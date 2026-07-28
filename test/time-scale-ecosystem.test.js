import assert from 'node:assert/strict';
import test from 'node:test';

import { BeeSimulation } from '../src/bee-simulation.js';
import {
	BUTTERFLY_BEHAVIOR,
	ButterflySimulation,
} from '../src/butterfly-simulation.js';
import { ChameleonSimulation } from '../src/chameleon-simulation.js';
import { SimulationClock } from '../src/simulation-clock.js';

const FIXED_STEP = 1 / 120;
const SIMULATED_DURATION = 8;
const EXPECTED_TICKS = SIMULATED_DURATION / FIXED_STEP;
const SPEEDS = [ 1, 4, 15, 22, 100 ];
const FRAME_RATES = [ 30, 60, 144, 240 ];

function cloneValue( value ) {

	if ( ArrayBuffer.isView( value ) ) return value.slice();
	if ( Array.isArray( value ) ) return value.map( cloneValue );
	if ( value && typeof value === 'object' ) {

		return Object.fromEntries(
			Object.entries( value ).map( ( [ key, child ] ) => [ key, cloneValue( child ) ] ),
		);

	}
	return value;

}

function cloneTypedArrayProperties( simulation ) {

	return Object.fromEntries(
		Object.entries( simulation )
			.filter( ( [ , value ] ) => ArrayBuffer.isView( value ) )
			.map( ( [ key, value ] ) => [ key, value.slice() ] ),
	);

}

function createFlowers() {

	return {
		count: 4,
		x: new Float32Array( [ 1.8, 3, - 2, - 3 ] ),
		y: new Float32Array( [ 0.5, 0.65, 0.55, 0.6 ] ),
		z: new Float32Array( [ 0, 2, 0, - 2 ] ),
		contactX: new Float32Array( [ 1.7, 2.9, - 2.1, - 3.1 ] ),
		contactY: new Float32Array( [ 0.7, 0.85, 0.75, 0.8 ] ),
		contactZ: new Float32Array( [ - 0.1, 1.9, 0.1, - 2.1 ] ),
		active: new Uint8Array( [ 1, 1, 1, 1 ] ),
		patch: new Int32Array( [ 10, 10, 20, 20 ] ),
		quality: new Float32Array( [ 1.2, 0.9, 1.1, 0.8 ] ),
		nectar: new Float32Array( [ 100, 100, 100, 100 ] ),
		pollen: new Float32Array( [ 100, 100, 100, 100 ] ),
	};

}

function createScenario() {

	const flowers = createFlowers();
	const weather = {
		temperatureC: 23,
		rain: 0,
		windSpeed: 0.5,
	};
	const hive = {
		x: 0,
		y: 1,
		z: 0,
	};
	const habitat = {
		x: 0,
		y: 0,
		z: 0,
	};

	const bee = new BeeSimulation( {
		capacity: 8,
		initialCount: 8,
		seed: 0x1234abcd,
		durationScale: 0.08,
		flightSpeed: 12,
		approachSpeed: 7,
		forageDurationSeconds: 0.25,
		biologicalDaysPerSecond: 0.4,
		cohortStepDays: 0.25,
		initialAdultWorkers: 2000,
		initialEggs: 120,
		initialLarvae: 80,
		initialPupae: 60,
		queenEggsPerDay: 200,
	} );

	for ( let index = 0; index < bee.count; index ++ ) {

		bee.orientationTrips[ index ] = 0;
		bee.stateTime[ index ] = 0;
		bee.energy[ index ] = 1;

	}

	const butterfly = new ButterflySimulation( {
		capacity: 8,
		initialCount: 8,
		seed: 0x07ac3e91,
		lifeSpeed: 1,
		flightSpeed: 5,
		adultSpawnRadius: 0.25,
		eggDuration: 0.45,
		eggDurationSpread: 0,
		larvaDuration: 0.55,
		larvaDurationSpread: 0,
		pupaDuration: 0.5,
		pupaDurationSpread: 0,
		adultDuration: 2,
		adultDurationSpread: 0,
		restDuration: 0.15,
		restDurationSpread: 0,
		feedDuration: 0.2,
		feedDurationSpread: 0,
		flightTimeout: 2,
		flightTimeoutSpread: 0,
		staggerInitialLifecycle: false,
	} );

	// A stationary adult inside striking range guarantees that the integrated
	// butterfly/chameleon capture contract is exercised before normal flight.
	butterfly.x[ 0 ] = 1.25;
	butterfly.y[ 0 ] = 0.13;
	butterfly.z[ 0 ] = 0;
	butterfly.behavior[ 0 ] = BUTTERFLY_BEHAVIOR.REST;
	butterfly.behaviorTime[ 0 ] = 3;
	butterfly.stageTime[ 0 ] = 3;

	const chameleon = new ChameleonSimulation( {
		preyCapacity: butterfly.capacity,
		scanFrequency: 9,
		attackDistance: 2,
		detectionDistance: 2.8,
		maxTongueLength: 2.2,
		patrolSpeed: 1,
		trackingSpeed: 1.5,
		restScanDuration: 0.02,
		aimDuration: 0.04,
		predictionTime: 0,
		extendDuration: 0.055,
		missRetractDuration: 0.06,
		contactDuration: 0.015,
		retractDuration: 0.09,
		biteDuration: 0.04,
		cooldownDuration: 0.05,
		preyRadius: 0.12,
		tongueRadius: 0.04,
		mouthConsumeRadius: 0.035,
		maxIntegrationStep: 0.0025,
	} );
	chameleon.setTrack( 0, 0, 0, 4, 0, 0 );

	const context = {
		daylight: 1,
		weather,
		hive,
		habitat,
		demand: {
			nectar: 0.65,
			pollen: 0.35,
		},
		colony: {
			nutrition: 1,
			season: 1,
			layingMultiplier: 1,
		},
		flowers,
	};
	const prey = {
		count: butterfly.count,
		capacity: butterfly.capacity,
		x: butterfly.x,
		y: butterfly.y,
		z: butterfly.z,
		visible: butterfly.visible,
		captured: butterfly.captured,
		headingX: butterfly.headingX,
		headingY: butterfly.headingY,
		headingZ: butterfly.headingZ,
		tryCapture: ( index ) => butterfly.tryCapture( index ),
		setCapturedPosition: ( index, x, y, z ) => (
			butterfly.setCapturedPosition( index, x, y, z )
		),
		consume: ( index ) => butterfly.consumeCaptured( index, habitat ),
	};

	return {
		flowers,
		bee,
		butterfly,
		chameleon,
		context,
		prey,
	};

}

