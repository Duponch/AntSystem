import {
	dot,
	hash,
	luminance,
	mix,
	normalView,
	positionGeometry,
	positionViewDirection,
	sin,
	uniform,
	vec2,
	vec3,
	viewportSharedTexture,
	viewportUV,
} from 'three/tsl';

const TRANSITION_95_PERCENT = - Math.log( 0.05 );
const PERCEPTUAL_EPSILON = 1e-4;
export const MAX_CHAMELEON_ENVIRONMENT_MATCH = 0.86;

function clamp( value, low, high, fallback ) {

	const safe = Number.isFinite( value ) ? value : fallback;
	return Math.min( high, Math.max( low, safe ) );

}

/**
 * Exponential progress reaches 95% after `duration` seconds. Its result is
 * independent of how the same elapsed time is split across render frames.
 */
export function advanceChameleonCamouflageBlend( current, target, dt, duration ) {

	const safeCurrent = clamp( current, 0, 1, 0 );
	const safeTarget = clamp( target, 0, 1, 0 );
	if ( ! Number.isFinite( dt ) || dt <= 0 ) return safeCurrent;
	if ( ! Number.isFinite( duration ) || duration <= 0 ) return safeTarget;
	const decay = Math.exp( - TRANSITION_95_PERCENT * dt / duration );
	return safeTarget + ( safeCurrent - safeTarget ) * decay;

}

export function resolveChameleonCamouflageProfile( settings = {} ) {

	return Object.freeze( {
		environmentMatch: clamp(
			settings.chameleonCamouflageEnvironmentMatch,
			0,
			MAX_CHAMELEON_ENVIRONMENT_MATCH,
			0.68,
		),
		edgeReveal: clamp( settings.chameleonCamouflageEdgeReveal, 0, 0.8, 0.35 ),
		patternStrength: clamp( settings.chameleonCamouflagePatternStrength, 0, 0.4, 0.18 ),
		patternScale: clamp( settings.chameleonCamouflagePatternScale, 0.5, 12, 3 ),
		sampleSpread: clamp( settings.chameleonCamouflageSampleSpread, 0, 0.015, 0.004 ),
		shadowRetention: clamp( settings.chameleonCamouflageShadowRetention, 0.1, 0.6, 0.28 ),
	} );

}

/**
 * CPU mirror of the shader profile. It protects the artistic contract: the
 * animal always retains a non-zero PBR contribution, particularly along its
 * grazing-angle silhouette.
 */
export function evaluateChameleonCamouflageMatch(
	profile,
	blend,
	pattern = 0.5,
	facing = 1,
) {

	const safeBlend = clamp( blend, 0, 1, 0 );
	const safePattern = clamp( pattern, 0, 1, 0.5 );
	const safeFacing = clamp( facing, 0, 1, 1 );
	const patches = ( safePattern - 0.5 ) * profile.patternStrength;
	const edge = ( 1 - safeFacing ) ** 2;
	return clamp(
		safeBlend
			* ( profile.environmentMatch + patches )
			* ( 1 - edge * profile.edgeReveal ),
		0,
		MAX_CHAMELEON_ENVIRONMENT_MATCH,
		0,
	);

}

function createPerceptualNodes( uniforms ) {

	// Two cheap object-space waves form broad, stable pigment patches. They do
	// not crawl with the camera and cost far less than a Worley/fBm stack.
	const waveA = sin(
		dot( positionGeometry, vec3( 0.73, 1.31, 1.93 ) )
			.mul( uniforms.patternScale ),
	);
	const waveB = sin(
		dot( positionGeometry, vec3( - 1.47, 0.61, 0.89 ) )
			.mul( uniforms.patternScale.mul( 0.73 ) )
			.add( waveA.mul( 1.35 ) ),
	);
	const pattern = waveA.mul( 0.62 ).add( waveB.mul( 0.38 ) )
		.mul( 0.5 ).add( 0.5 ).clamp( 0, 1 );

	// Sampling a nearby pixel rather than the exact same pixel keeps the local
	// palette but prevents the skin from behaving like a transparent screen.
	const sampleOffset = vec2( waveA, waveB ).mul( uniforms.sampleSpread );
	const behind = viewportSharedTexture( viewportUV.add( sampleOffset ) );
	return { pattern, behind };

}

function installPerceptualGraph( material, uniforms, nodes ) {

	const facing = normalView.dot( positionViewDirection ).abs().clamp( 0, 1 );
	const grazing = facing.oneMinus().pow( 2 );
	const patchVariation = nodes.pattern.sub( 0.5 ).mul( uniforms.patternStrength );
	const localMatch = uniforms.environmentMatch
		.add( patchVariation )
		.mul( grazing.mul( uniforms.edgeReveal ).oneMinus() )
		.mul( uniforms.blend )
		.clamp( 0, MAX_CHAMELEON_ENVIRONMENT_MATCH );

	// A chromatophore skin matches broad colour and luminance cues; it does not
	// replay the scene. The original PBR result always retains visible relief.
	const sceneLuminance = luminance( nodes.behind.rgb );
	const environmentPigment = mix(
		vec3( sceneLuminance ),
		nodes.behind.rgb,
		0.78,
	).mul(
		nodes.pattern.sub( 0.5 )
			.mul( uniforms.patternStrength.mul( 0.28 ) )
			.add( 1 ),
	).clamp( 0, 1 );
	// Backdrop participates in the lit-material pipeline: it adapts only the
	// diffuse response. Specular highlights, normals and roughness remain those
	// of the real skin, which prevents any transparent-screen appearance.
	material.outputNode = null;
	material.backdropNode = environmentPigment;
	material.backdropAlphaNode = localMatch;

	// The animal remains physically present: camouflage softens its projected
	// shadow but always leaves a configurable contact cue.
	const shadowDither = hash(
		dot( positionGeometry, vec3( 12.9898, 78.233, 37.719 ) ).mul( 43758.5453 ),
	);
	const shadowFade = uniforms.blend
		.mul( uniforms.shadowRetention.oneMinus() )
		.clamp( 0, 0.9 );
	material.maskShadowNode = shadowDither.greaterThanEqual( shadowFade );

	// Transparent render ordering is required only so the opaque environment
	// exists in the shared viewport texture. The shader itself outputs alpha 1.
	material.transparent = true;
	material.opacity = 1;
	material.depthTest = true;
	material.depthWrite = true;
	material.forceSinglePass = true;
	material.needsUpdate = true;

}

