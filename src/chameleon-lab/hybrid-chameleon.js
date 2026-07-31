import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { ChameleonProceduralGait } from '../chameleon-procedural-gait.js';
import {
	chameleonCollisionGroups,
	isExternalGripRayHit,
} from './surface-contact-model.js';
import {
	criticalDampingGains,
	HYBRID_JOINT_LIMITS,
	stableRootForce,
	supportFrameFromContacts,
} from './hybrid-controller-model.js';

const WORLD_UP = new THREE.Vector3( 0, 1, 0 );
const LOCAL_FORWARD = new THREE.Vector3( -1, 0, 0 );
const LOCAL_UP = new THREE.Vector3( 0, 1, 0 );
const ZERO = new THREE.Vector3();
const IDENTITY_QUATERNION = new THREE.Quaternion();
const BODY_COLLISION_GROUP = chameleonCollisionGroups();

const LEG_SPECS = Object.freeze( [
	Object.freeze( { name: 'front.L', girdle: 'front_girdleL', upper: 'front_upperL', lower: 'front_lowerL', palm: 'front_palmL' } ),
	Object.freeze( { name: 'front.R', girdle: 'front_girdleR', upper: 'front_upperR', lower: 'front_lowerR', palm: 'front_palmR' } ),
	Object.freeze( { name: 'hind.L', girdle: 'hind_girdleL', upper: 'hind_upperL', lower: 'hind_lowerL', palm: 'hind_palmL' } ),
	Object.freeze( { name: 'hind.R', girdle: 'hind_girdleR', upper: 'hind_upperR', lower: 'hind_lowerR', palm: 'hind_palmR' } ),
] );

const PROBE_AXES = Object.freeze( [
	new THREE.Vector3( 0, -1, 0 ),
	new THREE.Vector3( 0, 1, 0 ),
	new THREE.Vector3( 1, 0, 0 ),
	new THREE.Vector3( -1, 0, 0 ),
	new THREE.Vector3( 0, 0, 1 ),
	new THREE.Vector3( 0, 0, -1 ),
] );

function vectorRecord( vector ) {

	return { x: vector.x, y: vector.y, z: vector.z };

}

function quaternionRecord( quaternion ) {

	return { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w };

}

function readVector( value, target = new THREE.Vector3() ) {

	return target.set( value.x, value.y, value.z );

}

function readQuaternion( value, target = new THREE.Quaternion() ) {

	return target.set( value.x, value.y, value.z, value.w ).normalize();

}

function clampVector( vector, maximum ) {

	const lengthSq = vector.lengthSq();
	if ( lengthSq > maximum * maximum && maximum > 0 )
		vector.multiplyScalar( maximum / Math.sqrt( lengthSq ) );
	return vector;

}

function clampQuaternionFromRest( rest, candidate, limit, target = new THREE.Quaternion() ) {

	target.copy( rest ).invert().multiply( candidate ).normalize();
	if ( target.w < 0 ) target.set( -target.x, -target.y, -target.z, -target.w );
	const angle = 2 * Math.acos( THREE.MathUtils.clamp( target.w, -1, 1 ) );
	if ( angle > limit && angle > 1e-8 )
		target.slerpQuaternions( IDENTITY_QUATERNION, target, limit / angle );
	return target.premultiply( rest ).normalize();

}

function quaternionTorque( body, desired, frequency, dampingRatio, maximum ) {

	const current = readQuaternion( body.rotation(), new THREE.Quaternion() );
	const error = desired.clone().multiply( current.invert() ).normalize();
	if ( error.w < 0 ) error.set( -error.x, -error.y, -error.z, -error.w );
	const angle = 2 * Math.acos( THREE.MathUtils.clamp( error.w, -1, 1 ) );
	const sinHalf = Math.sqrt( Math.max( 1e-10, 1 - error.w * error.w ) );
	const axis = new THREE.Vector3( error.x / sinHalf, error.y / sinHalf, error.z / sinHalf );
	const inertia = body.principalInertia();
	const effectiveInertia = Math.max( inertia.x, inertia.y, inertia.z, 0.002 );
	const gains = criticalDampingGains( {
		mass: effectiveInertia,
		frequency,
		dampingRatio,
		maximumAcceleration: maximum / effectiveInertia,
	} );
	return clampVector(
		axis.multiplyScalar( angle * gains.stiffness )
			.addScaledVector( readVector( body.angvel(), new THREE.Vector3() ), -gains.damping ),
		maximum,
	);

}

