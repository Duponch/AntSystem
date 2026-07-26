import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
	buildCorridorNetwork,
	CORRIDOR_SURFACE_TRACKS,
	sampleCorridorSurface,
} from '../src/navigation/corridor-network.js';
import {
	buildEntranceTubeGeometry,
	buildGroundWithEntrance,
	entranceMouth,
	resolveEntranceLipStep,
} from '../src/navigation/entrance-geometry.js';
import { MIN_NEST_DEPTH } from '../src/config.js';
import { buildNest } from '../src/nest.js';
import { makeIrregularNest } from './helpers/corridor-fixtures.js';

test( 'NAV-ENTRANCE-002 the surface mesh contains a physical raycast hole', () => {

	const navigation = buildCorridorNetwork( makeIrregularNest( 8 ), { samples: 64 } );
	const layout = { navigation };
	const geometry = buildGroundWithEntrance( layout, 200 );
	const mouth = entranceMouth( layout );
	const mesh = new THREE.Mesh( geometry, new THREE.MeshBasicMaterial( { side: THREE.DoubleSide } ) );
	mesh.updateMatrixWorld( true );
	const ray = new THREE.Raycaster(
		new THREE.Vector3( mouth.x, 10, mouth.z ),
		new THREE.Vector3( 0, - 1, 0 ),
	);

	assert.equal( ray.intersectObject( mesh ).length, 0 );

	ray.ray.origin.set( mouth.x + mouth.radius * 1.5, 10, mouth.z );
	assert.ok( ray.intersectObject( mesh ).length > 0 );

} );

test( 'NAV-ENTRANCE-003 the procedural throat and ground share one mouth radius', () => {

	const navigation = buildCorridorNetwork( makeIrregularNest( 8 ), { samples: 64 } );
	const layout = { navigation };
	const mouth = entranceMouth( layout );
	const tube = buildEntranceTubeGeometry( layout, 32 );
	const positions = tube.getAttribute( 'position' );
	let min = Infinity, max = 0;

	for ( let i = 0; i < 32; i ++ ) {

		const radius = Math.hypot(
			positions.getX( i ) - mouth.x,
			positions.getZ( i ) - mouth.z,
		);
		min = Math.min( min, radius );
		max = Math.max( max, radius );

	}

	assert.ok( Math.abs( min - mouth.radius ) < 1e-5 );
	assert.ok( Math.abs( max - mouth.radius ) < 1e-5 );

} );

test( 'NAV-ENTRANCE-005 the rendered ring and every navigation contact meet ground at y=0', () => {

	const nest = buildNest( 8, MIN_NEST_DEPTH, 6, false );
	const navigation = buildCorridorNetwork( nest, { samples: 64 } );
	const layout = { navigation };
	const mouth = entranceMouth( layout );
	const sides = 48;
	const tube = buildEntranceTubeGeometry( layout, sides );
	const positions = tube.getAttribute( 'position' );
	const EPS_Y = 1e-6;

	assert.equal( nest.entry.depth, 0 );
	assert.equal( navigation.nodes[ 0 ].depth, 0 );
	assert.equal( mouth.y, 0 );

	for ( let side = 0; side < sides; side ++ ) assert.ok(
		Math.abs( positions.getY( side ) ) <= EPS_Y,
		`rendered entrance ring side ${ side } is not on y=0`,
	);

	for ( let track = 0; track < CORRIDOR_SURFACE_TRACKS; track ++ ) {

		const angle = track / CORRIDOR_SURFACE_TRACKS * Math.PI * 2;
		const contact = sampleCorridorSurface( navigation, 1, 0, angle, 1 );
		assert.ok(
			Math.abs( contact.depth ) <= EPS_Y,
			`navigation entrance contact track ${ track } is not on y=0`,
		);

	}

} );
test( 'NAV-ENTRANCE-006 swept lip catches a large-dt crossing at first impact and slides', () => {

	const center = { x: 0, y: 0 };
	const result = resolveEntranceLipStep(
		{ x: - 12, y: 0 }, { x: 24, y: 3 }, center, 3, 1 );

	assert.equal( result.collided, true );
	assert.ok( result.impactT > 0 && result.impactT < 1 );
	assert.ok( Math.hypot( result.x, result.y ) >= 4 );
	assert.ok( result.y > 0, 'the remaining tangential component must be preserved' );

} );

