import * as THREE from 'three/webgpu';

export const LAB_SURFACE_NODE_KIND = Object.freeze( {
	TERRAIN: 0,
	SUPPORT: 1,
	TRANSITION: 2,
} );

const EPSILON = 1e-8;
const DEFAULT_SPACING = 0.62;
const DEFAULT_CLEARANCE = 0.22;
const DEFAULT_TRANSITION_DISTANCE = 0.78;
const DEFAULT_MAXIMUM_TRANSITION_DEGREE = 6;
const GROUND_NAME = 'RoughGround';

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function colliderHandle( collider ) {

	if ( Number.isFinite( collider ) ) return collider;
	return Number.isFinite( collider?.handle ) ? collider.handle : -1;

}

function coordinateKey( x, y, z, precision = 10_000 ) {

	return `${ Math.round( x * precision ) },${ Math.round( y * precision ) },${ Math.round( z * precision ) }`;

}

function segmentIntersectsRectangle( ax, az, bx, bz, rectangle ) {

	let minimum = 0;
	let maximum = 1;
	const dx = bx - ax;
	const dz = bz - az;
	const checks = [
		[ -dx, ax - rectangle.minX ],
		[ dx, rectangle.maxX - ax ],
		[ -dz, az - rectangle.minZ ],
		[ dz, rectangle.maxZ - az ],
	];
	for ( const [ direction, distance ] of checks ) {

		if ( Math.abs( direction ) <= EPSILON ) {

			if ( distance < 0 ) return false;
			continue;

		}
		const ratio = distance / direction;
		if ( direction < 0 ) minimum = Math.max( minimum, ratio );
		else maximum = Math.min( maximum, ratio );
		if ( minimum > maximum ) return false;

	}
	return maximum >= 0 && minimum <= 1;

}

function segmentIntersectsBoundsInterior( ax, ay, az, bx, by, bz, bounds ) {

	let minimum = 0;
	let maximum = 1;
	for ( const [ origin, delta, lowerBound, upperBound ] of [
		[ ax, bx - ax, bounds.minX, bounds.maxX ],
		[ ay, by - ay, bounds.minY, bounds.maxY ],
		[ az, bz - az, bounds.minZ, bounds.maxZ ],
	] ) {

		const lower = lowerBound + 1e-5;
		const upper = upperBound - 1e-5;
		if ( lower >= upper ) continue;
		if ( Math.abs( delta ) <= EPSILON ) {

			if ( origin <= lower || origin >= upper ) return false;
			continue;

		}
		let near = ( lower - origin ) / delta;
		let far = ( upper - origin ) / delta;
		if ( near > far ) [ near, far ] = [ far, near ];
		minimum = Math.max( minimum, near );
		maximum = Math.min( maximum, far );
		if ( minimum > maximum ) return false;

	}
	return maximum >= 0 && minimum <= 1 && maximum >= minimum;

}

function graphPoint( positions, index, target ) {

	const offset = index * 3;
	return target.set( positions[ offset ], positions[ offset + 1 ], positions[ offset + 2 ] );

}

class SurfaceGraphBuilder {

	constructor( { spacing, clearance, transitionDistance, maximumTransitionDegree } ) {

		this.spacing = spacing;
		this.clearance = clearance;
		this.transitionDistance = transitionDistance;
		this.maximumTransitionDegree = maximumTransitionDegree;
		this.positions = [];
		this.rawPositions = [];
		this.normals = [];
		this.handles = [];
		this.kinds = [];
		this.patchIds = [];
		this.adjacency = [];
		this.edgeKeys = new Set();
		this.surfaceNodes = new Map();
		this.obstacles = [];
		this.solidBounds = [];
		this.solidVolumes = [];
		this.solidPoint = new THREE.Vector3();
		this.groundHandle = -1;

	}

	addNode( raw, normal, handle, kind, patchId ) {

		const clearanceX = raw.x + normal.x * this.clearance;
		const clearanceY = raw.y + normal.y * this.clearance;
		const clearanceZ = raw.z + normal.z * this.clearance;
		for ( const volume of this.solidVolumes ) {

			if ( volume.handle === handle ) continue;
			const rawBlocked = pointInsideSolidVolume(
				raw.x, raw.y, raw.z, volume, this.solidPoint,
			);
			const clearanceBlocked = pointInsideSolidVolume(
				clearanceX, clearanceY, clearanceZ, volume, this.solidPoint,
			);
			if ( rawBlocked || clearanceBlocked )
				return -1;

		}
		const node = this.handles.length;
		this.rawPositions.push( raw.x, raw.y, raw.z );
		this.positions.push( clearanceX, clearanceY, clearanceZ );
		this.normals.push( normal.x, normal.y, normal.z );
		this.handles.push( handle );
		this.kinds.push( kind );
		this.patchIds.push( patchId );
		this.adjacency.push( [] );
		const key = coordinateKey( raw.x, raw.y, raw.z );
		let coincident = this.surfaceNodes.get( key );
		if ( ! coincident ) {

			coincident = [];
			this.surfaceNodes.set( key, coincident );

		}
		coincident.push( node );
		return node;

	}

