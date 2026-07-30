import assert from 'node:assert/strict';
import test from 'node:test';

import {
	CHAMELEON_BODY_CONSTRAINT_CAPACITY,
	ChameleonBodyContactSolver,
} from '../src/chameleon-body-contact.js';
import {
	CHAMELEON_TAIL_CONSTRAINT_CAPACITY,
	ChameleonTailContactSolver,
} from '../src/chameleon-tail-contact.js';
import {
	CHAMELEON_TAIL_CORRECTION_BONE_INDICES,
	CHAMELEON_TAIL_JOINT_COUNT,
} from '../src/chameleon-rig.js';

function writeIdentityTail( target ) {

	target.fill( 0 );
	for ( let joint = 0; joint < CHAMELEON_TAIL_JOINT_COUNT; joint ++ ) {

		target[ joint * 4 + 3 ] = 1;

	}

}

function createGroundCollider() {

	return {
		calls: 0,
		projectPoint( x, y, z, out ) {

			this.calls ++;
			out.hit = true;
			out.isGround = true;
			out.triangleId = - 1;
			out.componentId = - 1;
			out.surfaceX = x;
			out.surfaceY = 0;
			out.surfaceZ = z;
			out.nx = 0;
			out.ny = 1;
			out.nz = 0;
			out.x = x;
			out.y = Math.max( y, 0 );
			out.z = z;
			return out;

		},
	};

}

function createCornerCollider() {

	return {
		calls: 0,
		triangleCount: 2,
		componentId: new Int32Array( [ 7, 7 ] ),
		edgeNeighbours: new Int32Array( [ 1, - 1, - 1, 0, - 1, - 1 ] ),
		faceNormalX: new Float32Array( [ 1, 0 ] ),
		faceNormalY: new Float32Array( [ 0, 1 ] ),
		faceNormalZ: new Float32Array( [ 0, 0 ] ),
		ax: new Float32Array( [ 0, 0 ] ),
		ay: new Float32Array( [ 0, 0 ] ),
		az: new Float32Array( [ 0, 0 ] ),
		_testTriangle() { return 0; },
		projectPoint( x, y, z, out ) {

			this.calls ++;
			out.hit = true;
			out.isGround = false;
			out.triangleId = 0;
			out.componentId = 7;
			out.surfaceX = 0;
			out.surfaceY = y;
			out.surfaceZ = z;
			out.nx = 1;
			out.ny = 0;
			out.nz = 0;
			out.x = Math.max( x, 0 );
			out.y = y;
			out.z = z;
			return out;

		},
	};

}

function createBodyBinding( positions ) {

	return {
		positions,
		writeBodyProbeWorldPositions( target ) {

			target.set( this.positions );
			return target;

		},
	};

}

function writeBodyPositions( positions, x, y, z, offset = null ) {

	for ( let probe = 0; probe < 3; probe ++ ) {

		const index = probe * 3;
		positions[ index ] = x + ( offset?.[ 0 ] || 0 );
		positions[ index + 1 ] = y + ( offset?.[ 1 ] || 0 );
		positions[ index + 2 ] = z + ( offset?.[ 2 ] || 0 );

	}
	return positions;

}

function bodyInput( collider, binding, overrides = {} ) {

	return {
		enabled: true,
		collider,
		binding,
		supportId: - 1,
		componentId: - 1,
		radius: 0.1,
		maximumOffset: 0.3,
		canonicalX: 0,
		canonicalY: 0,
		canonicalZ: 0,
		anchorX: 0,
		anchorY: 0,
		anchorZ: 0,
		...overrides,
	};

}

function createTailSolution() {

	const tailDeltas = new Float32Array( CHAMELEON_TAIL_JOINT_COUNT * 4 );
	writeIdentityTail( tailDeltas );
	return {
		tailDeltas,
		tailWeights: new Float32Array( CHAMELEON_TAIL_JOINT_COUNT ),
	};

}

