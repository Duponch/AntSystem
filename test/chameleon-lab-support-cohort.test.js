import assert from 'node:assert/strict';
import test from 'node:test';

import {
	SUPPORT_SEAM_MINIMUM_NORMAL_DOT,
	SUPPORT_COHORT_FULL_MASK,
	SUPPORT_TOPOLOGY_ACTIVE_HANDOFF,
	SupportCohortModel,
} from '../src/chameleon-lab/support-cohort-model.js';

const ACTIVE_FOUR = new Uint8Array( [ 1, 1, 1, 1 ] );
const REACHABLE = new Float32Array( [ 0.31, 0.3, 0.32, 0.29 ] );
const MAXIMUM_REACH = new Float32Array( [ 0.46, 0.46, 0.5, 0.5 ] );
const UP = [ 0, 1, 0 ];
const FORWARD = [ 0, 0, 1 ];

function packedVectors( vectors ) {

	return new Float32Array( vectors.flat() );

}

function compatibilityFor( model, {
	positions,
	normals,
	handles,
	branches = [ 0, 0, 0, 0 ],
	active = ACTIVE_FOUR,
	previous = 0,
} ) {

	return model.buildCompatibility(
		packedVectors( positions ),
		packedVectors( normals ),
		new Float64Array( handles ),
		new Uint8Array( branches ),
		active,
		previous,
	);

}

test( 'SUPPORT-COHORT-001 a real orthogonal corner keeps one locally connected four-claw cohort', () => {

	const model = new SupportCohortModel( {
		// These are the maximum runtime thresholds. The regression must exercise
		// the real production envelope, not an artificially strict test value.
		enterSeamDistance: 0.72,
		exitSeamDistance: 0.84,
	} );
	const links = compatibilityFor( model, {
		positions: [
			[ -0.12, 0, 0.05 ],
			[ 0.12, 0, 0.05 ],
			[ -0.12, 0.08, 0 ],
			[ 0.12, 0.08, 0 ],
		],
		normals: [ UP, UP, FORWARD, FORWARD ],
		handles: [ 11, 11, 22, 22 ],
		previous: 0b0011,
	} );
	const view = model.select(
		REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, 0b0011, links,
	);
	assert.equal( view.mask, SUPPORT_COHORT_FULL_MASK,
		'a short physical seam must connect both support faces' );
	assert.equal( view.count, 4 );

} );

test( 'SUPPORT-COHORT-002 distant wall and floor groups cannot suspend the body between them', () => {

	const model = new SupportCohortModel( {
		// Match the maximum production envelope: the old implied-root filter
		// accepted this bridge even though no pair of surfaces is locally joined.
		enterSeamDistance: 0.72,
		exitSeamDistance: 0.84,
	} );
	const geometry = {
		positions: [
			[ -0.1, 0.85, 0 ],
			[ 0.1, 0.85, 0 ],
			[ -0.1, 0.05, 0.72 ],
			[ 0.1, 0.05, 0.72 ],
		],
		normals: [ FORWARD, FORWARD, UP, UP ],
		handles: [ 11, 11, 22, 22 ],
	};
	let links = compatibilityFor( model, { ...geometry, previous: 0b0011 } );
	let view = model.select(
		REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, 0b0011, links,
	);
	assert.equal( view.mask, 0b0011,
		'the previously held wall pair wins without creating an empty-space bridge' );

	links = compatibilityFor( model, { ...geometry, previous: 0b1100 } );
	view = model.select( REACHABLE, MAXIMUM_REACH, 0b1111, 0b1100, links );
	assert.equal( view.mask, 0b1100,
		'the opposite coherent pair is retained deterministically' );

	links = compatibilityFor( model, { ...geometry, previous: 0 } );
	view = model.select( REACHABLE, MAXIMUM_REACH, 0b1111, 0, links );
	assert.equal( view.mask, 0b0011,
		'equal disconnected cohorts without history use stable mask order' );

} );

