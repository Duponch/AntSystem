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
	return { activePair, footPhase };

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
