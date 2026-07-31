import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
	anatomicalSwingLimit,
	chameleonCollisionGroups,
	idleHoldControllerGains,
	isExternalGripRayHit,
	muscleControllerGains,
	tailJointPolicy,
} from './active-ragdoll-model.js';

const CHAMELEON_GROUP = chameleonCollisionGroups();
const WORLD_UP = new THREE.Vector3( 0, 1, 0 );
const BODY_SCALE = new THREE.Vector3( 1, 1, 1 );
const ZERO = new THREE.Vector3();

const CENTRAL_CHAIN = [
	'pelvis',
	'spine_01',
	'spine_02',
	'neck',
	'head',
];

const LIMB_PREFIXES = [
	'front_girdleL',
	'front_girdleR',
	'hind_girdleL',
	'hind_girdleR',
];

const LIMB_CHAINS = [
	[ 'front_girdleL', 'front_upperL', 'front_lowerL', 'front_palmL' ],
	[ 'front_girdleR', 'front_upperR', 'front_lowerR', 'front_palmR' ],
	[ 'hind_girdleL', 'hind_upperL', 'hind_lowerL', 'hind_palmL' ],
	[ 'hind_girdleR', 'hind_upperR', 'hind_lowerR', 'hind_palmR' ],
];

const FOOT_NAMES = [
	'front_palmL',
	'hind_palmR',
	'front_palmR',
	'hind_palmL',
];

const TAIL_CHAIN = Array.from( { length: 12 }, ( _, index ) => `tail_${ String( index + 1 ).padStart( 2, '0' ) }` );
const PHYSICAL_BONES = [
	...CENTRAL_CHAIN,
	...LIMB_CHAINS.flat(),
	...TAIL_CHAIN,
];

const PROBE_DIRECTIONS = [
	new THREE.Vector3( 0, -1, 0 ),
	new THREE.Vector3( 0, 1, 0 ),
	new THREE.Vector3( 1, 0, 0 ),
	new THREE.Vector3( -1, 0, 0 ),
	new THREE.Vector3( 0, 0, 1 ),
	new THREE.Vector3( 0, 0, -1 ),
	new THREE.Vector3( 1, -1, 0 ).normalize(),
	new THREE.Vector3( -1, -1, 0 ).normalize(),
	new THREE.Vector3( 0, -1, 1 ).normalize(),
	new THREE.Vector3( 0, -1, -1 ).normalize(),
];

function vectorRecord( vector ) {

	return { x: vector.x, y: vector.y, z: vector.z };

}

function quaternionRecord( quaternion ) {

	return {
		x: quaternion.x,
		y: quaternion.y,
		z: quaternion.z,
		w: quaternion.w,
	};

}

function fromRapierVector( value, target = new THREE.Vector3() ) {

	return target.set( value.x, value.y, value.z );

}

function fromRapierQuaternion( value, target = new THREE.Quaternion() ) {

	return target.set( value.x, value.y, value.z, value.w );

}

function clampVectorLength( vector, maximum ) {

	const lengthSq = vector.lengthSq();
	if ( lengthSq > maximum * maximum ) vector.multiplyScalar( maximum / Math.sqrt( lengthSq ) );
	return vector;

}

function segmentRadius( name, length ) {

	if ( name === 'pelvis' || name.startsWith( 'spine_' ) ) return Math.min( 0.09, length * 0.36 );
	if ( name === 'neck' ) return Math.min( 0.064, length * 0.34 );
	if ( name === 'head' ) return Math.min( 0.095, length * 0.48 );
	if ( name.startsWith( 'tail_' ) ) {

		const index = Number.parseInt( name.slice( 5 ), 10 ) - 1;
		return THREE.MathUtils.lerp( 0.072, 0.016, index / 11 );

	}
	if ( name.includes( 'palm' ) ) return Math.min( 0.032, length * 0.32 );
	if ( name.includes( 'girdle' ) ) return Math.min( 0.043, length * 0.34 );
	return Math.min( 0.038, length * 0.31 );

}

function segmentMass( name ) {

	if ( name === 'pelvis' ) return 0.16;
	if ( name === 'spine_01' || name === 'spine_02' ) return 0.15;
	if ( name === 'neck' ) return 0.08;
	if ( name === 'head' ) return 0.14;
	if ( name.startsWith( 'tail_' ) ) {

		const index = Number.parseInt( name.slice( 5 ), 10 ) - 1;
		return THREE.MathUtils.lerp( 0.032, 0.006, index / 11 );

	}
	if ( name.includes( 'palm' ) ) return 0.018;
	if ( name.includes( 'girdle' ) ) return 0.035;
	return 0.028;

}

function motorProfile( name ) {

	if ( name === 'pelvis' ) return { stiffness: 22, damping: 3.8, torque: 10 };
	if ( name.startsWith( 'spine_' ) || name === 'neck' ) return { stiffness: 17, damping: 3, torque: 7 };
	if ( name === 'head' ) return { stiffness: 12, damping: 2.3, torque: 4.5 };
	if ( name.startsWith( 'tail_' ) ) return { stiffness: 5.2, damping: 1.15, torque: 1.8 };
	if ( name.includes( 'palm' ) ) return { stiffness: 9, damping: 1.65, torque: 2.7 };
	return { stiffness: 12, damping: 2.1, torque: 3.8 };

}