	addEdge( from, to, multiplier = 1 ) {

		if ( from === to || from < 0 || to < 0 ) return;
		const low = Math.min( from, to );
		const high = Math.max( from, to );
		const key = `${ low }:${ high }`;
		if ( this.edgeKeys.has( key ) ) return;
		this.edgeKeys.add( key );
		const a = from * 3;
		const b = to * 3;
		const distance = Math.hypot(
			this.positions[ a ] - this.positions[ b ],
			this.positions[ a + 1 ] - this.positions[ b + 1 ],
			this.positions[ a + 2 ] - this.positions[ b + 2 ],
		);
		const normalDot = THREE.MathUtils.clamp(
			this.normals[ a ] * this.normals[ b ]
			+ this.normals[ a + 1 ] * this.normals[ b + 1 ]
			+ this.normals[ a + 2 ] * this.normals[ b + 2 ],
			-1,
			1,
		);
		const climb = Math.max( 0, this.positions[ b + 1 ] - this.positions[ a + 1 ] );
		const cost = Math.max( 0.001, distance )
			* ( 1 + ( 1 - normalDot ) * 0.12 )
			+ climb * 0.035;
		this.adjacency[ from ].push( { to, cost: cost * multiplier } );
		this.adjacency[ to ].push( { to: from, cost: cost * multiplier } );

	}

	compile() {

		for ( const coincident of this.surfaceNodes.values() ) {

			for ( let a = 0; a < coincident.length; a ++ ) for ( let b = a + 1; b < coincident.length; b ++ ) {

				const from = coincident[ a ];
				const to = coincident[ b ];
				if ( this.handles[ from ] !== this.handles[ to ] ) continue;
				const offsetA = from * 3;
				const offsetB = to * 3;
				const normalDot = this.normals[ offsetA ] * this.normals[ offsetB ]
					+ this.normals[ offsetA + 1 ] * this.normals[ offsetB + 1 ]
					+ this.normals[ offsetA + 2 ] * this.normals[ offsetB + 2 ];
				if ( normalDot >= -0.15 ) this.addEdge( from, to, 1.04 );

			}

		}
		this._connectSupports();
		const nodeCount = this.handles.length;
		const offsets = new Uint32Array( nodeCount + 1 );
		for ( let node = 0; node < nodeCount; node ++ ) {

			this.adjacency[ node ].sort( ( a, b ) => a.to - b.to );
			offsets[ node + 1 ] = offsets[ node ] + this.adjacency[ node ].length;

		}
		const edgeTo = new Uint32Array( offsets[ nodeCount ] );
		const edgeCost = new Float32Array( offsets[ nodeCount ] );
		for ( let node = 0; node < nodeCount; node ++ ) {

			let edge = offsets[ node ];
			for ( const descriptor of this.adjacency[ node ] ) {

				edgeTo[ edge ] = descriptor.to;
				edgeCost[ edge ] = descriptor.cost;
				edge ++;

			}

		}
		return createGraphView( {
			positions: Float32Array.from( this.positions ),
			rawPositions: Float32Array.from( this.rawPositions ),
			normals: Float32Array.from( this.normals ),
			// Rapier JS handles are bit-pattern numbers and may be subnormal values;
			// integer coercion aliases distinct colliders to zero.
			handles: Float64Array.from( this.handles ),
			kinds: Uint8Array.from( this.kinds ),
			// Triangle-mesh patches use the source triangle index. Uint32 keeps the
			// manifold valid for production assets above 32k triangles.
			patchIds: Uint32Array.from( this.patchIds ),
			offsets,
			edgeTo,
			edgeCost,
			obstacles: Object.freeze( this.obstacles.map( ( obstacle ) => Object.freeze( { ...obstacle } ) ) ),
			groundHandle: this.groundHandle,
			spacing: this.spacing,
			clearance: this.clearance,
			maximumTransitionDegree: this.maximumTransitionDegree,
		} );

	}