function desiredBodyQuaternion( current, supportNormal, movement ) {

	const up = supportNormal.clone().normalize();
	let forward = movement.clone().projectOnPlane( up );
	if ( forward.lengthSq() < 1e-6 )
		forward.copy( LOCAL_FORWARD ).applyQuaternion( current ).projectOnPlane( up );
	if ( forward.lengthSq() < 1e-6 )
		forward.set( 0, 0, -1 ).projectOnPlane( up );
	forward.normalize();
	const xAxis = forward.clone().multiplyScalar( -1 );
	const zAxis = xAxis.clone().cross( up ).normalize();
	const correctedUp = zAxis.clone().cross( xAxis ).normalize();
	return new THREE.Quaternion().setFromRotationMatrix(
		new THREE.Matrix4().makeBasis( xAxis, correctedUp, zAxis ),
	).normalize();

}

class StableVisualRig {

	constructor( model ) {

		this.model = model;
		this.bones = [];
		this.byName = new Map();
		model.traverse( ( object ) => {

			if ( ! object.isBone ) return;
			this.bones.push( object );
			this.byName.set( object.name, object );

		} );
		this.pelvis = this._require( 'pelvis' );
		this.rest = this.bones.map( ( bone ) => ( {
			bone,
			position: bone.position.clone(),
			quaternion: bone.quaternion.clone(),
			scale: bone.scale.clone(),
		} ) );
		this.legs = LEG_SPECS.map( ( spec ) => {

			const girdle = this._require( spec.girdle );
			const upper = this._require( spec.upper );
			const lower = this._require( spec.lower );
			const palm = this._require( spec.palm );
			const worldQuaternion = palm.getWorldQuaternion( new THREE.Quaternion() );
			return {
				...spec,
				girdle,
				upper,
				lower,
				palm,
				joints: [ lower, upper, girdle ],
				restQuaternions: new Map( [
					[ girdle, girdle.quaternion.clone() ],
					[ upper, upper.quaternion.clone() ],
					[ lower, lower.quaternion.clone() ],
					[ palm, palm.quaternion.clone() ],
				] ),
				soleNormalLocal: WORLD_UP.clone().applyQuaternion( worldQuaternion.invert() ).normalize(),
			};

		} );
		this._jointWorld = new THREE.Vector3();
		this._palmWorld = new THREE.Vector3();
		this._toPalm = new THREE.Vector3();
		this._toTarget = new THREE.Vector3();
		this._jointWorldQuaternion = new THREE.Quaternion();
		this._parentWorldQuaternion = new THREE.Quaternion();
		this._candidate = new THREE.Quaternion();
		this._delta = new THREE.Quaternion();
		this._bounded = new THREE.Quaternion();
		this._currentNormal = new THREE.Vector3();
		this._target = new THREE.Vector3();
		this._desiredNormal = new THREE.Vector3();

	}

	_require( name ) {

		const bone = this.byName.get( name );
		if ( ! bone ) throw new Error( `Hybrid chameleon is missing bone "${ name }".` );
		return bone;

	}

	restore() {

		for ( const pose of this.rest ) {

			pose.bone.position.copy( pose.position );
			pose.bone.quaternion.copy( pose.quaternion );
			pose.bone.scale.copy( pose.scale );

		}
		this.model.updateMatrixWorld( true );

	}

	writePalmPositions( target ) {

		for ( let index = 0; index < this.legs.length; index ++ ) {

			this.legs[ index ].palm.getWorldPosition( this._palmWorld );
			target[ index * 3 ] = this._palmWorld.x;
			target[ index * 3 + 1 ] = this._palmWorld.y;
			target[ index * 3 + 2 ] = this._palmWorld.z;

		}
		return target;

	}

	_boundJoint( leg, joint, candidate ) {

		const role = joint === leg.girdle ? 'girdle' : joint === leg.upper ? 'upper' : 'lower';
		return clampQuaternionFromRest(
			leg.restQuaternions.get( joint ),
			candidate,
			HYBRID_JOINT_LIMITS[ role ],
			this._bounded,
		);

	}

