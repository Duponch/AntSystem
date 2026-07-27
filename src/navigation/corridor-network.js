// Navigation souterraine par corridors 3D.
//
// Le réseau est un squelette géométrique partagé : chaque arête du graphe du
// nid possède une courbe 3D ré-échantillonnée à abscisse curviligne constante.
// Une fourmi ne cherche jamais son chemin dans une grille et ne se projette
// jamais contre une paroi : elle avance sur une arête, puis franchit son nœud
// terminal. Le coût d'un pas est donc O(1), quelle que soit la taille du nid.

import { TEXEL } from '../config.js';
import {
	K_MAX,
	NODE_CHAMBER0,
	entranceConnectorPath,
	entrancePath,
	tunnelPath,
} from '../nest.js';
import {
	compileCorridorSurfaceTracks,
	CORRIDOR_SURFACE_TRACKS,
	corridorSdfSegmentCount,
	sampleCompiledSurfaceTrack,
} from './support-geometry.js';
import { compileCorridorSurfaceTracksParallel } from './corridor-surface-parallel.js';

export { CORRIDOR_SURFACE_TRACKS };

export const CORRIDOR_SAMPLES = 144;
export const ENTRY_EDGE_SEED = K_MAX + 0x51;
export const ENDPOINT_FADE = 0.35;
export const SDF_RADIUS_SCALE = 0.85;

const EPS = 1e-9;

const clamp01 = ( value ) => Math.max( 0, Math.min( 1, value ) );

const vector = ( x = 0, y = 0, z = 0 ) => ( { x, y, z } );
const add3 = ( a, b ) => vector( a.x + b.x, a.y + b.y, a.z + b.z );
const sub3 = ( a, b ) => vector( a.x - b.x, a.y - b.y, a.z - b.z );
const scale3 = ( v, s ) => vector( v.x * s, v.y * s, v.z * s );
const dot3 = ( a, b ) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = ( a, b ) => vector(
	a.y * b.z - a.z * b.y,
	a.z * b.x - a.x * b.z,
	a.x * b.y - a.y * b.x,
);
const length3 = ( v ) => Math.hypot( v.x, v.y, v.z );
const normalize3 = ( v, fallback = vector( 1, 0, 0 ) ) => {

	const magnitude = length3( v );
	return magnitude > EPS ? scale3( v, 1 / magnitude ) : { ...fallback };

};
const metricPoint = ( point, texel ) => vector( point.x, point.y, point.depth / texel );

function tangentAt( points, index, texel ) {

	const before = metricPoint( points[ Math.max( 0, index - 1 ) ], texel );
	const after = metricPoint( points[ Math.min( points.length - 1, index + 1 ) ], texel );
	return normalize3( sub3( after, before ) );

}

function projectedNormal( reference, tangent, fallback ) {

	const projected = sub3( reference, scale3( tangent, dot3( reference, tangent ) ) );
	return normalize3( projected, fallback );

}

function buildTransportFrames( points, texel ) {

	const tangents = points.map( ( _, index ) => tangentAt( points, index, texel ) );
	const frames = new Array( points.length );
	const floor = vector( 0, 0, - 1 );
	let normal = projectedNormal( floor, tangents[ 0 ],
		projectedNormal( vector( 1, 0, 0 ), tangents[ 0 ], vector( 0, 1, 0 ) ) );

	for ( let i = 0; i < points.length; i ++ ) {

		const tangent = tangents[ i ];

		if ( i > 0 ) {

			const fallback = frames[ i - 1 ].binormal;
			normal = projectedNormal( normal, tangent, fallback );
			if ( dot3( normal, frames[ i - 1 ].normal ) < 0 ) normal = scale3( normal, - 1 );

		}

		let binormal = normalize3( cross3( tangent, normal ), vector( 0, 1, 0 ) );
		normal = normalize3( cross3( binormal, tangent ), normal );
		binormal = normalize3( cross3( tangent, normal ), binormal );
		frames[ i ] = { tangent, normal, binormal };

	}

	return frames;


}
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

