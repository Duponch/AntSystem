import assert from 'node:assert/strict';
import test from 'node:test';

import {
	cameraRelativePlatformerDirection,
	parallelTransportTangent,
	PlatformerControlModel,
	platformerAxesFromKeys,
} from '../src/chameleon-lab/platformer-control-model.js';

const EPSILON = 1e-9;

function close( actual, expected, epsilon = EPSILON ) {

	assert.ok( Math.abs( actual - expected ) <= epsilon,
		`expected ${ expected }, received ${ actual }` );

}

function vectorClose( actual, expected, epsilon = EPSILON ) {

	close( actual.x, expected.x, epsilon );
	close( actual.y, expected.y, epsilon );
	close( actual.z, expected.z, epsilon );

}

test( 'PLATFORMER-CONTROL-001 preserves QWERTY, AZERTY and arrow layouts', () => {

	for ( const key of [ 'KeyW', 'KeyZ', 'ArrowUp' ] )
		assert.deepEqual( platformerAxesFromKeys( new Set( [ key ] ) ), { x: 0, y: 1 } );
	for ( const key of [ 'KeyA', 'KeyQ', 'ArrowLeft' ] )
		assert.deepEqual( platformerAxesFromKeys( new Set( [ key ] ) ), { x: - 1, y: 0 } );
	const diagonal = platformerAxesFromKeys( new Set( [ 'KeyZ', 'KeyD' ] ) );
	close( diagonal.x, Math.SQRT1_2 );
	close( diagonal.y, Math.SQRT1_2 );
	assert.deepEqual( platformerAxesFromKeys( new Set( [ 'KeyW', 'KeyS' ] ) ), { x: 0, y: 0 } );

} );

test( 'PLATFORMER-CONTROL-002 camera pitch never changes planar input direction', () => {

	const options = {
		worldUp: { x: 0, y: 1, z: 0 },
		supportNormal: { x: 0, y: 1, z: 0 },
	};
	const shallow = cameraRelativePlatformerDirection(
		{ x: 0, y: 1 }, { x: 0, y: - 0.05, z: - 1 }, options,
	);
	const steep = cameraRelativePlatformerDirection(
		{ x: 0, y: 1 }, { x: 0, y: - 0.999, z: - 0.01 }, options,
	);
	vectorClose( shallow, { x: 0, y: 0, z: - 1 } );
	vectorClose( steep, shallow );

} );

test( 'PLATFORMER-CONTROL-003 movement remains tangent on slopes and walls', () => {

	for ( const sourceNormal of [
		{ x: 0, y: 1, z: 0 },
		{ x: 0.35, y: 0.88, z: 0.32 },
		{ x: 0, y: 0, z: 1 },
	] ) {

		const length = Math.hypot( sourceNormal.x, sourceNormal.y, sourceNormal.z );
		const normal = {
			x: sourceNormal.x / length,
			y: sourceNormal.y / length,
			z: sourceNormal.z / length,
		};
		const direction = cameraRelativePlatformerDirection(
			{ x: 0.3, y: 0.9 },
			{ x: 0.4, y: - 0.6, z: - 1 },
			{ supportNormal: normal },
		);
		close( direction.x * normal.x + direction.y * normal.y + direction.z * normal.z, 0 );
		close( Math.hypot( direction.x, direction.y, direction.z ), Math.hypot( 0.3, 0.9 ) );

	}

} );

test( 'PLATFORMER-CONTROL-004 direct wall-facing input climbs instead of collapsing', () => {

	const direction = cameraRelativePlatformerDirection(
		{ x: 0, y: 1 },
		{ x: 0, y: 0, z: - 1 },
		{
			worldUp: { x: 0, y: 1, z: 0 },
			supportNormal: { x: 0, y: 0, z: - 1 },
		},
	);
	vectorClose( direction, { x: 0, y: 1, z: 0 } );

} );

test( 'PLATFORMER-CONTROL-005 facing turns at a bounded rate and does not follow an idle camera', () => {

	const model = new PlatformerControlModel( { turnRate: 2 } );
	model.reset( { x: 0, y: 0, z: - 1 } );
	const first = model.update( 0.1, {
		axes: { x: 1, y: 0 },
		cameraForward: { x: 0, y: - 0.6, z: - 1 },
		velocity: { x: 0, y: 0, z: 0 },
	} );
	close( first.turnDelta, - 0.2 );
	const facingAfterTurn = { ...first.facing };
	const idle = model.update( 0.1, {
		axes: { x: 0, y: 0 },
		cameraForward: { x: 1, y: 0, z: 0 },
		velocity: { x: 0, y: 0, z: 0 },
	} );
	vectorClose( idle.facing, facingAfterTurn );
	assert.equal( idle.moving, false );
	close( idle.turnDelta, 0 );

} );

