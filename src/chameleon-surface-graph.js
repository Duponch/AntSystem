/**
 * Global, baked surface graph for the chameleon.
 *
 * Geometry and collision work is deliberately confined to the bake and route
 * planning phases.  A running chameleon only receives a compact SoA corridor;
 * it never scans this graph, prop geometry, or the complete map per tick.
 */

import {
	CHAMELEON_TRACK_SAMPLES,
	buildChameleonTrack,
	selectChameleonHost,
} from './chameleon-track.js';

export const CHAMELEON_SURFACE_KIND = Object.freeze( {
	TERRAIN: 0,
	SUPPORT: 1,
	TRANSITION: 2,
} );

export const CHAMELEON_SURFACE_KIND_NAMES = Object.freeze( [
	'terrain',
	'support',
	'transition',
] );

export const CHAMELEON_SURFACE_CLASS = Object.freeze( {
	TERRAIN: 0,
	LINEAR: 1,
	ROCK: 2,
	TREE: 3,
} );

export const CHAMELEON_SURFACE_MAX_NODES = 8192;
export const CHAMELEON_CORRIDOR_MAX_SAMPLES = 384;

const LINEAR_MODELS = new Set( [ 'Log_01', 'Log_02', 'Branch' ] );
const ROCK_MODELS = new Set( [
	'Stump_01', 'BigRock_03',
	'Rock_01', 'Rock_02', 'Rock_03', 'Rock_04', 'Rock_05',
] );
const TREE_MODELS = new Set( [
	'Tree_01', 'Tree_02', 'Tree_06', 'Tree_07', 'Tree_08',
] );
const WALKABLE_MODELS = new Set( [
	...LINEAR_MODELS,
	...ROCK_MODELS,
	...TREE_MODELS,
] );

const EPSILON = 1e-7;

function clamp( value, low, high ) {

	return Math.min( high, Math.max( low, value ) );

}

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function categoryScaleFor( category, scales ) {

	if ( category === 'obstacles' ) return scales?.obstacles ?? 1;
	if ( category === 'trees' ) return scales?.trees ?? 1;
	if ( category === 'rocks' ) return scales?.rocks ?? 1;
	return 1;

}

function modelClass( model ) {

	if ( LINEAR_MODELS.has( model ) ) return CHAMELEON_SURFACE_CLASS.LINEAR;
	if ( ROCK_MODELS.has( model ) ) return CHAMELEON_SURFACE_CLASS.ROCK;
	if ( TREE_MODELS.has( model ) ) return CHAMELEON_SURFACE_CLASS.TREE;
	return - 1;

}

function readBounds( attribute ) {

	let minX = Infinity;
	let maxX = - Infinity;
	let minY = Infinity;
	let maxY = - Infinity;
	let minZ = Infinity;
	let maxZ = - Infinity;
	for ( let index = 0; index < attribute.count; index ++ ) {

		const x = attribute.getX( index );
		const y = attribute.getY( index );
		const z = attribute.getZ( index );
		minX = Math.min( minX, x );
		maxX = Math.max( maxX, x );
		minY = Math.min( minY, y );
		maxY = Math.max( maxY, y );
		minZ = Math.min( minZ, z );
		maxZ = Math.max( maxZ, z );

	}
	return { minX, maxX, minY, maxY, minZ, maxZ };

}

function quantile( values, alpha ) {

	if ( values.length === 0 ) return 0;
	values.sort( ( a, b ) => a - b );
	return values[ Math.min(
		values.length - 1,
		Math.max( 0, Math.round( ( values.length - 1 ) * alpha ) ),
	) ];

}

function estimateTreeRadius( position, bounds ) {

	const centreX = ( bounds.minX + bounds.maxX ) * 0.5;
	const centreZ = ( bounds.minZ + bounds.maxZ ) * 0.5;
	const lowCeiling = bounds.minY + ( bounds.maxY - bounds.minY ) * 0.2;
	const radii = [];
	for ( let index = 0; index < position.count; index ++ ) {

		if ( position.getY( index ) > lowCeiling ) continue;
		const radius = Math.hypot(
			position.getX( index ) - centreX,
			position.getZ( index ) - centreZ,
		);
		if ( radius > EPSILON ) radii.push( radius );

	}
	const fallback = Math.min(
		bounds.maxX - bounds.minX,
		bounds.maxZ - bounds.minZ,
	) * 0.15;
	const measured = quantile( radii, 0.72 ) || fallback;
	const maximum = Math.max( fallback, Math.min(
		bounds.maxX - bounds.minX,
		bounds.maxZ - bounds.minZ,
	) * 0.32 );
	return clamp( measured, Math.max( 0.012, fallback * 0.35 ), maximum );

}

function rotateLocalToWorld( localX, localZ, yaw ) {

	const sin = Math.sin( yaw );
	const cos = Math.cos( yaw );
	return {
		x: localX * cos + localZ * sin,
		z: - localX * sin + localZ * cos,
	};

}

function rotateWorldToLocal( worldX, worldZ, yaw ) {

	const sin = Math.sin( yaw );
	const cos = Math.cos( yaw );
	return {
		x: worldX * cos - worldZ * sin,
		z: worldX * sin + worldZ * cos,
	};

}

