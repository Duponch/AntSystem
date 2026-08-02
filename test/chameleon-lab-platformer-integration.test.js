import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const MAIN_URL = new URL( '../src/chameleon-lab/main.js', import.meta.url );
const HYBRID_URL = new URL( '../src/chameleon-lab/hybrid-chameleon.js', import.meta.url );
const UI_URL = new URL( '../src/chameleon-lab/lab-ui.js', import.meta.url );

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
		`(?:(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=|([A-Za-z_$][\\w$]*)\\s*=)\\s*${ escapeRegExp( modelName ) }\\.update\\s*\\(`,
		'u',
	).exec( block );
	assert.ok( match, `${ modelName }.update result is not retained` );
	return match[ 1 ] ?? match[ 2 ];

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
	assert.match( fixed, /platformerJumpInput\.jumpPressed\s*=/u );
	assert.match( fixed, /platformerJumpInput\.jumpHeld\s*=/u );
	assert.match( fixed, /platformerJumpInput\.jumpReleased\s*=/u );
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
		new RegExp(
			`ragdollCommand\\.sourceNormal\\s*=\\s*${ escapeRegExp( controlView ) }\\.supportNormal`,
			'u',
		),
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

test( 'CHAMELEON-LAB-PLATFORMER-INTEGRATION-006 body-relative steering and physical claw adhesion stay wired end to end', async () => {

	const [ source, hybrid, ui ] = await Promise.all( [
		readFile( MAIN_URL, 'utf8' ),
		readFile( HYBRID_URL, 'utf8' ),
		readFile( UI_URL, 'utf8' ),
	] );
	const fixed = fixedStepBlock( source );

	assert.match( fixed, /supported\s*=\s*ragdoll\.contactCount\s*>=\s*1/u,
		'an edge transition must remain supported while at least one claw is planted' );
	assert.match( fixed, /platformerControlInput\.bodyForward\s*=\s*ragdoll\.forward/u,
		'keyboard steering must use the anatomical forward axis, not camera yaw' );
	assert.match( fixed, /ragdollCommand\.facing\s*=\s*state\.autonomous\s*\?\s*move\s*:\s*platformerControlView\.facing/u,
		'the hybrid attitude controller must receive the same body-relative facing frame' );

	assert.match( hybrid, /body\.worldCom\(\)/u,
		'claw-force moments must be measured about the actual rigid-body centre of mass' );
	assert.match( hybrid, /body\.addForceAtPoint\(/u,
		'adhesion must be applied at planted claws instead of only at the root' );
	assert.match( hybrid, /settings\.gripStiffness/u );
	assert.match( hybrid, /settings\.gripDamping/u );
	assert.match( ui, /property:\s*'gripDamping'/u,
		'the support damping required to suppress roll must stay tunable' );

} );

test( 'CHAMELEON-LAB-PLATFORMER-INTEGRATION-007 click travel is event-driven and manual arcade input takes priority', async () => {

	const source = await readFile( MAIN_URL, 'utf8' );
	const fixed = fixedStepBlock( source );
	assert.match( source, /new\s+SurfaceDestinationPicker\s*\(/u );
	assert.match( source, /new\s+SurfaceRoutePlanner\s*\(\s*environment\.navigation\s*\)/u,
		'the event-side destination picker must own the access-route planner' );
	assert.match( source, /surfaceRoutePlanner\.plan\([\s\S]*?currentSupportCollider\(\)[\s\S]*?collider[\s\S]*?\)/u,
		'the route planner must receive both source support and the clicked collider' );
	assert.match( source, /explorer\.setDestination\(\s*destination,\s*normal,\s*creaturePosition,\s*route\s*\)/u,
		'the event-built route must be copied into the fixed-step explorer queue' );
	assert.match( source, /state\.autonomous\s*=\s*true/u );
	assert.match( fixed, /const\s+manualAxes\s*=\s*input\.axes/u );
	assert.match( fixed, /ragdollCommand\.turning\s*=\s*steeringCommand/u,
		'a planted steering command must reach the ragdoll without crab translation' );
	assert.doesNotMatch( fixed, /rootBody\.wakeUp\(\)/u,
		'the fixed-step hot path must let the ragdoll wake a static grip exactly once' );
	assert.match( fixed, /state\.autonomous\s*=\s*false[\s\S]*?explorer\.clearDestination\(\)/u,
		'manual input must immediately regain control from click travel' );
	assert.doesNotMatch( fixed, /destinationPicker\.(?:pick|raycast)/u,
		'destination raycasts must never enter the fixed-step hot path' );
	assert.doesNotMatch( fixed, /surfaceRoutePlanner\.(?:plan|route)/u,
		'access-graph routing must never enter the fixed-step hot path' );
	assert.match( source, /sprintMultiplier\s*=\s*Math\.max\([\s\S]*?2\.3/u,
		'sprint must remain perceptibly faster than walking' );
	assert.match( source, /destinationPicker\.dispose\(\)/u );

} );

test( 'CHAMELEON-LAB-PLATFORMER-INTEGRATION-008 fixed-step command records are sealed and reused', async () => {

	const source = await readFile( MAIN_URL, 'utf8' );
	const fixed = fixedStepBlock( source );
	const animationLoop = source.indexOf( 'renderer.setAnimationLoop' );
	assert.ok( animationLoop >= 0 );
	for ( const record of [
		'platformerControlInput',
		'platformerJumpInput',
		'ragdollCommand',
	] ) {

		const declaration = new RegExp(
			`const\\s+${ record }\\s*=\\s*Object\\.seal\\(\\s*\\{`,
			'u',
		).exec( source );
		assert.ok( declaration, `${ record } must be a sealed record` );
		assert.ok( declaration.index < animationLoop,
			`${ record } must be allocated before the render loop` );

	}
	assert.match(
		fixed,
		/platformerControl\.update\(\s*fixedDt,\s*platformerControlInput\s*,?\s*\)/u,
	);
	assert.match(
		fixed,
		/platformerJump\.update\(\s*fixedDt,\s*platformerJumpInput\s*,?\s*\)/u,
	);
	assert.match( fixed, /ragdoll\.setCommand\(\s*ragdollCommand\s*\)/u );
	assert.doesNotMatch(
		fixed,
		/(?:platformerControl|platformerJump)\.update\(\s*fixedDt,\s*\{/u,
	);
	assert.doesNotMatch( fixed, /ragdoll\.setCommand\(\s*\{/u );

} );

test( 'CHAMELEON-LAB-PLATFORMER-INTEGRATION-009 grab and free-ragdoll atomically cancel jump authority', async () => {

	const source = await readFile( MAIN_URL, 'utf8' );
	const fixed = fixedStepBlock( source );
	const consumeIndex = fixed.indexOf( 'input.consumeJumpState( jumpInput )' );
	const blockedIndex = fixed.indexOf( 'const jumpBlocked' );
	const resetIndex = fixed.indexOf( 'platformerJump.reset( false, ragdoll.supportNormal )' );
	const updateIndex = fixed.indexOf( 'platformerJump.update(' );
	assert.ok( consumeIndex >= 0 && blockedIndex > consumeIndex,
		'queued Space edges must be consumed before blocked jump authority is evaluated' );
	assert.match(
		fixed,
		/const\s+jumpBlocked\s*=\s*Boolean\(\s*grabbedBone\s*\)\s*\|\|\s*state\.fullRagdoll/u,
		'both mouse holding and free-ragdoll must suppress the jump controller',
	);
	assert.ok( resetIndex > blockedIndex && updateIndex > resetIndex,
		'the blocked branch must reset stale preload state instead of updating it' );
	for ( const edge of [ 'jumpPressed', 'jumpHeld', 'jumpReleased' ] ) assert.match(
		fixed.slice( blockedIndex, updateIndex ),
		new RegExp( `platformerJumpInput\\.${ edge }\\s*=\\s*false`, 'u' ),
		`${ edge } must be cleared while jump authority is blocked`,
	);
	assert.match(
		fixed.slice( resetIndex, updateIndex ),
		/\}\s*else\s*\{/u,
		'the model update must live exclusively in the non-blocked branch',
	);

} );

test( 'CHAMELEON-LAB-PLATFORMER-INTEGRATION-010 click-route debug follows lifecycle and active segment', async () => {

	const source = await readFile( MAIN_URL, 'utf8' );
	assert.match( source, /new\s+SurfaceRouteDebugView\s*\(\s*\{/u );
	assert.match(
		source,
		/createLabUI\s*\(\s*\{[\s\S]*?routeDebugView:\s*surfaceRouteDebugView/u,
		'the UI must own route-overlay visibility',
	);
	assert.match( source, /surfaceRouteDebugView\.setRoute\(\s*route\s*\)/u );
	assert.ok(
		( source.match(
			/(?:collider|destinationCollider)\s*,\s*ragdoll\.supportNormal\s*,?\s*\)/gu,
		) ?? [] ).length >= 2,
		'both initial planning and replanning must localize the current support face',
	);
	assert.match(
		source,
		/surfaceRouteDebugView\.setProgress\(\s*explorer\.routeProgressIndex\s*\)/u,
		'waypoint index must be converted to the active segment',
	);
	assert.ok( ( source.match( /surfaceRouteDebugView\.clear\(\s*\)/gu ) ?? [] ).length >= 5,
		'reset, rejection, failed replan, manual input and disabling auto must clear stale routes' );
	const dispose = extractBraceBlock( source, /function\s+dispose\s*\(\s*\)\s*/u, 'dispose' );
	assert.match( dispose, /surfaceRouteDebugView\.dispose\s*\(\s*\)/u );
	assert.match( source, /window\.__chameleonLab\s*=\s*\{[\s\S]*?surfaceRouteDebugView/u );

} );
