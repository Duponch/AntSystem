import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import { createLabEnvironment } from '../src/chameleon-lab/environment.js';
import { createPhysicsWorld } from '../src/chameleon-lab/physics-world.js';
import { SUPPORT_SEAM_MINIMUM_NORMAL_DOT } from '../src/chameleon-lab/support-cohort-model.js';
import { buildLabSurfaceNavigationGraph } from '../src/chameleon-lab/surface-navigation-graph.js';
import { SurfaceRoutePlanner } from '../src/chameleon-lab/third-person-controller.js';

const NAVIGATION_OPTIONS = Object.freeze( {
	spacing: 0.55,
	clearance: 0.34,
} );
const TERRAIN_ROUTE_KIND = 0;
const EPSILON = 1e-5;

function entryByName( environment, name ) {

	const entry = environment.colliders.find( ( candidate ) => candidate.object.name === name );
	assert.ok( entry, `missing laboratory collider ${ name }` );
	return entry;

}

async function withNavigation( callback ) {

	const scene = new THREE.Scene();
	const physics = await createPhysicsWorld( {
		gravity: { x: 0, y: -9.81, z: 0 },
		fixedDt: 1 / 120,
		maxSubsteps: 1,
	} );
	physics.surfaceByCollider = new Map();
	const environment = createLabEnvironment( { scene, physics } );
	try {

		const graph = buildLabSurfaceNavigationGraph(
			environment.colliders,
			NAVIGATION_OPTIONS,
		);
		await callback( { environment, graph } );

	} finally {

		environment.dispose();
		physics.dispose();

	}

}

function csrView( graph ) {

	const csr = graph.csr ?? graph;
	const rowOffsets = csr.rowOffsets ?? csr.offsets;
	const neighbors = csr.neighbors ?? csr.edgeTo ?? csr.columns ?? csr.targets;
	return { csr, rowOffsets, neighbors };

}

function locatedNodeId( located ) {

	if ( Number.isInteger( located ) ) return located;
	return located?.nodeId ?? located?.id ?? null;

}

function nodeNormal( graph, nodeId, target = new THREE.Vector3() ) {

	const offset = nodeId * 3;
	const source = graph.normals;
	assert.ok( source?.length >= offset + 3,
		'located graph nodes must expose their authored surface normal' );
	target.set(
		Number( source[ offset ] ),
		Number( source[ offset + 1 ] ),
		Number( source[ offset + 2 ] ),
	);
	assert.ok( [ target.x, target.y, target.z ].every( Number.isFinite ) );
	assert.ok( target.lengthSq() > 1e-8 );
	return target.normalize();

}

function locateNode( graph, point, normal, collider ) {

	const locate = graph.locate ?? graph.locatePatch;
	assert.equal( typeof locate, 'function',
		'the click and the four-foot support vote need one shared point/normal mapper' );
	const located = locate.call( graph, point, normal, collider );
	const nodeId = locatedNodeId( located );
	assert.ok( Number.isInteger( nodeId ), 'a grippable surface must resolve to a graph node' );
	return nodeId;

}

function pointAt( route, index, target = new THREE.Vector3() ) {

	const offset = index * 3;
	return target.set(
		route.positions[ offset ],
		route.positions[ offset + 1 ],
		route.positions[ offset + 2 ],
	);

}

function segmentIntersectsBoxInterior( start, end, box ) {

	let minimum = 0;
	let maximum = 1;
	for ( const axis of [ 'x', 'y', 'z' ] ) {

		const origin = start[ axis ];
		const delta = end[ axis ] - origin;
		const lower = box.min[ axis ] + EPSILON;
		const upper = box.max[ axis ] - EPSILON;
		if ( lower >= upper ) continue;
		if ( Math.abs( delta ) <= EPSILON ) {

			if ( origin <= lower || origin >= upper ) return false;
			continue;

		}
		let near = ( lower - origin ) / delta;
		let far = ( upper - origin ) / delta;
		if ( near > far ) [ near, far ] = [ far, near ];
		minimum = Math.max( minimum, near );
		maximum = Math.min( maximum, far );
		if ( minimum > maximum ) return false;

	}
	return maximum >= 0 && minimum <= 1 && maximum >= minimum;

}

