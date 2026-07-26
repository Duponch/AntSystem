import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import {
	createNestMutationQueue,
} from '../src/navigation/nest-mutation-transaction.js';

describe( 'asynchronous nest mutation transactions', () => {

	test( '[NAV-NEST-TXN-001] serializes candidates and never overlaps their commit windows', async () => {

		const queue = createNestMutationQueue();
		const events = [];
		let releaseFirst;
		const firstGate = new Promise( ( resolve ) => { releaseFirst = resolve; } );
		let active = 0;
		let maxActive = 0;

		const first = queue.run( async () => {

			active ++;
			maxActive = Math.max( maxActive, active );
			events.push( 'first:prepare' );
			await firstGate;
			events.push( 'first:commit' );
			active --;
			return 1;

		} );
		const second = queue.run( async () => {

			active ++;
			maxActive = Math.max( maxActive, active );
			events.push( 'second:prepare' );
			events.push( 'second:commit' );
			active --;
			return 2;

		} );

		await Promise.resolve();
		assert.equal( queue.busy, true );
		assert.equal( queue.pending, 2 );
		assert.deepEqual( events, [ 'first:prepare' ] );
		assert.throws( () => queue.assertIdle( 'rebuild' ), /asynchronous nest transaction/ );
		releaseFirst();
		assert.deepEqual( await Promise.all( [ first, second ] ), [ 1, 2 ] );
		assert.deepEqual( events, [
			'first:prepare',
			'first:commit',
			'second:prepare',
			'second:commit',
		] );
		assert.equal( maxActive, 1 );
		assert.equal( queue.pending, 0 );
		assert.equal( queue.busy, false );

	} );

	test( '[NAV-NEST-TXN-002] rejects a failed candidate without publishing and keeps the queue usable', async () => {

		const queue = createNestMutationQueue();
		const published = [];
		const failed = queue.run( async () => {

			const candidate = 'invalid';
			await Promise.resolve();
			throw new Error( `candidate ${ candidate } rejected` );

		} );
		const succeeding = queue.run( async () => {

			const candidate = 'valid';
			await Promise.resolve();
			published.push( candidate );
			return candidate;

		} );

		await assert.rejects( failed, /candidate invalid rejected/ );
		assert.equal( await succeeding, 'valid' );
		assert.deepEqual( published, [ 'valid' ] );
		queue.assertIdle();

	} );

	test( '[NAV-NEST-TXN-003] production UI delegates growth and rebuilds to async layout transactions', async () => {

		const uiSource = await readFile( new URL( '../src/ui.js', import.meta.url ), 'utf8' );
		assert.match( uiSource, /await sim\.layout\.growToAsync\( target, \{/ );
		assert.match( uiSource, /await sim\.layout\.rebuildAsync\( \{/ );
		assert.match( uiSource, /beforeCommit: commitPause\.beforeCommit/ );
		assert.doesNotMatch( uiSource, /sim\.layout\.growTo\(/ );
		assert.doesNotMatch( uiSource, /sim\.layout\.rebuild\(/ );

	} );

} );
