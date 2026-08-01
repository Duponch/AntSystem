import assert from 'node:assert/strict';
import test from 'node:test';

import {
	PASSIVE_LIMB_COMPONENT_COUNT,
	PASSIVE_LIMB_COUNT,
	PASSIVE_LIMB_NODE_COUNT,
	PASSIVE_LIMB_SEGMENT_COUNT,
	PassiveLimbRagdoll,
} from '../src/chameleon-lab/passive-limb-ragdoll.js';

function createInitialPositions() {

	const positions = new Float32Array( PASSIVE_LIMB_COMPONENT_COUNT );
	const roots = [
		[ -0.28, 0.92, -0.18, -1, -1 ],
		[ -0.28, 0.92, 0.18, -1, 1 ],
		[ 0.28, 0.92, -0.18, 1, -1 ],
		[ 0.28, 0.92, 0.18, 1, 1 ],
	];
	for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

		const [ x, y, z, sx, sz ] = roots[ limb ];
		const values = [
			x, y, z,
			x + sx * 0.06, y - 0.05, z + sz * 0.035,
			x + sx * 0.13, y - 0.17, z + sz * 0.07,
			x + sx * 0.085, y - 0.30, z + sz * 0.115,
			x + sx * 0.12, y - 0.40, z + sz * 0.165,
		];
		positions.set( values, limb * PASSIVE_LIMB_NODE_COUNT * 3 );

	}
	return positions;

}

function scalarOffset( limb, node ) {

	return ( limb * PASSIVE_LIMB_NODE_COUNT + node ) * 3;

}

function distance( positions, first, second ) {

	return Math.hypot(
		positions[ second ] - positions[ first ],
		positions[ second + 1 ] - positions[ first + 1 ],
		positions[ second + 2 ] - positions[ first + 2 ],
	);

}

function pointCapsuleDistance( positions, pointOffset, capsule ) {

	const abX = capsule[ 3 ] - capsule[ 0 ];
	const abY = capsule[ 4 ] - capsule[ 1 ];
	const abZ = capsule[ 5 ] - capsule[ 2 ];
	const apX = positions[ pointOffset ] - capsule[ 0 ];
	const apY = positions[ pointOffset + 1 ] - capsule[ 1 ];
	const apZ = positions[ pointOffset + 2 ] - capsule[ 2 ];
	const denominator = abX * abX + abY * abY + abZ * abZ;
	const t = Math.max( 0, Math.min( 1,
		( apX * abX + apY * abY + apZ * abZ ) / denominator,
	) );
	return Math.hypot(
		positions[ pointOffset ] - ( capsule[ 0 ] + abX * t ),
		positions[ pointOffset + 1 ] - ( capsule[ 1 ] + abY * t ),
		positions[ pointOffset + 2 ] - ( capsule[ 2 ] + abZ * t ),
	);

}

function segmentDistance( positions, firstOffset, secondOffset, thirdOffset, fourthOffset ) {

	const ux = positions[ secondOffset ] - positions[ firstOffset ];
	const uy = positions[ secondOffset + 1 ] - positions[ firstOffset + 1 ];
	const uz = positions[ secondOffset + 2 ] - positions[ firstOffset + 2 ];
	const vx = positions[ fourthOffset ] - positions[ thirdOffset ];
	const vy = positions[ fourthOffset + 1 ] - positions[ thirdOffset + 1 ];
	const vz = positions[ fourthOffset + 2 ] - positions[ thirdOffset + 2 ];
	const wx = positions[ firstOffset ] - positions[ thirdOffset ];
	const wy = positions[ firstOffset + 1 ] - positions[ thirdOffset + 1 ];
	const wz = positions[ firstOffset + 2 ] - positions[ thirdOffset + 2 ];
	const a = ux * ux + uy * uy + uz * uz;
	const b = ux * vx + uy * vy + uz * vz;
	const c = vx * vx + vy * vy + vz * vz;
	const d = ux * wx + uy * wy + uz * wz;
	const e = vx * wx + vy * wy + vz * wz;
	const denominator = a * c - b * b;
	let firstParameter = denominator > 1e-9 ? ( b * e - c * d ) / denominator : 0;
	firstParameter = Math.max( 0, Math.min( 1, firstParameter ) );
	let secondParameter = ( b * firstParameter + e ) / c;
	if ( secondParameter < 0 ) {

		secondParameter = 0;
		firstParameter = Math.max( 0, Math.min( 1, -d / a ) );

	} else if ( secondParameter > 1 ) {

		secondParameter = 1;
		firstParameter = Math.max( 0, Math.min( 1, ( b - d ) / a ) );

	}
	return Math.hypot(
		positions[ firstOffset ] + ux * firstParameter
			- positions[ thirdOffset ] - vx * secondParameter,
		positions[ firstOffset + 1 ] + uy * firstParameter
			- positions[ thirdOffset + 1 ] - vy * secondParameter,
		positions[ firstOffset + 2 ] + uz * firstParameter
			- positions[ thirdOffset + 2 ] - vz * secondParameter,
	);

}

