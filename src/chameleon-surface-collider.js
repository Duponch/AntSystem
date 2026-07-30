/**
 * Exact, baked collision surface for chameleon locomotion.
 *
 * All meshes and placements are converted once to immutable-size world-space
 * triangle SoA. Runtime queries only traverse the preallocated BVH and reuse a
 * caller-owned result object; they never raycast the scene or allocate arrays.
 */

export const CHAMELEON_WALKABLE_MODELS = Object.freeze( [
	'Log_01', 'Log_02', 'Branch', 'Stump_01', 'BigRock_03',
	'Rock_01', 'Rock_02', 'Rock_03', 'Rock_04', 'Rock_05',
	'Tree_01', 'Tree_02', 'Tree_06', 'Tree_07', 'Tree_08',
] );

const DEFAULT_WALKABLE_MODELS = new Set( CHAMELEON_WALKABLE_MODELS );
const EPSILON = 1e-12;

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function clampInteger( value, low, high ) {

	return Math.min( high, Math.max( low, Math.round( value ) ) );

}

function categoryScaleFor( category, scales ) {

	const configured = scales?.[ category ];
	return Number.isFinite( configured ) ? configured : 1;

}

function readComponent( attribute, index, component ) {

	if ( component === 0 && typeof attribute.getX === 'function' ) return attribute.getX( index );
	if ( component === 1 && typeof attribute.getY === 'function' ) return attribute.getY( index );
	if ( component === 2 && typeof attribute.getZ === 'function' ) return attribute.getZ( index );
	const itemSize = Math.max( 1, attribute.itemSize || 3 );
	return attribute.array?.[ index * itemSize + component ];

}

function readIndex( indexAttribute, ordinal ) {

	if ( typeof indexAttribute?.getX === 'function' ) return indexAttribute.getX( ordinal );
	return indexAttribute?.array?.[ ordinal ];

}

function indexCount( indexAttribute ) {

	if ( Number.isFinite( indexAttribute?.count ) ) return indexAttribute.count;
	return indexAttribute?.array?.length || 0;

}

function geometryIndex( geometry ) {

	return geometry?.getIndex?.() || geometry?.index || null;

}

function makeTriangleBuilder() {

	return {
		ax: [], ay: [], az: [],
		bx: [], by: [], bz: [],
		cx: [], cy: [], cz: [],
		nax: [], nay: [], naz: [],
		nbx: [], nby: [], nbz: [],
		ncx: [], ncy: [], ncz: [],
		fnx: [], fny: [], fnz: [],
		supportId: [],
		localTriangleId: [],
	};

}

function pushTriangle(
	builder,
	supportId,
	localTriangleId,
	a, b, c,
	na, nb, nc,
) {

	let abx = b.x - a.x;
	let aby = b.y - a.y;
	let abz = b.z - a.z;
	let acx = c.x - a.x;
	let acy = c.y - a.y;
	let acz = c.z - a.z;
	let fnx = aby * acz - abz * acy;
	let fny = abz * acx - abx * acz;
	let fnz = abx * acy - aby * acx;
	const faceLength = Math.hypot( fnx, fny, fnz );
	if ( ! Number.isFinite( faceLength ) || faceLength <= EPSILON ) return false;
	fnx /= faceLength;
	fny /= faceLength;
	fnz /= faceLength;

	function normalOrFace( normal ) {

		let nx = normal?.x;
		let ny = normal?.y;
		let nz = normal?.z;
		const length = Math.hypot( nx, ny, nz );
		if ( ! Number.isFinite( length ) || length <= EPSILON ) {

			nx = fnx;
			ny = fny;
			nz = fnz;

		} else {

			nx /= length;
			ny /= length;
			nz /= length;
			if ( nx * fnx + ny * fny + nz * fnz < 0 ) {

				nx = - nx;
				ny = - ny;
				nz = - nz;

			}

		}
		return [ nx, ny, nz ];

	}

	const normalA = normalOrFace( na );
	const normalB = normalOrFace( nb );
	const normalC = normalOrFace( nc );
	builder.ax.push( a.x ); builder.ay.push( a.y ); builder.az.push( a.z );
	builder.bx.push( b.x ); builder.by.push( b.y ); builder.bz.push( b.z );
	builder.cx.push( c.x ); builder.cy.push( c.y ); builder.cz.push( c.z );
	builder.nax.push( normalA[ 0 ] ); builder.nay.push( normalA[ 1 ] ); builder.naz.push( normalA[ 2 ] );
	builder.nbx.push( normalB[ 0 ] ); builder.nby.push( normalB[ 1 ] ); builder.nbz.push( normalB[ 2 ] );
	builder.ncx.push( normalC[ 0 ] ); builder.ncy.push( normalC[ 1 ] ); builder.ncz.push( normalC[ 2 ] );
	builder.fnx.push( fnx ); builder.fny.push( fny ); builder.fnz.push( fnz );
	builder.supportId.push( supportId );
	builder.localTriangleId.push( localTriangleId );
	return true;

}

function worldVertex( position, normal, index, placement, scale, sin, cos, normalSign ) {

	const localX = readComponent( position, index, 0 );
	const localY = readComponent( position, index, 1 );
	const localZ = readComponent( position, index, 2 );
	if ( ! Number.isFinite( localX ) || ! Number.isFinite( localY ) || ! Number.isFinite( localZ ) ) return null;
	const vertex = {
		x: placement.x + ( localX * cos + localZ * sin ) * scale,
		y: placement.y + localY * scale,
		z: placement.z + ( - localX * sin + localZ * cos ) * scale,
	};
	let transformedNormal = null;
	if ( normal && index < normal.count ) {

		const localNX = readComponent( normal, index, 0 );
		const localNY = readComponent( normal, index, 1 );
		const localNZ = readComponent( normal, index, 2 );
		if ( Number.isFinite( localNX ) && Number.isFinite( localNY ) && Number.isFinite( localNZ ) ) {

			transformedNormal = {
				x: ( localNX * cos + localNZ * sin ) * normalSign,
				y: localNY * normalSign,
				z: ( - localNX * sin + localNZ * cos ) * normalSign,
			};

		}

	}
	return { vertex, normal: transformedNormal };

}

function acceptsModel( entry, walkableModels ) {

	if ( entry?.walkable === false ) return false;
	if ( walkableModels === null || walkableModels === '*' ) return true;
	return walkableModels.has( entry?.model );

}

