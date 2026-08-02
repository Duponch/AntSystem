import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import { createLabEnvironment } from '../src/chameleon-lab/environment.js';
import { createPhysicsWorld } from '../src/chameleon-lab/physics-world.js';
import {
	AutonomousExplorer,
	SurfaceRoutePlanner,
} from '../src/chameleon-lab/third-person-controller.js';

function entryByName( environment, name ) {

	const entry = environment.colliders.find( ( candidate ) => candidate.object.name === name );
	assert.ok( entry, `missing laboratory collider ${ name }` );
	return entry;

}

function pointAt( plan, index, target = new THREE.Vector3() ) {

	const offset = index * 3;
	return target.set(
		plan.positions[ offset ],
		plan.positions[ offset + 1 ],
		plan.positions[ offset + 2 ],
	);

}

async function withEnvironment( callback ) {

	const scene = new THREE.Scene();
	const physics = await createPhysicsWorld( {
		gravity: { x: 0, y: -9.81, z: 0 },
		fixedDt: 1 / 120,
		maxSubsteps: 1,
	} );
	physics.surfaceByCollider = new Map();
	const environment = createLabEnvironment( { scene, physics } );
	try {

		await callback( environment );

	} finally {

		environment.dispose();
		physics.dispose();

	}

}

test( 'CHAMELEON-LAB-NAVIGATION-001 elevated perches use a connected surface corridor', async () => {

	await withEnvironment( ( environment ) => {

		const ground = entryByName( environment, 'RoughGround' );
		const horizontal = entryByName( environment, 'HorizontalPerch' );
		const planner = new SurfaceRoutePlanner( environment.navigation );
		const destination = horizontal.object.position.clone();
		const route = planner.plan(
			new THREE.Vector3( 0, 0.3, 0.75 ),
			ground.collider,
			destination,
			new THREE.Vector3( 0, 1, 0 ),
			horizontal.collider,
		);
		assert.equal( route.reachable, true );
		assert.ok( route.count >= 4 && route.count <= planner.maximumWaypoints );
		assert.ok( Array.from( route.kinds.subarray( 0, route.count ) ).includes( 2 ),
			'a physical support hand-off must remain explicit' );
		assert.ok( Array.from( route.nodeIds.subarray( 0, route.count ) ).some(
			( node ) => node >= 0
				&& environment.navigation.handles[ node ] === horizontal.collider.handle,
		), 'the corridor must actually enter the selected perch manifold' );
		assert.ok( pointAt( route, route.count - 1 ).distanceTo( destination ) < 1e-5 );

	} );

} );

test( 'CHAMELEON-LAB-NAVIGATION-002 explorer copies route storage and advances deterministically', () => {

	const positions = new Float32Array( [
		0, 0, 0,
		1, 0, 0,
		2, 0, 0,
		3, 0, 0,
	] );
	const normals = new Float32Array( [
		0, 1, 0,
		0, 1, 0,
		0, 1, 0,
		0, 1, 0,
	] );
	const route = { positions, normals, count: 4 };
	const explorer = new AutonomousExplorer( 0x321 );
	explorer.heading.set( 1, 0, 0 );
	explorer.setDestination(
		new THREE.Vector3( 3, 0, 0 ),
		new THREE.Vector3( 0, 1, 0 ),
		new THREE.Vector3(),
		route,
	);
	assert.equal( explorer.routeProgressIndex, 0 );
	const copiedPositions = explorer.routePositions;
	const copiedNormals = explorer.routeNormals;
	const output = new THREE.Vector3();
	for ( let waypoint = 0; waypoint < route.count; waypoint ++ ) {

		explorer.update(
			1 / 120,
			new THREE.Vector3( 0, 1, 0 ),
			pointAt( route, waypoint ),
			output,
		);
		const expectedSegment = waypoint >= route.count - 1
			? route.count - 1
			: Math.max( 0, waypoint );
		assert.equal( explorer.routeProgressIndex, expectedSegment );

	}
	assert.equal( explorer.destinationActive, false );
	assert.equal( explorer.destinationCompleted, true );
	assert.equal( explorer.routePositions, copiedPositions );
	assert.equal( explorer.routeNormals, copiedNormals );
	assert.equal( output.lengthSq(), 0 );

} );