function primaryChildName( boneName ) {

	const centralIndex = CENTRAL_CHAIN.indexOf( boneName );
	if ( centralIndex >= 0 && centralIndex < CENTRAL_CHAIN.length - 1 ) return CENTRAL_CHAIN[ centralIndex + 1 ];
	for ( const chain of LIMB_CHAINS ) {

		const index = chain.indexOf( boneName );
		if ( index >= 0 && index < chain.length - 1 ) return chain[ index + 1 ];
		if ( index === chain.length - 1 ) return boneName.replace( '_palm', '_digits_inner' );

	}
	const tailIndex = TAIL_CHAIN.indexOf( boneName );
	if ( tailIndex >= 0 && tailIndex < TAIL_CHAIN.length - 1 ) return TAIL_CHAIN[ tailIndex + 1 ];
	return null;

}

function nearestPhysicalAncestor( bone, partByBone ) {

	let parent = bone.parent;
	while ( parent ) {

		if ( partByBone.has( parent.name ) ) return partByBone.get( parent.name );
		parent = parent.parent;

	}
	return null;

}

function localPoint( worldPoint, position, quaternion, target = new THREE.Vector3() ) {

	return target.copy( worldPoint )
		.sub( position )
		.applyQuaternion( quaternion.clone().invert() );

}

function worldPoint( local, body, target = new THREE.Vector3() ) {

	return target.copy( local )
		.applyQuaternion( fromRapierQuaternion( body.rotation(), new THREE.Quaternion() ) )
		.add( fromRapierVector( body.translation(), new THREE.Vector3() ) );

}

function pointVelocity( body, point, target = new THREE.Vector3() ) {

	const center = fromRapierVector( body.translation(), new THREE.Vector3() );
	const angular = fromRapierVector( body.angvel(), new THREE.Vector3() );
	const linear = fromRapierVector( body.linvel(), target );
	return linear.add( angular.cross( point.clone().sub( center ) ) );

}

function scalarRotationalInertia( body, length = 0.1 ) {

	const principal = body.principalInertia();
	return Math.max(
		( principal.x + principal.y + principal.z ) / 3,
		body.mass() * length * length * 0.02,
		1e-7,
	);

}

function quaternionErrorTorque( {
	parent,
	child,
	targetRelative,
	stiffness,
	damping,
	maximum,
	targetAngularVelocity = ZERO,
} ) {

	const parentRotation = fromRapierQuaternion( parent.rotation(), new THREE.Quaternion() );
	const childRotation = fromRapierQuaternion( child.rotation(), new THREE.Quaternion() );
	const desiredWorld = parentRotation.clone().multiply( targetRelative ).normalize();
	const error = desiredWorld.multiply( childRotation.clone().invert() ).normalize();
	if ( error.w < 0 ) error.set( -error.x, -error.y, -error.z, -error.w );
	const angle = 2 * Math.acos( THREE.MathUtils.clamp( error.w, -1, 1 ) );
	const sinHalf = Math.sqrt( Math.max( 1e-9, 1 - error.w * error.w ) );
	const axis = new THREE.Vector3( error.x / sinHalf, error.y / sinHalf, error.z / sinHalf );
	const relativeAngularVelocity = fromRapierVector( child.angvel(), new THREE.Vector3() )
		.sub( fromRapierVector( parent.angvel(), new THREE.Vector3() ) )
		.sub( targetAngularVelocity );
	const torque = axis.multiplyScalar( angle * stiffness )
		.addScaledVector( relativeAngularVelocity, -damping );
	return clampVectorLength( torque, maximum );

}

function applyDirectionalMotor( {
	parent,
	child,
	startLocal,
	tipLocal,
	length,
	targetRelative,
	stiffness,
	damping,
	maximum,
} ) {

	const parentRotation = fromRapierQuaternion( parent.rotation(), new THREE.Quaternion() );
	const desiredRotation = parentRotation.multiply( targetRelative );
	const desiredDirection = new THREE.Vector3( 0, 1, 0 ).applyQuaternion( desiredRotation ).normalize();
	const start = worldPoint( startLocal, child );
	const tip = worldPoint( tipLocal, child );
	const desiredTip = start.clone().addScaledVector( desiredDirection, length );
	const relativeVelocity = pointVelocity( child, tip )
		.sub( pointVelocity( parent, start ) );
	const force = desiredTip.sub( tip ).multiplyScalar( stiffness )
		.addScaledVector( relativeVelocity, - damping );
	clampVectorLength( force, maximum );
	child.addForceAtPoint( vectorRecord( force ), vectorRecord( tip ), true );
	child.addForceAtPoint( vectorRecord( force.clone().multiplyScalar( -1 ) ), vectorRecord( start ), true );

}

