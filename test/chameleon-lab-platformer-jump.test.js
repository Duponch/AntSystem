import assert from 'node:assert/strict';
import test from 'node:test';

import {
	airControlAcceleration,
	JUMP_PHASE,
	PlatformerJumpModel,
	supportAwareJumpImpulse,
} from '../src/chameleon-lab/platformer-jump-model.js';

const EPSILON = 1e-9;
const BASE_INPUT = Object.freeze( {
	supported: true,
	supportNormal: Object.freeze( { x: 0, y: 1, z: 0 } ),
	worldUp: Object.freeze( { x: 0, y: 1, z: 0 } ),
	velocity: Object.freeze( { x: 0, y: 0, z: 0 } ),
	gravity: Object.freeze( { x: 0, y: - 10, z: 0 } ),
	mass: 2,
} );

function close( actual, expected, epsilon = EPSILON ) {

	assert.ok( Math.abs( actual - expected ) <= epsilon,
		`expected ${ expected }, received ${ actual }` );

}

test( 'PLATFORMER-JUMP-001 produces an exact height-derived floor impulse', () => {

	const launchDirection = { x: 0, y: 0, z: 0 };
	const impulse = supportAwareJumpImpulse( {
		...BASE_INPUT,
		jumpHeight: 0.8,
		riseGravityScale: 1,
	}, undefined, launchDirection );
	close( launchDirection.x, 0 );
	close( launchDirection.y, 1 );
	close( launchDirection.z, 0 );
	close( impulse.x, 0 );
	close( impulse.y, 2 * Math.sqrt( 16 ) );
	close( impulse.z, 0 );

} );

test( 'PLATFORMER-JUMP-002 wall launch combines support separation and world-up lift', () => {

	const direction = { x: 0, y: 0, z: 0 };
	const impulse = supportAwareJumpImpulse( {
		...BASE_INPUT,
		supportNormal: { x: 1, y: 0, z: 0 },
		jumpHeight: 0.5,
	}, undefined, direction );
	assert.ok( direction.x > 0.45 );
	assert.ok( direction.y > direction.x );
	close( direction.z, 0 );
	assert.ok( impulse.x > 0 );
	assert.ok( impulse.y > impulse.x );

} );

test( 'PLATFORMER-JUMP-018 inverted launch always separates from a ceiling', () => {

	const supportNormal = { x: 0, y: -1, z: 0 };
	const direction = { x: 0, y: 0, z: 0 };
	const impulse = supportAwareJumpImpulse( {
		...BASE_INPUT,
		supportNormal,
		jumpHeight: 0.72,
		forwardDirection: { x: 0, y: 0, z: -1 },
		forwardSpeed: 1,
	}, undefined, direction );
	const separationImpulse = impulse.x * supportNormal.x
		+ impulse.y * supportNormal.y + impulse.z * supportNormal.z;
	const separationDirection = direction.x * supportNormal.x
		+ direction.y * supportNormal.y + direction.z * supportNormal.z;
	assert.ok( separationImpulse > 0.1,
		`ceiling impulse points into its support: ${ separationImpulse }` );
	assert.ok( separationDirection > 0.1,
		`ceiling launch direction points into its support: ${ separationDirection }` );
	assert.ok( impulse.y < 0, 'an inverted take-off must move away from the ceiling' );

} );

test( 'PLATFORMER-JUMP-003 coyote time accepts a late press and rejects an expired one', () => {

	const accepted = new PlatformerJumpModel( { coyoteTime: 0.12 } );
	accepted.reset( true );
	accepted.update( 0.08, { ...BASE_INPUT, supported: false } );
	let late = accepted.update( 0.02, {
		...BASE_INPUT,
		supported: false,
		jumpPressed: true,
		jumpReleased: true,
	} );
	for ( let step = 0; step < 8 && ! late.jumped; step ++ ) late = accepted.update(
		1 / 120, { ...BASE_INPUT, supported: false },
	);
	assert.equal( late.jumped, true );
	assert.equal( late.phase, JUMP_PHASE.TAKEOFF );

	const rejected = new PlatformerJumpModel( { coyoteTime: 0.12 } );
	rejected.reset( true );
	rejected.update( 0.08, { ...BASE_INPUT, supported: false } );
	rejected.update( 0.06, { ...BASE_INPUT, supported: false } );
	const tooLate = rejected.update( 1 / 120, {
		...BASE_INPUT,
		supported: false,
		jumpPressed: true,
		jumpReleased: true,
	} );
	assert.equal( tooLate.jumped, false );
	assert.ok( tooLate.bufferRemaining > 0 );

} );