	_connectSupports() {

		const cellSize = this.transitionDistance;
		const buckets = new Map();
		const count = this.handles.length;
		const groundBounds = this.solidBounds.find(
			( bounds ) => bounds.handle === this.groundHandle,
		);
		const groundedHandles = new Set();
		if ( groundBounds ) for ( const bounds of this.solidBounds ) {

			if ( bounds.handle === this.groundHandle
				|| bounds.minY <= groundBounds.maxY + this.clearance * 1.5 )
				groundedHandles.add( bounds.handle );

		}
		for ( let node = 0; node < count; node ++ ) {

			const offset = node * 3;
			const cellX = Math.floor( this.rawPositions[ offset ] / cellSize );
			const cellY = Math.floor( this.rawPositions[ offset + 1 ] / cellSize );
			const cellZ = Math.floor( this.rawPositions[ offset + 2 ] / cellSize );
			const key = `${ cellX },${ cellY },${ cellZ }`;
			let bucket = buckets.get( key );
			if ( ! bucket ) {

				bucket = [];
				buckets.set( key, bucket );

			}
			bucket.push( node );

		}
		const maximumDistanceSquared = this.transitionDistance * this.transitionDistance;
		const fallbackDistance = this.transitionDistance + this.clearance * 2.25;
		const fallbackDistanceSquared = fallbackDistance * fallbackDistance;
		const candidates = [];
		const groundedFallbacks = [];
		for ( let node = 0; node < count; node ++ ) {

			const offset = node * 3;
			const cellX = Math.floor( this.rawPositions[ offset ] / cellSize );
			const cellY = Math.floor( this.rawPositions[ offset + 1 ] / cellSize );
			const cellZ = Math.floor( this.rawPositions[ offset + 2 ] / cellSize );
			for ( let dx = -1; dx <= 1; dx ++ ) for ( let dy = -1; dy <= 1; dy ++ ) for ( let dz = -1; dz <= 1; dz ++ ) {

				const nearby = buckets.get( `${ cellX + dx },${ cellY + dy },${ cellZ + dz }` );
				if ( ! nearby ) continue;
				for ( const other of nearby ) {

					if ( other <= node || this.handles[ other ] === this.handles[ node ] ) continue;
					const otherOffset = other * 3;
					const px = this.rawPositions[ offset ] - this.rawPositions[ otherOffset ];
					const py = this.rawPositions[ offset + 1 ] - this.rawPositions[ otherOffset + 1 ];
					const pz = this.rawPositions[ offset + 2 ] - this.rawPositions[ otherOffset + 2 ];
					const distanceSquared = px * px + py * py + pz * pz;
					const nodeHandle = this.handles[ node ];
					const otherHandle = this.handles[ other ];
					const groundedPair = ( nodeHandle === this.groundHandle
						&& groundedHandles.has( otherHandle ) )
						|| ( otherHandle === this.groundHandle
							&& groundedHandles.has( nodeHandle ) );
					if ( distanceSquared > ( groundedPair
						? fallbackDistanceSquared : maximumDistanceSquared ) ) continue;
					const normalDot = this.normals[ offset ] * this.normals[ otherOffset ]
						+ this.normals[ offset + 1 ] * this.normals[ otherOffset + 1 ]
						+ this.normals[ offset + 2 ] * this.normals[ otherOffset + 2 ];
					if ( normalDot < -0.35 ) continue;
					if ( ! this._transitionSegmentClear( node, other ) ) continue;
					if ( groundedPair )
						groundedFallbacks.push( {
							from: node,
							to: other,
							distanceSquared,
								targetHandle: nodeHandle === this.groundHandle
								? otherHandle : nodeHandle,
						} );
					if ( distanceSquared > maximumDistanceSquared ) continue;
					// A valid hand-off leaves the first convex support through its outward
					// half-space and approaches the second through its outward half-space.
					// Distance alone connected the ground directly to the rear wall face.
					const dxWorld = -px;
					const dyWorld = -py;
					const dzWorld = -pz;
					const departure = dxWorld * this.normals[ offset ]
						+ dyWorld * this.normals[ offset + 1 ]
						+ dzWorld * this.normals[ offset + 2 ];
					const arrival = dxWorld * this.normals[ otherOffset ]
						+ dyWorld * this.normals[ otherOffset + 1 ]
						+ dzWorld * this.normals[ otherOffset + 2 ];
					if ( departure < -1e-5 || arrival > 1e-5 ) continue;
					candidates.push( { from: node, to: other, distanceSquared } );

				}

			}

		}
		// Dense overlapping meshes used to create tens of thousands of portals and
		// made A* scale with local triangle density. A deterministic shortest-first
		// b-matching keeps both endpoints bounded while retaining the best contacts.
		candidates.sort( ( a, b ) => a.distanceSquared - b.distanceSquared
			|| a.from - b.from || a.to - b.to );
		const degree = new Uint8Array( count );
		const connectedHandles = new Set();
		for ( const candidate of candidates ) {

			if ( degree[ candidate.from ] >= this.maximumTransitionDegree
				|| degree[ candidate.to ] >= this.maximumTransitionDegree ) continue;
			this.addEdge( candidate.from, candidate.to, 1.12 );
			degree[ candidate.from ] ++;
			degree[ candidate.to ] ++;
			connectedHandles.add( this.handles[ candidate.from ] );
			connectedHandles.add( this.handles[ candidate.to ] );

		}
		// A support that physically intersects the ground can have every closest
		// sample just below the ground plane (irregular convex rocks are the common
		// case). The strict outward half-space test then rejects all portals even
		// though the surfaces share a real seam. Add exactly one shortest,
		// collision-cleared fallback for an otherwise isolated grounded collider.
		groundedFallbacks.sort( ( a, b ) => a.distanceSquared - b.distanceSquared
			|| a.from - b.from || a.to - b.to );
		for ( const candidate of groundedFallbacks ) {

			if ( connectedHandles.has( candidate.targetHandle ) ) continue;
			if ( degree[ candidate.from ] >= this.maximumTransitionDegree
				|| degree[ candidate.to ] >= this.maximumTransitionDegree ) continue;
			this.addEdge( candidate.from, candidate.to, 1.18 );
			degree[ candidate.from ] ++;
			degree[ candidate.to ] ++;
			connectedHandles.add( this.handles[ candidate.from ] );
			connectedHandles.add( this.handles[ candidate.to ] );

		}

	}

	_transitionSegmentClear( from, to ) {

		const fromOffset = from * 3;
		const toOffset = to * 3;
		const fromHandle = this.handles[ from ];
		const toHandle = this.handles[ to ];
		for ( const bounds of this.solidBounds ) {

			if ( bounds.handle === fromHandle || bounds.handle === toHandle ) continue;
			if ( segmentIntersectsBoundsInterior(
				this.rawPositions[ fromOffset ],
				this.rawPositions[ fromOffset + 1 ],
				this.rawPositions[ fromOffset + 2 ],
				this.rawPositions[ toOffset ],
				this.rawPositions[ toOffset + 1 ],
				this.rawPositions[ toOffset + 2 ],
				bounds,
			) ) return false;

		}
		return true;

	}

}