test( 'NAV-ENTRANCE-007 tangency and a start on the lip never penetrate', () => {

	const center = { x: 0, y: 0 };
	const tangent = resolveEntranceLipStep(
		{ x: - 10, y: 4 }, { x: 20, y: 0 }, center, 3, 1 );
	assert.equal( tangent.collided, false );
	assert.ok( Math.abs( tangent.x - 10 ) < 1e-9 );
	assert.ok( Math.abs( tangent.y - 4 ) < 1e-9 );

	const inward = resolveEntranceLipStep(
		{ x: 4, y: 0 }, { x: - 3, y: 2 }, center, 3, 1 );
	assert.equal( inward.collided, true );
	assert.ok( Math.hypot( inward.x, inward.y ) >= 4 );
	assert.ok( inward.y > 1.99, 'the lip must remove only the inward component' );

	const outward = resolveEntranceLipStep(
		{ x: 4, y: 0 }, { x: 2, y: 0 }, center, 3, 1 );
	assert.equal( outward.collided, false );
	assert.ok( Math.abs( outward.x - 6 ) < 1e-9 );

} );

test( 'NAV-ENTRANCE-008 no outside surface segment can finish inside mouth plus body radius', () => {

	const center = { x: 2.5, y: - 1.75 };
	const mouthRadius = 2.8;
	const bodyRadius = 0.7;
	const safeRadius = mouthRadius + bodyRadius;

	for ( let angleIndex = 0; angleIndex < 96; angleIndex ++ ) {

		const angle = angleIndex / 96 * Math.PI * 2;
		const start = {
			x: center.x + Math.cos( angle ) * ( safeRadius + 0.001 ),
			y: center.y + Math.sin( angle ) * ( safeRadius + 0.001 ),
		};
		for ( let directionIndex = 0; directionIndex < 48; directionIndex ++ ) {

			const direction = directionIndex / 48 * Math.PI * 2;
			const distance = 0.25 + ( directionIndex % 7 ) * 3.75;
			const result = resolveEntranceLipStep( start, {
				x: Math.cos( direction ) * distance,
				y: Math.sin( direction ) * distance,
			}, center, mouthRadius, bodyRadius );
			assert.ok(
				Math.hypot( result.x - center.x, result.y - center.y ) >= safeRadius - 1e-8,
				`penetration angle=${angleIndex}, direction=${directionIndex}`,
			);

		}

	}

} );
test( 'NAV-ENTRANCE-009 an ant emerging inside the lip spends distance and never moves deeper', () => {

	const center = { x: 0, y: 0 };
	const outward = resolveEntranceLipStep(
		{ x: 2, y: 0 }, { x: 0.5, y: 0 }, center, 3, 1 );
	assert.equal( outward.collided, false );
	assert.equal( outward.egressing, true );
	assert.ok( Math.abs( outward.x - 2.5 ) < 1e-9,
		'emergence must not teleport directly to the 4-unit safe radius' );

	const tangent = resolveEntranceLipStep(
		{ x: 2, y: 0 }, { x: 0, y: 1 }, center, 3, 1 );
	assert.equal( tangent.collided, false );
	assert.ok( Math.hypot( tangent.x, tangent.y ) > 2 );

	const inward = resolveEntranceLipStep(
		{ x: 2, y: 0 }, { x: - 1, y: 1 }, center, 3, 1 );
	assert.equal( inward.collided, true );
	assert.equal( inward.egressing, true );
	assert.ok( Math.hypot( inward.x, inward.y ) >= 2,
		'an emerging ant may slide but must never return deeper into the throat' );

} );
test( 'NAV-ENTRANCE-010 only an authorized entrant may engage the mouth collar', () => {

	const center = { x: 0, y: 0 };
	const start = { x: 4.1, y: 0 };
	const delta = { x: - 1.6, y: 0 };
	const bystander = resolveEntranceLipStep( start, delta, center, 3, 1 );
	const entrant = resolveEntranceLipStep( start, delta, center, 3, 1, true );

	assert.equal( bystander.collided, true );
	assert.ok( Math.hypot( bystander.x, bystander.y ) >= 4 );
	assert.equal( entrant.collided, true );
	assert.ok( Math.hypot( entrant.x, entrant.y ) >= 3 );
	assert.ok( Math.hypot( entrant.x, entrant.y ) < 3.01,
		'the entrant reaches the exact mouth, never its centre' );

} );