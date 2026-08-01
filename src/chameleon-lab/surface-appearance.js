import * as THREE from 'three/webgpu';

import {
	atan,
	fract,
	Fn,
	If,
	int,
	normalLocal,
	positionLocal,
	select,
	texture,
	uniform,
	vec2,
	vec3,
} from 'three/tsl';

const PATTERN_TILE_SIZE = 64;
const PATTERN_LAYER_COUNT = 4;
const TWO_PI = Math.PI * 2;
let sharedPatternTexture = null;

const PROFILE_KIND = Object.freeze( {
	soil: 0,
	bark: 1,
	stone: 2,
	wall: 3,
} );

function palette( dark, base, light ) {

	return Object.freeze( [ dark, base, light ] );

}

export const LAB_SURFACE_APPEARANCES = Object.freeze( {
	soil: Object.freeze( {
		key: 'soil',
		kind: PROFILE_KIND.soil,
		palette: palette( 0x382617, 0x604225, 0x795635 ),
		scale: 1.72,
		seed: 0.37,
		contrast: 0.78,
		roughness: 0.96,
	} ),
	bark: Object.freeze( {
		key: 'bark',
		kind: PROFILE_KIND.bark,
		palette: palette( 0x281a10, 0x49321e, 0x67482c ),
		scale: 2.45,
		seed: 1.91,
		contrast: 0.88,
		roughness: 0.92,
	} ),
	stone: Object.freeze( {
		key: 'stone',
		kind: PROFILE_KIND.stone,
		palette: palette( 0x3f4541, 0x5c625d, 0x7b817a ),
		scale: 2.08,
		seed: 3.17,
		contrast: 0.68,
		roughness: 0.84,
	} ),
	wall: Object.freeze( {
		key: 'wall',
		kind: PROFILE_KIND.wall,
		palette: palette( 0x503e2d, 0x796047, 0x987b5e ),
		scale: 1.36,
		seed: 4.63,
		contrast: 0.72,
		roughness: 0.93,
	} ),
} );

const SURFACE_KIND_TO_PROFILE = Object.freeze( {
	soil: 'soil',
	branch: 'bark',
	'bark-wall': 'wall',
	'rock-wall': 'stone',
	'rough-rock': 'stone',
} );

function clamp01( value ) {

	return Math.min( 1, Math.max( 0, value ) );

}

function smoothstepNumber( edge0, edge1, value ) {

	const x = clamp01( ( value - edge0 ) / Math.max( 1e-8, edge1 - edge0 ) );
	return x * x * ( 3 - 2 * x );

}

function paletteChannels( hexadecimal ) {

	return [
		( hexadecimal >> 16 ) & 0xff,
		( hexadecimal >> 8 ) & 0xff,
		hexadecimal & 0xff,
	];

}

function periodicPattern( kind, u, v, seed ) {

	const phase = seed * 0.73;
	const waveA = Math.sin( TWO_PI * ( u + v * 2 ) + phase );
	const waveB = Math.sin( TWO_PI * ( u * 3 - v ) + waveA * 1.1 + phase * 1.7 );
	const grain = Math.sin( TWO_PI * ( u * 7 + v * 5 ) + waveB * 1.4 + phase * 2.3 );
	const mottle = clamp01( 0.5 + waveA * 0.27 + waveB * 0.17 );
	const detail = grain * 0.5 + 0.5;
	if ( kind === PROFILE_KIND.soil ) return clamp01( mottle * 0.74 + detail * 0.26 );
	if ( kind === PROFILE_KIND.bark ) {

		const grooves = Math.sin(
			TWO_PI * ( v * 6 + Math.sin( TWO_PI * u ) * 0.14 ) + phase,
		) * 0.5 + 0.5;
		return clamp01( grooves * 0.82 + mottle * 0.18 );

	}
	if ( kind === PROFILE_KIND.stone )
		return smoothstepNumber( 0.28, 0.73, mottle * 0.72 + detail * 0.28 );
	const layers = Math.sin(
		TWO_PI * ( v * 2 + u * 0.25 ) + waveA * 0.85 + phase,
	) * 0.5 + 0.5;
	return clamp01( layers * 0.76 + mottle * 0.24 );

}

