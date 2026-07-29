import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
	BEE_CLIP,
	BEE_STATE,
	BEE_STRATEGY,
	BeeSimulation,
	FLOWER_CANDIDATE_SAMPLES,
} from '../src/bee-simulation.js';

function createHive() {

	return {
		// x/y/z remain the backward-compatible interior fallback.
		x: 0,
		y: 1,
		z: 0,
		interiorX: 0,
		interiorY: 1,
		interiorZ: 0,
		entranceX: 0,
		entranceY: 1.08,
		entranceZ: 0.72,
		outsideX: 0,
		outsideY: 1.3,
		outsideZ: 1.42,
	};

}

function createFlowers( count, {
	nectar = 12,
	pollen = 8,
	patchModulo = 4,
	offsetZ = 5,
} = {} ) {

	const flowers = {
		count,
		x: new Float32Array( count ),
		y: new Float32Array( count ),
		z: new Float32Array( count ),
		contactX: new Float32Array( count ),
		contactY: new Float32Array( count ),
		contactZ: new Float32Array( count ),
		active: new Uint8Array( count ),
		patch: new Uint16Array( count ),
		quality: new Float32Array( count ),
		nectar: new Float32Array( count ),
		pollen: new Float32Array( count ),
	};
	for ( let i = 0; i < count; i ++ ) {

		const column = i % 16;
		const row = Math.floor( i / 16 );
		flowers.x[ i ] = 3 + column * 0.38;
		flowers.y[ i ] = 1.1 + ( i % 3 ) * 0.04;
		flowers.z[ i ] = offsetZ + row * 0.38;
		flowers.contactX[ i ] = flowers.x[ i ];
		flowers.contactY[ i ] = flowers.y[ i ] - 0.08;
		flowers.contactZ[ i ] = flowers.z[ i ];
		flowers.active[ i ] = 1;
		flowers.patch[ i ] = i % Math.max( 1, patchModulo );
		flowers.quality[ i ] = 0.72 + ( i % 5 ) * 0.05;
		flowers.nectar[ i ] = nectar;
		flowers.pollen[ i ] = pollen;

	}
	return flowers;

}

function createContext( flowers = createFlowers( 8 ) ) {

	return {
		daylight: 1,
		weather: {
			temperatureC: 24,
			rain: 0,
			windSpeed: 0.4,
		},
		hive: createHive(),
		demand: { nectar: 1, pollen: 0 },
		colony: {
			nutrition: 1,
			season: 1,
			layingMultiplier: 1,
		},
		flowers,
	};

}

function run( simulation, context, steps, dt ) {

	for ( let step = 0; step < steps; step ++ ) simulation.update( dt, context );

}

function sum( values ) {

	let total = 0;
	for ( let i = 0; i < values.length; i ++ ) total += values[ i ];
	return total;

}

function distanceTo( x, y, z, pointX, pointY, pointZ ) {

	return Math.hypot( x - pointX, y - pointY, z - pointZ );

}

