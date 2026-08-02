import * as THREE from 'three/webgpu';

import {
	createLabSurfaceMaterial,
	createSurfaceAppearanceBinding,
} from './surface-appearance.js';
import { buildLabSurfaceNavigationGraph } from './surface-navigation-graph.js';

const ENVIRONMENT_GROUP = ( 0x0001 << 16 ) | 0xffff;

function setShadowFlags( object, cast = true, receive = true ) {

	object.traverse( ( child ) => {

		if ( ! child.isMesh ) return;
		child.castShadow = cast;
		child.receiveShadow = receive;

	} );

}

function quaternionRecord( quaternion ) {

	return {
		x: quaternion.x,
		y: quaternion.y,
		z: quaternion.z,
		w: quaternion.w,
	};

}

function addFixedCollider( physics, object, colliderDesc, surface ) {

	const { RAPIER, world } = physics;
	const bodyDesc = RAPIER.RigidBodyDesc.fixed()
		.setTranslation( object.position.x, object.position.y, object.position.z )
		.setRotation( quaternionRecord( object.quaternion ) );
	const body = world.createRigidBody( bodyDesc );
	const collider = world.createCollider(
		colliderDesc
			.setFriction( surface.friction )
			.setRestitution( surface.restitution ?? 0.02 )
			.setCollisionGroups( ENVIRONMENT_GROUP ),
		body,
	);
	const appearance = surface.appearance
		?? ( surface.kind === 'glass' ? null : createSurfaceAppearanceBinding( object, surface.kind ) );
	physics.surfaceByCollider ??= new Map();
	physics.surfaceByCollider.set( collider.handle, Object.freeze( {
		kind: 'rough',
		clawEligible: true,
		gripStrengthScale: 1,
		...surface,
		...( appearance ? { appearance } : {} ),
	} ) );
	object.userData.physicsColliderHandle = collider.handle;
	object.userData.surface = physics.surfaceByCollider.get( collider.handle );
	return { body, collider, object };

}

function createGroundMaterial() {

	return createLabSurfaceMaterial( 'soil' );

}

function createBarkMaterial() {

	return createLabSurfaceMaterial( 'bark' );

}

function createStoneMaterial() {

	return createLabSurfaceMaterial( 'stone' );

}

function createBox( scene, physics, {
	name,
	size,
	position,
	rotation = [ 0, 0, 0 ],
	material,
	surface,
} ) {

	const mesh = new THREE.Mesh(
		new THREE.BoxGeometry( size[ 0 ], size[ 1 ], size[ 2 ] ),
		material,
	);
	mesh.name = name;
	mesh.position.fromArray( position );
	mesh.rotation.fromArray( rotation );
	mesh.updateMatrixWorld( true );
	setShadowFlags( mesh );
	scene.add( mesh );
	const colliderDesc = physics.RAPIER.ColliderDesc.cuboid(
		size[ 0 ] * 0.5,
		size[ 1 ] * 0.5,
		size[ 2 ] * 0.5,
	);
	return addFixedCollider( physics, mesh, colliderDesc, {
		...surface,
		supportTopology: 'faceted-shell',
	} );

}

function createLog( scene, physics, {
	name,
	radius,
	length,
	position,
	direction,
} ) {

	const bark = createBarkMaterial();
	const mesh = new THREE.Mesh(
		new THREE.CylinderGeometry( radius, radius * 1.07, length, 18, 5, false ),
		bark,
	);
	mesh.name = name;
	mesh.position.fromArray( position );
	const axis = new THREE.Vector3( 0, 1, 0 );
	const target = new THREE.Vector3().fromArray( direction ).normalize();
	mesh.quaternion.setFromUnitVectors( axis, target );
	mesh.updateMatrixWorld( true );
	setShadowFlags( mesh );
	scene.add( mesh );
	const colliderDesc = physics.RAPIER.ColliderDesc.cylinder( length * 0.5, radius );
	return addFixedCollider( physics, mesh, colliderDesc, {
		kind: 'branch',
		friction: 1.15,
		clawEligible: true,
		gripStrengthScale: 1.25,
		supportTopology: 'radial-branch',
		branchAxis: target.toArray(),
		branchRadius: radius,
	} );

}

