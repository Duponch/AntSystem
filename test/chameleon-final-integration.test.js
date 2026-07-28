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