test( 'BEE-ECO-001 bees cross the physical hive entrance in both directions without teleporting', () => {

	assert.equal( typeof BEE_STATE.HIVE_EXIT, 'number' );
	assert.equal( typeof BEE_STATE.HIVE_ENTRY, 'number' );

	const simulation = new BeeSimulation( {
		capacity: 1,
		initialCount: 1,
		seed: 0xec0101,
		durationScale: 0.05,
		forageDurationSeconds: 0.3,
		flightSpeed: 9,
		approachSpeed: 3.5,
		scoutRatio: 1,
	} );
	const context = createContext( createFlowers( 1, { nectar: 30, pollen: 0 } ) );
	simulation.orientationTrips[ 0 ] = 0;
	simulation.stateTime[ 0 ] = 0;
	simulation.energy[ 0 ] = 1;

	let previousX = simulation.x[ 0 ];
	let previousY = simulation.y[ 0 ];
	let previousZ = simulation.z[ 0 ];
	let maximumStep = 0;
	let exitEntranceDistance = Infinity;
	let entryEntranceDistance = Infinity;
	let observedExit = false;
	let observedEntry = false;
	let entryCompletedInside = false;

	for ( let step = 0; step < 14000; step ++ ) {

		simulation.update( 0.01, context );
		const state = simulation.state[ 0 ];
		const delta = distanceTo(
			simulation.x[ 0 ],
			simulation.y[ 0 ],
			simulation.z[ 0 ],
			previousX,
			previousY,
			previousZ,
		);
		maximumStep = Math.max( maximumStep, delta );
		previousX = simulation.x[ 0 ];
		previousY = simulation.y[ 0 ];
		previousZ = simulation.z[ 0 ];

		if ( state === BEE_STATE.HIVE_EXIT ) {

			observedExit = true;
			assert.notEqual( simulation.clip[ 0 ], BEE_CLIP.HIDDEN, 'the bee must stay visible while leaving' );
			exitEntranceDistance = Math.min(
				exitEntranceDistance,
				distanceTo(
					simulation.x[ 0 ],
					simulation.y[ 0 ],
					simulation.z[ 0 ],
					context.hive.entranceX,
					context.hive.entranceY,
					context.hive.entranceZ,
				),
			);

		}
		if ( state === BEE_STATE.HIVE_ENTRY ) {

			observedEntry = true;
			assert.notEqual( simulation.clip[ 0 ], BEE_CLIP.HIDDEN, 'the bee must stay visible while entering' );
			entryEntranceDistance = Math.min(
				entryEntranceDistance,
				distanceTo(
					simulation.x[ 0 ],
					simulation.y[ 0 ],
					simulation.z[ 0 ],
					context.hive.entranceX,
					context.hive.entranceY,
					context.hive.entranceZ,
				),
			);

		} else if ( observedEntry && simulation.clip[ 0 ] === BEE_CLIP.HIDDEN ) {

			entryCompletedInside =
				distanceTo(
					simulation.x[ 0 ],
					simulation.y[ 0 ],
					simulation.z[ 0 ],
					context.hive.interiorX,
					context.hive.interiorY,
					context.hive.interiorZ,
				) < 0.08;
			if ( entryCompletedInside ) break;

		}

	}

	assert.equal( observedExit, true, 'the bee never used the hive exit state' );
	assert.equal( observedEntry, true, 'the bee never used the hive entry state' );
	assert.ok( exitEntranceDistance < 0.12, `exit missed entrance by ${ exitEntranceDistance }` );
	assert.ok( entryEntranceDistance < 0.12, `entry missed entrance by ${ entryEntranceDistance }` );
	assert.equal( entryCompletedInside, true, 'visibility must only end after reaching the hive interior' );
	assert.ok( maximumStep < 0.14, `spatial discontinuity of ${ maximumStep } world units` );

} );

test( 'BEE-ECO-002 scouts discover patches and bounded dance recruitment creates recruited trips', () => {

	const patchMemoryCapacity = 3;
	const simulation = new BeeSimulation( {
		capacity: 24,
		initialCount: 24,
		seed: 0xec0102,
		durationScale: 0.035,
		forageDurationSeconds: 0.24,
		flightSpeed: 11,
		approachSpeed: 4,
		scoutRatio: 0.25,
		patchMemoryCapacity,
	} );
	const context = createContext( createFlowers( 18, {
		nectar: 40,
		pollen: 12,
		patchModulo: 9,
	} ) );
	simulation.orientationTrips.fill( 0, 0, simulation.count );
	simulation.stateTime.fill( 0, 0, simulation.count );

	const views = simulation.getViews();
	assert.ok( views.strategy instanceof Uint8Array );
	let scouts = 0;
	let recruits = 0;
	for ( let i = 0; i < simulation.count; i ++ ) {

		if ( views.strategy[ i ] === BEE_STRATEGY.SCOUT ) scouts ++;
		if ( views.strategy[ i ] === BEE_STRATEGY.RECRUIT ) recruits ++;

	}
	assert.ok( scouts > 0 && recruits > 0, `expected both strategies, got ${ scouts }/${ recruits }` );

	run( simulation, context, 12000, 0.015 );

	const telemetry = simulation.getTelemetry();
	const colonyViews = simulation.getColonyViews();
	assert.ok( telemetry.scoutTrips > 0, 'no scout completed a discovery trip' );
	assert.ok( telemetry.danceEvents > 0, 'a profitable return should advertise a patch' );
	assert.ok( telemetry.recruitedTrips > 0, 'no recruit used advertised patch information' );
	assert.ok( telemetry.recruitedTrips <= telemetry.tripsStarted );
	assert.ok( telemetry.colony.knownPatches > 0 );
	assert.ok( telemetry.colony.knownPatches <= patchMemoryCapacity );
	assert.equal( colonyViews.patchId.length, patchMemoryCapacity );
	assert.equal( colonyViews.patchQuality.length, patchMemoryCapacity );
	assert.equal( colonyViews.patchStrength.length, patchMemoryCapacity );

} );

