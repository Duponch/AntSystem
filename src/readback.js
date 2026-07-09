// Verrou GLOBAL des readbacks GPU→CPU.
//
// `renderer.getArrayBufferAsync` n'est PAS sûr en concurrence : deux lectures
// qui se chevauchent corrompent leurs mappings (certaines rendent zéro).
// TOUT lecteur (échantillon de fourmis des araignées, stats de l'overlay,
// couvain de la colonie) doit passer par ce verrou unique — sémantique
// « je passe mon tour » : un poller qui trouve le verrou pris réessaiera à
// son prochain tick, ce qui borne la latence sans jamais empiler de lectures.

let busy = false;

export function tryAcquireReadback() {

	if ( busy ) return false;
	busy = true;
	return true;

}

export function releaseReadback() {

	busy = false;

}
