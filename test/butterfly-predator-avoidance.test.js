import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
	BUTTERFLY_BEHAVIOR,
	ButterflySimulation,
} from '../src/butterfly-simulation.js';

function createSimulation( overrides = {} ) {

	const simulation = new ButterflySimulation( {
		capacity: overrides.capacity ?? 1,
		initialCount: overrides.initialCount ?? 1,
		seed: overrides.seed ?? 0x51a7,
		adultSpawnRadius: 0,
		adultDuration: 1000,
		adultDurationSpread: 0,
		staggerInitialLifecycle: false,
		predatorViewDistance: 6,
		predatorViewFovDegrees: 240,
		predatorThreatScanFrequency: 20,
		predatorFearMemory: 0.35,
		...overrides,
	} );
	for ( let i = 0; i < simulation.count; i ++ ) {

		simulation.x[ i ] = i * 0.15;
		simulation.y[ i ] = 1;
		simulation.z[ i ] = 0;
		simulation.headingX[ i ] = 1;
		simulation.headingY[ i ] = 0;
		simulation.headingZ[ i ] = 0;
		simulation.behavior[ i ] = BUTTERFLY_BEHAVIOR.REST;
		simulation.behaviorTime[ i ] = 10;
		simulation.threatScanTime[ i ] = 0;

	}
	return simulation;

}

function createContext( predator = null ) {

	return {
		daylight: 1,
		weather: { temperatureC: 24, rain: 0, windSpeed: 0 },
		habitat: { x: 0, y: 0, z: 0 },
		flowers: { count: 0 },
		predator,
	};

}

function predator( overrides = {} ) {

	return {
		active: true,
		camouflaged: false,
		x: 2,
		y: 1,
		z: 0,
		headingX: 1,
		headingY: 0,
		headingZ: 0,
		speed: 0,
		...overrides,
	};

}

test( 'BUTTERFLY-FEAR-001 a visible chameleon interrupts activity and starts a continuous escape', () => {

	const simulation = createSimulation();
	const context = createContext( predator() );
	const startX = simulation.x[ 0 ];

	simulation.update( 0.025, context );
	const snapshot = simulation.snapshot( 0 );
	assert.equal( snapshot.threatVisible, true );
	assert.equal( snapshot.intention, 'FLEE_CHAMELEON' );
	for ( let step = 1; step < 20; step ++ ) simulation.update( 0.025, context );

	assert.equal( simulation.behavior[ 0 ], BUTTERFLY_BEHAVIOR.FLY );
	assert.equal( simulation.targetFlower[ 0 ], - 1 );
	assert.ok( simulation.x[ 0 ] < startX, 'escape must turn away from a predator in front' );
	assert.ok( simulation.getTelemetry().threatDetections >= 1 );
	assert.ok( simulation.getTelemetry().fleeDistance > 0 );

	assert.equal( snapshot.intention, 'FLEE_CHAMELEON' );
	assert.equal( snapshot.threat, 'CHAMELEON' );
	assert.equal( snapshot.visionDistance, 6 );
	assert.equal( snapshot.visionFovDegrees, 240 );
	assert.ok( Number.isFinite( snapshot.threatDistance ) );

} );

test( 'BUTTERFLY-FEAR-002 camouflage is perceptually identical to an absent predator and clears fear immediately', () => {

	const hidden = createSimulation( { seed: 88 } );
	const absent = createSimulation( { seed: 88 } );
	const hiddenContext = createContext( predator( { camouflaged: true } ) );
	const absentContext = createContext();

	for ( let step = 0; step < 40; step ++ ) {

		hidden.update( 0.025, hiddenContext );
		absent.update( 0.025, absentContext );

	}
	assert.deepEqual( hidden.x, absent.x );
	assert.deepEqual( hidden.y, absent.y );
	assert.deepEqual( hidden.z, absent.z );
	assert.deepEqual( hidden.headingX, absent.headingX );
	assert.deepEqual( hidden.behavior, absent.behavior );
	assert.equal( hidden.getTelemetry().threatScans, 0 );

	const visible = createSimulation();
	const threat = predator();
	const context = createContext( threat );
	visible.update( 0.05, context );
	assert.ok( visible.fearTime[ 0 ] > 0 );
	threat.camouflaged = true;
	visible.update( 0.01, context );
	assert.equal( visible.fearTime[ 0 ], 0 );
	assert.equal( visible.threatVisible[ 0 ], 0 );
	assert.equal( visible.snapshot( 0 ).threat, null );

} );

test( 'BUTTERFLY-FEAR-003 configurable FOV rejects a rear threat while panoramic vision detects it', () => {

	const simulation = createSimulation( {
		predatorViewFovDegrees: 60,
		predatorThreatScanFrequency: 60,
	} );
	const context = createContext( predator( { x: - 2 } ) );

	simulation.update( 0.02, context );
	assert.equal( simulation.threatVisible[ 0 ], 0 );
	assert.equal( simulation.fearTime[ 0 ], 0 );

	simulation.setPredatorPerception( {
		butterflyPredatorVisionDistance: 4,
		butterflyPredatorVisionAngle: 360,
		butterflyFleeSpeedMultiplier: 1.8,
		butterflyThreatScanFrequency: 30,
	} );
	simulation.threatScanTime[ 0 ] = 0;
	simulation.update( 0.02, context );
	assert.equal( simulation.threatVisible[ 0 ], 1 );
	assert.ok( simulation.fearTime[ 0 ] > 0 );
	assert.equal( simulation.predatorViewDistance, 4 );
	assert.equal( simulation.predatorViewFovDegrees, 360 );
	assert.equal( simulation.predatorFleeSpeedMultiplier, 1.8 );
	assert.equal( simulation.predatorThreatScanFrequency, 30 );

} );