test( 'PLATFORMER-JUMP-004 jump buffering fires on the first supported step', () => {

	const jump = new PlatformerJumpModel( { bufferTime: 0.15 } );
	jump.reset( false );
	const queued = jump.update( 0.05, {
		...BASE_INPUT,
		supported: false,
		velocity: { x: 0, y: - 1, z: 0 },
		jumpPressed: true,
		jumpReleased: true,
	} );
	assert.equal( queued.jumped, false );
	assert.ok( queued.bufferRemaining > 0.09 );
	const landed = jump.update( 0.05, {
		...BASE_INPUT,
		supported: true,
		velocity: { x: 0, y: - 1, z: 0 },
	} );
	assert.equal( landed.jumped, true );
	assert.equal( landed.bufferRemaining, 0 );
	assert.equal( landed.releaseSupport, true );

} );

test( 'PLATFORMER-JUMP-005 held, cut, apex and falling phases shape gravity independently', () => {

	const jump = new PlatformerJumpModel( {
		riseGravityScale: 0.9,
		cutGravityScale: 2.1,
		apexGravityScale: 0.65,
		fallGravityScale: 1.5,
	} );
	jump.reset( false );
	let view = jump.update( 1 / 120, {
		...BASE_INPUT,
		supported: false,
		velocity: { x: 0, y: 2, z: 0 },
		jumpHeld: true,
	} );
	assert.equal( view.phase, JUMP_PHASE.RISING );
	close( view.gravityScale, 0.9 );
	view = jump.update( 1 / 120, {
		...BASE_INPUT,
		supported: false,
		velocity: { x: 0, y: 2, z: 0 },
		jumpReleased: true,
	} );
	close( view.gravityScale, 2.1 );
	view = jump.update( 1 / 120, {
		...BASE_INPUT,
		supported: false,
		velocity: { x: 0, y: 0.1, z: 0 },
	} );
	assert.equal( view.phase, JUMP_PHASE.APEX );
	close( view.gravityScale, 0.65 );
	view = jump.update( 1 / 120, {
		...BASE_INPUT,
		supported: false,
		velocity: { x: 0, y: - 2, z: 0 },
	} );
	assert.equal( view.phase, JUMP_PHASE.FALLING );
	close( view.gravityScale, 1.5 );
	close( view.additionalGravity.y, - 5 );

} );

test( 'PLATFORMER-JUMP-006 air control is tangent, speed-aware and acceleration-bounded', () => {

	const acceleration = airControlAcceleration( {
		velocity: { x: - 8, y: 20, z: 3 },
		desiredDirection: { x: 1, y: 0.8, z: 0 },
		worldUp: { x: 0, y: 1, z: 0 },
		maximumSpeed: 4,
		acceleration: 2.5,
	} );
	close( acceleration.y, 0 );
	close( Math.hypot( acceleration.x, acceleration.y, acceleration.z ), 2.5 );
	assert.ok( acceleration.x > 0 );

} );

test( 'PLATFORMER-JUMP-007 landing exposes one decaying suspension compression envelope', () => {

	const jump = new PlatformerJumpModel( { landingDuration: 0.2, landingImpactSpeed: 4 } );
	jump.reset( false );
	jump.update( 0.1, {
		...BASE_INPUT,
		supported: false,
		velocity: { x: 0, y: - 3, z: 0 },
	} );
	const landing = jump.update( 0, {
		...BASE_INPUT,
		supported: true,
		velocity: { x: 0, y: - 2, z: 0 },
	} );
	assert.equal( landing.phase, JUMP_PHASE.LANDING );
	close( landing.landingImpact, 0.75 );
	close( landing.landingCompression, 0.75 );
	const settling = jump.update( 0.1, BASE_INPUT );
	assert.equal( settling.phase, JUMP_PHASE.LANDING );
	close( settling.landingCompression, 0.1875 );
	const grounded = jump.update( 0.1, BASE_INPUT );
	assert.equal( grounded.phase, JUMP_PHASE.GROUNDED );
	close( grounded.landingCompression, 0 );

} );

