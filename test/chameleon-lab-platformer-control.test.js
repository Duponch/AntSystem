import assert from 'node:assert/strict';
import test from 'node:test';

import {
	cameraRelativePlatformerDirection,
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
		model._from,
		model._cross,
		model._tangentVelocity,
		model._directionScratch,
		model._directionScratch.axis,
		model._directionScratch.up,
		model._directionScratch.normal,
		model._directionScratch.camera,
		model._directionScratch.forward,
		model._directionScratch.right,
		model._directionScratch.intent,
		model._directionOptions,
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
		model._from,
		model._cross,
		model._tangentVelocity,
		model._directionScratch,
		model._directionScratch.axis,
		model._directionScratch.up,
		model._directionScratch.normal,
		model._directionScratch.camera,
		model._directionScratch.forward,
		model._directionScratch.right,
		model._directionScratch.intent,
		model._directionOptions,
	];
	for ( let index = 0; index < references.length; index ++ )
		assert.equal( current[ index ], references[ index ], `hot-path record ${ index } was replaced` );

} );
