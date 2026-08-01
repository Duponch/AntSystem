import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import {
	AutonomousExplorer,
	cameraRelativeMovement,
	movementAxesFromKeys,
	ThirdPersonCamera,
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

test( 'CHAMELEON-LAB-CONTROLLER-007 autonomous watchdog reroutes only after sustained lack of progress', () => {

	const floor = new THREE.Vector3( 0, 1, 0 );
	const staticPosition = new THREE.Vector3();
	const stuck = new AutonomousExplorer( 0x9a7f );
	stuck.heading.set( 1, 0, 0 );
	stuck.timeToChange = 100;
	stuck.resetProgress( staticPosition );
	for ( let step = 0; step < 211; step ++ )
		stuck.update( 1 / 120, floor, staticPosition );
	assert.ok( stuck.heading.distanceToSquared( new THREE.Vector3( 1, 0, 0 ) ) > 0.01 );
	assert.ok( stuck.timeToChange < 3 );

	const moving = new AutonomousExplorer( 0x9a7f );
	const movingPosition = new THREE.Vector3();
	moving.heading.set( 1, 0, 0 );
	moving.timeToChange = 100;
	moving.resetProgress( movingPosition );
	for ( let step = 0; step < 211; step ++ ) {

		movingPosition.x += 0.001;
		moving.update( 1 / 120, floor, movingPosition );

	}
	assert.ok( moving.heading.distanceToSquared( new THREE.Vector3( 1, 0, 0 ) ) <= EPSILON );
	assert.ok( moving.timeToChange > 98 );

} );

test( 'CHAMELEON-LAB-CONTROLLER-008 pointer cancellation always releases camera rotation', () => {

	class FakeCanvas {

		constructor() {

			this.listeners = new Map();
			this.captured = null;

		}

		addEventListener( type, listener ) {

			this.listeners.set( type, listener );

		}

		removeEventListener( type, listener ) {

			if ( this.listeners.get( type ) === listener ) this.listeners.delete( type );

		}

		setPointerCapture( pointerId ) {

			this.captured = pointerId;

		}

		hasPointerCapture( pointerId ) {

			return this.captured === pointerId;

		}

		releasePointerCapture( pointerId ) {

			if ( this.captured === pointerId ) this.captured = null;

		}

		emit( type, event ) {

			this.listeners.get( type )( event );

		}

	}

	const canvas = new FakeCanvas();
	const controller = new ThirdPersonCamera( {
		camera: new THREE.PerspectiveCamera(),
		domElement: canvas,
		physics: {},
		targetProvider: () => new THREE.Vector3(),
	} );
	canvas.emit( 'pointerdown', { button: 2, clientX: 20, clientY: 30, pointerId: 7 } );
	assert.equal( controller.rotating, true );
	canvas.emit( 'pointercancel', { button: -1, pointerId: 7 } );
	assert.equal( controller.rotating, false );
	assert.equal( canvas.captured, null );

	canvas.emit( 'pointerdown', { button: 2, clientX: 20, clientY: 30, pointerId: 8 } );
	canvas.emit( 'lostpointercapture', { pointerId: 8 } );
	assert.equal( controller.rotating, false );
	controller.dispose();
	assert.equal( canvas.listeners.size, 0 );

} );

test( 'CHAMELEON-LAB-CONTROLLER-009 autonomous heading crosses a convex edge geodesically', () => {

	const explorer = new AutonomousExplorer( 0x62f3a9 );
	const position = new THREE.Vector3();
	const normal = new THREE.Vector3();
	const expected = new THREE.Vector3();
	const direction = new THREE.Vector3();
	const previous = new THREE.Vector3();
	explorer.heading.set( -1, 0, 0 );
	explorer.timeToChange = 100;
	explorer.resetProgress( position );
	let hasPrevious = false;

	const sample = ( degrees, secondEdge ) => {

		const angle = degrees * Math.PI / 180;
		if ( secondEdge ) {

			// Top (+Y) towards the opposite wall (-X). The transported forward
			// finishes downwards; a permanent world-up wall bias would reverse it.
			normal.set( -Math.sin( angle ), Math.cos( angle ), 0 );
			expected.set( -Math.cos( angle ), -Math.sin( angle ), 0 );

		} else {

			// Near wall (+X) towards the top (+Y).
			normal.set( Math.cos( angle ), Math.sin( angle ), 0 );
			expected.set( -Math.sin( angle ), Math.cos( angle ), 0 );

		}
		direction.copy( explorer.update( 1 / 120, normal, position ) ).normalize();
		assert.ok( Math.abs( direction.dot( normal ) ) < 1e-9,
			`heading left the support plane at ${ degrees } degrees` );
		assert.ok( direction.dot( expected ) > 0.999999,
			`heading diverged from its geodesic at ${ degrees } degrees: ${ direction.toArray() }` );
		if ( hasPrevious ) assert.ok(
			previous.dot( direction ) >= Math.cos( 5 * Math.PI / 180 ) - 1e-8,
			`heading snapped at ${ degrees } degrees`,
		);
		previous.copy( direction );
		hasPrevious = true;
		position.addScaledVector( direction, 0.002 );

	};

	for ( let degrees = 0; degrees <= 90; degrees += 5 ) sample( degrees, false );
	for ( let degrees = 5; degrees <= 90; degrees += 5 ) sample( degrees, true );
	assert.ok( direction.dot( new THREE.Vector3( 0, -1, 0 ) ) > 0.999999,
		`opposite wall heading did not descend: ${ direction.toArray() }` );
	assert.ok( Math.abs( explorer.update( 1 / 120, normal, position ).length() - 0.72 ) <= EPSILON );

} );

test( 'CHAMELEON-LAB-CONTROLLER-010 autonomous geodesic update reuses every hot-path record', () => {

	const explorer = new AutonomousExplorer( 0x4c2a91 );
	const normal = new THREE.Vector3( 1, 0, 0 );
	const position = new THREE.Vector3();
	explorer.timeToChange = 100;
	explorer.resetProgress( position );
	const output = explorer.update( 1 / 120, normal, position );
	const references = [
		explorer.heading,
		explorer.lastPosition,
		explorer.output,
		explorer._surfaceNormal,
		explorer._previousSurfaceNormal,
		explorer._surfaceHeading,
		explorer._boundaryCorrection,
		explorer._transportScratch,
		explorer._transportScratch.axis,
		explorer._transportScratch.firstCross,
		explorer._transportScratch.secondCross,
	];
	assert.equal( output, explorer.output );
	for ( let step = 1; step <= 4_096; step ++ ) {

		const angle = step * 0.0005;
		normal.set( Math.cos( angle ), Math.sin( angle ), 0 );
		position.addScaledVector( output, 0.002 );
		assert.equal( explorer.update( 1 / 120, normal, position ), output );

	}
	assert.deepEqual( [
		explorer.heading,
		explorer.lastPosition,
		explorer.output,
		explorer._surfaceNormal,
		explorer._previousSurfaceNormal,
		explorer._surfaceHeading,
		explorer._boundaryCorrection,
		explorer._transportScratch,
		explorer._transportScratch.axis,
		explorer._transportScratch.firstCross,
		explorer._transportScratch.secondCross,
	], references );
	assert.ok( [ output.x, output.y, output.z ].every( Number.isFinite ) );
	assert.ok( Math.abs( output.length() - 0.72 ) <= EPSILON );

} );
