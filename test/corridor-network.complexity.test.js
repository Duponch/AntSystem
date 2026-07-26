import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	buildCorridorNetwork,
	CORRIDOR_SURFACE_TRACKS,
	createRouteState,
	stepRoute,
	validateNetwork,
} from '../src/navigation/corridor-network.js';
import { makeChainNest } from './helpers/corridor-fixtures.js';

const TEXEL = 0.2;

function collectionSizes( value, seen = new Set(), out = [] ) {

	if ( value === null || typeof value !== 'object' || seen.has( value ) ) return out;
	seen.add( value );

	if ( Array.isArray( value ) || ArrayBuffer.isView( value ) ) {

		out.push( value.length );
		for ( const item of value ) collectionSizes( item, seen, out );
		return out;

	}

	for ( const item of Object.values( value ) ) collectionSizes( item, seen, out );
	return out;

}

describe( 'structural complexity guarantees', () => {

	test( 'shared navigation storage is linear in nodes, goals, samples and surface tracks', () => {

		for ( const chamberCount of [ 8, 32, 96 ] ) {

			const samples = 12;
			const network = buildCorridorNetwork(
				makeChainNest( chamberCount ),
				{ samples, texel: TEXEL },
			);
			const edgeCount = network.nodes.length - 1;
			const pointCount = network.corridors.reduce(
				( total, edge ) => total + ( edge?.points.length ?? 0 ),
				0,
			);
			const localContactScalars = network.corridors.reduce(
				( total, edge ) => total + ( edge?.surfaceTracks.length ?? 0 ),
				0,
			);
			const localSupportScalars = network.corridors.reduce(
				( total, edge ) => total + ( edge?.surfaceSupports.length ?? 0 ),
				0,
			);

			assert.equal( network.corridors.length, network.nodes.length );
			assert.equal( network.surfaceTracks, CORRIDOR_SURFACE_TRACKS );
			assert.equal( pointCount, edgeCount * samples );
			assert.equal( network.nextHop.length, network.nodes.length * network.maxGoals );
			assert.equal( network.goalDistance.length, network.nodes.length * network.maxGoals );
			assert.equal( network.nodeData.length, network.maxNodes * 4 );
			assert.equal( network.metaData.length, network.maxNodes * 4 );
			assert.equal( network.sampleData.length, network.maxNodes * samples * 4 );
			assert.equal(
				network.surfaceData.length,
				network.maxNodes * samples * CORRIDOR_SURFACE_TRACKS * 4,
			);
			assert.equal(
				network.surfaceSupportData.length,
				network.maxNodes * samples * CORRIDOR_SURFACE_TRACKS * 4,
			);
			assert.equal(
				localContactScalars,
				edgeCount * samples * CORRIDOR_SURFACE_TRACKS * 4,
			);
			assert.equal( localSupportScalars, localContactScalars );
			assert.equal( validateNetwork( network ).ok, true );

		}

	} );

	test( 'per-ant route state has constant shape and contains no copied path', () => {

		const expectedKeys = [
			'arrived', 'direction', 'distance', 'edge',
			'goal', 'node', 'position', 't',
		];

		for ( const chamberCount of [ 8, 32, 96 ] ) {

			const network = buildCorridorNetwork(
				makeChainNest( chamberCount ),
				{ samples: 10, texel: TEXEL },
			);
			const initial = createRouteState( network, 0, 1 );
			const advanced = stepRoute( network, initial, 17.25, 1 );

			assert.deepEqual( Object.keys( initial ).sort(), expectedKeys );
			assert.deepEqual( Object.keys( advanced ).sort(), expectedKeys );
			assert.deepEqual( collectionSizes( initial ), [] );
			assert.deepEqual( collectionSizes( advanced ), [] );
			assert.ok( JSON.stringify( advanced ).length < 1024 );

		}

	} );

	test( 'sampling density changes only per-edge shared storage', () => {

		const nest = makeChainNest( 24 );
		const low = buildCorridorNetwork( nest, { samples: 8, texel: TEXEL } );
		const high = buildCorridorNetwork( nest, { samples: 32, texel: TEXEL } );

		assert.equal( high.sampleData.length, low.sampleData.length * 4 );
		assert.equal( high.surfaceData.length, low.surfaceData.length * 4 );
		assert.equal(
			high.surfaceSupportData.length,
			low.surfaceSupportData.length * 4,
		);
		assert.equal(
			high.corridors.reduce( ( n, edge ) => n + ( edge?.points.length ?? 0 ), 0 ),
			low.corridors.reduce( ( n, edge ) => n + ( edge?.points.length ?? 0 ), 0 ) * 4,
		);
		assert.equal(
			high.corridors.reduce( ( n, edge ) => n + ( edge?.surfaceTracks.length ?? 0 ), 0 ),
			low.corridors.reduce( ( n, edge ) => n + ( edge?.surfaceTracks.length ?? 0 ), 0 ) * 4,
		);
		assert.equal(
			high.corridors.reduce( ( n, edge ) => n + ( edge?.surfaceSupports.length ?? 0 ), 0 ),
			low.corridors.reduce( ( n, edge ) => n + ( edge?.surfaceSupports.length ?? 0 ), 0 ) * 4,
		);
		assert.equal( high.nextHop.length, low.nextHop.length );
		assert.equal( high.goalDistance.length, low.goalDistance.length );

	} );

	test( 'thousands of steps do not grow the route state', () => {

		const network = buildCorridorNetwork(
			makeChainNest( 96 ),
			{ samples: 10, texel: TEXEL },
		);
		let state = createRouteState( network, 0, 1 );
		const baselineKeys = Object.keys( state ).sort();
		let maximumSerializedSize = 0;

		for ( let i = 0; i < 5000 && ! state.arrived; i ++ ) {

			state = stepRoute( network, state, 0.5, ( i % 7 ) - 3 );
			assert.deepEqual( Object.keys( state ).sort(), baselineKeys );
			assert.deepEqual( collectionSizes( state ), [] );
			maximumSerializedSize = Math.max( maximumSerializedSize, JSON.stringify( state ).length );

		}

		assert.ok( maximumSerializedSize < 1024 );
		assert.ok( state.distance > 0 );

	} );

} );
