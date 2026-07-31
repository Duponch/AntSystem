import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createPhysicsWorld,
	DEFAULT_PHYSICS_FIXED_DT,
	DEFAULT_PHYSICS_MAX_SUBSTEPS,
	initializePhysicsWorld,
} from '../src/chameleon-lab/physics-world.js';

function finiteTransform( transform ) {

	return [
		transform.x, transform.y, transform.z,
		transform.qx, transform.qy, transform.qz, transform.qw,
	].every( Number.isFinite );

}

async function fallingWorld() {

	const physics = await createPhysicsWorld( {
		gravity: { x: 0, y: - 9.81, z: 0 },
	} );
	physics.addFixedCuboid( {
		position: { x: 0, y: - 0.5, z: 0 },
		halfExtents: { x: 8, y: 0.5, z: 8 },
		friction: 0.8,
		surface: 'terrain',
		userData: { supportId: 7 },
	} );
	const ball = physics.addDynamicBall( {
		position: { x: 0, y: 5, z: 0 },
		radius: 0.5,
		restitution: 0,
		canSleep: false,
		surface: 'chameleon-probe',
		userData: { entityId: 3 },
	} );
	return { physics, ball };

}

test( 'CHAMELEON-LAB-PHYSICS-001 explicit async init creates a bounded fixed-step world', async () => {

	const rapier = await initializePhysicsWorld();
	assert.equal( typeof rapier.World, 'function' );
	const physics = await createPhysicsWorld();
	assert.equal( physics.RAPIER, rapier );
	assert.equal( physics.fixedDt, DEFAULT_PHYSICS_FIXED_DT );
	assert.equal( physics.maxSubsteps, DEFAULT_PHYSICS_MAX_SUBSTEPS );
	assert.ok( Math.abs( physics.world.timestep - DEFAULT_PHYSICS_FIXED_DT ) < 1e-9 );
	assert.ok( Math.abs( physics.world.gravity.x ) < 1e-9 );
	assert.ok( Math.abs( physics.world.gravity.y + 9.81 ) < 1e-6 );
	assert.ok( Math.abs( physics.world.gravity.z ) < 1e-9 );
	physics.dispose();

} );

test( 'CHAMELEON-LAB-PHYSICS-002 a dynamic ball falls and settles on a fixed surface without NaN', async () => {

	const { physics, ball } = await fallingWorld();
	for ( let frame = 0; frame < 180; frame ++ ) physics.step( 1 / 60 );
	const translation = ball.body.translation();
	assert.ok( Math.abs( translation.y - 0.5 ) < 0.02, `unexpected settled y=${ translation.y }` );
	assert.ok( finiteTransform( ball.current ) );
	assert.equal( physics.stats.totalSteps, 360 );
	assert.equal( physics.stats.invalidBodies, 0 );
	assert.ok( Number.isFinite( physics.stats.lastStepMs ) && physics.stats.lastStepMs >= 0 );
	assert.ok( Number.isFinite( physics.stats.emaStepMs ) && physics.stats.emaStepMs >= 0 );
	assert.ok( Number.isFinite( physics.stats.p95StepMs ) && physics.stats.p95StepMs >= 0 );
	assert.equal( physics.stats.metricSamples, 360 );
	physics.dispose();

} );

test( 'CHAMELEON-LAB-PHYSICS-003 60 Hz and 240 Hz render partitions produce the same fixed simulation', async () => {

	const slow = await fallingWorld();
	const fast = await fallingWorld();
	for ( let frame = 0; frame < 120; frame ++ ) slow.physics.step( 1 / 60 );
	for ( let frame = 0; frame < 480; frame ++ ) fast.physics.step( 1 / 240 );

	assert.equal( slow.physics.stats.totalSteps, 240 );
	assert.equal( fast.physics.stats.totalSteps, 240 );
	const slowPosition = slow.ball.body.translation();
	const fastPosition = fast.ball.body.translation();
	const slowVelocity = slow.ball.body.linvel();
	const fastVelocity = fast.ball.body.linvel();
	for ( const [ actual, expected ] of [
		[ fastPosition.x, slowPosition.x ],
		[ fastPosition.y, slowPosition.y ],
		[ fastPosition.z, slowPosition.z ],
		[ fastVelocity.x, slowVelocity.x ],
		[ fastVelocity.y, slowVelocity.y ],
		[ fastVelocity.z, slowVelocity.z ],
	] ) assert.ok( Math.abs( actual - expected ) < 1e-7, `${ actual } != ${ expected }` );
	assert.equal( slow.physics.stats.totalDroppedSeconds, 0 );
	assert.equal( fast.physics.stats.totalDroppedSeconds, 0 );
	slow.physics.dispose();
	fast.physics.dispose();

} );

