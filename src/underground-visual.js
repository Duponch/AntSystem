// Deterministic authoring data for the underground camera biome.
//
// This module deliberately contains no Three.js dependency. The render layer
// consumes one immutable, bounded bake; tests can therefore prove that the
// stylised soil never grows with the ant population or the nest topology.

export const UNDERGROUND_VISUAL_VERSION = 'camera-excavation-v2';

export const SOIL_LAYERS = Object.freeze( [
	Object.freeze( { id: 'humus', from: 0.00, to: 0.08, color: 0x3a2114 } ),
	Object.freeze( { id: 'topsoil', from: 0.08, to: 0.28, color: 0x5a3018 } ),
	Object.freeze( { id: 'clay', from: 0.28, to: 0.52, color: 0x8a441b } ),
	Object.freeze( { id: 'ochre', from: 0.52, to: 0.78, color: 0xc2782e } ),
	Object.freeze( { id: 'bedrock', from: 0.78, to: 1.00, color: 0xb9996a } ),
] );

const CLOD_COUNT = 3375;
const ROOT_SEGMENT_LIMIT = 1152;
const ROOT_DEPTH = 8.5;
const TILE_SPAN = 26;
const ROOT_SPACING = 5;
const CLOD_TRIANGLES = 20;
const ROOT_TRIANGLES = 20;
const SOIL_CARRIER_TRIANGLES = 12;

export const UNDERGROUND_ARTIFACT_CATALOG = Object.freeze( {
	rock: Object.freeze( {
		url: '/assets/Rock.glb', capacity: 256, visibleLimit: 18, triangles: 166, stream: 20, configPrefix: 'Rock',
	} ),
	bone: Object.freeze( {
		url: '/assets/Bone.glb', capacity: 64, visibleLimit: 8, triangles: 304, stream: 40, configPrefix: 'Bone',
	} ),
	fishBone: Object.freeze( {
		url: '/assets/FishBone.glb', capacity: 48, visibleLimit: 7, triangles: 588, stream: 60, configPrefix: 'FishBone',
	} ),
} );

export const UNDERGROUND_VISUAL_BUDGET = Object.freeze( {
	clods: CLOD_COUNT,
	rootSegments: ROOT_SEGMENT_LIMIT,
	rootDepth: ROOT_DEPTH,
	tileSpan: TILE_SPAN,
	drawCalls: Object.freeze( {
		soil: 1,
		clods: 1,
		roots: 1,
		rock: 1,
		bone: 1,
		fishBone: 1,
	} ),
	estimatedTriangles: SOIL_CARRIER_TRIANGLES + CLOD_COUNT * CLOD_TRIANGLES
		+ ROOT_SEGMENT_LIMIT * ROOT_TRIANGLES
		+ Object.values( UNDERGROUND_ARTIFACT_CATALOG ).reduce(
			( total, item ) => total + item.capacity * item.triangles, 0 ),
} );
const clamp01 = ( value ) => Math.min( 1, Math.max( 0, value ) );

export function artifactScale( size, variation, rank ) {

	const safeSize = Math.min( 2.5, Math.max( 0, Number.isFinite( size ) ? size : 0 ) );
	const safeVariation = clamp01( Number.isFinite( variation ) ? variation : 0 );
	const safeRank = clamp01( Number.isFinite( rank ) ? rank : 0.5 );
	return Math.min( 2.5, safeSize * ( 1 + ( safeRank * 2 - 1 ) * safeVariation * 0.5 ) );

}

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
	distance, radius, relief, instanceRadius, type, exposure = 0.72,
) {

	if ( ! Number.isFinite( distance ) || ! Number.isFinite( radius )
		|| ! Number.isFinite( relief ) || ! Number.isFinite( instanceRadius ) ) return false;
	const baseSurface = Math.max( 0, radius );
	const maximumSurface = baseSurface * ( 1 + Math.max( 0, relief ) * 0.035 );
	const size = Math.max( 0, instanceRadius );
	const clod = type === 'clod';
	const safeExposure = Number.isFinite( exposure )
		? Math.min( 1.2, Math.max( 0, exposure ) )
		: 0.72;
	const preferred = baseSurface + size * ( clod ? 0.82 : - safeExposure );
	// Cette bande ne sert qu'à choisir des candidats déterministes autour de la
	// coque. Le runtime les reprojette ensuite vers sa face visible selon le
	// réglage d'exposition, sans modifier le nombre d'instances ni de draws.
	const connected = maximumSurface - size * 0.92;
	const inner = Math.max( preferred, connected );
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

	const artifacts = {};
	for ( const [ key, item ] of Object.entries( UNDERGROUND_ARTIFACT_CATALOG ) ) {

		const values = new Float32Array( item.capacity * 8 );
		for ( let index = 0; index < item.capacity; index ++ ) {

			const offset = index * 8;
			values[ offset ] = ( random01( index, item.stream, seed ) * 2 - 1 ) * tileHalf;
			values[ offset + 1 ] = - 0.15 - random01( index, item.stream + 1, seed ) * safeDepth;
			values[ offset + 2 ] = ( random01( index, item.stream + 2, seed ) * 2 - 1 ) * tileHalf;
			values[ offset + 3 ] = random01( index, item.stream + 3, seed ) * Math.PI * 2;
			values[ offset + 4 ] = random01( index, item.stream + 4, seed ) * Math.PI * 2;
			values[ offset + 5 ] = random01( index, item.stream + 5, seed ) * Math.PI * 2;
			values[ offset + 6 ] = random01( index, item.stream + 6, seed );
			values[ offset + 7 ] = ( index + 0.5 ) / item.capacity;

		}
		artifacts[ key ] = values;

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

	return Object.freeze( {
		version: UNDERGROUND_VISUAL_VERSION,
		tileSpan: TILE_SPAN,
		clods,
		artifacts: Object.freeze( artifacts ),
		roots: roots.slice( 0, rootCount * 7 ),
		rootCount,
	} );

}
