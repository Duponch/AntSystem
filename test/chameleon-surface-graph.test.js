import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
import { createChameleonSurfaceHit } from '../src/chameleon-surface-collider.js';

async function loadShippedRuntimeGeometry( name, fit ) {

	const assetUrl = new URL( `../public/assets/${ name }.fbx`, import.meta.url );
	const bytes = await readFile( assetUrl );
	const arrayBuffer = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	);
	const originalTextureLoad = THREE.TextureLoader.prototype.load;
	THREE.TextureLoader.prototype.load = function loadTextureStub() {

		return new THREE.Texture();

	};
	let source;
	try {

		source = new FBXLoader().parse(
			arrayBuffer,
			new URL( '../public/assets/', import.meta.url ).href,
		);

	} finally {

		THREE.TextureLoader.prototype.load = originalTextureLoad;

	}
	source.updateMatrixWorld( true );
	const parts = [];
	source.traverse( ( object ) => {

		if ( ! object.isMesh ) return;
		const geometry = object.geometry.clone();
		geometry.applyMatrix4( object.matrixWorld );
		geometry.clearGroups();
		for ( const key of Object.keys( geometry.attributes ) ) {

			if ( key !== 'position' && key !== 'normal' && key !== 'uv' )
				geometry.deleteAttribute( key );

		}
		parts.push( geometry );

	} );
	assert.ok( parts.length > 0, `${ name } has no runtime mesh` );
	const geometry = parts.length > 1 ? mergeGeometries( parts, false ) : parts[ 0 ];
	assert.ok( geometry, `${ name } runtime geometry could not be merged` );
	geometry.computeBoundingBox();
	const bounds = geometry.boundingBox;
	const size = new THREE.Vector3();
	bounds.getSize( size );
	const normalisation = 1 / ( fit === 'length' ? size.z : size.y );
	geometry.translate(
		- ( bounds.min.x + bounds.max.x ) * 0.5,
		- bounds.min.y,
		- ( bounds.min.z + bounds.max.z ) * 0.5,
	);
	geometry.scale( normalisation, normalisation, normalisation );
	return geometry;

}

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

function packedAttribute( values, itemSize, Type = Float32Array ) {

	const array = new Type( values );
	return {
		array,
		itemSize,
		count: array.length / itemSize,
		getX( index ) { return array[ index * itemSize ]; },
		getY( index ) { return array[ index * itemSize + 1 ]; },
		getZ( index ) { return array[ index * itemSize + 2 ]; },
	};

}

function boxGeometry( halfX, height, halfZ ) {

	const position = packedAttribute( [
		- halfX, 0, - halfZ, halfX, 0, - halfZ,
		halfX, height, - halfZ, - halfX, height, - halfZ,
		- halfX, 0, halfZ, halfX, 0, halfZ,
		halfX, height, halfZ, - halfX, height, halfZ,
	], 3 );
	const index = packedAttribute( [
		0, 2, 1, 0, 3, 2,
		4, 5, 6, 4, 6, 7,
		0, 4, 7, 0, 7, 3,
		1, 2, 6, 1, 6, 5,
		0, 1, 5, 0, 5, 4,
		3, 7, 6, 3, 6, 2,
	], 1, Uint16Array );
	return {
		attributes: { position },
		index,
		drawRange: { start: 0, count: Infinity },
		getAttribute( name ) { return this.attributes[ name ] || null; },
		getIndex() { return this.index; },
	};


}
function disconnectedBoxesGeometry() {

	const first = boxGeometry( 0.8, 1, 0.6 );
	const positions = Array.from( first.attributes.position.array );
	const indices = Array.from( first.index.array );
	const vertexCount = first.attributes.position.count;
	for ( let vertex = 0; vertex < vertexCount; vertex ++ ) {

		positions.push(
			first.attributes.position.getX( vertex ) + 4,
			first.attributes.position.getY( vertex ),
			first.attributes.position.getZ( vertex ),
		);

	}
	for ( const index of first.index.array ) indices.push( index + vertexCount );
	const position = packedAttribute( positions, 3 );
	const index = packedAttribute( indices, 1, Uint16Array );
	return {
		attributes: { position },
		index,
		drawRange: { start: 0, count: Infinity },
		getAttribute( name ) { return this.attributes[ name ] || null; },
		getIndex() { return this.index; },
	};

}

