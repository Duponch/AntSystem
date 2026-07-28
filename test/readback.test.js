import test from 'node:test';
import assert from 'node:assert/strict';

import {
	acquireReadback,
	releaseReadback,
	tryAcquireReadback,
	withReadback,
} from '../src/readback.js';

test( 'global readback mutex', async ( t ) => {

	await t.test( 'tryAcquireReadback remains non-blocking', () => {

		assert.equal( tryAcquireReadback(), true );
		assert.equal( tryAcquireReadback(), false );
		releaseReadback();
		assert.equal( tryAcquireReadback(), true );
		releaseReadback();

	} );

	await t.test( 'an awaited request has priority over opportunistic pollers', async () => {

		assert.equal( tryAcquireReadback(), true );

		let entered = false;
		const waiting = acquireReadback().then( () => {

			entered = true;

		} );

		assert.equal( tryAcquireReadback(), false );
		releaseReadback();

		// Ownership is transferred before the promise continuation runs: no
		// opportunistic caller can steal the lock in that microtask window.
		assert.equal( tryAcquireReadback(), false );
		await waiting;
		assert.equal( entered, true );
		releaseReadback();

	} );

	await t.test( 'awaited requests are served in strict FIFO order', async () => {

		assert.equal( tryAcquireReadback(), true );
		const order = [];
		const jobs = [ 1, 2, 3, 4 ].map( ( id ) => withReadback( async () => {

			order.push( id );
			await Promise.resolve();

		} ) );

		for ( let attempt = 0; attempt < 20; attempt ++ ) {

			assert.equal( tryAcquireReadback(), false );

		}

		releaseReadback();
		await Promise.all( jobs );
		assert.deepEqual( order, [ 1, 2, 3, 4 ] );

	} );

	await t.test( 'withReadback always releases after a rejection', async () => {

		await assert.rejects(
			withReadback( async () => {

				throw new Error( 'readback failed' );

			} ),
			/readback failed/,
		);

		assert.equal( tryAcquireReadback(), true );
		releaseReadback();

		await assert.rejects( withReadback( null ), TypeError );
		assert.equal( tryAcquireReadback(), true );
		releaseReadback();

	} );

} );
