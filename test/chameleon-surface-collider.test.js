import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
	buildChameleonSurfaceCollider,
	createChameleonProjectionBuffer,
	createChameleonSurfaceHit,
	createChameleonSurfaceTraceBuffer,
} from '../src/chameleon-surface-collider.js';

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

function geometry( positions, {
	indices = null,
	normals = null,
	drawRange = null,
} = {} ) {

	const attrs = {
		position: attribute( positions ),
		...( normals ? { normal: attribute( normals ) } : {} ),
	};
	return {
		attributes: attrs,
		index: indices ? attribute( indices, 1 ) : null,
		drawRange: drawRange || { start: 0, count: Infinity },
		getAttribute( name ) { return this.attributes[ name ] || null; },
		getIndex() { return this.index; },
	};

}

function entry( model, category, geo, placements ) {

	return {
		model,
		category,
		mesh: { geometry: geo },
		placements,
	};

}

function hitOutput() {

	return createChameleonSurfaceHit();

}

function gridGeometry( width, depth, spacing = 1 ) {

	const positions = [];
	for ( let row = 0; row <= depth; row ++ ) {

		for ( let column = 0; column <= width; column ++ ) {

			positions.push( column * spacing, 0, row * spacing );

		}

	}
	const indices = [];
	const stride = width + 1;
	for ( let row = 0; row < depth; row ++ ) {

		for ( let column = 0; column < width; column ++ ) {

			const a = row * stride + column;
			const b = a + 1;
			const d = a + stride;
			const c = d + 1;
			indices.push( a, c, b, a, d, c );

		}

	}
	return geometry( positions, { indices } );

}

function quarterCylinderGeometry( segments = 24 ) {

	const positions = [];
	const normals = [];
	for ( let ordinal = 0; ordinal <= segments; ordinal ++ ) {

		const angle = ordinal / segments * Math.PI * 0.5;
		const x = Math.cos( angle );
		const y = Math.sin( angle );
		positions.push( x, y, - 1, x, y, 1 );
		normals.push( x, y, 0, x, y, 0 );

	}
	const indices = [];
	for ( let ordinal = 0; ordinal < segments; ordinal ++ ) {

		const a = ordinal * 2;
		const b = a + 1;
		const c = a + 3;
		const d = a + 2;
		indices.push( a, c, b, a, d, c );

	}
	return geometry( positions, { indices, normals } );

}

const CUBE_POSITIONS = [
	- 1, - 1, - 1, 1, - 1, - 1, 1, 1, - 1, - 1, 1, - 1,
	- 1, - 1, 1, 1, - 1, 1, 1, 1, 1, - 1, 1, 1,
];
const CUBE_INDICES = [
	0, 2, 1, 0, 3, 2,
	4, 5, 6, 4, 6, 7,
	0, 4, 7, 0, 7, 3,
	1, 2, 6, 1, 6, 5,
	3, 7, 6, 3, 6, 2,
	0, 1, 5, 0, 5, 4,
];

test( 'CHAMELEON-COLLIDER-001 indexed triangles use exact placement, yaw and category scale transforms', () => {

	const cube = geometry( CUBE_POSITIONS, { indices: CUBE_INDICES } );
	const collider = buildChameleonSurfaceCollider( [
		entry( 'BigRock_03', 'rocks', cube, [
			{ x: 10, y: 2, z: - 4, yaw: Math.PI * 0.5, scale: 2 },
		] ),
	], {
		scales: { rocks: 1.5 },
		groundY: 0,
	} );
	assert.equal( collider.supportCount, 1 );
	assert.equal( collider.triangleCount, 12 );
	assert.equal( collider.supports[ 0 ].scale, 3 );

	const out = hitOutput();
	assert.equal( collider.projectPoint( 10, 6, - 4, out, {
		maxDistance: 5,
		includeGround: true,
	} ), out );
	assert.equal( out.supportId, 0 );
	assert.ok( Math.abs( out.surfaceY - 5 ) < 1e-6 );
	assert.ok( out.ny > 0.999 );
	assert.ok( Math.abs( out.distance - 1 ) < 1e-6 );

	// local +X rotates into world -Z at yaw=+90°.
	collider.projectPoint( 10, 2, - 8, out, { maxDistance: 5 } );
	assert.equal( out.supportId, 0 );
	assert.ok( Math.abs( out.surfaceZ + 7 ) < 1e-6 );
	assert.ok( out.nz < - 0.999 );

} );

