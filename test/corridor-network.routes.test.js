import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	buildCorridorNetwork,
	createRouteState,
	stepRoute,
} from '../src/navigation/corridor-network.js';
import {
	makeIrregularNest,
	makeLinearNest,
	pointDistance3D,
} from './helpers/corridor-fixtures.js';

const OPTIONS = { samples: 49, texel: 0.2 };
const EPS = 1e-7;

function assertEquivalentState( a, b, texel ) {

	assert.equal( a.node, b.node );
	assert.equal( a.edge, b.edge );
	assert.equal( a.goal, b.goal );
	assert.equal( a.direction, b.direction );
	assert.equal( a.arrived, b.arrived );
	assert.ok( Math.abs( a.t - b.t ) <= EPS, `t: ${ a.t } vs ${ b.t }` );
	assert.ok( Math.abs( a.distance - b.distance ) <= EPS, `distance: ${ a.distance } vs ${ b.distance }` );
	assert.ok( pointDistance3D( a.position, b.position, texel ) <= 1e-5 );

}

describe( 'route state and traversal', () => {

	test( 'creates an explicit state at the requested node and goal', () => {

		const network = buildCorridorNetwork( makeLinearNest( 4 ), OPTIONS );
		const state = createRouteState( network, 0, 1 );

		assert.deepEqual( state.position, {
			x: network.nodes[ 0 ].x,
			y: network.nodes[ 0 ].y,
			depth: network.nodes[ 0 ].depth,
		} );
		assert.equal( state.node, 0 );
		assert.equal( state.edge, 0 );
		assert.equal( state.t, 0 );
		assert.equal( state.goal, 1 );
		assert.equal( state.distance, 0 );
		assert.equal( state.arrived, false );

	} );

	test( 'crosses only adjacent edges and conserves exact distance at boundaries', () => {

		const network = buildCorridorNetwork( makeLinearNest( 4 ), OPTIONS );
		let state = createRouteState( network, 0, 1 );
		let expectedDistance = 0;

		for ( let edgeId = 1; edgeId < network.corridors.length; edgeId ++ ) {

			const edge = network.corridors[ edgeId ];
			state = stepRoute( network, state, edge.length );
			expectedDistance += edge.length;

			assert.equal( state.node, edge.to );
			assert.equal( state.edge, 0 );
			assert.equal( state.direction, 0 );
			assert.ok( Math.abs( state.distance - expectedDistance ) <= EPS );
			assert.ok( pointDistance3D( state.position, network.nodes[ edge.to ], network.texel ) <= EPS );
			assert.equal( state.arrived, edge.to === network.goalNodes[ 1 ] );

		}

	} );

	test( 'keeps the input immutable and preserves residual distance across many edges', () => {

		const network = buildCorridorNetwork( makeIrregularNest(), OPTIONS );
		const initial = createRouteState( network, 0, 1 );
		const snapshot = structuredClone( initial );
		const total = network.goalDistance[ initial.node * network.maxGoals + initial.goal ];
		const state = stepRoute( network, initial, total * 0.83, 1.5 );

		assert.deepEqual( initial, snapshot );
		assert.notStrictEqual( state, initial );
		assert.ok( Math.abs( state.distance - total * 0.83 ) <= EPS );
		assert.equal( state.arrived, false );
		assert.notEqual( state.edge, 0 );

	} );

	test( 'is invariant to frame/dt partitioning', () => {

		const network = buildCorridorNetwork( makeIrregularNest(), OPTIONS );
		const initial = createRouteState( network, 0, 1 );
		const routeLength = network.goalDistance[ initial.node * network.maxGoals + initial.goal ];
		const distance = routeLength * 0.91;
		const lane = 1.25;
		const oneStep = stepRoute( network, initial, distance, lane );
		let sixtyHz = initial;
		let oneTwentyHz = initial;

		for ( let i = 0; i < 60; i ++ )
			sixtyHz = stepRoute( network, sixtyHz, distance / 60, lane );
		for ( let i = 0; i < 120; i ++ )
			oneTwentyHz = stepRoute( network, oneTwentyHz, distance / 120, lane );

		assertEquivalentState( oneStep, sixtyHz, network.texel );
		assertEquivalentState( oneStep, oneTwentyHz, network.texel );

	} );

	test( 'traverses the same corridor in reverse without a nearest-node fallback', () => {

		const network = buildCorridorNetwork( makeLinearNest( 4 ), OPTIONS );
		const startNode = network.goalNodes[ 1 ];
		const initial = createRouteState( network, startNode, 4 );
		const firstEdge = network.corridors.length - 1;
		const advanced = stepRoute( network, initial, 1 );

		assert.equal( advanced.edge, firstEdge );
		assert.equal( advanced.direction, - 1 );
		assert.ok( advanced.t < 1 && advanced.t > 0 );

		const finished = stepRoute( network, advanced, Number.MAX_SAFE_INTEGER );
		assert.equal( finished.arrived, true );
		assert.equal( finished.node, network.goalNodes[ 4 ] );
		assert.equal( finished.edge, 0 );

	} );

	test( 'clamps a huge travel distance at the goal', () => {

		const network = buildCorridorNetwork( makeLinearNest( 5 ), OPTIONS );
		const initial = createRouteState( network, 0, 1 );
		const routeLength = network.goalDistance[ initial.node * network.maxGoals + initial.goal ];
		const state = stepRoute( network, initial, routeLength * 1000 );

		assert.equal( state.arrived, true );
		assert.equal( state.node, network.goalNodes[ 1 ] );
		assert.equal( state.edge, 0 );
		assert.ok( Math.abs( state.distance - routeLength ) <= EPS );
		assert.ok( pointDistance3D( state.position, network.nodes[ state.node ], network.texel ) <= EPS );

	} );

	test( 'zero distance cannot teleport or add travelled distance', () => {

		const network = buildCorridorNetwork( makeLinearNest(), OPTIONS );
		const initial = createRouteState( network, 0, 1 );
		const state = stepRoute( network, initial, 0, 2 );

		assert.equal( state.distance, 0 );
		assert.equal( state.node, initial.node );
		assert.equal( state.arrived, initial.arrived );
		assert.ok( pointDistance3D( state.position, initial.position, network.texel ) <= EPS );

	} );

	test( 'a route already at its goal is terminal and stable', () => {

		const network = buildCorridorNetwork( makeLinearNest(), OPTIONS );
		const target = network.goalNodes[ 1 ];
		const initial = createRouteState( network, target, 1 );
		const state = stepRoute( network, initial, 100 );

		assert.equal( initial.arrived, true );
		assertEquivalentState( initial, state, network.texel );

	} );

	test( 'rejects invalid route inputs explicitly', () => {

		const network = buildCorridorNetwork( makeLinearNest(), OPTIONS );
		const state = createRouteState( network, 0, 1 );

		assert.throws( () => createRouteState( network, - 1, 1 ), /unknown start node/i );
		assert.throws( () => createRouteState( network, 0, 0 ), /unknown goal/i );
		assert.throws( () => createRouteState( network, 0, 999 ), /unknown goal/i );
		assert.throws( () => stepRoute( network, state, - 0.1 ), /distance/i );
		assert.throws( () => stepRoute( network, state, Number.NaN ), /distance/i );
		assert.throws( () => stepRoute( network, state, Infinity ), /distance/i );

	} );

} );
