import * as THREE from 'three/webgpu';

import {
	attribute,
	float,
	Fn,
	If,
	luminance,
	mix,
	positionWorld,
	smoothstep,
	uniform,
	vec4,
} from 'three/tsl';

import {
	createSurfaceAppearanceUniforms,
	surfacePigmentNode,
	writeSurfaceAppearanceUniforms,
} from './surface-appearance.js';

const TRANSITION_95_PERCENT = -Math.log( 0.05 );
const MATERIAL_EPSILON = 1e-4;

export const SURFACE_CAMOUFLAGE_DEFAULTS = Object.freeze( {
	camouflageEnabled: true,
	camouflageStrength: 0.98,
	camouflageAdaptSeconds: 0.85,
	camouflageReleaseSeconds: 0.45,
	camouflageSurfaceCommitSeconds: 0.1,
	camouflageSurfaceTransitionSeconds: 0.28,
	camouflageSupportHoldSeconds: 0.24,
	camouflageEyeRetention: 0.86,
} );

function finiteClamp( value, minimum, maximum, fallback ) {

	return Math.min( maximum, Math.max(
		minimum,
		Number.isFinite( value ) ? value : fallback,
	) );

}

export function ensureSurfaceCamouflageSettings( settings ) {

	if ( ! settings || typeof settings !== 'object' )
		throw new TypeError( 'camouflage settings must be an object' );
	for ( const [ property, fallback ] of Object.entries( SURFACE_CAMOUFLAGE_DEFAULTS ) ) {

		if ( property === 'camouflageEnabled' ) {

			if ( typeof settings[ property ] !== 'boolean' ) settings[ property ] = fallback;

		} else if ( ! Number.isFinite( settings[ property ] ) ) settings[ property ] = fallback;

	}
	return settings;

}

export function advanceSurfaceCamouflageBlend( current, target, dt, duration ) {

	const safeCurrent = finiteClamp( current, 0, 1, 0 );
	const safeTarget = finiteClamp( target, 0, 1, 0 );
	if ( ! Number.isFinite( dt ) || dt <= 0 ) return safeCurrent;
	if ( ! Number.isFinite( duration ) || duration <= 0 ) return safeTarget;
	const decay = Math.exp( -TRANSITION_95_PERCENT * dt / duration );
	return safeTarget + ( safeCurrent - safeTarget ) * decay;

}

function usableFoot( foot ) {

	return foot?.state === 'holding'
		&& Number.isFinite( foot.collider?.handle )
		&& foot.surface?.appearance;

}

/**
 * Four feet are a fixed anatomical bound. The O(4²) vote avoids a Map and all
 * allocation in the render loop; ties deliberately retain the previous support.
 */
export function dominantCamouflageSupportHandle( feet, previousHandle = null ) {

	let bestHandle = null;
	let bestScore = -Infinity;
	const list = feet || [];
	for ( let candidate = 0; candidate < list.length; candidate ++ ) {

		const foot = list[ candidate ];
		if ( ! usableFoot( foot ) ) continue;
		const handle = foot.collider.handle;
		let seen = false;
		for ( let earlier = 0; earlier < candidate; earlier ++ ) {

			if ( usableFoot( list[ earlier ] ) && list[ earlier ].collider.handle === handle ) {

				seen = true;
				break;

			}

		}
		if ( seen ) continue;
		let score = 0;
		for ( let index = 0; index < list.length; index ++ ) {

			const other = list[ index ];
			if ( ! usableFoot( other ) || other.collider.handle !== handle ) continue;
			score += 1 + finiteClamp( other.load, 0, 1, 0 ) * 0.1;

		}
		if ( score > bestScore + 1e-8
			|| Math.abs( score - bestScore ) <= 1e-8 && handle === previousHandle ) {

			bestHandle = handle;
			bestScore = score;

		}

	}
	return bestHandle;

}

function appearanceForHandle( feet, handle ) {

	if ( handle === null ) return null;
	for ( let index = 0; index < feet.length; index ++ ) {

		const foot = feet[ index ];
		if ( usableFoot( foot ) && foot.collider.handle === handle )
			return foot.surface.appearance;

	}
	return null;

}

