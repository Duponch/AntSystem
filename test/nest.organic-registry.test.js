import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NEST, TEXEL } from '../src/config.js';
import {
	SDF_RADIUS_SCALE,
	buildCorridorNetwork,
} from '../src/navigation/corridor-network.js';
import {
	SDF_SEGS_PER_CORRIDOR,
	corridorSdfSegmentCount,
	chamberPrimitive,
	corridorCapsuleRadii,
	corridorCapsuleSegments,
} from '../src/navigation/support-geometry.js';
import {
	DEPTH_SIZE,
	K_MAX,
	ROOM,
	buildNest,
	parentOf,
} from '../src/nest.js';

const DEPTH = 19;
const TUNNEL_WIDTH = 6;
const COLLISION_DEPTHS = process.env.NEST_TEST_DEPTH
	? [ Number( process.env.NEST_TEST_DEPTH ) ] : [ 19, 20, 22, 24 ];
const COLLISION_WIDTHS = process.env.NEST_TEST_WIDTH
	? [ Number( process.env.NEST_TEST_WIDTH ) ] : [ 5.5, 6, 12 ];
const COLLISION_NETWORK_SAMPLES = 8;
const BRANCH_MAX = 22;
const CHAMBER_MARGIN = 0.5;
const TUNNEL_CHAMBER_MARGIN = 0.4;
const TUNNEL_TUNNEL_MARGIN = 0.4;
const FIELD_MARGIN = 2;
const EPS = 1e-5;

const dot = ( a, b ) => a.reduce( ( sum, value, index ) => sum + value * b[ index ], 0 );
const subtract = ( a, b ) => a.map( ( value, index ) => value - b[ index ] );
const lerp = ( a, b, t ) => a.map( ( value, index ) => value + ( b[ index ] - value ) * t );
const length = ( value ) => Math.hypot( ...value );

function chamberOf( unit ) {

	return {
		center: [ unit.x * TEXEL, unit.depth + unit.rh, unit.y * TEXEL ],
		radii: [ unit.rwx, unit.rh, unit.rwz ],
	};

}

function renderedChamberOf( unit ) {

	const primitive = chamberPrimitive( unit );
	return {
		center: [ unit.x * TEXEL, primitive.centerDepth, unit.y * TEXEL ],
		radii: [ primitive.radiusX, primitive.radiusY, primitive.radiusZ ],
		floorDepth: primitive.floorDepth,
	};

}

function supportRadius( chamber, direction ) {

	return Math.hypot( ...chamber.radii.map( ( radius, index ) => radius * direction[ index ] ) );

}

function segmentSegmentDistance( p1, q1, p2, q2 ) {

	const u = subtract( q1, p1 );
	const v = subtract( q2, p2 );
	const w = subtract( p1, p2 );
	const a = dot( u, u ), b = dot( u, v ), c = dot( v, v );
	const d = dot( u, w ), e = dot( v, w );
	const denominator = a * c - b * b;
	let sNumerator, sDenominator = denominator;
	let tNumerator, tDenominator = denominator;

	if ( denominator < 1e-12 ) {

		sNumerator = 0;
		sDenominator = 1;
		tNumerator = e;
		tDenominator = c;

	} else {

		sNumerator = b * e - c * d;
		tNumerator = a * e - b * d;
		if ( sNumerator < 0 ) {

			sNumerator = 0;
			tNumerator = e;
			tDenominator = c;

		} else if ( sNumerator > sDenominator ) {

			sNumerator = sDenominator;
			tNumerator = e + b;
			tDenominator = c;

		}

	}
	if ( tNumerator < 0 ) {

		tNumerator = 0;
		if ( - d < 0 ) sNumerator = 0;
		else if ( - d > a ) sNumerator = sDenominator;
		else { sNumerator = - d; sDenominator = a; }

	} else if ( tNumerator > tDenominator ) {

		tNumerator = tDenominator;
		if ( - d + b < 0 ) sNumerator = 0;
		else if ( - d + b > a ) sNumerator = sDenominator;
		else { sNumerator = - d + b; sDenominator = a; }

	}
	const s = Math.abs( sNumerator ) < 1e-12 ? 0 : sNumerator / sDenominator;
	const t = Math.abs( tNumerator ) < 1e-12 ? 0 : tNumerator / tDenominator;
	return length( w.map( ( value, index ) => value + s * u[ index ] - t * v[ index ] ) );

}

