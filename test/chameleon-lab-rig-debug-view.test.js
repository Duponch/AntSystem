import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { createRigDebugView } from '../src/chameleon-lab/rig-debug-view.js';

const PHYSICAL_ASSET_PATH = fileURLToPath(
	new URL( '../public/assets/ChameleonPhysical.glb', import.meta.url ),
);

async function loadPhysicalAsset() {

	const bytes = await readFile( PHYSICAL_ASSET_PATH );
	const data = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	);
	return ( await new GLTFLoader().parseAsync( data, '' ) ).scene;

}

function createRigFixture() {

	const scene = new THREE.Scene();
	const model = new THREE.Group();
	model.position.set( 2, 0.5, -1 );
	model.rotation.y = 0.35;
	const root = new THREE.Bone();
	root.name = 'pelvis';
	root.position.set( 0.1, 0.2, 0.3 );
	root.userData.rest_length = 0.18;
	const spine = new THREE.Bone();
	spine.name = 'spine';
	spine.position.set( 0, 0.4, 0 );
	spine.userData.rest_length = 0.31;
	const head = new THREE.Bone();
	head.name = 'head';
	head.position.set( -0.2, 0.25, 0 );
	head.userData.rest_length = 0.22;
	root.add( spine );
	spine.add( head );
	model.add( root );
	scene.add( model );
	scene.updateMatrixWorld( true );
	return { scene, model, root, spine, head };

}

function worldPosition( bone ) {

	const elements = bone.matrixWorld.elements;
	return [ elements[ 12 ], elements[ 13 ], elements[ 14 ] ];

}

function worldTip( bone ) {

	const elements = bone.matrixWorld.elements;
	const length = Number( bone.userData.rest_length );
	return [
		elements[ 12 ] + elements[ 4 ] * length,
		elements[ 13 ] + elements[ 5 ] * length,
		elements[ 14 ] + elements[ 6 ] * length,
	];

}

function closeArray( actual, expected, epsilon = 1e-6 ) {

	assert.equal( actual.length, expected.length );
	for ( let index = 0; index < actual.length; index ++ )
		assert.ok( Math.abs( actual[ index ] - expected[ index ] ) <= epsilon,
			`index ${ index }: expected ${ expected[ index ] }, received ${ actual[ index ] }` );

}

test( 'CHAMELEON-LAB-RIG-DEBUG-001 builds one reusable segment per real bone axis', () => {

	const fixture = createRigFixture();
	const debug = createRigDebugView( {
		scene: fixture.scene,
		root: fixture.model,
	} );
	const view = debug.getView();
	assert.equal( view.boneCount, 3 );
	assert.equal( view.segmentCount, 3 );
	assert.equal( view.positions.length, 18 );
	assert.equal( view.colors.length, 18 );
	assert.equal( debug.lines.parent, null );
	assert.equal( view.visible, false );
	assert.equal( view.updates, 0 );
	assert.equal( debug.update(), view );
	assert.equal( view.updates, 0, 'disabled overlays must do no per-frame work' );
	debug.dispose();

} );

test( 'CHAMELEON-LAB-RIG-DEBUG-002 writes exact world-space joints through the skin', () => {

	const fixture = createRigFixture();
	const debug = createRigDebugView( {
		scene: fixture.scene,
		root: fixture.model,
		visible: true,
	} );
	const expected = [
		...worldPosition( fixture.root ), ...worldTip( fixture.root ),
		...worldPosition( fixture.spine ), ...worldTip( fixture.spine ),
		...worldPosition( fixture.head ), ...worldTip( fixture.head ),
	];
	closeArray( debug.positions, expected );
	assert.equal( debug.lines.parent, fixture.scene );
	assert.equal( debug.material.depthTest, false );
	assert.equal( debug.material.depthWrite, false );
	assert.equal( debug.material.transparent, true );
	assert.equal( debug.material.toneMapped, false );
	assert.equal( debug.lines.frustumCulled, false );
	assert.ok( debug.lines.renderOrder >= 10_000 );
	debug.dispose();

} );

test( 'CHAMELEON-LAB-RIG-DEBUG-003 animated refreshes allocate no new view or buffers', () => {

	const fixture = createRigFixture();
	const debug = createRigDebugView( {
		scene: fixture.scene,
		root: fixture.model,
		visible: true,
	} );
	const view = debug.getView();
	const positions = view.positions;
	const colors = view.colors;
	const attribute = debug.positionAttribute;
	const geometry = debug.geometry;
	const material = debug.material;
	const lines = debug.lines;
	for ( let frame = 0; frame < 10_000; frame ++ ) {

		fixture.spine.rotation.z = Math.sin( frame * 0.01 ) * 0.4;
		fixture.head.rotation.x = Math.cos( frame * 0.013 ) * 0.25;
		assert.equal( debug.update(), view );
		assert.equal( debug.getView(), view );

	}
	assert.equal( view.positions, positions );
	assert.equal( view.colors, colors );
	assert.equal( debug.positionAttribute, attribute );
	assert.equal( debug.geometry, geometry );
	assert.equal( debug.material, material );
	assert.equal( debug.lines, lines );
	assert.equal( view.updates, 10_001 );
	assert.ok( Array.from( positions ).every( Number.isFinite ) );
	debug.dispose();

} );

