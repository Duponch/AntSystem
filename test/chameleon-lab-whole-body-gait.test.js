import assert from 'node:assert/strict';
import test from 'node:test';

import {
	WholeBodyGaitModel,
	WHOLE_BODY_POSE,
	WHOLE_BODY_POSE_SIZE,
	writeWholeBodyTarget,
} from '../src/chameleon-lab/whole-body-gait-model.js';

function gaitView( activePair, phase ) {

	const footPhase = new Float32Array( 4 );
	if ( activePair === 0 ) {

		footPhase[ 0 ] = phase;
		footPhase[ 3 ] = phase;

	} else if ( activePair === 1 ) {

		footPhase[ 1 ] = phase;
		footPhase[ 2 ] = phase;

	}
	return { activePair, footPhase, nextPair: activePair === 0 ? 1 : 0 };

}

test( 'CHAMELEON-LAB-GAIT-001 diagonal swing drives hips and shoulders through a full stride', () => {

	const early = new Float32Array( WHOLE_BODY_POSE_SIZE );
	const late = new Float32Array( WHOLE_BODY_POSE_SIZE );
	writeWholeBodyTarget( {
		gaitView: gaitView( 0, 0.1 ), speed: 1,
		strideAmplitude: 0.48, limbLift: 0.32, jointFlex: 0.6,
	}, early );
	writeWholeBodyTarget( {
		gaitView: gaitView( 0, 0.9 ), speed: 1,
		strideAmplitude: 0.48, limbLift: 0.32, jointFlex: 0.6,
	}, late );

	for ( const foot of [ 0, 3 ] ) {

		assert.ok( early[ WHOLE_BODY_POSE.STRIDE_0 + foot ] < -0.4 );
		assert.ok( late[ WHOLE_BODY_POSE.STRIDE_0 + foot ] > 0.4 );

	}
	for ( const foot of [ 1, 2 ] ) {

		assert.ok( early[ WHOLE_BODY_POSE.STRIDE_0 + foot ] > 0.4 );
		assert.ok( late[ WHOLE_BODY_POSE.STRIDE_0 + foot ] < -0.4 );

	}

} );

test( 'CHAMELEON-LAB-GAIT-002 swing flexes the elbow and knee while support limbs stay extended', () => {

	const pose = new Float32Array( WHOLE_BODY_POSE_SIZE );
	writeWholeBodyTarget( {
		gaitView: gaitView( 1, 0.5 ), speed: 1,
		strideAmplitude: 0.44, limbLift: 0.3, jointFlex: 0.62,
	}, pose );

	assert.ok( pose[ WHOLE_BODY_POSE.FLEX_1 ] > 0.55 );
	assert.ok( pose[ WHOLE_BODY_POSE.FLEX_2 ] > 0.55 );
	assert.ok( pose[ WHOLE_BODY_POSE.FLEX_0 ] < 0.12 );
	assert.ok( pose[ WHOLE_BODY_POSE.FLEX_3 ] < 0.12 );
	assert.ok( Math.abs( pose[ WHOLE_BODY_POSE.LIFT_1 ] ) > 0.25 );
	assert.ok( Math.abs( pose[ WHOLE_BODY_POSE.LIFT_2 ] ) > 0.25 );

} );

test( 'CHAMELEON-LAB-GAIT-003 trunk counter-rotates and the head correction stays smaller', () => {

	const pose = new Float32Array( WHOLE_BODY_POSE_SIZE );
	writeWholeBodyTarget( {
		gaitView: gaitView( 0, 0.22 ), speed: 0.8, bodyMotion: 1.2,
	}, pose );

	assert.ok( pose[ WHOLE_BODY_POSE.PELVIS_YAW ] * pose[ WHOLE_BODY_POSE.CHEST_YAW ] < 0 );
	assert.ok( pose[ WHOLE_BODY_POSE.PELVIS_YAW ] * pose[ WHOLE_BODY_POSE.HEAD_YAW ] < 0 );
	const accumulatedHeadYaw = pose[ WHOLE_BODY_POSE.PELVIS_YAW ]
		+ pose[ WHOLE_BODY_POSE.CHEST_YAW ]
		+ pose[ WHOLE_BODY_POSE.NECK_YAW ]
		+ pose[ WHOLE_BODY_POSE.HEAD_YAW ];
	assert.ok(
		Math.abs( accumulatedHeadYaw ) < Math.abs( pose[ WHOLE_BODY_POSE.PELVIS_YAW ] ) * 0.2,
	);
	assert.ok( Math.abs( pose[ WHOLE_BODY_POSE.SUPPORT_SHIFT ] ) > 0 );

} );

