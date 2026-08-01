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

test( 'PLATFORMER-JUMP-003 coyote time accepts a late press and rejects an expired one', () => {

	const accepted = new PlatformerJumpModel( { coyoteTime: 0.12 } );
	accepted.reset( true );
	accepted.update( 0.08, { ...BASE_INPUT, supported: false } );
	const late = accepted.update( 0.02, {
		...BASE_INPUT,
		supported: false,
		jumpPressed: true,
		jumpHeld: true,
	} );
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
		jumpHeld: true,
	} );
	assert.equal( queued.jumped, false );
	assert.ok( queued.bufferRemaining > 0.09 );
	const landed = jump.update( 0.05, {
		...BASE_INPUT,
		supported: true,
		velocity: { x: 0, y: - 1, z: 0 },
		jumpHeld: true,
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
	close( landing.landingImpact, 0.5 );
	close( landing.landingCompression, 0.5 );
	const settling = jump.update( 0.1, BASE_INPUT );
	assert.equal( settling.phase, JUMP_PHASE.LANDING );
	close( settling.landingCompression, 0.125 );
	const grounded = jump.update( 0.1, BASE_INPUT );
	assert.equal( grounded.phase, JUMP_PHASE.GROUNDED );
	close( grounded.landingCompression, 0 );

} );

test( 'PLATFORMER-JUMP-008 one press cannot retrigger while takeoff contacts linger', () => {

	const jump = new PlatformerJumpModel( { detachTime: 0.09 } );
	jump.reset( true );
	const takeoff = jump.update( 1 / 120, {
		...BASE_INPUT,
		jumpPressed: true,
		jumpHeld: true,
	} );
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
	for ( let step = 0; step < 360; step ++ ) {

		const elapsed = step * fixedDt;
		const shouldRelease = ! released && elapsed >= holdSeconds;
		const view = jump.update( fixedDt, {
			...BASE_INPUT,
			supported: step === 0,
			velocity,
			gravity,
			mass: 1,
			jumpPressed: step === 0,
			jumpHeld: ! released && ! shouldRelease,
			jumpReleased: shouldRelease,
		} );
		if ( shouldRelease ) released = true;
		if ( view.jumped ) velocity.y += view.impulse.y;
		velocity.y += ( gravity.y + view.additionalGravity.y ) * fixedDt;
		height += velocity.y * fixedDt;
		apex = Math.max( apex, height );
		if ( step > 2 && velocity.y < 0 && height < 0 ) break;

	}
	return apex;

}

test( 'PLATFORMER-JUMP-011 holding Space produces a strictly higher physical apex', () => {

	const tapApex = simulatedApex( 0.035 );
	const mediumApex = simulatedApex( 0.18 );
	const heldApex = simulatedApex( 0.5 );
	assert.ok( tapApex > 0.1, `tap apex is too small: ${ tapApex }` );
	assert.ok( mediumApex > tapApex + 0.08,
		`medium hold ${ mediumApex } did not exceed tap ${ tapApex }` );
	assert.ok( heldApex > mediumApex + 0.08,
		`long hold ${ heldApex } did not exceed medium ${ mediumApex }` );
	assert.ok( heldApex <= 0.78, `held apex exceeded its bounded target: ${ heldApex }` );

} );