function resampleCapsulesWithPortalBoundaries(
	raw, startIndex, endIndex, segmentCount, texel
) {

	const regions = [
		raw.slice( 0, startIndex + 1 ),
		raw.slice( startIndex, endIndex + 1 ),
		raw.slice( endIndex ),
	];
	const lengths = regions.map( ( region ) => {

		let length = 0;
		for ( let index = 1; index < region.length; index ++ )
			length += pointDistance( region[ index - 1 ], region[ index ], texel );
		return length;

	} );
	const totalWeight = lengths.reduce( ( sum, length ) => sum + length, 0 );
	const counts = lengths.map( ( length ) => length > EPS ? 1 : 0 );
	let remaining = segmentCount - counts.reduce( ( sum, count ) => sum + count, 0 );
	const ideal = lengths.map( ( length ) => length / totalWeight * segmentCount );
	while ( remaining -- > 0 ) {

		let selected = 0, largestDeficit = - Infinity;
		for ( let index = 0; index < counts.length; index ++ ) {

			if ( lengths[ index ] <= EPS ) continue;
			const deficit = ideal[ index ] - counts[ index ];
			if ( deficit > largestDeficit ) {

				largestDeficit = deficit;
				selected = index;

			}

		}
		counts[ selected ] ++;

	}
	const points = [];
	for ( let index = 0; index < regions.length; index ++ ) {

		if ( counts[ index ] === 0 ) continue;
		const sampled = resampleByArcLength( regions[ index ], counts[ index ] + 1, texel ).points;
		points.push( ... ( points.length === 0 ? sampled : sampled.slice( 1 ) ) );

	}
	if ( points.length !== segmentCount + 1 )
		throw new Error( `Capsule partition produced ${ points.length - 1 } segments instead of ${ segmentCount }` );
	return points;

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

	if ( childNode === 1 ) return entrancePath(
		nest.entry, nest.shaft, ENTRY_EDGE_SEED, subdivisions );
	const chamber = childNode - NODE_CHAMBER0;
	const child = nest.units[ chamber ];
	const parentIndex = nest.parents[ chamber ];
	const parent = parentIndex < 0 ? nest.shaft : nest.units[ parentIndex ];
	if ( chamber === 0 && nest.peripheralEntrance )
		return entranceConnectorPath( parent, child, subdivisions );
	return verticalPath( parent, child ) ?? tunnelPath( parent, child, chamber, subdivisions );

}

function stableClearanceIndex( points, texel, clearanceWorld, fromStart, metric = false ) {

	const endpoint = points[ fromStart ? 0 : points.length - 1 ];
	const distance = points.map( ( point ) => Math.hypot(
		( point.x - endpoint.x ) * texel,
		( point.y - endpoint.y ) * texel,
		metric ? point.depth - endpoint.depth : 0,
	) );

	if ( fromStart ) {

		const suffix = new Float64Array( points.length );
		let minimum = Infinity;
		for ( let index = points.length - 1; index >= 0; index -- ) {

			minimum = Math.min( minimum, distance[ index ] );
			suffix[ index ] = minimum;

		}
		for ( let index = 1; index < points.length - 1; index ++ )
			if ( suffix[ index ] >= clearanceWorld ) return index;

	} else {

		const prefix = new Float64Array( points.length );
		let minimum = Infinity;
		for ( let index = 0; index < points.length; index ++ ) {

			minimum = Math.min( minimum, distance[ index ] );
			prefix[ index ] = minimum;

		}
		for ( let index = points.length - 2; index > 0; index -- )
			if ( prefix[ index ] >= clearanceWorld ) return index;

	}
	return fromStart
		? Math.max( 1, Math.floor( points.length * 0.18 ) )
		: Math.min( points.length - 2, Math.ceil( points.length * 0.82 ) );

}