function segmentIntersectsAabb( start, end, center, radii ) {

	let low = 0, high = 1;
	for ( let axis = 0; axis < 3; axis ++ ) {

		const velocity = end[ axis ] - start[ axis ];
		const minimum = center[ axis ] - radii[ axis ];
		const maximum = center[ axis ] + radii[ axis ];
		if ( Math.abs( velocity ) < 1e-12 ) {

			if ( start[ axis ] < minimum || start[ axis ] > maximum ) return false;
			continue;

		}
		let first = ( minimum - start[ axis ] ) / velocity;
		let last = ( maximum - start[ axis ] ) / velocity;
		if ( first > last ) [ first, last ] = [ last, first ];
		low = Math.max( low, first );
		high = Math.min( high, last );
		if ( low > high ) return false;

	}
	return true;

}

function closestEllipsoidPoint( point, chamber ) {

	const relative = subtract( point, chamber.center );
	const absolute = relative.map( Math.abs );
	const normalizedSquared = absolute.reduce( ( sum, value, index ) =>
		sum + ( value / chamber.radii[ index ] ) ** 2, 0 );
	if ( normalizedSquared <= 1 ) return { distance: 0, point: [ ...point ] };
	const equation = ( lambda ) => absolute.reduce( ( sum, value, index ) => {

		const radius = chamber.radii[ index ];
		return sum + ( radius * value / ( lambda + radius * radius ) ) ** 2;

	}, 0 ) - 1;
	let low = 0, high = 1;
	while ( equation( high ) > 0 ) high *= 2;
	for ( let iteration = 0; iteration < 48; iteration ++ ) {

		const middle = ( low + high ) * 0.5;
		if ( equation( middle ) > 0 ) low = middle; else high = middle;

	}
	const lambda = ( low + high ) * 0.5;
	const surface = absolute.map( ( value, index ) => {

		const radius = chamber.radii[ index ];
		return radius * radius * value / ( lambda + radius * radius );

	} );
	const projected = surface.map( ( value, index ) =>
		chamber.center[ index ] + Math.sign( relative[ index ] || 1 ) * value );
	return { distance: length( subtract( point, projected ) ), point: projected };

}

function ellipseDiskDistance( x, z, radiusX, radiusZ ) {

	const absolute = [ Math.abs( x ), Math.abs( z ) ];
	if ( ( absolute[ 0 ] / radiusX ) ** 2 + ( absolute[ 1 ] / radiusZ ) ** 2 <= 1 ) return 0;
	const radii = [ radiusX, radiusZ ];
	const equation = ( lambda ) => absolute.reduce( ( sum, value, index ) => {

		const radius = radii[ index ];
		return sum + ( radius * value / ( lambda + radius * radius ) ) ** 2;

	}, 0 ) - 1;
	let low = 0, high = 1;
	while ( equation( high ) > 0 ) high *= 2;
	for ( let iteration = 0; iteration < 48; iteration ++ ) {

		const middle = ( low + high ) * 0.5;
		if ( equation( middle ) > 0 ) low = middle; else high = middle;

	}
	const lambda = ( low + high ) * 0.5;
	const surface = absolute.map( ( value, index ) => {

		const radius = radii[ index ];
		return radius * radius * value / ( lambda + radius * radius );

	} );
	return Math.hypot( absolute[ 0 ] - surface[ 0 ], absolute[ 1 ] - surface[ 1 ] );

}

function pointChamberDistance( point, chamber ) {

	const relative = subtract( point, chamber.center );
	const inside = relative.reduce( ( sum, value, index ) =>
		sum + ( value / chamber.radii[ index ] ) ** 2, 0 ) <= 1;
	if ( inside && point[ 1 ] >= chamber.floorDepth ) return 0;
	if ( ! inside ) {

		const ellipsoid = closestEllipsoidPoint( point, chamber );
		if ( ellipsoid.point[ 1 ] >= chamber.floorDepth ) return ellipsoid.distance;

	}
	const floorY = ( chamber.floorDepth - chamber.center[ 1 ] ) / chamber.radii[ 1 ];
	const crossSection = Math.sqrt( Math.max( 0, 1 - floorY * floorY ) );
	const horizontal = ellipseDiskDistance( relative[ 0 ], relative[ 2 ],
		chamber.radii[ 0 ] * crossSection, chamber.radii[ 2 ] * crossSection );
	return Math.hypot( horizontal, point[ 1 ] - chamber.floorDepth );

}