function writePatternPixel( data, offset, profile, u, v ) {

	const dark = paletteChannels( profile.palette[ 0 ] );
	const base = paletteChannels( profile.palette[ 1 ] );
	const light = paletteChannels( profile.palette[ 2 ] );
	const rawTone = periodicPattern( profile.kind, u, v, profile.seed );
	const tone = clamp01( 0.5 + ( rawTone - 0.5 ) * profile.contrast );
	const detail = Math.sin( TWO_PI * ( u * 5 - v * 7 ) + profile.seed ) * 0.5 + 0.5;
	const highlight = smoothstepNumber( 0.69, 0.94, detail * 0.58 + rawTone * 0.42 ) * 0.38;
	for ( let channel = 0; channel < 3; channel ++ ) {

		const pigment = dark[ channel ] + ( base[ channel ] - dark[ channel ] ) * tone;
		data[ offset + channel ] = Math.round(
			pigment + ( light[ channel ] - pigment ) * highlight,
		);

	}
	data[ offset + 3 ] = 255;

}

function createPatternTexture() {

	const layerPixels = PATTERN_TILE_SIZE * PATTERN_TILE_SIZE;
	const data = new Uint8Array( layerPixels * PATTERN_LAYER_COUNT * 4 );
	for ( const profile of Object.values( LAB_SURFACE_APPEARANCES ) ) {

		const layerOffset = profile.kind * layerPixels;
		for ( let y = 0; y < PATTERN_TILE_SIZE; y ++ ) {

			for ( let x = 0; x < PATTERN_TILE_SIZE; x ++ ) {

				const offset = ( layerOffset + y * PATTERN_TILE_SIZE + x ) * 4;
				writePatternPixel(
					data,
					offset,
					profile,
					x / PATTERN_TILE_SIZE,
					y / PATTERN_TILE_SIZE,
				);

			}

		}

	}
	const pattern = new THREE.DataArrayTexture(
		data, PATTERN_TILE_SIZE, PATTERN_TILE_SIZE, PATTERN_LAYER_COUNT,
	);
	pattern.name = 'LabSurfacePigmentArray';
	pattern.format = THREE.RGBAFormat;
	pattern.type = THREE.UnsignedByteType;
	pattern.colorSpace = THREE.SRGBColorSpace;
	pattern.wrapS = THREE.RepeatWrapping;
	pattern.wrapT = THREE.RepeatWrapping;
	pattern.minFilter = THREE.LinearMipmapLinearFilter;
	pattern.magFilter = THREE.LinearFilter;
	pattern.generateMipmaps = true;
	pattern.needsUpdate = true;
	return pattern;

}

export function getLabSurfacePatternTexture() {

	sharedPatternTexture ??= createPatternTexture();
	return sharedPatternTexture;

}

export function disposeLabSurfacePatternTexture() {

	sharedPatternTexture?.dispose();
	sharedPatternTexture = null;

}

export function resolveLabSurfaceAppearance( keyOrSurfaceKind ) {

	const key = LAB_SURFACE_APPEARANCES[ keyOrSurfaceKind ]
		? keyOrSurfaceKind
		: SURFACE_KIND_TO_PROFILE[ keyOrSurfaceKind ];
	const profile = LAB_SURFACE_APPEARANCES[ key ];
	if ( ! profile ) throw new Error( `Unknown laboratory surface appearance: ${ keyOrSurfaceKind }` );
	return profile;

}

export function createSurfaceAppearanceUniforms( initial = 'soil' ) {

	const profile = resolveLabSurfaceAppearance( initial );
	return {
		dark: uniform( new THREE.Color( profile.palette[ 0 ] ) ),
		base: uniform( new THREE.Color( profile.palette[ 1 ] ) ),
		light: uniform( new THREE.Color( profile.palette[ 2 ] ) ),
		kind: uniform( profile.kind ),
		scale: uniform( profile.scale ),
		seed: uniform( profile.seed ),
		contrast: uniform( profile.contrast ),
		roughness: uniform( profile.roughness ),
	};

}