function createTailBinding( positions ) {

	return {
		positions,
		receivedConstraintNormals: null,
		receivedConstraintPlaneConstants: null,
		receivedConstraintProbeIndices: null,
		receivedConstraintCount: 0,
		receivedClearance: 0,
		writeTailProbeWorldPositions( target ) {

			target.set( this.positions );
			return target;

		},
		writeTailContactDeltas(
			deltas, weights, probes, targets, contactWeights, maximumAngle,
			constraintNormals, constraintPlaneConstants, constraintProbeIndices,
			constraintCount, clearance,
		) {

			this.receivedConstraintNormals = constraintNormals;
			this.receivedConstraintPlaneConstants = constraintPlaneConstants;
			this.receivedConstraintProbeIndices = constraintProbeIndices;
			this.receivedConstraintCount = constraintCount;
			this.receivedClearance = clearance;
			writeIdentityTail( deltas );
			weights.fill( 0 );
			for ( let probe = 0; probe < 3; probe ++ ) {

				const correction = CHAMELEON_TAIL_CORRECTION_BONE_INDICES[ probe ];
				const vectorOffset = probe * 3;
				const depth = Math.hypot(
					targets[ vectorOffset ] - probes[ vectorOffset ],
					targets[ vectorOffset + 1 ] - probes[ vectorOffset + 1 ],
					targets[ vectorOffset + 2 ] - probes[ vectorOffset + 2 ],
				);
				const angle = Math.min( maximumAngle, depth * 2 );
				deltas[ correction * 4 + 2 ] = Math.sin( angle * 0.5 );
				deltas[ correction * 4 + 3 ] = Math.cos( angle * 0.5 );
				weights[ correction ] = contactWeights[ probe ];

			}
			return deltas;

		},
	};

}

function tailInput( collider, binding, solution, overrides = {} ) {

	return {
		enabled: true,
		collider,
		binding,
		solution,
		supportId: - 1,
		componentId: - 1,
		radius: 0.1,
		...overrides,
	};

}

test( 'CHAMELEON-BODY-CONTACT-001 immediate push and smoothed release preserve the exact margin', () => {

	const collider = createGroundCollider();
	const positions = writeBodyPositions( new Float32Array( 9 ), 0, 0.05, 0 );
	const binding = createBodyBinding( positions );
	const solver = new ChameleonBodyContactSolver( { frequency: 30, response: 12 } );
	const input = bodyInput( collider, binding );
	let view = solver.update( 0, input );
	assert.equal( view.refreshed, true );
	assert.equal( view.queries, 3 );
	assert.ok( Math.abs( view.offset[ 1 ] - 0.05 ) < 1e-6 );
	writeBodyPositions( positions, 0, 0.05, 0, view.offset );
	assert.equal( solver.validateAppliedPose( binding, 1e-5 ).constraintsSatisfied, true );

	writeBodyPositions( positions, 0, 0, 0, view.offset );
	view = solver.update( 1 / 30, input );
	assert.ok( Math.abs( view.offset[ 1 ] - 0.1 ) < 1e-6, 'a growing intrusion may not be smoothed' );

	writeBodyPositions( positions, 0, 0.2, 0, view.offset );
	view = solver.update( 1 / 30, input );
	assert.ok( view.offset[ 1 ] > 0 && view.offset[ 1 ] < 0.1, 'release must be smoothed' );

} );

test( 'CHAMELEON-BODY-CONTACT-002 cadence is capped at three BVH queries and buffers stay stable', () => {

	const collider = createGroundCollider();
	const positions = writeBodyPositions( new Float32Array( 9 ), 0, 0.2, 0 );
	const binding = createBodyBinding( positions );
	const solver = new ChameleonBodyContactSolver( { frequency: 30 } );
	const input = bodyInput( collider, binding );
	const view = solver.update( 0, input );
	const identities = [
		view.offset, view.probePositions, view.projectedPositions,
		view.constraintNormals, view.constraintPlaneConstants, view.constraintProbeIndices,
	];
	assert.equal( collider.calls, 3 );
	for ( let frame = 0; frame < 7; frame ++ ) {

		assert.equal( solver.update( 1 / 240, input ).queries, 0 );

	}
	assert.equal( solver.update( 1 / 240, input ).queries, 3 );
	assert.equal( collider.calls, 6 );
	assert.equal( solver.update( 1, input ).queries, 3 );
	assert.equal( collider.calls, 9, 'a large dt still performs only one bounded refresh' );
	assert.deepEqual(
		[
			view.offset, view.probePositions, view.projectedPositions,
			view.constraintNormals, view.constraintPlaneConstants, view.constraintProbeIndices,
		],
		identities,
	);
	assert.equal( view.constraintNormals.length, CHAMELEON_BODY_CONSTRAINT_CAPACITY * 3 );

} );

