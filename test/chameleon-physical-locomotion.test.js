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

test( 'CHAMELEON-PHYSICS-000A exploration strongly prefers natural elevated supports', () => {

	assert.ok( chameleonDestinationWeight( { model: 'Log_01' } )
		> chameleonDestinationWeight( { model: 'Tree_01' } ) );
	assert.ok( chameleonDestinationWeight( { kind: 'branch' } )
		> chameleonDestinationWeight( { model: 'Rock.glb' } ) );
	assert.ok( chameleonDestinationWeight( { category: 'rocks' } )
		> chameleonDestinationWeight( { kind: 'ground' } ) );
	assert.equal( chameleonDestinationWeight( null ), 1.5 );

} );

test( 'CHAMELEON-PHYSICS-000B support authority follows the strongest coherent foot cohort', () => {

	const log = { handle: 11 };
	const ground = { handle: 22 };
	const fallback = { handle: 99 };
	const feet = [
		{ collider: log, state: 'holding', load: 0.8 },
		{ collider: log, state: 'holding', load: 0.6 },
		{ collider: ground, state: 'holding', load: 1 },
		{ collider: ground, state: 'swinging', load: 1 },
	];
	assert.equal( dominantChameleonSupportCollider( feet, fallback ), log );
	assert.equal( dominantChameleonSupportCollider( [], fallback ), fallback );
	assert.equal(
		dominantChameleonSupportCollider(
			[ { collider: ground, state: 'holding', load: 1 } ],
			fallback,
		),
		ground,
	);

} );

test( 'CHAMELEON-PHYSICS-000C jaw motion follows logical attack phases without animation clips', () => {

	assert.equal( chameleonJawOpening( CHAMELEON_STATE.REST_SCAN, 1 ), 0 );
	assert.equal( chameleonJawOpening( CHAMELEON_STATE.STRIKE_EXTEND, 0 ), 1 );
	assert.equal( chameleonJawOpening( CHAMELEON_STATE.CONTACT, 0.5 ), 1 );
	assert.equal( chameleonJawOpening( CHAMELEON_STATE.RETRACT_WITH_PREY, 1 ), 1 );
	assert.ok( chameleonJawOpening( CHAMELEON_STATE.AIM_AND_BRACE, 0.25 ) > 0 );
	assert.ok( chameleonJawOpening( CHAMELEON_STATE.BITE_AND_SWALLOW, 0.8 ) < 1 );

} );

