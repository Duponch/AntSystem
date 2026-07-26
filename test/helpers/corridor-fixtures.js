// Test geometry uses grid coordinates for X/Z but world units for depth and
// chamber half-axes. Keep enough room for the physical entrance throat and its
// curvature-safe elbow at the default TEXEL/tunnel widths.
const DEFAULT_ENTRY = { x: - 8, y: 0, depth: - 0.1, layer: 0, r: 3 };
const DEFAULT_SHAFT = { x: 0, y: 0, depth: - 3.25, layer: 0, r: 3 };

function parentNode( chamberIndex, parents ) {

	const parent = parents[ chamberIndex ];
	return parent < 0 ? 1 : parent + 2;

}

function buildAdjacency( nodeCount, parents ) {

	const adjacency = Array.from( { length: nodeCount }, () => [] );
	const connect = ( a, b ) => {

		adjacency[ a ].push( b );
		adjacency[ b ].push( a );

	};

	connect( 0, 1 );
	for ( let chamber = 0; chamber < parents.length; chamber ++ )
		connect( parentNode( chamber, parents ), chamber + 2 );

	return adjacency;

}

function buildNextHop( nodeCount, parents, goalNodes ) {

	const adjacency = buildAdjacency( nodeCount, parents );
	const width = goalNodes.length;
	const out = new Int32Array( nodeCount * width );

	for ( let goal = 0; goal < width; goal ++ ) {

		const target = goalNodes[ goal ];

		if ( goal === 0 || target < 0 || target >= nodeCount ) {

			for ( let node = 0; node < nodeCount; node ++ ) out[ node * width + goal ] = node;
			continue;

		}

		const next = new Int32Array( nodeCount ).fill( - 1 );
		const queue = [ target ];
		next[ target ] = target;

		for ( let head = 0; head < queue.length; head ++ ) {

			const current = queue[ head ];

			for ( const neighbour of adjacency[ current ] ) {

				if ( next[ neighbour ] !== - 1 ) continue;
				next[ neighbour ] = current;
				queue.push( neighbour );

			}

		}

		for ( let node = 0; node < nodeCount; node ++ )
			out[ node * width + goal ] = next[ node ] < 0 ? node : next[ node ];

	}

	return out;

}

function normalizeUnit( unit, index ) {

	return {
		k: index,
		x: unit.x,
		y: unit.y,
		depth: unit.depth,
		layer: unit.layer ?? Math.min( 3, index % 4 ),
		R: unit.R ?? unit.r ?? 4,
		r: unit.r ?? unit.R ?? 4,
		rwx: unit.rwx ?? 1.2,
		rwz: unit.rwz ?? 1.05,
		rh: unit.rh ?? 0.45,
		type: unit.type ?? 0,
	};

}

export function makeNest( {
	entry = DEFAULT_ENTRY,
	shaft = DEFAULT_SHAFT,
	units,
	parents,
	goals,
	tunnelW = 5,
} ) {

	if ( ! Array.isArray( units ) || units.length === 0 )
		throw new Error( 'A fixture needs at least one chamber' );
	if ( ! Array.isArray( parents ) || parents.length !== units.length )
		throw new Error( 'Fixture parents must match chamber count' );

	const normalizedUnits = units.map( normalizeUnit );
	const nodes = [
		{ ...entry },
		{ ...shaft },
		...normalizedUnits.map( ( unit ) => ( {
			x: unit.x,
			y: unit.y,
			depth: unit.depth,
			layer: unit.layer,
			r: unit.R,
		} ) ),
	];
	const goalNodes = goals ?? [ - 1, nodes.length - 1, 2, Math.min( 3, nodes.length - 1 ), 0 ];
	const nextHop = buildNextHop( nodes.length, parents, goalNodes );
	const edges = [ [ 0, 1 ] ];

	for ( let chamber = 0; chamber < parents.length; chamber ++ )
		edges.push( [ parentNode( chamber, parents ), chamber + 2 ] );

	return {
		nodes,
		edges,
		entry: { ...entry },
		shaft: { ...shaft },
		units: normalizedUnits,
		parents: parents.slice(),
		nextHop,
		GOAL_NODE: goalNodes.slice(),
		tunnelW,
	};

}

