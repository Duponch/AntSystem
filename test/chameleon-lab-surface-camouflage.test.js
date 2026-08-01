import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import { createLabEnvironment } from '../src/chameleon-lab/environment.js';
import {
	LAB_SURFACE_APPEARANCES,
	createSurfaceAppearanceBinding,
	getLabSurfacePatternTexture,
	resolveLabSurfaceAppearance,
} from '../src/chameleon-lab/surface-appearance.js';
import {
	advanceSurfaceCamouflageBlend,
	createSurfaceCamouflageController,
	dominantCamouflageSupportHandle,
} from '../src/chameleon-lab/surface-camouflage.js';
import { createPhysicsWorld } from '../src/chameleon-lab/physics-world.js';

function settings() {

	return {
		camouflageEnabled: true,
		camouflageStrength: 0.98,
		camouflageAdaptSeconds: 0.85,
		camouflageReleaseSeconds: 0.45,
		camouflageSurfaceCommitSeconds: 0.1,
		camouflageSurfaceTransitionSeconds: 0.28,
		camouflageSupportHoldSeconds: 0.24,
		camouflageEyeRetention: 0.86,
	};

}

function appearance( key = 'soil' ) {

	const object = new THREE.Object3D();
	object.position.set( 2, 3, -4 );
	object.rotation.set( 0.2, -0.3, 0.1 );
	object.scale.set( 1.5, 0.8, 2 );
	object.updateMatrixWorld( true );
	return createSurfaceAppearanceBinding( object, key );

}

function foot( handle, {
	state = 'holding',
	load = 0,
	profile = 'soil',
	normal = new THREE.Vector3( 0, 1, 0 ),
} = {} ) {

	return {
		state,
		load,
		normal,
		collider: { handle },
		surface: { appearance: appearance( profile ) },
	};

}

test( 'CHAMELEON-LAB-CAMOUFLAGE-001 surface profiles and bindings are immutable', () => {

	assert.ok( Object.isFrozen( LAB_SURFACE_APPEARANCES ) );
	for ( const [ key, profile ] of Object.entries( LAB_SURFACE_APPEARANCES ) ) {

		assert.equal( resolveLabSurfaceAppearance( key ), profile );
		assert.ok( Object.isFrozen( profile ), `${ key } profile must be frozen` );
		assert.ok( Object.isFrozen( profile.palette ), `${ key } palette must be frozen` );
		assert.equal( profile.palette.length, 3 );

	}
	assert.equal( resolveLabSurfaceAppearance( 'branch' ), LAB_SURFACE_APPEARANCES.bark );
	assert.equal( resolveLabSurfaceAppearance( 'rough-rock' ), LAB_SURFACE_APPEARANCES.stone );
	assert.throws( () => resolveLabSurfaceAppearance( 'ice' ), /Unknown/u );

	const binding = appearance( 'wall' );
	assert.ok( Object.isFrozen( binding ) );
	assert.ok( Object.isFrozen( binding.worldToLocal ) );
	assert.ok( Object.isFrozen( binding.worldNormalToLocal ) );
	assert.equal( binding.worldToLocal.length, 16 );
	assert.equal( binding.worldNormalToLocal.length, 9 );
	assert.equal( binding.profile, LAB_SURFACE_APPEARANCES.wall );
	assert.throws( () => binding.worldToLocal.push( 0 ), TypeError );

	const pattern = getLabSurfacePatternTexture();
	assert.equal( pattern.isDataArrayTexture, true );
	assert.equal( pattern.image.width, 64 );
	assert.equal( pattern.image.height, 64 );
	assert.equal( pattern.image.depth, 4 );
	assert.equal( pattern.image.data.byteLength, 64 * 64 * 4 * 4 );
	assert.equal( pattern.wrapS, THREE.RepeatWrapping );
	assert.equal( pattern.wrapT, THREE.RepeatWrapping );
	assert.equal( pattern.minFilter, THREE.LinearMipmapLinearFilter );
	assert.equal( pattern.generateMipmaps, true );

} );

test( 'CHAMELEON-LAB-CAMOUFLAGE-002 the four-foot vote ignores released feet and preserves the current support on ties', () => {

	const feet = [
		foot( 11 ),
		foot( 22 ),
		foot( 11, { state: 'seeking', load: 1 } ),
		foot( 22, { state: 'released', load: 1 } ),
	];
	assert.equal( dominantCamouflageSupportHandle( feet, 11 ), 11 );
	assert.equal( dominantCamouflageSupportHandle( feet, 22 ), 22 );

	feet[ 2 ] = foot( 11, { load: 0.4 } );
	assert.equal( dominantCamouflageSupportHandle( feet, 22 ), 11 );
	feet[ 0 ].surface.appearance = null;
	feet[ 2 ].surface.appearance = null;
	assert.equal( dominantCamouflageSupportHandle( feet, 11 ), 22 );
	assert.equal( dominantCamouflageSupportHandle( [], 11 ), null );

} );