function buildAxisGeometry( floorPath, child, from, nest, axisLiftWorld, texel, samples ) {

	const last = floorPath.length - 1;
	const clearanceWorld = axisLiftWorld * 2 + 0.4;
	let raw;

	if ( child === 1 ) {

		// Gorge verticale, puis coude circulaire de rayon strictement superieur
		// au tube, puis sortie horizontale. Cette construction C1 possede un reach
		// connu : aucune generatrice ne peut viser la suite du tunnel et perdre sa
		// paroi locale comme avec l'ancien angle vif.
		const entry = floorPath[ 0 ];
		const exit = floorPath[ last ];
		const dxWorld = ( exit.x - entry.x ) * texel;
		const dyWorld = ( exit.y - entry.y ) * texel;
		const horizontalWorld = Math.hypot( dxWorld, dyWorld );
		const endAxisDepth = exit.depth + axisLiftWorld;
		const dropWorld = entry.depth - endAxisDepth;

		if ( horizontalWorld <= EPS ) {

			raw = Array.from( { length: floorPath.length }, ( _, index ) => ( {
				x: entry.x,
				y: entry.y,
				depth: entry.depth + ( endAxisDepth - entry.depth ) * index / last,
			} ) );

		} else {

			if ( dropWorld <= EPS ) throw new Error( 'Entrance axis must descend below the surface' );
			const ux = dxWorld / horizontalWorld;
			const uy = dyWorld / horizontalWorld;
			const nominalBend = Math.max( 1.0, axisLiftWorld * 1.5 );
			const bendRadius = Math.max( axisLiftWorld * 1.05,
				Math.min( nominalBend, horizontalWorld * 0.45, dropWorld * 0.55 ) );
			if ( bendRadius >= horizontalWorld || bendRadius >= dropWorld )
				throw new Error( 'Entrance is too short for its curvature-safe elbow' );
			const collarLength = dropWorld - bendRadius;
			const arcLength = bendRadius * Math.PI * 0.5;
			const tailLength = horizontalWorld - bendRadius;
			const totalLength = collarLength + arcLength + tailLength;
			const arcDepth = entry.depth - collarLength;

			raw = Array.from( { length: floorPath.length }, ( _, index ) => {

				const distance = totalLength * index / last;
				let horizontal = 0;
				let depth = entry.depth;
				if ( distance <= collarLength ) depth -= distance;
				else if ( distance <= collarLength + arcLength ) {

					const theta = ( distance - collarLength ) / bendRadius;
					horizontal = bendRadius * ( 1 - Math.cos( theta ) );
					depth = arcDepth - bendRadius * Math.sin( theta );

				} else {

					horizontal = bendRadius + distance - collarLength - arcLength;
					depth = endAxisDepth;

				}
				return {
					x: entry.x + ux * horizontal / texel,
					y: entry.y + uy * horizontal / texel,
					depth,
				};

			} );
			raw[ 0 ] = { ...entry };
			raw[ last ] = { ...exit, depth: endAxisDepth };

		}

	} else raw = floorPath.map( ( point ) => ( {
		...point,
		depth: point.depth + axisLiftWorld,
	} ) );

	// Chaque portail conserve un collier plat d'au moins deux rayons plus sa
	// marge physique. La variation de profondeur utilise ensuite tout le trajet
	// restant : cela borne la courbure sans imposer une longue corde cachee sous
	// l'empreinte de la chambre.
	const chamberBoundary = ( node, fromStart ) => {

		if ( node < NODE_CHAMBER0 ) return fromStart ? 0 : last;
		const unit = nest.units?.[ node - NODE_CHAMBER0 ];
		if ( ! unit ) return fromStart ? 0 : last;
		const insideFloor = ( point ) => {

			const dx = ( point.x - unit.x ) * texel / Math.max( unit.rwx, EPS );
			const dy = ( point.y - unit.y ) * texel / Math.max( unit.rwz, EPS );
			return Math.hypot( dx, dy ) <= 1.02;

		};
		if ( fromStart ) {

			let boundary = 0;
			for ( let index = 0; index < raw.length; index ++ ) {

				if ( ! insideFloor( raw[ index ] ) ) break;
				boundary = index;

			}
			return boundary;

		}
		let boundary = last;
		for ( let index = last; index >= 0; index -- ) {

			if ( ! insideFloor( raw[ index ] ) ) break;
			boundary = index;

		}
		return boundary;

	};

	let startIndex = stableClearanceIndex(
		raw, texel, clearanceWorld, true, child === 1 );
	let endIndex = stableClearanceIndex( raw, texel, clearanceWorld, false, false );
	if ( child !== 1 ) startIndex = Math.max( startIndex, chamberBoundary( from, true ) );
	endIndex = Math.min( endIndex, chamberBoundary( child, false ) );
	// La dernière grande branche a besoin d'un vestibule plus long : son fort
	// dénivelé est ainsi amorcé avant le bord de chambre, sans changer ses nœuds.
	if ( child >= 95 ) startIndex = Math.max( 1, startIndex - Math.round( last * 0.05 ) );

	if ( startIndex >= endIndex ) {

		startIndex = Math.max( 1, Math.floor( last * 0.2 ) );
		endIndex = Math.min( last - 1, Math.ceil( last * 0.8 ) );
		if ( startIndex >= endIndex ) throw new Error( 'Corridor is too short for portal collars' );

	}

	if ( child !== 1 ) {

		const startDepth = raw[ 0 ].depth;
		const endDepth = raw[ last ].depth;
		for ( let index = 0; index <= startIndex; index ++ ) raw[ index ].depth = startDepth;
		const routedUnit = child >= NODE_CHAMBER0
			? nest.units?.[ child - NODE_CHAMBER0 ] : null;
		const verticalBulgeWorld = routedUnit?.organicRoute?.verticalBulgeWorld ?? 0;
		for ( let index = startIndex + 1; index < endIndex; index ++ ) {

			const u = ( index - startIndex ) / ( endIndex - startIndex );
			const eased = u * u * u * ( u * ( u * 6 - 15 ) + 10 );
			raw[ index ].depth = lerpPoint(
				{ x: 0, y: 0, depth: startDepth },
				{ x: 0, y: 0, depth: endDepth }, eased ).depth
				+ verticalBulgeWorld * Math.sin( Math.PI * u ) ** 2;

		}
		// The underpass is authored only across the free span. Its sin² envelope
		// has zero position and slope at both collars, so no portal kink can make a
		// surface track loop or move backwards.
	}
	for ( let index = endIndex; index <= last; index ++ )
		raw[ index ].depth = raw[ last ].depth;
	// Le SDF doit discretiser le MEME axe complet que la navigation. Une capsule
	// unique entre le portail et `startIndex` transformait toute l'approche
	// courbe en une longue corde : l'axe sortait alors du tube et certains rayons
	// de support accrochaient une paroi distante. Les ruptures de collier restent
	// garanties par la profondeur plane de `raw`; la repartition uniforme borne
	// en plus l'erreur de corde sur l'ensemble du corridor.
	const capsuleSegmentCount = corridorSdfSegmentCount( child );
	const capsulePoints = child === 1
		? resampleByArcLength( raw, capsuleSegmentCount + 1, texel ).points
		: resampleCapsulesWithPortalBoundaries(
			raw, startIndex, endIndex, capsuleSegmentCount, texel );
	const sampled = resampleByArcLength( raw, samples, texel );
	return { raw, sampled, capsulePoints, startIndex, endIndex, clearanceWorld };

}
function corridorWallWeights( nest, corridor, texel ) {

	const chamberWeight = ( node, point ) => {

		if ( node < NODE_CHAMBER0 ) return null;
		const unit = nest.units?.[ node - NODE_CHAMBER0 ];
		if ( ! unit ) return null;
		const dx = ( point.x - unit.x ) * texel / Math.max( unit.rwx, EPS );
		const dy = ( point.y - unit.y ) * texel / Math.max( unit.rwz, EPS );
		return smoothStep( 0.95, 2.4, Math.hypot( dx, dy ) );

	};

	return corridor.axisPoints.map( ( point, index, points ) => {

		const t = index / Math.max( 1, points.length - 1 );
		const startChamber = chamberWeight( corridor.from, point );
		const endChamber = chamberWeight( corridor.to, point );
		const start = corridor.id === 1 ? 1
			: startChamber ?? smoothStep( 0, ENDPOINT_FADE, t );
		const end = endChamber ?? smoothStep( 0, ENDPOINT_FADE, 1 - t );
		return start * end;

	} );

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
	// Le point de contact est la surface géométrique elle-même. Le léger retrait
	// anatomique nécessaire au rendu est appliqué au pivot, pas au rail.
	const surfaceInsetWorld = options.surfaceInsetWorld ?? 0;
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
	const frameData = new Float32Array( maxNodes * samples * 4 );
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
		const radius = tunnelWidth;
		const contactRadius = Math.max( 0.05,
			radius * SDF_RADIUS_SCALE - surfaceInsetWorld / texel );
		const axisLiftWorld = contactRadius * texel;
		const floorPath = rawPathOf( nest, child, subdivisions );
		const floorSampled = resampleByArcLength( floorPath, samples, texel );
		// Chaque portail possede un vrai collier geometrique. Hors bouche, le
		// premier et le dernier segment d'axe sont horizontaux sur plus d'un rayon;
		// a la bouche, le premier segment reste vertical. La capsule suivante ne
		// peut donc jamais recreuser sous le point de jonction.
		const axis = buildAxisGeometry(
			floorPath, child, from, nest, axisLiftWorld, texel, samples );
		const sampled = axis.sampled;
		const safeCoreRadiusWorld = radius * texel * SDF_RADIUS_SCALE;
		const safeLane = Math.max( 0, ( safeCoreRadiusWorld - agentRadiusWorld - safetyWorld ) / texel );
		const frames = buildTransportFrames( sampled.points, texel );
		const wallWeights = corridorWallWeights( nest, {
			id: child, from, to: child, axisPoints: sampled.points,
		}, texel );
		const corridor = {
			id: child,
			from,
			to: child,
			length: floorSampled.length,
			axisLength: sampled.length,
			points: floorSampled.points,
			axisPoints: sampled.points,
			capsulePoints: axis.capsulePoints,
			portalStartIndex: axis.startIndex,
			portalEndIndex: axis.endIndex,
			portalClearanceWorld: axis.clearanceWorld,
			frames,
			wallWeights,
			radius,
			contactRadius,
			axisLiftWorld,
			safeLane,
		};

		corridors[ child ] = corridor;
		edgeByPair.set( routeEdgeKey( from, child ), child );
		const mb = child * 4;
		metaData[ mb ] = from;
		metaData[ mb + 1 ] = child;
		metaData[ mb + 2 ] = corridor.length;
		metaData[ mb + 3 ] = safeLane;

		for ( let i = 0; i < samples; i ++ ) {

			const p = corridor.axisPoints[ i ];
			const base = ( child * samples + i ) * 4;
			sampleData[ base ] = p.x;
			sampleData[ base + 1 ] = p.y;
			sampleData[ base + 2 ] = p.depth;
			sampleData[ base + 3 ] = safeLane;
			const frame = frames[ i ];
			frameData[ base ] = frame.normal.x;
			frameData[ base + 1 ] = frame.normal.y;
			frameData[ base + 2 ] = frame.normal.z;
			frameData[ base + 3 ] = contactRadius;

		}

	}

	// Projection unique sur l'union propre réellement rendue. Cette table est
	// partagée par toutes les fourmis et reste append-only lors de la croissance.
	const surfaceCompilation = options.deferSurface === true ? null
		: compileCorridorSurfaceTracks( {
			nest,
			corridors,
			samples,
			texel,
			maxNodes,
			tracks: CORRIDOR_SURFACE_TRACKS,
			endpointFade: ENDPOINT_FADE,
			tunnelRadiusScale: SDF_RADIUS_SCALE,
		} );
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

	const network = {
		samples,
		texel,
		agentRadiusWorld,
		safetyWorld,
		surfaceInsetWorld,
		surfaceTracks: CORRIDOR_SURFACE_TRACKS,
		maxNodes,
		maxLaneStretch: 1,
		maxGoals,
		nodes,
		corridors,
		edgeByPair,
		nextHop,
		goalNodes,
		goalDistance,
		sampleData,
		frameData,
		surfaceData: null,
		surfaceSupportData: null,
		metaData,
		nodeData,
	};
	return surfaceCompilation
		? attachCorridorSurfaceCompilation( network, surfaceCompilation )
		: network;

}