export function makeLinearNest( chamberCount = 5 ) {

	const units = [];
	const parents = [];

	for ( let i = 0; i < chamberCount; i ++ ) {

		units.push( {
			x: 12 * ( i + 1 ),
			y: 0,
			depth: - 3 - i * 1.25,
			layer: i % 4,
			R: 5,
		} );
		parents.push( i === 0 ? - 1 : i - 1 );

	}

	return makeNest( {
		units,
		parents,
		goals: [ - 1, chamberCount + 1, 2, Math.min( 3, chamberCount + 1 ), 0 ],
	} );

}

export function makeIrregularNest() {

	return makeNest( {
		entry: { x: - 10, y: 1, depth: - 0.15, layer: 0, r: 3 },
		shaft: { x: 0, y: 0, depth: - 3.25, layer: 0, r: 3 },
		units: [
			{ x: 13, y: 7, depth: - 4.2, layer: 0, R: 5.5 },
			{ x: 21, y: - 9, depth: - 8.8, layer: 1, R: 4.7 },
			{ x: 37, y: - 2, depth: - 12.5, layer: 2, R: 4.2 },
			{ x: 31, y: 18, depth: - 17.2, layer: 3, R: 3.8 },
			{ x: 49, y: 27, depth: - 22.6, layer: 3, R: 3.5 },
		],
		parents: [ - 1, 0, 1, 2, 3 ],
		goals: [ - 1, 6, 2, 4, 0 ],
		tunnelW: 6,
	} );

}

export function makeStackedCrossingNest() {

	// Les chambres 2 et 3 ont exactement la même projection X/Y, mais sont
	// deux branches distinctes et très éloignées en profondeur. Le seul chemin
	// topologique autorisé entre elles repasse par le puits (nœud 1).
	return makeNest( {
		units: [
			{ x: 18, y: 4, depth: - 5, layer: 1, R: 4 },
			{ x: 18, y: 4, depth: - 16, layer: 3, R: 4 },
			{ x: 34, y: 4, depth: - 7, layer: 1, R: 4 },
			{ x: 34, y: 4, depth: - 18, layer: 3, R: 4 },
		],
		parents: [ - 1, - 1, 0, 1 ],
		goals: [ - 1, 2, 3, 4, 0 ],
		tunnelW: 4.5,
	} );

}

export function makeDeepNest( depth = 200 ) {

	return makeNest( {
		units: [
			{ x: 25, y: 9, depth: - depth * 0.25, layer: 0, R: 5 },
			{ x: 52, y: - 13, depth: - depth * 0.50, layer: 1, R: 5 },
			{ x: 24, y: - 39, depth: - depth * 0.75, layer: 2, R: 4.5 },
			{ x: - 12, y: - 22, depth: - depth, layer: 3, R: 4 },
		],
		parents: [ - 1, 0, 1, 2 ],
		goals: [ - 1, 5, 2, 4, 0 ],
		tunnelW: 7,
	} );

}

export function makeChainNest( chamberCount ) {

	const units = [];
	const parents = [];

	for ( let i = 0; i < chamberCount; i ++ ) {

		const angle = i * 0.71;
		units.push( {
			x: i * 7 + Math.cos( angle ) * 3,
			y: Math.sin( angle ) * 11,
			depth: - 3 - i * 0.35,
			layer: i % 4,
			R: 4,
		} );
		parents.push( i === 0 ? - 1 : i - 1 );

	}

	return makeNest( {
		units,
		parents,
		goals: [ - 1, chamberCount + 1, 2, Math.min( chamberCount + 1, 3 ), 0 ],
		tunnelW: 5,
	} );

}

export function pointDistance3D( a, b, texel = 1 ) {

	return Math.hypot(
		b.x - a.x,
		b.y - a.y,
		( b.depth - a.depth ) / texel,
	);

}

export function assertFiniteSample( assert, sample ) {

	for ( const key of [
		'x', 'y', 'depth', 'centerX', 'centerY',
		'tangentX', 'tangentY', 'lane', 'laneWeight', 'clearance',
	] )
		assert.ok( Number.isFinite( sample[ key ] ), `${ key } must be finite` );

}
