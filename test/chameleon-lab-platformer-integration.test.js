import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const MAIN_URL = new URL( '../src/chameleon-lab/main.js', import.meta.url );

function extractBraceBlock( source, markerPattern, label ) {

	const match = markerPattern.exec( source );
	assert.ok( match, `${ label } marker is missing` );
	const open = source.indexOf( '{', match.index + match[ 0 ].length );
	assert.ok( open >= 0, `${ label } opening brace is missing` );
	let depth = 0;
	let quote = '';
	let escaped = false;
	for ( let index = open; index < source.length; index ++ ) {

		const character = source[ index ];
		if ( quote ) {

			if ( escaped ) escaped = false;
			else if ( character === '\\' ) escaped = true;
			else if ( character === quote ) quote = '';
			continue;

		}
		if ( character === '"' || character === "'" || character === '`' ) {

			quote = character;
			continue;

		}
		if ( character === '{' ) depth ++;
		else if ( character === '}' ) {

			depth --;
			if ( depth === 0 ) return source.slice( open + 1, index );

		}

	}
	assert.fail( `${ label } closing brace is missing` );

}

function fixedStepBlock( source ) {

	const physicsStep = source.indexOf( 'physics.step(' );
	assert.ok( physicsStep >= 0, 'physics.step is missing' );
	const remainder = source.slice( physicsStep );
	const block = extractBraceBlock(
		remainder,
		/\(\s*fixedDt\s*\)\s*=>\s*/u,
		'fixed-step callback',
	);
	return block;

}

function escapeRegExp( value ) {

	return value.replace( /[.*+?^${}()|[\]\\]/gu, '\\$&' );

}

function instanceName( source, constructorName ) {

	const match = new RegExp(
		`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${ constructorName }\\s*\\(`,
		'u',
	).exec( source );
	assert.ok( match, `${ constructorName } instance is missing` );
	return match[ 1 ];

}

function updateViewName( block, modelName ) {

	const match = new RegExp(
		`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${ escapeRegExp( modelName ) }\\.update\\s*\\(`,
		'u',
	).exec( block );
	assert.ok( match, `${ modelName }.update result is not retained` );
	return match[ 1 ];

}

