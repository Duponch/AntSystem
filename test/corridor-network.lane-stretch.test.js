import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TEXEL } from '../src/config.js';
import { buildNest } from '../src/nest.js';
import {
	buildCorridorNetwork,
	sampleCorridor,
} from '../src/navigation/corridor-network.js';

function distance3D( a, b, texel ) {

	return Math.hypot(
		b.x - a.x,
		b.y - a.y,
		( b.depth - a.depth ) / texel,
	);

}

test( 'maxLaneStretch bounds every dense maximum-lane advance', () => {

	const activeChambers = 24;
	const tunnelWidth = 12;
	const samples = 64;
	const denseSegments = 4096;

	for ( const depth of [ 10, 18, 200 ] ) {

		// Le préfixe actif et son graphe sont identiques avec carve=false ; le
		// heightfield, inutilisé par le corridor network, n'est pas alloué.
		const nest = buildNest( activeChambers, depth, tunnelWidth, false );
		const network = buildCorridorNetwork( nest, {
			samples,
			texel: TEXEL,
			tunnelWidth,
		} );
		let checkedEdges = 0;

		assert.ok( Number.isFinite( network.maxLaneStretch ) );
		assert.ok( network.maxLaneStretch >= 1 );

		for ( let edgeId = 1; edgeId < network.corridors.length; edgeId ++ ) {

			const corridor = network.corridors[ edgeId ];
			assert.ok( corridor, `depth ${ depth }, missing edge ${ edgeId }` );
			assert.ok( Number.isFinite( corridor.maxLaneStretch ) );
			assert.ok( corridor.maxLaneStretch >= 1 );
			assert.ok( corridor.maxLaneStretch <= network.maxLaneStretch );
			assert.ok( corridor.safeLane > 0, `depth ${ depth }, edge ${ edgeId } has no testable lane` );

			let previousCenter = sampleCorridor( network, edgeId, 0, 0, 1 );
			let previousLane = sampleCorridor( network, edgeId, 0, corridor.safeLane, 1 );

			for ( let i = 1; i <= denseSegments; i ++ ) {

				const t = i / denseSegments;
				const center = sampleCorridor( network, edgeId, t, 0, 1 );
				const lane = sampleCorridor( network, edgeId, t, corridor.safeLane, 1 );
				const centerAdvance = distance3D( previousCenter, center, network.texel );
				const actualAdvance = distance3D( previousLane, lane, network.texel );
				const ratio = actualAdvance / centerAdvance;

				assert.ok( Number.isFinite( centerAdvance ) && centerAdvance > 0 );
				assert.ok( Number.isFinite( actualAdvance ) );
				assert.ok( Number.isFinite( ratio ) );
				assert.ok(
					ratio <= corridor.maxLaneStretch,
					`depth ${ depth }, edge ${ edgeId }, step ${ i }: ` +
						`ratio ${ ratio } > corridor bound ${ corridor.maxLaneStretch }`,
				);
				assert.ok( corridor.maxLaneStretch <= network.maxLaneStretch );

				previousCenter = center;
				previousLane = lane;

			}

			checkedEdges ++ ;

		}

		assert.equal( checkedEdges, network.nodes.length - 1 );

	}

} );
