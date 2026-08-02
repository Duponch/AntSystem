import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { createHybridChameleon } from '../src/chameleon-lab/hybrid-chameleon.js';
import {
	ANATOMICAL_METRIC,
	ANATOMICAL_POSITION,
} from '../src/chameleon-lab/anatomical-limb-solver.js';
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
import { PlatformerControlModel } from '../src/chameleon-lab/platformer-control-model.js';
import { WHOLE_BODY_POSE } from '../src/chameleon-lab/whole-body-gait-model.js';

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

async function createGroundedHybrid( { inclination = 0 } = {} ) {

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
	const groundColliderDescription = RAPIER.ColliderDesc.cuboid( 6, 0.2, 6 )
		.setFriction( 0.92 )
		.setCollisionGroups( ( 0x0001 << 16 ) | 0xffff );
	if ( Math.abs( inclination ) > 1e-8 ) groundColliderDescription.setRotation( {
		x: 0,
		y: 0,
		z: Math.sin( inclination * 0.5 ),
		w: Math.cos( inclination * 0.5 ),
	} );
	const groundCollider = world.createCollider( groundColliderDescription, groundBody );
	physics.surfaceByCollider.set( groundCollider.handle, Object.freeze( {
		kind: Math.abs( inclination ) > 1e-8 ? 'incline' : 'ground',
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

async function createBranchHybrid( {
	radius = 0.18,
	halfHeight = 3,
	registerAfterCreation = false,
	branchAxis = [ 1, 0, 0 ],
	gripStrengthScale = 1.25,
	spawn = null,
} = {} ) {

	const physics = await createPhysicsWorld( {
		gravity: { x: 0, y: -9.81, z: 0 },
		fixedDt: 1 / 120,
		maxSubsteps: 4,
	} );
	physics.surfaceByCollider = new Map();
	const { RAPIER, world } = physics;
	const halfTurn = -Math.PI * 0.25;
	const branchBody = world.createRigidBody(
		RAPIER.RigidBodyDesc.fixed().setRotation( {
			x: 0,
			y: 0,
			z: Math.sin( halfTurn ),
			w: Math.cos( halfTurn ),
		} ),
	);
	const branchCollider = world.createCollider(
		RAPIER.ColliderDesc.cylinder( halfHeight, radius )
			.setFriction( 1.15 )
			.setCollisionGroups( ( 0x0001 << 16 ) | 0xffff ),
		branchBody,
	);
	const branchSurface = Object.freeze( {
		kind: 'branch',
		clawEligible: true,
		gripStrengthScale,
		branchAxis: Object.freeze( branchAxis ),
		branchRadius: radius,
	} );
	if ( ! registerAfterCreation )
		physics.surfaceByCollider.set( branchCollider.handle, branchSurface );
	const chameleon = await createHybridChameleon( {
		scene: new THREE.Scene(),
		physics,
		assetScene: await loadPhysicalScene(),
		spawn: spawn ?? new THREE.Vector3( 0, radius + 0.3, 0 ),
	} );
	if ( registerAfterCreation )
		physics.surfaceByCollider.set( branchCollider.handle, branchSurface );
	return {
		physics,
		chameleon,
		branchCollider,
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
	assert.ok( [ 'girdle', 'upper', 'lower' ].every(
		( role ) => Number.isFinite( HYBRID_JOINT_LIMITS[ role ] )
			&& HYBRID_JOINT_LIMITS[ role ] > 0 && HYBRID_JOINT_LIMITS[ role ] < Math.PI * 0.5,
	) );
	assert.ok( HYBRID_JOINT_LIMITS.palm > Math.PI * 0.5 && HYBRID_JOINT_LIMITS.palm <= Math.PI,
		'the zygodactyl palm needs enough roll to lie flat on walls and floors' );
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
	runFrames( fixture, 120, 2, () => assertFiniteHybrid( fixture ) );
	const settledTranslation = fixture.chameleon.pelvis.body.translation();
	const settledRoot = new THREE.Vector3(
		settledTranslation.x, settledTranslation.y, settledTranslation.z,
	);
	const settledDesiredRoot = fixture.chameleon.desiredRoot.clone();
	let maximumRootDrift = 0;
	let maximumDesiredRootError = 0;
	let minimumContacts = HYBRID_FOOT_COUNT;
	let lateLinearSpeed = 0;
	let lateAngularSpeed = 0;
	runFrames( fixture, 120, 10, ( _, fixedStep ) => {

		assertFiniteHybrid( fixture );
		const translation = fixture.chameleon.pelvis.body.translation();
		const position = new THREE.Vector3(
			translation.x, translation.y, translation.z,
		);
		maximumRootDrift = Math.max(
			maximumRootDrift,
			position.distanceTo( settledRoot ),
		);
		maximumDesiredRootError = Math.max(
			maximumDesiredRootError,
			position.distanceTo( fixture.chameleon.desiredRoot ),
		);
		minimumContacts = Math.min( minimumContacts, fixture.chameleon.contactCount );
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
	const finalRoot = new THREE.Vector3( position.x, position.y, position.z );
	assert.ok(
		maximumRootDrift < 0.02,
		`settled root drifted ${ maximumRootDrift } from ${ settledRoot.toArray() } to ${ finalRoot.toArray() }`,
	);
	assert.ok( settledRoot.y >= 0.16 && settledRoot.y <= 0.42,
		`settled pelvis height ${ settledRoot.y } is outside the anatomical range` );
	assert.ok( finalRoot.y >= 0.16 && finalRoot.y <= 0.42,
		`final pelvis height ${ finalRoot.y } is outside the anatomical range` );
	assert.ok( settledRoot.distanceTo( settledDesiredRoot ) < 0.025,
		`warm equilibrium missed desiredRoot by ${ settledRoot.distanceTo( settledDesiredRoot ) }` );
	assert.ok( maximumDesiredRootError < 0.025,
		`pelvis diverged from desiredRoot by ${ maximumDesiredRootError }` );
	assert.ok( lateLinearSpeed < 0.002, `late linear speed ${ lateLinearSpeed }` );
	assert.ok( lateAngularSpeed < 0.01, `late angular speed ${ lateAngularSpeed }` );
	assert.equal( minimumContacts, HYBRID_FOOT_COUNT );
	assert.equal( fixture.chameleon.contactCount, HYBRID_FOOT_COUNT );
	assertAnatomicalPose( fixture.chameleon );
	assert.equal( fixture.physics.stats.totalSteps, 1_440 );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-005 root recovers after an impulse while mouse control is released', async () => {

	const fixture = await createGroundedHybrid();
	const root = fixture.chameleon.pelvis.body;
	runFrames( fixture, 120, 2 );
	const equilibriumTranslation = root.translation();
	const equilibriumRoot = new THREE.Vector3(
		equilibriumTranslation.x, equilibriumTranslation.y, equilibriumTranslation.z,
	);
	fixture.chameleon.setDragging( true );
	root.applyImpulse( { x: 0.65, y: 0.95, z: 0.3 }, true );
	root.applyTorqueImpulse( { x: 0.08, y: 0.14, z: 0.22 }, true );
	runFrames( fixture, 120, 0.4 );
	const displaced = root.translation();
	const displacement = new THREE.Vector3( displaced.x, displaced.y, displaced.z )
		.distanceTo( equilibriumRoot );
	assert.ok(
		displacement > 0.15,
		`the disturbance only displaced the body by ${ displacement }`,
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
	const recoveredRotation = root.rotation();
	const recoveredUp = new THREE.Vector3( 0, 1, 0 ).applyQuaternion(
		new THREE.Quaternion(
			recoveredRotation.x, recoveredRotation.y, recoveredRotation.z, recoveredRotation.w,
		),
	);
	const recoveredTranslation = root.translation();
	const recoveredRoot = new THREE.Vector3(
		recoveredTranslation.x, recoveredTranslation.y, recoveredTranslation.z,
	);
	const recoveryError = recoveredRoot.distanceTo( fixture.chameleon.desiredRoot );
	assert.ok( recoveryError < 0.035,
		`recovered root missed current desiredRoot by ${ recoveryError }; body=${ recoveredRoot.toArray() }; target=${ fixture.chameleon.desiredRoot.toArray() }; contacts=${ fixture.chameleon.contactCount }; up=${ recoveredUp.toArray() }; anchors=${ fixture.chameleon.feet.map( ( foot ) => foot.anchor?.toArray() ) }` );
	assert.ok( recoveredRoot.y >= 0.16 && recoveredRoot.y <= 0.42,
		`recovered pelvis height ${ recoveredRoot.y } is outside the anatomical range` );
	assert.ok( recoveredUp.dot( fixture.chameleon.supportNormal ) > 0.95,
		`recovered up ${ recoveredUp.toArray() } does not follow support ${ fixture.chameleon.supportNormal.toArray() }` );
	assert.ok( fixture.chameleon.contactCount >= 2,
		`reset retained ${ fixture.chameleon.contactCount } contacts: ${ fixture.chameleon.feet.map( ( foot ) => `${ foot.state }/${ foot.surface?.kind ?? 'none' }` ) }` );
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
	// The deliberate diagonal gait has exactly two stance claws while the
	// opposite pair swings; both contacts are a valid support polygon.
	assert.ok( fixture.chameleon.contactCount >= 2,
		`reset retained ${ fixture.chameleon.contactCount } contacts: ${ fixture.chameleon.feet.map( ( foot ) => `${ foot.state }/${ foot.surface?.kind ?? 'none' }` ) }` );
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

test( 'CHAMELEON-LAB-RAGDOLL-020 fixed-step breast-stroke is broad, smooth and render-rate invariant', async () => {

	const slowFixture = await createGroundedHybrid();
	const fastFixture = await createGroundedHybrid();
	const command = { move: new THREE.Vector3( -1, 0, 0.12 ) };
	slowFixture.chameleon.setCommand( command );
	fastFixture.chameleon.setCommand( command );
	runFrames( slowFixture, 60, 6 );
	runFrames( fastFixture, 240, 6 );
	// Compare the same authoritative fixed pose, not two potentially different
	// sub-frame accumulator alphas caused by floating-point render partitions.
	slowFixture.chameleon.syncVisual( 1 );
	fastFixture.chameleon.syncVisual( 1 );
	for ( let index = 0; index < slowFixture.chameleon.rig.bones.length; index ++ ) {

		const slow = slowFixture.chameleon.rig.bones[ index ];
		const fast = fastFixture.chameleon.rig.bones[ index ];
		if ( slow.name.startsWith( 'tail_' ) ) continue;
		assert.ok(
			slow.quaternion.angleTo( fast.quaternion ) < 2e-5,
			`${ slow.name } depends on render rate (${ slow.quaternion.angleTo( fast.quaternion ) } rad)`,
		);

	}
	for ( const key of [ 'positions', 'previousPositions' ] ) {

		const slow = slowFixture.chameleon.tailPhysics[ key ];
		const fast = fastFixture.chameleon.tailPhysics[ key ];
		for ( let index = 0; index < slow.length; index ++ ) assert.ok(
			Math.abs( slow[ index ] - fast[ index ] ) < 1e-6,
			`tail ${ key }[${ index }] depends on render rate`,
		);

	}
	const slowTailOrigin = new THREE.Vector3();
	const fastTailOrigin = new THREE.Vector3();
	for ( let index = 0; index < slowFixture.chameleon.tailVisualRig.bones.length; index ++ ) {

		slowFixture.chameleon.tailVisualRig.bones[ index ].getWorldPosition( slowTailOrigin );
		fastFixture.chameleon.tailVisualRig.bones[ index ].getWorldPosition( fastTailOrigin );
		assert.ok( slowTailOrigin.distanceTo( fastTailOrigin ) < 2e-4,
			`tail bone ${ index } world origin depends on render rate` );

	}
	for ( let repeat = 0; repeat < 20; repeat ++ )
		fastFixture.chameleon.syncVisual( 0.35, 1 / 240 );
	const firstRepeatedPose = fastFixture.chameleon.rig.bones.map( ( bone ) => bone.quaternion.clone() );
	fastFixture.chameleon.syncVisual( 0.35, 1 / 30 );
	for ( let index = 0; index < firstRepeatedPose.length; index ++ ) assert.ok(
		fastFixture.chameleon.rig.bones[ index ].quaternion.angleTo( firstRepeatedPose[ index ] ) < 1e-6,
		`${ fastFixture.chameleon.rig.bones[ index ].name } advances during render-only sync`,
	);

	const fixture = await createGroundedHybrid();
	const { chameleon, physics } = fixture;
	chameleon.setCommand( command );
	const leg = chameleon.rig.legs[ 0 ];
	const socket = new THREE.Vector3();
	const shoulder = new THREE.Vector3();
	const elbow = new THREE.Vector3();
	const supportNormal = new THREE.Vector3();
	const previousUpper = leg.upper.quaternion.clone();
	const restGirdle = leg.restQuaternions.get( leg.girdle );
	const restUpper = leg.restQuaternions.get( leg.upper );
	let minimumShoulderHeight = Infinity;
	let maximumShoulderHeight = -Infinity;
	let minimumElbowHeight = Infinity;
	let maximumElbowHeight = -Infinity;
	let minimumElbowAboveShoulder = Infinity;
	let maximumElbowAboveShoulder = -Infinity;
	let maximumPoleUp = -Infinity;
	let maximumGirdleExcursion = 0;
	let maximumUpperExcursion = 0;
	let maximumRenderRotation = 0;
	let swingSamples = 0;
	for ( let frame = 0; frame < 240 * 5; frame ++ ) {

		const result = physics.step(
			1 / 240,
			( dt ) => chameleon.beforeStep( dt ),
			() => chameleon.afterStep(),
		);
		chameleon.syncVisual( result.alpha, 1 / 240 );
		const frameRotation = previousUpper.angleTo( leg.upper.quaternion );
		maximumRenderRotation = Math.max( maximumRenderRotation, frameRotation );
		previousUpper.copy( leg.upper.quaternion );
		if ( chameleon.feet[ 0 ].state !== 'swinging' ) continue;
		leg.girdle.getWorldPosition( socket );
		leg.upper.getWorldPosition( shoulder );
		leg.lower.getWorldPosition( elbow );
		supportNormal.copy( chameleon.feet[ 0 ].normal ).normalize();
		const shoulderHeight = shoulder.clone().sub( socket ).dot( supportNormal );
		const elbowHeight = elbow.clone().sub( socket ).dot( supportNormal );
		const elbowAboveShoulder = elbow.clone().sub( shoulder ).dot( supportNormal );
		minimumShoulderHeight = Math.min( minimumShoulderHeight, shoulderHeight );
		maximumShoulderHeight = Math.max( maximumShoulderHeight, shoulderHeight );
		minimumElbowHeight = Math.min( minimumElbowHeight, elbowHeight );
		maximumElbowHeight = Math.max( maximumElbowHeight, elbowHeight );
		minimumElbowAboveShoulder = Math.min( minimumElbowAboveShoulder, elbowAboveShoulder );
		maximumElbowAboveShoulder = Math.max( maximumElbowAboveShoulder, elbowAboveShoulder );
		maximumPoleUp = Math.max(
			maximumPoleUp,
			leg.solver.poleDirection[ 0 ] * supportNormal.x
				+ leg.solver.poleDirection[ 1 ] * supportNormal.y
				+ leg.solver.poleDirection[ 2 ] * supportNormal.z,
		);
		maximumGirdleExcursion = Math.max(
			maximumGirdleExcursion, restGirdle.angleTo( leg.girdle.quaternion ),
		);
		maximumUpperExcursion = Math.max(
			maximumUpperExcursion, restUpper.angleTo( leg.upper.quaternion ),
		);
		swingSamples ++;

	}
	assert.ok( swingSamples > 100, `only ${ swingSamples } front swing samples` );
	assert.ok( maximumShoulderHeight > 0.008,
		`front shoulder never rises above its socket (${ maximumShoulderHeight } m)` );
	assert.ok( maximumShoulderHeight - minimumShoulderHeight > 0.045,
		`front shoulder stroke is only ${ maximumShoulderHeight - minimumShoulderHeight } m high` );
	assert.ok( maximumElbowHeight - minimumElbowHeight > 0.085,
		`front elbow stroke is only ${ maximumElbowHeight - minimumElbowHeight } m` );
	assert.ok( maximumElbowAboveShoulder > -0.006,
		`front elbow remains pinned below the shoulder (${ minimumElbowAboveShoulder }..${ maximumElbowAboveShoulder } m; pole up ${ maximumPoleUp })` );
	assert.ok( maximumGirdleExcursion > 0.28,
		`front girdle excursion is only ${ maximumGirdleExcursion } rad` );
	assert.ok( maximumUpperExcursion > 0.32,
		`front upper-arm excursion is only ${ maximumUpperExcursion } rad` );
	assert.ok( maximumRenderRotation < 0.031,
		`front arm contains a ${ maximumRenderRotation } rad render-frame snap` );
	const rotationMetrics = chameleon.rig.legs.slice( 0, 2 ).map( ( frontLeg ) => ( {
		leg: frontLeg,
		previous: frontLeg.upper.quaternion.clone(),
		inverse: new THREE.Quaternion(),
		delta: new THREE.Quaternion(),
		previousStep: new THREE.Vector3(),
		step: new THREE.Vector3(),
		peakSecondDifference: 0,
		squaredSecondDifference: 0,
		samples: 0,
	} ) );
	for ( let frame = 0; frame < 120 * 5; frame ++ ) {

		const result = physics.step(
			1 / 120,
			( dt ) => chameleon.beforeStep( dt ),
			() => chameleon.afterStep(),
		);
		chameleon.syncVisual( result.alpha, 1 / 120 );
		for ( const metric of rotationMetrics ) {

			metric.inverse.copy( metric.previous ).invert();
			metric.delta.multiplyQuaternions(
				metric.leg.upper.quaternion, metric.inverse,
			).normalize();
			if ( metric.delta.w < 0 ) metric.delta.set(
				-metric.delta.x, -metric.delta.y, -metric.delta.z, -metric.delta.w,
			);
			const sine = Math.hypot( metric.delta.x, metric.delta.y, metric.delta.z );
			const angle = 2 * Math.atan2( sine, Math.max( 0, metric.delta.w ) );
			const scale = sine > 1e-8 ? angle / sine : 2;
			metric.step.set(
				metric.delta.x * scale,
				metric.delta.y * scale,
				metric.delta.z * scale,
			);
			if ( metric.samples > 0 ) {

				const secondDifference = metric.step.distanceTo( metric.previousStep );
				metric.peakSecondDifference = Math.max(
					metric.peakSecondDifference, secondDifference,
				);
				metric.squaredSecondDifference += secondDifference * secondDifference;

			}
			metric.samples ++;
			metric.previousStep.copy( metric.step );
			metric.previous.copy( metric.leg.upper.quaternion );

		}

	}
	for ( const metric of rotationMetrics ) {

		const rms = Math.sqrt(
			metric.squaredSecondDifference / Math.max( 1, metric.samples - 1 ),
		);
		assert.ok( metric.peakSecondDifference < 0.012,
			`${ metric.leg.upper.name } angular acceleration spike ${ metric.peakSecondDifference } rad/tick²` );
		assert.ok( rms < 0.006,
			`${ metric.leg.upper.name } angular acceleration RMS ${ rms } rad/tick²` );

	}
	assertAnatomicalPose( chameleon );
	assertFiniteHybrid( fixture );
	fixture.dispose();
	slowFixture.dispose();
	fastFixture.dispose();

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
	// Only the root link remains rigid: the free curve starts at tail_02, close
	// enough to the rump to avoid the former visibly frozen tail section.
	assert.equal( chameleon.tailPhysics.kinematicNodeCount, 2 );
	assert.deepEqual(
		Array.from( chameleon.tailVisualRig.transitionWeights.slice( 0, 4 ) ),
		Array.from( new Float32Array( [ 0, 1, 1, 1 ] ) ),
	);
	// A collision-safe centreline is not enough if the visual bones alternate
	// between two poses. Sample the settled tail at a deliberately high render
	// rate and reject any one-frame whip or residual high-speed corkscrew.
	const previousTailRotations = chameleon.tailVisualRig.bones.map(
		( bone ) => bone.quaternion.clone(),
	);
	let maximumTailRenderRotation = 0;
	let maximumSettledTailSpeed = 0;
	let squaredTailRenderRotation = 0;
	let tailRenderRotationSamples = 0;
	let squaredSettledTailSpeed = 0;
	let maximumSettledTailEnergy = 0;
	let maximumInterpolatedOriginError = 0;
	const interpolatedTailPositions = chameleon.tailPhysics.getView().interpolatedPositions;
	const interpolatedBoneOrigin = new THREE.Vector3();
	const interpolatedPhysicsOrigin = new THREE.Vector3();
	for ( let frame = 0; frame < 480; frame ++ ) {

		const result = fixture.physics.step(
			1 / 240,
			( dt ) => chameleon.beforeStep( dt ),
			() => chameleon.afterStep(),
		);
		chameleon.syncVisual( result.alpha );
		for ( let index = 0; index < chameleon.tailVisualRig.bones.length; index ++ ) {

			const bone = chameleon.tailVisualRig.bones[ index ];
			const rotation = previousTailRotations[ index ].angleTo( bone.quaternion );
			maximumTailRenderRotation = Math.max( maximumTailRenderRotation, rotation );
			squaredTailRenderRotation += rotation * rotation;
			tailRenderRotationSamples ++;
			previousTailRotations[ index ].copy( bone.quaternion );
			if ( index >= chameleon.tailVisualRig.physicsKinematicBoneCount ) {

				bone.getWorldPosition( interpolatedBoneOrigin );
				const offset = index * 3;
				maximumInterpolatedOriginError = Math.max(
					maximumInterpolatedOriginError,
					interpolatedBoneOrigin.distanceTo( interpolatedPhysicsOrigin.set(
						interpolatedTailPositions[ offset ],
						interpolatedTailPositions[ offset + 1 ],
						interpolatedTailPositions[ offset + 2 ],
					) ),
				);

			}

		}
		const speed = chameleon.tailPhysics.maxNodeSpeed();
		maximumSettledTailSpeed = Math.max( maximumSettledTailSpeed, speed );
		squaredSettledTailSpeed += speed * speed;
		maximumSettledTailEnergy = Math.max(
			maximumSettledTailEnergy, chameleon.tailPhysics.kineticEnergy(),
		);

	}
	const tailRenderRotationRms = Math.sqrt(
		squaredTailRenderRotation / Math.max( 1, tailRenderRotationSamples ),
	);
	const settledTailSpeedRms = Math.sqrt( squaredSettledTailSpeed / 480 );
	assert.ok( maximumTailRenderRotation < 0.0015,
		`settled tail contains a ${ maximumTailRenderRotation } rad render-frame whip` );
	assert.ok( tailRenderRotationRms < 0.0004,
		`settled tail rotation RMS is ${ tailRenderRotationRms } rad/frame` );
	assert.ok( maximumSettledTailSpeed < 0.03,
		`settled tail contains a ${ maximumSettledTailSpeed } m/s residual spin` );
	assert.ok( settledTailSpeedRms < 0.02,
		`settled tail speed RMS is ${ settledTailSpeedRms } m/s` );
	assert.ok( maximumSettledTailEnergy < 5e-4,
		`settled tail energy reaches ${ maximumSettledTailEnergy }` );
	assert.ok( maximumInterpolatedOriginError < 0.009,
		`interpolated visual tail diverges by ${ maximumInterpolatedOriginError } m` );
	for ( let node = chameleon.tailPhysics.kinematicNodeCount;
		node < chameleon.tail.nodeCount; node ++ ) {

		assert.ok(
			positions[ node * 3 + 1 ] >= radii[ node ] * chameleon.settings.tailCollisionScale - 0.006,
			`tail node ${ node } penetrates ground: ${ positions[ node * 3 + 1 ] }`,
		);

	}
	let deformedBones = 0;
	const boneAxis = new THREE.Vector3( 0, 1, 0 );
	const physicalDirection = new THREE.Vector3();
	const boneOrigin = new THREE.Vector3();
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
		const exactDynamicBone = chameleon.tailVisualRig.transitionWeights[ index ] >= 0.999;
		const centrelineAlignment = boneAxis.dot( physicalDirection );
		bone.getWorldPosition( boneOrigin );
		const physicalOffset = index * 3;
		const originError = boneOrigin.distanceTo( new THREE.Vector3(
			positions[ physicalOffset ], positions[ physicalOffset + 1 ], positions[ physicalOffset + 2 ],
		) );
		assert.ok(
			centrelineAlignment > ( exactDynamicBone ? 0.995 : 0.72 ),
			`tail bone ${ index } does not follow the passive centreline (${ centrelineAlignment }; origin error ${ originError })`,
		);
		if ( exactDynamicBone ) assert.ok( originError < 0.009,
			`tail bone ${ index } origin diverges by ${ originError } m` );

	}
	assert.ok( deformedBones >= 8, `only ${ deformedBones } tail bones deformed` );
	assert.ok( chameleon.tailPhysics.kineticEnergy() < chameleon.tailPhysics.maximumKineticEnergy() );
	assert.ok( chameleon.tailPhysics.stats.totalSteps >= 480 );
	assert.ok( chameleon.tailPhysics.maxSegmentError() < 0.006, `tail segment error ${ chameleon.tailPhysics.maxSegmentError() }` );
	// The centreline can remain outside the colliders while the actual tapered
	// skin still clips through them. Validate the rendered, skinned tail surface
	// rather than accepting a visually false positive from the rod alone.
	let tailVertexCount = 0;
	let minimumTailSurfaceY = Infinity;
	let minimumTailVertex = -1;
	let minimumTailInfluences = '';
	const skinnedVertex = new THREE.Vector3();
	chameleon.model.traverse( ( object ) => {

		if ( ! object.isSkinnedMesh ) return;
		const skinIndex = object.geometry.getAttribute( 'skinIndex' );
		const skinWeight = object.geometry.getAttribute( 'skinWeight' );
		if ( ! skinIndex || ! skinWeight ) return;
		const tailJointIndices = new Set( chameleon.tailVisualRig.bones.map(
			( bone ) => object.skeleton.bones.indexOf( bone ),
		) );
		for ( let vertex = 0; vertex < skinIndex.count; vertex ++ ) {

			let tailWeight = 0;
			for ( let lane = 0; lane < 4; lane ++ ) {

				const joint = skinIndex.getComponent( vertex, lane );
				if ( tailJointIndices.has( joint ) )
					tailWeight += skinWeight.getComponent( vertex, lane );

			}
			if ( tailWeight < 0.5 ) continue;
			object.getVertexPosition( vertex, skinnedVertex );
			object.localToWorld( skinnedVertex );
			if ( skinnedVertex.y < minimumTailSurfaceY ) {

				minimumTailSurfaceY = skinnedVertex.y;
				minimumTailVertex = vertex;
				minimumTailInfluences = Array.from( { length: 4 }, ( _, lane ) => {

					const joint = skinIndex.getComponent( vertex, lane );
					return `${ object.skeleton.bones[ joint ]?.name ?? joint }:${ skinWeight.getComponent( vertex, lane ).toFixed( 3 ) }`;

				} ).join( ',' );

			}
			tailVertexCount ++;

		}

	} );
	assert.ok( tailVertexCount > 5_000, `only ${ tailVertexCount } rendered tail vertices sampled` );
	assert.ok(
		minimumTailSurfaceY >= -0.001,
		`rendered tail skin penetrates ground by ${ -minimumTailSurfaceY } m at vertex ${ minimumTailVertex } (${ minimumTailInfluences })`,
	);
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-010 exact asymmetric soles close on their support anchors', async () => {

	const fixture = await createGroundedHybrid();
	fixture.chameleon.setCommand( { move: new THREE.Vector3( -0.75, 0, 0.18 ) } );
	runFrames( fixture, 120, 2 );
	fixture.chameleon.setCommand( { move: new THREE.Vector3() } );
	runFrames( fixture, 120, 1 );
	fixture.chameleon.syncVisual( 1, 1 / 120 );
	for ( let index = 0; index < fixture.chameleon.rig.legs.length; index ++ ) {

		const leg = fixture.chameleon.rig.legs[ index ];
		const normal = fixture.chameleon.feet[ index ].normal.clone().normalize();
		const distal = [
			[ leg.palm, ANATOMICAL_POSITION.WRIST, ANATOMICAL_POSITION.PALM_END ],
			[ leg.inner, ANATOMICAL_POSITION.PALM_END, ANATOMICAL_POSITION.DIGIT_INNER ],
			[ leg.outer, ANATOMICAL_POSITION.PALM_END, ANATOMICAL_POSITION.DIGIT_OUTER ],
		];
		for ( const [ bone, start, end ] of distal ) {

			const axis = new THREE.Vector3( 0, 1, 0 )
				.applyQuaternion( bone.getWorldQuaternion( new THREE.Quaternion() ) ).normalize();
			const solvedAxis = new THREE.Vector3(
				leg.solver.positions[ end ] - leg.solver.positions[ start ],
				leg.solver.positions[ end + 1 ] - leg.solver.positions[ start + 1 ],
				leg.solver.positions[ end + 2 ] - leg.solver.positions[ start + 2 ],
			).normalize();
			assert.ok( axis.dot( solvedAxis ) > 0.995,
				`${ bone.name } diverges from its asymmetric authored axis` );
			const soleNormal = leg.contactNormalLocals.get( bone ).clone()
				.applyQuaternion( bone.getWorldQuaternion( new THREE.Quaternion() ) );
			const soleAlignment = soleNormal.dot( normal );
			assert.ok( soleAlignment < -0.88,
				`${ bone.name } sole does not face its support (${ soleAlignment })` );

		}
		const patchCentre = leg.palm.localToWorld( leg.contactPatchLocal.clone() );
		const anchor = fixture.chameleon.feet[ index ].anchor;
		const anchorError = anchor ? patchCentre.distanceTo( anchor ) : Infinity;
		const solvedCentre = new THREE.Vector3().fromArray( leg.solver.positions, 12 );
		const solvedError = patchCentre.distanceTo( solvedCentre );
		const deviations = [ leg.girdle, leg.upper, leg.lower, leg.palm, leg.inner, leg.outer ].map(
			( bone ) => leg.restQuaternions.get( bone ).angleTo( bone.quaternion ),
		);
		assert.ok( solvedError < 0.003,
			`${ leg.name } rendered contact patch diverged from its anatomical solve (${ solvedError }); deviations=${ deviations }` );
		assert.ok( anchor && anchorError < 0.015,
			`${ leg.name } contact patch missed its stance anchor (${ anchorError }); metrics=${ [ ...leg.solver.metrics ] }; offset=${ [ ...leg.solver.contactOffset ] }; local=${ leg.contactPatchLocal.toArray() }; lengths=${ [ ...leg.solver.lengths ] }; socket=${ leg.girdle.getWorldPosition( new THREE.Vector3() ).toArray() }; anchor=${ anchor?.toArray() }; body=${ Object.values( fixture.chameleon.pelvis.body.translation() ) }; desired=${ fixture.chameleon.desiredRoot.toArray() }` );
		if ( leg.kind === 'hind' ) {

			assert.equal( leg.solver.metrics[ ANATOMICAL_METRIC.CLAMPED ], 0 );
			assert.ok( Math.abs( leg.solver.metrics[ ANATOMICAL_METRIC.REACH_RESIDUAL ] ) < 0.003 );
			assert.ok( leg.solver.metrics[ ANATOMICAL_METRIC.FLEXION ] >= 0.95,
				`${ leg.name } flexion ${ leg.solver.metrics[ ANATOMICAL_METRIC.FLEXION ] }` );

		}

	}
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-011 held limbs become passive articulated chains then recover muscle tone', async () => {

	const fixture = await createGroundedHybrid();
	runFrames( fixture, 120, 1 );
	const activePose = fixture.chameleon.rig.legs.flatMap( ( leg ) =>
		leg.passiveBones.map( ( bone ) => bone.quaternion.clone() ) );
	fixture.chameleon.setDragging( true );
	fixture.chameleon.pelvis.body.applyImpulse( { x: 0.38, y: 0.52, z: -0.24 }, true );
	fixture.chameleon.pelvis.body.applyTorqueImpulse( { x: 0.06, y: -0.08, z: 0.07 }, true );
	runFrames( fixture, 120, 0.55 );
	assert.ok( fixture.chameleon.passiveLimbPhysics.stats.steps >= 60 );
	const passive = fixture.chameleon.passiveLimbPhysics;
	let worstSegment = '';
	let worstError = -1;
	for ( let limb = 0; limb < 4; limb ++ ) for ( let segment = 0; segment < 4; segment ++ ) {

		const first = ( limb * 5 + segment ) * 3;
		const second = first + 3;
		const length = Math.hypot(
			passive.positions[ second ] - passive.positions[ first ],
			passive.positions[ second + 1 ] - passive.positions[ first + 1 ],
			passive.positions[ second + 2 ] - passive.positions[ first + 2 ],
		);
		const error = Math.abs( length - passive.segmentLengths[ limb * 4 + segment ] );
		if ( error > worstError ) {

			worstError = error;
			worstSegment = `${ limb }:${ segment } (${ length } vs ${ passive.segmentLengths[ limb * 4 + segment ] })`;

		}

	}
	assert.ok( fixture.chameleon.passiveLimbPhysics.maxSegmentError() < 0.008,
		`passive limb error ${ fixture.chameleon.passiveLimbPhysics.maxSegmentError() }; worst=${ worstSegment }` );
	let passiveBones = 0;
	let boneIndex = 0;
	for ( const leg of fixture.chameleon.rig.legs ) for ( const bone of leg.passiveBones ) {

		if ( bone.quaternion.angleTo( activePose[ boneIndex ] ) > 0.08 ) passiveBones ++;
		boneIndex ++;

	}
	assert.ok( passiveBones >= 8, `only ${ passiveBones } limb bones reacted passively` );
	fixture.chameleon.setDragging( false );
	runFrames( fixture, 120, 0.65 );
	assertAnatomicalPose( fixture.chameleon );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-012 distal tail cannot fold through torso or head', async () => {

	const fixture = await createGroundedHybrid();
	fixture.chameleon.setCommand( { move: new THREE.Vector3( -0.72, 0, 0.25 ) } );
	runFrames( fixture, 120, 5 );
	const root = fixture.chameleon.pelvis.body;
	const translation = root.translation();
	const inverse = new THREE.Quaternion(
		root.rotation().x, root.rotation().y, root.rotation().z, root.rotation().w,
	).invert();
	const positions = fixture.chameleon.tailPhysics.getView().positions;
	const radii = fixture.chameleon.tailPhysics.getView().radii;
	const rootPoint = new THREE.Vector3( positions[ 0 ], positions[ 1 ], positions[ 2 ] );
	for ( let node = 1; node < fixture.chameleon.tail.nodeCount; node ++ ) {

		const worldPoint = new THREE.Vector3(
			positions[ node * 3 ], positions[ node * 3 + 1 ], positions[ node * 3 + 2 ],
		);
		if ( worldPoint.distanceToSquared( rootPoint ) <= 0.22 * 0.22 ) continue;
		const local = worldPoint.sub( new THREE.Vector3( translation.x, translation.y, translation.z ) )
			.applyQuaternion( inverse );
		const capsuleX = THREE.MathUtils.clamp( local.x, -0.3, 0.14 );
		const torsoDistance = Math.hypot( local.x - capsuleX, local.y - 0.04, local.z );
		const headDistance = Math.hypot( local.x + 0.38, local.y - 0.055, local.z );
		assert.ok( torsoDistance >= 0.16 + radii[ node ] - 0.025,
			`tail node ${ node } entered torso` );
		assert.ok( headDistance >= 0.18 + radii[ node ] - 0.025,
			`tail node ${ node } entered head` );

	}
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-013 a thrown body reacquires wall and cylinder supports', async () => {

	for ( const surfaceCase of [ 'wall', 'cylinder' ] ) {

		const fixture = await createGroundedHybrid();
		const { RAPIER, world } = fixture.physics;
		const obstacleBody = world.createRigidBody( RAPIER.RigidBodyDesc.fixed() );
		let collider;
		let launchPosition;
		let launchVelocity;
		let expectedNormal;
		if ( surfaceCase === 'wall' ) {

			obstacleBody.setTranslation( { x: 0, y: 1, z: -1.45 }, false );
			collider = world.createCollider(
				RAPIER.ColliderDesc.cuboid( 2, 1.2, 0.1 )
					.setFriction( 0.95 )
					.setCollisionGroups( ( 0x0001 << 16 ) | 0xffff ),
				obstacleBody,
			);
			launchPosition = { x: 0, y: 0.8, z: -0.82 };
			launchVelocity = { x: 0, y: 0, z: -3.2 };
			expectedNormal = new THREE.Vector3( 0, 0, 1 );

		} else {

			obstacleBody.setTranslation( { x: 1.45, y: 0.9, z: 0 }, false );
			obstacleBody.setRotation( {
				x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2,
			}, false );
			collider = world.createCollider(
				RAPIER.ColliderDesc.cylinder( 1.4, 0.42 )
					.setFriction( 0.95 )
					.setCollisionGroups( ( 0x0001 << 16 ) | 0xffff ),
				obstacleBody,
			);
			launchPosition = { x: 0.7, y: 0.9, z: 0 };
			launchVelocity = { x: 3.2, y: 0, z: 0 };
			expectedNormal = new THREE.Vector3( -1, 0, 0 );

		}
		fixture.physics.surfaceByCollider.set( collider.handle, Object.freeze( {
			kind: surfaceCase,
			clawEligible: true,
			gripStrengthScale: 1,
		} ) );
		fixture.chameleon.setDragging( true );
		fixture.chameleon.pelvis.body.setTranslation( launchPosition, true );
		fixture.chameleon.pelvis.body.setLinvel( launchVelocity, true );
		fixture.chameleon.pelvis.body.setAngvel( { x: 0.35, y: -0.2, z: 0.28 }, true );
		world.propagateModifiedBodyPositionsToColliders();
		runFrames( fixture, 120, 0.08 );
		fixture.chameleon.setDragging( false );
		let bestSupportAlignment = -1;
		let bestCandidateCount = 0;
		let bestCandidateAlignment = -1;
		const candidateKinds = new Set();
		runFrames( fixture, 120, 2.5, () => {

			bestCandidateCount = Math.max(
				bestCandidateCount, fixture.chameleon.candidateContactCount,
			);
			for ( let foot = 0; foot < 4; foot ++ ) {

				if ( ! fixture.chameleon.candidateActiveContacts[ foot ] ) continue;
				const offset = foot * 3;
				bestCandidateAlignment = Math.max( bestCandidateAlignment,
					fixture.chameleon.candidateContactNormals[ offset ] * expectedNormal.x
					+ fixture.chameleon.candidateContactNormals[ offset + 1 ] * expectedNormal.y
					+ fixture.chameleon.candidateContactNormals[ offset + 2 ] * expectedNormal.z );
				candidateKinds.add( fixture.chameleon.feet[ foot ]._candidateSurface?.kind ?? 'none' );

			}
			if ( fixture.chameleon.contactCount >= 2 ) bestSupportAlignment = Math.max(
				bestSupportAlignment,
				fixture.chameleon.supportNormal.dot( expectedNormal ),
			);

		} );
		assert.ok( fixture.chameleon.contactCount >= 2,
			`${ surfaceCase } throw did not reacquire enough claws; count=${ fixture.chameleon.contactCount }; candidates=${ bestCandidateCount }; best=${ bestSupportAlignment }; body=${ Object.values( fixture.chameleon.pelvis.body.translation() ) }; feet=${ fixture.chameleon.feet.map( ( foot ) => foot.surface?.kind ?? 'none' ) }` );
		assert.ok( fixture.chameleon.supportNormal.dot( expectedNormal ) > 0.65,
			`${ surfaceCase } support normal is ${ fixture.chameleon.supportNormal.toArray() }; candidates=${ bestCandidateCount }/${ bestCandidateAlignment }/${ [ ...candidateKinds ] }; best=${ bestSupportAlignment }; body=${ Object.values( fixture.chameleon.pelvis.body.translation() ) }; feet=${ fixture.chameleon.feet.map( ( foot ) => `${ foot.surface?.kind ?? 'none' }/${ foot.normal.toArray() }` ) }` );
		const bodyUp = new THREE.Vector3( 0, 1, 0 ).applyQuaternion(
			new THREE.Quaternion().copy( fixture.chameleon.pelvis.body.rotation() ),
		);
		assert.ok( bodyUp.dot( expectedNormal ) > 0.55,
			`${ surfaceCase } body failed to orient onto its support (${ bodyUp.dot( expectedNormal ) })` );
		runFrames( fixture, 120, 2.5 );
		assert.equal( fixture.chameleon.staticGripLocked, true,
			`${ surfaceCase } support never converged to a static claw lock` );
		assert.equal( fixture.chameleon.pelvis.body.isSleeping(), true,
			`${ surfaceCase } rigid body kept jittering after static lock` );
		assertFiniteHybrid( fixture );
		fixture.dispose();

	}

} );

test( 'CHAMELEON-LAB-RAGDOLL-014 jump release cannot reactivate stale ground claws in mid-air', async () => {

	const fixture = await createGroundedHybrid();
	runFrames( fixture, 120, 0.8 );
	assert.ok( fixture.chameleon.contactCount >= 2 );
	fixture.chameleon.setCommand( { release: true } );
	let maximumReleasedContacts = 0;
	runFrames( fixture, 120, 0.12, () => {

		maximumReleasedContacts = Math.max(
			maximumReleasedContacts, fixture.chameleon.contactCount,
		);

	} );
	assert.equal( maximumReleasedContacts, 0, 'release retained active claw forces' );

	// Model the airborne part of a jump independently of its take-off impulse.
	// No eligible surface is within claw reach at this altitude, so restoring
	// grip must not revive the pre-jump ground anchors.
	const body = fixture.chameleon.pelvis.body;
	body.setTranslation( { x: 0, y: 1.15, z: 0 }, true );
	body.setLinvel( { x: 0.18, y: 0.7, z: -0.12 }, true );
	fixture.physics.world.propagateModifiedBodyPositionsToColliders();
	fixture.chameleon.setCommand( { release: false } );
	let maximumAirborneContacts = 0;
	runFrames( fixture, 120, 0.08, () => {

		maximumAirborneContacts = Math.max(
			maximumAirborneContacts, fixture.chameleon.contactCount,
		);

	} );
	assert.equal(
		maximumAirborneContacts,
		0,
		`stale ground contacts reactivated in air: ${ fixture.chameleon.feet.map(
			( foot ) => `${ foot.state }/${ foot.surface?.kind ?? 'none' }`,
		).join( ', ' ) }`,
	);
	assert.ok( body.translation().y > 0.75 );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-015 post-jump impact reacquires wall and cylinder without stale support', async () => {

	for ( const surfaceCase of [ 'wall', 'cylinder' ] ) {

		const fixture = await createGroundedHybrid();
		const { RAPIER, world } = fixture.physics;
		const obstacleBody = world.createRigidBody( RAPIER.RigidBodyDesc.fixed() );
		let collider;
		let launchPosition;
		let launchVelocity;
		let expectedNormal;
		if ( surfaceCase === 'wall' ) {

			obstacleBody.setTranslation( { x: 0, y: 1, z: -1.45 }, false );
			collider = world.createCollider(
				RAPIER.ColliderDesc.cuboid( 2, 1.2, 0.1 )
					.setFriction( 0.95 )
					.setCollisionGroups( ( 0x0001 << 16 ) | 0xffff ),
				obstacleBody,
			);
			launchPosition = { x: 0, y: 0.8, z: -0.82 };
			launchVelocity = { x: 0, y: 0.45, z: -3.2 };
			expectedNormal = new THREE.Vector3( 0, 0, 1 );

		} else {

			obstacleBody.setTranslation( { x: 1.45, y: 0.9, z: 0 }, false );
			obstacleBody.setRotation( {
				x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2,
			}, false );
			collider = world.createCollider(
				RAPIER.ColliderDesc.cylinder( 1.4, 0.42 )
					.setFriction( 0.95 )
					.setCollisionGroups( ( 0x0001 << 16 ) | 0xffff ),
				obstacleBody,
			);
			launchPosition = { x: 0.7, y: 0.9, z: 0 };
			launchVelocity = { x: 3.2, y: 0.35, z: 0 };
			expectedNormal = new THREE.Vector3( -1, 0, 0 );

		}
		fixture.physics.surfaceByCollider.set( collider.handle, Object.freeze( {
			kind: surfaceCase,
			clawEligible: true,
			gripStrengthScale: 1,
		} ) );
		fixture.chameleon.setCommand( { release: true } );
		fixture.chameleon.pelvis.body.setTranslation( launchPosition, true );
		fixture.chameleon.pelvis.body.setLinvel( launchVelocity, true );
		fixture.chameleon.pelvis.body.setAngvel( { x: 0.22, y: -0.13, z: 0.18 }, true );
		world.propagateModifiedBodyPositionsToColliders();
		let releaseContacts = 0;
		runFrames( fixture, 120, 0.12, () => {

			releaseContacts = Math.max( releaseContacts, fixture.chameleon.contactCount );

		} );
		assert.equal( releaseContacts, 0, `${ surfaceCase } jump did not release claws` );
		fixture.chameleon.setCommand( { release: false } );
		let bestCandidateCount = 0;
		let bestSupportAlignment = -1;
		runFrames( fixture, 120, 2.5, () => {

			bestCandidateCount = Math.max(
				bestCandidateCount, fixture.chameleon.candidateContactCount,
			);
			if ( fixture.chameleon.contactCount >= 2 ) bestSupportAlignment = Math.max(
				bestSupportAlignment,
				fixture.chameleon.supportNormal.dot( expectedNormal ),
			);

		} );
		const matchingContacts = fixture.chameleon.feet.filter(
			( foot ) => foot.state === 'holding' && foot.surface?.kind === surfaceCase,
		).length;
		assert.ok(
			matchingContacts >= 2,
			`${ surfaceCase } impact acquired ${ matchingContacts } matching claws; candidates=${ bestCandidateCount }; contacts=${ fixture.chameleon.contactCount }; feet=${ fixture.chameleon.feet.map( ( foot ) => `${ foot.state }/${ foot.surface?.kind ?? 'none' }` ) }`,
		);
		assert.ok(
			fixture.chameleon.supportNormal.dot( expectedNormal ) > 0.65,
			`${ surfaceCase } support normal did not follow impact: ${ fixture.chameleon.supportNormal.toArray() }; best=${ bestSupportAlignment }`,
		);
		assertFiniteHybrid( fixture );
		fixture.dispose();

	}

} );

test( 'CHAMELEON-LAB-RAGDOLL-017 release cannot select a remote surface before a physical manifold exists', async () => {

	const fixture = await createGroundedHybrid();
	const body = fixture.chameleon.pelvis.body;
	fixture.chameleon.setDragging( true );
	body.setTranslation( { x: 0, y: 2.1, z: 0 }, true );
	body.setLinvel( { x: 0.1, y: 0, z: -0.08 }, true );
	fixture.physics.world.propagateModifiedBodyPositionsToColliders();
	fixture.chameleon.setDragging( false );
	runFrames( fixture, 120, 0.12 );
	assert.equal( fixture.chameleon.reacquireState, 'seeking' );
	assert.equal( fixture.chameleon.reacquireColliderHandle, null );
	assert.equal( fixture.chameleon.contactCount, 0 );
	assert.equal( fixture.chameleon.candidateContactCount, 0 );
	assert.ok( body.translation().y > 1.9 );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-018 an inverted landing rights the belly before engaging claws', async () => {

	const fixture = await createGroundedHybrid();
	const body = fixture.chameleon.pelvis.body;
	fixture.chameleon.setDragging( true );
	body.setTranslation( { x: 0, y: 0.62, z: 0 }, true );
	body.setRotation( { x: 1, y: 0, z: 0, w: 0 }, true );
	body.setLinvel( { x: 0.05, y: -1.35, z: 0.03 }, true );
	body.setAngvel( { x: 0.25, y: 0.08, z: -0.18 }, true );
	fixture.physics.world.propagateModifiedBodyPositionsToColliders();
	fixture.chameleon.setDragging( false );
	let contactsWhileDorsal = 0;
	let bestAlignment = -1;
	runFrames( fixture, 120, 2.4, () => {

		if ( fixture.chameleon.reacquireVentralAlignment < 0.35 )
			contactsWhileDorsal = Math.max( contactsWhileDorsal, fixture.chameleon.contactCount );
		const rotation = new THREE.Quaternion().copy( body.rotation() );
		bestAlignment = Math.max(
			bestAlignment,
			new THREE.Vector3( 0, 1, 0 ).applyQuaternion( rotation ).y,
		);

	} );
	assert.equal( contactsWhileDorsal, 0, 'dorsal impact activated claws before righting' );
	assert.ok( bestAlignment > 0.8, `righting alignment peaked at ${ bestAlignment }` );
	assert.ok( fixture.chameleon.contactCount >= 2 );
	const bodyUp = new THREE.Vector3( 0, 1, 0 ).applyQuaternion(
		new THREE.Quaternion().copy( body.rotation() ),
	);
	assert.ok( bodyUp.y > 0.65, `body stayed on its flank/back (${ bodyUp.y })` );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-019 a corner impact commits to one surface without support ping-pong', async () => {

	const fixture = await createGroundedHybrid();
	const { RAPIER, world } = fixture.physics;
	const xWallBody = world.createRigidBody(
		RAPIER.RigidBodyDesc.fixed().setTranslation( 1.45, 0.9, 0 ),
	);
	const zWallBody = world.createRigidBody(
		RAPIER.RigidBodyDesc.fixed().setTranslation( 0, 0.9, -1.45 ),
	);
	const xWall = world.createCollider(
		RAPIER.ColliderDesc.cuboid( 0.1, 1.2, 2 )
			.setFriction( 0.95 ).setCollisionGroups( ( 0x0001 << 16 ) | 0xffff ),
		xWallBody,
	);
	const zWall = world.createCollider(
		RAPIER.ColliderDesc.cuboid( 2, 1.2, 0.1 )
			.setFriction( 0.95 ).setCollisionGroups( ( 0x0001 << 16 ) | 0xffff ),
		zWallBody,
	);
	for ( const [ collider, kind ] of [ [ xWall, 'corner-x' ], [ zWall, 'corner-z' ] ] )
		fixture.physics.surfaceByCollider.set( collider.handle, Object.freeze( {
			kind, clawEligible: true, gripStrengthScale: 1,
		} ) );

	const body = fixture.chameleon.pelvis.body;
	fixture.chameleon.setDragging( true );
	body.setTranslation( { x: 0.7, y: 0.82, z: -0.7 }, true );
	body.setRotation( { x: 1, y: 0, z: 0, w: 0 }, true );
	body.setLinvel( { x: 3.1, y: 0.08, z: -3.1 }, true );
	body.setAngvel( { x: 0.22, y: -0.18, z: 0.16 }, true );
	world.propagateModifiedBodyPositionsToColliders();
	fixture.chameleon.setDragging( false );
	let owner = null;
	let ownerTransitions = 0;
	let maximumOwnedClaws = 0;
	runFrames( fixture, 120, 2.5, () => {

		const nextOwner = fixture.chameleon.reacquireColliderHandle;
		if ( nextOwner !== null && nextOwner !== owner ) {

			owner = nextOwner;
			ownerTransitions ++;

		}
		if ( owner !== null ) maximumOwnedClaws = Math.max(
			maximumOwnedClaws,
			fixture.chameleon.feet.filter(
				( foot ) => foot.state === 'holding' && foot.collider?.handle === owner,
			).length,
		);

	} );
	assert.ok( owner === xWall.handle || owner === zWall.handle,
		`corner owner was ${ owner }` );
	assert.equal( ownerTransitions, 1, `support changed owner ${ ownerTransitions } times` );
	assert.ok( maximumOwnedClaws >= 2, `only ${ maximumOwnedClaws } claws reached owner` );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-016 idle limbs retain authored flexion while neck and head animate softly', async () => {

	const fixture = await createGroundedHybrid();
	const { chameleon } = fixture;
	runFrames( fixture, 120, 2, () => assertFiniteHybrid( fixture ) );
	const neck = chameleon.rig.byName.get( 'neck' );
	const head = chameleon.rig.byName.get( 'head' );
	assert.ok( neck && head, 'the physical rig must expose neck and head bones' );
	const neckBaseline = neck.quaternion.clone();
	const headBaseline = head.quaternion.clone();
	let previousNeck = neckBaseline.clone();
	let previousHead = headBaseline.clone();
	let peakNeckExcursion = 0;
	let peakHeadExcursion = 0;
	let maximumNeckFrameDelta = 0;
	let maximumHeadFrameDelta = 0;
	const minimumFlexionRatio = new Float32Array( HYBRID_FOOT_COUNT ).fill( Infinity );
	const maximumResidual = new Float32Array( HYBRID_FOOT_COUNT );
	let clampSamples = 0;
	runFrames( fixture, 120, 6, () => {

		assertFiniteHybrid( fixture );
		peakNeckExcursion = Math.max(
			peakNeckExcursion, neckBaseline.angleTo( neck.quaternion ),
		);
		peakHeadExcursion = Math.max(
			peakHeadExcursion, headBaseline.angleTo( head.quaternion ),
		);
		maximumNeckFrameDelta = Math.max(
			maximumNeckFrameDelta, previousNeck.angleTo( neck.quaternion ),
		);
		maximumHeadFrameDelta = Math.max(
			maximumHeadFrameDelta, previousHead.angleTo( head.quaternion ),
		);
		previousNeck.copy( neck.quaternion );
		previousHead.copy( head.quaternion );
		for ( let index = 0; index < chameleon.rig.legs.length; index ++ ) {

			const leg = chameleon.rig.legs[ index ];
			minimumFlexionRatio[ index ] = Math.min(
				minimumFlexionRatio[ index ],
				leg.solver.metrics[ ANATOMICAL_METRIC.FLEXION ] / leg.restFlexion,
			);
			maximumResidual[ index ] = Math.max(
				maximumResidual[ index ],
				Math.abs( leg.solver.metrics[ ANATOMICAL_METRIC.REACH_RESIDUAL ] ),
			);
			clampSamples += leg.solver.metrics[ ANATOMICAL_METRIC.CLAMPED ];

		}

	} );
	for ( let index = 0; index < chameleon.rig.legs.length; index ++ ) {

		const leg = chameleon.rig.legs[ index ];
		assert.ok( minimumFlexionRatio[ index ] >= 0.72 - 1e-5,
			`${ leg.name } flexion fell to ${ minimumFlexionRatio[ index ] * 100 }% of rest` );
		assert.ok( maximumResidual[ index ] < 0.003,
			`${ leg.name } reach residual ${ maximumResidual[ index ] }` );
		const modelQuaternion = chameleon.model.getWorldQuaternion( new THREE.Quaternion() );
		const expectedForward = new THREE.Vector3( -1, 0, 0 ).applyQuaternion( modelQuaternion );
		const expectedUp = new THREE.Vector3( 0, 1, 0 ).applyQuaternion( modelQuaternion );
		assert.ok( expectedForward.dot( new THREE.Vector3().fromArray( leg.solver._bodyForward ) ) > 0.97,
			`${ leg.name } inherited a parent-bone axis instead of the model forward` );
		assert.ok( expectedUp.dot( new THREE.Vector3().fromArray( leg.solver._bodyUp ) ) > 0.97,
			`${ leg.name } inherited a parent-bone axis instead of the model up` );

	}
	assert.equal( clampSamples, 0, 'an idle anatomical solve must never clamp a limb' );
	assert.ok( peakNeckExcursion > 0.015,
		`neck animation was imperceptible (${ peakNeckExcursion })` );
	assert.ok( peakHeadExcursion > 0.005,
		`head animation was imperceptible (${ peakHeadExcursion })` );
	assert.ok( peakNeckExcursion < 0.35,
		`neck animation was excessive (${ peakNeckExcursion })` );
	assert.ok( peakHeadExcursion < 0.25,
		`head animation was excessive (${ peakHeadExcursion })` );
	assert.ok( maximumNeckFrameDelta < 0.01,
		`neck animation jumped by ${ maximumNeckFrameDelta } in one fixed step` );
	assert.ok( maximumHeadFrameDelta < 0.01,
		`head animation jumped by ${ maximumHeadFrameDelta } in one fixed step` );
	assert.equal( chameleon.contactCount, HYBRID_FOOT_COUNT );
	assertAnatomicalPose( chameleon );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-021 settled claws enter static grip sleep and wake on intent', async () => {

	const fixture = await createGroundedHybrid();
	const { chameleon } = fixture;
	runFrames( fixture, 120, 4 );
	assert.equal( chameleon.staticGripLocked, true );
	assert.equal( chameleon.pelvis.body.isSleeping(), true );
	const bodyBefore = bodyState( chameleon.pelvis.body );
	const feetBefore = chameleon.feet.map( ( foot ) => foot.anchor.clone() );
	let idleProbeRaycasts = 0;
	const castRayAndGetNormal = fixture.physics.world.castRayAndGetNormal;
	fixture.physics.world.castRayAndGetNormal = function ( ...args ) {

		idleProbeRaycasts ++;
		return castRayAndGetNormal.apply( this, args );

	};
	runFrames( fixture, 240, 2 );
	fixture.physics.world.castRayAndGetNormal = castRayAndGetNormal;
	assert.deepEqual( bodyState( chameleon.pelvis.body ), bodyBefore );
	assert.equal( idleProbeRaycasts, 0,
		'a sleeping static grip must not keep running the 44-ray claw probe fan' );
	for ( let foot = 0; foot < 4; foot ++ ) assert.ok(
		chameleon.feet[ foot ].anchor.distanceToSquared( feetBefore[ foot ] ) < 1e-16,
		`static claw ${ foot } drifted while locked`,
	);

	chameleon.setDragging( true );
	assert.equal( chameleon.staticGripLocked, false,
		'a mouse grab must release static friction immediately' );
	assert.equal( chameleon.pelvis.body.isSleeping(), false );
	chameleon.setDragging( false );
	runFrames( fixture, 120, 4 );
	assert.equal( chameleon.staticGripLocked, true );

	// Arcade steering can rotate with zero translation. It must wake the same
	// static-friction lock immediately instead of being mistaken for idle.
	chameleon.setCommand( {
		move: new THREE.Vector3(),
		facing: new THREE.Vector3( 0, 0, -1 ),
	} );
	assert.equal( chameleon.staticGripLocked, false );
	assert.equal( chameleon.pelvis.body.isSleeping(), false );
	runFrames( fixture, 120, 0.12 );
	const turnVelocity = chameleon.pelvis.body.angvel();
	assert.ok( Math.hypot( turnVelocity.x, turnVelocity.y, turnVelocity.z ) > 0.01 );
	chameleon.setCommand( { move: new THREE.Vector3( -1, 0, 0 ) } );
	runFrames( fixture, 120, 0.2 );
	assert.ok( chameleon.pelvis.body.linvel().x < -0.02 );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-022 charged jump drives a crouch and compliant aerial pose', async () => {

	const fixture = await createGroundedHybrid();
	const { chameleon } = fixture;
	runFrames( fixture, 120, 0.4 );
	const pelvisBeforeChargeY = chameleon.rig.pelvis.position.y;
	chameleon.setJumpPose( {
		preloadCompression: 1,
		forwardLean: 0.4,
		muscleCompliance: 0.04,
	} );
	runFrames( fixture, 120, 0.2 );
	assert.ok( chameleon.rig.pelvis.position.y < pelvisBeforeChargeY - 0.025,
		`charged crouch did not lower the pelvis (${ chameleon.rig.pelvis.position.y } / before ${ pelvisBeforeChargeY })` );

	chameleon.setJumpPose( {
		takeoffExtension: 0.8,
		airborneTuck: 0.58,
		forwardLean: 0.25,
		muscleCompliance: 0.48,
	} );
	chameleon.setCommand( { release: true } );
	runFrames( fixture, 120, 0.08 );
	assert.ok( Number.isFinite( chameleon.rig.pelvis.position.y ) );
	for ( const bone of [ chameleon.rig.pelvis, chameleon.rig.spine01,
		chameleon.rig.spine02, ...chameleon.rig.legs.flatMap( ( leg ) => [
			leg.girdle, leg.upper, leg.lower, leg.palm,
		] ) ] ) assert.ok(
		bone.quaternion.toArray().every( Number.isFinite ),
		`${ bone.name } received a non-finite airborne pose`,
	);
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-023 forward locomotion transfers claws from ground to an obstacle and climbs it', async () => {

	const fixture = await createGroundedHybrid();
	const { RAPIER, world } = fixture.physics;
	const obstacleBody = world.createRigidBody(
		RAPIER.RigidBodyDesc.fixed().setTranslation( -1.9, 0.55, 0.75 ),
	);
	const obstacleCollider = world.createCollider(
		RAPIER.ColliderDesc.cuboid( 1, 0.55, 1 )
			.setFriction( 0.98 )
			.setCollisionGroups( ( 0x0001 << 16 ) | 0xffff ),
		obstacleBody,
	);
	fixture.physics.surfaceByCollider.set( obstacleCollider.handle, Object.freeze( {
		kind: 'climb-step',
		clawEligible: true,
		gripStrengthScale: 1,
	} ) );
	const direction = new THREE.Vector3( -1, 0, 0 );
	fixture.chameleon.setCommand( {
		move: direction,
		facing: direction,
		sourceNormal: new THREE.Vector3( 0, 1, 0 ),
	} );
	let maximumHeight = fixture.chameleon.pelvis.body.translation().y;
	let maximumObstacleClaws = 0;
	let maximumObstacleCandidates = 0;
	let maximumWallAlignment = 0;
	runFrames( fixture, 120, 6, () => {

		const position = fixture.chameleon.pelvis.body.translation();
		maximumHeight = Math.max( maximumHeight, position.y );
		maximumObstacleClaws = Math.max(
			maximumObstacleClaws,
			fixture.chameleon.feet.filter(
				( foot ) => foot.collider?.handle === obstacleCollider.handle,
			).length,
		);
		maximumObstacleCandidates = Math.max(
			maximumObstacleCandidates,
			fixture.chameleon.feet.filter(
				( foot ) => foot._candidateCollider?.handle === obstacleCollider.handle,
			).length,
		);
		maximumWallAlignment = Math.max(
			maximumWallAlignment,
			Math.abs( fixture.chameleon.supportNormal.x ),
		);
		assertFiniteHybrid( fixture );

	} );
	const finalPosition = fixture.chameleon.pelvis.body.translation();
	assert.ok( maximumObstacleClaws >= 2,
		`only ${ maximumObstacleClaws } claws transferred to the obstacle; candidates=${ maximumObstacleCandidates }; final=${ finalPosition.x },${ finalPosition.y },${ finalPosition.z }; nominal=${ Array.from( fixture.chameleon.nominalFootPositions ) }` );
	assert.ok( maximumWallAlignment > 0.45,
		`support never rotated onto the obstacle (${ maximumWallAlignment })` );
	assert.ok( maximumHeight > 0.82,
		`pelvis never climbed above ${ maximumHeight } m` );
	assert.ok( finalPosition.x < -0.45,
		`root remained blocked before the obstacle (${ finalPosition.x })` );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-024 released supports cannot cycle a walking gait in flight', async () => {

	const fixture = await createGroundedHybrid();
	runFrames( fixture, 120, 0.4 );
	fixture.chameleon.setJumpPose( {
		takeoffExtension: 0.4,
		airborneTuck: 0.58,
		muscleCompliance: 0.36,
	} );
	fixture.chameleon.setCommand( {
		move: new THREE.Vector3( -1, 0, 0 ),
		facing: new THREE.Vector3( -1, 0, 0 ),
		release: true,
	} );
	runFrames( fixture, 120, 0.08 );
	const target = fixture.chameleon.wholeBodyGait.getView().target;
	for ( let foot = 0; foot < 4; foot ++ ) {

		assert.ok( Math.abs( target[ WHOLE_BODY_POSE.STRIDE_0 + foot ] ) < 1e-7,
			`airborne foot ${ foot } retained a walking stride` );
		assert.ok( Math.abs( target[ WHOLE_BODY_POSE.LIFT_0 + foot ] ) < 1e-7,
			`airborne foot ${ foot } retained a walking lift` );
		assert.ok( Math.abs( target[ WHOLE_BODY_POSE.FLEX_0 + foot ] ) < 1e-7,
			`airborne foot ${ foot } retained a walking flexion` );

	}
	for ( let index = WHOLE_BODY_POSE.PELVIS_YAW;
		index <= WHOLE_BODY_POSE.SUPPORT_SHIFT; index ++ ) assert.ok(
		Math.abs( target[ index ] ) < 1e-9,
		`airborne whole-body lane ${ index } retained terrestrial idle`,
	);
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-025 sub-unit commands preserve proportional physical speed', async () => {

	async function travelledDistance( magnitude ) {

		const fixture = await createGroundedHybrid();
		runFrames( fixture, 120, 0.6 );
		const startX = fixture.chameleon.pelvis.body.translation().x;
		fixture.chameleon.setCommand( {
			move: new THREE.Vector3( -magnitude, 0, 0 ),
			facing: new THREE.Vector3( -1, 0, 0 ),
			sourceNormal: new THREE.Vector3( 0, 1, 0 ),
		} );
		runFrames( fixture, 120, 1.8 );
		const distance = startX - fixture.chameleon.pelvis.body.translation().x;
		assertFiniteHybrid( fixture );
		fixture.dispose();
		return distance;

	}

	const slow = await travelledDistance( 0.3 );
	const full = await travelledDistance( 1 );
	assert.ok( slow > 0.08, `sub-unit command did not move (${ slow })` );
	assert.ok( full > slow * 1.8,
		`physical speed discarded command magnitude (slow=${ slow }, full=${ full })` );

} );

test( 'CHAMELEON-LAB-RAGDOLL-026 held arcade steering produces a stable physical turn arc', async () => {

	const fixture = await createGroundedHybrid();
	const { chameleon, physics } = fixture;
	runFrames( fixture, 120, 0.6 );
	const start = chameleon.pelvis.body.translation();
	const startPosition = new THREE.Vector3( start.x, start.y, start.z );
	const initialForward = chameleon.forward.clone();
	const control = new PlatformerControlModel( {
		moveSpeed: chameleon.settings.moveSpeed,
		sprintMultiplier: chameleon.settings.sprintMultiplier,
	} );
	control.reset( initialForward, chameleon.supportNormal );
	const axes = { x: 1, y: 0 };
	const move = new THREE.Vector3();
	let view = control.view;
	for ( let step = 0; step < 240; step ++ ) {

		if ( step === 54 ) axes.x = 0;
		physics.step( 1 / 120, ( dt ) => {

			view = control.update( dt, {
				axes,
				bodyForward: chameleon.forward,
				supportNormal: chameleon.supportNormal,
				velocity: chameleon.pelvis.body.linvel(),
				supported: chameleon.contactCount >= 1,
			} );
			move.set( view.direction.x, view.direction.y, view.direction.z );
			chameleon.setCommand( {
				move,
				facing: view.facing,
				turning: view.steering,
				sourceNormal: view.supportNormal,
			} );
			chameleon.beforeStep( dt );

		}, () => chameleon.afterStep() );

	}
	const finalForward = chameleon.forward.clone();
	const finalPosition = chameleon.pelvis.body.translation();
	const travel = startPosition.distanceTo(
		new THREE.Vector3( finalPosition.x, finalPosition.y, finalPosition.z ),
	);
	assert.ok( initialForward.dot( finalForward ) < 0.72,
		`held steering barely rotated the physical body (${ initialForward.dot( finalForward ) })` );
	assert.ok( finalForward.dot( new THREE.Vector3(
		view.facing.x, view.facing.y, view.facing.z,
	) ) > 0.94, 'physical body did not settle on its bounded arcade turn target' );
	assert.ok( travel > 0.015 && travel < 0.45,
		`turn should form a short natural arc, not crab or spin in place (${ travel } m)` );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-027 a half-second command produces a responsive physical U-turn', async () => {

	const fixture = await createGroundedHybrid();
	const { chameleon, physics } = fixture;
	runFrames( fixture, 120, 0.6 );
	const start = chameleon.pelvis.body.translation();
	const startPosition = new THREE.Vector3( start.x, start.y, start.z );
	const initialForward = chameleon.forward.clone();
	const control = new PlatformerControlModel( {
		moveSpeed: chameleon.settings.moveSpeed,
		sprintMultiplier: chameleon.settings.sprintMultiplier,
	} );
	control.reset( initialForward, chameleon.supportNormal );
	const axes = { x: 1, y: 0 };
	const move = new THREE.Vector3();
	const tangentVelocity = new THREE.Vector3();
	const surfaceRight = new THREE.Vector3();
	let view = control.view;
	let alignmentAt100Ms = 1;
	let alignmentAt250Ms = 1;
	let alignmentAt500Ms = 1;
	let maximumLateralSpeed = 0;
	let maximumTangentSpeed = 0;
	const forwardAtRelease = new THREE.Vector3();
	for ( let step = 0; step < 120; step ++ ) {

		if ( step === 60 ) axes.x = 0;
		physics.step( 1 / 120, ( dt ) => {

			view = control.update( dt, {
				axes,
				bodyForward: chameleon.forward,
				supportNormal: chameleon.supportNormal,
				velocity: chameleon.pelvis.body.linvel(),
				supported: chameleon.contactCount >= 1,
			} );
			move.set( view.direction.x, view.direction.y, view.direction.z );
			chameleon.setCommand( {
				move,
				facing: view.facing,
				turning: view.steering,
				sourceNormal: view.supportNormal,
			} );
			chameleon.beforeStep( dt );

		}, () => chameleon.afterStep() );
		if ( step < 60 ) {

			const velocity = chameleon.pelvis.body.linvel();
			tangentVelocity.set( velocity.x, velocity.y, velocity.z )
				.projectOnPlane( chameleon.supportNormal );
			surfaceRight.crossVectors( chameleon.forward, chameleon.supportNormal ).normalize();
			maximumLateralSpeed = Math.max(
				maximumLateralSpeed, Math.abs( tangentVelocity.dot( surfaceRight ) ),
			);
			maximumTangentSpeed = Math.max( maximumTangentSpeed, tangentVelocity.length() );

		}
		if ( step === 11 ) alignmentAt100Ms = initialForward.dot( chameleon.forward );
		if ( step === 29 ) alignmentAt250Ms = initialForward.dot( chameleon.forward );
		if ( step === 59 ) alignmentAt500Ms = initialForward.dot( chameleon.forward );
		if ( step === 59 ) forwardAtRelease.copy( chameleon.forward );

	}
	const finalForward = chameleon.forward.clone();
	const finalPosition = chameleon.pelvis.body.translation();
	const travel = startPosition.distanceTo(
		new THREE.Vector3( finalPosition.x, finalPosition.y, finalPosition.z ),
	);
	assert.ok( alignmentAt100Ms < 0.985,
		`body has no immediate steering response at 0.10 s (${ alignmentAt100Ms })` );
	assert.ok( alignmentAt250Ms < 0.45,
		`body turn remains heavy at 0.25 s (${ alignmentAt250Ms })` );
	assert.ok( alignmentAt500Ms < -0.92,
		`body failed to complete the held half-second U-turn (${ alignmentAt500Ms })` );
	assert.ok( maximumLateralSpeed < 0.1,
		`turn crawl became body-local crab motion (${ maximumLateralSpeed } m/s)` );
	assert.ok( maximumLateralSpeed / Math.max( maximumTangentSpeed, 1e-6 ) < 0.42,
		`turn crawl lateral ratio is ${ maximumLateralSpeed / maximumTangentSpeed }` );
	assert.ok( initialForward.dot( finalForward ) < -0.65,
		`half-second steering failed to produce a near U-turn (${ initialForward.dot( finalForward ) })` );
	assert.ok( finalForward.dot( new THREE.Vector3(
		view.facing.x, view.facing.y, view.facing.z,
	) ) > 0.92, 'body failed to settle rapidly on the arcade target' );
	assert.ok( travel > 0.02 && travel < 0.5,
		`responsive turn must remain a compact planted arc (${ travel } m)` );
	assert.ok( chameleon.contactCount >= 2,
		`responsive steering destabilized the claws (${ chameleon.contactCount })` );
	const releaseNormal = chameleon.supportNormal;
	const releaseForward = forwardAtRelease.clone().projectOnPlane( releaseNormal ).normalize();
	const settledForward = finalForward.clone().projectOnPlane( releaseNormal ).normalize();
	const postReleaseOvershoot = Math.acos( THREE.MathUtils.clamp(
		releaseForward.dot( settledForward ), -1, 1,
	) );
	assert.ok( postReleaseOvershoot <= THREE.MathUtils.degToRad( 12 ),
		`released pivot coasted ${ THREE.MathUtils.radToDeg( postReleaseOvershoot ) } degrees `
			+ `(half-second alignment ${ alignmentAt500Ms }, final ${ initialForward.dot( finalForward ) })` );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-029 forward arcade turns remain body-tangent while walking and sprinting', async () => {

	for ( const inclination of [ 0, Math.PI / 10 ] ) for ( const sprint of [ false, true ] ) {

		const fixture = await createGroundedHybrid( { inclination } );
		const { chameleon, physics } = fixture;
		runFrames( fixture, 120, inclination === 0 ? 0.6 : 2 );
		const control = new PlatformerControlModel( {
			moveSpeed: chameleon.settings.moveSpeed,
			sprintMultiplier: chameleon.settings.sprintMultiplier,
		} );
		control.reset( chameleon.forward, chameleon.supportNormal );
		const axes = { x: 1, y: 1 };
		const move = new THREE.Vector3();
		const tangentVelocity = new THREE.Vector3();
		const surfaceRight = new THREE.Vector3();
		let maximumLateralRatio = 0;
		let maximumLateralSpeed = 0;
		let minimumContacts = 4;
		const evaluationFloor = chameleon.settings.moveSpeed
			* ( sprint ? chameleon.settings.sprintMultiplier : 1 ) * 0.2;
		for ( let step = 0; step < 60; step ++ ) {

			physics.step( 1 / 120, ( dt ) => {

				const view = control.update( dt, {
					axes,
					bodyForward: chameleon.forward,
					supportNormal: chameleon.supportNormal,
					velocity: chameleon.pelvis.body.linvel(),
					supported: chameleon.contactCount >= 1,
					sprint,
				} );
				move.set( view.direction.x, view.direction.y, view.direction.z );
				chameleon.setCommand( {
					move,
					facing: view.facing,
					turning: view.steering,
					sourceNormal: view.supportNormal,
					sprint,
				} );
				chameleon.beforeStep( dt );

			}, () => chameleon.afterStep() );
			const velocity = chameleon.pelvis.body.linvel();
			tangentVelocity.set( velocity.x, velocity.y, velocity.z )
				.projectOnPlane( chameleon.supportNormal );
			surfaceRight.crossVectors( chameleon.forward, chameleon.supportNormal ).normalize();
			const lateralSpeed = Math.abs( tangentVelocity.dot( surfaceRight ) );
			const tangentSpeed = tangentVelocity.length();
			maximumLateralSpeed = Math.max( maximumLateralSpeed, lateralSpeed );
			if ( tangentSpeed >= evaluationFloor ) maximumLateralRatio = Math.max(
				maximumLateralRatio, lateralSpeed / tangentSpeed,
			);
			minimumContacts = Math.min( minimumContacts, chameleon.contactCount );

		}
		const label = `${ inclination === 0 ? 'flat' : 'incline' }/${ sprint ? 'sprint' : 'walk' }`;
		assert.ok( maximumLateralRatio < 0.3,
			`${ label } instantaneous lateral ratio is ${ maximumLateralRatio } (${ maximumLateralSpeed } m/s)` );
		assert.ok( minimumContacts >= 2,
			`${ label } steering lost planted support (${ minimumContacts })` );
		assertFiniteHybrid( fixture );
		fixture.dispose();

	}

} );

test( 'CHAMELEON-LAB-RAGDOLL-028 arcade yaw remains responsive and tangent on an incline', async () => {

	const fixture = await createGroundedHybrid( { inclination: Math.PI / 10 } );
	const { chameleon, physics } = fixture;
	runFrames( fixture, 120, 2 );
	assert.ok( chameleon.supportNormal.x < -0.25 && chameleon.supportNormal.y > 0.9,
		`inclined support was not acquired (${ chameleon.supportNormal.toArray() })` );
	const initialForward = chameleon.forward.clone();
	const control = new PlatformerControlModel( {
		moveSpeed: chameleon.settings.moveSpeed,
		sprintMultiplier: chameleon.settings.sprintMultiplier,
	} );
	control.reset( initialForward, chameleon.supportNormal );
	const move = new THREE.Vector3();
	const tangentVelocity = new THREE.Vector3();
	const surfaceRight = new THREE.Vector3();
	const axes = { x: 1, y: 0 };
	let alignmentAt100Ms = 1;
	let alignmentAt250Ms = 1;
	let alignmentAt500Ms = 1;
	let maximumLateralSpeed = 0;
	for ( let step = 0; step < 60; step ++ ) {

		physics.step( 1 / 120, ( dt ) => {

			const view = control.update( dt, {
				axes,
				bodyForward: chameleon.forward,
				supportNormal: chameleon.supportNormal,
				velocity: chameleon.pelvis.body.linvel(),
				supported: chameleon.contactCount >= 1,
			} );
			move.set( view.direction.x, view.direction.y, view.direction.z );
			chameleon.setCommand( {
				move,
				facing: view.facing,
				turning: view.steering,
				sourceNormal: view.supportNormal,
			} );
			chameleon.beforeStep( dt );

		}, () => chameleon.afterStep() );
		const velocity = chameleon.pelvis.body.linvel();
		tangentVelocity.set( velocity.x, velocity.y, velocity.z )
			.projectOnPlane( chameleon.supportNormal );
		surfaceRight.crossVectors( chameleon.forward, chameleon.supportNormal ).normalize();
		maximumLateralSpeed = Math.max(
			maximumLateralSpeed, Math.abs( tangentVelocity.dot( surfaceRight ) ),
		);
		if ( step === 11 ) alignmentAt100Ms = initialForward.dot( chameleon.forward );
		if ( step === 29 ) alignmentAt250Ms = initialForward.dot( chameleon.forward );
		if ( step === 59 ) alignmentAt500Ms = initialForward.dot( chameleon.forward );

	}
	assert.ok( alignmentAt100Ms < 0.985, `incline response at 0.10 s is ${ alignmentAt100Ms }` );
	assert.ok( alignmentAt250Ms < 0.45, `incline response at 0.25 s is ${ alignmentAt250Ms }` );
	assert.ok( alignmentAt500Ms < -0.92, `incline response at 0.50 s is ${ alignmentAt500Ms }` );
	assert.ok( maximumLateralSpeed < 0.11,
		`inclined turn generated ${ maximumLateralSpeed } m/s of lateral slip` );
	assert.ok( chameleon.contactCount >= 2,
		`inclined turn lost its planted support (${ chameleon.contactCount })` );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-030 a small branch settles after travel without perpetual rocking', async () => {

	const fixture = await createBranchHybrid( { radius: 0.18 } );
	const { chameleon, branchCollider } = fixture;
	runFrames( fixture, 120, 1.2 );
	const direction = new THREE.Vector3( -1, 0, 0 );
	chameleon.setCommand( {
		move: direction,
		facing: direction,
		sourceNormal: new THREE.Vector3( 0, 1, 0 ),
	} );
	runFrames( fixture, 120, 1.6 );
	chameleon.setCommand( {
		move: new THREE.Vector3(),
		facing: direction,
		sourceNormal: chameleon.supportNormal,
	} );
	let reference = null;
	let maximumDrift = 0;
	let maximumLinearSpeed = 0;
	let maximumAngularSpeed = 0;
	let minimumContacts = 4;
	runFrames( fixture, 120, 6, ( _dt, step ) => {

		const position = chameleon.pelvis.body.translation();
		if ( step === 360 ) reference = new THREE.Vector3( position.x, position.y, position.z );
		if ( step >= 360 ) {

			maximumDrift = Math.max(
				maximumDrift,
				reference.distanceTo( new THREE.Vector3( position.x, position.y, position.z ) ),
			);
			maximumLinearSpeed = Math.max(
				maximumLinearSpeed, vectorMagnitude( chameleon.pelvis.body.linvel() ),
			);
			maximumAngularSpeed = Math.max(
				maximumAngularSpeed, vectorMagnitude( chameleon.pelvis.body.angvel() ),
			);

		}
		minimumContacts = Math.min( minimumContacts, chameleon.contactCount );

	} );
	assert.ok( chameleon.feet.filter(
		( foot ) => foot.collider?.handle === branchCollider.handle,
	).length >= 2, 'small branch did not retain a two-claw grip' );
	assert.ok( minimumContacts >= 2,
		'small branch lost its support polygon (' + minimumContacts + ')' );
	assert.equal( chameleon.staticGripLocked, true,
		'small branch never entered a static physical grip' );
	assert.equal( chameleon.pelvis.body.isSleeping(), true,
		'small branch body kept solving instead of sleeping in its grip' );
	assert.ok( maximumDrift < 0.012,
		'small branch kept rocking by ' + maximumDrift + ' m after settlement' );
	assert.ok( maximumLinearSpeed < 0.035 && maximumAngularSpeed < 0.08,
		'small branch remained restless (linear=' + maximumLinearSpeed
			+ ', angular=' + maximumAngularSpeed + ')' );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-031 holding forward traverses wall, crown and opposite face', async () => {

	const fixture = await createGroundedHybrid();
	const { RAPIER, world } = fixture.physics;
	const wallBody = world.createRigidBody(
		RAPIER.RigidBodyDesc.fixed().setTranslation( -1.65, 0.8, 0.75 ),
	);
	const wallCollider = world.createCollider(
		RAPIER.ColliderDesc.cuboid( 0.25, 0.8, 2 )
			.setFriction( 1.05 )
			.setCollisionGroups( ( 0x0001 << 16 ) | 0xffff ),
		wallBody,
	);
	fixture.physics.surfaceByCollider.set( wallCollider.handle, Object.freeze( {
		kind: 'bark-wall',
		clawEligible: true,
		gripStrengthScale: 1.2,
	} ) );
	const forward = new THREE.Vector3( -1, 0, 0 );
	fixture.chameleon.setCommand( {
		move: forward,
		facing: forward,
		sourceNormal: new THREE.Vector3( 0, 1, 0 ),
	} );
	let frontAlignment = -Infinity;
	let crownAlignment = -Infinity;
	let oppositeAlignment = Infinity;
	let maximumHeight = -Infinity;
	let farthestX = Infinity;
	let minimumContacts = 4;
	let minimumHighSupportY = Infinity;
	let undersideFootContacts = 0;
	let maximumFixedStepDisplacement = 0;
	let maximumSupportAngle = 0;
	let minimumContactState = '';
	const previousPosition = new THREE.Vector3();
	const previousNormal = fixture.chameleon.supportNormal.clone();
	{

		const position = fixture.chameleon.pelvis.body.translation();
		previousPosition.set( position.x, position.y, position.z );

	}
	const checkpoints = [];
	runFrames( fixture, 120, 11, ( _dt, step ) => {

		const normal = fixture.chameleon.supportNormal;
		const position = fixture.chameleon.pelvis.body.translation();
		const currentPosition = new THREE.Vector3( position.x, position.y, position.z );
		maximumFixedStepDisplacement = Math.max(
			maximumFixedStepDisplacement, previousPosition.distanceTo( currentPosition ),
		);
		previousPosition.copy( currentPosition );
		if ( fixture.chameleon.contactCount >= 2 ) maximumSupportAngle = Math.max(
			maximumSupportAngle,
			Math.acos( THREE.MathUtils.clamp( previousNormal.dot( normal ), -1, 1 ) ),
		);
		previousNormal.copy( normal );
		if ( step % 120 === 0 ) checkpoints.push(
			step / 120 + 's p=' + position.x.toFixed( 2 ) + ',' + position.y.toFixed( 2 )
			+ ' n=' + normal.x.toFixed( 2 ) + ',' + normal.y.toFixed( 2 )
			+ ' c=' + fixture.chameleon.contactCount,
		);
		if ( position.x > -1.5 && position.y > 0.3 )
			frontAlignment = Math.max( frontAlignment, normal.x );
		if ( position.y > 1.55 ) {

			crownAlignment = Math.max( crownAlignment, normal.y );
			minimumHighSupportY = Math.min( minimumHighSupportY, normal.y );
			for ( const foot of fixture.chameleon.feet )
				if ( foot.collider?.handle === wallCollider.handle && foot.normal.y < -0.5 )
					undersideFootContacts ++;

		}
		if ( position.x < -1.9 ) oppositeAlignment = Math.min( oppositeAlignment, normal.x );
		maximumHeight = Math.max( maximumHeight, position.y );
		farthestX = Math.min( farthestX, position.x );
		minimumContacts = Math.min( minimumContacts, fixture.chameleon.contactCount );
		if ( fixture.chameleon.contactCount === minimumContacts && minimumContacts < 2 )
			minimumContactState = 'step=' + step + ' '
				+ fixture.chameleon.feet.map( ( foot ) =>
					foot.state + ':' + ( foot.collider?.handle ?? '-' ),
				).join( ',' );

	} );
	assert.ok( frontAlignment > 0.62,
		'forward input never established the near wall face (' + frontAlignment + ')' );
	assert.ok( crownAlignment > 0.72 && maximumHeight > 1.55,
		'forward input did not wrap onto the crown (' + crownAlignment
			+ ', y=' + maximumHeight + '; ' + checkpoints.join( '; ' ) + ')' );
	assert.ok( oppositeAlignment < -0.5,
		'forward input never wrapped onto the opposite face (' + oppositeAlignment
			+ '; ' + checkpoints.join( '; ' ) + ')' );
	assert.ok( minimumHighSupportY > -0.2,
		'the crown traversal attached to the underside (' + minimumHighSupportY + ')' );
	assert.equal( undersideFootContacts, 0,
		'the crown traversal accepted an underside claw contact' );
	assert.ok( farthestX < -2.05,
		'the body did not continue beyond the far edge (' + farthestX
			+ '; ' + checkpoints.join( '; ' ) + ')' );
	assert.ok( minimumContacts >= 2,
		'the traversal lost its two-claw support polygon (' + minimumContacts
			+ '; ' + minimumContactState + '; ' + checkpoints.join( '; ' ) + ')' );
	assert.ok( maximumFixedStepDisplacement < 0.035,
		'the edge handoff teleported the body by ' + maximumFixedStepDisplacement + ' m' );
	assert.ok( maximumSupportAngle < 0.55,
		'the support frame snapped by ' + THREE.MathUtils.radToDeg( maximumSupportAngle )
			+ ' degrees in one fixed step' );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-032 a branch registered after creation gets the same radial static grip', async () => {

	const fixture = await createBranchHybrid( {
		radius: 0.18,
		registerAfterCreation: true,
	} );
	const direction = new THREE.Vector3( -1, 0, 0 );
	runFrames( fixture, 120, 1.2 );
	fixture.chameleon.setCommand( {
		move: direction,
		facing: direction,
		sourceNormal: new THREE.Vector3( 0, 1, 0 ),
	} );
	runFrames( fixture, 120, 1.4 );
	fixture.chameleon.setCommand( {
		move: new THREE.Vector3(),
		facing: direction,
		sourceNormal: fixture.chameleon.supportNormal,
	} );
	runFrames( fixture, 120, 6 );
	assert.ok( fixture.chameleon.contactCount >= 2 );
	assert.ok( fixture.chameleon.supportNormal.y > 0.88,
		'late branch metadata did not activate the radial frame' );
	assert.equal( fixture.chameleon.staticGripLocked, true );
	assert.equal( fixture.chameleon.pelvis.body.isSleeping(), true );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-033 invalid branch metadata fails safe without poisoning physics', async () => {

	const fixture = await createBranchHybrid( {
		radius: 0.18,
		branchAxis: [ NaN, Infinity, 0 ],
		gripStrengthScale: NaN,
	} );
	const direction = new THREE.Vector3( -1, 0, 0 );
	runFrames( fixture, 120, 1.2 );
	fixture.chameleon.setCommand( {
		move: direction,
		facing: direction,
		sourceNormal: new THREE.Vector3( 0, 1, 0 ),
	} );
	runFrames( fixture, 120, 1.4 );
	fixture.chameleon.setCommand( {
		move: new THREE.Vector3(),
		facing: direction,
		sourceNormal: fixture.chameleon.supportNormal,
	} );
	runFrames( fixture, 120, 6 );
	assert.ok( fixture.chameleon.contactCount >= 2,
		'invalid metadata destroyed the two-claw support polygon' );
	assert.ok( fixture.chameleon.supportNormal.y > 0.88,
		'invalid branch axis prevented the collider-derived radial frame' );
	assert.ok( Math.abs( fixture.chameleon.supportNormal.length() - 1 ) < 1e-6,
		'invalid metadata produced a non-unit support normal' );
	assert.equal( fixture.chameleon.staticGripLocked, true,
		'invalid grip scale prevented the fail-safe static grip' );
	assert.equal( fixture.chameleon.pelvis.body.isSleeping(), true,
		'invalid metadata kept the physical body awake' );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );

test( 'CHAMELEON-LAB-RAGDOLL-034 branch flank hands support to its physical end cap', async () => {

	const fixture = await createBranchHybrid( {
		radius: 0.3,
		halfHeight: 0.5,
		spawn: new THREE.Vector3( 0, 0.6, 0 ),
	} );
	const { chameleon, branchCollider } = fixture;
	runFrames( fixture, 120, 1.5 );
	const direction = new THREE.Vector3( -1, 0, 0 );
	chameleon.setCommand( {
		move: direction,
		facing: direction,
		sourceNormal: new THREE.Vector3( 0, 1, 0 ),
	} );
	let maximumEndCapFeet = 0;
	let maximumEndCapSupportAlignment = -Infinity;
	let farthestX = Infinity;
	let minimumTransitionContacts = 4;
	let firstLowSupport = null;
	let endCapEstablished = false;
	let maximumTransitionStepDisplacement = 0;
	const initial = chameleon.pelvis.body.translation();
	const previousPosition = new THREE.Vector3( initial.x, initial.y, initial.z );
	runFrames( fixture, 120, 5, () => {

		const position = chameleon.pelvis.body.translation();
		const currentPosition = new THREE.Vector3( position.x, position.y, position.z );
		const fixedStepDisplacement = previousPosition.distanceTo( currentPosition );
		previousPosition.copy( currentPosition );
		const endCapFeet = chameleon.feet.filter(
			foot => foot.collider?.handle === branchCollider.handle && foot.normal.x < -0.72,
		).length;
		if ( ! endCapEstablished ) {

			maximumTransitionStepDisplacement = Math.max(
				maximumTransitionStepDisplacement, fixedStepDisplacement,
			);
			minimumTransitionContacts = Math.min(
				minimumTransitionContacts, chameleon.contactCount,
			);
			if ( chameleon.contactCount < 2 && ! firstLowSupport )
				firstLowSupport = {
					x: position.x,
					y: position.y,
					contacts: chameleon.contactCount,
					support: chameleon.supportNormal.toArray(),
				};

		}
		maximumEndCapFeet = Math.max( maximumEndCapFeet, endCapFeet );
		if ( endCapFeet >= 2 ) endCapEstablished = true;
		if ( endCapFeet >= 2 ) maximumEndCapSupportAlignment = Math.max(
			maximumEndCapSupportAlignment, -chameleon.supportNormal.x,
		);
		farthestX = Math.min( farthestX, position.x );

	} );
	assert.ok( maximumEndCapFeet >= 2,
		'the front pair never established end-cap contacts' );
	assert.ok( maximumEndCapSupportAlignment > 0.65,
		'end-cap contacts did not rotate the support frame ('
			+ maximumEndCapSupportAlignment + ')' );
	assert.ok( farthestX < -0.52,
		'the body stalled before wrapping beyond the cylinder cap (' + farthestX + ')' );
	assert.ok( minimumTransitionContacts >= 2,
		'the side-to-cap handoff lost its support polygon ('
			+ minimumTransitionContacts + '; ' + JSON.stringify( firstLowSupport ) + ')' );
	assert.ok( maximumTransitionStepDisplacement < 0.025,
		'the side-to-cap handoff teleported the body by '
			+ maximumTransitionStepDisplacement + ' m' );
	assertFiniteHybrid( fixture );
	fixture.dispose();

} );