function rootMeanSquareDrift( positions, targets ) {

	let squareSum = 0;
	let count = 0;
	for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

		for ( let node = 1; node < PASSIVE_LIMB_NODE_COUNT; node ++ ) {

			const offset = scalarOffset( limb, node );
			for ( let component = 0; component < 3; component ++ ) {

				const delta = positions[ offset + component ] - targets[ offset + component ];
				squareSum += delta * delta;
				count ++;

			}

		}

	}
	return Math.sqrt( squareSum / count );

}

function assertFiniteAndConstrained( ragdoll, tolerance = 0.004 ) {

	assert.equal( ragdoll.isFinite(), true );
	assert.ok( ragdoll.maxSegmentError() <= tolerance,
		`segment error ${ ragdoll.maxSegmentError() }` );
	for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

		for ( let bend = 0; bend < PASSIVE_LIMB_NODE_COUNT - 2; bend ++ ) {

			const first = scalarOffset( limb, bend );
			const third = scalarOffset( limb, bend + 2 );
			const chord = distance( ragdoll.positions, first, third );
			const index = limb * ( PASSIVE_LIMB_NODE_COUNT - 2 ) + bend;
			assert.ok(
				chord >= ragdoll.bendMinimumLengths[ index ] - tolerance,
				`limb ${ limb } bend ${ bend } folded past its ligament`,
			);
			assert.ok(
				chord <= ragdoll.bendMaximumLengths[ index ] + tolerance,
				`limb ${ limb } bend ${ bend } hyperextended`,
			);

		}

	}

}

