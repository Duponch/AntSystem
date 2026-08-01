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

function tunnelProjector( halfWidth = 0.18, ceiling = 0.5 ) {

	return ( point, radius, outPoint, outNormal ) => {

		let correction = 0;
		outPoint.x = point.x;
		outPoint.y = point.y;
		outPoint.z = point.z;
		if ( radius - point.y > correction ) {

			correction = radius - point.y;
			outPoint.y = radius;
			outNormal.x = 0; outNormal.y = 1; outNormal.z = 0;

		}
		if ( point.y - ( ceiling - radius ) > correction ) {

			correction = point.y - ( ceiling - radius );
			outPoint.x = point.x; outPoint.y = ceiling - radius; outPoint.z = point.z;
			outNormal.x = 0; outNormal.y = -1; outNormal.z = 0;

		}
		if ( point.z - ( halfWidth - radius ) > correction ) {

			correction = point.z - ( halfWidth - radius );
			outPoint.x = point.x; outPoint.y = point.y; outPoint.z = halfWidth - radius;
			outNormal.x = 0; outNormal.y = 0; outNormal.z = -1;

		}
		if ( -halfWidth + radius - point.z > correction ) {

			correction = -halfWidth + radius - point.z;
			outPoint.x = point.x; outPoint.y = point.y; outPoint.z = -halfWidth + radius;
			outNormal.x = 0; outNormal.y = 0; outNormal.z = 1;

		}
		return correction > 0;

	};

}

