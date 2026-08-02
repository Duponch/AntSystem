import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CHAMELEON_STATE } from '../src/chameleon-simulation.js';
import {
	chameleonDestinationWeight,
	chameleonJawOpening,
	dominantChameleonSupportCollider,
} from '../src/chameleon-physical-system.js';

async function readSource( relativeUrl ) {

	return readFile( new URL( relativeUrl, import.meta.url ), 'utf8' );

}

test( 'CHAMELEON-PHYSICAL-SYSTEM-001 autonomous destinations favour natural elevated supports', () => {

	const weighted = [
		[ { model: 'Log_01' }, 9 ],
		[ { provenance: { model: 'Log_02' } }, 9 ],
		[ { category: 'branches' }, 8 ],
		[ { kind: 'arbre vertical' }, 6 ],
		[ { provenance: { category: 'BigRock_03' } }, 4.5 ],
		[ { model: 'Stump_01' }, 3.5 ],
		[ { model: 'Mushroom_01' }, 1.5 ],
		[ { kind: 'terrain' }, 0.35 ],
		[ null, 1.5 ],
	];
	for ( const [ metadata, expected ] of weighted )
		assert.equal( chameleonDestinationWeight( metadata ), expected );

	const ordered = [ 'Log_01', 'Branch', 'Tree_07', 'Rock_04', 'Stump_01', 'unknown', 'ground' ]
		.map( ( model ) => chameleonDestinationWeight( { model } ) );
	for ( let index = 1; index < ordered.length; index ++ )
		assert.ok( ordered[ index - 1 ] > ordered[ index ], `${ ordered } must remain strictly ordered` );

} );

test( 'CHAMELEON-PHYSICAL-SYSTEM-002 dominant support uses the strongest holding-foot cohort', () => {

	const log = Object.freeze( { handle: 7, name: 'log' } );
	const logAlias = Object.freeze( { handle: 7, name: 'same Rapier collider' } );
	const rock = Object.freeze( { handle: 11, name: 'rock' } );
	const fallback = Object.freeze( { handle: 19, name: 'impact owner' } );
	assert.equal( dominantChameleonSupportCollider( [
		{ state: 'holding', collider: rock, load: 1 },
		{ state: 'holding', collider: log, load: 0 },
		{ state: 'holding', collider: logAlias, load: 0.2 },
		{ state: 'swing', collider: rock, load: 1 },
	], fallback ), log );

	assert.equal( dominantChameleonSupportCollider( [
		{ state: 'reaching', collider: log, load: 1 },
		{ state: 'holding', collider: logAlias, load: 0.4 },
	], fallback ), logAlias, 'a non-holding foot may not shadow a later valid owner' );

	assert.equal( dominantChameleonSupportCollider( [
		{ state: 'holding', collider: rock, load: 0.5 },
		{ state: 'holding', collider: log, load: 0.5 },
	], fallback ), rock, 'equal cohorts retain deterministic anatomical order' );
	assert.equal( dominantChameleonSupportCollider( [], fallback ), fallback );
	assert.equal( dominantChameleonSupportCollider( null, fallback ), fallback );

} );

test( 'CHAMELEON-PHYSICAL-SYSTEM-003 jaw pose is bounded and follows the attack phases', () => {

	const aimSamples = [ -1, 0.04, 0.12, 0.24, 0.395, 2 ].map(
		( phase ) => chameleonJawOpening( CHAMELEON_STATE.AIM_AND_BRACE, phase ),
	);
	assert.equal( aimSamples[ 0 ], 0 );
	assert.equal( aimSamples[ 1 ], 0 );
	assert.equal( aimSamples.at( -1 ), 1 );
	for ( let index = 1; index < aimSamples.length; index ++ ) {

		assert.ok( aimSamples[ index ] >= aimSamples[ index - 1 ] );
		assert.ok( aimSamples[ index ] >= 0 && aimSamples[ index ] <= 1 );

	}
	for ( const state of [
		CHAMELEON_STATE.STRIKE_EXTEND,
		CHAMELEON_STATE.CONTACT,
		CHAMELEON_STATE.RETRACT_WITH_PREY,
	] ) assert.equal( chameleonJawOpening( state, Number.NaN ), 1 );

	const biteSamples = [ 0, 0.651, 0.75, 0.9, 1, 4 ].map(
		( phase ) => chameleonJawOpening( CHAMELEON_STATE.BITE_AND_SWALLOW, phase ),
	);
	assert.equal( biteSamples[ 0 ], 1 );
	assert.equal( biteSamples[ 1 ], 1 );
	assert.equal( biteSamples.at( -1 ), 0 );
	for ( let index = 1; index < biteSamples.length; index ++ )
		assert.ok( biteSamples[ index ] <= biteSamples[ index - 1 ] );
	assert.equal( chameleonJawOpening( CHAMELEON_STATE.REST_SCAN, 0.5 ), 0 );
	assert.equal( chameleonJawOpening( CHAMELEON_STATE.COOLDOWN, 0.5 ), 0 );

} );

