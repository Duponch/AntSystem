// CPU-side colony anchors derived from a published nest layout.

export const COLONY_TROUGH_NAMES = [ 'granary', 'queen', 'brood' ];

export function troughRenderDepth( layout, trough ) {

	if ( Number.isFinite( trough?.depth ) ) return trough.depth;
	if ( typeof layout?.depthAt !== 'function' )
		throw new Error( 'A trough needs either a depth or a layout depth sampler' );
	return layout.depthAt( trough.x, trough.y, trough.layer );

}

export function broodRenderAnchor( layout, point ) {

	const queen = layout?.troughs?.queen;
	const brood = layout?.troughs?.brood;
	if ( ! queen || ! brood ) throw new Error( 'Brood rendering needs queen and brood anchors' );
	const queenDistance2 = ( point.x - queen.x ) ** 2 + ( point.y - queen.y ) ** 2;
	const broodDistance2 = ( point.x - brood.x ) ** 2 + ( point.y - brood.y ) ** 2;
	return broodDistance2 <= queenDistance2 ? brood : queen;

}

export function broodRenderDepth( layout, point ) {

	return troughRenderDepth( layout, broodRenderAnchor( layout, point ) );

}

export function colonyTroughSnapshot( layout ) {

	return COLONY_TROUGH_NAMES.map( ( name ) => {

		const trough = layout?.troughs?.[ name ];
		if ( ! trough ) throw new Error( `Missing colony trough ${ name }` );
		return {
			name,
			x: trough.x,
			y: trough.y,
			depth: troughRenderDepth( layout, trough ),
			cell: trough.cell,
			layer: trough.layer,
		};

	} );

}