test( 'CHAMELEON-COLLIDER-002 non-indexed geometry preserves interpolated normals and world clearance', () => {

	const slope = geometry( [
		0, 0, 0,
		2, 0, 0,
		0, 2, 2,
	], {
		normals: [
			0, 1, 0,
			0, 1, 0,
			0, 0.8, - 0.6,
		],
	} );
	const collider = buildChameleonSurfaceCollider( [
		entry( 'Log_01', 'obstacles', slope, [
			{ x: - 2, y: 1, z: 4, yaw: 0.37, scale: 10 },
		] ),
	], {
		scales: { obstacles: 2 },
	} );
	const out = hitOutput();
	collider.projectPoint( - 2, 1, 4, out, {
		supportId: 0,
		maxDistance: 50,
		clearance: 0.2,
	} );
	assert.equal( out.triangleId, 0 );
	assert.ok( Math.abs( Math.hypot( out.nx, out.ny, out.nz ) - 1 ) < 1e-6 );
	assert.ok( Math.abs( Math.hypot(
		out.x - out.surfaceX,
		out.y - out.surfaceY,
		out.z - out.surfaceZ,
	) - 0.2 ) < 1e-6, 'clearance must not be multiplied by placement/category scale' );

} );

test( 'CHAMELEON-COLLIDER-003 closest points resolve undersides and sides instead of a synthetic top profile', () => {

	const collider = buildChameleonSurfaceCollider( [
		entry(
			'Log_02',
			'obstacles',
			geometry( CUBE_POSITIONS, { indices: CUBE_INDICES } ),
			[ { x: 0, y: 4, z: 0, yaw: 0, scale: 2 } ],
		),
	] );
	const out = hitOutput();
	collider.projectPoint( 0, 1, 0, out, { maxDistance: 3.1 } );
	assert.equal( out.isGround, false );
	assert.ok( Math.abs( out.surfaceY - 2 ) < 1e-6 );
	assert.ok( out.ny < - 0.999, 'underside winding/normal must be retained' );

	collider.projectPoint( 3, 4, 0, out, { maxDistance: 2 } );
	assert.ok( Math.abs( out.surfaceX - 2 ) < 1e-6 );
	assert.ok( out.nx > 0.999 );
	assert.equal( out.supportId, 0 );

} );

test( 'CHAMELEON-COLLIDER-004 nearby support wins over closer ground, while distant queries use ground fallback', () => {

	const plate = geometry( [
		- 1, 0.2, - 1,
		1, 0.2, - 1,
		0, 0.2, 1,
	] );
	const collider = buildChameleonSurfaceCollider( [
		entry( 'Rock_01', 'rocks', plate, [ { x: 0, y: 0, z: 0, scale: 1 } ] ),
	], {
		groundY: 0,
		defaultMaxDistance: 0.5,
	} );
	const out = hitOutput();
	collider.projectPoint( 0, 0.05, 0, out );
	assert.equal( out.isGround, false, 'ground must not mask a nearby prop surface' );
	assert.equal( out.supportId, 0 );

	collider.projectPoint( 20, 0.8, 20, out );
	assert.equal( out.isGround, true );
	assert.equal( out.y, 0 );
	assert.equal( out.distance, 0.8 );

	collider.projectPoint( 0, 0.19, 0, out, { groundOnly: true, clearance: 0.03 } );
	assert.equal( out.isGround, true, 'groundOnly must bypass nearby support triangles' );
	assert.equal( out.y, 0.03 );
	assert.equal( out.visitedNodes, 0 );
	assert.equal( out.testedTriangles, 0 );

	collider.projectPoint( 20, 0.8, 20, out, { includeGround: false } );
	assert.equal( out.hit, false );
	assert.equal( out.distance, Infinity );

} );

