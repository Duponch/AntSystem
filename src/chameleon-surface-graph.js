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
import {
	buildChameleonSurfaceCollider,
	createChameleonSurfaceHit,
} from './chameleon-surface-collider.js';
import {
	buildChameleonSurfacePatches,
	floodChameleonSurfaceComponent,
} from './chameleon-surface-patches.js';

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
		componentId: [],
		triangleId: [],
		edgesA: [],
		edgesB: [],
		edgeWeight: [],
		edgePathAB: [],
		edgePathBA: [],
		surfacePathDescriptors: [],
		surfacePatches: [],
		edgeKeys: new Map(),
	};

}

function appendNode(
	builder,
	x, y, z,
	nx, ny, nz,
	kind,
	supportId,
	componentId = - 1,
	triangleId = - 1,
) {

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
	builder.componentId.push( componentId );
	builder.triangleId.push( triangleId );
	return index;

}

function addUndirectedEdge( builder, a, b, {
	weight = NaN,
	forwardPath = - 1,
	reversePath = - 1,
} = {} ) {

	if ( a === b || a < 0 || b < 0 ) return;
	const low = Math.min( a, b );
	const high = Math.max( a, b );
	const key = `${ low }:${ high }`;
	const existing = builder.edgeKeys.get( key );
	if ( existing !== undefined ) {

		if ( forwardPath >= 0 || reversePath >= 0 ) {

			const lowToHigh = a === low ? forwardPath : reversePath;
			const highToLow = a === low ? reversePath : forwardPath;
			if ( lowToHigh >= 0 ) builder.edgePathAB[ existing ] = lowToHigh;
			if ( highToLow >= 0 ) builder.edgePathBA[ existing ] = highToLow;

		}
		if ( Number.isFinite( weight ) ) builder.edgeWeight[ existing ] = weight;
		return;

	}
	const edge = builder.edgesA.length;
	builder.edgeKeys.set( key, edge );
	builder.edgesA.push( low );
	builder.edgesB.push( high );
	builder.edgeWeight.push( Number.isFinite( weight ) ? weight : NaN );
	if ( a === low ) {

		builder.edgePathAB.push( forwardPath );
		builder.edgePathBA.push( reversePath );

	} else {

		builder.edgePathAB.push( reversePath );
		builder.edgePathBA.push( forwardPath );

	}

}