test( 'CHAMELEON-LAB-GAIT-004 damping is allocation-free, finite and relaxes at rest', () => {

	const model = new WholeBodyGaitModel();
	const view = model.getView();
	const identities = [ view.previous, view.current, view.target, view.render ];
	let maximumDelta = 0;
	let previous = 0;
	for ( let frame = 0; frame < 240; frame ++ ) {

		model.update( 1 / 120, {
			gaitView: gaitView( frame < 120 ? 0 : 1, ( frame % 120 ) / 119 ),
			speed: 1,
		} );
		const value = model.getView().current[ WHOLE_BODY_POSE.STRIDE_0 ];
		maximumDelta = Math.max( maximumDelta, Math.abs( value - previous ) );
		previous = value;
		assert.ok( model.getView().current.every( Number.isFinite ) );

	}
	for ( let frame = 0; frame < 240; frame ++ )
		model.update( 1 / 120, { gaitView: gaitView( -1, 0 ), speed: 0 } );

	assert.ok( maximumDelta < 0.1, `unbounded pose delta ${ maximumDelta }` );
	assert.ok( Math.abs( model.getView().current[ WHOLE_BODY_POSE.STRIDE_0 ] ) < 1e-5 );
	assert.deepEqual(
		[ view.previous, view.current, view.target, view.render ],
		identities,
		'fixed buffers must retain their identity',
	);
	assert.equal( model.interpolate( 0.35 ), view.render );

} );

test( 'CHAMELEON-LAB-GAIT-005 idle observation includes subtle whole-body weight transfer', () => {

	const first = new Float32Array( WHOLE_BODY_POSE_SIZE );
	const later = new Float32Array( WHOLE_BODY_POSE_SIZE );
	const repeated = new Float32Array( WHOLE_BODY_POSE_SIZE );
	writeWholeBodyTarget( {
		gaitView: gaitView( -1, 0 ), speed: 0, attentionTime: 1.25, attentionSeed: 0.4,
	}, first );
	writeWholeBodyTarget( {
		gaitView: gaitView( -1, 0 ), speed: 0, attentionTime: 8.75, attentionSeed: 0.4,
	}, later );
	writeWholeBodyTarget( {
		gaitView: gaitView( -1, 0 ), speed: 0, attentionTime: 8.75, attentionSeed: 0.4,
	}, repeated );
	assert.ok( Math.abs( first[ WHOLE_BODY_POSE.NECK_YAW ] ) > 0.01 );
	assert.ok( Math.abs(
		later[ WHOLE_BODY_POSE.NECK_YAW ] - first[ WHOLE_BODY_POSE.NECK_YAW ],
	) > 0.02 );
	assert.ok( Math.abs( later[ WHOLE_BODY_POSE.NECK_YAW ] ) < 0.15 );
	assert.ok( Math.abs( later[ WHOLE_BODY_POSE.HEAD_YAW ] ) < 0.06 );
	assert.ok( Math.abs( later[ WHOLE_BODY_POSE.CHEST_PITCH ] ) < 0.005 );
	assert.ok( Math.abs( later[ WHOLE_BODY_POSE.PELVIS_YAW ] ) > 0.001 );
	assert.ok( Math.abs( later[ WHOLE_BODY_POSE.PELVIS_YAW ] ) < 0.007 );
	assert.ok( Math.abs(
		later[ WHOLE_BODY_POSE.PELVIS_YAW ] - first[ WHOLE_BODY_POSE.PELVIS_YAW ],
	) > 0.002 );
	assert.ok( Math.abs( later[ WHOLE_BODY_POSE.PELVIS_ROLL ] ) > 0.0005 );
	assert.ok( Math.abs( later[ WHOLE_BODY_POSE.PELVIS_ROLL ] ) < 0.005 );
	assert.ok( Math.abs( later[ WHOLE_BODY_POSE.SUPPORT_SHIFT ] ) > 0.0001 );
	assert.ok( Math.abs( later[ WHOLE_BODY_POSE.SUPPORT_SHIFT ] ) < 0.002 );
	for ( let foot = 0; foot < 4; foot ++ ) {

		assert.equal( Math.abs( later[ WHOLE_BODY_POSE.STRIDE_0 + foot ] ), 0 );
		assert.equal( Math.abs( later[ WHOLE_BODY_POSE.LIFT_0 + foot ] ), 0 );
		assert.equal( Math.abs( later[ WHOLE_BODY_POSE.FLEX_0 + foot ] ), 0 );

	}
	assert.equal( later[ WHOLE_BODY_POSE.MOTION_WEIGHT ], 1 );
	assert.deepEqual( later, repeated, 'idle attention must remain deterministic' );

} );

