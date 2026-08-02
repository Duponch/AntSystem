import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { createMainChameleonSurfaceWorld } from '../src/chameleon-main-surfaces.js';
import { SurfaceRoutePlanner } from '../src/chameleon-lab/third-person-controller.js';

function groundWithHole( size = 16, radius = 1.15 ) {

	const half = size * 0.5;
	const shape = new THREE.Shape();
	shape.moveTo( -half, -half );
	shape.lineTo( -half, half );
	shape.lineTo( half, half );
	shape.lineTo( half, -half );
	shape.closePath();
	const hole = new THREE.Path();
	for ( let segment = 0; segment <= 32; segment ++ ) {

		const angle = segment / 32 * Math.PI * 2;
		const x = Math.cos( angle ) * radius;
		const y = Math.sin( angle ) * radius;
		if ( segment === 0 ) hole.moveTo( x, y );
		else hole.lineTo( x, y );

	}
	hole.closePath();
	shape.holes.push( hole );
	const geometry = new THREE.ShapeGeometry( shape, 1 );
	geometry.rotateX( -Math.PI / 2 );
	geometry.computeVertexNormals();
	const ground = new THREE.Mesh( geometry, new THREE.MeshBasicMaterial() );
	ground.name = 'RenderedMainGround';
	ground.updateMatrixWorld( true );
	return ground;

}

function treeGeometry() {

	const trunk = new THREE.CylinderGeometry( 0.08, 0.1, 1, 8, 2, false );
	trunk.translate( 0, 0.5, 0 );
	const canopy = new THREE.SphereGeometry( 0.42, 10, 6 );
	canopy.scale( 1.35, 1, 1.2 );
	canopy.translate( 0.12, 1.32, -0.08 );
	const merged = mergeGeometries( [ trunk, canopy ], false );
	trunk.dispose();
	canopy.dispose();
	return merged;

}

function makeEntry( model, category, geometry, placements ) {

	const material = new THREE.MeshBasicMaterial();
	const mesh = new THREE.InstancedMesh( geometry, material, placements.length );
	const dummy = new THREE.Object3D();
	for ( let index = 0; index < placements.length; index ++ ) {

		const placement = placements[ index ];
		dummy.position.set( placement.x, placement.y ?? 0, placement.z );
		dummy.rotation.set( 0, placement.yaw ?? 0, 0 );
		dummy.scale.setScalar( placement.scale );
		dummy.updateMatrix();
		mesh.setMatrixAt( index, dummy.matrix );

	}
	mesh.instanceMatrix.needsUpdate = true;
	mesh.updateMatrixWorld( true );
	return { model, category, mesh, placements, fit: 'test' };

}

function fixture() {

	const ground = groundWithHole();
	const tree = makeEntry(
		'Tree_01',
		'trees',
		treeGeometry(),
		[ { x: -4.2, z: 3.3, yaw: 0.4, scale: 4 } ],
	);
	const logGeometry = new THREE.BoxGeometry( 0.42, 0.36, 2.2 );
	logGeometry.translate( 0, 0.18, 0 );
	const log = makeEntry(
		'Log_01',
		'obstacles',
		logGeometry,
		[ { x: -4.3, z: -3.2, yaw: 0.35, scale: 1.15 } ],
	);
	const rockGeometry = new THREE.DodecahedronGeometry( 0.58, 0 );
	rockGeometry.translate( 0, 0.55, 0 );
	const rock = makeEntry(
		'BigRock_03',
		'obstacles',
		rockGeometry,
		[ { x: 4.1, z: 3.25, yaw: 0.8, scale: 1.05 } ],
	);
	const props = {
		registry: [ tree, log, rock ],
		getRevision: () => 17,
	};
	return {
		ground,
		props,
		entries: [ tree, log, rock ],
		dispose() {

		ground.geometry.dispose();
		ground.material.dispose();
		for ( const entry of [ tree, log, rock ] ) {

			entry.mesh.geometry.dispose();
			entry.mesh.material.dispose();
			entry.mesh.dispose?.();

		}

		},
	};

}

async function withMainSurfaces( callback ) {

	const source = fixture();
	const surfaces = await createMainChameleonSurfaceWorld( {
		props: source.props,
		ground: source.ground,
		worldSize: 16,
		maxSubsteps: 1,
	} );
	try {

		await callback( { source, surfaces } );

	} finally {

		surfaces.dispose();
		source.dispose();

	}

}

