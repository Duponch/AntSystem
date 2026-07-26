import assert from 'node:assert/strict';
import { test } from 'node:test';

import { params } from '../src/config.js';
import {
	buildNestLayout,
	buildNestLayoutAsync,
} from '../src/colony.js';
import {
	compileCorridorSurfacePartition,
} from '../src/navigation/corridor-surface-partition.js';
import { createNestCommitPause } from '../src/nest-mutation-ui.js';

function bytesEqual( actual, expected, label ) {

	assert.equal(
		Buffer.compare(
			Buffer.from( actual.buffer, actual.byteOffset, actual.byteLength ),
			Buffer.from( expected.buffer, expected.byteOffset, expected.byteLength ),
		),
		0,
		label,
	);

}

function assertEquivalent( actual, expected, stage ) {

	assert.equal( actual.K, expected.K, `${ stage } K` );
	assert.equal( actual.nodeCount, expected.nodeCount, `${ stage } nodes` );
	assert.deepEqual( actual.nodes, expected.nodes, `${ stage } topology` );
	bytesEqual( actual.field, expected.field, `${ stage } field` );
	bytesEqual(
		actual.navigation.surfaceData,
		expected.navigation.surfaceData,
		`${ stage } surface positions`,
	);
	bytesEqual(
		actual.navigation.surfaceSupportData,
		expected.navigation.surfaceSupportData,
		`${ stage } surface supports`,
	);
	bytesEqual(
		actual.navigation.nextHop,
		expected.navigation.nextHop,
		`${ stage } routes`,
	);

}

test(
	'[NAV-NEST-TXN-004] real layout async growth and rebuild publish exact serialized candidates',
	async () => {

		const saved = {
			antCount: params.antCount,
			nestScale: params.nestScale,
			nestDepth: params.nestDepth,
			nestTunnelW: params.nestTunnelW,
			paused: params.paused,
		};
		let workersCreated = 0;
		let workersTerminated = 0;
		let workerBarrier = null;
		let activeCommitPause = null;

		class ExactSurfaceWorker {

			constructor() { workersCreated ++; }

			postMessage( { jobId, input } ) {

				const compile = () => {

					try {

						const result = compileCorridorSurfacePartition( input );
						this.onmessage( { data: { jobId, ok: true, result } } );

					} catch ( error ) {

						this.onmessage( { data: {
							jobId,
							ok: false,
							error: {
								kind: 'compile',
								name: error.name,
								message: error.message,
							},
						} } );

					}

				};
				const barrier = workerBarrier;
				if ( barrier ) barrier.then( () => queueMicrotask( compile ) );
				else queueMicrotask( compile );

			}

			terminate() { workersTerminated ++; }

		}

		const workerOptions = {
			maxSurfaceWorkers: 2,
			surfaceWorkerFactory: () => new ExactSurfaceWorker(),
		};

		try {

			// Keep the integration fixture small: four chambers, then eight.
			params.antCount = 10;
			params.nestScale = 0.3;
			params.nestDepth = 19;
			params.nestTunnelW = 6;
			const synchronous = buildNestLayout();
			const asynchronous = await buildNestLayoutAsync( workerOptions );
			assertEquivalent( asynchronous, synchronous, 'initial' );

			let publications = 0;
			asynchronous.onPublished( () => { publications ++; } );
			let releaseWorkers;
			workerBarrier = new Promise( ( resolve ) => { releaseWorkers = resolve; } );
			params.paused = false;
			let synchronizeCalls = 0;
			activeCommitPause = createNestCommitPause( {
				isPaused: () => params.paused,
				setPaused: ( value ) => { params.paused = value; },
				synchronize: async () => { synchronizeCalls ++; },
			} );
			const firstGrowth = asynchronous.growToAsync( 8, {
				beforeCommit: activeCommitPause.beforeCommit,
			} );
			const duplicateGrowth = asynchronous.growToAsync( 8 );
			assert.equal( asynchronous.nestMutationPending, 2 );
			assert.equal( asynchronous.nestMutationBusy, true );
			await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
			assert.equal( params.paused, false, 'worker bake must not pause simulation' );
			assert.equal( synchronizeCalls, 0 );
			assert.equal( publications, 0 );
			assert.equal( asynchronous.K, 4 );
			releaseWorkers();
			workerBarrier = null;
			assert.deepEqual(
				await Promise.all( [ firstGrowth, duplicateGrowth ] ),
				[ true, false ],
			);
			assert.equal( params.paused, true, 'apply window remains paused' );
			assert.equal( synchronizeCalls, 1, 'commit hook runs exactly once' );
			activeCommitPause.restore();
			activeCommitPause = null;
			assert.equal( params.paused, false );
			assert.equal( synchronous.growTo( 8 ), true );
			assert.equal( publications, 1 );
			assert.equal( asynchronous.nestMutationPending, 0 );
			assertEquivalent( asynchronous, synchronous, 'growth' );
			assert.equal( asynchronous.navigation.surfaceBake.mode, 'workers' );

			// Full replacement: new depth and width, same eight-room budget.
			params.antCount = 100;
			params.nestScale = 1;
			params.nestDepth = 20;
			params.nestTunnelW = 7;
			synchronous.rebuild();
			assert.equal( await asynchronous.rebuildAsync(), true );
			assert.equal( publications, 2 );
			assert.equal( asynchronous.nestMutationPending, 0 );
			assert.equal( asynchronous.nestMutationBusy, false );
			assertEquivalent( asynchronous, synchronous, 'rebuild' );
			assert.equal( workersCreated, workersTerminated );
			assert.ok(
				workersCreated >= 6,
				'initial, growth and rebuild must all delegate to workers',
			);

		} finally {

			activeCommitPause?.restore();
			Object.assign( params, saved );

		}

	},
);