function collectWalkablePlacements( registry, scales, groundClearance ) {

	const supports = [];
	for ( const entry of registry || [] ) {

		if ( ! WALKABLE_MODELS.has( entry.model ) ) continue;
		const position = entry.mesh?.geometry?.getAttribute?.( 'position' );
		if ( ! position || position.count <= 0 ) continue;
		const bounds = readBounds( position );
		const surfaceClass = modelClass( entry.model );
		const categoryScale = categoryScaleFor( entry.category, scales );
		for ( let placementIndex = 0; placementIndex < ( entry.placements?.length || 0 ); placementIndex ++ ) {

			const placement = entry.placements[ placementIndex ];
			const scale = Math.max(
				0.0001,
				finiteOr( placement.scale, 1 ) * categoryScale,
			);
			const support = {
				id: supports.length,
				entry,
				placement,
				placementIndex,
				model: entry.model,
				surfaceClass,
				position,
				bounds,
				scale,
				categoryScale,
				yaw: finiteOr( placement.yaw, 0 ),
				x: finiteOr( placement.x, 0 ),
				y: finiteOr( placement.y, 0 ),
				z: finiteOr( placement.z, 0 ),
			};
			if ( surfaceClass === CHAMELEON_SURFACE_CLASS.LINEAR ) {

				support.footprint = {
					type: 'box',
					supportId: support.id,
					x: support.x,
					z: support.z,
					yaw: support.yaw,
					halfX: ( bounds.maxX - bounds.minX ) * scale * 0.5 + groundClearance,
					halfZ: ( bounds.maxZ - bounds.minZ ) * scale * 0.5 + groundClearance,
				};

			} else if ( surfaceClass === CHAMELEON_SURFACE_CLASS.TREE ) {

				support.treeRadius = estimateTreeRadius( position, bounds );
				support.footprint = {
					type: 'circle',
					supportId: support.id,
					x: support.x,
					z: support.z,
					radius: support.treeRadius * scale + groundClearance,
				};

			} else {

				// A circumscribed disc is conservative for irregular rocks and
				// matches the obstacle clearance contract used by the ant map.
				const halfX = ( bounds.maxX - bounds.minX ) * 0.5;
				const halfZ = ( bounds.maxZ - bounds.minZ ) * 0.5;
				support.footprint = {
					type: 'circle',
					supportId: support.id,
					x: support.x,
					z: support.z,
					radius: Math.hypot( halfX, halfZ ) * scale + groundClearance,
				};

			}
			supports.push( support );

		}

	}
	return supports;

}

function pointInsideFootprint( x, z, footprint, padding = 0 ) {

	if ( footprint.type === 'circle' ) {

		const dx = x - footprint.x;
		const dz = z - footprint.z;
		const radius = footprint.radius + padding;
		return dx * dx + dz * dz < radius * radius - EPSILON;

	}
	const local = rotateWorldToLocal(
		x - footprint.x,
		z - footprint.z,
		footprint.yaw,
	);
	return Math.abs( local.x ) < footprint.halfX + padding - EPSILON
		&& Math.abs( local.z ) < footprint.halfZ + padding - EPSILON;

}

function pointClear( x, z, footprints, ignoreSupportId = - 1, padding = 0 ) {

	for ( const footprint of footprints ) {

		if ( footprint.supportId === ignoreSupportId ) continue;
		if ( pointInsideFootprint( x, z, footprint, padding ) ) return false;

	}
	return true;

}

function segmentClear(
	ax, az, bx, bz,
	footprints,
	ignoreSupportId,
	probeSpacing,
) {

	const length = Math.hypot( bx - ax, bz - az );
	const count = Math.max( 1, Math.ceil( length / probeSpacing ) );
	for ( let index = 0; index <= count; index ++ ) {

		const alpha = index / count;
		if ( ! pointClear(
			ax + ( bx - ax ) * alpha,
			az + ( bz - az ) * alpha,
			footprints,
			ignoreSupportId,
		) ) return false;

	}
	return true;

}

function makeGraphBuilder( maximumNodes ) {

	return {
		maximumNodes,
		x: [],
		y: [],
		z: [],
		nx: [],
		ny: [],
		nz: [],
		kind: [],
		supportId: [],
		edgesA: [],
		edgesB: [],
		edgeKeys: new Set(),
	};

}

function appendNode( builder, x, y, z, nx, ny, nz, kind, supportId ) {

	if ( builder.x.length >= builder.maximumNodes ) {

		throw new RangeError( `chameleon surface graph exceeds ${ builder.maximumNodes } nodes` );

	}
	const normalLength = Math.hypot( nx, ny, nz ) || 1;
	const index = builder.x.length;
	builder.x.push( x );
	builder.y.push( y );
	builder.z.push( z );
	builder.nx.push( nx / normalLength );
	builder.ny.push( ny / normalLength );
	builder.nz.push( nz / normalLength );
	builder.kind.push( kind );
	builder.supportId.push( supportId );
	return index;

}

function addUndirectedEdge( builder, a, b ) {

	if ( a === b || a < 0 || b < 0 ) return;
	const low = Math.min( a, b );
	const high = Math.max( a, b );
	const key = `${ low }:${ high }`;
	if ( builder.edgeKeys.has( key ) ) return;
	builder.edgeKeys.add( key );
	builder.edgesA.push( low );
	builder.edgesB.push( high );

}

function nodeDistance( builder, a, b ) {

	return Math.hypot(
		builder.x[ b ] - builder.x[ a ],
		builder.y[ b ] - builder.y[ a ],
		builder.z[ b ] - builder.z[ a ],
	);

}

function appendPolyline( builder, points, kind, supportId ) {

	const nodes = new Int32Array( points.length );
	for ( let index = 0; index < points.length; index ++ ) {

		const point = points[ index ];
		nodes[ index ] = appendNode(
			builder,
			point.x, point.y, point.z,
			point.nx, point.ny, point.nz,
			kind,
			supportId,
		);
		if ( index > 0 ) addUndirectedEdge( builder, nodes[ index - 1 ], nodes[ index ] );

	}
	return nodes;

}

function trackPoints( track ) {

	const points = new Array( track.count );
	for ( let index = 0; index < track.count; index ++ ) {

		points[ index ] = {
			x: track.x[ index ],
			y: track.y[ index ],
			z: track.z[ index ],
			nx: track.normalX[ index ],
			ny: track.normalY[ index ],
			nz: track.normalZ[ index ],
		};

	}
	return points;

}

