import assert from 'node:assert/strict';
import test from 'node:test';

import {
	ANATOMICAL_FRAME,
	ANATOMICAL_METRIC,
	ANATOMICAL_POSITION,
	AnatomicalLimbSolver,
	AnatomicalSuspensionModel,
	CHAMELEON_LIMB_PRESETS,
	CHAMELEON_RIG_AXES,
	clampSwingTwist,
	SUSPENSION_OUTPUT,
} from '../src/chameleon-lab/anatomical-limb-solver.js';

const P = ANATOMICAL_POSITION;
const M = ANATOMICAL_METRIC;

function distance( values, first, second ) {

	return Math.hypot(
		values[ first ] - values[ second ],
		values[ first + 1 ] - values[ second + 1 ],
		values[ first + 2 ] - values[ second + 2 ],
	);

}

function dotFromPoint( values, point, origin, normal ) {

	return ( values[ point ] - origin[ 0 ] ) * normal[ 0 ]
		+ ( values[ point + 1 ] - origin[ 1 ] ) * normal[ 1 ]
		+ ( values[ point + 2 ] - origin[ 2 ] ) * normal[ 2 ];

}

function quaternionAxisAngle( axis, angle ) {

	const half = angle * 0.5;
	const sine = Math.sin( half );
	return [ axis[ 0 ] * sine, axis[ 1 ] * sine, axis[ 2 ] * sine, Math.cos( half ) ];

}

function multiplyQuaternion( first, second ) {

	const [ ax, ay, az, aw ] = first;
	const [ bx, by, bz, bw ] = second;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];

}

test( 'ANATOMICAL-LIMB-001 presets preserve the exact exported rig axes and segment lengths', () => {

	assert.deepEqual( CHAMELEON_RIG_AXES.restBoneAxis, [ 0, 1, 0 ] );
	assert.deepEqual( CHAMELEON_RIG_AXES.forward, [ -1, 0, 0 ] );
	assert.deepEqual( CHAMELEON_RIG_AXES.up, [ 0, 1, 0 ] );
	assert.deepEqual( CHAMELEON_RIG_AXES.right, [ 0, 0, 1 ] );
	assert.equal( CHAMELEON_RIG_AXES.leftSideSign, -1 );
	assert.equal( CHAMELEON_RIG_AXES.rightSideSign, 1 );
	assert.ok( Math.abs( CHAMELEON_LIMB_PRESETS.front.lengths[ 0 ] - 0.0943398029 ) < 1e-10 );
	assert.ok( Math.abs( CHAMELEON_LIMB_PRESETS.front.lengths[ 2 ] - 0.1938839108 ) < 1e-10 );
	assert.ok( Math.abs( CHAMELEON_LIMB_PRESETS.hind.lengths[ 1 ] - 0.1411559433 ) < 1e-10 );
	assert.ok( Math.abs( CHAMELEON_LIMB_PRESETS.hind.lengths[ 3 ] - 0.0562117994 ) < 1e-10 );
	assert.ok( CHAMELEON_LIMB_PRESETS.front.girdleSwingLimit > 1 );
	assert.ok( CHAMELEON_LIMB_PRESETS.hind.girdleSwingLimit > 1 );

} );

