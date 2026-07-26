// Navigation souterraine par corridors 3D.
//
// Le réseau est un squelette géométrique partagé : chaque arête du graphe du
// nid possède une courbe 3D ré-échantillonnée à abscisse curviligne constante.
// Une fourmi ne cherche jamais son chemin dans une grille et ne se projette
// jamais contre une paroi : elle avance sur une arête, puis franchit son nœud
// terminal. Le coût d'un pas est donc O(1), quelle que soit la taille du nid.

import { TEXEL } from '../config.js';
import { K_MAX, NODE_CHAMBER0, tunnelPath } from '../nest.js';

export const CORRIDOR_SAMPLES = 64;
export const ENTRY_EDGE_SEED = K_MAX + 0x51;
export const ENDPOINT_FADE = 0.12;

const EPS = 1e-9;

const clamp01 = ( value ) => Math.max( 0, Math.min( 1, value ) );

function pointDistance( a, b, texel ) {

	return Math.hypot( b.x - a.x, b.y - a.y, ( b.depth - a.depth ) / texel );

}

function lerpPoint( a, b, t ) {

	return {
		x: a.x + ( b.x - a.x ) * t,
		y: a.y + ( b.y - a.y ) * t,
		depth: a.depth + ( b.depth - a.depth ) * t,
	};

}

function smoothStep( edge0, edge1, x ) {

	if ( edge0 === edge1 ) return x < edge0 ? 0 : 1;
	const t = clamp01( ( x - edge0 ) / ( edge1 - edge0 ) );
	return t * t * ( 3 - 2 * t );

}

function resampleByArcLength( raw, count, texel ) {

	if ( ! Array.isArray( raw ) || raw.length < 2 ) throw new Error( 'A corridor needs at least two points' );
	if ( ! Number.isInteger( count ) || count < 2 ) throw new Error( 'samples must be an integer >= 2' );

	const cumulative = new Float64Array( raw.length );
	for ( let i = 1; i < raw.length; i ++ )
		cumulative[ i ] = cumulative[ i - 1 ] + pointDistance( raw[ i - 1 ], raw[ i ], texel );

	const length = cumulative[ cumulative.length - 1 ];
	if ( ! Number.isFinite( length ) || length <= EPS ) throw new Error( 'A corridor cannot have zero 3D length' );

	const points = new Array( count );
	let segment = 0;

	for ( let i = 0; i < count; i ++ ) {

		const target = length * i / ( count - 1 );
		while ( segment + 1 < cumulative.length - 1 && cumulative[ segment + 1 ] < target ) segment ++;
		const span = cumulative[ segment + 1 ] - cumulative[ segment ];
		const f = span <= EPS ? 0 : ( target - cumulative[ segment ] ) / span;
		points[ i ] = lerpPoint( raw[ segment ], raw[ segment + 1 ], f );

	}

	// Les jonctions doivent être exactes, même après des milliers de rebuilds.
	points[ 0 ] = { ...raw[ 0 ] };
	points[ count - 1 ] = { ...raw[ raw.length - 1 ] };

	return { points, length };

}

function parentNodeOf( nest, childNode ) {

	if ( childNode === 1 ) return 0;
	const chamber = childNode - NODE_CHAMBER0;
	const parent = nest.parents[ chamber ];
	return parent < 0 ? 1 : NODE_CHAMBER0 + parent;

}

function rawPathOf( nest, childNode, subdivisions ) {

	const verticalPath = ( a, b ) => {

		if ( Math.hypot( b.x - a.x, b.y - a.y ) > EPS ) return null;
		return Array.from( { length: subdivisions + 1 }, ( _, i ) => {

			const t = i / subdivisions;
			return { x: a.x, y: a.y, depth: a.depth + ( b.depth - a.depth ) * t };

		} );

	};

	if ( childNode === 1 ) return verticalPath( nest.entry, nest.shaft )
		?? tunnelPath( nest.entry, nest.shaft, ENTRY_EDGE_SEED, subdivisions );
	const chamber = childNode - NODE_CHAMBER0;
	const child = nest.units[ chamber ];
	const parentIndex = nest.parents[ chamber ];
	const parent = parentIndex < 0 ? nest.shaft : nest.units[ parentIndex ];
	return verticalPath( parent, child ) ?? tunnelPath( parent, child, chamber, subdivisions );

}

function routeEdgeKey( a, b ) {

	return a < b ? `${ a }:${ b }` : `${ b }:${ a }`;

}