	solve( footTargets, footNormals, weight = 1 ) {

		const influence = THREE.MathUtils.clamp( weight, 0, 1 );
		if ( influence <= 0 ) {

			this.model.updateMatrixWorld( true );
			return;

		}
		for ( let index = 0; index < this.legs.length; index ++ ) {

			const offset = index * 3;
			const target = this._target.set(
				footTargets[ offset ], footTargets[ offset + 1 ], footTargets[ offset + 2 ],
			);
			const leg = this.legs[ index ];
			for ( let iteration = 0; iteration < 4; iteration ++ ) {

				for ( const joint of leg.joints ) {

					joint.updateWorldMatrix( true, true );
					joint.getWorldPosition( this._jointWorld );
					leg.palm.getWorldPosition( this._palmWorld );
					this._toPalm.copy( this._palmWorld ).sub( this._jointWorld );
					this._toTarget.copy( target ).sub( this._jointWorld );
					if ( this._toPalm.lengthSq() < 1e-9 || this._toTarget.lengthSq() < 1e-9 ) continue;
					this._delta.setFromUnitVectors( this._toPalm.normalize(), this._toTarget.normalize() );
					joint.getWorldQuaternion( this._jointWorldQuaternion );
					this._candidate.copy( this._delta ).multiply( this._jointWorldQuaternion );
					joint.parent.getWorldQuaternion( this._parentWorldQuaternion ).invert();
					this._candidate.premultiply( this._parentWorldQuaternion ).normalize();
					const bounded = this._boundJoint( leg, joint, this._candidate );
					joint.quaternion.slerpQuaternions( leg.restQuaternions.get( joint ), bounded, influence );

				}

			}
			const desiredNormal = this._desiredNormal.set(
				footNormals[ offset ], footNormals[ offset + 1 ], footNormals[ offset + 2 ],
			);
			if ( desiredNormal.lengthSq() > 1e-8 ) {

				desiredNormal.normalize();
				leg.palm.updateWorldMatrix( true, false );
				leg.palm.getWorldQuaternion( this._jointWorldQuaternion );
				this._currentNormal.copy( leg.soleNormalLocal )
					.applyQuaternion( this._jointWorldQuaternion ).normalize();
				this._delta.setFromUnitVectors( this._currentNormal, desiredNormal );
				this._candidate.copy( this._delta ).multiply( this._jointWorldQuaternion );
				leg.palm.parent.getWorldQuaternion( this._parentWorldQuaternion ).invert();
				this._candidate.premultiply( this._parentWorldQuaternion ).normalize();
				const bounded = clampQuaternionFromRest(
					leg.restQuaternions.get( leg.palm ),
					this._candidate,
					HYBRID_JOINT_LIMITS.palm,
					this._bounded,
				);
				leg.palm.quaternion.slerpQuaternions(
					leg.restQuaternions.get( leg.palm ), bounded, influence,
				);

			}

		}
		this.model.updateMatrixWorld( true );

	}

}

function createDebugView( scene ) {

	const group = new THREE.Group();
	group.name = 'ChameleonHybridDebug';
	group.visible = false;
	const coreMaterial = new THREE.MeshBasicMaterial( {
		color: 0xff5e78,
		wireframe: true,
		depthTest: false,
		transparent: true,
		opacity: 0.7,
	} );
	const torso = new THREE.Mesh( new THREE.CapsuleGeometry( 0.16, 0.44, 6, 12 ), coreMaterial );
	torso.rotation.z = Math.PI * 0.5;
	torso.position.set( -0.08, 0.04, 0 );
	const head = new THREE.Mesh(
		new THREE.SphereGeometry( 0.18, 12, 8 ),
		coreMaterial.clone(),
	);
	head.position.set( -0.38, 0.055, 0 );
	const bodyRoot = new THREE.Group();
	bodyRoot.add( torso, head );
	group.add( bodyRoot );
	const footMaterial = new THREE.MeshBasicMaterial( { color: 0xffd166, depthTest: false } );
	const feet = Array.from( { length: 4 }, () => {

		const mesh = new THREE.Mesh( new THREE.SphereGeometry( 0.025, 10, 6 ), footMaterial );
		group.add( mesh );
		return mesh;

	} );
	const linePositions = new Float32Array( 4 * 2 * 3 );
	const lineGeometry = new THREE.BufferGeometry();
	lineGeometry.setAttribute( 'position', new THREE.BufferAttribute( linePositions, 3 ) );
	const lines = new THREE.LineSegments(
		lineGeometry,
		new THREE.LineBasicMaterial( { color: 0x9ee8ff, depthTest: false, transparent: true, opacity: 0.75 } ),
	);
	group.add( lines );
	scene.add( group );
	return { group, bodyRoot, feet, lines, linePositions };

}