test( 'CHAMELEON-MAIN-SURFACES-001 one static body owns exact hidden production supports', async () => {

	await withMainSurfaces( ( { source, surfaces } ) => {

		assert.equal( surfaces.revision, 17 );
		assert.equal( surfaces.entries.length, 4, 'ground plus three walkable placements' );
		assert.equal( surfaces.supportMetadataByHandle.size, surfaces.entries.length );
		assert.equal( surfaces.physics.surfaceByCollider.size, surfaces.entries.length );
		let bodyCount = 0;
		surfaces.physics.world.forEachRigidBody( () => bodyCount ++ );
		assert.equal( bodyCount, 1, 'the complete immutable clearing must share one body' );
		const parentHandles = new Set();
		for ( const entry of surfaces.entries ) {

			assert.equal( entry.object.parent, null, 'physics proxies must never enter the scene graph' );
			assert.equal( entry.object.visible, false );
			assert.equal( entry.body.isFixed(), true );
			parentHandles.add( entry.collider.parent().handle );
			assert.equal(
				surfaces.supportMetadataByHandle.get( entry.collider.handle ),
				surfaces.physics.surfaceByCollider.get( entry.collider.handle ),
			);

		}
		assert.equal( parentHandles.size, 1 );
		assert.equal( surfaces.groundCollider.shapeType(), surfaces.physics.RAPIER.ShapeType.TriMesh );
		assert.equal( source.ground.parent, null, 'the adapter must not reparent the rendered ground' );
		for ( const sourceEntry of source.entries )
			assert.equal( sourceEntry.mesh.visible, true, 'rendered prop instances remain untouched' );

	} );

} );

test( 'CHAMELEON-MAIN-SURFACES-002 support topology, provenance and weighted destinations stay collider-local', async () => {

	await withMainSurfaces( ( { surfaces } ) => {

		const byModel = new Map();
		for ( const entry of surfaces.entries ) {

			const metadata = surfaces.supportMetadataByHandle.get( entry.collider.handle );
			byModel.set( metadata.model, { entry, metadata } );
			assert.ok( metadata.appearance?.worldToLocal?.length === 16 );
			assert.equal( metadata.provenance.model, metadata.model );
			assert.equal( metadata.provenance.placementIndex, metadata.placementIndex );

		}
		const tree = byModel.get( 'Tree_01' );
		assert.equal( tree.entry.collider.shapeType(), surfaces.physics.RAPIER.ShapeType.Cylinder );
		assert.equal( tree.metadata.supportTopology, 'radial-branch' );
		assert.equal( tree.metadata.kind, 'branch' );
		assert.ok( tree.metadata.branchRadius > 0.2 && tree.metadata.branchRadius < 0.5,
			'the measured trunk must ignore the much wider canopy' );
		const log = byModel.get( 'Log_01' );
		assert.equal( log.entry.collider.shapeType(), surfaces.physics.RAPIER.ShapeType.ConvexPolyhedron );
		assert.equal( log.metadata.supportTopology, 'radial-branch' );
		const rock = byModel.get( 'BigRock_03' );
		assert.equal( rock.entry.collider.shapeType(), surfaces.physics.RAPIER.ShapeType.ConvexPolyhedron );
		assert.equal( rock.metadata.supportTopology, 'convex-shell' );
		assert.deepEqual(
			surfaces.destinationHandles.map( ( destination ) => [
				destination.model, destination.kind, destination.weight,
			] ),
			[
				[ '__ground__', 'terrain', 0.3 ],
				[ 'Tree_01', 'tree', 2 ],
				[ 'Log_01', 'log', 4 ],
				[ 'BigRock_03', 'rock', 2.5 ],
			],
		);
		assert.ok( Object.isFrozen( surfaces.destinationHandles ) );
		assert.ok( surfaces.navigation.nodeCount > 0 );

		const planner = new SurfaceRoutePlanner( surfaces.navigation );
		const groundHandle = surfaces.groundCollider.handle;
		const point = new THREE.Vector3();
		const normal = new THREE.Vector3();
		for ( const model of [ 'Tree_01', 'Log_01', 'BigRock_03' ] ) {

			const target = byModel.get( model ).entry;
			let targetNode = -1;
			for ( let node = 0; node < surfaces.navigation.nodeCount; node ++ ) {

				if ( surfaces.navigation.handles[ node ] === target.collider.handle ) {

					targetNode = node;
					break;

				}

			}
			assert.ok( targetNode >= 0, `${ model } must contribute navigable surface nodes` );
			const targetOffset = targetNode * 3;
			let groundNode = -1;
			let bestGroundDistance = Infinity;
			for ( let node = 0; node < surfaces.navigation.nodeCount; node ++ ) {

				if ( surfaces.navigation.handles[ node ] !== groundHandle ) continue;
				const offset = node * 3;
				const dx = surfaces.navigation.positions[ offset ]
					- surfaces.navigation.positions[ targetOffset ];
				const dy = surfaces.navigation.positions[ offset + 1 ]
					- surfaces.navigation.positions[ targetOffset + 1 ];
				const dz = surfaces.navigation.positions[ offset + 2 ]
					- surfaces.navigation.positions[ targetOffset + 2 ];
				const distance = dx * dx + dy * dy + dz * dz;
				if ( distance < bestGroundDistance ) {

					bestGroundDistance = distance;
					groundNode = node;

				}

			}
			assert.ok( groundNode >= 0 );
			const groundOffset = groundNode * 3;
			point.fromArray( surfaces.navigation.positions, groundOffset );
			normal.fromArray( surfaces.navigation.normals, groundOffset );
			const destination = new THREE.Vector3().fromArray(
				surfaces.navigation.positions, targetOffset,
			);
			const destinationNormal = new THREE.Vector3().fromArray(
				surfaces.navigation.normals, targetOffset,
			);
			const route = planner.plan(
				point,
				surfaces.groundCollider,
				destination,
				destinationNormal,
				target.collider,
				normal,
			);
			assert.equal( route.reachable, true, `ground must route onto ${ model }` );
			assert.ok( route.count >= 2 );
			assert.ok(
				Array.from( route.handles.subarray( 0, route.count ) )
					.includes( target.collider.handle ),
				`the route must hand off physically onto ${ model }`,
			);

		}

	} );

} );