function buildTreeHelix( support, {
	objectSamples,
	supportClearance,
	treeClimbFraction,
	treeTurns,
} ) {

	const count = clamp( Math.round( objectSamples * 1.5 ), 24, 96 );
	const points = new Array( count );
	const bounds = support.bounds;
	const height = Math.max( EPSILON, bounds.maxY - bounds.minY );
	const centreX = ( bounds.minX + bounds.maxX ) * 0.5;
	const centreZ = ( bounds.minZ + bounds.maxZ ) * 0.5;
	// The base faces the map centre. This leaves a usable ground portal even
	// for the tree ring close to the world boundary.
	const inwardWorldAngle = Math.atan2( - support.z, - support.x );
	const localStartAngle = inwardWorldAngle + support.yaw;
	const climb = height * clamp( treeClimbFraction, 0.12, 0.82 );
	for ( let index = 0; index < count; index ++ ) {

		const alpha = index / ( count - 1 );
		const eased = alpha * alpha * ( 3 - 2 * alpha );
		const angle = localStartAngle + alpha * treeTurns * Math.PI * 2;
		const radius = support.treeRadius * ( 1 - alpha * 0.28 )
			* ( 1 + Math.sin( alpha * Math.PI * 7 + support.id ) * 0.035 );
		const localX = centreX + Math.cos( angle ) * radius;
		const localZ = centreZ + Math.sin( angle ) * radius;
		const localNormalX = Math.cos( angle );
		const localNormalZ = Math.sin( angle );
		const worldOffset = rotateLocalToWorld( localX, localZ, support.yaw );
		const worldNormal = rotateLocalToWorld( localNormalX, localNormalZ, support.yaw );
		points[ index ] = {
			x: support.x + worldOffset.x * support.scale
				+ worldNormal.x * supportClearance * support.scale,
			y: support.y + ( bounds.minY + height * 0.025 + climb * eased ) * support.scale,
			z: support.z + worldOffset.z * support.scale
				+ worldNormal.z * supportClearance * support.scale,
			nx: worldNormal.x,
			ny: 0,
			nz: worldNormal.z,
		};

	}
	return points;

}

function endpointDirection( points, end ) {

	const last = points.length - 1;
	const a = end === 0 ? 1 : last - 1;
	const b = end === 0 ? 0 : last;
	let x = points[ b ].x - points[ a ].x;
	let z = points[ b ].z - points[ a ].z;
	if ( Math.hypot( x, z ) <= EPSILON ) {

		x = points[ b ].nx;
		z = points[ b ].nz;

	}
	const length = Math.hypot( x, z ) || 1;
	return { x: x / length, z: z / length };

}

function cubic( p0, p1, p2, p3, t ) {

	const u = 1 - t;
	return u * u * u * p0
		+ 3 * u * u * t * p1
		+ 3 * u * t * t * p2
		+ t * t * t * p3;

}

function makeGroundAnchor(
	surface,
	direction,
	support,
	footprints,
	groundY,
	groundClearance,
) {

	let run = Math.max( 0.3, Math.abs( surface.y - groundY ) * 0.55 );
	let x = surface.x + direction.x * run;
	let z = surface.z + direction.z * run;
	// Clear the support's complete measured footprint, not just its centre.
	for ( let guard = 0; guard < 96; guard ++ ) {

		if ( ! pointInsideFootprint( x, z, support.footprint, 0.02 )
			&& pointClear( x, z, footprints, support.id ) ) break;
		run += Math.max( 0.16, groundClearance * 0.4 );
		x = surface.x + direction.x * run;
		z = surface.z + direction.z * run;

	}
	return { x, y: groundY, z, run };

}

function appendTransition(
	builder,
	surfaceNode,
	surface,
	direction,
	anchor,
	supportId,
	sampleCount,
) {

	let previous = surfaceNode;
	const count = clamp( Math.round( sampleCount ), 5, 18 );
	const handle = Math.max( 0.12, anchor.run * 0.38 );
	const p1x = surface.x + direction.x * handle;
	const p1z = surface.z + direction.z * handle;
	const p2x = anchor.x - direction.x * handle;
	const p2z = anchor.z - direction.z * handle;
	for ( let ordinal = 1; ordinal < count; ordinal ++ ) {

		const alpha = ordinal / ( count - 1 );
		const x = cubic( surface.x, p1x, p2x, anchor.x, alpha );
		const y = cubic( surface.y, surface.y, anchor.y, anchor.y, alpha );
		const z = cubic( surface.z, p1z, p2z, anchor.z, alpha );
		let nx = surface.nx * ( 1 - alpha );
		let ny = surface.ny * ( 1 - alpha ) + alpha;
		let nz = surface.nz * ( 1 - alpha );
		const length = Math.hypot( nx, ny, nz ) || 1;
		nx /= length;
		ny /= length;
		nz /= length;
		const node = appendNode(
			builder, x, y, z, nx, ny, nz,
			CHAMELEON_SURFACE_KIND.TRANSITION,
			supportId,
		);
		addUndirectedEdge( builder, previous, node );
		previous = node;

	}
	return previous;

}

function buildTerrain(
	builder,
	footprints,
	{
		worldSize,
		mapMargin,
		terrainSpacing,
		groundY,
		collisionProbeSpacing,
	},
) {

	const half = worldSize * 0.5;
	const limit = Math.max( terrainSpacing, half - mapMargin );
	const width = Math.max( 3, Math.floor( ( limit * 2 ) / terrainSpacing ) + 1 );
	const step = ( limit * 2 ) / ( width - 1 );
	const grid = new Int32Array( width * width );
	grid.fill( - 1 );
	const nodes = [];

	for ( let row = 0; row < width; row ++ ) {

		const z = - limit + step * row;
		for ( let column = 0; column < width; column ++ ) {

			const x = - limit + step * column;
			if ( ! pointClear( x, z, footprints ) ) continue;
			const node = appendNode(
				builder, x, groundY, z, 0, 1, 0,
				CHAMELEON_SURFACE_KIND.TERRAIN,
				- 1,
			);
			grid[ row * width + column ] = node;
			nodes.push( node );

		}

	}

	const neighbours = [
		[ 1, 0 ], [ 0, 1 ], [ 1, 1 ], [ - 1, 1 ],
	];
	for ( let row = 0; row < width; row ++ ) {

		for ( let column = 0; column < width; column ++ ) {

			const from = grid[ row * width + column ];
			if ( from < 0 ) continue;
			for ( const [ dc, dr ] of neighbours ) {

				const nc = column + dc;
				const nr = row + dr;
				if ( nc < 0 || nc >= width || nr < 0 || nr >= width ) continue;
				const to = grid[ nr * width + nc ];
				if ( to < 0 ) continue;
				if ( ! segmentClear(
					builder.x[ from ], builder.z[ from ],
					builder.x[ to ], builder.z[ to ],
					footprints, - 1, collisionProbeSpacing,
				) ) continue;
				addUndirectedEdge( builder, from, to );

			}

		}

	}
	return { nodes, width, step, limit };

}

