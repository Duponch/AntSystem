// Verrou GLOBAL des readbacks GPU→CPU.
//
// `renderer.getArrayBufferAsync` n'est PAS sûr en concurrence : deux lectures
// qui se chevauchent corrompent leurs mappings (certaines rendent zéro).
// TOUT lecteur (échantillon de fourmis des araignées, stats de l'overlay,
// couvain de la colonie) doit passer par ce verrou unique — sémantique
// « je passe mon tour » : un poller qui trouve le verrou pris réessaiera à
// son prochain tick, ce qui borne la latence sans jamais empiler de lectures.

// Les pollers de diagnostic conservent cette semantique non bloquante. Les
// barrieres autoritaires utilisent, elles, la file FIFO awaitable ci-dessous :
// elles ne perdent aucun echantillon et sont prioritaires sur les pollers.

let busy = false;
const waiters = [];

function handOffToNextWaiter() {

	if ( busy || waiters.length === 0 ) return;

	// Le verrou reste logiquement pris pendant le transfert. Ainsi, un poller
	// opportuniste ne peut pas doubler une requete awaitable deja en attente.
	busy = true;
	const resolve = waiters.shift();
	resolve();

}

export function tryAcquireReadback() {

	// Les demandes awaitables sont prioritaires. Refuser egalement lorsqu'une
	// file existe garantit qu'un flux de pollers ne peut pas affamer la file FIFO.
	if ( busy || waiters.length > 0 ) return false;
	busy = true;
	return true;

}

export function acquireReadback() {

	return new Promise( ( resolve ) => {

		waiters.push( resolve );
		handOffToNextWaiter();

	} );

}

export async function withReadback( fn ) {

	if ( typeof fn !== 'function' ) throw new TypeError( 'withReadback attend une fonction' );

	await acquireReadback();

	try {

		return await fn();

	} finally {

		releaseReadback();

	}

}

export function releaseReadback() {

	busy = false;
	handOffToNextWaiter();

}
