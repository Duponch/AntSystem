import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildChameleonSurfaceCollider,
} from '../src/chameleon-surface-collider.js';
import {
	buildChameleonSurfacePatches,
	floodChameleonSurfaceComponent,
} from '../src/chameleon-surface-patches.js';

function attribute( values, itemSize = 3 ) {

	return {
		array: new Float32Array( values ),
		itemSize,
		count: values.length / itemSize,
		getX( index ) { return this.array[ index * itemSize ]; },
		getY( index ) { return this.array[ index * itemSize + 1 ]; },
		getZ( index ) { return this.array[ index * itemSize + 2 ]; },
	};

}

function registryFromTriangles( positions ) {

	const position = attribute( positions );
	const geometry = {
		drawRange: { start: 0, count: Infinity },
		getAttribute: ( name ) => name === 'position' ? position : null,
		getIndex: () => null,
	};
	return [ {
		model: 'Log_01',
		category: 'obstacles',
		mesh: { geometry },
		placements: [ { x: 0, y: 0, z: 0, yaw: 0, scale: 1 } ],
	} ];

}

function appendQuad( positions, x, z, size = 1, y = 0 ) {

	const x1 = x + size;
	const z1 = z + size;
	positions.push(
		x, y, z, x1, y, z1, x1, y, z,
		x, y, z, x, y, z1, x1, y, z1,
	);

}

function gridPositions( width, height, {
	offsetX = 0,
	offsetZ = 0,
	cellSize = 1,
} = {} ) {

	const positions = [];
	for ( let row = 0; row < height; row ++ ) {

		for ( let column = 0; column < width; column ++ ) {

			appendQuad(
				positions,
				offsetX + column * cellSize,
				offsetZ + row * cellSize,
				cellSize,
			);

		}

	}
	return positions;

}

function tBranchPositions() {

	const positions = [];
	for ( const [ x, z ] of [
		[ 0, 0 ], [ 1, 0 ], [ 2, 0 ], [ 3, 0 ], [ 4, 0 ],
		[ 2, 1 ], [ 2, 2 ], [ 2, 3 ], [ 2, 4 ],
	] ) appendQuad( positions, x, z );
	return positions;

}

function cylinderPositions( segments = 24, radius = 2, height = 1.5 ) {

	const positions = [];
	for ( let segment = 0; segment < segments; segment ++ ) {

		const angleA = segment / segments * Math.PI * 2;
		const angleB = ( segment + 1 ) / segments * Math.PI * 2;
		const ax = Math.cos( angleA ) * radius;
		const az = Math.sin( angleA ) * radius;
		const bx = Math.cos( angleB ) * radius;
		const bz = Math.sin( angleB ) * radius;
		positions.push(
			ax, 0, az, bx, height, bz, bx, 0, bz,
			ax, 0, az, ax, height, az, bx, height, bz,
		);

	}
	return positions;

}

function buildCollider( positions ) {

	return buildChameleonSurfaceCollider( registryFromTriangles( positions ), {
		groundY: - 10,
		defaultMaxDistance: 20,
		weldEpsilon: 1e-5,
	} );

}

function adjacent( collider, triangle, neighbour ) {

	for (
		let ordinal = collider.adjacencyOffsets[ triangle ];
		ordinal < collider.adjacencyOffsets[ triangle + 1 ];
		ordinal ++
	) {

		if ( collider.adjacencyTriangles[ ordinal ] === neighbour ) return true;

	}
	return false;

}