test( 'ANATOMICAL-LIMB-002 analytic chains keep every anatomical length and a finite orthonormal frame', () => {

	for ( const kind of [ 'front', 'hind' ] ) {

		for ( const side of [ 'L', 'R' ] ) {

			const sideSign = side === 'L' ? -1 : 1;
			const socket = kind === 'front'
				? [ -0.13, 0.27, 0.07 * sideSign ]
				: [ 0.085, 0.23, 0.07 * sideSign ];
			const contact = kind === 'front'
				? [ -0.19, 0, 0.29 * sideSign ]
				: [ 0.16, 0, 0.27 * sideSign ];
			const solver = new AnatomicalLimbSolver( { kind, side } );
			const view = solver.solve( {
				socket,
				contact,
				contactNormal: [ 0, 1, 0 ],
				bodyForward: [ -1, 0, 0 ],
				bodyUp: [ 0, 1, 0 ],
				stride: 0.35,
				dt: 1 / 120,
			} );
			const lengths = CHAMELEON_LIMB_PRESETS[ kind ].lengths;
			assert.ok( Math.abs( distance( view.positions, P.SOCKET, P.SHOULDER ) - lengths[ 0 ] ) < 2e-6 );
			assert.ok( Math.abs( distance( view.positions, P.SHOULDER, P.ELBOW ) - lengths[ 1 ] ) < 2e-6 );
			assert.ok( Math.abs( distance( view.positions, P.ELBOW, P.WRIST ) - lengths[ 2 ] ) < 2e-6 );
			assert.ok( Math.abs( distance( view.positions, P.WRIST, P.PALM_END ) - lengths[ 3 ] ) < 2e-6 );
			assert.ok( Math.abs( distance( view.positions, P.PALM_END, P.DIGIT_INNER ) - lengths[ 4 ] ) < 2e-6 );
			assert.ok( Math.abs( distance( view.positions, P.PALM_END, P.DIGIT_OUTER ) - lengths[ 5 ] ) < 2e-6 );
			assert.ok( view.metrics[ M.FLEXION ] >= CHAMELEON_LIMB_PRESETS[ kind ].minimumFlexion - 2e-5 );
			assert.ok( view.metrics[ M.FLEXION ] <= CHAMELEON_LIMB_PRESETS[ kind ].maximumFlexion + 2e-5 );
			for ( const value of view.positions ) assert.ok( Number.isFinite( value ) );
			for ( let frame = 0; frame < ANATOMICAL_FRAME.SIZE; frame += 4 ) {

				const length = Math.hypot(
					view.frames[ frame ], view.frames[ frame + 1 ],
					view.frames[ frame + 2 ], view.frames[ frame + 3 ],
				);
				assert.ok( Math.abs( length - 1 ) < 2e-6 );

			}

		}

	}

} );

test( 'ANATOMICAL-LIMB-003 wrist, palm and both zygodactyl pads form one complete surface patch', () => {

	const solver = new AnatomicalLimbSolver( { kind: 'front', side: 'L', contactClearance: 0 } );
	const normal = [ 0.18, 0.965, -0.19 ];
	const normalLength = Math.hypot( ...normal );
	for ( let lane = 0; lane < 3; lane ++ ) normal[ lane ] /= normalLength;
	const contact = [ -0.18, 0.04, -0.27 ];
	const view = solver.solve( {
		socket: [ -0.13, 0.29, -0.07 ],
		contact,
		contactNormal: normal,
		palmDirection: [ -1, 0.2, 0.1 ],
		bodyForward: [ -1, 0, 0 ],
		bodyUp: [ 0, 1, 0 ],
	} );
	assert.equal( view.metrics[ M.CLAMPED ], 0 );
	for ( const point of [ P.WRIST, P.PALM_CENTER, P.PALM_END, P.DIGIT_INNER, P.DIGIT_OUTER ] )
		assert.ok( Math.abs( dotFromPoint( view.positions, point, contact, normal ) ) < 3e-6 );
	assert.ok( view.metrics[ M.CONTACT_PLANE_ERROR ] < 3e-6 );
	assert.ok( Math.abs( view.metrics[ M.CONTACT_NORMAL_OFFSET ] ) < 3e-6 );
	assert.ok( Math.abs(
		view.contactTangent[ 0 ] * normal[ 0 ]
		+ view.contactTangent[ 1 ] * normal[ 1 ]
		+ view.contactTangent[ 2 ] * normal[ 2 ]
	) < 2e-6 );

} );