test( 'CHAMELEON-LAB-SURFACE-NAV-001 the immutable CSR graph connects every emitted patch', async () => {

	await withNavigation( ( { environment, graph } ) => {

		assert.ok( Object.isFrozen( graph ), 'the shared graph descriptor must be immutable' );
		assert.ok( Number.isInteger( graph.nodeCount ) && graph.nodeCount > 1 );
		assert.ok( Number.isInteger( graph.patchCount ) && graph.patchCount > 1
			&& graph.patchCount <= graph.nodeCount );
		const { csr, rowOffsets, neighbors } = csrView( graph );
		assert.ok( Object.isFrozen( csr ), 'the CSR descriptor must be immutable' );
		assert.ok( rowOffsets instanceof Uint32Array );
		assert.ok( neighbors instanceof Uint32Array );
		assert.equal( rowOffsets.length, graph.nodeCount + 1 );
		assert.equal( rowOffsets[ 0 ], 0 );
		assert.equal( rowOffsets.at( -1 ), neighbors.length );
		if ( graph.edgeCount !== undefined ) assert.equal( graph.edgeCount, neighbors.length );
		for ( let patch = 0; patch < graph.nodeCount; patch ++ ) {

			assert.ok( rowOffsets[ patch ] <= rowOffsets[ patch + 1 ] );
			for ( let edge = rowOffsets[ patch ]; edge < rowOffsets[ patch + 1 ]; edge ++ )
				assert.ok( neighbors[ edge ] < graph.nodeCount );

		}

		const reached = new Uint8Array( graph.nodeCount );
		const queue = new Uint32Array( graph.nodeCount );
		let read = 0;
		let write = 1;
		reached[ 0 ] = 1;
		while ( read < write ) {

			const patch = queue[ read ++ ];
			for ( let edge = rowOffsets[ patch ]; edge < rowOffsets[ patch + 1 ]; edge ++ ) {

				const neighbor = neighbors[ edge ];
				if ( reached[ neighbor ] ) continue;
				reached[ neighbor ] = 1;
				queue[ write ++ ] = neighbor;

			}

		}
		const missingByHandle = new Map();
		for ( let node = 0; node < graph.nodeCount; node ++ ) {

			if ( reached[ node ] ) continue;
			const handle = graph.handles[ node ];
			missingByHandle.set( handle, ( missingByHandle.get( handle ) ?? 0 ) + 1 );

		}
		const missing = Array.from( missingByHandle, ( [ handle, count ] ) => [
			environment.colliders.find( ( entry ) => entry.collider.handle === handle )
				?.object?.name ?? handle,
			count,
		] );
		assert.equal( write, graph.nodeCount,
			'all emitted patches must be reachable in the directed locomotion graph; '
				+ JSON.stringify( missing ) );

	} );

} );

test( 'CHAMELEON-LAB-SURFACE-NAV-002 front and rear clicks on one wall resolve to distinct face patches', async () => {

	await withNavigation( ( { environment, graph } ) => {

		const wall = entryByName( environment, 'RoughBackWall' );
		const depth = wall.object.geometry.parameters.depth;
		const frontPoint = wall.object.localToWorld( new THREE.Vector3( 0, 0, depth * 0.5 ) );
		const rearPoint = wall.object.localToWorld( new THREE.Vector3( 0, 0, -depth * 0.5 ) );
		const frontNormal = new THREE.Vector3( 0, 0, 1 )
			.transformDirection( wall.object.matrixWorld );
		const rearNormal = new THREE.Vector3( 0, 0, -1 )
			.transformDirection( wall.object.matrixWorld );
		const front = locateNode( graph, frontPoint, frontNormal, wall.collider );
		const rear = locateNode( graph, rearPoint, rearNormal, wall.collider );

		assert.notEqual( front, rear,
			'collider handles alone cannot identify opposite support faces' );
		assert.ok( graph.patchIds instanceof Uint32Array
			|| graph.patchIds instanceof Uint16Array
			|| graph.patchIds instanceof Int16Array );
		assert.notEqual( graph.patchIds[ front ], graph.patchIds[ rear ] );
		assert.ok( nodeNormal( graph, front ).dot( frontNormal ) > 0.999 );
		assert.ok( nodeNormal( graph, rear ).dot( rearNormal ) > 0.999 );
		assert.ok( nodeNormal( graph, front ).dot( nodeNormal( graph, rear ) ) < -0.999 );
		assert.equal(
			locateNode( graph, frontPoint, frontNormal, wall.collider ),
			front,
			'patch lookup must be deterministic',
		);

	} );

} );

test( 'CHAMELEON-LAB-SURFACE-NAV-003 ground travel behind RoughBackWall never crosses its expanded solid', async () => {

	await withNavigation( ( { environment, graph } ) => {

		const ground = entryByName( environment, 'RoughGround' );
		const wall = entryByName( environment, 'RoughBackWall' );
		const planner = new SurfaceRoutePlanner( graph );
		const start = new THREE.Vector3( 0, 0.16, -5 );
		const destination = new THREE.Vector3( 0, 0.16, -9 );
		const up = new THREE.Vector3( 0, 1, 0 );
		assert.equal( typeof graph.segmentClearTerrain, 'function' );
		assert.equal( graph.segmentClearTerrain( start, destination ), false,
			'the graph must reject the direct terrain chord through RoughBackWall' );
		const route = planner.plan(
			start,
			ground.collider,
			destination,
			up,
			ground.collider,
		);

		assert.ok( route.count > 1,
			'a same-ground destination behind a wall must not collapse to one direct waypoint' );
		assert.ok( route.kinds instanceof Uint8Array,
			'the follower and debug view need terrain/transition/support semantics' );
		assert.ok( pointAt( route, route.count - 1 ).distanceTo( destination ) < 1e-4 );
		const blocked = new THREE.Box3().setFromObject( wall.object )
			.expandByScalar( NAVIGATION_OPTIONS.clearance );
		const from = start.clone();
		const to = new THREE.Vector3();
		let previousKind = TERRAIN_ROUTE_KIND;
		for ( let index = 0; index < route.count; index ++ ) {

			pointAt( route, index, to );
			const nextKind = route.kinds[ index ];
			assert.equal(
				segmentIntersectsBoxInterior( from, to, blocked ),
				false,
				`route segment ${ index } crosses the expanded RoughBackWall AABB: `
					+ `${ from.toArray() } -> ${ to.toArray() }; kind=${ nextKind }; `
					+ `handle=${ route.handles?.[ index ] }; patch=${ route.patches?.[ index ] }`,
			);
			if ( previousKind === TERRAIN_ROUTE_KIND && nextKind === TERRAIN_ROUTE_KIND ) {

				assert.equal( graph.segmentClearTerrain( from, to ), true,
					'terrain segment ' + index + ' was not cleared by the navigation graph' );
				assert.equal(
					segmentIntersectsBoxInterior( from, to, blocked ),
					false,
					`terrain segment ${ index } crosses the expanded RoughBackWall AABB`,
				);

			}
			from.copy( to );
			previousKind = nextKind;

		}

	} );

} );