function segmentChamberDistance( start, end, chamber ) {

	const at = ( t ) => pointChamberDistance( lerp( start, end, t ), chamber );
	let low = 0, high = 1;
	for ( let iteration = 0; iteration < 40; iteration ++ ) {

		const first = ( low * 2 + high ) / 3;
		const second = ( low + high * 2 ) / 3;
		if ( at( first ) < at( second ) ) high = second; else low = first;

	}
	return Math.min( at( 0 ), at( 1 ), at( ( low + high ) * 0.5 ) );

}

function worldCapsulesOf( corridor ) {

	return corridorCapsuleSegments( corridor ).map( ( [ start, end ] ) => [
		[ start.x * TEXEL, start.depth, start.y * TEXEL ],
		[ end.x * TEXEL, end.depth, end.y * TEXEL ],
	] );

}

function shareNode( first, second ) {

	return first.from === second.from
		|| first.from === second.to
		|| first.to === second.from
		|| first.to === second.to;

}

const SEPARATING_DIRECTIONS = Array.from( { length: 512 }, ( _, index ) => {

	const y = 1 - 2 * ( index + 0.5 ) / 512;
	const radius = Math.sqrt( 1 - y * y );
	const angle = index * Math.PI * ( 3 - Math.sqrt( 5 ) );
	return [ Math.cos( angle ) * radius, y, Math.sin( angle ) * radius ];

} );