function collectTriangles( registry, {
	scales,
	walkableModels,
	maxTriangles,
} ) {

	const builder = makeTriangleBuilder();
	const supports = [];

	for ( const entry of registry || [] ) {

		if ( ! acceptsModel( entry, walkableModels ) ) continue;
		const geometry = entry?.mesh?.geometry;
		const position = geometry?.getAttribute?.( 'position' );
		if ( ! position || ! Number.isFinite( position.count ) || position.count < 3 ) continue;
		const normal = geometry.getAttribute?.( 'normal' ) || null;
		const indices = geometryIndex( geometry );
		const sourceCount = indices ? indexCount( indices ) : position.count;
		const drawStart = Math.max( 0, Math.floor( finiteOr( geometry.drawRange?.start, 0 ) ) );
		const requestedCount = geometry.drawRange?.count;
		const drawCount = Number.isFinite( requestedCount )
			? Math.max( 0, Math.floor( requestedCount ) )
			: sourceCount - drawStart;
		const drawEnd = Math.min( sourceCount, drawStart + drawCount );

		for ( let placementIndex = 0; placementIndex < ( entry.placements?.length || 0 ); placementIndex ++ ) {

			const sourcePlacement = entry.placements[ placementIndex ];
			const categoryScale = categoryScaleFor( entry.category, scales );
			const scale = finiteOr( sourcePlacement?.scale, 1 ) * categoryScale;
			if ( ! Number.isFinite( scale ) || Math.abs( scale ) <= EPSILON ) continue;
			const placement = {
				x: finiteOr( sourcePlacement?.x, 0 ),
				y: finiteOr( sourcePlacement?.y, 0 ),
				z: finiteOr( sourcePlacement?.z, 0 ),
			};
			const yaw = finiteOr( sourcePlacement?.yaw, 0 );
			const sin = Math.sin( yaw );
			const cos = Math.cos( yaw );
			const normalSign = scale < 0 ? - 1 : 1;
			const supportId = supports.length;
			const triangleStart = builder.ax.length;
			let localTriangleId = 0;

			for ( let ordinal = drawStart; ordinal + 2 < drawEnd; ordinal += 3 ) {

				const ia = indices ? readIndex( indices, ordinal ) : ordinal;
				const ib = indices ? readIndex( indices, ordinal + 1 ) : ordinal + 1;
				const ic = indices ? readIndex( indices, ordinal + 2 ) : ordinal + 2;
				if ( ! Number.isInteger( ia ) || ! Number.isInteger( ib ) || ! Number.isInteger( ic )
					|| ia < 0 || ib < 0 || ic < 0
					|| ia >= position.count || ib >= position.count || ic >= position.count ) {

					localTriangleId ++;
					continue;

				}
				const a = worldVertex( position, normal, ia, placement, scale, sin, cos, normalSign );
				const b = worldVertex( position, normal, ib, placement, scale, sin, cos, normalSign );
				const c = worldVertex( position, normal, ic, placement, scale, sin, cos, normalSign );
				if ( a && b && c ) pushTriangle(
					builder,
					supportId,
					localTriangleId,
					a.vertex, b.vertex, c.vertex,
					a.normal, b.normal, c.normal,
				);
				localTriangleId ++;
				if ( builder.ax.length > maxTriangles ) {

					throw new RangeError( `chameleon surface collider exceeds ${ maxTriangles } triangles` );

				}

			}

			const triangleCount = builder.ax.length - triangleStart;
			if ( triangleCount <= 0 ) continue;
			let minX = Infinity; let minY = Infinity; let minZ = Infinity;
			let maxX = - Infinity; let maxY = - Infinity; let maxZ = - Infinity;
			for ( let triangle = triangleStart; triangle < builder.ax.length; triangle ++ ) {

				minX = Math.min( minX, builder.ax[ triangle ], builder.bx[ triangle ], builder.cx[ triangle ] );
				minY = Math.min( minY, builder.ay[ triangle ], builder.by[ triangle ], builder.cy[ triangle ] );
				minZ = Math.min( minZ, builder.az[ triangle ], builder.bz[ triangle ], builder.cz[ triangle ] );
				maxX = Math.max( maxX, builder.ax[ triangle ], builder.bx[ triangle ], builder.cx[ triangle ] );
				maxY = Math.max( maxY, builder.ay[ triangle ], builder.by[ triangle ], builder.cy[ triangle ] );
				maxZ = Math.max( maxZ, builder.az[ triangle ], builder.bz[ triangle ], builder.cz[ triangle ] );

			}
			supports.push( Object.freeze( {
				id: supportId,
				model: entry.model,
				category: entry.category,
				entry,
				placement: sourcePlacement,
				placementIndex,
				scale,
				categoryScale,
				yaw,
				triangleStart,
				triangleCount,
				minX, minY, minZ,
				maxX, maxY, maxZ,
			} ) );

		}

	}
	return { builder, supports: Object.freeze( supports ) };

}

function typedTriangles( builder ) {

	return {
		ax: Float32Array.from( builder.ax ),
		ay: Float32Array.from( builder.ay ),
		az: Float32Array.from( builder.az ),
		bx: Float32Array.from( builder.bx ),
		by: Float32Array.from( builder.by ),
		bz: Float32Array.from( builder.bz ),
		cx: Float32Array.from( builder.cx ),
		cy: Float32Array.from( builder.cy ),
		cz: Float32Array.from( builder.cz ),
		normalAX: Float32Array.from( builder.nax ),
		normalAY: Float32Array.from( builder.nay ),
		normalAZ: Float32Array.from( builder.naz ),
		normalBX: Float32Array.from( builder.nbx ),
		normalBY: Float32Array.from( builder.nby ),
		normalBZ: Float32Array.from( builder.nbz ),
		normalCX: Float32Array.from( builder.ncx ),
		normalCY: Float32Array.from( builder.ncy ),
		normalCZ: Float32Array.from( builder.ncz ),
		faceNormalX: Float32Array.from( builder.fnx ),
		faceNormalY: Float32Array.from( builder.fny ),
		faceNormalZ: Float32Array.from( builder.fnz ),
		supportId: Int32Array.from( builder.supportId ),
		localTriangleId: Uint32Array.from( builder.localTriangleId ),
	};

}

function weldedVertexKey( x, y, z, inverseEpsilon ) {

	return `${ Math.round( x * inverseEpsilon ) },${ Math.round( y * inverseEpsilon ) },${ Math.round( z * inverseEpsilon ) }`;

}

function buildAdjacency( triangles, weldEpsilon ) {

	const count = triangles.ax.length;
	const edgeBuckets = new Map();
	const inverseEpsilon = 1 / weldEpsilon;
	const edgeNeighbours = new Int32Array( count * 3 );
	edgeNeighbours.fill( - 1 );

	function addEdge( triangle, edge, ax, ay, az, bx, by, bz ) {

		const a = weldedVertexKey( ax, ay, az, inverseEpsilon );
		const b = weldedVertexKey( bx, by, bz, inverseEpsilon );
		const key = a < b
			? `${ triangles.supportId[ triangle ] }:${ a }|${ b }`
			: `${ triangles.supportId[ triangle ] }:${ b }|${ a }`;
		let bucket = edgeBuckets.get( key );
		if ( ! bucket ) {

			bucket = [];
			edgeBuckets.set( key, bucket );

		}
		bucket.push( triangle, edge );

	}

	for ( let triangle = 0; triangle < count; triangle ++ ) {

		addEdge(
			triangle, 0,
			triangles.ax[ triangle ], triangles.ay[ triangle ], triangles.az[ triangle ],
			triangles.bx[ triangle ], triangles.by[ triangle ], triangles.bz[ triangle ],
		);
		addEdge(
			triangle, 1,
			triangles.bx[ triangle ], triangles.by[ triangle ], triangles.bz[ triangle ],
			triangles.cx[ triangle ], triangles.cy[ triangle ], triangles.cz[ triangle ],
		);
		addEdge(
			triangle, 2,
			triangles.cx[ triangle ], triangles.cy[ triangle ], triangles.cz[ triangle ],
			triangles.ax[ triangle ], triangles.ay[ triangle ], triangles.az[ triangle ],
		);

	}

	const neighbours = Array.from( { length: count }, () => [] );
	const pairKeys = new Set();
	for ( const bucket of edgeBuckets.values() ) {

		for ( let index = 0; index < bucket.length; index += 2 ) {

			const triangle = bucket[ index ];
			const edge = bucket[ index + 1 ];
			for ( let otherIndex = 0; otherIndex < bucket.length; otherIndex += 2 ) {

				const other = bucket[ otherIndex ];
				if ( triangle === other ) continue;
				if ( edgeNeighbours[ triangle * 3 + edge ] < 0 ) {

					edgeNeighbours[ triangle * 3 + edge ] = other;

				}
				const low = Math.min( triangle, other );
				const high = Math.max( triangle, other );
				const pairKey = `${ low }:${ high }`;
				if ( pairKeys.has( pairKey ) ) continue;
				pairKeys.add( pairKey );
				neighbours[ low ].push( high );
				neighbours[ high ].push( low );

			}

		}

	}

	const offsets = new Uint32Array( count + 1 );
	const componentId = new Int32Array( count );
	componentId.fill( - 1 );
	const componentStack = new Int32Array( Math.max( 1, count ) );
	const components = [];
	for ( let seed = 0; seed < count; seed ++ ) {

		if ( componentId[ seed ] >= 0 ) continue;
		const id = components.length;
		const supportId = triangles.supportId[ seed ];
		let stackSize = 1;
		let triangleCount = 0;
		let minX = Infinity; let minY = Infinity; let minZ = Infinity;
		let maxX = - Infinity; let maxY = - Infinity; let maxZ = - Infinity;
		componentStack[ 0 ] = seed;
		componentId[ seed ] = id;
		while ( stackSize > 0 ) {

			const triangle = componentStack[ -- stackSize ];
			triangleCount ++;
			minX = Math.min(
				minX,
				triangles.ax[ triangle ], triangles.bx[ triangle ], triangles.cx[ triangle ],
			);
			minY = Math.min(
				minY,
				triangles.ay[ triangle ], triangles.by[ triangle ], triangles.cy[ triangle ],
			);
			minZ = Math.min(
				minZ,
				triangles.az[ triangle ], triangles.bz[ triangle ], triangles.cz[ triangle ],
			);
			maxX = Math.max(
				maxX,
				triangles.ax[ triangle ], triangles.bx[ triangle ], triangles.cx[ triangle ],
			);
			maxY = Math.max(
				maxY,
				triangles.ay[ triangle ], triangles.by[ triangle ], triangles.cy[ triangle ],
			);
			maxZ = Math.max(
				maxZ,
				triangles.az[ triangle ], triangles.bz[ triangle ], triangles.cz[ triangle ],
			);
			for ( const neighbour of neighbours[ triangle ] ) {

				if ( componentId[ neighbour ] >= 0 ) continue;
				componentId[ neighbour ] = id;
				componentStack[ stackSize ++ ] = neighbour;

			}

		}
		components.push( Object.freeze( {
			id, supportId, triangleCount,
			minX, minY, minZ,
			maxX, maxY, maxZ,
		} ) );

	}

	for ( let triangle = 0; triangle < count; triangle ++ ) {

		neighbours[ triangle ].sort( ( a, b ) => a - b );
		offsets[ triangle + 1 ] = offsets[ triangle ] + neighbours[ triangle ].length;

	}
	const adjacentTriangles = new Uint32Array( offsets[ count ] );
	for ( let triangle = 0; triangle < count; triangle ++ ) {

		adjacentTriangles.set( neighbours[ triangle ], offsets[ triangle ] );

	}
	return {
		adjacencyOffsets: offsets,
		adjacencyTriangles: adjacentTriangles,
		componentId,
		componentCount: components.length,
		components: Object.freeze( components ),
		edgeNeighbours,
		weldedEdgeCount: edgeBuckets.size,
	};

}