test( 'ANATOMICAL-LIMB-004 proximal joints make broad strides while flexion adapts to reach', () => {

	const solver = new AnatomicalLimbSolver( { kind: 'hind', side: 'R' } );
	const common = {
		socket: [ 0.085, 0.22, 0.07 ],
		contactNormal: [ 0, 1, 0 ],
		bodyForward: [ -1, 0, 0 ],
		bodyUp: [ 0, 1, 0 ],
		dt: 1 / 30,
	};
	const tucked = solver.solve( {
		...common,
		contact: [ 0.12, 0.035, 0.20 ],
		stride: -1,
	} );
	const tuckedFlexion = tucked.metrics[ M.FLEXION ];
	const tuckedShoulder = Array.from( tucked.positions.slice( P.SHOULDER, P.SHOULDER + 3 ) );
	const extended = solver.solve( {
		...common,
		contact: [ 0.23, 0.005, 0.30 ],
		stride: 1,
	} );
	const shoulderTravel = Math.hypot(
		extended.positions[ P.SHOULDER ] - tuckedShoulder[ 0 ],
		extended.positions[ P.SHOULDER + 1 ] - tuckedShoulder[ 1 ],
		extended.positions[ P.SHOULDER + 2 ] - tuckedShoulder[ 2 ],
	);
	assert.ok( shoulderTravel > 0.045, `girdle excursion ${ shoulderTravel } is too small` );
	assert.ok( tuckedFlexion - extended.metrics[ M.FLEXION ] > 0.35,
		`flexion did not adapt (${ tuckedFlexion } -> ${ extended.metrics[ M.FLEXION ] })` );
	assert.ok( extended.metrics[ M.GIRDLE_SWING ] > 0.35 );
	assert.ok( extended.metrics[ M.GIRDLE_SWING ] <= CHAMELEON_LIMB_PRESETS.hind.girdleSwingLimit + 1e-5 );

} );

test( 'ANATOMICAL-LIMB-005 persistent pole vectors do not invert at near-singular reaches', () => {

	const solver = new AnatomicalLimbSolver( { kind: 'front', side: 'R', poleResponse: 10 } );
	let previousPole = null;
	let minimumDot = 1;
	for ( let frame = 0; frame < 240; frame ++ ) {

		const phase = frame / 239;
		const view = solver.solve( {
			socket: [ -0.13, 0.26, 0.07 ],
			contact: [ -0.18 + phase * 0.025, 0.002, 0.34 - phase * 0.015 ],
			contactNormal: [ 0, 1, Math.sin( phase * Math.PI * 2 ) * 1e-4 ],
			bodyForward: [ -1, 0, 0 ],
			bodyUp: [ 0, 1, 0 ],
			poleVector: frame < 120 ? [ 0, 1, 1e-6 ] : [ 0, -1, -1e-6 ],
			dt: 1 / 120,
		} );
		if ( previousPole ) minimumDot = Math.min(
			minimumDot,
			previousPole[ 0 ] * view.poleDirection[ 0 ]
				+ previousPole[ 1 ] * view.poleDirection[ 1 ]
				+ previousPole[ 2 ] * view.poleDirection[ 2 ],
		);
		previousPole = Array.from( view.poleDirection );
		assert.ok( Number.isFinite( view.metrics[ M.FLEXION ] ) );

	}
	assert.ok( minimumDot > 0.995, `pole flipped or jittered (minimum dot ${ minimumDot })` );

} );

test( 'ANATOMICAL-LIMB-010 front stroke elevates the shoulder before planting the hand', () => {

	const solver = new AnatomicalLimbSolver( { kind: 'front', side: 'L' } );
	const common = {
		socket: [ -0.135, 0.22, -0.06 ],
		contact: [ -0.24, 0.002, -0.27 ],
		contactNormal: [ 0, 1, 0 ],
		bodyForward: [ -1, 0, 0 ],
		bodyUp: [ 0, 1, 0 ],
		stride: 0.2,
		abduction: 0.25,
		girdleReachWeight: 0.18,
		minimumFlexion: 1.35,
		dt: 1 / 120,
	};
	const planted = solver.solve( common );
	const plantedShoulderY = planted.positions[ P.SHOULDER + 1 ];
	const lifted = solver.solve( { ...common, girdleElevation: 0.72 } );
	const shoulderRise = lifted.positions[ P.SHOULDER + 1 ] - plantedShoulderY;

	assert.ok( shoulderRise > 0.045, `front shoulder only rose ${ shoulderRise } m` );
	assert.ok(
		lifted.positions[ P.SHOULDER + 1 ] > lifted.positions[ P.SOCKET + 1 ],
		'the anterior girdle must pass above its socket during the aerial stroke',
	);
	assert.ok( lifted.metrics[ M.GIRDLE_SWING ] <= CHAMELEON_LIMB_PRESETS.front.girdleSwingLimit + 1e-5 );
	assert.ok( lifted.positions.every( Number.isFinite ) );

} );