function groundProjector( state = null ) {

	return ( point, radius, outPoint, outNormal ) => {

		if ( state ) {

			state.calls ++;
			state.point ??= point;
			state.outPoint ??= outPoint;
			state.outNormal ??= outNormal;
			if ( point !== state.point || outPoint !== state.outPoint
				|| outNormal !== state.outNormal ) state.stableScratch = false;

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

test( 'CHAMELEON-LAB-PASSIVE-LIMBS-001 owns four five-node chains and stable hot-path views', () => {

	const ragdoll = new PassiveLimbRagdoll( {
		initialPositions: createInitialPositions(),
		gravity: { x: 0, y: 0, z: 0 },
	} );
	assert.equal( PASSIVE_LIMB_COUNT, 4 );
	assert.equal( PASSIVE_LIMB_NODE_COUNT, 5 );
	assert.equal( PASSIVE_LIMB_SEGMENT_COUNT, 4 );
	assert.equal( PASSIVE_LIMB_COMPONENT_COUNT, 60 );
	const view = ragdoll.getView();
	const stats = ragdoll.stats;
	const identities = {
		view,
		stats,
		positions: view.positions,
		previous: view.previousPositions,
		interpolated: view.interpolatedPositions,
		roots: view.rootAnchors,
		segments: view.segmentLengths,
		bendMinimum: view.bendMinimumLengths,
		bendMaximum: view.bendMaximumLengths,
		radii: view.radii,
	};
	for ( let step = 0; step < 2_000; step ++ ) {

		assert.equal( ragdoll.stepFixed(), identities.view );
		assert.equal( ragdoll.getView(), identities.view );
		assert.equal( ragdoll.stats, identities.stats );

	}
	assert.equal( ragdoll.positions, identities.positions );
	assert.equal( ragdoll.renderPreviousPositions, identities.previous );
	assert.equal( ragdoll.interpolatedPositions, identities.interpolated );
	assert.equal( ragdoll.rootAnchors, identities.roots );
	assert.equal( ragdoll.segmentLengths, identities.segments );
	assert.equal( ragdoll.bendMinimumLengths, identities.bendMinimum );
	assert.equal( ragdoll.bendMaximumLengths, identities.bendMaximum );
	assert.equal( ragdoll.radii, identities.radii );
	assert.equal( stats.steps, 2_000 );
	assert.equal( stats.invalidCorrections, 0 );
	assert.equal( ragdoll.interpolate( 0.5 ), identities.interpolated );
	assert.equal( ragdoll.interpolate( 0.5 ), identities.interpolated );
	assertFiniteAndConstrained( ragdoll );

} );

test( 'CHAMELEON-LAB-PASSIVE-LIMBS-002 roots are kinematic while gravity passively droops every free limb', () => {

	const initial = createInitialPositions();
	const ragdoll = new PassiveLimbRagdoll( {
		initialPositions: initial,
		damping: 1.2,
		solverIterations: 12,
	} );
	const initialFreeCentreY = Array.from( { length: PASSIVE_LIMB_COUNT }, ( _, limb ) => {

		let sum = 0;
		for ( let node = 1; node < PASSIVE_LIMB_NODE_COUNT; node ++ )
			sum += initial[ scalarOffset( limb, node ) + 1 ];
		return sum / ( PASSIVE_LIMB_NODE_COUNT - 1 );

	} );
	for ( let step = 0; step < 180; step ++ ) ragdoll.stepFixed();
	for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

		const root = scalarOffset( limb, 0 );
		const anchor = limb * 3;
		assert.equal( ragdoll.positions[ root ], ragdoll.rootAnchors[ anchor ] );
		assert.equal( ragdoll.positions[ root + 1 ], ragdoll.rootAnchors[ anchor + 1 ] );
		assert.equal( ragdoll.positions[ root + 2 ], ragdoll.rootAnchors[ anchor + 2 ] );
		let finalCentreY = 0;
		for ( let node = 1; node < PASSIVE_LIMB_NODE_COUNT; node ++ )
			finalCentreY += ragdoll.positions[ scalarOffset( limb, node ) + 1 ];
		finalCentreY /= PASSIVE_LIMB_NODE_COUNT - 1;
		assert.ok( finalCentreY < initialFreeCentreY[ limb ] - 0.05,
			`limb ${ limb } did not droop under gravity` );

	}
	assertFiniteAndConstrained( ragdoll );

} );

test( 'CHAMELEON-LAB-PASSIVE-LIMBS-003 impulse creates bounded inertial motion without breaking ligaments', () => {

	const ragdoll = new PassiveLimbRagdoll( {
		initialPositions: createInitialPositions(),
		gravity: { x: 0, y: 0, z: 0 },
		damping: 0.35,
		solverIterations: 12,
		maxSpeed: 6,
	} );
	const tip = scalarOffset( 2, PASSIVE_LIMB_NODE_COUNT - 1 );
	const before = ragdoll.positions[ tip + 2 ];
	ragdoll.applyImpulse( 2, PASSIVE_LIMB_NODE_COUNT - 1, { x: 0.5, y: 1.5, z: 2.5 } );
	ragdoll.stepFixed();
	const first = ragdoll.positions[ tip + 2 ];
	ragdoll.stepFixed();
	const second = ragdoll.positions[ tip + 2 ];
	assert.ok( first > before );
	assert.ok( second > first, 'the impulse must retain inertia for more than one step' );
	for ( let step = 0; step < 600; step ++ ) {

		ragdoll.stepFixed();
		assertFiniteAndConstrained( ragdoll );

	}
	assert.equal( ragdoll.stats.invalidCorrections, 0 );

} );

test( 'CHAMELEON-LAB-PASSIVE-LIMBS-004 all free nodes settle outside the ground plane', () => {

	const state = { calls: 0, stableScratch: true };
	const ragdoll = new PassiveLimbRagdoll( {
		initialPositions: createInitialPositions(),
		damping: 2.4,
		solverIterations: 12,
		collisionFriction: 0.55,
	} );
	const project = groundProjector( state );
	for ( let step = 0; step < 1_200; step ++ ) ragdoll.stepFixed( null, project );
	for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

		for ( let node = 1; node < PASSIVE_LIMB_NODE_COUNT; node ++ ) {

			const scalar = limb * PASSIVE_LIMB_NODE_COUNT + node;
			assert.ok(
				ragdoll.positions[ scalar * 3 + 1 ] >= ragdoll.radii[ scalar ] - 1e-6,
				`limb ${ limb } node ${ node } penetrated the ground`,
			);

		}

	}
	assert.equal(
		state.calls,
		1_200 * PASSIVE_LIMB_COUNT * ( PASSIVE_LIMB_NODE_COUNT - 1 ),
		'external scene projection must run once per free node and fixed step',
	);
	assert.equal( state.stableScratch, true );
	assert.equal( ragdoll.stats.invalidCorrections, 0 );
	assertFiniteAndConstrained( ragdoll, 0.01 );

} );

test( 'CHAMELEON-LAB-PASSIVE-LIMBS-005 fixed-step evolution is bit-identical across instances', () => {

	const create = () => new PassiveLimbRagdoll( {
		initialPositions: createInitialPositions(),
		damping: 1.4,
		solverIterations: 10,
	} );
	const first = create();
	const second = create();
	first.applyImpulse( 0, 4, { x: 0.9, y: 1.2, z: -0.5 } );
	second.applyImpulse( 0, 4, { x: 0.9, y: 1.2, z: -0.5 } );
	const projectorA = groundProjector();
	const projectorB = groundProjector();
	for ( let step = 0; step < 1_000; step ++ ) {

		first.stepFixed( null, projectorA );
		second.stepFixed( null, projectorB );

	}
	for ( const key of [ 'positions', 'previousPositions', 'renderPreviousPositions' ] )
		assert.deepEqual( Array.from( first[ key ] ), Array.from( second[ key ] ), key );
	assert.deepEqual( first.stats, second.stats );
	assertFiniteAndConstrained( first, 0.01 );
	assertFiniteAndConstrained( second, 0.01 );

} );

test( 'CHAMELEON-LAB-PASSIVE-LIMBS-006 invalid collision output is rejected without NaN', () => {

	const ragdoll = new PassiveLimbRagdoll( {
		initialPositions: createInitialPositions(),
	} );
	const invalidProjector = ( point, radius, outPoint, outNormal ) => {

		outPoint.x = Number.NaN;
		outPoint.y = point.y + radius;
		outPoint.z = point.z;
		outNormal.x = 0;
		outNormal.y = Number.NaN;
		outNormal.z = 0;
		return true;

	};
	for ( let step = 0; step < 120; step ++ ) {

		ragdoll.stepFixed( null, invalidProjector );
		assert.equal( ragdoll.isFinite(), true );

	}
	assert.ok( ragdoll.stats.invalidCorrections > 0 );
	assert.throws( () => ragdoll.applyImpulse( 4, 1, {} ), /limb/u );
	assert.throws( () => ragdoll.interpolate( Number.NaN ), /alpha/u );

} );

test( 'CHAMELEON-LAB-PASSIVE-LIMBS-007 configurable low muscle tone follows stable rest targets without becoming rigid', () => {

	const targets = createInitialPositions();
	const create = muscleTone => new PassiveLimbRagdoll( {
		initialPositions: targets,
		muscleTone,
		damping: 1.6,
		solverIterations: 10,
	} );
	const floppy = create( 0 );
	const toned = create( 0.18 );
	assert.notEqual( toned.muscleTargets, targets, 'targets must be copied into owned storage' );
	const ownedTargets = toned.muscleTargets;
	const view = toned.getView();
	assert.equal( view.muscleTargets, ownedTargets );
	assert.equal( toned.setMuscleTargets( targets ), toned );
	assert.equal( toned.setMuscleTone( 0.18 ), toned );
	for ( let step = 0; step < 360; step ++ ) {

		floppy.stepFixed();
		targets[ scalarOffset( 0, 4 ) + 2 ] += Math.sin( step * 0.02 ) * 1e-5;
		assert.equal( toned.setMuscleTargets( targets ), toned );
		assert.equal( toned.stepFixed(), view );
		assert.equal( toned.muscleTargets, ownedTargets );

	}
	const floppyDrift = rootMeanSquareDrift( floppy.positions, targets );
	const tonedDrift = rootMeanSquareDrift( toned.positions, targets );
	assert.ok( floppyDrift > 0.05, 'gravity fixture did not produce a passive droop' );
	assert.ok(
		tonedDrift < floppyDrift * 0.7,
		`low tone did not retain anatomy: toned=${ tonedDrift }, floppy=${ floppyDrift }`,
	);
	assert.ok( tonedDrift > 0.002, 'low tone must remain compliant rather than lock the pose' );
	assertFiniteAndConstrained( toned, 0.01 );
	assert.throws( () => toned.setMuscleTone( -0.01 ), /muscleTone/u );
	assert.throws( () => toned.setMuscleTone( 1.01 ), /muscleTone/u );
	assert.throws(
		() => toned.setMuscleTargets( new Float32Array( 3 ) ),
		/muscleTargets/u,
	);

} );

test( 'CHAMELEON-LAB-PASSIVE-LIMBS-008 capsule constraints keep distal limbs outside the torso and each other', () => {

	const initial = createInitialPositions();
	initial.set( [
		-0.35, 0.9, -0.2,
		-0.3, 0.75, -0.15,
		-0.18, 0.6, 0,
		0.18, 0.6, 0,
		0.28, 0.48, 0.08,
	], scalarOffset( 0, 0 ) );
	initial.set( [
		-0.35, 0.9, 0.2,
		-0.3, 0.75, 0.15,
		0, 0.6, -0.18,
		0, 0.6, 0.18,
		0.08, 0.48, 0.28,
	], scalarOffset( 1, 0 ) );
	// Packed capsule layout: endpoint A xyz, endpoint B xyz, radius.
	const torsoCapsules = new Float32Array( [
		-0.24, 0.48, 0.08, 0.24, 0.48, 0.08, 0.095,
	] );
	const radii = new Float32Array(
		PASSIVE_LIMB_COUNT * PASSIVE_LIMB_NODE_COUNT,
	).fill( 0.035 );
	const ragdoll = new PassiveLimbRagdoll( {
		initialPositions: initial,
		radii,
		bodyCapsules: torsoCapsules,
		selfCollision: true,
		selfCollisionMargin: 0.004,
		muscleTone: 0,
		gravity: { x: 0, y: 0, z: 0 },
		damping: 2.5,
		solverIterations: 12,
		minimumBend: 0.01,
		maximumBend: 3,
	} );
	const ownedCapsules = ragdoll.bodyCapsules;
	assert.notEqual( ownedCapsules, torsoCapsules );
	assert.equal( ragdoll.getView().bodyCapsules, ownedCapsules );
	for ( let step = 0; step < 180; step ++ ) ragdoll.stepFixed();

	const firstSegmentStart = scalarOffset( 0, 2 );
	const firstSegmentEnd = scalarOffset( 0, 3 );
	const secondSegmentStart = scalarOffset( 1, 2 );
	const secondSegmentEnd = scalarOffset( 1, 3 );
	const separation = segmentDistance(
		ragdoll.positions,
		firstSegmentStart, firstSegmentEnd, secondSegmentStart, secondSegmentEnd,
	);
	assert.ok(
		separation >= radii[ 2 ] + radii[ PASSIVE_LIMB_NODE_COUNT + 2 ] + 0.004 - 0.003,
		`crossed limb capsules remain interwoven: clearance=${ separation }`,
	);
	const torsoNode = scalarOffset( 0, 4 );
	assert.ok(
		pointCapsuleDistance( ragdoll.positions, torsoNode, torsoCapsules )
			>= torsoCapsules[ 6 ] + radii[ 4 ] - 0.003,
		'distal limb remained embedded in the torso capsule',
	);
	assert.ok( ragdoll.stats.selfCollisionCorrections > 0 );
	assert.ok( ragdoll.stats.bodyCollisionCorrections > 0 );
	assert.equal( ragdoll.bodyCapsules, ownedCapsules );
	assertFiniteAndConstrained( ragdoll, 0.012 );

} );

test( 'CHAMELEON-LAB-PASSIVE-LIMBS-009 external scene projections are bounded independently of XPBD iterations', () => {

	const run = solverIterations => {

		const state = { calls: 0, stableScratch: true };
		const ragdoll = new PassiveLimbRagdoll( {
			initialPositions: createInitialPositions(),
			gravity: { x: 0, y: 0, z: 0 },
			solverIterations,
		} );
		const projector = groundProjector( state );
		for ( let step = 0; step < 40; step ++ ) ragdoll.stepFixed( null, projector );
		return state;

	};
	const low = run( 2 );
	const high = run( 24 );
	const expected = 40 * PASSIVE_LIMB_COUNT * ( PASSIVE_LIMB_NODE_COUNT - 1 );
	assert.equal( low.calls, expected );
	assert.equal( high.calls, expected );
	assert.equal( low.stableScratch, true );
	assert.equal( high.stableScratch, true );

} );