function buildSegmentDefinition( bone, boneByName, spawn ) {

	const start = bone.getWorldPosition( new THREE.Vector3() ).add( spawn );
	const childName = primaryChildName( bone.name );
	const child = childName ? boneByName.get( childName ) : null;
	let end;

	if ( child ) {

		end = child.getWorldPosition( new THREE.Vector3() ).add( spawn );

	} else if ( bone.name === 'head' ) {

		const neck = boneByName.get( 'neck' );
		const direction = start.clone().sub( neck.getWorldPosition( new THREE.Vector3() ).add( spawn ) ).normalize();
		end = start.clone().addScaledVector( direction, 0.14 );

	} else {

		const parentStart = bone.parent.getWorldPosition( new THREE.Vector3() ).add( spawn );
		end = start.clone().add( start.clone().sub( parentStart ).normalize().multiplyScalar( 0.07 ) );

	}

	const direction = end.clone().sub( start );
	const length = Math.max( 0.025, direction.length() );
	const center = start.clone().add( end ).multiplyScalar( 0.5 );
	const quaternion = new THREE.Quaternion().setFromUnitVectors(
		new THREE.Vector3( 0, 1, 0 ),
		direction.normalize(),
	);
	const radius = segmentRadius( bone.name, length );
	return {
		start,
		end,
		center,
		quaternion,
		length,
		radius,
		halfHeight: Math.max( 0.003, length * 0.5 - radius ),
	};

}

function createDebugCapsule( definition, name ) {

	const geometry = new THREE.CapsuleGeometry(
		definition.radius,
		definition.halfHeight * 2,
		4,
		8,
	);
	const material = new THREE.MeshBasicMaterial( {
		color: name.includes( 'palm' ) ? 0xffd166 : name.startsWith( 'tail_' ) ? 0x79c7ff : 0xff5e78,
		wireframe: true,
		transparent: true,
		opacity: 0.5,
		depthTest: false,
	} );
	const mesh = new THREE.Mesh( geometry, material );
	mesh.renderOrder = 20;
	mesh.name = `Proxy_${ name }`;
	return mesh;

}

