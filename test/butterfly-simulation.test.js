import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
	BUTTERFLY_BEHAVIOR,
	BUTTERFLY_BEHAVIOR_NAMES,
	BUTTERFLY_FLOWER_CANDIDATE_SAMPLES,
	BUTTERFLY_STAGE,
	BUTTERFLY_STAGE_NAMES,
	ButterflySimulation,
	createButterflySimulation,
} from '../src/butterfly-simulation.js';

function createContext() {

	return {
		daylight: 1,
		weather: {
			temperatureC: 24,
			rain: 0,
			windSpeed: 0.8,
		},
		habitat: { x: 0, y: 0.4, z: 0 },
		flowers: {
			count: 6,
			x: new Float32Array( [ 2, 3, - 2, - 3, 1, - 1 ] ),
			y: new Float32Array( [ 0.5, 0.65, 0.55, 0.6, 0.7, 0.75 ] ),
			z: new Float32Array( [ 0, 2, 0, - 2, - 1, 1 ] ),
			active: new Uint8Array( [ 1, 1, 1, 1, 1, 1 ] ),
			patch: new Uint16Array( [ 10, 10, 20, 20, 30, 30 ] ),
			quality: new Float32Array( [ 0.9, 1, 0.8, 0.95, 0.85, 0.92 ] ),
			nectar: new Float32Array( [ 20, 20, 20, 20, 20, 20 ] ),
		},
	};

}

function run( simulation, context, steps, dt ) {

	for ( let i = 0; i < steps; i ++ ) simulation.update( dt, context );

}

test( 'BUTTERFLY-SIM-001 preallocates stable renderer-facing SoA views', () => {

	const simulation = createButterflySimulation( {
		capacity: 32,
		initialCount: 12,
		seed: 123,
	} );
	const views = simulation.getViews();
	const telemetry = simulation.getTelemetry();

	assert.equal( simulation.capacity, 32 );
	assert.equal( simulation.count, 12 );
	assert.ok( views.stage instanceof Uint8Array );
	assert.ok( views.behavior instanceof Uint8Array );
	assert.ok( views.visible instanceof Uint8Array );
	assert.ok( views.targetFlower instanceof Int32Array );
	assert.ok( views.x instanceof Float32Array );
	assert.equal( views.x.length, 32 );
	assert.equal( telemetry.visibleAdults, 12 );

	simulation.update( 0.1, createContext() );
	assert.equal( simulation.getViews(), views );
	assert.equal( simulation.getTelemetry(), telemetry );
	assert.equal( telemetry.stageCounts.length, BUTTERFLY_STAGE_NAMES.length );
	assert.equal( telemetry.behaviorCounts.length, BUTTERFLY_BEHAVIOR_NAMES.length );

} );

test( 'BUTTERFLY-SIM-002 identical seeds and inputs produce identical trajectories', () => {

	const options = {
		capacity: 24,
		initialCount: 24,
		seed: 0x12345678,
		lifeSpeed: 1.7,
	};
	const a = new ButterflySimulation( options );
	const b = new ButterflySimulation( options );
	const contextA = createContext();
	const contextB = createContext();

	run( a, contextA, 600, 0.025 );
	run( b, contextB, 600, 0.025 );

	assert.deepEqual( a.stage, b.stage );
	assert.deepEqual( a.behavior, b.behavior );
	assert.deepEqual( a.visible, b.visible );
	assert.deepEqual( a.x, b.x );
	assert.deepEqual( a.y, b.y );
	assert.deepEqual( a.z, b.z );
	assert.deepEqual( a.headingX, b.headingX );
	assert.deepEqual( a.headingY, b.headingY );
	assert.deepEqual( a.headingZ, b.headingZ );
	assert.deepEqual( a.targetFlower, b.targetFlower );
	assert.deepEqual( a.rngState, b.rngState );
	assert.deepEqual( contextA.flowers.nectar, contextB.flowers.nectar );
	assert.deepEqual( a.getTelemetry(), b.getTelemetry() );

} );