function buildBvh( triangles, leafSize ) {

	const triangleCount = triangles.ax.length;
	if ( triangleCount === 0 ) {

		return {
			root: - 1,
			triangleOrder: new Uint32Array( 0 ),
			minX: new Float64Array( 0 ),
			minY: new Float64Array( 0 ),
			minZ: new Float64Array( 0 ),
			maxX: new Float64Array( 0 ),
			maxY: new Float64Array( 0 ),
			maxZ: new Float64Array( 0 ),
			left: new Int32Array( 0 ),
			right: new Int32Array( 0 ),
			start: new Uint32Array( 0 ),
			count: new Uint16Array( 0 ),
		};

	}
	const order = Array.from( { length: triangleCount }, ( _, index ) => index );
	const centroidX = new Float64Array( triangleCount );
	const centroidY = new Float64Array( triangleCount );
	const centroidZ = new Float64Array( triangleCount );
	for ( let triangle = 0; triangle < triangleCount; triangle ++ ) {

		centroidX[ triangle ] = ( triangles.ax[ triangle ] + triangles.bx[ triangle ] + triangles.cx[ triangle ] ) / 3;
		centroidY[ triangle ] = ( triangles.ay[ triangle ] + triangles.by[ triangle ] + triangles.cy[ triangle ] ) / 3;
		centroidZ[ triangle ] = ( triangles.az[ triangle ] + triangles.bz[ triangle ] + triangles.cz[ triangle ] ) / 3;

	}
	const nodes = [];

	function makeNode( start, end ) {

		const nodeIndex = nodes.length;
		const node = {
			minX: Infinity, minY: Infinity, minZ: Infinity,
			maxX: - Infinity, maxY: - Infinity, maxZ: - Infinity,
			left: - 1, right: - 1, start: 0, count: 0,
		};
		nodes.push( node );
		let centroidMinX = Infinity; let centroidMinY = Infinity; let centroidMinZ = Infinity;
		let centroidMaxX = - Infinity; let centroidMaxY = - Infinity; let centroidMaxZ = - Infinity;
		for ( let index = start; index < end; index ++ ) {

			const triangle = order[ index ];
			node.minX = Math.min( node.minX, triangles.ax[ triangle ], triangles.bx[ triangle ], triangles.cx[ triangle ] );
			node.minY = Math.min( node.minY, triangles.ay[ triangle ], triangles.by[ triangle ], triangles.cy[ triangle ] );
			node.minZ = Math.min( node.minZ, triangles.az[ triangle ], triangles.bz[ triangle ], triangles.cz[ triangle ] );
			node.maxX = Math.max( node.maxX, triangles.ax[ triangle ], triangles.bx[ triangle ], triangles.cx[ triangle ] );
			node.maxY = Math.max( node.maxY, triangles.ay[ triangle ], triangles.by[ triangle ], triangles.cy[ triangle ] );
			node.maxZ = Math.max( node.maxZ, triangles.az[ triangle ], triangles.bz[ triangle ], triangles.cz[ triangle ] );
			centroidMinX = Math.min( centroidMinX, centroidX[ triangle ] );
			centroidMinY = Math.min( centroidMinY, centroidY[ triangle ] );
			centroidMinZ = Math.min( centroidMinZ, centroidZ[ triangle ] );
			centroidMaxX = Math.max( centroidMaxX, centroidX[ triangle ] );
			centroidMaxY = Math.max( centroidMaxY, centroidY[ triangle ] );
			centroidMaxZ = Math.max( centroidMaxZ, centroidZ[ triangle ] );

		}
		const count = end - start;
		if ( count <= leafSize ) {

			node.start = start;
			node.count = count;
			return nodeIndex;

		}
		const extentX = centroidMaxX - centroidMinX;
		const extentY = centroidMaxY - centroidMinY;
		const extentZ = centroidMaxZ - centroidMinZ;
		const axis = extentY > extentX && extentY >= extentZ ? 1 : extentZ > extentX ? 2 : 0;
		const sorted = order.slice( start, end );
		sorted.sort( ( a, b ) => {

			const av = axis === 0 ? centroidX[ a ] : axis === 1 ? centroidY[ a ] : centroidZ[ a ];
			const bv = axis === 0 ? centroidX[ b ] : axis === 1 ? centroidY[ b ] : centroidZ[ b ];
			return av - bv || a - b;

		} );
		for ( let index = 0; index < sorted.length; index ++ ) order[ start + index ] = sorted[ index ];
		const middle = start + Math.floor( count * 0.5 );
		node.left = makeNode( start, middle );
		node.right = makeNode( middle, end );
		return nodeIndex;

	}

	const root = makeNode( 0, triangleCount );
	const nodeCount = nodes.length;
	const bvh = {
		root,
		triangleOrder: Uint32Array.from( order ),
		minX: new Float64Array( nodeCount ),
		minY: new Float64Array( nodeCount ),
		minZ: new Float64Array( nodeCount ),
		maxX: new Float64Array( nodeCount ),
		maxY: new Float64Array( nodeCount ),
		maxZ: new Float64Array( nodeCount ),
		left: new Int32Array( nodeCount ),
		right: new Int32Array( nodeCount ),
		start: new Uint32Array( nodeCount ),
		count: new Uint16Array( nodeCount ),
	};
	for ( let index = 0; index < nodeCount; index ++ ) {

		const node = nodes[ index ];
		bvh.minX[ index ] = node.minX;
		bvh.minY[ index ] = node.minY;
		bvh.minZ[ index ] = node.minZ;
		bvh.maxX[ index ] = node.maxX;
		bvh.maxY[ index ] = node.maxY;
		bvh.maxZ[ index ] = node.maxZ;
		bvh.left[ index ] = node.left;
		bvh.right[ index ] = node.right;
		bvh.start[ index ] = node.start;
		bvh.count[ index ] = node.count;

	}
	return bvh;

}

