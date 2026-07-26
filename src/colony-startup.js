// Politique pure de démarrage de la colonie.
//
// Le runtime GPU reproduit ce contrat sans stock supplémentaire par fourmi :
// une colonie vivante démarre comme une colonie déjà installée, dans ses
// chambres, puis les activités reprennent de manière échelonnée. Le mode
// surface historique reste explicite lorsque la colonie vivante est coupée.

export const STARTUP_MODE = Object.freeze( {
	ESTABLISHED: 'established',
	HATCHLING: 'hatchling',
	SURFACE_ONLY: 'surface-only',
} );

export const STARTUP_DELAY = Object.freeze( {
	ESTABLISHED_MIN: 0.75,
	ESTABLISHED_MAX: 9,
	HATCHLING_MIN: 1.5,
	HATCHLING_MAX: 6,
} );

function hash01( id, stream ) {

	let x = ( ( id >>> 0 ) ^ Math.imul( stream + 1, 0x9E3779B9 ) ) >>> 0;
	x ^= x >>> 16;
	x = Math.imul( x, 0x7FEB352D ) >>> 0;
	x ^= x >>> 15;
	x = Math.imul( x, 0x846CA68B ) >>> 0;
	x >>>= 0;
	x ^= x >>> 16;
	x >>>= 0;
	return x / 0x100000000;

}

function between( id, stream, min, max ) {

	return min + ( max - min ) * hash01( id, stream );

}

export function initialAntPlacement( {
	id,
	caste,
	mode,
	nodeCount,
	queenNode,
	broodNode,
} ) {

	if ( mode === STARTUP_MODE.SURFACE_ONLY )
		return { under: false, node: 0, goal: 0, activationDelay: 0 };

	if ( caste === 'queen' )
		return { under: true, node: queenNode, goal: 0, activationDelay: 0 };

	const hatchling = mode === STARTUP_MODE.HATCHLING;
	const activationDelay = hatchling
		? between( id, 0xB17, STARTUP_DELAY.HATCHLING_MIN, STARTUP_DELAY.HATCHLING_MAX )
		: between( id, 0xA11, STARTUP_DELAY.ESTABLISHED_MIN, STARTUP_DELAY.ESTABLISHED_MAX );

	if ( caste === 'nurse' )
		return { under: true, node: broodNode, goal: 1, activationDelay };

	if ( hatchling )
		return { under: true, node: broodNode, goal: 4, activationDelay };

	const firstChamber = nodeCount > 2 ? 2 : Math.max( 0, nodeCount - 1 );
	const chamberCount = Math.max( 1, nodeCount - firstChamber );
	const node = firstChamber + Math.min(
		chamberCount - 1,
		Math.floor( hash01( id, 0xC01 ) * chamberCount ),
	);

	return { under: true, node, goal: 4, activationDelay };

}