test( 'CHAMELEON-LAB-CAMOUFLAGE-003 adaptation is invariant to render-frame partitioning', () => {

	const elapsed = 0.73;
	const duration = 0.85;
	const single = advanceSurfaceCamouflageBlend( 0.07, 1, elapsed, duration );
	let partitioned = 0.07;
	for ( let index = 0; index < 146; index ++ )
		partitioned = advanceSurfaceCamouflageBlend(
			partitioned, 1, elapsed / 146, duration,
		);
	assert.ok( single > 0.07 && single < 1 );
	assert.ok( Math.abs( single - partitioned ) < 1e-12 );
	assert.equal( advanceSurfaceCamouflageBlend( single, 0, 0, duration ), single );
	assert.equal( advanceSurfaceCamouflageBlend( single, 0, 1, 0 ), 0 );

} );

test( 'CHAMELEON-LAB-CAMOUFLAGE-004 the controller commits, blends, changes support and restores one opaque material', () => {

	const geometry = new THREE.BoxGeometry();
	const vertexColors = new Float32Array(
		geometry.getAttribute( 'position' ).count * 4,
	).fill( 1 );
	geometry.setAttribute( 'color', new THREE.Float32BufferAttribute( vertexColors, 4 ) );
	const natural = new THREE.MeshStandardNodeMaterial( {
		color: 0x5a933f,
		vertexColors: true,
		roughness: 0.8,
	} );
	const mesh = new THREE.Mesh( geometry, natural );
	const config = settings();
	const controller = createSurfaceCamouflageController( [ mesh ], config );
	try {

		assert.equal( mesh.material, natural );
		assert.equal( controller.isAdaptiveActive(), false );
		assert.equal( controller.getAdaptiveMaterialCount(), 1 );

		const contacts = [ foot( 7, { profile: 'bark' } ) ];
		const view = controller.update( 1 / 60, contacts, true );
		assert.equal( view.supportHandle, 7 );
		assert.equal( view.profile, 'bark' );
		assert.equal( view.blend, 1 );
		assert.equal( controller.isAdaptiveActive(), true );
		assert.notEqual( mesh.material, natural );
		assert.ok( mesh.material instanceof THREE.MeshStandardNodeMaterial );
		assert.equal( mesh.material.transparent, false );
		assert.equal( mesh.material.opacity, 1 );
		assert.equal( mesh.material.depthTest, true );
		assert.equal( mesh.material.depthWrite, true );
		assert.ok( mesh.material.colorNode );
		assert.equal( mesh.material.backdropNode, null );

		controller.reset();
		assert.equal( controller.isAdaptiveActive(), false );
		assert.equal( mesh.material, natural );
		assert.equal( controller.uniforms.blend.value, 0 );
		assert.equal( controller.getView().supportHandle, null );
		assert.equal( controller.getView().profile, null );
		assert.equal( controller.getView().active, false );

		const barkContacts = [ foot( 7, { profile: 'bark' } ) ];
		for ( let index = 0; index < 5; index ++ )
			controller.update( 0.02, barkContacts );
		assert.equal( controller.getView().supportHandle, null,
			'the candidate must respect the commit delay' );
		controller.update( 0.02, barkContacts );
		const acquired = controller.getView();
		assert.equal( acquired.supportHandle, 7 );
		assert.equal( acquired.profile, 'bark' );
		assert.ok( acquired.blend > 0 && acquired.blend < 1 );

		const stoneContacts = [
			foot( 9, { profile: 'stone', load: 0.8 } ),
			foot( 9, { profile: 'stone', load: 0.7 } ),
		];
		for ( let index = 0; index < 7; index ++ )
			controller.update( 0.02, stoneContacts );
		assert.equal( controller.getView().supportHandle, 9 );
		assert.equal( controller.getView().profile, 'stone' );
		assert.ok( controller.getView().supportMix > 0
			&& controller.getView().supportMix < 1 );

		const wallContacts = [ foot( 12, { profile: 'wall', load: 1 } ) ];
		for ( let index = 0; index < 4; index ++ )
			controller.update( 0.02, wallContacts );
		assert.equal( controller.getView().supportHandle, 9,
			'a third support must wait for the in-flight cross-fade' );
		for ( let index = 0; index < 28; index ++ )
			controller.update( 0.02, wallContacts );
		assert.equal( controller.getView().supportHandle, 12 );
		assert.equal( controller.getView().profile, 'wall' );

		config.camouflageStrength = 0;
		controller.update( 0.02, wallContacts );
		assert.equal( controller.getView().active, false );
		assert.equal( mesh.material, natural,
			'zero correspondence must restore the zero-cost natural material' );
		config.camouflageStrength = 0.98;
		controller.update( 0.02, wallContacts );
		assert.equal( controller.getView().active, true );

		const beforeRelease = controller.getView().blend;
		for ( let index = 0; index < 10; index ++ )
			controller.update( 0.02, [] );
		assert.ok( controller.getView().blend >= beforeRelease,
			'the short airborne hold must retain camouflage' );
		for ( let index = 0; index < 40; index ++ )
			controller.update( 0.02, [] );
		assert.ok( controller.getView().blend < beforeRelease,
			'camouflage must release after support hold expires' );

	} finally {

		controller.dispose();
		geometry.dispose();
		natural.dispose();

	}

} );