test( 'PLATFORMER-CONTROL-006 ground and air acceleration are independently bounded', () => {

	const model = new PlatformerControlModel( {
		moveSpeed: 4,
		groundAcceleration: 10,
		airAcceleration: 2,
	} );
	const common = {
		axes: { x: 0, y: 1 },
		cameraForward: { x: 0, y: 0, z: - 1 },
		velocity: { x: 20, y: 8, z: 20 },
	};
	const ground = model.update( 1 / 60, { ...common, supported: true } );
	close( Math.hypot( ground.acceleration.x, ground.acceleration.y, ground.acceleration.z ), 10 );
	close( ground.acceleration.y, 0 );
	const air = model.update( 1 / 60, { ...common, supported: false } );
	close( Math.hypot( air.acceleration.x, air.acceleration.y, air.acceleration.z ), 2 );
	close( air.acceleration.y, 0 );

} );

test( 'PLATFORMER-CONTROL-007 update reuses its view and vector records', () => {

	const model = new PlatformerControlModel();
	const first = model.update( 1 / 60, {
		axes: { x: 0, y: 1 },
		cameraForward: { x: 0, y: 0, z: - 1 },
		velocity: { x: 0, y: 0, z: 0 },
	} );
	const direction = first.direction;
	const acceleration = first.acceleration;
	const second = model.update( 1 / 60, {
		axes: { x: 1, y: 0 },
		cameraForward: { x: 0, y: 0, z: - 1 },
		velocity: { x: 0, y: 0, z: 0 },
	} );
	assert.equal( second, first );
	assert.equal( second.direction, direction );
	assert.equal( second.acceleration, acceleration );

} );

test( 'PLATFORMER-CONTROL-008 long fixed-step runs preserve every hot-path record', () => {

	const model = new PlatformerControlModel();
	const references = [
		model.view,
		model.direction,
		model.facing,
		model.desiredVelocity,
		model.acceleration,
		model._axis,
		model._normal,
		model._worldUp,
		model._previousNormal,
		model.surfaceForward,
		model._cameraHeading,
		model._cameraCandidate,
		model._from,
		model._cross,
		model._surfaceRight,
		model._transportScratch,
		model._transportScratch.axis,
		model._transportScratch.firstCross,
		model._transportScratch.secondCross,
		model._transportScratch.yawCross,
		model._transportScratch.supportCross,
		model._tangentVelocity,
	];
	const axes = { x: 0, y: 0 };
	const cameraForward = { x: 0, y: -0.2, z: -1 };
	const supportNormal = { x: 0, y: 1, z: 0 };
	const velocity = { x: 0, y: 0, z: 0 };
	const input = {
		axes,
		cameraForward,
		supportNormal,
		velocity,
		supported: true,
		sprint: false,
	};
	for ( let frame = 0; frame < 25_000; frame ++ ) {

		axes.x = Math.sin( frame * 0.017 );
		axes.y = Math.cos( frame * 0.013 );
		cameraForward.x = Math.sin( frame * 0.001 );
		cameraForward.z = - Math.cos( frame * 0.001 );
		velocity.x = Math.sin( frame * 0.01 ) * 0.5;
		velocity.z = Math.cos( frame * 0.01 ) * 0.5;
		input.supported = frame % 101 !== 0;
		input.sprint = frame % 43 === 0;
		assert.equal( model.update( 1 / 120, input ), references[ 0 ] );

	}
	const current = [
		model.view,
		model.direction,
		model.facing,
		model.desiredVelocity,
		model.acceleration,
		model._axis,
		model._normal,
		model._worldUp,
		model._previousNormal,
		model.surfaceForward,
		model._cameraHeading,
		model._cameraCandidate,
		model._from,
		model._cross,
		model._surfaceRight,
		model._transportScratch,
		model._transportScratch.axis,
		model._transportScratch.firstCross,
		model._transportScratch.secondCross,
		model._transportScratch.yawCross,
		model._transportScratch.supportCross,
		model._tangentVelocity,
	];
	for ( let index = 0; index < references.length; index ++ )
		assert.equal( current[ index ], references[ index ], `hot-path record ${ index } was replaced` );

} );

test( 'PLATFORMER-CONTROL-009 initial wall heading changes continuously with camera yaw', () => {

	const normal = { x: 0, y: 0, z: 1 };
	for ( const epsilon of [ -0.25, -0.205, -0.2, -0.02, 0, 0.02, 0.2, 0.205, 0.25 ] ) {

		const model = new PlatformerControlModel();
		model.reset( { x: 0, y: 1, z: 0 }, normal );
		const view = model.update( 1 / 120, {
			axes: { x: 0, y: 1 },
			cameraForward: { x: epsilon, y: -0.25, z: -1 },
			supportNormal: normal,
			velocity: { x: 0, y: 0, z: 0 },
			supported: true,
		} );
		const inverseLength = 1 / Math.hypot( epsilon, 1 );
		vectorClose( view.direction, {
			x: epsilon * inverseLength,
			y: inverseLength,
			z: 0,
		}, 2e-8 );
		close( view.direction.x * normal.x + view.direction.y * normal.y
			+ view.direction.z * normal.z, 0 );

	}

} );

