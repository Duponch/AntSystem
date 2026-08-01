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

test( 'CHAMELEON-LAB-NAVIGATION-001 diagonal perch routes through its grounded endpoint', async () => {

	await withEnvironment( ( environment ) => {

		const ground = entryByName( environment, 'RoughGround' );
		const diagonal = entryByName( environment, 'DiagonalPerch' );
		const planner = new SurfaceRoutePlanner( environment.navigation );
		const start = new THREE.Vector3( 0, 0.3, 0.75 );
		const destination = diagonal.object.position.clone();
		const plan = planner.plan(
			start, ground.collider, destination, new THREE.Vector3( 0, 1, 0 ), diagonal.collider,
		);
		assert.equal( plan.count, 2, 'ground access plus the clicked point are sufficient' );
		const access = pointAt( plan, 0 );
		assert.ok( access.y < 0.05, `diagonal lower endpoint must meet the ground, got y=${ access.y }` );
		assert.ok( access.distanceTo( destination ) > 2.5,
			'the route must not drive directly beneath the elevated branch centre' );
		assert.ok( pointAt( plan, plan.count - 1 ).distanceTo( destination ) < 1e-5 );

	} );

} );

test( 'CHAMELEON-LAB-NAVIGATION-002 horizontal perch uses both ends of the access ramp', async () => {

	await withEnvironment( ( environment ) => {

		const ground = entryByName( environment, 'RoughGround' );
		const horizontal = entryByName( environment, 'HorizontalPerch' );
		const ramp = entryByName( environment, 'PerchAccessRamp' );
		const planner = new SurfaceRoutePlanner( environment.navigation );
		const destination = horizontal.object.position.clone();
		const plan = planner.plan(
			new THREE.Vector3( 0, 0.3, 0.75 ),
			ground.collider,
			destination,
			new THREE.Vector3( 0, 1, 0 ),
			horizontal.collider,
		);
		assert.equal( plan.count, 3 );
		const lower = pointAt( plan, 0 );
		const upper = pointAt( plan, 1 );
		assert.ok( lower.y < 0.1, `ramp must begin at ground height, got ${ lower.y }` );
		assert.ok( upper.distanceTo( horizontal.object.position ) < 0.2,
			'ramp upper portal must overlap the horizontal perch' );
		assert.ok( upper.distanceTo( ramp.object.position ) > 1,
			'upper portal must be an endpoint, not the ramp centre' );
		assert.ok( pointAt( plan, 2 ).distanceTo( destination ) < 1e-5 );

	} );

} );

test( 'CHAMELEON-LAB-NAVIGATION-003 explorer copies a fixed route and advances without replacing hot-path storage', () => {

	const accessByCollider = new Map( [
		[ 1, { access: [] } ],
		[ 2, { access: [
			{ position: [ 1, 0, 0 ], normal: [ 0, 1, 0 ] },
			{ position: [ 2, 0, 0 ], normal: [ 0, 1, 0 ] },
		] } ],
	] );
	const planner = new SurfaceRoutePlanner( { accessByCollider, maximumWaypoints: 12 } );
	const destination = new THREE.Vector3( 3, 0, 0 );
	const route = planner.plan(
		new THREE.Vector3(), 1, destination, new THREE.Vector3( 0, 1, 0 ), 2,
	);
	const explorer = new AutonomousExplorer( 0x321 );
	explorer.heading.set( 1, 0, 0 );
	explorer.setDestination( destination, new THREE.Vector3( 0, 1, 0 ), new THREE.Vector3(), route );
	const positions = explorer.routePositions;
	const normals = explorer.routeNormals;
	const output = new THREE.Vector3();
	const position = new THREE.Vector3();
	for ( let waypoint = 0; waypoint < route.count; waypoint ++ ) {

		pointAt( route, waypoint, position );
		explorer.update( 1 / 120, new THREE.Vector3( 0, 1, 0 ), position, output );

	}
	assert.equal( explorer.destinationActive, false );
	assert.equal( explorer.destinationCompleted, true );
	assert.equal( explorer.routePositions, positions );
	assert.equal( explorer.routeNormals, normals );
	assert.equal( output.lengthSq(), 0 );

} );