function createObstacleBounds( entries, groundTop, clearance ) {

	const obstacles = [];
	for ( const entry of entries ) {

		if ( entry.object.name === GROUND_NAME ) continue;
		entry.object.geometry?.computeBoundingBox?.();
		const bounds = new THREE.Box3().setFromObject( entry.object );
		if ( ! Number.isFinite( bounds.min.x ) || bounds.min.y > groundTop + clearance * 2.5 ) continue;
		const margin = Math.max( 0.16, clearance );
		obstacles.push( {
			handle: entry.collider.handle,
			minX: bounds.min.x - margin,
			maxX: bounds.max.x + margin,
			minZ: bounds.min.z - margin,
			maxZ: bounds.max.z + margin,
		} );

	}
	return obstacles;

}

function createSolidBounds( entries ) {

	const bounds = [];
	for ( const entry of entries ) {

		if ( ! entry?.object?.isMesh || ! Number.isFinite( entry?.collider?.handle ) ) continue;
		entry.object.geometry?.computeBoundingBox?.();
		const world = new THREE.Box3().setFromObject( entry.object );
		if ( ! Number.isFinite( world.min.x ) ) continue;
		bounds.push( {
			handle: entry.collider.handle,
			minX: world.min.x,
			minY: world.min.y,
			minZ: world.min.z,
			maxX: world.max.x,
			maxY: world.max.y,
			maxZ: world.max.z,
		} );

	}
	return bounds;

}

function createSolidVolumes( entries ) {

	const volumes = [];
	for ( const entry of entries ) {

		if ( ! entry?.object?.isMesh || ! Number.isFinite( entry?.collider?.handle ) ) continue;
		const geometry = entry.object.geometry;
		const parameters = geometry?.parameters ?? {};
		if ( geometry?.type !== 'BoxGeometry' && geometry?.type !== 'CylinderGeometry' ) continue;
		volumes.push( {
			handle: entry.collider.handle,
			type: geometry.type,
			inverse: entry.object.matrixWorld.clone().invert(),
			width: finiteOr( parameters.width, 1 ),
			height: finiteOr( parameters.height, 1 ),
			depth: finiteOr( parameters.depth, 1 ),
			radiusTop: finiteOr( parameters.radiusTop, 0.5 ),
			radiusBottom: finiteOr( parameters.radiusBottom, parameters.radiusTop ?? 0.5 ),
		} );

	}
	return volumes;

}

function pointInsideSolidVolume( x, y, z, volume, target ) {

	target.set( x, y, z ).applyMatrix4( volume.inverse );
	const epsilon = 1e-5;
	if ( volume.type === 'BoxGeometry' ) return (
		Math.abs( target.x ) <= volume.width * 0.5 + epsilon
		&& Math.abs( target.y ) <= volume.height * 0.5 + epsilon
		&& Math.abs( target.z ) <= volume.depth * 0.5 + epsilon
	);
	const halfHeight = volume.height * 0.5;
	if ( Math.abs( target.y ) > halfHeight + epsilon ) return false;
	const fraction = THREE.MathUtils.clamp(
		( target.y + halfHeight ) / Math.max( volume.height, EPSILON ),
		0,
		1,
	);
	const radius = THREE.MathUtils.lerp(
		volume.radiusBottom,
		volume.radiusTop,
		fraction,
	) + epsilon;
	return target.x * target.x + target.z * target.z <= radius * radius;

}

function pointBlockedByObstacle( x, z, obstacles ) {

	for ( const obstacle of obstacles ) if (
		x > obstacle.minX && x < obstacle.maxX
		&& z > obstacle.minZ && z < obstacle.maxZ
	) return true;
	return false;

}

function terrainSegmentClear( ax, az, bx, bz, obstacles ) {

	for ( const obstacle of obstacles )
		if ( segmentIntersectsRectangle( ax, az, bx, bz, obstacle ) ) return false;
	return true;

}