export function buildCorridorNetwork( nest, options = {} ) {

	if ( ! nest || ! Array.isArray( nest.nodes ) || nest.nodes.length < 2 )
		throw new Error( 'buildCorridorNetwork expects a built nest' );

	const samples = options.samples ?? CORRIDOR_SAMPLES;
	const texel = options.texel ?? TEXEL;
	const maxNodes = options.maxNodes ?? Math.max( 128, nest.nodes.length );
	const tunnelWidth = options.tunnelWidth ?? nest.tunnelW ?? 6;
	const agentRadiusWorld = options.agentRadiusWorld ?? TEXEL * 2.9;
	const safetyWorld = options.safetyWorld ?? TEXEL * 0.4;
	const subdivisions = Math.max( samples * 3, 96 );

	if ( nest.nodes.length > maxNodes ) throw new Error( `Navigation node capacity exceeded (${ nest.nodes.length } > ${ maxNodes })` );
	if ( ! Number.isFinite( texel ) || texel <= 0 ) throw new Error( 'texel must be positive' );

	const nodes = nest.nodes.map( ( node, index ) => ( {
		index,
		x: node.x,
		y: node.y,
		depth: node.depth,
		layer: node.layer,
		radius: node.r,
		parent: index === 0 ? - 1 : parentNodeOf( nest, index ),
	} ) );
	const corridors = new Array( nodes.length ).fill( null );
	const edgeByPair = new Map();
	const sampleData = new Float32Array( maxNodes * samples * 4 );
	const metaData = new Float32Array( maxNodes * 4 );
	const nodeData = new Float32Array( maxNodes * 4 );

	for ( const node of nodes ) {

		const base = node.index * 4;
		nodeData[ base ] = node.x;
		nodeData[ base + 1 ] = node.y;
		nodeData[ base + 2 ] = node.depth;
		nodeData[ base + 3 ] = node.radius;

	}

	for ( let child = 1; child < nodes.length; child ++ ) {

		const from = parentNodeOf( nest, child );
		const raw = rawPathOf( nest, child, subdivisions );
		const sampled = resampleByArcLength( raw, samples, texel );
		const radius = tunnelWidth;
		const safeCoreRadiusWorld = radius * texel * 0.85;
		const safeLane = Math.max( 0, ( safeCoreRadiusWorld - agentRadiusWorld - safetyWorld ) / texel );
		const corridor = {
			id: child,
			from,
			to: child,
			length: sampled.length,
			points: sampled.points,
			radius,
			safeLane,
		};

		corridors[ child ] = corridor;
		edgeByPair.set( routeEdgeKey( from, child ), child );
		const mb = child * 4;
		metaData[ mb ] = from;
		metaData[ mb + 1 ] = child;
		metaData[ mb + 2 ] = sampled.length;
		metaData[ mb + 3 ] = safeLane;

		for ( let i = 0; i < samples; i ++ ) {

			const p = sampled.points[ i ];
			const base = ( child * samples + i ) * 4;
			sampleData[ base ] = p.x;
			sampleData[ base + 1 ] = p.y;
			sampleData[ base + 2 ] = p.depth;
			sampleData[ base + 3 ] = safeLane;

		}

	}

	// Borne géométrique partagée par l'oracle GPU : une voie latérale est plus
	// longue que son axe, surtout pendant le fondu aux portails. Elle est mesurée
	// une fois par corridor, puis majorée pour couvrir l'interpolation float GPU.
	const samplingNetwork = { corridors };
	let maxLaneStretch = 1;
	for ( const corridor of corridors ) {

		if ( ! corridor ) continue;
		const segments = Math.max( 256, samples * 16 );
		const centerAdvance = corridor.length / segments;
		let previous = sampleCorridor( samplingNetwork, corridor.id, 0, corridor.safeLane, 1 );
		let measured = 1;

		for ( let i = 1; i <= segments; i ++ ) {

			const current = sampleCorridor( samplingNetwork, corridor.id,
				i / segments, corridor.safeLane, 1 );
			measured = Math.max( measured,
				pointDistance( previous, current, texel ) / centerAdvance );
			previous = current;

		}

		corridor.maxLaneStretch = measured * 1.08;
		maxLaneStretch = Math.max( maxLaneStretch, corridor.maxLaneStretch );

	}
	const maxGoals = Math.floor( nest.nextHop.length / nodes.length );
	const nextHop = new Int32Array( nest.nextHop );
	const goalNodes = Int32Array.from( nest.GOAL_NODE.slice( 0, maxGoals ) );
	const goalDistance = new Float64Array( nodes.length * maxGoals ).fill( Infinity );

	for ( let goal = 0; goal < maxGoals; goal ++ ) {

		for ( let start = 0; start < nodes.length; start ++ ) {

			if ( goal === 0 || goalNodes[ goal ] < 0 ) continue;
			let node = start, distance = 0;
			const visited = new Set();

			while ( node !== goalNodes[ goal ] && ! visited.has( node ) ) {

				visited.add( node );
				const hop = nextHop[ node * maxGoals + goal ];
				const edge = edgeByPair.get( routeEdgeKey( node, hop ) );
				if ( edge === undefined ) { distance = Infinity; break; }
				distance += corridors[ edge ].length;
				node = hop;

			}

			if ( node === goalNodes[ goal ] ) goalDistance[ start * maxGoals + goal ] = distance;

		}

	}

	return {
		samples,
		texel,
		agentRadiusWorld,
		safetyWorld,
		maxNodes,
		maxLaneStretch,
		maxGoals,
		nodes,
		corridors,
		edgeByPair,
		nextHop,
		goalNodes,
		goalDistance,
		sampleData,
		metaData,
		nodeData,
	};

}

