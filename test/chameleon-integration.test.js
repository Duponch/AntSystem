import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const GLB_MAGIC = 0x46546C67;
const GLB_JSON_CHUNK = 0x4E4F534A;
const REQUIRED_WALK = 'Walk_Chameleon_Imported';
const REQUIRED_ATTACK = 'Attack_Chameleon_Imported';

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
	while ( offset < bytes.length ) {

		const length = bytes.readUInt32LE( offset );
		const type = bytes.readUInt32LE( offset + 4 );
		offset += 8;
		assert.ok( offset + length <= bytes.length );
		if ( type === GLB_JSON_CHUNK ) {

			json = JSON.parse(
				bytes.toString( 'utf8', offset, offset + length ).replace( /[\0\s]+$/u, '' ),
			);

		}
		offset += length;

	}
	assert.ok( json );
	return { bytes, json };

}

function animationDuration( gltf, animation ) {

	let duration = 0;
	for ( const sampler of animation.samplers || [] ) {

		const accessor = gltf.accessors?.[ sampler.input ];
		assert.ok( accessor?.max?.length );
		duration = Math.max( duration, accessor.max[ 0 ] );

	}
	return duration;

}

function animationTargets( gltf, animation ) {

	return new Set( ( animation.channels || [] ).map(
		( channel ) => gltf.nodes?.[ channel.target.node ]?.name,
	) );

}

test( 'CHAMELEON-SIM-015 shipped GLB preserves the exact rig, sockets and clip contract', async () => {

	const { bytes, json } = await readGlb( '../public/Chameleon.glb' );
	const names = ( json.nodes || [] ).map( ( node ) => node.name );
	const clips = ( json.animations || [] ).map( ( animation ) => animation.name );
	const skinnedNodes = ( json.nodes || [] ).filter(
		( node ) => node.mesh !== undefined && node.skin !== undefined,
	);

	assert.ok( bytes.length < 3 * 1024 * 1024, 'single-animal GLB must stay below 3 MiB' );
	assert.ok( clips.includes( REQUIRED_WALK ) );
	assert.ok( clips.includes( REQUIRED_ATTACK ) );
	assert.ok( names.includes( 'jaw' ) );
	assert.ok( names.includes( 'tongue_base' ) );
	assert.ok( names.includes( 'tongue_mid' ) );
	assert.ok( names.includes( 'tongue_tip' ) );
	assert.equal( names.filter( ( name ) => name === 'mouth_socket' ).length, 1 );
	assert.equal( names.filter( ( name ) => name === 'capture_socket' ).length, 1 );
	assert.ok( ( json.skins || [] ).some( ( skin ) => ( skin.joints || [] ).length >= 32 ) );
	assert.ok( skinnedNodes.length >= 1 );
	assert.ok( skinnedNodes.every( ( node ) => node.skin === skinnedNodes[ 0 ].skin ) );
	assert.ok(
		( json.nodes || [] ).some(
			( node ) => /tongue/iu.test( node.name || '' ) && node.mesh !== undefined,
		),
		'exported tongue must remain a separate hideable mesh',
	);

} );

test( 'CHAMELEON-SIM-016 attack clip animates the whole body, jaw and tongue at useful speed', async () => {

	const { json } = await readGlb( '../public/Chameleon.glb' );
	const attack = json.animations.find( ( animation ) => animation.name === REQUIRED_ATTACK );
	const walk = json.animations.find( ( animation ) => animation.name === REQUIRED_WALK );
	const targets = animationTargets( json, attack );

	for ( const required of [
		'root',
		'pelvis',
		'chest',
		'neck',
		'head',
		'jaw',
		'tongue_base',
		'tongue_mid',
		'tongue_tip',
		'upper_front.L',
		'upper_hind.R',
	] ) assert.ok( targets.has( required ), `${ required } is absent from attack animation` );
	assert.ok( attack.channels.length >= 100, 'attack must be a full-body animation' );
	assert.ok( animationDuration( json, attack ) >= 1.5 );
	assert.ok( animationDuration( json, attack ) <= 2.2 );
	assert.ok( animationDuration( json, walk ) >= 1 );

	const mainMesh = ( json.meshes || [] ).find( ( mesh ) => /GameMesh/iu.test( mesh.name || '' ) );
	assert.ok( mainMesh );
	assert.notEqual(
		mainMesh.primitives?.[ 0 ]?.attributes?.COLOR_0,
		undefined,
		'main PBR mesh must keep authored vertex colors',
	);

} );

test( 'CHAMELEON-SIM-017 loader is singleton, validates exact names and clones the skeleton safely', async () => {

	const source = await readSource( '../src/chameleon-assets.js' );

	assert.match( source, /let assetPromise = null/u );
	assert.match( source, /if\s*\(\s*assetPromise\s*\)\s*return assetPromise/u );
	assert.match( source, /loader\.loadAsync\(\s*CHAMELEON_ASSET_URL\s*\)/u );
	assert.match( source, /Walk_Chameleon_Imported/u );
	assert.match( source, /Attack_Chameleon_Imported/u );
	assert.match( source, /mouth_socket/u );
	assert.match( source, /capture_socket/u );
	assert.match( source, /cloneSkeleton\(\s*asset\.scene\s*\)/u );
	assert.match( source, /MeshStandardNodeMaterial/u );
	assert.match( source, /vertexColors/u );
	assert.match( source, /if\s*\(\s*\/tongue\/iu\.test\(\s*object\.name\s*\)\s*\)/u );
	assert.doesNotMatch( source, /loadVAT|InstancedMesh/u );

} );

