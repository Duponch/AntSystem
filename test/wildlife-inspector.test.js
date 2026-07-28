import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import {
	buildWildlifeHudView,
	createWildlifeInspector,
	writeButterflyRayHit,
} from '../src/wildlife-inspector.js';

function butterflyViews( positions, visible = null ) {

	const count = positions.length;
	return {
		x: new Float32Array( positions.map( ( position ) => position[ 0 ] ) ),
		y: new Float32Array( positions.map( ( position ) => position[ 1 ] ) ),
		z: new Float32Array( positions.map( ( position ) => position[ 2 ] ) ),
		headingX: new Float32Array( count ).fill( 0 ),
		headingY: new Float32Array( count ).fill( 0 ),
		headingZ: new Float32Array( count ).fill( 1 ),
		visible: visible || new Uint8Array( count ).fill( 1 ),
	};

}

function createFacade( views, chameleon ) {

	const calls = [];
	const simulation = {
		count: views.x.length,
		getViews: () => views,
	};
	let selectedButterfly = - 1;
	let chameleonSelected = false;
	return {
		calls,
		chameleon,
		getButterflySimulation: () => simulation,
		selectButterfly( index ) {

			selectedButterfly = index;
			calls.push( `butterfly:${ index }` );

		},
		clearButterflySelection() {

			selectedButterfly = - 1;
			calls.push( 'butterfly:clear' );

		},
		getButterflyDebugSnapshot() {

			if ( selectedButterfly < 0 ) return null;
			return {
				index: selectedButterfly,
				stage: 'ADULT',
				behavior: 'FLY',
				intention: 'FLEE_CHAMELEON',
				threatVisible: true,
				threatDistance: 2.5,
				visionDistance: 8,
				visionFovDegrees: 250,
				targetFlower: - 1,
			};

		},
		selectChameleon( selected ) {

			chameleonSelected = !! selected;
			calls.push( `chameleon:${ chameleonSelected }` );

		},
		getChameleonDebugView() {

			return {
				visible: true,
				x: 0,
				y: 0,
				z: 6,
				mouthX: 0.25,
				mouthY: 0.5,
				mouthZ: 6.5,
				stateName: 'PATROL_LOG',
				locomotionState: 'roam',
				attackDistance: 3.2,
				detectionDistance: 4.8,
				supportModel: 'Log_01',
				supportSegment: 4,
				camouflaged: false,
			};

		},
		get selectedButterfly() {

			return selectedButterfly;

		},
		get chameleonSelected() {

			return chameleonSelected;

		},
	};

}

test( 'WILDLIFE-INSPECTOR-001 logical ray picking is bounded, visibility-aware and nearest-first', () => {

	const views = butterflyViews(
		[ [ 0.03, 0, 8 ], [ 0.01, 0, 4 ], [ 0, 0, 2 ], [ 4, 0, 3 ] ],
		new Uint8Array( [ 1, 1, 0, 1 ] ),
	);
	const output = {};
	const returned = writeButterflyRayHit(
		views,
		999,
		{ x: 0, y: 0, z: 0 },
		{ x: 0, y: 0, z: 2 },
		output,
		{ baseRadius: 0.1, angularRadius: 0 },
	);

	assert.equal( returned, output, 'the caller-owned result object must be reused' );
	assert.equal( output.index, 1, 'the hidden closer point must not be selected' );
	assert.ok( Math.abs( output.distance - 4 ) < 1e-6 );

	writeButterflyRayHit(
		views,
		views.x.length,
		{ x: 0, y: 0, z: 0 },
		{ x: 0, y: 0, z: 0 },
		output,
	);
	assert.equal( output.index, - 1, 'a degenerate ray must remain a miss' );

} );