export function sampleCorridor( network, edgeId, t, lane = 0, direction = 1 ) {

	const corridor = network.corridors[ edgeId ];
	if ( ! corridor ) throw new Error( `Unknown corridor ${ edgeId }` );

	const u = clamp01( t );
	const f = u * ( corridor.points.length - 1 );
	const i0 = Math.min( corridor.points.length - 2, Math.floor( f ) );
	const i1 = i0 + 1;
	const local = f - i0;
	const center = lerpPoint( corridor.points[ i0 ], corridor.points[ i1 ], local );

	const pBefore = corridor.points[ Math.max( 0, i0 - 1 ) ];
	const pAfter = corridor.points[ Math.min( corridor.points.length - 1, i1 + 1 ) ];
	const segmentX = corridor.points[ i1 ].x - corridor.points[ i0 ].x;
	const segmentY = corridor.points[ i1 ].y - corridor.points[ i0 ].y;
	const segmentLength = Math.hypot( segmentX, segmentY );
	const fallbackX = segmentLength > EPS ? segmentX / segmentLength : 1;
	const fallbackY = segmentLength > EPS ? segmentY / segmentLength : 0;

	const unitOrFallback = ( dx, dy ) => {

		const magnitude = Math.hypot( dx, dy );
		return magnitude > EPS ? [ dx / magnitude, dy / magnitude ] : [ fallbackX, fallbackY ];

	};
	const tangent0 = unitOrFallback(
		corridor.points[ i1 ].x - pBefore.x,
		corridor.points[ i1 ].y - pBefore.y,
	);
	const tangent1 = unitOrFallback(
		pAfter.x - corridor.points[ i0 ].x,
		pAfter.y - corridor.points[ i0 ].y,
	);
	let canonicalX = tangent0[ 0 ] + ( tangent1[ 0 ] - tangent0[ 0 ] ) * local;
	let canonicalY = tangent0[ 1 ] + ( tangent1[ 1 ] - tangent0[ 1 ] ) * local;
	const blendedLength = Math.hypot( canonicalX, canonicalY );
	canonicalX = blendedLength > EPS ? canonicalX / blendedLength : fallbackX;
	canonicalY = blendedLength > EPS ? canonicalY / blendedLength : fallbackY;
	const dir = direction < 0 ? - 1 : 1;
	const fade = smoothStep( 0, ENDPOINT_FADE, u ) * smoothStep( 0, ENDPOINT_FADE, 1 - u );
	const offset = Math.max( - corridor.safeLane, Math.min( corridor.safeLane, lane ) ) * dir * fade;

	return {
		x: center.x - canonicalY * offset,
		y: center.y + canonicalX * offset,
		depth: center.depth,
		centerX: center.x,
		centerY: center.y,
		tangentX: canonicalX * dir,
		tangentY: canonicalY * dir,
		lane: offset,
		laneWeight: fade,
		clearance: corridor.radius - Math.abs( offset ),
	};

}

export function createRouteState( network, startNode, goal ) {

	if ( ! network.nodes[ startNode ] ) throw new Error( `Unknown start node ${ startNode }` );
	if ( goal <= 0 || goal >= network.maxGoals || network.goalNodes[ goal ] < 0 )
		throw new Error( `Unknown goal ${ goal }` );
	const node = network.nodes[ startNode ];

	return {
		node: startNode,
		edge: 0,
		t: 0,
		goal,
		direction: 0,
		distance: 0,
		arrived: startNode === network.goalNodes[ goal ],
		position: { x: node.x, y: node.y, depth: node.depth },
	};

}

function nextEdge( network, node, goal ) {

	const hop = network.nextHop[ node * network.maxGoals + goal ];
	if ( hop === node ) return null;
	const edge = network.edgeByPair.get( routeEdgeKey( node, hop ) );
	if ( edge === undefined ) throw new Error( `No corridor between route nodes ${ node } and ${ hop }` );
	const corridor = network.corridors[ edge ];
	return { hop, edge, direction: corridor.from === node ? 1 : - 1 };

}

