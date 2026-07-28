import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
	BEE_STATE,
	BEE_STATE_NAMES,
	BeeSimulation,
	FLOWER_CANDIDATE_SAMPLES,
	createBeeSimulation,
} from '../src/bee-simulation.js';

function createContext() {

	return {
		daylight: 1,
		weather: {
			temperatureC: 23,
			rain: 0,
			windSpeed: 0.5,
		},
		hive: { x: 0, y: 1, z: 0 },
		demand: { nectar: 0.65, pollen: 0.35 },
		flowers: {
			count: 4,
			x: new Float32Array( [ 4, 5, - 4, - 5 ] ),
			y: new Float32Array( [ 1.2, 1.4, 1.1, 1.3 ] ),
			z: new Float32Array( [ 0, 2, 0, - 2 ] ),
			active: new Uint8Array( [ 1, 1, 1, 1 ] ),
			patch: new Uint16Array( [ 10, 10, 20, 20 ] ),
			quality: new Float32Array( [ 0.8, 1, 0.75, 0.95 ] ),
			nectar: new Float32Array( [ 20, 20, 20, 20 ] ),
			pollen: new Float32Array( [ 20, 20, 20, 20 ] ),
		},
	};

}

function run( simulation, context, steps, dt ) {

	for ( let i = 0; i < steps; i ++ ) simulation.update( dt, context );

}

test( 'BEE-SIM-001 preallocates stable SoA views for a renderer', () => {

	const simulation = createBeeSimulation( {
		capacity: 32,
		initialCount: 12,
		seed: 123,
	} );
	const views = simulation.getViews();
	const telemetry = simulation.getTelemetry();

	assert.equal( simulation.capacity, 32 );
	assert.equal( simulation.count, 12 );
	assert.ok( views.state instanceof Uint8Array );
	assert.ok( views.x instanceof Float32Array );
	assert.ok( views.targetFlower instanceof Int32Array );
	assert.equal( views.x.length, 32 );

	simulation.update( 0.1, createContext() );
	assert.equal( simulation.getViews(), views );
	assert.equal( simulation.getTelemetry(), telemetry );
	assert.equal( telemetry.stateCounts.length, BEE_STATE_NAMES.length );

} );

test( 'BEE-SIM-002 identical seeds and inputs produce byte-identical trajectories', () => {

	const a = new BeeSimulation( {
		capacity: 24,
		initialCount: 24,
		seed: 0x12345678,
		durationScale: 0.3,
	} );
	const b = new BeeSimulation( {
		capacity: 24,
		initialCount: 24,
		seed: 0x12345678,
		durationScale: 0.3,
	} );
	const contextA = createContext();
	const contextB = createContext();

	run( a, contextA, 500, 0.04 );
	run( b, contextB, 500, 0.04 );

	assert.deepEqual( a.state, b.state );
	assert.deepEqual( a.x, b.x );
	assert.deepEqual( a.y, b.y );
	assert.deepEqual( a.z, b.z );
	assert.deepEqual( a.targetFlower, b.targetFlower );
	assert.deepEqual( a.rngState, b.rngState );
	assert.deepEqual( contextA.flowers.nectar, contextB.flowers.nectar );
	assert.deepEqual( contextA.flowers.pollen, contextB.flowers.pollen );
	assert.deepEqual( a.getTelemetry(), b.getTelemetry() );

} );

test( 'BEE-SIM-003 the complete visible foraging cycle is reachable and productive', () => {

	const simulation = new BeeSimulation( {
		capacity: 8,
		initialCount: 8,
		seed: 77,
		durationScale: 0.18,
		flightSpeed: 12,
		approachSpeed: 6,
	} );
	const context = createContext();
	const observed = new Uint8Array( BEE_STATE_NAMES.length );

	observed[ BEE_STATE.IN_HIVE ] = 1;
	for ( let step = 0; step < 1600; step ++ ) {

		simulation.update( 0.025, context );
		for ( let i = 0; i < simulation.count; i ++ ) observed[ simulation.state[ i ] ] = 1;

	}

	for ( let state = BEE_STATE.IN_HIVE; state <= BEE_STATE.REST; state ++ ) {

		assert.equal( observed[ state ], 1, `${ BEE_STATE_NAMES[ state ] } was never observed` );

	}
	const telemetry = simulation.getTelemetry();
	assert.ok( telemetry.tripsStarted > 0 );
	assert.ok( telemetry.tripsCompleted > 0 );
	assert.ok( telemetry.flowerVisits > 0 );
	assert.ok( telemetry.deliveredNectar + telemetry.deliveredPollen > 0 );

} );