function distanceSqToNode( bvh, node, x, y, z ) {

	const dx = x < bvh.minX[ node ]
		? bvh.minX[ node ] - x
		: x > bvh.maxX[ node ] ? x - bvh.maxX[ node ] : 0;
	const dy = y < bvh.minY[ node ]
		? bvh.minY[ node ] - y
		: y > bvh.maxY[ node ] ? y - bvh.maxY[ node ] : 0;
	const dz = z < bvh.minZ[ node ]
		? bvh.minZ[ node ] - z
		: z > bvh.maxZ[ node ] ? z - bvh.maxZ[ node ] : 0;
	return dx * dx + dy * dy + dz * dz;

}

/**
 * Creates a shape-stable output record for projectPoint().
 */
export function createChameleonSurfaceHit() {

	return {
		hit: false,
		x: 0, y: 0, z: 0,
		surfaceX: 0, surfaceY: 0, surfaceZ: 0,
		nx: 0, ny: 1, nz: 0,
		faceNormalX: 0, faceNormalY: 1, faceNormalZ: 0,
		barycentricA: 0, barycentricB: 0, barycentricC: 0,
		distance: Infinity,
		distanceSq: Infinity,
		signedDistance: 0,
		supportId: - 1,
		componentId: - 1,
		triangleId: - 1,
		localTriangleId: - 1,
		isGround: false,
		visitedNodes: 0,
		testedTriangles: 0,
		hintTriangleId: - 1,
		hintTests: 0,
	};

}

/**
 * Preallocates the arrays accepted by projectCorridor().
 */
export function createChameleonProjectionBuffer( capacity ) {

	const safeCapacity = Math.max( 1, Math.round( capacity ) );
	return {
		count: 0,
		x: new Float32Array( safeCapacity ),
		y: new Float32Array( safeCapacity ),
		z: new Float32Array( safeCapacity ),
		normalX: new Float32Array( safeCapacity ),
		normalY: new Float32Array( safeCapacity ),
		normalZ: new Float32Array( safeCapacity ),
		tangentX: new Float32Array( safeCapacity ),
		tangentY: new Float32Array( safeCapacity ),
		tangentZ: new Float32Array( safeCapacity ),
		distance: new Float32Array( safeCapacity ),
		projectionDistance: new Float32Array( safeCapacity ),
		supportId: new Int32Array( safeCapacity ),
		triangleId: new Int32Array( safeCapacity ),
		hit: new Uint8Array( safeCapacity ),
		componentId: new Int32Array( safeCapacity ),
	};

}

const TRACE_POINT_STRIDE = 9;

/**
 * Preallocates both result and DFS scratch storage for adaptive surface traces.
 * A buffer can be reused for every graph edge and transition during a rebuild.
 */
export function createChameleonSurfaceTraceBuffer( capacity, maximumDepth = 8 ) {

	const safeCapacity = Math.max( 2, Math.round( capacity ) );
	const safeDepth = clampInteger( finiteOr( maximumDepth, 8 ), 0, 16 );
	const stackCapacity = safeDepth + 2;
	return {
		capacity: safeCapacity,
		maximumDepth: safeDepth,
		count: 0,
		x: new Float32Array( safeCapacity ),
		y: new Float32Array( safeCapacity ),
		z: new Float32Array( safeCapacity ),
		normalX: new Float32Array( safeCapacity ),
		normalY: new Float32Array( safeCapacity ),
		normalZ: new Float32Array( safeCapacity ),
		distance: new Float32Array( safeCapacity ),
		triangleId: new Int32Array( safeCapacity ),
		componentId: new Int32Array( safeCapacity ),
		supportId: new Int32Array( safeCapacity ),
		isGround: new Uint8Array( safeCapacity ),
		valid: false,
		budgetExceeded: false,
		depthExceeded: false,
		projectionFailures: 0,
		validatedSegmentCount: 0,
		maxChordError: 0,
		maxLeafLength: 0,
		maxNormalAngle: 0,
		_hit: createChameleonSurfaceHit(),
		_pointQuery: {
			supportId: - 1,
			componentId: - 1,
			includeGround: false,
			groundOnly: false,
			nearestGround: false,
			clearance: 0,
			maxDistance: Infinity,
			triangleId: - 1,
		},
		_stackT0: new Float64Array( stackCapacity ),
		_stackT1: new Float64Array( stackCapacity ),
		_stackDepth: new Uint8Array( stackCapacity ),
		_stackA: new Float64Array( stackCapacity * TRACE_POINT_STRIDE ),
		_stackB: new Float64Array( stackCapacity * TRACE_POINT_STRIDE ),
	};

}

function writeTraceOutput( trace, index, x, y, z, nx, ny, nz, triangleId, componentId, supportId ) {

	trace.x[ index ] = x;
	trace.y[ index ] = y;
	trace.z[ index ] = z;
	trace.normalX[ index ] = nx;
	trace.normalY[ index ] = ny;
	trace.normalZ[ index ] = nz;
	trace.triangleId[ index ] = triangleId;
	trace.supportId[ index ] = supportId;
	trace.isGround[ index ] = triangleId < 0 ? 1 : 0;
	trace.componentId[ index ] = componentId;

}

export class ChameleonSurfaceCollider {

	constructor( triangles, supports, adjacency, bvh, {
		groundY,
		defaultMaxDistance,
	} ) {

		this.triangleCount = triangles.ax.length;
		this.supportCount = supports.length;
		this.supports = supports;
		this.groundY = groundY;
		this.defaultMaxDistance = defaultMaxDistance;
		Object.assign( this, triangles, adjacency );
		this.bvh = bvh;
		this.bvhNodeCount = bvh.minX.length;
		this._queryStack = new Int32Array( Math.max( 1, this.bvhNodeCount ) );
		this._corridorHit = createChameleonSurfaceHit();
		this._corridorQuery = {
			supportId: - 1,
			maxDistance: defaultMaxDistance,
			componentId: - 1,
			includeGround: true,
			clearance: 0,
			groundOnly: false,
			triangleId: - 1,
		};
		this._candidateX = 0;
		this._candidateY = 0;
		this._candidateZ = 0;
		this._candidateA = 0;
		this._candidateB = 0;
		this._candidateC = 0;
		this._hintMarks = new Uint32Array( this.triangleCount );
		this._hintEpoch = 0;

	}

	_testTriangle( triangle, px, py, pz ) {

		const ax = this.ax[ triangle ];
		const ay = this.ay[ triangle ];
		const az = this.az[ triangle ];
		const bx = this.bx[ triangle ];
		const by = this.by[ triangle ];
		const bz = this.bz[ triangle ];
		const cx = this.cx[ triangle ];
		const cy = this.cy[ triangle ];
		const cz = this.cz[ triangle ];
		const abx = bx - ax; const aby = by - ay; const abz = bz - az;
		const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
		const apx = px - ax; const apy = py - ay; const apz = pz - az;
		const d1 = abx * apx + aby * apy + abz * apz;
		const d2 = acx * apx + acy * apy + acz * apz;
		let x; let y; let z; let wa; let wb; let wc;

		if ( d1 <= 0 && d2 <= 0 ) {

			x = ax; y = ay; z = az;
			wa = 1; wb = 0; wc = 0;

		} else {

			const bpx = px - bx; const bpy = py - by; const bpz = pz - bz;
			const d3 = abx * bpx + aby * bpy + abz * bpz;
			const d4 = acx * bpx + acy * bpy + acz * bpz;
			if ( d3 >= 0 && d4 <= d3 ) {

				x = bx; y = by; z = bz;
				wa = 0; wb = 1; wc = 0;

			} else {

				const vc = d1 * d4 - d3 * d2;
				if ( vc <= 0 && d1 >= 0 && d3 <= 0 ) {

					const v = d1 / ( d1 - d3 );
					x = ax + abx * v; y = ay + aby * v; z = az + abz * v;
					wa = 1 - v; wb = v; wc = 0;

				} else {

					const cpx = px - cx; const cpy = py - cy; const cpz = pz - cz;
					const d5 = abx * cpx + aby * cpy + abz * cpz;
					const d6 = acx * cpx + acy * cpy + acz * cpz;
					if ( d6 >= 0 && d5 <= d6 ) {

						x = cx; y = cy; z = cz;
						wa = 0; wb = 0; wc = 1;

					} else {

						const vb = d5 * d2 - d1 * d6;
						if ( vb <= 0 && d2 >= 0 && d6 <= 0 ) {

							const w = d2 / ( d2 - d6 );
							x = ax + acx * w; y = ay + acy * w; z = az + acz * w;
							wa = 1 - w; wb = 0; wc = w;

						} else {

							const va = d3 * d6 - d5 * d4;
							if ( va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0 ) {

								const edgeX = cx - bx;
								const edgeY = cy - by;
								const edgeZ = cz - bz;
								const w = ( d4 - d3 ) / ( ( d4 - d3 ) + ( d5 - d6 ) );
								x = bx + edgeX * w; y = by + edgeY * w; z = bz + edgeZ * w;
								wa = 0; wb = 1 - w; wc = w;

							} else {

								const denominator = 1 / ( va + vb + vc );
								wb = vb * denominator;
								wc = vc * denominator;
								wa = 1 - wb - wc;
								x = ax + abx * wb + acx * wc;
								y = ay + aby * wb + acy * wc;
								z = az + abz * wb + acz * wc;

							}

						}

					}

				}

			}

		}
		this._candidateX = x;
		this._candidateY = y;
		this._candidateZ = z;
		this._candidateA = wa;
		this._candidateB = wb;
		this._candidateC = wc;
		const dx = px - x;
		const dy = py - y;
		const dz = pz - z;
		return dx * dx + dy * dy + dz * dz;

	}

