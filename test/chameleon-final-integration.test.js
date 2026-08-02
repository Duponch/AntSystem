import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readSource( relativeUrl ) {

	// Physical runtime integration contracts use source inspection only.

	return readFile( new URL( relativeUrl, import.meta.url ), 'utf8' );

}

test( 'CHAMELEON-SIM-030 physical settings remain independent', async () => {

	const runtime = await readSource( '../src/chameleon-physical-system.js' );
	assert.match( runtime, /settings\.gaitFrequency\s*=\s*gfx\.chameleonGaitFrequency/u );
	assert.match( runtime, /settings\.animationSpeed\s*=\s*gfx\.chameleonAnimationSpeed/u );

} );

test( 'CHAMELEON-SIM-025 config and UI expose the physical animal tuning surface', async () => {

	const [ config, ui ] = await Promise.all( [
		readSource( '../src/config.js' ),
		readSource( '../src/ui.js' ),
	] );
	for ( const setting of [
		'chameleonEnabled', 'chameleonPatrolSpeed',
		'chameleonTrackingSpeed', 'chameleonAnimationSpeed', 'chameleonTurnSpeed',
		'chameleonMoveForce', 'chameleonMotorStrength', 'chameleonMotorDamping',
		'chameleonLimbMuscleTone', 'chameleonGaitFrequency', 'chameleonStepLength',
		'chameleonStepHeight', 'chameleonStrideAmplitude', 'chameleonLimbLift',
		'chameleonJointFlex', 'chameleonGripEnabled', 'chameleonGripStrength',
		'chameleonGripStiffness', 'chameleonGripDamping', 'chameleonGripReach',
		'chameleonSurfaceCommitTime', 'chameleonTailDamping', 'chameleonTailFlexibility',
		'chameleonTailCollisionScale', 'chameleonTailGravity', 'chameleonRoamingEnabled',
		'chameleonRoamingRadius', 'chameleonCamouflageEnabled', 'chameleonCamouflageStrength',
		'chameleonCamouflageSurfaceCommitSeconds', 'chameleonCamouflageSurfaceTransitionSeconds',
		'chameleonCamouflageSupportHoldSeconds', 'chameleonCamouflageEyeRetention',
		'chameleonAttackDistance', 'chameleonDetectionDistance', 'chameleonCastShadow',
		'chameleonReceiveShadow', 'chameleonDebugContacts', 'chameleonDebugRig',
		'chameleonDebugRoute',
	] ) {

		assert.match( config, new RegExp( '\\b' + setting + '\\s*:', 'u' ), setting );
		assert.match( ui, new RegExp( setting, 'u' ), setting );

	}
	assert.match( ui, /\.setChameleonEnabled\(\s*value\s*\)/u );
	assert.match( ui, /\.setChameleonCastShadow\(\s*value\s*\)/u );
	assert.match( ui, /\.setChameleonReceiveShadow\(\s*value\s*\)/u );
	assert.match( config, /chameleonGripStrength:\s*32/u );
	assert.match( config, /chameleonSurfaceCommitTime:\s*0\.85/u );
	assert.match( config, /chameleonCamouflageStrength:\s*0\.98/u );
	assert.match( config, /chameleonCamouflageEyeRetention:\s*0\.86/u );

} );

test( 'CHAMELEON-SIM-032 physical runtime routes exploration and ambush camouflage', async () => {

	const source = await readSource( '../src/chameleon-physical-system.js' );
	for ( const contract of [
		'SurfaceRoutePlanner', 'AutonomousExplorer', 'planExplorationDestination',
		'chooseWeightedRecord', 'routeNodeWithinRoamingRadius', 'explorer.setDestination',
		'simulation.setExternalPose', 'createSurfaceCamouflageController',
		'advanceChameleonCamouflageDwell', 'camouflage.update',
	] ) assert.ok( source.includes( contract ), contract );
	assert.match( source, /if\s*\(\s*revealing\s*\)[\s\S]*?stopCamouflageCycle\(\)/u );
	assert.doesNotMatch( source, /setTrackSamples|surfaceGraphBaker|exploreNext/u );

} );

test( 'CHAMELEON-SIM-026 pollinator facade owns the lazy physical chameleon lifecycle', async () => {

	const [ source, facade ] = await Promise.all( [
		readSource( '../src/pollinators.js' ),
		readSource( '../src/chameleons.js' ),
	] );
	assert.match( source, /import\s*\{\s*createChameleons\s*\}\s*from\s*[']\.\/chameleons\.js[']/u );
	assert.match( source, /function ensureChameleon\(\)/u );
	assert.match( source, /createChameleons\(\s*\{/u );
	assert.match( source, /\benvironment,\s*[\r\n]/u );
	for ( const contract of [
		'getButterflyPredationContext:', 'setChameleonEnabled( value )',
		'setChameleonCastShadow( value )', 'setChameleonReceiveShadow( value )',
		'getChameleonSimulation:', 'getChameleonTelemetry:',
		'getChameleonDebugView()', 'getChameleonAvoidanceContext()',
		'selectChameleon( selected = true )',
	] ) assert.ok( source.includes( contract ), contract );
	assert.match( facade, /import\s*\{\s*createChameleonPhysicalSystem\s*\}\s*from\s*[']\.\/chameleon-physical-system\.js[']/u );
	assert.match( facade, /return\s+createChameleonPhysicalSystem\(\s*options\s*\)/u );
	assert.match( facade, /export\s*\{\s*createChameleonPhysicalSystem\s*\}/u );
	assert.doesNotMatch( facade, /chameleon-(?:assets|rig|surface-graph)|AnimationMixer|Raycaster/u );

} );

test( 'CHAMELEON-SIM-027 deterministic physical predator steps stay outside rendering', async () => {

	const [ pollinators, runtime ] = await Promise.all( [
		readSource( '../src/pollinators.js' ),
		readSource( '../src/chameleon-physical-system.js' ),
	] );
	const stepStart = pollinators.indexOf( '\n\tfunction stepSimulation( dt ) {' );
	const renderStart = pollinators.indexOf( '\n\tfunction renderFrame( renderDt = 0, visible = true ) {' );
	const updateStart = pollinators.indexOf( '\n\tfunction update( dt, visible = true ) {' );
	assert.ok( stepStart >= 0 && renderStart > stepStart && updateStart > renderStart );
	const stepBody = pollinators.slice( stepStart, renderStart );
	assert.ok( stepBody.indexOf( 'butterflySystem.stepSimulation' ) >= 0 );
	assert.ok( stepBody.indexOf( 'chameleonSystem.stepSimulation' )
		> stepBody.indexOf( 'butterflySystem.stepSimulation' ) );
	const facadeRender = pollinators.slice( renderStart, updateStart );
	assert.match( facadeRender, /chameleonSystem\.renderFrame/u );
	assert.doesNotMatch( facadeRender, /stepSimulation|\.update\(\s*renderDt/u );

	const physicalRenderStart = runtime.indexOf( '\n\tfunction renderFrame(' );
	const physicalRenderEnd = runtime.indexOf( '\n\tfunction reset(', physicalRenderStart );
	assert.match( runtime.slice( 0, physicalRenderStart ), /surfaceWorld\.physics\.step\(/u );
	const physicalRender = runtime.slice( physicalRenderStart, physicalRenderEnd );
	assert.doesNotMatch( physicalRender, /simulation\.update|surfaceWorld\.physics\.step|setCapturedPosition/u );

} );