export async function createHybridChameleon( {
	scene,
	physics,
	spawn = new THREE.Vector3( 0, 0.3, 0.75 ),
	assetUrl = '/assets/ChameleonPhysical.glb',
	assetScene = null,
} ) {

	const model = assetScene || ( await new GLTFLoader().loadAsync( assetUrl ) ).scene;
	model.name = 'HybridChameleonModel';
	model.traverse( ( object ) => {

		if ( ! object.isMesh ) return;
		object.castShadow = true;
		object.receiveShadow = true;
		object.frustumCulled = false;

	} );
	const visualRoot = new THREE.Group();
	visualRoot.name = 'HybridChameleonPhysicalRoot';
	visualRoot.add( model );
	scene.add( visualRoot );
	model.updateMatrixWorld( true );
	const rig = new StableVisualRig( model );
	const pelvisInitial = rig.pelvis.getWorldPosition( new THREE.Vector3() );
	model.position.sub( pelvisInitial );
	visualRoot.position.copy( spawn );
	visualRoot.updateMatrixWorld( true );
	rig.restore();

	const { RAPIER, world } = physics;
	const body = world.createRigidBody(
		RAPIER.RigidBodyDesc.dynamic()
			.setTranslation( spawn.x, spawn.y, spawn.z )
			.setLinearDamping( 0.7 )
			.setAngularDamping( 1.35 )
			.setCanSleep( true )
			.setCcdEnabled( true ),
	);
	body.userData = { kind: 'chameleon-proxy', boneName: 'body' };
	body.setAdditionalSolverIterations( 3 );
	const horizontalCapsule = new THREE.Quaternion().setFromAxisAngle(
		new THREE.Vector3( 0, 0, 1 ), Math.PI * 0.5,
	);
	const torsoCollider = world.createCollider(
		RAPIER.ColliderDesc.capsule( 0.22, 0.16 )
			.setTranslation( -0.08, 0.04, 0 )
			.setRotation( quaternionRecord( horizontalCapsule ) )
			.setMass( 0.78 )
			.setFriction( 0.82 )
			.setRestitution( 0.01 )
			.setCollisionGroups( BODY_COLLISION_GROUP ),
		body,
	);
	const headCollider = world.createCollider(
		RAPIER.ColliderDesc.ball( 0.18 )
			.setTranslation( -0.38, 0.055, 0 )
			.setMass( 0.22 )
			.setFriction( 0.75 )
			.setRestitution( 0.01 )
			.setCollisionGroups( BODY_COLLISION_GROUP ),
		body,
	);
	torsoCollider.userData = body.userData;
	headCollider.userData = body.userData;
	physics.registerBody?.( body, { collider: torsoCollider } );

	const corePart = { name: 'body', body, collider: torsoCollider, colliders: [ torsoCollider, headCollider ] };
	const footNames = LEG_SPECS.map( ( spec ) => spec.palm );
	const feet = footNames.map( ( name, order ) => ( {
		order,
		part: { name, body, collider: torsoCollider },
		anchor: null,
		normal: new THREE.Vector3( 0, 1, 0 ),
		surface: null,
		collider: null,
		load: 0,
		state: 'reaching',
	} ) );
	const tail = Object.freeze( {
		name: 'tail_original',
		deformationMode: 'rigid-pelvis',
		physicsDofs: 0,
	} );

	const settings = {
		motorStrength: 1,
		motorDamping: 1,
		moveSpeed: 1.25,
		sprintMultiplier: 1.75,
		moveForce: 13,
		turnTorque: 0.9,
		gripEnabled: true,
		gripStrength: 28,
		gripStiffness: 175,
		gripDamping: 8,
		gripReach: 0.42,
		gaitFrequency: 1.55,
		animationSpeed: 1,
	};
	const command = {
		move: new THREE.Vector3(),
		sprint: false,
		release: false,
		fullRagdoll: false,
	};
	const gait = new ChameleonProceduralGait( {
		fixedStep: physics.fixedDt || 1 / 120,
		maxSubsteps: 1,
		stepDistance: 0.09,
		stepHeight: 0.045,
		minSwingDuration: 0.09,
		maxSwingDuration: 0.24,
		minTargetError: 0.018,
		bodyClearance: 0,
	} );
	const candidatePositions = new Float32Array( 12 );
	const candidateNormals = new Float32Array( 12 );
	const previousFootPositions = new Float32Array( 12 );
	const currentFootPositions = new Float32Array( 12 );
	const previousFootNormals = new Float32Array( 12 );
	const currentFootNormals = new Float32Array( 12 );
	const renderFootPositions = new Float32Array( 12 );
	const renderFootNormals = new Float32Array( 12 );
	const nominalFootPositions = new Float32Array( 12 );
	const bodyToFootOffsets = Array.from( { length: 4 }, () => new THREE.Vector3() );
	const activeContacts = new Uint8Array( 4 );
	const gaitInput = Object.seal( {
		contactPositions: candidatePositions,
		contactNormals: candidateNormals,
		speed: 0,
		velocityX: 0,
		velocityY: 0,
		velocityZ: 0,
		forwardX: -1,
		forwardY: 0,
		forwardZ: 0,
	} );
	const debug = createDebugView( scene );
	const previousPosition = spawn.clone();
	const currentPosition = spawn.clone();
	const previousQuaternion = new THREE.Quaternion();
	const currentQuaternion = new THREE.Quaternion();
	const renderPosition = new THREE.Vector3();
	const renderQuaternion = new THREE.Quaternion();
	const averageSupportNormal = new THREE.Vector3( 0, 1, 0 );
	const tempPosition = new THREE.Vector3();
	const tempQuaternion = new THREE.Quaternion();
	const tempVelocity = new THREE.Vector3();
	const tempDirection = new THREE.Vector3();
	const tempRight = new THREE.Vector3();
	const desiredRoot = new THREE.Vector3();
	const rootSuggestion = new THREE.Vector3();
	let contactCount = 0;
	let dragging = false;
	let elapsed = 0;

	function surfaceProbe( nominal, preferredNormal, movement, contact ) {

		const reach = Math.max( 0.1, settings.gripReach );
		const currentRotation = readQuaternion( body.rotation(), tempQuaternion );
		const directions = [
			preferredNormal.clone().multiplyScalar( -1 ),
			movement.clone(),
			movement.clone().multiplyScalar( -1 ),
			tempRight.copy( movement.lengthSq() > 1e-6 ? movement : LOCAL_FORWARD )
				.cross( preferredNormal ).normalize().clone(),
			tempRight.clone().multiplyScalar( -1 ),
			...PROBE_AXES.map( ( axis ) => axis.clone().applyQuaternion( currentRotation ) ),
		];
		let best = null;
		for ( const rawDirection of directions ) {

			if ( rawDirection.lengthSq() < 1e-8 ) continue;
			const direction = rawDirection.normalize();
			const lift = reach * 0.48;
			const origin = nominal.clone().addScaledVector( direction, -lift );
			const ray = new RAPIER.Ray( vectorRecord( origin ), vectorRecord( direction ) );
			const hit = world.castRayAndGetNormal(
				ray,
				reach * 1.55,
				false,
				undefined,
				undefined,
				undefined,
				body,
				( collider ) => physics.surfaceByCollider?.has( collider.handle ) === true,
			);
			if ( ! hit || ! isExternalGripRayHit( hit.timeOfImpact, hit.normal, direction ) ) continue;
			const surface = physics.surfaceByCollider.get( hit.collider.handle );
			if ( ! surface?.clawEligible ) continue;
			const normal = new THREE.Vector3( hit.normal.x, hit.normal.y, hit.normal.z ).normalize();
			const point = origin.clone().addScaledVector( direction, hit.timeOfImpact )
				.addScaledVector( normal, 0.008 );
			const score = Math.abs( hit.timeOfImpact - lift )
				+ ( 1 - normal.dot( preferredNormal ) ) * 0.075;
			if ( ! best || score < best.score ) best = { score, point, normal, surface, collider: hit.collider };

		}
		if ( ! best ) {

			contact.anchor = null;
			contact.surface = null;
			contact.collider = null;
			contact.load = 0;
			contact.state = 'reaching';
			return null;

		}
		contact.anchor = best.point;
		contact.normal.copy( best.normal );
		contact.surface = best.surface;
		contact.collider = best.collider;
		contact.load = 0.35;
		contact.state = 'holding';
		return best;

	}

	function updateCandidates() {

		const position = readVector( body.translation(), tempPosition );
		const rotation = readQuaternion( body.rotation(), tempQuaternion );
		const movement = command.move.clone().projectOnPlane( averageSupportNormal );
		if ( movement.lengthSq() > 1e-8 ) movement.normalize();
		contactCount = 0;
		for ( let foot = 0; foot < 4; foot ++ ) {

			const offset = foot * 3;
			const nominal = bodyToFootOffsets[ foot ].clone().applyQuaternion( rotation ).add( position );
			if ( movement.lengthSq() > 0 ) nominal.addScaledVector( movement, 0.055 );
			nominalFootPositions[ offset ] = nominal.x;
			nominalFootPositions[ offset + 1 ] = nominal.y;
			nominalFootPositions[ offset + 2 ] = nominal.z;
			const hit = settings.gripEnabled && ! command.release && ! command.fullRagdoll && ! dragging
				? surfaceProbe( nominal, averageSupportNormal, movement, feet[ foot ] )
				: null;
			if ( hit ) {

				candidatePositions[ offset ] = hit.point.x;
				candidatePositions[ offset + 1 ] = hit.point.y;
				candidatePositions[ offset + 2 ] = hit.point.z;
				candidateNormals[ offset ] = hit.normal.x;
				candidateNormals[ offset + 1 ] = hit.normal.y;
				candidateNormals[ offset + 2 ] = hit.normal.z;
				activeContacts[ foot ] = 1;
				contactCount ++;

			} else {

				candidatePositions[ offset ] = nominal.x;
				candidatePositions[ offset + 1 ] = nominal.y;
				candidatePositions[ offset + 2 ] = nominal.z;
				candidateNormals[ offset ] = averageSupportNormal.x;
				candidateNormals[ offset + 1 ] = averageSupportNormal.y;
				candidateNormals[ offset + 2 ] = averageSupportNormal.z;
				activeContacts[ foot ] = 0;

			}

		}

	}

	function updateGait( dt ) {

		previousFootPositions.set( currentFootPositions );
		previousFootNormals.set( currentFootNormals );
		const velocity = readVector( body.linvel(), tempVelocity );
		const currentRotation = readQuaternion( body.rotation(), tempQuaternion );
		const forward = LOCAL_FORWARD.clone().applyQuaternion( currentRotation );
		gaitInput.speed = command.move.length() * settings.moveSpeed;
		gaitInput.velocityX = velocity.x;
		gaitInput.velocityY = velocity.y;
		gaitInput.velocityZ = velocity.z;
		gaitInput.forwardX = forward.x;
		gaitInput.forwardY = forward.y;
		gaitInput.forwardZ = forward.z;
		const cadence = Math.max( 0.1, settings.gaitFrequency * settings.animationSpeed );
		gait.minSwingDuration = 0.12 / cadence;
		gait.maxSwingDuration = 0.28 / cadence;
		const view = gait.update( dt, gaitInput );
		currentFootPositions.set( view.footPositions );
		currentFootNormals.set( view.footNormals );
		const frame = supportFrameFromContacts( currentFootPositions, currentFootNormals, activeContacts );
		if ( frame.count >= 2 ) averageSupportNormal.set(
			frame.normal.x, frame.normal.y, frame.normal.z,
		).normalize();

	}

	function applyRootController() {

		if ( command.fullRagdoll || command.release || dragging || contactCount < 2 ) return;
		const position = readVector( body.translation(), tempPosition );
		const rotation = readQuaternion( body.rotation(), tempQuaternion );
		const velocity = readVector( body.linvel(), tempVelocity );
		desiredRoot.set( 0, 0, 0 );
		let suggestions = 0;
		for ( let foot = 0; foot < 4; foot ++ ) {

			if ( ! activeContacts[ foot ] ) continue;
			const offset = foot * 3;
			rootSuggestion.set(
				currentFootPositions[ offset ],
				currentFootPositions[ offset + 1 ],
				currentFootPositions[ offset + 2 ],
			).sub( bodyToFootOffsets[ foot ].clone().applyQuaternion( rotation ) );
			desiredRoot.add( rootSuggestion );
			suggestions ++;

		}
		if ( suggestions > 0 ) desiredRoot.multiplyScalar( 1 / suggestions );
		else desiredRoot.copy( position );
		const totalMass = Math.max( body.mass(), 0.1 );
		const supportForceRecord = stableRootForce( {
			error: desiredRoot.clone().sub( position ),
			velocity,
			mass: totalMass,
			frequency: 5.5 + settings.motorStrength * 2.5,
			dampingRatio: settings.motorDamping,
			maximumAcceleration: Math.max( 8, settings.gripStrength / totalMass ),
		} );
		const supportForce = new THREE.Vector3(
			supportForceRecord.x, supportForceRecord.y, supportForceRecord.z,
		);
		const gravity = readVector( world.gravity, new THREE.Vector3() );
		const gravityAlongSupport = -gravity.dot( averageSupportNormal ) * totalMass;
		supportForce.addScaledVector( averageSupportNormal, Math.max( 0, gravityAlongSupport ) );
		const desiredMovement = command.move.clone().projectOnPlane( averageSupportNormal );
		if ( desiredMovement.lengthSq() > 1e-8 ) {

			desiredMovement.normalize().multiplyScalar(
				settings.moveSpeed * ( command.sprint ? settings.sprintMultiplier : 1 ),
			);
			const tangentVelocity = velocity.clone().projectOnPlane( averageSupportNormal );
			supportForce.add(
				desiredMovement.sub( tangentVelocity ).multiplyScalar( totalMass * settings.moveForce ),
			);

		}
		body.addForce( vectorRecord( clampVector(
			supportForce,
			Math.max( settings.gripStrength, totalMass * 10 ) + settings.moveForce * totalMass,
		) ), true );
		const desiredRotation = desiredBodyQuaternion( rotation, averageSupportNormal, command.move );
		const torque = quaternionTorque(
			body,
			desiredRotation,
			6.5 + settings.motorStrength * 2,
			settings.motorDamping,
			settings.turnTorque,
		);
		body.addTorque( vectorRecord( torque ), true );

	}

	function beforeStep( dt ) {

		elapsed += dt;
		body.resetForces( false );
		body.resetTorques( false );
		previousPosition.copy( currentPosition );
		previousQuaternion.copy( currentQuaternion );
		updateCandidates();
		updateGait( dt );
		applyRootController();

	}

	function afterStep() {

		readVector( body.translation(), currentPosition );
		readQuaternion( body.rotation(), currentQuaternion );

	}

	function syncVisual( alpha = 1 ) {

		const t = THREE.MathUtils.clamp( alpha, 0, 1 );
		renderPosition.lerpVectors( previousPosition, currentPosition, t );
		renderQuaternion.slerpQuaternions( previousQuaternion, currentQuaternion, t );
		visualRoot.position.copy( renderPosition );
		visualRoot.quaternion.copy( renderQuaternion );
		visualRoot.updateMatrixWorld( true );
		for ( let index = 0; index < 12; index ++ ) {

			renderFootPositions[ index ] = THREE.MathUtils.lerp(
				previousFootPositions[ index ], currentFootPositions[ index ], t,
			);
			renderFootNormals[ index ] = THREE.MathUtils.lerp(
				previousFootNormals[ index ], currentFootNormals[ index ], t,
			);

		}
		rig.restore();
		const ikWeight = settings.motorStrength > 0
			&& ! dragging && ! command.fullRagdoll && ! command.release ? 1 : 0;
		rig.solve( renderFootPositions, renderFootNormals, ikWeight );
		debug.bodyRoot.position.copy( renderPosition );
		debug.bodyRoot.quaternion.copy( renderQuaternion );
		for ( let foot = 0; foot < 4; foot ++ ) {

			const offset = foot * 3;
			debug.feet[ foot ].position.set(
				renderFootPositions[ offset ], renderFootPositions[ offset + 1 ], renderFootPositions[ offset + 2 ],
			);
			debug.linePositions[ foot * 6 ] = renderPosition.x;
			debug.linePositions[ foot * 6 + 1 ] = renderPosition.y;
			debug.linePositions[ foot * 6 + 2 ] = renderPosition.z;
			debug.linePositions[ foot * 6 + 3 ] = renderFootPositions[ offset ];
			debug.linePositions[ foot * 6 + 4 ] = renderFootPositions[ offset + 1 ];
			debug.linePositions[ foot * 6 + 5 ] = renderFootPositions[ offset + 2 ];

		}
		debug.lines.geometry.attributes.position.needsUpdate = true;

	}

	function initializeContacts( nextSpawn ) {

		visualRoot.position.copy( nextSpawn );
		visualRoot.quaternion.identity();
		visualRoot.updateMatrixWorld( true );
		rig.restore();
		rig.writePalmPositions( nominalFootPositions );
		averageSupportNormal.copy( WORLD_UP );
		for ( let foot = 0; foot < 4; foot ++ ) bodyToFootOffsets[ foot ].set(
			nominalFootPositions[ foot * 3 ] - nextSpawn.x,
			nominalFootPositions[ foot * 3 + 1 ] - nextSpawn.y,
			nominalFootPositions[ foot * 3 + 2 ] - nextSpawn.z,
		);
		updateCandidates();
		for ( let foot = 0; foot < 4; foot ++ ) {

			const offset = foot * 3;
			bodyToFootOffsets[ foot ].set(
				candidatePositions[ offset ] - nextSpawn.x,
				candidatePositions[ offset + 1 ] - nextSpawn.y,
				candidatePositions[ offset + 2 ] - nextSpawn.z,
			);

		}
		gait.reset( gaitInput );
		currentFootPositions.set( gait.getView().footPositions );
		currentFootNormals.set( gait.getView().footNormals );
		previousFootPositions.set( currentFootPositions );
		previousFootNormals.set( currentFootNormals );

	}

	function reset( nextSpawn = spawn ) {

		elapsed = 0;
		dragging = false;
		body.setTranslation( vectorRecord( nextSpawn ), true );
		body.setRotation( { x: 0, y: 0, z: 0, w: 1 }, true );
		body.setLinvel( vectorRecord( ZERO ), true );
		body.setAngvel( vectorRecord( ZERO ), true );
		body.resetForces( true );
		body.resetTorques( true );
		world.propagateModifiedBodyPositionsToColliders();
		physics.resetAccumulator?.();
		previousPosition.copy( nextSpawn );
		currentPosition.copy( nextSpawn );
		previousQuaternion.identity();
		currentQuaternion.identity();
		initializeContacts( nextSpawn );
		syncVisual( 1 );

	}

	function setDebugVisible( visible ) {

		debug.group.visible = !! visible;

	}

	function dispose() {

		if ( body.isValid() ) world.removeRigidBody( body );
		model.traverse( ( object ) => {

			if ( ! object.isMesh ) return;
			object.geometry?.dispose();
			if ( Array.isArray( object.material ) ) {

				for ( const material of object.material ) material.dispose();

			} else object.material?.dispose();

		} );
		for ( const mesh of [ ...debug.feet, ...debug.bodyRoot.children ] ) {

			mesh.geometry?.dispose();
			mesh.material?.dispose();

		}
		debug.lines.geometry.dispose();
		debug.lines.material.dispose();
		scene.remove( visualRoot );
		scene.remove( debug.group );

	}

	reset( spawn );

	return {
		architecture: 'hybrid-root-ik',
		model,
		visualRoot,
		rig,
		parts: [ corePart ],
		partByBone: new Map( [ [ 'pelvis', corePart ], [ 'body', corePart ] ] ),
		feet,
		tail,
		pelvis: corePart,
		settings,
		command,
		debugGroup: debug.group,
		maxContactCount: 4,
		get supportNormal() {

			return averageSupportNormal;

		},
		get contactCount() {

			return contactCount;

		},
		setCommand( next ) {

			if ( next.move ) command.move.copy( next.move );
			if ( next.sprint !== undefined ) command.sprint = !! next.sprint;
			if ( next.release !== undefined ) command.release = !! next.release;
			if ( next.fullRagdoll !== undefined ) command.fullRagdoll = !! next.fullRagdoll;

		},
		setDragging( value ) {

			dragging = !! value;

		},
		beforeStep,
		afterStep,
		syncVisual,
		reset,
		setDebugVisible,
		dispose,
	};

}
