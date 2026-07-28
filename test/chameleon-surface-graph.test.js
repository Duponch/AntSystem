import assert from 'node:assert/strict';
import test from 'node:test';

import {
	CHAMELEON_CORRIDOR_MAX_SAMPLES,
	CHAMELEON_SURFACE_CLASS,
	CHAMELEON_SURFACE_KIND,
	ChameleonSurfaceGraphBaker,
	ChameleonSurfaceRouter,
	buildChameleonSurfaceGraph,
	findChameleonSurfacePath,
	isChameleonGroundPointClear,
	planChameleonRoute,
} from '../src/chameleon-surface-graph.js';

function attribute( vertices ) {

	return {
		count: vertices.length,
		getX: ( index ) => vertices[ index ][ 0 ],
		getY: ( index ) => vertices[ index ][ 1 ],
		getZ: ( index ) => vertices[ index ][ 2 ],
	};

}

function geometryVertices( halfX, height, halfZ, tree = false ) {

	const vertices = [];
	const levels = tree ? [ 0, 0.08, 0.18, 0.45, 0.72, 1 ] : [ 0, height * 0.45, height ];
	for ( const y of levels ) {

		const canopy = tree && y > 0.62 ? 2.2 : 1;
		for ( const x of [ - halfX * canopy, 0, halfX * canopy ] ) {

			for ( const z of [ - halfZ * canopy, 0, halfZ * canopy ] ) {

				vertices.push( [ x, tree ? y : y, z ] );

			}

		}

	}
	return vertices;

}

function entry( model, category, placements, {
	halfX = 0.28,
	height = 0.5,
	halfZ = 0.5,
	tree = false,
} = {} ) {

	const positions = attribute( geometryVertices( halfX, height, halfZ, tree ) );
	return {
		model,
		category,
		placements,
		mesh: {
			geometry: {
				getAttribute: ( name ) => name === 'position' ? positions : null,
			},
		},
	};

}

function fullRegistryFixture() {

	return [
		entry( 'Log_01', 'obstacles', [
			{ x: - 24, z: - 12, yaw: 0.35, scale: 7, tag: 'chameleon-host' },
		] ),
		entry( 'Log_02', 'obstacles', [ { x: 0, z: - 24, yaw: 1.1, scale: 6 } ] ),
		entry( 'Branch', 'obstacles', [ { x: 24, z: - 13, yaw: - 0.5, scale: 5 } ], {
			height: 0.35,
		} ),
		entry( 'Stump_01', 'obstacles', [ { x: - 27, z: 8, yaw: 0.4, scale: 2.2 } ], {
			halfX: 0.46, height: 1, halfZ: 0.42,
		} ),
		entry( 'BigRock_03', 'obstacles', [ { x: - 7, z: 4, yaw: 0.2, scale: 2.6 } ], {
			halfX: 0.48, height: 0.72, halfZ: 0.5,
		} ),
		...[
			[ 'Rock_01', 8, 4 ], [ 'Rock_02', 20, 7 ], [ 'Rock_03', - 17, 25 ],
			[ 'Rock_04', 0, 25 ], [ 'Rock_05', 18, 25 ],
		].map( ( [ model, x, z ], index ) => entry(
			model,
			'rocks',
			[ { x, z, yaw: index * 0.41, scale: 1.4 + index * 0.08 } ],
			{ halfX: 0.5, height: 0.55, halfZ: 0.43 },
		) ),
		...[
			[ 'Tree_01', - 38, - 31 ], [ 'Tree_02', 36, - 30 ],
			[ 'Tree_06', - 38, 33 ], [ 'Tree_07', 37, 32 ],
			[ 'Tree_08', 30, 4 ],
		].map( ( [ model, x, z ], index ) => entry(
			model,
			'trees',
			[ { x, z, yaw: index * 0.37, scale: 9 + index } ],
			{ halfX: 0.13, height: 1, halfZ: 0.15, tree: true },
		) ),
	];

}

function support( graph, model ) {

	const result = graph.supports.find( ( candidate ) => candidate.model === model );
	assert.ok( result, `missing ${ model } support` );
	return result;

}

function assertFrameContract( corridor ) {

	assert.ok( corridor.count >= 2 );
	assert.ok( corridor.count <= CHAMELEON_CORRIDOR_MAX_SAMPLES );
	for ( let index = 0; index < corridor.count; index ++ ) {

		const tangentLength = Math.hypot(
			corridor.tangentX[ index ],
			corridor.tangentY[ index ],
			corridor.tangentZ[ index ],
		);
		const normalLength = Math.hypot(
			corridor.normalX[ index ],
			corridor.normalY[ index ],
			corridor.normalZ[ index ],
		);
		const dot = Math.abs(
			corridor.tangentX[ index ] * corridor.normalX[ index ]
			+ corridor.tangentY[ index ] * corridor.normalY[ index ]
			+ corridor.tangentZ[ index ] * corridor.normalZ[ index ],
		);
		assert.ok( Math.abs( tangentLength - 1 ) < 1e-5 );
		assert.ok( Math.abs( normalLength - 1 ) < 1e-5 );
		assert.ok( dot < 1e-5 );
		if ( index > 0 ) assert.ok( corridor.distance[ index ] > corridor.distance[ index - 1 ] );

	}

}