function sharedEdgeMidpoint( collider, triangle, neighbour ) {

	const vertices = ( id ) => [
		[ collider.ax[ id ], collider.ay[ id ], collider.az[ id ] ],
		[ collider.bx[ id ], collider.by[ id ], collider.bz[ id ] ],
		[ collider.cx[ id ], collider.cy[ id ], collider.cz[ id ] ],
	];
	const a = vertices( triangle );
	const b = vertices( neighbour );
	const shared = [];
	for ( const vertexA of a ) {

		if ( b.some( ( vertexB ) => Math.hypot(
			vertexA[ 0 ] - vertexB[ 0 ],
			vertexA[ 1 ] - vertexB[ 1 ],
			vertexA[ 2 ] - vertexB[ 2 ],
		) < 1e-5 ) ) shared.push( vertexA );

	}
	assert.equal( shared.length, 2, `${ triangle } and ${ neighbour } must share one edge` );
	return [
		( shared[ 0 ][ 0 ] + shared[ 1 ][ 0 ] ) * 0.5,
		( shared[ 0 ][ 1 ] + shared[ 1 ][ 1 ] ) * 0.5,
		( shared[ 0 ][ 2 ] + shared[ 1 ][ 2 ] ) * 0.5,
	];

}

function triangleCentroid( collider, triangle ) {

	return [
		( collider.ax[ triangle ] + collider.bx[ triangle ] + collider.cx[ triangle ] ) / 3,
		( collider.ay[ triangle ] + collider.by[ triangle ] + collider.cy[ triangle ] ) / 3,
		( collider.az[ triangle ] + collider.bz[ triangle ] + collider.cz[ triangle ] ) / 3,
	];

}

function edgePathCost( collider, triangle, parent ) {

	const a = triangleCentroid( collider, triangle );
	const b = triangleCentroid( collider, parent );
	const midpoint = sharedEdgeMidpoint( collider, triangle, parent );
	return Math.hypot(
		a[ 0 ] - midpoint[ 0 ],
		a[ 1 ] - midpoint[ 1 ],
		a[ 2 ] - midpoint[ 2 ],
	) + Math.hypot(
		b[ 0 ] - midpoint[ 0 ],
		b[ 1 ] - midpoint[ 1 ],
		b[ 2 ] - midpoint[ 2 ],
	);

}

function assertPatchGraphConnected( patches ) {

	const visited = new Uint8Array( patches.patchCount );
	const queue = new Uint32Array( patches.patchCount );
	let read = 0;
	let write = 1;
	queue[ 0 ] = 0;
	visited[ 0 ] = 1;
	while ( read < write ) {

		const patch = queue[ read ++ ];
		for ( let edge = patches.offsets[ patch ]; edge < patches.offsets[ patch + 1 ]; edge ++ ) {

			const next = patches.edgeTo[ edge ];
			if ( visited[ next ] ) continue;
			visited[ next ] = 1;
			queue[ write ++ ] = next;

		}

	}
	assert.equal( write, patches.patchCount );

}
function tracePatchParentPath( collider, patches, triangle, patch ) {

	const path = [ triangle ];
	let current = triangle;
	let cost = 0;
	let steps = 0;
	while ( patches.triangleParent[ current - patches.supportTriangleStart ] >= 0 ) {

		const parent = patches.triangleParent[ current - patches.supportTriangleStart ];
		assert.equal( adjacent( collider, current, parent ), true );
		assert.equal(
			patches.trianglePatch[ parent - patches.supportTriangleStart ],
			patch,
		);
		cost += edgePathCost( collider, current, parent );
		current = parent;
		path.push( current );
		assert.ok( ++ steps <= patches.patchTriangleCount[ patch ] );

	}
	assert.equal( current, patches.patchSeedTriangles[ patch ] );
	assert.ok( Number.isFinite(
		patches.triangleGeodesicDistance[ triangle - patches.supportTriangleStart ],
	) );
	assert.ok( Math.abs(
		cost - patches.triangleGeodesicDistance[ triangle - patches.supportTriangleStart ],
	) < 2e-5 );
	return path;

}