test( 'CHAMELEON-BODY-CONTACT-003 absolute anchors and finite IK budgets cannot hide penetration', () => {

	function solveAtAnchor( anchorY ) {

		const collider = createGroundCollider();
		const positions = writeBodyPositions( new Float32Array( 9 ), 0, 0.02, 0 );
		const binding = createBodyBinding( positions );
		const solver = new ChameleonBodyContactSolver();
		return solver.update( 0, bodyInput( collider, binding, { anchorY } ) ).offset[ 1 ];

	}
	assert.ok( Math.abs( solveAtAnchor( 0.05 ) - 0.08 ) < 1e-6 );
	assert.ok( Math.abs( solveAtAnchor( - 0.05 ) - 0.08 ) < 1e-6 );

	const collider = createGroundCollider();
	const positions = writeBodyPositions( new Float32Array( 9 ), 0, 0, 0 );
	const binding = createBodyBinding( positions );
	const solver = new ChameleonBodyContactSolver();
	const view = solver.update( 0, bodyInput( collider, binding, { maximumOffset: 0.03 } ) );
	assert.equal( view.budgetExceeded, true );
	assert.equal( view.constraintsSatisfied, false );
	assert.equal( view.requiresFreeze, true );
	assert.ok( view.maxResidual > 0.06 );

} );

test( 'CHAMELEON-BODY-CONTACT-004 cached safe planes catch animation penetration between BVH refreshes', () => {

	const collider = createGroundCollider();
	const positions = writeBodyPositions( new Float32Array( 9 ), 0, 0.15, 0 );
	const binding = createBodyBinding( positions );
	const solver = new ChameleonBodyContactSolver( { frequency: 30 } );
	const input = bodyInput( collider, binding );
	const view = solver.update( 0, input );
	assert.equal( view.constraintCount, 3, 'safe nearby planes must still be cached' );
	assert.equal( solver.validateAppliedPose( binding, 1e-5 ).constraintsSatisfied, true );
	const calls = collider.calls;
	writeBodyPositions( positions, 0, 0.05, 0 );
	assert.equal( solver.validateAppliedPose( binding, 1e-5 ).requiresFreeze, true );
	assert.equal( collider.calls, calls, 'render validation must never issue a BVH query' );

} );

test( 'CHAMELEON-BODY-CONTACT-005 convex corner planes are solved and validated independently', () => {

	const collider = createCornerCollider();
	const positions = writeBodyPositions( new Float32Array( 9 ), 0.05, 0.05, 0 );
	const binding = createBodyBinding( positions );
	const solver = new ChameleonBodyContactSolver();
	const input = bodyInput( collider, binding, { supportId: 0, componentId: 7 } );
	const view = solver.update( 0, input );
	assert.ok( Math.abs( view.offset[ 0 ] - 0.05 ) < 1e-5 );
	assert.ok( Math.abs( view.offset[ 1 ] - 0.05 ) < 1e-5 );
	writeBodyPositions( positions, 0.05, 0.05, 0, view.offset );
	assert.equal( solver.validateAppliedPose( binding, 1e-5 ).constraintsSatisfied, true );
	positions[ 0 ] -= 0.002;
	assert.equal( solver.validateAppliedPose( binding, 1e-5 ).requiresFreeze, true );

} );