	/**
	 * Closest exact support point. `out` is mandatory and returned unchanged.
	 * Terrain is only a fallback when no eligible support is in maxDistance.
	 */
	projectPoint( x, y, z, out, query = null ) {

		if ( ! out || typeof out !== 'object' ) throw new TypeError( 'projectPoint requires a caller-owned output object' );
		const requestedSupport = Number.isInteger( query?.supportId ) ? query.supportId : - 1;
		const requestedComponent = Number.isInteger( query?.componentId ) ? query.componentId : - 1;
		const nearestGround = query?.nearestGround === true;
		const includeGround = query?.includeGround !== false
			&& ( ( requestedSupport < 0 && requestedComponent < 0 ) || nearestGround );
		// `Infinity` is an intentional unbounded, support-scoped query. Do not
		// collapse it to the ordinary interactive-query radius: graph baking
		// still keeps the exact support/component filters.
		const configuredDistance = query?.maxDistance === Infinity
			? Infinity
			: Number.isFinite( query?.maxDistance )
				? Math.max( 0, query.maxDistance )
				: this.defaultMaxDistance;
		const clearance = Number.isFinite( query?.clearance ) ? query.clearance : 0;
		if ( query?.groundOnly === true ) {

			const groundDistance = Math.abs( y - this.groundY );
			out.hit = true;
			out.surfaceX = x;
			out.surfaceY = this.groundY;
			out.surfaceZ = z;
			out.nx = 0; out.ny = 1; out.nz = 0;
			out.faceNormalX = 0; out.faceNormalY = 1; out.faceNormalZ = 0;
			out.x = x;
			out.y = this.groundY + clearance;
			out.z = z;
			out.barycentricA = 0; out.barycentricB = 0; out.barycentricC = 0;
			out.distance = groundDistance;
			out.distanceSq = groundDistance * groundDistance;
			out.signedDistance = y - this.groundY;
			out.supportId = - 1;
			out.componentId = - 1;
			out.triangleId = - 1;
			out.localTriangleId = - 1;
			out.isGround = true;
			out.visitedNodes = 0;
			out.testedTriangles = 0;
			out.hintTriangleId = - 1;
			out.hintTests = 0;
			return out;

		}
		let bestDistanceSq = configuredDistance === Infinity
			? Infinity
			: configuredDistance * configuredDistance;
		let bestTriangle = - 1;
		let bestX = 0; let bestY = 0; let bestZ = 0;
		let bestA = 0; let bestB = 0; let bestC = 0;
		let visitedNodes = 0;
		let testedTriangles = 0;
		let hintTests = 0;
		let hintedTriangle = Number.isInteger( query?.triangleId )
			? query.triangleId
			: - 1;
		if ( hintedTriangle < 0 || hintedTriangle >= this.triangleCount
			|| ( requestedComponent >= 0 && this.componentId[ hintedTriangle ] !== requestedComponent )
			|| ( requestedSupport >= 0 && this.supportId[ hintedTriangle ] !== requestedSupport ) ) {

			hintedTriangle = - 1;

		}
		let hintEpoch = 0;
		if ( hintedTriangle >= 0 ) {

			hintEpoch = ( this._hintEpoch + 1 ) >>> 0;
			if ( hintEpoch === 0 ) {

				this._hintMarks.fill( 0 );
				hintEpoch = 1;

			}
			this._hintEpoch = hintEpoch;
			this._hintMarks[ hintedTriangle ] = hintEpoch;
			let distanceSq = this._testTriangle( hintedTriangle, x, y, z );
			testedTriangles ++;
			hintTests ++;
			if ( distanceSq <= bestDistanceSq ) {

				bestDistanceSq = distanceSq;
				bestTriangle = hintedTriangle;
				bestX = this._candidateX;
				bestY = this._candidateY;
				bestZ = this._candidateZ;
				bestA = this._candidateA;
				bestB = this._candidateB;
				bestC = this._candidateC;

			}
			const adjacencyStart = this.adjacencyOffsets[ hintedTriangle ];
			const adjacencyEnd = this.adjacencyOffsets[ hintedTriangle + 1 ];
			for ( let ordinal = adjacencyStart; ordinal < adjacencyEnd; ordinal ++ ) {

				const triangle = this.adjacencyTriangles[ ordinal ];
				if ( this._hintMarks[ triangle ] === hintEpoch ) continue;
				this._hintMarks[ triangle ] = hintEpoch;
				distanceSq = this._testTriangle( triangle, x, y, z );
				testedTriangles ++;
				hintTests ++;
				if ( distanceSq > bestDistanceSq
					|| ( distanceSq === bestDistanceSq && bestTriangle >= 0 && triangle >= bestTriangle ) ) continue;
				bestDistanceSq = distanceSq;
				bestTriangle = triangle;
				bestX = this._candidateX;
				bestY = this._candidateY;
				bestZ = this._candidateZ;
				bestA = this._candidateA;
				bestB = this._candidateB;
				bestC = this._candidateC;

			}

		}
		const bvh = this.bvh;
		let stackSize = 0;
		if ( bvh.root >= 0 && distanceSqToNode( bvh, bvh.root, x, y, z ) <= bestDistanceSq ) {

			this._queryStack[ stackSize ++ ] = bvh.root;

		}
		while ( stackSize > 0 ) {

			const node = this._queryStack[ -- stackSize ];
			visitedNodes ++;
			const leafCount = bvh.count[ node ];
			if ( leafCount > 0 ) {

				const start = bvh.start[ node ];
				for ( let ordinal = start; ordinal < start + leafCount; ordinal ++ ) {

					const triangle = bvh.triangleOrder[ ordinal ];
					if ( requestedComponent >= 0 && this.componentId[ triangle ] !== requestedComponent ) continue;
					if ( requestedSupport >= 0 && this.supportId[ triangle ] !== requestedSupport ) continue;
					if ( hintEpoch !== 0 && this._hintMarks[ triangle ] === hintEpoch ) continue;
					testedTriangles ++;
					const distanceSq = this._testTriangle( triangle, x, y, z );
					if ( distanceSq > bestDistanceSq
						|| ( distanceSq === bestDistanceSq && bestTriangle >= 0 && triangle >= bestTriangle ) ) continue;
					bestDistanceSq = distanceSq;
					bestTriangle = triangle;
					bestX = this._candidateX;
					bestY = this._candidateY;
					bestZ = this._candidateZ;
					bestA = this._candidateA;
					bestB = this._candidateB;
					bestC = this._candidateC;

				}

			} else {

				const left = bvh.left[ node ];
				const right = bvh.right[ node ];
				const leftDistance = distanceSqToNode( bvh, left, x, y, z );
				const rightDistance = distanceSqToNode( bvh, right, x, y, z );
				if ( leftDistance <= rightDistance ) {

					if ( rightDistance <= bestDistanceSq ) this._queryStack[ stackSize ++ ] = right;
					if ( leftDistance <= bestDistanceSq ) this._queryStack[ stackSize ++ ] = left;

				} else {

					if ( leftDistance <= bestDistanceSq ) this._queryStack[ stackSize ++ ] = left;
					if ( rightDistance <= bestDistanceSq ) this._queryStack[ stackSize ++ ] = right;

				}

			}

		}

		out.visitedNodes = visitedNodes;
		out.testedTriangles = testedTriangles;
		out.hintTriangleId = hintedTriangle;
		out.hintTests = hintTests;
		if ( bestTriangle >= 0 && includeGround && nearestGround ) {

			const groundDistance = y - this.groundY;
			if ( groundDistance * groundDistance < bestDistanceSq ) bestTriangle = - 1;

		}
		if ( bestTriangle < 0 ) {

			if ( ! includeGround ) {

				out.hit = false;
				out.distance = Infinity;
				out.distanceSq = Infinity;
				out.supportId = - 1;
				out.componentId = - 1;
				out.triangleId = - 1;
				out.localTriangleId = - 1;
				out.isGround = false;
				return out;

			}
			const groundDistance = Math.abs( y - this.groundY );
			out.hit = true;
			out.surfaceX = x;
			out.surfaceY = this.groundY;
			out.surfaceZ = z;
			out.nx = 0; out.ny = 1; out.nz = 0;
			out.faceNormalX = 0; out.faceNormalY = 1; out.faceNormalZ = 0;
			out.x = x;
			out.y = this.groundY + clearance;
			out.z = z;
			out.barycentricA = 0; out.barycentricB = 0; out.barycentricC = 0;
			out.distance = groundDistance;
			out.distanceSq = groundDistance * groundDistance;
			out.signedDistance = y - this.groundY;
			out.supportId = - 1;
			out.componentId = - 1;
			out.triangleId = - 1;
			out.localTriangleId = - 1;
			out.isGround = true;
			return out;

		}

		let nx = this.normalAX[ bestTriangle ] * bestA
			+ this.normalBX[ bestTriangle ] * bestB
			+ this.normalCX[ bestTriangle ] * bestC;
		let ny = this.normalAY[ bestTriangle ] * bestA
			+ this.normalBY[ bestTriangle ] * bestB
			+ this.normalCY[ bestTriangle ] * bestC;
		let nz = this.normalAZ[ bestTriangle ] * bestA
			+ this.normalBZ[ bestTriangle ] * bestB
			+ this.normalCZ[ bestTriangle ] * bestC;
		let normalLength = Math.hypot( nx, ny, nz );
		if ( normalLength <= EPSILON ) {

			nx = this.faceNormalX[ bestTriangle ];
			ny = this.faceNormalY[ bestTriangle ];
			nz = this.faceNormalZ[ bestTriangle ];
			normalLength = 1;

		}
		nx /= normalLength;
		ny /= normalLength;
		nz /= normalLength;
		const fnx = this.faceNormalX[ bestTriangle ];
		const fny = this.faceNormalY[ bestTriangle ];
		const fnz = this.faceNormalZ[ bestTriangle ];
		if ( nx * fnx + ny * fny + nz * fnz < 0 ) {

			nx = - nx; ny = - ny; nz = - nz;

		}
		out.hit = true;
		out.surfaceX = bestX;
		out.surfaceY = bestY;
		out.surfaceZ = bestZ;
		out.nx = nx; out.ny = ny; out.nz = nz;
		out.faceNormalX = fnx; out.faceNormalY = fny; out.faceNormalZ = fnz;
		out.x = bestX + nx * clearance;
		out.y = bestY + ny * clearance;
		out.z = bestZ + nz * clearance;
		out.barycentricA = bestA;
		out.barycentricB = bestB;
		out.barycentricC = bestC;
		out.distance = Math.sqrt( bestDistanceSq );
		out.distanceSq = bestDistanceSq;
		out.signedDistance = ( x - bestX ) * nx + ( y - bestY ) * ny + ( z - bestZ ) * nz;
		out.supportId = this.supportId[ bestTriangle ];
		out.componentId = this.componentId[ bestTriangle ];
		out.triangleId = bestTriangle;
		out.localTriangleId = this.localTriangleId[ bestTriangle ];
		out.isGround = false;
		return out;

	}

