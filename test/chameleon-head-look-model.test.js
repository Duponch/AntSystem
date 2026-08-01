import assert from 'node:assert/strict';
import test from 'node:test';

import {
	CHAMELEON_HEAD_LOOK,
	CHAMELEON_HEAD_LOOK_SIZE,
	ChameleonHeadLookModel,
} from '../src/chameleon-head-look-model.js';

function sumYaw( pose ) {

	return pose[ CHAMELEON_HEAD_LOOK.NECK_YAW ]
		+ pose[ CHAMELEON_HEAD_LOOK.HEAD_YAW ];

}

function sumPitch( pose ) {

	return pose[ CHAMELEON_HEAD_LOOK.NECK_PITCH ]
		+ pose[ CHAMELEON_HEAD_LOOK.HEAD_PITCH ];

}

function advance( model, seconds, dt = 1 / 120 ) {

	const frames = Math.round( seconds / dt );
	for ( let frame = 0; frame < frames; frame ++ ) model.updateFixed( dt );
	return model.getView().current;

}

test( 'CHAMELEON-HEAD-LOOK-001 idle uses deterministic irregular fixations and held micro poses', () => {

	const first = new ChameleonHeadLookModel( { seed: 0x12345678 } );
	const second = new ChameleonHeadLookModel( { seed: 0x12345678 } );
	const previousTarget = new Float32Array( CHAMELEON_HEAD_LOOK_SIZE );
	previousTarget.fill( NaN );
	let heldTicks = 0;
	let longestHold = 0;
	let previousFixation = first.getView().fixationIndex;
	let fixationStart = 0;
	const durations = [];
	for ( let tick = 0; tick < 1_440; tick ++ ) {

		const a = first.updateFixed( 1 / 120 );
		const b = second.updateFixed( 1 / 120 );
		assert.deepEqual( a.current, b.current );
		assert.deepEqual( a.target, b.target );
		if ( a.target.every( ( value, index ) => value === previousTarget[ index ] ) ) heldTicks ++;
		else {

			longestHold = Math.max( longestHold, heldTicks );
			heldTicks = 0;
			previousTarget.set( a.target );

		}
		if ( a.fixationIndex !== previousFixation ) {

			durations.push( ( tick - fixationStart ) / 120 );
			fixationStart = tick;
			previousFixation = a.fixationIndex;

		}

	}
	assert.ok( longestHold >= 20, `idle never held a pose (${ longestHold } ticks)` );
	assert.ok( durations.length >= 4, `only ${ durations.length } fixation changes` );
	assert.ok( new Set( durations.map( ( value ) => value.toFixed( 2 ) ) ).size >= 3,
		`fixation dwell became regular: ${ durations.join( ', ' ) }` );
	assert.ok( Math.abs( sumYaw( first.getView().current ) ) > 0.025 );

} );

test( 'CHAMELEON-HEAD-LOOK-002 explicit weighted targets are split across bounded neck and skull', () => {

	const model = new ChameleonHeadLookModel( { seed: 7 } ).setIdleWeight( 0 );
	model.setTarget( 10, -10, 1 );
	advance( model, 2 );
	const view = model.getView();
	const pose = view.current;
	assert.ok( Math.abs( pose[ CHAMELEON_HEAD_LOOK.NECK_YAW ] ) <= 0.72 + 1e-6 );
	assert.ok( Math.abs( pose[ CHAMELEON_HEAD_LOOK.HEAD_YAW ] ) <= 0.55 + 1e-6 );
	assert.ok( pose[ CHAMELEON_HEAD_LOOK.NECK_PITCH ] >= -0.34 - 1e-6 );
	assert.ok( pose[ CHAMELEON_HEAD_LOOK.HEAD_PITCH ] >= -0.26 - 1e-6 );
	assert.ok( Math.abs( sumYaw( pose ) - 1.27 ) < 1e-4 );
	assert.ok( Math.abs( sumPitch( pose ) + 0.60 ) < 1e-4 );
	assert.ok( Math.abs( pose[ CHAMELEON_HEAD_LOOK.TARGET_WEIGHT ] - 1 ) < 1e-5 );

	model.reset( 7 );
	model.setIdleWeight( 0 ).setTarget( 0.8, 0.3, 0.5 );
	model.updateFixed( 0 );
	assert.ok( Math.abs( sumYaw( model.getView().target ) - 0.4 ) < 1e-6 );
	assert.ok( Math.abs( sumPitch( model.getView().target ) - 0.15 ) < 1e-6 );

} );

test( 'CHAMELEON-HEAD-LOOK-003 critical response is smooth and returns progressively to idle', () => {

	const model = new ChameleonHeadLookModel().setIdleWeight( 0 ).setTarget( 0.72, 0.18, 1 );
	let previous = 0;
	let maximumStep = 0;
	for ( let tick = 0; tick < 180; tick ++ ) {

		model.updateFixed( 1 / 120 );
		const value = sumYaw( model.getView().current );
		maximumStep = Math.max( maximumStep, Math.abs( value - previous ) );
		previous = value;

	}
	assert.ok( maximumStep < 0.06, `angular snap ${ maximumStep }` );
	const acquired = sumYaw( model.getView().current );
	assert.ok( acquired > 0.70 );
	model.clearTarget();
	model.updateFixed( 1 / 120 );
	const firstRelease = sumYaw( model.getView().current );
	assert.ok( firstRelease > acquired * 0.95, 'clearTarget snapped back to idle' );
	advance( model, 1.5 );
	assert.ok( Math.abs( sumYaw( model.getView().current ) ) < 1e-4 );
	assert.ok( model.getView().current.every( Number.isFinite ) );

} );

test( 'CHAMELEON-HEAD-LOOK-004 exact critical spring is invariant to time partition away from events', () => {

	const slow = new ChameleonHeadLookModel().setIdleWeight( 0 ).setTarget( 0.36, -0.12, 1 );
	const fast = new ChameleonHeadLookModel().setIdleWeight( 0 ).setTarget( 0.36, -0.12, 1 );
	for ( let frame = 0; frame < 60; frame ++ ) slow.updateFixed( 1 / 60 );
	for ( let frame = 0; frame < 120; frame ++ ) fast.updateFixed( 1 / 120 );
	for ( let lane = 0; lane < CHAMELEON_HEAD_LOOK_SIZE; lane ++ ) assert.ok(
		Math.abs( slow.getView().current[ lane ] - fast.getView().current[ lane ] ) < 2e-6,
		`partition drift in lane ${ lane }`,
	);

} );

test( 'CHAMELEON-HEAD-LOOK-005 hot buffers retain identity and render interpolation is passive', () => {

	const model = new ChameleonHeadLookModel( { seed: 0x42 } );
	const view = model.getView();
	const identities = [ view.previous, view.current, view.target, view.render ];
	model.updateFixed( 1 / 120, {
		targetYaw: -0.4,
		targetPitch: 0.2,
		targetWeight: 0.8,
		idleWeight: 0.35,
	} );
	const fixationBefore = view.fixationRemaining;
	const currentBefore = view.current.slice();
	assert.equal( model.interpolate( 0.25 ), view.render );
	assert.equal( model.interpolate( 0.75 ), view.render );
	assert.equal( view.fixationRemaining, fixationBefore );
	assert.deepEqual( view.current, currentBefore );
	assert.deepEqual( [ view.previous, view.current, view.target, view.render ], identities );
	assert.ok( view.current.every( Number.isFinite ) );
	assert.equal( view.externalWeight, 0.8 );

} );
