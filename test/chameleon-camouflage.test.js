import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import {
	MAX_CHAMELEON_ENVIRONMENT_MATCH,
	advanceChameleonCamouflageBlend,
	createChameleonCamouflageController,
	evaluateChameleonCamouflageMatch,
	resolveChameleonCamouflageProfile,
} from '../src/chameleon-camouflage.js';

function settings() {

	return {
		chameleonCamouflageEnvironmentMatch: 0.68,
		chameleonCamouflageEdgeReveal: 0.35,
		chameleonCamouflagePatternStrength: 0.18,
		chameleonCamouflagePatternScale: 3,
		chameleonCamouflageSampleSpread: 0.004,
		chameleonCamouflageShadowRetention: 0.28,
		chameleonCamouflageAdaptSeconds: 2.2,
		chameleonCamouflageReleaseSeconds: 0.8,
	};

}

test( 'CHAMELEON-SIM-034 camouflage progress is monotone and frame-partition independent', () => {

	const duration = 2.2;
	const elapsed = 1;
	const singleStep = advanceChameleonCamouflageBlend( 0, 1, elapsed, duration );
	let sliced = 0;
	for ( let index = 0; index < 60; index ++ )
		sliced = advanceChameleonCamouflageBlend( sliced, 1, elapsed / 60, duration );
	assert.ok( singleStep > 0 && singleStep < 1 );
	assert.ok( Math.abs( singleStep - sliced ) < 1e-12 );
	const released = advanceChameleonCamouflageBlend( singleStep, 0, 0.25, 0.8 );
	assert.ok( released >= 0 && released < singleStep );

} );

test( 'CHAMELEON-SIM-035 perceptual variants cover the animal and idle at zero cost', () => {

	const bodyMaterial = new THREE.MeshStandardNodeMaterial( {
		color: new THREE.Color( '#6f8b47' ),
		vertexColors: true,
		roughness: 0.78,
		metalness: 0,
	} );
	const eyeMaterial = new THREE.MeshStandardNodeMaterial( {
		color: new THREE.Color( '#d6c074' ),
		roughness: 0.55,
	} );
	const bodyGeometry = new THREE.BoxGeometry();
	const eyeGeometry = new THREE.SphereGeometry();
	const body = new THREE.Mesh( bodyGeometry, bodyMaterial );
	const eye = new THREE.Mesh( eyeGeometry, eyeMaterial );
	const controller = createChameleonCamouflageController( [ body, eye ], settings() );
	try {

		assert.equal( controller.isPerceptualActive(), false );
		assert.equal( body.material, bodyMaterial );
		assert.equal( eye.material, eyeMaterial );
		assert.equal( controller.getPerceptualMaterialCount(), 2 );

		controller.update( 1, true );
		assert.equal( controller.isPerceptualActive(), true );
		assert.notEqual( body.material, bodyMaterial );
		assert.notEqual( eye.material, eyeMaterial );
		for ( const material of [ body.material, eye.material ] ) {

			assert.ok( material.backdropNode );
			assert.ok( material.backdropAlphaNode );
			assert.ok( material.maskShadowNode );
			assert.equal( material.outputNode, null );
			assert.equal( material.transparent, true );
			assert.equal( material.opacity, 1 );
			assert.equal( material.depthWrite, true );
			assert.equal( material.forceSinglePass, true );

		}
		assert.ok( controller.getBlend() > 0 && controller.getBlend() < 1 );

		controller.update( 0, false, true );
		assert.equal( controller.isPerceptualActive(), false );
		assert.equal( controller.getBlend(), 0 );
		assert.equal( body.material, bodyMaterial );
		assert.equal( eye.material, eyeMaterial );

	} finally {

		controller.dispose();
		bodyGeometry.dispose();
		eyeGeometry.dispose();
		bodyMaterial.dispose();
		eyeMaterial.dispose();

	}

} );

test( 'CHAMELEON-SIM-036 one viewport copy feeds an opaque lit-skin adaptation', async () => {

	const source = await readFile(
		new URL( '../src/chameleon-camouflage.js', import.meta.url ),
		'utf8',
	);
	assert.equal(
		( source.match( /viewportSharedTexture\(/gu ) || [] ).length,
		1,
		'the whole animal must share one framebuffer-copy node',
	);
	assert.match( source, /viewportSharedTexture\(\s*viewportUV\.add\(\s*sampleOffset\s*\)\s*\)/u );
	assert.match( source, /material\.backdropNode\s*=\s*environmentPigment/u );
	assert.match( source, /material\.backdropAlphaNode\s*=\s*localMatch/u );
	assert.match( source, /material\.outputNode\s*=\s*null/u );
	assert.match( source, /material\.maskShadowNode/u );
	assert.match( source, /material\.forceSinglePass\s*=\s*true/u );
	assert.match( source, /setPerceptualActive\(\s*uniforms\.blend\.value\s*>\s*PERCEPTUAL_EPSILON\s*\)/u );
	assert.match( source, /renderer\.compileAsync\(\s*root,\s*camera,\s*scene\s*\|\|\s*null\s*\)/u );
	assert.doesNotMatch( source, /viewportMipTexture|viewportTexture\(/u );
	assert.doesNotMatch( source, /mix\(\s*output\.rgb/u );

} );

test( 'CHAMELEON-SIM-037 the skin can never become an invisibility cloak', async () => {

	const profile = resolveChameleonCamouflageProfile( {
		chameleonCamouflageEnvironmentMatch: 10,
		chameleonCamouflageEdgeReveal: 10,
		chameleonCamouflagePatternStrength: 10,
		chameleonCamouflagePatternScale: 100,
		chameleonCamouflageSampleSpread: 1,
		chameleonCamouflageShadowRetention: 0,
	} );
	assert.equal( profile.environmentMatch, MAX_CHAMELEON_ENVIRONMENT_MATCH );
	assert.equal( profile.edgeReveal, 0.8 );
	assert.equal( profile.patternStrength, 0.4 );
	assert.equal( profile.patternScale, 12 );
	assert.equal( profile.sampleSpread, 0.015 );
	assert.equal( profile.shadowRetention, 0.1 );

	const face = evaluateChameleonCamouflageMatch( profile, 1, 1, 1 );
	const edge = evaluateChameleonCamouflageMatch( profile, 1, 1, 0 );
	assert.ok( face <= MAX_CHAMELEON_ENVIRONMENT_MATCH );
	assert.ok( 1 - face >= 0.14 - Number.EPSILON, 'at least 14% of the natural diffuse remains' );
	assert.ok( edge < face, 'grazing angles must reveal the silhouette more than front faces' );
	assert.equal(
		evaluateChameleonCamouflageMatch( profile, 1, 1, 0 ),
		edge,
		'the object-space profile must be deterministic',
	);

	const source = await readFile(
		new URL( '../src/chameleon-camouflage.js', import.meta.url ),
		'utf8',
	);
	assert.doesNotMatch( source, /\bpositionWorld\b|\btime\.(?:mul|add|sub)/u );
	assert.match( source, /positionGeometry/u );

} );
