import * as THREE from 'three/webgpu';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';

import { ENVIRONMENT_GROUP } from './chameleon-lab/environment.js';
import { createPhysicsWorld } from './chameleon-lab/physics-world.js';
import { createSurfaceAppearanceBinding } from './chameleon-lab/surface-appearance.js';
import { buildLabSurfaceNavigationGraph } from './chameleon-lab/surface-navigation-graph.js';

const LINEAR_MODELS = new Set( [ 'Log_01', 'Log_02', 'Branch' ] );
const ROCK_MODELS = new Set( [
	'Stump_01', 'BigRock_03',
	'Rock_01', 'Rock_02', 'Rock_03', 'Rock_04', 'Rock_05',
] );
const TREE_MODELS = new Set( [
	'Tree_01', 'Tree_02', 'Tree_06', 'Tree_07', 'Tree_08',
] );
const MAXIMUM_HULL_SUPPORT_POINTS = 72;
const TREE_TRUNK_SAMPLE_FRACTION = 0.24;
const TREE_TRUNK_HEIGHT_FRACTION = 0.62;
const TREE_TRUNK_MIN_RADIUS_RATIO = 0.012;
const TREE_TRUNK_MAX_RADIUS_RATIO = 0.065;

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function quantile( values, alpha ) {

	if ( values.length === 0 ) return 0;
	values.sort( ( a, b ) => a - b );
	return values[ Math.min(
		values.length - 1,
		Math.max( 0, Math.round( ( values.length - 1 ) * alpha ) ),
	) ];

}

function sourcePosition( geometry ) {

	const position = geometry?.getAttribute?.( 'position' );
	if ( ! position || position.count < 3 )
		throw new TypeError( 'walkable prop geometry requires at least three positions' );
	return position;

}

function placementTransform( entry, placementIndex ) {

	const placement = entry.placements?.[ placementIndex ] ?? {};
	const matrix = new THREE.Matrix4();
	if ( entry.mesh?.isInstancedMesh && typeof entry.mesh.getMatrixAt === 'function' ) {

		entry.mesh.updateMatrixWorld?.( true );
		entry.mesh.getMatrixAt( placementIndex, matrix );
		matrix.premultiply( entry.mesh.matrixWorld );

	} else {

		matrix.compose(
			new THREE.Vector3(
				finiteOr( placement.x, 0 ),
				finiteOr( placement.y, 0 ),
				finiteOr( placement.z, 0 ),
			),
			new THREE.Quaternion().setFromEuler(
				new THREE.Euler( 0, finiteOr( placement.yaw, 0 ), 0 ),
			),
			new THREE.Vector3().setScalar( Math.max( 1e-4, Math.abs(
				finiteOr( placement.scale, 1 ),
			) ) ),
		);

	}
	const position = new THREE.Vector3();
	const quaternion = new THREE.Quaternion();
	const scale = new THREE.Vector3();
	matrix.decompose( position, quaternion, scale );
	scale.set( Math.abs( scale.x ), Math.abs( scale.y ), Math.abs( scale.z ) );
	return { matrix, position, quaternion, scale };

}

function proxyMesh( geometry, name, transform ) {

	const object = new THREE.Mesh( geometry, null );
	object.name = name;
	object.visible = false;
	object.frustumCulled = false;
	object.position.copy( transform.position );
	object.quaternion.copy( transform.quaternion );
	object.scale.copy( transform.scale );
	object.updateMatrixWorld( true );
	return object;

}

