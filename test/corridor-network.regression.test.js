import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	buildCorridorNetwork,
	createRouteState,
	networkSignature,
	sampleCorridor,
	stepRoute,
	validateNetwork,
} from '../src/navigation/corridor-network.js';
import {
	makeDeepNest,
	makeIrregularNest,
	makeLinearNest,
	makeStackedCrossingNest,
	pointDistance3D,
} from './helpers/corridor-fixtures.js';

const OPTIONS = { samples: 64, texel: 0.15625 };
const EPS = 1e-6;

function pointToSegmentDistance2D( point, start, end ) {

	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const l2 = dx * dx + dy * dy;
	const t = l2 === 0 ? 0 : Math.max( 0, Math.min( 1,
		( ( point.x - start.x ) * dx + ( point.y - start.y ) * dy ) / l2,
	) );
	return Math.hypot( point.x - start.x - dx * t, point.y - start.y - dy * t );

}

describe( 'irregular geometry and non-regression corpus', () => {

	test( 'irregular corridors retain their curvature instead of collapsing to chords', () => {

		const network = buildCorridorNetwork( makeIrregularNest(), OPTIONS );
		let curvedEdges = 0;

		for ( let edgeId = 2; edgeId < network.corridors.length; edgeId ++ ) {

			const edge = network.corridors[ edgeId ];
			const start = edge.points[ 0 ];
			const end = edge.points.at( - 1 );
			let maxDeviation = 0;

			for ( const point of edge.points )
				maxDeviation = Math.max( maxDeviation, pointToSegmentDistance2D( point, start, end ) );

			if ( maxDeviation > 0.2 ) curvedEdges ++ ;

		}

		assert.ok( curvedEdges >= 2, `only ${ curvedEdges } visibly curved edge(s)` );

	} );

	test( 'arc-length samples remain quasi-uniform on tortuous 3D tunnels', () => {

		const network = buildCorridorNetwork( makeIrregularNest(), OPTIONS );

		for ( let edgeId = 1; edgeId < network.corridors.length; edgeId ++ ) {

			const points = network.corridors[ edgeId ].axisPoints;
			const lengths = [];

			for ( let i = 1; i < points.length; i ++ )
				lengths.push( pointDistance3D( points[ i - 1 ], points[ i ], network.texel ) );

			const min = Math.min( ...lengths );
			const max = Math.max( ...lengths );
			assert.ok( min > 0, `edge ${ edgeId } has a degenerate segment` );
			assert.ok( max / min <= 1.10, `edge ${ edgeId } sample ratio=${ max / min }` );

		}

	} );

	test( 'stacked X/Y crossings never create an implicit vertical shortcut', () => {

		const network = buildCorridorNetwork( makeStackedCrossingNest(), OPTIONS );
		const startNode = 3;
		const targetNode = network.goalNodes[ 1 ];
		const direct = network.corridors.some( ( edge ) => edge &&
			( ( edge.from === startNode && edge.to === targetNode ) ||
				( edge.from === targetNode && edge.to === startNode ) ) );
		const initial = createRouteState( network, startNode, 1 );
		const first = stepRoute( network, initial, 0.5 );

		assert.equal( direct, false );
		assert.equal( first.edge, 3, 'must leave through branch 3, not nearest projected node' );
		assert.equal( first.direction, - 1 );

		const finished = stepRoute( network, first, Number.MAX_SAFE_INTEGER );
		const expected = network.corridors[ 3 ].length + network.corridors[ 2 ].length;

		assert.equal( finished.arrived, true );
		assert.equal( finished.node, targetNode );
		assert.ok( Math.abs( finished.distance - expected ) <= EPS );

	} );

	test( 'extreme depth remains finite, connected and traversable', () => {

		for ( const depth of [ 10, 18, 60, 120, 200 ] ) {

			const network = buildCorridorNetwork( makeDeepNest( depth ), OPTIONS );
			const verdict = validateNetwork( network );
			const initial = createRouteState( network, 0, 1 );
			const finished = stepRoute( network, initial, Number.MAX_SAFE_INTEGER, 2 );

			assert.equal( verdict.ok, true, `depth ${ depth }: ${ verdict.errors.join( '; ' ) }` );
			assert.equal( finished.arrived, true, `depth ${ depth }` );
			assert.ok( Number.isFinite( finished.distance ) && finished.distance > 0 );
			assert.ok( Number.isFinite( finished.position.depth ) );

		}

	} );

	test( 'append-only growth leaves every existing corridor byte-for-byte stable', () => {

		const prefix = buildCorridorNetwork( makeLinearNest( 3 ), OPTIONS );
		const grown = buildCorridorNetwork( makeLinearNest( 7 ), OPTIONS );

		for ( let edgeId = 1; edgeId < prefix.corridors.length; edgeId ++ ) {

			const before = prefix.corridors[ edgeId ];
			const after = grown.corridors[ edgeId ];

			assert.equal( before.id, after.id );
			assert.equal( before.from, after.from );
			assert.equal( before.to, after.to );
			assert.equal( before.length, after.length );
			assert.deepEqual( before.points, after.points );
			assert.deepEqual( before.axisPoints, after.axisPoints );
			assert.deepEqual( before.frames, after.frames );
			assert.deepEqual( before.surfaceTracks, after.surfaceTracks );
			assert.deepEqual( before.surfaceSupports, after.surfaceSupports );
			assert.deepEqual( before.surfaceLengths, after.surfaceLengths );

			const surfaceStart = edgeId * prefix.surfaceTracks * prefix.samples * 4;
			const surfaceEnd = surfaceStart + prefix.surfaceTracks * prefix.samples * 4;
			assert.deepEqual(
				prefix.surfaceData.slice( surfaceStart, surfaceEnd ),
				grown.surfaceData.slice( surfaceStart, surfaceEnd ),
			);
			assert.deepEqual(
				prefix.surfaceSupportData.slice( surfaceStart, surfaceEnd ),
				grown.surfaceSupportData.slice( surfaceStart, surfaceEnd ),
			);

		}

	} );

	test( 'the same irregular fixture has a stable navigation signature', () => {

		const first = buildCorridorNetwork( makeIrregularNest(), OPTIONS );
		const second = buildCorridorNetwork( makeIrregularNest(), OPTIONS );

		assert.match( networkSignature( first ), /^[0-9a-f]{8}$/ );
		assert.equal( networkSignature( first ), networkSignature( second ) );

	} );

	test( 'all sampled lane poses retain positive physical clearance', () => {

		const network = buildCorridorNetwork( makeIrregularNest(), OPTIONS );

		for ( let edgeId = 1; edgeId < network.corridors.length; edgeId ++ ) {

			const edge = network.corridors[ edgeId ];

			for ( let i = 0; i <= 100; i ++ ) {

				const t = i / 100;

				for ( const lane of [ - 1e6, - edge.safeLane, 0, edge.safeLane, 1e6 ] ) {

					const sample = sampleCorridor( network, edgeId, t, lane, i % 2 ? 1 : - 1 );
					assert.ok( sample.clearance >= edge.radius - edge.safeLane - EPS );
					assert.ok( sample.clearance > 0 );

				}

			}

		}

	} );

} );