test( 'CHAMELEON-COLLIDER-004B explicit Infinity reaches a distant scoped support without ground fallback', () => {

	const elevatedPlate = geometry( [
		- 1, 3, - 1,
		1, 3, - 1,
		0, 3, 1,
	] );
	const collider = buildChameleonSurfaceCollider( [
		entry( 'Rock_02', 'rocks', elevatedPlate, [ { x: 40, y: 0, z: - 20, scale: 1 } ] ),
	], { groundY: 0, defaultMaxDistance: 0.5 } );
	const out = hitOutput();
	const scoped = { supportId: 0, includeGround: true };
	collider.projectPoint( 40, 12, - 20, out, scoped );
	assert.equal( out.hit, false );
	assert.equal( out.isGround, false );
	collider.projectPoint( 40, 12, - 20, out, { ...scoped, maxDistance: Infinity } );
	assert.equal( out.hit, true );
	assert.equal( out.supportId, 0 );
	assert.equal( out.isGround, false );
	assert.equal( out.surfaceX, 40 );
	assert.equal( out.surfaceY, 3 );
	assert.equal( out.surfaceZ, - 20 );
	assert.equal( out.distance, 9 );

} );
test( 'CHAMELEON-COLLIDER-005 welded indexed and non-indexed edges compile deterministic triangle adjacency', () => {

	const squareIndexed = geometry(
		[ 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1 ],
		{ indices: [ 0, 1, 2, 0, 2, 3 ] },
	);
	const squareNonIndexed = geometry( [
		0, 0, 0, 1, 0, 0, 1, 0, 1,
		0, 0, 0, 1, 0, 1, 0, 0, 1,
	] );
	const collider = buildChameleonSurfaceCollider( [
		entry( 'Rock_01', 'rocks', squareIndexed, [ { x: 0, z: 0, scale: 1 } ] ),
		entry( 'Rock_02', 'rocks', squareNonIndexed, [ { x: 3, z: 0, scale: 1 } ] ),
	] );
	assert.equal( collider.triangleCount, 4 );
	for ( const triangle of [ 0, 1, 2, 3 ] ) {

		assert.equal(
			collider.adjacencyOffsets[ triangle + 1 ] - collider.adjacencyOffsets[ triangle ],
			1,
		);

	}
	assert.equal( collider.adjacencyTriangles[ collider.adjacencyOffsets[ 0 ] ], 1 );
	assert.equal( collider.adjacencyTriangles[ collider.adjacencyOffsets[ 2 ] ], 3 );
	assert.ok( collider.edgeNeighbours.some( ( neighbour ) => neighbour >= 0 ) );

} );

test( 'CHAMELEON-COLLIDER-006 point and corridor hot paths retain caller and internal buffer identities', () => {

	const collider = buildChameleonSurfaceCollider( [
		entry(
			'Rock_03',
			'rocks',
			geometry( CUBE_POSITIONS, { indices: CUBE_INDICES } ),
			[ { x: 0, y: 0, z: 0, scale: 1 } ],
		),
	] );
	const out = hitOutput();
	const stack = collider._queryStack;
	const candidateArrays = [
		collider.ax,
		collider.supportId,
		collider.bvh.triangleOrder,
		collider.adjacencyTriangles,
	];
	const hintMarks = collider._hintMarks;
	for ( let index = 0; index < 1000; index ++ ) {

		assert.equal( collider.projectPoint( 0.1, 1.2, 0.1, out ), out );

	}
	assert.equal( collider._queryStack, stack );
	assert.equal( collider.ax, candidateArrays[ 0 ] );
	assert.equal( collider.supportId, candidateArrays[ 1 ] );
	assert.equal( collider.bvh.triangleOrder, candidateArrays[ 2 ] );
	assert.equal( collider.adjacencyTriangles, candidateArrays[ 3 ] );
	assert.equal( collider._hintMarks, hintMarks );

	const corridor = {
		count: 3,
		x: Float32Array.of( - 0.5, 0, 0.5 ),
		y: Float32Array.of( 1.2, 1.2, 1.2 ),
		z: Float32Array.of( 0, 0, 0 ),
		normalX: new Float32Array( 3 ),
		normalY: new Float32Array( 3 ),
		normalZ: new Float32Array( 3 ),
	};
	const projection = createChameleonProjectionBuffer( 3 );
	const projectionX = projection.x;
	assert.equal( collider.projectCorridor( corridor, 0.07, projection ), projection );
	assert.equal( projection.x, projectionX );
	assert.equal( projection.count, 3 );
	assert.deepEqual( [ ...projection.hit ], [ 1, 1, 1 ] );
	assert.ok( projection.distance[ 1 ] > projection.distance[ 0 ] );
	assert.ok( projection.distance[ 2 ] > projection.distance[ 1 ] );
	assert.ok( projection.projectionDistance.every( Number.isFinite ) );
	assert.ok( Math.abs( Math.hypot(
		projection.tangentX[ 1 ], projection.tangentY[ 1 ], projection.tangentZ[ 1 ] ) - 1 ) < 1e-6 );

} );