function geometryTriangleBuffers( geometry, scale ) {

	const position = sourcePosition( geometry );
	const vertices = new Float32Array( position.count * 3 );
	for ( let vertex = 0; vertex < position.count; vertex ++ ) {

		vertices[ vertex * 3 ] = position.getX( vertex ) * scale.x;
		vertices[ vertex * 3 + 1 ] = position.getY( vertex ) * scale.y;
		vertices[ vertex * 3 + 2 ] = position.getZ( vertex ) * scale.z;

	}
	const sourceIndex = geometry.getIndex?.() ?? geometry.index;
	let indices;
	if ( sourceIndex ) {

		indices = new Uint32Array( sourceIndex.count );
		for ( let index = 0; index < sourceIndex.count; index ++ )
			indices[ index ] = sourceIndex.getX( index );

	} else {

		const triangleVertexCount = position.count - position.count % 3;
		indices = new Uint32Array( triangleVertexCount );
		for ( let index = 0; index < triangleVertexCount; index ++ ) indices[ index ] = index;

	}
	return { vertices, indices };

}

function geometryVertexCloud( geometry, scale ) {

	return geometryTriangleBuffers( geometry, scale ).vertices;

}

function hullSupportPoints( geometry, maximum = MAXIMUM_HULL_SUPPORT_POINTS ) {

	const position = sourcePosition( geometry );
	const unique = new Map();
	for ( let index = 0; index < position.count; index ++ ) {

		const x = position.getX( index );
		const y = position.getY( index );
		const z = position.getZ( index );
		const key = `${ Math.round( x * 100000 ) },${ Math.round( y * 100000 ) },${ Math.round( z * 100000 ) }`;
		if ( ! unique.has( key ) ) unique.set( key, new THREE.Vector3( x, y, z ) );

	}
	const points = Array.from( unique.values() );
	if ( points.length <= maximum ) return points;
	const selected = new Map();
	const direction = new THREE.Vector3();
	for ( let sample = 0; sample < maximum; sample ++ ) {

		// Fibonacci sphere directions retain thin log ends and irregular rock
		// extrema while strictly bounding the one-time hull complexity.
		const y = 1 - 2 * ( sample + 0.5 ) / maximum;
		const radius = Math.sqrt( Math.max( 0, 1 - y * y ) );
		const angle = sample * Math.PI * ( 3 - Math.sqrt( 5 ) );
		direction.set( Math.cos( angle ) * radius, y, Math.sin( angle ) * radius );
		let best = points[ 0 ];
		let bestDot = -Infinity;
		for ( const point of points ) {

			const dot = point.dot( direction );
			if ( dot > bestDot ) {

				best = point;
				bestDot = dot;

			}

		}
		selected.set( `${ best.x },${ best.y },${ best.z }`, best );

	}
	return Array.from( selected.values() );

}

function convexProxyGeometry( source ) {

	let points = hullSupportPoints( source );
	if ( points.length < 4 ) {

		source.computeBoundingBox?.();
		const bounds = source.boundingBox;
		if ( ! bounds ) throw new Error( 'cannot derive a convex proxy without bounds' );
		points = [];
		for ( const x of [ bounds.min.x, bounds.max.x ] )
			for ( const y of [ bounds.min.y, bounds.max.y ] )
				for ( const z of [ bounds.min.z, bounds.max.z ] )
					points.push( new THREE.Vector3( x, y, z ) );

	}
	const geometry = new ConvexGeometry( points );
	geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	return geometry;

}

function measureTreeTrunk( geometry ) {

	const position = sourcePosition( geometry );
	geometry.computeBoundingBox?.();
	const bounds = geometry.boundingBox;
	if ( ! bounds ) throw new Error( 'tree geometry has no bounds' );
	const height = Math.max( 1e-4, bounds.max.y - bounds.min.y );
	const ceiling = bounds.min.y + height * TREE_TRUNK_SAMPLE_FRACTION;
	const lowX = [];
	const lowZ = [];
	for ( let vertex = 0; vertex < position.count; vertex ++ ) {

		if ( position.getY( vertex ) > ceiling ) continue;
		lowX.push( position.getX( vertex ) );
		lowZ.push( position.getZ( vertex ) );

	}
	const centerX = lowX.length > 0
		? quantile( lowX, 0.5 )
		: ( bounds.min.x + bounds.max.x ) * 0.5;
	const centerZ = lowZ.length > 0
		? quantile( lowZ, 0.5 )
		: ( bounds.min.z + bounds.max.z ) * 0.5;
	const radii = [];
	for ( let vertex = 0; vertex < position.count; vertex ++ ) {

		if ( position.getY( vertex ) > ceiling ) continue;
		radii.push( Math.hypot(
			position.getX( vertex ) - centerX,
			position.getZ( vertex ) - centerZ,
		) );

	}
	const measuredRadius = quantile( radii, 0.68 );
	const radius = THREE.MathUtils.clamp(
		measuredRadius || height * 0.035,
		height * TREE_TRUNK_MIN_RADIUS_RATIO,
		height * TREE_TRUNK_MAX_RADIUS_RATIO,
	);
	return Object.freeze( {
		centerX,
		centerZ,
		baseY: bounds.min.y,
		height: height * TREE_TRUNK_HEIGHT_FRACTION,
		radius,
	} );

}