	/**
	 * Adaptively projects and validates one raw segment against the exact mesh.
	 *
	 * Midpoint chord error, normal rotation and leaf length independently cause
	 * subdivision. `trace` owns all result/scratch arrays, so repeated calls do
	 * not allocate. A false `valid` never means an approximate edge is safe.
	 */
	traceSegment( ax, ay, az, bx, by, bz, trace, query = null ) {

		if ( ! trace || trace.capacity < 2
			|| ! trace._stackA || ! trace._stackB || ! trace._hit || ! trace._pointQuery ) {

			throw new TypeError( 'traceSegment requires a reusable chameleon surface trace buffer' );

		}
		const maximumDepth = Math.min(
			trace.maximumDepth,
			clampInteger( finiteOr( query?.maxDepth, trace.maximumDepth ), 0, trace.maximumDepth ),
		);
		const tolerance = Math.max( 1e-6, finiteOr( query?.tolerance, 0.015 ) );
		const maximumLeafLength = Number.isFinite( query?.maxSegmentLength )
			? Math.max( tolerance, query.maxSegmentLength )
			: Infinity;
		const maximumNormalAngle = Math.max(
			0,
			Math.min( Math.PI, finiteOr( query?.maxNormalAngle, Math.PI / 10 ) ),
		);
		const minimumNormalDot = Math.cos( maximumNormalAngle );
		const pointQuery = trace._pointQuery;
		pointQuery.supportId = Number.isInteger( query?.supportId ) ? query.supportId : - 1;
		pointQuery.componentId = Number.isInteger( query?.componentId ) ? query.componentId : - 1;
		pointQuery.includeGround = query?.includeGround === true;
		pointQuery.groundOnly = query?.groundOnly === true;
		pointQuery.nearestGround = query?.nearestGround === true;
		pointQuery.clearance = finiteOr( query?.clearance, 0 );
		pointQuery.maxDistance = Number.isFinite( query?.maxDistance )
			? query.maxDistance
			: Infinity;
		pointQuery.triangleId = Number.isInteger( query?.triangleId ) ? query.triangleId : - 1;
		trace.count = 0;
		trace.valid = true;
		trace.budgetExceeded = false;
		trace.depthExceeded = false;
		trace.projectionFailures = 0;
		trace.validatedSegmentCount = 0;
		trace.maxChordError = 0;
		trace.maxLeafLength = 0;
		trace.maxNormalAngle = 0;

		const hit = trace._hit;
		this.projectPoint( ax, ay, az, hit, pointQuery );
		if ( ! hit.hit ) {

			trace.valid = false;
			trace.projectionFailures = 1;
			return trace;

		}
		const startX = hit.x; const startY = hit.y; const startZ = hit.z;
		const startNX = hit.nx; const startNY = hit.ny; const startNZ = hit.nz;
		const startTriangle = hit.triangleId;
		const startComponent = hit.componentId;
		const startSupport = hit.supportId;
		if ( query?.lockComponent !== false && startComponent >= 0 ) pointQuery.componentId = startComponent;
		pointQuery.triangleId = startTriangle;
		this.projectPoint( bx, by, bz, hit, pointQuery );
		if ( ! hit.hit ) {

			trace.valid = false;
			trace.projectionFailures = 1;
			return trace;

		}
		const endX = hit.x; const endY = hit.y; const endZ = hit.z;
		const endNX = hit.nx; const endNY = hit.ny; const endNZ = hit.nz;
		const endTriangle = hit.triangleId; const endSupport = hit.supportId;
		const endComponent = hit.componentId;
		writeTraceOutput(
			trace, 0,
			startX, startY, startZ,
			startNX, startNY, startNZ,
			startTriangle, startComponent, startSupport,
		);
		trace.count = 1;
		trace.distance[ 0 ] = 0;

		let stackSize = 1;
		trace._stackT0[ 0 ] = 0;
		trace._stackT1[ 0 ] = 1;
		trace._stackDepth[ 0 ] = 0;
		let packed = 0;
		trace._stackA[ packed ] = startX;
		trace._stackA[ packed + 1 ] = startY;
		trace._stackA[ packed + 2 ] = startZ;
		trace._stackA[ packed + 3 ] = startNX;
		trace._stackA[ packed + 4 ] = startNY;
		trace._stackA[ packed + 5 ] = startNZ;
		trace._stackA[ packed + 6 ] = startTriangle;
		trace._stackA[ packed + 7 ] = startSupport;
		trace._stackB[ packed ] = endX;
		trace._stackA[ packed + 8 ] = startComponent;
		trace._stackB[ packed + 1 ] = endY;
		trace._stackB[ packed + 2 ] = endZ;
		trace._stackB[ packed + 3 ] = endNX;
		trace._stackB[ packed + 4 ] = endNY;
		trace._stackB[ packed + 5 ] = endNZ;
		trace._stackB[ packed + 6 ] = endTriangle;
		trace._stackB[ packed + 7 ] = endSupport;

		trace._stackB[ packed + 8 ] = endComponent;
		while ( stackSize > 0 ) {

			const slot = -- stackSize;
			packed = slot * TRACE_POINT_STRIDE;
			const t0 = trace._stackT0[ slot ];
			const t1 = trace._stackT1[ slot ];
			const depth = trace._stackDepth[ slot ];
			const x0 = trace._stackA[ packed ];
			const y0 = trace._stackA[ packed + 1 ];
			const z0 = trace._stackA[ packed + 2 ];
			const nx0 = trace._stackA[ packed + 3 ];
			const ny0 = trace._stackA[ packed + 4 ];
			const nz0 = trace._stackA[ packed + 5 ];
			const triangle0 = trace._stackA[ packed + 6 ];
			const support0 = trace._stackA[ packed + 7 ];
			const x1 = trace._stackB[ packed ];
			const component0 = trace._stackA[ packed + 8 ];
			const y1 = trace._stackB[ packed + 1 ];
			const z1 = trace._stackB[ packed + 2 ];
			const nx1 = trace._stackB[ packed + 3 ];
			const ny1 = trace._stackB[ packed + 4 ];
			const nz1 = trace._stackB[ packed + 5 ];
			const triangle1 = trace._stackB[ packed + 6 ];
			const support1 = trace._stackB[ packed + 7 ];
			const middleT = ( t0 + t1 ) * 0.5;
			const component1 = trace._stackB[ packed + 8 ];
			pointQuery.triangleId = triangle0 >= 0 ? triangle0 : triangle1;
			const chordMiddleX = ( x0 + x1 ) * 0.5;
			const chordMiddleY = ( y0 + y1 ) * 0.5;
			const chordMiddleZ = ( z0 + z1 ) * 0.5;
			this.projectPoint(
				chordMiddleX,
				chordMiddleY,
				chordMiddleZ,
				hit,
				pointQuery,
			);
			let middleX = ( x0 + x1 ) * 0.5;
			let middleY = ( y0 + y1 ) * 0.5;
			let middleZ = ( z0 + z1 ) * 0.5;
			let middleNX = ( nx0 + nx1 ) * 0.5;
			let middleNY = ( ny0 + ny1 ) * 0.5;
			let middleNZ = ( nz0 + nz1 ) * 0.5;
			let middleTriangle = - 1;
			let middleSupport = - 1;
			let middleComponent = - 1;
			if ( hit.hit ) {

				middleX = hit.x; middleY = hit.y; middleZ = hit.z;
				middleNX = hit.nx; middleNY = hit.ny; middleNZ = hit.nz;
				middleTriangle = hit.triangleId;
				middleSupport = hit.supportId;

				middleComponent = hit.componentId;
			} else {

				trace.valid = false;
				trace.projectionFailures ++;

			}
			const chordError = Math.hypot(
				middleX - chordMiddleX,
				middleY - chordMiddleY,
				middleZ - chordMiddleZ,
			);
			const leafLength = Math.hypot( x1 - x0, y1 - y0, z1 - z0 );
			const normalDot = Math.min(
				nx0 * nx1 + ny0 * ny1 + nz0 * nz1,
				nx0 * middleNX + ny0 * middleNY + nz0 * middleNZ,
				middleNX * nx1 + middleNY * ny1 + middleNZ * nz1,
			);
			/*
			 * A physical portal is a real discontinuity: for example the last
			 * point on a vertical trunk and the first point on the ground have
			 * different support/component ids and normals. Subdivision cannot
			 * make that 90-degree normal jump disappear. It can, however,
			 * localise the two projected sides until they are epsilon-close.
			 *
			 * Only relax the normal criterion after both the projected endpoint
			 * gap and the chord error are bounded. Disconnected surfaces retain
			 * a finite gap and therefore still exhaust the depth budget instead
			 * of being accepted as a shortcut.
			 */
			const topologyChanged = support0 !== support1 || component0 !== component1;
			const topologyConverged = topologyChanged
				&& leafLength <= tolerance * 2
				&& chordError <= tolerance;
			const requiresSplit = hit.hit && (
				chordError > tolerance
				|| leafLength > maximumLeafLength
				|| ( normalDot < minimumNormalDot && ! topologyConverged )
			);
			if ( requiresSplit && depth < maximumDepth ) {

				const rightSlot = stackSize ++;
				const rightOffset = rightSlot * TRACE_POINT_STRIDE;
				trace._stackT0[ rightSlot ] = middleT;
				trace._stackT1[ rightSlot ] = t1;
				trace._stackDepth[ rightSlot ] = depth + 1;
				trace._stackA[ rightOffset ] = middleX;
				trace._stackA[ rightOffset + 1 ] = middleY;
				trace._stackA[ rightOffset + 2 ] = middleZ;
				trace._stackA[ rightOffset + 3 ] = middleNX;
				trace._stackA[ rightOffset + 4 ] = middleNY;
				trace._stackA[ rightOffset + 5 ] = middleNZ;
				trace._stackA[ rightOffset + 6 ] = middleTriangle;
				trace._stackA[ rightOffset + 7 ] = middleSupport;
				trace._stackB[ rightOffset ] = x1;
				trace._stackA[ rightOffset + 8 ] = middleComponent;
				trace._stackB[ rightOffset + 1 ] = y1;
				trace._stackB[ rightOffset + 2 ] = z1;
				trace._stackB[ rightOffset + 3 ] = nx1;
				trace._stackB[ rightOffset + 4 ] = ny1;
				trace._stackB[ rightOffset + 5 ] = nz1;
				trace._stackB[ rightOffset + 6 ] = triangle1;
				trace._stackB[ rightOffset + 7 ] = support1;

				trace._stackB[ rightOffset + 8 ] = component1;
				const leftSlot = stackSize ++;
				const leftOffset = leftSlot * TRACE_POINT_STRIDE;
				trace._stackT0[ leftSlot ] = t0;
				trace._stackT1[ leftSlot ] = middleT;
				trace._stackDepth[ leftSlot ] = depth + 1;
				trace._stackA[ leftOffset ] = x0;
				trace._stackA[ leftOffset + 1 ] = y0;
				trace._stackA[ leftOffset + 2 ] = z0;
				trace._stackA[ leftOffset + 3 ] = nx0;
				trace._stackA[ leftOffset + 4 ] = ny0;
				trace._stackA[ leftOffset + 5 ] = nz0;
				trace._stackA[ leftOffset + 6 ] = triangle0;
				trace._stackA[ leftOffset + 7 ] = support0;
				trace._stackB[ leftOffset ] = middleX;
				trace._stackA[ leftOffset + 8 ] = component0;
				trace._stackB[ leftOffset + 1 ] = middleY;
				trace._stackB[ leftOffset + 2 ] = middleZ;
				trace._stackB[ leftOffset + 3 ] = middleNX;
				trace._stackB[ leftOffset + 4 ] = middleNY;
				trace._stackB[ leftOffset + 5 ] = middleNZ;
				trace._stackB[ leftOffset + 6 ] = middleTriangle;
				trace._stackB[ leftOffset + 7 ] = middleSupport;
				trace._stackB[ leftOffset + 8 ] = middleComponent;
				continue;

			}
			if ( requiresSplit ) {

				trace.valid = false;
				trace.depthExceeded = true;

			}
			trace.maxChordError = Math.max( trace.maxChordError, chordError );
			trace.maxLeafLength = Math.max( trace.maxLeafLength, leafLength );
			trace.maxNormalAngle = Math.max(
				trace.maxNormalAngle,
				Math.acos( Math.max( - 1, Math.min( 1, normalDot ) ) ),
			);
			trace.validatedSegmentCount ++;
			if ( trace.count >= trace.capacity ) {

				trace.valid = false;
				trace.budgetExceeded = true;
				break;

			}
			const outputIndex = trace.count ++;
			writeTraceOutput(
				trace, outputIndex,
				x1, y1, z1,
				nx1, ny1, nz1,
				triangle1, component1, support1,
			);
			trace.distance[ outputIndex ] = trace.distance[ outputIndex - 1 ] + leafLength;

		}
		return trace;

	}

