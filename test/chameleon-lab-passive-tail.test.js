import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createPassiveTailPhysics,
	PASSIVE_TAIL_BEND_CONSTRAINT_COUNT,
	PASSIVE_TAIL_BONE_COUNT,
	PASSIVE_TAIL_NODE_COUNT,
	PASSIVE_TAIL_SEGMENT_COUNT,
} from '../src/chameleon-lab/passive-tail-physics.js';

const EPSILON = 1e-6;

function planeProjector( state = null ) {

	return ( point, radius, outPoint, outNormal ) => {

		if ( state ) {

			state.calls ++;
			state.point ??= point;
			state.outPoint ??= outPoint;
			state.outNormal ??= outNormal;
			if ( state.point !== point || state.outPoint !== outPoint
				|| state.outNormal !== outNormal ) state.stableScratch = false;

		}
		if ( point.y >= radius ) return false;
		outPoint.x = point.x;
		outPoint.y = radius;
		outPoint.z = point.z;
		outNormal.x = 0;
		outNormal.y = 1;
		outNormal.z = 0;
		return true;

	};

}

function assertBuffersFinite( tail ) {

	assert.equal( tail.isFinite(), true );
	for ( const buffer of [
		tail.positions,
		tail.previousPositions,
		tail.renderPreviousPositions,
		tail.interpolatedPositions,
	] ) assert.ok( Array.from( buffer ).every( Number.isFinite ) );
	assert.ok( Number.isFinite( tail.kineticEnergy() ) );

}

function endpointDistance( positions ) {

	const last = positions.length - 3;
	return Math.hypot(
		positions[ last ] - positions[ 0 ],
		positions[ last + 1 ] - positions[ 1 ],
		positions[ last + 2 ] - positions[ 2 ],
	);

}