test( 'BUTTERFLY-SIM-003 lifecycle follows EGG to LARVA to PUPA to ADULT to EGG', () => {

	const simulation = new ButterflySimulation( {
		capacity: 1,
		initialCount: 1,
		initialStage: BUTTERFLY_STAGE.EGG,
		seed: 77,
		lifeSpeed: 1,
		eggDuration: 0.2,
		eggDurationSpread: 0,
		larvaDuration: 0.3,
		larvaDurationSpread: 0,
		pupaDuration: 0.4,
		pupaDurationSpread: 0,
		adultDuration: 0.5,
		adultDurationSpread: 0,
		staggerInitialLifecycle: false,
	} );
	const context = createContext();

	assert.equal( simulation.stage[ 0 ], BUTTERFLY_STAGE.EGG );
	assert.equal( simulation.visible[ 0 ], 0 );

	simulation.update( 0.2, context );
	assert.equal( simulation.stage[ 0 ], BUTTERFLY_STAGE.LARVA );
	assert.equal( simulation.visible[ 0 ], 0 );

	simulation.update( 0.3, context );
	assert.equal( simulation.stage[ 0 ], BUTTERFLY_STAGE.PUPA );
	assert.equal( simulation.visible[ 0 ], 0 );

	simulation.update( 0.4, context );
	assert.equal( simulation.stage[ 0 ], BUTTERFLY_STAGE.ADULT );
	assert.equal( simulation.visible[ 0 ], 1 );

	simulation.update( 0.5, context );
	assert.equal( simulation.stage[ 0 ], BUTTERFLY_STAGE.EGG );
	assert.equal( simulation.visible[ 0 ], 0 );
	assert.equal( simulation.generation[ 0 ], 1 );

	const telemetry = simulation.getTelemetry();
	assert.equal( telemetry.eggHatches, 1 );
	assert.equal( telemetry.larvaePupated, 1 );
	assert.equal( telemetry.adultsEmerged, 1 );
	assert.equal( telemetry.cyclesCompleted, 1 );

} );

test( 'BUTTERFLY-SIM-004 darkness and storms stop activity, never lifecycle ageing', () => {

	const options = {
		capacity: 8,
		initialCount: 8,
		initialStage: BUTTERFLY_STAGE.EGG,
		seed: 91,
		lifeSpeed: 2,
		staggerInitialLifecycle: false,
	};
	const fair = new ButterflySimulation( options );
	const storm = new ButterflySimulation( options );
	const fairContext = createContext();
	const stormContext = createContext();
	stormContext.daylight = 0;
	stormContext.weather.temperatureC = 5;
	stormContext.weather.rain = 1;
	stormContext.weather.windSpeed = 12;

	run( fair, fairContext, 80, 0.05 );
	run( storm, stormContext, 80, 0.05 );

	assert.deepEqual( fair.stage, storm.stage );
	assert.deepEqual( fair.stageTime, storm.stageTime );
	assert.deepEqual( fair.age, storm.age );
	assert.equal( fair.getTelemetry().eggHatches, storm.getTelemetry().eggHatches );

	const adultStorm = new ButterflySimulation( {
		capacity: 8,
		initialCount: 8,
		seed: 92,
		restDuration: 0.01,
		restDurationSpread: 0,
	} );
	run( adultStorm, stormContext, 100, 0.04 );
	assert.equal( adultStorm.getTelemetry().flightsStarted, 0 );
	assert.equal( adultStorm.getTelemetry().flying, 0 );
	assert.equal( adultStorm.getTelemetry().resting, adultStorm.getTelemetry().visibleAdults );

	const interrupted = new ButterflySimulation( {
		capacity: 1,
		initialCount: 1,
		seed: 93,
		lifeSpeed: 0,
	} );
	interrupted.behavior[ 0 ] = BUTTERFLY_BEHAVIOR.FLY;
	interrupted.behaviorTime[ 0 ] = 10;
	interrupted.targetFlower[ 0 ] = 0;
	interrupted.y[ 0 ] = 4;
	interrupted.update( 0.05, stormContext );
	assert.equal( interrupted.behavior[ 0 ], BUTTERFLY_BEHAVIOR.REST );
	run( interrupted, stormContext, 100, 0.05 );
	assert.ok( interrupted.y[ 0 ] <= stormContext.habitat.y + 0.121 );

} );

