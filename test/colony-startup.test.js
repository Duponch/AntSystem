import assert from 'node:assert/strict';
import test from 'node:test';

import {
	STARTUP_MODE,
	initialAntPlacement,
} from '../src/colony-startup.js';

const context = {
	nodeCount: 26,
	queenNode: 8,
	broodNode: 7,
	granaryNode: 6,
};

test( 'COL-START-001 an established colony starts entirely inside its nest', () => {

	for ( let id = 0; id < 4096; id ++ ) {

		const caste = id === 0 ? 'queen' : [ 'worker', 'soldier', 'nurse', 'scout' ][ id % 4 ];
		const placement = initialAntPlacement( {
			id, caste, mode: STARTUP_MODE.ESTABLISHED, ...context,
		} );
		assert.equal( placement.under, true );
		assert.ok( placement.node >= 0 && placement.node < context.nodeCount );

	}

} );

test( 'COL-START-002 castes receive coherent homes and missions', () => {

	assert.deepEqual(
		initialAntPlacement( { id: 0, caste: 'queen', mode: STARTUP_MODE.ESTABLISHED, ...context } ),
		{ under: true, node: context.queenNode, goal: 0, activationDelay: 0 },
	);

	const nurse = initialAntPlacement( {
		id: 19, caste: 'nurse', mode: STARTUP_MODE.ESTABLISHED, ...context,
	} );
	assert.equal( nurse.node, context.broodNode );
	assert.equal( nurse.goal, 1 );
	assert.ok( nurse.activationDelay > 0 );

	for ( const caste of [ 'worker', 'soldier', 'scout' ] ) {

		const ant = initialAntPlacement( {
			id: 31, caste, mode: STARTUP_MODE.ESTABLISHED, ...context,
		} );
		assert.ok( ant.node >= 2 && ant.node < context.nodeCount );
		assert.equal( ant.goal, 4 );
		assert.ok( ant.activationDelay > 0 );

	}

} );

test( 'COL-START-003 hatchlings emerge from brood with a bounded maturation delay', () => {

	for ( let id = 1; id < 512; id ++ ) {

		const caste = id % 5 === 0 ? 'nurse' : 'worker';
		const ant = initialAntPlacement( {
			id, caste, mode: STARTUP_MODE.HATCHLING, ...context,
		} );
		assert.equal( ant.under, true );
		assert.equal( ant.node, context.broodNode );
		assert.equal( ant.goal, caste === 'nurse' ? 1 : 4 );
		assert.ok( ant.activationDelay >= 1.5 && ant.activationDelay <= 6 );

	}

} );

test( 'COL-START-004 the historical surface-only mode remains explicit', () => {

	const ant = initialAntPlacement( {
		id: 42, caste: 'worker', mode: STARTUP_MODE.SURFACE_ONLY, ...context,
	} );
	assert.deepEqual( ant, { under: false, node: 0, goal: 0, activationDelay: 0 } );

} );