test( 'CHAMELEON-LAB-CAMOUFLAGE-005 surface adaptation has no screen capture, compute, or ray-query API', async () => {

	const source = (
		await Promise.all( [
			'surface-appearance.js',
			'surface-camouflage.js',
		].map( ( file ) => readFile(
			new URL( `../src/chameleon-lab/${ file }`, import.meta.url ),
			'utf8',
		) ) )
	).join( '\n' );
	for ( const forbidden of [
		/viewportSharedTexture/u,
		/viewportTexture/u,
		/backdropNode/u,
		/backdropAlphaNode/u,
		/computeAsync/u,
		/computeNode/u,
		/Raycaster/u,
		/\.raycast\s*\(/u,
		/intersectObjects?\s*\(/u,
	] ) assert.doesNotMatch( source, forbidden );
	assert.match( source, /dominantCamouflageSupportHandle/u );
	assert.match( source, /surfacePigmentNode/u );

} );

test( 'CHAMELEON-LAB-CAMOUFLAGE-006 every grippable laboratory collider exposes a frozen appearance binding', async () => {

	const physics = await createPhysicsWorld();
	const scene = new THREE.Scene();
	const environment = createLabEnvironment( { scene, physics } );
	try {

		assert.ok( environment.colliders.length > 0 );
		for ( const entry of environment.colliders ) {

			const surface = physics.surfaceByCollider.get( entry.collider.handle );
			assert.equal( entry.object.userData.surface, surface );
			assert.ok( Object.isFrozen( surface ) );
			if ( surface.clawEligible ) {

				assert.ok( surface.appearance,
					`${ entry.object.name } is grippable but has no appearance` );
				assert.ok( Object.isFrozen( surface.appearance ) );
				assert.ok( Object.isFrozen( surface.appearance.worldToLocal ) );
				assert.ok( Object.isFrozen( surface.appearance.worldNormalToLocal ) );
				for ( const material of Array.isArray( entry.object.material )
					? entry.object.material
					: [ entry.object.material ] ) {

					assert.equal(
						material.userData.labSurfaceAppearance,
						surface.appearance.profile.key,
						`${ entry.object.name } must render the same profile exposed to camouflage`,
					);

				}

			} else assert.equal( surface.appearance, undefined );

		}

	} finally {

		environment.dispose();
		physics.dispose();

	}

} );

test( 'CHAMELEON-LAB-CAMOUFLAGE-007 runtime and UI expose the complete adaptive-skin lifecycle', async () => {

	const [ main, ui ] = await Promise.all( [
		readFile( new URL( '../src/chameleon-lab/main.js', import.meta.url ), 'utf8' ),
		readFile( new URL( '../src/chameleon-lab/lab-ui.js', import.meta.url ), 'utf8' ),
	] );
	assert.match( main, /createSurfaceCamouflageController/u );
	assert.match( main, /camouflage\.prewarm/u );
	assert.match( main, /camouflage\.update\(\s*dt,\s*ragdoll\.feet\s*\)/u );
	assert.match( main, /camouflage\.reset/u );
	assert.match( main, /camouflage\.dispose/u );
	assert.match( main, /createLabUI\(\s*\{[\s\S]*?camouflage,/u );
	for ( const setting of [
		'camouflageEnabled',
		'camouflageStrength',
		'camouflageAdaptSeconds',
		'camouflageReleaseSeconds',
		'camouflageSurfaceTransitionSeconds',
		'camouflageEyeRetention',
	] ) assert.match( ui, new RegExp( setting, 'u' ) );
	assert.match( ui, /dataset\.camouflage/u );

} );