test( 'CHAMELEON-BODY-CONTACT-006 bounded convex convergence eliminates solvable corner residuals', () => {

	const normals = [
		[ - 0.31716151, 0.92412768, - 0.21306479 ],
		[ - 0.05451395, 0.79548266, 0.60351932 ],
		[ 0.61486632, 0.63805439, - 0.46349326 ],
		[ 0.48404202, - 0.87480973, - 0.02027946 ],
		[ 0.21992808, 0.88776496, - 0.40435754 ],
		[ 0.72618562, - 0.43332394, 0.53374602 ],
		[ - 0.23570461, - 0.91986799, - 0.31350634 ],
		[ 0.64739566, - 0.19261487, - 0.7374133 ],
	];
	const depths = [
		- 0.10089997, - 0.01034279, 0.00837175, 0.08817998,
		- 0.03780804, 0.14131944, - 0.01605807, 0.02155353,
	];
	const twoSweep = new Float64Array( 3 );
	for ( let pass = 0; pass < 2; pass ++ ) for ( let index = 0; index < normals.length; index ++ ) {

		const normal = normals[ index ];
		const correction = depths[ index ]
			- twoSweep[ 0 ] * normal[ 0 ]
			- twoSweep[ 1 ] * normal[ 1 ]
			- twoSweep[ 2 ] * normal[ 2 ];
		if ( correction <= 0 ) continue;
		for ( let axis = 0; axis < 3; axis ++ ) twoSweep[ axis ] += normal[ axis ] * correction;

	}
	const twoSweepResidual = Math.max( ...normals.map( ( normal, index ) =>
		depths[ index ]
		- twoSweep[ 0 ] * normal[ 0 ]
		- twoSweep[ 1 ] * normal[ 1 ]
		- twoSweep[ 2 ] * normal[ 2 ] ) );
	assert.ok( twoSweepResidual > 0.005, 'the fixture must reproduce the old false freeze' );

	const solver = new ChameleonBodyContactSolver();
	for ( let index = 0; index < normals.length; index ++ ) solver._appendConstraint(
		0, normals[ index ][ 0 ], normals[ index ][ 1 ], normals[ index ][ 2 ],
		depths[ index ], 0,
	);
	const solved = new Float32Array( 3 );
	solver._solveConstraints( solved );
	assert.ok( solver._maxResidual( solved ) <= 1e-5 );

} );