test( 'ANATOMICAL-LIMB-006 swing-twist decomposition respects both limits', () => {

	const swing = quaternionAxisAngle( [ 1, 0, 0 ], 1.15 );
	const twist = quaternionAxisAngle( [ 0, 1, 0 ], -0.9 );
	const candidate = multiplyQuaternion( swing, twist );
	const result = new Float32Array( 4 );
	clampSwingTwist( candidate, [ 0, 1, 0 ], 0.55, -0.22, 0.34, result );
	const projected = result[ 1 ];
	const twistW = result[ 3 ];
	const twistLength = Math.hypot( projected, twistW );
	const twistAngle = 2 * Math.atan2( projected / twistLength, twistW / twistLength );
	assert.ok( Math.abs( twistAngle + 0.22 ) < 2e-5 );
	const tx = 0;
	const ty = projected / twistLength;
	const tz = 0;
	const tw = twistW / twistLength;
	// swing = result * inverse(twist)
	const sx = -result[ 3 ] * tx + result[ 0 ] * tw - result[ 1 ] * tz + result[ 2 ] * ty;
	const sy = -result[ 3 ] * ty + result[ 0 ] * tz + result[ 1 ] * tw - result[ 2 ] * tx;
	const sz = -result[ 3 ] * tz - result[ 0 ] * ty + result[ 1 ] * tx + result[ 2 ] * tw;
	const sw = result[ 3 ] * tw + result[ 0 ] * tx + result[ 1 ] * ty + result[ 2 ] * tz;
	const swingAngle = 2 * Math.atan2( Math.hypot( sx, sy, sz ), Math.abs( sw ) );
	assert.ok( Math.abs( swingAngle - 0.55 ) < 2e-5 );
	assert.ok( Math.abs( Math.hypot( ...result ) - 1 ) < 2e-6 );

} );

test( 'ANATOMICAL-LIMB-007 support suspension produces bounded heave, pitch and roll', () => {

	const suspension = new AnatomicalSuspensionModel( {
		responseFrequency: 5,
		maximumOffset: 0.075,
		maximumAngle: 0.16,
	} );
	const sockets = new Float32Array( [
		-0.14, 0.24, -0.08,
		-0.14, 0.24, 0.08,
		0.10, 0.22, -0.08,
		0.10, 0.22, 0.08,
	] );
	const contacts = new Float32Array( [
		-0.15, 0.10, -0.16,
		-0.15, 0.04, 0.23,
		0.11, 0.08, -0.15,
		0.11, 0.05, 0.20,
	] );
	const normals = new Float32Array( [
		0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
	] );
	let view;
	for ( let frame = 0; frame < 180; frame ++ ) view = suspension.update( 1 / 120, {
		socketPositions: sockets,
		contactPositions: contacts,
		contactNormals: normals,
		active: new Uint8Array( [ 1, 1, 1, 1 ] ),
	} );
	assert.ok( view.current[ SUSPENSION_OUTPUT.OFFSET_Y ] > 0.005 );
	assert.ok( Math.abs( view.current[ SUSPENSION_OUTPUT.PITCH ] ) > 0.005 );
	assert.ok( Math.abs( view.current[ SUSPENSION_OUTPUT.ROLL ] ) > 0.005 );
	assert.ok( Math.hypot( ...view.current.slice( 0, 3 ) ) <= 0.0751 );
	assert.ok( Math.abs( view.current[ SUSPENSION_OUTPUT.PITCH ] ) <= 0.1601 );
	assert.ok( Math.abs( view.current[ SUSPENSION_OUTPUT.ROLL ] ) <= 0.1601 );
	assert.ok( view.current[ SUSPENSION_OUTPUT.LOAD ] >= 0 );

} );