function foldedRibbonGeometry( segments = 36 ) {

	const positions = [];
	const normals = [];
	const indices = [];
	for ( let ordinal = 0; ordinal <= segments; ordinal ++ ) {

		const alpha = ordinal / segments;
		const angle = Math.PI * ( 1 - alpha );
		const x = Math.cos( angle ) * 3;
		const y = Math.sin( angle ) * 2.4;
		let tx = - Math.sin( angle ) * Math.PI;
		let ty = Math.cos( angle ) * - Math.PI * 0.8;
		const tangentLength = Math.hypot( tx, ty ) || 1;
		tx /= tangentLength;
		ty /= tangentLength;
		let nx = - ty;
		let ny = tx;
		if ( ny < 0 ) { nx = - nx; ny = - ny; }
		positions.push( x, y, - 0.45, x, y, 0.45 );
		normals.push( nx, ny, 0, nx, ny, 0 );
		if ( ordinal >= segments ) continue;
		const a = ordinal * 2;
		indices.push( a, a + 3, a + 1, a, a + 2, a + 3 );

	}
	const position = packedAttribute( positions, 3 );
	const normal = packedAttribute( normals, 3 );
	const index = packedAttribute( indices, 1, Uint16Array );
	return {
		attributes: { position, normal },
		index,
		drawRange: { start: 0, count: Infinity },
		getAttribute( name ) { return this.attributes[ name ] || null; },
		getIndex() { return this.index; },
	};

}

function singleGeometryRegistry( geometry, {
	model = 'Log_01',
	placement = { x: 0, y: 0.018, z: 0, scale: 1, tag: 'chameleon-host' },
} = {} ) {

	return [ {
		model,
		category: 'obstacles',
		placements: [ placement ],
		mesh: { geometry },
	} ];

}