test( 'CHAMELEON-COLLIDER-007 BVH query work and elapsed time stay bounded on a large fixture', () => {

	const placements = [];
	for ( let z = 0; z < 40; z ++ ) {

		for ( let x = 0; x < 40; x ++ ) {

			placements.push( { x: x * 4, y: 0, z: z * 4, scale: 1 } );

		}

	}
	const collider = buildChameleonSurfaceCollider( [
		entry(
			'Rock_04',
			'rocks',
			geometry( CUBE_POSITIONS, { indices: CUBE_INDICES } ),
			placements,
		),
	], {
		leafSize: 6,
		defaultMaxDistance: 2,
	} );
	assert.equal( collider.triangleCount, 19200 );
	const out = hitOutput();
	const started = performance.now();
	let maximumTests = 0;
	for ( let index = 0; index < 5000; index ++ ) {

		const x = ( index * 17 % 157 ) + 0.13;
		const z = ( index * 29 % 157 ) + 0.27;
		collider.projectPoint( x, 1.4, z, out );
		maximumTests = Math.max( maximumTests, out.testedTriangles );

	}
	const elapsed = performance.now() - started;
	assert.ok( maximumTests < 80, `BVH tested ${ maximumTests } triangles for one query` );
	assert.ok( elapsed < 1500, `5000 queries took ${ elapsed.toFixed( 1 ) } ms` );

} );

test( 'CHAMELEON-COLLIDER-008 coherent triangle hints preserve the exact result and prune local trajectories', () => {

	const collider = buildChameleonSurfaceCollider( [
		entry(
			'Rock_05',
			'rocks',
			gridGeometry( 96, 96, 0.5 ),
			[ { x: - 24, y: 1.7, z: - 24, yaw: 0.18, scale: 1.15 } ],
		),
	], {
		leafSize: 6,
		defaultMaxDistance: Infinity,
	} );
	assert.equal( collider.triangleCount, 96 * 96 * 2 );
	const plain = hitOutput();
	const hinted = hitOutput();
	const plainQuery = {
		supportId: 0,
		maxDistance: Infinity,
		includeGround: false,
		clearance: 0.025,
		triangleId: - 1,
	};
	const hintedQuery = {
		supportId: 0,
		maxDistance: Infinity,
		includeGround: false,
		clearance: 0.025,
		triangleId: - 1,
	};
	const stack = collider._queryStack;
	const marks = collider._hintMarks;
	const adjacency = collider.adjacencyTriangles;
	let plainNodes = 0;
	let hintedNodes = 0;
	let plainTests = 0;
	let hintedTests = 0;
	let acceptedHints = 0;

	for ( let step = 0; step < 900; step ++ ) {

		const x = - 13 + step * 0.018;
		const z = - 7 + Math.sin( step * 0.013 ) * 0.18;
		const y = 2.35 + Math.cos( step * 0.009 ) * 0.015;
		collider.projectPoint( x, y, z, plain, plainQuery );
		collider.projectPoint( x, y, z, hinted, hintedQuery );
		assert.equal( hinted.hit, plain.hit );
		assert.equal( hinted.x, plain.x );
		assert.equal( hinted.y, plain.y );
		assert.equal( hinted.z, plain.z );
		assert.equal( hinted.nx, plain.nx );
		assert.equal( hinted.ny, plain.ny );
		assert.equal( hinted.nz, plain.nz );
		assert.equal( hinted.distanceSq, plain.distanceSq );
		assert.equal( hinted.supportId, plain.supportId );
		assert.equal( hinted.triangleId, plain.triangleId );
		if ( step > 0 ) {

			plainNodes += plain.visitedNodes;
			hintedNodes += hinted.visitedNodes;
			plainTests += plain.testedTriangles;
			hintedTests += hinted.testedTriangles;
			if ( hinted.hintTests > 0 ) acceptedHints ++;

		}
		hintedQuery.triangleId = hinted.triangleId;

	}
	assert.equal( acceptedHints, 899 );
	assert.ok(
		hintedNodes < plainNodes * 0.65,
		`hinted BVH visited ${ hintedNodes } nodes versus ${ plainNodes } without hints`,
	);
	assert.ok(
		hintedTests <= plainTests,
		`hinted path tested ${ hintedTests } triangles versus ${ plainTests } without hints`,
	);
	assert.equal( collider._queryStack, stack );
	assert.equal( collider._hintMarks, marks );
	assert.equal( collider.adjacencyTriangles, adjacency );

	plainQuery.triangleId = - 1;
	hintedQuery.triangleId = collider.triangleCount + 123;
	collider.projectPoint( 0.2, 2.4, - 0.3, plain, plainQuery );
	collider.projectPoint( 0.2, 2.4, - 0.3, hinted, hintedQuery );
	assert.equal( hinted.hintTriangleId, - 1 );
	assert.equal( hinted.hintTests, 0 );
	assert.equal( hinted.triangleId, plain.triangleId );
	assert.equal( hinted.distanceSq, plain.distanceSq );

} );

