// Deterministic authoring data for the underground camera biome.
//
// This module deliberately contains no Three.js dependency. The render layer
// consumes one immutable, bounded bake; tests can therefore prove that the
// stylised soil never grows with the ant population or the nest topology.

export const UNDERGROUND_VISUAL_VERSION = 'camera-excavation-v1';

export const SOIL_LAYERS = Object.freeze( [
	Object.freeze( { id: 'humus', from: 0.00, to: 0.08, color: 0x3a2114 } ),
	Object.freeze( { id: 'topsoil', from: 0.08, to: 0.28, color: 0x5a3018 } ),
	Object.freeze( { id: 'clay', from: 0.28, to: 0.52, color: 0x8a441b } ),
	Object.freeze( { id: 'ochre', from: 0.52, to: 0.78, color: 0xc2782e } ),
	Object.freeze( { id: 'bedrock', from: 0.78, to: 1.00, color: 0xb9996a } ),
] );

const CLOD_COUNT = 3375;
const ROCK_COUNT = 384;
const ROOT_SEGMENT_LIMIT = 1152;
const DUST_COUNT = 128;
const ROOT_DEPTH = 8.5;
const TILE_SPAN = 26;
const ROOT_SPACING = 5;
const CLOD_TRIANGLES = 20;
const ROCK_TRIANGLES = 20;
const ROOT_TRIANGLES = 20;
const SOIL_CARRIER_TRIANGLES = 12;

export const UNDERGROUND_VISUAL_BUDGET = Object.freeze( {
	clods: CLOD_COUNT,
	rocks: ROCK_COUNT,
	rootSegments: ROOT_SEGMENT_LIMIT,
	rootDepth: ROOT_DEPTH,
	tileSpan: TILE_SPAN,
	dust: DUST_COUNT,
	drawCalls: Object.freeze( {
		soil: 1,
		clods: 1,
		rocks: 1,
		roots: 1,
		dust: 1,
	} ),
	estimatedTriangles: SOIL_CARRIER_TRIANGLES + CLOD_COUNT * CLOD_TRIANGLES
		+ ROCK_COUNT * ROCK_TRIANGLES
		+ ROOT_SEGMENT_LIMIT * ROOT_TRIANGLES,
} );

const clamp01 = ( value ) => Math.min( 1, Math.max( 0, value ) );

function hashUint( value ) {

	let x = value >>> 0;
	x = Math.imul( x ^ ( x >>> 16 ), 0x7FEB352D );
	x = Math.imul( x ^ ( x >>> 15 ), 0x846CA68B );
	return ( x ^ ( x >>> 16 ) ) >>> 0;

}

function random01( index, stream, seed ) {

	const word = ( seed ^ Math.imul( index + 1, 0x9E3779B1 )
		^ Math.imul( stream + 1, 0x85EBCA77 ) ) >>> 0;
	return hashUint( word ) / 0x100000000;

}

function writeInstance( target, index, position, scale, rotation ) {

	const offset = index * 9;
	target[ offset ] = position[ 0 ];
	target[ offset + 1 ] = position[ 1 ];
	target[ offset + 2 ] = position[ 2 ];
	target[ offset + 3 ] = scale[ 0 ];
	target[ offset + 4 ] = scale[ 1 ];
	target[ offset + 5 ] = scale[ 2 ];
	target[ offset + 6 ] = rotation[ 0 ];
	target[ offset + 7 ] = rotation[ 1 ];
	target[ offset + 8 ] = rotation[ 2 ];

}

function writeRoot( roots, segments, from, to, radius ) {

	if ( segments >= ROOT_SEGMENT_LIMIT ) return segments;
	const offset = segments * 7;
	roots[ offset ] = from[ 0 ];
	roots[ offset + 1 ] = from[ 1 ];
	roots[ offset + 2 ] = from[ 2 ];
	roots[ offset + 3 ] = to[ 0 ];
	roots[ offset + 4 ] = to[ 1 ];
	roots[ offset + 5 ] = to[ 2 ];
	roots[ offset + 6 ] = radius;
	return segments + 1;

}

