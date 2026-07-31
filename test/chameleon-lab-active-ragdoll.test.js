import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { createHybridChameleon } from '../src/chameleon-lab/hybrid-chameleon.js';
import {
	clampJointAngle,
	criticalDampingGains,
	HYBRID_FOOT_COUNT,
	HYBRID_JOINT_LIMITS,
	HYBRID_PHYSICS_BODY_COUNT,
	stableRootForce,
	supportFrameFromContacts,
} from '../src/chameleon-lab/hybrid-controller-model.js';
import { createPhysicsWorld } from '../src/chameleon-lab/physics-world.js';

const ASSET_PATH = fileURLToPath(
	new URL( '../public/assets/ChameleonPhysical.glb', import.meta.url ),
);
let physicalAssetBytes = null;

async function loadPhysicalScene() {

	physicalAssetBytes ??= await readFile( ASSET_PATH );
	const data = physicalAssetBytes.buffer.slice(
		physicalAssetBytes.byteOffset,
		physicalAssetBytes.byteOffset + physicalAssetBytes.byteLength,
	);
	return ( await new GLTFLoader().parseAsync( data.slice( 0 ), '' ) ).scene;

}

async function createGroundedHybrid() {

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
		RAPIER.ColliderDesc.cuboid( 6, 0.2, 6 )
			.setFriction( 0.92 )
			.setCollisionGroups( ( 0x0001 << 16 ) | 0xffff ),
		groundBody,
	);
	physics.surfaceByCollider.set( groundCollider.handle, Object.freeze( {
		kind: 'ground',
		clawEligible: true,
		gripStrengthScale: 1,
	} ) );
	const chameleon = await createHybridChameleon( {
		scene: new THREE.Scene(),
		physics,
		assetScene: await loadPhysicalScene(),
	} );
	return {
		physics,
		chameleon,
		dispose() {

			chameleon.dispose();
			physics.dispose();

		},
	};

}

function runFrames( fixture, renderHz, seconds, afterFixedStep = null ) {

	const frames = Math.round( renderHz * seconds );
	let fixedSteps = 0;
	for ( let frame = 0; frame < frames; frame ++ ) {

		const result = fixture.physics.step(
			1 / renderHz,
			( dt ) => fixture.chameleon.beforeStep( dt ),
			( dt ) => {

				fixture.chameleon.afterStep();
				fixedSteps ++;
				afterFixedStep?.( dt, fixedSteps );

			},
		);
		fixture.chameleon.syncVisual( result.alpha );

	}
	return fixedSteps;

}

function bodyState( body ) {

	const position = body.translation();
	const rotation = body.rotation();
	const linear = body.linvel();
	const angular = body.angvel();
	return [
		position.x, position.y, position.z,
		rotation.x, rotation.y, rotation.z, rotation.w,
		linear.x, linear.y, linear.z,
		angular.x, angular.y, angular.z,
	];

}

function assertFiniteHybrid( fixture ) {

	const { chameleon, physics } = fixture;
	assert.ok( bodyState( chameleon.pelvis.body ).every( Number.isFinite ) );
	assert.ok( [
		chameleon.supportNormal.x,
		chameleon.supportNormal.y,
		chameleon.supportNormal.z,
	].every( Number.isFinite ) );
	assert.ok( chameleon.contactCount >= 0 && chameleon.contactCount <= HYBRID_FOOT_COUNT );
	for ( const foot of chameleon.feet ) {

		assert.ok( [ foot.normal.x, foot.normal.y, foot.normal.z ].every( Number.isFinite ) );
		if ( foot.anchor )
			assert.ok( [ foot.anchor.x, foot.anchor.y, foot.anchor.z ].every( Number.isFinite ) );

	}
	chameleon.model.traverse( ( object ) => {

		if ( ! object.isBone ) return;
		assert.ok( [
			object.position.x, object.position.y, object.position.z,
			object.quaternion.x, object.quaternion.y,
			object.quaternion.z, object.quaternion.w,
			object.scale.x, object.scale.y, object.scale.z,
		].every( Number.isFinite ), `non-finite bone transform: ${ object.name }` );

	} );
	assert.equal( chameleon.tailPhysics.isFinite(), true );
	assert.ok( Number.isFinite( chameleon.tailPhysics.maxSegmentError() ) );
	assert.equal( physics.stats.invalidBodies, 0 );

}