export function attachCorridorSurfaceCompilation( network, compilation ) {

	const expectedLength = network.maxNodes * network.samples * network.surfaceTracks * 4;
	if ( ! ( compilation?.positionData instanceof Float32Array )
		|| compilation.positionData.length !== expectedLength
		|| ! ( compilation.supportData instanceof Float32Array )
		|| compilation.supportData.length !== expectedLength
		|| ! Number.isFinite( compilation.maxSurfaceStretch ) )
		throw new Error( 'Invalid corridor surface compilation' );
	for ( const corridor of network.corridors ) {

		if ( ! corridor ) continue;
		if ( ! ( corridor.surfaceTracks instanceof Float32Array )
			|| ! ( corridor.surfaceSupports instanceof Float32Array )
			|| ! ( corridor.surfaceLengths instanceof Float32Array )
			|| ! Number.isFinite( corridor.maxSurfaceStretch ) )
			throw new Error( `Missing surface compilation for corridor ${ corridor.id }` );
		corridor.maxLaneStretch = corridor.maxSurfaceStretch * 1.02;

	}
	network.surfaceData = compilation.positionData;
	network.surfaceSupportData = compilation.supportData;
	network.maxLaneStretch = compilation.maxSurfaceStretch * 1.02;
	if ( compilation.bake ) network.surfaceBake = compilation.bake;
	return network;

}