function nodeDistance( builder, a, b ) {

	return Math.hypot(
		builder.x[ b ] - builder.x[ a ],
		builder.y[ b ] - builder.y[ a ],
		builder.z[ b ] - builder.z[ a ],
	);

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

function appendPhysicalTransition(
	builder,
	surfaceNode,
	surface,
	direction,
	anchor,
	supportId,
	sampleCount,
	validation,
	clearance,
	groundY,
) {

	const epsilon = Math.max( 2e-4, clearance * 2 );
	const groundX = ( surface.surfaceX ?? surface.x ) + direction.x * epsilon;
	const groundZ = ( surface.surfaceZ ?? surface.z ) + direction.z * epsilon;
	const gap = Math.hypot(
		surface.x - groundX,
		surface.y - groundY,
		surface.z - groundZ,
	);
	const maximumGap = Math.max( 0.12, clearance * 4 + validation.tolerance * 4 );
	if ( gap > maximumGap ) throw new RangeError(
		`physical support-ground portal gap ${ gap.toFixed( 4 ) } exceeds ${ maximumGap.toFixed( 4 ) }`,
	);
	const run = Math.hypot( anchor.x - groundX, anchor.z - groundZ );
	const requested = clamp( Math.round( sampleCount ), 3, 18 );
	const required = Math.ceil( run / validation.maxSegmentLength ) + 1;
	const count = clamp( Math.max( requested, required ), 3, 18 );
	let previous = surfaceNode;
	let previousX = surface.x;
	let previousY = surface.y;
	let previousZ = surface.z;
	for ( let ordinal = 0; ordinal < count; ordinal ++ ) {

		const alpha = ordinal / ( count - 1 );
		const x = groundX + ( anchor.x - groundX ) * alpha;
		const z = groundZ + ( anchor.z - groundZ ) * alpha;
		const node = appendNode(
			builder,
			x, groundY, z,
			0, 1, 0,
			CHAMELEON_SURFACE_KIND.TRANSITION,
			supportId,
			- 1,
			- 1,
		);
		addUndirectedEdge( builder, previous, node );
		const segmentLength = Math.hypot(
			x - previousX,
			groundY - previousY,
			z - previousZ,
		);
		validation.validatedSegmentCount ++;
		validation.validatedTransitionSegments ++;
		validation.maxLeafLength = Math.max( validation.maxLeafLength, segmentLength );
		previous = node;
		previousX = x;
		previousY = groundY;
		previousZ = z;

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
	const edgeSurfacePath = new Int32Array( offsets[ count ] );
	edgeSurfacePath.fill( - 1 );
	for ( let edge = 0; edge < builder.edgesA.length; edge ++ ) {

		const a = builder.edgesA[ edge ];
		const b = builder.edgesB[ edge ];
		const weight = Number.isFinite( builder.edgeWeight[ edge ] )
			? builder.edgeWeight[ edge ] : nodeDistance( builder, a, b );
		let index = cursor[ a ] ++;
		edgeTo[ index ] = b;
		edgeWeight[ index ] = weight;
		edgeSurfacePath[ index ] = builder.edgePathAB[ edge ];
		index = cursor[ b ] ++;
		edgeTo[ index ] = a;
		edgeWeight[ index ] = weight;
		edgeSurfacePath[ index ] = builder.edgePathBA[ edge ];

	}
	return { offsets, edgeTo, edgeWeight, edgeSurfacePath };

}

function hostMatchesSupport( host, support ) {

	return host?.entry === support.entry && host?.index === support.placementIndex;

}

function supportGuidePoints( support, {
	objectSamples,
	scales,
	supportClearance,
	treeClimbFraction,
	treeTurns,
} ) {

	if ( support.surfaceClass === CHAMELEON_SURFACE_CLASS.TREE ) return buildTreeHelix(
		support,
		{ objectSamples, supportClearance, treeClimbFraction, treeTurns },
	);
	const track = buildChameleonTrack( {
		entry: support.entry,
		index: support.placementIndex,
		placement: support.placement,
	}, {
		sampleCount: objectSamples,
		scales,
		clearance: supportClearance,
		endMargin: support.surfaceClass === CHAMELEON_SURFACE_CLASS.ROCK ? 0.035 : 0.07,
	} );
	return trackPoints( track );

}

function projectSupportSeed(
	collider,
	support,
	colliderSupportId,
	guidePoints,
	clearance,
) {

	if ( colliderSupportId < 0 || guidePoints.length < 1 ) {

		throw new Error( `walkable support ${ support.model } has no exact collider` );

	}
	const guess = guidePoints[ 0 ];
	const hit = createChameleonSurfaceHit();
	collider.projectPoint( guess.x, guess.y, guess.z, hit, {
		supportId: colliderSupportId,
		includeGround: false,
		groundOnly: false,
		clearance,
		maxDistance: Infinity,
	} );
	if ( ! hit.hit || hit.triangleId < 0 ) {

		throw new Error( `walkable support ${ support.model } has no physical ground portal` );

	}
	let direction;
	if ( support.surfaceClass === CHAMELEON_SURFACE_CLASS.TREE ) {

		let x = hit.nx;
		let z = hit.nz;
		const length = Math.hypot( x, z ) || 1;
		x /= length;
		z /= length;
		direction = { x, z };

	} else {

		direction = endpointDirection( guidePoints, 0 );

	}
	return Object.freeze( {
		x: hit.x,
		y: hit.y,
		z: hit.z,
		nx: hit.nx,
		ny: hit.ny,
		nz: hit.nz,
		triangleId: hit.triangleId,
		componentId: hit.componentId,
		direction,
	} );

}

function portalPeripheralRatio( support, x, z ) {

	if ( support.footprint.type === 'circle' ) return Math.hypot(
		x - support.footprint.x,
		z - support.footprint.z,
	) / Math.max( EPSILON, support.footprint.radius );
	const local = rotateWorldToLocal(
		x - support.footprint.x,
		z - support.footprint.z,
		support.footprint.yaw,
	);
	return Math.max(
		Math.abs( local.x ) / Math.max( EPSILON, support.footprint.halfX ),
		Math.abs( local.z ) / Math.max( EPSILON, support.footprint.halfZ ),
	);

}

function portalVertexNormal( collider, triangle, vertex ) {

	let nx = vertex === 0 ? collider.normalAX[ triangle ]
		: vertex === 1 ? collider.normalBX[ triangle ] : collider.normalCX[ triangle ];
	let ny = vertex === 0 ? collider.normalAY[ triangle ]
		: vertex === 1 ? collider.normalBY[ triangle ] : collider.normalCY[ triangle ];
	let nz = vertex === 0 ? collider.normalAZ[ triangle ]
		: vertex === 1 ? collider.normalBZ[ triangle ] : collider.normalCZ[ triangle ];
	const length = Math.hypot( nx, ny, nz ) || 1;
	nx /= length;
	ny /= length;
	nz /= length;
	return { nx, ny, nz };

}

/**
 * Finds an actual mesh/ground contact on the portal component. The initial
 * guide seed can be on the back or canopy; it is deliberately not reused as a
 * ground handoff. Edge/ground intersections win, then the lowest peripheral
 * vertex whose normal does not point through the underside.
 */
function projectSupportPortal(
	collider,
	support,
	colliderSupportId,
	component,
	guidePoints,
	clearance,
	groundY,
) {

	let best = null;
	let bestScore = Infinity;

	function consider( triangle, x, y, z, normal, exactGroundIntersection ) {

		let { nx, ny, nz } = normal;
		const radialX = x - support.x;
		const radialZ = z - support.z;
		const radialLength = Math.hypot( radialX, radialZ );
		const outwardAlignment = radialLength > EPSILON
			? ( nx * radialX + nz * radialZ ) / radialLength
			: 0;
		const peripheral = portalPeripheralRatio( support, x, z );
		const verticalError = Math.abs( y - groundY );
		const undersidePenalty = Math.max( 0, - ny - 0.15 );
		const intersectionBonus = exactGroundIntersection ? - 0.5 : 0;
		const score = verticalError * 1000
			+ undersidePenalty * 80
			+ Math.max( 0, 1 - peripheral ) * 3
			- outwardAlignment * 0.35
			+ intersectionBonus
			+ triangle * 1e-10;
		if ( score >= bestScore ) return;
		bestScore = score;
		best = { x, y, z, nx, ny, nz, triangleId: triangle };

	}

	for ( const triangle of component.reachableTriangles ) {

		const vertices = [
			colliderVertex( collider, triangle, 0 ),
			colliderVertex( collider, triangle, 1 ),
			colliderVertex( collider, triangle, 2 ),
		];
		const normals = [
			portalVertexNormal( collider, triangle, 0 ),
			portalVertexNormal( collider, triangle, 1 ),
			portalVertexNormal( collider, triangle, 2 ),
		];
		for ( let vertex = 0; vertex < 3; vertex ++ ) consider(
			triangle,
			vertices[ vertex ].x,
			vertices[ vertex ].y,
			vertices[ vertex ].z,
			normals[ vertex ],
			Math.abs( vertices[ vertex ].y - groundY ) <= EPSILON,
		);
		for ( let edge = 0; edge < 3; edge ++ ) {

			const a = vertices[ edge ];
			const b = vertices[ ( edge + 1 ) % 3 ];
			const ay = a.y - groundY;
			const by = b.y - groundY;
			if ( ay * by > 0 || Math.abs( b.y - a.y ) <= EPSILON ) continue;
			const alpha = clamp( ( groundY - a.y ) / ( b.y - a.y ), 0, 1 );
			const na = normals[ edge ];
			const nb = normals[ ( edge + 1 ) % 3 ];
			let nx = na.nx + ( nb.nx - na.nx ) * alpha;
			let ny = na.ny + ( nb.ny - na.ny ) * alpha;
			let nz = na.nz + ( nb.nz - na.nz ) * alpha;
			const normalLength = Math.hypot( nx, ny, nz ) || 1;
			nx /= normalLength; ny /= normalLength; nz /= normalLength;
			consider(
				triangle,
				a.x + ( b.x - a.x ) * alpha,
				groundY,
				a.z + ( b.z - a.z ) * alpha,
				{ nx, ny, nz },
				true,
			);

		}

	}
	if ( ! best ) throw new Error( `walkable support ${ support.model } has no reachable physical portal` );
	let directionX = best.x - support.x;
	let directionZ = best.z - support.z;
	let directionLength = Math.hypot( directionX, directionZ );
	if ( directionLength <= EPSILON ) {

		directionX = best.nx;
		directionZ = best.nz;
		directionLength = Math.hypot( directionX, directionZ );

	}
	if ( directionLength <= EPSILON ) {

		const fallback = endpointDirection( guidePoints, 0 );
		directionX = fallback.x;
		directionZ = fallback.z;
		directionLength = 1;

	}
	return Object.freeze( {
		x: best.x + best.nx * clearance,
		y: best.y + best.ny * clearance,
		z: best.z + best.nz * clearance,
		surfaceX: best.x,
		surfaceY: best.y,
		surfaceZ: best.z,
		nx: best.nx,
		ny: best.ny,
		nz: best.nz,
		triangleId: best.triangleId,
		componentId: collider.componentId[ best.triangleId ],
		direction: { x: directionX / directionLength, z: directionZ / directionLength },
		groundGap: Math.abs( best.y - groundY ),
	} );

}

function allocatePatchBudgets( components, capacity, maxTrianglesPerPatch ) {

	const budgets = new Uint32Array( components.length );
	const maximums = new Uint32Array( components.length );
	const fractions = new Float64Array( components.length );
	let minimumTotal = 0;
	let weightTotal = 0;
	for ( let index = 0; index < components.length; index ++ ) {

		const count = components[ index ].reachableTriangleCount;
		const minimum = Math.ceil( count / maxTrianglesPerPatch );
		const maximum = count > 1 ? Math.ceil( count / 2 ) : 1;
		budgets[ index ] = minimum;
		maximums[ index ] = Math.max( minimum, maximum );
		minimumTotal += minimum;
		weightTotal += count;

	}
	if ( minimumTotal > capacity ) throw new RangeError(
		`surface-wide patch minimum ${ minimumTotal } exceeds the global support budget ${ capacity }; `
		+ 'increase maximumNodes or maxTrianglesPerPatch',
	);
	let remaining = capacity - minimumTotal;
	for ( let index = 0; index < components.length; index ++ ) {

		const room = maximums[ index ] - budgets[ index ];
		const ideal = weightTotal > 0
			? remaining * components[ index ].reachableTriangleCount / weightTotal
			: 0;
		const extra = Math.min( room, Math.floor( ideal ) );
		budgets[ index ] += extra;
		fractions[ index ] = ideal - Math.floor( ideal );

	}
	let assigned = 0;
	for ( let index = 0; index < components.length; index ++ ) {

		assigned += budgets[ index ] - Math.ceil(
			components[ index ].reachableTriangleCount / maxTrianglesPerPatch,
		);

	}
	remaining -= assigned;
	const order = Array.from( { length: components.length }, ( _, index ) => index );
	order.sort( ( a, b ) => fractions[ b ] - fractions[ a ] || a - b );
	while ( remaining > 0 ) {

		let progressed = false;
		for ( const index of order ) {

			if ( remaining <= 0 ) break;
			if ( budgets[ index ] >= maximums[ index ] ) continue;
			budgets[ index ] ++;
			remaining --;
			progressed = true;

		}
		if ( ! progressed ) break;

	}
	return Object.freeze( { budgets, minimumTotal, capacity } );

}

function reversePatchEdge( patches, fromPatch, toPatch ) {

	for ( let edge = patches.offsets[ fromPatch ]; edge < patches.offsets[ fromPatch + 1 ]; edge ++ ) {

		if ( patches.edgeTo[ edge ] === toPatch ) return edge;

	}
	return - 1;

}

function appendSurfacePatchSet(
	builder,
	patches,
	supportId,
	colliderSupportId,
	componentId,
	clearance,
) {

	const patchSetIndex = builder.surfacePatches.length;
	const graphNodes = new Uint32Array( patches.patchCount );
	for ( let patch = 0; patch < patches.patchCount; patch ++ ) {

		graphNodes[ patch ] = appendNode(
			builder,
			patches.x[ patch ] + patches.normalX[ patch ] * clearance,
			patches.y[ patch ] + patches.normalY[ patch ] * clearance,
			patches.z[ patch ] + patches.normalZ[ patch ] * clearance,
			patches.normalX[ patch ],
			patches.normalY[ patch ],
			patches.normalZ[ patch ],
			CHAMELEON_SURFACE_KIND.SUPPORT,
			supportId,
			componentId,
			patches.patchSeedTriangles[ patch ],
		);

	}
	const patchSet = Object.freeze( {
		index: patchSetIndex,
		supportId,
		colliderSupportId,
		componentId,
		graphNodes,
		patches,
	} );
	builder.surfacePatches.push( patchSet );

	for ( let patch = 0; patch < patches.patchCount; patch ++ ) {

		for ( let edge = patches.offsets[ patch ]; edge < patches.offsets[ patch + 1 ]; edge ++ ) {

			const next = patches.edgeTo[ edge ];
			if ( next <= patch ) continue;
			const reverse = reversePatchEdge( patches, next, patch );
			if ( reverse < 0 ) throw new Error( `surface patch edge ${ patch }-${ next } is not symmetric` );
			const forwardPath = builder.surfacePathDescriptors.length;
			builder.surfacePathDescriptors.push( Object.freeze( {
				patchSet: patchSetIndex,
				edge,
			} ) );
			const reversePath = builder.surfacePathDescriptors.length;
			builder.surfacePathDescriptors.push( Object.freeze( {
				patchSet: patchSetIndex,
				edge: reverse,
			} ) );
			addUndirectedEdge( builder, graphNodes[ patch ], graphNodes[ next ], {
				weight: Math.max( patches.edgeWeight[ edge ], patches.edgeWeight[ reverse ] ),
				forwardPath,
				reversePath,
			} );

		}

	}
	return patchSet;

}


function appendSurfacePortalNode(
	builder,
	patchSet,
	portal,
	supportId,
	componentId,
) {

	const node = appendNode(
		builder,
		portal.x, portal.y, portal.z,
		portal.nx, portal.ny, portal.nz,
		CHAMELEON_SURFACE_KIND.SUPPORT,
		supportId,
		componentId,
		portal.triangleId,
	);
	const descriptor = builder.surfacePathDescriptors.length;
	builder.surfacePathDescriptors.push( Object.freeze( {
		type: 'triangle-local',
		patchSet: patchSet.index,
		triangleId: portal.triangleId,
	} ) );
	const patchNode = patchSet.graphNodes[ 0 ];
	addUndirectedEdge( builder, patchNode, node, {
		weight: nodeDistance( builder, patchNode, node ),
		forwardPath: descriptor,
		reversePath: descriptor,
	} );
	return node;

}

function nearestPatchNode( builder, patchSet, point ) {

	let best = patchSet.graphNodes[ 0 ];
	let bestDistanceSq = Infinity;
	for ( const node of patchSet.graphNodes ) {

		const dx = builder.x[ node ] - point.x;
		const dy = builder.y[ node ] - point.y;
		const dz = builder.z[ node ] - point.z;
		const distanceSq = dx * dx + dy * dy + dz * dz;
		if ( distanceSq >= bestDistanceSq ) continue;
		bestDistanceSq = distanceSq;
		best = node;

	}
	return best;

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
	surfaceChordTolerance = 0.018,
	surfaceMaxSegmentLength = 0.5,
	surfaceMaxNormalAngle = Math.PI / 5,
	surfaceSubdivisionDepth = 8,
	surfacePatchRadius = 1.25,
	surfacePatchMaxTriangles = 64,
	surfaceTransitionNodeReserve = 24,
	maximumNodes = CHAMELEON_SURFACE_MAX_NODES,
} = {} ) {

	const groundLevel = finiteOr( groundY, 0.018 );
	const safeWorldSize = Math.max( 20, finiteOr( worldSize, 160 ) );
	const safeSpacing = clamp( finiteOr( terrainSpacing, 7.5 ), 2.5, 20 );
	const safeGroundClearance = Math.max( 0.02, finiteOr( groundClearance, 0.42 ) );
	const safeSupportClearance = Math.max( 0, finiteOr( supportClearance, 0.006 ) );
	const safeProbeSpacing = clamp( finiteOr( collisionProbeSpacing, 0.3 ), 0.08, 1 );
	const safeSubdivisionDepth = clamp( Math.round( finiteOr( surfaceSubdivisionDepth, 8 ) ), 2, 10 );
	const safePatchRadius = clamp( finiteOr( surfacePatchRadius, 1.25 ), 0.05, 20 );
	const safePatchTriangleLimit = clamp(
		Math.round( finiteOr( surfacePatchMaxTriangles, 64 ) ),
		2, 96,
	);
	const safeTransitionNodeReserve = clamp( Math.round( finiteOr( surfaceTransitionNodeReserve, 24 ) ), 4, 128 );
	const validation = {
		tolerance: clamp( finiteOr( surfaceChordTolerance, 0.018 ), 0.002, 0.1 ),
		maxSegmentLength: clamp( finiteOr( surfaceMaxSegmentLength, 0.5 ), 0.08, 2 ),
		maxNormalAngle: clamp( finiteOr( surfaceMaxNormalAngle, Math.PI / 5 ), 0.05, Math.PI ),
		maxDepth: safeSubdivisionDepth,
		validatedSegmentCount: 0,
		validatedSupportSegments: 0,
		validatedTransitionSegments: 0,
		maxChordError: 0,
		maxLeafLength: 0,
	};
	const collider = buildChameleonSurfaceCollider( registry, {
		scales,
		groundY: groundLevel,
		defaultMaxDistance: 3,
		maxTriangles: 200000,
	} );
	const supports = collectWalkablePlacements(
		registry,
		scales,
		safeGroundClearance,
	);
	const colliderSupportIds = new Int32Array( supports.length );
	colliderSupportIds.fill( - 1 );
	for ( const support of supports ) {

		const exact = collider.supports.find( ( candidate ) =>
			candidate.entry === support.entry && candidate.placementIndex === support.placementIndex );
		if ( exact ) colliderSupportIds[ support.id ] = exact.id;

	}
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
		groundY: groundLevel,
		collisionProbeSpacing: safeProbeSpacing,
	} );
	if ( terrain.nodes.length === 0 ) throw new Error( 'surface graph has no terrain nodes' );

	const supportMetadata = [];
	const destinationNodes = [];
	const supportPlans = [];
	let hostNode = terrain.nodes[ Math.floor( terrain.nodes.length * 0.5 ) ];

	for ( const support of supports ) {

		const exactSupportId = colliderSupportIds[ support.id ];
		const guidePoints = supportGuidePoints( support, {
			objectSamples,
			scales,
			supportClearance: safeSupportClearance,
			treeClimbFraction,
			treeTurns,
		} );
		const seed = projectSupportSeed(
			collider,
			support,
			exactSupportId,
			guidePoints,
			safeSupportClearance,
		);
		const seededComponent = floodChameleonSurfaceComponent( collider, {
			supportId: exactSupportId,
			seedTriangle: seed.triangleId,
		} );
		const portal = projectSupportPortal(
			collider,
			support,
			exactSupportId,
			seededComponent,
			guidePoints,
			safeSupportClearance,
			groundLevel,
		);
		const component = floodChameleonSurfaceComponent( collider, {
			supportId: exactSupportId,
			seedTriangle: portal.triangleId,
		} );
		const destinationGuide = support.surfaceClass === CHAMELEON_SURFACE_CLASS.TREE
			? guidePoints[ guidePoints.length - 1 ]
			: guidePoints[ Math.floor( guidePoints.length * 0.5 ) ];
		supportPlans.push( {
			support,
			exactSupportId,
			guidePoints,
			portal,
			component,
			destinationGuide,
		} );

	}

	const reservedTransitionNodes = supportPlans.length * safeTransitionNodeReserve;
	const reservedPortalNodes = supportPlans.length;
	const patchNodeCapacity = builder.maximumNodes
		- builder.x.length
		- reservedTransitionNodes
		- reservedPortalNodes;
	if ( patchNodeCapacity < 1 && supportPlans.length > 0 ) throw new RangeError(
		`terrain plus portal/transition reserve leaves ${ patchNodeCapacity } surface patch nodes`,
	);
	const patchAllocation = allocatePatchBudgets(
		supportPlans.map( ( plan ) => plan.component ),
		Math.max( 0, patchNodeCapacity ),
		safePatchTriangleLimit,
	);
	let reachableSurfaceTriangleCount = 0;
	let excludedSurfaceTriangleCount = 0;

	for ( let planIndex = 0; planIndex < supportPlans.length; planIndex ++ ) {

		const plan = supportPlans[ planIndex ];
		const { support, exactSupportId, portal, component } = plan;
		const patches = buildChameleonSurfacePatches( collider, {
			supportId: exactSupportId,
			seedTriangle: portal.triangleId,
			targetPatchRadius: safePatchRadius,
			maxPatches: patchAllocation.budgets[ planIndex ],
			maxTrianglesPerPatch: safePatchTriangleLimit,
		} );
		if ( patches.patchSeedTriangles[ 0 ] !== portal.triangleId ) {

			throw new Error( `surface patch portal seed drifted on ${ support.model }` );

		}
		const componentId = collider.componentId[ portal.triangleId ];
		const patchSet = appendSurfacePatchSet(
			builder,
			patches,
			support.id,
			exactSupportId,
			componentId,
			safeSupportClearance,
		);
		const patchNodeStart = patchSet.graphNodes[ 0 ];
		const surfaceNode = appendSurfacePortalNode(
			builder,
			patchSet,
			portal,
			support.id,
			componentId,
		);
		const surface = portal;
		const anchor = makeGroundAnchor(
			surface,
			portal.direction,
			support,
			footprints,
			groundLevel,
			safeGroundClearance,
		);
		const transitionPortal = appendPhysicalTransition(
			builder,
			surfaceNode,
			surface,
			portal.direction,
			anchor,
			support.id,
			transitionSamples,
			validation,
			safeSupportClearance,
			groundLevel,
		);
		const terrainNode = connectPortalToTerrain(
			builder,
			transitionPortal,
			terrain.nodes,
			footprints,
			support.id,
			safeProbeSpacing,
		);
		if ( terrainNode < 0 ) throw new Error(
			`physical portal for ${ support.model } cannot reach the terrain graph`,
		);

		const destination = nearestPatchNode( builder, patchSet, plan.destinationGuide );
		destinationNodes.push( destination );
		if ( hostMatchesSupport( host, support ) ) hostNode = destination;
		const exactSupport = collider.supports[ exactSupportId ];
		reachableSurfaceTriangleCount += patches.reachableTriangleCount;
		excludedSurfaceTriangleCount += patches.excludedTriangleCount;
		supportMetadata.push( Object.freeze( {
			id: support.id,
			model: support.model,
			placementIndex: support.placementIndex,
			surfaceClass: support.surfaceClass,
			nodeStart: surfaceNode,
			patchNodeStart,
			surfacePortalNode: surfaceNode,
			nodeEnd: destination,
			destinationNode: destination,
			portals: Int32Array.of( transitionPortal ),
			portalTerrainNodes: Int32Array.of( terrainNode ),
			categoryScale: support.categoryScale,
			colliderSupportId: exactSupportId,
			componentId,
			triangleStart: exactSupport?.triangleStart ?? - 1,
			triangleCount: exactSupport?.triangleCount ?? 0,
			reachableTriangleCount: patches.reachableTriangleCount,
			excludedTriangleCount: patches.excludedTriangleCount,
			patchSet: patchSet.index,
			patchCount: patches.patchCount,
			patchTelemetry: patches.telemetry,
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
	const surfacePatchNodeCount = builder.surfacePatches.reduce(
		( total, patchSet ) => total + patchSet.graphNodes.length, 0,
	);
	const surfacePortalNodeCount = supportPlans.length;
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
		componentId: Int32Array.from( builder.componentId ),
		nodeTriangleId: Int32Array.from( builder.triangleId ),
		offsets: csr.offsets,
		edgeTo: csr.edgeTo,
		edgeWeight: csr.edgeWeight,
		edgeSurfacePath: csr.edgeSurfacePath,
		edgeCount: builder.edgesA.length,
		terrainNodeCount: terrain.nodes.length,
		terrainWidth: terrain.width,
		terrainStep: terrain.step,
		supportCount: supportMetadata.length,
		supports: Object.freeze( supportMetadata ),
		surfacePatches: Object.freeze( builder.surfacePatches ),
		surfacePathDescriptors: Object.freeze( builder.surfacePathDescriptors ),
		collider,
		colliderSupportIds,
		surfaceTriangleCount: collider.triangleCount,
		surfaceComponentCount: collider.componentCount,
		reachableSurfaceTriangleCount,
		excludedSurfaceTriangleCount,
		surfacePatchNodeCount,
		surfacePortalNodeCount,
		surfaceBudget: Object.freeze( {
			maximumNodes: builder.maximumNodes,
			terrainNodes: terrain.nodes.length,
			reservedTransitionNodes,
			reservedPortalNodes,
			patchCapacity: patchAllocation.capacity,
			minimumPatchNodes: patchAllocation.minimumTotal,
			actualPatchNodes: surfacePatchNodeCount,
			actualPortalNodes: surfacePortalNodeCount,
			actualTransitionNodes: count - terrain.nodes.length
				- surfacePatchNodeCount - surfacePortalNodeCount,
			unusedNodes: builder.maximumNodes - count,
		} ),
		surfaceValidation: Object.freeze( {
			validatedSegmentCount: validation.validatedSegmentCount,
			validatedSupportSegments: validation.validatedSupportSegments,
			validatedTransitionSegments: validation.validatedTransitionSegments,
			maxChordError: validation.maxChordError,
			maxLeafLength: validation.maxLeafLength,
			coverageMode: 'reachable-component-topology-patches',
		} ),
		hostNode,
		destinationNodes: Uint32Array.from( destinationNodes ),
		footprints: Object.freeze( footprints.map( ( footprint ) => Object.freeze( { ...footprint } ) ) ),
		settings: Object.freeze( {
			worldSize: safeWorldSize,
			mapMargin: Math.max( 0.5, finiteOr( mapMargin, 1.5 ) ),
			terrainSpacing: safeSpacing,
			groundY: groundLevel,
			groundClearance: safeGroundClearance,
			supportClearance: safeSupportClearance,
			objectSamples: clamp( Math.round( objectSamples ), 8, 128 ),
			transitionSamples: clamp( Math.round( transitionSamples ), 5, 18 ),
			treeClimbFraction: clamp( treeClimbFraction, 0.12, 0.82 ),
			treeTurns: clamp( treeTurns, 0.25, 4 ),
			collisionProbeSpacing: safeProbeSpacing,
			surfaceChordTolerance: validation.tolerance,
			surfaceMaxSegmentLength: validation.maxSegmentLength,
			surfaceMaxNormalAngle: validation.maxNormalAngle,
			surfaceSubdivisionDepth: validation.maxDepth,
			surfacePatchRadius: safePatchRadius,
			surfacePatchMaxTriangles: safePatchTriangleLimit,
			surfaceTransitionNodeReserve: safeTransitionNodeReserve,
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
		options.surfaceChordTolerance ?? 0.018,
		options.surfaceMaxSegmentLength ?? 0.5,
		options.surfaceMaxNormalAngle ?? Math.PI / 5,
		options.surfaceSubdivisionDepth ?? 8,
		options.maximumNodes ?? CHAMELEON_SURFACE_MAX_NODES,
		scales.trees ?? 1,
		scales.rocks ?? 1,
		options.surfacePatchRadius ?? 1.25,
		options.surfacePatchMaxTriangles ?? 64,
		options.surfaceTransitionNodeReserve ?? 24,
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

function graphNodePoint( graph, node ) {

	const triangleId = graph.nodeTriangleId?.[ node ] ?? - 1;
	return {
		x: graph.x[ node ],
		y: graph.y[ node ],
		z: graph.z[ node ],
		nx: graph.normalX[ node ],
		ny: graph.normalY[ node ],
		nz: graph.normalZ[ node ],
		kind: graph.kind[ node ],
		supportId: graph.supportId[ node ],
		componentId: graph.componentId[ node ],
		triangleId,
		incomingTriangleId: - 1,
		exactSurface: graph.kind[ node ] === CHAMELEON_SURFACE_KIND.SUPPORT
			&& triangleId >= 0,
		graphNode: node,
	};

}

function triangleContactNormal( collider, triangle ) {

	let nx = collider.normalAX[ triangle ]
		+ collider.normalBX[ triangle ]
		+ collider.normalCX[ triangle ];
	let ny = collider.normalAY[ triangle ]
		+ collider.normalBY[ triangle ]
		+ collider.normalCY[ triangle ];
	let nz = collider.normalAZ[ triangle ]
		+ collider.normalBZ[ triangle ]
		+ collider.normalCZ[ triangle ];
	let length = Math.hypot( nx, ny, nz );
	if ( length <= EPSILON ) {

		nx = collider.faceNormalX[ triangle ];
		ny = collider.faceNormalY[ triangle ];
		nz = collider.faceNormalZ[ triangle ];
		length = Math.hypot( nx, ny, nz ) || 1;

	}
	nx /= length;
	ny /= length;
	nz /= length;
	if ( nx * collider.faceNormalX[ triangle ]
		+ ny * collider.faceNormalY[ triangle ]
		+ nz * collider.faceNormalZ[ triangle ] < 0 ) {

		nx = - nx;
		ny = - ny;
		nz = - nz;

	}
	return { nx, ny, nz };

}

function colliderVertex( collider, triangle, vertex ) {

	return {
		x: vertex === 0 ? collider.ax[ triangle ]
			: vertex === 1 ? collider.bx[ triangle ] : collider.cx[ triangle ],
		y: vertex === 0 ? collider.ay[ triangle ]
			: vertex === 1 ? collider.by[ triangle ] : collider.cy[ triangle ],
		z: vertex === 0 ? collider.az[ triangle ]
			: vertex === 1 ? collider.bz[ triangle ] : collider.cz[ triangle ],
	};

}

function sharedEdgePoint( graph, patchSet, fromTriangle, toTriangle, graphNode ) {

	const collider = graph.collider;
	let first = null;
	let second = null;
	for ( let edge = 0; edge < 3; edge ++ ) {

		if ( collider.edgeNeighbours[ fromTriangle * 3 + edge ] !== toTriangle ) continue;
		first = colliderVertex( collider, fromTriangle, edge );
		second = colliderVertex( collider, fromTriangle, ( edge + 1 ) % 3 );
		break;

	}
	if ( ! first ) {

		const epsilonSq = 1e-10;
		for ( let fromVertex = 0; fromVertex < 3; fromVertex ++ ) {

			const candidate = colliderVertex( collider, fromTriangle, fromVertex );
			for ( let toVertex = 0; toVertex < 3; toVertex ++ ) {

				const other = colliderVertex( collider, toTriangle, toVertex );
				const dx = candidate.x - other.x;
				const dy = candidate.y - other.y;
				const dz = candidate.z - other.z;
				if ( dx * dx + dy * dy + dz * dz > epsilonSq ) continue;
				if ( ! first ) first = candidate;
				else if ( Math.hypot(
					candidate.x - first.x,
					candidate.y - first.y,
					candidate.z - first.z,
				) > EPSILON ) second = candidate;
				break;

			}

		}

	}
	if ( ! first || ! second ) throw new Error(
		`geodesic triangles ${ fromTriangle } and ${ toTriangle } do not share an edge`,
	);
	const normalA = triangleContactNormal( collider, fromTriangle );
	const normalB = triangleContactNormal( collider, toTriangle );
	let nx = normalA.nx + normalB.nx;
	let ny = normalA.ny + normalB.ny;
	let nz = normalA.nz + normalB.nz;
	const normalLength = Math.hypot( nx, ny, nz ) || 1;
	nx /= normalLength;
	ny /= normalLength;
	nz /= normalLength;
	const x = ( first.x + second.x ) * 0.5;
	const y = ( first.y + second.y ) * 0.5;
	const z = ( first.z + second.z ) * 0.5;
	const clearance = graph.settings.supportClearance;
	return {
		x: x + nx * clearance,
		y: y + ny * clearance,
		z: z + nz * clearance,
		nx, ny, nz,
		kind: CHAMELEON_SURFACE_KIND.SUPPORT,
		supportId: patchSet.supportId,
		componentId: patchSet.componentId,
		triangleId: fromTriangle,
		incomingTriangleId: fromTriangle,
		exactSurface: true,
		graphNode,
	};

}

function triangleCentrePoint( graph, patchSet, triangle, graphNode ) {

	const collider = graph.collider;
	const normal = triangleContactNormal( collider, triangle );
	const clearance = graph.settings.supportClearance;
	const x = ( collider.ax[ triangle ] + collider.bx[ triangle ] + collider.cx[ triangle ] ) / 3;
	const y = ( collider.ay[ triangle ] + collider.by[ triangle ] + collider.cy[ triangle ] ) / 3;
	const z = ( collider.az[ triangle ] + collider.bz[ triangle ] + collider.cz[ triangle ] ) / 3;
	return {
		x: x + normal.nx * clearance,
		y: y + normal.ny * clearance,
		z: z + normal.nz * clearance,
		nx: normal.nx,
		ny: normal.ny,
		nz: normal.nz,
		kind: CHAMELEON_SURFACE_KIND.SUPPORT,
		supportId: patchSet.supportId,
		componentId: patchSet.componentId,
		triangleId: triangle,
		incomingTriangleId: triangle,
		exactSurface: true,
		graphNode,
	};

}

function appendDistinctPoint( points, point ) {

	const previous = points[ points.length - 1 ];
	if ( previous && Math.hypot(
		previous.x - point.x,
		previous.y - point.y,
		previous.z - point.z,
	) <= EPSILON ) return;
	points.push( point );

}

function parentChainToSeed( patches, triangle, expectedSeed ) {

	const chain = [ triangle ];
	let current = triangle;
	for ( let guard = 0; guard <= patches.reachableTriangleCount; guard ++ ) {

		const parent = patches.triangleParent[ current - patches.supportTriangleStart ];
		if ( parent < 0 ) break;
		chain.push( parent );
		current = parent;

	}
	if ( current !== expectedSeed ) throw new Error(
		`triangle ${ triangle } has no in-patch path to seed ${ expectedSeed }`,
	);
	return chain;

}

function appendPatchEdgePath( graph, descriptor, targetNode, points ) {

	const patchSet = graph.surfacePatches[ descriptor.patchSet ];
	const patches = patchSet?.patches;
	if ( ! patches ) throw new Error( `surface path references missing patch set ${ descriptor.patchSet }` );
	const edge = descriptor.edge;
	const fromTriangle = patches.edgeFromTriangle[ edge ];
	const toTriangle = patches.edgeToTriangle[ edge ];
	const fromPatch = patches.trianglePatch[ fromTriangle - patches.supportTriangleStart ];
	const toPatch = patches.edgeTo[ edge ];
	const sourceChain = parentChainToSeed(
		patches,
		fromTriangle,
		patches.patchSeedTriangles[ fromPatch ],
	);
	for ( let index = sourceChain.length - 2; index >= 0; index -- ) {

		const previousTriangle = sourceChain[ index + 1 ];
		const triangle = sourceChain[ index ];
		appendDistinctPoint( points, sharedEdgePoint(
			graph, patchSet, previousTriangle, triangle, targetNode,
		) );
		appendDistinctPoint( points, triangleCentrePoint(
			graph, patchSet, triangle, targetNode,
		) );

	}
	let nx = patches.portalNormalX[ edge ];
	let ny = patches.portalNormalY[ edge ];
	let nz = patches.portalNormalZ[ edge ];
	const normalLength = Math.hypot( nx, ny, nz ) || 1;
	nx /= normalLength;
	ny /= normalLength;
	nz /= normalLength;
	const clearance = graph.settings.supportClearance;
	appendDistinctPoint( points, {
		x: patches.portalX[ edge ] + nx * clearance,
		y: patches.portalY[ edge ] + ny * clearance,
		z: patches.portalZ[ edge ] + nz * clearance,
		nx, ny, nz,
		kind: CHAMELEON_SURFACE_KIND.SUPPORT,
		supportId: patchSet.supportId,
		componentId: patchSet.componentId,
		triangleId: fromTriangle,
		incomingTriangleId: fromTriangle,
		exactSurface: true,
		graphNode: targetNode,
	} );
	appendDistinctPoint( points, triangleCentrePoint(
		graph, patchSet, toTriangle, targetNode,
	) );
	const destinationChain = parentChainToSeed(
		patches,
		toTriangle,
		patches.patchSeedTriangles[ toPatch ],
	);
	for ( let index = 1; index < destinationChain.length; index ++ ) {

		const previousTriangle = destinationChain[ index - 1 ];
		const triangle = destinationChain[ index ];
		appendDistinctPoint( points, sharedEdgePoint(
			graph, patchSet, previousTriangle, triangle, targetNode,
		) );
		appendDistinctPoint( points, triangleCentrePoint(
			graph, patchSet, triangle, targetNode,
		) );

	}

}

function directedGraphEdge( graph, from, to ) {

	for ( let edge = graph.offsets[ from ]; edge < graph.offsets[ from + 1 ]; edge ++ ) {

		if ( graph.edgeTo[ edge ] === to ) return edge;

	}
	throw new Error( `surface path contains non-adjacent nodes ${ from }-${ to }` );

}

function expandSurfacePath( graph, path ) {

	const points = [ graphNodePoint( graph, path[ 0 ] ) ];
	for ( let index = 1; index < path.length; index ++ ) {

		const from = path[ index - 1 ];
		const to = path[ index ];
		const edge = directedGraphEdge( graph, from, to );
		const descriptorIndex = graph.edgeSurfacePath?.[ edge ] ?? - 1;
		if ( descriptorIndex >= 0 ) {

			const descriptor = graph.surfacePathDescriptors[ descriptorIndex ];
			if ( descriptor.type === 'triangle-local' ) {

				const target = graphNodePoint( graph, to );
				if ( target.triangleId !== descriptor.triangleId ) throw new Error(
					`local portal edge left triangle ${ descriptor.triangleId }`,
				);
				target.incomingTriangleId = descriptor.triangleId;
				target.exactSurface = true;
				appendDistinctPoint( points, target );

			} else {

				appendPatchEdgePath( graph, descriptor, to, points );
				appendDistinctPoint( points, graphNodePoint( graph, to ) );

			}

		} else appendDistinctPoint( points, graphNodePoint( graph, to ) );

	}
	return points;

}


function corridorSampleCount( points, spacing ) {
	let count = 1;
	for ( let index = 1; index < points.length; index ++ ) {

		count += Math.max( 1, Math.ceil( Math.hypot(
			points[ index ].x - points[ index - 1 ].x,
			points[ index ].y - points[ index - 1 ].y,
			points[ index ].z - points[ index - 1 ].z,
		) / spacing ) );

	}
	return count;

}

function colliderTrianglesAdjacent( collider, triangle, candidate ) {

	if ( triangle === candidate ) return true;
	if ( triangle < 0 || candidate < 0 ) return false;
	for (
		let ordinal = collider.adjacencyOffsets[ triangle ];
		ordinal < collider.adjacencyOffsets[ triangle + 1 ];
		ordinal ++
	) {

		if ( collider.adjacencyTriangles[ ordinal ] === candidate ) return true;

	}
	return false;

}
function colliderTrianglesTouch( collider, triangle, candidate ) {

	if ( colliderTrianglesAdjacent( collider, triangle, candidate ) ) return true;
	for ( let a = 0; a < 3; a ++ ) {

		const point = colliderVertex( collider, triangle, a );
		for ( let b = 0; b < 3; b ++ ) {

			const other = colliderVertex( collider, candidate, b );
			const dx = point.x - other.x;
			const dy = point.y - other.y;
			const dz = point.z - other.z;
			if ( dx * dx + dy * dy + dz * dz <= 1e-10 ) return true;

		}

	}
	return false;

}


function projectCorridorToExactSurface( graph, corridor ) {

	const collider = graph.collider;
	if ( ! collider ) throw new TypeError( 'surface corridor requires its baked collider' );
	const hit = createChameleonSurfaceHit();
	const query = {
		supportId: - 1,
		componentId: - 1,
		includeGround: false,
		groundOnly: false,
		clearance: graph.settings.supportClearance,
		maxDistance: Infinity,
	};
	const groundQuery = {
		supportId: - 1,
		includeGround: true,
		groundOnly: true,
		clearance: graph.settings.supportClearance,
		maxDistance: Infinity,
	};
	for ( let index = 0; index < corridor.count; index ++ ) {

		if ( corridor.surfaceHit[ index ] ) {

			const supportId = corridor.supportId[ index ];
			const exactSupportId = supportId >= 0
				? graph.colliderSupportIds[ supportId ] : - 1;
			const triangle = corridor.triangleId[ index ];
			if ( corridor.kind[ index ] === CHAMELEON_SURFACE_KIND.SUPPORT
				&& ( exactSupportId < 0
					|| triangle < 0
					|| collider.supportId[ triangle ] !== exactSupportId
					|| collider.componentId[ triangle ] !== corridor.componentId[ index ] ) ) {

				throw new Error( `exact surface corridor sample ${ index } lost its support/component` );

			}
			if ( corridor.kind[ index ] === CHAMELEON_SURFACE_KIND.SUPPORT ) {

				query.supportId = exactSupportId;
				query.componentId = corridor.componentId[ index ];
				query.triangleId = triangle;
				collider.projectPoint(
					corridor.x[ index ], corridor.y[ index ], corridor.z[ index ],
					hit, query,
				);
				const geometryError = hit.hit ? Math.hypot(
					hit.x - corridor.x[ index ],
					hit.y - corridor.y[ index ],
					hit.z - corridor.z[ index ],
				) : Infinity;
				const tolerance = Math.max(
					2e-4,
					graph.settings.surfaceChordTolerance + graph.settings.supportClearance * 2,
				);
				if ( ! hit.hit || hit.supportId !== exactSupportId
					|| hit.componentId !== corridor.componentId[ index ]
					|| ! colliderTrianglesTouch( collider, triangle, hit.triangleId )
					|| geometryError > tolerance ) throw new Error(
					`exact surface corridor sample ${ index } failed geometric revalidation`,
				);

			}
			continue;

		}
		const supportId = corridor.supportId[ index ];
		if ( supportId < 0 || corridor.kind[ index ] === CHAMELEON_SURFACE_KIND.TERRAIN ) {

			collider.projectPoint(
				corridor.x[ index ], corridor.y[ index ], corridor.z[ index ],
				hit, groundQuery,
			);

		} else {

			const exactSupportId = graph.colliderSupportIds[ supportId ];
			if ( exactSupportId < 0 ) throw new Error(
				`surface corridor sample ${ index } references missing support ${ supportId }`,
			);
			query.triangleId = corridor.triangleId[ index ];
			query.supportId = exactSupportId;
			query.componentId = corridor.componentId[ index ];
			collider.projectPoint(
				corridor.x[ index ], corridor.y[ index ], corridor.z[ index ],
				hit, query,
			);
			if ( corridor.kind[ index ] === CHAMELEON_SURFACE_KIND.TRANSITION ) {

				const groundDistance = Math.abs(
					corridor.y[ index ] - graph.settings.groundY,
				);
				if ( groundDistance < hit.distance ) collider.projectPoint(
					corridor.x[ index ], corridor.y[ index ], corridor.z[ index ],
					hit, groundQuery,
				);

			}

		}
		if ( ! hit.hit ) throw new Error( `surface corridor sample ${ index } did not project` );
		const kind = corridor.kind[ index ];
		if ( kind === CHAMELEON_SURFACE_KIND.TERRAIN && ! hit.isGround ) throw new Error(
			`terrain corridor sample ${ index } did not resolve to ground`,
		);
		if ( kind === CHAMELEON_SURFACE_KIND.SUPPORT && ( hit.isGround
			|| hit.supportId !== graph.colliderSupportIds[ supportId ]
			|| ( corridor.componentId[ index ] >= 0
				&& hit.componentId !== corridor.componentId[ index ] ) ) ) throw new Error(
			`support corridor sample ${ index } changed support/component`,
		);
		if ( kind === CHAMELEON_SURFACE_KIND.TRANSITION && ! hit.isGround
			&& ( hit.supportId !== graph.colliderSupportIds[ supportId ]
				|| ( corridor.componentId[ index ] >= 0
					&& hit.componentId !== corridor.componentId[ index ] ) ) ) throw new Error(
			`transition corridor sample ${ index } changed support/component`,
		);
		corridor.x[ index ] = hit.x;
		corridor.y[ index ] = hit.y;
		corridor.z[ index ] = hit.z;
		corridor.normalX[ index ] = hit.nx;
		corridor.normalY[ index ] = hit.ny;
		corridor.normalZ[ index ] = hit.nz;
		corridor.triangleId[ index ] = hit.triangleId;
		corridor.componentId[ index ] = hit.componentId;
		corridor.surfaceHit[ index ] = 1;

	}

	for ( let index = 0; index < corridor.count; index ++ ) {

		if ( ! corridor.surfaceHit[ index ] ) throw new Error(
			`surface corridor sample ${ index } remained unresolved`,
		);

	}
}

function compactCorridorSamples( corridor ) {

	const scalarFields = [
		'x', 'y', 'z',
		'normalX', 'normalY', 'normalZ',
		'kind', 'supportId', 'componentId',
		'graphNode', 'triangleId', 'surfaceHit',
	];
	let write = 1;
	for ( let read = 1; read < corridor.count; read ++ ) {

		const previous = write - 1;
		const distance = Math.hypot(
			corridor.x[ read ] - corridor.x[ previous ],
			corridor.y[ read ] - corridor.y[ previous ],
			corridor.z[ read ] - corridor.z[ previous ],
		);
		const sameTopology = corridor.kind[ read ] === corridor.kind[ previous ]
			&& corridor.supportId[ read ] === corridor.supportId[ previous ]
			&& corridor.componentId[ read ] === corridor.componentId[ previous ]
			&& corridor.triangleId[ read ] === corridor.triangleId[ previous ];
		if ( distance <= EPSILON && ! sameTopology ) throw new Error(
			'surface corridor contains a zero-length topological handoff',
		);
		if ( distance <= 1e-4 && sameTopology ) {

			for ( const field of scalarFields ) corridor[ field ][ previous ] = corridor[ field ][ read ];
			continue;

		}
		if ( write !== read ) {

			for ( const field of scalarFields ) corridor[ field ][ write ] = corridor[ field ][ read ];

		}
		write ++;

	}
	if ( write < 2 && corridor.count > 1 ) throw new Error(
		'surface corridor collapsed to a zero-length route',
	);
	corridor.count = write;
	return corridor;

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
		let normalLength = Math.hypot( nx, ny, nz );
		if ( normalLength <= EPSILON ) {

			// A vertical handoff can momentarily align its contact normal and
			// tangent. Choose the least-parallel reference axis so the frame
			// remains finite, orthonormal and deterministic.
			nx = Math.abs( ty ) < 0.9 ? - tx * ty : 1 - tx * tx;
			ny = Math.abs( ty ) < 0.9 ? 1 - ty * ty : - tx * ty;
			nz = Math.abs( ty ) < 0.9 ? - tz * ty : - tx * tz;
			normalLength = Math.hypot( nx, ny, nz ) || 1;

		}
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

function corridorBudgetError( message ) {

	const error = new RangeError( message );
	error.code = 'CHAMELEON_CORRIDOR_BUDGET';
	return error;

}

/**
 * Compile a path into the only data consumed by ChameleonSimulation.
 * Every graph corner is retained; the budget only changes subdivision density,
 * so compacting can never cut through an obstacle.
 */
export function buildChameleonSurfaceCorridor( graph, path, {
	spacing = 1.15,
	maxSamples = CHAMELEON_CORRIDOR_MAX_SAMPLES,
	requestedTargetNode = path?.[ path.length - 1 ],
} = {} ) {

	if ( ! path || path.length < 2 ) throw new TypeError(
		'a surface corridor requires two distinct graph nodes',
	);
	for ( const node of path ) assertNode( graph, node, 'path node' );
	const capacity = clamp(
		Math.round( finiteOr( maxSamples, CHAMELEON_CORRIDOR_MAX_SAMPLES ) ),
		32,
		CHAMELEON_CORRIDOR_MAX_SAMPLES,
	);
	const expandedPoints = expandSurfacePath( graph, path );
	if ( expandedPoints.length > capacity ) throw corridorBudgetError(
		`geodesic surface corridor needs ${ expandedPoints.length } mandatory points `
		+ `for a ${ capacity } sample budget; refusing an unsafe chord fallback`,
	);
	let effectiveSpacing = clamp( finiteOr( spacing, 1.15 ), 0.2, 12 );
	for ( let guard = 0; guard < 24
		&& corridorSampleCount( expandedPoints, effectiveSpacing ) > capacity; guard ++ ) {

		effectiveSpacing *= 1.18;

	}
	const count = corridorSampleCount( expandedPoints, effectiveSpacing );
	if ( count > capacity ) throw corridorBudgetError(
		'surface corridor budget cannot retain every topological corner',
	);
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
		componentId: new Int32Array( count ).fill( - 1 ),
		graphNode: new Uint32Array( count ),
		triangleId: new Int32Array( count ).fill( - 1 ),
		surfaceHit: new Uint8Array( count ),
		startNode: path[ 0 ],
		targetNode: path[ path.length - 1 ],
		pathNodeCount: path.length,
		requestedTargetNode,
		truncated: requestedTargetNode !== path[ path.length - 1 ],
		mandatoryPointCount: expandedPoints.length,
		effectiveSpacing,
		supportCount: graph.supportCount,
		supports: graph.supports,
	};
	let cursor = 0;

	function write( from, to, alpha, graphNode, incomingTriangleId = - 1, exactSurface = false ) {

		corridor.x[ cursor ] = from.x + ( to.x - from.x ) * alpha;
		corridor.y[ cursor ] = from.y + ( to.y - from.y ) * alpha;
		corridor.z[ cursor ] = from.z + ( to.z - from.z ) * alpha;
		corridor.normalX[ cursor ] = from.nx + ( to.nx - from.nx ) * alpha;
		corridor.normalY[ cursor ] = from.ny + ( to.ny - from.ny ) * alpha;
		corridor.normalZ[ cursor ] = from.nz + ( to.nz - from.nz ) * alpha;
		const nearest = alpha < 0.5 ? from : to;
		corridor.kind[ cursor ] = nearest.kind;
		corridor.supportId[ cursor ] = nearest.supportId;
		corridor.componentId[ cursor ] = nearest.componentId;
		corridor.graphNode[ cursor ] = graphNode;
		corridor.triangleId[ cursor ] = incomingTriangleId >= 0
			? incomingTriangleId : nearest.triangleId;
		corridor.surfaceHit[ cursor ] = exactSurface ? 1 : 0;
		cursor ++;

	}

	const first = expandedPoints[ 0 ];
	write(
		first,
		first,
		0,
		first.graphNode,
		first.triangleId,
		first.exactSurface,
	);
	for ( let segment = 1; segment < expandedPoints.length; segment ++ ) {

		const from = expandedPoints[ segment - 1 ];
		const to = expandedPoints[ segment ];
		const length = Math.hypot( to.x - from.x, to.y - from.y, to.z - from.z );
		const subdivisions = Math.max( 1, Math.ceil( length / effectiveSpacing ) );
		const exactSurface = to.incomingTriangleId >= 0;
		for ( let ordinal = 1; ordinal <= subdivisions; ordinal ++ ) write(
			from,
			to,
			ordinal / subdivisions,
			to.graphNode,
			to.incomingTriangleId,
			exactSurface,
		);

	}
	if ( cursor !== count ) throw new Error( `surface corridor wrote ${ cursor }/${ count } samples` );
	projectCorridorToExactSurface( graph, corridor );
	compactCorridorSamples( corridor );
	normalizeCorridorFrames( corridor );
	corridor.length = corridor.distance[ corridor.count - 1 ];
	return Object.freeze( corridor );

}

function buildBudgetedRouterCorridor( graph, path, options ) {

	const requestedTargetNode = path[ path.length - 1 ];
	if ( path.length <= 1 ) return {
		path,
		corridor: buildChameleonSurfaceCorridor( graph, path, {
			...options,
			requestedTargetNode,
		} ),
	};
	for ( let length = path.length; length >= 2; length -- ) {

		const candidate = length === path.length ? path : path.slice( 0, length );
		try {

			return {
				path: candidate,
				corridor: buildChameleonSurfaceCorridor( graph, candidate, {
					...options,
					requestedTargetNode,
				} ),
			};

		} catch ( error ) {

			if ( error?.code !== 'CHAMELEON_CORRIDOR_BUDGET' || length === 2 ) throw error;

		}

	}
	throw corridorBudgetError( 'no adjacent graph edge fits the surface corridor budget' );

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

		this.pendingTargetNode = - 1;
		this._proposalActive = false;
		this._proposalNodeCount = 0;
		this._proposalNodes = new Int32Array( 128 );
		this._proposalVisitCounts = new Uint16Array( 128 );
		this._proposalCurrentNode = this.currentNode;
		this._proposalPreviousNode = this.previousNode;
		this._proposalPendingTargetNode = this.pendingTargetNode;
		this._proposalRouteCount = 0;
		this._proposalDestinationCount = 0;
		this._proposalExplorationCount = 0;
		this._proposalDecisionCount = 0;
		this._rejectedFromNode = - 1;
		this._rejectedNextNode = - 1;
	}

	beginProposal() {

		if ( this._proposalActive ) throw new Error( 'chameleon router proposal already active' );
		this._proposalActive = true;
		this._proposalNodeCount = 0;
		this._proposalCurrentNode = this.currentNode;
		this._proposalPreviousNode = this.previousNode;
		this._proposalPendingTargetNode = this.pendingTargetNode;
		this._proposalRouteCount = this.routeCount;
		this._proposalDestinationCount = this.destinationCount;
		this._proposalExplorationCount = this.explorationCount;
		this._proposalDecisionCount = this.decisionCount;
		return this;

	}

	_recordProposalNode( node ) {

		if ( ! this._proposalActive ) return;
		for ( let index = 0; index < this._proposalNodeCount; index ++ ) {

			if ( this._proposalNodes[ index ] === node ) return;

		}
		if ( this._proposalNodeCount >= this._proposalNodes.length ) {

			throw new Error( 'chameleon router proposal exceeds its fixed node budget' );

		}
		const index = this._proposalNodeCount ++;
		this._proposalNodes[ index ] = node;
		this._proposalVisitCounts[ index ] = this.visitCounts[ node ];

	}

	acceptProposal() {

		if ( ! this._proposalActive ) return false;
		this._proposalActive = false;
		this._proposalNodeCount = 0;
		this._rejectedFromNode = - 1;
		this._rejectedNextNode = - 1;
		return true;

	}

	rejectProposal() {

		if ( ! this._proposalActive ) return false;
		const rejectedFrom = this._proposalNodeCount > 0
			? this._proposalNodes[ 0 ] : this._proposalCurrentNode;
		const rejectedNext = this._proposalNodeCount > 1
			? this._proposalNodes[ 1 ] : - 1;
		for ( let index = 0; index < this._proposalNodeCount; index ++ ) {

			this.visitCounts[ this._proposalNodes[ index ] ] = this._proposalVisitCounts[ index ];

		}
		this.currentNode = this._proposalCurrentNode;
		this.previousNode = this._proposalPreviousNode;
		this.pendingTargetNode = this._proposalPendingTargetNode;
		this.routeCount = this._proposalRouteCount;
		this.destinationCount = this._proposalDestinationCount;
		this.explorationCount = this._proposalExplorationCount;
		this.decisionCount = this._proposalDecisionCount;
		this._proposalActive = false;
		this._proposalNodeCount = 0;
		this._rejectedFromNode = rejectedFrom;
		this._rejectedNextNode = rejectedNext;
		return true;

	}

	routeTo( targetNode, startNode = this.currentNode ) {

		const requestedPath = findChameleonSurfacePath( this.graph, startNode, targetNode );
		const planned = buildBudgetedRouterCorridor( this.graph, requestedPath, {
			spacing: this.spacing,
			maxSamples: this.maxSamples,
		} );
		const { path, corridor } = planned;
		if ( path.length > 1 ) this.previousNode = path[ path.length - 2 ];
		this.currentNode = path[ path.length - 1 ];
		this.pendingTargetNode = corridor.truncated ? targetNode : - 1;
		for ( const node of path ) {

			this._recordProposalNode( node );
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
			if ( current === this._rejectedFromNode && next === this._rejectedNextNode ) score += 64;
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
			previous = current;
			current = next;
			this.decisionCount ++;
			if ( travelled >= Math.max( 0.5, horizonDistance ) ) break;

		}
		if ( path.length < 2 ) {

			throw new Error( 'current chameleon surface node has no exploration edge' );

		}
		const planned = buildBudgetedRouterCorridor(
			this.graph,
			Uint32Array.from( path ),
			{ spacing: this.spacing, maxSamples: this.maxSamples },
		);
		const effectivePath = planned.path;
		const corridor = planned.corridor;
		this.previousNode = effectivePath[ effectivePath.length - 2 ];
		this.currentNode = effectivePath[ effectivePath.length - 1 ];
		this.pendingTargetNode = corridor.truncated ? corridor.requestedTargetNode : - 1;
		for ( const node of effectivePath ) {

			this._recordProposalNode( node );
			if ( this.visitCounts[ node ] < 65535 ) this.visitCounts[ node ] ++;

		}
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
		this._recordProposalNode( this.currentNode );
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
