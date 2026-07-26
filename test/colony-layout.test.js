import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	broodRenderAnchor,
	broodRenderDepth,
	colonyTroughSnapshot,
	troughRenderDepth,
} from '../src/colony-layout.js';

describe( 'colony layout anchors', () => {

	test( '[COLONY-TROUGH-001] renders every trough on its declared layer instead of the deepest overlap', () => {

		const calls = [];
		const layout = {
			depthAt( x, y, layer ) {

				calls.push( { x, y, layer } );
				return layer === 1 ? - 7.25 : - 18.1;

			},
		};
		assert.equal(
			troughRenderDepth( layout, {
				x: 10, y: 20, layer: 1, depth: - 7.25,
			} ),
			- 7.25,
		);
		assert.deepEqual( calls, [], 'the authoritative node depth needs no column search' );
		assert.equal(
			troughRenderDepth( layout, {
				x: 10, y: 20, layer: 1,
			} ),
			- 7.25,
		);
		assert.deepEqual( calls, [ { x: 10, y: 20, layer: 1 } ] );

	} );

	test( '[COLONY-TROUGH-002] rebuild snapshots replace all three render and exchange anchors', () => {

		const layout = {
			depthAt: () => - 99,
			troughs: {
				granary: { x: 1, y: 2, depth: - 3, layer: 0, cell: 11 },
				queen: { x: 4, y: 5, depth: - 6, layer: 1, cell: 22 },
				brood: { x: 7, y: 8, depth: - 9, layer: 2, cell: 33 },
			},
		};
		assert.deepEqual( colonyTroughSnapshot( layout ), [
			{ name: 'granary', x: 1, y: 2, depth: - 3, cell: 11, layer: 0 },
			{ name: 'queen', x: 4, y: 5, depth: - 6, cell: 22, layer: 1 },
			{ name: 'brood', x: 7, y: 8, depth: - 9, cell: 33, layer: 2 },
		] );

		layout.troughs.brood = {
			x: 70, y: 80, depth: - 12, layer: 3, cell: 330,
		};
		assert.deepEqual( colonyTroughSnapshot( layout )[ 2 ], {
			name: 'brood', x: 70, y: 80, depth: - 12, cell: 330, layer: 3,
		} );

	} );

	test( '[COLONY-BROOD-001] brood follows the nearest declared chamber layer across rebuilds', () => {

		let fallbackCalls = 0;
		const layout = {
			depthAt() { fallbackCalls ++; return - 99; },
			troughs: {
				queen: { x: 10, y: 10, depth: - 5, layer: 1 },
				brood: { x: 30, y: 10, depth: - 9, layer: 2 },
			},
		};
		assert.equal( broodRenderAnchor( layout, { x: 12, y: 10 } ),
			layout.troughs.queen );
		assert.equal( broodRenderDepth( layout, { x: 12, y: 10 } ), - 5 );
		assert.equal( broodRenderAnchor( layout, { x: 29, y: 11 } ),
			layout.troughs.brood );
		assert.equal( broodRenderDepth( layout, { x: 29, y: 11 } ), - 9 );
		assert.equal( fallbackCalls, 0, 'deeper overlapping channels are never queried' );

		// A published rebuild replaces both anchors and their layers/depths.
		layout.troughs.queen = { x: 4, y: 5, depth: - 7, layer: 0 };
		layout.troughs.brood = { x: 8, y: 5, depth: - 12, layer: 3 };
		assert.equal( broodRenderDepth( layout, { x: 7.5, y: 5 } ), - 12 );
		assert.equal( broodRenderDepth( layout, { x: 4.2, y: 5 } ), - 7 );

	} );

} );