	/**
	 * Projects a route in place or into a preallocated projection buffer.
	 * Supplying `output` makes the entire operation allocation-free.
	 */
	projectCorridor( corridor, clearance = 0, output = null, query = null ) {

		const count = Math.max( 0, Math.floor( corridor?.count || 0 ) );
		if ( ! corridor?.x || ! corridor?.y || ! corridor?.z ) {

			throw new TypeError( 'projectCorridor requires x/y/z SoA inputs' );

		}
		const result = output || createChameleonProjectionBuffer( count || 1 );
		if ( result.x.length < count || result.y.length < count || result.z.length < count
			|| result.normalX.length < count || result.normalY.length < count || result.normalZ.length < count ) {

			throw new RangeError( 'projection output capacity is smaller than the corridor' );

		}
		const localQuery = this._corridorQuery;
		localQuery.clearance = clearance;
		localQuery.maxDistance = query?.maxDistance === Infinity
			? Infinity
			: Number.isFinite( query?.maxDistance )
				? query.maxDistance
				: this.defaultMaxDistance;
		localQuery.includeGround = query?.includeGround !== false;
		localQuery.groundOnly = query?.groundOnly === true;
		const useCorridorSupport = query?.useCorridorSupport === true;
		const useCorridorComponent = query?.useCorridorComponent !== false && !! corridor.componentId;
		const useCorridorTriangle = query?.useCorridorTriangle !== false && !! corridor.triangleId;
		const fixedSupport = Number.isInteger( query?.supportId ) ? query.supportId : - 1;
		const fixedComponent = Number.isInteger( query?.componentId ) ? query.componentId : - 1;
		const fixedTriangle = Number.isInteger( query?.triangleId ) ? query.triangleId : - 1;
		for ( let index = 0; index < count; index ++ ) {

			localQuery.supportId = useCorridorSupport && corridor.supportId
				? corridor.supportId[ index ]
				: fixedSupport;
			localQuery.componentId = useCorridorComponent
				? corridor.componentId[ index ]
				: fixedComponent;
			localQuery.triangleId = useCorridorTriangle
				? corridor.triangleId[ index ]
				: fixedTriangle;
			this.projectPoint(
				corridor.x[ index ],
				corridor.y[ index ],
				corridor.z[ index ],
				this._corridorHit,
				localQuery,
			);
			if ( this._corridorHit.hit ) {

				result.x[ index ] = this._corridorHit.x;
				result.y[ index ] = this._corridorHit.y;
				result.z[ index ] = this._corridorHit.z;
				result.normalX[ index ] = this._corridorHit.nx;
				result.normalY[ index ] = this._corridorHit.ny;
				result.normalZ[ index ] = this._corridorHit.nz;
				if ( result.projectionDistance ) result.projectionDistance[ index ] = this._corridorHit.distance;
				if ( result.supportId ) result.supportId[ index ] = this._corridorHit.supportId;
				if ( result.componentId ) result.componentId[ index ] = this._corridorHit.componentId;
				if ( result.triangleId ) result.triangleId[ index ] = this._corridorHit.triangleId;
				if ( result.hit ) result.hit[ index ] = 1;

			} else {

				result.x[ index ] = corridor.x[ index ];
				result.y[ index ] = corridor.y[ index ];
				result.z[ index ] = corridor.z[ index ];
				result.normalX[ index ] = corridor.normalX?.[ index ] || 0;
				result.normalY[ index ] = corridor.normalY?.[ index ] || 1;
				result.normalZ[ index ] = corridor.normalZ?.[ index ] || 0;
				if ( result.projectionDistance ) result.projectionDistance[ index ] = Infinity;
				if ( result.supportId ) result.supportId[ index ] = - 1;
				if ( result.componentId ) result.componentId[ index ] = - 1;
				if ( result.triangleId ) result.triangleId[ index ] = - 1;
				if ( result.hit ) result.hit[ index ] = 0;

			}

		}
		if ( result.distance && count > 0 ) result.distance[ 0 ] = 0;
		for ( let index = 0; index < count; index ++ ) {

			const before = Math.max( 0, index - 1 );
			const after = Math.min( count - 1, index + 1 );
			let tx = result.x[ after ] - result.x[ before ];
			let ty = result.y[ after ] - result.y[ before ];
			let tz = result.z[ after ] - result.z[ before ];
			const tangentLength = Math.hypot( tx, ty, tz ) || 1;
			tx /= tangentLength;
			ty /= tangentLength;
			tz /= tangentLength;
			let nx = result.normalX[ index ];
			let ny = result.normalY[ index ];
			let nz = result.normalZ[ index ];
			const projection = nx * tx + ny * ty + nz * tz;
			nx -= tx * projection;
			ny -= ty * projection;
			nz -= tz * projection;
			const normalLength = Math.hypot( nx, ny, nz ) || 1;
			result.normalX[ index ] = nx / normalLength;
			result.normalY[ index ] = ny / normalLength;
			result.normalZ[ index ] = nz / normalLength;
			if ( result.tangentX ) result.tangentX[ index ] = tx;
			if ( result.tangentY ) result.tangentY[ index ] = ty;
			if ( result.tangentZ ) result.tangentZ[ index ] = tz;
			if ( result.distance && index > 0 ) {

				result.distance[ index ] = result.distance[ index - 1 ] + Math.hypot(
					result.x[ index ] - result.x[ index - 1 ],
					result.y[ index ] - result.y[ index - 1 ],
					result.z[ index ] - result.z[ index - 1 ],
				);

			}

		}
		result.count = count;
		return result;

	}

}