function transformedTreeProxy( geometry, measurement, transform, name ) {

	const localCenter = new THREE.Vector3(
		measurement.centerX,
		measurement.baseY + measurement.height * 0.5,
		measurement.centerZ,
	);
	const worldCenter = localCenter.applyMatrix4( transform.matrix );
	const proxyTransform = {
		position: worldCenter,
		quaternion: transform.quaternion,
		scale: transform.scale,
	};
	return proxyMesh( geometry, name, proxyTransform );

}

function colliderTransform( descriptor, object ) {

	return descriptor
		.setTranslation( object.position.x, object.position.y, object.position.z )
		.setRotation( {
			x: object.quaternion.x,
			y: object.quaternion.y,
			z: object.quaternion.z,
			w: object.quaternion.w,
		} );

}

function surfaceSpecification( model, object, scale, measurement = null ) {

	if ( TREE_MODELS.has( model ) ) {

		const axis = new THREE.Vector3( 0, 1, 0 ).applyQuaternion( object.quaternion ).normalize();
		return {
			kind: 'branch',
			appearanceKind: 'bark',
			friction: 1.15,
			gripStrengthScale: 1.2,
			supportTopology: 'radial-branch',
			branchAxis: axis.toArray(),
			branchRadius: measurement.radius * Math.max( scale.x, scale.z ),
			destinationKind: 'tree',
			destinationWeight: 2,
		};

	}
	if ( LINEAR_MODELS.has( model ) ) {

		const axis = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( object.quaternion ).normalize();
		object.geometry.computeBoundingBox?.();
		const bounds = object.geometry.boundingBox;
		const radius = bounds
			? Math.max( bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y )
				* Math.max( scale.x, scale.y ) * 0.5
			: 0.3;
		return {
			kind: 'branch',
			appearanceKind: 'bark',
			friction: 1.15,
			gripStrengthScale: 1.25,
			supportTopology: 'radial-branch',
			branchAxis: axis.toArray(),
			branchRadius: radius,
			destinationKind: 'log',
			destinationWeight: 4,
		};

	}
	return {
		kind: 'rough-rock',
		appearanceKind: 'stone',
		friction: 0.96,
		gripStrengthScale: 0.96,
		supportTopology: 'convex-shell',
		destinationKind: model === 'Stump_01' ? 'stump' : 'rock',
		destinationWeight: model === 'Stump_01' ? 2.7 : 2.5,
	};

}