test( 'CHAMELEON-BODY-CONTACT-007 pelvis centre and chest retain independent support scopes', () => {

	const scopes = [];
	const collider = {
		projectPoint( x, y, z, out, query ) {

			scopes.push( [ query.supportId, query.componentId ] );
			out.hit = false;
			return out;

		},
	};
	const positions = writeBodyPositions( new Float32Array( 9 ), 0, 0.2, 0 );
	const binding = createBodyBinding( positions );
	const solver = new ChameleonBodyContactSolver( { frequency: 30 } );
	const supportIds = new Int32Array( [ 11, - 1, 13 ] );
	const componentIds = new Int32Array( [ 2, - 1, 4 ] );
	const input = bodyInput( collider, binding, { supportIds, componentIds } );
	solver.update( 0, input );
	assert.deepEqual( scopes, [ [ 11, 2 ], [ - 1, - 1 ], [ 13, 4 ] ] );
	assert.deepEqual( Array.from( solver._supportIds ), [ 11, - 1, 13 ] );
	assert.deepEqual( Array.from( solver._componentIds ), [ 2, - 1, 4 ] );

} );
test( 'CHAMELEON-BODY-CONTACT-008 cached planes follow animated probes without another BVH query', () => {

	const collider = createGroundCollider();
	const positions = writeBodyPositions( new Float32Array( 9 ), 0, 0.15, 0 );
	const binding = createBodyBinding( positions );
	const solver = new ChameleonBodyContactSolver( { frequency: 30 } );
	const input = bodyInput( collider, binding );
	const view = solver.update( 0, input );
	assert.equal( collider.calls, 3 );
	writeBodyPositions( positions, 0, 0.04, 0 );
	assert.equal( solver.validateAppliedPose( binding, 1e-5 ).requiresFreeze, true );
	const offsetIdentity = view.offset;
	solver.resolveCachedPose( binding );
	assert.equal( collider.calls, 3, 'cached recovery must remain query-free' );
	assert.equal( view.offset, offsetIdentity );
	assert.ok( Math.abs( view.offset[ 1 ] - 0.06 ) < 1e-5 );
	writeBodyPositions( positions, 0, 0.04, 0, view.offset );
	assert.equal( solver.validateAppliedPose( binding, 1e-5 ).constraintsSatisfied, true );

} );
test( 'CHAMELEON-BODY-CONTACT-009 an exact support scope cannot be replaced by nearer ground', () => {

	const queries = [];
	const collider = {
		calls: 0,
		projectPoint( x, y, z, out, query ) {

			this.calls ++;
			queries.push( {
				supportId: query.supportId,
				componentId: query.componentId,
				includeGround: query.includeGround,
				nearestGround: query.nearestGround,
			} );
			const groundWon = query.includeGround;
			out.hit = true;
			out.isGround = groundWon;
			out.triangleId = groundWon ? - 1 : 0;
			out.componentId = groundWon ? - 1 : 7;
			out.surfaceX = groundWon ? x : 0;
			out.surfaceY = groundWon ? 0 : y;
			out.surfaceZ = z;
			out.nx = groundWon ? 0 : 1;
			out.ny = groundWon ? 1 : 0;
			out.nz = 0;
			out.x = groundWon ? x : Math.max( x, 0 );
			out.y = groundWon ? Math.max( y, 0 ) : y;
			out.z = z;
			return out;

		},
	};
	// Ground is 0.02 u away, while the scoped support is 0.05 u away.
	const positions = writeBodyPositions( new Float32Array( 9 ), 0.05, 0.02, 0 );
	const binding = createBodyBinding( positions );
	const solver = new ChameleonBodyContactSolver( { frequency: 30, response: 12 } );
	const supportIds = new Int32Array( [ 11, 11, 11 ] );
	const componentIds = new Int32Array( [ 7, 7, 7 ] );
	const view = solver.update( 0, bodyInput( collider, binding, {
		supportId: 11,
		componentId: 7,
		supportIds,
		componentIds,
	} ) );
	assert.equal( view.queries, 3 );
	assert.equal( queries.length, 3 );
	for ( const query of queries ) {

		assert.equal( query.supportId, 11 );
		assert.equal( query.componentId, 7 );
		assert.equal( query.includeGround, false );
		assert.equal( query.nearestGround, false );

	}
	assert.equal( view.constraintCount, 3 );
	for ( let constraint = 0; constraint < view.constraintCount; constraint ++ ) {

		const offset = constraint * 3;
		assert.ok( Math.abs( view.constraintNormals[ offset ] - 1 ) < 1e-7 );
		assert.ok( Math.abs( view.constraintNormals[ offset + 1 ] ) < 1e-7 );
		assert.ok( Math.abs( view.constraintNormals[ offset + 2 ] ) < 1e-7 );

	}
	assert.equal( view.requiresFreeze, false );

} );
test( 'CHAMELEON-TAIL-CONTACT-001 active corrections snap immediately and release alone is smoothed', () => {

	const collider = createGroundCollider();
	const positions = writeBodyPositions( new Float32Array( 9 ), 0, 0.05, 0 );
	const binding = createTailBinding( positions );
	const solution = createTailSolution();
	const solver = new ChameleonTailContactSolver( { frequency: 30, response: 14 } );
	const input = tailInput( collider, binding, solution );
	let view = solver.update( 0, input );
	assert.equal( view.refreshed, true );
	assert.equal( collider.calls, 3 );
	for ( const index of CHAMELEON_TAIL_CORRECTION_BONE_INDICES ) {

		assert.equal( solution.tailWeights[ index ], 1 );

	}
	positions.set( view.projectedPositions );
	assert.equal( solver.validateAppliedPose( binding, 1e-5 ).constraintsSatisfied, true );

	writeBodyPositions( positions, 0, 0.2, 0 );
	view = solver.update( 1 / 30, input );
	for ( const index of CHAMELEON_TAIL_CORRECTION_BONE_INDICES ) {

		assert.ok( solution.tailWeights[ index ] > 0 && solution.tailWeights[ index ] < 1 );

	}

} );