function entry( model, category, placements, {
	halfX = 0.28,
	height = 0.5,
	halfZ = 0.5,
	tree = false,
} = {} ) {

	const geometry = boxGeometry( halfX * ( tree ? 1 : 1 ), height, halfZ * ( tree ? 1 : 1 ) );
	return {
		model,
		category,
		placements,
		mesh: { geometry },
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
	assert.ok( graph.count > graph.terrainNodeCount );
	assert.ok( graph.surfacePatchNodeCount >= graph.supportCount );
	assert.equal( graph.reachableSurfaceTriangleCount, graph.collider.triangleCount );
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

test( 'CHAMELEON-SURFACE-004B a failed rebake preserves the last published cache', () => {

	const validRegistry = fullRegistryFixture();
	const baker = new ChameleonSurfaceGraphBaker();
	const validOptions = {
		revision: 4,
		worldSize: 90,
		scales: { obstacles: 1, trees: 1, rocks: 1 },
	};
	const stable = baker.update( validRegistry, validOptions );
	const stableBakeCount = baker.bakeCount;
	const placements = Array.from( { length: 300 }, ( _, index ) => ( {
		x: ( index % 20 ) * 3 - 28.5,
		y: 0.018,
		z: Math.floor( index / 20 ) * 3 - 21,
		yaw: 0,
		scale: 1,
	} ) );
	const invalidRegistry = [ entry( 'Log_01', 'obstacles', placements ) ];
	assert.throws(
		() => baker.update( invalidRegistry, {
			revision: 5,
			worldSize: 90,
			maximumNodes: 256,
			scales: { obstacles: 1, trees: 1, rocks: 1 },
		} ),
		/surface-wide patch minimum|global support budget|node budget|leaves .* surface patch nodes/u,
	);
	assert.equal( baker.graph, stable.graph );
	assert.equal( baker.registry, validRegistry );
	assert.equal( baker.revision, validOptions.revision );
	assert.equal( baker.bakeCount, stableBakeCount );
	const cached = baker.update( validRegistry, validOptions );
	assert.equal( cached.rebuilt, false );
	assert.equal( cached.graph, stable.graph );

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

test( 'CHAMELEON-SURFACE-005B rejected route proposals restore router history exactly', () => {

	const graph = buildChameleonSurfaceGraph( fullRegistryFixture(), {
		worldSize: 90,
		terrainSpacing: 5.5,
	} );
	const router = new ChameleonSurfaceRouter( graph, {
		seed: 0x51f15e,
		horizonDistance: 9,
	} );
	const before = {
		currentNode: router.currentNode,
		previousNode: router.previousNode,
		pendingTargetNode: router.pendingTargetNode,
		routeCount: router.routeCount,
		destinationCount: router.destinationCount,
		explorationCount: router.explorationCount,
		decisionCount: router.decisionCount,
		visitCounts: router.visitCounts.slice(),
	};
	router.beginProposal();
	const rejected = router.exploreNext( 90 );
	assertFrameContract( rejected );
	assert.equal( router.routeCount, before.routeCount + 1 );
	assert.equal( router.rejectProposal(), true );
	for ( const field of [
		'currentNode', 'previousNode', 'pendingTargetNode', 'routeCount',
		'destinationCount', 'explorationCount', 'decisionCount',
	] ) assert.equal( router[ field ], before[ field ], field );
	assert.deepEqual( router.visitCounts, before.visitCounts );
	assert.equal( router._proposalActive, false );

	// Explicit destination routes share the same transactional visit history.
	const explicitTarget = support( graph, 'Tree_01' ).destinationNode;
	router.beginProposal();
	const directRejected = router.routeTo( explicitTarget );
	assertFrameContract( directRejected );
	assert.equal( router.rejectProposal(), true );
	for ( const field of [
		'currentNode', 'previousNode', 'pendingTargetNode', 'routeCount',
		'destinationCount', 'explorationCount', 'decisionCount',
	] ) assert.equal( router[ field ], before[ field ], 'direct ' + field );
	assert.deepEqual( router.visitCounts, before.visitCounts );

	router.beginProposal();
	const accepted = router.exploreNext( 90 );
	assertFrameContract( accepted );
	assert.equal( router.acceptProposal(), true );
	assert.equal( router.routeCount, before.routeCount + 1 );
	assert.equal( router.explorationCount, before.explorationCount + 1 );
	assert.equal( router._proposalActive, false );
	assert.equal( router.rejectProposal(), false );

} );
test( 'CHAMELEON-SURFACE-006 convex supports and handoffs retain adaptive clearance within the node budget', () => {

	const segments = 28;
	const positions = [];
	const normals = [];
	for ( let ordinal = 0; ordinal <= segments; ordinal ++ ) {

		const angle = ordinal / segments * Math.PI;
		const x = Math.cos( angle ) * 3;
		const y = Math.sin( angle ) * 2;
		const nx = Math.cos( angle ) / 3;
		const ny = Math.sin( angle ) / 2;
		const normalLength = Math.hypot( nx, ny ) || 1;
		positions.push( x, y, - 0.4, x, y, 0.4 );
		normals.push(
			nx / normalLength, ny / normalLength, 0,
			nx / normalLength, ny / normalLength, 0,
		);

	}
	const indices = [];
	for ( let ordinal = 0; ordinal < segments; ordinal ++ ) {

		const a = ordinal * 2;
		const b = a + 1;
		const c = a + 3;
		const d = a + 2;
		indices.push( a, c, b, a, d, c );

	}
	const packed = ( values, itemSize ) => ( {
		array: itemSize === 1 ? new Uint16Array( values ) : new Float32Array( values ),
		itemSize,
		count: values.length / itemSize,
		getX( index ) { return this.array[ index * itemSize ]; },
		getY( index ) { return this.array[ index * itemSize + 1 ]; },
		getZ( index ) { return this.array[ index * itemSize + 2 ]; },
	} );
	const position = packed( positions, 3 );
	const normal = packed( normals, 3 );
	const index = packed( indices, 1 );
	const geometry = {
		attributes: { position, normal },
		index,
		drawRange: { start: 0, count: Infinity },
		getAttribute( name ) { return this.attributes[ name ] || null; },
		getIndex() { return this.index; },
	};
	const registry = [ {
		model: 'Log_01',
		category: 'obstacles',
		placements: [ { x: 0, y: 0.018, z: 0, yaw: 0, scale: 1, tag: 'chameleon-host' } ],
		mesh: { geometry },
	} ];
	const graph = buildChameleonSurfaceGraph( registry, {
		worldSize: 24,
		mapMargin: 1.5,
		terrainSpacing: 3,
		groundClearance: 0.2,
		supportClearance: 0.002,
		objectSamples: 8,
		transitionSamples: 5,
		surfaceChordTolerance: 0.006,
		surfaceMaxSegmentLength: 0.18,
		surfaceSubdivisionDepth: 8,
		maximumNodes: 512,
	} );
	assert.ok( graph.count <= 512 );
	assert.ok( graph.surfaceValidation.validatedTransitionSegments > 0 );
	assert.equal( graph.surfaceComponentCount, 1 );
	assert.equal( graph.reachableSurfaceTriangleCount, segments * 2 );
	assert.equal( graph.excludedSurfaceTriangleCount, 0 );
	assert.ok( graph.surfacePatchNodeCount > 1 );
	const supportMetadata = graph.supports[ 0 ];
	assert.equal( supportMetadata.reachableTriangleCount, segments * 2 );
	assert.equal( supportMetadata.patchCount, graph.surfacePatchNodeCount );
	const terrainNode = supportMetadata.portalTerrainNodes[ 0 ];
	const corridor = planChameleonRoute( graph, supportMetadata.destinationNode, terrainNode );
	assertFrameContract( corridor );
	for ( let index = 0; index < corridor.count; index ++ ) assert.equal(
		corridor.surfaceHit[ index ],
		1,
	);
	let previousTriangle = - 1;
	for ( let index = 0; index < corridor.count; index ++ ) {

		if ( corridor.kind[ index ] !== CHAMELEON_SURFACE_KIND.SUPPORT ) continue;
		const triangle = corridor.triangleId[ index ];
		assert.ok( triangle >= 0 );
		assert.equal( graph.collider.componentId[ triangle ], corridor.componentId[ index ] );
		if ( previousTriangle >= 0 && triangle !== previousTriangle ) {

			const begin = graph.collider.adjacencyOffsets[ previousTriangle ];
			const end = graph.collider.adjacencyOffsets[ previousTriangle + 1 ];
			assert.ok( graph.collider.adjacencyTriangles.subarray( begin, end ).includes( triangle ) );

		}
		previousTriangle = triangle;

	}

} );

test( 'CHAMELEON-SURFACE-007 disconnected mesh islands are excluded and global component ids are preserved', () => {

	const graph = buildChameleonSurfaceGraph(
		singleGeometryRegistry( disconnectedBoxesGeometry() ),
		{ worldSize: 24, terrainSpacing: 3, maximumNodes: 512 },
	);
	const metadata = graph.supports[ 0 ];
	assert.equal( graph.surfaceComponentCount, 2 );
	assert.equal( metadata.reachableTriangleCount, 12 );
	assert.equal( metadata.excludedTriangleCount, 12 );
	assert.equal( graph.reachableSurfaceTriangleCount, 12 );
	assert.equal( graph.excludedSurfaceTriangleCount, 12 );
	for ( let node = 0; node < graph.count; node ++ ) {

		if ( graph.kind[ node ] !== CHAMELEON_SURFACE_KIND.SUPPORT ) continue;
		const triangle = graph.nodeTriangleId[ node ];
		assert.ok( triangle >= 0 );
		assert.equal( graph.componentId[ node ], metadata.componentId );
		assert.equal( graph.collider.componentId[ triangle ], metadata.componentId );

	}

} );

test( 'CHAMELEON-SURFACE-008 folded U routes expand through exact face-adjacent portals and reach the portal node', () => {

	const graph = buildChameleonSurfaceGraph(
		singleGeometryRegistry( foldedRibbonGeometry( 48 ) ),
		{
			worldSize: 24,
			terrainSpacing: 3,
			maximumNodes: 512,
			surfacePatchRadius: 0.28,
			surfacePatchMaxTriangles: 4,
			supportClearance: 0.002,
		},
	);
	const metadata = graph.supports[ 0 ];
	assert.ok( metadata.patchCount > 8 );
	assert.equal( metadata.reachableTriangleCount, 96 );
	const corridor = planChameleonRoute( graph, metadata.destinationNode, metadata.nodeStart );
	assertFrameContract( corridor );
	const last = corridor.count - 1;
	assert.equal( corridor.x[ last ], graph.x[ metadata.nodeStart ] );
	assert.equal( corridor.y[ last ], graph.y[ metadata.nodeStart ] );
	assert.equal( corridor.z[ last ], graph.z[ metadata.nodeStart ] );
	const hit = createChameleonSurfaceHit();
	let previousTriangle = - 1;
	for ( let index = 0; index < corridor.count; index ++ ) {

		assert.equal( corridor.surfaceHit[ index ], 1 );
		const triangle = corridor.triangleId[ index ];
		assert.ok( triangle >= 0 );
		graph.collider.projectPoint(
			corridor.x[ index ], corridor.y[ index ], corridor.z[ index ],
			hit,
			{
				supportId: graph.colliderSupportIds[ 0 ],
				componentId: metadata.componentId,
				includeGround: false,
				clearance: graph.settings.supportClearance,
				maxDistance: Infinity,
				triangleId: triangle,
			},
		);
		assert.equal( hit.hit, true );
		assert.ok( Math.hypot(
			hit.x - corridor.x[ index ],
			hit.y - corridor.y[ index ],
			hit.z - corridor.z[ index ],
		) <= graph.settings.surfaceChordTolerance
			+ graph.settings.supportClearance * 2
			+ 1e-6 );
		if ( previousTriangle >= 0 && triangle !== previousTriangle ) {

			const begin = graph.collider.adjacencyOffsets[ previousTriangle ];
			const end = graph.collider.adjacencyOffsets[ previousTriangle + 1 ];
			assert.ok( graph.collider.adjacencyTriangles.subarray( begin, end ).includes( triangle ) );

		}
		previousTriangle = triangle;

	}

} );

test( 'CHAMELEON-SURFACE-009 corridor compilation fails closed on missing support or changed component', () => {

	const graph = buildChameleonSurfaceGraph(
		singleGeometryRegistry( boxGeometry( 1, 1, 1 ) ),
		{ worldSize: 24, terrainSpacing: 3, maximumNodes: 512 },
	);
	const metadata = graph.supports[ 0 ];
	const target = metadata.portalTerrainNodes[ 0 ];
	const exactSupportId = graph.colliderSupportIds[ 0 ];
	graph.colliderSupportIds[ 0 ] = - 1;
	assert.throws(
		() => planChameleonRoute( graph, metadata.nodeStart, target ),
		/missing support|lost its support\/component/,
	);
	graph.colliderSupportIds[ 0 ] = exactSupportId;
	const componentId = graph.componentId[ metadata.nodeStart ];
	graph.componentId[ metadata.nodeStart ] = componentId + 1000;
	assert.throws(
		() => planChameleonRoute( graph, metadata.nodeStart, target ),
		/lost its support\/component|changed support\/component/,
	);
	graph.componentId[ metadata.nodeStart ] = componentId;

	assert.throws(
		() => planChameleonRoute( graph, metadata.nodeStart, metadata.nodeStart ),
		/two distinct graph nodes/,
	);
} );

test( 'CHAMELEON-SURFACE-010 a right-angle support-ground junction is explicit, local and fully resolved', () => {

	const graph = buildChameleonSurfaceGraph(
		singleGeometryRegistry( boxGeometry( 1.2, 1.4, 0.9 ) ),
		{
			worldSize: 24,
			terrainSpacing: 3,
			maximumNodes: 512,
			supportClearance: 0.002,
			surfaceMaxNormalAngle: Math.PI / 12,
		},
	);
	const metadata = graph.supports[ 0 ];
	const corridor = planChameleonRoute(
		graph,
		metadata.nodeStart,
		metadata.portalTerrainNodes[ 0 ],
	);
	assertFrameContract( corridor );
	let boundary = - 1;
	for ( let index = 0; index < corridor.count; index ++ ) {

		assert.equal( corridor.surfaceHit[ index ], 1 );
		if ( boundary < 0 && corridor.kind[ index ] !== CHAMELEON_SURFACE_KIND.SUPPORT ) boundary = index;

	}
	assert.ok( boundary > 0 );
	assert.ok( Math.hypot(
		corridor.x[ boundary ] - corridor.x[ boundary - 1 ],
		corridor.y[ boundary ] - corridor.y[ boundary - 1 ],
		corridor.z[ boundary ] - corridor.z[ boundary - 1 ],
	) < 0.12 );
	assert.ok( corridor.kind.includes( CHAMELEON_SURFACE_KIND.TERRAIN ) );

} );

test( 'CHAMELEON-SURFACE-011 mandatory geodesic corners fail closed and the stateful router truncates safely', () => {

	const graph = buildChameleonSurfaceGraph(
		singleGeometryRegistry( foldedRibbonGeometry( 72 ) ),
		{
			worldSize: 24,
			terrainSpacing: 3,
			maximumNodes: 512,
			surfacePatchRadius: 0.2,
			surfacePatchMaxTriangles: 4,
			supportClearance: 0.002,
		},
	);
	assert.ok( graph.count <= 512 );
	assert.equal(
		graph.surfaceBudget.terrainNodes
			+ graph.surfaceBudget.actualPatchNodes
			+ graph.surfaceBudget.actualPortalNodes
			+ graph.surfaceBudget.actualTransitionNodes,
		graph.count,
	);
	const metadata = graph.supports[ 0 ];
	const start = metadata.destinationNode;
	const requestedTarget = metadata.portalTerrainNodes[ 0 ];
	assert.throws(
		() => planChameleonRoute( graph, start, requestedTarget, { maxSamples: 32, spacing: 0.2 } ),
		( error ) => error?.code === 'CHAMELEON_CORRIDOR_BUDGET',
	);
	const router = new ChameleonSurfaceRouter( graph, { maxSamples: 32, spacing: 0.2 } );
	const corridor = router.routeTo( requestedTarget, start );
	assert.equal( corridor.truncated, true );
	assert.equal( corridor.requestedTargetNode, requestedTarget );
	assert.notEqual( corridor.targetNode, requestedTarget );
	assert.equal( corridor.targetNode, router.currentNode );
	assert.equal( router.pendingTargetNode, requestedTarget );
	assert.ok( corridor.count <= 32 );
	assert.ok( corridor.mandatoryPointCount <= 32 );
	for ( let index = 0; index < corridor.count; index ++ ) assert.equal( corridor.surfaceHit[ index ], 1 );

} );

test( 'CHAMELEON-SURFACE-012 shipped Tree_07 bakes an exact local portal independently of yaw', async () => {

	const geometry = await loadShippedRuntimeGeometry( 'Tree_07', 'height' );
	const placement = {
		x: 70.67453704319684,
		z: 18.178261201827866,
		yaw: 0.6751668750446875,
		scale: 19.377381544793025,
	};
	const graph = buildChameleonSurfaceGraph( [ {
		model: 'Tree_07',
		category: 'trees',
		placements: [ placement ],
		mesh: { geometry },
	} ], {
		worldSize: 160,
		groundClearance: 0.42,
		supportClearance: 0.006,
		maximumNodes: 512,
	} );

	assert.equal( graph.supportCount, 1 );
	const metadata = graph.supports[ 0 ];
	const exactSupportId = graph.colliderSupportIds[ 0 ];
	assert.ok( exactSupportId >= 0 );
	assert.ok( metadata.componentId >= 0 );
	assert.equal( metadata.colliderSupportId, exactSupportId );
	assert.equal(
		graph.collider.componentId[ graph.nodeTriangleId[ metadata.destinationNode ] ],
		metadata.componentId,
	);

	const corridor = planChameleonRoute(
		graph,
		metadata.destinationNode,
		metadata.portalTerrainNodes[ 0 ],
	);
	assertFrameContract( corridor );
	let boundary = - 1;
	for ( let index = 0; index < corridor.count; index ++ ) {

		assert.equal( corridor.surfaceHit[ index ], 1 );
		if ( corridor.kind[ index ] === CHAMELEON_SURFACE_KIND.SUPPORT ) {

			const triangle = corridor.triangleId[ index ];
			assert.ok( triangle >= 0 );
			assert.equal( graph.collider.supportId[ triangle ], exactSupportId );
			assert.equal( graph.collider.componentId[ triangle ], metadata.componentId );

		} else if ( boundary < 0 ) boundary = index;

	}
	assert.ok( boundary > 0 );
	assert.equal( corridor.kind[ boundary ], CHAMELEON_SURFACE_KIND.TRANSITION );
	assert.ok( Math.hypot(
		corridor.x[ boundary ] - corridor.x[ boundary - 1 ],
		corridor.y[ boundary ] - corridor.y[ boundary - 1 ],
		corridor.z[ boundary ] - corridor.z[ boundary - 1 ],
	) <= 0.121 );
	assert.ok( corridor.kind.includes( CHAMELEON_SURFACE_KIND.TERRAIN ) );
	assert.ok( graph.surfaceValidation.validatedTransitionSegments > 0 );

} );
