import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { MAX_BUTTERFLIES } from '../src/config.js';

const GLB_MAGIC = 0x46546C67;
const GLB_JSON_CHUNK = 0x4E4F534A;
const GLB_BINARY_CHUNK = 0x004E4942;
const VAT_FPS = 16;

async function readSource( relativeUrl ) {

	return readFile( new URL( relativeUrl, import.meta.url ), 'utf8' );

}

async function readGlb( relativeUrl ) {

	const bytes = await readFile( new URL( relativeUrl, import.meta.url ) );
	assert.ok( bytes.length >= 20 );
	assert.equal( bytes.readUInt32LE( 0 ), GLB_MAGIC );
	assert.equal( bytes.readUInt32LE( 4 ), 2 );
	assert.equal( bytes.readUInt32LE( 8 ), bytes.length );

	let offset = 12;
	let json = null;
	let binary = null;
	while ( offset < bytes.length ) {

		const length = bytes.readUInt32LE( offset );
		const type = bytes.readUInt32LE( offset + 4 );
		offset += 8;
		assert.ok( offset + length <= bytes.length );
		if ( type === GLB_JSON_CHUNK ) {

			json = JSON.parse( bytes.toString( 'utf8', offset, offset + length ).replace( /[\0\s]+$/u, '' ) );

		} else if ( type === GLB_BINARY_CHUNK ) {

			binary = bytes.subarray( offset, offset + length );

		}
		offset += length;

	}
	assert.equal( offset, bytes.length );
	assert.ok( json );
	assert.ok( binary );
	return { bytes, json, binary };

}

function animationDuration( gltf, animation ) {

	let duration = 0;
	for ( const sampler of animation.samplers || [] ) {

		const input = gltf.accessors?.[ sampler.input ];
		assert.ok( input?.max?.length );
		duration = Math.max( duration, input.max[ 0 ] );

	}
	return duration;

}