function sampleBox( builder, entry, { groundOnly = false } = {} ) {

	const geometry = entry.object.geometry;
	const parameters = geometry.parameters ?? {};
	const width = Math.max( 0.01, finiteOr( parameters.width, 1 ) );
	const height = Math.max( 0.01, finiteOr( parameters.height, 1 ) );
	const depth = Math.max( 0.01, finiteOr( parameters.depth, 1 ) );
	const faces = [
		{ axis: 0, sign: 1, u: 1, v: 2, lengths: [ height, depth ], patch: 0 },
		{ axis: 0, sign: -1, u: 1, v: 2, lengths: [ height, depth ], patch: 1 },
		{ axis: 1, sign: 1, u: 0, v: 2, lengths: [ width, depth ], patch: 2 },
		{ axis: 1, sign: -1, u: 0, v: 2, lengths: [ width, depth ], patch: 3 },
		{ axis: 2, sign: 1, u: 0, v: 1, lengths: [ width, height ], patch: 4 },
		{ axis: 2, sign: -1, u: 0, v: 1, lengths: [ width, height ], patch: 5 },
	];
	const half = [ width * 0.5, height * 0.5, depth * 0.5 ];
	const local = new THREE.Vector3();
	const localNormal = new THREE.Vector3();
	const raw = new THREE.Vector3();
	const normal = new THREE.Vector3();
	const handle = entry.collider.handle;
	const kind = groundOnly ? LAB_SURFACE_NODE_KIND.TERRAIN : LAB_SURFACE_NODE_KIND.SUPPORT;
	for ( const face of faces ) {

		if ( groundOnly && ( face.axis !== 1 || face.sign !== 1 ) ) continue;
		const stepsU = Math.max( 1, Math.ceil( face.lengths[ 0 ] / builder.spacing ) );
		const stepsV = Math.max( 1, Math.ceil( face.lengths[ 1 ] / builder.spacing ) );
		const nodes = new Int32Array( ( stepsU + 1 ) * ( stepsV + 1 ) );
		nodes.fill( -1 );
		for ( let u = 0; u <= stepsU; u ++ ) for ( let v = 0; v <= stepsV; v ++ ) {

			const components = [ 0, 0, 0 ];
			components[ face.axis ] = half[ face.axis ] * face.sign;
			components[ face.u ] = -half[ face.u ] + half[ face.u ] * 2 * u / stepsU;
			components[ face.v ] = -half[ face.v ] + half[ face.v ] * 2 * v / stepsV;
			local.fromArray( components );
			raw.copy( local ).applyMatrix4( entry.object.matrixWorld );
			localNormal.set( 0, 0, 0 ).setComponent( face.axis, face.sign );
			normal.copy( localNormal ).transformDirection( entry.object.matrixWorld ).normalize();
			if ( groundOnly && pointBlockedByObstacle( raw.x, raw.z, builder.obstacles ) ) continue;
			const node = builder.addNode( raw, normal, handle, kind, face.patch );
			nodes[ u * ( stepsV + 1 ) + v ] = node;

		}
		for ( let u = 0; u <= stepsU; u ++ ) for ( let v = 0; v <= stepsV; v ++ ) {

			const node = nodes[ u * ( stepsV + 1 ) + v ];
			if ( node < 0 ) continue;
			for ( let du = -1; du <= 1; du ++ ) for ( let dv = -1; dv <= 1; dv ++ ) {

				if ( du === 0 && dv === 0 ) continue;
				const nextU = u + du;
				const nextV = v + dv;
				if ( nextU < 0 || nextU > stepsU || nextV < 0 || nextV > stepsV ) continue;
				const other = nodes[ nextU * ( stepsV + 1 ) + nextV ];
				if ( other < 0 ) continue;
				if ( groundOnly ) {

					const a = node * 3;
					const b = other * 3;
					if ( ! terrainSegmentClear(
						builder.rawPositions[ a ], builder.rawPositions[ a + 2 ],
						builder.rawPositions[ b ], builder.rawPositions[ b + 2 ],
						builder.obstacles,
					) ) continue;

				}
				builder.addEdge( node, other );

			}

		}

	}

}

function sampleCylinder( builder, entry ) {

	const parameters = entry.object.geometry.parameters ?? {};
	const height = Math.max( 0.01, finiteOr( parameters.height, 1 ) );
	const radiusTop = Math.max( 0.01, finiteOr( parameters.radiusTop, 0.5 ) );
	const radiusBottom = Math.max( 0.01, finiteOr( parameters.radiusBottom, radiusTop ) );
	const rings = Math.max( 2, Math.ceil( height / builder.spacing ) );
	const sectors = Math.max( 12, Math.trunc( finiteOr( parameters.radialSegments, 18 ) ) );
	const side = Array.from( { length: rings + 1 }, () => new Int32Array( sectors ) );
	const raw = new THREE.Vector3();
	const normal = new THREE.Vector3();
	const localNormal = new THREE.Vector3();
	const handle = entry.collider.handle;
	for ( let ring = 0; ring <= rings; ring ++ ) {

		const fraction = ring / rings;
		const y = -height * 0.5 + height * fraction;
		const radius = THREE.MathUtils.lerp( radiusBottom, radiusTop, fraction );
		for ( let sector = 0; sector < sectors; sector ++ ) {

			const angle = sector * Math.PI * 2 / sectors;
			raw.set( Math.cos( angle ) * radius, y, Math.sin( angle ) * radius )
				.applyMatrix4( entry.object.matrixWorld );
			localNormal.set( Math.cos( angle ), 0, Math.sin( angle ) );
			normal.copy( localNormal ).transformDirection( entry.object.matrixWorld ).normalize();
			side[ ring ][ sector ] = builder.addNode(
				raw, normal, handle, LAB_SURFACE_NODE_KIND.SUPPORT, sector,
			);

		}

	}
	for ( let ring = 0; ring <= rings; ring ++ ) for ( let sector = 0; sector < sectors; sector ++ ) {

		const node = side[ ring ][ sector ];
		builder.addEdge( node, side[ ring ][ ( sector + 1 ) % sectors ] );
		if ( ring < rings ) {

			builder.addEdge( node, side[ ring + 1 ][ sector ] );
			builder.addEdge( node, side[ ring + 1 ][ ( sector + 1 ) % sectors ] );

		}

	}
	for ( const capSign of [ -1, 1 ] ) {

		const radius = capSign < 0 ? radiusBottom : radiusTop;
		const capNormal = new THREE.Vector3( 0, capSign, 0 )
			.transformDirection( entry.object.matrixWorld ).normalize();
		const centreRaw = new THREE.Vector3( 0, capSign * height * 0.5, 0 )
			.applyMatrix4( entry.object.matrixWorld );
		const centre = builder.addNode(
			centreRaw, capNormal, handle, LAB_SURFACE_NODE_KIND.SUPPORT,
			sectors + ( capSign > 0 ? 1 : 0 ),
		);
		let previous = -1;
		let first = -1;
		for ( let sector = 0; sector < sectors; sector ++ ) {

			const angle = sector * Math.PI * 2 / sectors;
			raw.set( Math.cos( angle ) * radius, capSign * height * 0.5, Math.sin( angle ) * radius )
				.applyMatrix4( entry.object.matrixWorld );
			const node = builder.addNode(
				raw, capNormal, handle, LAB_SURFACE_NODE_KIND.SUPPORT,
				sectors + ( capSign > 0 ? 1 : 0 ),
			);
			builder.addEdge( centre, node );
			if ( previous >= 0 ) builder.addEdge( previous, node );
			else first = node;
			previous = node;

		}
		builder.addEdge( previous, first );

	}

}

