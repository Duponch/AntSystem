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
	// The first four nodes belong to the rigid sacral bridge inside the body
	// envelope. Ground projection starts at the first genuinely passive sample.
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