test( 'CHAMELEON-TAIL-CONTACT-002 safe half-spaces detect inter-frame penetration without queries', () => {

	const collider = createGroundCollider();
	const positions = writeBodyPositions( new Float32Array( 9 ), 0, 0.15, 0 );
	const binding = createTailBinding( positions );
	const solution = createTailSolution();
	const solver = new ChameleonTailContactSolver( { frequency: 30 } );
	const input = tailInput( collider, binding, solution );
	const view = solver.update( 0, input );
	assert.equal( view.constraintCount, 3 );
	assert.equal( solver.validateAppliedPose( binding, 1e-5 ).constraintsSatisfied, true );
	const calls = collider.calls;
	writeBodyPositions( positions, 0, 0.05, 0 );
	assert.equal( solver.validateAppliedPose( binding, 1e-5 ).requiresFreeze, true );
	assert.equal( collider.calls, calls );

} );

test( 'CHAMELEON-TAIL-CONTACT-003 local convex fans retain exact plane margins with fixed buffers', () => {

	const collider = createCornerCollider();
	const positions = writeBodyPositions( new Float32Array( 9 ), 0.05, 0.05, 0 );
	const binding = createTailBinding( positions );
	const solution = createTailSolution();
	const solver = new ChameleonTailContactSolver( { frequency: 30 } );
	const input = tailInput( collider, binding, solution, { supportId: 0, componentId: 7 } );
	const view = solver.update( 0, input );
	assert.strictEqual( binding.receivedConstraintNormals, view.constraintNormals );
	assert.strictEqual( binding.receivedConstraintPlaneConstants, view.constraintPlaneConstants );
	assert.strictEqual( binding.receivedConstraintProbeIndices, view.constraintProbeIndices );
	assert.equal( binding.receivedConstraintCount, view.constraintCount );
	assert.equal( binding.receivedClearance, 0.1 );
	const identities = [
		view.probePositions, view.projectedPositions, view.appliedPositions,
		view.constraintNormals, view.constraintPlaneConstants, view.constraintProbeIndices,
		solution.tailDeltas, solution.tailWeights,
	];
	assert.ok( view.constraintCount >= 6 && view.constraintCount <= CHAMELEON_TAIL_CONSTRAINT_CAPACITY );
	positions.set( view.projectedPositions );
	assert.equal( solver.validateAppliedPose( binding, 1e-5 ).constraintsSatisfied, true );
	positions[ 0 ] -= 0.002;
	assert.equal( solver.validateAppliedPose( binding, 1e-5 ).requiresFreeze, true );
	assert.deepEqual(
		[
			view.probePositions, view.projectedPositions, view.appliedPositions,
			view.constraintNormals, view.constraintPlaneConstants, view.constraintProbeIndices,
			solution.tailDeltas, solution.tailWeights,
		],
		identities,
	);
	assert.equal( view.constraintNormals.length, CHAMELEON_TAIL_CONSTRAINT_CAPACITY * 3 );

} );