test( 'PLATFORMER-JUMP-008 one press cannot retrigger while takeoff contacts linger', () => {

	const jump = new PlatformerJumpModel( { detachTime: 0.09 } );
	jump.reset( true );
	let takeoff = jump.update( 1 / 120, {
		...BASE_INPUT,
		jumpPressed: true,
		jumpReleased: true,
	} );
	assert.equal( takeoff.phase, JUMP_PHASE.PRELOAD );
	for ( let step = 0; step < 8 && ! takeoff.jumped; step ++ )
		takeoff = jump.update( 1 / 120, BASE_INPUT );
	assert.equal( takeoff.jumped, true );
	for ( let index = 0; index < 8; index ++ ) {

		const view = jump.update( 1 / 120, {
			...BASE_INPUT,
			supported: true,
			jumpHeld: true,
		} );
		assert.equal( view.jumped, false );
		assert.equal( view.releaseSupport, true );

	}

} );

test( 'PLATFORMER-JUMP-009 update reuses all hot-path output records', () => {

	const jump = new PlatformerJumpModel();
	const first = jump.update( 1 / 120, { ...BASE_INPUT, jumpPressed: true } );
	const impulse = first.impulse;
	const gravity = first.additionalGravity;
	const air = first.airAcceleration;
	const second = jump.update( 1 / 120, { ...BASE_INPUT, supported: false } );
	assert.equal( second, first );
	assert.equal( second.impulse, impulse );
	assert.equal( second.additionalGravity, gravity );
	assert.equal( second.airAcceleration, air );

} );

test( 'PLATFORMER-JUMP-010 long fixed-step runs preserve every hot-path record', () => {

	const jump = new PlatformerJumpModel();
	const references = [
		jump.view,
		jump.lastSupportNormal,
		jump.worldUp,
		jump.impulse,
		jump.launchDirection,
		jump.additionalGravity,
		jump.airAccelerationVector,
		jump._impulseScratch,
		jump._impulseScratch.up,
		jump._impulseScratch.support,
		jump._impulseScratch.lift,
		jump._impulseScratch.forward,
		jump._impulseInput,
		jump._airScratch,
		jump._airScratch.up,
		jump._airScratch.tangentVelocity,
		jump._airScratch.desired,
		jump._airInput,
	];
	const supportNormal = { x: 0, y: 1, z: 0 };
	const velocity = { x: 0, y: 0, z: 0 };
	const desiredDirection = { x: 0, y: 0, z: -1 };
	const input = {
		supported: true,
		supportNormal,
		worldUp: { x: 0, y: 1, z: 0 },
		velocity,
		gravity: { x: 0, y: -9.81, z: 0 },
		mass: 1,
		jumpPressed: false,
		jumpHeld: false,
		jumpReleased: false,
		desiredDirection,
	};
	for ( let frame = 0; frame < 25_000; frame ++ ) {

		const cycle = frame % 360;
		input.supported = cycle < 120;
		input.jumpPressed = cycle === 20;
		input.jumpHeld = cycle >= 20 && cycle < 60;
		input.jumpReleased = cycle === 60;
		velocity.y = input.supported ? 0 : Math.sin( cycle * 0.03 ) * 2;
		desiredDirection.x = Math.sin( frame * 0.007 );
		desiredDirection.z = - Math.cos( frame * 0.007 );
		assert.equal( jump.update( 1 / 120, input ), references[ 0 ] );

	}
	const current = [
		jump.view,
		jump.lastSupportNormal,
		jump.worldUp,
		jump.impulse,
		jump.launchDirection,
		jump.additionalGravity,
		jump.airAccelerationVector,
		jump._impulseScratch,
		jump._impulseScratch.up,
		jump._impulseScratch.support,
		jump._impulseScratch.lift,
		jump._impulseScratch.forward,
		jump._impulseInput,
		jump._airScratch,
		jump._airScratch.up,
		jump._airScratch.tangentVelocity,
		jump._airScratch.desired,
		jump._airInput,
	];
	for ( let index = 0; index < references.length; index ++ )
		assert.equal( current[ index ], references[ index ], `hot-path record ${ index } was replaced` );

} );

