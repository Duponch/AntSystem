import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createNestCommitPause } from '../src/nest-mutation-ui.js';

describe( 'nest UI commit pause scope', () => {

	test( '[NAV-NEST-PAUSE-001] worker preparation stays live and the commit hook pauses exactly once', async () => {

		let paused = false;
		let synchronizeCalls = 0;
		let commits = 0;
		let releaseWorker;
		const workerGate = new Promise( ( resolve ) => { releaseWorker = resolve; } );
		const commitPause = createNestCommitPause( {
			isPaused: () => paused,
			setPaused: ( value ) => { paused = value; },
			synchronize: async () => { synchronizeCalls ++; },
		} );

		const transaction = ( async () => {

			await workerGate;
			await commitPause.beforeCommit();
			commits ++;

		} )();
		await Promise.resolve();
		assert.equal( paused, false, 'simulation remains live during worker bake' );
		assert.equal( synchronizeCalls, 0 );
		assert.equal( commits, 0 );

		releaseWorker();
		await transaction;
		assert.equal( paused, true, 'apply/reset window remains paused after commit' );
		assert.equal( synchronizeCalls, 1 );
		assert.equal( commits, 1 );
		assert.equal( commitPause.entered, true );
		commitPause.restore();
		assert.equal( paused, false );
		assert.equal( commitPause.restored, true );
		commitPause.restore();
		assert.equal( paused, false, 'restore is idempotent' );

	} );

	test( '[NAV-NEST-PAUSE-002] failed GPU synchronization restores the previous pause state', async () => {

		let paused = false;
		const commitPause = createNestCommitPause( {
			isPaused: () => paused,
			setPaused: ( value ) => { paused = value; },
			synchronize: async () => { throw new Error( 'GPU fence failed' ); },
		} );
		await assert.rejects( commitPause.beforeCommit(), /GPU fence failed/ );
		assert.equal( paused, false );
		assert.equal( commitPause.restored, true );

	} );

} );