function jointRole( leg, joint ) {

	if ( joint === leg.girdle ) return 'girdle';
	if ( joint === leg.upper ) return 'upper';
	if ( joint === leg.lower ) return 'lower';
	return 'palm';

}

function assertAnatomicalPose( chameleon, tolerance = 1e-5 ) {

	for ( const leg of chameleon.rig.legs ) {

		for ( const [ joint, rest ] of leg.restQuaternions ) {

			const role = jointRole( leg, joint );
			const deviation = rest.angleTo( joint.quaternion );
			assert.ok(
				deviation <= HYBRID_JOINT_LIMITS[ role ] + tolerance,
				`${ joint.name } exceeds ${ role } limit: ${ deviation }`,
			);

		}

	}

}

function vectorMagnitude( value ) {

	return Math.hypot( value.x, value.y, value.z );

}

test( 'CHAMELEON-LAB-RAGDOLL-001 hybrid architecture owns one dynamic root and four IK supports', async () => {

	const fixture = await createGroundedHybrid();
	const { chameleon, physics } = fixture;
	assert.equal( chameleon.architecture, 'hybrid-root-ik' );
	assert.equal( HYBRID_PHYSICS_BODY_COUNT, 1 );
	assert.equal( HYBRID_FOOT_COUNT, 4 );
	assert.equal( chameleon.parts.length, HYBRID_PHYSICS_BODY_COUNT );
	assert.equal( chameleon.feet.length, HYBRID_FOOT_COUNT );
	assert.equal( chameleon.maxContactCount, HYBRID_FOOT_COUNT );
	assert.equal( physics.stats.registeredBodies, HYBRID_PHYSICS_BODY_COUNT );
	assert.equal( chameleon.pelvis.body.isDynamic(), true );
	assert.equal( chameleon.parts[ 0 ].colliders.length, 2 );
	assert.ok( chameleon.feet.every( ( foot ) => foot.part.body === chameleon.pelvis.body ) );
	assert.equal( chameleon.tail.deformationMode, 'passive-xpbd-original-mesh' );
	assert.equal( chameleon.tail.nodeCount, 13 );
	assert.equal( chameleon.tail.physicsDofs, 12 );
	assert.equal( chameleon.tailPhysics.getView().positions.length, 39 );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-002 controller gains and anatomical limits are finite and bounded', () => {

	assert.deepEqual( Object.keys( HYBRID_JOINT_LIMITS ), [ 'girdle', 'upper', 'lower', 'palm' ] );
	assert.ok( Object.values( HYBRID_JOINT_LIMITS ).every(
		( value ) => Number.isFinite( value ) && value > 0 && value < Math.PI * 0.5,
	) );
	assert.equal( clampJointAngle( 4, 0.7 ), 0.7 );
	assert.equal( clampJointAngle( -4, 0.7 ), -0.7 );

	const light = criticalDampingGains( { mass: 0.5, frequency: 6 } );
	const heavy = criticalDampingGains( { mass: 1, frequency: 6 } );
	assert.equal( heavy.stiffness, light.stiffness * 2 );
	assert.equal( heavy.damping, light.damping * 2 );
	assert.equal( heavy.maximum, light.maximum * 2 );

	const force = stableRootForce( {
		error: { x: 100, y: -100, z: 50 },
		velocity: { x: -20, y: 10, z: 5 },
		mass: 1,
		frequency: 8,
		maximumAcceleration: 24,
	} );
	assert.ok( Object.values( force ).every( Number.isFinite ) );
	assert.ok( Math.hypot( force.x, force.y, force.z ) <= 24 + 1e-10 );

	const positions = new Float32Array( [
		-1, 0, -1, 1, 0, -1,
		-1, 0, 1, 1, 0, 1,
	] );
	const normals = new Float32Array( [
		0, 1, 0, 0, 1, 0,
		0, 1, 0, 0, 1, 0,
	] );
	const support = supportFrameFromContacts(
		positions,
		normals,
		new Uint8Array( [ 1, 1, 1, 1 ] ),
	);
	assert.equal( support.count, HYBRID_FOOT_COUNT );
	assert.deepEqual( support.centroid, { x: 0, y: 0, z: 0 } );
	assert.deepEqual( support.normal, { x: 0, y: 1, z: 0 } );

} );