test( 'BUTTERFLY-SIM-005 adult FLY, FEED and REST states are all productive and reachable', () => {

	const simulation = new ButterflySimulation( {
		capacity: 16,
		initialCount: 16,
		seed: 234,
		lifeSpeed: 0,
		flightSpeed: 12,
		restDuration: 0.02,
		restDurationSpread: 0.02,
		feedDuration: 0.03,
		feedDurationSpread: 0.02,
		flightTimeout: 3,
		flightTimeoutSpread: 1,
	} );
	const context = createContext();
	const observed = new Uint8Array( BUTTERFLY_BEHAVIOR_NAMES.length );
	observed[ BUTTERFLY_BEHAVIOR.REST ] = 1;

	simulation.animationTime[ 0 ] = 2.5;
	simulation._setBehavior( 0, BUTTERFLY_BEHAVIOR.FLY, 1 );
	assert.equal( simulation.animationTime[ 0 ], 2.5, 'behavior changes must preserve the shared clip phase' );

	for ( let step = 0; step < 600; step ++ ) {

		simulation.update( 0.02, context );
		for ( let i = 0; i < simulation.count; i ++ ) observed[ simulation.behavior[ i ] ] = 1;

	}

	assert.equal( observed[ BUTTERFLY_BEHAVIOR.FLY ], 1 );
	assert.equal( observed[ BUTTERFLY_BEHAVIOR.FEED ], 1 );
	assert.equal( observed[ BUTTERFLY_BEHAVIOR.REST ], 1 );
	assert.ok( simulation.getTelemetry().flightsStarted > 0 );
	assert.ok( simulation.getTelemetry().flowerVisits > 0 );
	assert.ok( simulation.getTelemetry().distanceTravelled > 0 );
	assert.ok( context.flowers.nectar.some( ( stock ) => stock < 20 ) );
	assert.equal( BUTTERFLY_FLOWER_CANDIDATE_SAMPLES, 4 );

} );

test( 'BUTTERFLY-SIM-006 flower targets and headings are valid direct indexed data', () => {

	const simulation = new ButterflySimulation( {
		capacity: 32,
		initialCount: 32,
		seed: 1001,
		lifeSpeed: 0,
		restDuration: 0.01,
		restDurationSpread: 0,
	} );
	const context = createContext();

	run( simulation, context, 20, 0.025 );

	let assigned = 0;
	for ( let i = 0; i < simulation.count; i ++ ) {

		const target = simulation.targetFlower[ i ];
		if ( target >= 0 ) {

			assigned ++;
			assert.ok( target < context.flowers.count );

		}
		if ( simulation.behavior[ i ] === BUTTERFLY_BEHAVIOR.FLY ) {

			const length = Math.hypot(
				simulation.headingX[ i ],
				simulation.headingY[ i ],
				simulation.headingZ[ i ],
			);
			assert.ok( Math.abs( length - 1 ) < 0.00001 );

		}

	}
	assert.ok( assigned > 0 );

	const flying = simulation.behavior.findIndex(
		( behavior, index ) => index < simulation.count && behavior === BUTTERFLY_BEHAVIOR.FLY,
	);
	assert.ok( flying >= 0 );
	const exhausted = simulation.targetFlower[ flying ];
	assert.ok( exhausted >= 0 );
	context.flowers.active[ exhausted ] = 0;
	simulation.update( 0.025, context );
	assert.notEqual( simulation.targetFlower[ flying ], exhausted, 'an inactive target must be abandoned immediately' );

} );

test( 'BUTTERFLY-SIM-007 count changes respect capacity and preserve buffer identity', () => {

	const simulation = new ButterflySimulation( {
		capacity: 10,
		initialCount: 2,
		seed: 51,
	} );
	const views = simulation.getViews();

	assert.equal( simulation.setCount( 8 ), 8 );
	assert.equal( simulation.count, 8 );
	assert.equal( simulation.getViews(), views );
	assert.equal( simulation.setCount( 3 ), 3 );
	assert.equal( simulation.getTelemetry().count, 3 );
	assert.throws( () => simulation.setCount( 11 ), RangeError );
	assert.throws( () => simulation.addButterflies( 8 ), RangeError );

} );

test( 'BUTTERFLY-SIM-008 debug records expose lifecycle and intent explicitly', () => {

	const simulation = new ButterflySimulation( {
		capacity: 2,
		initialCount: 1,
		initialStage: BUTTERFLY_STAGE.LARVA,
		seed: 6,
	} );
	const output = {};

	assert.equal( simulation.writeDebugRecord( 0, output ), output );
	assert.equal( output.index, 0 );
	assert.equal( output.stage, 'LARVA' );
	assert.equal( output.behavior, 'REST' );
	assert.equal( output.visible, false );
	assert.equal( typeof output.stageTime, 'number' );
	assert.throws( () => simulation.snapshot( 1 ), RangeError );

} );

test( 'BUTTERFLY-SIM-009 hot update path has no ambient RNG or collection allocation', async () => {

	const source = await readFile( new URL( '../src/butterfly-simulation.js', import.meta.url ), 'utf8' );
	const updateBody = source.slice(
		source.indexOf( '\n\tupdate( dt, context ) {' ),
		source.indexOf( '\n\twriteDebugRecord' ),
	);

	assert.doesNotMatch( source, /Math\.random/ );
	assert.doesNotMatch( updateBody, /\bnew\s+(?:Array|Object|Map|Set|Float|Uint|Int)/ );
	assert.doesNotMatch( updateBody, /\.map\(|\.filter\(|\.reduce\(|\.slice\(/ );

} );