test( 'CHAMELEON-COLLIDER-009 adaptive trace follows convex relief with bounded chord error and world clearance', () => {

	const collider = buildChameleonSurfaceCollider( [
		entry(
			'Rock_01',
			'rocks',
			geometry( [
				- 1, 0, - 1,
				1, 0, - 1,
				0, 0, 1,
			], {
				normals: [
					0, 1, 0,
					0, 1, 0,
					0, 1, 0,
				],
			} ),
			[ { x: - 20, y: 0, z: - 20, yaw: 0, scale: 1 } ],
		),
		entry(
			'Log_01',
			'obstacles',
			quarterCylinderGeometry( 28 ),
			[ { x: 2, y: 0.7, z: - 3, yaw: 0.31, scale: 2.4 } ],
		),
	], {
		defaultMaxDistance: Infinity,
	} );
	const trace = createChameleonSurfaceTraceBuffer( 257, 8 );
	const query = {
		supportId: 1,
		includeGround: false,
		clearance: 0.04,
		maxDistance: Infinity,
		tolerance: 0.008,
		maxSegmentLength: 0.16,
		maxNormalAngle: Math.PI / 9,
		maxDepth: 8,
	};
	const cos = Math.cos( 0.31 );
	const sin = Math.sin( 0.31 );
	const world = ( localX, localY, localZ ) => [
		2 + ( localX * cos + localZ * sin ) * 2.4,
		0.7 + localY * 2.4,
		- 3 + ( - localX * sin + localZ * cos ) * 2.4,
	];
	const start = world( 1, 0, 0 );
	const end = world( 0, 1, 0 );
	assert.equal(
		collider.traceSegment( ...start, ...end, trace, query ),
		trace,
	);
	assert.equal( trace.valid, true );
	assert.equal( trace.budgetExceeded, false );
	assert.ok( trace.count > 16, `convex arc only produced ${ trace.count } samples` );
	assert.ok( trace.count <= trace.capacity );
	assert.ok( trace.maxChordError <= query.tolerance + 1e-6 );
	assert.ok( trace.maxLeafLength <= query.maxSegmentLength + 1e-6 );

	const physical = hitOutput();
	const physicalQuery = {
		supportId: 1,
		includeGround: false,
		clearance: 0,
		maxDistance: Infinity,
		triangleId: - 1,
	};
	for ( let index = 0; index < trace.count; index ++ ) {

		assert.equal(
			trace.componentId[ index ],
			collider.componentId[ trace.triangleId[ index ] ],
			`sample ${ index } lost its exact non-zero component`,
		);

		physicalQuery.triangleId = trace.triangleId[ index ];
		collider.projectPoint( trace.x[ index ], trace.y[ index ], trace.z[ index ], physical, physicalQuery );
		assert.ok(
			Math.abs( physical.distance - query.clearance ) < 2e-5,
			`sample ${ index } clearance=${ physical.distance }`,
		);
		if ( index === 0 ) continue;
		const middleX = ( trace.x[ index - 1 ] + trace.x[ index ] ) * 0.5;
		const middleY = ( trace.y[ index - 1 ] + trace.y[ index ] ) * 0.5;
		const middleZ = ( trace.z[ index - 1 ] + trace.z[ index ] ) * 0.5;
		physicalQuery.clearance = query.clearance;
		collider.projectPoint( middleX, middleY, middleZ, physical, physicalQuery );
		const projectedChordError = Math.hypot(
			physical.x - middleX,
			physical.y - middleY,
			physical.z - middleZ,
		);
		assert.ok( projectedChordError <= query.tolerance + 2e-5 );
		physicalQuery.clearance = 0;

	}

	const xBuffer = trace.x;
	const workBuffer = trace._stackA;
	collider.traceSegment( ...start, ...end, trace, query );
	assert.equal( trace.x, xBuffer );
	assert.equal( trace._stackA, workBuffer );

	const tiny = createChameleonSurfaceTraceBuffer( 4, 8 );
	collider.traceSegment( ...start, ...end, tiny, {
		...query,
		tolerance: 1e-6,
		maxSegmentLength: 0.01,
	} );
	assert.equal( tiny.valid, false );
	assert.equal( tiny.budgetExceeded, true );
	assert.ok( tiny.count <= tiny.capacity );

} );