export async function buildCorridorNetworkAsync( nest, options = {} ) {

	const {
		maxSurfaceWorkers,
		surfaceWorkerTimeoutMs,
		surfaceWorkerFactory,
		...networkOptions
	} = options;
	const network = buildCorridorNetwork( nest, {
		...networkOptions,
		deferSurface: true,
	} );
	const compilation = await compileCorridorSurfaceTracksParallel( {
		nest,
		corridors: network.corridors,
		samples: network.samples,
		texel: network.texel,
		maxNodes: network.maxNodes,
		tracks: network.surfaceTracks,
		endpointFade: ENDPOINT_FADE,
		tunnelRadiusScale: SDF_RADIUS_SCALE,
	}, {
		maxWorkers: maxSurfaceWorkers,
		timeoutMs: surfaceWorkerTimeoutMs,
		workerFactory: surfaceWorkerFactory,
	} );
	return attachCorridorSurfaceCompilation( network, compilation );

}

export function sampleCorridorSurface( network, edgeId, t, angle = 0, direction = 1 ) {

	const corridor = network.corridors[ edgeId ];
	if ( ! corridor ) throw new Error( `Unknown corridor ${ edgeId }` );
	const compiled = sampleCompiledSurfaceTrack(
		corridor, network.samples ?? corridor.points.length,
		network.surfaceTracks ?? CORRIDOR_SURFACE_TRACKS, t, angle );
	if ( ! compiled ) throw new Error( `Corridor ${ edgeId } has no compiled surface` );

	const path = corridor.axisPoints ?? corridor.points;
	const axisF = clamp01( compiled.axisT ) * ( path.length - 1 );
	const axisI0 = Math.min( path.length - 2, Math.floor( axisF ) );
	const axisI1 = axisI0 + 1;
	const axisLocal = axisF - axisI0;
	const center = lerpPoint( path[ axisI0 ], path[ axisI1 ], axisLocal );
	const radial = normalize3( vector(
		compiled.x - center.x,
		compiled.y - center.y,
		( compiled.depth - center.depth ) / network.texel,
	), vector( 0, 0, - 1 ) );
	const contactRadius = length3( vector(
		compiled.x - center.x,
		compiled.y - center.y,
		( compiled.depth - center.depth ) / network.texel,
	) );
	const support = compiled.support;
	const signedTangent = scale3( compiled.tangent, direction < 0 ? - 1 : 1 );
	const tangentOnSurface = projectedNormal(
		signedTangent, support, corridor.frames[ axisI0 ].binormal );
	const startWeight = edgeId === 1 ? 1 : smoothStep( 0, ENDPOINT_FADE, compiled.axisT );
	const endWeight = smoothStep( 0, ENDPOINT_FADE, 1 - compiled.axisT );

	return {
		x: compiled.x,
		y: compiled.y,
		depth: compiled.depth,
		centerX: center.x,
		centerY: center.y,
		centerDepth: center.depth,
		tangentX: tangentOnSurface.x,
		tangentY: tangentOnSurface.y,
		tangent3: tangentOnSurface,
		support,
		radial,
		wallWeight: startWeight * endWeight,
		contactRadius,
		trackLength: compiled.length,
		axisT: compiled.axisT,
		clearance: corridor.radius - contactRadius,
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
		if ( pointDistance( first, from, network.texel ) > tolerance )
			errors.push( `corridor ${ edge } start mismatch` );
		if ( pointDistance( last, to, network.texel ) > tolerance )
			errors.push( `corridor ${ edge } end mismatch` );
		const firstAxis = corridor.axisPoints?.[ 0 ];
		const lastAxis = corridor.axisPoints?.[ corridor.axisPoints.length - 1 ];
		const startAxis = { ...from,
			depth: from.depth + ( edge === 1 ? 0 : corridor.axisLiftWorld ) };
		const endAxis = { ...to, depth: to.depth + corridor.axisLiftWorld };
		if ( ! firstAxis || pointDistance( firstAxis, startAxis, network.texel ) > tolerance )
			errors.push( `corridor ${ edge } start axis mismatch` );
		if ( ! lastAxis || pointDistance( lastAxis, endAxis, network.texel ) > tolerance )
			errors.push( `corridor ${ edge } end axis mismatch` );
		if ( ! Number.isFinite( corridor.length ) || corridor.length <= 0 ) errors.push( `corridor ${ edge } invalid length` );
		if ( ! Number.isFinite( corridor.maxLaneStretch ) || corridor.maxLaneStretch < 1 )
			errors.push( `corridor ${ edge } invalid lane stretch bound` );
		if ( ! Array.isArray( corridor.frames ) || corridor.frames.length !== corridor.axisPoints?.length )
			errors.push( `corridor ${ edge } invalid transported frames` );
		if ( corridor.surfaceTracks?.length !== network.samples * network.surfaceTracks * 4 )
			errors.push( `corridor ${ edge } invalid projected surface tracks` );
		if ( corridor.surfaceSupports?.length !== network.samples * network.surfaceTracks * 4 )
			errors.push( `corridor ${ edge } invalid projected surface supports` );

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

		push( corridor.from ); push( corridor.to ); push( corridor.length ); push( corridor.axisLength );
		push( corridor.maxLaneStretch );
		for ( const point of corridor.points ) { push( point.x ); push( point.y ); push( point.depth ); }
		for ( const point of corridor.axisPoints ) { push( point.x ); push( point.y ); push( point.depth ); }
		for ( const value of corridor.surfaceTracks ) push( value );
		for ( const value of corridor.surfaceSupports ) push( value );
		for ( const frame of corridor.frames ) {

			push( frame.normal.x ); push( frame.normal.y ); push( frame.normal.z );

		}

	}

	return hash.toString( 16 ).padStart( 8, '0' );

}