function assertPatchEdgeCorridors( collider, patches ) {

	for ( let patch = 0; patch < patches.patchCount; patch ++ ) {

		for ( let edge = patches.offsets[ patch ]; edge < patches.offsets[ patch + 1 ]; edge ++ ) {

			const destinationPatch = patches.edgeTo[ edge ];
			const sourcePath = tracePatchParentPath(
				collider,
				patches,
				patches.edgeFromTriangle[ edge ],
				patch,
			);
			const destinationPath = tracePatchParentPath(
				collider,
				patches,
				patches.edgeToTriangle[ edge ],
				destinationPatch,
			);
			assert.equal( sourcePath.at( - 1 ), patches.patchSeedTriangles[ patch ] );
			assert.equal( destinationPath.at( - 1 ), patches.patchSeedTriangles[ destinationPatch ] );

		}

	}

}


test( 'CHAMELEON-SURFACE-006 flood and patches exclude disconnected geometry sharing one support', () => {

	const positions = gridPositions( 4, 2 );
	positions.push( ...gridPositions( 2, 1, { offsetX: 12 } ) );
	const collider = buildCollider( positions );
	const component = floodChameleonSurfaceComponent( collider, {
		supportId: 0,
		portal: { x: 0.1, y: 0.5, z: 0.1 },
	} );
	const patches = buildChameleonSurfacePatches( collider, {
		supportId: 0,
		portal: { x: 0.1, y: 0.5, z: 0.1 },
		targetPatchRadius: 1.5,
		maxPatches: 8,
		maxTrianglesPerPatch: 6,
	} );

	assert.equal( component.componentCount, 2 );
	assert.equal( component.reachableTriangleCount, 16 );
	assert.equal( component.excludedTriangleCount, 4 );
	assert.equal( patches.reachableTriangleCount, 16 );
	assert.equal( patches.excludedTriangleCount, 4 );
	assert.ok( patches.patchCount < patches.reachableTriangleCount );
	for ( let local = 0; local < patches.supportTriangleCount; local ++ ) {

		const reachable = component.componentOfTriangle[ local ] === component.seedComponent;
		assert.equal( patches.trianglePatch[ local ] >= 0, reachable );

	}
	assert.equal( patches.telemetry.coverageRatio, 1 );
	assertPatchGraphConnected( patches );

} );

test( 'CHAMELEON-SURFACE-007 welded branches remain reachable and every patch edge crosses a shared face boundary', () => {

	const collider = buildCollider( tBranchPositions() );
	const patches = buildChameleonSurfacePatches( collider, {
		supportId: 0,
		portal: { x: 0.05, y: 0.4, z: 0.05 },
		targetPatchRadius: 1.1,
		maxPatches: 10,
		maxTrianglesPerPatch: 5,
	} );

	assert.equal( patches.reachableTriangleCount, 18 );
	assert.equal( patches.excludedTriangleCount, 0 );
	assertPatchEdgeCorridors( collider, patches );
	assert.ok( Math.max( ...patches.x ) > 3 );
	assert.ok( Math.max( ...patches.z ) > 2 );
	assertPatchGraphConnected( patches );

	for ( let patch = 0; patch < patches.patchCount; patch ++ ) {

		for ( let edge = patches.offsets[ patch ]; edge < patches.offsets[ patch + 1 ]; edge ++ ) {

			const fromTriangle = patches.edgeFromTriangle[ edge ];
			const toTriangle = patches.edgeToTriangle[ edge ];
			assert.equal( adjacent( collider, fromTriangle, toTriangle ), true );
			assert.equal(
				patches.trianglePatch[ fromTriangle - patches.supportTriangleStart ],
				patch,
			);
			assert.equal(
				patches.trianglePatch[ toTriangle - patches.supportTriangleStart ],
				patches.edgeTo[ edge ],
			);
			const midpoint = sharedEdgeMidpoint( collider, fromTriangle, toTriangle );
			assert.ok( Math.hypot(
				patches.portalX[ edge ] - midpoint[ 0 ],
				patches.portalY[ edge ] - midpoint[ 1 ],
				patches.portalZ[ edge ] - midpoint[ 2 ],
			) < 1e-6 );

		}

	}

} );