test( 'CHAMELEON-COLLIDER-010 component filters prevent jumps between disconnected meshes of one support', () => {

	const separated = geometry( [
		- 5, 0, - 1, - 5, 0, 1, - 3, 0, - 1,
		3, 0, - 1, 5, 0, - 1, 5, 0, 1,
	], {
		normals: [
			0, 1, 0, 0, 1, 0, 0, 1, 0,
			0, 1, 0, 0, 1, 0, 0, 1, 0,
		],
	} );
	const collider = buildChameleonSurfaceCollider( [
		entry( 'Log_01', 'obstacles', separated, [
			{ x: 0, y: 1, z: 0, yaw: 0, scale: 1 },
		] ),
	], { defaultMaxDistance: Infinity } );
	assert.equal( collider.supportCount, 1 );
	assert.equal( collider.componentCount, 2 );
	assert.equal( collider.components.length, 2 );
	assert.deepEqual(
		collider.components.map( ( component ) => component.supportId ),
		[ 0, 0 ],
	);
	assert.deepEqual(
		collider.components.map( ( component ) => component.triangleCount ),
		[ 1, 1 ],
	);

	const hit = hitOutput();
	collider.projectPoint( - 4.4, 2, 0, hit, {
		supportId: 0,
		includeGround: false,
		maxDistance: Infinity,
	} );
	const leftComponent = hit.componentId;
	assert.equal( leftComponent, 0 );

	collider.projectPoint( 4.4, 2, 0, hit, {
		supportId: 0,
		componentId: leftComponent,
		includeGround: false,
		maxDistance: Infinity,
	} );
	assert.equal( hit.hit, true );
	assert.equal( hit.componentId, leftComponent );
	assert.ok( hit.x < 0, `component-filtered query jumped to x=${ hit.x }` );

	const trace = createChameleonSurfaceTraceBuffer( 65, 6 );
	collider.traceSegment( - 4.4, 2, 0, 4.4, 2, 0, trace, {
		supportId: 0,
		includeGround: false,
		clearance: 0.02,
		maxDistance: Infinity,
		tolerance: 0.01,
		maxSegmentLength: 0.25,
		maxNormalAngle: Math.PI / 4,
		maxDepth: 6,
	} );
	assert.equal( trace.valid, true );
	for ( let index = 0; index < trace.count; index ++ ) {

		assert.equal( trace.componentId[ index ], leftComponent );
		assert.ok( trace.x[ index ] < 0 );

	}

} );