function simulatedApex( holdSeconds ) {

	const fixedDt = 1 / 120;
	const gravity = { x: 0, y: -9.81, z: 0 };
	const velocity = { x: 0, y: 0, z: 0 };
	const jump = new PlatformerJumpModel( { jumpHeight: 0.72 } );
	jump.reset( true );
	let height = 0;
	let apex = 0;
	let released = false;
	let launched = false;
	for ( let step = 0; step < 360; step ++ ) {

		const elapsed = step * fixedDt;
		const shouldRelease = ! released && elapsed >= holdSeconds;
		const view = jump.update( fixedDt, {
			...BASE_INPUT,
			supported: ! launched,
			velocity,
			gravity,
			mass: 1,
			jumpPressed: step === 0,
			jumpHeld: ! released && ! shouldRelease,
			jumpReleased: shouldRelease,
		} );
		if ( shouldRelease ) released = true;
		if ( view.jumped ) {

			velocity.y += view.impulse.y;
			launched = true;

		}
		if ( launched ) {

			velocity.y += ( gravity.y + view.additionalGravity.y ) * fixedDt;
			height += velocity.y * fixedDt;

		}
		apex = Math.max( apex, height );
		if ( step > 2 && velocity.y < 0 && height < 0 ) break;

	}
	return apex;

}

test( 'PLATFORMER-JUMP-011 preloading Space produces a strictly higher physical apex', () => {

	const tapApex = simulatedApex( 0.035 );
	const mediumApex = simulatedApex( 0.18 );
	const heldApex = simulatedApex( 0.5 );
	assert.ok( tapApex > 0.1, `tap apex is too small: ${ tapApex }` );
	assert.ok( mediumApex > tapApex + 0.08,
		`medium hold ${ mediumApex } did not exceed tap ${ tapApex }` );
	assert.ok( heldApex > mediumApex + 0.02,
		`long hold ${ heldApex } did not exceed medium ${ mediumApex }` );
	assert.ok( heldApex <= 0.78, `held apex exceeded its bounded target: ${ heldApex }` );

} );

function chargeAndRelease( partitions, options = {} ) {

	const jump = new PlatformerJumpModel( options.model );
	jump.reset( true );
	const input = {
		...BASE_INPUT,
		bodyForward: { x: 0, y: 0, z: -1 },
		desiredDirection: { x: 0, y: 0, z: 0 },
		sprint: Boolean( options.sprint ),
		jumpHeld: true,
	};
	let view = jump.update( partitions[ 0 ], { ...input, jumpPressed: true } );
	let launch = null;
	if ( view.jumped ) launch = {

		jumped: view.jumped,
		phase: view.phase,
		charge: view.charge,
		targetJumpHeight: view.targetJumpHeight,
		targetForwardSpeed: view.targetForwardSpeed,

	};
	for ( let index = 1; index < partitions.length && ! launch; index ++ ) {

		view = jump.update( partitions[ index ], input );
		if ( view.jumped ) launch = {

			jumped: view.jumped,
			phase: view.phase,
			charge: view.charge,
			targetJumpHeight: view.targetJumpHeight,
			targetForwardSpeed: view.targetForwardSpeed,

		};

	}
	if ( ! launch ) {

		view = jump.update( 0, {
			...input,
			jumpHeld: false,
			jumpReleased: true,
		} );
		for ( let step = 0; step < 16 && ! view.jumped; step ++ ) view = jump.update(
			1 / 120, { ...input, jumpHeld: false },
		);
		launch = {

			jumped: view.jumped,
			phase: view.phase,
			charge: view.charge,
			targetJumpHeight: view.targetJumpHeight,
			targetForwardSpeed: view.targetForwardSpeed,

		};

	}
	return {
		view: launch,
		impulse: { ...view.impulse },
		direction: { ...view.launchDirection },
	};

}

test( 'PLATFORMER-JUMP-012 held input exposes a smooth PRELOAD pose before take-off', () => {

	const jump = new PlatformerJumpModel( { maximumChargeTime: 0.2 } );
	jump.reset( true );
	const first = jump.update( 0.02, {
		...BASE_INPUT,
		jumpPressed: true,
		jumpHeld: true,
	} );
	assert.equal( first.phase, JUMP_PHASE.PRELOAD );
	assert.equal( first.charging, true );
	assert.equal( first.jumped, false );
	assert.equal( first.releaseSupport, false );
	assert.ok( first.preloadCompression >= 0.18 );
	const firstCharge = first.charge;
	const firstCompression = first.preloadCompression;
	const deeper = jump.update( 0.08, { ...BASE_INPUT, jumpHeld: true } );
	assert.ok( deeper.charge > firstCharge );
	assert.ok( deeper.preloadCompression > firstCompression );
	assert.ok( deeper.forwardLean > 0.12 );
	assert.equal( deeper.muscleCompliance, 0.04 );

} );

