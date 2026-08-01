import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
	CHAMELEON_FOOT,
	CHAMELEON_FOOT_COMPONENTS,
	ChameleonProceduralGait,
	swingAdvanceEnvelope,
	swingClearanceEnvelope,
	TWO_BONE_IK_RESULT_SIZE,
	solveTwoBoneIK,
} from '../src/chameleon-procedural-gait.js';

function flatContacts( advance = 0 ) {

	return {
		contactPositions: new Float32Array( [
			0.35 + advance, 0, 0.25,
			0.35 + advance, 0, - 0.25,
			- 0.35 + advance, 0, 0.25,
			- 0.35 + advance, 0, - 0.25,
		] ),
		contactNormals: new Float32Array( [
			0, 1, 0,
			0, 1, 0,
			0, 1, 0,
			0, 1, 0,
		] ),
		forwardX: 1,
		forwardY: 0,
		forwardZ: 0,
		speed: 1,
	};

}

function footTuple( positions, foot ) {

	const offset = foot * 3;
	return [
		positions[ offset ],
		positions[ offset + 1 ],
		positions[ offset + 2 ],
	];

}

function assertNear( actual, expected, tolerance = 1e-6 ) {

	assert.ok(
		Math.abs( actual - expected ) <= tolerance,
		`${ actual } should be within ${ tolerance } of ${ expected }`,
	);

}

test( 'CHAMELEON-GAIT-001 diagonal swing keeps the opposite stance feet locked in world space', () => {

	const initial = flatContacts();
	const gait = new ChameleonProceduralGait( {
		stepDistance: 0.05,
		minSwingDuration: 0.2,
		maxSwingDuration: 0.2,
	} );
	gait.reset( initial );
	const desired = flatContacts( 0.25 );
	const frontRightBefore = footTuple(
		gait.getView().footPositions,
		CHAMELEON_FOOT.FRONT_RIGHT,
	);
	const hindLeftBefore = footTuple(
		gait.getView().footPositions,
		CHAMELEON_FOOT.HIND_LEFT,
	);

	for ( let index = 0; index < 12; index ++ ) gait.update( 1 / 120, desired );

	assert.equal( gait.getView().activePair, 0 );
	assert.equal( gait.getView().footSwinging[ CHAMELEON_FOOT.FRONT_LEFT ], 1 );
	assert.equal( gait.getView().footSwinging[ CHAMELEON_FOOT.HIND_RIGHT ], 1 );
	assert.deepEqual(
		footTuple( gait.getView().footPositions, CHAMELEON_FOOT.FRONT_RIGHT ),
		frontRightBefore,
	);
	assert.deepEqual(
		footTuple( gait.getView().footPositions, CHAMELEON_FOOT.HIND_LEFT ),
		hindLeftBefore,
	);

} );

test( 'CHAMELEON-GAIT-002 swing is continuous, bounded and never crosses a flat target surface', () => {

	const initial = flatContacts();
	const desired = flatContacts( 0.3 );
	const gait = new ChameleonProceduralGait( {
		stepDistance: 0.025,
		stepHeight: 0.09,
		minSwingDuration: 0.22,
		maxSwingDuration: 0.22,
	} );
	gait.reset( initial );
	let previousX = gait.getView().footPositions[ 0 ];
	let maximumDelta = 0;
	let observedSwing = false;

	for ( let index = 0; index < 60; index ++ ) {

		gait.update( 1 / 120, desired );
		const view = gait.getView();
		const x = view.footPositions[ 0 ];
		maximumDelta = Math.max( maximumDelta, Math.abs( x - previousX ) );
		previousX = x;
		if ( view.footSwinging[ 0 ] ) observedSwing = true;
		assert.ok( view.footPositions[ 1 ] >= - 1e-7, 'swing foot penetrated the target plane' );

	}

	assert.equal( observedSwing, true );
	assert.ok( maximumDelta < 0.04, `unexpected foot teleport of ${ maximumDelta }` );
	assertNear( gait.getView().footPositions[ 0 ], desired.contactPositions[ 0 ] );
	assertNear( gait.getView().footPositions[ 1 ], 0 );
	assertNear( gait.getView().footPositions[ 2 ], desired.contactPositions[ 2 ] );

} );