function sampleTriangleMesh( builder, entry ) {

	const geometry = entry.object.geometry;
	const position = geometry.getAttribute?.( 'position' );
	if ( ! position || position.count < 3 ) return;
	const index = geometry.index;
	const triangleCount = index ? Math.floor( index.count / 3 ) : Math.floor( position.count / 3 );
	const a = new THREE.Vector3();
	const b = new THREE.Vector3();
	const c = new THREE.Vector3();
	const raw = new THREE.Vector3();
	const ab = new THREE.Vector3();
	const ac = new THREE.Vector3();
	const normal = new THREE.Vector3();
	const handle = entry.collider.handle;
	for ( let triangle = 0; triangle < triangleCount; triangle ++ ) {

		const ia = index ? index.getX( triangle * 3 ) : triangle * 3;
		const ib = index ? index.getX( triangle * 3 + 1 ) : triangle * 3 + 1;
		const ic = index ? index.getX( triangle * 3 + 2 ) : triangle * 3 + 2;
		a.fromBufferAttribute( position, ia ).applyMatrix4( entry.object.matrixWorld );
		b.fromBufferAttribute( position, ib ).applyMatrix4( entry.object.matrixWorld );
		c.fromBufferAttribute( position, ic ).applyMatrix4( entry.object.matrixWorld );
		normal.crossVectors( ab.subVectors( b, a ), ac.subVectors( c, a ) ).normalize();
		if ( normal.lengthSq() < EPSILON ) continue;
		const nodes = [];
		for ( const point of [ a, b, c ] ) nodes.push( builder.addNode(
			point, normal, handle, LAB_SURFACE_NODE_KIND.SUPPORT, triangle,
		) );
		raw.copy( a ).add( b ).add( c ).multiplyScalar( 1 / 3 );
		const centre = builder.addNode(
			raw, normal, handle, LAB_SURFACE_NODE_KIND.SUPPORT, triangle,
		);
		for ( let vertex = 0; vertex < 3; vertex ++ ) {

			builder.addEdge( nodes[ vertex ], nodes[ ( vertex + 1 ) % 3 ] );
			builder.addEdge( centre, nodes[ vertex ] );

		}

	}

}