export function writeSurfaceAppearanceUniforms( uniforms, appearance ) {

	const profile = appearance?.profile ?? resolveLabSurfaceAppearance( appearance?.key ?? appearance );
	uniforms.dark.value.setHex( profile.palette[ 0 ] );
	uniforms.base.value.setHex( profile.palette[ 1 ] );
	uniforms.light.value.setHex( profile.palette[ 2 ] );
	uniforms.kind.value = profile.kind;
	uniforms.scale.value = profile.scale;
	uniforms.seed.value = profile.seed;
	uniforms.contrast.value = profile.contrast;
	uniforms.roughness.value = profile.roughness;
	return profile;

}

/**
 * One cache-friendly array-texture sample drives both the visible support and the
 * adaptive skin. The hard local-plane choice prevents the pattern from
 * changing when the animal sits farther away along the support normal.
 */
export function surfacePigmentNode(
	localPositionNode,
	localNormalNode,
	controls,
	patternTexture = getLabSurfacePatternTexture(),
) {

	const isBark = controls.kind.greaterThanEqual( 0.5 ).and( controls.kind.lessThan( 1.5 ) );
	const repeated = Fn( () => {

		const coordinates = vec2( 0 ).toVar();
		If( isBark, () => {

			const radial = localPositionNode.xz
				.div( localPositionNode.xz.length().max( 1e-4 ) );
			const barkAngle = atan( radial.y, radial.x ).div( TWO_PI ).add( 0.5 );
			coordinates.assign( vec2(
				localPositionNode.y.mul( controls.scale ),
				barkAngle.mul( 6 ),
			) );

		} ).Else( () => {

			const absoluteNormal = localNormalNode.abs();
			const xDominant = absoluteNormal.x.greaterThanEqual( absoluteNormal.y )
				.and( absoluteNormal.x.greaterThanEqual( absoluteNormal.z ) );
			const yDominant = absoluteNormal.y.greaterThanEqual( absoluteNormal.z );
			const planar = select(
				xDominant,
				vec3( localPositionNode.y, localPositionNode.z, 0 ),
				select(
					yDominant,
					vec3( localPositionNode.x, localPositionNode.z, 0 ),
					vec3( localPositionNode.x, localPositionNode.y, 0 ),
				),
			);
			coordinates.assign( planar.xy.mul( controls.scale ) );

		} );
		return fract( coordinates );

	} )();
	return texture( patternTexture, repeated ).depth( int( controls.kind ) ).rgb;

}

export function createLabSurfaceMaterial( keyOrSurfaceKind ) {

	const profile = resolveLabSurfaceAppearance( keyOrSurfaceKind );
	const controls = createSurfaceAppearanceUniforms( profile.key );
	const material = new THREE.MeshStandardNodeMaterial( {
		color: 0xffffff,
		roughness: profile.roughness,
		metalness: 0,
	} );
	material.name = `LabSurface_${ profile.key }`;
	material.colorNode = surfacePigmentNode( positionLocal, normalLocal, controls );
	material.roughnessNode = controls.roughness;
	material.userData.labSurfaceAppearance = profile.key;
	material.userData.labSurfaceUniforms = controls;
	return material;

}

export function createSurfaceAppearanceBinding( object, keyOrSurfaceKind ) {

	if ( ! object?.matrixWorld ) throw new TypeError( 'a transformed support object is required' );
	const profile = resolveLabSurfaceAppearance( keyOrSurfaceKind );
	object.updateMatrixWorld( true );
	const worldToLocal = object.matrixWorld.clone().invert();
	// A world-space plane normal returns to geometry-local space through A^T.
	// Keeping this transform in the immutable binding avoids object lookups and
	// matrix inversions in the render loop.
	const worldNormalToLocal = new THREE.Matrix3()
		.setFromMatrix4( object.matrixWorld )
		.transpose();
	return Object.freeze( {
		profile,
		worldToLocal: Object.freeze( worldToLocal.toArray() ),
		worldNormalToLocal: Object.freeze( worldNormalToLocal.toArray() ),
	} );

}