test( 'CHAMELEON-GAIT-003 diagonal pairs alternate and a stopped gait stays perfectly stable', () => {

	const gait = new ChameleonProceduralGait( {
		stepDistance: 0.025,
		minSwingDuration: 0.08,
		maxSwingDuration: 0.08,
	} );
	const initial = flatContacts();
	gait.reset( initial );
	const firstTarget = flatContacts( 0.15 );
	let sawFirstPair = false;
	let sawSecondPair = false;
	for ( let index = 0; index < 30; index ++ ) {

		gait.update( 1 / 120, firstTarget );
		if ( gait.getView().activePair === 0 ) sawFirstPair = true;
		if ( gait.getView().activePair === 1 ) sawSecondPair = true;

	}
	assert.equal( sawFirstPair, true );
	assert.equal( sawSecondPair, true );

	const secondTarget = flatContacts( 0.3 );
	for ( let index = 0; index < 30; index ++ ) gait.update( 1 / 120, secondTarget );
	assert.ok( gait.getTelemetry().stepsCompleted >= 2 );

	const stopped = {
		...secondTarget,
		speed: 0,
	};
	for ( let index = 0; index < 60 && gait.getView().activePair >= 0; index ++ ) {

		gait.update( 1 / 120, stopped );

	}
	const snapshot = Float32Array.from( gait.getView().footPositions );
	for ( let index = 0; index < 240; index ++ ) gait.update( 1 / 120, stopped );
	assert.deepEqual( gait.getView().footPositions, snapshot );

} );

test( 'CHAMELEON-GAIT-010 moving feet wait for the configured stride instead of starting a settlement swing', () => {

	const gait = new ChameleonProceduralGait( {
		fixedStep: 1 / 120,
		stepDistance: 0.15,
		minSwingDuration: 0.18,
		maxSwingDuration: 0.18,
	} );
	gait.reset( flatContacts() );
	const desired = flatContacts( 0.24 );
	desired.speed = 0.6;
	for ( let step = 0; step < 29; step ++ ) gait.update( 1 / 120, desired );
	assert.equal( gait.getTelemetry().stepsStarted, 0 );
	assert.equal( gait.getView().activePair, -1 );
	assert.equal( gait.getView().distanceSinceStep < gait.stepDistance, true );

	gait.update( 1 / 120, desired );
	assert.equal( gait.getTelemetry().stepsStarted, 1 );
	assert.notEqual( gait.getView().activePair, -1 );

} );

test( 'CHAMELEON-GAIT-011 C2 swing clearance creates a high plateau with exact still endpoints', () => {

	assert.equal( swingClearanceEnvelope( 0 ), 0 );
	assert.equal( swingClearanceEnvelope( 1 ), 0 );
	assert.ok( swingClearanceEnvelope( 0.18 ) >= 0.9 );
	assert.ok( swingClearanceEnvelope( 0.5 ) >= 0.999999 );
	assert.ok( swingClearanceEnvelope( 0.78 ) >= 0.85 );
	assert.ok( swingClearanceEnvelope( 0.1 ) > 0.35 );
	assert.ok( swingClearanceEnvelope( 0.9 ) > 0.18 );

} );

test( 'CHAMELEON-GAIT-012 a stride lifts before advancing and plants after reaching forwards', () => {

	assert.equal( swingAdvanceEnvelope( 0 ), 0 );
	assert.equal( swingAdvanceEnvelope( 0.1 ), 0 );
	assert.equal( swingAdvanceEnvelope( 1 ), 1 );
	assert.ok( swingClearanceEnvelope( 0.1 ) > 0.5, 'toe-off must already be clearly visible' );
	assert.ok( swingAdvanceEnvelope( 0.14 ) < 0.01, 'the claw must rise before travelling' );
	assert.ok( swingAdvanceEnvelope( 0.72 ) > 0.85, 'forward reach must precede placement' );
	assert.ok( swingClearanceEnvelope( 0.72 ) > 0.99, 'the claw stays clear while reaching' );
	assert.equal( swingClearanceEnvelope( 1 ), 0 );

} );