test( 'CHAMELEON-LAB-PLATFORMER-INTEGRATION-001 main owns the control, jump and rig-overlay models', async () => {

	const source = await readFile( MAIN_URL, 'utf8' );
	assert.match(
		source,
		/import\s*\{[^}]*PlatformerControlModel[^}]*\}\s*from\s*['"]\.\/platformer-control-model\.js['"]/su,
	);
	assert.match(
		source,
		/import\s*\{[^}]*PlatformerJumpModel[^}]*\}\s*from\s*['"]\.\/platformer-jump-model\.js['"]/su,
	);
	assert.match(
		source,
		/import\s*\{[^}]*createRigDebugView[^}]*\}\s*from\s*['"]\.\/rig-debug-view\.js['"]/su,
	);
	assert.match( source, /new\s+PlatformerControlModel\s*\(/u );
	assert.match( source, /new\s+PlatformerJumpModel\s*\(/u );
	assert.match( source, /createRigDebugView\s*\(\s*\{[\s\S]*?scene[\s\S]*?root:\s*ragdoll\.model/u );
	assert.match( source, /renderer\.domElement\.tabIndex\s*=\s*0/u,
		'the 3D canvas must reclaim keyboard focus after using an UI control' );

} );

test( 'CHAMELEON-LAB-PLATFORMER-INTEGRATION-002 fixed steps consume edges once and update both models', async () => {

	const source = await readFile( MAIN_URL, 'utf8' );
	const fixed = fixedStepBlock( source );
	const controlModel = instanceName( source, 'PlatformerControlModel' );
	const jumpModel = instanceName( source, 'PlatformerJumpModel' );
	assert.match( fixed, /input\.consumeJumpState\s*\(/u,
		'jump edges must remain queued when a render frame performs no fixed step' );
	assert.match( fixed, new RegExp( `${ escapeRegExp( controlModel ) }\\.update\\s*\\(\\s*fixedDt`, 'u' ) );
	assert.match( fixed, new RegExp( `${ escapeRegExp( jumpModel ) }\\.update\\s*\\(\\s*fixedDt`, 'u' ) );
	assert.match( fixed, /jumpPressed\s*:/u );
	assert.match( fixed, /jumpHeld\s*:/u );
	assert.match( fixed, /jumpReleased\s*:/u );
	assert.doesNotMatch( source, /input\.consume\(\s*['"]jumpQueued['"]\s*\)/u );
	assert.doesNotMatch( source, /normal\.[xyz]\s*\*\s*0\.42/u,
		'the old fixed impulse shortcut must not coexist with the height model' );

} );

test( 'CHAMELEON-LAB-PLATFORMER-INTEGRATION-003 all platformer body forces run after hybrid support forces', async () => {

	const source = await readFile( MAIN_URL, 'utf8' );
	const fixed = fixedStepBlock( source );
	const controlModel = instanceName( source, 'PlatformerControlModel' );
	const jumpModel = instanceName( source, 'PlatformerJumpModel' );
	const controlView = updateViewName( fixed, controlModel );
	const jumpView = updateViewName( fixed, jumpModel );
	const hybridIndex = fixed.indexOf( 'ragdoll.beforeStep( fixedDt )' );
	assert.ok( hybridIndex >= 0, 'hybrid beforeStep is missing from the fixed callback' );
	const mutations = Array.from( fixed.matchAll(
		/\.\s*(?:addForce|applyImpulse|addTorque|applyTorqueImpulse|setLinvel)\s*\(/gu,
	) );
	assert.ok( mutations.length >= 2,
		'expected separate model-driven steering/gravity and take-off body mutations' );
	for ( const mutation of mutations ) assert.ok(
		mutation.index > hybridIndex,
		`${ mutation[ 0 ] } must run after ragdoll.beforeStep`,
	);
	assert.match(
		fixed,
		new RegExp( `move\\.set\\(\\s*${ escapeRegExp( controlView ) }\\.direction`, 'u' ),
		'platformer control direction must feed the hybrid command',
	);
	assert.match(
		fixed,
		new RegExp( `sourceNormal:\\s*${ escapeRegExp( controlView ) }\\.supportNormal`, 'u' ),
		'the hybrid command must retain the support frame that produced its direction',
	);
	assert.match(
		fixed.slice( hybridIndex ),
		new RegExp( `${ escapeRegExp( jumpView ) }\\.jumped[\\s\\S]*?applyImpulse`, 'u' ),
	);
	assert.match(
		fixed.slice( hybridIndex ),
		new RegExp(
			`${ escapeRegExp( jumpView ) }\\.additionalGravity[\\s\\S]*?addForce`,
			'u',
		),
	);

} );

test( 'CHAMELEON-LAB-PLATFORMER-INTEGRATION-004 rig overlay follows UI ownership and is disposed', async () => {

	const source = await readFile( MAIN_URL, 'utf8' );
	assert.match(
		source,
		/createLabUI\s*\(\s*\{[\s\S]*?rigDebugView[\s\S]*?\}\s*\)/u,
		'the UI must own the overlay visibility toggle',
	);
	const dispose = extractBraceBlock( source, /function\s+dispose\s*\(\s*\)\s*/u, 'dispose' );
	assert.match( dispose, /rigDebugView\.dispose\s*\(\s*\)/u );
	assert.match( source, /window\.__chameleonLab\s*=\s*\{[\s\S]*?rigDebugView/u,
		'the lab inspection API must expose the overlay for diagnostics' );

} );

test( 'CHAMELEON-LAB-PLATFORMER-INTEGRATION-005 UI tuning is copied into fixed-step jump policy', async () => {

	const source = await readFile( MAIN_URL, 'utf8' );
	const fixed = fixedStepBlock( source );
	const controlModel = instanceName( source, 'PlatformerControlModel' );
	const jumpModel = instanceName( source, 'PlatformerJumpModel' );
	for ( const [ stateProperty, modelProperty ] of [
		[ 'jumpHeight', 'jumpHeight' ],
		[ 'coyoteTime', 'coyoteTime' ],
		[ 'jumpBufferTime', 'bufferTime' ],
		[ 'fallGravityScale', 'fallGravityScale' ],
		[ 'jumpCutGravityScale', 'cutGravityScale' ],
	] ) assert.match(
		fixed,
		new RegExp(
			`${ escapeRegExp( jumpModel ) }\\.${ modelProperty }\\s*=\\s*state\\.${ stateProperty }`,
			'u',
		),
		`${ stateProperty } is not wired to ${ modelProperty }`,
	);
	assert.match(
		fixed,
		new RegExp(
			`${ escapeRegExp( controlModel ) }\\.airAcceleration\\s*=[\\s\\S]*?state\\.airControl`,
			'u',
		),
	);

} );
