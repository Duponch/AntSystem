import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	attachCorridorSurfaceCompilation,
	buildCorridorNetwork,
	buildCorridorNetworkAsync,
	validateNetwork,
} from '../src/navigation/corridor-network.js';
import {
	compileCorridorSurfacePartition,
	createCorridorSurfacePartitionInput,
	mergeCorridorSurfacePartitions,
	partitionCorridorIds,
	surfacePartitionTransferList,
} from '../src/navigation/corridor-surface-partition.js';
import { makeIrregularNest, makeLinearNest } from './helpers/corridor-fixtures.js';

const OPTIONS = {
	samples: 16,
	texel: 0.25,
	maxNodes: 32,
};

function assertBitIdentical( actual, expected, label ) {

	assert.equal( actual.byteLength, expected.byteLength, `${ label } byte length` );
	assert.equal(
		Buffer.compare(
			Buffer.from( actual.buffer, actual.byteOffset, actual.byteLength ),
			Buffer.from( expected.buffer, expected.byteOffset, expected.byteLength ),
		),
		0,
		`${ label } must be bit-identical`,
	);

}

describe( 'parallel corridor surface bake', () => {

	test( '[NAV-SURFACE-PAR-001] partitions and merges every corridor bit-identically to the synchronous bake', () => {

		const nest = makeIrregularNest();
		const synchronous = buildCorridorNetwork( nest, OPTIONS );
		const parallel = buildCorridorNetwork( nest, { ...OPTIONS, deferSurface: true } );
		const partitions = partitionCorridorIds( parallel.corridors, 3 );

		assert.equal( partitions.length, 3 );
		assert.deepEqual(
			partitions.flat().sort( ( a, b ) => a - b ),
			parallel.corridors.filter( Boolean ).map( ( corridor ) => corridor.id ),
		);
		assert.ok( Math.max( ...partitions.map( ( part ) => part.length ) )
			- Math.min( ...partitions.map( ( part ) => part.length ) ) <= 1 );

		const results = partitions.map( ( ids ) => compileCorridorSurfacePartition(
			createCorridorSurfacePartitionInput( {
				nest,
				corridors: parallel.corridors,
				samples: parallel.samples,
				texel: parallel.texel,
				maxNodes: parallel.maxNodes,
				tracks: parallel.surfaceTracks,
				endpointFade: 0.35,
				tunnelRadiusScale: 0.85,
			}, ids ),
		) );
		const transferBuffers = results.flatMap( surfacePartitionTransferList );
		assert.equal( new Set( transferBuffers ).size, transferBuffers.length,
			'each worker result buffer is transferred exactly once' );

		attachCorridorSurfaceCompilation( parallel, mergeCorridorSurfacePartitions( {
			corridors: parallel.corridors,
			samples: parallel.samples,
			maxNodes: parallel.maxNodes,
			tracks: parallel.surfaceTracks,
			texel: parallel.texel,
		}, results ) );

		assertBitIdentical( parallel.surfaceData, synchronous.surfaceData, 'positions' );
		assertBitIdentical(
			parallel.surfaceSupportData,
			synchronous.surfaceSupportData,
			'supports',
		);
		assert.equal( parallel.maxLaneStretch, synchronous.maxLaneStretch );

		for ( const corridor of parallel.corridors ) {

			if ( ! corridor ) continue;
			const expected = synchronous.corridors[ corridor.id ];
			assertBitIdentical( corridor.surfaceTracks, expected.surfaceTracks,
				`corridor ${ corridor.id } positions` );
			assertBitIdentical( corridor.surfaceSupports, expected.surfaceSupports,
				`corridor ${ corridor.id } supports` );
			assertBitIdentical( corridor.surfaceLengths, expected.surfaceLengths,
				`corridor ${ corridor.id } lengths` );
			assert.equal( corridor.maxSurfaceStretch, expected.maxSurfaceStretch );
			assert.equal( corridor.maxLaneStretch, expected.maxLaneStretch );

		}
		const verdict = validateNetwork( parallel );
		assert.equal( verdict.ok, true, verdict.errors.join( '\n' ) );

	} );

	test( '[NAV-SURFACE-PAR-002] uses the exact synchronous fallback when Worker is unavailable', async () => {

		const nest = makeLinearNest( 1 );
		const expected = buildCorridorNetwork( nest, OPTIONS );
		const actual = await buildCorridorNetworkAsync( nest, OPTIONS );

		assert.equal( actual.surfaceBake.mode, 'sync' );
		assert.equal( actual.surfaceBake.workerCount, 0 );
		assert.equal( actual.surfaceBake.fallbackReason, 'worker-unavailable' );
		assertBitIdentical( actual.surfaceData, expected.surfaceData, 'fallback positions' );
		assertBitIdentical(
			actual.surfaceSupportData,
			expected.surfaceSupportData,
			'fallback supports',
		);

	} );

	test( '[NAV-SURFACE-PAR-003] terminates failed workers and falls back only for infrastructure errors', async () => {

		const nest = makeLinearNest( 1 );
		let created = 0;
		let terminated = 0;
		class InfrastructureFailureWorker {

			constructor() { created ++; }
			postMessage() { throw new Error( 'structured-clone transport failed' ); }
			terminate() { terminated ++; }

		}

		const actual = await buildCorridorNetworkAsync( nest, {
			...OPTIONS,
			maxSurfaceWorkers: 2,
			surfaceWorkerFactory: () => new InfrastructureFailureWorker(),
		} );
		assert.equal( actual.surfaceBake.mode, 'sync-fallback' );
		assert.match( actual.surfaceBake.fallbackReason, /transport failed/ );
		assert.equal( created, 2 );
		assert.equal( terminated, created );
		assert.equal( validateNetwork( actual ).ok, true );

	} );

	test( '[NAV-SURFACE-PAR-004] surfaces deterministic compiler errors and still terminates every worker', async () => {

		const nest = makeLinearNest( 1 );
		let created = 0;
		let terminated = 0;
		class DeterministicFailureWorker {

			constructor() { created ++; }
			postMessage( { jobId } ) {

				queueMicrotask( () => this.onmessage( {
					data: {
						jobId,
						ok: false,
						error: {
							kind: 'compile',
							name: 'Error',
							message: 'surface projection sentinel',
						},
					},
				} ) );

			}
			terminate() { terminated ++; }

		}

		await assert.rejects(
			buildCorridorNetworkAsync( nest, {
				...OPTIONS,
				maxSurfaceWorkers: 2,
				surfaceWorkerFactory: () => new DeterministicFailureWorker(),
			} ),
			/surface projection sentinel/,
		);
		assert.equal( created, 2 );
		assert.equal( terminated, created );

	} );

} );