test( 'BEE-SIM-004 darkness and dangerous weather prevent departures without drift', () => {

	const simulation = new BeeSimulation( {
		capacity: 16,
		initialCount: 16,
		seed: 91,
		durationScale: 0.05,
	} );
	const context = createContext();
	context.daylight = 0;
	context.weather.temperatureC = 6;
	context.weather.rain = 1;
	context.weather.windSpeed = 9;

	run( simulation, context, 200, 0.05 );

	assert.equal( simulation.getTelemetry().tripsStarted, 0 );
	for ( let i = 0; i < simulation.count; i ++ ) {

		assert.equal( simulation.state[ i ], BEE_STATE.IN_HIVE );
		assert.equal( simulation.x[ i ], context.hive.x );
		assert.equal( simulation.y[ i ], context.hive.y );
		assert.equal( simulation.z[ i ], context.hive.z );

	}

} );

test( 'BEE-SIM-005 flower and patch targets are direct indexed assignments', () => {

	const simulation = new BeeSimulation( {
		capacity: 64,
		initialCount: 64,
		seed: 234,
		durationScale: 0.04,
	} );
	const context = createContext();

	run( simulation, context, 80, 0.05 );

	let assigned = 0;
	for ( let i = 0; i < simulation.count; i ++ ) {

		const target = simulation.targetFlower[ i ];
		if ( target < 0 ) continue;
		assigned ++;
		assert.ok( target < context.flowers.count );
		assert.equal( simulation.targetPatch[ i ], context.flowers.patch[ target ] );

	}
	assert.ok( assigned > 0 );
	assert.equal( FLOWER_CANDIDATE_SAMPLES, 4 );

} );

test( 'BEE-SIM-006 debug snapshots expose intent without changing hot-loop storage', () => {

	const simulation = new BeeSimulation( {
		capacity: 2,
		initialCount: 1,
		seed: 6,
	} );
	const output = {};

	assert.equal( simulation.writeDebugRecord( 0, output ), output );
	assert.equal( output.index, 0 );
	assert.equal( output.state, 'IN_HIVE' );
	assert.equal( typeof output.energy, 'number' );
	assert.equal( simulation.snapshot( 0 ).resource === 'nectar' || simulation.snapshot( 0 ).resource === 'pollen', true );
	assert.throws( () => simulation.snapshot( 1 ), RangeError );

} );