test( 'BUTTERFLY-SIM-010 shipped animated GLB and VAT budget stay exact', async () => {

	const [ asset, loaderSource ] = await Promise.all( [
		readGlb( '../public/Butterfly.glb' ),
		readSource( '../src/pollinator-assets.js' ),
	] );
	const { bytes, json, binary } = asset;
	const animation = json.animations?.[ 0 ];
	const primitive = json.meshes?.[ 0 ]?.primitives?.[ 0 ];
	const positionCount = json.accessors?.[ primitive?.attributes?.POSITION ]?.count;
	const indexCount = json.accessors?.[ primitive?.indices ]?.count;
	const duration = animationDuration( json, animation );
	const frames = Math.max( 2, Math.round( duration * VAT_FPS ) );
	const vatBytes = positionCount * frames * 4 * 2;
	const image = json.images?.[ 0 ];
	const imageView = json.bufferViews?.[ image?.bufferView ];
	const imageStart = imageView?.byteOffset || 0;
	const png = binary.subarray( imageStart, imageStart + imageView.byteLength );

	assert.equal( bytes.length, 99_876 );
	assert.equal( json.meshes.length, 1 );
	assert.equal( json.meshes[ 0 ].primitives.length, 1 );
	assert.deepEqual( json.animations.map( ( clip ) => clip.name ), [ 'Flight_Butterfly' ] );
	assert.equal( json.skins.length, 1 );
	assert.equal( json.skins[ 0 ].joints.length, 13 );
	assert.equal( positionCount, 1_105 );
	assert.equal( indexCount, 1_584 );
	assert.equal( indexCount / 3, 528 );
	assert.ok( Math.abs( duration - 5.0416665 ) < 0.00001 );
	assert.equal( frames, 81 );
	assert.equal( vatBytes, 716_040 );
	assert.equal( image.mimeType, 'image/png' );
	assert.equal( png.readUInt32BE( 0 ), 0x89504E47 );
	assert.equal( png[ 25 ], 2, 'the embedded atlas must remain opaque RGB' );
	assert.equal( json.materials?.[ 0 ]?.alphaMode, undefined );
	assert.match( loaderSource, /loadVATMulti\(\s*'\/Butterfly\.glb',[\s\S]*?clipNames:\s*\[\s*'Flight_Butterfly'\s*\][\s\S]*?fps:\s*16[\s\S]*?preserveUv:\s*true/u );

} );

test( 'BUTTERFLY-SIM-011 renderer is one opaque PBR VAT draw with fixed cost', async () => {

	const [ source, configSource ] = await Promise.all( [
		readSource( '../src/butterflies.js' ),
		readSource( '../src/config.js' ),
	] );
	const drawCalls = ( source.match( /new THREE\.Mesh\(/gu ) || [] ).length;

	assert.equal( MAX_BUTTERFLIES, 64 );
	assert.equal( drawCalls, 1 );
	assert.equal( 528 * MAX_BUTTERFLIES, 33_792 );
	assert.match( configSource, /export const MAX_BUTTERFLIES = 64/u );
	assert.match( source, /capacity:\s*MAX_BUTTERFLIES/u );
	assert.match( source, /geometry\.instanceCount = rendered/u );
	assert.match( source, /views\.visible\[ butterfly \] !== 1/u );
	assert.match( source, /modelForward = new THREE\.Vector3\( 0, 0, 1 \)/u );
	assert.match( source, /new THREE\.MeshStandardNodeMaterial/u );
	assert.match( source, /side:\s*THREE\.DoubleSide/u );
	assert.match( source, /texture\( vat\.colorMap, uv\(\) \)/u );
	assert.doesNotMatch( source, /AnimationMixer|alphaHash|opacityNode|transparent:\s*true/u );
	assert.doesNotMatch( source, /\b(?:MAX_ANTS|antCount|ants)\b/u );

} );

test( 'BUTTERFLY-SIM-012 asset loading is conditional, lazy and singleton', async () => {

	const [ mainSource, facadeSource, assetSource ] = await Promise.all( [
		readSource( '../src/main.js' ),
		readSource( '../src/pollinators.js' ),
		readSource( '../src/pollinator-assets.js' ),
	] );

	assert.match( mainSource, /gfx\.pollinators && gfx\.butterflies \? loadButterflyAsset\(\) : Promise\.resolve\( null \)/u );
	assert.match( mainSource, /createPollinators\( \{ scene, renderer, camera, props, assets: pollinatorAssets, butterflyVat \} \)/u );
	assert.match( facadeSource, /if \( ! gfx\.pollinators \|\| ! gfx\.butterflies \) return Promise\.resolve\( null \)/u );
	assert.match( facadeSource, /if \( butterflyLoadPromise \) return butterflyLoadPromise/u );
	assert.match( facadeSource, /butterflyLoadPromise = Promise\.all/u );
	assert.match( facadeSource, /else if \( gfx\.pollinators && gfx\.butterflies \) void ensureButterflies\(\)/u );
	assert.match( assetSource, /if \( butterflyPromise \) return butterflyPromise/u );
	assert.match( assetSource, /butterflyPromise = loadVATMulti/u );

} );

test( 'BUTTERFLY-SIM-013 butterflies are atomically hidden below ground or when disabled', async () => {

	const [ source, mainSource ] = await Promise.all( [
		readSource( '../src/butterflies.js' ),
		readSource( '../src/main.js' ),
	] );
	const masks = source.match( /group\.visible = !! gfx\.pollinators && !! gfx\.butterflies && surfaceVisible;/gu ) || [];

	assert.ok( masks.length >= 2 );
	assert.match( source, /if \( ! gfx\.pollinators \|\| ! gfx\.butterflies \) return simulation\.getTelemetry\(\)/u );
	assert.match( mainSource, /bees\.stepSimulation\( fixedDt \)/u );
	assert.match( mainSource, /bees\.renderFrame\( rawDt, ! dived \)/u );
	assert.match( mainSource, /bees\.setSurfaceVisible\( ! dived \)/u );

} );

test( 'BUTTERFLY-SIM-014 UI, lifecycle cohorts and constant flower search are wired', async () => {

	const [ configSource, uiSource, rendererSource, simulationSource ] = await Promise.all( [
		readSource( '../src/config.js' ),
		readSource( '../src/ui.js' ),
		readSource( '../src/butterflies.js' ),
		readSource( '../src/butterfly-simulation.js' ),
	] );

	for ( const key of [ 'butterflies', 'butterflyCount', 'butterflyScale', 'butterflySpeed', 'butterflyLifeSpeed', 'butterflyTint' ] ) {

		assert.match( configSource, new RegExp( key + ':' ) );
		assert.match( uiSource, new RegExp( "'" + key + "'" ) );

	}
	assert.match( uiSource, /bees\.setButterflyCount\( value \)/u );
	assert.match( uiSource, /bees\.setButterflyTint\( value \)/u );
	assert.match( rendererSource, /const adults = Math\.ceil\( count \* 0\.6 \)/u );
	assert.match( rendererSource, /BUTTERFLY_STAGE\.(?:ADULT|EGG|LARVA|PUPA)/u );
	assert.match( simulationSource, /BUTTERFLY_FLOWER_CANDIDATE_SAMPLES = 4/u );
	assert.match( simulationSource, /for \( let sample = 0; sample < BUTTERFLY_FLOWER_CANDIDATE_SAMPLES; sample \+\+ \)/u );
	assert.match( simulationSource, /BUTTERFLY_STAGE\.EGG[\s\S]*BUTTERFLY_STAGE\.LARVA[\s\S]*BUTTERFLY_STAGE\.PUPA[\s\S]*BUTTERFLY_STAGE\.ADULT/u );

} );