test( 'BEE-ECO-003 the colony cannot invent forage and finite flower stocks deplete without going negative', () => {

	const options = {
		capacity: 12,
		initialCount: 12,
		seed: 0xec0103,
		durationScale: 0.04,
		forageDurationSeconds: 0.2,
		flightSpeed: 12,
		approachSpeed: 4,
		scoutRatio: 0.5,
		biologicalDaysPerSecond: 0,
		initialRawNectar: 0,
		initialHoney: 0,
	};
	const barren = new BeeSimulation( options );
	const barrenContext = createContext( createFlowers( 0 ) );
	barren.orientationTrips.fill( 0, 0, barren.count );
	barren.stateTime.fill( 0, 0, barren.count );
	run( barren, barrenContext, 5000, 0.02 );

	assert.equal( barren.getTelemetry().deliveredNectar, 0 );
	assert.equal( barren.getTelemetry().deliveredPollen, 0 );
	assert.equal( barren.getTelemetry().colony.rawNectar, 0 );
	assert.equal( barren.getTelemetry().colony.honey, 0 );

	const finite = new BeeSimulation( options );
	const finiteFlowers = createFlowers( 2, { nectar: 2.5, pollen: 0, patchModulo: 1 } );
	const finiteContext = createContext( finiteFlowers );
	finite.orientationTrips.fill( 0, 0, finite.count );
	finite.stateTime.fill( 0, 0, finite.count );
	const initialNectar = sum( finiteFlowers.nectar );
	run( finite, finiteContext, 14000, 0.015 );

	const remainingNectar = sum( finiteFlowers.nectar );
	const telemetry = finite.getTelemetry();
	assert.ok( remainingNectar < initialNectar, 'available flowers were never harvested' );
	assert.ok( telemetry.deliveredNectar > 0, 'harvested nectar never reached the hive' );
	assert.ok( telemetry.deliveredNectar <= initialNectar + 1e-5 );
	for ( let i = 0; i < finiteFlowers.count; i ++ ) {

		assert.ok( finiteFlowers.nectar[ i ] >= 0, `flower ${ i } has a negative nectar stock` );

	}

} );

test( 'BEE-ECO-004 honey maturation changes storage form while conserving sugar', () => {

	const simulation = new BeeSimulation( {
		capacity: 1,
		initialCount: 0,
		seed: 0xec0104,
		biologicalDaysPerSecond: 0,
		initialRawNectar: 10,
		initialHoney: 2,
		honeyMaturationSeconds: 1.5,
	} );
	const context = createContext( createFlowers( 0 ) );
	const colony = simulation.getTelemetry().colony;
	const stableColonyTelemetry = colony;
	const initialSugar = colony.rawNectar + colony.honey + colony.consumedSugar;

	run( simulation, context, 240, 0.05 );

	assert.equal( simulation.getTelemetry().colony, stableColonyTelemetry );
	assert.ok( colony.rawNectar < 10, 'raw nectar was not matured' );
	assert.ok( colony.honey > 2, 'maturation did not create honey' );
	assert.ok(
		Math.abs( colony.rawNectar + colony.honey + colony.consumedSugar - initialSugar ) < 1e-6,
		'sugar changed while only water should be removed during maturation',
	);

} );