test( 'BEE-SIM-007 hot path has no ambient RNG or per-frame collection construction', async () => {

	const source = await readFile( new URL( '../src/bee-simulation.js', import.meta.url ), 'utf8' );
	const updateBody = source.slice( source.indexOf( '\n\tupdate( dt, context ) {' ), source.indexOf( '\n\twriteDebugRecord' ) );
	const demographyBody = source.slice( source.indexOf( '\n\t_advanceCohorts() {' ), source.indexOf( '\n\t_flightCondition' ) );

	assert.doesNotMatch( source, /Math\.random/ );
	assert.doesNotMatch( updateBody, /\bnew\s+(?:Array|Object|Map|Set|Float|Uint|Int)/ );
	assert.doesNotMatch( updateBody, /\.map\(|\.filter\(|\.reduce\(|\.slice\(/ );
	assert.doesNotMatch( demographyBody, /\bnew\s+(?:Array|Object|Map|Set|Float|Uint|Int)/ );
	assert.doesNotMatch( demographyBody, /\.map\(|\.filter\(|\.reduce\(|\.slice\(/ );

} );

test( 'BEE-SIM-008 aggregate cohorts progress through the 3 + 6 + 12 day lifecycle', () => {

	const simulation = new BeeSimulation( {
		capacity: 1,
		initialCount: 0,
		biologicalDaysPerSecond: 1,
		cohortStepDays: 1,
		queenEggsPerDay: 100,
		initialAdultWorkers: 10000,
		adultCapacityForFullLaying: 1,
		adultDailyMortality: 0,
		eggSurvival: 1,
		larvaSurvival: 1,
		pupaSurvival: 1,
	} );
	const context = createContext();

	simulation.setQueenPresent( false );
	simulation.update( 1, context );
	assert.equal( simulation.getTelemetry().demography.eggs, 0 );

	simulation.setQueenPresent( true );
	run( simulation, context, 2, 1 );
	assert.equal( simulation.getTelemetry().demography.eggs, 200 );
	assert.equal( simulation.getTelemetry().demography.larvae, 0 );

	simulation.update( 1, context );
	assert.equal( simulation.getTelemetry().demography.eggs, 200 );
	assert.equal( simulation.getTelemetry().demography.larvae, 100 );

	run( simulation, context, 6, 1 );
	assert.ok( simulation.getTelemetry().demography.pupae >= 100 );

	run( simulation, context, 12, 1 );
	const demography = simulation.getTelemetry().demography;
	assert.ok( demography.emergedWorkers >= 100 );
	assert.ok( demography.adultWorkers > 10000 );

} );

test( 'BEE-SIM-009 weather changes activity, never biological ageing', () => {

	const options = {
		capacity: 1,
		initialCount: 0,
		seed: 45,
		biologicalDaysPerSecond: 1,
		cohortStepDays: 0.5,
		initialAdultWorkers: 20000,
	};
	const fair = new BeeSimulation( options );
	const storm = new BeeSimulation( options );
	const fairContext = createContext();
	const stormContext = createContext();
	stormContext.daylight = 0;
	stormContext.weather.temperatureC = 3;
	stormContext.weather.rain = 1;
	stormContext.weather.windSpeed = 12;

	run( fair, fairContext, 50, 0.5 );
	run( storm, stormContext, 50, 0.5 );

	assert.deepEqual( fair.getDemographyViews().eggs, storm.getDemographyViews().eggs );
	assert.deepEqual( fair.getDemographyViews().larvae, storm.getDemographyViews().larvae );
	assert.deepEqual( fair.getDemographyViews().pupae, storm.getDemographyViews().pupae );
	assert.deepEqual( fair.getTelemetry().demography, storm.getTelemetry().demography );

} );

test( 'BEE-SIM-010 demographic buffers and telemetry objects remain stable', () => {

	const simulation = new BeeSimulation( {
		capacity: 32,
		initialCount: 16,
		initialAdultWorkers: 500000,
	} );
	const views = simulation.getDemographyViews();
	const demography = simulation.getTelemetry().demography;
	const eggs = views.eggs;
	const larvae = views.larvae;
	const pupae = views.pupae;

	run( simulation, createContext(), 100, 0.1 );

	assert.equal( simulation.getDemographyViews(), views );
	assert.equal( simulation.getTelemetry().demography, demography );
	assert.equal( simulation.getDemographyViews().eggs, eggs );
	assert.equal( simulation.getDemographyViews().larvae, larvae );
	assert.equal( simulation.getDemographyViews().pupae, pupae );
	assert.ok( eggs instanceof Float64Array );
	assert.equal( simulation.count, 16 );
	assert.equal( simulation.capacity, 32 );
	assert.ok( demography.workersPerRepresentative > 10000 );

} );

test( 'BEE-SIM-011 demographic work is independent of represented colony size', () => {

	const common = {
		capacity: 1,
		initialCount: 0,
		queenPresent: false,
		biologicalDaysPerSecond: 1,
		cohortStepDays: 0.25,
	};
	const small = new BeeSimulation( { ...common, initialAdultWorkers: 1000 } );
	const large = new BeeSimulation( { ...common, initialAdultWorkers: 1000000 } );
	const context = createContext();

	run( small, context, 20, 0.5 );
	run( large, context, 20, 0.5 );

	assert.equal(
		small.getTelemetry().demography.cohortAdvances,
		large.getTelemetry().demography.cohortAdvances,
	);
	assert.equal( small.getDemographyViews().eggs.length, large.getDemographyViews().eggs.length );
	assert.equal( small.getDemographyViews().larvae.length, large.getDemographyViews().larvae.length );
	assert.equal( small.getDemographyViews().pupae.length, large.getDemographyViews().pupae.length );

} );

test( 'BEE-SIM-012 old visible representatives recycle deterministically', () => {

	const options = {
		capacity: 4,
		initialCount: 4,
		seed: 990,
		biologicalDaysPerSecond: 1,
		representativeLifespanDays: 0.2,
		representativeLifespanSpreadDays: 0,
	};
	const a = new BeeSimulation( options );
	const b = new BeeSimulation( options );
	const contextA = createContext();
	const contextB = createContext();
	contextA.daylight = 0;
	contextB.daylight = 0;

	run( a, contextA, 2, 0.25 );
	run( b, contextB, 2, 0.25 );

	assert.deepEqual( a.generation, b.generation );
	assert.deepEqual( a.ageDays, b.ageDays );
	for ( let i = 0; i < a.count; i ++ ) assert.equal( a.generation[ i ], 2 );
	assert.equal( a.getTelemetry().demography.representativeRecycles, 8 );
	assert.equal( a.count, 4 );

} );
test( 'BEE-SIM-013 initial brood is uniformly and deterministically seeded', () => {

	const options = {
		capacity: 1,
		initialCount: 0,
		seed: 741,
		initialEggs: 120,
		initialLarvae: 240,
		initialPupae: 480,
	};
	const a = new BeeSimulation( options );
	const b = new BeeSimulation( options );
	const views = a.getDemographyViews();

	assert.deepEqual( views.eggs, b.getDemographyViews().eggs );
	assert.deepEqual( views.larvae, b.getDemographyViews().larvae );
	assert.deepEqual( views.pupae, b.getDemographyViews().pupae );
	for ( let i = 0; i < views.eggs.length; i ++ ) assert.equal( views.eggs[ i ], 10 );
	for ( let i = 0; i < views.larvae.length; i ++ ) assert.equal( views.larvae[ i ], 10 );
	for ( let i = 0; i < views.pupae.length; i ++ ) assert.equal( views.pupae[ i ], 10 );

	const demography = a.getTelemetry().demography;
	assert.equal( demography.eggs, 120 );
	assert.equal( demography.larvae, 240 );
	assert.equal( demography.pupae, 480 );

} );
test( 'BEE-SIM-014 animation phase only resets when the visual clip changes', () => {

	const simulation = new BeeSimulation( {
		capacity: 1,
		initialCount: 1,
		seed: 82,
	} );

	simulation._setState( 0, BEE_STATE.ORIENTATION, 1 );
	simulation.animationTime[ 0 ] = 0.625;
	simulation._setState( 0, BEE_STATE.OUTBOUND, 1 );
	assert.equal( simulation.animationTime[ 0 ], 0.625 );
	simulation._setState( 0, BEE_STATE.APPROACH, 1 );
	assert.equal( simulation.animationTime[ 0 ], 0.625 );
	simulation._setState( 0, BEE_STATE.RETURN, 1 );
	assert.equal( simulation.animationTime[ 0 ], 0.625 );

	simulation._setState( 0, BEE_STATE.FORAGE, 1 );
	assert.equal( simulation.animationTime[ 0 ], 0 );
	simulation.animationTime[ 0 ] = 0.375;
	simulation._setState( 0, BEE_STATE.RETURN, 1 );
	assert.equal( simulation.animationTime[ 0 ], 0 );

} );