test( 'CHAMELEON-LAB-GAIT-006 anterior breast-stroke lifts, reaches, then plants from the shoulder', () => {

	const toeOff = new Float32Array( WHOLE_BODY_POSE_SIZE );
	const reach = new Float32Array( WHOLE_BODY_POSE_SIZE );
	const plant = new Float32Array( WHOLE_BODY_POSE_SIZE );
	const parameters = {
		speed: 1, strideAmplitude: 0.48, limbLift: 0.36, jointFlex: 0.72,
	};
	writeWholeBodyTarget( { ...parameters, gaitView: gaitView( 0, 0.12 ) }, toeOff );
	writeWholeBodyTarget( { ...parameters, gaitView: gaitView( 0, 0.55 ) }, reach );
	writeWholeBodyTarget( { ...parameters, gaitView: gaitView( 0, 0.94 ) }, plant );

	assert.ok( toeOff[ WHOLE_BODY_POSE.STRIDE_0 ] < -0.45,
		'the front arm must fold/lift before its forward sweep' );
	assert.ok( Math.abs( toeOff[ WHOLE_BODY_POSE.LIFT_0 ] ) > 0.35 );
	assert.ok( reach[ WHOLE_BODY_POSE.STRIDE_0 ] > 0.1 );
	assert.ok( Math.abs( reach[ WHOLE_BODY_POSE.LIFT_0 ] ) > 0.5 );
	assert.ok( plant[ WHOLE_BODY_POSE.STRIDE_0 ] > 0.5 );
	assert.ok( Math.abs( plant[ WHOLE_BODY_POSE.LIFT_0 ] ) < 0.08,
		'the palm must descend only after the shoulder has reached forwards' );
	assert.ok(
		Math.abs( reach[ WHOLE_BODY_POSE.LIFT_0 ] )
			> Math.abs( reach[ WHOLE_BODY_POSE.LIFT_3 ] ) * 1.2,
		'the anterior shoulder must describe the broader arc',
	);

} );

test( 'CHAMELEON-LAB-GAIT-007 couplet hand-off is pose-continuous without a neutral-frame twitch', () => {

	const completed = new Float32Array( WHOLE_BODY_POSE_SIZE );
	const handOff = new Float32Array( WHOLE_BODY_POSE_SIZE );
	const started = new Float32Array( WHOLE_BODY_POSE_SIZE );
	const parameters = {
		speed: 1, strideAmplitude: 0.64, limbLift: 0.43, jointFlex: 0.82,
	};
	writeWholeBodyTarget( { ...parameters, gaitView: gaitView( 0, 1 ) }, completed );
	const between = gaitView( -1, 0 );
	between.nextPair = 1;
	writeWholeBodyTarget( { ...parameters, gaitView: between }, handOff );
	writeWholeBodyTarget( { ...parameters, gaitView: gaitView( 1, 0 ) }, started );

	for ( let index = 0; index < WHOLE_BODY_POSE_SIZE; index ++ ) {

		assert.ok( Math.abs( completed[ index ] - handOff[ index ] ) < 1e-6,
			`completed -> hand-off discontinuity in lane ${ index }` );
		assert.ok( Math.abs( handOff[ index ] - started[ index ] ) < 1e-6,
			`hand-off -> next couplet discontinuity in lane ${ index }` );

	}

} );

test( 'CHAMELEON-LAB-GAIT-008 exact damped response is smooth and fixed-time invariant', () => {

	const options = { responseFrequency: 8.5, dampingRatio: 1.05 };
	const sixty = new WholeBodyGaitModel( options );
	const oneTwenty = new WholeBodyGaitModel( options );
	const input = {
		gaitView: gaitView( 0, 0.55 ), speed: 1,
		strideAmplitude: 0.64, limbLift: 0.43, jointFlex: 0.82,
	};
	for ( let frame = 0; frame < 60; frame ++ ) sixty.update( 1 / 60, input );
	let maximumAccelerationDelta = 0;
	let previousDelta = 0;
	let previousValue = 0;
	for ( let frame = 0; frame < 120; frame ++ ) {

		oneTwenty.update( 1 / 120, input );
		const value = oneTwenty.getView().current[ WHOLE_BODY_POSE.LIFT_0 ];
		const delta = value - previousValue;
		maximumAccelerationDelta = Math.max(
			maximumAccelerationDelta, Math.abs( delta - previousDelta ),
		);
		previousValue = value;
		previousDelta = delta;

	}
	for ( let index = 0; index < WHOLE_BODY_POSE_SIZE; index ++ )
		assert.ok( Math.abs(
			sixty.getView().current[ index ] - oneTwenty.getView().current[ index ],
		) < 2e-6, `dt partition drift in lane ${ index }` );
	assert.ok( maximumAccelerationDelta < 0.07,
		`damped pose contains a visible impulse (${ maximumAccelerationDelta })` );

} );

test( 'CHAMELEON-LAB-GAIT-009 detached bodies suppress the terrestrial idle envelope', () => {

	const target = new Float32Array( WHOLE_BODY_POSE_SIZE );
	writeWholeBodyTarget( {
		gaitView: gaitView( -1, 0 ),
		speed: 0,
		idleWeight: 0,
		attentionTime: 9.75,
		attentionSeed: 0.41,
	}, target );
	for ( let index = WHOLE_BODY_POSE.PELVIS_YAW;
		index <= WHOLE_BODY_POSE.SUPPORT_SHIFT; index ++ ) assert.equal(
		target[ index ], 0, `detached whole-body lane ${ index } retained idle motion`,
	);
	assert.equal( target[ WHOLE_BODY_POSE.MOTION_WEIGHT ], 1 );

} );