test( 'SUPPORT-COHORT-002B only explicit locomotion may widen an inter-collider hand-off', () => {

	const model = new SupportCohortModel( {
		enterSeamDistance: 0.72,
		exitSeamDistance: 0.84,
		activeHandoffDistance: 0.96,
		activeHandoffExitDistance: 1.08,
	} );
	const geometry = {
		positions: [
			[ -0.1, 0.75, 0 ],
			[ 0.1, 0.75, 0 ],
			[ -0.1, 0, 0.55 ],
			[ 0.1, 0, 0.55 ],
		],
		normals: [ FORWARD, FORWARD, UP, UP ],
		handles: [ 51, 51, 52, 52 ],
	};
	const nearestCrossOwnerDistance = Math.hypot( 0.75, 0.55 );
	assert.ok( nearestCrossOwnerDistance > model.exitSeamDistance );
	assert.ok( nearestCrossOwnerDistance < model.activeHandoffDistance );

	let links = compatibilityFor( model, {
		...geometry,
		previous: 0b0011,
	} );
	let view = model.select(
		REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, 0b0011, links,
	);
	assert.equal( links[ 0 ] & 0b1100, 0,
		'idle/impact contacts must not manufacture a seam between nearby owners' );
	assert.equal( view.mask, 0b0011,
		'without explicit locomotion authority the retained owner stays isolated' );

	links = compatibilityFor( model, {
		...geometry,
		branches: [
			0,
			0,
			SUPPORT_TOPOLOGY_ACTIVE_HANDOFF,
			SUPPORT_TOPOLOGY_ACTIVE_HANDOFF,
		],
		previous: 0b0011,
	} );
	view = model.select(
		REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, 0b0011, links,
	);
	assert.notEqual( links[ 0 ] & 0b1100, 0,
		'a probe-confirmed active hand-off must connect leading and trailing owners' );
	assert.equal( view.mask, SUPPORT_COHORT_FULL_MASK,
		'active locomotion may retain the trailing pair while the leading pair transfers' );

	const retainedGeometry = {
		...geometry,
		positions: geometry.positions.map( position => position.slice() ),
	};
	retainedGeometry.positions[ 2 ][ 2 ] = 0.68;
	retainedGeometry.positions[ 3 ][ 2 ] = 0.68;
	const retainedDistance = Math.hypot( 0.75, 0.68 );
	assert.ok( retainedDistance > model.activeHandoffDistance );
	assert.ok( retainedDistance < model.activeHandoffExitDistance );
	links = compatibilityFor( model, {
		...retainedGeometry,
		branches: [
			0,
			0,
			SUPPORT_TOPOLOGY_ACTIVE_HANDOFF,
			SUPPORT_TOPOLOGY_ACTIVE_HANDOFF,
		],
		previous: SUPPORT_COHORT_FULL_MASK,
	} );
	view = model.select(
		REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, SUPPORT_COHORT_FULL_MASK, links,
	);
	assert.equal( view.mask, SUPPORT_COHORT_FULL_MASK,
		'a retained active hand-off uses a wider exit threshold instead of chattering' );
	retainedGeometry.positions[ 2 ][ 2 ] = 0.82;
	retainedGeometry.positions[ 3 ][ 2 ] = 0.82;
	links = compatibilityFor( model, {
		...retainedGeometry,
		branches: [
			0,
			0,
			SUPPORT_TOPOLOGY_ACTIVE_HANDOFF,
			SUPPORT_TOPOLOGY_ACTIVE_HANDOFF,
		],
		previous: SUPPORT_COHORT_FULL_MASK,
	} );
	view = model.select(
		REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, SUPPORT_COHORT_FULL_MASK, links,
	);
	assert.notEqual( view.mask, SUPPORT_COHORT_FULL_MASK,
		'a retained hand-off must still release beyond its bounded exit threshold' );

	const rejectedDot = SUPPORT_SEAM_MINIMUM_NORMAL_DOT - 0.01;
	const rejectedNormal = [ Math.sqrt( 1 - rejectedDot * rejectedDot ), rejectedDot, 0 ];
	links = compatibilityFor( model, {
		...geometry,
		normals: [ UP, UP, rejectedNormal, rejectedNormal ],
		branches: [
			0,
			0,
			SUPPORT_TOPOLOGY_ACTIVE_HANDOFF,
			SUPPORT_TOPOLOGY_ACTIVE_HANDOFF,
		],
		previous: 0b0011,
	} );
	view = model.select(
		REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, 0b0011, links,
	);
	assert.equal( view.mask, 0b0011,
		'active hand-off authority must not bypass the shared normal discontinuity limit' );

} );