test( 'CHAMELEON-MAIN-SURFACES-003 triangulated ground preserves its physical and navigational entrance hole', async () => {

	await withMainSurfaces( ( { surfaces } ) => {

		const { physics, groundCollider, navigation } = surfaces;
		const centreRay = new physics.RAPIER.Ray(
			{ x: 0, y: 3, z: 0 },
			{ x: 0, y: -1, z: 0 },
		);
		const soilRay = new physics.RAPIER.Ray(
			{ x: 3, y: 3, z: 0 },
			{ x: 0, y: -1, z: 0 },
		);
		assert.ok( groundCollider.castRay( centreRay, 8, true ) < 0,
			'the Rapier ground collider must not cap the authored hole' );
		assert.ok( groundCollider.castRay( soilRay, 8, true ) >= 0 );
		assert.ok( navigation.terrainTriangles instanceof Float32Array );
		assert.ok( navigation.terrainTriangles.length > 0 );
		assert.equal(
			navigation.segmentClearTerrain(
				new THREE.Vector3( -3, 0, 0 ),
				new THREE.Vector3( 3, 0, 0 ),
			),
			false,
			'a terrain shortcut must not bridge the entrance hole',
		);
		assert.equal(
			navigation.segmentClearTerrain(
				new THREE.Vector3( -3, 0, -6.3 ),
				new THREE.Vector3( 3, 0, -6.3 ),
			),
			true,
		);
		assert.ok( navigation.locate(
			new THREE.Vector3( -3, 0, 0 ),
			new THREE.Vector3( 0, 1, 0 ),
			groundCollider,
		) >= 0 );

	} );

} );

test( 'CHAMELEON-MAIN-SURFACES-004 prey projection index returns the exact nearest bounded nodes', async () => {

	await withMainSurfaces( ( { surfaces } ) => {

		const { navigation, nodeSpatialIndex } = surfaces;
		const outputNodes = new Int32Array( 8 );
		const outputScores = new Float64Array( 8 );
		for ( const query of [
			[ -3.7, 0.8, -2.4 ],
			[ 4.4, 1.3, 3.1 ],
			[ 0.35, 0.4, 5.2 ],
		] ) {

			const count = nodeSpatialIndex.queryNearest(
				query[ 0 ], query[ 1 ], query[ 2 ],
				outputNodes, outputScores, outputNodes.length,
			);
			const expected = [];
			for ( let node = 0; node < navigation.nodeCount; node ++ ) {

				const offset = node * 3;
				const dx = navigation.positions[ offset ] - query[ 0 ];
				const dy = navigation.positions[ offset + 1 ] - query[ 1 ];
				const dz = navigation.positions[ offset + 2 ] - query[ 2 ];
				expected.push( {
					node,
					score: dx * dx + dz * dz + dy * dy * 0.28
						+ ( dy > 0 ? dy * dy * 2.5 : 0 ),
				} );

			}
			expected.sort( ( a, b ) => a.score - b.score || a.node - b.node );
			assert.equal( count, outputNodes.length );
			for ( let index = 0; index < count; index ++ ) {

				assert.equal( outputNodes[ index ], expected[ index ].node );
				assert.ok( Math.abs( outputScores[ index ] - expected[ index ].score ) < 1e-9 );

			}

		}
		const count = nodeSpatialIndex.queryNearest(
			0, 0, 0,
			outputNodes, outputScores, outputNodes.length,
			100, 100, 100, 0.01,
		);
		assert.equal( count, 0, 'the roaming sphere must reject every distant node' );
		assert.deepEqual( Array.from( outputNodes ), new Array( 8 ).fill( -1 ) );

	} );

} );