function materialList( material ) {

	return Array.isArray( material ) ? material : [ material ];

}

/**
 * Creates two immutable material variants:
 * - the original opaque PBR materials, used at zero camouflage and costing no
 *   framebuffer copy;
 * - opaque-looking perceptual variants, all sharing one viewport node and
 *   therefore one framebuffer copy per scene render while camouflage is active.
 */
export function createChameleonCamouflageController( meshes, settings ) {

	const renderMeshes = Array.from( meshes || [] ).filter( ( mesh ) => mesh?.isMesh );
	const uniforms = {
		blend: uniform( 0 ),
		environmentMatch: uniform( 0.68 ),
		edgeReveal: uniform( 0.35 ),
		patternStrength: uniform( 0.18 ),
		patternScale: uniform( 3 ),
		sampleSpread: uniform( 0.004 ),
		shadowRetention: uniform( 0.28 ),
	};
	const nodes = createPerceptualNodes( uniforms );
	const perceptualByNatural = new Map();
	const perceptualMaterials = [];
	const bindings = [];

	function perceptualVariant( natural ) {

		if ( perceptualByNatural.has( natural ) ) return perceptualByNatural.get( natural );
		const perceptual = natural.clone();
		perceptual.name = `${ natural.name || 'ChameleonMaterial' }_Perceptual`;
		installPerceptualGraph( perceptual, uniforms, nodes );
		perceptualByNatural.set( natural, perceptual );
		perceptualMaterials.push( perceptual );
		return perceptual;

	}

	for ( const mesh of renderMeshes ) {

		const natural = mesh.material;
		const perceptualList = materialList( natural ).map( perceptualVariant );
		bindings.push( {
			mesh,
			natural,
			perceptual: Array.isArray( natural ) ? perceptualList : perceptualList[ 0 ],
		} );

	}

	let perceptualActive = false;
	let disposed = false;

	function setPerceptualActive( active ) {

		const next = !! active;
		if ( next === perceptualActive ) return;
		perceptualActive = next;
		for ( const binding of bindings )
			binding.mesh.material = next ? binding.perceptual : binding.natural;

	}

	function update( renderDt, camouflaged = false, force = false ) {

		if ( disposed ) return uniforms.blend.value;
		if ( force ) uniforms.blend.value = camouflaged ? 1 : 0;
		else {

			const adaptSeconds = clamp(
				settings?.chameleonCamouflageAdaptSeconds, 0.1, 6, 2.2,
			);
			const releaseSeconds = clamp(
				settings?.chameleonCamouflageReleaseSeconds, 0.1, 4, 0.8,
			);
			uniforms.blend.value = advanceChameleonCamouflageBlend(
				uniforms.blend.value,
				camouflaged ? 1 : 0,
				renderDt,
				camouflaged ? adaptSeconds : releaseSeconds,
			);

		}

		const profile = resolveChameleonCamouflageProfile( settings );
		uniforms.environmentMatch.value = profile.environmentMatch;
		uniforms.edgeReveal.value = profile.edgeReveal;
		uniforms.patternStrength.value = profile.patternStrength;
		uniforms.patternScale.value = profile.patternScale;
		uniforms.sampleSpread.value = profile.sampleSpread;
		uniforms.shadowRetention.value = profile.shadowRetention;
		setPerceptualActive( uniforms.blend.value > PERCEPTUAL_EPSILON );
		return uniforms.blend.value;

	}

	function reset() {

		uniforms.blend.value = 0;
		setPerceptualActive( false );

	}

	async function prewarm( renderer, camera, root, scene ) {

		if ( disposed || typeof renderer?.compileAsync !== 'function' || ! camera || ! root )
			return false;
		const wasActive = perceptualActive;
		setPerceptualActive( true );
		try {

			await renderer.compileAsync( root, camera, scene || null );
			return true;

		} finally {

			setPerceptualActive( wasActive );

		}

	}

	function dispose() {

		if ( disposed ) return;
		reset();
		disposed = true;
		for ( const material of perceptualMaterials ) material.dispose();

	}

	return {
		uniforms,
		update,
		reset,
		prewarm,
		dispose,
		getBlend: () => uniforms.blend.value,
		isPerceptualActive: () => perceptualActive,
		getPerceptualMaterialCount: () => perceptualMaterials.length,
	};

}
