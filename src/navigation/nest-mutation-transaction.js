// FIFO mutex for expensive nest mutations.
//
// A task prepares and validates a complete candidate before its short commit
// section. Failed tasks never poison the queue: the next requested mutation
// still runs, but no two candidates can observe or publish concurrently.

export function createNestMutationQueue() {

	let tail = Promise.resolve();
	let pending = 0;
	let sequence = 0;

	const queue = {
		get pending() { return pending; },
		get busy() { return pending > 0; },
		get sequence() { return sequence; },

		run( operation ) {

			if ( typeof operation !== 'function' )
				return Promise.reject( new TypeError( 'Nest mutation must be a function' ) );
			const id = ++ sequence;
			pending ++;
			const execute = () => operation( id );
			const transaction = tail.then( execute, execute )
				.finally( () => { pending --; } );
			tail = transaction.then(
				() => undefined,
				() => undefined,
			);
			return transaction;

		},

		assertIdle( operation = 'Synchronous nest mutation' ) {

			if ( pending > 0 )
				throw new Error( `${ operation } cannot run during an asynchronous nest transaction` );

		},
	};
	return queue;

}