test( 'PLATFORMER-CONTROL-010 transported forward follows a cylinder without lateral drift', () => {

	const model = new PlatformerControlModel();
	model.reset( { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 } );
	let previous = null;
	for ( let degrees = 0; degrees <= 180; degrees += 5 ) {

		const angle = degrees * Math.PI / 180;
		const normal = { x: 0, y: Math.cos( angle ), z: Math.sin( angle ) };
		const expected = { x: 0, y: Math.sin( angle ), z: -Math.cos( angle ) };
		const view = model.update( 1 / 120, {
			axes: { x: 0, y: 1 },
			cameraForward: { x: 0, y: -0.2, z: -1 },
			supportNormal: normal,
			velocity: { x: 0, y: 0, z: 0 },
			supported: true,
		} );
		const alignment = view.direction.x * expected.x
			+ view.direction.y * expected.y + view.direction.z * expected.z;
		assert.ok( alignment >= 0.995,
			`cylinder ${ degrees } degrees drifted: alignment ${ alignment }` );
		close( view.direction.x * normal.x + view.direction.y * normal.y
			+ view.direction.z * normal.z, 0, 2e-8 );
		if ( previous ) {

			const continuity = previous.x * view.direction.x
				+ previous.y * view.direction.y + previous.z * view.direction.z;
			assert.ok( continuity >= Math.cos( 5 * Math.PI / 180 ) - 1e-6 );

		}
		previous = { ...view.direction };

	}

} );

test( 'PLATFORMER-CONTROL-011 first update anchors forward to the actual camera yaw', () => {

	const model = new PlatformerControlModel();
	model.reset();
	for ( let tick = 0; tick < 2; tick ++ ) {

		const view = model.update( 1 / 120, {
			axes: { x: 0, y: 1 },
			cameraForward: { x: -1, y: -0.25, z: 0 },
			supportNormal: { x: 0, y: 1, z: 0 },
			velocity: { x: 0, y: 0, z: 0 },
			supported: true,
		} );
		vectorClose( view.direction, { x: -1, y: 0, z: 0 } );

	}

} );

test( 'PLATFORMER-CONTROL-012 initial oblique heading keeps its axial component around a cylinder', () => {

	const model = new PlatformerControlModel();
	model.reset();
	let previous = null;
	const horizontalLength = Math.hypot( 0.55, 1 );
	for ( let degrees = 0; degrees <= 180; degrees += 5 ) {

		const angle = degrees * Math.PI / 180;
		const normal = { x: 0, y: Math.cos( angle ), z: Math.sin( angle ) };
		const expected = {
			x: 0.55 / horizontalLength,
			y: Math.sin( angle ) / horizontalLength,
			z: -Math.cos( angle ) / horizontalLength,
		};
		const view = model.update( 1 / 120, {
			axes: { x: 0, y: 1 },
			cameraForward: { x: 0.55, y: -0.2, z: -1 },
			supportNormal: normal,
			velocity: { x: 0, y: 0, z: 0 },
			supported: true,
		} );
		const alignment = view.direction.x * expected.x
			+ view.direction.y * expected.y + view.direction.z * expected.z;
		assert.ok( alignment >= 0.995,
			`oblique cylinder ${ degrees } degrees drifted: alignment ${ alignment }` );
		close( view.direction.x * normal.x + view.direction.y * normal.y
			+ view.direction.z * normal.z, 0, 2e-8 );
		if ( previous ) assert.ok(
			previous.x * view.direction.x + previous.y * view.direction.y
				+ previous.z * view.direction.z >= Math.cos( 5 * Math.PI / 180 ) - 1e-6,
		);
		previous = { ...view.direction };

	}

} );

test( 'PLATFORMER-CONTROL-013 a floor command is transported across a wall seam without side snap', () => {

	const movement = { x: 0.482, y: 0, z: -0.876 };
	const target = { x: 0, y: 0, z: 0 };
	const scratch = {
		axis: { x: 0, y: 0, z: 0 },
		firstCross: { x: 0, y: 0, z: 0 },
		secondCross: { x: 0, y: 0, z: 0 },
	};
	parallelTransportTangent(
		target, movement,
		{ x: 0, y: 1, z: 0 },
		{ x: 0, y: 0, z: 1 },
		scratch,
	);
	const inverseLength = 1 / Math.hypot( movement.x, movement.z );
	vectorClose( target, {
		x: movement.x * inverseLength,
		y: -movement.z * inverseLength,
		z: 0,
	}, 2e-8 );
	assert.ok( target.x > 0.45 && target.y > 0.85,
		`seam transport collapsed to ${ JSON.stringify( target ) }` );

} );
