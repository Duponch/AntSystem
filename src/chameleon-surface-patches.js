/**
 * Baked, topology-safe surface patches for chameleon navigation.
 *
 * The exact collider remains the source of truth. This module never samples
 * rendered objects and never runs in the frame loop: it floods one reachable
 * triangle component, groups face-adjacent triangles into bounded patches and
 * exposes a compact CSR graph whose edges all cross a real shared mesh edge.
 */

import { createChameleonSurfaceHit } from './chameleon-surface-collider.js';

const EPSILON = 1e-9;
const DEFAULT_PATCH_RADIUS = 1;
const DEFAULT_MAX_PATCHES = 512;
const DEFAULT_MAX_TRIANGLES_PER_PATCH = 96;
const MAX_ADAPTATION_ATTEMPTS = 12;

function clampInteger( value, minimum, maximum ) {

	const finite = Number.isFinite( value ) ? Math.round( value ) : minimum;
	return Math.min( maximum, Math.max( minimum, finite ) );

}

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function requireCollider( collider ) {

	const required = [
		'ax', 'ay', 'az', 'bx', 'by', 'bz', 'cx', 'cy', 'cz',
		'faceNormalX', 'faceNormalY', 'faceNormalZ',
		'normalAX', 'normalAY', 'normalAZ',
		'normalBX', 'normalBY', 'normalBZ',
		'normalCX', 'normalCY', 'normalCZ',
		'supportId', 'adjacencyOffsets', 'adjacencyTriangles', 'edgeNeighbours',
	];
	if ( ! collider || ! Number.isInteger( collider.triangleCount ) ) {

		throw new TypeError( 'a baked chameleon surface collider is required' );

	}
	for ( const key of required ) {

		if ( ! collider[ key ] ) throw new TypeError( `collider.${ key } is required` );

	}

}

function requireSupport( collider, supportId ) {

	if ( ! Number.isInteger( supportId ) || supportId < 0 ) {

		throw new RangeError( 'supportId must identify a collider support' );

	}
	const support = collider.supports?.find?.( ( candidate ) => candidate.id === supportId )
		|| collider.supports?.[ supportId ];
	if ( ! support || support.id !== supportId || support.triangleCount <= 0 ) {

		throw new RangeError( `collider support ${ supportId } is unavailable` );

	}
	return support;

}

function triangleBelongsToSupport( collider, triangle, support ) {

	return Number.isInteger( triangle )
		&& triangle >= support.triangleStart
		&& triangle < support.triangleStart + support.triangleCount
		&& collider.supportId[ triangle ] === support.id;

}

function resolveSeedTriangle( collider, support, {
	seedTriangle = - 1,
	portal = null,
	portalX = NaN,
	portalY = NaN,
	portalZ = NaN,
} = {} ) {

	if ( Number.isInteger( seedTriangle ) && seedTriangle >= 0 ) {

		if ( ! triangleBelongsToSupport( collider, seedTriangle, support ) ) {

			throw new RangeError( `seed triangle ${ seedTriangle } is outside support ${ support.id }` );

		}
		return seedTriangle;

	}

	const x = finiteOr( portal?.x, portalX );
	const y = finiteOr( portal?.y, portalY );
	const z = finiteOr( portal?.z, portalZ );
	if ( Number.isFinite( x ) && Number.isFinite( y ) && Number.isFinite( z ) ) {

		if ( typeof collider.projectPoint !== 'function' ) {

			throw new TypeError( 'portal projection requires collider.projectPoint' );

		}
		const hit = createChameleonSurfaceHit();
		collider.projectPoint( x, y, z, hit, {
			supportId: support.id,
			includeGround: false,
			groundOnly: false,
			clearance: 0,
			maxDistance: Infinity,
			triangleId: - 1,
		} );
		if ( ! hit.hit || ! triangleBelongsToSupport( collider, hit.triangleId, support ) ) {

			throw new Error( `portal does not project onto support ${ support.id }` );

		}
		return hit.triangleId;

	}

	return support.triangleStart;

}

/**
 * Labels every connected triangle component of one collider support and
 * returns the component reachable from a triangle or a world-space portal.
 * Triangle ids in the public arrays are global collider triangle ids.
 */