function registerCollider(
	physics,
	staticBody,
	object,
	descriptor,
	provenance,
	specification,
	supportMetadataByHandle,
) {

	const collider = physics.world.createCollider(
		colliderTransform( descriptor, object )
			.setFriction( specification.friction )
			.setRestitution( 0.02 )
			.setCollisionGroups( ENVIRONMENT_GROUP ),
		staticBody,
	);
	const appearance = createSurfaceAppearanceBinding(
		object, specification.appearanceKind,
	);
	const metadata = Object.freeze( {
		kind: specification.kind,
		clawEligible: true,
		gripStrengthScale: specification.gripStrengthScale,
		friction: specification.friction,
		supportTopology: specification.supportTopology,
		...( specification.branchAxis ? { branchAxis: specification.branchAxis } : {} ),
		...( Number.isFinite( specification.branchRadius )
			? { branchRadius: specification.branchRadius } : {} ),
		appearance,
		provenance,
		model: provenance.model,
		category: provenance.category,
		placementIndex: provenance.placementIndex,
	} );
	physics.surfaceByCollider.set( collider.handle, metadata );
	supportMetadataByHandle.set( collider.handle, metadata );
	object.userData.physicsColliderHandle = collider.handle;
	object.userData.surface = metadata;
	return { body: staticBody, collider, object };

}

/**
 * Immutable XZ spatial index for event-driven prey projection. Queries write
 * the exact nearest candidates into caller-owned typed arrays, so many agents
 * can share one bake without scanning every surface node or allocating.
 */
