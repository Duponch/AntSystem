// Pure partition/merge helpers for the one-shot corridor surface bake.
//
// A corridor is an independent compilation unit: its clean SDF contains its
// own capsule chain and, at most, its two terminal chambers. Keeping the whole
// corridor on one worker preserves the exact floating-point operation order of
// compileCorridorSurfaceTracks while allowing several corridors to bake in
// parallel.

import {
	compileCorridorSurfaceTracks,
	CORRIDOR_SURFACE_TRACKS,
} from './support-geometry.js';

function clonePoint( point ) {

	return { x: point.x, y: point.y, depth: point.depth };

}

function cloneDirection( direction ) {

	return { x: direction.x, y: direction.y, z: direction.z };

}

function cloneCorridor( corridor ) {

	return {
		id: corridor.id,
		from: corridor.from,
		to: corridor.to,
		radius: corridor.radius,
		axisPoints: corridor.axisPoints.map( clonePoint ),
		capsulePoints: corridor.capsulePoints?.map( clonePoint ),
		frames: corridor.frames.map( ( frame ) => ( {
			tangent: cloneDirection( frame.tangent ),
			normal: cloneDirection( frame.normal ),
			binormal: cloneDirection( frame.binormal ),
		} ) ),
		wallWeights: Array.from( corridor.wallWeights ?? [] ),
	};

}

function cloneUnit( unit ) {

	return {
		x: unit.x,
		y: unit.y,
		depth: unit.depth,
		rwx: unit.rwx,
		rwz: unit.rwz,
		rh: unit.rh,
	};

}

export function partitionCorridorIds( corridors, requestedPartitions ) {

	const ids = corridors
		.filter( Boolean )
		.map( ( corridor ) => corridor.id )
		.sort( ( a, b ) => a - b );
	if ( ids.length === 0 ) return [];
	const count = Math.max( 1, Math.min(
		ids.length,
		Math.floor( requestedPartitions ) || 1,
	) );
	const partitions = Array.from( { length: count }, () => [] );
	for ( let index = 0; index < ids.length; index ++ )
		partitions[ index % count ].push( ids[ index ] );
	return partitions;

}

export function createCorridorSurfacePartitionInput( {
	nest,
	corridors,
	samples,
	texel,
	maxNodes,
	tracks = CORRIDOR_SURFACE_TRACKS,
	endpointFade,
	tunnelRadiusScale,
}, corridorIds ) {

	const byId = new Map( corridors.filter( Boolean ).map( ( corridor ) => [
		corridor.id, corridor,
	] ) );
	const selected = corridorIds.map( ( id ) => {

		const corridor = byId.get( id );
		if ( ! corridor ) throw new Error( `Unknown surface corridor ${ id }` );
		return cloneCorridor( corridor );

	} );
	return {
		nest: {
			K: nest.K,
			units: ( nest.units ?? [] ).map( cloneUnit ),
		},
		corridors: selected,
		samples,
		texel,
		maxNodes,
		tracks,
		endpointFade,
		tunnelRadiusScale,
	};

}

export function compileCorridorSurfacePartition( input ) {

	const {
		nest,
		corridors: selected,
		samples,
		texel,
		maxNodes,
		tracks = CORRIDOR_SURFACE_TRACKS,
		endpointFade,
		tunnelRadiusScale,
	} = input;
	if ( ! Number.isInteger( maxNodes ) || maxNodes < 2 )
		throw new Error( 'Surface partition needs a positive node capacity' );
	const corridors = new Array( maxNodes ).fill( null );
	for ( const corridor of selected ) {

		if ( ! Number.isInteger( corridor.id ) || corridor.id <= 0 || corridor.id >= maxNodes )
			throw new Error( `Invalid surface corridor id ${ corridor.id }` );
		if ( corridors[ corridor.id ] )
			throw new Error( `Duplicate surface corridor id ${ corridor.id }` );
		corridors[ corridor.id ] = corridor;

	}
	const compilation = compileCorridorSurfaceTracks( {
		nest,
		corridors,
		samples,
		texel,
		maxNodes,
		tracks,
		endpointFade,
		tunnelRadiusScale,
	} );
	return {
		corridors: selected.map( ( corridor ) => ( {
			id: corridor.id,
			surfaceTracks: corridor.surfaceTracks,
			surfaceSupports: corridor.surfaceSupports,
			surfaceLengths: corridor.surfaceLengths,
			maxSurfaceStretch: corridor.maxSurfaceStretch,
		} ) ),
		maxSurfaceStretch: compilation.maxSurfaceStretch,
	};

}

export function surfacePartitionTransferList( result ) {

	const buffers = [];
	for ( const corridor of result.corridors ) buffers.push(
		corridor.surfaceTracks.buffer,
		corridor.surfaceSupports.buffer,
		corridor.surfaceLengths.buffer,
	);
	return buffers;

}

export function mergeCorridorSurfacePartitions( {
	corridors,
	samples,
	maxNodes,
	tracks = CORRIDOR_SURFACE_TRACKS,
	texel,
}, partitions ) {

	const stride = samples * tracks * 4;
	const positionData = new Float32Array( maxNodes * stride );
	const supportData = new Float32Array( maxNodes * stride );
	const expected = new Set( corridors.filter( Boolean ).map( ( corridor ) => corridor.id ) );
	let maxSurfaceStretch = 1;

	for ( const partition of partitions ) {

		if ( ! partition || ! Array.isArray( partition.corridors ) )
			throw new Error( 'Malformed corridor surface partition' );
		maxSurfaceStretch = Math.max( maxSurfaceStretch, partition.maxSurfaceStretch );

		for ( const compiled of partition.corridors ) {

			const corridor = corridors[ compiled.id ];
			if ( ! corridor || ! expected.delete( compiled.id ) )
				throw new Error( `Unexpected or duplicate surface corridor ${ compiled.id }` );
			if ( ! ( compiled.surfaceTracks instanceof Float32Array )
				|| compiled.surfaceTracks.length !== stride
				|| ! ( compiled.surfaceSupports instanceof Float32Array )
				|| compiled.surfaceSupports.length !== stride
				|| ! ( compiled.surfaceLengths instanceof Float32Array )
				|| compiled.surfaceLengths.length !== tracks
				|| ! Number.isFinite( compiled.maxSurfaceStretch ) )
				throw new Error( `Malformed surface buffers for corridor ${ compiled.id }` );

			const start = compiled.id * stride;
			positionData.set( compiled.surfaceTracks, start );
			supportData.set( compiled.surfaceSupports, start );
			corridor.surfaceTracks = compiled.surfaceTracks;
			corridor.surfaceSupports = compiled.surfaceSupports;
			corridor.surfaceLengths = compiled.surfaceLengths;
			corridor.surfaceTexel = texel;
			corridor.maxSurfaceStretch = compiled.maxSurfaceStretch;

		}

	}
	if ( expected.size > 0 )
		throw new Error( `Missing surface corridors: ${ [ ...expected ].join( ', ' ) }` );
	return { positionData, supportData, maxSurfaceStretch };

}