function createGraphView( data ) {

	const scratchPoint = new THREE.Vector3();
	const scratchNormal = new THREE.Vector3();
	// Clicks always carry the Rapier collider that was hit. Keep this index in the
	// closure so locating a point scans one surface only, not the complete world
	// manifold. It is built once and cannot be mutated through the public graph.
	const nodesByHandle = new Map();
	for ( let node = 0; node < data.handles.length; node ++ ) {

		const handle = data.handles[ node ];
		let nodes = nodesByHandle.get( handle );
		if ( ! nodes ) {

			nodes = [];
			nodesByHandle.set( handle, nodes );

		}
		nodes.push( node );

	}
	for ( const [ handle, nodes ] of nodesByHandle )
		nodesByHandle.set( handle, Uint32Array.from( nodes ) );
	const graph = {
		...data,
		nodeCount: data.handles.length,
		edgeCount: data.edgeTo.length,
		rowOffsets: data.offsets,
		neighbors: data.edgeTo,
		patchCount: new Set( Array.from( data.patchIds, ( patch, node ) =>
			`${ data.handles[ node ] }:${ patch }` ) ).size,
		locate( point, normal = null, collider = null ) {

			const wantedHandle = colliderHandle( collider );
			const px = Number( point?.x ?? point?.[ 0 ] );
			const py = Number( point?.y ?? point?.[ 1 ] );
			const pz = Number( point?.z ?? point?.[ 2 ] );
			if ( ! Number.isFinite( px ) || ! Number.isFinite( py ) || ! Number.isFinite( pz ) )
				return -1;
			let nx = Number( normal?.x ?? normal?.[ 0 ] );
			let ny = Number( normal?.y ?? normal?.[ 1 ] );
			let nz = Number( normal?.z ?? normal?.[ 2 ] );
			const normalLength = Math.hypot( nx, ny, nz );
			const useNormal = Number.isFinite( normalLength ) && normalLength > EPSILON;
			if ( useNormal ) {

				nx /= normalLength; ny /= normalLength; nz /= normalLength;

			}
			let bestNode = -1;
			let bestScore = Infinity;
			const candidates = wantedHandle >= 0 ? nodesByHandle.get( wantedHandle ) : null;
			if ( wantedHandle >= 0 && ! candidates ) return -1;
			const candidateCount = candidates?.length ?? graph.nodeCount;
			for ( let candidate = 0; candidate < candidateCount; candidate ++ ) {

				const node = candidates ? candidates[ candidate ] : candidate;
				const offset = node * 3;
				// Clicks carry a contact normal and are compared with raw surface
				// samples. A creature source is a clearance-offset body point; comparing
				// it with raw coincident seams made the selected face depend on face order.
				const coordinates = useNormal ? graph.rawPositions : graph.positions;
				const dx = coordinates[ offset ] - px;
				const dy = coordinates[ offset + 1 ] - py;
				const dz = coordinates[ offset + 2 ] - pz;
				let score = dx * dx + dy * dy + dz * dz;
				if ( useNormal ) {

					const dot = graph.normals[ offset ] * nx
						+ graph.normals[ offset + 1 ] * ny
						+ graph.normals[ offset + 2 ] * nz;
					score += Math.pow( 1 - dot, 2 ) * 0.42;

				}
				if ( score < bestScore ) {

					bestScore = score;
					bestNode = node;

				}

			}
			return bestNode;

		},
		locatePatch( point, normal = null, collider = null ) {

			const id = graph.locate( point, normal, collider );
			if ( id < 0 ) return null;
			const offset = id * 3;
			return Object.freeze( {
				id,
				patchId: graph.patchIds[ id ],
				handle: graph.handles[ id ],
				normal: Object.freeze( [
					graph.normals[ offset ],
					graph.normals[ offset + 1 ],
					graph.normals[ offset + 2 ],
				] ),
			} );

		},
		segmentClearTerrain( from, to ) {

			return terrainSegmentClear(
				Number( from?.x ?? from?.[ 0 ] ),
				Number( from?.z ?? from?.[ 2 ] ),
				Number( to?.x ?? to?.[ 0 ] ),
				Number( to?.z ?? to?.[ 2 ] ),
				graph.obstacles,
			);

		},
		canShortcut( path, fromIndex, toIndex ) {

			if ( toIndex <= fromIndex + 1 ) return true;
			const fromNode = path[ fromIndex ];
			const toNode = path[ toIndex ];
			const handle = graph.handles[ fromNode ];
			if ( handle !== graph.handles[ toNode ] ) return false;
			const terrain = handle === graph.groundHandle;
			const patch = graph.patchIds[ fromNode ];
			const fromOffset = fromNode * 3;
			for ( let index = fromIndex + 1; index < toIndex; index ++ ) {

				const node = path[ index ];
				if ( graph.handles[ node ] !== handle ) return false;
				if ( ! terrain && graph.patchIds[ node ] !== patch ) return false;
				const offset = node * 3;
				const dot = graph.normals[ fromOffset ] * graph.normals[ offset ]
					+ graph.normals[ fromOffset + 1 ] * graph.normals[ offset + 1 ]
					+ graph.normals[ fromOffset + 2 ] * graph.normals[ offset + 2 ];
				if ( dot < 0.985 ) return false;

			}
			if ( ! terrain ) return graph.patchIds[ toNode ] === patch;
			graphPoint( graph.rawPositions, fromNode, scratchPoint );
			graphPoint( graph.rawPositions, toNode, scratchNormal );
			return graph.segmentClearTerrain( scratchPoint, scratchNormal );

		},
	};
	return Object.freeze( graph );

}

/**
 * Bakes the laboratory's physical support manifold once. Box faces, cylindrical
 * rings and arbitrary convex render meshes become distinct surface patches;
 * physical intersections become sparse transition edges. The immutable graph
 * is shared by every agent and is never queried from the fixed-step follower.
 */
export function buildLabSurfaceNavigationGraph( entries, {
	spacing = DEFAULT_SPACING,
	clearance = DEFAULT_CLEARANCE,
	transitionDistance = DEFAULT_TRANSITION_DISTANCE,
	maximumTransitionDegree = DEFAULT_MAXIMUM_TRANSITION_DEGREE,
} = {} ) {

	const safeEntries = Array.from( entries ?? [] ).filter( ( entry ) =>
		entry?.object?.isMesh && Number.isFinite( entry?.collider?.handle )
		&& entry.object.userData.surface?.clawEligible === true );
	if ( safeEntries.length === 0 ) throw new Error( 'surface navigation requires walkable colliders' );
	const safeSpacing = THREE.MathUtils.clamp( finiteOr( spacing, DEFAULT_SPACING ), 0.25, 2 );
	const safeClearance = THREE.MathUtils.clamp( finiteOr( clearance, DEFAULT_CLEARANCE ), 0.02, 0.5 );
	const builder = new SurfaceGraphBuilder( {
		spacing: safeSpacing,
		clearance: safeClearance,
		transitionDistance: THREE.MathUtils.clamp(
			Math.max(
				finiteOr( transitionDistance, DEFAULT_TRANSITION_DISTANCE ),
				safeSpacing * 1.7,
				safeClearance * 3,
			),
			safeSpacing * 0.7,
			1.2,
		),
		maximumTransitionDegree: THREE.MathUtils.clamp(
			Math.trunc( finiteOr( maximumTransitionDegree, DEFAULT_MAXIMUM_TRANSITION_DEGREE ) ),
			1,
			12,
		),
	} );
	const ground = safeEntries.find( ( entry ) => entry.object.name === GROUND_NAME )
		?? safeEntries.find( ( entry ) => entry.object.userData.surface?.kind === 'soil' );
	if ( ! ground ) throw new Error( 'surface navigation requires a ground support' );
	ground.object.geometry.computeBoundingBox?.();
	const groundBounds = new THREE.Box3().setFromObject( ground.object );
	builder.groundHandle = ground.collider.handle;
	builder.obstacles = createObstacleBounds( entries, groundBounds.max.y, safeClearance );
	builder.solidBounds = createSolidBounds( entries );
	builder.solidVolumes = createSolidVolumes( entries );
	sampleBox( builder, ground, { groundOnly: true } );
	for ( const entry of safeEntries ) {

		if ( entry === ground ) continue;
		const geometry = entry.object.geometry;
		if ( geometry?.type === 'BoxGeometry' ) sampleBox( builder, entry );
		else if ( geometry?.type === 'CylinderGeometry' ) sampleCylinder( builder, entry );
		else sampleTriangleMesh( builder, entry );

	}
	return builder.compile();

}

