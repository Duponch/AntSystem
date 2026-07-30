import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
	CHAMELEON_FOOT,
	CHAMELEON_FOOT_COMPONENTS,
	ChameleonProceduralGait,
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