test( 'CHAMELEON-SURFACE-001 bakes every supported placement without the former 8-object or 512-sample ceiling', () => {

	const graph = buildChameleonSurfaceGraph( fullRegistryFixture(), {
		worldSize: 90,
		terrainSpacing: 5.5,
	} );
	assert.equal( graph.supportCount, 15 );
	assert.ok( graph.count > 512 );
	assert.ok( graph.count <= 8192 );
	assert.deepEqual(
		new Set( graph.supports.map( ( candidate ) => candidate.model ) ),
		new Set( [
			'Log_01', 'Log_02', 'Branch', 'Stump_01', 'BigRock_03',
			'Rock_01', 'Rock_02', 'Rock_03', 'Rock_04', 'Rock_05',
			'Tree_01', 'Tree_02', 'Tree_06', 'Tree_07', 'Tree_08',
		] ),
	);
	for ( const candidate of graph.supports ) {

		assert.ok( candidate.portals.length >= 1 );
		assert.ok( candidate.portalTerrainNodes.every( ( node ) => node >= 0 ) );

	}
	const tree = support( graph, 'Tree_08' );
	assert.equal( tree.surfaceClass, CHAMELEON_SURFACE_CLASS.TREE );
	assert.ok( graph.y[ tree.nodeEnd ] - graph.y[ tree.nodeStart ] > 4 );
	assert.ok( Math.abs( graph.normalY[ tree.nodeEnd ] ) < 0.1 );

} );

test( 'CHAMELEON-SURFACE-002 terrain, rock, horizontal trunk and vertical tree routes are continuous SoA corridors', () => {

	const graph = buildChameleonSurfaceGraph( fullRegistryFixture(), {
		worldSize: 90,
		terrainSpacing: 5.5,
	} );
	const terrain = graph.destinationNodes[ graph.destinationNodes.length - 1 ];
	const rock = support( graph, 'Rock_02' ).destinationNode;
	const log = support( graph, 'Branch' ).destinationNode;
	const tree = support( graph, 'Tree_08' ).destinationNode;
	const terrainToRock = planChameleonRoute( graph, terrain, rock );
	const rockToLog = planChameleonRoute( graph, rock, log );
	const logToTree = planChameleonRoute( graph, log, tree );

	for ( const corridor of [ terrainToRock, rockToLog, logToTree ] ) {

		assertFrameContract( corridor );
		assert.equal( corridor.supports, graph.supports );
		assert.ok( corridor.kind.includes( CHAMELEON_SURFACE_KIND.TERRAIN ) );
		assert.ok( corridor.kind.includes( CHAMELEON_SURFACE_KIND.TRANSITION ) );
		assert.ok( corridor.kind.includes( CHAMELEON_SURFACE_KIND.SUPPORT ) );

	}
	assert.equal( terrainToRock.x[ terrainToRock.count - 1 ], rockToLog.x[ 0 ] );
	assert.equal( terrainToRock.y[ terrainToRock.count - 1 ], rockToLog.y[ 0 ] );
	assert.equal( terrainToRock.z[ terrainToRock.count - 1 ], rockToLog.z[ 0 ] );
	assert.equal( rockToLog.x[ rockToLog.count - 1 ], logToTree.x[ 0 ] );
	assert.equal( rockToLog.y[ rockToLog.count - 1 ], logToTree.y[ 0 ] );
	assert.equal( rockToLog.z[ rockToLog.count - 1 ], logToTree.z[ 0 ] );

} );