test( 'CHAMELEON-LAB-NAVIGATION-003 opposite faces remain distinct through a wall traversal', async () => {

	await withEnvironment( ( environment ) => {

		const ground = entryByName( environment, 'RoughGround' );
		const wall = entryByName( environment, 'RoughBackWall' );
		const depth = wall.object.geometry.parameters.depth;
		const target = wall.object.localToWorld( new THREE.Vector3( 0, 1.4, -depth * 0.5 ) );
		const targetNormal = new THREE.Vector3( 0, 0, -1 )
			.transformDirection( wall.object.matrixWorld );
		const route = new SurfaceRoutePlanner( environment.navigation ).plan(
			new THREE.Vector3( 0, 0.25, -5 ),
			ground.collider,
			target,
			targetNormal,
			wall.collider,
		);
		assert.equal( route.reachable, true );
		assert.ok( route.count > 3, 'the rear face must not become a direct chord' );
		assert.ok( Array.from( route.kinds.subarray( 0, route.count ) ).includes( 2 ) );
		const finalOffset = ( route.count - 1 ) * 3;
		const finalNormal = new THREE.Vector3(
			route.normals[ finalOffset ],
			route.normals[ finalOffset + 1 ],
			route.normals[ finalOffset + 2 ],
		);
		assert.ok( finalNormal.dot( targetNormal ) > 0.999 );
		assert.ok( pointAt( route, route.count - 1 ).distanceTo( target ) < 1e-5 );

	} );

} );

test( 'CHAMELEON-LAB-NAVIGATION-004 leaving an irregular support returns through real graph edges', async () => {

	await withEnvironment( ( environment ) => {

		const ground = entryByName( environment, 'RoughGround' );
		const rock = entryByName( environment, 'SlopedRock' );
		const destination = new THREE.Vector3( 0, 0.16, 0.8 );
		const route = new SurfaceRoutePlanner( environment.navigation ).plan(
			rock.object.localToWorld( new THREE.Vector3( 0, 0.275, 0 ) ),
			rock.collider,
			destination,
			new THREE.Vector3( 0, 1, 0 ),
			ground.collider,
		);
		assert.equal( route.reachable, true );
		assert.ok( route.count > 2 );
		assert.ok( Array.from( route.kinds.subarray( 0, route.count ) ).includes( 2 ) );
		for ( let waypoint = 0; waypoint < route.count; waypoint ++ ) {

			const point = pointAt( route, waypoint );
			assert.ok( [ point.x, point.y, point.z ].every( Number.isFinite ) );

		}
		assert.ok( pointAt( route, route.count - 1 ).distanceTo( destination ) < 1e-5 );

	} );

} );

test( 'CHAMELEON-LAB-NAVIGATION-005 a portal waits for the expected support owner and normal', () => {

	const route = {
		positions: new Float32Array( [
			0, 0, 0,
			1, 0, 0,
			2, 0, 0,
		] ),
		normals: new Float32Array( [
			0, 1, 0,
			1, 0, 0,
			1, 0, 0,
		] ),
		kinds: new Uint8Array( [ 0, 2, 1 ] ),
		handles: new Float64Array( [ 11, 22, 22 ] ),
		patchIds: new Int16Array( [ 2, 0, 0 ] ),
		count: 3,
	};
	const explorer = new AutonomousExplorer();
	const output = new THREE.Vector3();
	explorer.heading.set( 1, 0, 0 );
	explorer.setDestination(
		new THREE.Vector3( 2, 0, 0 ),
		new THREE.Vector3( 1, 0, 0 ),
		new THREE.Vector3(),
		route,
	);
	explorer.update(
		1 / 120, new THREE.Vector3( 0, 1, 0 ),
		new THREE.Vector3(), output, 11,
	);
	assert.equal( explorer.routeIndex, 1 );
	explorer.update(
		1 / 120, new THREE.Vector3( 0, 1, 0 ),
		new THREE.Vector3( 1, 0, 0 ), output, 11,
	);
	assert.equal( explorer.routeIndex, 1,
		'distance cannot advance a transition while the former collider owns support' );
	explorer.update(
		1 / 120, new THREE.Vector3( 0, 1, 0 ),
		new THREE.Vector3( 1, 0, 0 ), output, 22,
	);
	assert.equal( explorer.routeIndex, 1,
		'the expected collider must also own the expected support frame' );
	explorer.update(
		1 / 120, new THREE.Vector3( 1, 0, 0 ),
		new THREE.Vector3( 1, 0, 0 ), output, 22,
	);
	assert.equal( explorer.routeIndex, 2 );

} );

