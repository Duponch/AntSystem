import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { AntSimulation } from '../src/simulation.js';

const EMPTY_STATS = {
	delivered: 0,
	picked: 0,
	eaten: 0,
	devoured: 0,
	laid: 0,
	hatched: 0,
	granary: 0,
	queenEnergy: 1,
};

function makeResettableSimulation() {

	const simulation = Object.create( AntSimulation.prototype );
	simulation._statsEpoch = 0;
	simulation.statsData = { ... EMPTY_STATS, delivered: 12 };
	simulation.cur = 1;
	simulation._clock = 3;
	simulation._tick = 8;
	simulation._regenSerial = 4;
	simulation.u = { tick: { value: 8 } };
	simulation._brushQueue = [ {} ];
	simulation._regenAccum = 2;
	simulation.init = async () => {};
	return simulation;

}

function deferredStatsRead( simulation ) {

	let resolve;
	let signalStarted;
	const started = new Promise( ( done ) => { signalStarted = done; } );
	simulation._readStatsFresh = () => {

		signalStarted();
		return new Promise( ( done ) => { resolve = done; } );

	};
	return {
		started,
		resolve( value ) {

			assert.equal( typeof resolve, 'function', 'stats read must have started' );
			resolve( value );

		},
	};

}

test( 'SIM-SYNC-001 synchronize submits a sentinel before the explicit GPU queue barrier', async () => {

	const order = [];
	const simulation = Object.create( AntSimulation.prototype );
	simulation.kSynchronize = { name: 'sentinel' };
	simulation.renderer = {
		async computeAsync( kernel ) {

			assert.strictEqual( kernel, simulation.kSynchronize );
			order.push( 'sentinel' );

		},
		backend: {
			device: {
				queue: {
					async onSubmittedWorkDone() {

						order.push( 'queue' );

					},
				},
			},
		},
	};

	await simulation.synchronize();
	assert.deepEqual( order, [ 'sentinel', 'queue' ] );

} );

test( 'SIM-SYNC-002 synchronize falls back to a locked sentinel readback without a public GPU queue', async () => {

	const order = [];
	const sentinel = {};
	const simulation = Object.create( AntSimulation.prototype );
	simulation.kSynchronize = {};
	simulation._syncSentinel = { value: sentinel };
	simulation.renderer = {
		async computeAsync() { order.push( 'sentinel' ); },
		async getArrayBufferAsync( attribute, target, offset, count ) {

			assert.strictEqual( attribute, sentinel );
			assert.equal( target, null );
			assert.equal( offset, 0 );
			assert.equal( count, 4 );
			order.push( 'readback' );
			return new ArrayBuffer( 4 );

		},
		backend: {},
	};

	await simulation.synchronize();
	assert.deepEqual( order, [ 'sentinel', 'readback' ] );

} );

test( 'SIM-SYNC-003 synchronize never uses a gameplay buffer as its sentinel', async () => {

	const source = await readFile( new URL( '../src/simulation.js', import.meta.url ), 'utf8' );
	const start = source.indexOf( '\n\tasync synchronize() {' );
	const end = source.indexOf( '\n\tapplyLayout() {', start );
	assert.ok( start >= 0 && end > start, 'synchronize source block must exist' );
	const block = source.slice( start, end );

	assert.match( source, /this\._syncSentinel\s*=\s*instancedArray\(\s*1,\s*['"]uint['"]\s*\)/u );
	assert.match( block, /computeAsync\(\s*this\.kSynchronize\s*\)/u );
	assert.match( block, /this\._syncSentinel\.value/u );
	assert.doesNotMatch( block, /kClearSpiderAlarm|spiderAlarm\.value/u );

} );

test( 'SIM-STATS-001 reset invalidates an opportunistic read already in flight', async () => {

	const simulation = makeResettableSimulation();
	const deferred = deferredStatsRead( simulation );
	const oldRun = { ... EMPTY_STATS, delivered: 99, laid: 7 };
	const read = simulation.readStats();
	await deferred.started;
	const reset = simulation.reset();
	deferred.resolve( oldRun );

	await reset;
	const published = await read;
	assert.equal( simulation._statsEpoch, 1 );
	assert.deepEqual( simulation.statsData, EMPTY_STATS );
	assert.strictEqual( published, simulation.statsData );

} );

test( 'SIM-STATS-002 authoritative reads retain their invocation epoch while waiting for the FIFO lock', async () => {

	const simulation = makeResettableSimulation();
	const deferred = deferredStatsRead( simulation );
	const oldRun = { ... EMPTY_STATS, picked: 41, hatched: 3 };
	const read = simulation.readStatsAuthoritative();
	const reset = simulation.reset();
	await deferred.started;
	deferred.resolve( oldRun );

	await reset;
	const published = await read;
	assert.equal( simulation._statsEpoch, 1 );
	assert.deepEqual( simulation.statsData, EMPTY_STATS );
	assert.strictEqual( published, simulation.statsData );

} );
