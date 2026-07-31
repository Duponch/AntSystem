import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { createActiveRagdoll, CHAMELEON_GROUP } from '../src/chameleon-lab/active-ragdoll.js';
import {
	anatomicalSwingLimit,
	chameleonCollisionGroups,
	idleHoldControllerGains,
	isExternalGripRayHit,
	muscleControllerGains,
	TAIL_HINGE_LIMIT,
	tailJointPolicy,
} from '../src/chameleon-lab/active-ragdoll-model.js';
import { createPhysicsWorld } from '../src/chameleon-lab/physics-world.js';

async function loadPhysicalScene() {

	const path = fileURLToPath( new URL( '../public/assets/ChameleonPhysical.glb', import.meta.url ) );
	const bytes = await readFile( path );
	const data = bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength );
	return ( await new GLTFLoader().parseAsync( data, '' ) ).scene;

}

function worldAnchor( body, local ) {

	const rotation = body.rotation();
	const translation = body.translation();
	return new THREE.Vector3( local.x, local.y, local.z )
		.applyQuaternion( new THREE.Quaternion( rotation.x, rotation.y, rotation.z, rotation.w ) )
		.add( new THREE.Vector3( translation.x, translation.y, translation.z ) );

}

async function simulateTail( renderHz, seconds = 6 ) {

	const physics = await createPhysicsWorld( {
		gravity: { x: 0, y: -9.81, z: 0 },
		fixedDt: 1 / 120,
		maxSubsteps: 4,
	} );
	const { RAPIER, world } = physics;
	const segmentLength = 0.12;
	const half = segmentLength * 0.5;
	const root = world.createRigidBody(
		RAPIER.RigidBodyDesc.fixed().setTranslation( 0, 2, 0 ),
	);
	const bodies = [];
	const joints = [];
	let parent = root;
	for ( let index = 1; index <= 12; index ++ ) {

		const body = world.createRigidBody(
			RAPIER.RigidBodyDesc.dynamic()
				.setTranslation( 0, 2 - segmentLength * index, 0 )
				.setLinearDamping( 0.18 )
				.setAngularDamping( 0.55 )
				.setCanSleep( false ),
		);
		world.createCollider(
			RAPIER.ColliderDesc.capsule( half - 0.012, 0.012 )
				.setMass( 0.02 )
				.setCollisionGroups( ( 0x0002 << 16 ) | 0x0001 ),
			body,
		);
		const policy = tailJointPolicy( index );
		const data = policy.kind === 'fixed'
			? RAPIER.JointData.fixed(
				{ x: 0, y: -half, z: 0 },
				{ x: 0, y: 0, z: 0, w: 1 },
				{ x: 0, y: half, z: 0 },
				{ x: 0, y: 0, z: 0, w: 1 },
			)
			: RAPIER.JointData.revolute(
				{ x: 0, y: -half, z: 0 },
				{ x: 0, y: half, z: 0 },
				policy.axis,
			);
		const joint = world.createImpulseJoint( data, parent, body, true );
		joint.setContactsEnabled( false );
		if ( policy.kind === 'hinge' ) joint.setLimits( -policy.limit, policy.limit );
		bodies.push( body );
		joints.push( { joint, parent, child: body, policy } );
		parent = body;

	}
	bodies.at( -1 ).applyImpulse( { x: 0.08, y: 0, z: 0.045 }, true );
	const frames = Math.round( renderHz * seconds );
	for ( let frame = 0; frame < frames; frame ++ ) physics.step( 1 / renderHz );
	const rootPosition = root.translation();
	const tipPosition = bodies.at( -1 ).translation();
	let maximumAnchorGap = 0;
	for ( const item of joints ) {

		const parentPoint = worldAnchor( item.parent, { x: 0, y: -half, z: 0 } );
		const childPoint = worldAnchor( item.child, { x: 0, y: half, z: 0 } );
		maximumAnchorGap = Math.max( maximumAnchorGap, parentPoint.distanceTo( childPoint ) );

	}
	const result = {
		tip: new THREE.Vector3( tipPosition.x, tipPosition.y, tipPosition.z ),
		root: new THREE.Vector3( rootPosition.x, rootPosition.y, rootPosition.z ),
		maximumAnchorGap,
		steps: physics.stats.totalSteps,
		invalidBodies: physics.stats.invalidBodies,
	};
	physics.dispose();
	return result;

}

test( 'CHAMELEON-LAB-RAGDOLL-001 tail policy alternates bounded hinges and rigid pairs', () => {

	const policies = Array.from( { length: 12 }, ( _, index ) => tailJointPolicy( index + 1 ) );
	assert.deepEqual(
		policies.filter( ( policy ) => policy.kind === 'hinge' ).map( ( policy ) => policy.index ),
		[ 3, 5, 7, 9, 11 ],
	);
	assert.ok( policies.every( ( policy ) => policy.limit === 0 || policy.limit === TAIL_HINGE_LIMIT ) );
	assert.ok( policies.every( ( policy ) => Math.hypot( policy.axis.x, policy.axis.y, policy.axis.z ) === 1 ) );

} );

