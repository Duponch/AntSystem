import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const GLB_MAGIC = 0x46546C67;
const GLB_JSON_CHUNK = 0x4E4F534A;

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

test( 'CHAMELEON-SIM-015 shipped physical GLB preserves the production rig contract', async () => {

	const { bytes, json } = await readGlb( '../public/assets/ChameleonPhysical.glb' );
	const names = new Set( ( json.nodes || [] ).map( ( node ) => node.name ) );
	const skinnedNodes = ( json.nodes || [] ).filter(
		( node ) => node.mesh !== undefined && node.skin !== undefined,
	);

	assert.ok( bytes.length < 12 * 1024 * 1024, 'physical animal GLB must stay below 12 MiB' );
	assert.equal( json.skins?.length, 1 );
	assert.equal( json.skins[ 0 ].joints.length, 43 );
	assert.equal( skinnedNodes.length, 1 );
	assert.equal( skinnedNodes[ 0 ].name, 'Chameleon_Physics_Body' );
	assert.equal( skinnedNodes[ 0 ].extras?.physics_ready, true );
	assert.equal( json.animations?.length || 0, 0, 'locomotion is procedural, not clip-driven' );
	for ( const required of [
		'root', 'pelvis', 'spine_01', 'spine_02', 'neck', 'head', 'jaw',
		'front_girdle.L', 'front_upper.L', 'front_lower.L', 'front_palm.L',
		'hind_girdle.R', 'hind_upper.R', 'hind_lower.R', 'hind_palm.R',
		'tail_01', 'tail_12',
	] ) assert.equal( names.has( required ), true, `${ required } is absent from the physical rig` );

} );