test( 'CHAMELEON-LAB-NAVIGATION-004 sloped rock crosses face, lip and top in collider-local order', async () => {

	await withEnvironment( ( environment ) => {

		const ground = entryByName( environment, 'RoughGround' );
		const rock = entryByName( environment, 'SlopedRock' );
		const descriptor = environment.navigation.accessByCollider.get( rock.collider.handle );
		assert.deepEqual( descriptor.access.map( ( portal ) => portal.phase ), [ 'face', 'lip', 'top' ] );
		const inverseRotation = rock.object.getWorldQuaternion( new THREE.Quaternion() ).invert();
		const localPortalNormals = descriptor.access.map( ( portal ) => new THREE.Vector3()
			.fromArray( portal.normal ).applyQuaternion( inverseRotation ).normalize() );
		assert.ok( localPortalNormals[ 0 ].dot( new THREE.Vector3( 0, 0, 1 ) ) > 0.9999,
			'the face portal must retain the outward front-face normal' );
		assert.ok( localPortalNormals[ 1 ].dot( new THREE.Vector3( 0, 1, 1 ).normalize() ) > 0.9999,
			'the lip portal must blend the front and top support frames' );
		assert.ok( localPortalNormals[ 2 ].dot( new THREE.Vector3( 0, 1, 0 ) ) > 0.9999,
			'the top portal must finish in the upper support frame' );
		const planner = new SurfaceRoutePlanner( environment.navigation );
		const destination = rock.object.localToWorld( new THREE.Vector3( -0.8, 0.275, -0.45 ) );
		const topNormal = new THREE.Vector3( 0, 1, 0 ).transformDirection( rock.object.matrixWorld );
		const plan = planner.plan(
			new THREE.Vector3( 0, 0.3, 0.75 ),
			ground.collider,
			destination,
			topNormal,
			rock.collider,
		);
		assert.equal( plan.count, 4, 'three transition portals must precede the clicked point' );

		const inverse = rock.object.matrixWorld.clone().invert();
		const face = pointAt( plan, 0 ).applyMatrix4( inverse );
		const lip = pointAt( plan, 1 ).applyMatrix4( inverse );
		const top = pointAt( plan, 2 ).applyMatrix4( inverse );
		const depth = rock.object.geometry.parameters.depth;
		const height = rock.object.geometry.parameters.height;
		assert.ok( face.z > depth * 0.5,
			'the first portal must hold the body outside the front face' );
		assert.ok( lip.y > face.y + height * 0.65,
			'the lip portal must command a real climb instead of another ground approach' );
		assert.ok( top.z < lip.z - 0.4,
			'the upper portal must commit the body behind the lip' );
		assert.ok( top.y > height * 0.5,
			'the upper portal must preserve body clearance over the top face' );
		assert.ok( face.distanceTo( lip ) > 0.42 && lip.distanceTo( top ) > 0.42,
			'each transition must survive the explorer waypoint arrival radius' );
		assert.ok( Math.abs( face.y ) < height * 0.12,
			'the face portal must stay at the collider-local standing height' );
		assert.ok( pointAt( plan, 3 ).distanceTo( destination ) < 1e-5 );

	} );

} );

test( 'CHAMELEON-LAB-NAVIGATION-005 leaving sloped rock reverses the same stable portal chain', async () => {

	await withEnvironment( ( environment ) => {

		const ground = entryByName( environment, 'RoughGround' );
		const rock = entryByName( environment, 'SlopedRock' );
		const planner = new SurfaceRoutePlanner( environment.navigation );
		const destination = new THREE.Vector3( 0, 0.16, 0.8 );
		const plan = planner.plan(
			rock.object.position,
			rock.collider,
			destination,
			new THREE.Vector3( 0, 1, 0 ),
			ground.collider,
		);
		assert.equal( plan.count, 4 );
		const expected = [ ...environment.navigation.accessByCollider
			.get( rock.collider.handle ).access ].reverse();
		for ( let index = 0; index < expected.length; index ++ ) assert.ok(
			pointAt( plan, index ).distanceTo( new THREE.Vector3().fromArray( expected[ index ].position ) ) < 1e-5,
			`reversed portal ${ index } must be copied exactly`,
		);
		assert.ok( pointAt( plan, 3 ).distanceTo( destination ) < 1e-5 );

	} );

} );