test( 'CHAMELEON-LAB-PASSIVE-TAIL-001 owns thirteen samples for twelve bones in stable preallocated buffers', () => {

	const tail = createPassiveTailPhysics( {
		rootPosition: { x: 1, y: 2, z: 3 },
		segmentLength: 0.06,
		gravity: { x: 0, y: 0, z: 0 },
	} );
	const view = tail.getView();
	assert.equal( PASSIVE_TAIL_NODE_COUNT, 13 );
	assert.equal( PASSIVE_TAIL_SEGMENT_COUNT, 12 );
	assert.equal( PASSIVE_TAIL_BEND_CONSTRAINT_COUNT, 11 );
	assert.equal( PASSIVE_TAIL_BONE_COUNT, 12 );
	assert.equal( view.nodeCount, PASSIVE_TAIL_NODE_COUNT );
	assert.equal( view.positions.length, PASSIVE_TAIL_NODE_COUNT * 3 );
	assert.equal( view.previousPositions.length, PASSIVE_TAIL_NODE_COUNT * 3 );
	assert.equal( view.interpolatedPositions.length, PASSIVE_TAIL_NODE_COUNT * 3 );
	assert.equal( view.segmentLengths.length, PASSIVE_TAIL_SEGMENT_COUNT );
	assert.equal( view.bendLengths.length, PASSIVE_TAIL_BEND_CONSTRAINT_COUNT );
	assert.deepEqual( Array.from( view.positions.slice( 0, 3 ) ), [ 1, 2, 3 ] );

	const identities = {
		view,
		positions: view.positions,
		previous: view.previousPositions,
		interpolated: view.interpolatedPositions,
		segments: view.segmentLengths,
		bends: view.bendLengths,
		radii: view.radii,
	};
	for ( let step = 0; step < 600; step ++ )
		assert.equal( tail.stepFixed(), identities.view );
	assert.equal( tail.getView(), identities.view );
	assert.equal( tail.positions, identities.positions );
	assert.equal( tail.renderPreviousPositions, identities.previous );
	assert.equal( tail.interpolatedPositions, identities.interpolated );
	assert.equal( tail.segmentLengths, identities.segments );
	assert.equal( tail.bendLengths, identities.bends );
	assert.equal( tail.radii, identities.radii );
	assert.equal( tail.stats.totalSteps, 600 );
	assertBuffersFinite( tail );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-002 keeps its root attached and projects passive nodes out of collision', () => {

	const callbackState = { calls: 0, stableScratch: true };
	const tail = createPassiveTailPhysics( {
		rootPosition: { x: 0, y: 0.6, z: 0 },
		segmentLength: 0.075,
		damping: 1.5,
		projectPoint: planeProjector( callbackState ),
	} );
	for ( let step = 0; step < 2_400; step ++ ) {

		tail.stepFixed();
		assert.equal( tail.positions[ 0 ], 0 );
		assert.ok( Math.abs( tail.positions[ 1 ] - 0.6 ) <= EPSILON );
		assert.equal( tail.positions[ 2 ], 0 );
		assertBuffersFinite( tail );

	}
	for ( let node = 1; node < PASSIVE_TAIL_NODE_COUNT; node ++ )
		assert.ok(
			tail.positions[ node * 3 + 1 ] >= tail.radii[ node ] - 2e-5,
			'node ' + node + ' penetrated the plane',
		);
	assert.ok( callbackState.calls > 100_000 );
	assert.equal( callbackState.stableScratch, true );
	assert.ok( tail.maxSegmentError() < 0.002 );
	assert.equal( tail.stats.invalidCorrections, 0 );
	assert.equal( tail.stats.rejectedProjections, 0 );
	assert.ok( tail.kineticEnergy() <= tail.maximumKineticEnergy() + EPSILON );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-003 passive damping dissipates an impulse without injecting energy', () => {

	const tail = createPassiveTailPhysics( {
		gravity: { x: 0, y: 0, z: 0 },
		damping: 2,
		maxSpeed: 6,
		bendCompliance: 2e-5,
	} );
	tail.applyImpulse( PASSIVE_TAIL_NODE_COUNT - 1, { x: 0, y: 4, z: 2 } );
	const initialEnergy = tail.kineticEnergy();
	let peakEnergy = initialEnergy;
	for ( let step = 0; step < 2_400; step ++ ) {

		tail.stepFixed();
		peakEnergy = Math.max( peakEnergy, tail.kineticEnergy() );
		assert.ok( tail.kineticEnergy() <= tail.maximumKineticEnergy() + EPSILON );
		assertBuffersFinite( tail );

	}
	assert.ok( initialEnergy > 9 && initialEnergy < 11 );
	assert.ok( peakEnergy <= initialEnergy * 1.001 );
	assert.ok( tail.kineticEnergy() < initialEnergy * 0.001 );
	assert.ok( tail.maxSegmentError() < 1e-4 );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-004 fixed-step outcome is identical at 60 and 240 render Hz', () => {

	const create = () => {

		const tail = createPassiveTailPhysics( {
			rootPosition: { x: 0, y: 0.6, z: 0 },
			damping: 1.5,
			projectPoint: planeProjector(),
		} );
		tail.applyImpulse(
			PASSIVE_TAIL_NODE_COUNT - 1,
			{ x: 1.5, y: 2, z: -0.7 },
		);
		return tail;

	};
	const slow = create();
	const fast = create();
	for ( let frame = 0; frame < 360; frame ++ ) slow.advance( 1 / 60 );
	for ( let frame = 0; frame < 1_440; frame ++ ) fast.advance( 1 / 240 );
	assert.equal( slow.stats.totalSteps, 720 );
	assert.equal( fast.stats.totalSteps, 720 );
	for ( const key of [ 'positions', 'previousPositions', 'interpolatedPositions' ] ) {

		const first = slow[ key ];
		const second = fast[ key ];
		for ( let index = 0; index < first.length; index ++ )
			assert.equal( first[ index ], second[ index ], key + '[' + index + ']' );

	}
	assert.equal( slow.kineticEnergy(), fast.kineticEnergy() );
	assert.equal( slow.maxSegmentError(), fast.maxSegmentError() );
	assertBuffersFinite( slow );
	assertBuffersFinite( fast );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-005 interpolation reuses one buffer and brackets fixed poses', () => {

	const tail = createPassiveTailPhysics( {
		gravity: { x: 0, y: 0, z: 0 },
		damping: 0,
	} );
	tail.applyImpulse( PASSIVE_TAIL_NODE_COUNT - 1, { x: 0, y: 2, z: 0 } );
	const before = tail.positions.slice();
	tail.stepFixed();
	const current = tail.positions.slice();
	const interpolationBuffer = tail.interpolatedPositions;
	assert.equal( tail.interpolate( 0 ), interpolationBuffer );
	assert.deepEqual( Array.from( interpolationBuffer ), Array.from( before ) );
	tail.interpolate( 0.5 );
	for ( let index = 0; index < interpolationBuffer.length; index ++ )
		assert.ok(
			Math.abs(
				interpolationBuffer[ index ] - ( before[ index ] + current[ index ] ) * 0.5,
			) <= 1e-7,
		);
	assert.equal( tail.interpolate( 1 ), interpolationBuffer );
	assert.deepEqual( Array.from( interpolationBuffer ), Array.from( current ) );
	const external = new Float32Array( PASSIVE_TAIL_NODE_COUNT * 3 );
	assert.equal( tail.interpolate( 0.25, external ), external );
	assert.equal( tail.getView().interpolatedPositions, interpolationBuffer );
	assertBuffersFinite( tail );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-006 rejects invalid projections before they create NaN', () => {

	const invalidProjector = ( point, radius, outPoint, outNormal ) => {

		outPoint.x = Number.NaN;
		outPoint.y = Number.POSITIVE_INFINITY;
		outPoint.z = point.z + radius;
		outNormal.x = 0;
		outNormal.y = Number.NaN;
		outNormal.z = 0;
		return true;

	};
	const tail = createPassiveTailPhysics( { projectPoint: invalidProjector } );
	for ( let step = 0; step < 240; step ++ ) {

		tail.stepFixed();
		assertBuffersFinite( tail );

	}
	assert.ok( tail.stats.rejectedProjections > 0 );
	assert.equal( tail.stats.invalidCorrections, 0 );
	assert.throws( () => tail.advance( Number.NaN ), /frameDt/u );
	assert.throws(
		() => tail.stepFixed( { x: Number.NaN, y: 0, z: 0 } ),
		/rootPosition/u,
	);
	assert.throws(
		() => tail.applyImpulse( 0, { x: 1, y: 0, z: 0 } ),
		/nodeIndex/u,
	);

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-007 follows a moving root with bounded energy and lengths', () => {

	const tail = createPassiveTailPhysics( {
		rootPosition: { x: 0, y: 0.8, z: 0.12 },
		segmentLength: 0.06,
		damping: 1.7,
		solverIterations: 10,
	} );
	let maximumError = 0;
	let maximumEnergy = 0;
	for ( let step = 0; step < 1_200; step ++ ) {

		const time = step / 120;
		const root = {
			x: Math.sin( time * 0.8 ) * 0.25,
			y: 0.8 + Math.sin( time * 0.33 ) * 0.08,
			z: Math.cos( time * 0.5 ) * 0.12,
		};
		tail.stepFixed( root );
		assert.ok( Math.abs( tail.positions[ 0 ] - root.x ) <= EPSILON );
		assert.ok( Math.abs( tail.positions[ 1 ] - root.y ) <= EPSILON );
		assert.ok( Math.abs( tail.positions[ 2 ] - root.z ) <= EPSILON );
		maximumError = Math.max( maximumError, tail.maxSegmentError() );
		maximumEnergy = Math.max( maximumEnergy, tail.kineticEnergy() );
		assertBuffersFinite( tail );

	}
	assert.ok( maximumError < 0.002 );
	assert.ok( maximumEnergy <= tail.maximumKineticEnergy() + EPSILON );
	assert.equal( tail.stats.invalidCorrections, 0 );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-008 encodes initial curvature as passive rest geometry', () => {

	const initial = new Float32Array( PASSIVE_TAIL_NODE_COUNT * 3 );
	for ( let node = 0; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

		const angle = node * 0.19;
		const offset = node * 3;
		initial[ offset ] = Math.sin( angle ) * 0.34;
		initial[ offset + 1 ] = ( 1 - Math.cos( angle ) ) * 0.34;
		initial[ offset + 2 ] = node * 0.012;

	}
	const tail = createPassiveTailPhysics( {
		initialPositions: initial,
		rootPosition: { x: 0.3, y: 0.7, z: -0.2 },
		gravity: { x: 0, y: 0, z: 0 },
		damping: 1.5,
		bendCompliance: 2e-5,
	} );
	const restPose = tail.positions.slice();
	const restEndpointDistance = endpointDistance( restPose );
	const arcLength = Array.from( tail.segmentLengths )
		.reduce( ( sum, length ) => sum + length, 0 );
	assert.ok( restEndpointDistance < arcLength * 0.9, 'fixture must be visibly curved' );
	for ( let step = 0; step < 1_200; step ++ ) tail.stepFixed();
	let maximumDrift = 0;
	for ( let index = 0; index < restPose.length; index ++ )
		maximumDrift = Math.max(
			maximumDrift,
			Math.abs( tail.positions[ index ] - restPose[ index ] ),
		);
	assert.ok( maximumDrift < 1e-5 );
	assert.ok( Math.abs( endpointDistance( tail.positions ) - restEndpointDistance ) < 1e-5 );
	assert.ok( tail.maxSegmentError() < 1e-6 );
	assertBuffersFinite( tail );

} );
