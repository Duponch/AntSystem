import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
	UNDERGROUND_ARTIFACT_CATALOG,
	UNDERGROUND_VISUAL_BUDGET,
	UNDERGROUND_VISUAL_VERSION,
	artifactScale,
	generateUndergroundVisualLayout,
} from '../src/underground-visual.js';

const THICKNESS = 28;

describe( 'chaotic underground geology contract', () => {

	test( 'UNDERGROUND-VISUAL-008 removes dust from data, runtime and settings', () => {

		const layout = generateUndergroundVisualLayout( { world: 160, thickness: THICKNESS } );
		const runtime = readFileSync( new URL( '../src/underground.js', import.meta.url ), 'utf8' );
		const config = readFileSync( new URL( '../src/config.js', import.meta.url ), 'utf8' );
		const ui = readFileSync( new URL( '../src/ui.js', import.meta.url ), 'utf8' );

		assert.equal( UNDERGROUND_VISUAL_VERSION, 'camera-excavation-v2' );
		assert.equal( 'dust' in layout, false );
		assert.equal( 'dust' in UNDERGROUND_VISUAL_BUDGET, false );
		assert.doesNotMatch( runtime, /new THREE\.(?:Points|PointsMaterial)\(/ );
		assert.doesNotMatch( config + ui, /undergroundDust/ );

	} );

	test( 'UNDERGROUND-VISUAL-009 catalog is exact, bounded and backed by valid GLB files', () => {

		assert.deepEqual( Object.keys( UNDERGROUND_ARTIFACT_CATALOG ), [
			'rock', 'bone', 'fishBone',
		] );
		assert.deepEqual(
			Object.values( UNDERGROUND_ARTIFACT_CATALOG ).map( ( item ) => item.url ),
			[ '/assets/Rock.glb', '/assets/Bone.glb', '/assets/FishBone.glb' ],
		);
		for ( const item of Object.values( UNDERGROUND_ARTIFACT_CATALOG ) ) {

			assert.ok( Object.isFrozen( item ) );
			assert.ok( item.capacity > 0 && item.triangles > 0 );
			const bytes = readFileSync( new URL( `../public${item.url}`, import.meta.url ) );
			assert.equal( bytes.subarray( 0, 4 ).toString( 'ascii' ), 'glTF' );

		}

	} );

	test( 'UNDERGROUND-VISUAL-010 artifact candidates are deterministic and frequency-monotonic', () => {

		const first = generateUndergroundVisualLayout( { world: 160, thickness: THICKNESS } );
		const repeated = generateUndergroundVisualLayout( { world: 160, thickness: THICKNESS } );
		for ( const [ key, item ] of Object.entries( UNDERGROUND_ARTIFACT_CATALOG ) ) {

			const values = first.artifacts[ key ];
			assert.ok( values instanceof Float32Array );
			assert.equal( values.length, item.capacity * 8 );
			assert.deepEqual( values, repeated.artifacts[ key ] );
			let previousRank = - Infinity;
			for ( let offset = 0; offset < values.length; offset += 8 ) {

				assert.ok( values[ offset + 1 ] < 0 && values[ offset + 1 ] >= - THICKNESS );
				assert.ok( values[ offset + 6 ] >= 0 && values[ offset + 6 ] <= 1 );
				assert.ok( values[ offset + 7 ] >= previousRank,
					'frequency rank order makes lower densities a stable subset' );
				previousRank = values[ offset + 7 ];

			}

		}

	} );

	test( 'UNDERGROUND-VISUAL-011 dimensions stay finite and within UI bounds', () => {

		for ( const seed of [ 0, 0.25, 0.5, 0.75, 1 ] ) {

			assert.equal( artifactScale( 0, 1, seed ), 0 );
			const value = artifactScale( 2.5, 1, seed );
			assert.ok( Number.isFinite( value ) && value >= 0 && value <= 2.5 );

		}

	} );

	test( 'UNDERGROUND-VISUAL-PERF-001 fixes six draws and a strict triangle ceiling', () => {

		assert.deepEqual( UNDERGROUND_VISUAL_BUDGET.drawCalls, {
			soil: 1,
			clods: 1,
			roots: 1,
			rock: 1,
			bone: 1,
			fishBone: 1,
		} );
		assert.equal( UNDERGROUND_VISUAL_BUDGET.estimatedTriangles,
			12
			+ UNDERGROUND_VISUAL_BUDGET.clods * 20
			+ UNDERGROUND_VISUAL_BUDGET.rootSegments * 20
			+ Object.values( UNDERGROUND_ARTIFACT_CATALOG ).reduce(
				( total, item ) => total + item.capacity * item.triangles, 0 ) );
		assert.ok( UNDERGROUND_VISUAL_BUDGET.estimatedTriangles <= 200_000 );

	} );

} );