export function createLabEnvironment( { scene, physics } ) {

	const group = new THREE.Group();
	group.name = 'ChameleonLabEnvironment';
	scene.add( group );

	const groundMaterial = createGroundMaterial();
	const stone = createStoneMaterial();
	const roughWall = createLabSurfaceMaterial( 'wall' );
	const smoothWall = new THREE.MeshPhysicalMaterial( {
		color: 0x8bc4c9,
		roughness: 0.13,
		metalness: 0.03,
		transparent: true,
		opacity: 0.52,
		transmission: 0.18,
	} );

	const colliders = [];
	const addBox = ( spec ) => colliders.push( createBox( group, physics, spec ) );

	addBox( {
		name: 'RoughGround',
		size: [ 24, 0.5, 24 ],
		position: [ 0, -0.25, 0 ],
		material: groundMaterial,
		surface: {
			kind: 'soil',
			friction: 1.2,
			clawEligible: true,
			gripStrengthScale: 1.05,
		},
	} );
	addBox( {
		name: 'RoughBackWall',
		size: [ 15, 6, 0.45 ],
		position: [ 0, 3, -7 ],
		material: roughWall,
		surface: {
			kind: 'bark-wall',
			friction: 1,
			clawEligible: true,
			gripStrengthScale: 1.15,
		},
	} );
	addBox( {
		name: 'RoughSideWall',
		size: [ 0.45, 6, 10 ],
		position: [ 7, 3, -1.8 ],
		material: stone,
		surface: {
			kind: 'rock-wall',
			friction: 0.92,
			clawEligible: true,
			gripStrengthScale: 1,
		},
	} );
	addBox( {
		name: 'SmoothGlassWall',
		size: [ 0.22, 4.2, 6 ],
		position: [ -7, 2.1, -2.4 ],
		material: smoothWall,
		surface: {
			kind: 'glass',
			friction: 0.14,
			clawEligible: false,
			gripStrengthScale: 0,
		},
	} );
	addBox( {
		name: 'SlopedRock',
		size: [ 5.5, 0.55, 3.2 ],
		position: [ -2.8, 0.72, -2.15 ],
		rotation: [ 0.12, 0.08, -0.34 ],
		material: stone,
		surface: {
			kind: 'rough-rock',
			friction: 0.96,
			clawEligible: true,
			gripStrengthScale: 0.92,
		},
	} );
	addBox( {
		name: 'WallGroundCornerShelf',
		size: [ 4.8, 0.38, 1.35 ],
		position: [ 2.8, 1.35, -5.95 ],
		rotation: [ 0.1, 0, 0 ],
		material: stone,
		surface: {
			kind: 'rough-rock',
			friction: 0.9,
			clawEligible: true,
			gripStrengthScale: 0.95,
		},
	} );

	colliders.push( createLog( group, physics, {
		name: 'HorizontalPerch',
		radius: 0.3,
		length: 8.5,
		position: [ 0.8, 2.3, -3.2 ],
		direction: [ 1, 0.08, 0.05 ],
	} ) );
	// Keep the physical test topology connected: a click on the elevated perch
	// must describe a walkable/climbable problem rather than an impossible
	// teleport across empty air. The ramp begins at the spawn-side ground and
	// overlaps the perch with enough radius for four independent claw probes.
	colliders.push( createLog( group, physics, {
		name: 'PerchAccessRamp',
		radius: 0.23,
		length: 4.2,
		position: [ 0.4, 1.15, -1.6 ],
		direction: [ 0.2, 0.575, -0.8 ],
	} ) );
	colliders.push( createLog( group, physics, {
		name: 'DiagonalPerch',
		radius: 0.24,
		length: 6.3,
		position: [ 3.5, 2.7, 1.8 ],
		direction: [ 0.25, 0.86, -0.44 ],
	} ) );
	colliders.push( createLog( group, physics, {
		name: 'VerticalTrunk',
		radius: 0.48,
		length: 7,
		position: [ 4.7, 3.5, -0.4 ],
		direction: [ 0, 1, 0 ],
	} ) );
	colliders.push( createLog( group, physics, {
		name: 'LowPerch',
		radius: 0.2,
		length: 5.4,
		position: [ -3.5, 0.8, 3 ],
		direction: [ 0.92, 0.18, 0.34 ],
	} ) );

	const rockPositions = [
		[ -0.5, 0.55, 4.1, 0.75 ],
		[ 2.4, 0.38, 3.6, 0.52 ],
		[ 5.2, 0.7, 4.3, 0.92 ],
		[ -5.1, 0.46, 0.8, 0.61 ],
	];
	for ( let i = 0; i < rockPositions.length; i ++ ) {

		const [ x, y, z, radius ] = rockPositions[ i ];
		const mesh = new THREE.Mesh(
			new THREE.DodecahedronGeometry( radius, 1 ),
			stone.clone(),
		);
		mesh.name = `RoughRock_${ i + 1 }`;
		mesh.position.set( x, y, z );
		mesh.scale.set( 1.1, 0.78, 0.92 );
		mesh.rotation.set( i * 0.31, i * 0.47, i * 0.17 );
		mesh.updateMatrixWorld( true );
		setShadowFlags( mesh );
		group.add( mesh );
		const positions = mesh.geometry.getAttribute( 'position' );
		const hullVertices = new Float32Array( positions.count * 3 );
		for ( let vertex = 0; vertex < positions.count; vertex ++ ) {

			hullVertices[ vertex * 3 ] = positions.getX( vertex ) * mesh.scale.x;
			hullVertices[ vertex * 3 + 1 ] = positions.getY( vertex ) * mesh.scale.y;
			hullVertices[ vertex * 3 + 2 ] = positions.getZ( vertex ) * mesh.scale.z;

		}
		const colliderDesc = physics.RAPIER.ColliderDesc.convexHull( hullVertices )
			?? physics.RAPIER.ColliderDesc.ball( radius * 0.86 );
		colliders.push( addFixedCollider( physics, mesh, colliderDesc, {
			kind: 'rough-rock',
			friction: 0.92,
			clawEligible: true,
			gripStrengthScale: 0.9,
			supportTopology: 'convex-shell',
		} ) );

	}

	const grid = new THREE.GridHelper( 24, 48, 0xb39567, 0x6d5131 );
	grid.position.y = 0.006;
	grid.material.transparent = true;
	grid.material.opacity = 0.17;
	group.add( grid );
	const navigation = buildLabSurfaceNavigationGraph( colliders, {
		spacing: 0.62,
		clearance: 0.22,
		transitionDistance: 0.78,
	} );

	return {
		group,
		colliders,
		navigation,
		dispose() {

			group.traverse( ( object ) => {

				if ( ! object.isMesh ) return;
				object.geometry?.dispose();
				if ( Array.isArray( object.material ) ) {

					for ( const material of object.material ) material.dispose();

				} else {

					object.material?.dispose();

				}

			} );
			scene.remove( group );

		},
	};

}

export { ENVIRONMENT_GROUP };