export function soilLayerAtDepth( depth, thickness ) {

	const fraction = clamp01( Math.max( 0, depth ) / Math.max( 0.001, thickness ) );
	return SOIL_LAYERS.find( ( layer ) => fraction <= layer.to ) || SOIL_LAYERS.at( - 1 );

}

export function isInsideUndergroundBlock( point, world, thickness ) {

	const half = Math.max( 0, world ) * 0.5;
	return Number.isFinite( point?.x ) && Number.isFinite( point?.y )
		&& Number.isFinite( point?.z )
		&& point.y < 0 && point.y >= - Math.max( 0, thickness )
		&& Math.abs( point.x ) <= half && Math.abs( point.z ) <= half;

}

export function isEmbeddedInExcavationShell(
	distance, radius, relief, instanceRadius, type,
) {

	if ( ! Number.isFinite( distance ) || ! Number.isFinite( radius )
		|| ! Number.isFinite( relief ) || ! Number.isFinite( instanceRadius ) ) return false;
	const safeSurface = Math.max( 0, radius ) * ( 1 + Math.max( 0, relief ) * 0.035 );
	const size = Math.max( 0, instanceRadius );
	const clod = type === 'clod';
	const inner = safeSurface + size * ( clod ? 0.82 : 0.65 );
	const outer = inner + ( clod ? 0.48 : 0.65 );
	return distance >= inner && distance <= outer;

}

export function wrapPeriodicCoordinate( coordinate, focus, span = TILE_SPAN ) {

	if ( ! Number.isFinite( coordinate ) || ! Number.isFinite( focus ) ) return coordinate;
	const period = Math.abs( span );
	if ( ! Number.isFinite( period ) || period < 1e-6 ) return coordinate;
	return coordinate + Math.round( ( focus - coordinate ) / period ) * period;

}