test( 'CHAMELEON-PHYSICAL-SYSTEM-004 production facade owns the shared Rapier runtime', async () => {

	const [ facade, pollinators, physical ] = await Promise.all( [
		readSource( '../src/chameleons.js' ),
		readSource( '../src/pollinators.js' ),
		readSource( '../src/chameleon-physical-system.js' ),
	] );
	assert.match( facade, /import\s*\{\s*createChameleonPhysicalSystem\s*\}\s*from\s*[']\.\/chameleon-physical-system\.js[']/u );
	assert.match( facade, /return\s+createChameleonPhysicalSystem\(\s*options\s*\)/u );
	for ( const retired of [
		'chameleon-assets.js',
		'chameleon-body-contact.js',
		'chameleon-tail-contact.js',
		'chameleon-surface-graph.js',
		'chameleon-camouflage.js',
	] ) assert.doesNotMatch( facade, new RegExp( retired.replace( '.', '\\.' ), 'u' ) );

	assert.match( pollinators, /createChameleons\(\s*\{[\s\S]*?environment,[\s\S]*?getButterflyPredationContext:/u );
	assert.match( physical, /architecture:\s*[']shared-rapier-hybrid-surface-manifold[']/u );
	for ( const member of [
		'stepSimulation', 'renderFrame', 'reset', 'dispose', 'setSurfaceVisible',
		'setCastShadow', 'setReceiveShadow', 'select', 'clearSelection',
		'getDebugView', 'getAvoidanceContext', 'getSupportNetwork', 'getSurfaceWorld',
		'getSurfaceRouter', 'getProceduralGait', 'getRigBinding', 'getTailContactSolver',
		'getFootContacts',
	] ) assert.match( physical, new RegExp( `\\b${ member }\\b`, 'u' ) );

} );

test( 'CHAMELEON-PHYSICAL-SYSTEM-005 main world reuses exact scene transforms and one bounded manifold', async () => {

	const source = await readSource( '../src/chameleon-main-surfaces.js' );
	assert.match( source, /createPhysicsWorld\(\s*\{/u );
	assert.match( source, /RigidBodyDesc\.fixed\(\)/u );
	assert.match( source, /ground\.matrixWorld\.decompose/u );
	assert.match( source, /ColliderDesc\.trimesh\(/u );
	assert.match( source, /ColliderDesc\.convexHull\(/u );
	assert.match( source, /ColliderDesc\.cylinder\(/u );
	assert.match( source, /buildLabSurfaceNavigationGraph\(\s*entries/u );
	assert.match( source, /supportMetadataByHandle\.set\(\s*collider\.handle,\s*metadata\s*\)/u );
	assert.match( source, /createSurfaceAppearanceBinding\(/u );
	assert.match( source, /destinationHandles/u );
	assert.match( source, /physics\.surfaceByCollider\.clear\(\)/u );
	assert.match( source, /physics\.dispose\(\)/u );
	assert.doesNotMatch( source, /requestAnimationFrame|WebGPURenderer|renderer\.render/u );

} );

test( 'CHAMELEON-PHYSICAL-SYSTEM-006 routing, camouflage and physics remain event-driven', async () => {

	const source = await readSource( '../src/chameleon-physical-system.js' );
	assert.match( source, /createMainChameleonSurfaceWorld\(\s*\{[\s\S]*?ground:\s*environment\.ground,[\s\S]*?fixedDt:\s*1\s*\/\s*120,[\s\S]*?maxSubsteps:\s*4/u );
	assert.match( source, /createHybridChameleon\(\s*\{[\s\S]*?physics:\s*surfaceWorld\.physics,[\s\S]*?assetUrl:\s*[']\/assets\/ChameleonPhysical\.glb[']/u );
	assert.match( source, /new\s+SurfaceRoutePlanner\(\s*surfaceWorld\.navigation\s*\)/u );
	assert.match( source, /new\s+AutonomousExplorer\(/u );
	assert.match( source, /routePlanner\.plan\(/u );
	assert.match( source, /explorer\.setDestination\(/u );
	assert.match( source, /routeDebug\.setRoute\(/u );
	assert.match( source, /if\s*\(\s*explorer\.consumeReplanRequest\(\)\s*\)\s*requestRoute\(\s*3\s*\)/u );
	assert.match( source, /surfaceWorld\.physics\.step\([\s\S]*?beforePhysicsStep,[\s\S]*?hybrid\.afterStep\(\)/u );
	assert.match( source, /createSurfaceCamouflageController\(\s*meshes,\s*camouflageSettings\s*\)/u );
	assert.match( source, /camouflage\.update\(\s*visualDt,\s*hybrid\.feet\s*\)/u );
	assert.match( source, /avoidanceView\.camouflaged\s*=\s*camouflaged/u );
	assert.doesNotMatch( source, /viewportSharedTexture|requestAnimationFrame/u );

	for ( const [ setting, graphics ] of [
		[ 'sprintMultiplier', 'chameleonSprintMultiplier' ],
		[ 'moveForce', 'chameleonMoveForce' ],
		[ 'motorStrength', 'chameleonMotorStrength' ],
		[ 'stepLength', 'chameleonStepLength' ],
		[ 'gripStrength', 'chameleonGripStrength' ],
		[ 'supportClearance', 'chameleonSupportClearance' ],
		[ 'tailDamping', 'chameleonTailDamping' ],
	] ) assert.match( source, new RegExp(
		`settings\\.${ setting }\\s*=\\s*gfx\\.${ graphics }`, 'u',
	) );

	const renderStart = source.indexOf( 'function renderFrame' );
	const renderEnd = source.indexOf( '\n\tfunction reset', renderStart );
	assert.ok( renderStart >= 0 && renderEnd > renderStart );
	const renderFrame = source.slice( renderStart, renderEnd );
	assert.doesNotMatch( renderFrame, /routePlanner\.plan|createMainChameleonSurfaceWorld|physics\.step/u );

} );

test( 'CHAMELEON-PHYSICAL-SYSTEM-007 edited scene surfaces rebuild transactionally', async () => {

	const [ pollinators, editor, main, ui ] = await Promise.all( [
		readSource( '../src/pollinators.js' ),
		readSource( '../src/editor.js' ),
		readSource( '../src/main.js' ),
		readSource( '../src/ui.js' ),
	] );
	assert.ok( pollinators.includes( 'generation !== chameleonLoadGeneration' ) );
	assert.ok( pollinators.includes( 'loaded?.dispose?.()' ) );
	const rebuildStart = pollinators.indexOf( 'async function rebuildChameleonSurfaces()' );
	const rebuildEnd = pollinators.indexOf( 'function refreshChameleonSurfaces', rebuildStart );
	assert.ok( rebuildStart >= 0 && rebuildEnd > rebuildStart );
	const rebuild = pollinators.slice( rebuildStart, rebuildEnd );
	assert.ok( rebuild.includes( 'previous?.dispose?.()' ) );
	assert.ok( rebuild.includes( 'const previous = chameleonSystem' ) );
	assert.ok( rebuild.includes( 'loaded = await createChameleonInstance()' ) );
	assert.ok( rebuild.includes( 'request !== chameleonSurfaceRefreshRequest' ) );
	assert.ok( rebuild.includes( 'chameleonSystem = loaded' ) );
	assert.ok( pollinators.includes( 'function refreshChameleonSurfaces( debounceMs = 180 )' ) );
	assert.ok( pollinators.includes( 'return completion;' ) );
	assert.match(
		pollinators,
		/if \( ! gfx\.chameleonEnabled \) \{[\s\S]*?chameleonLoadGeneration \+\+;[\s\S]*?chameleonLoadPromise = null;/u,
	);
	assert.ok( editor.includes( 'onDecorChanged?.()' ) );
	assert.ok( editor.includes( 'CHAMELEON_SURFACE_CATEGORIES' ) );
	assert.ok( main.includes( 'onDecorChanged: () => bees.refreshChameleonSurfaces( 0 )' ) );
	assert.ok( ui.includes( 'env.rebuildEntrance();' ) );
	assert.ok( ui.includes( 'await bees.refreshChameleonSurfaces( 0 );' ) );
	for ( const category of [ 'trees', 'obstacles', 'rocks' ] )
		assert.ok( ui.includes( `cat === '${ category }'` ) );

} );