/**
 * Reusable allocation-free A* scratch. Search is intentionally event driven:
 * one call on click or a rare replan, never one call per simulation tick.
 */
export class LabSurfaceGraphSearch {

	constructor( graph ) {

		if ( ! graph?.offsets || ! graph?.edgeTo ) throw new TypeError( 'a surface graph is required' );
		this.graph = graph;
		const count = graph.nodeCount;
		this.distance = new Float64Array( count );
		this.previous = new Int32Array( count );
		this.closed = new Uint8Array( count );
		this.heap = new Int32Array( count );
		this.heapIndex = new Int32Array( count );
		this.heapScore = new Float64Array( count );
		this.path = new Uint32Array( count );
		this.heapSize = 0;
		this.view = Object.seal( {
			path: this.path,
			count: 0,
			cost: Infinity,
			expanded: 0,
			reachable: false,
		} );

	}

	_heuristic( from, to ) {

		const a = from * 3;
		const b = to * 3;
		return Math.hypot(
			this.graph.positions[ a ] - this.graph.positions[ b ],
			this.graph.positions[ a + 1 ] - this.graph.positions[ b + 1 ],
			this.graph.positions[ a + 2 ] - this.graph.positions[ b + 2 ],
		);

	}

	_swap( a, b ) {

		const node = this.heap[ a ];
		this.heap[ a ] = this.heap[ b ];
		this.heap[ b ] = node;
		this.heapIndex[ this.heap[ a ] ] = a;
		this.heapIndex[ this.heap[ b ] ] = b;

	}

	_pushOrDecrease( node, score ) {

		let index = this.heapIndex[ node ];
		this.heapScore[ node ] = score;
		if ( index < 0 ) {

			index = this.heapSize ++;
			this.heap[ index ] = node;
			this.heapIndex[ node ] = index;

		}
		while ( index > 0 ) {

			const parent = ( index - 1 ) >> 1;
			if ( this.heapScore[ this.heap[ parent ] ] <= score ) break;
			this._swap( index, parent );
			index = parent;

		}

	}

	_pop() {

		const root = this.heap[ 0 ];
		this.heapIndex[ root ] = -1;
		this.heapSize --;
		if ( this.heapSize <= 0 ) return root;
		this.heap[ 0 ] = this.heap[ this.heapSize ];
		this.heapIndex[ this.heap[ 0 ] ] = 0;
		let index = 0;
		while ( true ) {

			const left = index * 2 + 1;
			if ( left >= this.heapSize ) break;
			const right = left + 1;
			let next = left;
			if ( right < this.heapSize
				&& this.heapScore[ this.heap[ right ] ] < this.heapScore[ this.heap[ left ] ] )
				next = right;
			if ( this.heapScore[ this.heap[ index ] ] <= this.heapScore[ this.heap[ next ] ] ) break;
			this._swap( index, next );
			index = next;

		}
		return root;

	}

	search( start, target ) {

		const count = this.graph.nodeCount;
		this.distance.fill( Infinity );
		this.previous.fill( -1 );
		this.closed.fill( 0 );
		this.heapIndex.fill( -1 );
		this.heapSize = 0;
		this.view.count = 0;
		this.view.cost = Infinity;
		this.view.expanded = 0;
		this.view.reachable = false;
		if ( start < 0 || target < 0 || start >= count || target >= count ) return this.view;
		this.distance[ start ] = 0;
		this._pushOrDecrease( start, this._heuristic( start, target ) );
		while ( this.heapSize > 0 ) {

			const node = this._pop();
			if ( this.closed[ node ] ) continue;
			this.closed[ node ] = 1;
			this.view.expanded ++;
			if ( node === target ) break;
			for ( let edge = this.graph.offsets[ node ]; edge < this.graph.offsets[ node + 1 ]; edge ++ ) {

				const next = this.graph.edgeTo[ edge ];
				if ( this.closed[ next ] ) continue;
				const candidate = this.distance[ node ] + this.graph.edgeCost[ edge ];
				if ( candidate >= this.distance[ next ] ) continue;
				this.distance[ next ] = candidate;
				this.previous[ next ] = node;
				this._pushOrDecrease( next, candidate + this._heuristic( next, target ) );

			}

		}
		if ( ! Number.isFinite( this.distance[ target ] ) ) return this.view;
		let cursor = target;
		while ( cursor >= 0 && this.view.count < count ) {

			this.path[ this.view.count ++ ] = cursor;
			if ( cursor === start ) break;
			cursor = this.previous[ cursor ];

		}
		if ( this.path[ this.view.count - 1 ] !== start ) {

			this.view.count = 0;
			return this.view;

		}
		for ( let left = 0, right = this.view.count - 1; left < right; left ++, right -- ) {

			const value = this.path[ left ];
			this.path[ left ] = this.path[ right ];
			this.path[ right ] = value;

		}
		this.view.cost = this.distance[ target ];
		this.view.reachable = true;
		return this.view;

	}

}