test( 'CHAMELEON-LAB-NAVIGATION-010 an acquired transition portal tolerates the pelvis clearance offset', () => {

	const route = {
		positions: new Float32Array( [ 0, 0, 0, 1, 0, 0, 1, 1, 0 ] ),
		normals: new Float32Array( [ 0, 1, 0, 1, 0, 0, 1, 0, 0 ] ),
		kinds: new Uint8Array( [ 0, 2, 1 ] ),
		handles: new Float64Array( [ 11, 22, 22 ] ),
		patchIds: new Int16Array( [ 2, 0, 0 ] ),
		count: 3,
	};
	const explorer = new AutonomousExplorer();
	const output = new THREE.Vector3();
	explorer.heading.set( 1, 0, 0 );
	explorer.setDestination(
		new THREE.Vector3( 1, 1, 0 ), new THREE.Vector3( 1, 0, 0 ),
		new THREE.Vector3(), route,
	);
	explorer.update(
		1 / 120, new THREE.Vector3( 0, 1, 0 ),
		new THREE.Vector3(), output, 11,
	);
	assert.equal( explorer.routeIndex, 1 );
	explorer.update(
		1 / 120, new THREE.Vector3( 1, 0, 0 ),
		new THREE.Vector3( 0.2, 0, 0 ), output, 22,
	);
	assert.equal( explorer.routeIndex, 1,
		'a remote matching owner must not skip a physical hand-off' );
	explorer.update(
		1 / 120, new THREE.Vector3( 1, 0, 0 ),
		new THREE.Vector3( 0.35, 0, 0 ), output, 22,
	);
	assert.equal( explorer.routeIndex, 2,
		'an acquired owner and support frame must absorb the bounded pelvis offset' );

} );

test( 'CHAMELEON-LAB-NAVIGATION-011 support-normal alignment counts as portal progress', () => {

	const route = {
		positions: new Float32Array( [ 0, 0, 0, 1, 0, 0, 1, 1, 0 ] ),
		normals: new Float32Array( [ 0, 1, 0, 1, 0, 0, 1, 0, 0 ] ),
		kinds: new Uint8Array( [ 0, 2, 1 ] ),
		handles: new Float64Array( [ 11, 22, 22 ] ),
		patchIds: new Int16Array( [ 2, 0, 0 ] ),
		count: 3,
	};
	const explorer = new AutonomousExplorer();
	const position = new THREE.Vector3( 0.2, 0, 0 );
	const output = new THREE.Vector3();
	const supportNormal = new THREE.Vector3( 0, 1, 0 );
	explorer.heading.set( 1, 0, 0 );
	explorer.setDestination(
		new THREE.Vector3( 1, 1, 0 ), new THREE.Vector3( 1, 0, 0 ),
		new THREE.Vector3(), route,
	);
	explorer.update(
		1 / 120, new THREE.Vector3( 0, 1, 0 ),
		new THREE.Vector3(), output, 11,
	);
	assert.equal( explorer.routeIndex, 1 );
	explorer.resetProgress( position );
	for ( let tick = 0; tick < 180; tick ++ ) {

		const alignment = 0.78 * tick / 179;
		supportNormal.set(
			alignment,
			Math.sqrt( Math.max( 0, 1 - alignment * alignment ) ),
			0,
		);
		explorer.update( 1 / 120, supportNormal, position, output, 11 );

	}
	assert.equal( explorer.consumeReplanRequest(), false,
		'a monotone physical plane change must not trigger recovery' );
	for ( let tick = 0; tick < 180; tick ++ )
		explorer.update( 1 / 120, supportNormal, position, output, 11 );
	assert.equal( explorer.consumeReplanRequest(), true,
		'a plane change that subsequently stops must still be detected' );

} );

test( 'CHAMELEON-LAB-NAVIGATION-006 a source face remains stable at a box seam', async () => {

	await withEnvironment( ( environment ) => {

		const graph = environment.navigation;
		const wall = entryByName( environment, 'RoughBackWall' );
		const rearNormal = new THREE.Vector3( 0, 0, -1 )
			.transformDirection( wall.object.matrixWorld ).normalize();
		let source = -1;
		let sourceY = Infinity;
		for ( let node = 0; node < graph.nodeCount; node ++ ) {

			if ( graph.handles[ node ] !== wall.collider.handle ) continue;
			const offset = node * 3;
			const dot = graph.normals[ offset ] * rearNormal.x
				+ graph.normals[ offset + 1 ] * rearNormal.y
				+ graph.normals[ offset + 2 ] * rearNormal.z;
			if ( dot < 0.999 || graph.rawPositions[ offset + 1 ] >= sourceY ) continue;
			source = node;
			sourceY = graph.rawPositions[ offset + 1 ];

		}
		assert.ok( source >= 0 );
		const sourceOffset = source * 3;
		let target = -1;
		let targetDistance = Infinity;
		for ( let node = 0; node < graph.nodeCount; node ++ ) {

			if ( graph.handles[ node ] !== wall.collider.handle ) continue;
			const offset = node * 3;
			const dot = graph.normals[ offset ] * rearNormal.x
				+ graph.normals[ offset + 1 ] * rearNormal.y
				+ graph.normals[ offset + 2 ] * rearNormal.z;
			const height = graph.rawPositions[ offset + 1 ] - sourceY;
			if ( dot < 0.999 || height < 0.45 ) continue;
			const distance = Math.abs( graph.rawPositions[ offset ] - graph.rawPositions[ sourceOffset ] )
				+ Math.abs( graph.rawPositions[ offset + 2 ] - graph.rawPositions[ sourceOffset + 2 ] )
				+ height;
			if ( distance >= targetDistance ) continue;
			target = node;
			targetDistance = distance;

		}
		assert.ok( target >= 0 );
		const targetOffset = target * 3;
		const currentPosition = new THREE.Vector3().fromArray(
			graph.positions, sourceOffset,
		);
		const destination = new THREE.Vector3().fromArray(
			graph.rawPositions, targetOffset,
		);
		const planner = new SurfaceRoutePlanner( graph );
		const explicit = planner.plan(
			currentPosition, wall.collider, destination, rearNormal, wall.collider, rearNormal,
		);
		assert.equal( explicit.reachable, true,
			'an authored source normal must retain the rear face at the bottom seam' );
		const inferred = planner.plan(
			currentPosition, wall.collider, destination, rearNormal, wall.collider,
		);
		assert.equal( inferred.reachable, true,
			'clearance-space fallback must remain stable for the existing production call' );

	} );

} );

