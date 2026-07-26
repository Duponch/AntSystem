import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	buildCorridorNetwork,
	sampleCorridor,
	validateNetwork,
} from '../src/navigation/corridor-network.js';
import {
	assertFiniteSample,
	makeIrregularNest,
	makeLinearNest,
	pointDistance3D,
} from './helpers/corridor-fixtures.js';

const OPTIONS = { samples: 33, texel: 0.25 };
const EPS = 1e-6;

describe( 'corridor network invariants', () => {

	test( 'builds a deterministic, valid, capacity-bounded network', () => {

		const nest = makeIrregularNest();
		const a = buildCorridorNetwork( nest, OPTIONS );
		const b = buildCorridorNetwork( nest, OPTIONS );
		const verdict = validateNetwork( a );

		assert.equal( verdict.ok, true, verdict.errors.join( '\n' ) );
		assert.deepEqual( verdict.errors, [] );
		assert.equal( a.nodes.length, nest.nodes.length );
		assert.equal( a.corridors.length, nest.nodes.length );
		assert.equal( a.samples, OPTIONS.samples );
		assert.equal( a.texel, OPTIONS.texel );
		assert.deepEqual( a.nodeData, b.nodeData );
		assert.deepEqual( a.metaData, b.metaData );
		assert.deepEqual( a.sampleData, b.sampleData );
		assert.deepEqual(
			a.corridors.map( ( edge ) => edge?.points ?? null ),
			b.corridors.map( ( edge ) => edge?.points ?? null ),
		);

	} );

	test( 'every corridor starts and ends exactly on its declared nodes', () => {

		const network = buildCorridorNetwork( makeIrregularNest(), OPTIONS );

		for ( let edgeId = 1; edgeId < network.corridors.length; edgeId ++ ) {

			const edge = network.corridors[ edgeId ];
			const start = sampleCorridor( network, edgeId, 0 );
			const end = sampleCorridor( network, edgeId, 1 );
			const from = network.nodes[ edge.from ];
			const to = network.nodes[ edge.to ];

			assert.ok( pointDistance3D( start, from, network.texel ) <= EPS, `edge ${ edgeId } start` );
			assert.ok( pointDistance3D( end, to, network.texel ) <= EPS, `edge ${ edgeId } end` );
			assert.equal( start.lane, 0 );
			assert.equal( end.lane, 0 );

		}

	} );

	test( 'sampling stays finite, unit-oriented and inside corridor clearance', () => {

		const network = buildCorridorNetwork( makeIrregularNest(), OPTIONS );

		for ( let edgeId = 1; edgeId < network.corridors.length; edgeId ++ ) {

			const edge = network.corridors[ edgeId ];

			for ( let i = 0; i <= 128; i ++ ) {

				const t = i / 128;
				const sample = sampleCorridor( network, edgeId, t, edge.safeLane * 0.8, 1 );
				assertFiniteSample( assert, sample );
				assert.ok( Math.abs( Math.hypot( sample.tangentX, sample.tangentY ) - 1 ) < 1e-6 );
				assert.ok( sample.clearance >= edge.radius - edge.safeLane - EPS );
				assert.ok( Math.abs( sample.lane ) <= edge.safeLane + EPS );
				assert.ok( sample.laneWeight >= - EPS && sample.laneWeight <= 1 + EPS );

			}

		}

	} );

	test( 'opposite travel direction reverses tangent without moving centerline', () => {

		const network = buildCorridorNetwork( makeLinearNest(), OPTIONS );

		for ( const t of [ 0, 0.1, 0.37, 0.8, 1 ] ) {

			const forward = sampleCorridor( network, 2, t, 0, 1 );
			const reverse = sampleCorridor( network, 2, t, 0, - 1 );

			assert.equal( forward.x, reverse.x );
			assert.equal( forward.y, reverse.y );
			assert.equal( forward.depth, reverse.depth );
			assert.ok( Math.abs( forward.tangentX + reverse.tangentX ) < EPS );
			assert.ok( Math.abs( forward.tangentY + reverse.tangentY ) < EPS );

		}

	} );

	test( 'lane is clamped and fades to zero at portals', () => {

		const network = buildCorridorNetwork( makeLinearNest(), OPTIONS );
		const edge = network.corridors[ 2 ];
		const middle = sampleCorridor( network, 2, 0.5, edge.radius * 100, 1 );
		const start = sampleCorridor( network, 2, 0, edge.radius * 100, 1 );
		const end = sampleCorridor( network, 2, 1, edge.radius * 100, 1 );

		assert.ok( Math.abs( middle.lane ) <= edge.safeLane + EPS );
		assert.ok( middle.clearance >= edge.radius - edge.safeLane - EPS );
		assert.equal( start.lane, 0 );
		assert.equal( end.lane, 0 );
		assert.equal( start.laneWeight, 0 );
		assert.equal( end.laneWeight, 0 );

	} );

	test( 'rejects invalid build parameters and unknown corridors', () => {

		const nest = makeLinearNest();
		assert.throws( () => buildCorridorNetwork( nest, { samples: 1, texel: 0.25 } ), /samples/i );
		assert.throws( () => buildCorridorNetwork( nest, { samples: 8, texel: 0 } ), /texel/i );

		const network = buildCorridorNetwork( nest, OPTIONS );
		assert.throws( () => sampleCorridor( network, 999, 0.5 ), /unknown corridor/i );

	} );

	test( 'validator detects structural corridor corruption', () => {

		const valid = buildCorridorNetwork( makeLinearNest(), OPTIONS );
		const corridors = valid.corridors.slice();
		corridors[ 2 ] = { ...corridors[ 2 ], length: 0 };
		const invalid = { ...valid, corridors };
		const verdict = validateNetwork( invalid );

		assert.equal( verdict.ok, false );
		assert.ok( verdict.errors.some( ( error ) => /invalid length/i.test( error ) ) );

	} );

} );
