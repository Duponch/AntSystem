import {
	compileCorridorSurfacePartition,
	surfacePartitionTransferList,
} from './corridor-surface-partition.js';

self.onmessage = ( event ) => {

	const { jobId, input } = event.data ?? {};
	try {

		const result = compileCorridorSurfacePartition( input );
		self.postMessage( { jobId, ok: true, result }, surfacePartitionTransferList( result ) );

	} catch ( error ) {

		self.postMessage( {
			jobId,
			ok: false,
			error: {
				kind: 'compile',
				name: error?.name ?? 'Error',
				message: error?.message ?? String( error ),
				stack: error?.stack ?? '',
			},
		} );

	}

};