function connectPortalToTerrain(
	builder,
	portalNode,
	terrainNodes,
	footprints,
	supportId,
	collisionProbeSpacing,
) {

	let best = - 1;
	let bestDistanceSq = Infinity;
	const px = builder.x[ portalNode ];
	const pz = builder.z[ portalNode ];
	for ( const node of terrainNodes ) {

		const dx = builder.x[ node ] - px;
		const dz = builder.z[ node ] - pz;
		const distanceSq = dx * dx + dz * dz;
		if ( distanceSq >= bestDistanceSq ) continue;
		if ( ! segmentClear(
			px, pz,
			builder.x[ node ], builder.z[ node ],
			footprints, supportId, collisionProbeSpacing,
		) ) continue;
		best = node;
		bestDistanceSq = distanceSq;

	}
	if ( best >= 0 ) addUndirectedEdge( builder, portalNode, best );
	return best;

}

function compileCsr( builder ) {

	const count = builder.x.length;
	const degree = new Uint32Array( count );
	for ( let edge = 0; edge < builder.edgesA.length; edge ++ ) {

		degree[ builder.edgesA[ edge ] ] ++;
		degree[ builder.edgesB[ edge ] ] ++;

	}
	const offsets = new Uint32Array( count + 1 );
	for ( let index = 0; index < count; index ++ ) {

		offsets[ index + 1 ] = offsets[ index ] + degree[ index ];

	}
	const cursor = offsets.slice( 0, count );
	const edgeTo = new Uint32Array( offsets[ count ] );
	const edgeWeight = new Float32Array( offsets[ count ] );
	for ( let edge = 0; edge < builder.edgesA.length; edge ++ ) {

		const a = builder.edgesA[ edge ];
		const b = builder.edgesB[ edge ];
		const weight = nodeDistance( builder, a, b );
		let index = cursor[ a ] ++;
		edgeTo[ index ] = b;
		edgeWeight[ index ] = weight;
		index = cursor[ b ] ++;
		edgeTo[ index ] = a;
		edgeWeight[ index ] = weight;

	}
	return { offsets, edgeTo, edgeWeight };

}

function hostMatchesSupport( host, support ) {

	return host?.entry === support.entry && host?.index === support.placementIndex;

}

/**
 * Bake all terrain and supported prop placements into one immutable graph.
 *
 * The graph covers the full map. `revision` is metadata used by the cache
 * wrapper; the pure builder itself is deterministic for identical inputs.
 */