test( 'CHAMELEON-SIM-016 procedural locomotion owns the body while behaviour only owns intent', async () => {

	const [ runtime, hybrid ] = await Promise.all( [
		readSource( '../src/chameleon-physical-system.js' ),
		readSource( '../src/chameleon-lab/hybrid-chameleon.js' ),
	] );

	assert.match( runtime, /new ChameleonSimulation\(\s*\{[\s\S]*?externalLocomotion:\s*true/u );
	const fixedStart = runtime.indexOf( '\n\tfunction beforePhysicsStep(' );
	const fixedEnd = runtime.indexOf( '\n\tfunction stepSimulation(', fixedStart );
	const fixed = runtime.slice( fixedStart, fixedEnd );
	const pose = fixed.indexOf( 'simulation.setExternalPose(' );
	const behaviour = fixed.indexOf( 'simulation.update(' );
	const command = fixed.indexOf( 'hybrid.setCommand(' );
	const physical = fixed.indexOf( 'hybrid.beforeStep(' );
	assert.ok( pose >= 0 && behaviour > pose && command > behaviour && physical > command );
	assert.match( runtime, /surfaceWorld\.physics\.step\([\s\S]*?beforePhysicsStep[\s\S]*?hybrid\.afterStep\(\)/u );
	assert.match( runtime, /hybrid\.syncVisual\(\s*lastPhysicsAlpha,\s*renderDt\s*\)/u );
	assert.match( hybrid, /new ChameleonProceduralGait\s*\(/u );
	assert.match( hybrid, /new PassiveTailPhysics\s*\(/u );
	assert.match( hybrid, /new PassiveLimbRagdoll\s*\(/u );
	assert.doesNotMatch( runtime + hybrid, /new THREE\.AnimationMixer\s*\(/u );

} );

test( 'CHAMELEON-SIM-017 physical loader validates and instantiates the authored hybrid body', async () => {

	const source = await readSource( '../src/chameleon-lab/hybrid-chameleon.js' );

	assert.match( source, /assetUrl\s*=\s*[']\/assets\/ChameleonPhysical\.glb[']/u );
	assert.match( source, /assetScene\s*=\s*null/u );
	assert.match( source, /new GLTFLoader\(\)\.loadAsync\(\s*assetUrl\s*\)/u );
	assert.match( source, /new StableVisualRig\(\s*model\s*\)/u );
	assert.match( source, /RigidBodyDesc\.dynamic\(\)[\s\S]*?setCcdEnabled\(\s*true\s*\)/u );
	assert.match( source, /ColliderDesc\.capsule\s*\(/u );
	assert.match( source, /ColliderDesc\.ball\s*\(/u );
	assert.match( source, /object\.castShadow\s*=\s*true/u );
	assert.match( source, /object\.receiveShadow\s*=\s*true/u );

} );

test( 'CHAMELEON-SIM-018 physical renderer owns one fixed procedural tongue without a mixer', async () => {

	const source = await readSource( '../src/chameleon-physical-system.js' );
	const cylinderConstructions = source.match( /new THREE\.CylinderGeometry\(/gu ) || [];
	const padConstructions = source.match( /new THREE\.SphereGeometry\(/gu ) || [];

	assert.equal( cylinderConstructions.length, 1 );
	assert.equal( padConstructions.length, 1 );
	assert.doesNotMatch( source, /new THREE\.AnimationMixer\s*\(/u );
	assert.match( source, /function createTongueVisual\(\s*scene\s*\)/u );
	assert.match( source, /view\.tongueTipX\s*-\s*renderedMouthPosition\.x/u );
	assert.match( source, /setFromUnitVectors\(\s*LOCAL_BONE_AXIS,\s*tongueDirection\s*\)/u );
	assert.match( source, /tongue\.tube\.scale\.set\(\s*1,\s*length,\s*1\s*\)/u );
	assert.match( source, /tongue\.pad\.position\.set\(\s*view\.tongueTipX/u );
	const renderAttack = source.slice(
		source.indexOf( '\n\tfunction renderAttack(' ),
		source.indexOf( '\n\tfunction updateDebugView(', source.indexOf( '\n\tfunction renderAttack(' ) ),
	);
	assert.doesNotMatch( renderAttack, /new THREE\.(?:CylinderGeometry|SphereGeometry)/u );

} );

test( 'CHAMELEON-SIM-019 production navigation uses one shared physical surface manifold', async () => {

	const source = await readSource( '../src/chameleon-physical-system.js' );

	assert.match( source, /await createMainChameleonSurfaceWorld\(\s*\{/u );
	assert.equal( ( source.match( /createMainChameleonSurfaceWorld\(/gu ) || [] ).length, 1 );
	assert.match( source, /new SurfaceRoutePlanner\(\s*surfaceWorld\.navigation\s*\)/u );
	assert.match( source, /new AutonomousExplorer\(/u );
	assert.match( source, /routePlanner\.plan\(/u );
	assert.match( source, /explorer\.setDestination\(/u );
	assert.match( source, /getSupportNetwork:\s*\(\)\s*=>\s*surfaceWorld\.navigation/u );
	assert.match( source, /getSurfaceWorld:\s*\(\)\s*=>\s*surfaceWorld/u );
	assert.doesNotMatch( source, /Raycaster|intersectObjects?|\.raycast\s*\(/u );

} );

test( 'CHAMELEON-SIM-020 physical runtime exposes visibility, shadows and stable facade views', async () => {

	const source = await readSource( '../src/chameleon-physical-system.js' );

	assert.match( source, /function setSurfaceVisible\(\s*visible\s*\)/u );
	assert.match( source, /function setCastShadow\(\s*value\s*\)/u );
	assert.match( source, /function setReceiveShadow\(\s*value\s*\)/u );
	assert.match( source, /mesh\.castShadow\s*=\s*enabled/u );
	assert.match( source, /mesh\.receiveShadow\s*=\s*enabled/u );
	assert.match( source, /tongue\.tube\.castShadow\s*=\s*enabled/u );
	assert.match( source, /tongue\.tube\.receiveShadow\s*=\s*enabled/u );
	assert.match( source, /getSimulation:\s*\(\)\s*=>\s*simulation/u );
	assert.match( source, /getTelemetry:\s*\(\)\s*=>\s*simulation\.getTelemetry\(\)/u );
	assert.match( source, /getDebugView:\s*\(\)\s*=>\s*debugView/u );
	assert.match( source, /getAvoidanceContext:\s*\(\)\s*=>\s*avoidanceView/u );

} );

test( 'CHAMELEON-SIM-038 prey look drives the physical neck before tongue rendering', async () => {

	const source = await readSource( '../src/chameleon-physical-system.js' );
	const lookStart = source.indexOf( '\n\tfunction updateLookTarget(' );
	const lookEnd = source.indexOf( '\n\tfunction beforePhysicsStep(', lookStart );
	const look = source.slice( lookStart, lookEnd );

	assert.match( look, /view\.targetIndex\s*>=\s*0\s*\?\s*view\.targetIndex\s*:\s*view\.capturedIndex/u );
	assert.match( look, /hybrid\.setLookTarget\(\s*preyPosition,\s*ATTACK_STATES\.has\(\s*view\.state\s*\)/u );
	assert.match( look, /hybrid\.clearLookTarget\(\)/u );
	const renderStart = source.indexOf( '\n\tfunction renderFrame(' );
	const renderEnd = source.indexOf( '\n\tfunction reset(', renderStart );
	const render = source.slice( renderStart, renderEnd );
	assert.ok( render.indexOf( 'hybrid.syncVisual(' ) < render.indexOf( 'renderAttack( view )' ) );
	assert.match( source, /mouthSocket\.getWorldPosition\(\s*renderedMouthPosition\s*\)/u );
	assert.doesNotMatch( look, /\.lookAt\s*\(/u );

} );
