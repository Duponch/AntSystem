import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import {
	AutonomousExplorer,
	cameraRelativeMovement,
	movementAxesFromKeys,
} from '../src/chameleon-lab/third-person-controller.js';

const EPSILON = 1e-10;

function assertVectorClose( actual, expected, epsilon = EPSILON ) {

	for ( const axis of [ 'x', 'y', 'z' ] ) {

		assert.ok(
			Math.abs( actual[ axis ] - expected[ axis ] ) <= epsilon,
			`${ axis }: expected ${ expected[ axis ] }, received ${ actual[ axis ] }`,
		);

	}

}

test( 'CHAMELEON-LAB-CONTROLLER-001 maps QWERTY, AZERTY and arrow movement consistently', () => {

	for ( const key of [ 'KeyW', 'KeyZ', 'ArrowUp' ] ) {

		assert.deepEqual( movementAxesFromKeys( new Set( [ key ] ) ), { x: 0, y: 1 } );

	}
	for ( const key of [ 'KeyA', 'KeyQ', 'ArrowLeft' ] ) {

		assert.deepEqual( movementAxesFromKeys( new Set( [ key ] ) ), { x: - 1, y: 0 } );

	}
	for ( const key of [ 'KeyS', 'ArrowDown' ] ) {

		assert.deepEqual( movementAxesFromKeys( new Set( [ key ] ) ), { x: 0, y: - 1 } );

	}
	for ( const key of [ 'KeyD', 'ArrowRight' ] ) {

		assert.deepEqual( movementAxesFromKeys( new Set( [ key ] ) ), { x: 1, y: 0 } );

	}

	assert.deepEqual( movementAxesFromKeys( new Set( [ 'KeyW', 'KeyZ', 'ArrowUp' ] ) ), { x: 0, y: 1 } );
	assert.deepEqual( movementAxesFromKeys( new Set( [ 'KeyA', 'KeyQ', 'ArrowLeft' ] ) ), { x: - 1, y: 0 } );
	assert.deepEqual( movementAxesFromKeys( new Set( [ 'KeyW', 'KeyS' ] ) ), { x: 0, y: 0 } );
	assert.deepEqual( movementAxesFromKeys( new Set( [ 'KeyQ', 'KeyD' ] ) ), { x: 0, y: 0 } );
	assert.deepEqual( movementAxesFromKeys( new Set( [ 'ShiftLeft', 'Space' ] ) ), { x: 0, y: 0 } );

} );

test( 'CHAMELEON-LAB-CONTROLLER-002 normalizes diagonals without changing cardinal speed', () => {

	const diagonal = movementAxesFromKeys( new Set( [ 'KeyZ', 'KeyD' ] ) );
	const inverse = movementAxesFromKeys( new Set( [ 'ArrowDown', 'ArrowLeft' ] ) );

	assert.ok( Math.abs( Math.hypot( diagonal.x, diagonal.y ) - 1 ) <= EPSILON );
	assert.ok( Math.abs( diagonal.x - Math.SQRT1_2 ) <= EPSILON );
	assert.ok( Math.abs( diagonal.y - Math.SQRT1_2 ) <= EPSILON );
	assert.ok( Math.abs( Math.hypot( inverse.x, inverse.y ) - 1 ) <= EPSILON );
	assert.ok( Math.abs( inverse.x + Math.SQRT1_2 ) <= EPSILON );
	assert.ok( Math.abs( inverse.y + Math.SQRT1_2 ) <= EPSILON );

} );