export function createSurfaceNodeSpatialIndex( navigation, {
	cellSize = Math.max( 1, finiteOr( navigation?.spacing, 0.62 ) * 2 ),
} = {} ) {

	if ( ! navigation?.positions || ! Number.isInteger( navigation.nodeCount ) )
		throw new TypeError( 'surface node index requires a baked navigation graph' );
	const count = navigation.nodeCount;
	const positions = navigation.positions;
	const size = Math.max( 0.25, finiteOr( cellSize, 1.25 ) );
	let minimumX = Infinity;
	let maximumX = -Infinity;
	let minimumZ = Infinity;
	let maximumZ = -Infinity;
	for ( let node = 0; node < count; node ++ ) {

		const offset = node * 3;
		minimumX = Math.min( minimumX, positions[ offset ] );
		maximumX = Math.max( maximumX, positions[ offset ] );
		minimumZ = Math.min( minimumZ, positions[ offset + 2 ] );
		maximumZ = Math.max( maximumZ, positions[ offset + 2 ] );

	}
	if ( count === 0 ) minimumX = maximumX = minimumZ = maximumZ = 0;
	const width = Math.max( 1, Math.floor( ( maximumX - minimumX ) / size ) + 1 );
	const depth = Math.max( 1, Math.floor( ( maximumZ - minimumZ ) / size ) + 1 );
	const bucketCount = width * depth;
	const counts = new Uint32Array( bucketCount );
	const bucketFor = ( x, z ) => {

		const cellX = Math.min( width - 1, Math.max( 0, Math.floor( ( x - minimumX ) / size ) ) );
		const cellZ = Math.min( depth - 1, Math.max( 0, Math.floor( ( z - minimumZ ) / size ) ) );
		return cellZ * width + cellX;

	};
	for ( let node = 0; node < count; node ++ ) {

		const offset = node * 3;
		counts[ bucketFor( positions[ offset ], positions[ offset + 2 ] ) ] ++;

	}
	const offsets = new Uint32Array( bucketCount + 1 );
	for ( let bucket = 0; bucket < bucketCount; bucket ++ )
		offsets[ bucket + 1 ] = offsets[ bucket ] + counts[ bucket ];
	const cursor = offsets.slice( 0, bucketCount );
	const nodes = new Uint32Array( count );
	for ( let node = 0; node < count; node ++ ) {

		const offset = node * 3;
		const bucket = bucketFor( positions[ offset ], positions[ offset + 2 ] );
		nodes[ cursor[ bucket ] ++ ] = node;

	}

	return Object.freeze( {
		cellSize: size,
		width,
		depth,
		nodeCount: count,
		queryNearest(
			x, y, z,
			outputNodes,
			outputScores,
			maximum = outputNodes?.length ?? 0,
			centerX = 0,
			centerY = 0,
			centerZ = 0,
			radius = Infinity,
		) {

			if ( ! outputNodes || ! outputScores )
				throw new TypeError( 'nearest query requires caller-owned node and score arrays' );
			const limit = Math.max( 0, Math.min(
				outputNodes.length,
				outputScores.length,
				Math.trunc( maximum ),
			) );
			for ( let index = 0; index < limit; index ++ ) {

				outputNodes[ index ] = -1;
				outputScores[ index ] = Infinity;

			}
			if ( limit === 0 || count === 0 ) return 0;
			const queryX = finiteOr( x, 0 );
			const queryY = finiteOr( y, 0 );
			const queryZ = finiteOr( z, 0 );
			const queryCellX = Math.min(
				width - 1,
				Math.max( 0, Math.floor( ( queryX - minimumX ) / size ) ),
			);
			const queryCellZ = Math.min(
				depth - 1,
				Math.max( 0, Math.floor( ( queryZ - minimumZ ) / size ) ),
			);
			const radiusSquared = Number.isFinite( radius )
				? Math.max( 0, radius ) ** 2 : Infinity;
			let found = 0;
			const visit = ( cellX, cellZ ) => {

				if ( cellX < 0 || cellX >= width || cellZ < 0 || cellZ >= depth ) return;
				const bucket = cellZ * width + cellX;
				for ( let slot = offsets[ bucket ]; slot < offsets[ bucket + 1 ]; slot ++ ) {

					const node = nodes[ slot ];
					const offset = node * 3;
					const roamX = positions[ offset ] - centerX;
					const roamY = positions[ offset + 1 ] - centerY;
					const roamZ = positions[ offset + 2 ] - centerZ;
					if ( roamX * roamX + roamY * roamY + roamZ * roamZ > radiusSquared ) continue;
					const dx = positions[ offset ] - queryX;
					const dy = positions[ offset + 1 ] - queryY;
					const dz = positions[ offset + 2 ] - queryZ;
					const score = dx * dx + dz * dz + dy * dy * 0.28
						+ ( dy > 0 ? dy * dy * 2.5 : 0 );
					if ( score >= outputScores[ limit - 1 ] ) continue;
					let insertion = Math.min( found, limit - 1 );
					while ( insertion > 0 && score < outputScores[ insertion - 1 ] ) {

						if ( insertion < limit ) {

							outputScores[ insertion ] = outputScores[ insertion - 1 ];
							outputNodes[ insertion ] = outputNodes[ insertion - 1 ];

						}
						insertion --;

					}
					outputScores[ insertion ] = score;
					outputNodes[ insertion ] = node;
					found = Math.min( limit, found + 1 );

				}

			};
			const maximumRing = Math.max( width, depth );
			for ( let ring = 0; ring < maximumRing; ring ++ ) {

				const left = queryCellX - ring;
				const right = queryCellX + ring;
				const near = queryCellZ - ring;
				const far = queryCellZ + ring;
				for ( let cellX = left; cellX <= right; cellX ++ ) {

					visit( cellX, near );
					if ( far !== near ) visit( cellX, far );

				}
				for ( let cellZ = near + 1; cellZ < far; cellZ ++ ) {

					visit( left, cellZ );
					if ( right !== left ) visit( right, cellZ );

				}
				if ( found < limit ) continue;
				const visitedLeft = Math.max( 0, left );
				const visitedRight = Math.min( width - 1, right );
				const visitedNear = Math.max( 0, near );
				const visitedFar = Math.min( depth - 1, far );
				let nearestUnvisited = Infinity;
				if ( visitedLeft > 0 ) nearestUnvisited = Math.min(
					nearestUnvisited,
					Math.max( 0, queryX - ( minimumX + visitedLeft * size ) ),
				);
				if ( visitedRight < width - 1 ) nearestUnvisited = Math.min(
					nearestUnvisited,
					Math.max( 0, minimumX + ( visitedRight + 1 ) * size - queryX ),
				);
				if ( visitedNear > 0 ) nearestUnvisited = Math.min(
					nearestUnvisited,
					Math.max( 0, queryZ - ( minimumZ + visitedNear * size ) ),
				);
				if ( visitedFar < depth - 1 ) nearestUnvisited = Math.min(
					nearestUnvisited,
					Math.max( 0, minimumZ + ( visitedFar + 1 ) * size - queryZ ),
				);
				if ( nearestUnvisited * nearestUnvisited > outputScores[ limit - 1 ] ) break;

			}
			return found;

		},
	} );

}