test( 'CHAMELEON-SIM-018 renderer owns one mixer and a fixed tapered procedural tongue', async () => {

	const source = await readSource( '../src/chameleons.js' );
	const mixerConstructions = source.match( /new THREE\.AnimationMixer\(/gu ) || [];
	const cylinderConstructions = source.match( /new THREE\.CylinderGeometry\(/gu ) || [];
	const padConstructions = source.match( /new THREE\.SphereGeometry\(/gu ) || [];

	assert.equal( mixerConstructions.length, 1 );
	assert.equal( cylinderConstructions.length, 1 );
	assert.equal( padConstructions.length, 1 );
	assert.match( source, /new THREE\.CylinderGeometry\(\s*0\.54,\s*1,\s*1/u );
	assert.match( source, /view\.attackClipPhase/u );
	assert.match( source, /view\.mouthX/u );
	assert.match( source, /view\.tongueTipX/u );
	assert.match( source, /setFromUnitVectors\(\s*LOCAL_Y,\s*tongueDirection\s*\)/u );
	assert.match( source, /tongueTube\.scale\.set\(\s*width,\s*length,\s*width\s*\)/u );
	const tongueUpdate = source.slice(
		source.indexOf( 'function updateTongue' ), source.indexOf( 'function setCastShadow' ),
	);
	assert.doesNotMatch( tongueUpdate, /new THREE\.(?:CylinderGeometry|SphereGeometry)/u );

} );

test( 'CHAMELEON-SIM-019 support relief rebuild is revision-driven and has no frame raycast', async () => {

	const source = await readSource( '../src/chameleons.js' );

	assert.match( source, /selectChameleonHost\(\s*props\.registry\s*\)/u );
	assert.match( source, /new ChameleonSurfaceGraphBaker\(\)/u );
	assert.match( source, /surfaceGraphBaker\.update\(\s*props\.registry/u );
	assert.match( source, /props\.getRevision/u );
	assert.match( source, /revision !== propRevision/u );
	assert.match( source, /nextTreeScale !== treeScale/u );
	assert.match( source, /nextRockScale !== rockScale/u );
	assert.match( source, /if\s*\(\s*! changed\s*\)\s*return false/u );
	assert.match( source, /simulation\.setTrackSamples\(\s*track\s*\)/u );
	assert.match( source, /localX\.copy\(\s*forward\s*\)\.multiplyScalar\(\s*-\s*1\s*\)/u );
	assert.match( source, /rotationMatrix\.makeBasis\(\s*localX,\s*up,\s*localZ\s*\)/u );
	assert.doesNotMatch( source, /Raycaster|raycast|intersectObject|intersectObjects/u );

} );

test( 'CHAMELEON-SIM-020 runtime exposes independent visibility and shadow controls', async () => {

	const source = await readSource( '../src/chameleons.js' );

	assert.match( source, /function setSurfaceVisible\(\s*visible\s*\)/u );
	assert.match( source, /function setCastShadow\(\s*enabled\s*\)/u );
	assert.match( source, /function setReceiveShadow\(\s*enabled\s*\)/u );
	assert.match( source, /mesh\.castShadow = castShadow/u );
	assert.match( source, /mesh\.receiveShadow = receiveShadow/u );
	assert.match( source, /tongueTube\.castShadow = castShadow/u );
	assert.match( source, /tongueTube\.receiveShadow = receiveShadow/u );
	assert.match( source, /getButterflyPredationContext\(\)/u );
	assert.match( source, /getSimulation:\s*\(\)\s*=>\s*simulation/u );
	assert.match( source, /getTelemetry:\s*\(\)\s*=>\s*simulation\.getTelemetry\(\)/u );

} );

test( 'CHAMELEON-SIM-038 hierarchical prey look drives neck and head before tongue rendering', async () => {

	const source = await readSource( '../src/chameleons.js' );

	assert.match( source, /new ChameleonHeadLookModel\s*\(/u );
	assert.match( source, /function updateHeadLookSimulation\(\s*dt,\s*view\s*\)/u );
	assert.match( source, /view\.targetIndex\s*>=\s*0/u );
	assert.match( source, /const striking = attackState\(\s*view\.state\s*\)[\s\S]*?striking\s*\?\s*view\.strikeX\s*:\s*view\.aimX/u );
	assert.match( source, /rotateLookBoneInModelSpace\(\s*rigBinding\.neck/u );
	assert.match( source, /rotateLookBoneInModelSpace\(\s*rigBinding\.head/u );

	const renderStart = source.indexOf( 'function renderFrame' );
	assert.ok( renderStart >= 0, 'renderFrame is missing' );
	const renderEnd = source.indexOf( 'function reset', renderStart );
	assert.ok( renderEnd > renderStart, 'renderFrame boundary is missing' );
	const render = source.slice( renderStart, renderEnd );
	const contactIndex = render.indexOf( 'commitSafeContactPose' );
	const lookIndex = render.indexOf( 'applyHeadLookPose' );
	const tongueIndex = render.indexOf( 'updateTongue( view, true )' );
	assert.ok( contactIndex >= 0 && contactIndex < lookIndex,
		'look offsets must be layered over the validated contact pose' );
	assert.ok( lookIndex < tongueIndex,
		'the mouth matrices must inherit the final neck/head pose before tongue aiming' );
	assert.doesNotMatch( render, /\.lookAt\s*\(/u,
		'Object3D.lookAt would bypass anatomical neck/head limits' );

} );
