import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { BoxGeometry, CylinderGeometry, IcosahedronGeometry } from 'three';

import {
	UNDERGROUND_VISUAL_BUDGET,
	UNDERGROUND_VISUAL_VERSION,
	isEmbeddedInExcavationShell,
	generateUndergroundVisualLayout,
	isInsideUndergroundBlock,
	soilLayerAtDepth,
	wrapPeriodicCoordinate,
} from '../src/underground-visual.js';

const WORLD = 160;
const THICKNESS = 28;
const EPS = 1e-6;

function digestLayout( layout ) {

	const hash = createHash( 'sha256' );
	for ( const values of [ layout.clods, layout.rocks, layout.roots, layout.dust ] )
		hash.update( Buffer.from( values.buffer, values.byteOffset, values.byteLength ) );
	return hash.digest( 'hex' );

}

describe( 'stylised underground visual contract', () => {

	test( 'UNDERGROUND-VISUAL-001 defines five ordered, contrasting soil horizons', () => {

		assert.equal( UNDERGROUND_VISUAL_VERSION, 'camera-excavation-v1' );
		const samples = [ 0.02, 0.16, 0.38, 0.66, 0.94 ]
			.map( ( fraction ) => soilLayerAtDepth( fraction * THICKNESS, THICKNESS ) );
		assert.deepEqual( samples.map( ( layer ) => layer.id ), [
			'humus',
			'topsoil',
			'clay',
			'ochre',
			'bedrock',
		] );
		assert.equal( new Set( samples.map( ( layer ) => layer.color ) ).size, samples.length );
		assert.ok( samples.every( ( layer ) => layer.from >= 0 && layer.to <= 1 ) );

	} );

	test( 'UNDERGROUND-VISUAL-002 diving depends only on the physical soil block', () => {

		assert.equal( isInsideUndergroundBlock( { x: 0, y: - 0.01, z: 0 }, WORLD, THICKNESS ), true );
		assert.equal( isInsideUndergroundBlock( { x: 79.99, y: - 27.99, z: - 79.99 }, WORLD, THICKNESS ), true );
		for ( const point of [
			{ x: 0, y: 0, z: 0 },
			{ x: 0, y: - THICKNESS - 0.01, z: 0 },
			{ x: WORLD / 2 + 0.01, y: - 2, z: 0 },
			{ x: 0, y: - 2, z: - WORLD / 2 - 0.01 },
		] ) assert.equal( isInsideUndergroundBlock( point, WORLD, THICKNESS ), false );

	} );

	test( 'UNDERGROUND-VISUAL-003 the decor bake is deterministic, bounded and nest-independent', () => {

		const first = generateUndergroundVisualLayout( { world: WORLD, thickness: THICKNESS } );
		const repeated = generateUndergroundVisualLayout( { world: WORLD, thickness: THICKNESS } );
		const variant = generateUndergroundVisualLayout( {
			world: WORLD,
			thickness: THICKNESS,
			seed: 0x7E221,
		} );

		assert.equal( digestLayout( repeated ), digestLayout( first ) );
		assert.notEqual( digestLayout( variant ), digestLayout( first ) );
		assert.equal( first.clods.length, UNDERGROUND_VISUAL_BUDGET.clods * 9 );
		assert.equal( first.rocks.length, UNDERGROUND_VISUAL_BUDGET.rocks * 9 );
		assert.equal( first.dust.length, UNDERGROUND_VISUAL_BUDGET.dust * 4 );
		assert.ok( first.rootCount <= UNDERGROUND_VISUAL_BUDGET.rootSegments );
		assert.equal( first.roots.length, first.rootCount * 7 );

		for ( const instances of [ first.clods, first.rocks ] )
			for ( let offset = 0; offset < instances.length; offset += 9 ) {

				assert.ok( Math.abs( instances[ offset ] ) <= WORLD / 2 + EPS );
				assert.ok( instances[ offset + 1 ] <= - 0.05 + EPS );
				assert.ok( instances[ offset + 1 ] >= - THICKNESS - EPS );
				assert.ok( Math.abs( instances[ offset + 2 ] ) <= WORLD / 2 + EPS );
				assert.ok( instances[ offset + 3 ] > 0 );
				assert.ok( instances[ offset + 4 ] > 0 );
				assert.ok( instances[ offset + 5 ] > 0 );

			}

	} );

	test( 'UNDERGROUND-VISUAL-004 roots stay in the living topsoil while aggregates span every horizon', () => {

		const layout = generateUndergroundVisualLayout( { world: WORLD, thickness: THICKNESS } );
		assert.ok( layout.rootCount >= 180, 'the topsoil must contain a visible root network' );
		assert.equal( layout.rootCount % 9, 0, 'each root plant owns nine connected segments' );
		for ( let offset = 0; offset < layout.roots.length; offset += 7 ) {

			for ( const y of [ layout.roots[ offset + 1 ], layout.roots[ offset + 4 ] ] ) {

				assert.ok( y <= EPS );
				assert.ok( y >= - UNDERGROUND_VISUAL_BUDGET.rootDepth - EPS );

			}
			assert.ok( layout.roots[ offset + 6 ] > 0 );

		}

		const occupied = new Set();
		for ( let offset = 1; offset < layout.clods.length; offset += 9 )
			occupied.add( soilLayerAtDepth( - layout.clods[ offset ], THICKNESS ).id );
		assert.deepEqual( [ ...occupied ].sort(), [
			'bedrock',
			'clay',
			'humus',
			'ochre',
			'topsoil',
		] );

	} );

	test( 'UNDERGROUND-VISUAL-005 shell reveal exposes embedded matter without floating near the camera', () => {

		const radius = 9;
		const relief = 1;
		const rockRadius = 1.4;
		const safeSurface = radius * ( 1 + relief * 0.035 );
		const inner = safeSurface + rockRadius * 0.65;
		assert.equal( isEmbeddedInExcavationShell(
			inner + 0.2, radius, relief, rockRadius, 'rock' ), true );
		assert.equal( isEmbeddedInExcavationShell(
			inner - 0.001, radius, relief, rockRadius, 'rock' ), false );
		assert.equal( isEmbeddedInExcavationShell(
			inner + 0.651, radius, relief, rockRadius, 'rock' ), false );

	} );

	test( 'UNDERGROUND-VISUAL-006 periodic geology keeps a dense stable shell around every camera tile', () => {

		const layout = generateUndergroundVisualLayout( { world: WORLD, thickness: THICKNESS } );
		assert.equal( layout.tileSpan, UNDERGROUND_VISUAL_BUDGET.tileSpan );

		const countAround = ( camera ) => {

			let count = 0;
			for ( let offset = 0; offset < layout.clods.length; offset += 9 ) {

				const x = wrapPeriodicCoordinate(
					layout.clods[ offset ], camera.x, layout.tileSpan );
				const z = wrapPeriodicCoordinate(
					layout.clods[ offset + 2 ], camera.z, layout.tileSpan );
				assert.ok( Math.abs( x - camera.x ) <= layout.tileSpan * 0.5 + EPS );
				assert.ok( Math.abs( z - camera.z ) <= layout.tileSpan * 0.5 + EPS );
				const distance = Math.hypot(
					x - camera.x,
					layout.clods[ offset + 1 ] - camera.y,
					z - camera.z,
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

		const cameras = [
			{ x: 0, y: - 14, z: 0 },
			{ x: 12.9, y: - 14, z: - 12.9 },
			{ x: 52, y: - 14, z: - 47 },
		];
		const counts = cameras.map( countAround );
		assert.ok( counts.every( ( count ) => count >= 90 ),
			`periodic shell density regressed: ${counts.join( ', ' )}` );
		assert.equal(
			countAround( { x: layout.tileSpan, y: - 14, z: layout.tileSpan } ),
			counts[ 0 ],
			'an exact tile translation must reproduce the same geology',
		);

	} );

	test( 'UNDERGROUND-VISUAL-007 the maximum excavation fits one periodic tile without popping', () => {

		const layout = generateUndergroundVisualLayout( { world: WORLD, thickness: THICKNESS } );
		let maxRockRadius = 0;
		for ( let offset = 0; offset < layout.rocks.length; offset += 9 )
			maxRockRadius = Math.max( maxRockRadius,
				layout.rocks[ offset + 3 ], layout.rocks[ offset + 4 ], layout.rocks[ offset + 5 ] );
		const furthestRockCenter = 10 * ( 1 + 1.8 * 0.035 ) + maxRockRadius * 0.65 + 0.65;
		assert.ok( furthestRockCenter <= layout.tileSpan * 0.5,
			`periodic tile too small for the excavation shell: ${furthestRockCenter}` );

	} );
	test( 'UNDERGROUND-VISUAL-PERF-001 keeps every GPU and geometry budget fixed', () => {

		assert.deepEqual( UNDERGROUND_VISUAL_BUDGET.drawCalls, {
			soil: 1,
			clods: 1,
			rocks: 1,
			roots: 1,
			dust: 1,
		} );
		const triangleCount = ( geometry ) => geometry.index
			? geometry.index.count / 3
			: geometry.attributes.position.count / 3;
		const carrierTriangles = triangleCount( new BoxGeometry( 1, 1, 1 ) );
		const aggregateTriangles = triangleCount( new IcosahedronGeometry( 1, 0 ) );
		const rootTriangles = triangleCount( new CylinderGeometry( 1, 0.72, 1, 5, 1, false ) );
		assert.equal( carrierTriangles, 12 );
		assert.equal( aggregateTriangles, 20 );
		assert.equal( rootTriangles, 20 );
		assert.equal( UNDERGROUND_VISUAL_BUDGET.estimatedTriangles,
			carrierTriangles
			+ UNDERGROUND_VISUAL_BUDGET.clods * aggregateTriangles
			+ UNDERGROUND_VISUAL_BUDGET.rocks * aggregateTriangles
			+ UNDERGROUND_VISUAL_BUDGET.rootSegments * rootTriangles );
		assert.equal( UNDERGROUND_VISUAL_BUDGET.estimatedTriangles, 98_232 );
		assert.ok( UNDERGROUND_VISUAL_BUDGET.estimatedTriangles <= 150_000 );
		assert.ok( UNDERGROUND_VISUAL_BUDGET.clods <= 4096 );
		assert.ok( UNDERGROUND_VISUAL_BUDGET.rocks <= 768 );
		assert.ok( UNDERGROUND_VISUAL_BUDGET.rootSegments <= 1536 );
		assert.ok( UNDERGROUND_VISUAL_BUDGET.dust <= 192 );

	} );

} );