test( 'CHAMELEON-LAB-RAGDOLL-002 anatomical limits and inertial gains stay finite and scale predictably', () => {

	assert.ok( anatomicalSwingLimit( 'spine_01' ) < anatomicalSwingLimit( 'front_upperL' ) );
	assert.ok( anatomicalSwingLimit( 'front_upperL' ) < anatomicalSwingLimit( 'front_lowerL' ) );
	const base = muscleControllerGains( { inertia: 0.002, frequency: 24 } );
	const doubled = muscleControllerGains( { inertia: 0.004, frequency: 24 } );
	const dragged = muscleControllerGains( { inertia: 0.002, frequency: 24, dragScale: 0.28 } );
	assert.equal( doubled.stiffness, base.stiffness * 2 );
	assert.equal( doubled.maximum, base.maximum * 2 );
	assert.equal( dragged.stiffness, base.stiffness * 0.28 );
	assert.ok( Object.values( base ).every( Number.isFinite ) );

} );

test( 'CHAMELEON-LAB-RAGDOLL-003 idle hold gains scale with total body mass and stay bounded', () => {

	const light = idleHoldControllerGains( { mass: 0.8 } );
	const heavy = idleHoldControllerGains( { mass: 1.6 } );
	assert.equal( heavy.stiffness, light.stiffness * 2 );
	assert.equal( heavy.damping, light.damping * 2 );
	assert.equal( heavy.maximum, light.maximum * 2 );
	assert.throws( () => idleHoldControllerGains( { mass: 0 } ), /mass/ );

} );

test( 'CHAMELEON-LAB-RAGDOLL-004 physical tail cannot collapse and keeps joint anchors coincident', async () => {

	const result = await simulateTail( 60 );
	assert.equal( result.invalidBodies, 0 );
	assert.equal( result.steps, 720 );
	assert.ok( result.tip.distanceTo( result.root ) > 1.05 );
	assert.ok( result.maximumAnchorGap < 0.003, `anchor gap ${ result.maximumAnchorGap }` );

} );

test( 'CHAMELEON-LAB-RAGDOLL-005 fixed simulation is render-rate invariant at 60 and 240 Hz', async () => {

	const at60 = await simulateTail( 60, 4 );
	const at240 = await simulateTail( 240, 4 );
	assert.equal( at60.steps, 480 );
	assert.equal( at240.steps, 480 );
	assert.ok( at60.tip.distanceTo( at240.tip ) < 1e-6 );
	assert.ok( Math.abs( at60.maximumAnchorGap - at240.maximumAnchorGap ) < 1e-7 );

} );

test( 'CHAMELEON-LAB-RAGDOLL-006 complete 33-body rig remains finite, joined and self-collision ready', async () => {

	const physics = await createPhysicsWorld( {
		gravity: { x: 0, y: -9.81, z: 0 },
		fixedDt: 1 / 120,
		maxSubsteps: 4,
	} );
	physics.surfaceByCollider = new Map();
	const { RAPIER, world } = physics;
	const groundBody = world.createRigidBody(
		RAPIER.RigidBodyDesc.fixed().setTranslation( 0, -0.2, 0 ),
	);
	const groundCollider = world.createCollider(
		RAPIER.ColliderDesc.cuboid( 4, 0.2, 4 )
			.setFriction( 0.92 )
			.setCollisionGroups( ( 0x0001 << 16 ) | 0xffff ),
		groundBody,
	);
	physics.surfaceByCollider.set( groundCollider.handle, Object.freeze( {
		kind: 'ground',
		clawEligible: true,
		gripStrengthScale: 1,
	} ) );

	const ragdoll = await createActiveRagdoll( {
		scene: new THREE.Scene(),
		physics,
		assetScene: await loadPhysicalScene(),
	} );
	assert.equal( ragdoll.parts.length, 33 );
	assert.equal( CHAMELEON_GROUP, chameleonCollisionGroups() );
	assert.ok( ragdoll.parts.every( ( part ) => part.collider.collisionGroups() === CHAMELEON_GROUP ) );
	assert.ok( ragdoll.parts.filter( ( part ) => part.parent ).every( ( part ) => part.joint.contactsEnabled() === false ) );

	ragdoll.setCommand( { move: new THREE.Vector3( 0.35, 0, 0 ) } );
	let peakContacts = 0;
	let maximumAnchorGap = 0;
	for ( let step = 0; step < 480; step ++ ) {

		physics.step(
			1 / 120,
			( dt ) => ragdoll.beforeStep( dt ),
			() => ragdoll.afterStep(),
		);
		peakContacts = Math.max( peakContacts, ragdoll.contactCount );
		for ( const part of ragdoll.parts ) {

			const translation = part.body.translation();
			const rotation = part.body.rotation();
			assert.ok( [ translation.x, translation.y, translation.z, rotation.x, rotation.y, rotation.z, rotation.w ].every( Number.isFinite ) );
			if ( ! part.parent ) continue;
			const parentAnchor = worldAnchor( part.parent.body, part.parentAnchor );
			const childAnchor = worldAnchor( part.body, part.childAnchor );
			maximumAnchorGap = Math.max( maximumAnchorGap, parentAnchor.distanceTo( childAnchor ) );

		}

	}
	assert.equal( physics.stats.invalidBodies, 0 );
	assert.ok( peakContacts >= 1 );
	assert.ok( maximumAnchorGap < 0.035, 'full-body anchor gap ' + maximumAnchorGap );

	ragdoll.dispose();
	physics.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-007 grip rays reject embedded exits and accept external faces', () => {

	const direction = { x: 0, y: -1, z: 0 };
	assert.equal( isExternalGripRayHit( 0, { x: 0, y: 1, z: 0 }, direction ), false );
	assert.equal( isExternalGripRayHit( 0.04, { x: 0, y: -1, z: 0 }, direction ), false );
	assert.equal( isExternalGripRayHit( 0.04, { x: 0, y: 1, z: 0 }, direction ), true );

} );