test( 'BEE-ECO-005 harvested sugar is conserved across flowers, flight, raw nectar and honey', () => {

	const flowers = createFlowers( 1, { nectar: 8, pollen: 0, patchModulo: 1 } );
	const context = createContext( flowers );
	const simulation = new BeeSimulation( {
		capacity: 8,
		initialCount: 8,
		seed: 0xec0105,
		durationScale: 0.035,
		forageDurationSeconds: 0.18,
		flightSpeed: 12,
		approachSpeed: 4,
		scoutRatio: 0.5,
		biologicalDaysPerSecond: 0,
		initialRawNectar: 0,
		initialHoney: 0,
		honeyMaturationSeconds: 0.8,
	} );
	simulation.orientationTrips.fill( 0, 0, simulation.count );
	simulation.stateTime.fill( 0, 0, simulation.count );
	const initialSugar = sum( flowers.nectar );

	run( simulation, context, 18000, 0.01 );

	const colony = simulation.getTelemetry().colony;
	const accountedSugar =
		sum( flowers.nectar ) +
		colony.rawNectar +
		colony.honey +
		colony.sugarInTransit +
		colony.consumedSugar;
	assert.ok(
		Math.abs( accountedSugar - initialSugar ) < 2e-4,
		`unaccounted sugar: expected ${ initialSugar }, got ${ accountedSugar }`,
	);
	assert.ok( colony.honey > 0, 'nectar delivery never became honey' );

} );

test( 'BEE-ECO-006 free flight accelerates smoothly and follows curved, non-robotic trajectories', () => {

	const simulation = new BeeSimulation( {
		capacity: 1,
		initialCount: 1,
		seed: 0xec0106,
		durationScale: 0.06,
		forageDurationSeconds: 0.3,
		flightSpeed: 8,
		approachSpeed: 3,
		flightAcceleration: 18,
		turnRate: 4.5,
		scoutRatio: 1,
	} );
	const context = createContext( createFlowers( 1, {
		nectar: 30,
		pollen: 0,
		offsetZ: 14,
	} ) );
	simulation.orientationTrips[ 0 ] = 0;
	simulation.stateTime[ 0 ] = 0;
	simulation.energy[ 0 ] = 1;

	const views = simulation.getViews();
	assert.ok( views.velocityX instanceof Float32Array );
	assert.ok( views.velocityY instanceof Float32Array );
	assert.ok( views.velocityZ instanceof Float32Array );

	let previousX = simulation.x[ 0 ];
	let previousY = simulation.y[ 0 ];
	let previousZ = simulation.z[ 0 ];
	let previousVelocityX = 0;
	let previousVelocityY = 0;
	let previousVelocityZ = 0;
	let minimumMovingSpeed = Infinity;
	let maximumSpeed = 0;
	let maximumStep = 0;
	let accelerationSamples = 0;
	let curvedSamples = 0;
	let flightSamples = 0;

	for ( let step = 0; step < 8000; step ++ ) {

		simulation.update( 0.01, context );
		const state = simulation.state[ 0 ];
		const freeFlight =
			state === BEE_STATE.HIVE_EXIT ||
			state === BEE_STATE.SCOUT_SEARCH ||
			state === BEE_STATE.OUTBOUND ||
			state === BEE_STATE.PATCH_SEARCH ||
			state === BEE_STATE.HIVE_APPROACH;
		const positionStep = distanceTo(
			simulation.x[ 0 ],
			simulation.y[ 0 ],
			simulation.z[ 0 ],
			previousX,
			previousY,
			previousZ,
		);
		maximumStep = Math.max( maximumStep, positionStep );
		previousX = simulation.x[ 0 ];
		previousY = simulation.y[ 0 ];
		previousZ = simulation.z[ 0 ];

		if ( ! freeFlight ) {

			previousVelocityX = views.velocityX[ 0 ];
			previousVelocityY = views.velocityY[ 0 ];
			previousVelocityZ = views.velocityZ[ 0 ];
			continue;

		}

		const velocityX = views.velocityX[ 0 ];
		const velocityY = views.velocityY[ 0 ];
		const velocityZ = views.velocityZ[ 0 ];
		const speed = Math.hypot( velocityX, velocityY, velocityZ );
		if ( speed > 0.05 ) {

			minimumMovingSpeed = Math.min( minimumMovingSpeed, speed );
			maximumSpeed = Math.max( maximumSpeed, speed );
			flightSamples ++;

		}
		const previousSpeed = Math.hypot( previousVelocityX, previousVelocityY, previousVelocityZ );
		const acceleration = Math.hypot(
			velocityX - previousVelocityX,
			velocityY - previousVelocityY,
			velocityZ - previousVelocityZ,
		) / 0.01;
		if ( acceleration > 0.05 ) accelerationSamples ++;
		if ( speed > 0.25 && previousSpeed > 0.25 ) {

			const cosine = (
				velocityX * previousVelocityX +
				velocityY * previousVelocityY +
				velocityZ * previousVelocityZ
			) / ( speed * previousSpeed );
			if ( cosine < 0.99999 ) curvedSamples ++;

		}
		previousVelocityX = velocityX;
		previousVelocityY = velocityY;
		previousVelocityZ = velocityZ;

	}

	assert.ok( flightSamples > 100, `only ${ flightSamples } free-flight samples` );
	assert.ok( accelerationSamples > 20, 'velocity stayed constant like a linear tween' );
	assert.ok( curvedSamples > 20, 'flight remained an exact straight line' );
	assert.ok( minimumMovingSpeed < maximumSpeed * 0.9, 'flight did not accelerate or decelerate' );
	assert.ok( maximumSpeed <= simulation.flightSpeed * 1.08 );
	assert.ok( maximumStep <= simulation.flightSpeed * 0.01 * 1.18 + 1e-4, `step ${ maximumStep } is a teleport` );

} );