export function buildChameleonSurfaceGraph( registry, {
	revision = 0,
	host = selectChameleonHost( registry ),
	scales = null,
	worldSize = 160,
	mapMargin = 1.5,
	terrainSpacing = 7.5,
	groundY = 0.018,
	groundClearance = 0.42,
	supportClearance = 0.006,
	objectSamples = CHAMELEON_TRACK_SAMPLES,
	transitionSamples = 9,
	treeClimbFraction = 0.58,
	treeTurns = 1.65,
	collisionProbeSpacing = 0.3,
	maximumNodes = CHAMELEON_SURFACE_MAX_NODES,
} = {} ) {

	const safeWorldSize = Math.max( 20, finiteOr( worldSize, 160 ) );
	const safeSpacing = clamp( finiteOr( terrainSpacing, 7.5 ), 2.5, 20 );
	const safeGroundClearance = Math.max( 0.02, finiteOr( groundClearance, 0.42 ) );
	const safeSupportClearance = Math.max( 0, finiteOr( supportClearance, 0.006 ) );
	const safeProbeSpacing = clamp( finiteOr( collisionProbeSpacing, 0.3 ), 0.08, 1 );
	const supports = collectWalkablePlacements(
		registry,
		scales,
		safeGroundClearance,
	);
	const footprints = supports.map( ( support ) => support.footprint );
	const builder = makeGraphBuilder( clamp(
		Math.round( finiteOr( maximumNodes, CHAMELEON_SURFACE_MAX_NODES ) ),
		512,
		CHAMELEON_SURFACE_MAX_NODES,
	) );
	const terrain = buildTerrain( builder, footprints, {
		worldSize: safeWorldSize,
		mapMargin: Math.max( 0.5, finiteOr( mapMargin, 1.5 ) ),
		terrainSpacing: safeSpacing,
		groundY: finiteOr( groundY, 0.018 ),
		collisionProbeSpacing: safeProbeSpacing,
	} );
	if ( terrain.nodes.length === 0 ) throw new Error( 'surface graph has no terrain nodes' );

	const supportMetadata = [];
	const destinationNodes = [];
	let hostNode = terrain.nodes[ Math.floor( terrain.nodes.length * 0.5 ) ];

	for ( const support of supports ) {

		let points;
		if ( support.surfaceClass === CHAMELEON_SURFACE_CLASS.TREE ) {

			points = buildTreeHelix( support, {
				objectSamples,
				supportClearance: safeSupportClearance,
				treeClimbFraction,
				treeTurns,
			} );

		} else {

			const track = buildChameleonTrack( {
				entry: support.entry,
				index: support.placementIndex,
				placement: support.placement,
			}, {
				sampleCount: objectSamples,
				scales,
				clearance: safeSupportClearance,
				endMargin: support.surfaceClass === CHAMELEON_SURFACE_CLASS.ROCK ? 0.035 : 0.07,
			} );
			points = trackPoints( track );

		}
		const surfaceNodes = appendPolyline(
			builder,
			points,
			CHAMELEON_SURFACE_KIND.SUPPORT,
			support.id,
		);
		const portals = [];
		const portalTerrainNodes = [];
		const endpointOrdinals = support.surfaceClass === CHAMELEON_SURFACE_CLASS.TREE
			? [ 0 ]
			: [ 0, points.length - 1 ];
		for ( const ordinal of endpointOrdinals ) {

			const end = ordinal === 0 ? 0 : 1;
			const surface = points[ ordinal ];
			const direction = support.surfaceClass === CHAMELEON_SURFACE_CLASS.TREE
				? ( () => {

					let x = surface.nx;
					let z = surface.nz;
					const length = Math.hypot( x, z ) || 1;
					x /= length;
					z /= length;
					return { x, z };

				} )()
				: endpointDirection( points, end );
			const anchor = makeGroundAnchor(
				surface,
				direction,
				support,
				footprints,
				finiteOr( groundY, 0.018 ),
				safeGroundClearance,
			);
			const portal = appendTransition(
				builder,
				surfaceNodes[ ordinal ],
				surface,
				direction,
				anchor,
				support.id,
				transitionSamples,
			);
			const terrainNode = connectPortalToTerrain(
				builder,
				portal,
				terrain.nodes,
				footprints,
				support.id,
				safeProbeSpacing,
			);
			portals.push( portal );
			portalTerrainNodes.push( terrainNode );

		}

		const destination = support.surfaceClass === CHAMELEON_SURFACE_CLASS.TREE
			? surfaceNodes[ surfaceNodes.length - 1 ]
			: surfaceNodes[ Math.floor( surfaceNodes.length * 0.5 ) ];
		destinationNodes.push( destination );
		if ( hostMatchesSupport( host, support ) ) hostNode = destination;
		supportMetadata.push( Object.freeze( {
			id: support.id,
			model: support.model,
			placementIndex: support.placementIndex,
			surfaceClass: support.surfaceClass,
			nodeStart: surfaceNodes[ 0 ],
			nodeEnd: surfaceNodes[ surfaceNodes.length - 1 ],
			destinationNode: destination,
			portals: Int32Array.from( portals ),
			portalTerrainNodes: Int32Array.from( portalTerrainNodes ),
			categoryScale: support.categoryScale,
		} ) );

	}

	// Sparse terrain goals make exploration cover the map without making the
	// destination scan large. This scan occurs only when a route completes.
	const destinationStride = Math.max( 1, Math.round( terrain.nodes.length / 36 ) );
	for ( let index = 0; index < terrain.nodes.length; index += destinationStride ) {

		destinationNodes.push( terrain.nodes[ index ] );

	}
	const csr = compileCsr( builder );
	const count = builder.x.length;
	const graph = {
		revision,
		count,
		x: Float32Array.from( builder.x ),
		y: Float32Array.from( builder.y ),
		z: Float32Array.from( builder.z ),
		normalX: Float32Array.from( builder.nx ),
		normalY: Float32Array.from( builder.ny ),
		normalZ: Float32Array.from( builder.nz ),
		kind: Uint8Array.from( builder.kind ),
		supportId: Int16Array.from( builder.supportId ),
		offsets: csr.offsets,
		edgeTo: csr.edgeTo,
		edgeWeight: csr.edgeWeight,
		edgeCount: builder.edgesA.length,
		terrainNodeCount: terrain.nodes.length,
		terrainWidth: terrain.width,
		terrainStep: terrain.step,
		supportCount: supportMetadata.length,
		supports: Object.freeze( supportMetadata ),
		hostNode,
		destinationNodes: Uint32Array.from( destinationNodes ),
		footprints: Object.freeze( footprints.map( ( footprint ) => Object.freeze( { ...footprint } ) ) ),
		settings: Object.freeze( {
			worldSize: safeWorldSize,
			mapMargin: Math.max( 0.5, finiteOr( mapMargin, 1.5 ) ),
			terrainSpacing: safeSpacing,
			groundY: finiteOr( groundY, 0.018 ),
			groundClearance: safeGroundClearance,
			supportClearance: safeSupportClearance,
			objectSamples: clamp( Math.round( objectSamples ), 8, 128 ),
			transitionSamples: clamp( Math.round( transitionSamples ), 5, 18 ),
			treeClimbFraction: clamp( treeClimbFraction, 0.12, 0.82 ),
			treeTurns: clamp( treeTurns, 0.25, 4 ),
			collisionProbeSpacing: safeProbeSpacing,
		} ),
	};
	return Object.freeze( graph );

}

function graphSignature( options ) {

	const scales = options.scales || {};
	return [
		options.worldSize ?? 160,
		options.mapMargin ?? 1.5,
		options.terrainSpacing ?? 7.5,
		options.groundY ?? 0.018,
		options.groundClearance ?? 0.42,
		options.supportClearance ?? 0.006,
		options.objectSamples ?? CHAMELEON_TRACK_SAMPLES,
		options.transitionSamples ?? 9,
		options.treeClimbFraction ?? 0.58,
		options.treeTurns ?? 1.65,
		options.collisionProbeSpacing ?? 0.3,
		scales.obstacles ?? 1,
		scales.trees ?? 1,
		scales.rocks ?? 1,
	].join( '|' );

}

/**
 * Revision/config cache. Calling `update` every frame is O(1); a bake occurs
 * only after the prop revision or a geometry-affecting option changes.
 */
export class ChameleonSurfaceGraphBaker {

	constructor() {

		this.graph = null;
		this.registry = null;
		this.revision = NaN;
		this.signature = '';
		this.bakeCount = 0;

	}

	update( registry, options = {} ) {

		const revision = finiteOr( options.revision, 0 );
		const signature = graphSignature( options );
		if ( this.graph
			&& this.registry === registry
			&& this.revision === revision
			&& this.signature === signature ) {

			return Object.freeze( { graph: this.graph, rebuilt: false } );

		}
		this.graph = buildChameleonSurfaceGraph( registry, options );
		this.registry = registry;
		this.revision = revision;
		this.signature = signature;
		this.bakeCount ++;
		return Object.freeze( { graph: this.graph, rebuilt: true } );

	}

	invalidate() {

		this.graph = null;
		this.registry = null;
		this.revision = NaN;
		this.signature = '';

	}

}

class MinHeap {

	constructor() {

		this.nodes = [];
		this.priorities = [];

	}

	push( node, priority ) {

		let index = this.nodes.length;
		this.nodes.push( node );
		this.priorities.push( priority );
		while ( index > 0 ) {

			const parent = ( index - 1 ) >> 1;
			if ( this.priorities[ parent ] <= priority ) break;
			this.nodes[ index ] = this.nodes[ parent ];
			this.priorities[ index ] = this.priorities[ parent ];
			index = parent;

		}
		this.nodes[ index ] = node;
		this.priorities[ index ] = priority;

	}