export function floodChameleonSurfaceComponent( collider, options = {} ) {

	requireCollider( collider );
	const support = requireSupport( collider, options.supportId );
	const seedTriangle = resolveSeedTriangle( collider, support, options );
	const start = support.triangleStart;
	const count = support.triangleCount;
	const end = start + count;
	const componentOfTriangle = new Int32Array( count );
	componentOfTriangle.fill( - 1 );
	const queue = new Int32Array( count );
	const componentSizes = [];
	let componentCount = 0;

	for ( let localSeed = 0; localSeed < count; localSeed ++ ) {

		if ( componentOfTriangle[ localSeed ] >= 0 ) continue;
		const component = componentCount ++;
		let read = 0;
		let write = 0;
		let componentSize = 0;
		queue[ write ++ ] = start + localSeed;
		componentOfTriangle[ localSeed ] = component;

		while ( read < write ) {

			const triangle = queue[ read ++ ];
			componentSize ++;
			for (
				let ordinal = collider.adjacencyOffsets[ triangle ];
				ordinal < collider.adjacencyOffsets[ triangle + 1 ];
				ordinal ++
			) {

				const neighbour = collider.adjacencyTriangles[ ordinal ];
				if ( neighbour < start || neighbour >= end
					|| collider.supportId[ neighbour ] !== support.id ) continue;
				const localNeighbour = neighbour - start;
				if ( componentOfTriangle[ localNeighbour ] >= 0 ) continue;
				componentOfTriangle[ localNeighbour ] = component;
				queue[ write ++ ] = neighbour;

			}

		}
		componentSizes.push( componentSize );

	}

	const seedComponent = componentOfTriangle[ seedTriangle - start ];
	const reachableTriangleCount = componentSizes[ seedComponent ];
	const reachableTriangles = new Uint32Array( reachableTriangleCount );
	let cursor = 0;
	for ( let local = 0; local < count; local ++ ) {

		if ( componentOfTriangle[ local ] === seedComponent ) {

			reachableTriangles[ cursor ++ ] = start + local;

		}

	}

	return Object.freeze( {
		supportId: support.id,
		supportTriangleStart: start,
		supportTriangleCount: count,
		seedTriangle,
		seedComponent,
		componentCount,
		componentSizes: Uint32Array.from( componentSizes ),
		componentOfTriangle,
		reachableTriangleCount,
		excludedTriangleCount: count - reachableTriangleCount,
		reachableTriangles,
	} );

}

function vertexX( collider, triangle, vertex ) {

	return vertex === 0 ? collider.ax[ triangle ]
		: vertex === 1 ? collider.bx[ triangle ]
			: collider.cx[ triangle ];

}

function vertexY( collider, triangle, vertex ) {

	return vertex === 0 ? collider.ay[ triangle ]
		: vertex === 1 ? collider.by[ triangle ]
			: collider.cy[ triangle ];

}

function vertexZ( collider, triangle, vertex ) {

	return vertex === 0 ? collider.az[ triangle ]
		: vertex === 1 ? collider.bz[ triangle ]
			: collider.cz[ triangle ];

}

function writeEdgeMidpoint( collider, triangle, edge, out ) {

	const a = edge;
	const b = ( edge + 1 ) % 3;
	const ax = vertexX( collider, triangle, a );
	const ay = vertexY( collider, triangle, a );
	const az = vertexZ( collider, triangle, a );
	const bx = vertexX( collider, triangle, b );
	const by = vertexY( collider, triangle, b );
	const bz = vertexZ( collider, triangle, b );
	out.x = ( ax + bx ) * 0.5;
	out.y = ( ay + by ) * 0.5;
	out.z = ( az + bz ) * 0.5;
	out.length = Math.hypot( bx - ax, by - ay, bz - az );
	return out;

}

function writeSharedEdgeMidpoint(
	collider,
	triangle,
	neighbour,
	out,
	weldEpsilon,
) {

	for ( let edge = 0; edge < 3; edge ++ ) {

		if ( collider.edgeNeighbours[ triangle * 3 + edge ] === neighbour ) {

			return writeEdgeMidpoint( collider, triangle, edge, out );

		}

	}
	for ( let edge = 0; edge < 3; edge ++ ) {

		if ( collider.edgeNeighbours[ neighbour * 3 + edge ] === triangle ) {

			return writeEdgeMidpoint( collider, neighbour, edge, out );

		}

	}

	const epsilonSq = weldEpsilon * weldEpsilon;
	let first = - 1;
	let second = - 1;
	for ( let a = 0; a < 3; a ++ ) {

		const ax = vertexX( collider, triangle, a );
		const ay = vertexY( collider, triangle, a );
		const az = vertexZ( collider, triangle, a );
		for ( let b = 0; b < 3; b ++ ) {

			const dx = ax - vertexX( collider, neighbour, b );
			const dy = ay - vertexY( collider, neighbour, b );
			const dz = az - vertexZ( collider, neighbour, b );
			if ( dx * dx + dy * dy + dz * dz > epsilonSq ) continue;
			if ( first < 0 ) first = a;
			else if ( a !== first ) second = a;
			break;

		}

	}
	if ( first < 0 || second < 0 ) return null;
	const ax = vertexX( collider, triangle, first );
	const ay = vertexY( collider, triangle, first );
	const az = vertexZ( collider, triangle, first );
	const bx = vertexX( collider, triangle, second );
	const by = vertexY( collider, triangle, second );
	const bz = vertexZ( collider, triangle, second );
	out.x = ( ax + bx ) * 0.5;
	out.y = ( ay + by ) * 0.5;
	out.z = ( az + bz ) * 0.5;
	out.length = Math.hypot( bx - ax, by - ay, bz - az );
	return out;

}

function buildTriangleMetrics( collider, support ) {

	const count = support.triangleCount;
	const start = support.triangleStart;
	const centroidX = new Float64Array( count );
	const centroidY = new Float64Array( count );
	const centroidZ = new Float64Array( count );
	const area = new Float64Array( count );

	for ( let local = 0; local < count; local ++ ) {

		const triangle = start + local;
		const ax = collider.ax[ triangle ];
		const ay = collider.ay[ triangle ];
		const az = collider.az[ triangle ];
		const abx = collider.bx[ triangle ] - ax;
		const aby = collider.by[ triangle ] - ay;
		const abz = collider.bz[ triangle ] - az;
		const acx = collider.cx[ triangle ] - ax;
		const acy = collider.cy[ triangle ] - ay;
		const acz = collider.cz[ triangle ] - az;
		centroidX[ local ] = ( ax + collider.bx[ triangle ] + collider.cx[ triangle ] ) / 3;
		centroidY[ local ] = ( ay + collider.by[ triangle ] + collider.cy[ triangle ] ) / 3;
		centroidZ[ local ] = ( az + collider.bz[ triangle ] + collider.cz[ triangle ] ) / 3;
		area[ local ] = Math.hypot(
			aby * acz - abz * acy,
			abz * acx - abx * acz,
			abx * acy - aby * acx,
		) * 0.5;

	}
	return { centroidX, centroidY, centroidZ, area };

}