test( 'CHAMELEON-PHYSICS-000D every fixed step publishes pose before intent and physics', async () => {

	const source = await readSource( '../src/chameleon-physical-system.js' );
	const start = source.indexOf( '\n\tfunction beforePhysicsStep(' );
	const end = source.indexOf( '\n\tfunction stepSimulation(', start );
	const fixed = source.slice( start, end );
	const pose = fixed.indexOf( 'simulation.setExternalPose(' );
	const behaviour = fixed.indexOf( 'simulation.update(' );
	const command = fixed.indexOf( 'hybrid.setCommand(' );
	const bodyStep = fixed.indexOf( 'hybrid.beforeStep(' );
	assert.ok( start >= 0 && end > start );
	assert.ok( pose >= 0 && behaviour > pose && command > behaviour && bodyStep > command );
	assert.match( fixed, /explorer\.update\(/u );
	assert.doesNotMatch( fixed, /setTrackPosition|setTrackSamples|_moveTowardsTrackPosition/u );

} );

test( 'CHAMELEON-PHYSICS-000E route requests are bounded, prioritised and serviced off-step', async () => {

	const source = await readSource( '../src/chameleon-physical-system.js' );
	const requestStart = source.indexOf( '\n\tfunction requestRoute(' );
	const requestEnd = source.indexOf( '\n\tfunction updateLookTarget(', requestStart );
	const request = source.slice( requestStart, requestEnd );
	assert.match( source, /const MAX_ROUTE_ATTEMPTS\s*=\s*12/u );
	assert.match( source, /const ROUTE_REPLAN_SECONDS\s*=\s*0\.82/u );
	assert.match( request, /routeRequest\s*===\s*2\s*&&\s*type\s*!==\s*2/u );
	assert.match( source, /if\s*\(\s*routeRequest\s*===\s*1\s*\)\s*accepted\s*=\s*planExplorationDestination/u );
	assert.match( source, /else if\s*\(\s*routeRequest\s*===\s*2\s*\)\s*accepted\s*=\s*planTowardsPrey/u );
	assert.match( source, /else if\s*\(\s*routeRequest\s*===\s*3\s*\)\s*accepted\s*=\s*replanCurrentDestination/u );
	const stepStart = source.indexOf( '\n\tfunction stepSimulation(' );
	const renderStart = source.indexOf( '\n\tfunction updateAvoidanceView(', stepStart );
	const step = source.slice( stepStart, renderStart );
	assert.ok( step.indexOf( 'surfaceWorld.physics.step(' ) < step.indexOf( 'serviceRouteRequest()' ) );

} );

test( 'CHAMELEON-PHYSICS-001 production owns one Rapier world and one static surface body', async () => {

	const [ runtime, surfaces ] = await Promise.all( [
		readSource( '../src/chameleon-physical-system.js' ),
		readSource( '../src/chameleon-main-surfaces.js' ),
	] );
	assert.equal( ( runtime.match( /createMainChameleonSurfaceWorld\(/gu ) || [] ).length, 1 );
	assert.equal( ( surfaces.match( /createPhysicsWorld\(\s*\{/gu ) || [] ).length, 1 );
	assert.equal( ( surfaces.match( /RigidBodyDesc\.fixed\(\)/gu ) || [] ).length, 1 );
	assert.match( surfaces, /ColliderDesc\.trimesh\(/u );
	assert.match( surfaces, /buildLabSurfaceNavigationGraph\(\s*entries/u );
	assert.match( surfaces, /destinationHandles:\s*frozenDestinations/u );
	assert.match( runtime, /surfaceWorld\.physics\.step\(/u );
	assert.match( runtime, /architecture:\s*[']shared-rapier-hybrid-surface-manifold[']/u );

} );

test( 'CHAMELEON-PHYSICS-002 fixed locomotion and render hot paths allocate no scene queries', async () => {

	const source = await readSource( '../src/chameleon-physical-system.js' );
	const fixedStart = source.indexOf( '\n\tfunction beforePhysicsStep(' );
	const fixedEnd = source.indexOf( '\n\tfunction stepSimulation(', fixedStart );
	const fixed = source.slice( fixedStart, fixedEnd );
	assert.doesNotMatch( fixed, /\bnew\s+(?:THREE\.|Float32Array|Uint8Array|Array|Map|Set)/u );
	assert.doesNotMatch( fixed, /\.clone\(\)|\.map\(|\.filter\(|\.slice\(/u );
	assert.doesNotMatch( source, /new THREE\.Raycaster|intersectObjects?\s*\(|\.raycast\s*\(/u );
	const renderStart = source.indexOf( '\n\tfunction renderFrame(' );
	const renderEnd = source.indexOf( '\n\tfunction reset(', renderStart );
	const render = source.slice( renderStart, renderEnd );
	assert.doesNotMatch( render, /surfaceWorld\.physics\.step|simulation\.update/u );

} );

test( 'CHAMELEON-PHYSICS-003 facade exposes the physical debug and gameplay ownership graph', async () => {

	const source = await readSource( '../src/chameleon-physical-system.js' );
	for ( const contract of [
		'stepSimulation', 'renderFrame', 'reset', 'dispose', 'setSurfaceVisible',
		'setCastShadow', 'setReceiveShadow', 'select', 'clearSelection',
		'getSimulation', 'getTelemetry', 'getDebugView', 'getAvoidanceContext',
		'getSupportNetwork', 'getSurfaceWorld', 'getSurfaceRouter', 'getTrack',
		'getProceduralGait', 'getRigBinding', 'getTailContactSolver',
		'getBodyContactView', 'getLocomotionState', 'getFootContacts',
	] ) assert.ok( source.includes( contract ), contract );
	assert.match( source, /debugView\.groundedFeet\s*=\s*hybrid\.contactCount/u );
	assert.match( source, /debugView\.pathReachable\s*=\s*explorer\.destinationActive/u );
	assert.match( source, /avoidanceView\.camouflaged\s*=\s*camouflaged/u );

} );
