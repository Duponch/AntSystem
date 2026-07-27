import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { NEST, TEXEL } from '../src/config.js';
import {
	BAKED_NATURAL_REGISTRY,
	K_MAX,
	NEST_LAYOUT_VERSION,
	NEST_ROLE,
	ROOM,
	buildNest,
	parentOf,
} from '../src/nest.js';

const DEPTH = 19;
const TUNNEL_WIDTH = 6;
const PREFIXES = [ 24, K_MAX ];
const EPS = 1e-9;

function topologyOf( nest, count ) {

	const parents = nest.parents.slice( 0, count );
	const children = Array.from( { length: count }, () => [] );
	const depth = new Array( count ).fill( 0 );
	const edgeLengths = [];

	for ( let child = 0; child < count; child ++ ) {

		const parent = parents[ child ];
		assert.ok( parent >= - 1 && parent < child,
			`parent ${ parent } is not append-only for unit ${ child }` );
		if ( parent < 0 ) continue;
		children[ parent ].push( child );
		depth[ child ] = depth[ parent ] + 1;

		const from = nest.units[ parent ];
		const to = nest.units[ child ];
		edgeLengths.push( Math.hypot(
			( to.x - from.x ) * TEXEL,
			to.depth - from.depth,
			( to.y - from.y ) * TEXEL,
		) );

	}

	return { parents, children, depth, edgeLengths };

}

function coefficientOfVariation( values ) {

	const mean = values.reduce( ( total, value ) => total + value, 0 ) / values.length;
	const variance = values.reduce(
		( total, value ) => total + ( value - mean ) ** 2, 0 ) / values.length;
	return Math.sqrt( variance ) / mean;

}