test( 'CHAMELEON-GAIT-013 anterior claws use a visibly broader clearance arc', () => {

	const gait = new ChameleonProceduralGait( {
		stepDistance: 0.025,
		stepHeight: 0.09,
		minSwingDuration: 0.24,
		maxSwingDuration: 0.24,
	} );
	gait.reset( flatContacts() );
	const desired = flatContacts( 0.3 );
	let frontPeak = 0;
	let hindPeak = 0;
	for ( let frame = 0; frame < 48; frame ++ ) {

		const view = gait.update( 1 / 120, desired );
		if ( view.footSwinging[ CHAMELEON_FOOT.FRONT_LEFT ] )
			frontPeak = Math.max( frontPeak, view.footPositions[ 1 ] );
		if ( view.footSwinging[ CHAMELEON_FOOT.HIND_RIGHT ] )
			hindPeak = Math.max( hindPeak, view.footPositions[ 10 ] );

	}
	assert.ok( frontPeak > 0.12, `anterior clearance ${ frontPeak }` );
	assert.ok( hindPeak > 0.095, `posterior clearance ${ hindPeak }` );
	assert.ok( frontPeak > hindPeak * 1.2,
		`anterior arc ${ frontPeak } must be broader than posterior ${ hindPeak }` );

} );

test( 'CHAMELEON-GAIT-004 body pose follows the mean contact plane and remains orthonormal', () => {

	const input = flatContacts();
	input.contactPositions[ 1 ] = 0.1;
	input.contactPositions[ 4 ] = 0.1;
	input.contactPositions[ 7 ] = - 0.1;
	input.contactPositions[ 10 ] = - 0.1;
	const normalLength = Math.hypot( - 0.275, 0.962, 0 );
	for ( let foot = 0; foot < 4; foot ++ ) {

		input.contactNormals[ foot * 3 ] = - 0.275 / normalLength;
		input.contactNormals[ foot * 3 + 1 ] = 0.962 / normalLength;

	}
	const gait = new ChameleonProceduralGait( { bodyClearance: 0.2 } );
	gait.reset( input );
	const view = gait.getView();

	assertNear( Math.hypot( ...view.bodyUp ), 1 );
	assertNear( Math.hypot( ...view.bodyForward ), 1 );
	assertNear( Math.hypot( ...view.bodyRight ), 1 );
	assertNear(
		view.bodyUp[ 0 ] * view.bodyForward[ 0 ] +
			view.bodyUp[ 1 ] * view.bodyForward[ 1 ] +
			view.bodyUp[ 2 ] * view.bodyForward[ 2 ],
		0,
	);
	assert.ok( view.bodyPosition[ 1 ] > 0.18 );

} );

test( 'CHAMELEON-GAIT-005 fixed-step result is invariant to a reasonable dt partition', () => {

	const options = {
		fixedStep: 1 / 120,
		stepDistance: 0.03,
		minSwingDuration: 0.18,
		maxSwingDuration: 0.18,
	};
	const initial = flatContacts();
	const target = flatContacts( 0.25 );
	const a = new ChameleonProceduralGait( options );
	const b = new ChameleonProceduralGait( options );
	a.reset( initial );
	b.reset( initial );

	for ( let index = 0; index < 60; index ++ ) a.update( 1 / 60, target );
	for ( let index = 0; index < 120; index ++ ) b.update( 1 / 120, target );

	for ( let index = 0; index < CHAMELEON_FOOT_COMPONENTS; index ++ ) {

		assertNear( a.getView().footPositions[ index ], b.getView().footPositions[ index ] );

	}
	assert.equal( a.getView().activePair, b.getView().activePair );
	assert.equal( a.getView().nextPair, b.getView().nextPair );
	assert.equal( a.getTelemetry().integrationSteps, b.getTelemetry().integrationSteps );

} );

test( 'CHAMELEON-GAIT-006 analytic IK reaches valid targets and clamps unreachable ones robustly', () => {

	const result = new Float32Array( TWO_BONE_IK_RESULT_SIZE );
	assert.equal(
		solveTwoBoneIK(
			0, 0, 0,
			1.2, 0.3, - 0.2,
			0, 1, 0,
			0.8, 0.7,
			result,
		),
		result,
	);
	assertNear( result[ 6 ], 1.2 );
	assertNear( result[ 7 ], 0.3 );
	assertNear( result[ 8 ], - 0.2 );
	assertNear(
		Math.hypot( result[ 3 ], result[ 4 ], result[ 5 ] ),
		0.8,
	);
	assertNear(
		Math.hypot(
			result[ 6 ] - result[ 3 ],
			result[ 7 ] - result[ 4 ],
			result[ 8 ] - result[ 5 ],
		),
		0.7,
	);

	solveTwoBoneIK(
		0, 0, 0,
		10, 0, 0,
		2, 0, 0,
		0.8, 0.7,
		result,
	);
	for ( const value of result ) assert.ok( Number.isFinite( value ) );
	assert.ok( result[ 11 ] < 1.5 );
	assertNear( Math.hypot( result[ 6 ], result[ 7 ], result[ 8 ] ), result[ 11 ] );

} );

