import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	buildCorridorNetwork,
	createRouteState,
	sampleCorridor,
	stepRoute,
} from '../src/navigation/corridor-network.js';
import {
	makeIrregularNest,
	makeLinearNest,
	pointDistance3D,
} from './helpers/corridor-fixtures.js';

const OPTIONS = { samples: 65, texel: 0.15625 };
const EPS = 1e-6;

describe( 'corridor continuity and motion safety', () => {

	test( 'all lane offsets converge to the exact same portal position', () => {

		const network = buildCorridorNetwork( makeLinearNest( 6 ), OPTIONS );

		for ( let edgeId = 1; edgeId < network.corridors.length - 1; edgeId ++ ) {

			const edge = network.corridors[ edgeId ];
			const next = network.corridors[ edgeId + 1 ];
			assert.equal( edge.to, next.from );

			for ( const lane of [ - 100, - 2, 0, 2, 100 ] ) {

				const before = sampleCorridor( network, edgeId, 1, lane, 1 );
				const after = sampleCorridor( network, edgeId + 1, 0, lane, 1 );

				assert.ok(
					pointDistance3D( before, after, network.texel ) <= EPS,
					`portal ${ edge.to }, lane ${ lane }`,
				);
				assert.ok( Math.abs( before.lane ) <= EPS );
				assert.ok( Math.abs( after.lane ) <= EPS );

			}

		}

	} );

	test( 'small fixed advances never produce a hidden warp', () => {

		const network = buildCorridorNetwork( makeIrregularNest(), OPTIONS );
		const command = 0.75;
		let state = createRouteState( network, 0, 1 );
		let previousDistance = state.distance;
		let guard = 20000;

		while ( ! state.arrived && guard -- > 0 ) {

			const previous = state;
			state = stepRoute( network, state, command, 0 );
			const travelled = state.distance - previousDistance;
			const displacement = pointDistance3D( previous.position, state.position, network.texel );

			assert.ok( travelled > 0 && travelled <= command + EPS );
			assert.ok(
				displacement <= travelled * 1.10 + 1e-5,
				`warp: displacement=${ displacement }, travelled=${ travelled }`,
			);
			assert.ok( state.distance > previousDistance );

			if ( state.edge !== 0 ) {

				const edge = network.corridors[ state.edge ];
				const expectedNode = state.direction > 0 ? edge.from : edge.to;
				assert.equal( state.node, expectedNode, 'active edge must be adjacent to last crossed node' );

			}

			previousDistance = state.distance;

		}

		assert.ok( guard > 0, 'route traversal guard exhausted' );
		assert.equal( state.arrived, true );

	} );

	test( 'distance and route potential are strictly monotonic until arrival', () => {

		const network = buildCorridorNetwork( makeIrregularNest(), OPTIONS );
		let state = createRouteState( network, 0, 1 );
		const total = network.goalDistance[ state.node * network.maxGoals + state.goal ];
		let remaining = total;
		let guard = 10000;

		while ( ! state.arrived && guard -- > 0 ) {

			const previous = state;
			state = stepRoute( network, state, 1.125, 0.8 );
			const nextRemaining = total - state.distance;

			assert.ok( state.distance > previous.distance );
			assert.ok( nextRemaining < remaining );
			assert.ok( nextRemaining >= - EPS );
			remaining = nextRemaining;

		}

		assert.ok( guard > 0 );
		assert.equal( state.arrived, true );
		assert.ok( Math.abs( remaining ) <= EPS );

	} );

	test( 'lane choice changes only lateral pose, never route progress', () => {

		const network = buildCorridorNetwork( makeIrregularNest(), OPTIONS );
		const initial = createRouteState( network, 0, 1 );
		const distance = network.goalDistance[ 1 ] * 0.42;
		const left = stepRoute( network, initial, distance, - 2 );
		const centre = stepRoute( network, initial, distance, 0 );
		const right = stepRoute( network, initial, distance, 2 );

		for ( const state of [ left, right ] ) {

			assert.equal( state.node, centre.node );
			assert.equal( state.edge, centre.edge );
			assert.equal( state.direction, centre.direction );
			assert.equal( state.t, centre.t );
			assert.equal( state.distance, centre.distance );
			assert.equal( state.arrived, centre.arrived );

		}

		assert.ok( pointDistance3D( left.position, right.position, network.texel ) > 0 );

	} );

	test( 'motion converges to the portal continuously from either direction', () => {

		const network = buildCorridorNetwork( makeLinearNest(), OPTIONS );
		const edgeId = 3;
		const edge = network.corridors[ edgeId ];
		const portal = network.nodes[ edge.to ];
		let lastForward = Infinity;
		let lastReverse = Infinity;

		for ( const delta of [ 0.1, 0.05, 0.02, 0.01, 0.001 ] ) {

			const forward = sampleCorridor( network, edgeId, 1 - delta, 2.5, 1 );
			const reverse = sampleCorridor( network, edgeId, 1 - delta, 2.5, - 1 );
			const dForward = pointDistance3D( forward, portal, network.texel );
			const dReverse = pointDistance3D( reverse, portal, network.texel );

			assert.ok( dForward <= lastForward + EPS );
			assert.ok( dReverse <= lastReverse + EPS );
			lastForward = dForward;
			lastReverse = dReverse;

		}

		assert.ok( lastForward < edge.length * 0.01 );
		assert.ok( lastReverse < edge.length * 0.01 );

	} );

} );