export function stepRoute( network, inputState, distance, lane = 0 ) {

	if ( ! Number.isFinite( distance ) || distance < 0 ) throw new Error( 'distance must be finite and >= 0' );
	const state = { ...inputState, position: { ...inputState.position } };
	let remaining = distance;
	let guard = network.nodes.length * 2 + 2;

	while ( guard -- > 0 ) {

		if ( state.arrived ) break;

		if ( state.edge === 0 ) {

			const transition = nextEdge( network, state.node, state.goal );
			if ( transition === null ) { state.arrived = true; break; }
			state.edge = transition.edge;
			state.direction = transition.direction;
			state.t = transition.direction > 0 ? 0 : 1;

		}

		const corridor = network.corridors[ state.edge ];
		const available = state.direction > 0 ? ( 1 - state.t ) * corridor.length : state.t * corridor.length;
		const travel = Math.min( remaining, available );
		state.t = clamp01( state.t + state.direction * travel / corridor.length );
		state.distance += travel;
		remaining -= travel;

		if ( available - travel > EPS ) break;

		state.node = state.direction > 0 ? corridor.to : corridor.from;
		state.edge = 0;
		state.direction = 0;
		state.t = 0;
		const node = network.nodes[ state.node ];
		state.position = { x: node.x, y: node.y, depth: node.depth };
		if ( state.node === network.goalNodes[ state.goal ] ) { state.arrived = true; break; }
		if ( remaining <= EPS ) break;

	}

	if ( guard <= 0 ) throw new Error( 'Route transition guard exhausted' );

	if ( state.edge !== 0 ) {

		state.position = sampleCorridor( network, state.edge, state.t, lane, state.direction );

	}

	return state;

}

export function validateNetwork( network ) {

	const errors = [];
	const tolerance = 1e-5;
	if ( ! Number.isFinite( network.maxLaneStretch ) || network.maxLaneStretch < 1 )
		errors.push( 'invalid global lane stretch bound' );

	for ( let edge = 1; edge < network.corridors.length; edge ++ ) {

		const corridor = network.corridors[ edge ];
		if ( ! corridor ) { errors.push( `missing corridor ${ edge }` ); continue; }
		const first = corridor.points[ 0 ];
		const last = corridor.points[ corridor.points.length - 1 ];
		const from = network.nodes[ corridor.from ];
		const to = network.nodes[ corridor.to ];
		if ( pointDistance( first, from, network.texel ) > tolerance ) errors.push( `corridor ${ edge } start mismatch` );
		if ( pointDistance( last, to, network.texel ) > tolerance ) errors.push( `corridor ${ edge } end mismatch` );
		if ( ! Number.isFinite( corridor.length ) || corridor.length <= 0 ) errors.push( `corridor ${ edge } invalid length` );
		if ( ! Number.isFinite( corridor.maxLaneStretch ) || corridor.maxLaneStretch < 1 )
			errors.push( `corridor ${ edge } invalid lane stretch bound` );

		const nominal = corridor.length / ( corridor.points.length - 1 );
		for ( let i = 1; i < corridor.points.length; i ++ ) {

			const d = pointDistance( corridor.points[ i - 1 ], corridor.points[ i ], network.texel );
			if ( ! Number.isFinite( d ) || d <= 0 ) errors.push( `corridor ${ edge } degenerate sample ${ i }` );
			if ( d > nominal * 1.08 + tolerance ) errors.push( `corridor ${ edge } non-uniform sample ${ i }` );

		}

	}

	for ( let goal = 1; goal < network.maxGoals; goal ++ ) {

		if ( network.goalNodes[ goal ] < 0 ) continue;
		for ( let start = 0; start < network.nodes.length; start ++ ) {

			let node = start;
			const seen = new Set();
			while ( node !== network.goalNodes[ goal ] && ! seen.has( node ) ) {

				seen.add( node );
				node = network.nextHop[ node * network.maxGoals + goal ];

			}
			if ( node !== network.goalNodes[ goal ] ) errors.push( `goal ${ goal } unreachable from node ${ start }` );

		}

	}

	return { ok: errors.length === 0, errors };

}

export function networkSignature( network, quantum = 1e-4 ) {

	let hash = 0x811C9DC5;
	const push = ( value ) => {

		let word = Math.round( value / quantum ) | 0;
		for ( let i = 0; i < 4; i ++ ) {

			hash ^= word & 0xFF;
			hash = Math.imul( hash, 0x01000193 ) >>> 0;
			word >>= 8;

		}

	};

	for ( const node of network.nodes ) { push( node.x ); push( node.y ); push( node.depth ); push( node.parent ); }
	push( network.maxLaneStretch );
	for ( const corridor of network.corridors ) if ( corridor ) {

		push( corridor.from ); push( corridor.to ); push( corridor.length ); push( corridor.maxLaneStretch );
		for ( const point of corridor.points ) { push( point.x ); push( point.y ); push( point.depth ); }

	}

	return hash.toString( 16 ).padStart( 8, '0' );

}