	pop() {

		if ( this.nodes.length === 0 ) return - 1;
		const result = this.nodes[ 0 ];
		const node = this.nodes.pop();
		const priority = this.priorities.pop();
		if ( this.nodes.length === 0 ) return result;
		let index = 0;
		while ( true ) {

			const left = index * 2 + 1;
			if ( left >= this.nodes.length ) break;
			const right = left + 1;
			let child = left;
			if ( right < this.nodes.length
				&& this.priorities[ right ] < this.priorities[ left ] ) child = right;
			if ( this.priorities[ child ] >= priority ) break;
			this.nodes[ index ] = this.nodes[ child ];
			this.priorities[ index ] = this.priorities[ child ];
			index = child;

		}
		this.nodes[ index ] = node;
		this.priorities[ index ] = priority;
		return result;

	}

	get size() {

		return this.nodes.length;

	}

}

function assertNode( graph, node, label ) {

	if ( ! Number.isInteger( node ) || node < 0 || node >= graph.count ) {

		throw new RangeError( `${ label } is outside the surface graph` );

	}

}

/** A* over the baked CSR graph. Call only when selecting a new destination. */
export function findChameleonSurfacePath( graph, startNode, targetNode ) {

	assertNode( graph, startNode, 'startNode' );
	assertNode( graph, targetNode, 'targetNode' );
	if ( startNode === targetNode ) return Uint32Array.of( startNode );
	const distance = new Float64Array( graph.count );
	distance.fill( Infinity );
	const previous = new Int32Array( graph.count );
	previous.fill( - 1 );
	const closed = new Uint8Array( graph.count );
	const heap = new MinHeap();
	distance[ startNode ] = 0;
	heap.push( startNode, 0 );

	while ( heap.size > 0 ) {

		const current = heap.pop();
		if ( current < 0 || closed[ current ] ) continue;
		if ( current === targetNode ) break;
		closed[ current ] = 1;
		for ( let edge = graph.offsets[ current ]; edge < graph.offsets[ current + 1 ]; edge ++ ) {

			const next = graph.edgeTo[ edge ];
			if ( closed[ next ] ) continue;
			const candidate = distance[ current ] + graph.edgeWeight[ edge ];
			if ( candidate >= distance[ next ] ) continue;
			distance[ next ] = candidate;
			previous[ next ] = current;
			const heuristic = Math.hypot(
				graph.x[ targetNode ] - graph.x[ next ],
				graph.y[ targetNode ] - graph.y[ next ],
				graph.z[ targetNode ] - graph.z[ next ],
			);
			heap.push( next, candidate + heuristic );

		}

	}
	if ( previous[ targetNode ] < 0 ) {

		throw new Error( `surface nodes ${ startNode } and ${ targetNode } are disconnected` );

	}
	const reverse = [];
	for ( let node = targetNode; node >= 0; node = previous[ node ] ) {

		reverse.push( node );
		if ( node === startNode ) break;

	}
	reverse.reverse();
	return Uint32Array.from( reverse );

}

function corridorSampleCount( graph, path, spacing ) {

	let count = 1;
	for ( let index = 1; index < path.length; index ++ ) {

		count += Math.max( 1, Math.ceil( Math.hypot(
			graph.x[ path[ index ] ] - graph.x[ path[ index - 1 ] ],
			graph.y[ path[ index ] ] - graph.y[ path[ index - 1 ] ],
			graph.z[ path[ index ] ] - graph.z[ path[ index - 1 ] ],
		) / spacing ) );

	}
	return count;

}

function normalizeCorridorFrames( corridor ) {

	for ( let index = 0; index < corridor.count; index ++ ) {

		const before = Math.max( 0, index - 1 );
		const after = Math.min( corridor.count - 1, index + 1 );
		let tx = corridor.x[ after ] - corridor.x[ before ];
		let ty = corridor.y[ after ] - corridor.y[ before ];
		let tz = corridor.z[ after ] - corridor.z[ before ];
		const tangentLength = Math.hypot( tx, ty, tz ) || 1;
		tx /= tangentLength;
		ty /= tangentLength;
		tz /= tangentLength;
		let nx = corridor.normalX[ index ];
		let ny = corridor.normalY[ index ];
		let nz = corridor.normalZ[ index ];
		const projection = nx * tx + ny * ty + nz * tz;
		nx -= tx * projection;
		ny -= ty * projection;
		nz -= tz * projection;
		const normalLength = Math.hypot( nx, ny, nz ) || 1;
		corridor.tangentX[ index ] = tx;
		corridor.tangentY[ index ] = ty;
		corridor.tangentZ[ index ] = tz;
		corridor.normalX[ index ] = nx / normalLength;
		corridor.normalY[ index ] = ny / normalLength;
		corridor.normalZ[ index ] = nz / normalLength;
		if ( index > 0 ) {

			corridor.distance[ index ] = corridor.distance[ index - 1 ] + Math.hypot(
				corridor.x[ index ] - corridor.x[ index - 1 ],
				corridor.y[ index ] - corridor.y[ index - 1 ],
				corridor.z[ index ] - corridor.z[ index - 1 ],
			);

		}

	}

}

/**
 * Compile a path into the only data consumed by ChameleonSimulation.
 * Every graph corner is retained; the budget only changes subdivision density,
 * so compacting can never cut through an obstacle.
 */