/**
 * Bake rendered prop triangles using placement translation/yaw/uniform scale
 * multiplied by the live category scale. No Three.js dependency is required.
 */
export function buildChameleonSurfaceCollider( registry, {
	scales = null,
	groundY = 0.018,
	walkableModels = DEFAULT_WALKABLE_MODELS,
	maxTriangles = 200000,
	leafSize = 8,
	weldEpsilon = 1e-5,
	defaultMaxDistance = 2.5,
} = {} ) {

	let modelFilter;
	if ( walkableModels === null || walkableModels === '*' ) {

		modelFilter = walkableModels;

	} else if ( walkableModels instanceof Set ) {

		modelFilter = walkableModels;

	} else {

		modelFilter = new Set( walkableModels || CHAMELEON_WALKABLE_MODELS );

	}
	const safeMaximum = clampInteger( finiteOr( maxTriangles, 200000 ), 1, 1000000 );
	const collected = collectTriangles( registry, {
		scales,
		walkableModels: modelFilter,
		maxTriangles: safeMaximum,
	} );
	const triangles = typedTriangles( collected.builder );
	const adjacency = buildAdjacency(
		triangles,
		Math.max( 1e-9, finiteOr( weldEpsilon, 1e-5 ) ),
	);
	const bvh = buildBvh(
		triangles,
		clampInteger( finiteOr( leafSize, 8 ), 2, 32 ),
	);
	return new ChameleonSurfaceCollider(
		triangles,
		collected.supports,
		adjacency,
		bvh,
		{
			groundY: finiteOr( groundY, 0.018 ),
			defaultMaxDistance: Number.isFinite( defaultMaxDistance )
				? Math.max( 0, defaultMaxDistance )
				: Infinity,
		},
	);

}