test( 'PLATFORMER-JUMP-013 release converts charge into continuous lift and anatomical forward range', () => {

	const short = chargeAndRelease( [ 0.02 ] );
	const medium = chargeAndRelease( [ 0.05, 0.05, 0.04 ] );
	const long = chargeAndRelease( [ 0.05, 0.05, 0.05, 0.05, 0.02 ] );
	for ( const result of [ short, medium, long ] ) {

		assert.equal( result.view.jumped, true );
		assert.equal( result.view.phase, JUMP_PHASE.TAKEOFF );
		assert.ok( result.impulse.y > 0 );
		assert.ok( result.impulse.z < 0 );

	}
	assert.ok( medium.impulse.y > short.impulse.y );
	assert.ok( long.impulse.y > medium.impulse.y );
	assert.ok( Math.abs( medium.impulse.z ) > Math.abs( short.impulse.z ) );
	assert.ok( Math.abs( long.impulse.z ) > Math.abs( medium.impulse.z ) );
	assert.ok( long.view.targetJumpHeight > short.view.targetJumpHeight );
	assert.ok( long.view.targetForwardSpeed > short.view.targetForwardSpeed );

} );

test( 'PLATFORMER-JUMP-014 charge result is invariant to fixed-step partitioning', () => {

	const coarse = chargeAndRelease( [ 0.04, 0.04, 0.04, 0.04, 0.02 ] );
	const fine = chargeAndRelease( new Array( 18 ).fill( 0.01 ) );
	close( coarse.view.charge, fine.view.charge, 1e-12 );
	close( coarse.view.targetJumpHeight, fine.view.targetJumpHeight, 1e-12 );
	close( coarse.view.targetForwardSpeed, fine.view.targetForwardSpeed, 1e-12 );
	close( coarse.impulse.x, fine.impulse.x, 1e-12 );
	close( coarse.impulse.y, fine.impulse.y, 1e-12 );
	close( coarse.impulse.z, fine.impulse.z, 1e-12 );

} );

test( 'PLATFORMER-JUMP-015 sprint amplifies range without changing charged height', () => {

	const normal = chargeAndRelease( [ 0.05, 0.05, 0.05 ], { sprint: false } );
	const sprint = chargeAndRelease( [ 0.05, 0.05, 0.05 ], { sprint: true } );
	close( sprint.impulse.y, normal.impulse.y );
	assert.ok( Math.abs( sprint.impulse.z ) > Math.abs( normal.impulse.z ) * 1.3 );
	close( sprint.view.targetJumpHeight, normal.view.targetJumpHeight );
	assert.ok( sprint.view.targetForwardSpeed > normal.view.targetForwardSpeed );

} );

test( 'PLATFORMER-JUMP-016 maximum charge auto-launches and exposes aerial ragdoll envelopes', () => {

	const jump = new PlatformerJumpModel( { maximumChargeTime: 0.1 } );
	jump.reset( true );
	let view = jump.update( 0.04, {
		...BASE_INPUT,
		jumpPressed: true,
		jumpHeld: true,
		bodyForward: { x: 0, y: 0, z: -1 },
	} );
	assert.equal( view.phase, JUMP_PHASE.PRELOAD );
	view = jump.update( 0.06, {
		...BASE_INPUT,
		jumpHeld: true,
		bodyForward: { x: 0, y: 0, z: -1 },
	} );
	assert.equal( view.jumped, true );
	close( view.charge, 1 );
	close( view.preloadCompression, 0 );
	assert.ok( view.takeoffExtension > 0.99 );
	assert.ok( view.forwardLean > 0.4 );
	assert.ok( view.muscleCompliance > 0 );

	view = jump.update( 0.05, {
		...BASE_INPUT,
		supported: false,
		velocity: { x: 0, y: 1.2, z: -1 },
	} );
	assert.equal( view.phase, JUMP_PHASE.TAKEOFF );
	assert.ok( view.takeoffExtension > 0 );
	assert.ok( view.muscleCompliance > 0 );
	jump.update( 0.1, {
		...BASE_INPUT,
		supported: false,
		velocity: { x: 0, y: 0.4, z: -1 },
	} );
	view = jump.update( 0.02, {
		...BASE_INPUT,
		supported: false,
		velocity: { x: 0, y: 0.1, z: -1 },
	} );
	assert.equal( view.phase, JUMP_PHASE.APEX );
	close( view.airborneTuck, 0.58 );
	assert.ok( view.muscleCompliance > 0.3 );

} );