export function buildChameleonSurfaceCorridor( graph, path, {
	spacing = 1.15,
	maxSamples = CHAMELEON_CORRIDOR_MAX_SAMPLES,
} = {} ) {

	if ( ! path || path.length < 1 ) throw new TypeError( 'a non-empty surface path is required' );
	for ( const node of path ) assertNode( graph, node, 'path node' );
	const capacity = clamp(
		Math.round( finiteOr( maxSamples, CHAMELEON_CORRIDOR_MAX_SAMPLES ) ),
		32,
		CHAMELEON_CORRIDOR_MAX_SAMPLES,
	);
	if ( path.length > capacity ) {

		throw new RangeError( `surface path has ${ path.length } mandatory corners for a ${ capacity } sample corridor` );

	}
	let effectiveSpacing = clamp( finiteOr( spacing, 1.15 ), 0.2, 12 );
	for ( let guard = 0; guard < 24
		&& corridorSampleCount( graph, path, effectiveSpacing ) > capacity; guard ++ ) {

		effectiveSpacing *= 1.18;

	}
	const count = corridorSampleCount( graph, path, effectiveSpacing );
	if ( count > capacity ) throw new RangeError( 'surface corridor budget could not retain all corners' );
	const corridor = {
		count,
		x: new Float32Array( count ),
		y: new Float32Array( count ),
		z: new Float32Array( count ),
		normalX: new Float32Array( count ),
		normalY: new Float32Array( count ),
		normalZ: new Float32Array( count ),
		tangentX: new Float32Array( count ),
		tangentY: new Float32Array( count ),
		tangentZ: new Float32Array( count ),
		distance: new Float32Array( count ),
		kind: new Uint8Array( count ),
		supportId: new Int16Array( count ),
		graphNode: new Uint32Array( count ),
		startNode: path[ 0 ],
		targetNode: path[ path.length - 1 ],
		pathNodeCount: path.length,
		effectiveSpacing,
		supportCount: graph.supportCount,
		supports: graph.supports,
	};
	let cursor = 0;

	function write( fromNode, toNode, alpha, graphNode ) {

		corridor.x[ cursor ] = graph.x[ fromNode ]
			+ ( graph.x[ toNode ] - graph.x[ fromNode ] ) * alpha;
		corridor.y[ cursor ] = graph.y[ fromNode ]
			+ ( graph.y[ toNode ] - graph.y[ fromNode ] ) * alpha;
		corridor.z[ cursor ] = graph.z[ fromNode ]
			+ ( graph.z[ toNode ] - graph.z[ fromNode ] ) * alpha;
		corridor.normalX[ cursor ] = graph.normalX[ fromNode ]
			+ ( graph.normalX[ toNode ] - graph.normalX[ fromNode ] ) * alpha;
		corridor.normalY[ cursor ] = graph.normalY[ fromNode ]
			+ ( graph.normalY[ toNode ] - graph.normalY[ fromNode ] ) * alpha;
		corridor.normalZ[ cursor ] = graph.normalZ[ fromNode ]
			+ ( graph.normalZ[ toNode ] - graph.normalZ[ fromNode ] ) * alpha;
		const nearest = alpha < 0.5 ? fromNode : toNode;
		corridor.kind[ cursor ] = graph.kind[ nearest ];
		corridor.supportId[ cursor ] = graph.supportId[ nearest ];
		corridor.graphNode[ cursor ] = graphNode;
		cursor ++;

	}

	write( path[ 0 ], path[ 0 ], 0, path[ 0 ] );
	for ( let edge = 1; edge < path.length; edge ++ ) {

		const from = path[ edge - 1 ];
		const to = path[ edge ];
		const length = Math.hypot(
			graph.x[ to ] - graph.x[ from ],
			graph.y[ to ] - graph.y[ from ],
			graph.z[ to ] - graph.z[ from ],
		);
		const subdivisions = Math.max( 1, Math.ceil( length / effectiveSpacing ) );
		for ( let ordinal = 1; ordinal <= subdivisions; ordinal ++ ) {

			write( from, to, ordinal / subdivisions, to );

		}

	}
	normalizeCorridorFrames( corridor );
	corridor.length = corridor.distance[ count - 1 ];
	return Object.freeze( corridor );

}

/**
 * Convenience route planner used by the runtime controller. A* and corridor
 * compilation both happen here, exclusively when a destination changes.
 */
export function planChameleonRoute( graph, fromNode, toNode, options = {} ) {

	return buildChameleonSurfaceCorridor(
		graph,
		findChameleonSurfacePath( graph, fromNode, toNode ),
		options,
	);

}

/** Finds the closest graph node. This is intended for re-bakes/replans only. */
export function nearestChameleonSurfaceNode( graph, x, y, z ) {

	let best = 0;
	let bestDistanceSq = Infinity;
	for ( let node = 0; node < graph.count; node ++ ) {

		const dx = graph.x[ node ] - x;
		const dy = graph.y[ node ] - y;
		const dz = graph.z[ node ] - z;
		const distanceSq = dx * dx + dy * dy + dz * dz;
		if ( distanceSq < bestDistanceSq ) {

			bestDistanceSq = distanceSq;
			best = node;

		}

	}
	return best;

}

function nextRandom( state ) {

	let value = state.value | 0;
	value = ( value + 0x6D2B79F5 ) | 0;
	state.value = value;
	let mixed = Math.imul( value ^ ( value >>> 15 ), 1 | value );
	mixed = ( mixed + Math.imul( mixed ^ ( mixed >>> 7 ), 61 | mixed ) ) ^ mixed;
	return ( ( mixed ^ ( mixed >>> 14 ) ) >>> 0 ) / 4294967296;

}

/**
 * Destination-time router. It has intentionally no frame `update` method:
 * route planning is explicit and therefore cannot accidentally enter the hot
 * simulation loop.
 */
export class ChameleonSurfaceRouter {

	constructor( graph, {
		seed = 0x51f15e,
		spacing = 1.15,
		maxSamples = CHAMELEON_CORRIDOR_MAX_SAMPLES,
		horizonDistance = 10,
		maximumEdges = 48,
	} = {} ) {

		this.graph = graph;
		this.currentNode = graph.hostNode;
		this.previousNode = - 1;
		this.spacing = spacing;
		this.maxSamples = maxSamples;
		this.horizonDistance = Math.max( 0.5, horizonDistance );
		this.maximumEdges = clamp( Math.round( maximumEdges ), 1, 96 );
		this.seed = seed | 0;
		this.visitCounts = new Uint16Array( graph.count );
		this.visitCounts[ this.currentNode ] = 1;
		this.routeCount = 0;
		this.destinationCount = 0;
		this.explorationCount = 0;
		this.decisionCount = 0;

	}