test( 'WILDLIFE-INSPECTOR-002 click arbitration selects the closest species and raycasts only on click', () => {

	const scene = new THREE.Scene();
	const chameleon = new THREE.Mesh(
		new THREE.BoxGeometry( 1, 1, 1 ),
		new THREE.MeshBasicMaterial(),
	);
	chameleon.position.set( 0, 0, 7 );
	scene.add( chameleon );
	const views = butterflyViews( [ [ 0, 0, 3 ] ] );
	const facade = createFacade( views, chameleon );
	let raycastCount = 0;
	const originalRaycast = chameleon.raycast.bind( chameleon );
	chameleon.raycast = function countedRaycast( ...args ) {

		raycastCount ++;
		return originalRaycast( ...args );

	};
	const graphics = {
		butterflyScale: 1,
		butterflyPredatorVisionDistance: 8,
		butterflyPredatorVisionAngle: 250,
		butterflyDebugVision: true,
		chameleonAttackDistance: 3.2,
		chameleonDebugAttackRange: true,
	};
	const inspector = createWildlifeInspector( {
		scene,
		pollinators: facade,
		graphics,
		documentRef: null,
	} );

	inspector.update( 1 / 60, true );
	assert.equal( raycastCount, 0, 'regular updates must never raycast' );
	inspector.pick(
		new THREE.Vector3( 0, 0, 0 ),
		new THREE.Vector3( 0, 0, 1 ),
	);
	assert.equal( raycastCount, 1 );
	assert.equal( inspector.selected.kind, 'butterfly' );
	assert.equal( inspector.selected.index, 0 );
	assert.equal( facade.selectedButterfly, 0 );

	inspector.update( 1 / 60, true );
	assert.equal( inspector.visionVolume.visible, true );
	const blindCone = inspector.visionVolume.getObjectByName( 'SelectedButterflyBlindCone' );
	assert.ok( blindCone, 'a >180° field is represented by a range sphere and rear blind cone' );
	assert.ok( blindCone.scale.x > 0 && blindCone.scale.y > 0 && blindCone.scale.z > 0 );
	assert.equal( raycastCount, 1, 'debug updates still must not raycast' );

	views.visible[ 0 ] = 0;
	inspector.pick(
		new THREE.Vector3( 0, 0, 0 ),
		new THREE.Vector3( 0, 0, 1 ),
	);
	assert.equal( inspector.selected.kind, 'chameleon' );
	assert.equal( facade.chameleonSelected, true );
	inspector.update( 1 / 60, true );
	assert.equal( inspector.attackVolume.visible, true );
	assert.equal( inspector.attackVolume.scale.x, 3.2 );
	assert.deepEqual( inspector.attackVolume.position.toArray(), [ 0.25, 0.5, 6.5 ] );
	assert.equal( raycastCount, 2, 'selected-only debug must not add raycasts' );

	inspector.clear();
	assert.equal( inspector.selected, null );
	assert.equal( inspector.group.visible, false );
	inspector.dispose();
	assert.equal( scene.getObjectByName( 'SelectedWildlifeDebug' ), undefined );
	chameleon.geometry.dispose();
	chameleon.material.dispose();

} );

test( 'WILDLIFE-INSPECTOR-003 HUD explains intention, threat, support and camouflage', () => {

	const chameleon = buildWildlifeHudView( 'chameleon', {
		stateName: 'AIM_AND_BRACE',
		locomotionState: 'camouflage',
		targetIndex: 7,
		supportModel: 'Log_02',
		supportSegment: 12,
		camouflaged: true,
		camouflageRemaining: 2.4,
		attackDistance: 3.2,
		detectionDistance: 4.8,
	} );
	assert.match( chameleon.html, /Se cale avant l’attaque/ );
	assert.match( chameleon.html, /Papillon #7 suivi/ );
	assert.match( chameleon.html, /Log_02 · segment 12/ );
	assert.match( chameleon.html, /Actif .* rouge .* invisible pour les papillons .* 2,4 s/u );
	assert.match( chameleon.html, /Navigation<\/div><div>Locale/u );

	const butterfly = buildWildlifeHudView( 'butterfly', {
		index: 3,
		stage: 'ADULT',
		behavior: 'FLY',
		intention: 'FLEE_CHAMELEON',
		threatVisible: true,
		threatDistance: 1.75,
		targetFlower: - 1,
		visionDistance: 8,
		visionFovDegrees: 250,
		predatorCamouflaged: false,
	} );
	assert.match( butterfly.html, /Fuit le caméléon/ );
	assert.match( butterfly.html, /Caméléon vu à 1,8 u/ );
	assert.match( butterfly.html, /Vol libre/ );
	assert.match( butterfly.html, /250°/ );

} );
