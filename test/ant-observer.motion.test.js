import test from 'node:test';
import assert from 'node:assert/strict';

import { createAntMotionTracker } from '../src/ant-observer.js';

function point( x, y = 0, z = 0 ) {

	return { x, y, z };

}

test( 'stationary duration accumulates through harmless positional jitter', () => {

	const tracker = createAntMotionTracker( { movingSpeed: 0.08 } );
	tracker.sample( { id: 8, timeMs: 0, position: point( 0 ) } );
	tracker.sample( { id: 8, timeMs: 1000, position: point( 0.01 ) } );
	const result = tracker.sample( { id: 8, timeMs: 3000, position: point( 0.015 ) } );

	assert.equal( result.moving, false );
	assert.equal( result.stationarySeconds, 3 );
	assert.ok( result.measuredSpeed < 0.08 );

} );

test( 'meaningful movement resets the immobility clock', () => {

	const tracker = createAntMotionTracker( { movingSpeed: 0.08 } );
	tracker.sample( { id: 9, timeMs: 0, position: point( 0 ) } );
	tracker.sample( { id: 9, timeMs: 2000, position: point( 0 ) } );
	const moving = tracker.sample( { id: 9, timeMs: 2500, position: point( 0.5 ) } );
	const stoppedAgain = tracker.sample( { id: 9, timeMs: 3500, position: point( 0.5 ) } );

	assert.equal( moving.moving, true );
	assert.equal( moving.stationarySeconds, 0 );
	assert.equal( stoppedAgain.stationarySeconds, 1 );

} );

test( 'global pause time is excluded from immobility duration', () => {

	const tracker = createAntMotionTracker( { movingSpeed: 0.08 } );
	tracker.sample( { id: 10, timeMs: 0, position: point( 0 ) } );
	tracker.sample( { id: 10, timeMs: 1000, position: point( 0 ) } );
	const paused = tracker.sample( { id: 10, timeMs: 6000, position: point( 0 ), paused: true } );
	tracker.sample( { id: 10, timeMs: 8000, position: point( 0 ), paused: true } );
	const resumed = tracker.sample( { id: 10, timeMs: 9000, position: point( 0 ) } );

	assert.equal( paused.stationarySeconds, 1 );
	assert.equal( resumed.stationarySeconds, 2 );

} );

test( 'changing the selected ant cannot inherit another ant immobility', () => {

	const tracker = createAntMotionTracker();
	tracker.sample( { id: 10, timeMs: 0, position: point( 0 ) } );
	tracker.sample( { id: 10, timeMs: 5000, position: point( 0 ) } );
	const result = tracker.sample( { id: 11, timeMs: 6000, position: point( 20 ) } );

	assert.equal( result.stationarySeconds, 0 );
	assert.equal( result.measuredSpeed, 0 );

} );

test( 'non-monotonic timestamps are ignored safely', () => {

	const tracker = createAntMotionTracker();
	tracker.sample( { id: 12, timeMs: 1000, position: point( 0 ) } );
	const result = tracker.sample( { id: 12, timeMs: 900, position: point( 5 ) } );

	assert.equal( result.stationarySeconds, 0 );
	assert.equal( result.measuredSpeed, 0 );

} );

test( 'reset clears all temporal state', () => {

	const tracker = createAntMotionTracker();
	tracker.sample( { id: 13, timeMs: 0, position: point( 0 ) } );
	tracker.sample( { id: 13, timeMs: 4000, position: point( 0 ) } );
	tracker.reset();
	const result = tracker.sample( { id: 13, timeMs: 5000, position: point( 0 ) } );

	assert.equal( result.stationarySeconds, 0 );

} );