	routeTo( targetNode, startNode = this.currentNode ) {

		const path = findChameleonSurfacePath( this.graph, startNode, targetNode );
		const corridor = buildChameleonSurfaceCorridor( this.graph, path, {
			spacing: this.spacing,
			maxSamples: this.maxSamples,
		} );
		if ( path.length > 1 ) this.previousNode = path[ path.length - 2 ];
		this.currentNode = targetNode;
		for ( const node of path ) {

			if ( this.visitCounts[ node ] < 65535 ) this.visitCounts[ node ] ++;

		}
		this.routeCount ++;
		return corridor;

	}

	_candidate( current, previous, pathNodes, radiusSq ) {

		const graph = this.graph;
		const host = graph.hostNode;
		let headingX = 0;
		let headingY = 0;
		let headingZ = 0;
		if ( previous >= 0 ) {

			headingX = graph.x[ current ] - graph.x[ previous ];
			headingY = graph.y[ current ] - graph.y[ previous ];
			headingZ = graph.z[ current ] - graph.z[ previous ];
			const length = Math.hypot( headingX, headingY, headingZ ) || 1;
			headingX /= length;
			headingY /= length;
			headingZ /= length;

		}
		let best = - 1;
		let bestScore = Infinity;
		for ( let edge = graph.offsets[ current ]; edge < graph.offsets[ current + 1 ]; edge ++ ) {

			const next = graph.edgeTo[ edge ];
			const hostDx = graph.x[ next ] - graph.x[ host ];
			const hostDz = graph.z[ next ] - graph.z[ host ];
			if ( hostDx * hostDx + hostDz * hostDz > radiusSq ) continue;
			let score = this.visitCounts[ next ] * 16;
			if ( next === previous ) score += 10;
			if ( pathNodes.has( next ) ) score += 24;
			if ( previous >= 0 ) {

				let dx = graph.x[ next ] - graph.x[ current ];
				let dy = graph.y[ next ] - graph.y[ current ];
				let dz = graph.z[ next ] - graph.z[ current ];
				const length = Math.hypot( dx, dy, dz ) || 1;
				dx /= length;
				dy /= length;
				dz /= length;
				score += ( 1 - ( dx * headingX + dy * headingY + dz * headingZ ) ) * 1.4;

			}
			// Slight surface curiosity prevents a terrain junction from always
			// winning over an unvisited climbable portal with the same history.
			if ( graph.supportId[ next ] >= 0 ) score -= 0.45;
			let hash = Math.imul( ( current + 1 ) ^ this.seed, 0x45d9f3b );
			hash = Math.imul( hash ^ ( next + 0x9e37 ), 0x45d9f3b );
			hash ^= this.decisionCount + ( hash >>> 16 );
			score += ( hash >>> 0 ) / 4294967296 * 0.08;
			if ( score < bestScore ) {

				bestScore = score;
				best = next;

			}

		}
		return best;

	}

	/**
	 * Builds a short, continuous local corridor. Choices are reactive at each
	 * junction: inertia, low visit count and deterministic tie-breaking. There
	 * is no pre-written global tour and no A* in ordinary exploration.
	 */
	exploreNext( maximumDistance = Infinity, {
		horizonDistance = this.horizonDistance,
		maximumEdges = this.maximumEdges,
	} = {} ) {

		const radius = Number.isFinite( maximumDistance )
			? Math.max( 0, maximumDistance )
			: Infinity;
		const radiusSq = radius * radius;
		const path = [ this.currentNode ];
		const pathNodes = new Set( path );
		let current = this.currentNode;
		let previous = this.previousNode;
		let travelled = 0;
		const edgeLimit = clamp( Math.round( maximumEdges ), 1, 96 );
		for ( let ordinal = 0; ordinal < edgeLimit; ordinal ++ ) {

			let next = this._candidate( current, previous, pathNodes, radiusSq );
			if ( next < 0 ) {

				// Outside a newly reduced radius: take the adjacent node that moves
				// closest to the host rather than teleporting back into the area.
				let closestSq = Infinity;
				for ( let edge = this.graph.offsets[ current ]; edge < this.graph.offsets[ current + 1 ]; edge ++ ) {

					const candidate = this.graph.edgeTo[ edge ];
					const dx = this.graph.x[ candidate ] - this.graph.x[ this.graph.hostNode ];
					const dz = this.graph.z[ candidate ] - this.graph.z[ this.graph.hostNode ];
					const distanceSq = dx * dx + dz * dz;
					if ( distanceSq < closestSq ) { closestSq = distanceSq; next = candidate; }

				}

			}
			if ( next < 0 ) break;
			travelled += Math.hypot(
				this.graph.x[ next ] - this.graph.x[ current ],
				this.graph.y[ next ] - this.graph.y[ current ],
				this.graph.z[ next ] - this.graph.z[ current ],
			);
			path.push( next );
			pathNodes.add( next );
			if ( this.visitCounts[ next ] < 65535 ) this.visitCounts[ next ] ++;
			previous = current;
			current = next;
			this.decisionCount ++;
			if ( travelled >= Math.max( 0.5, horizonDistance ) ) break;

		}
		if ( path.length < 2 ) {

			throw new Error( 'current chameleon surface node has no exploration edge' );

		}
		const corridor = buildChameleonSurfaceCorridor(
			this.graph,
			Uint32Array.from( path ),
			{ spacing: this.spacing, maxSamples: this.maxSamples },
		);
		this.previousNode = path[ path.length - 2 ];
		this.currentNode = current;
		this.routeCount ++;
		this.destinationCount ++;
		this.explorationCount ++;
		return corridor;

	}

	routeNext( maximumDistance = Infinity, options = {} ) {

		return this.exploreNext( maximumDistance, options );

	}

	rebase( x, y, z ) {

		this.currentNode = nearestChameleonSurfaceNode( this.graph, x, y, z );
		this.previousNode = - 1;
		if ( this.visitCounts[ this.currentNode ] < 65535 ) this.visitCounts[ this.currentNode ] ++;
		return this.currentNode;

	}

}
/** Diagnostics helper used by clearance/non-regression tests. */
export function isChameleonGroundPointClear(
	graph,
	x,
	z,
	ignoreSupportId = - 1,
) {

	return pointClear( x, z, graph.footprints, ignoreSupportId );

}