test( 'BUTTERFLY-FEAR-004 moving-predator anticipation alters the escape vector without teleportation', () => {

	const moving = createSimulation( { predatorViewFovDegrees: 360, predatorTurnRate: 20 } );
	const staticThreat = createSimulation( { predatorViewFovDegrees: 360, predatorTurnRate: 20 } );
	const dt = 0.02;
	const beforeX = moving.x[ 0 ];
	const beforeY = moving.y[ 0 ];
	const beforeZ = moving.z[ 0 ];

	moving.update( dt, createContext( predator( { velocityZ: 8 } ) ) );
	staticThreat.update( dt, createContext( predator() ) );

	const displacement = Math.hypot(
		moving.x[ 0 ] - beforeX,
		moving.y[ 0 ] - beforeY,
		moving.z[ 0 ] - beforeZ,
	);
	const maximum = moving.flightSpeed * moving.predatorFleeSpeedMultiplier * 1.15 * dt;
	assert.ok( displacement <= maximum + 0.000001, 'fleeing remains speed-bounded' );
	assert.ok( moving.headingZ[ 0 ] < staticThreat.headingZ[ 0 ], 'predicted lateral motion must be avoided' );

} );

test( 'BUTTERFLY-FEAR-005 threat scans are frequency bounded and trajectories stay deterministic', () => {

	const options = {
		capacity: 12,
		initialCount: 12,
		seed: 0x1701,
		predatorViewFovDegrees: 360,
		predatorThreatScanFrequency: 10,
	};
	const a = createSimulation( options );
	const b = createSimulation( options );
	const contextA = createContext( predator( { velocityZ: 0.7 } ) );
	const contextB = createContext( predator( { velocityZ: 0.7 } ) );

	for ( let step = 0; step < 240; step ++ ) {

		a.update( 1 / 240, contextA );
		b.update( 1 / 240, contextB );

	}
	assert.deepEqual( a.x, b.x );
	assert.deepEqual( a.y, b.y );
	assert.deepEqual( a.z, b.z );
	assert.deepEqual( a.headingX, b.headingX );
	assert.deepEqual( a.headingY, b.headingY );
	assert.deepEqual( a.headingZ, b.headingZ );
	assert.deepEqual( a.fearTime, b.fearTime );
	assert.deepEqual( a.threatVisible, b.threatVisible );
	assert.deepEqual( a.getTelemetry(), b.getTelemetry() );
	assert.ok( a.getTelemetry().threatScans <= a.count * 12 );

} );

test( 'BUTTERFLY-FEAR-006 hot avoidance stays allocation-free and facade exposes stable selection mapping', async () => {

	const [ kernel, facade ] = await Promise.all( [
		readFile( new URL( '../src/butterfly-simulation.js', import.meta.url ), 'utf8' ),
		readFile( new URL( '../src/butterflies.js', import.meta.url ), 'utf8' ),
	] );
	const avoidance = kernel.slice(
		kernel.indexOf( '\n\t_updatePredatorAvoidance(' ),
		kernel.indexOf( '\n\t_advanceLifecycle', kernel.indexOf( '\n\t_updatePredatorAvoidance(' ) ),
	);
	const writer = facade.slice(
		facade.indexOf( '\n\tfunction writeInstances() {' ),
		facade.indexOf( '\n\tfunction syncSimulationInputs()', facade.indexOf( '\n\tfunction writeInstances() {' ) ),
	);
	const inputSync = facade.slice(
		facade.indexOf( '\n\tfunction syncSimulationInputs() {' ),
		facade.indexOf( '\n\tfunction stepSimulation', facade.indexOf( '\n\tfunction syncSimulationInputs() {' ) ),
	);

	assert.doesNotMatch( avoidance, /\bnew\s+(?:Array|Object|Map|Set|Float|Uint|Int)/u );
	assert.doesNotMatch( avoidance, /\.map\(|\.filter\(|\.reduce\(|\.slice\(/u );
	assert.doesNotMatch( writer, /new Int32Array/u );
	assert.match( inputSync, /context\.predator = predatorThreatGetter \? predatorThreatGetter\(\) : null/u );
	const mappingPosition = writer.indexOf( 'renderedToLogical[ rendered ] = butterfly' );
	const incrementPosition = writer.indexOf( 'rendered ++' );
	assert.ok( mappingPosition >= 0 && incrementPosition > mappingPosition );
	assert.match( facade, /context\.predator = predatorThreatGetter \? predatorThreatGetter\(\) : null/u );
	assert.match( facade, /renderedToLogical\[ rendered \] = butterfly/u );
	assert.match( facade, /function select\( index \)/u );
	assert.match( facade, /function selectInstance\( instanceId \)/u );
	assert.match( facade, /function getLogicalIndexForInstance\( instanceId \)/u );
	assert.match( facade, /function getDebugSnapshot\(\)/u );

} );
