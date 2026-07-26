import {
	compileCorridorSurfacePartition,
	createCorridorSurfacePartitionInput,
	mergeCorridorSurfacePartitions,
	partitionCorridorIds,
} from './corridor-surface-partition.js';

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_TIMEOUT_MS = 120_000;

function availableWorkerCount( maxWorkers ) {

	const concurrency = globalThis.navigator?.hardwareConcurrency;
	const useful = Number.isFinite( concurrency ) ? Math.max( 2, concurrency - 1 ) : 4;
	return Math.max( 1, Math.min( DEFAULT_MAX_WORKERS, maxWorkers, useful ) );

}

function defaultWorkerFactory() {

	return new Worker(
		new URL( './corridor-surface.worker.js', import.meta.url ),
		{ type: 'module', name: 'antsystem-surface-bake' },
	);

}

function runWorker( worker, jobId, input, timeoutMs ) {

	return new Promise( ( resolve, reject ) => {

		let settled = false;
		const finish = ( callback, value ) => {

			if ( settled ) return;
			settled = true;
			clearTimeout( timeout );
			callback( value );

		};
		const timeout = setTimeout( () => finish( reject,
			new Error( `Surface worker ${ jobId } timed out after ${ timeoutMs } ms` ) ), timeoutMs );
		worker.surfaceBakeCancel = () => finish( reject,
			new Error( `Surface worker ${ jobId } was cancelled` ) );
		worker.onmessage = ( event ) => {

			const message = event.data ?? {};
			if ( message.jobId !== jobId ) return;
			if ( message.ok ) finish( resolve, message.result );
			else {

				const error = new Error(
					message.error?.message ?? `Surface worker ${ jobId } failed` );
				error.name = message.error?.name ?? 'Error';
				if ( message.error?.stack ) error.stack = message.error.stack;
				error.deterministic = message.error?.kind === 'compile';
				finish( reject, error );

			}

		};
		worker.onerror = ( event ) => finish( reject,
			new Error( event?.message ?? `Surface worker ${ jobId } crashed` ) );
		worker.onmessageerror = () => finish( reject,
			new Error( `Surface worker ${ jobId } returned an unreadable message` ) );
		try {

			worker.postMessage( { jobId, input } );

		} catch ( error ) {

			finish( reject, error );

		}

	} );

}

function terminateWorkers( workers ) {

	while ( workers.length > 0 ) {

		const worker = workers.pop();
		try { worker.surfaceBakeCancel?.(); } catch { /* cancellation is best effort */ }
		try { worker.terminate(); } catch { /* already terminated */ }

	}

}

function syncCompilation( input, partitions ) {

	return mergeCorridorSurfacePartitions( input,
		partitions.map( ( corridorIds ) => compileCorridorSurfacePartition(
			createCorridorSurfacePartitionInput( input, corridorIds ),
		) ) );

}

export async function compileCorridorSurfaceTracksParallel( input, {
	maxWorkers = DEFAULT_MAX_WORKERS,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	workerFactory,
} = {} ) {

	const start = performance.now();
	const workerCount = availableWorkerCount( maxWorkers );
	const partitions = partitionCorridorIds( input.corridors, workerCount );
	const canUseWorkers = partitions.length >= 2
		&& ( workerFactory !== undefined || typeof Worker !== 'undefined' );

	if ( ! canUseWorkers ) {

		const compilation = syncCompilation( input, partitions );
		return {
			...compilation,
			bake: {
				mode: 'sync',
				workerCount: 0,
				durationMs: performance.now() - start,
				fallbackReason: typeof Worker === 'undefined' ? 'worker-unavailable' : null,
			},
		};

	}

	const createWorker = workerFactory ?? defaultWorkerFactory;
	const workers = [];
	try {

		// Create the full pool before posting any job. If construction fails partway,
		// no orphan promise or timeout can survive the synchronous fallback.
		for ( let jobId = 0; jobId < partitions.length; jobId ++ )
			workers.push( createWorker( jobId ) );
		const jobs = partitions.map( ( corridorIds, jobId ) => {

			const partitionInput = createCorridorSurfacePartitionInput( input, corridorIds );
			return runWorker( workers[ jobId ], jobId, partitionInput, timeoutMs );

		} );
		const results = await Promise.all( jobs );
		return {
			...mergeCorridorSurfacePartitions( input, results ),
			bake: {
				mode: 'workers',
				workerCount: workers.length,
				durationMs: performance.now() - start,
				fallbackReason: null,
			},
		};

	} catch ( workerError ) {

		// A compiler error is deterministic geometry feedback, not an
		// infrastructure outage. Preserve it instead of hiding it behind a retry.
		if ( workerError?.deterministic ) throw workerError;
		// Stop healthy siblings before doing the synchronous retry; otherwise a
		// timeout/crash would briefly run both complete bakes at the same time.
		terminateWorkers( workers );
		const compilation = syncCompilation( input, partitions );
		return {
			...compilation,
			bake: {
				mode: 'sync-fallback',
				workerCount: 0,
				durationMs: performance.now() - start,
				fallbackReason: workerError?.message ?? String( workerError ),
			},
		};

	} finally {

		terminateWorkers( workers );

	}

}
