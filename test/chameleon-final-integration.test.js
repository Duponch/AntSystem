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

test( 'CHAMELEON-SIM-027 renderer bridge is stable and flushes capture after predator update', async () => {

	const [ butterflies, pollinators ] = await Promise.all( [
		readSource( '../src/butterflies.js' ),
		readSource( '../src/pollinators.js' ),
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

	const updateStart = pollinators.indexOf( '\n\t\tupdate( dt, visible = true ) {' );
	const updateEnd = pollinators.indexOf( '\n\t\treset() {', updateStart );
	assert.ok( updateStart >= 0 && updateEnd > updateStart );
	const updateBody = pollinators.slice( updateStart, updateEnd );
	const butterflyUpdate = updateBody.indexOf( 'butterflySystem.update' );
	const chameleonUpdate = updateBody.indexOf( 'chameleonSystem.update' );
	const renderFlush = updateBody.indexOf( 'flushPredationRender' );

	assert.ok( butterflyUpdate >= 0, 'butterfly simulation update is absent' );
	assert.ok( chameleonUpdate > butterflyUpdate, 'predator must scan post-butterfly positions' );
	assert.ok( renderFlush > chameleonUpdate, 'captured position must flush after predator callbacks' );

} );