function averageNormalForHandle( feet, handle, target ) {

	target.set( 0, 0, 0 );
	let count = 0;
	for ( let index = 0; index < feet.length; index ++ ) {

		const foot = feet[ index ];
		if ( ! usableFoot( foot ) || foot.collider.handle !== handle ) continue;
		const weight = 1 + finiteClamp( foot.load, 0, 1, 0 );
		target.addScaledVector( foot.normal, weight );
		count ++;

	}
	if ( count === 0 || target.lengthSq() < 1e-10 ) target.set( 0, 1, 0 );
	else target.normalize();
	return target;

}

function copyAppearanceUniforms( target, source ) {

	target.dark.value.copy( source.dark.value );
	target.base.value.copy( source.base.value );
	target.light.value.copy( source.light.value );
	for ( const property of [ 'kind', 'scale', 'seed', 'contrast', 'roughness' ] )
		target[ property ].value = source[ property ].value;

}

function materialList( material ) {

	return Array.isArray( material ) ? material : [ material ];

}

function adaptiveMaterial( source, nodes, naturalTint ) {

	const material = new THREE.MeshStandardNodeMaterial( {
		color: 0xffffff,
		roughness: Number.isFinite( source?.roughness ) ? source.roughness : 0.78,
		metalness: Number.isFinite( source?.metalness ) ? source.metalness : 0,
		vertexColors: false,
		side: source?.side ?? THREE.DoubleSide,
		transparent: false,
		opacity: 1,
		alphaTest: Number.isFinite( source?.alphaTest ) ? source.alphaTest : 0,
		flatShading: !! source?.flatShading,
	} );
	material.name = `${ source?.name || 'ChameleonMaterial' }_SurfaceAdaptive`;
	if ( source?.emissive ) material.emissive.copy( source.emissive );
	if ( Number.isFinite( source?.emissiveIntensity ) )
		material.emissiveIntensity = source.emissiveIntensity;

	const vertexPigment = attribute( 'color', 'vec4' ).rgb;
	const natural = vertexPigment.mul( naturalTint );
	const naturalLuminance = luminance( natural );
	const pupil = smoothstep( 0.02, 0.055, naturalLuminance ).oneMinus();
	const catchlight = smoothstep( 0.75, 0.86, naturalLuminance );
	const anatomicalDetail = pupil.max( catchlight );
	const adaptation = nodes.blend
		.mul( nodes.strength )
		.mul( anatomicalDetail.mul( nodes.eyeRetention ).oneMinus() )
		.clamp( 0, 1 );
	const supportPigment = Fn( () => {

		const pigment = nodes.pigmentB.toVar();
		// The second atlas sample exists only during a support cross-fade. The
		// branch condition is uniform for the whole draw, so stable camouflage
		// costs exactly one tiny cache-local sample per visible fragment.
		If( nodes.supportMix.lessThan( 0.999 ), () => {

			pigment.assign( mix( nodes.pigmentA, nodes.pigmentB, nodes.supportMix ) );

		} );
		return pigment;

	} )();
	material.colorNode = mix( natural, supportPigment, adaptation );
	const supportRoughness = mix(
		nodes.appearanceA.roughness,
		nodes.appearanceB.roughness,
		nodes.supportMix,
	);
	material.roughnessNode = mix(
		float( material.roughness ),
		supportRoughness,
		adaptation.mul( 0.82 ),
	);
	material.depthTest = true;
	material.depthWrite = true;
	material.needsUpdate = true;
	return material;

}