describe( 'natural nest topology contract', () => {

	test( 'NEST-NATURAL-001 consumes the reviewed versioned bake', () => {

		assert.equal( NEST_LAYOUT_VERSION, 'natural-growth-tree-v2' );
		assert.equal( BAKED_NATURAL_REGISTRY.length, K_MAX );

		const nest = buildNest( K_MAX, DEPTH, TUNNEL_WIDTH, false );
		for ( let k = 0; k < K_MAX; k ++ ) {

			const record = BAKED_NATURAL_REGISTRY[ k ];
			const unit = nest.units[ k ];
			assert.ok( Math.abs( ( unit.x - NEST.x ) * TEXEL - record.x ) <= EPS,
				`unit ${ k } does not consume baked x` );
			assert.ok( Math.abs( ( unit.y - NEST.y ) * TEXEL - record.z ) <= EPS,
				`unit ${ k } does not consume baked z` );
			assert.equal( unit.role, record.role, `unit ${ k } does not consume baked role` );
			assert.equal( parentOf( k ), record.parent,
				`unit ${ k } does not consume baked parent` );
			assert.deepEqual( unit.organicRoute, record.route,
				`unit ${ k } does not consume baked route` );

		}

	} );

	test( 'NEST-NATURAL-002 is deterministic and append-only at K24 and K96', () => {

		const full = buildNest( K_MAX, DEPTH, TUNNEL_WIDTH, false );
		const repeated = buildNest( K_MAX, DEPTH, TUNNEL_WIDTH, false );
		assert.deepEqual( repeated.units, full.units );
		assert.deepEqual( repeated.parents, full.parents );
		assert.deepEqual( repeated.nodes, full.nodes );
		assert.deepEqual( repeated.edges, full.edges );

		for ( const count of PREFIXES ) {

			const prefix = buildNest( count, DEPTH, TUNNEL_WIDTH, false );
			assert.deepEqual( prefix.units, full.units,
				`registry changed when only K${ count } was activated` );
			assert.deepEqual( prefix.parents, full.parents,
				`parent registry changed when only K${ count } was activated` );
			assert.deepEqual( prefix.nodes, full.nodes.slice( 0, count + 2 ),
				`navigation nodes are not a K${ count } prefix` );
			assert.deepEqual( prefix.edges, full.edges.slice( 0, count + 1 ),
				`navigation edges are not a K${ count } prefix` );

		}

	} );

	test( 'NEST-NATURAL-003 grows one binary tree with branches, leaves and depth', () => {

		const expected = new Map( [
			[ 24, { minimumForks: 7, minimumLeaves: 9, minimumDepth: 5 } ],
			[ K_MAX, { minimumForks: 28, minimumLeaves: 30, minimumDepth: 8 } ],
		] );

		for ( const count of PREFIXES ) {

			const nest = buildNest( count, DEPTH, TUNNEL_WIDTH, false );
			const topology = topologyOf( nest, count );
			const roots = topology.parents.filter( ( parent ) => parent < 0 );
			const forks = topology.children.filter( ( children ) => children.length === 2 ).length;
			const leaves = topology.children.filter( ( children ) => children.length === 0 ).length;
			const maxDepth = Math.max( ...topology.depth );
			const limits = expected.get( count );

			assert.equal( roots.length, 1, `K${ count } must have exactly one root` );
			assert.ok( topology.children.every( ( children ) => children.length <= 2 ),
				`K${ count } contains a geometric hub with more than two children` );
			assert.ok( forks >= limits.minimumForks,
				`K${ count } has only ${ forks } bifurcations` );
			assert.ok( leaves >= limits.minimumLeaves,
				`K${ count } has only ${ leaves } terminal leaves` );
			assert.ok( maxDepth >= limits.minimumDepth,
				`K${ count } is only ${ maxDepth } edges deep` );
			assert.ok( maxDepth <= 14,
				`K${ count } degenerated into an overlong single-file chain` );

			for ( let k = 0; k < count; k ++ ) {

				let cursor = k;
				let hops = 0;
				while ( topology.parents[ cursor ] >= 0 ) {

					cursor = topology.parents[ cursor ];
					hops ++;
					assert.ok( hops < count, `cycle reached from unit ${ k }` );

				}
				assert.equal( cursor, 0, `unit ${ k } does not reach the founding root` );

			}

		}

	} );

	test( 'NEST-NATURAL-004 mixes corridor scales and has no four-unit template', () => {

		for ( const count of PREFIXES ) {

			const nest = buildNest( count, DEPTH, TUNNEL_WIDTH, false );
			const topology = topologyOf( nest, count );
			const shortest = Math.min( ...topology.edgeLengths );
			const longest = Math.max( ...topology.edgeLengths );
			const cv = coefficientOfVariation( topology.edgeLengths );
			const units = nest.units.slice( 0, count );
			const repeatedLevels = units.filter(
				( unit, index ) => unit.level === index % 4 ).length;
			const withinBlockEdges = topology.parents.filter( ( parent, child ) =>
				child >= 4 && parent >= 0
				&& Math.floor( parent / 4 ) === Math.floor( child / 4 ) ).length;

			assert.ok( cv >= 0.22,
				`K${ count } edge-length CV ${ cv.toFixed( 3 ) } is too uniform` );
			assert.ok( longest / shortest >= 2,
				`K${ count } does not mix short and long corridors` );
			assert.equal( new Set( units.map( ( unit ) => unit.q ) ).size, count,
				`K${ count } still groups units into repeated q-series` );
			assert.ok( repeatedLevels / count < 0.5,
				`K${ count } still repeats the level-0/1/2/3 template` );
			assert.ok( withinBlockEdges / Math.max( 1, count - 4 ) < 0.06,
				`K${ count } still contains four-unit ladder blocks` );

		}

	} );

	test( 'NEST-NATURAL-005 mixes vestibules and chambers while preserving founders', () => {

		const full = buildNest( K_MAX, DEPTH, TUNNEL_WIDTH, false );
		assert.deepEqual( full.units.slice( 0, 4 ).map( ( unit ) => unit.type ), [
			ROOM.GARDE,
			ROOM.GRENIER,
			ROOM.CRECHE,
			ROOM.ROYALE,
		] );
		assert.ok( full.units.slice( 0, 4 ).every(
			( unit ) => unit.role === NEST_ROLE.FUNCTIONAL ) );

		for ( const count of PREFIXES ) {

			const units = full.units.slice( 0, count );
			const vestibules = units.filter( ( unit ) => unit.role === NEST_ROLE.TRANSIT );
			const chambers = units.filter( ( unit ) => unit.role !== NEST_ROLE.TRANSIT );
			const radius = ( unit ) => ( unit.rwx + unit.rwz ) * 0.5;
			const average = ( values ) =>
				values.reduce( ( total, value ) => total + value, 0 ) / values.length;

			assert.ok( vestibules.length >= ( count === 24 ? 4 : 40 ),
				`K${ count } has too few small transit vestibules` );
			assert.ok( chambers.length >= ( count === 24 ? 14 : 36 ),
				`K${ count } has too few true chambers` );
			assert.ok( vestibules.every( ( unit ) => unit.type === ROOM.TUNNEL ),
				`K${ count } transit node exposed a chamber function` );
			assert.ok( average( vestibules.map( radius ) ) < 2.1,
				`K${ count } transit vestibules are visually chamber-sized` );
			assert.ok( average( chambers.map( radius ) ) > 2.5,
				`K${ count } chambers are visually corridor-sized` );
			assert.ok( Math.max( ...units.map( radius ) ) / Math.min( ...units.map( radius ) ) >= 2,
				`K${ count } lacks a readable vestibule/chamber size hierarchy` );

		}

	} );

	test( 'NEST-NATURAL-006 freezes the reviewed natural bake byte-for-byte', () => {

		assert.ok( Object.isFrozen( BAKED_NATURAL_REGISTRY ) );
		for ( const record of BAKED_NATURAL_REGISTRY ) {

			assert.ok( Object.isFrozen( record ) );
			assert.ok( Object.isFrozen( record.route ) );

		}
		const digest = createHash( 'sha256' )
			.update( JSON.stringify( BAKED_NATURAL_REGISTRY ) )
			.digest( 'hex' );
		assert.equal( digest, 'e99dde300bf4bb4b3f3ff63ac116bb5f79954e790800c32d16a77ba2b59fa805' );

	} );

} );