function sphereFloorProjector( center = { x: 0.35, y: 0.1, z: 0 }, sphereRadius = 0.1 ) {

	return ( point, radius, outPoint, outNormal ) => {

		let correction = radius - point.y;
		outPoint.x = point.x;
		outPoint.y = radius;
		outPoint.z = point.z;
		outNormal.x = 0; outNormal.y = 1; outNormal.z = 0;
		let dx = point.x - center.x;
		let dy = point.y - center.y;
		let dz = point.z - center.z;
		let distance = Math.hypot( dx, dy, dz );
		const sphereCorrection = sphereRadius + radius - distance;
		if ( sphereCorrection > correction ) {

			if ( distance < 1e-9 ) {

				dx = 0; dy = 1; dz = 0; distance = 1;

			}
			const inverseDistance = 1 / distance;
			outNormal.x = dx * inverseDistance;
			outNormal.y = dy * inverseDistance;
			outNormal.z = dz * inverseDistance;
			outPoint.x = center.x + outNormal.x * ( sphereRadius + radius );
			outPoint.y = center.y + outNormal.y * ( sphereRadius + radius );
			outPoint.z = center.z + outNormal.z * ( sphereRadius + radius );
			correction = sphereCorrection;

		}
		return correction > 0;

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

function baseAngle( tail, direction ) {

	const directionLength = Math.hypot( direction.x, direction.y, direction.z );
	const segmentX = tail.positions[ 3 ] - tail.positions[ 0 ];
	const segmentY = tail.positions[ 4 ] - tail.positions[ 1 ];
	const segmentZ = tail.positions[ 5 ] - tail.positions[ 2 ];
	const segmentLength = Math.hypot( segmentX, segmentY, segmentZ );
	const cosine = (
		segmentX * direction.x + segmentY * direction.y + segmentZ * direction.z
	) / ( segmentLength * directionLength );
	return Math.acos( Math.max( -1, Math.min( 1, cosine ) ) );

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
	assert.ok( callbackState.calls > 1_000 );
	assert.equal( tail.isSleeping(), true );
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

test( 'CHAMELEON-LAB-PASSIVE-TAIL-009 root cone prevents inversion under impulses and moving attachment', () => {

	const maxAngle = 0.42;
	const tail = createPassiveTailPhysics( {
		rootPosition: { x: 0, y: 0.7, z: 0 },
		segmentLength: 0.06,
		baseDirection: { x: 1, y: 0, z: 0 },
		baseMaxAngle: maxAngle,
		damping: 1.1,
		solverIterations: 12,
		maxSpeed: 10,
	} );
	// Force the singular antiparallel case once; the deterministic fallback
	// must still choose a finite point on the cone boundary.
	tail.positions[ 3 ] = tail.positions[ 0 ] - tail.segmentLengths[ 0 ];
	tail.positions[ 4 ] = tail.positions[ 1 ];
	tail.positions[ 5 ] = tail.positions[ 2 ];
	tail.previousPositions.set( tail.positions );
	tail.setBaseDirection( { x: 1, y: 0, z: 0 }, 0 );
	tail.stepFixed( { x: 0, y: 0.7, z: 0 } );
	const antiparallelAngle = baseAngle( tail, { x: 1, y: 0, z: 0 } );
	assert.ok( antiparallelAngle <= 5e-4, 'angle was ' + antiparallelAngle );

	let maximumLengthError = 0;
	for ( let step = 0; step < 1_440; step ++ ) {

		const time = step / 120;
		const direction = {
			x: Math.cos( time * 0.31 ),
			y: Math.sin( time * 0.19 ) * 0.22,
			z: Math.sin( time * 0.31 ),
		};
		const root = {
			x: Math.sin( time * 0.47 ) * 0.18,
			y: 0.7 + Math.sin( time * 0.23 ) * 0.06,
			z: Math.cos( time * 0.29 ) * 0.12,
		};
		assert.equal( tail.setBaseDirection( direction, maxAngle ), tail );
		if ( step % 97 === 0 ) tail.applyImpulse( 1, { x: -8, y: 5, z: -7 } );
		tail.stepFixed( root );
		assert.ok(
			baseAngle( tail, direction ) <= maxAngle + 2e-5,
			'base segment escaped its structural cone at step ' + step,
		);
		maximumLengthError = Math.max( maximumLengthError, tail.maxSegmentError() );
		assertBuffersFinite( tail );

	}
	assert.ok(
		maximumLengthError < 0.002,
		'maximum segment error was ' + maximumLengthError,
	);
	assert.equal( tail.stats.invalidCorrections, 0 );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-010 root cone is deterministic, allocation-stable, and validates input', () => {

	const create = () => createPassiveTailPhysics( {
		gravity: { x: 0.3, y: -9.81, z: -0.2 },
		segmentLength: 0.055,
		damping: 1.4,
		solverIterations: 10,
	} );
	const first = create();
	const second = create();
	const firstView = first.getView();
	const firstPositions = first.positions;
	for ( let step = 0; step < 960; step ++ ) {

		const direction = {
			x: 0.8 + Math.cos( step * 0.017 ) * 0.15,
			y: Math.sin( step * 0.013 ) * 0.2,
			z: Math.sin( step * 0.017 ) * 0.3,
		};
		const root = {
			x: Math.sin( step * 0.009 ) * 0.1,
			y: 0.65,
			z: Math.cos( step * 0.007 ) * 0.08,
		};
		for ( const tail of [ first, second ] ) {

			tail.setBaseDirection( direction, Math.PI / 5 );
			if ( step === 80 || step === 410 )
				tail.applyImpulse( PASSIVE_TAIL_NODE_COUNT - 1, { x: -2, y: 3, z: 4 } );
			tail.stepFixed( root );

		}

	}
	assert.equal( first.getView(), firstView );
	assert.equal( first.positions, firstPositions );
	assert.deepEqual( Array.from( first.positions ), Array.from( second.positions ) );
	assert.deepEqual(
		Array.from( first.previousPositions ),
		Array.from( second.previousPositions ),
	);
	assert.equal( first.maxSegmentError(), second.maxSegmentError() );
	assertBuffersFinite( first );
	assertBuffersFinite( second );
	assert.throws(
		() => first.setBaseDirection( { x: 0, y: 0, z: 0 }, 0.5 ),
		/baseDirection/u,
	);
	assert.throws(
		() => first.setBaseDirection( { x: 1, y: 0, z: 0 }, -0.01 ),
		/maxAngle/u,
	);
	assert.throws(
		() => first.setBaseDirection( { x: 1, y: 0, z: 0 }, Math.PI + 0.01 ),
		/maxAngle/u,
	);

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-011 stable root enters deterministic sleep with zero residual jitter', () => {

	const callbackState = { calls: 0, stableScratch: true };
	const tail = createPassiveTailPhysics( {
		rootPosition: { x: 0, y: 0.6, z: 0 },
		segmentLength: 0.075,
		damping: 1.5,
		projectPoint: planeProjector( callbackState ),
	} );
	let sleepStep = -1;
	for ( let step = 0; step < 4_000; step ++ ) {

		tail.stepFixed();
		if ( tail.isSleeping() ) {

			sleepStep = step;
			break;

		}

	}
	assert.ok( sleepStep >= tail.sleepSteps, 'tail slept before the stability window' );
	assert.ok( sleepStep < 1_200, 'tail failed to settle promptly: step ' + sleepStep );
	assert.equal( tail.stats.sleeping, true );
	assert.equal( tail.stats.sleepCount, 1 );
	assert.equal( tail.stats.sleepCandidateSteps, tail.sleepSteps );
	assert.equal( tail.maxNodeSpeed(), 0 );
	assert.equal( tail.kineticEnergy(), 0 );
	const settled = tail.positions.slice();
	const collisionCallsAtSleep = callbackState.calls;
	let maximumSoakDisplacement = 0;
	for ( let step = 0; step < 20_000; step ++ ) {

		tail.stepFixed();
		for ( let index = 0; index < settled.length; index ++ )
			maximumSoakDisplacement = Math.max(
				maximumSoakDisplacement,
				Math.abs( tail.positions[ index ] - settled[ index ] ),
			);

	}
	assert.equal( maximumSoakDisplacement, 0 );
	assert.equal( tail.maxNodeSpeed(), 0 );
	assert.equal( tail.kineticEnergy(), 0 );
	assert.equal( callbackState.calls, collisionCallsAtSleep );
	assert.equal( callbackState.stableScratch, true );
	for ( let node = 1; node < PASSIVE_TAIL_NODE_COUNT; node ++ )
		assert.ok( tail.positions[ node * 3 + 1 ] >= tail.radii[ node ] - 2e-5 );
	assert.ok( tail.maxSegmentError() < 0.002 );
	assertBuffersFinite( tail );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-012 impulses, root motion, and cone motion wake sleeping tail immediately', () => {

	const root = { x: 0, y: 0.6, z: 0 };
	const tail = createPassiveTailPhysics( {
		rootPosition: root,
		segmentLength: 0.07,
		damping: 2.2,
		projectPoint: planeProjector(),
		baseDirection: { x: 1, y: 0, z: 0 },
		baseMaxAngle: 0.48,
	} );
	for ( let step = 0; step < 4_000 && ! tail.isSleeping(); step ++ ) tail.stepFixed();
	assert.equal( tail.isSleeping(), true );
	const sleepingTip = tail.positions.slice( -3 );
	tail.applyImpulse( PASSIVE_TAIL_NODE_COUNT - 1, { x: 0.4, y: 2.4, z: 1.1 } );
	assert.equal( tail.isSleeping(), false );
	assert.equal( tail.stats.wakeCount, 1 );
	tail.stepFixed();
	assert.ok( Math.hypot(
		tail.positions.at( -3 ) - sleepingTip[ 0 ],
		tail.positions.at( -2 ) - sleepingTip[ 1 ],
		tail.positions.at( -1 ) - sleepingTip[ 2 ],
	) > 1e-5 );
	assert.ok( tail.maxNodeSpeed() > 0 );

	for ( let step = 0; step < 8_000 && ! tail.isSleeping(); step ++ ) tail.stepFixed();
	assert.equal( tail.isSleeping(), true );
	const movedRoot = { x: 0.08, y: 0.63, z: -0.04 };
	tail.stepFixed( movedRoot );
	assert.equal( tail.isSleeping(), false );
	assert.equal( tail.stats.wakeCount, 2 );
	assert.ok( Math.abs( tail.positions[ 0 ] - movedRoot.x ) <= EPSILON );
	assert.ok( Math.abs( tail.positions[ 1 ] - movedRoot.y ) <= EPSILON );
	assert.ok( Math.abs( tail.positions[ 2 ] - movedRoot.z ) <= EPSILON );

	for ( let step = 0; step < 8_000 && ! tail.isSleeping(); step ++ )
		tail.stepFixed( movedRoot );
	assert.equal( tail.isSleeping(), true );
	const direction = { x: 0.2, y: 0.12, z: 1 };
	tail.setBaseDirection( direction, 0.38 );
	assert.equal( tail.isSleeping(), false );
	assert.equal( tail.stats.wakeCount, 3 );
	tail.stepFixed( movedRoot );
	assert.ok( baseAngle( tail, direction ) <= 0.38 + 2e-5 );
	assert.ok( tail.maxSegmentError() < 0.002 );
	assertBuffersFinite( tail );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-013 sleep and wake remain fixed-step invariant', () => {

	const create = () => createPassiveTailPhysics( {
		rootPosition: { x: 0, y: 0.55, z: 0 },
		segmentLength: 0.065,
		damping: 1.8,
		projectPoint: planeProjector(),
		baseDirection: { x: 1, y: 0, z: 0 },
		baseMaxAngle: 0.5,
	} );
	const slow = create();
	const fast = create();
	for ( let frame = 0; frame < 720; frame ++ ) slow.advance( 1 / 60 );
	for ( let frame = 0; frame < 2_880; frame ++ ) fast.advance( 1 / 240 );
	assert.equal( slow.isSleeping(), true );
	assert.equal( fast.isSleeping(), true );
	assert.equal( slow.stats.totalSteps, fast.stats.totalSteps );
	assert.equal( slow.stats.sleepCount, fast.stats.sleepCount );
	assert.deepEqual( Array.from( slow.positions ), Array.from( fast.positions ) );

	for ( const tail of [ slow, fast ] )
		tail.applyImpulse( PASSIVE_TAIL_NODE_COUNT - 1, { x: -0.5, y: 1.7, z: 0.8 } );
	for ( let frame = 0; frame < 300; frame ++ ) slow.advance( 1 / 60 );
	for ( let frame = 0; frame < 1_200; frame ++ ) fast.advance( 1 / 240 );
	assert.equal( slow.stats.totalSteps, fast.stats.totalSteps );
	assert.equal( slow.stats.sleepCount, fast.stats.sleepCount );
	assert.equal( slow.stats.wakeCount, fast.stats.wakeCount );
	assert.equal( slow.isSleeping(), fast.isSleeping() );
	assert.deepEqual( Array.from( slow.positions ), Array.from( fast.positions ) );
	assert.deepEqual(
		Array.from( slow.previousPositions ),
		Array.from( fast.previousPositions ),
	);
	assertBuffersFinite( slow );
	assertBuffersFinite( fast );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-014 legacy one-segment pin follows its root direction exactly', () => {

	const tail = createPassiveTailPhysics( {
		rootPosition: { x: 0.2, y: 0.5, z: -0.1 },
		segmentLength: 0.08,
		gravity: { x: 0, y: -9.81, z: 0 },
		pinBaseSegment: true,
		baseDirection: { x: 1, y: 0, z: 0 },
	} );
	assert.equal( tail.getView().kinematicNodeCount, 2 );
	assert.equal( tail.inverseMasses[ 0 ], 0 );
	assert.equal( tail.inverseMasses[ 1 ], 0 );
	assert.throws( () => tail.applyImpulse( 1, { x: 1, y: 0, z: 0 } ), /passive node/u );
	for ( let step = 0; step < 360; step ++ ) {

		const angle = step * 0.002;
		const root = { x: 0.2 + step * 0.0001, y: 0.5, z: -0.1 };
		const direction = { x: Math.cos( angle ), y: 0, z: Math.sin( angle ) };
		tail.setBaseDirection( direction, 0 );
		tail.stepFixed( root );
		assert.ok( Math.abs( tail.positions[ 3 ] - ( root.x + direction.x * 0.08 ) ) < 2e-6 );
		assert.ok( Math.abs( tail.positions[ 4 ] - root.y ) < 2e-6 );
		assert.ok( Math.abs( tail.positions[ 5 ] - ( root.z + direction.z * 0.08 ) ) < 2e-6 );
		assert.deepEqual(
			Array.from( tail.previousPositions.slice( 3, 6 ) ),
			Array.from( tail.positions.slice( 3, 6 ) ),
		);

	}
	assert.ok( tail.maxSegmentError() < 2e-4 );
	assertBuffersFinite( tail );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-015 three proximal segments use four exact allocation-stable kinematic anchors', () => {

	const tail = createPassiveTailPhysics( {
		rootPosition: { x: 0.2, y: 0.5, z: -0.1 },
		segmentLength: 0.08,
		gravity: { x: 0, y: -9.81, z: 0 },
		kinematicSegmentCount: 3,
	} );
	assert.equal( tail.kinematicSegmentCount, 3 );
	assert.equal( tail.kinematicNodeCount, 4 );
	assert.equal( tail.getView().kinematicNodeCount, 4 );
	const ownedAnchors = tail.kinematicAnchors;
	assert.equal( tail.getView().kinematicAnchors, ownedAnchors );
	for ( let node = 0; node < 4; node ++ ) assert.equal( tail.inverseMasses[ node ], 0 );
	assert.throws( () => tail.applyImpulse( 3, { x: 1, y: 0, z: 0 } ), /passive node/u );

	const anchors = new Float32Array( 12 );
	for ( let step = 0; step < 360; step ++ ) {

		const angle = step * 0.002;
		const directionX = Math.cos( angle );
		const directionZ = Math.sin( angle );
		const rootX = 0.2 + step * 0.0001;
		for ( let node = 0; node < 4; node ++ ) {

			const offset = node * 3;
			anchors[ offset ] = rootX + directionX * 0.08 * node;
			anchors[ offset + 1 ] = 0.5;
			anchors[ offset + 2 ] = -0.1 + directionZ * 0.08 * node;

		}
		assert.equal( tail.setKinematicAnchors( anchors ), tail );
		tail.stepFixed();
		for ( let index = 0; index < anchors.length; index ++ ) {

			assert.ok( Math.abs( tail.positions[ index ] - anchors[ index ] ) < 2e-6 );
			assert.equal( tail.previousPositions[ index ], tail.positions[ index ] );

		}
		assert.equal( tail.kinematicAnchors, ownedAnchors );

	}
	assert.ok( tail.maxSegmentError() < 2e-4 );
	assertBuffersFinite( tail );
	assert.throws(
		() => tail.setKinematicAnchors( new Float32Array( 9 ) ),
		/kinematicAnchors/u,
	);
	assert.throws(
		() => createPassiveTailPhysics( { kinematicSegmentCount: 12 } ),
		/kinematicSegmentCount/u,
	);

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-016 external projections stay bounded and sleeping tail ignores sub-threshold anchor noise', () => {

	const callbackState = { calls: 0, stableScratch: true };
	const tail = createPassiveTailPhysics( {
		rootPosition: { x: 0, y: 0.6, z: 0 },
		segmentLength: 0.065,
		damping: 2.2,
		solverIterations: 20,
		kinematicSegmentCount: 3,
		projectPoint: planeProjector( callbackState ),
	} );
	const minimumCallsPerAwakeStep = PASSIVE_TAIL_NODE_COUNT - 4;
	for ( let step = 0; step < 24; step ++ ) tail.stepFixed();
	assert.ok( callbackState.calls >= 24 * minimumCallsPerAwakeStep );
	assert.ok( callbackState.calls <= 24 * ( minimumCallsPerAwakeStep + 3 ) );
	for ( let step = 24; step < 8_000 && ! tail.isSleeping(); step ++ ) tail.stepFixed();
	assert.equal( tail.isSleeping(), true );
	assert.equal( tail.maxNodeSpeed(), 0 );
	assert.equal( tail.kineticEnergy(), 0 );

	const anchors = tail.kinematicAnchors.slice();
	const passivePose = tail.positions.slice( 12 );
	const callsAtSleep = callbackState.calls;
	const wakeCount = tail.stats.wakeCount;
	for ( let step = 0; step < 20_000; step ++ ) {

		const offset = ( step & 1 ? -1 : 1 ) * tail.sleepRootThreshold * 0.25;
		for ( let node = 0; node < 4; node ++ ) {

			const scalar = node * 3;
			anchors[ scalar ] = tail.restOffsets[ scalar ] + offset;
			anchors[ scalar + 1 ] = 0.6 + tail.restOffsets[ scalar + 1 ];
			anchors[ scalar + 2 ] = tail.restOffsets[ scalar + 2 ];

		}
		tail.setKinematicAnchors( anchors );
		tail.stepFixed();
		assert.equal( tail.isSleeping(), true );

	}
	assert.deepEqual( Array.from( tail.positions.slice( 12 ) ), Array.from( passivePose ) );
	assert.equal( tail.stats.wakeCount, wakeCount );
	assert.equal( callbackState.calls, callsAtSleep );
	assert.equal( tail.maxNodeSpeed(), 0 );
	assert.equal( tail.kineticEnergy(), 0 );
	assert.equal( callbackState.stableScratch, true );
	assertBuffersFinite( tail );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-017 graded collar settles without hidden Verlet spin', () => {

	const tail = createPassiveTailPhysics( {
		rootPosition: { x: 0, y: 0.6, z: 0 },
		segmentLength: 0.065,
		kinematicSegmentCount: 2,
		bendCompliance: 5e-6,
		bendComplianceProfile: [ 0.04, 0.12, 0.35, 0.7, 1, 1, 1, 1, 1, 1, 1 ],
		damping: 3.2,
		collisionFriction: 0.68,
		collisionStaticFrictionSpeed: 0.055,
		projectPoint: planeProjector(),
		sleepEnabled: false,
	} );
	assert.equal( tail.kinematicNodeCount, 3 );
	assert.deepEqual(
		Array.from( tail.bendComplianceScales.slice( 0, 5 ) ),
		Array.from( new Float32Array( [ 0.04, 0.12, 0.35, 0.7, 1 ] ) ),
	);
	assert.throws( () => tail.applyImpulse( 2, { x: 0, y: 1, z: 0 } ), /passive node/u );
	tail.applyImpulse( 3, { x: 0, y: 0.35, z: 0.18 } );
	for ( let step = 0; step < 3_600; step ++ ) tail.stepFixed();
	let maximumVerletSpeed = 0;
	for ( let node = tail.kinematicNodeCount; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

		const offset = node * 3;
		maximumVerletSpeed = Math.max( maximumVerletSpeed, Math.hypot(
			tail.positions[ offset ] - tail.previousPositions[ offset ],
			tail.positions[ offset + 1 ] - tail.previousPositions[ offset + 1 ],
			tail.positions[ offset + 2 ] - tail.previousPositions[ offset + 2 ],
		) / tail.fixedDt );

	}
	assert.ok( maximumVerletSpeed < 0.001, `hidden tail speed ${ maximumVerletSpeed }` );
	assert.ok( tail.kineticEnergy() < 1e-6, `residual tail energy ${ tail.kineticEnergy() }` );
	assert.ok( tail.maxSegmentError() < 0.006 );
	assertBuffersFinite( tail );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-018 one-segment collar releases the tail near the rump with graded physical stiffness', () => {

	const tail = createPassiveTailPhysics( {
		rootPosition: { x: 0, y: 0.45, z: 0 },
		segmentLength: 0.065,
		kinematicSegmentCount: 1,
		bendComplianceProfile: [ 0.03, 0.1, 0.28, 0.58, 0.82, 1, 1, 1, 1, 1, 1 ],
	} );
	assert.equal( tail.kinematicNodeCount, 2 );
	assert.equal( tail.inverseMasses[ 1 ], 0 );
	assert.ok( tail.inverseMasses[ 2 ] > 0 );
	assert.deepEqual(
		Array.from( tail.bendComplianceScales.slice( 0, 6 ) ),
		Array.from( new Float32Array( [ 0.03, 0.1, 0.28, 0.58, 0.82, 1 ] ) ),
	);
	assert.throws( () => tail.applyImpulse( 1, { x: 0, y: 1, z: 0 } ), /passive node/u );
	assert.doesNotThrow( () => tail.applyImpulse( 2, { x: 0, y: 1, z: 0 } ) );
	const explicitAnchors = new Float32Array( [
		0.17, 0.53, -0.09,
		0.205, 0.487, -0.057,
	] );
	tail.setKinematicAnchors( explicitAnchors );
	tail.stepFixed();
	assert.deepEqual(
		Array.from( tail.positions.slice( 0, explicitAnchors.length ) ),
		Array.from( explicitAnchors ),
		'explicit skeleton anchors must not be rebuilt from the legacy root direction',
	);
	assert.deepEqual(
		Array.from( tail.previousPositions.slice( 0, explicitAnchors.length ) ),
		Array.from( explicitAnchors ),
		'explicit skeleton anchors must have zero synthetic Verlet velocity',
	);
	for ( let step = 0; step < 1_200; step ++ ) tail.stepFixed();
	assert.ok( tail.maxSegmentError() < 0.001 );
	assertBuffersFinite( tail );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-019 violent tunnel impacts stay inside every support plane', () => {

	const halfWidth = 0.18;
	const ceiling = 0.5;
	const tail = createPassiveTailPhysics( {
		rootPosition: { x: 0, y: 0.25, z: 0 },
		segmentLength: 0.06,
		kinematicSegmentCount: 1,
		damping: 3.2,
		collisionFriction: 0.72,
		projectPoint: tunnelProjector( halfWidth, ceiling ),
		sleepEnabled: false,
	} );
	tail.applyImpulse( PASSIVE_TAIL_NODE_COUNT - 1, { x: 0, y: 18, z: 22 } );
	for ( let step = 0; step < 2_400; step ++ ) {

		tail.stepFixed();
		for ( let node = tail.kinematicNodeCount; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

			const offset = node * 3;
			assert.ok( tail.positions[ offset + 1 ] >= tail.radii[ node ] - 2e-5 );
			assert.ok( tail.positions[ offset + 1 ] <= ceiling - tail.radii[ node ] + 2e-5 );
			assert.ok( Math.abs( tail.positions[ offset + 2 ] )
				<= halfWidth - tail.radii[ node ] + 2e-5 );

		}

	}
	assert.ok( tail.kineticEnergy() < 1e-5, `tunnel residual ${ tail.kineticEnergy() }` );
	assert.ok( tail.maxSegmentError() < 0.007 );
	assertBuffersFinite( tail );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-020 curved support protects links and damps corkscrew motion', () => {

	const center = { x: 0.35, y: 0.1, z: 0 };
	const sphereRadius = 0.1;
	const tail = createPassiveTailPhysics( {
		rootPosition: { x: 0, y: 0.35, z: 0 },
		segmentLength: 0.065,
		kinematicSegmentCount: 1,
		bendCompliance: 5e-6,
		bendComplianceProfile: [ 0.04, 0.12, 0.35, 0.7, 1, 1, 1, 1, 1, 1, 1 ],
		damping: 3.2,
		collisionFriction: 0.68,
		collisionStaticFrictionSpeed: 0.055,
		projectPoint: sphereFloorProjector( center, sphereRadius ),
		sleepEnabled: false,
	} );
	tail.applyImpulse( PASSIVE_TAIL_NODE_COUNT - 1, { x: 0, y: 0, z: 2 } );
	for ( let step = 0; step < 10_000; step ++ ) tail.stepFixed();
	for ( let segment = tail.kinematicNodeCount - 1;
		segment < PASSIVE_TAIL_SEGMENT_COUNT; segment ++ ) {

		const first = segment * 3;
		const second = first + 3;
		const midpointX = ( tail.positions[ first ] + tail.positions[ second ] ) * 0.5;
		const midpointY = ( tail.positions[ first + 1 ] + tail.positions[ second + 1 ] ) * 0.5;
		const midpointZ = ( tail.positions[ first + 2 ] + tail.positions[ second + 2 ] ) * 0.5;
		const midpointRadius = ( tail.radii[ segment ] + tail.radii[ segment + 1 ] ) * 0.5;
		assert.ok(
			Math.hypot(
				midpointX - center.x,
				midpointY - center.y,
				midpointZ - center.z,
			) - midpointRadius >= sphereRadius - 2e-5,
			`tail link ${ segment } entered curved support`,
		);

	}
	assert.ok( tail.kineticEnergy() < 1e-6, `corkscrew energy ${ tail.kineticEnergy() }` );
	assert.ok( tail.maxNodeSpeed() < 0.001, `corkscrew speed ${ tail.maxNodeSpeed() }` );
	assert.ok( tail.maxSegmentError() < 0.006 );
	assertBuffersFinite( tail );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-021 leaving a finite coplanar support clears its cached friction', () => {

	const halfExtent = 0.1;
	const finiteSupport = ( point, radius, outPoint, outNormal ) => {

		if ( Math.abs( point.x ) > halfExtent || Math.abs( point.z ) > halfExtent
			|| point.y >= radius ) return false;
		outPoint.x = point.x;
		outPoint.y = radius;
		outPoint.z = point.z;
		outNormal.x = 0;
		outNormal.y = 1;
		outNormal.z = 0;
		return true;

	};
	const tail = createPassiveTailPhysics( {
		segmentLength: 0.06,
		gravity: { x: 0, y: 0, z: 0 },
		damping: 0,
		internalDamping: 0,
		torsionDamping: 0,
		stretchCompliance: 1e6,
		bendCompliance: 1e6,
		solverIterations: 1,
		collisionFriction: 1,
		collisionStaticFrictionSpeed: 100,
		sleepEnabled: false,
		projectPoint: finiteSupport,
	} );
	const node = PASSIVE_TAIL_NODE_COUNT - 1;
	const offset = node * 3;
	const radius = tail.radii[ node ];

	// Establish a cached horizontal contact plane inside the finite patch.
	tail.positions[ offset ] = 0;
	tail.positions[ offset + 1 ] = radius - 0.01;
	tail.positions[ offset + 2 ] = 0;
	tail.previousPositions.set( tail.positions );
	tail.stepFixed();
	assert.equal( tail._collisionActive[ node ], 1 );

	// Move the node beyond the patch edge while it remains exactly coplanar.
	// The next integration tick carries 1 cm of tangential Verlet displacement.
	// A stale infinite plane would erase that displacement as static friction.
	tail.positions[ offset ] = 0.3;
	tail.positions[ offset + 1 ] = radius;
	tail.positions[ offset + 2 ] = 0;
	tail.previousPositions[ offset ] = 0.29;
	tail.previousPositions[ offset + 1 ] = radius;
	tail.previousPositions[ offset + 2 ] = 0;
	tail.stepFixed();

	assert.equal( tail._collisionActive[ node ], 0,
		'the cached contact must end at the finite collider boundary' );
	assert.ok(
		Math.abs( tail.positions[ offset ] - tail.previousPositions[ offset ] - 0.01 ) < 5e-5,
		'coplanar motion outside the collider was consumed by ghost friction',
	);
	assertBuffersFinite( tail );

} );

test( 'CHAMELEON-LAB-PASSIVE-TAIL-022 segment projection cannot push a node into an adjacent collider', () => {

	const floorTop = 0.2;
	const ceilingBottom = 0.22;
	const halfExtent = 0.035;
	const ceilingX = 0.1;
	const adjacentProjector = ( point, radius, outPoint, outNormal ) => {

		let bestCorrection = 0;
		outPoint.x = point.x;
		outPoint.y = point.y;
		outPoint.z = point.z;
		if ( Math.abs( point.x ) <= halfExtent && Math.abs( point.z ) <= 0.1 ) {

			const correction = floorTop + radius - point.y;
			if ( correction > bestCorrection ) {

				bestCorrection = correction;
				outPoint.y = floorTop + radius;
				outNormal.x = 0;
				outNormal.y = 1;
				outNormal.z = 0;

			}

		}
		if ( Math.abs( point.x - ceilingX ) <= halfExtent
			&& Math.abs( point.z ) <= 0.1 ) {

			const correction = point.y - ( ceilingBottom - radius );
			if ( correction > bestCorrection ) {

				bestCorrection = correction;
				outPoint.x = point.x;
				outPoint.y = ceilingBottom - radius;
				outPoint.z = point.z;
				outNormal.x = 0;
				outNormal.y = -1;
				outNormal.z = 0;

			}

		}
		return bestCorrection > 0;

	};
	const tail = createPassiveTailPhysics( {
		rootPosition: { x: -0.1, y: 0.15, z: 0 },
		segmentLength: 0.2,
		gravity: { x: 0, y: 0, z: 0 },
		damping: 0,
		internalDamping: 0,
		torsionDamping: 0,
		solverIterations: 1,
		collisionFriction: 0,
		sleepEnabled: false,
		projectPoint: adjacentProjector,
	} );
	const node = 1;
	const offset = node * 3;
	const maximumY = ceilingBottom - tail.radii[ node ];
	assert.ok( tail.positions[ offset + 1 ] < maximumY,
		'test setup starts inside the adjacent ceiling' );

	// Segment zero spans the narrow floor patch although both endpoints are
	// outside it. Its midpoint correction moves node one upward into the adjacent
	// ceiling, which must be caught by a final endpoint reconciliation pass.
	tail.stepFixed();
	assert.ok(
		tail.positions[ offset + 1 ] <= maximumY + 2e-5,
		`segment correction left node ${ node } ${ tail.positions[ offset + 1 ] - maximumY } m inside the adjacent ceiling`,
	);
	assertBuffersFinite( tail );

} );
