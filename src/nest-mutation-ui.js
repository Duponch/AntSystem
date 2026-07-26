// Pause scope used only around the short commit/apply/reset phase of a nest
// mutation. Candidate geometry may bake for seconds before this hook runs.

export function createNestCommitPause( {
	isPaused,
	setPaused,
	synchronize,
} ) {

	if ( typeof isPaused !== 'function'
		|| typeof setPaused !== 'function'
		|| typeof synchronize !== 'function' )
		throw new TypeError( 'Nest commit pause needs pause accessors and synchronize' );
	let previousPause;
	let entered = false;
	let restored = false;

	return {
		get entered() { return entered; },
		get restored() { return restored; },

		async beforeCommit() {

			if ( entered ) throw new Error( 'Nest commit pause hook ran more than once' );
			entered = true;
			previousPause = Boolean( isPaused() );
			setPaused( true );
			try {

				await synchronize();

			} catch ( error ) {

				setPaused( previousPause );
				restored = true;
				throw error;

			}

		},

		restore() {

			if ( ! entered || restored ) return;
			setPaused( previousPause );
			restored = true;

		},
	};

}