export async function createActiveRagdoll( {
	scene,
	physics,
	spawn = new THREE.Vector3( 0, 0.95, 0.75 ),
	assetUrl = '/assets/ChameleonPhysical.glb',
	assetScene = null,
} ) {

	const model = assetScene || ( await new GLTFLoader().loadAsync( assetUrl ) ).scene;
	model.name = 'PhysicalChameleon';
	model.updateMatrixWorld( true );
	model.traverse( ( object ) => {

		if ( object.isMesh ) {

			object.castShadow = true;
			object.receiveShadow = true;
			object.frustumCulled = false;

		}

	} );
	scene.add( model );

	const boneByName = new Map();
	model.traverse( ( object ) => {

		if ( object.isBone ) boneByName.set( object.name, object );

	} );
	for ( const name of PHYSICAL_BONES ) {

		if ( ! boneByName.has( name ) ) throw new Error( `Physical chameleon is missing bone "${ name }".` );

	}

	const { RAPIER, world } = physics;
	const parts = [];
	const partByBone = new Map();
	const debugGroup = new THREE.Group();
	debugGroup.name = 'ChameleonPhysicsDebug';
	debugGroup.visible = false;
	scene.add( debugGroup );

	model.updateMatrixWorld( true );
	for ( const name of PHYSICAL_BONES ) {

		const bone = boneByName.get( name );
		const definition = buildSegmentDefinition( bone, boneByName, spawn );
		const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
			.setTranslation( definition.center.x, definition.center.y, definition.center.z )
			.setRotation( quaternionRecord( definition.quaternion ) )
			.setLinearDamping( 0.28 )
			.setAngularDamping( name.startsWith( 'tail_' ) ? 1.2 : 0.82 )
			.setCanSleep( false );
		const body = world.createRigidBody( bodyDesc );
		body.userData = { kind: 'chameleon-proxy', boneName: name };
		if ( name === 'pelvis' ) body.setAdditionalSolverIterations( 5 );
		const collider = world.createCollider(
			RAPIER.ColliderDesc.capsule( definition.halfHeight, definition.radius )
				.setMass( segmentMass( name ) )
				.setFriction( name.includes( 'palm' ) ? 0.75 : 0.42 )
				.setRestitution( 0.01 )
				.setCollisionGroups( CHAMELEON_GROUP ),
			body,
		);
		collider.userData = body.userData;
		physics.registerBody?.( body );

		const boneRestWorld = bone.matrixWorld.clone();
		boneRestWorld.setPosition( bone.getWorldPosition( new THREE.Vector3() ).add( spawn ) );
		const bodyRestWorld = new THREE.Matrix4().compose( definition.center, definition.quaternion, BODY_SCALE );
		const bodyToBone = bodyRestWorld.clone().invert().multiply( boneRestWorld );
		const tipLocal = localPoint( definition.end, definition.center, definition.quaternion );
		const startLocal = localPoint( definition.start, definition.center, definition.quaternion );
		const debugMesh = createDebugCapsule( definition, name );
		debugGroup.add( debugMesh );
		const part = {
			name,
			bone,
			body,
			collider,
			definition,
			bodyToBone,
			tipLocal,
			startLocal,
			debugMesh,
			parent: null,
			joint: null,
			restRelative: new THREE.Quaternion(),
			motor: motorProfile( name ),
			prevPosition: definition.center.clone(),
			position: definition.center.clone(),
			prevQuaternion: definition.quaternion.clone(),
			quaternion: definition.quaternion.clone(),
		};
		parts.push( part );
		partByBone.set( name, part );

	}

	const joints = [];
	for ( const part of parts ) {

		const parent = nearestPhysicalAncestor( part.bone, partByBone );
		if ( ! parent ) continue;
		part.parent = parent;
		const jointWorld = part.definition.start;
		part.parentAnchor = localPoint(
			jointWorld,
			parent.definition.center,
			parent.definition.quaternion,
		);
		part.childAnchor = localPoint(
			jointWorld,
			part.definition.center,
			part.definition.quaternion,
		);
		const tailIndex = part.name.startsWith( 'tail_' )
			? Number.parseInt( part.name.slice( 5 ), 10 )
			: 0;
		const tailPolicy = tailIndex > 0 ? tailJointPolicy( tailIndex ) : null;
		part.tailHinge = tailPolicy?.kind === 'hinge';
		part.tailFixed = tailPolicy?.kind === 'fixed';
		part.tailAxis = tailPolicy
			? new THREE.Vector3( tailPolicy.axis.x, tailPolicy.axis.y, tailPolicy.axis.z )
			: ZERO;
		part.tailLimit = tailPolicy?.limit ?? 0;
		part.fixedFrame2 = part.definition.quaternion.clone()
			.invert()
			.multiply( parent.definition.quaternion )
			.normalize();
		part.restRelative.copy( parent.definition.quaternion ).invert().multiply( part.definition.quaternion ).normalize();

	}

	function rebuildJoints() {

		for ( const joint of joints ) if ( joint.isValid() ) world.removeImpulseJoint( joint, false );
		joints.length = 0;
		for ( const part of parts ) {

			if ( ! part.parent ) continue;
			const jointData = part.tailFixed
				? RAPIER.JointData.fixed(
					vectorRecord( part.parentAnchor ),
					{ x: 0, y: 0, z: 0, w: 1 },
					vectorRecord( part.childAnchor ),
					quaternionRecord( part.fixedFrame2 ),
				)
				: part.tailHinge
					? RAPIER.JointData.revolute(
						vectorRecord( part.parentAnchor ),
						vectorRecord( part.childAnchor ),
						vectorRecord( part.tailAxis ),
					)
					: RAPIER.JointData.spherical(
						vectorRecord( part.parentAnchor ),
						vectorRecord( part.childAnchor ),
					);
			part.joint = world.createImpulseJoint( jointData, part.parent.body, part.body, true );
			if ( part.tailHinge ) part.joint.setLimits( -part.tailLimit, part.tailLimit );
			part.joint.setContactsEnabled( false );
			joints.push( part.joint );

		}

	}

	rebuildJoints();

	const feet = FOOT_NAMES.map( ( name, order ) => ( {
		order,
		part: partByBone.get( name ),
		anchor: null,
		normal: new THREE.Vector3( 0, 1, 0 ),
		surface: null,
		collider: null,
		lastProbeStep: -100,
		load: 0,
		overloadSeconds: 0,
		state: 'reaching',
	} ) );
	const tailGrip = {
		part: partByBone.get( 'tail_12' ),
		anchor: null,
		normal: new THREE.Vector3( 0, 1, 0 ),
		surface: null,
		collider: null,
		lastProbeStep: -100,
		load: 0,
		overloadSeconds: 0,
		state: 'reaching',
		tail: true,
	};

	const pelvis = partByBone.get( 'pelvis' );
	const pelvisRestUpLocal = WORLD_UP.clone().applyQuaternion( pelvis.definition.quaternion.clone().invert() );
	const tempMatrix = new THREE.Matrix4();
	const tempBodyMatrix = new THREE.Matrix4();
	const tempParentInverse = new THREE.Matrix4();
	const renderPosition = new THREE.Vector3();
	const renderQuaternion = new THREE.Quaternion();
	const renderScale = new THREE.Vector3();
	const contacts = [ ...feet, tailGrip ];
	const totalMass = parts.reduce( ( sum, part ) => sum + part.body.mass(), 0 );

	const settings = {
		motorStrength: 1,
		motorDamping: 1,
		moveSpeed: 1.25,
		sprintMultiplier: 1.75,
		moveForce: 13,
		turnTorque: 0.55,
		gripEnabled: true,
		gripStrength: 28,
		gripStiffness: 175,
		gripDamping: 8,
		gripReach: 0.23,
		gaitFrequency: 1.55,
		animationSpeed: 1,
		tailGrip: true,
	};
	const command = {
		move: new THREE.Vector3(),
		sprint: false,
		release: false,
		fullRagdoll: false,
	};
	let elapsed = 0;
	let substepIndex = 0;
	let dragging = false;
	let averageSupportNormal = new THREE.Vector3( 0, 1, 0 );
	let groundedContacts = 0;
	let idleAnchor = null;
	let idleHoldCooldown = 0;

	function probeContact( contact, force = false ) {

		if ( ! settings.gripEnabled ) return false;
		if ( contact.tail && ! settings.tailGrip ) return false;
		if ( ! force && substepIndex - contact.lastProbeStep < ( contact.anchor ? 5 : 2 ) ) return contact.anchor !== null;
		contact.lastProbeStep = substepIndex;
		const tip = worldPoint( contact.part.tipLocal, contact.part.body );
		let best = null;
		const bodyRotation = fromRapierQuaternion( contact.part.body.rotation(), new THREE.Quaternion() );
		const localDown = new THREE.Vector3( 0, -1, 0 ).applyQuaternion( bodyRotation );
		const directions = [ localDown, ...PROBE_DIRECTIONS ];

		for ( const directionSource of directions ) {

			const direction = directionSource.clone().normalize();
			const origin = tip.clone().addScaledVector( direction, -0.035 );
			const ray = new RAPIER.Ray( vectorRecord( origin ), vectorRecord( direction ) );
			const hit = world.castRayAndGetNormal(
				ray,
				settings.gripReach + 0.035,
				false,
				undefined,
				undefined,
				undefined,
				contact.part.body,
				( collider ) => physics.surfaceByCollider?.has( collider.handle ) === true,
			);
			if ( ! hit
				|| ! isExternalGripRayHit( hit.timeOfImpact, hit.normal, direction )
				|| ( best && hit.timeOfImpact >= best.timeOfImpact ) ) continue;
			const surface = physics.surfaceByCollider.get( hit.collider.handle );
			if ( ! surface?.clawEligible ) continue;
			if ( contact.tail && surface.kind !== 'branch' ) continue;
			best = {
				collider: hit.collider,
				timeOfImpact: hit.timeOfImpact,
				normal: hit.normal,
				direction,
				point: origin.clone().addScaledVector( direction, hit.timeOfImpact ),
				surface,
			};

		}

		if ( ! best ) return false;
		contact.anchor = best.point;
		contact.normal.set( best.normal.x, best.normal.y, best.normal.z ).normalize();
		contact.surface = best.surface;
		contact.collider = best.collider;
		contact.state = 'holding';
		return true;

	}

	function releaseContact( contact, state = 'reaching' ) {

		contact.anchor = null;
		contact.surface = null;
		contact.collider = null;
		contact.load = 0;
		contact.overloadSeconds = 0;
		contact.state = state;

	}

	function applyGrip( contact, dt ) {

		if ( ! contact.anchor && ! probeContact( contact ) ) return false;
		const tip = worldPoint( contact.part.tipLocal, contact.part.body );
		const target = contact.anchor.clone().addScaledVector( contact.normal, contact.tail ? 0.008 : 0.012 );
		const error = target.sub( tip );
		const errorDistance = error.length();
		const maximumReach = contact.tail ? 0.16 : 0.12;
		if ( errorDistance > maximumReach ) {

			releaseContact( contact, 'slipping' );
			return false;

		}
		const velocity = pointVelocity( contact.part.body, tip );
		const scale = contact.surface?.gripStrengthScale ?? 1;
		const maximum = settings.gripStrength * scale * ( contact.tail ? 0.45 : 1 );
		const force = error.multiplyScalar( settings.gripStiffness )
			.addScaledVector( velocity, -settings.gripDamping );
		clampVectorLength( force, maximum );
		contact.load = force.length() / Math.max( maximum, 1e-6 );
		contact.overloadSeconds = contact.load > 0.98 && errorDistance > 0.075
			? contact.overloadSeconds + dt
			: Math.max( 0, contact.overloadSeconds - dt * 2 );
		if ( contact.overloadSeconds > 0.22 ) {

			releaseContact( contact, 'slipping' );
			return false;

		}
		contact.part.body.addForceAtPoint( vectorRecord( force ), vectorRecord( tip ), true );
		contact.state = contact.load > 0.92 ? 'loaded' : 'holding';
		return true;

	}

	function gaitOffset( part ) {

		const speed = command.move.length();
		if ( speed < 0.05 || command.fullRagdoll ) return new THREE.Quaternion();
		const limbIndex = LIMB_CHAINS.findIndex( ( chain ) => chain.includes( part.name ) );
		if ( limbIndex < 0 ) return new THREE.Quaternion();
		const phaseOffsets = [ 0, Math.PI, Math.PI, 0 ];
		const wave = Math.sin( elapsed * settings.gaitFrequency * settings.animationSpeed * Math.PI * 2 + phaseOffsets[ limbIndex ] );
		let amplitude = 0.12;
		if ( part.name.includes( '_upper' ) ) amplitude = 0.28;
		if ( part.name.includes( '_lower' ) ) amplitude = -0.34;
		if ( part.name.includes( '_palm' ) ) amplitude = 0.2;
		if ( part.name.includes( '_girdle' ) ) amplitude = 0.14;
		const axis = part.name.endsWith( 'L' )
			? new THREE.Vector3( 0, 0, 1 )
			: new THREE.Vector3( 0, 0, -1 );
		return new THREE.Quaternion().setFromAxisAngle( axis, wave * amplitude * speed );

	}

	function tailOffset( part ) {

		if ( ! part.name.startsWith( 'tail_' ) || command.fullRagdoll ) return new THREE.Quaternion();
		const index = Number.parseInt( part.name.slice( 5 ), 10 ) - 1;
		const wave = Math.sin( elapsed * 1.25 * settings.animationSpeed - index * 0.42 );
		const bend = wave * THREE.MathUtils.lerp( 0, 0, index / 11 );
		return new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 0, 0, 1 ), bend );

	}

	function applyJointMotors() {

		if ( command.fullRagdoll || settings.motorStrength <= 0 ) return;
		const dragScale = dragging ? 0.28 : 1;
		for ( const part of parts ) {

			if ( ! part.parent ) continue;
			if ( part.tailFixed ) continue;
			const target = part.restRelative.clone();
			if ( LIMB_PREFIXES.some( ( prefix ) => part.name.startsWith( prefix.split( '_' )[ 0 ] ) ) || part.name.includes( '_upper' ) || part.name.includes( '_lower' ) || part.name.includes( '_palm' ) ) {

				target.multiply( gaitOffset( part ) );

			}
			target.multiply( tailOffset( part ) ).normalize();
			const baseFrequency = part.name.startsWith( 'tail_' )
				? 18
				: part.name.includes( 'palm' ) ? 20 : 24;
			const frequency = baseFrequency * Math.sqrt( settings.motorStrength );
			if ( part.tailHinge ) {

				const mass = Math.max( part.body.mass(), 0.001 );
				applyDirectionalMotor( {
					parent: part.parent.body,
					child: part.body,
					startLocal: part.startLocal,
					tipLocal: part.tipLocal,
					length: part.definition.length,
					targetRelative: target,
					stiffness: mass * frequency * frequency * 0.25 * dragScale,
					damping: mass * frequency * 0.32 * settings.motorDamping * dragScale,
					maximum: mass * frequency * frequency * part.definition.length * 2 * dragScale,
				} );

			} else {

				const inertia = scalarRotationalInertia( part.body, part.definition.length );
				const gains = muscleControllerGains( {
					inertia,
					frequency,
					damping: settings.motorDamping,
					dragScale,
				} );
				const torque = quaternionErrorTorque( {
					parent: part.parent.body,
					child: part.body,
					targetRelative: target,
					...gains,
				} );
				part.body.addTorque( vectorRecord( torque ), true );
				part.parent.body.addTorque( vectorRecord( torque.clone().multiplyScalar( -1 ) ), true );

			}

		}

	}

	function applyAnatomicalLimits() {

		for ( const part of parts ) {

			if ( ! part.parent || part.name.startsWith( 'tail_' ) ) continue;
			const limit = anatomicalSwingLimit( part.name );

			const parentRotation = fromRapierQuaternion( part.parent.body.rotation(), new THREE.Quaternion() );
			const childRotation = fromRapierQuaternion( part.body.rotation(), new THREE.Quaternion() );
			const actualRelative = parentRotation.invert().multiply( childRotation ).normalize();
			const angle = part.restRelative.angleTo( actualRelative );
			if ( angle <= limit ) continue;
			const boundary = part.restRelative.clone().slerp( actualRelative, limit / angle ).normalize();
			const inertia = scalarRotationalInertia( part.body, part.definition.length );
			const frequency = 34;
			const torque = quaternionErrorTorque( {
				parent: part.parent.body,
				child: part.body,
				targetRelative: boundary,
				stiffness: inertia * frequency * frequency,
				damping: inertia * frequency * 2.1,
				maximum: inertia * frequency * frequency * 0.7,
			} );
			part.body.addTorque( vectorRecord( torque ), true );
			part.parent.body.addTorque( vectorRecord( torque.clone().multiplyScalar( -1 ) ), true );

		}

	}
	function updateGaitContacts( dt ) {

		if ( dragging || command.release || command.fullRagdoll || ! settings.gripEnabled ) {

			for ( const contact of contacts ) releaseContact( contact, command.release ? 'released' : 'ragdoll' );
			return;

		}
		const moving = command.move.lengthSq() > 0.0025;
		const activeFoot = moving
			? Math.floor( ( elapsed * settings.gaitFrequency * settings.animationSpeed * 4 ) % 4 )
			: -1;
		for ( const foot of feet ) {

			if ( foot.order === activeFoot ) {

				if ( foot.anchor ) releaseContact( foot, 'swinging' );
				continue;

			}
			applyGrip( foot, dt );

		}
		if ( settings.tailGrip && ( ! moving || groundedContacts < 2 ) ) applyGrip( tailGrip, dt );
		else if ( tailGrip.anchor ) releaseContact( tailGrip, 'balancing' );

	}

	function updateSupportNormal() {

		const previousNormal = averageSupportNormal.clone();
		averageSupportNormal.set( 0, 0, 0 );
		groundedContacts = 0;
		for ( const contact of contacts ) {

			if ( ! contact.anchor ) continue;
			groundedContacts ++;
			if ( contact.normal.dot( previousNormal ) < -0.65 ) continue;
			const weight = contact.tail ? 0.25 : 1 + contact.load * 0.2;
			averageSupportNormal.addScaledVector( contact.normal, weight );

		}
		if ( averageSupportNormal.lengthSq() > 1e-5 ) averageSupportNormal.normalize();
		else if ( previousNormal.lengthSq() > 1e-5 ) averageSupportNormal.copy( previousNormal ).normalize();
		else averageSupportNormal.copy( WORLD_UP );

	}

	function applyRootControl() {

		if ( command.fullRagdoll ) {

			idleAnchor = null;
			return;

		}
		const body = pelvis.body;
		const bodyRotation = fromRapierQuaternion( body.rotation(), new THREE.Quaternion() );
		const currentForward = new THREE.Vector3( 0, 1, 0 ).applyQuaternion( bodyRotation ).normalize();
		const currentUp = pelvisRestUpLocal.clone().applyQuaternion( bodyRotation ).normalize();
		const desiredMove = command.move.clone();
		const headingError = new THREE.Vector3();
		if ( desiredMove.lengthSq() > 1e-5 ) {

			idleAnchor = null;
			desiredMove.projectOnPlane( averageSupportNormal );
			if ( desiredMove.lengthSq() < 1e-5 ) desiredMove.copy( command.move );
			desiredMove.normalize();
			const desiredSpeed = settings.moveSpeed * ( command.sprint ? settings.sprintMultiplier : 1 );
			const currentVelocity = fromRapierVector( body.linvel(), new THREE.Vector3() );
			const tangentVelocity = currentVelocity.clone().projectOnPlane( averageSupportNormal );
			const force = desiredMove.multiplyScalar( desiredSpeed )
				.sub( tangentVelocity )
				.multiplyScalar( settings.moveForce * Math.max( body.mass(), 0.15 ) );
			clampVectorLength( force, settings.moveForce * 1.45 );
			body.addForce( vectorRecord( force ), true );

			const flatForward = currentForward.clone().projectOnPlane( averageSupportNormal ).normalize();
			headingError.copy( flatForward ).cross( desiredMove );

		} else if (
			( groundedContacts > 0 || idleAnchor )
				&& idleHoldCooldown <= 0
				&& ! dragging
				&& ! command.release
		) {

			const currentPosition = fromRapierVector( body.translation(), new THREE.Vector3() );
			if ( ! idleAnchor ) idleAnchor = currentPosition.clone();
			const currentVelocity = fromRapierVector( body.linvel(), new THREE.Vector3() );
			const tangentError = idleAnchor.clone().sub( currentPosition ).projectOnPlane( averageSupportNormal );
			const tangentVelocity = currentVelocity.projectOnPlane( averageSupportNormal );
			const gains = idleHoldControllerGains( { mass: totalMass } );
			const force = tangentError.multiplyScalar( gains.stiffness )
				.addScaledVector( tangentVelocity, -gains.damping );
			body.addForce( vectorRecord( clampVectorLength( force, gains.maximum ) ), true );

		} else {

			idleAnchor = null;

		}
		const angularVelocity = fromRapierVector( body.angvel(), new THREE.Vector3() );
		const angularAcceleration = currentUp.clone().cross( averageSupportNormal )
			.multiplyScalar( groundedContacts > 0 ? 70 : 18 )
			.addScaledVector( headingError, 52 )
			.addScaledVector( angularVelocity, -9 );
		const principalInertia = body.principalInertia();
		const effectiveInertia = Math.max(
			principalInertia.x,
			principalInertia.y,
			principalInertia.z,
			totalMass * 0.0015,
		);
		const controlTorque = angularAcceleration.multiplyScalar( effectiveInertia );
		body.addTorque(
			vectorRecord( clampVectorLength( controlTorque, settings.turnTorque ) ),
			true,
		);

		const plantedFeet = feet.filter( ( foot ) => foot.anchor );
		if ( plantedFeet.length >= 2 ) {

			const centroid = new THREE.Vector3();
			for ( const foot of plantedFeet ) centroid.add( foot.anchor );
			centroid.multiplyScalar( 1 / plantedFeet.length );
			const position = fromRapierVector( body.translation(), new THREE.Vector3() );
			const normalVelocity = fromRapierVector( body.linvel(), new THREE.Vector3() )
				.dot( averageSupportNormal );
			const height = position.sub( centroid ).dot( averageSupportNormal );
			const gravity = fromRapierVector( world.gravity, new THREE.Vector3() );
			const gravityCompensation = Math.max( 0, -gravity.dot( averageSupportNormal ) ) * totalMass;
			const supportMagnitude = THREE.MathUtils.clamp(
				( 0.15 - height ) * totalMass * 75
					- normalVelocity * totalMass * 11
					+ gravityCompensation,
				- totalMass * 8,
				totalMass * 22,
			);
			body.addForce(
				vectorRecord( averageSupportNormal.clone().multiplyScalar( supportMagnitude ) ),
				true,
			);

		}

	}

	function beforeStep( dt ) {

		elapsed += dt;
		substepIndex ++;
		idleHoldCooldown = Math.max( 0, idleHoldCooldown - dt );
		if ( command.release ) idleHoldCooldown = Math.max( idleHoldCooldown, 0.35 );
		for ( const part of parts ) {

			part.body.resetForces( false );
			part.body.resetTorques( false );
			part.prevPosition.copy( part.position );
			part.prevQuaternion.copy( part.quaternion );

		}
		updateGaitContacts( dt );
		updateSupportNormal();
		applyAnatomicalLimits();
		applyJointMotors();
		applyRootControl();

	}

	function afterStep() {

		for ( const part of parts ) {

			fromRapierVector( part.body.translation(), part.position );
			fromRapierQuaternion( part.body.rotation(), part.quaternion );

		}

	}

	function syncVisual( alpha = 1 ) {

		for ( const part of parts ) {

			renderPosition.lerpVectors( part.prevPosition, part.position, alpha );
			renderQuaternion.slerpQuaternions( part.prevQuaternion, part.quaternion, alpha );
			tempBodyMatrix.compose( renderPosition, renderQuaternion, BODY_SCALE );
			tempMatrix.multiplyMatrices( tempBodyMatrix, part.bodyToBone );
			const parentWorld = part.bone.parent?.matrixWorld;
			if ( parentWorld ) tempMatrix.premultiply( tempParentInverse.copy( parentWorld ).invert() );
			tempMatrix.decompose( part.bone.position, part.bone.quaternion, renderScale );
			part.bone.scale.copy( renderScale );
			part.bone.updateMatrix();
			part.bone.updateMatrixWorld( false );
			part.debugMesh.position.copy( renderPosition );
			part.debugMesh.quaternion.copy( renderQuaternion );

		}
		model.updateMatrixWorld( true );

	}

	function reset( nextSpawn = spawn ) {

		elapsed = 0;
		substepIndex = 0;
		idleAnchor = null;
		idleHoldCooldown = 0;
		for ( const contact of contacts ) {

			releaseContact( contact );
			contact.lastProbeStep = -100;

		}
		for ( const part of parts ) {

			const offset = nextSpawn.clone().sub( spawn );
			const position = part.definition.center.clone().add( offset );
			part.body.setTranslation( vectorRecord( position ), true );
			part.body.setRotation( quaternionRecord( part.definition.quaternion ), true );
			part.body.setLinvel( vectorRecord( ZERO ), true );
			part.body.setAngvel( vectorRecord( ZERO ), true );
			part.body.resetForces( true );
			part.body.resetTorques( true );
			part.prevPosition.copy( position );
			part.position.copy( position );
			part.prevQuaternion.copy( part.definition.quaternion );
			part.quaternion.copy( part.definition.quaternion );

		}
		world.propagateModifiedBodyPositionsToColliders();
		rebuildJoints();
		physics.resetAccumulator?.();
		syncVisual( 1 );

	}

	function setDebugVisible( visible ) {

		debugGroup.visible = visible;

	}

	function dispose() {

		for ( const joint of joints ) {

			if ( joint.isValid() ) world.removeImpulseJoint( joint, false );

		}
		for ( const part of parts ) {

			if ( part.body.isValid() ) world.removeRigidBody( part.body );
			part.debugMesh.geometry.dispose();
			part.debugMesh.material.dispose();

		}
		model.traverse( ( object ) => {

			if ( ! object.isMesh ) return;
			object.geometry?.dispose();
			if ( Array.isArray( object.material ) ) {

				for ( const material of object.material ) material.dispose();

			} else {

				object.material?.dispose();

			}

		} );
		scene.remove( model );
		scene.remove( debugGroup );

	}

	reset( spawn );

	return {
		model,
		parts,
		partByBone,
		feet,
		tailGrip,
		pelvis,
		settings,
		command,
		debugGroup,
		get supportNormal() {

			return averageSupportNormal;

		},
		get contactCount() {

			return groundedContacts;

		},
		setCommand( next ) {

			if ( next.move ) command.move.copy( next.move );
			if ( next.sprint !== undefined ) command.sprint = next.sprint;
			if ( next.release !== undefined ) command.release = next.release;
			if ( next.fullRagdoll !== undefined ) command.fullRagdoll = next.fullRagdoll;

		},
		setDragging( value ) {

			const next = !! value;
			if ( next || ( dragging && ! next ) ) {

				idleAnchor = null;
				idleHoldCooldown = Math.max( idleHoldCooldown, 0.65 );

			}
			dragging = next;

		},
		beforeStep,
		afterStep,
		syncVisual,
		reset,
		setDebugVisible,
		dispose,
	};

}

export {
	CHAMELEON_GROUP,
	FOOT_NAMES,
	PHYSICAL_BONES,
};