class TriangleMinHeap {

	constructor() {

		this.nodes = [];
		this.priorities = [];
		this.poppedPriority = Infinity;

	}

	clear() {

		this.nodes.length = 0;
		this.priorities.length = 0;

	}

	_precedes( priorityA, nodeA, priorityB, nodeB ) {

		return priorityA < priorityB
			|| ( priorityA === priorityB && nodeA < nodeB );

	}

	push( node, priority ) {

		let index = this.nodes.length;
		this.nodes.push( node );
		this.priorities.push( priority );
		while ( index > 0 ) {

			const parent = ( index - 1 ) >> 1;
			if ( this._precedes(
				this.priorities[ parent ], this.nodes[ parent ],
				priority, node,
			) ) break;
			this.nodes[ index ] = this.nodes[ parent ];
			this.priorities[ index ] = this.priorities[ parent ];
			index = parent;

		}
		this.nodes[ index ] = node;
		this.priorities[ index ] = priority;

	}

	pop() {

		if ( this.nodes.length === 0 ) {

			this.poppedPriority = Infinity;
			return - 1;

		}
		const result = this.nodes[ 0 ];
		this.poppedPriority = this.priorities[ 0 ];
		const node = this.nodes.pop();
		const priority = this.priorities.pop();
		if ( this.nodes.length === 0 ) return result;

		let index = 0;
		while ( true ) {

			const left = index * 2 + 1;
			if ( left >= this.nodes.length ) break;
			const right = left + 1;
			let child = left;
			if ( right < this.nodes.length && this._precedes(
				this.priorities[ right ], this.nodes[ right ],
				this.priorities[ left ], this.nodes[ left ],
			) ) child = right;
			if ( this._precedes(
				priority, node,
				this.priorities[ child ], this.nodes[ child ],
			) ) break;
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

function nextPatchSeed(
	collider,
	component,
	trianglePatch,
	preferredLocal,
) {

	const start = component.supportTriangleStart;
	const count = component.supportTriangleCount;
	const reachableComponent = component.seedComponent;
	if ( preferredLocal >= 0
		&& component.componentOfTriangle[ preferredLocal ] === reachableComponent
		&& trianglePatch[ preferredLocal ] < 0 ) return preferredLocal;

	let fallback = - 1;
	for ( let local = 0; local < count; local ++ ) {

		if ( component.componentOfTriangle[ local ] !== reachableComponent
			|| trianglePatch[ local ] >= 0 ) continue;
		if ( fallback < 0 ) fallback = local;
		const triangle = start + local;
		for (
			let ordinal = collider.adjacencyOffsets[ triangle ];
			ordinal < collider.adjacencyOffsets[ triangle + 1 ];
			ordinal ++
		) {

			const neighbour = collider.adjacencyTriangles[ ordinal ];
			const neighbourLocal = neighbour - start;
			if ( neighbourLocal >= 0 && neighbourLocal < count
				&& trianglePatch[ neighbourLocal ] >= 0 ) return local;

		}

	}
	return fallback;

}

function clusterReachableComponent(
	collider,
	component,
	metrics,
	radius,
	maxTrianglesPerPatch,
	weldEpsilon,
) {

	const start = component.supportTriangleStart;
	const count = component.supportTriangleCount;
	const reachableComponent = component.seedComponent;
	const trianglePatch = new Int32Array( count );
	const triangleParent = new Int32Array( count );
	const triangleGeodesicDistance = new Float32Array( count );
	trianglePatch.fill( - 1 );
	triangleParent.fill( - 1 );
	triangleGeodesicDistance.fill( Infinity );

	const candidateDistance = new Float64Array( count );
	const candidateParent = new Int32Array( count );
	const candidateEpoch = new Uint32Array( count );
	const heap = new TriangleMinHeap();
	const midpoint = { x: 0, y: 0, z: 0, length: 0 };
	const patchSeedTriangles = [];
	const patchTriangleCounts = [];
	const patchMaxGeodesicRadius = [];
	const patchAreas = [];
	let assigned = 0;
	let preferredLocal = component.seedTriangle - start;
	let epoch = 0;

	while ( assigned < component.reachableTriangleCount ) {

		const seedLocal = nextPatchSeed(
			collider,
			component,
			trianglePatch,
			preferredLocal,
		);
		preferredLocal = - 1;
		if ( seedLocal < 0 ) throw new Error( 'reachable surface component could not be clustered' );
		const patch = patchSeedTriangles.length;
		const seedTriangle = start + seedLocal;
		patchSeedTriangles.push( seedTriangle );
		patchTriangleCounts.push( 0 );
		patchMaxGeodesicRadius.push( 0 );
		patchAreas.push( 0 );

		epoch = ( epoch + 1 ) >>> 0;
		if ( epoch === 0 ) {

			candidateEpoch.fill( 0 );
			epoch = 1;

		}
		heap.clear();
		candidateEpoch[ seedLocal ] = epoch;
		candidateDistance[ seedLocal ] = 0;
		candidateParent[ seedLocal ] = - 1;
		heap.push( seedLocal, 0 );

		while ( heap.size > 0
			&& patchTriangleCounts[ patch ] < maxTrianglesPerPatch ) {

			const local = heap.pop();
			const distance = heap.poppedPriority;
			if ( local < 0
				|| candidateEpoch[ local ] !== epoch
				|| Math.abs( candidateDistance[ local ] - distance ) > EPSILON
				|| trianglePatch[ local ] >= 0 ) continue;
			if ( distance > radius + EPSILON ) break;

			const triangle = start + local;
			trianglePatch[ local ] = patch;
			triangleParent[ local ] = candidateParent[ local ];
			triangleGeodesicDistance[ local ] = distance;
			patchTriangleCounts[ patch ] ++;
			patchMaxGeodesicRadius[ patch ] = Math.max(
				patchMaxGeodesicRadius[ patch ],
				distance,
			);
			patchAreas[ patch ] += metrics.area[ local ];
			assigned ++;

			for (
				let ordinal = collider.adjacencyOffsets[ triangle ];
				ordinal < collider.adjacencyOffsets[ triangle + 1 ];
				ordinal ++
			) {

				const neighbour = collider.adjacencyTriangles[ ordinal ];
				const neighbourLocal = neighbour - start;
				if ( neighbourLocal < 0 || neighbourLocal >= count
					|| component.componentOfTriangle[ neighbourLocal ] !== reachableComponent
					|| trianglePatch[ neighbourLocal ] >= 0 ) continue;
				if ( ! writeSharedEdgeMidpoint(
					collider,
					triangle,
					neighbour,
					midpoint,
					weldEpsilon,
				) ) {

					throw new Error( `adjacent triangles ${ triangle } and ${ neighbour } have no shared edge` );

				}
				const step = Math.hypot(
					metrics.centroidX[ local ] - midpoint.x,
					metrics.centroidY[ local ] - midpoint.y,
					metrics.centroidZ[ local ] - midpoint.z,
				) + Math.hypot(
					metrics.centroidX[ neighbourLocal ] - midpoint.x,
					metrics.centroidY[ neighbourLocal ] - midpoint.y,
					metrics.centroidZ[ neighbourLocal ] - midpoint.z,
				);
				const candidate = distance + step;
				if ( candidate > radius + EPSILON ) continue;
				const previous = candidateDistance[ neighbourLocal ];
				const previousParent = candidateParent[ neighbourLocal ];
				if ( candidateEpoch[ neighbourLocal ] === epoch
					&& ( candidate > previous + EPSILON
						|| ( Math.abs( candidate - previous ) <= EPSILON
							&& triangle >= previousParent ) ) ) continue;
				candidateEpoch[ neighbourLocal ] = epoch;
				candidateDistance[ neighbourLocal ] = candidate;
				candidateParent[ neighbourLocal ] = triangle;
				heap.push( neighbourLocal, candidate );

			}

		}

	}

	return {
		trianglePatch,
		triangleParent,
		triangleGeodesicDistance,
		patchSeedTriangles: Uint32Array.from( patchSeedTriangles ),
		patchTriangleCounts: Uint32Array.from( patchTriangleCounts ),
		patchMaxGeodesicRadius: Float32Array.from( patchMaxGeodesicRadius ),
		patchAreas: Float32Array.from( patchAreas ),
		patchCount: patchSeedTriangles.length,
	};

}
/*
 * Radius-grown patches can leave small frontier islands even when the
 * triangle-count budget is mathematically sufficient. This bake-only
 * fallback partitions a deterministic spanning tree bottom-up. Every patch
 * therefore remains face-connected and every triangle retains an exact
 * adjacent-triangle path to its seed.
 */
function partitionReachableTree(
	collider,
	component,
	metrics,
	maxTrianglesPerPatch,
	weldEpsilon,
) {

	const start = component.supportTriangleStart;
	const count = component.supportTriangleCount;
	const reachableComponent = component.seedComponent;
	const rootLocal = component.seedTriangle - start;
	const treeParent = new Int32Array( count );
	const traversalOrder = new Int32Array( component.reachableTriangleCount );
	const traversalStack = new Int32Array( component.reachableTriangleCount );
	const nextAdjacency = new Uint32Array( component.reachableTriangleCount );
	treeParent.fill( - 2 );
	treeParent[ rootLocal ] = - 1;
	traversalOrder[ 0 ] = rootLocal;
	traversalStack[ 0 ] = rootLocal;
	nextAdjacency[ 0 ] = collider.adjacencyOffsets[ component.seedTriangle ];
	let depth = 0;
	let write = 1;

	while ( depth >= 0 ) {

		const local = traversalStack[ depth ];
		const triangle = start + local;
		const end = collider.adjacencyOffsets[ triangle + 1 ];
		if ( nextAdjacency[ depth ] >= end ) {

			depth --;
			continue;

		}
		const neighbour = collider.adjacencyTriangles[ nextAdjacency[ depth ] ++ ];
		const neighbourLocal = neighbour - start;
		if ( neighbourLocal < 0 || neighbourLocal >= count
			|| component.componentOfTriangle[ neighbourLocal ] !== reachableComponent
			|| treeParent[ neighbourLocal ] !== - 2 ) continue;
		treeParent[ neighbourLocal ] = triangle;
		traversalOrder[ write ++ ] = neighbourLocal;
		depth ++;
		traversalStack[ depth ] = neighbourLocal;
		nextAdjacency[ depth ] = collider.adjacencyOffsets[ neighbour ];

	}
	if ( write !== component.reachableTriangleCount ) {

		throw new Error( 'reachable surface component spanning tree is incomplete' );

	}

	const openGroups = new Array( count );
	const groups = [];
	for ( let order = write - 1; order >= 0; order -- ) {

		const local = traversalOrder[ order ];
		const triangle = start + local;
		const group = { root: local, nodes: [ local ] };
		for (
			let ordinal = collider.adjacencyOffsets[ triangle ];
			ordinal < collider.adjacencyOffsets[ triangle + 1 ];
			ordinal ++
		) {

			const child = collider.adjacencyTriangles[ ordinal ];
			const childLocal = child - start;
			if ( childLocal < 0 || childLocal >= count
				|| treeParent[ childLocal ] !== triangle ) continue;
			const childGroup = openGroups[ childLocal ];
			if ( group.nodes.length + childGroup.nodes.length
				<= maxTrianglesPerPatch ) {

				group.nodes.push( ...childGroup.nodes );

			} else {

				groups.push( childGroup );

			}

		}
		openGroups[ local ] = group;

	}
	groups.push( openGroups[ rootLocal ] );

	const orderIndex = new Int32Array( count );
	orderIndex.fill( - 1 );
	for ( let order = 0; order < write; order ++ ) {

		orderIndex[ traversalOrder[ order ] ] = order;

	}
	groups.sort( ( a, b ) => orderIndex[ a.root ] - orderIndex[ b.root ] );

	const patchCount = groups.length;
	const trianglePatch = new Int32Array( count );
	const triangleParent = new Int32Array( count );
	const triangleGeodesicDistance = new Float32Array( count );
	const patchSeedTriangles = new Uint32Array( patchCount );
	const patchTriangleCounts = new Uint32Array( patchCount );
	const patchMaxGeodesicRadius = new Float32Array( patchCount );
	const patchAreas = new Float32Array( patchCount );
	trianglePatch.fill( - 1 );
	triangleParent.fill( - 1 );
	triangleGeodesicDistance.fill( Infinity );

	for ( let patch = 0; patch < patchCount; patch ++ ) {

		const group = groups[ patch ];
		patchSeedTriangles[ patch ] = start + group.root;
		triangleGeodesicDistance[ group.root ] = 0;
		patchTriangleCounts[ patch ] = group.nodes.length;
		for ( const local of group.nodes ) {

			trianglePatch[ local ] = patch;
			patchAreas[ patch ] += metrics.area[ local ];

		}

	}

	const midpoint = { x: 0, y: 0, z: 0, length: 0 };
	for ( let order = 0; order < write; order ++ ) {

		const local = traversalOrder[ order ];
		const triangle = start + local;
		const parent = treeParent[ local ];
		const patch = trianglePatch[ local ];
		if ( parent < 0 || trianglePatch[ parent - start ] !== patch ) continue;
		if ( ! writeSharedEdgeMidpoint(
			collider,
			triangle,
			parent,
			midpoint,
			weldEpsilon,
		) ) {

			throw new Error( `tree triangles ${ triangle } and ${ parent } have no shared edge` );

		}
		const parentLocal = parent - start;
		const distance = triangleGeodesicDistance[ parentLocal ]
			+ Math.hypot(
				metrics.centroidX[ local ] - midpoint.x,
				metrics.centroidY[ local ] - midpoint.y,
				metrics.centroidZ[ local ] - midpoint.z,
			)
			+ Math.hypot(
				metrics.centroidX[ parentLocal ] - midpoint.x,
				metrics.centroidY[ parentLocal ] - midpoint.y,
				metrics.centroidZ[ parentLocal ] - midpoint.z,
			);
		triangleParent[ local ] = parent;
		triangleGeodesicDistance[ local ] = distance;
		patchMaxGeodesicRadius[ patch ] = Math.max(
			patchMaxGeodesicRadius[ patch ],
			distance,
		);

	}

	return {
		trianglePatch,
		triangleParent,
		triangleGeodesicDistance,
		patchSeedTriangles,
		patchTriangleCounts,
		patchMaxGeodesicRadius,
		patchAreas,
		patchCount,
	};

}


function writeTriangleSmoothNormal( collider, triangle, output, offset ) {

	let nx = collider.normalAX[ triangle ]
		+ collider.normalBX[ triangle ]
		+ collider.normalCX[ triangle ];
	let ny = collider.normalAY[ triangle ]
		+ collider.normalBY[ triangle ]
		+ collider.normalCY[ triangle ];
	let nz = collider.normalAZ[ triangle ]
		+ collider.normalBZ[ triangle ]
		+ collider.normalCZ[ triangle ];
	const inverseLength = 1 / ( Math.hypot( nx, ny, nz ) || 1 );
	nx *= inverseLength;
	ny *= inverseLength;
	nz *= inverseLength;
	output.normalX[ offset ] = nx;
	output.normalY[ offset ] = ny;
	output.normalZ[ offset ] = nz;

}

function buildPatchMembership( component, clustered ) {

	const patchOffsets = new Uint32Array( clustered.patchCount + 1 );
	for ( let patch = 0; patch < clustered.patchCount; patch ++ ) {

		patchOffsets[ patch + 1 ] = patchOffsets[ patch ]
			+ clustered.patchTriangleCounts[ patch ];

	}
	const patchTriangles = new Uint32Array( component.reachableTriangleCount );
	const cursor = patchOffsets.slice( 0, clustered.patchCount );
	for ( let local = 0; local < component.supportTriangleCount; local ++ ) {

		const patch = clustered.trianglePatch[ local ];
		if ( patch >= 0 ) patchTriangles[ cursor[ patch ] ++ ] =
			component.supportTriangleStart + local;

	}
	return { patchOffsets, patchTriangles };

}

function buildPatchTopology(
	collider,
	component,
	clustered,
	metrics,
	nodeOutput,
	weldEpsilon,
) {

	const start = component.supportTriangleStart;
	const records = new Map();
	const midpoint = { x: 0, y: 0, z: 0, length: 0 };

	for ( const triangle of component.reachableTriangles ) {

		const local = triangle - start;
		const patchA = clustered.trianglePatch[ local ];
		for (
			let ordinal = collider.adjacencyOffsets[ triangle ];
			ordinal < collider.adjacencyOffsets[ triangle + 1 ];
			ordinal ++
		) {

			const neighbour = collider.adjacencyTriangles[ ordinal ];
			if ( neighbour <= triangle ) continue;
			const neighbourLocal = neighbour - start;
			if ( neighbourLocal < 0
				|| neighbourLocal >= component.supportTriangleCount ) continue;
			const patchB = clustered.trianglePatch[ neighbourLocal ];
			if ( patchB < 0 || patchA === patchB ) continue;
			if ( ! writeSharedEdgeMidpoint(
				collider,
				triangle,
				neighbour,
				midpoint,
				weldEpsilon,
			) ) {

				throw new Error( `patch boundary ${ triangle }/${ neighbour } has no shared edge` );

			}

			const low = Math.min( patchA, patchB );
			const high = Math.max( patchA, patchB );
			const lowTriangle = patchA === low ? triangle : neighbour;
			const highTriangle = patchA === low ? neighbour : triangle;
			const key = low * clustered.patchCount + high;
			const candidateWeight =
				clustered.triangleGeodesicDistance[ local ]
				+ Math.hypot(
					metrics.centroidX[ local ] - midpoint.x,
					metrics.centroidY[ local ] - midpoint.y,
					metrics.centroidZ[ local ] - midpoint.z,
				)
				+ clustered.triangleGeodesicDistance[ neighbourLocal ]
				+ Math.hypot(
					metrics.centroidX[ neighbourLocal ] - midpoint.x,
					metrics.centroidY[ neighbourLocal ] - midpoint.y,
					metrics.centroidZ[ neighbourLocal ] - midpoint.z,
				);
			let record = records.get( key );
			if ( ! record ) {

				record = {
					a: low,
					b: high,
					triangleA: lowTriangle,
					triangleB: highTriangle,
					x: midpoint.x,
					y: midpoint.y,
					z: midpoint.z,
					nx: 0,
					ny: 1,
					nz: 0,
					weight: candidateWeight,
					boundaryLength: 0,
				};
				records.set( key, record );

			}
			record.boundaryLength += midpoint.length;
			const better = candidateWeight < record.weight - EPSILON
				|| ( Math.abs( candidateWeight - record.weight ) <= EPSILON
					&& ( lowTriangle < record.triangleA
						|| ( lowTriangle === record.triangleA
							&& highTriangle < record.triangleB ) ) );
			if ( better ) {

				record.triangleA = lowTriangle;
				record.triangleB = highTriangle;
				record.x = midpoint.x;
				record.y = midpoint.y;
				record.z = midpoint.z;
				record.weight = candidateWeight;

			}

		}

	}

	const undirected = [ ...records.values() ].sort(
		( a, b ) => a.a - b.a || a.b - b.b,
	);
	for ( const record of undirected ) {

		let nx = collider.faceNormalX[ record.triangleA ]
			+ collider.faceNormalX[ record.triangleB ];
		let ny = collider.faceNormalY[ record.triangleA ]
			+ collider.faceNormalY[ record.triangleB ];
		let nz = collider.faceNormalZ[ record.triangleA ]
			+ collider.faceNormalZ[ record.triangleB ];
		const inverseLength = 1 / ( Math.hypot( nx, ny, nz ) || 1 );
		record.nx = nx * inverseLength;
		record.ny = ny * inverseLength;
		record.nz = nz * inverseLength;

	}

	const directed = [];
	for ( const edge of undirected ) {

		directed.push( {
			from: edge.a,
			to: edge.b,
			fromTriangle: edge.triangleA,
			toTriangle: edge.triangleB,
			edge,
		}, {
			from: edge.b,
			to: edge.a,
			fromTriangle: edge.triangleB,
			toTriangle: edge.triangleA,
			edge,
		} );

	}
	directed.sort( ( a, b ) => a.from - b.from || a.to - b.to
		|| a.fromTriangle - b.fromTriangle || a.toTriangle - b.toTriangle );

	const offsets = new Uint32Array( clustered.patchCount + 1 );
	for ( const edge of directed ) offsets[ edge.from + 1 ] ++;
	for ( let patch = 0; patch < clustered.patchCount; patch ++ ) {

		offsets[ patch + 1 ] += offsets[ patch ];

	}
	const edgeTo = new Uint32Array( directed.length );
	const edgeWeight = new Float32Array( directed.length );
	const portalX = new Float32Array( directed.length );
	const portalY = new Float32Array( directed.length );
	const portalZ = new Float32Array( directed.length );
	const portalNormalX = new Float32Array( directed.length );
	const portalNormalY = new Float32Array( directed.length );
	const portalNormalZ = new Float32Array( directed.length );
	const boundaryLength = new Float32Array( directed.length );
	const edgeFromTriangle = new Uint32Array( directed.length );
	const edgeToTriangle = new Uint32Array( directed.length );

	for ( let index = 0; index < directed.length; index ++ ) {

		const directedEdge = directed[ index ];
		const edge = directedEdge.edge;
		edgeTo[ index ] = directedEdge.to;
		edgeWeight[ index ] = edge.weight;
		portalX[ index ] = edge.x;
		portalY[ index ] = edge.y;
		portalZ[ index ] = edge.z;
		portalNormalX[ index ] = edge.nx;
		portalNormalY[ index ] = edge.ny;
		portalNormalZ[ index ] = edge.nz;
		boundaryLength[ index ] = edge.boundaryLength;
		edgeFromTriangle[ index ] = directedEdge.fromTriangle;
		edgeToTriangle[ index ] = directedEdge.toTriangle;

	}

	let connectedPatchCount = clustered.patchCount > 0 ? 1 : 0;
	if ( clustered.patchCount > 1 ) {

		const visited = new Uint8Array( clustered.patchCount );
		const queue = new Uint32Array( clustered.patchCount );
		let read = 0;
		let write = 1;
		queue[ 0 ] = 0;
		visited[ 0 ] = 1;
		while ( read < write ) {

			const patch = queue[ read ++ ];
			for ( let edge = offsets[ patch ]; edge < offsets[ patch + 1 ]; edge ++ ) {

				const next = edgeTo[ edge ];
				if ( visited[ next ] ) continue;
				visited[ next ] = 1;
				queue[ write ++ ] = next;
				connectedPatchCount ++;

			}

		}

	}
	if ( connectedPatchCount !== clustered.patchCount ) {

		throw new Error( 'surface patch graph is disconnected inside a reachable component' );

	}

	return {
		edgeCount: undirected.length,
		directedEdgeCount: directed.length,
		offsets,
		edgeTo,
		edgeWeight,
		portalX,
		portalY,
		portalZ,
		portalNormalX,
		portalNormalY,
		portalNormalZ,
		boundaryLength,
		edgeFromTriangle,
		edgeToTriangle,
	};

}

/**
 * Builds one compact patch graph for the reachable component of one support.
 *
 * `targetPatchRadius` is an upper bound on the in-patch path accumulated from
 * each patch seed. It may be increased deterministically to honour
 * `maxPatches`; the effective value is published in the result. Each patch is
 * additionally bounded by `maxTrianglesPerPatch`.
 */
export function buildChameleonSurfacePatches( collider, {
	supportId,
	seedTriangle = - 1,
	portal = null,
	portalX = NaN,
	portalY = NaN,
	portalZ = NaN,
	targetPatchRadius = DEFAULT_PATCH_RADIUS,
	maxPatches = DEFAULT_MAX_PATCHES,
	maxTrianglesPerPatch = DEFAULT_MAX_TRIANGLES_PER_PATCH,
	weldEpsilon = 1e-5,
} = {} ) {

	requireCollider( collider );
	const support = requireSupport( collider, supportId );
	const component = floodChameleonSurfaceComponent( collider, {
		supportId,
		seedTriangle,
		portal,
		portalX,
		portalY,
		portalZ,
	} );
	const triangleLimit = clampInteger( maxTrianglesPerPatch, 2, 65535 );
	const requestedBudget = clampInteger( maxPatches, 1, 65535 );
	const compressionBudget = component.reachableTriangleCount > 1
		? Math.ceil( component.reachableTriangleCount / 2 )
		: 1;
	const effectiveBudget = Math.min( requestedBudget, compressionBudget );
	const minimumPatchBudget = Math.ceil(
		component.reachableTriangleCount / triangleLimit,
	);
	if ( effectiveBudget < minimumPatchBudget ) {

		throw new RangeError(
			`patch budget ${ effectiveBudget } cannot cover ${ component.reachableTriangleCount } triangles `
			+ `with at most ${ triangleLimit } triangles per patch`,
		);

	}

	const metrics = buildTriangleMetrics( collider, support );
	const safeWeldEpsilon = Math.max( 1e-9, finiteOr( weldEpsilon, 1e-5 ) );
	const requestedRadius = Math.max(
		safeWeldEpsilon,
		finiteOr( targetPatchRadius, DEFAULT_PATCH_RADIUS ),
	);
	let effectiveRadius = requestedRadius;
	let clustered = null;
	let attempts = 0;
	let usedTreePartition = false;

	for ( ; attempts < MAX_ADAPTATION_ATTEMPTS; attempts ++ ) {

		clustered = clusterReachableComponent(
			collider,
			component,
			metrics,
			effectiveRadius,
			triangleLimit,
			safeWeldEpsilon,
		);
		if ( clustered.patchCount <= effectiveBudget ) break;
		const ratio = clustered.patchCount / effectiveBudget;
		effectiveRadius *= Math.max( 1.3, Math.sqrt( ratio ) * 1.08 );

	}
	if ( clustered.patchCount > effectiveBudget ) {

		clustered = partitionReachableTree(
			collider,
			component,
			metrics,
			triangleLimit,
			safeWeldEpsilon,
		);
		effectiveRadius = 0;
		for ( const radius of clustered.patchMaxGeodesicRadius ) {

			effectiveRadius = Math.max( effectiveRadius, radius );

		}
		usedTreePartition = true;

	}
	if ( clustered.patchCount > effectiveBudget ) {

		throw new RangeError(
			`deterministic clustering needs ${ clustered.patchCount } patches `
			+ `but the effective budget is ${ effectiveBudget }`,
		);

	}

	const patchCount = clustered.patchCount;
	const nodeOutput = {
		x: new Float32Array( patchCount ),
		y: new Float32Array( patchCount ),
		z: new Float32Array( patchCount ),
		normalX: new Float32Array( patchCount ),
		normalY: new Float32Array( patchCount ),
		normalZ: new Float32Array( patchCount ),
	};
	for ( let patch = 0; patch < patchCount; patch ++ ) {

		const triangle = clustered.patchSeedTriangles[ patch ];
		const local = triangle - support.triangleStart;
		nodeOutput.x[ patch ] = metrics.centroidX[ local ];
		nodeOutput.y[ patch ] = metrics.centroidY[ local ];
		nodeOutput.z[ patch ] = metrics.centroidZ[ local ];
		writeTriangleSmoothNormal( collider, triangle, nodeOutput, patch );

	}

	const membership = buildPatchMembership( component, clustered );
	const topology = buildPatchTopology(
		collider,
		component,
		clustered,
		metrics,
		nodeOutput,
		safeWeldEpsilon,
	);
	let maximumGeodesicRadius = 0;
	let maximumTriangleCount = 0;
	for ( let patch = 0; patch < patchCount; patch ++ ) {

		maximumGeodesicRadius = Math.max(
			maximumGeodesicRadius,
			clustered.patchMaxGeodesicRadius[ patch ],
		);
		maximumTriangleCount = Math.max(
			maximumTriangleCount,
			clustered.patchTriangleCounts[ patch ],
		);

	}
	const telemetry = Object.freeze( {
		supportId,
		supportTriangleCount: component.supportTriangleCount,
		reachableTriangleCount: component.reachableTriangleCount,
		excludedTriangleCount: component.excludedTriangleCount,
		componentCount: component.componentCount,
		patchCount,
		edgeCount: topology.edgeCount,
		directedEdgeCount: topology.directedEdgeCount,
		requestedPatchBudget: requestedBudget,
		effectivePatchBudget: effectiveBudget,
		minimumPatchBudget,
		requestedPatchRadius: requestedRadius,
		effectivePatchRadius: effectiveRadius,
		maximumGeodesicRadius,
		maximumTriangleCount,
		maxTrianglesPerPatch: triangleLimit,
		adaptationAttempts: attempts + 1,
		coverageRatio: component.reachableTriangleCount > 0 ? 1 : 0,
		usedTreePartition,
		trianglesPerPatch: component.reachableTriangleCount / patchCount,
		compressionRatio: patchCount / component.reachableTriangleCount,
	} );

	return Object.freeze( {
		supportId,
		supportTriangleStart: component.supportTriangleStart,
		supportTriangleCount: component.supportTriangleCount,
		seedTriangle: component.seedTriangle,
		componentCount: component.componentCount,
		reachableTriangleCount: component.reachableTriangleCount,
		excludedTriangleCount: component.excludedTriangleCount,
		reachableTriangles: component.reachableTriangles,
		componentOfTriangle: component.componentOfTriangle,
		patchCount,
		x: nodeOutput.x,
		y: nodeOutput.y,
		z: nodeOutput.z,
		normalX: nodeOutput.normalX,
		normalY: nodeOutput.normalY,
		normalZ: nodeOutput.normalZ,
		patchSeedTriangles: clustered.patchSeedTriangles,
		patchTriangleCount: clustered.patchTriangleCounts,
		patchArea: clustered.patchAreas,
		patchMaxGeodesicRadius: clustered.patchMaxGeodesicRadius,
		trianglePatch: clustered.trianglePatch,
		triangleParent: clustered.triangleParent,
		triangleGeodesicDistance: clustered.triangleGeodesicDistance,
		patchTriangleOffsets: membership.patchOffsets,
		patchTriangles: membership.patchTriangles,
		edgeCount: topology.edgeCount,
		offsets: topology.offsets,
		edgeTo: topology.edgeTo,
		edgeWeight: topology.edgeWeight,
		portalX: topology.portalX,
		portalY: topology.portalY,
		portalZ: topology.portalZ,
		portalNormalX: topology.portalNormalX,
		portalNormalY: topology.portalNormalY,
		portalNormalZ: topology.portalNormalZ,
		boundaryLength: topology.boundaryLength,
		edgeFromTriangle: topology.edgeFromTriangle,
		edgeToTriangle: topology.edgeToTriangle,
		telemetry,
	} );

}