test( 'CHAMELEON-LAB-NAVIGATION-007 coincident semantic waypoints merge instead of rejecting a route', () => {

	let locateCalls = 0;
	const graph = Object.freeze( {
		positions: new Float32Array( [ 0, 0, 0, 0, 0, 0 ] ),
		rawPositions: new Float32Array( [ 0, 0, 0, 0, 0, 0 ] ),
		normals: new Float32Array( [ 0, 1, 0, 0, 1, 0 ] ),
		handles: new Float64Array( [ 11, 11 ] ),
		kinds: new Uint8Array( [ 1, 1 ] ),
		patchIds: new Int16Array( [ 0, 1 ] ),
		offsets: new Uint32Array( [ 0, 1, 2 ] ),
		edgeTo: new Uint32Array( [ 1, 0 ] ),
		edgeCost: new Float32Array( [ 0.001, 0.001 ] ),
		nodeCount: 2,
		locate() {

			return locateCalls ++ === 0 ? 0 : 1;

		},
		canShortcut() {

			return false;

		},
	} );
	const route = new SurfaceRoutePlanner( graph ).plan(
		new THREE.Vector3(), 11,
		new THREE.Vector3(), new THREE.Vector3( 0, 1, 0 ), 11,
	);
	assert.equal( route.reachable, true );
	assert.equal( route.count, 1 );
	assert.equal( route.nodeIds[ 0 ], 1 );
	assert.equal( route.patchIds[ 0 ], 1 );
	assert.equal( route.kinds[ 0 ], 2,
		'the merged point must retain its support-transition semantics' );

} );

test( 'CHAMELEON-LAB-NAVIGATION-008 planning without a physical source support is rejected', async () => {

	await withEnvironment( ( environment ) => {

		const ground = entryByName( environment, 'RoughGround' );
		const route = new SurfaceRoutePlanner( environment.navigation ).plan(
			new THREE.Vector3( 0, 2, 0 ),
			null,
			new THREE.Vector3( 2, 0, 2 ),
			new THREE.Vector3( 0, 1, 0 ),
			ground.collider,
		);
		assert.equal( route.reachable, false );
		assert.equal( route.count, 0 );
		assert.equal( route.expanded, 0 );

	} );

} );

test( 'CHAMELEON-LAB-NAVIGATION-009 an identical failed corridor is not replanned forever', () => {

	const route = {
		positions: new Float32Array( [ 0, 0, 0, 2, 0, 0 ] ),
		normals: new Float32Array( [ 0, 1, 0, 0, 1, 0 ] ),
		kinds: new Uint8Array( [ 0, 0 ] ),
		nodeIds: new Int32Array( [ 4, 5 ] ),
		handles: new Float64Array( [ 11, 11 ] ),
		patchIds: new Int16Array( [ 2, 2 ] ),
		count: 2,
	};
	const explorer = new AutonomousExplorer();
	const position = new THREE.Vector3();
	const output = new THREE.Vector3();
	const supportNormal = new THREE.Vector3( 0, 1, 0 );
	explorer.setDestination(
		new THREE.Vector3( 2, 0, 0 ), supportNormal, position, route,
	);
	for ( let tick = 0; tick < 220; tick ++ )
		explorer.update( 1 / 120, supportNormal, position, output, 11 );
	assert.equal( explorer.consumeReplanRequest(), true );
	explorer.setDestination(
		new THREE.Vector3( 2, 0, 0 ), supportNormal, position, route,
	);
	for ( let tick = 0; tick < 220; tick ++ )
		explorer.update( 1 / 120, supportNormal, position, output, 11 );
	assert.equal( explorer.consumeReplanRequest(), false,
		'the same failed node corridor must not trigger an unbounded A* loop' );

} );
