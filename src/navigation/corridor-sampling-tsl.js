// Echantillonneur GPU unique des pistes de contact 3D precalculees.
//
// Deux texels de position et deux texels de support suffisent par fourmi. Le
// runtime ne reconstruit aucune paroi, ne lance aucun rayon et n'evalue aucun
// SDF : son cout reste strictement O(1), quelle que soit la taille du nid.

import {
	int, uint, float, vec2, vec3, ivec2,
	textureLoad, clamp, floor, min, max, mix, length, dot, select,
	hash, PI2,
} from 'three/tsl';

import { TEXEL } from '../config.js';
import { CORRIDOR_SURFACE_TRACKS } from './support-geometry.js';

const unitOr = ( value, fallback ) => {

	const magnitude = length( value );
	return select(
		magnitude.greaterThan( 1e-5 ),
		value.div( max( magnitude, 1e-5 ) ),
		fallback,
	);

};

const metricPoint = ( point ) => vec3( point.x, point.y, point.z.div( TEXEL ) );

export const corridorSurfaceTrack = ( antId ) => min(
	floor( hash( antId.add( uint( 0x3605A ) ) ).mul( CORRIDOR_SURFACE_TRACKS ) ).toInt(),
	int( CORRIDOR_SURFACE_TRACKS - 1 ),
);

export const corridorSurfaceAngle = ( antId ) =>
	corridorSurfaceTrack( antId ).toFloat().mul( PI2 / CORRIDOR_SURFACE_TRACKS );

function surfaceCoordinate( layout, edge, track, sample ) {

	return ivec2(
		track.mul( int( layout.CORRIDOR_SAMPLES ) ).add( sample ),
		edge,
	);

}

export function corridorSurfaceLengthTSL( layout, edge, antId ) {

	const track = corridorSurfaceTrack( antId );
	return textureLoad(
		layout.corridorSurfaceTexture,
		surfaceCoordinate( layout, edge, track, int( 0 ) ),
	).w;

}

export function sampleCorridorSurfaceTSL( layout, edge, t, direction, antId ) {

	const track = corridorSurfaceTrack( antId );
	const positionAt = ( sample ) => textureLoad(
		layout.corridorSurfaceTexture,
		surfaceCoordinate( layout, edge, track, sample ),
	);
	const supportAt = ( sample ) => textureLoad(
		layout.corridorSurfaceSupportTexture,
		surfaceCoordinate( layout, edge, track, sample ),
	);
	const f = clamp( t, 0, 1 ).mul( layout.CORRIDOR_SAMPLES - 1 );
	const i0 = clamp( floor( f ).toInt(), int( 0 ), int( layout.CORRIDOR_SAMPLES - 2 ) );
	const i1 = i0.add( int( 1 ) );
	const local = f.sub( i0.toFloat() );
	const p0 = positionAt( i0 );
	const p1 = positionAt( i1 );
	const s0 = supportAt( i0 );
	const s1 = supportAt( i1 );
	const contact = mix( p0.xyz, p1.xyz, local ).toVar();
	const supportMetric = unitOr(
		mix( s0.xyz, s1.xyz, local ), vec3( 0, 0, 1 ) ).toVar();
	const tangentRaw = metricPoint( p1.xyz ).sub( metricPoint( p0.xyz ));
	const tangentProjected = tangentRaw.sub(
		supportMetric.mul( dot( tangentRaw, supportMetric ) ) );
	const forwardMetric = unitOr(
		tangentProjected, vec3( 1, 0, 0 ) ).mul( direction ).toVar();

	return {
		position: vec2( contact.x, contact.y ),
		depth: contact.z,
		center: vec3( contact.x, contact.z, contact.y ),
		forward: vec3( forwardMetric.x, forwardMetric.z, forwardMetric.y ),
		support: vec3( supportMetric.x, supportMetric.z, supportMetric.y ),
		radial: vec3( supportMetric.x, supportMetric.z, supportMetric.y ).negate(),
		tangent: vec2( forwardMetric.x, forwardMetric.y ),
		wallWeight: float( 1 ),
		trackLength: mix( p0.w, p1.w, local ),
	};

}