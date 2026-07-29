import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readSource( relativeUrl ) {

	return readFile( new URL( relativeUrl, import.meta.url ), 'utf8' );

}

test( 'CHAMELEON-SIM-025 config and UI expose predator tuning and independent shadows', async () => {

	const [ config, ui ] = await Promise.all( [
		readSource( '../src/config.js' ),
		readSource( '../src/ui.js' ),
	] );

	for ( const setting of [
		'chameleonEnabled',
		'chameleonScale',
		'chameleonPatrolSpeed',
		'chameleonTrackingSpeed',
		'chameleonAnimationSpeed',
		'chameleonRoamingEnabled',
		'chameleonRoamingRadius',
		'chameleonCamouflageEnabled',
		'chameleonCamouflageEnvironmentMatch',
		'chameleonCamouflageEdgeReveal',
		'chameleonCamouflagePatternStrength',
		'chameleonCamouflagePatternScale',
		'chameleonCamouflageSampleSpread',
		'chameleonCamouflageShadowRetention',
		'chameleonCamouflageAdaptSeconds',
		'chameleonCamouflageReleaseSeconds',
		'chameleonCamouflageInterval',
		'chameleonCamouflageMinDuration',
		'chameleonCamouflageMaxDuration',
		'chameleonSupportClearance',
		'chameleonDebugAttackRange',
		'chameleonAttackDistance',
		'chameleonDetectionDistance',
		'chameleonAimDuration',
		'chameleonTongueRetractDuration',
		'chameleonAttackCooldown',
		'chameleonCastShadow',
		'chameleonReceiveShadow',
	] ) {

		assert.match( config, new RegExp( `\\b${ setting }\\s*:`, 'u' ), `${ setting } is absent from config` );
		assert.match( ui, new RegExp( `['"]${ setting }['"]`, 'u' ), `${ setting } is absent from UI` );

	}
	assert.match( ui, /addFolder\(\s*['"][^'"]*Caméléon['"]\s*\)/u );
	assert.match( ui, /\.setChameleonEnabled\(\s*value\s*\)/u );
	assert.match( ui, /\.setChameleonCastShadow\(\s*value\s*\)/u );
	assert.match( ui, /\.setChameleonReceiveShadow\(\s*value\s*\)/u );
	assert.match( config, /chameleonCamouflageMinDuration:\s*7/u );
	assert.match( config, /chameleonCamouflageMaxDuration:\s*13/u );
	assert.match( config, /chameleonCamouflageEnvironmentMatch:\s*0\.68/u );
	assert.match( config, /chameleonCamouflageShadowRetention:\s*0\.28/u );
	assert.match( ui, /chameleonCamouflageEnvironmentMatch['"],\s*0,\s*0\.86,\s*0\.01/u );
	assert.match( ui, /chameleonCamouflageShadowRetention['"],\s*0\.1,\s*0\.6,\s*0\.01/u );
	assert.match( config, /legacyOpticalFidelity \* 0\.68/u );
	assert.doesNotMatch( config, /chameleonCamouflageOpticalFidelity:\s*/u );
	assert.doesNotMatch( config + ui, /chameleonCamouflageColor|Signal camouflage/u );
	assert.doesNotMatch( config + ui, /chameleonCamouflageStrength|CamouflageBarkColor|CamouflageRockColor/u );

} );

test( 'CHAMELEON-SIM-030 movement and walk animation speeds stay independently configurable', async () => {

	const [ config, ui, chameleons ] = await Promise.all( [
		readSource( '../src/config.js' ),
		readSource( '../src/ui.js' ),
		readSource( '../src/chameleons.js' ),
	] );

	assert.match( config, /chameleonPatrolSpeed:\s*1\.15/u );
	assert.match( config, /chameleonAnimationSpeed:\s*1/u );
	assert.match( ui, /chameleonAnimationSpeed['"],\s*0\.1,\s*4/u );
	assert.match( chameleons, /travelled \/ stride \* animationSpeed/u );
	assert.match( chameleons, /attackAction\.time[\s\S]*?view\.attackClipPhase/u );

} );

test( 'CHAMELEON-SIM-032 runtime uses reactive local surface exploration and explicit ambush camouflage', async () => {

	const source = await readSource( '../src/chameleons.js' );
	assert.match( source, /from\s*['"]\.\/chameleon-surface-graph\.js['"]/u );
	assert.doesNotMatch( source, /chameleon-support-network|buildChameleonSupportNetwork/u );
	assert.match( source, /holdAtTrackEnd:\s*true/u );
	assert.match( source, /surfaceRouter\.exploreNext\(\s*roamingRadius\s*\)/u );
	assert.match( source, /simulation\.routeCompleted/u );
	assert.match( source, /preserveHeading[\s\S]*?simulation\.setHeading/u );
	assert.match( source, /bodyRoot\.quaternion\.slerp\(\s*targetBodyQuaternion/u );
	assert.doesNotMatch( source, /surfaceRouter\.routeTo|findChameleonSurfacePath/u );
	assert.match( source, /scheduledCamouflage[\s\S]*?simulation\.patrolSpeed/u );
	assert.match( source, /camouflageCandidate[\s\S]*?scheduledCamouflage/u );
	assert.match( source, /camouflageStationaryTime\s*=\s*advanceChameleonCamouflageDwell/u );
	assert.doesNotMatch( source, /view\.stateTime\s*>=\s*0\.08/u );
	assert.match( source, /createChameleonCamouflageController/u );
	assert.match( source, /camouflageVisual\.update/u );
	assert.doesNotMatch( source, /chameleonCamouflageColor|camouflageTint|material\.color\.copy/u );
	assert.match( source, /simulation\.state !== CHAMELEON_STATE\.AIM_AND_BRACE/u );

} );

test( 'CHAMELEON-SIM-026 pollinator facade owns lazy chameleon lifecycle and shadow controls', async () => {

	const source = await readSource( '../src/pollinators.js' );

	assert.match( source, /import\s*\{\s*createChameleons\s*\}\s*from\s*['"]\.\/chameleons\.js['"]/u );
	assert.match( source, /function ensureChameleon\(\)/u );
	assert.match( source, /createChameleons\(\s*\{/u );
	assert.match( source, /getButterflyPredationContext:/u );
	assert.match( source, /setChameleonEnabled\(\s*value\s*\)/u );
	assert.match( source, /setChameleonCastShadow\(\s*value\s*\)/u );
	assert.match( source, /setChameleonReceiveShadow\(\s*value\s*\)/u );
	assert.match( source, /chameleonSystem\.setSurfaceVisible\(\s*visible\s*\)/u );
	assert.match( source, /getChameleonSimulation:/u );
	assert.match( source, /getChameleonTelemetry:/u );
	assert.match( source, /getChameleonDebugView\(\)/u );
	assert.match( source, /getChameleonAvoidanceContext\(\)/u );
	assert.match( source, /selectChameleon\(\s*selected\s*=\s*true\s*\)/u );

} );

test( 'CHAMELEON-SIM-027 deterministic predator steps are separated from renderer uploads', async () => {

	const [ butterflies, pollinators, chameleons ] = await Promise.all( [
		readSource( '../src/butterflies.js' ),
		readSource( '../src/pollinators.js' ),
		readSource( '../src/chameleons.js' ),
	] );

	assert.match(
		butterflies,
		/(?:const predationContext\s*=\s*\{|function (?:create|build)PredationContext\(\))/u,
	);
	assert.match( butterflies, /(?:captured:\s*views\.captured|predationContext\.captured\s*=\s*views\.captured)/u );
	assert.match(
		butterflies,
		/(?:tryCapture\s*:\s*)?tryCapture\(\s*index\s*\)[\s\S]*?simulation\.tryCapture\(\s*index\s*\)/u,
	);
	assert.match(
		butterflies,
		/(?:setCapturedPosition\s*:\s*)?setCapturedPosition\(\s*index,\s*x,\s*y,\s*z\s*\)/u,
	);
	assert.match(
		butterflies,
		/(?:consumeCaptured|consume)\(\s*index\s*\)[\s\S]*?simulation\.consumeCaptured\(\s*index/u,
	);
	assert.match( butterflies, /getPredationContext:\s*\(\)\s*=>/u );
	assert.match( butterflies, /flushPredationRender/u );

	const stepStart = pollinators.indexOf( '\n\tfunction stepSimulation( dt ) {' );
	const renderStart = pollinators.indexOf( '\n\tfunction renderFrame( renderDt = 0, visible = true ) {' );
	const updateStart = pollinators.indexOf( '\n\tfunction update( dt, visible = true ) {' );
	assert.ok( stepStart >= 0 && renderStart > stepStart && updateStart > renderStart );
	const stepBody = pollinators.slice( stepStart, renderStart );
	const butterflyStep = stepBody.indexOf( 'butterflySystem.stepSimulation' );
	const chameleonStep = stepBody.indexOf( 'chameleonSystem.stepSimulation' );
	assert.ok( butterflyStep >= 0, 'butterfly logical step is absent' );
	assert.ok( chameleonStep > butterflyStep, 'predator must scan post-butterfly logical positions' );

	const renderBody = pollinators.slice( renderStart, updateStart );
	assert.ok( renderBody.indexOf( 'butterflySystem.renderFrame' ) >= 0 );
	assert.ok( renderBody.indexOf( 'chameleonSystem.renderFrame' ) >= 0 );
	assert.doesNotMatch( renderBody, /stepSimulation|\.update\(\s*renderDt/u );

	const rendererStart = chameleons.indexOf( '\n\tfunction renderFrame( renderDt = 0, visible = surfaceVisible ) {' );
	const rendererEnd = chameleons.indexOf( '\n\tfunction update( dt ) {', rendererStart );
	assert.ok( rendererStart >= 0 && rendererEnd > rendererStart );
	assert.doesNotMatch( chameleons.slice( rendererStart, rendererEnd ), /setCapturedPosition/u );

} );