test( 'CHAMELEON-SURFACE-008 adaptive clustering honours a strict budget and is byte-deterministic', () => {

	const collider = buildCollider( gridPositions( 30, 20, { cellSize: 0.35 } ) );
	const options = {
		supportId: 0,
		seedTriangle: 0,
		targetPatchRadius: 0.001,
		maxPatches: 24,
		maxTrianglesPerPatch: 64,
	};
	const a = buildChameleonSurfacePatches( collider, options );
	const b = buildChameleonSurfacePatches( collider, options );

	assert.equal( a.reachableTriangleCount, 1200 );
	assert.ok( a.patchCount <= 24 );
	assert.equal( a.telemetry.usedTreePartition, true );
	assert.ok( a.patchCount < a.reachableTriangleCount );
	assert.ok( Number.isFinite( a.telemetry.effectivePatchRadius ) );
	assert.ok( a.telemetry.adaptationAttempts > 1 );
	assert.ok( a.telemetry.maximumTriangleCount <= 64 );
	assert.ok( a.telemetry.compressionRatio <= 24 / 1200 );
	for ( const key of [
		'x', 'y', 'z', 'normalX', 'normalY', 'normalZ',
		'patchSeedTriangles', 'patchTriangleCount', 'patchArea',
		'patchMaxGeodesicRadius', 'trianglePatch', 'triangleParent',
		'triangleGeodesicDistance', 'patchTriangleOffsets', 'patchTriangles',
		'offsets', 'edgeTo', 'edgeWeight', 'portalX', 'portalY', 'portalZ',
		'edgeFromTriangle', 'edgeToTriangle',
	] ) assert.deepEqual( a[ key ], b[ key ], `${ key } changed between identical bakes` );
	for ( const triangle of a.reachableTriangles ) {

		const local = triangle - a.supportTriangleStart;
		tracePatchParentPath( collider, a, triangle, a.trianglePatch[ local ] );

	}

	assert.throws( () => buildChameleonSurfacePatches( collider, {
		...options,
		maxPatches: 4,
		maxTrianglesPerPatch: 64,
	} ), /cannot cover/u );

} );

test( 'CHAMELEON-SURFACE-009 every curved-surface triangle has a bounded adjacent parent path to its patch seed', () => {

	const collider = buildCollider( cylinderPositions( 32 ) );
	const patches = buildChameleonSurfacePatches( collider, {
		supportId: 0,
		portal: { x: 2.2, y: 0.1, z: 0 },
		targetPatchRadius: 1.15,
		maxPatches: 20,
		maxTrianglesPerPatch: 10,
	} );

	assert.equal( patches.reachableTriangleCount, 64 );
	assert.ok( Math.min( ...patches.normalX ) < - 0.8 );
	assert.ok( Math.max( ...patches.normalX ) > 0.8 );
	assertPatchGraphConnected( patches );

	for ( const triangle of patches.reachableTriangles ) {

		const local = triangle - patches.supportTriangleStart;
		const patch = patches.trianglePatch[ local ];
		assert.ok( patch >= 0 );
		let current = triangle;
		let cost = 0;
		let steps = 0;
		while ( patches.triangleParent[ current - patches.supportTriangleStart ] >= 0 ) {

			const parent = patches.triangleParent[ current - patches.supportTriangleStart ];
			assert.equal( adjacent( collider, current, parent ), true );
			assert.equal(
				patches.trianglePatch[ parent - patches.supportTriangleStart ],
				patch,
			);
			cost += edgePathCost( collider, current, parent );
			current = parent;
			assert.ok( ++ steps <= patches.patchTriangleCount[ patch ] );

		}
		assert.equal( current, patches.patchSeedTriangles[ patch ] );
		assert.ok( Math.abs(
			cost - patches.triangleGeodesicDistance[ local ],
		) < 2e-5 );
		assert.ok(
			cost <= patches.telemetry.effectivePatchRadius + 2e-5,
			`${ cost } exceeded ${ patches.telemetry.effectivePatchRadius }`,
		);

	}
	assert.equal(
		patches.telemetry.maximumGeodesicRadius,
		Math.max( ...patches.patchMaxGeodesicRadius ),
	);

} );