function renderFrames( duration, fps, jitter, callback ) {

	const frameCount = Math.max( jitter ? 2 : 1, Math.round( duration * fps ) );
	const base = duration / frameCount;
	let elapsed = 0;

	for ( let frame = 0; frame < frameCount; frame ++ ) {

		const remaining = duration - elapsed;
		const wave = 0.35 + ( ( frame * 37 ) % 11 ) * 0.13;
		const dt = jitter ?
			( frame === frameCount - 1 ? remaining : Math.min( remaining, base * wave ) ) :
			base;
		elapsed += dt;
		callback( dt );

	}

}

function captureSnapshot( scenario, clock ) {

	const { flowers, bee, butterfly, chameleon } = scenario;
	return {
		clock: {
			tickExact: clock.tickExact,
			timeUnits: clock.timeUnits,
			backlogUnits: clock.backlogUnits,
			alpha: clock.alpha,
			effectiveTotal: clock.telemetry.effectiveTotal,
		},
		flowers: cloneValue( flowers ),
		bee: {
			views: cloneValue( bee.getViews() ),
			demographyViews: cloneValue( bee.getDemographyViews() ),
			telemetry: cloneValue( bee.getTelemetry() ),
			allSoA: cloneTypedArrayProperties( bee ),
		},
		butterfly: {
			views: cloneValue( butterfly.getViews() ),
			telemetry: cloneValue( butterfly.getTelemetry() ),
			allSoA: cloneTypedArrayProperties( butterfly ),
		},
		chameleon: {
			view: cloneValue( chameleon.getView() ),
			telemetry: cloneValue( chameleon.getTelemetry() ),
			allSoA: cloneTypedArrayProperties( chameleon ),
		},
	};

}

function runScenario( { speed, fps, jitter } ) {

	const scenario = createScenario();
	const clock = new SimulationClock( {
		fixedStep: FIXED_STEP,
	} );
	const realDuration = SIMULATED_DURATION / speed;

	renderFrames( realDuration, fps, jitter, ( realDt ) => {

		clock.advance( realDt, speed, ( step ) => {

			scenario.bee.update( step, scenario.context );
			scenario.butterfly.update( step, scenario.context );
			scenario.chameleon.update( step, scenario.prey );

		} );

	} );

	assert.equal( clock.tick, EXPECTED_TICKS );
	assert.equal( clock.backlogUnits, 0n );
	return captureSnapshot( scenario, clock );

}

test( 'TIME-SCALE-ECO-001 reference scenario exercises foraging, lifecycles and predation', () => {

	const snapshot = runScenario( {
		speed: 1,
		fps: 60,
		jitter: false,
	} );
	const bee = snapshot.bee.telemetry;
	const butterfly = snapshot.butterfly.telemetry;
	const chameleon = snapshot.chameleon.telemetry;

	assert.ok( bee.tripsStarted > 0 );
	assert.ok( bee.tripsCompleted > 0 );
	assert.ok( bee.flowerVisits > 0 );
	assert.ok( bee.demography.cohortAdvances > 0 );
	assert.ok( butterfly.flowerVisits > 0 );
	assert.ok( butterfly.eggHatches > 0 );
	assert.ok( butterfly.larvaePupated > 0 );
	assert.ok( butterfly.adultsEmerged > 0 );
	assert.ok( butterfly.cyclesCompleted > 0 );
	assert.ok( butterfly.predated > 0 );
	assert.ok( chameleon.contacts > 0 );
	assert.ok( chameleon.captures > 0 );
	assert.ok( chameleon.consumed > 0 );

} );

test( 'TIME-SCALE-ECO-002 x1/x4/x15/x22/x100 are bit-identical across FPS and jitter', () => {

	const baseline = runScenario( {
		speed: 1,
		fps: 60,
		jitter: false,
	} );

	for ( const speed of SPEEDS ) {

		for ( const fps of FRAME_RATES ) {

			for ( const jitter of [ false, true ] ) {

				const label = `x${ speed }, ${ fps } FPS, jitter=${ jitter }`;
				const actual = runScenario( {
					speed,
					fps,
					jitter,
				} );
				assert.deepEqual( actual, baseline, label );

			}

		}

	}

} );
