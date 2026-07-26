import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	buildCorridorNetwork,
	sampleCorridor,
} from '../src/navigation/corridor-network.js';
import { makeIrregularNest } from './helpers/corridor-fixtures.js';

test( 'maximum lane has no lateral jump at internal sample boundaries', () => {

	const samples = 64;
	const epsilon = 1e-7;
	const network = buildCorridorNetwork(
		makeIrregularNest(),
		{ samples, texel: 0.15625, tunnelWidth: 10 },
	);
	// Long tunnel sinueux au cœur de la fixture, loin du fondu des portails.
	const edgeId = 5;
	const edge = network.corridors[ edgeId ];
	const lane = edge.safeLane;
	// Une normale continue varie en O(epsilon). Ce facteur couvre sa dérivée
	// discrète et l'interpolation float, mais reste plusieurs milliers de fois
	// sous le saut fini produit par deux normales segmentaires différentes.
	const maxAllowed = 4 * epsilon * ( samples - 1 ) * Math.max( 1, lane );
	let maximum = 0;
	let worstBoundary = - 1;
	const violations = [];

	assert.ok( lane > 0, 'fixture must exercise a non-zero traffic lane' );

	for ( let i = 1; i < samples - 1; i ++ ) {

		const boundary = i / ( samples - 1 );
		const before = sampleCorridor( network, edgeId, boundary - epsilon, lane, 1 );
		const after = sampleCorridor( network, edgeId, boundary + epsilon, lane, 1 );
		const beforeOffsetX = before.x - before.centerX;
		const beforeOffsetY = before.y - before.centerY;
		const afterOffsetX = after.x - after.centerX;
		const afterOffsetY = after.y - after.centerY;
		const lateralJump = Math.hypot(
			afterOffsetX - beforeOffsetX,
			afterOffsetY - beforeOffsetY,
		);

		if ( lateralJump > maximum ) {

			maximum = lateralJump;
			worstBoundary = i;

		}

		if ( lateralJump > maxAllowed ) violations.push( { boundary: i, lateralJump } );

	}

	assert.equal(
		violations.length, 0,
		`${ violations.length } discontinuities; worst boundary ${ worstBoundary }: ${ maximum } > ${ maxAllowed }`,
	);

} );
