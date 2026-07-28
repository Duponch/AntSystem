import assert from 'node:assert/strict';
import test from 'node:test';

import {
	DEFAULT_SIMULATION_STEP,
	SIMULATION_TIME_UNITS_PER_SECOND,
	SimulationClock,
	createSimulationClock,
} from '../src/simulation-clock.js';

function runFrames( clock, { duration, fps, speed, jitter = false }, stepFn = () => {} ) {

	if ( ! jitter ) {

		const count = Math.round( duration * fps );
		const dt = duration / count;
		for ( let frame = 0; frame < count; frame ++ ) clock.advance( dt, speed, stepFn );
		return;

	}

	const frameCount = Math.max( 2, Math.round( duration * fps ) );
	const base = duration / frameCount;
	let elapsed = 0;

	for ( let frame = 0; frame < frameCount; frame ++ ) {

		const wave = 0.35 + ( ( frame * 37 ) % 11 ) * 0.13;
		const remaining = duration - elapsed;
		const dt = frame === frameCount - 1 ?
			remaining :
			Math.min( remaining, base * wave );
		elapsed += dt;
		clock.advance( dt, speed, stepFn );

	}

}

test( 'SIM-CLOCK-001 defaults to a deterministic 60 Hz fixed step', () => {

	const clock = createSimulationClock();
	assert.equal( clock.fixedStep, DEFAULT_SIMULATION_STEP );
	assert.equal( clock.tick, 0 );
	assert.equal( clock.tickExact, 0n );
	assert.equal( clock.time, 0 );
	assert.equal( clock.backlog, 0 );
	assert.equal( clock.alpha, 0 );
	assert.equal( SIMULATION_TIME_UNITS_PER_SECOND % 60n, 0n );

} );

test( 'SIM-CLOCK-002 x1 at 240 FPS averages exactly 60 simulation ticks per second', () => {

	const clock = new SimulationClock();
	const samples = [];
	runFrames( clock, { duration: 10, fps: 240, speed: 1 }, ( dt, tick, time ) => {

		if ( tick <= 2 || tick >= 599 ) samples.push( { dt, tick, time } );

	} );

	assert.equal( clock.tick, 600 );
	assert.equal( clock.tickExact, 600n );
	assert.equal( clock.time, 10 );
	assert.equal( clock.backlogUnits, 0n );
	assert.equal( clock.alpha, 0 );
	assert.equal( samples[ 0 ].dt, 1 / 60 );
	assert.deepEqual( samples.map( ( sample ) => sample.tick ), [ 1, 2, 599, 600 ] );
	assert.equal( samples.at( - 1 ).time, 10 );

} );

test( 'SIM-CLOCK-003 speeds x1/x4/x15/x22/x100 are invariant across 30/60/144/240 FPS', () => {

	const speeds = [ 1, 4, 15, 22, 100 ];
	const frameRates = [ 30, 60, 144, 240 ];
	const duration = 2;

	for ( const speed of speeds ) {

		const expected = duration * speed * 60;
		for ( const fps of frameRates ) {

			const clock = new SimulationClock();
			runFrames( clock, { duration, fps, speed } );
			assert.equal( clock.tick, expected, `x${ speed } at ${ fps } FPS` );
			assert.equal( clock.time, duration * speed, `time x${ speed } at ${ fps } FPS` );
			assert.equal( clock.backlogUnits, 0n, `backlog x${ speed } at ${ fps } FPS` );

		}

	}

} );

test( 'SIM-CLOCK-004 equal simulated durations produce equal ticks with regular or jittered frames', () => {

	const cases = [
		{ speed: 1, duration: 22 },
		{ speed: 4, duration: 5.5 },
		{ speed: 15, duration: 22 / 15 },
		{ speed: 22, duration: 1 },
		{ speed: 100, duration: 0.22 },
	];

	for ( const options of cases ) {

		for ( const fps of [ 30, 60, 144, 240 ] ) {

			for ( const jitter of [ false, true ] ) {

				const clock = new SimulationClock();
				runFrames( clock, { ...options, fps, jitter } );
				assert.equal(
					clock.tick,
					1320,
					`x${ options.speed }, ${ fps } FPS, jitter=${ jitter }`,
				);

			}

		}

	}

} );