test( 'SUPPORT-COHORT-003 collider identity alone never connects remote or opposite faces', () => {

	const model = new SupportCohortModel();
	const geometry = {
		positions: [
			[ -0.1, 0, 0.5 ],
			[ 0.1, 0, 0.5 ],
			[ -0.1, 0, -0.5 ],
			[ 0.1, 0, -0.5 ],
		],
		normals: [ FORWARD, FORWARD, [ 0, 0, -1 ], [ 0, 0, -1 ] ],
		handles: [ 31, 31, 31, 31 ],
	};
	let links = compatibilityFor( model, geometry );
	let view = model.select( REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, 0b0011, links );
	assert.equal( view.mask, 0b0011 );
	assert.notEqual( view.mask, SUPPORT_COHORT_FULL_MASK );

	links = compatibilityFor( model, {
		...geometry,
		branches: [ 1, 1, 1, 1 ],
	} );
	view = model.select( REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, 0b0011, links );
	assert.equal( view.mask, SUPPORT_COHORT_FULL_MASK,
		'a registered continuous branch may join radial contacts around one cylinder' );

	links = compatibilityFor( model, {
		positions: geometry.positions,
		normals: [ FORWARD, FORWARD, UP, UP ],
		handles: geometry.handles,
		branches: [ 2, 2, 2, 2 ],
	} );
	view = model.select( REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, 0b0011, links );
	assert.equal( view.mask, SUPPORT_COHORT_FULL_MASK,
		'adjacent faces of one convex faceted shell remain traversable' );

} );

test( 'SUPPORT-COHORT-004 anatomical reach, seam hysteresis and retained ownership are deterministic', () => {

	const model = new SupportCohortModel( {
		reachSlack: 0.01,
		enterSeamDistance: 0.28,
		exitSeamDistance: 0.38,
	} );
	const seamGeometry = {
		positions: [
			[ 0, 0, 0 ],
			[ 0.2, 0, 0 ],
			[ 0, 0.34, 0 ],
			[ 0.2, 0.34, 0 ],
		],
		normals: [ UP, UP, FORWARD, FORWARD ],
		handles: [ 41, 41, 42, 42 ],
	};
	let links = compatibilityFor( model, seamGeometry );
	let view = model.select(
		REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, 0b0011, links,
	);
	assert.equal( view.mask, 0b0011,
		'a new support group outside the enter threshold must stay detached' );

	links = compatibilityFor( model, { ...seamGeometry, previous: 0b1111 } );
	const reach = new Float32Array( [ 0.3, 0.31, 0.32, 0.53 ] );
	view = model.select(
		reach, MAXIMUM_REACH, ACTIVE_FOUR, SUPPORT_COHORT_FULL_MASK, links,
	);
	assert.equal( view.validMask, 0b0111 );
	assert.equal( view.rejectedReachMask, 0b1000 );
	assert.equal( view.mask, 0b0111,
		'the wider exit threshold retains only anatomically reachable prior contacts' );

} );

test( 'SUPPORT-COHORT-005 hot-path views are reused and malformed contacts fail closed', () => {

	const model = new SupportCohortModel();
	const positions = packedVectors( [
		[ -0.1, 0, 0 ], [ 0.1, 0, 0 ], [ -0.1, 0, 0.1 ], [ 0.1, 0, 0.1 ],
	] );
	const normals = packedVectors( [ UP, UP, UP, UP ] );
	const handles = new Float64Array( [ 1, 1, 1, 1 ] );
	const branches = new Uint8Array( 4 );
	const links = model.buildCompatibility(
		positions, normals, handles, branches, ACTIVE_FOUR,
	);
	const first = model.select(
		REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, 0, links,
	);
	for ( let iteration = 0; iteration < 10_000; iteration ++ ) {

		assert.strictEqual(
			model.buildCompatibility(
				positions, normals, handles, branches, ACTIVE_FOUR, first.mask,
			),
			links,
		);
		const returned = model.select(
			REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, first.mask, links,
		);
		assert.strictEqual( returned, first );
		assert.strictEqual( returned, model.getView() );
		assert.equal( returned.mask, SUPPORT_COHORT_FULL_MASK );

	}
	assert.throws(
		() => model.buildCompatibility(
			new Float32Array( 3 ), normals, handles, branches, ACTIVE_FOUR,
		),
		/packed contact-position/u,
	);
	const badPositions = positions.slice();
	badPositions[ 3 ] = Number.NaN;
	model.buildCompatibility(
		badPositions, normals, handles, branches, ACTIVE_FOUR,
	);
	const view = model.select(
		REACHABLE, MAXIMUM_REACH, ACTIVE_FOUR, 0, model.compatibility,
	);
	assert.notEqual( view.mask, SUPPORT_COHORT_FULL_MASK,
		'a non-finite contact cannot connect the full support cohort' );

} );