test( 'CHAMELEON-LAB-SURFACE-NAV-005 cross-collider portals are outward-facing and degree bounded', async () => {

	await withNavigation( ( { graph } ) => {

		assert.ok( Number.isInteger( graph.maximumTransitionDegree ) );
		assert.ok( graph.maximumTransitionDegree >= 1 && graph.maximumTransitionDegree <= 12 );
		const degree = new Uint16Array( graph.nodeCount );
		let transitionCount = 0;
		for ( let node = 0; node < graph.nodeCount; node ++ ) {

			for ( let edge = graph.offsets[ node ]; edge < graph.offsets[ node + 1 ]; edge ++ ) {

				const neighbor = graph.edgeTo[ edge ];
				if ( graph.handles[ node ] === graph.handles[ neighbor ] ) continue;
				degree[ node ] ++;
				if ( neighbor <= node ) continue;
				transitionCount ++;
				const from = node * 3;
				const to = neighbor * 3;
				const dx = graph.rawPositions[ to ] - graph.rawPositions[ from ];
				const dy = graph.rawPositions[ to + 1 ] - graph.rawPositions[ from + 1 ];
				const dz = graph.rawPositions[ to + 2 ] - graph.rawPositions[ from + 2 ];
				const departure = dx * graph.normals[ from ]
					+ dy * graph.normals[ from + 1 ]
					+ dz * graph.normals[ from + 2 ];
				const arrival = dx * graph.normals[ to ]
					+ dy * graph.normals[ to + 1 ]
					+ dz * graph.normals[ to + 2 ];
				const normalDot = graph.normals[ from ] * graph.normals[ to ]
					+ graph.normals[ from + 1 ] * graph.normals[ to + 1 ]
					+ graph.normals[ from + 2 ] * graph.normals[ to + 2 ];
				assert.ok( departure >= -1e-4,
					`portal ${ node } -> ${ neighbor } enters its departure solid` );
				assert.ok( arrival <= 1e-4,
					`portal ${ node } -> ${ neighbor } enters its destination solid` );
				assert.ok( normalDot >= SUPPORT_SEAM_MINIMUM_NORMAL_DOT - EPSILON,
					`portal ${ node } -> ${ neighbor } exceeds the physical normal discontinuity` );

			}

		}
		assert.ok( transitionCount > 0 );
		assert.ok( Math.max( ...degree ) <= graph.maximumTransitionDegree );

	} );

} );

test( 'CHAMELEON-LAB-SURFACE-NAV-004 planning reuses storage without mutating the shared CSR graph', async () => {

	await withNavigation( ( { environment, graph } ) => {

		const ground = entryByName( environment, 'RoughGround' );
		const wall = entryByName( environment, 'RoughBackWall' );
		const planner = new SurfaceRoutePlanner( graph );
		const { rowOffsets, neighbors } = csrView( graph );
		const rowOffsetsBefore = rowOffsets.slice();
		const neighborsBefore = neighbors.slice();
		const first = planner.plan(
			new THREE.Vector3( 0, 0.16, -5 ),
			ground.collider,
			new THREE.Vector3( 0, 1, -6.775 ),
			new THREE.Vector3( 0, 0, 1 ),
			wall.collider,
		);
		const storage = {
			view: first,
			positions: first.positions,
			normals: first.normals,
			kinds: first.kinds,
			patchIds: first.patchIds,
		};
		const second = planner.plan(
			new THREE.Vector3( 1, 0.16, -5 ),
			ground.collider,
			new THREE.Vector3( 1, 0.16, -9 ),
			new THREE.Vector3( 0, 1, 0 ),
			ground.collider,
		);

		assert.equal( second, storage.view );
		assert.equal( second.positions, storage.positions );
		assert.equal( second.normals, storage.normals );
		assert.equal( second.kinds, storage.kinds );
		if ( storage.patchIds !== undefined ) assert.equal( second.patchIds, storage.patchIds );
		assert.deepEqual( rowOffsets, rowOffsetsBefore );
		assert.deepEqual( neighbors, neighborsBefore );

	} );

} );