test( 'CHAMELEON-SURFACE-003 terrain graph and interpolated edges preserve clearance for the adversarial rock fixture', () => {

	const obstaclePlacements = [
		{ x: 0.754581755027175, z: 4.273510901257396, scale: 3.9934467875864357 },
		{ x: - 8.358522355556488, z: 3.0569943180307746, scale: 1.0185469014104456 },
		{ x: - 7.9710869723930955, z: - 0.6362930294126272, scale: 2.703962559113279 },
		{ x: 5.240591405890882, z: - 2.226333210244775, scale: 3.0889782102312893 },
		{ x: - 5.120639828965068, z: 4.2650741608813405, scale: 5.641175563447177 },
		{ x: - 9.972439692355692, z: - 0.002293931320309639, scale: 1.2720753639005125 },
	];
	const registry = [
		entry( 'Log_01', 'obstacles', [
			{ x: - 12, z: 0, yaw: 1.4800634674528261, scale: 5, tag: 'chameleon-host' },
		] ),
		entry( 'Log_02', 'obstacles', [
			{ x: 12, z: 0, yaw: - 0.1229441781242195, scale: 5 },
		] ),
		entry( 'BigRock_03', 'obstacles', obstaclePlacements ),
	];
	const graph = buildChameleonSurfaceGraph( registry, {
		worldSize: 50,
		terrainSpacing: 3.5,
		groundClearance: 0.42,
		collisionProbeSpacing: 0.12,
	} );

	for ( let node = 0; node < graph.count; node ++ ) {

		if ( graph.kind[ node ] !== CHAMELEON_SURFACE_KIND.TERRAIN ) continue;
		assert.ok( isChameleonGroundPointClear( graph, graph.x[ node ], graph.z[ node ] ) );
		for ( let edge = graph.offsets[ node ]; edge < graph.offsets[ node + 1 ]; edge ++ ) {

			const next = graph.edgeTo[ edge ];
			if ( graph.kind[ next ] !== CHAMELEON_SURFACE_KIND.TERRAIN ) continue;
			for ( let ordinal = 0; ordinal <= 40; ordinal ++ ) {

				const alpha = ordinal / 40;
				assert.ok( isChameleonGroundPointClear(
					graph,
					graph.x[ node ] + ( graph.x[ next ] - graph.x[ node ] ) * alpha,
					graph.z[ node ] + ( graph.z[ next ] - graph.z[ node ] ) * alpha,
				) );

			}

		}

	}
	const route = planChameleonRoute(
		graph,
		support( graph, 'Log_01' ).destinationNode,
		support( graph, 'Log_02' ).destinationNode,
	);
	assertFrameContract( route );

} );

test( 'CHAMELEON-SURFACE-004 revision/config cache never rebakes in the frame hot path', () => {

	const registry = fullRegistryFixture();
	const baker = new ChameleonSurfaceGraphBaker();
	const first = baker.update( registry, {
		revision: 4,
		worldSize: 90,
		scales: { obstacles: 1, trees: 1, rocks: 1 },
	} );
	assert.equal( first.rebuilt, true );
	const same = baker.update( registry, {
		revision: 4,
		worldSize: 90,
		scales: { obstacles: 1, trees: 1, rocks: 1 },
	} );
	assert.equal( same.rebuilt, false );
	assert.equal( same.graph, first.graph );
	assert.equal( baker.bakeCount, 1 );
	assert.equal( baker.update( registry, {
		revision: 5,
		worldSize: 90,
		scales: { obstacles: 1, trees: 1, rocks: 1 },
	} ).rebuilt, true );
	assert.equal( baker.update( registry, {
		revision: 5,
		worldSize: 90,
		scales: { obstacles: 1, trees: 1.1, rocks: 1 },
	} ).rebuilt, true );
	assert.equal( baker.update( registry, {
		revision: 5,
		worldSize: 90,
		scales: { obstacles: 1, trees: 1.1, rocks: 0.9 },
	} ).rebuilt, true );
	assert.equal( baker.bakeCount, 4 );

} );

test( 'CHAMELEON-SURFACE-005 local exploration is deterministic, continuous and biased toward little-visited branches', () => {

	const graph = buildChameleonSurfaceGraph( fullRegistryFixture(), {
		worldSize: 90,
		terrainSpacing: 5.5,
	} );
	const a = new ChameleonSurfaceRouter( graph, {
		seed: 12345,
		horizonDistance: 9,
	} );
	const b = new ChameleonSurfaceRouter( graph, {
		seed: 12345,
		horizonDistance: 9,
	} );
	assert.equal( typeof a.update, 'undefined' );
	const firstA = a.exploreNext( 90 );
	const firstB = b.exploreNext( 90 );
	assert.deepEqual( firstA.x, firstB.x );
	assert.deepEqual( firstA.y, firstB.y );
	assert.deepEqual( firstA.z, firstB.z );
	assert.deepEqual( a.visitCounts, b.visitCounts );
	assertFrameContract( firstA );

	const second = a.exploreNext( 90 );
	assertFrameContract( second );
	assert.equal( firstA.x[ firstA.count - 1 ], second.x[ 0 ] );
	assert.equal( firstA.y[ firstA.count - 1 ], second.y[ 0 ] );
	assert.equal( firstA.z[ firstA.count - 1 ], second.z[ 0 ] );
	assert.equal( a.routeCount, 2 );
	assert.equal( a.explorationCount, 2 );
	assert.ok( a.visitCounts.some( ( count ) => count > 0 ) );

	const tinyRadius = new ChameleonSurfaceRouter( graph, { seed: 9 } );
	assert.ok( tinyRadius.routeNext( 2 ).count >= 2 );
	assert.equal( findChameleonSurfacePath(
		graph,
		support( graph, 'Rock_01' ).destinationNode,
		support( graph, 'Tree_01' ).destinationNode,
	)[ 0 ], support( graph, 'Rock_01' ).destinationNode );

} );