describe( 'deterministic organic nest registry', () => {

	test( 'NEST-LAYOUT-001 is deterministic and append-only for every active prefix', () => {

		const full = buildNest( K_MAX, DEPTH, TUNNEL_WIDTH, false );
		const repeated = buildNest( K_MAX, DEPTH, TUNNEL_WIDTH, false );
		assert.deepEqual( repeated.units, full.units );
		assert.deepEqual( repeated.parents, full.parents );
		assert.deepEqual( repeated.nodes, full.nodes );

		for ( const active of [ 4, 8, 24, 52, 72, K_MAX ] ) {

			const prefix = buildNest( active, DEPTH, TUNNEL_WIDTH, false );
			assert.deepEqual( prefix.units, full.units, `unit registry changed at K=${ active }` );
			assert.deepEqual( prefix.parents, full.parents, `parent registry changed at K=${ active }` );
			assert.deepEqual( prefix.nodes, full.nodes.slice( 0, active + 2 ), `node prefix changed at K=${ active }` );
			assert.deepEqual( prefix.edges, full.edges.slice( 0, active + 1 ), `edge prefix changed at K=${ active }` );

		}
		assert.deepEqual( full.units.slice( 0, 4 ).map( ( unit ) => unit.type ), [
			ROOM.GARDE, ROOM.GRENIER, ROOM.CRECHE, ROOM.ROYALE,
		] );

		let crossSeriesParents = 0;
		let rootsFromBelow = 0;
		for ( let k = 0; k < K_MAX; k ++ ) {

			const unit = full.units[ k ];
			const parent = full.parents[ k ];
			assert.ok( parent < k && parent >= - 1, `invalid parent ${ parent } for ${ k }` );
			if ( unit.q === 0 ) {

				assert.equal( parent, k === 0 ? - 1 : k - 1,
					`founding series must expose all four biological strata` );
				continue;

			}
			const previous = full.units[ parent ];
			if ( unit.level === 0 ) {

				assert.ok( previous.level === 0 || previous.level === 1,
					`root ${ k } attached below the shallow service strata` );
				if ( previous.level === 1 ) rootsFromBelow ++;

			} else assert.equal( previous.level, unit.level - 1,
				`room ${ k } attached to level ${ previous.level }, expected ${ unit.level - 1 }` );
			const distance = Math.hypot(
				( unit.x - previous.x ) * TEXEL,
				unit.depth - previous.depth,
				( unit.y - previous.y ) * TEXEL );
			assert.ok( distance <= BRANCH_MAX + EPS,
				`organic edge ${ k } is ${ distance } world units long` );
			if ( previous.q !== unit.q ) crossSeriesParents ++;

		}
		assert.ok( crossSeriesParents >= 36,
			`only ${ crossSeriesParents } rooms escape the repeated four-room ladder` );
		assert.ok( rootsFromBelow >= 5,
			`only ${ rootsFromBelow } shallow roots grow from the stratum below` );

	} );

	test( 'NEST-LAYOUT-002 uses asymmetric stable scoring and rejects overlong candidates', () => {

		const scale = ( world ) => world / TEXEL;
		const child = { level: 0, q: 1, x: 0, y: 0 };
		const candidates = [
			{ level: 0, q: 0, x: scale( 11.5 ), y: 0 },
			{ level: 0, q: 0, x: scale( 14 ), y: 0 },
			{ level: 0, q: 0, x: scale( 30 ), y: 0 },
			child,
		];
		assert.equal( parentOf( 3, candidates ), 1, 'benign overshoot should beat a short steep branch' );
		assert.equal( parentOf( 2, [
			{ level: 0, q: 0, x: scale( 13 ), y: 0 },
			{ level: 0, q: 0, x: - scale( 13 ), y: 0 },
			child,
		] ), 0, 'index must break an exact score tie' );
		assert.throws( () => parentOf( 1, [
			{ level: 0, q: 0, x: scale( 30 ), y: 0 },
			child,
		] ), /no append-only branch parent/i );

	} );

	test( 'NEST-LAYOUT-003 chambers have a constructive separating plane and fit the field', () => {

		const nest = buildNest( K_MAX, DEPTH, TUNNEL_WIDTH, false );
		const chambers = nest.units.map( chamberOf );
		const halfFieldWorld = DEPTH_SIZE * TEXEL * 0.5;

		for ( let i = 0; i < chambers.length; i ++ ) {

			const unit = nest.units[ i ];
			assert.ok( Math.abs( ( unit.x - NEST.x ) * TEXEL ) + unit.rwx <= halfFieldWorld - FIELD_MARGIN );
			assert.ok( Math.abs( ( unit.y - NEST.y ) * TEXEL ) + unit.rwz <= halfFieldWorld - FIELD_MARGIN );

			for ( let j = i + 1; j < chambers.length; j ++ ) {

				const delta = subtract( chambers[ j ].center, chambers[ i ].center );
				let bestSeparation = - Infinity;
				for ( const direction of SEPARATING_DIRECTIONS ) {

					const separation = Math.abs( dot( delta, direction ) )
						- supportRadius( chambers[ i ], direction )
						- supportRadius( chambers[ j ], direction );
					bestSeparation = Math.max( bestSeparation, separation );

				}
				assert.ok( bestSeparation >= CHAMBER_MARGIN - EPS,
					`chambers ${ i }/${ j } lack a separating plane: ${ bestSeparation }` );

			}

		}

	} );

	test( 'NEST-LAYOUT-004 rendered capsules keep 0.4u of soil across the valid UI matrix', () => {

		let refinedPairs = 0;
		let entryPairs = 0;
		const violationByPair = new Map();
		const recordViolation = ( key, clearance, depth, width ) => {

			const previous = violationByPair.get( key );
			if ( previous && previous.clearance <= clearance ) return;
			violationByPair.set( key, {
				clearance,
				message: `D${ depth } W${ width }: ${ key } has ${ clearance.toFixed( 6 ) }u of soil`,
			} );

		};

		for ( const depth of COLLISION_DEPTHS ) for ( const width of COLLISION_WIDTHS ) {

			const nest = buildNest( K_MAX, depth, width, false );
			const network = buildCorridorNetwork( nest, {
				samples: COLLISION_NETWORK_SAMPLES,
				maxNodes: 128,
				deferSurface: true,
			} );
			const chambers = nest.units.map( renderedChamberOf );
			const corridors = network.corridors.filter( Boolean ).map( ( corridor ) => {

				const segments = worldCapsulesOf( corridor );
				const radii = corridorCapsuleRadii(
					corridor, TEXEL, SDF_RADIUS_SCALE, segments.length );
				return {
					...corridor,
					radiusWorld: Math.max( ...radii ),
					capsules: segments.map( ( segment, index ) => ( {
						segment,
						radiusWorld: radii[ index ],
					} ) ),
				};

			} );
			const halfFieldWorld = DEPTH_SIZE * TEXEL * 0.5;
			const centerWorld = [ NEST.x * TEXEL, NEST.y * TEXEL ];
			const entrance = corridors.find( ( corridor ) => corridor.id === 1 );
			assert.ok( entrance, `missing entrance at depth=${ depth }, width=${ width }` );
			assert.equal( entrance.capsules.length, SDF_SEGS_PER_CORRIDOR );

			for ( const corridor of corridors ) {

				assert.equal( corridor.capsules.length, corridorSdfSegmentCount( corridor ),
					`edge ${ corridor.id } does not use rendered capsule count` );
				for ( const capsule of corridor.capsules ) {

					const [ start, end ] = capsule.segment;
					for ( const point of [ start, end ] ) {

						assert.ok( Math.abs( point[ 0 ] - centerWorld[ 0 ] ) + capsule.radiusWorld
							<= halfFieldWorld - FIELD_MARGIN,
							`edge ${ corridor.id } leaves the X field at D${ depth } W${ width }` );
						assert.ok( Math.abs( point[ 2 ] - centerWorld[ 1 ] ) + capsule.radiusWorld
							<= halfFieldWorld - FIELD_MARGIN,
							`edge ${ corridor.id } leaves the Z field at D${ depth } W${ width }` );

					}
					for ( let chamberIndex = 0; chamberIndex < chambers.length; chamberIndex ++ ) {

						const chamberNode = chamberIndex + 2;
						if ( chamberNode === corridor.from || chamberNode === corridor.to ) continue;
						const chamber = chambers[ chamberIndex ];
						const broadRadii = chamber.radii.map( ( radius ) =>
							radius + capsule.radiusWorld + TUNNEL_CHAMBER_MARGIN );
						if ( ! segmentIntersectsAabb( start, end, chamber.center, broadRadii ) ) continue;
						refinedPairs ++;
						if ( corridor.id <= 2 ) entryPairs ++;
						const distance = segmentChamberDistance( start, end, chamber );
						if ( distance < capsule.radiusWorld + TUNNEL_CHAMBER_MARGIN - EPS )
							recordViolation( `edge ${ corridor.id } / chamber ${ chamberIndex }`, distance - capsule.radiusWorld, depth, width );

					}

				}

			}

			for ( let first = 0; first < corridors.length; first ++ ) {

				for ( let second = first + 1; second < corridors.length; second ++ ) {

					const corridorA = corridors[ first ];
					const corridorB = corridors[ second ];
					if ( shareNode( corridorA, corridorB ) ) continue;
					let clearance = Infinity;
					for ( const capsuleA of corridorA.capsules ) {

						for ( const capsuleB of corridorB.capsules ) clearance = Math.min( clearance,
							segmentSegmentDistance(
								capsuleA.segment[ 0 ], capsuleA.segment[ 1 ],
								capsuleB.segment[ 0 ], capsuleB.segment[ 1 ],
							) - capsuleA.radiusWorld - capsuleB.radiusWorld );

					}
					if ( corridorA.id <= 2 || corridorB.id <= 2 ) entryPairs ++;
					if ( clearance < TUNNEL_TUNNEL_MARGIN - EPS )
						recordViolation( `edges ${ corridorA.id }/${ corridorB.id }`, clearance, depth, width );

				}

			}

		}
		assert.ok( refinedPairs > 0, 'clipped-ellipsoid oracle was not exercised' );
		assert.ok( entryPairs > 0, 'entrance corridors were not checked against the K96 registry' );
		const violations = [ ...violationByPair.values() ].map( ( entry ) => entry.message );
		assert.deepEqual( violations, [], violations.join( '\n' ) );

	} );

} );