/**
 * Builds the production clearing's physical support manifold once. Rendered
 * InstancedMesh props stay untouched: small hidden proxy objects only expose
 * their transform and shared geometry to Rapier and the immutable A* bake.
 */
export async function createMainChameleonSurfaceWorld( {
	props,
	ground,
	worldSize,
	fixedDt = 1 / 120,
	maxSubsteps = 4,
} = {} ) {

	if ( ! Array.isArray( props?.registry ) )
		throw new TypeError( 'main chameleon surfaces require props.registry' );
	if ( ! ground?.isMesh || ! ground.geometry )
		throw new TypeError( 'main chameleon surfaces require the rendered ground mesh' );
	if ( ! Number.isFinite( worldSize ) || worldSize <= 0 )
		throw new RangeError( 'worldSize must be a positive finite number' );
	const physics = await createPhysicsWorld( {
		gravity: { x: 0, y: -9.81, z: 0 },
		fixedDt,
		maxSubsteps,
	} );
	physics.surfaceByCollider = new Map();
	const supportMetadataByHandle = new Map();
	const ownedGeometries = new Set();
	const convexByModel = new Map();
	const treeByModel = new Map();
	const entries = [];
	const destinationHandles = [];
	let disposed = false;
	try {

		// All immutable environment colliders share one fixed body. Handles remain
		// distinct, preserving foot ownership and camouflage votes.
		const staticBody = physics.world.createRigidBody(
			physics.RAPIER.RigidBodyDesc.fixed().setUserData( {
				owner: 'main-chameleon-surfaces',
			} ),
		);

		ground.updateMatrixWorld( true );
		const groundPosition = new THREE.Vector3();
		const groundQuaternion = new THREE.Quaternion();
		const groundScale = new THREE.Vector3();
		ground.matrixWorld.decompose( groundPosition, groundQuaternion, groundScale );
		groundScale.set(
			Math.abs( groundScale.x ),
			Math.abs( groundScale.y ),
			Math.abs( groundScale.z ),
		);
		const groundProxy = proxyMesh( ground.geometry, 'RoughGround', {
			position: groundPosition,
			quaternion: groundQuaternion,
			scale: groundScale,
		} );
		const groundBuffers = geometryTriangleBuffers( ground.geometry, groundScale );
		const groundFlags = ( physics.RAPIER.TriMeshFlags?.MERGE_DUPLICATE_VERTICES ?? 0 )
			| ( physics.RAPIER.TriMeshFlags?.DELETE_DEGENERATE_TRIANGLES ?? 0 );
		const groundProvenance = Object.freeze( {
			model: '__ground__',
			category: 'terrain',
			placementIndex: -1,
		} );
		const groundEntry = registerCollider(
			physics,
			staticBody,
			groundProxy,
			physics.RAPIER.ColliderDesc.trimesh(
				groundBuffers.vertices, groundBuffers.indices, groundFlags,
			),
			groundProvenance,
			{
				kind: 'soil',
				appearanceKind: 'soil',
				friction: 1.2,
				gripStrengthScale: 1.05,
				supportTopology: 'faceted-shell',
			},
			supportMetadataByHandle,
		);
		entries.push( groundEntry );
		destinationHandles.push( Object.freeze( {
			handle: groundEntry.collider.handle,
			weight: 0.3,
			kind: 'terrain',
			model: '__ground__',
		} ) );

		for ( const entry of props.registry ) {

			const model = entry?.model;
			if ( ! LINEAR_MODELS.has( model )
				&& ! ROCK_MODELS.has( model )
				&& ! TREE_MODELS.has( model ) ) continue;
			const source = entry.mesh?.geometry;
			if ( ! source ) continue;
			for ( let placementIndex = 0;
				placementIndex < ( entry.placements?.length ?? 0 );
				placementIndex ++ ) {

				const transform = placementTransform( entry, placementIndex );
				let object;
				let descriptor;
				let measurement = null;
				if ( TREE_MODELS.has( model ) ) {

					let cached = treeByModel.get( model );
					if ( ! cached ) {

						measurement = measureTreeTrunk( source );
						const geometry = new THREE.CylinderGeometry(
							measurement.radius,
							measurement.radius,
							measurement.height,
							12,
							Math.max( 2, Math.ceil( measurement.height / 0.12 ) ),
							false,
						);
						geometry.computeBoundingBox();
						ownedGeometries.add( geometry );
						cached = { geometry, measurement };
						treeByModel.set( model, cached );

					} else measurement = cached.measurement;
					object = transformedTreeProxy(
						cached.geometry,
						measurement,
						transform,
						`ChameleonSurface_${ model }_${ placementIndex }`,
					);
					descriptor = physics.RAPIER.ColliderDesc.cylinder(
						measurement.height * transform.scale.y * 0.5,
						measurement.radius * Math.max( transform.scale.x, transform.scale.z ),
					);

				} else {

					let geometry = convexByModel.get( model );
					if ( ! geometry ) {

						geometry = convexProxyGeometry( source );
						convexByModel.set( model, geometry );
						ownedGeometries.add( geometry );

					}
					object = proxyMesh(
						geometry,
						`ChameleonSurface_${ model }_${ placementIndex }`,
						transform,
					);
					descriptor = physics.RAPIER.ColliderDesc.convexHull(
						geometryVertexCloud( geometry, transform.scale ),
					);
					if ( ! descriptor ) throw new Error(
						`Rapier could not build the ${ model } convex support`,
					);

				}
				const specification = surfaceSpecification(
					model, object, transform.scale, measurement,
				);
				const provenance = Object.freeze( {
					model,
					category: entry.category,
					placementIndex,
				} );
				const colliderEntry = registerCollider(
					physics,
					staticBody,
					object,
					descriptor,
					provenance,
					specification,
					supportMetadataByHandle,
				);
				entries.push( colliderEntry );
				destinationHandles.push( Object.freeze( {
					handle: colliderEntry.collider.handle,
					weight: specification.destinationWeight,
					kind: specification.destinationKind,
					model,
				} ) );

			}

		}
		const navigation = buildLabSurfaceNavigationGraph( entries, {
			// The 160-unit clearing would exceed 55k terrain nodes at the small
			// laboratory spacing. 1.1 remains below one body length, keeps every
			// support within the bounded 1.2 portal radius and bakes about 21k nodes.
			spacing: 1.1,
			clearance: 0.22,
			transitionDistance: 0.86,
		} );
		const nodeSpatialIndex = createSurfaceNodeSpatialIndex( navigation );
		const revision = typeof props.getRevision === 'function'
			? finiteOr( props.getRevision(), 0 ) : 0;
		const groundCollider = groundEntry.collider;
		const frozenEntries = Object.freeze( entries.slice() );
		const frozenDestinations = Object.freeze( destinationHandles.slice() );

		return Object.freeze( {
			physics,
			entries: frozenEntries,
			navigation,
			nodeSpatialIndex,
			groundCollider,
			supportMetadataByHandle,
			destinationHandles: frozenDestinations,
			revision,
			worldSize,
			dispose() {

				if ( disposed ) return;
				disposed = true;
				for ( const geometry of ownedGeometries ) geometry.dispose();
				ownedGeometries.clear();
				supportMetadataByHandle.clear();
				physics.surfaceByCollider.clear();
				physics.dispose();

			},
		} );

	} catch ( error ) {

		for ( const geometry of ownedGeometries ) geometry.dispose();
		physics.dispose();
		throw error;

	}

}
