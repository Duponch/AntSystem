import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import {
	SOIL_LAYERS,
	UNDERGROUND_ARTIFACT_CATALOG,
	UNDERGROUND_VISUAL_BUDGET,
	UNDERGROUND_VISUAL_VERSION,
	generateUndergroundVisualLayout,
	isEmbeddedInExcavationShell,
	isInsideUndergroundBlock,
	wrapPeriodicCoordinate,
} from '../src/underground-visual.js';

const WORLD = 160;
const THICKNESS = 28;
const EPS = 1e-6;

function digestLayout( layout ) {

	const hash = createHash( 'sha256' );
	for ( const values of [
		layout.clods,
		...Object.values( layout.artifacts ),
		layout.roots,
	] ) hash.update( Buffer.from( values.buffer, values.byteOffset, values.byteLength ) );
	return hash.digest( 'hex' );

}

describe( 'stylised underground visual contract', () => {

	test( 'UNDERGROUND-VISUAL-001 exposes five configurable palette anchors', () => {

		assert.equal( UNDERGROUND_VISUAL_VERSION, 'camera-excavation-v2' );
		assert.deepEqual( SOIL_LAYERS.map( ( layer ) => layer.id ), [
			'humus', 'topsoil', 'clay', 'ochre', 'bedrock',
		] );
		assert.equal( new Set( SOIL_LAYERS.map( ( layer ) => layer.color ) ).size, 5 );

	} );

	test( 'UNDERGROUND-VISUAL-002 diving depends only on the physical soil block', () => {

		assert.equal( isInsideUndergroundBlock( { x: 0, y: - Number.EPSILON, z: 0 }, WORLD, THICKNESS ), true );
		assert.equal( isInsideUndergroundBlock( { x: 0, y: - 0.01, z: 0 }, WORLD, THICKNESS ), true );
		assert.equal( isInsideUndergroundBlock( { x: 79.99, y: - 27.99, z: - 79.99 }, WORLD, THICKNESS ), true );
		for ( const point of [
			{ x: 0, y: 0, z: 0 },
			{ x: 0, y: - THICKNESS - 0.01, z: 0 },
			{ x: WORLD / 2 + 0.01, y: - 2, z: 0 },
		] ) assert.equal( isInsideUndergroundBlock( point, WORLD, THICKNESS ), false );

	} );

	test( 'UNDERGROUND-VISUAL-003 decor bake is deterministic, bounded and dust-free', () => {

		const first = generateUndergroundVisualLayout( { world: WORLD, thickness: THICKNESS } );
		const repeated = generateUndergroundVisualLayout( { world: WORLD, thickness: THICKNESS } );
		const variant = generateUndergroundVisualLayout( {
			world: WORLD, thickness: THICKNESS, seed: 0x7E221,
		} );
		assert.equal( digestLayout( repeated ), digestLayout( first ) );
		assert.notEqual( digestLayout( variant ), digestLayout( first ) );
		assert.equal( 'dust' in first, false );
		assert.equal( first.clods.length, UNDERGROUND_VISUAL_BUDGET.clods * 9 );
		assert.ok( first.rootCount <= UNDERGROUND_VISUAL_BUDGET.rootSegments );
		assert.equal( first.roots.length, first.rootCount * 7 );

		for ( const [ key, item ] of Object.entries( UNDERGROUND_ARTIFACT_CATALOG ) ) {

			const values = first.artifacts[ key ];
			assert.equal( values.length, item.capacity * 8 );
			let previousRank = - Infinity;
			for ( let offset = 0; offset < values.length; offset += 8 ) {

				assert.ok( Math.abs( values[ offset ] ) <= first.tileSpan * 0.5 + EPS );
				assert.ok( values[ offset + 1 ] < 0 && values[ offset + 1 ] >= - THICKNESS );
				assert.ok( Math.abs( values[ offset + 2 ] ) <= first.tileSpan * 0.5 + EPS );
				assert.ok( values[ offset + 7 ] >= previousRank );
				previousRank = values[ offset + 7 ];

			}

		}

	} );

	test( 'UNDERGROUND-VISUAL-004 roots stay connected and bounded near the surface', () => {

		const layout = generateUndergroundVisualLayout( { world: WORLD, thickness: THICKNESS } );
		assert.ok( layout.rootCount >= 180 );
		assert.equal( layout.rootCount % 9, 0 );
		for ( let offset = 0; offset < layout.roots.length; offset += 7 ) {

			for ( const y of [ layout.roots[ offset + 1 ], layout.roots[ offset + 4 ] ] ) {

				assert.ok( y <= EPS );
				assert.ok( y >= - UNDERGROUND_VISUAL_BUDGET.rootDepth - EPS );

			}

		}

	} );

	test( 'UNDERGROUND-VISUAL-005 periodic matter remains embedded around every camera tile', () => {

		const layout = generateUndergroundVisualLayout( { world: WORLD, thickness: THICKNESS } );
		const countAround = ( camera ) => {

			let count = 0;
			for ( let offset = 0; offset < layout.clods.length; offset += 9 ) {

				const x = wrapPeriodicCoordinate( layout.clods[ offset ], camera.x, layout.tileSpan );
				const z = wrapPeriodicCoordinate( layout.clods[ offset + 2 ], camera.z, layout.tileSpan );
				const distance = Math.hypot(
					x - camera.x, layout.clods[ offset + 1 ] - camera.y, z - camera.z,
				);
				const instanceRadius = Math.max(
					layout.clods[ offset + 3 ],
					layout.clods[ offset + 4 ],
					layout.clods[ offset + 5 ],
				) * 0.08;
				if ( isEmbeddedInExcavationShell(
					distance, 9, 1, instanceRadius, 'clod' ) ) count ++;

			}
			return count;

		};
		const origin = countAround( { x: 0, y: - 14, z: 0 } );
		assert.ok( origin >= 90 );
		assert.equal( countAround( {
			x: layout.tileSpan, y: - 14, z: layout.tileSpan,
		} ), origin );

	} );

	test( 'UNDERGROUND-VISUAL-006 maximum UI dimensions fit one periodic tile', () => {

		const maximumNormalizedRadius = 0.8;
		const maximumInstanceRadius = maximumNormalizedRadius * 2.5;
		const furthestCenter = 10 * ( 1 + 1.8 * 0.035 )
			+ maximumInstanceRadius * 0.8 + 0.65;
		assert.ok( furthestCenter <= UNDERGROUND_VISUAL_BUDGET.tileSpan * 0.5 );

	} );

	test( 'UNDERGROUND-VISUAL-PERF-001 keeps all GPU budgets fixed', () => {

		assert.deepEqual( UNDERGROUND_VISUAL_BUDGET.drawCalls, {
			soil: 1,
			clods: 1,
			roots: 1,
			rock: 1,
			bone: 1,
			fishBone: 1,
		} );
		assert.equal( UNDERGROUND_VISUAL_BUDGET.estimatedTriangles, 180_728 );
		assert.ok( UNDERGROUND_VISUAL_BUDGET.estimatedTriangles <= 200_000 );
		assert.ok( UNDERGROUND_VISUAL_BUDGET.clods <= 4096 );
		assert.ok( UNDERGROUND_VISUAL_BUDGET.rootSegments <= 1536 );
		for ( const item of Object.values( UNDERGROUND_ARTIFACT_CATALOG ) )
			assert.ok( item.capacity <= 512 );

	} );

} );