export function generateUndergroundVisualLayout( {
	world,
	thickness,
	seed = 0x51A71F1E,
} ) {

	if ( ! Number.isFinite( world ) || world <= 0 )
		throw new RangeError( 'Underground visual world must be positive' );
	if ( ! Number.isFinite( thickness ) || thickness <= 0 )
		throw new RangeError( 'Underground visual thickness must be positive' );

	const tileHalf = TILE_SPAN * 0.5;
	const safeDepth = Math.max( 0.2, thickness - 0.2 );
	const clods = new Float32Array( CLOD_COUNT * 9 );
	for ( let index = 0; index < CLOD_COUNT; index ++ ) {

		const scale = 0.72 + random01( index, 3, seed ) * 0.85;
		writeInstance(
			clods,
			index,
			[
				( random01( index, 0, seed ) * 2 - 1 ) * tileHalf,
				- 0.1 - random01( index, 1, seed ) * safeDepth,
				( random01( index, 2, seed ) * 2 - 1 ) * tileHalf,
			],
			[
				scale * ( 0.72 + random01( index, 4, seed ) * 0.55 ),
				scale * ( 0.64 + random01( index, 5, seed ) * 0.48 ),
				scale * ( 0.72 + random01( index, 6, seed ) * 0.55 ),
			],
			[
				random01( index, 7, seed ) * Math.PI,
				random01( index, 8, seed ) * Math.PI * 2,
				random01( index, 9, seed ) * Math.PI,
			],
		);

	}

	const rocks = new Float32Array( ROCK_COUNT * 9 );
	for ( let index = 0; index < ROCK_COUNT; index ++ ) {

		const scale = 0.38 + random01( index, 23, seed ) ** 2 * 1.15;
		writeInstance(
			rocks,
			index,
			[
				( random01( index, 20, seed ) * 2 - 1 ) * tileHalf,
				- 0.18 - random01( index, 21, seed ) * Math.max( 0.2, safeDepth - 0.2 ),
				( random01( index, 22, seed ) * 2 - 1 ) * tileHalf,
			],
			[
				scale * ( 0.68 + random01( index, 24, seed ) * 0.65 ),
				scale * ( 0.55 + random01( index, 25, seed ) * 0.55 ),
				scale * ( 0.68 + random01( index, 26, seed ) * 0.65 ),
			],
			[
				random01( index, 27, seed ) * Math.PI,
				random01( index, 28, seed ) * Math.PI * 2,
				random01( index, 29, seed ) * Math.PI,
			],
		);

	}

	const roots = new Float32Array( ROOT_SEGMENT_LIMIT * 7 );
	const cells = Math.max( 2, Math.round( TILE_SPAN / ROOT_SPACING ) );
	const spacing = TILE_SPAN / cells;
	let rootCount = 0;
	let rootId = 0;
	for ( let ix = 0; ix < cells; ix ++ ) for ( let iz = 0; iz < cells; iz ++ ) {

		const anchor = [
			- tileHalf + ( ix + 0.5 ) * spacing
				+ ( random01( rootId, 40, seed ) - 0.5 ) * spacing * 0.55,
			- 0.04,
			- tileHalf + ( iz + 0.5 ) * spacing
				+ ( random01( rootId, 41, seed ) - 0.5 ) * spacing * 0.55,
		];
		let cursor = anchor;
		const trunkPoints = [ anchor ];
		for ( let segment = 0; segment < 5; segment ++ ) {

			const next = [
				cursor[ 0 ] + ( random01( rootId * 7 + segment, 42, seed ) - 0.5 ) * 0.72,
				Math.max( - ROOT_DEPTH, cursor[ 1 ] - 0.72
					- random01( rootId * 7 + segment, 43, seed ) * 0.42 ),
				cursor[ 2 ] + ( random01( rootId * 7 + segment, 44, seed ) - 0.5 ) * 0.72,
			];
			rootCount = writeRoot(
				roots,
				rootCount,
				cursor,
				next,
				0.18 * ( 1 - segment / 6 ) + 0.035,
			);
			trunkPoints.push( next );
			cursor = next;

		}

		for ( const branchIndex of [ 1, 3 ] ) {

			cursor = trunkPoints[ branchIndex ];
			const angle = random01( rootId * 5 + branchIndex, 45, seed ) * Math.PI * 2;
			for ( let segment = 0; segment < 2; segment ++ ) {

				const spread = 0.65 + segment * 0.25;
				const next = [
					cursor[ 0 ] + Math.cos( angle + segment * 0.22 ) * spread,
					Math.max( - ROOT_DEPTH, cursor[ 1 ] - 0.38
						- random01( rootId * 5 + segment, 46 + branchIndex, seed ) * 0.32 ),
					cursor[ 2 ] + Math.sin( angle + segment * 0.22 ) * spread,
				];
				rootCount = writeRoot(
					roots,
					rootCount,
					cursor,
					next,
					0.09 * ( 1 - segment * 0.35 ) + 0.018,
				);
				cursor = next;

			}

		}
		rootId ++;

	}

	const dust = new Float32Array( DUST_COUNT * 4 );
	for ( let index = 0; index < DUST_COUNT; index ++ ) {

		const angle = random01( index, 60, seed ) * Math.PI * 2;
		const z = random01( index, 61, seed ) * 2 - 1;
		const radius = Math.cbrt( random01( index, 62, seed ) );
		const planar = Math.sqrt( Math.max( 0, 1 - z * z ) ) * radius;
		const offset = index * 4;
		dust[ offset ] = Math.cos( angle ) * planar;
		dust[ offset + 1 ] = z * radius;
		dust[ offset + 2 ] = Math.sin( angle ) * planar;
		dust[ offset + 3 ] = random01( index, 63, seed );

	}

	return Object.freeze( {
		version: UNDERGROUND_VISUAL_VERSION,
		tileSpan: TILE_SPAN,
		clods,
		rocks,
		roots: roots.slice( 0, rootCount * 7 ),
		rootCount,
		dust,
	} );

}