test( 'SIM-CLOCK-005 a finite step budget preserves debt until later advances', () => {

	const clock = new SimulationClock( { maxStepsPerAdvance: 3 } );
	const first = { ... clock.advance( 1, 1 ) };

	assert.equal( clock.tick, 3 );
	assert.equal( first.requested, 1 );
	assert.equal( first.effective, 0.05 );
	assert.equal( first.backlog, 0.95 );
	assert.equal( first.requestedSteps, 60 );
	assert.equal( first.effectiveSteps, 3 );
	assert.equal( first.backlogSteps, 57 );
	assert.equal( first.budgetLimited, true );
	assert.equal(
		first.requestedUnits,
		first.effectiveUnits + first.backlogUnits,
	);
	assert.equal( first.alpha, 1 );

	for ( let frame = 0; frame < 19; frame ++ ) clock.advance( 0, 1 );

	assert.equal( clock.tick, 60 );
	assert.equal( clock.time, 1 );
	assert.equal( clock.backlogUnits, 0n );
	assert.equal( clock.telemetry.requestedTotal, 1 );
	assert.equal( clock.telemetry.effectiveTotal, 1 );
	assert.equal( clock.telemetry.budgetLimited, false );

} );

test( 'SIM-CLOCK-006 speed zero is a pause and does not consume an existing debt', () => {

	const clock = new SimulationClock( { maxStepsPerAdvance: 2 } );
	clock.advance( 0.5, 1 );
	const backlog = clock.backlogUnits;
	const tick = clock.tickExact;
	const paused = clock.advance( 20, 0 );

	assert.equal( clock.tickExact, tick );
	assert.equal( clock.backlogUnits, backlog );
	assert.equal( paused.requested, 0 );
	assert.equal( paused.effective, 0 );
	assert.equal( paused.backlogUnits, backlog );

	clock.setMaxStepsPerAdvance( Number.POSITIVE_INFINITY );
	clock.advance( 0, 1 );
	assert.equal( clock.tick, 30 );
	assert.equal( clock.backlogUnits, 0n );

} );

test( 'SIM-CLOCK-007 integer accumulation avoids drift over long 240 FPS runs', () => {

	const clock = new SimulationClock();
	const seconds = 600;
	runFrames( clock, { duration: seconds, fps: 240, speed: 1 } );

	assert.equal( clock.tickExact, 36_000n );
	assert.equal( clock.timeUnits, BigInt( seconds ) * SIMULATION_TIME_UNITS_PER_SECOND );
	assert.equal( clock.time, seconds );
	assert.equal( clock.backlogUnits, 0n );

} );

test( 'SIM-CLOCK-008 configurable fixed steps preserve the same elapsed time', () => {

	const clock = new SimulationClock( { fixedStep: 1 / 120 } );
	runFrames( clock, { duration: 3, fps: 144, speed: 4 } );

	assert.equal( clock.fixedStep, 1 / 120 );
	assert.equal( clock.tick, 1440 );
	assert.equal( clock.time, 12 );
	assert.equal( clock.alpha, 0 );

} );

test( 'SIM-CLOCK-009 callback failure leaves the failed step in the backlog', () => {

	const clock = new SimulationClock();
	let calls = 0;

	assert.throws( () => {

		clock.advance( 0.1, 1, () => {

			calls ++;
			if ( calls === 3 ) throw new Error( 'sentinel' );

		} );

	}, /sentinel/ );

	assert.equal( calls, 3 );
	assert.equal( clock.tick, 2 );
	assert.equal( clock.backlogUnits, 4n * clock.timeUnits / 2n );

	clock.advance( 0, 1 );
	assert.equal( clock.tick, 6 );
	assert.equal( clock.backlogUnits, 0n );

} );

test( 'SIM-CLOCK-010 validates configuration and advance inputs', () => {

	assert.throws( () => new SimulationClock( { fixedStep: 0 } ), /fixedStep/ );
	assert.throws( () => new SimulationClock( { fixedStep: Number.NaN } ), /fixedStep/ );
	assert.throws( () => new SimulationClock( { maxStepsPerAdvance: - 1 } ), /maxStepsPerAdvance/ );
	assert.throws( () => new SimulationClock( { maxStepsPerAdvance: 1.5 } ), /maxStepsPerAdvance/ );

	const clock = new SimulationClock();
	assert.throws( () => clock.advance( - 1, 1 ), /realDt/ );
	assert.throws( () => clock.advance( 1, Number.POSITIVE_INFINITY ), /speed/ );
	assert.throws( () => clock.advance( 1, 1, null ), /stepFn/ );
	assert.throws( () => clock.setMaxStepsPerAdvance( - 2 ), /maxStepsPerAdvance/ );

} );

test( 'SIM-CLOCK-011 discarding interactive debt preserves strict tick history', () => {

	const clock = new SimulationClock( { maxStepsPerAdvance: 1 } );
	clock.advance( 0.2, 1 );
	const tick = clock.tick;
	const time = clock.time;
	assert.ok( clock.backlog > 0 );

	clock.discardBacklog();
	assert.equal( clock.backlog, 0 );
	assert.equal( clock.tick, tick );
	assert.equal( clock.time, time );

	clock.advance( 0, 1 );
	assert.equal( clock.tick, tick );

} );