test( 'ANATOMICAL-LIMB-008 hot paths reuse all output buffers and expose unreachable residuals', () => {

	const solver = new AnatomicalLimbSolver( { kind: 'front', side: 'L' } );
	const first = solver.solve( {
		socket: [ 0, 0.3, 0 ],
		contact: [ -2, 0, -2 ],
		contactNormal: [ 0, 1, 0 ],
	} );
	const positions = first.positions;
	const frames = first.frames;
	const metrics = first.metrics;
	for ( let iteration = 0; iteration < 10_000; iteration ++ ) {

		const next = solver.solve( {
			socket: [ 0, 0.3, 0 ],
			contact: [ -2 + iteration * 1e-8, 0, -2 ],
			contactNormal: [ 0, 1, 0 ],
			dt: 1 / 120,
		} );
		assert.equal( next, first );
		assert.equal( next.positions, positions );
		assert.equal( next.frames, frames );
		assert.equal( next.metrics, metrics );

	}
	assert.equal( first.metrics[ M.CLAMPED ], 1 );
	assert.ok( first.metrics[ M.REACH_RESIDUAL ] > 1 );
	assert.ok( first.metrics[ M.FLEXION ] >= CHAMELEON_LIMB_PRESETS.front.minimumFlexion - 2e-5 );

	const suspension = new AnatomicalSuspensionModel();
	const suspensionView = suspension.getView();
	assert.equal( suspension.update( 1 / 120, {
		socketPositions: new Float32Array( 12 ),
		contactPositions: new Float32Array( 12 ),
		contactNormals: new Float32Array( [ 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0 ] ),
	} ), suspensionView );
	assert.equal( suspension.interpolate( 0.5 ), suspensionView.render );

} );

test( 'ANATOMICAL-LIMB-009 exact asymmetric distal frame preserves wrist height and digit axes', () => {

	const solver = new AnatomicalLimbSolver( {
		kind: 'front',
		side: 'L',
		contactClearance: 0,
		lengths: [ 0.1, 0.25, 0.25, 0.08, 0.1, 0.075 ],
		contactOffset: [ 0.026, 0.019, -0.012 ],
		palmAxisFrame: [ 0.82, 0.46, 0.34 ],
		innerAxisFrame: [ 0.62, 0.28, -0.73 ],
		outerAxisFrame: [ 0.55, 0.17, 0.82 ],
	} );
	const contact = [ -0.14, 0.05, -0.12 ];
	const view = solver.solve( {
		socket: [ 0, 0.24, 0 ],
		contact,
		contactNormal: [ 0, 1, 0 ],
		palmDirection: [ -1, 0, 0 ],
		palmYaw: 0,
		bodyForward: [ -1, 0, 0 ],
		bodyUp: [ 0, 1, 0 ],
		minimumFlexion: 0.2,
	} );
	for ( let lane = 0; lane < 3; lane ++ ) assert.ok(
		Math.abs( view.positions[ P.PALM_CENTER + lane ] - contact[ lane ] ) < 3e-6,
	);
	const assertFrameAxis = ( start, end, frame ) => {

		const actual = [
			view.positions[ end ] - view.positions[ start ],
			view.positions[ end + 1 ] - view.positions[ start + 1 ],
			view.positions[ end + 2 ] - view.positions[ start + 2 ],
		];
		const actualLength = Math.hypot( ...actual );
		const expected = [
			view.contactTangent[ 0 ] * frame[ 0 ] + view.contactNormal[ 0 ] * frame[ 1 ] + view.contactBinormal[ 0 ] * frame[ 2 ],
			view.contactTangent[ 1 ] * frame[ 0 ] + view.contactNormal[ 1 ] * frame[ 1 ] + view.contactBinormal[ 1 ] * frame[ 2 ],
			view.contactTangent[ 2 ] * frame[ 0 ] + view.contactNormal[ 2 ] * frame[ 1 ] + view.contactBinormal[ 2 ] * frame[ 2 ],
		];
		const expectedLength = Math.hypot( ...expected );
		const alignment = actual.reduce(
			( sum, value, lane ) => sum + value / actualLength * expected[ lane ] / expectedLength, 0,
		);
		assert.ok( alignment > 1 - 2e-6, `distal frame alignment ${ alignment }` );

	};
	assertFrameAxis( P.WRIST, P.PALM_END, solver.palmAxisFrame );
	assertFrameAxis( P.PALM_END, P.DIGIT_INNER, solver.innerAxisFrame );
	assertFrameAxis( P.PALM_END, P.DIGIT_OUTER, solver.outerAxisFrame );

} );