test( 'CHAMELEON-COLLIDER-011 trace localises a 90-degree support-ground portal without accepting a chord', () => {

	const wall = geometry( [
		0, 0, - 1,
		0, 2, - 1,
		0, 2, 1,
		0, 0, 1,
	], {
		indices: [ 0, 2, 1, 0, 3, 2 ],
		normals: [
			1, 0, 0,
			1, 0, 0,
			1, 0, 0,
			1, 0, 0,
		],
	} );
	const collider = buildChameleonSurfaceCollider( [
		entry( 'Log_01', 'obstacles', wall, [
			{ x: 0, y: 0, z: 0, yaw: 0, scale: 1 },
		] ),
	], { groundY: 0, defaultMaxDistance: Infinity } );
	const trace = createChameleonSurfaceTraceBuffer( 1025, 10 );
	const wallTrace = createChameleonSurfaceTraceBuffer( 1025, 10 );
	const diagonalTrace = createChameleonSurfaceTraceBuffer( 1025, 10 );
	const tolerance = 0.002;
	const query = {
		supportId: 0,
		includeGround: true,
		nearestGround: true,
		clearance: 0,
		maxDistance: Infinity,
		tolerance,
		maxSegmentLength: 0.08,
		maxNormalAngle: Math.PI / 12,
		maxDepth: 10,
	};

	// A direct diagonal never passes through the physical corner and remains a
	// forbidden shortcut.
	collider.traceSegment( 0, 1, 0, 1, 0, 0, diagonalTrace, query );
	assert.equal( diagonalTrace.valid, false );
	assert.equal( diagonalTrace.depthExceeded, true );

	// The graph supplies the real topology portal. Both segments remain exact;
	// the second one contains the epsilon-localised normal/support switch.
	collider.traceSegment( 0, 1, 0, 0, 0, 0, wallTrace, query );
	assert.equal( wallTrace.valid, true );
	collider.traceSegment( 0, 0, 0, 1, 0, 0, trace, query );
	assert.equal( trace.valid, true, JSON.stringify( {
		count: trace.count,
		depthExceeded: trace.depthExceeded,
		budgetExceeded: trace.budgetExceeded,
		maxChordError: trace.maxChordError,
		maxLeafLength: trace.maxLeafLength,
	} ) );
	assert.equal( trace.depthExceeded, false );
	const wallEnd = wallTrace.count - 1;
	assert.ok( Math.hypot(
		wallTrace.x[ wallEnd ] - trace.x[ 0 ],
		wallTrace.y[ wallEnd ] - trace.y[ 0 ],
		wallTrace.z[ wallEnd ] - trace.z[ 0 ],
	) <= 1e-7 );

	let portalCount = 0;
	for ( let index = 1; index < trace.count; index ++ ) {

		if ( trace.supportId[ index - 1 ] === trace.supportId[ index ]
			&& trace.componentId[ index - 1 ] === trace.componentId[ index ] ) continue;
		portalCount ++;
		const gap = Math.hypot(
			trace.x[ index ] - trace.x[ index - 1 ],
			trace.y[ index ] - trace.y[ index - 1 ],
			trace.z[ index ] - trace.z[ index - 1 ],
		);
		assert.ok( gap <= tolerance * 2 + 1e-6, `portal gap ${ gap } was not localised` );

	}
	assert.equal( portalCount, 1 );
	assert.equal( trace.supportId[ 0 ], 0 );
	assert.equal( trace.supportId[ trace.count - 1 ], - 1 );

} );

test( 'CHAMELEON-COLLIDER-012 trace rejects a geometrically disconnected support-ground jump', () => {

	const floatingWall = geometry( [
		0, 1, - 1,
		0, 3, - 1,
		0, 3, 1,
		0, 1, 1,
	], {
		indices: [ 0, 2, 1, 0, 3, 2 ],
		normals: [
			1, 0, 0,
			1, 0, 0,
			1, 0, 0,
			1, 0, 0,
		],
	} );
	const collider = buildChameleonSurfaceCollider( [
		entry( 'Log_01', 'obstacles', floatingWall, [
			{ x: 0, y: 0, z: 0, yaw: 0, scale: 1 },
		] ),
	], { groundY: 0, defaultMaxDistance: Infinity } );
	const trace = createChameleonSurfaceTraceBuffer( 1025, 10 );
	collider.traceSegment( 0, 1.5, 0, 1, 0, 0, trace, {
		supportId: 0,
		includeGround: true,
		nearestGround: true,
		clearance: 0,
		maxDistance: Infinity,
		tolerance: 0.002,
		maxSegmentLength: 0.08,
		maxNormalAngle: Math.PI / 12,
		maxDepth: 10,
	} );

	assert.equal( trace.valid, false );
	assert.equal( trace.depthExceeded, true );

} );
