import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_NEST_DEPTH, MIN_NEST_DEPTH, TEXEL } from '../src/config.js';
import { buildNest } from '../src/nest.js';
import {
	buildCorridorNetwork,
	CORRIDOR_SURFACE_TRACKS,
	sampleCorridorSurface,
} from '../src/navigation/corridor-network.js';

function distance3D( a, b, texel ) {

	return Math.hypot(
		b.x - a.x,
		b.y - a.y,
		( b.depth - a.depth ) / texel,
	);

}

test( 'maxLaneStretch bounds every dense surface-track advance', () => {

	const activeChambers = 24;
	const tunnelWidth = 12;
	const samples = 64;
	const denseSegments = 512;

	for ( const depth of [ MIN_NEST_DEPTH, 20, MAX_NEST_DEPTH ] ) {

		// The active prefix and its graph are identical with carve=false; the
		// heightfield, unused by the corridor network, is not allocated.
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
			assert.equal( corridor.surfaceLengths.length, CORRIDOR_SURFACE_TRACKS );

			for ( let track = 0; track < CORRIDOR_SURFACE_TRACKS; track ++ ) {

				const angle = track / CORRIDOR_SURFACE_TRACKS * Math.PI * 2;
				const nominalAdvance = corridor.surfaceLengths[ track ] / denseSegments;
				let previous = sampleCorridorSurface( network, edgeId, 0, angle, 1 );

				assert.ok( Number.isFinite( nominalAdvance ) && nominalAdvance > 0 );

				for ( let i = 1; i <= denseSegments; i ++ ) {

					const t = i / denseSegments;
					const current = sampleCorridorSurface( network, edgeId, t, angle, 1 );
					const actualAdvance = distance3D( previous, current, network.texel );
					const ratio = actualAdvance / nominalAdvance;

					assert.ok( Number.isFinite( actualAdvance ) && actualAdvance > 0 );
					assert.ok( Number.isFinite( ratio ) );
					assert.ok(
						ratio <= corridor.maxLaneStretch + 1e-5,
						`depth ${ depth }, edge ${ edgeId }, track ${ track }, step ${ i }: ` +
							`ratio ${ ratio } > corridor bound ${ corridor.maxLaneStretch }`,
					);
					assert.ok( corridor.maxLaneStretch <= network.maxLaneStretch );
					previous = current;

				}

			}

			checkedEdges ++ ;

		}

		assert.equal( checkedEdges, network.nodes.length - 1 );

	}

} );