test( 'CHAMELEON-LAB-PHYSICS-004 catch-up is capped at four substeps and drops excess debt', async () => {

	const physics = await createPhysicsWorld( {
		gravity: { x: 0, y: 0, z: 0 },
	} );
	physics.addDynamicBall( { position: { x: 0, y: 1, z: 0 }, radius: 0.25 } );
	let beforeCalls = 0;
	let afterCalls = 0;
	const result = physics.step(
		1,
		( dt ) => {

			assert.equal( dt, DEFAULT_PHYSICS_FIXED_DT );
			beforeCalls ++;

		},
		( dt ) => {

			assert.equal( dt, DEFAULT_PHYSICS_FIXED_DT );
			afterCalls ++;

		},
	);
	assert.equal( result.steps, DEFAULT_PHYSICS_MAX_SUBSTEPS );
	assert.equal( beforeCalls, DEFAULT_PHYSICS_MAX_SUBSTEPS );
	assert.equal( afterCalls, DEFAULT_PHYSICS_MAX_SUBSTEPS );
	assert.equal( result.alpha, 0 );
	assert.ok( Math.abs(
		result.droppedSeconds
		- ( 1 - DEFAULT_PHYSICS_FIXED_DT * DEFAULT_PHYSICS_MAX_SUBSTEPS ),
	) < 1e-12 );
	const droppedSeconds = result.droppedSeconds;
	assert.equal( physics.step( 0 ).steps, 0, 'dropped debt must not leak into later frames' );
	assert.equal( physics.stats.totalSteps, DEFAULT_PHYSICS_MAX_SUBSTEPS );
	assert.equal( physics.stats.totalDroppedSeconds, droppedSeconds );
	physics.dispose();

} );

test( 'CHAMELEON-LAB-PHYSICS-005 helpers retain surface metadata and stable snapshots', async () => {

	const physics = await createPhysicsWorld();
	const floor = physics.addFixedCuboid( {
		x: 1, y: - 1, z: 2,
		hx: 3, hy: 0.5, hz: 4,
		surface: 'ground',
		userData: { biome: 'meadow' },
	} );
	const trunk = physics.addFixedCylinder( {
		position: { x: - 2, y: 1, z: 0 },
		halfHeight: 2,
		radius: 0.4,
		surface: 'bark',
	} );
	const ball = physics.addDynamicBall( {
		position: { x: 0, y: 3, z: 0 },
		radius: 0.3,
		surface: 'probe',
		userData: { owner: 'chameleon' },
	} );
	assert.deepEqual( floor.body.userData, {
		biome: 'meadow', surface: 'ground', shape: 'cuboid',
	} );
	assert.deepEqual( trunk.body.userData, { surface: 'bark', shape: 'cylinder' } );
	assert.deepEqual( ball.body.userData, {
		owner: 'chameleon', surface: 'probe', shape: 'ball',
	} );
	assert.equal( floor.trackMotion, false );
	assert.equal( trunk.trackMotion, false );
	assert.equal( ball.trackMotion, true );
	assert.equal( physics.stats.registeredBodies, 3 );

	const previousIdentity = ball.previous;
	const currentIdentity = ball.current;
	const interpolatedIdentity = ball.interpolated;
	const result = physics.step( DEFAULT_PHYSICS_FIXED_DT + DEFAULT_PHYSICS_FIXED_DT * 0.5 );
	assert.equal( result.steps, 1 );
	assert.ok( Math.abs( result.alpha - 0.5 ) < 1e-12 );
	assert.equal( ball.previous, previousIdentity );
	assert.equal( ball.current, currentIdentity );
	assert.equal( physics.getInterpolatedTransform( ball ), interpolatedIdentity );
	assert.ok( ball.current.y < ball.previous.y );
	assert.ok( ball.interpolated.y < ball.previous.y );
	assert.ok( ball.interpolated.y > ball.current.y );
	assert.ok( finiteTransform( ball.interpolated ) );

	physics.reset();
	assert.equal( ball.body.translation().y, 3 );
	assert.ok( Math.abs( ball.collider.translation().y - 3 ) < 1e-6 );
	assert.deepEqual( ball.current, ball.initial );
	assert.equal( physics.stats.totalSteps, 0 );
	physics.dispose();
	physics.dispose();
	assert.throws( () => physics.step( 0 ), /disposed/u );

} );

test( 'CHAMELEON-LAB-PHYSICS-006 invalid frame input fails before Rapier can receive NaN', async () => {

	const physics = await createPhysicsWorld();
	assert.throws( () => physics.step( Number.NaN ), /frameDt/u );
	assert.throws( () => physics.step( - 0.01 ), /non-negative/u );
	assert.throws( () => physics.addDynamicBall( { radius: Number.NaN } ), /radius/u );
	assert.equal( physics.stats.totalSteps, 0 );
	physics.dispose();

} );