test( 'CHAMELEON-GAIT-007 view and hot-path buffers keep stable identities without constructors', async () => {

	const gait = new ChameleonProceduralGait( {
		stepDistance: 0.02,
		minSwingDuration: 0.1,
		maxSwingDuration: 0.1,
	} );
	const initial = flatContacts();
	const target = flatContacts( 0.4 );
	gait.reset( initial );
	const view = gait.getView();
	const telemetry = gait.getTelemetry();
	const identities = [
		view.footPositions,
		view.footNormals,
		view.footStartPositions,
		view.footTargetPositions,
		view.footPhase,
		view.footSwinging,
		view.bodyPosition,
		view.bodyForward,
		view.bodyUp,
		view.bodyRight,
	];
	for ( let index = 0; index < 5000; index ++ ) gait.update( 1 / 240, target );

	assert.equal( gait.getView(), view );
	assert.equal( gait.getTelemetry(), telemetry );
	assert.deepEqual( [
		view.footPositions,
		view.footNormals,
		view.footStartPositions,
		view.footTargetPositions,
		view.footPhase,
		view.footSwinging,
		view.bodyPosition,
		view.bodyForward,
		view.bodyUp,
		view.bodyRight,
	], identities );

	const source = await readFile(
		new URL( '../src/chameleon-procedural-gait.js', import.meta.url ),
		'utf8',
	);
	const hotPath = source.slice(
		source.indexOf( '\\n\\tupdate( dt, input ) {' ),
		source.indexOf( '\\n\\tgetView() {', source.indexOf( '\\n\\tupdate( dt, input ) {' ) ),
	);
	const resetPath = source.slice(
		source.indexOf( '\n\treset( input ) {' ),
		source.indexOf( '\n\tupdate( dt, input ) {' ),
	);
	assert.doesNotMatch( resetPath, /\.subarray\(|\bnew\s+/u );
	assert.doesNotMatch( hotPath, /\\bnew\\s+/u );

} );

test( 'CHAMELEON-GAIT-008 stopping settles an over-extended pair without stationary jitter', () => {

	const gait = new ChameleonProceduralGait( {
		stepDistance: 0.15,
		minSwingDuration: 0.12,
		maxSwingDuration: 0.22,
	} );
	const initial = flatContacts();
	gait.reset( initial );
	const displaced = flatContacts( 0.09 );
	for ( let index = 0; index < 8; index ++ ) gait.update( 1 / 120, displaced );
	displaced.speed = 0;
	let observedCorrection = false;
	for ( let index = 0; index < 120; index ++ ) {

		gait.update( 1 / 120, displaced );
		if ( gait.getView().activePair >= 0 ) observedCorrection = true;

	}
	assert.equal( observedCorrection, true );
	for ( let foot = 0; foot < 4; foot ++ )
		assertNear( gait.getView().footPositions[ foot * 3 ], displaced.contactPositions[ foot * 3 ] );
	const settled = Float32Array.from( gait.getView().footPositions );
	for ( let index = 0; index < 240; index ++ ) gait.update( 1 / 120, displaced );
	assert.deepEqual( gait.getView().footPositions, settled );

} );

test( 'CHAMELEON-GAIT-009 an external landing can request the same smooth settlement', () => {

	const gait = new ChameleonProceduralGait( {
		stepDistance: 0.15,
		minSwingDuration: 0.1,
		maxSwingDuration: 0.18,
	} );
	const initial = flatContacts();
	gait.reset( initial );
	const landing = flatContacts( 0.11 );
	landing.speed = 0;
	assert.equal( gait.requestSettlement(), gait );
	let swung = false;
	for ( let index = 0; index < 120; index ++ ) {

		gait.update( 1 / 120, landing );
		if ( gait.getView().activePair >= 0 ) swung = true;

	}
	assert.equal( swung, true );
	for ( let foot = 0; foot < 4; foot ++ )
		assertNear( gait.getView().footPositions[ foot * 3 ], landing.contactPositions[ foot * 3 ] );
	const settled = Float32Array.from( gait.getView().footPositions );
	for ( let index = 0; index < 240; index ++ ) gait.update( 1 / 120, landing );
	assert.deepEqual( gait.getView().footPositions, settled );

} );

test( 'CHAMELEON-GAIT-014 curved-support candidate motion bounds both diagonal settlements', () => {

	const gait = new ChameleonProceduralGait( {
		stepDistance: 0.15,
		minSwingDuration: 0.08,
		maxSwingDuration: 0.08,
	} );
	const initial = flatContacts();
	gait.reset( initial );
	// Driving even less than one stride arms post-drive settlement without
	// starting a walking pair.
	const driven = flatContacts();
	driven.speed = 0.3;
	gait.update( 1 / 120, driven );
	assert.equal( gait.getView().activePair, -1 );
	const stepsBeforeStop = gait.getTelemetry().stepsStarted;
	const completedBeforeStop = gait.getTelemetry().stepsCompleted;

	const stopped = flatContacts();
	stopped.speed = 0;
	for ( let tick = 0; tick < 240; tick ++ ) {

		// A narrow curved support moves the projection beneath each nominal claw
		// as the physical root rocks. Keep that candidate error permanently above
		// the settlement threshold to reproduce the former alternating loop.
		const candidateAdvance = tick % 2 === 0 ? 0.09 : - 0.09;
		for ( let foot = 0; foot < 4; foot ++ )
			stopped.contactPositions[ foot * 3 ] = initial.contactPositions[ foot * 3 ]
				+ candidateAdvance;
		gait.update( 1 / 120, stopped );

	}

	assert.equal( gait.getTelemetry().stepsStarted - stepsBeforeStop, 2,
		'each diagonal must be corrected exactly once' );
	assert.equal( gait.getTelemetry().stepsCompleted - completedBeforeStop, 2 );
	assert.equal( gait.getView().activePair, -1 );
	assert.deepEqual( Array.from( gait.getView().footSwinging ), [ 0, 0, 0, 0 ] );
	const settled = Float32Array.from( gait.getView().footPositions );
	for ( let tick = 0; tick < 240; tick ++ ) {

		const candidateAdvance = tick % 2 === 0 ? 0.09 : - 0.09;
		for ( let foot = 0; foot < 4; foot ++ )
			stopped.contactPositions[ foot * 3 ] = initial.contactPositions[ foot * 3 ]
				+ candidateAdvance;
		gait.update( 1 / 120, stopped );

	}
	assert.deepEqual( gait.getView().footPositions, settled,
		'candidate noise restarted settlement after both pair budgets were spent' );

} );

test( 'CHAMELEON-GAIT-015 stopping mid-stride finishes it and corrects the opposite pair once', () => {

	const gait = new ChameleonProceduralGait( {
		stepDistance: 0.025,
		minSwingDuration: 0.12,
		maxSwingDuration: 0.12,
	} );
	gait.reset( flatContacts() );
	const moving = flatContacts( 0.24 );
	for ( let tick = 0; tick < 30 && gait.getView().activePair < 0; tick ++ )
		gait.update( 1 / 120, moving );
	assert.notEqual( gait.getView().activePair, -1 );
	const activeAtStop = gait.getView().activePair;
	const stepsAtStop = gait.getTelemetry().stepsStarted;

	const stopped = flatContacts( 0.24 );
	stopped.speed = 0;
	for ( let tick = 0; tick < 120; tick ++ ) {

		// Keep the opposite diagonal pair deliberately far from its candidate.
		// It receives one corrective stride, never an unbounded alternation.
		const oppositePair = activeAtStop === 0
			? [ CHAMELEON_FOOT.FRONT_RIGHT, CHAMELEON_FOOT.HIND_LEFT ]
			: [ CHAMELEON_FOOT.FRONT_LEFT, CHAMELEON_FOOT.HIND_RIGHT ];
		for ( const foot of oppositePair )
			stopped.contactPositions[ foot * 3 ] = moving.contactPositions[ foot * 3 ] + 0.08;
		gait.update( 1 / 120, stopped );

	}

	assert.equal( gait.getTelemetry().stepsStarted, stepsAtStop + 1,
		'the opposite diagonal did not receive its single corrective stride' );
	assert.equal( gait.getView().activePair, -1 );
	assert.deepEqual( Array.from( gait.getView().footSwinging ), [ 0, 0, 0, 0 ] );

} );