test( 'CHAMELEON-LAB-RAGDOLL-003 procedural IK never exceeds anatomical joint limits', async () => {

	const fixture = await createGroundedHybrid();
	fixture.chameleon.setCommand( { move: new THREE.Vector3( 0.62, 0, -0.28 ) } );
	runFrames( fixture, 120, 4, () => {

		fixture.chameleon.syncVisual( 1 );
		assertAnatomicalPose( fixture.chameleon );
		assertFiniteHybrid( fixture );

	} );
	assert.equal( fixture.physics.stats.totalSteps, 480 );
	assert.ok( fixture.chameleon.contactCount >= 2 );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-004 idle hybrid remains stable during a twelve-second soak', async () => {

	const fixture = await createGroundedHybrid();
	const spawn = new THREE.Vector3( 0, 0.3, 0.75 );
	let lateLinearSpeed = 0;
	let lateAngularSpeed = 0;
	runFrames( fixture, 120, 12, ( _, fixedStep ) => {

		assertFiniteHybrid( fixture );
		if ( fixedStep <= 960 ) return;
		lateLinearSpeed = Math.max(
			lateLinearSpeed,
			vectorMagnitude( fixture.chameleon.pelvis.body.linvel() ),
		);
		lateAngularSpeed = Math.max(
			lateAngularSpeed,
			vectorMagnitude( fixture.chameleon.pelvis.body.angvel() ),
		);

	} );
	const position = fixture.chameleon.pelvis.body.translation();
	assert.ok(
		spawn.distanceTo( new THREE.Vector3( position.x, position.y, position.z ) ) < 0.02,
		`idle root drifted to ${ JSON.stringify( position ) }`,
	);
	assert.ok( lateLinearSpeed < 0.002, `late linear speed ${ lateLinearSpeed }` );
	assert.ok( lateAngularSpeed < 0.01, `late angular speed ${ lateAngularSpeed }` );
	assert.equal( fixture.chameleon.contactCount, HYBRID_FOOT_COUNT );
	assertAnatomicalPose( fixture.chameleon );
	assert.equal( fixture.physics.stats.totalSteps, 1_440 );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-005 root recovers after an impulse while mouse control is released', async () => {

	const fixture = await createGroundedHybrid();
	const root = fixture.chameleon.pelvis.body;
	runFrames( fixture, 120, 2 );
	fixture.chameleon.setDragging( true );
	root.applyImpulse( { x: 0.65, y: 0.95, z: 0.3 }, true );
	root.applyTorqueImpulse( { x: 0.08, y: 0.14, z: 0.22 }, true );
	runFrames( fixture, 120, 0.4 );
	const displaced = root.translation();
	assert.ok(
		new THREE.Vector3( displaced.x, displaced.y, displaced.z )
			.distanceTo( new THREE.Vector3( 0, 0.3, 0.75 ) ) > 0.15,
		'the disturbance must actually displace the body',
	);

	fixture.chameleon.setDragging( false );
	let recoveryPeakAngularSpeed = 0;
	runFrames( fixture, 120, 10, () => {

		assertFiniteHybrid( fixture );
		recoveryPeakAngularSpeed = Math.max(
			recoveryPeakAngularSpeed,
			vectorMagnitude( root.angvel() ),
		);

	} );
	assert.ok( recoveryPeakAngularSpeed < 12, `angular spike ${ recoveryPeakAngularSpeed }` );
	assert.ok( vectorMagnitude( root.linvel() ) < 0.01 );
	assert.ok( vectorMagnitude( root.angvel() ) < 0.02 );
	assert.ok( Math.abs( root.translation().y - 0.3 ) < 0.03 );
	assert.ok( fixture.chameleon.contactCount >= 3 );
	assertAnatomicalPose( fixture.chameleon );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-006 fixed-step outcome is identical at 60 and 240 render Hz', async () => {

	const slow = await createGroundedHybrid();
	const fast = await createGroundedHybrid();
	const move = new THREE.Vector3( 0.55, 0, -0.2 );
	slow.chameleon.setCommand( { move } );
	fast.chameleon.setCommand( { move } );
	const slowSteps = runFrames( slow, 60, 4 );
	const fastSteps = runFrames( fast, 240, 4 );
	assert.equal( slowSteps, 480 );
	assert.equal( fastSteps, 480 );
	assert.equal( slow.physics.stats.totalSteps, 480 );
	assert.equal( fast.physics.stats.totalSteps, 480 );

	const slowState = bodyState( slow.chameleon.pelvis.body );
	const fastState = bodyState( fast.chameleon.pelvis.body );
	for ( let index = 0; index < slowState.length; index ++ ) {

		assert.ok(
			Math.abs( slowState[ index ] - fastState[ index ] ) < 1e-7,
			`state[${ index }]: ${ slowState[ index ] } != ${ fastState[ index ] }`,
		);

	}
	assert.equal( slow.chameleon.contactCount, fast.chameleon.contactCount );
	assertFiniteHybrid( slow );
	assertFiniteHybrid( fast );
	slow.dispose();
	fast.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-007 repeated control and reset cycles never create NaN', async () => {

	const fixture = await createGroundedHybrid();
	const root = fixture.chameleon.pelvis.body;
	for ( let cycle = 0; cycle < 4; cycle ++ ) {

		fixture.chameleon.setDragging( true );
		root.applyImpulse( {
			x: cycle % 2 === 0 ? 0.22 : -0.22,
			y: 0.32,
			z: 0.08 * ( cycle - 1.5 ),
		}, true );
		root.applyTorqueImpulse( { x: 0.025, y: -0.035, z: 0.04 }, true );
		runFrames( fixture, 120, 0.2, () => assertFiniteHybrid( fixture ) );
		fixture.chameleon.setDragging( false );
		fixture.chameleon.setCommand( {
			move: new THREE.Vector3( cycle % 2 === 0 ? 0.4 : -0.4, 0, 0.18 ),
		} );
		runFrames( fixture, 120, 1.8, () => {

			assertFiniteHybrid( fixture );
			fixture.chameleon.syncVisual( 1 );
			assertAnatomicalPose( fixture.chameleon );

		} );

	}
	fixture.chameleon.reset();
	runFrames( fixture, 120, 2, () => assertFiniteHybrid( fixture ) );
	assert.ok( bodyState( root ).every( Number.isFinite ) );
	assert.equal( fixture.physics.stats.invalidBodies, 0 );
	assert.ok( fixture.chameleon.contactCount >= 3 );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-008 whole-body strides engage proximal joints without wrist jitter', async () => {

	const fixture = await createGroundedHybrid();
	const { chameleon } = fixture;
	chameleon.setCommand( { move: new THREE.Vector3( -1, 0, 0.12 ) } );
	runFrames( fixture, 120, 1 );
	const baselines = chameleon.rig.legs.map( ( leg ) => ( {
		girdle: leg.girdle.quaternion.clone(),
		upper: leg.upper.quaternion.clone(),
		lower: leg.lower.quaternion.clone(),
		palm: leg.palm.quaternion.clone(),
	} ) );
	const excursions = chameleon.rig.legs.map( () => ( {
		girdle: 0, upper: 0, lower: 0, palmFrame: 0,
	} ) );
	const bodyRest = new Map( chameleon.rig.rest.map( ( pose ) => [
		pose.bone.name,
		pose.quaternion,
	] ) );
	const bodyPeak = { pelvis: 0, spine_01: 0, spine_02: 0, neck: 0, head: 0 };
	runFrames( fixture, 120, 5, () => {

		chameleon.syncVisual( 1 );
		for ( let index = 0; index < chameleon.rig.legs.length; index ++ ) {

			const leg = chameleon.rig.legs[ index ];
			const baseline = baselines[ index ];
			const peak = excursions[ index ];
			peak.girdle = Math.max( peak.girdle, baseline.girdle.angleTo( leg.girdle.quaternion ) );
			peak.upper = Math.max( peak.upper, baseline.upper.angleTo( leg.upper.quaternion ) );
			peak.lower = Math.max( peak.lower, baseline.lower.angleTo( leg.lower.quaternion ) );
			peak.palmFrame = Math.max( peak.palmFrame, baseline.palm.angleTo( leg.palm.quaternion ) );
			baseline.palm.copy( leg.palm.quaternion );

		}
		for ( const name of Object.keys( bodyPeak ) ) {

			const bone = chameleon.rig.byName.get( name );
			bodyPeak[ name ] = Math.max(
				bodyPeak[ name ],
				bodyRest.get( name ).angleTo( bone.quaternion ),
			);

		}

	} );
	for ( const [ index, peak ] of excursions.entries() ) {

		assert.ok( peak.girdle > 0.08, `girdle ${ index } excursion ${ peak.girdle }` );
		assert.ok( peak.upper > 0.12, `upper ${ index } excursion ${ peak.upper }` );
		assert.ok( peak.lower > 0.16, `lower ${ index } excursion ${ peak.lower }` );
		assert.ok( peak.palmFrame < 0.18, `palm ${ index } frame delta ${ peak.palmFrame }` );

	}
	assert.ok( bodyPeak.pelvis > 0.035 );
	assert.ok( bodyPeak.spine_01 > 0.015 );
	assert.ok( bodyPeak.head > 0.005 );
	assert.ok( bodyPeak.head < bodyPeak.pelvis + bodyPeak.spine_01 + bodyPeak.spine_02 );
	assertAnatomicalPose( chameleon );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-009 passive original tail settles on the ground without penetration', async () => {

	const fixture = await createGroundedHybrid();
	const { chameleon } = fixture;
	const restTailRotations = chameleon.tailVisualRig.bones.map(
		( bone ) => bone.quaternion.clone(),
	);
	runFrames( fixture, 120, 4, () => assertFiniteHybrid( fixture ) );
	chameleon.syncVisual( 1 );
	const positions = chameleon.tailPhysics.getView().positions;
	const radii = chameleon.tailPhysics.getView().radii;
	for ( let node = 1; node < chameleon.tail.nodeCount; node ++ ) {

		assert.ok(
			positions[ node * 3 + 1 ] >= radii[ node ] * chameleon.settings.tailCollisionScale - 0.006,
			`tail node ${ node } penetrates ground: ${ positions[ node * 3 + 1 ] }`,
		);

	}
	let deformedBones = 0;
	const boneAxis = new THREE.Vector3( 0, 1, 0 );
	const physicalDirection = new THREE.Vector3();
	const boneQuaternion = new THREE.Quaternion();
	for ( let index = 0; index < chameleon.tailVisualRig.bones.length; index ++ ) {

		const bone = chameleon.tailVisualRig.bones[ index ];
		if ( restTailRotations[ index ].angleTo( bone.quaternion ) > 0.01 ) deformedBones ++;
		bone.getWorldQuaternion( boneQuaternion );
		boneAxis.set( 0, 1, 0 ).applyQuaternion( boneQuaternion ).normalize();
		physicalDirection.set(
			positions[ index * 3 + 3 ] - positions[ index * 3 ],
			positions[ index * 3 + 4 ] - positions[ index * 3 + 1 ],
			positions[ index * 3 + 5 ] - positions[ index * 3 + 2 ],
		).normalize();
		assert.ok(
			boneAxis.dot( physicalDirection ) > 0.995,
			`tail bone ${ index } does not follow the passive centreline`,
		);

	}
	assert.ok( deformedBones >= 8, `only ${ deformedBones } tail bones deformed` );
	assert.ok( chameleon.tailPhysics.kineticEnergy() < chameleon.tailPhysics.maximumKineticEnergy() );
	assert.ok( chameleon.tailPhysics.stats.totalSteps >= 480 );
	assert.ok( chameleon.tailPhysics.maxSegmentError() < 0.006, `tail segment error ${ chameleon.tailPhysics.maxSegmentError() }` );
	fixture.dispose();

} );