test( 'CHAMELEON-LAB-RIG-DEBUG-004 renderer hook refreshes matrices and toggling removes all idle cost', () => {

	const fixture = createRigFixture();
	const debug = createRigDebugView( {
		scene: fixture.scene,
		root: fixture.model,
		visible: true,
	} );
	fixture.head.position.y += 0.37;
	fixture.scene.updateMatrixWorld( true );
	const before = debug.getView().updates;
	debug.lines.onBeforeRender();
	assert.equal( debug.getView().updates, before + 1 );
	closeArray(
		Array.from( debug.positions.slice( 15, 18 ) ),
		worldTip( fixture.head ),
	);
	debug.setVisible( false );
	assert.equal( debug.lines.parent, null );
	assert.equal( debug.getView().visible, false );
	const disabledUpdates = debug.getView().updates;
	for ( let frame = 0; frame < 1_000; frame ++ ) debug.update( false );
	assert.equal( debug.getView().updates, disabledUpdates );
	debug.setVisible( true );
	assert.equal( debug.lines.parent, fixture.scene );
	assert.equal( debug.getView().updates, disabledUpdates + 1 );
	debug.dispose();

} );

test( 'CHAMELEON-LAB-RIG-DEBUG-005 color, opacity and disposal mutate resources in place', () => {

	const fixture = createRigFixture();
	const debug = createRigDebugView( {
		scene: fixture.scene,
		root: fixture.model,
		visible: true,
	} );
	const colors = debug.colors;
	assert.equal( debug.setColors( 0xff0000, 0x0000ff ), debug );
	assert.equal( debug.colors, colors );
	closeArray( Array.from( colors.slice( 0, 6 ) ), [ 1, 0, 0, 0, 0, 1 ] );
	assert.equal( debug.setOpacity( 0.42 ), debug );
	assert.equal( debug.material.opacity, 0.42 );
	assert.throws( () => debug.setOpacity( Number.NaN ), /opacity/u );
	let geometryDisposals = 0;
	let materialDisposals = 0;
	debug.geometry.addEventListener( 'dispose', () => geometryDisposals ++ );
	debug.material.addEventListener( 'dispose', () => materialDisposals ++ );
	debug.dispose();
	debug.dispose();
	assert.equal( geometryDisposals, 1 );
	assert.equal( materialDisposals, 1 );
	assert.equal( debug.lines.parent, null );
	assert.equal( debug.getView().visible, false );

} );

test( 'CHAMELEON-LAB-RIG-DEBUG-006 rejects roots without an articulated skeleton', () => {

	const scene = new THREE.Scene();
	assert.throws( () => createRigDebugView( {
		scene,
		root: new THREE.Group(),
	} ), /drawable bone/u );
	assert.throws( () => createRigDebugView( {
		scene: null,
		root: new THREE.Group(),
	} ), /scene/u );

} );

test( 'CHAMELEON-LAB-RIG-DEBUG-007 physical asset exposes every anatomical chain to the overlay', async () => {

	const model = await loadPhysicalAsset();
	const scene = new THREE.Scene();
	scene.add( model );
	const debug = createRigDebugView( { scene, root: model, visible: true } );
	const bones = [];
	model.traverse( ( object ) => {

		if ( object.isBone ) bones.push( object );

	} );
	const drawableBones = bones.filter( ( bone ) =>
		Number.isFinite( Number( bone.userData?.rest_length ) )
		&& Number( bone.userData.rest_length ) > 1e-5 );
	assert.equal( debug.getView().boneCount, bones.length );
	assert.equal( debug.getView().segmentCount, drawableBones.length,
		'the overlay must draw each exported bone axis exactly once' );
	const connected = new Set( debug.bones.map( ( bone ) => bone.name ) );
	const required = [
		'neck', 'head', 'jaw',
		...Array.from( { length: 12 }, ( _, index ) =>
			`tail_${ String( index + 1 ).padStart( 2, '0' ) }` ),
	];
	for ( const kind of [ 'front', 'hind' ] ) for ( const side of [ 'L', 'R' ] )
		for ( const role of [ 'girdle', 'upper', 'lower', 'palm', 'digits_inner', 'digits_outer' ] )
			required.push( `${ kind }_${ role }${ side }` );
	for ( const name of required )
		assert.ok( connected.has( name ), `${ name } is absent from the rig overlay graph` );

	const view = debug.getView();
	const positions = view.positions;
	const positionAttribute = debug.positionAttribute;
	const colors = view.colors;
	for ( let frame = 0; frame < 2_000; frame ++ ) {

		model.rotation.y = frame * 0.0001;
		assert.equal( debug.update(), view );

	}
	assert.equal( view.positions, positions );
	assert.equal( view.colors, colors );
	assert.equal( debug.positionAttribute, positionAttribute );
	assert.ok( positions.every( Number.isFinite ) );
	for ( let boneIndex = 0; boneIndex < drawableBones.length; boneIndex ++ ) {

		const offset = boneIndex * 6;
		const length = Math.hypot(
			positions[ offset + 3 ] - positions[ offset ],
			positions[ offset + 4 ] - positions[ offset + 1 ],
			positions[ offset + 5 ] - positions[ offset + 2 ],
		);
		assert.ok( Math.abs( length - Number( drawableBones[ boneIndex ].userData.rest_length ) ) < 2e-5,
			`${ drawableBones[ boneIndex ].name } axis differs from its exported rest length` );

	}
	debug.dispose();

} );