test( 'BEE-ECO-007 colony memory and flower selection keep fixed storage and bounded hot-loop work', async () => {

	const options = {
		capacity: 32,
		initialCount: 32,
		seed: 0xec0107,
		scoutRatio: 0.5,
		patchMemoryCapacity: 7,
	};
	const small = new BeeSimulation( options );
	const large = new BeeSimulation( options );
	const smallFlowers = createFlowers( 8, { patchModulo: 8 } );
	const largeFlowers = createFlowers( 32768, { patchModulo: 1024 } );
	const smallViews = small.getViews();
	const largeViews = large.getViews();
	const smallColonyViews = small.getColonyViews();
	const largeColonyViews = large.getColonyViews();
	const smallTelemetry = small.getTelemetry();
	const largeTelemetry = large.getTelemetry();

	for ( let i = 0; i < small.count; i ++ ) {

		small._assignFlower( i, smallFlowers );
		large._assignFlower( i, largeFlowers );

	}

	assert.equal( small.getViews(), smallViews );
	assert.equal( large.getViews(), largeViews );
	assert.equal( small.getColonyViews(), smallColonyViews );
	assert.equal( large.getColonyViews(), largeColonyViews );
	assert.equal( small.getTelemetry(), smallTelemetry );
	assert.equal( large.getTelemetry(), largeTelemetry );
	assert.equal( smallColonyViews.patchId.length, options.patchMemoryCapacity );
	assert.equal( largeColonyViews.patchId.length, options.patchMemoryCapacity );
	assert.equal( smallTelemetry.candidateEvaluations, largeTelemetry.candidateEvaluations );
	assert.ok(
		smallTelemetry.candidateEvaluations <= small.count * FLOWER_CANDIDATE_SAMPLES,
		'flower selection exceeded its fixed candidate budget',
	);

	const source = await readFile( new URL( '../src/bee-simulation.js', import.meta.url ), 'utf8' );
	const updateStart = source.indexOf( '\n\tupdate( dt, context ) {' );
	const updateEnd = source.indexOf( '\n\twriteDebugRecord', updateStart );
	const updateBody = source.slice( updateStart, updateEnd );
	assert.ok( updateStart >= 0 && updateEnd > updateStart, 'could not isolate BeeSimulation.update' );
	assert.doesNotMatch( source, /Math\.random/ );
	assert.doesNotMatch( updateBody, /\bnew\s+(?:Array|Object|Map|Set|Float|Uint|Int)/ );
	assert.doesNotMatch( updateBody, /\.(?:map|filter|reduce|slice|sort|splice)\(/ );

} );
