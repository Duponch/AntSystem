import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	buildCorridorNetwork,
	validateNetwork,
} from '../src/navigation/corridor-network.js';
import { makeNest } from './helpers/corridor-fixtures.js';

test( 'a perfectly vertical entrance shaft is a valid 3D corridor', () => {

	const texel = 0.2;
	const entry = { x: 4, y: - 3, depth: - 0.25, layer: 0, r: 3 };
	const shaft = { x: 4, y: - 3, depth: - 6.25, layer: 0, r: 3 };
	const nest = makeNest( {
		entry,
		shaft,
		units: [ { x: 15, y: 2, depth: - 8, layer: 1, R: 4 } ],
		parents: [ - 1 ],
		goals: [ - 1, 2, 2, 2, 0 ],
	} );
	const network = buildCorridorNetwork( nest, { samples: 32, texel } );
	const vertical = network.corridors[ 1 ];
	const verdict = validateNetwork( network );

	assert.equal( verdict.ok, true, verdict.errors.join( '\n' ) );
	assert.ok( vertical.length >= Math.abs( shaft.depth - entry.depth ) / texel );
	assert.deepEqual( vertical.points[ 0 ], {
		x: entry.x,
		y: entry.y,
		depth: entry.depth,
	} );
	assert.deepEqual( vertical.points.at( - 1 ), {
		x: shaft.x,
		y: shaft.y,
		depth: shaft.depth,
	} );

} );