test( 'PLATFORMER-JUMP-017 buffered held input preloads on landing then launches on release', () => {

	const jump = new PlatformerJumpModel( { bufferTime: 0.18 } );
	jump.reset( false );
	let view = jump.update( 0.05, {
		...BASE_INPUT,
		supported: false,
		jumpPressed: true,
		jumpHeld: true,
	} );
	assert.equal( view.jumped, false );
	view = jump.update( 0.04, {
		...BASE_INPUT,
		jumpHeld: true,
	} );
	assert.equal( view.phase, JUMP_PHASE.PRELOAD );
	assert.equal( view.charging, true );
	view = jump.update( 0.03, {
		...BASE_INPUT,
		jumpReleased: true,
	} );
	assert.equal( view.jumped, true );
	assert.equal( view.phase, JUMP_PHASE.TAKEOFF );

} );

test( 'PLATFORMER-JUMP-019 a complete tap retains a visible preload before launch', () => {

	const jump = new PlatformerJumpModel( { minimumPreloadTime: 0.045 } );
	jump.reset( true );
	let view = jump.update( 1 / 120, {
		...BASE_INPUT,
		jumpPressed: true,
		jumpReleased: true,
		bodyForward: { x: 0, y: 0, z: -1 },
	} );
	assert.equal( view.jumped, false );
	assert.equal( view.phase, JUMP_PHASE.PRELOAD );
	assert.ok( view.preloadCompression >= 0.18 );
	let preloadSteps = 1;
	for ( ; preloadSteps < 16 && ! view.jumped; preloadSteps ++ ) view = jump.update(
		1 / 120, { ...BASE_INPUT, bodyForward: { x: 0, y: 0, z: -1 } },
	);
	assert.equal( view.jumped, true );
	assert.ok( preloadSteps >= 5, `tap launched before its visible preload (${ preloadSteps } steps)` );
	assert.ok( view.impulse.y > 0 );
	assert.ok( view.impulse.z < 0 );

} );

test( 'PLATFORMER-JUMP-020 an accepted held coyote jump can never disappear', () => {

	const jump = new PlatformerJumpModel( {
		coyoteTime: 0.12,
		maximumChargeTime: 0.22,
		minimumPreloadTime: 0.045,
	} );
	jump.reset( true );
	jump.update( 0.08, { ...BASE_INPUT, supported: false } );
	let view = jump.update( 1 / 120, {
		...BASE_INPUT,
		supported: false,
		jumpPressed: true,
		jumpHeld: true,
		bodyForward: { x: 0, y: 0, z: -1 },
	} );
	let launches = view.jumped ? 1 : 0;
	for ( let step = 0; step < 40; step ++ ) {

		view = jump.update( 1 / 120, {
			...BASE_INPUT,
			supported: false,
			jumpHeld: true,
			bodyForward: { x: 0, y: 0, z: -1 },
		} );
		if ( view.jumped ) launches ++;

	}
	assert.equal( launches, 1, 'the accepted coyote press was lost or retriggered' );
	assert.ok( jump.launchCharge > 0, 'coyote charge did not contribute to take-off' );
	assert.equal( jump.charging, false );

} );

test( 'PLATFORMER-JUMP-021 landing compression remembers the fastest airborne descent', () => {

	const jump = new PlatformerJumpModel( { landingImpactSpeed: 4 } );
	jump.reset( false );
	jump.update( 1 / 120, {
		...BASE_INPUT,
		supported: false,
		velocity: { x: 0, y: -3.2, z: 0 },
	} );
	jump.update( 1 / 120, {
		...BASE_INPUT,
		supported: false,
		velocity: { x: 0, y: -1.1, z: 0 },
	} );
	const landed = jump.update( 1 / 120, {
		...BASE_INPUT,
		supported: true,
		velocity: { x: 0, y: 0, z: 0 },
	} );
	close( landed.landingImpact, 0.8 );
	assert.ok( landed.landingCompression > 0.6 );

} );