test( 'CHAMELEON-LAB-CONTROLLER-003 projects camera-relative movement onto floor and wall support planes', () => {

	const floorNormal = new THREE.Vector3( 0, 1, 0 );
	const cameraForward = new THREE.Vector3( 0, - 0.7, - 1 );
	const floorForward = cameraRelativeMovement(
		{ x: 0, y: 1 },
		cameraForward,
		floorNormal,
	);
	const floorRight = cameraRelativeMovement(
		{ x: 1, y: 0 },
		cameraForward,
		floorNormal,
	);

	assertVectorClose( floorForward, new THREE.Vector3( 0, 0, - 1 ) );
	assertVectorClose( floorRight, new THREE.Vector3( 1, 0, 0 ) );

	const wallNormal = new THREE.Vector3( 0, 0, 1 );
	const wallCameraForward = new THREE.Vector3( 0.8, - 0.35, - 1 );
	const wallMovement = cameraRelativeMovement(
		{ x: Math.SQRT1_2, y: Math.SQRT1_2 },
		wallCameraForward,
		wallNormal,
	);

	assert.ok( Math.abs( wallMovement.dot( wallNormal ) ) <= EPSILON );
	assert.ok( Math.abs( wallMovement.length() - 1 ) <= EPSILON );
	assertVectorClose( cameraForward, new THREE.Vector3( 0, - 0.7, - 1 ) );
	assertVectorClose( floorNormal, new THREE.Vector3( 0, 1, 0 ) );
	assertVectorClose( wallCameraForward, new THREE.Vector3( 0.8, - 0.35, - 1 ) );
	assertVectorClose( wallNormal, new THREE.Vector3( 0, 0, 1 ) );

} );

test( 'CHAMELEON-LAB-CONTROLLER-004 remains tangent when the camera faces the support normal', () => {

	const normal = new THREE.Vector3( 0, 1, 0 );
	const movement = cameraRelativeMovement(
		{ x: 0, y: 1 },
		new THREE.Vector3( 0, - 1, 0 ),
		normal,
	);
	const idle = cameraRelativeMovement(
		{ x: 0, y: 0 },
		new THREE.Vector3( 0, - 1, 0 ),
		normal,
	);

	assert.ok( movement.length() > 0.999999 );
	assert.ok( Math.abs( movement.dot( normal ) ) <= EPSILON );
	assertVectorClose( idle, new THREE.Vector3() );

} );

test( 'CHAMELEON-LAB-CONTROLLER-005 autonomous exploration is deterministic, finite and speed-bounded', () => {

	const first = new AutonomousExplorer( 0x12345678 );
	const second = new AutonomousExplorer( 0x12345678 );
	const other = new AutonomousExplorer( 0x87654321 );
	const floor = new THREE.Vector3( 0, 1, 0 );
	const wall = new THREE.Vector3( 0, 0, 1 );
	const center = new THREE.Vector3();
	let divergedFromOtherSeed = false;

	for ( let step = 0; step < 1_200; step ++ ) {

		const normal = step % 240 < 120 ? floor : wall;
		const dt = step % 3 === 0 ? 1 / 120 : 1 / 60;
		const a = first.update( dt, normal, center );
		const b = second.update( dt, normal, center );
		const c = other.update( dt, normal, center );

		assertVectorClose( a, b );
		assert.ok( [ a.x, a.y, a.z ].every( Number.isFinite ) );
		assert.ok( a.length() <= 0.72 + EPSILON );
		assert.ok( a.length() >= 0.72 - EPSILON );
		assert.ok( first.timeToChange > 0 && first.timeToChange <= 9 );
		if ( a.distanceToSquared( c ) > 1e-8 ) divergedFromOtherSeed = true;

	}

	assert.equal( first.seed, second.seed );
	assert.equal( first.phase, second.phase );
	assert.equal( first.timeToChange, second.timeToChange );
	assert.ok( divergedFromOtherSeed );

} );

test( 'CHAMELEON-LAB-CONTROLLER-006 autonomous exploration steers back inside world bounds', () => {

	const edge = 9.5;
	for ( const [ position, axis, expectedSign ] of [
		[ new THREE.Vector3( edge + 1, 0, 0 ), 'x', - 1 ],
		[ new THREE.Vector3( - edge - 1, 0, 0 ), 'x', 1 ],
		[ new THREE.Vector3( 0, 0, edge + 1 ), 'z', - 1 ],
		[ new THREE.Vector3( 0, 0, - edge - 1 ), 'z', 1 ],
	] ) {

		const explorer = new AutonomousExplorer( 0x43a91 );
		const movement = explorer.update(
			1 / 60,
			new THREE.Vector3( 0, 1, 0 ),
			position,
		);

		assert.equal( Math.sign( movement[ axis ] ), expectedSign );
		assert.ok( Math.abs( movement.length() - 0.72 ) <= EPSILON );

	}

} );