test( 'CHAMELEON-TAIL-CONTACT-004 240 Hz interpolation never raises the three-query cadence budget', () => {

	const collider = createGroundCollider();
	const positions = writeBodyPositions( new Float32Array( 9 ), 0, 0.2, 0 );
	const binding = createTailBinding( positions );
	const solution = createTailSolution();
	const solver = new ChameleonTailContactSolver( { frequency: 30 } );
	const input = tailInput( collider, binding, solution );
	solver.update( 0, input );
	assert.equal( solver.getTelemetry().lastFrameQueries, 3 );
	for ( let frame = 0; frame < 7; frame ++ ) {

		solver.update( 1 / 240, input );
		assert.equal( solver.getTelemetry().lastFrameQueries, 0 );

	}
	solver.update( 1 / 240, input );
	assert.equal( solver.getTelemetry().lastFrameQueries, 3 );
	solver.update( 1, input );
	assert.equal( solver.getTelemetry().lastFrameQueries, 3 );
	assert.equal( collider.calls, 9 );

} );
test( 'CHAMELEON-TAIL-CONTACT-005 twelve bounded sweeps converge on a feasible target fan', () => {

	const normals = [
		[ - 0.31716151, 0.92412768, - 0.21306479 ],
		[ - 0.05451395, 0.79548266, 0.60351932 ],
		[ 0.61486632, 0.63805439, - 0.46349326 ],
		[ 0.48404202, - 0.87480973, - 0.02027946 ],
		[ 0.21992808, 0.88776496, - 0.40435754 ],
		[ 0.72618562, - 0.43332394, 0.53374602 ],
		[ - 0.23570461, - 0.91986799, - 0.31350634 ],
		[ 0.64739566, - 0.19261487, - 0.7374133 ],
	];
	const depths = [
		- 0.10089997, - 0.01034279, 0.00837175, 0.08817998,
		- 0.03780804, 0.14131944, - 0.01605807, 0.02155353,
	];
	const twoSweep = new Float64Array( 3 );
	for ( let pass = 0; pass < 2; pass ++ ) for ( let index = 0; index < normals.length; index ++ ) {

		const normal = normals[ index ];
		const correction = depths[ index ]
			- twoSweep[ 0 ] * normal[ 0 ]
			- twoSweep[ 1 ] * normal[ 1 ]
			- twoSweep[ 2 ] * normal[ 2 ];
		if ( correction <= 0 ) continue;
		for ( let axis = 0; axis < 3; axis ++ ) twoSweep[ axis ] += normal[ axis ] * correction;

	}
	const twoSweepResidual = Math.max( ...normals.map( ( normal, index ) =>
		depths[ index ]
		- twoSweep[ 0 ] * normal[ 0 ]
		- twoSweep[ 1 ] * normal[ 1 ]
		- twoSweep[ 2 ] * normal[ 2 ] ) );
	assert.ok( twoSweepResidual > 0.005, 'the fixture must defeat the former two sweeps' );

	const solver = new ChameleonTailContactSolver();
	for ( let index = 0; index < normals.length; index ++ ) solver._appendConstraint(
		0, normals[ index ][ 0 ], normals[ index ][ 1 ], normals[ index ][ 2 ], depths[ index ],
	);
	solver.projectedPositions.fill( 0 );
	const residual = solver._solveProbeConstraints( 0, 0, 0 );
	assert.ok( residual <= 1e-5, `bounded target residual ${ residual }` );

} );
test( 'CHAMELEON-TAIL-CONTACT-006 an exact tail support cannot be replaced by nearer ground', () => {

	const queries = [];
	const collider = {
		calls: 0,
		projectPoint( x, y, z, out, query ) {

			this.calls ++;
			queries.push( {
				supportId: query.supportId,
				componentId: query.componentId,
				includeGround: query.includeGround,
				nearestGround: query.nearestGround,
			} );
			const groundWon = query.includeGround;
			out.hit = true;
			out.isGround = groundWon;
			out.triangleId = groundWon ? - 1 : 0;
			out.componentId = groundWon ? - 1 : 7;
			out.surfaceX = groundWon ? x : 0;
			out.surfaceY = groundWon ? 0 : y;
			out.surfaceZ = z;
			out.nx = groundWon ? 0 : 1;
			out.ny = groundWon ? 1 : 0;
			out.nz = 0;
			out.x = groundWon ? x : Math.max( x, 0 );
			out.y = groundWon ? Math.max( y, 0 ) : y;
			out.z = z;
			return out;

		},
	};
	const positions = writeBodyPositions( new Float32Array( 9 ), 0.05, 0.02, 0 );
	const binding = createTailBinding( positions );
	const solution = createTailSolution();
	const solver = new ChameleonTailContactSolver( { frequency: 30 } );
	const view = solver.update( 0, tailInput( collider, binding, solution, {
		supportId: 11,
		componentId: 7,
	} ) );
	assert.equal( queries.length, 3 );
	for ( const query of queries ) {

		assert.equal( query.supportId, 11 );
		assert.equal( query.componentId, 7 );
		assert.equal( query.includeGround, false );
		assert.equal( query.nearestGround, false );

	}
	assert.equal( view.constraintCount, 3 );
	for ( let constraint = 0; constraint < view.constraintCount; constraint ++ ) {

		const offset = constraint * 3;
		assert.ok( Math.abs( view.constraintNormals[ offset ] - 1 ) < 1e-7 );
		assert.ok( Math.abs( view.constraintNormals[ offset + 1 ] ) < 1e-7 );
		assert.ok( Math.abs( view.constraintNormals[ offset + 2 ] ) < 1e-7 );

	}
	assert.equal( view.requiresFreeze, false );

} );