export function createSurfaceCamouflageController( meshes, settings ) {

	ensureSurfaceCamouflageSettings( settings );
	const appearanceA = createSurfaceAppearanceUniforms( 'soil' );
	const appearanceB = createSurfaceAppearanceUniforms( 'soil' );
	const uniforms = {
		blend: uniform( 0 ),
		strength: uniform( settings.camouflageStrength ),
		eyeRetention: uniform( settings.camouflageEyeRetention ),
		supportMix: uniform( 1 ),
		worldToLocalA: uniform( new THREE.Matrix4() ),
		worldToLocalB: uniform( new THREE.Matrix4() ),
		localNormalA: uniform( new THREE.Vector3( 0, 1, 0 ) ),
		localNormalB: uniform( new THREE.Vector3( 0, 1, 0 ) ),
		appearanceA,
		appearanceB,
	};
	const pointA = uniforms.worldToLocalA.mul( vec4( positionWorld, 1 ) ).xyz;
	const pointB = uniforms.worldToLocalB.mul( vec4( positionWorld, 1 ) ).xyz;
	const nodes = {
		...uniforms,
		pigmentA: surfacePigmentNode( pointA, uniforms.localNormalA, appearanceA ),
		pigmentB: surfacePigmentNode( pointB, uniforms.localNormalB, appearanceB ),
	};
	const adaptiveByNatural = new Map();
	const adaptiveMaterials = [];
	const bindings = [];
	for ( const mesh of Array.from( meshes || [] ).filter( ( entry ) => entry?.isMesh ) ) {

		const natural = mesh.material;
		const adaptive = materialList( natural ).map( ( source ) => {

			if ( adaptiveByNatural.has( source ) ) return adaptiveByNatural.get( source );
			const naturalTint = uniform(
				source?.color ? source.color.clone() : new THREE.Color( 0xffffff ),
			);
			const created = adaptiveMaterial( source, nodes, naturalTint );
			adaptiveByNatural.set( source, created );
			adaptiveMaterials.push( created );
			return created;

		} );
		bindings.push( {
			mesh,
			natural,
			adaptive: Array.isArray( natural ) ? adaptive : adaptive[ 0 ],
		} );

	}

	const normalWorld = new THREE.Vector3( 0, 1, 0 );
	const localNormal = new THREE.Vector3( 0, 1, 0 );
	const normalMatrix = new THREE.Matrix3();
	let currentHandle = null;
	let currentAppearance = null;
	let pendingHandle = null;
	let pendingSeconds = 0;
	let unsupportedSeconds = Infinity;
	let adaptiveActive = false;
	let disposed = false;
	const view = Object.seal( {
		blend: 0,
		supportMix: 1,
		supportHandle: null,
		profile: null,
		active: false,
	} );

	function setAdaptiveActive( active ) {

		const next = !! active;
		if ( next === adaptiveActive ) return;
		adaptiveActive = next;
		for ( const binding of bindings )
			binding.mesh.material = next ? binding.adaptive : binding.natural;

	}

	function writeNormal( target, appearance, worldNormal ) {

		normalMatrix.fromArray( appearance.worldNormalToLocal );
		localNormal.copy( worldNormal ).applyMatrix3( normalMatrix );
		if ( localNormal.lengthSq() < 1e-10 ) localNormal.set( 0, 1, 0 );
		else localNormal.normalize();
		target.value.copy( localNormal );

	}

	function commitAppearance( handle, appearance, worldNormal ) {

		if ( ! currentAppearance ) {

			writeSurfaceAppearanceUniforms( appearanceA, appearance );
			writeSurfaceAppearanceUniforms( appearanceB, appearance );
			uniforms.worldToLocalA.value.fromArray( appearance.worldToLocal );
			uniforms.worldToLocalB.value.fromArray( appearance.worldToLocal );
			writeNormal( uniforms.localNormalA, appearance, worldNormal );
			writeNormal( uniforms.localNormalB, appearance, worldNormal );
			uniforms.supportMix.value = 1;

		} else {

			copyAppearanceUniforms( appearanceA, appearanceB );
			uniforms.worldToLocalA.value.copy( uniforms.worldToLocalB.value );
			uniforms.localNormalA.value.copy( uniforms.localNormalB.value );
			writeSurfaceAppearanceUniforms( appearanceB, appearance );
			uniforms.worldToLocalB.value.fromArray( appearance.worldToLocal );
			writeNormal( uniforms.localNormalB, appearance, worldNormal );
			uniforms.supportMix.value = 0;

		}
		currentHandle = handle;
		currentAppearance = appearance;
		pendingHandle = null;
		pendingSeconds = 0;

	}

	function update( renderDt, feet, force = false ) {

		if ( disposed ) return view;
		const dt = Number.isFinite( renderDt ) && renderDt > 0 ? renderDt : 0;
		const preferred = pendingHandle ?? currentHandle;
		const selectedHandle = dominantCamouflageSupportHandle( feet, preferred );
		if ( selectedHandle === null ) {

			pendingHandle = null;
			pendingSeconds = 0;
			unsupportedSeconds += dt;

		} else {

			unsupportedSeconds = 0;
			averageNormalForHandle( feet, selectedHandle, normalWorld );
			if ( selectedHandle === currentHandle ) {

				pendingHandle = null;
				pendingSeconds = 0;
				writeNormal( uniforms.localNormalB, currentAppearance, normalWorld );

			} else {

				if ( selectedHandle !== pendingHandle ) {

					pendingHandle = selectedHandle;
					pendingSeconds = 0;

			} else pendingSeconds += dt;
				const commitSeconds = finiteClamp(
					settings.camouflageSurfaceCommitSeconds, 0, 0.6,
					SURFACE_CAMOUFLAGE_DEFAULTS.camouflageSurfaceCommitSeconds,
				);
				const transitionReady = ! currentAppearance || force
					|| uniforms.supportMix.value >= 0.95;
				if ( transitionReady && ( force || pendingSeconds >= commitSeconds ) ) {

					const appearance = appearanceForHandle( feet, selectedHandle );
					if ( appearance ) commitAppearance(
						selectedHandle, appearance, normalWorld,
					);

				}

			}

		}

		const holdSeconds = finiteClamp(
			settings.camouflageSupportHoldSeconds, 0, 1.5,
			SURFACE_CAMOUFLAGE_DEFAULTS.camouflageSupportHoldSeconds,
		);
		const target = settings.camouflageEnabled
			&& currentAppearance && unsupportedSeconds <= holdSeconds ? 1 : 0;
		if ( force ) uniforms.blend.value = target;
		else uniforms.blend.value = advanceSurfaceCamouflageBlend(
			uniforms.blend.value,
			target,
			dt,
			target
				? finiteClamp( settings.camouflageAdaptSeconds, 0.05, 8,
					SURFACE_CAMOUFLAGE_DEFAULTS.camouflageAdaptSeconds )
				: finiteClamp( settings.camouflageReleaseSeconds, 0.05, 5,
					SURFACE_CAMOUFLAGE_DEFAULTS.camouflageReleaseSeconds ),
		);
		uniforms.supportMix.value = advanceSurfaceCamouflageBlend(
			uniforms.supportMix.value,
			1,
			dt,
			finiteClamp( settings.camouflageSurfaceTransitionSeconds, 0.05, 2,
				SURFACE_CAMOUFLAGE_DEFAULTS.camouflageSurfaceTransitionSeconds ),
		);
		uniforms.strength.value = finiteClamp(
			settings.camouflageStrength, 0, 1,
			SURFACE_CAMOUFLAGE_DEFAULTS.camouflageStrength,
		);
		uniforms.eyeRetention.value = finiteClamp(
			settings.camouflageEyeRetention, 0, 1,
			SURFACE_CAMOUFLAGE_DEFAULTS.camouflageEyeRetention,
		);
		setAdaptiveActive(
			uniforms.blend.value * uniforms.strength.value > MATERIAL_EPSILON,
		);
		view.blend = uniforms.blend.value;
		view.supportMix = uniforms.supportMix.value;
		view.supportHandle = currentHandle;
		view.profile = currentAppearance?.profile.key ?? null;
		view.active = adaptiveActive;
		return view;

	}

	function reset() {

		currentHandle = null;
		currentAppearance = null;
		pendingHandle = null;
		pendingSeconds = 0;
		unsupportedSeconds = Infinity;
		uniforms.blend.value = 0;
		uniforms.supportMix.value = 1;
		setAdaptiveActive( false );
		view.blend = 0;
		view.supportMix = 1;
		view.supportHandle = null;
		view.profile = null;
		view.active = false;

	}

	async function prewarm( renderer, camera, root, scene ) {

		if ( disposed || typeof renderer?.compileAsync !== 'function' || ! camera || ! root )
			return false;
		const wasActive = adaptiveActive;
		setAdaptiveActive( true );
		try {

			await renderer.compileAsync( root, camera, scene || null );
			return true;

		} finally {

			setAdaptiveActive( wasActive );

		}

	}

	function dispose() {

		if ( disposed ) return;
		reset();
		disposed = true;
		for ( const material of adaptiveMaterials ) material.dispose();
		adaptiveByNatural.clear();
		adaptiveMaterials.length = 0;
		bindings.length = 0;

	}

	return {
		uniforms,
		update,
		reset,
		prewarm,
		dispose,
		getView: () => view,
		isAdaptiveActive: () => adaptiveActive,
		getAdaptiveMaterialCount: () => adaptiveMaterials.length,
	};

}
