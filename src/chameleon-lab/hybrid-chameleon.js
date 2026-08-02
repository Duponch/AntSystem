import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { ChameleonProceduralGait } from '../chameleon-procedural-gait.js';
import {
	CHAMELEON_HEAD_LOOK,
	ChameleonHeadLookModel,
} from '../chameleon-head-look-model.js';
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
import {
	WholeBodyGaitModel,
	WHOLE_BODY_POSE,
} from './whole-body-gait-model.js';
import {
	PassiveTailPhysics,
	PASSIVE_TAIL_NODE_COUNT,
} from './passive-tail-physics.js';
import { PassiveTailVisualRig } from './passive-tail-visual-rig.js';
import {
	ANATOMICAL_POSITION,
	AnatomicalLimbSolver,
	AnatomicalSuspensionModel,
	SUSPENSION_OUTPUT,
} from './anatomical-limb-solver.js';
import {
	PassiveLimbRagdoll,
	PASSIVE_LIMB_COMPONENT_COUNT,
	PASSIVE_LIMB_NODE_COUNT,
} from './passive-limb-ragdoll.js';
import {
	DEFAULT_ARCADE_TURN_RATE,
	parallelTransportTangent,
} from './platformer-control-model.js';
import { SupportCohortModel } from './support-cohort-model.js';

const WORLD_UP = new THREE.Vector3( 0, 1, 0 );
const LOCAL_FORWARD = new THREE.Vector3( -1, 0, 0 );
const LOCAL_UP = new THREE.Vector3( 0, 1, 0 );
const LOCAL_SIDE = new THREE.Vector3( 0, 0, 1 );
const ZERO = new THREE.Vector3();
const IDENTITY_QUATERNION = new THREE.Quaternion();
const BODY_COLLISION_GROUP = chameleonCollisionGroups();
const REST_FLEXION_RETENTION = 0.84;
const MINIMUM_REST_FLEXION_RETENTION = 0.72;
// Maximum radial envelope of the preserved original tail around its authored
// twelve-segment medial line (rest-mesh audit, plus 3 mm collision margin).
// The source finishes in a broad spiral rather than a geometric taper, so a
// formula that shrinks towards zero necessarily lets the rendered skin enter
// the floor even while the XPBD centreline remains valid.
const TAIL_COLLISION_RADII_FALLBACK = new Float32Array( [
	0.148, 0.148, 0.097, 0.073, 0.066, 0.066, 0.069,
	0.079, 0.080, 0.089, 0.094, 0.094, 0.083,
] );

const LEG_SPECS = Object.freeze( [
	Object.freeze( { name: 'front.L', kind: 'front', side: 'L', girdle: 'front_girdleL', upper: 'front_upperL', lower: 'front_lowerL', palm: 'front_palmL', inner: 'front_digits_innerL', outer: 'front_digits_outerL' } ),
	Object.freeze( { name: 'front.R', kind: 'front', side: 'R', girdle: 'front_girdleR', upper: 'front_upperR', lower: 'front_lowerR', palm: 'front_palmR', inner: 'front_digits_innerR', outer: 'front_digits_outerR' } ),
	Object.freeze( { name: 'hind.L', kind: 'hind', side: 'L', girdle: 'hind_girdleL', upper: 'hind_upperL', lower: 'hind_lowerL', palm: 'hind_palmL', inner: 'hind_digits_innerL', outer: 'hind_digits_outerL' } ),
	Object.freeze( { name: 'hind.R', kind: 'hind', side: 'R', girdle: 'hind_girdleR', upper: 'hind_upperR', lower: 'hind_lowerR', palm: 'hind_palmR', inner: 'hind_digits_innerR', outer: 'hind_digits_outerR' } ),
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

function quaternionTorque(
	currentRotation, desired, angularVelocity, effectiveInertia,
	frequency, dampingRatio, maximum,
	target, current, error,
) {

	error.copy( desired ).multiply( current.copy( currentRotation ).invert() ).normalize();
	if ( error.w < 0 ) error.set( -error.x, -error.y, -error.z, -error.w );
	const angle = 2 * Math.acos( THREE.MathUtils.clamp( error.w, -1, 1 ) );
	const sinHalf = Math.sqrt( Math.max( 1e-10, 1 - error.w * error.w ) );
	const stiffness = effectiveInertia * frequency * frequency;
	const damping = 2 * effectiveInertia * frequency * Math.max( 0, dampingRatio );
	return clampVector(
		target.set( error.x / sinHalf, error.y / sinHalf, error.z / sinHalf )
			.multiplyScalar( angle * stiffness )
			.addScaledVector( angularVelocity, -damping ),
		maximum,
	);

}

function axisTwistTorque(
	axis, angleError, angularVelocity, desiredRate, effectiveInertia,
	frequency, dampingRatio, maximum, target,
) {

	const currentRate = angularVelocity.dot( axis );
	const stiffness = effectiveInertia * frequency * frequency;
	const damping = 2 * effectiveInertia * frequency * Math.max( 0, dampingRatio );
	const scalar = THREE.MathUtils.clamp(
		angleError * stiffness + ( desiredRate - currentRate ) * damping,
		-maximum,
		maximum,
	);
	return target.copy( axis ).multiplyScalar( scalar );

}

function desiredBodyQuaternion(
	current, supportNormal, movement, target,
	up, forward, xAxis, zAxis, matrix,
) {

	up.copy( supportNormal ).normalize();
	forward.copy( movement ).projectOnPlane( up );
	if ( forward.lengthSq() < 1e-6 )
		forward.copy( LOCAL_FORWARD ).applyQuaternion( current ).projectOnPlane( up );
	if ( forward.lengthSq() < 1e-6 )
		forward.set( 0, 0, -1 ).projectOnPlane( up );
	forward.normalize();
	xAxis.copy( forward ).multiplyScalar( -1 );
	zAxis.copy( xAxis ).cross( up ).normalize();
	up.crossVectors( zAxis, xAxis ).normalize();
	return target.setFromRotationMatrix( matrix.makeBasis( xAxis, up, zAxis ) ).normalize();

}

class StableVisualRig {

	constructor( model ) {

		this.model = model;
		model.updateMatrixWorld( true );
		this.bones = [];
		this.byName = new Map();
		model.traverse( ( object ) => {

			if ( ! object.isBone ) return;
			this.bones.push( object );
			this.byName.set( object.name, object );

		} );
		this.pelvis = this._require( 'pelvis' );
		this.spine01 = this._require( 'spine_01' );
		this.spine02 = this._require( 'spine_02' );
		this.neck = this._require( 'neck' );
		this.head = this._require( 'head' );
		this.rest = this.bones.map( ( bone ) => ( {
			bone,
			position: bone.position.clone(),
			quaternion: bone.quaternion.clone(),
			scale: bone.scale.clone(),
		} ) );
		this.activeRest = this.rest.filter(
			( pose ) => ! pose.bone.name.startsWith( 'tail_' ),
		);
		const modelWorldQuaternion = model.getWorldQuaternion( new THREE.Quaternion() );
		const inverseModelWorldQuaternion = modelWorldQuaternion.clone().invert();
		this.legs = LEG_SPECS.map( ( spec ) => {

			const girdle = this._require( spec.girdle );
			const upper = this._require( spec.upper );
			const lower = this._require( spec.lower );
			const palm = this._require( spec.palm );
			const inner = this._require( spec.inner );
			const outer = this._require( spec.outer );
			const limbBones = [ girdle, upper, lower, palm, inner, outer ];
			const exactLengths = limbBones.map( ( bone ) => {

				const length = Number( bone.userData?.rest_length );
				return Number.isFinite( length ) && length > 0 ? length : undefined;

			} );
			const patchCenter = palm.userData?.contact_patch_center_rest;
			const patchNormal = palm.userData?.contact_patch_normal_rest;
			const hasExactPatch = Array.isArray( patchCenter ) && patchCenter.length >= 3
				&& Array.isArray( patchNormal ) && patchNormal.length >= 3;
			const contactPatchLocal = new THREE.Vector3();
			const contactPatchWorld = new THREE.Vector3();
			const exactNormalWorld = new THREE.Vector3();
			if ( hasExactPatch ) {

				// Blender publishes the patches in armature-local Z-up space.
				// glTF maps it to Three.js as (x, z, -y).  Converting through the
				// scene and palm matrices keeps this exact even if the asset root is
				// later translated, rotated or scaled.
				contactPatchLocal.set( patchCenter[ 0 ], patchCenter[ 2 ], -patchCenter[ 1 ] );
				model.localToWorld( contactPatchLocal );
				contactPatchWorld.copy( contactPatchLocal );
				palm.worldToLocal( contactPatchLocal );
				exactNormalWorld.set( patchNormal[ 0 ], patchNormal[ 2 ], -patchNormal[ 1 ] )
					.applyQuaternion( modelWorldQuaternion ).normalize();

			} else {

				palm.getWorldPosition( contactPatchWorld );
				inner.getWorldPosition( new THREE.Vector3() ).add(
					outer.getWorldPosition( new THREE.Vector3() ),
				).multiplyScalar( 0.5 ).add( contactPatchWorld ).multiplyScalar( 0.5 );
				contactPatchLocal.copy( contactPatchWorld );
				palm.worldToLocal( contactPatchLocal );

			}
			const contactNormalLocals = new Map();
			for ( const bone of [ palm, inner, outer ] ) {

				const worldQuaternion = bone.getWorldQuaternion( new THREE.Quaternion() );
				if ( hasExactPatch ) {

					const localNormal = exactNormalWorld.clone().applyQuaternion( worldQuaternion.invert() );
					// Keep the complete authored outsole direction.  The irregular
					// zygodactyl digits descend towards their pads, therefore the true
					// contact normal legitimately contains a component along the bone's
					// local +Y axis.  Erasing it made the distal pads stand on an edge as
					// soon as their medial axes were recentered inside the actual mesh.
					if ( localNormal.lengthSq() < 1e-8 ) localNormal.set( 0, 0, 1 );
					contactNormalLocals.set( bone, localNormal.normalize() );

				} else {

					const localXWorld = new THREE.Vector3( 1, 0, 0 ).applyQuaternion( worldQuaternion );
					const localZWorld = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( worldQuaternion );
					const useX = Math.abs( localXWorld.dot( WORLD_UP ) )
						>= Math.abs( localZWorld.dot( WORLD_UP ) );
					const selectedWorld = useX ? localXWorld : localZWorld;
					const sign = selectedWorld.dot( WORLD_UP ) < 0 ? -1 : 1;
					contactNormalLocals.set(
						bone,
						new THREE.Vector3( useX ? sign : 0, 0, useX ? 0 : sign ),
					);

				}

			}
			const palmNormalLocal = contactNormalLocals.get( palm );
			// The exported patch normal points out of the sole. A supporting
			// surface points the other way, so the solver's contact-frame normal is
			// the opposite vector (outsole down, ground normal up).
			const palmSupportNormalLocal = palmNormalLocal.clone().multiplyScalar( -1 );
			const restParentWorldQuaternion = girdle.parent.getWorldQuaternion( new THREE.Quaternion() );
			const inverseRestParentWorld = restParentWorldQuaternion.clone().invert();
			const parentRestToModel = inverseModelWorldQuaternion.clone()
				.multiply( restParentWorldQuaternion ).invert();
			const restGirdleDirection = new THREE.Vector3( 0, 1, 0 )
				.applyQuaternion( girdle.getWorldQuaternion( new THREE.Quaternion() ) )
				.applyQuaternion( inverseModelWorldQuaternion ).normalize();
			const restPalmDirection = new THREE.Vector3( 0, 1, 0 )
				.applyQuaternion( palm.getWorldQuaternion( new THREE.Quaternion() ) ).normalize();
			const restSupportNormalWorld = palmSupportNormalLocal.clone()
				.applyQuaternion( palm.getWorldQuaternion( new THREE.Quaternion() ) ).normalize();
			const restPalmTangentWorld = restPalmDirection.clone()
				.projectOnPlane( restSupportNormalWorld ).normalize();
			const restPalmBinormalWorld = new THREE.Vector3()
				.crossVectors( restSupportNormalWorld, restPalmTangentWorld ).normalize();
			const frameComponents = ( vector ) => [
				vector.dot( restPalmTangentWorld ),
				vector.dot( restSupportNormalWorld ),
				vector.dot( restPalmBinormalWorld ),
			];
			const wristWorld = palm.getWorldPosition( new THREE.Vector3() );
			const contactOffset = frameComponents( contactPatchWorld.clone().sub( wristWorld ) );
			const palmAxisFrame = frameComponents( restPalmDirection );
			const innerAxisFrame = frameComponents(
				new THREE.Vector3( 0, 1, 0 )
					.applyQuaternion( inner.getWorldQuaternion( new THREE.Quaternion() ) ).normalize(),
			);
			const outerAxisFrame = frameComponents(
				new THREE.Vector3( 0, 1, 0 )
					.applyQuaternion( outer.getWorldQuaternion( new THREE.Quaternion() ) ).normalize(),
			);
			const restPalmTangentModel = restPalmTangentWorld.clone()
				.applyQuaternion( inverseModelWorldQuaternion ).normalize();
			const sideSign = spec.side === 'L' ? -1 : 1;
			const restGirdle = [
				-restGirdleDirection.x,
				restGirdleDirection.y,
				restGirdleDirection.z * sideSign,
			];
			const restPalm = [
				-restPalmTangentModel.x,
				restPalmTangentModel.y,
				restPalmTangentModel.z * sideSign,
			];
			// Preserve the exported flexion plane.  A generic "outward + up"
			// pole makes the analytic IK look plausible in isolation but rotates
			// the elbow/knee away from the actual bent mesh as soon as it runs.
			const shoulderWorld = upper.getWorldPosition( new THREE.Vector3() );
			const socketWorld = girdle.getWorldPosition( new THREE.Vector3() );
			const elbowWorld = lower.getWorldPosition( new THREE.Vector3() );
			const restReachDistance = shoulderWorld.distanceTo( wristWorld );
			const restSupportReach = socketWorld.distanceTo( contactPatchWorld );
			const restFlexion = elbowWorld.clone().sub( shoulderWorld ).normalize()
				.angleTo( wristWorld.clone().sub( elbowWorld ).normalize() );
			const restReach = wristWorld.clone().sub( shoulderWorld ).normalize();
			const restPoleParentLocal = elbowWorld.clone().sub( shoulderWorld )
				.addScaledVector(
					restReach,
					-elbowWorld.clone().sub( shoulderWorld ).dot( restReach ),
				);
			if ( restPoleParentLocal.lengthSq() < 1e-10 )
				restPoleParentLocal.copy( restSupportNormalWorld ).cross( restReach );
			restPoleParentLocal.normalize().applyQuaternion( inverseRestParentWorld );
			return {
				...spec,
				girdle,
				upper,
				lower,
				palm,
				inner,
				outer,
				solver: new AnatomicalLimbSolver( {
					kind: spec.kind,
					side: spec.side,
					contactClearance: 0.006,
					lengths: exactLengths,
					contactOffset,
					restGirdle,
					palmAxisFrame,
					innerAxisFrame,
					outerAxisFrame,
				} ),
				contactPatchLocal,
				restPalm,
				restPalmTangentBody: restPalmTangentModel.clone(),
				parentRestToModel,
				restPoleParentLocal,
				restReach: restReachDistance,
				restSupportReach,
				restFlexion,
				joints: [ girdle, upper, lower ],
				passiveBones: [ girdle, upper, lower, palm ],
				contactNormalLocals,
				solvedQuaternions: new Map( [ girdle, upper, lower, palm, inner, outer ].map(
					( bone ) => [ bone, bone.quaternion.clone() ],
				) ),
				restQuaternions: new Map( [
					[ girdle, girdle.quaternion.clone() ],
					[ upper, upper.quaternion.clone() ],
					[ lower, lower.quaternion.clone() ],
					[ palm, palm.quaternion.clone() ],
					[ inner, inner.quaternion.clone() ],
					[ outer, outer.quaternion.clone() ],
				] ),
			};

		} );
		this._jointWorld = new THREE.Vector3();
		this._palmWorld = new THREE.Vector3();
		this._jointWorldQuaternion = new THREE.Quaternion();
		this._parentWorldQuaternion = new THREE.Quaternion();
		this._candidate = new THREE.Quaternion();
		this._delta = new THREE.Quaternion();
		this._bounded = new THREE.Quaternion();
		this._target = new THREE.Vector3();
		this._desiredNormal = new THREE.Vector3();
		this._soleTargetNormal = new THREE.Vector3();
		this._modelWorldQuaternion = new THREE.Quaternion();
		this._legFrameWorldQuaternion = new THREE.Quaternion();
		this._legParentWorldQuaternion = new THREE.Quaternion();
		this._axisWorld = new THREE.Vector3();
		this._bodyCandidate = new THREE.Quaternion();
		this._bodyForward = new THREE.Vector3();
		this._bodyUp = new THREE.Vector3();
		this._bodySide = new THREE.Vector3();
		this._palmDirection = new THREE.Vector3();
		this._poleVector = new THREE.Vector3();
		this._segmentStart = new THREE.Vector3();
		this._segmentEnd = new THREE.Vector3();
		this._segmentDirection = new THREE.Vector3();
		this._segmentX = new THREE.Vector3();
		this._segmentZ = new THREE.Vector3();
		this._restWorld = new THREE.Quaternion();
		this._restAxis = new THREE.Vector3();
		this._surfaceCurrent = new THREE.Vector3();
		this._surfaceTarget = new THREE.Vector3();
		this._surfaceCross = new THREE.Vector3();
		this._twist = new THREE.Quaternion();
		this._suspensionOffset = new THREE.Vector3();
		this._inverseModelWorld = new THREE.Quaternion();
		this._basis = new THREE.Matrix4();
		this._digitRoot = new THREE.Vector3();
		this._innerWorld = new THREE.Vector3();
		this._outerWorld = new THREE.Vector3();
		this._solveInput = Object.seal( {
			socket: this._jointWorld,
			contact: this._target,
			contactNormal: this._desiredNormal,
			palmDirection: this._palmDirection,
			bodyForward: this._bodyForward,
			bodyUp: this._bodyUp,
			poleVector: this._poleVector,
			palmYaw: 0,
			stride: 0,
			abduction: 0,
			girdleElevation: 0,
			girdleReachWeight: 0,
			minimumFlexion: 0.42,
			maximumFlexion: 2.62,
			girdleSwingLimit: 1.08,
			dt: 1 / 120,
		} );
		this._pelvisRestPosition = this.pelvis.position.clone();

	}

	_rotateInModelSpace( bone, modelAxis, angle ) {

		if ( Math.abs( angle ) < 1e-7 ) return;
		bone.updateWorldMatrix( true, false );
		this.model.getWorldQuaternion( this._modelWorldQuaternion );
		this._axisWorld.copy( modelAxis ).applyQuaternion( this._modelWorldQuaternion ).normalize();
		this._delta.setFromAxisAngle( this._axisWorld, angle );
		bone.getWorldQuaternion( this._jointWorldQuaternion );
		this._bodyCandidate.copy( this._delta ).multiply( this._jointWorldQuaternion );
		bone.parent.getWorldQuaternion( this._parentWorldQuaternion ).invert();
		bone.quaternion.copy(
			this._bodyCandidate.premultiply( this._parentWorldQuaternion ),
		).normalize();
		bone.updateWorldMatrix( false, true );

	}

	applyWholeBodyPose( pose, weight = 1, suspensionPose = null, suspensionScale = 1,
		landingCompression = 0, jumpPose = null ) {

		if ( ! pose || pose.length <= WHOLE_BODY_POSE.MOTION_WEIGHT ) return;
		const influence = THREE.MathUtils.clamp( weight, 0, 1 );
		const suspensionInfluence = THREE.MathUtils.clamp( suspensionScale, 0, 2 ) * influence;
		if ( influence <= 0 ) return;
		const preload = THREE.MathUtils.clamp( jumpPose?.preloadCompression ?? 0, 0, 1 );
		const extension = THREE.MathUtils.clamp( jumpPose?.takeoffExtension ?? 0, 0, 1 );
		const airborneTuck = THREE.MathUtils.clamp( jumpPose?.airborneTuck ?? 0, 0, 1 );
		const forwardLean = THREE.MathUtils.clamp( jumpPose?.forwardLean ?? 0, 0, 1 );
		this.pelvis.position.copy( this._pelvisRestPosition );
		this.pelvis.position.y += pose[ WHOLE_BODY_POSE.PELVIS_BOB ] * influence;
		this.pelvis.position.y -= THREE.MathUtils.clamp( landingCompression, 0, 1 )
			* 0.045 * influence;
		// The charged jump remains an anatomical pose layered over the same bounded
		// IK: compression lowers the girdles while the claws stay planted, take-off
		// extends the trunk, and the airborne envelope folds the limbs softly.
		this.pelvis.position.y += ( extension * 0.042 - preload * 0.072
			- airborneTuck * 0.018 ) * influence;
		this.pelvis.position.z += pose[ WHOLE_BODY_POSE.SUPPORT_SHIFT ] * influence;
		if ( suspensionPose && suspensionPose.length >= SUSPENSION_OUTPUT.SIZE ) {

			this.model.getWorldQuaternion( this._inverseModelWorld ).invert();
			this._suspensionOffset.set(
				suspensionPose[ SUSPENSION_OUTPUT.OFFSET_X ],
				suspensionPose[ SUSPENSION_OUTPUT.OFFSET_Y ],
				suspensionPose[ SUSPENSION_OUTPUT.OFFSET_Z ],
			).applyQuaternion( this._inverseModelWorld ).multiplyScalar( 0.42 * suspensionInfluence );
			this.pelvis.position.add( this._suspensionOffset );

		}
		this._rotateInModelSpace(
			this.pelvis, LOCAL_UP, pose[ WHOLE_BODY_POSE.PELVIS_YAW ] * influence,
		);
		this._rotateInModelSpace(
			this.pelvis, LOCAL_FORWARD, pose[ WHOLE_BODY_POSE.PELVIS_ROLL ] * influence,
		);
		this._rotateInModelSpace(
			this.pelvis, LOCAL_SIDE, -forwardLean * 0.12 * influence,
		);
		if ( suspensionPose && suspensionPose.length >= SUSPENSION_OUTPUT.SIZE ) {

			this._rotateInModelSpace(
				this.pelvis, LOCAL_SIDE,
				-suspensionPose[ SUSPENSION_OUTPUT.PITCH ] * 0.55 * suspensionInfluence,
			);
			this._rotateInModelSpace(
				this.pelvis, LOCAL_FORWARD,
				suspensionPose[ SUSPENSION_OUTPUT.ROLL ] * 0.55 * suspensionInfluence,
			);

		}
		this._rotateInModelSpace(
			this.spine01, LOCAL_UP, pose[ WHOLE_BODY_POSE.CHEST_YAW ] * 0.56 * influence,
		);
		this._rotateInModelSpace(
			this.spine02, LOCAL_UP, pose[ WHOLE_BODY_POSE.CHEST_YAW ] * 0.44 * influence,
		);
		this._rotateInModelSpace(
			this.spine01, LOCAL_FORWARD, pose[ WHOLE_BODY_POSE.CHEST_ROLL ] * influence,
		);
		this._rotateInModelSpace(
			this.spine02, LOCAL_SIDE, pose[ WHOLE_BODY_POSE.CHEST_PITCH ] * influence,
		);
		this._rotateInModelSpace(
			this.spine01, LOCAL_SIDE, -forwardLean * 0.10 * influence,
		);
		this._rotateInModelSpace(
			this.spine02, LOCAL_SIDE, -forwardLean * 0.08 * influence,
		);
		this._rotateInModelSpace(
			this.neck, LOCAL_UP, pose[ WHOLE_BODY_POSE.NECK_YAW ] * influence,
		);
		this._rotateInModelSpace(
			this.neck, LOCAL_SIDE, pose[ WHOLE_BODY_POSE.NECK_PITCH ] * influence,
		);
		this._rotateInModelSpace(
			this.head, LOCAL_UP, pose[ WHOLE_BODY_POSE.HEAD_YAW ] * influence,
		);
		this._rotateInModelSpace(
			this.head, LOCAL_SIDE, pose[ WHOLE_BODY_POSE.HEAD_PITCH ] * influence,
		);

		for ( let index = 0; index < this.legs.length; index ++ ) {

			const leg = this.legs[ index ];
			const side = index === 0 || index === 2 ? 1 : -1;
			const stride = pose[ WHOLE_BODY_POSE.STRIDE_0 + index ] * influence;
			const jumpLift = preload * 0.12 + airborneTuck * 0.16;
			const jumpFlex = preload * 0.54 + airborneTuck * 0.42 - extension * 0.24;
			const lift = ( pose[ WHOLE_BODY_POSE.LIFT_0 + index ] + jumpLift ) * influence;
			const flex = ( pose[ WHOLE_BODY_POSE.FLEX_0 + index ] + jumpFlex ) * influence;
			this._rotateInModelSpace( leg.girdle, LOCAL_UP, -stride * side * 0.58 );
			this._rotateInModelSpace( leg.upper, LOCAL_UP, -stride * side * 0.52 );
			this._rotateInModelSpace( leg.girdle, LOCAL_FORWARD, lift * 0.58 );
			this._rotateInModelSpace( leg.upper, LOCAL_FORWARD, lift * 0.54 );
			this._rotateInModelSpace( leg.lower, LOCAL_FORWARD, flex * side * 0.76 );

		}
		this.model.updateMatrixWorld( true );

	}

	applyHeadLookPose( pose, weight = 1 ) {

		if ( ! pose || pose.length <= CHAMELEON_HEAD_LOOK.HEAD_PITCH ) return;
		const influence = THREE.MathUtils.clamp( weight, 0, 1 );
		if ( influence <= 0 ) return;
		this._rotateInModelSpace(
			this.neck, LOCAL_UP,
			pose[ CHAMELEON_HEAD_LOOK.NECK_YAW ] * influence,
		);
		this._rotateInModelSpace(
			this.neck, LOCAL_SIDE,
			-pose[ CHAMELEON_HEAD_LOOK.NECK_PITCH ] * influence,
		);
		this._rotateInModelSpace(
			this.head, LOCAL_UP,
			pose[ CHAMELEON_HEAD_LOOK.HEAD_YAW ] * influence,
		);
		this._rotateInModelSpace(
			this.head, LOCAL_SIDE,
			-pose[ CHAMELEON_HEAD_LOOK.HEAD_PITCH ] * influence,
		);
		this.model.updateMatrixWorld( true );

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

	restoreActive() {

		for ( const pose of this.activeRest ) {

			pose.bone.position.copy( pose.position );
			pose.bone.quaternion.copy( pose.quaternion );
			pose.bone.scale.copy( pose.scale );

		}
		this.model.updateMatrixWorld( true );

	}

	resetDynamics() {

		for ( const leg of this.legs ) {

			leg.solver.resetPole();
			for ( const [ bone, quaternion ] of leg.solvedQuaternions )
				quaternion.copy( leg.restQuaternions.get( bone ) );

		}

	}

	writePalmPositions( target ) {

		for ( let index = 0; index < this.legs.length; index ++ ) {

			const leg = this.legs[ index ];
			this._palmWorld.copy( leg.contactPatchLocal );
			leg.palm.localToWorld( this._palmWorld );
			target[ index * 3 ] = this._palmWorld.x;
			target[ index * 3 + 1 ] = this._palmWorld.y;
			target[ index * 3 + 2 ] = this._palmWorld.z;

		}
		return target;

	}

	writeSocketPositions( target ) {

		for ( let index = 0; index < this.legs.length; index ++ ) {

			this.legs[ index ].girdle.getWorldPosition( this._jointWorld );
			target[ index * 3 ] = this._jointWorld.x;
			target[ index * 3 + 1 ] = this._jointWorld.y;
			target[ index * 3 + 2 ] = this._jointWorld.z;

		}
		return target;

	}

	writePassiveLimbPositions( target ) {

		if ( ! target || target.length < PASSIVE_LIMB_COMPONENT_COUNT )
			throw new TypeError( `passive limb target must contain ${ PASSIVE_LIMB_COMPONENT_COUNT } values` );
		for ( let index = 0; index < this.legs.length; index ++ ) {

			const leg = this.legs[ index ];
			const bones = [ leg.girdle, leg.upper, leg.lower, leg.palm ];
			for ( let node = 0; node < bones.length; node ++ ) {

				bones[ node ].getWorldPosition( this._jointWorld );
				const offset = ( index * PASSIVE_LIMB_NODE_COUNT + node ) * 3;
				target[ offset ] = this._jointWorld.x;
				target[ offset + 1 ] = this._jointWorld.y;
				target[ offset + 2 ] = this._jointWorld.z;

			}
			this._palmWorld.copy( leg.contactPatchLocal );
			leg.palm.localToWorld( this._palmWorld );
			const soleOffset = ( index * PASSIVE_LIMB_NODE_COUNT + 4 ) * 3;
			target[ soleOffset ] = this._palmWorld.x;
			target[ soleOffset + 1 ] = this._palmWorld.y;
			target[ soleOffset + 2 ] = this._palmWorld.z;

		}
		return target;

	}

	_boundJoint( leg, joint, candidate, role = null ) {

		role ||= joint === leg.girdle ? 'girdle'
			: joint === leg.upper ? 'upper' : joint === leg.lower ? 'lower' : 'palm';
		return clampQuaternionFromRest(
			leg.restQuaternions.get( joint ),
			candidate,
			HYBRID_JOINT_LIMITS[ role ],
			this._bounded,
		);

	}

	_applyWorldFrame( leg, bone, frames, offset, role, influence ) {

		this._jointWorldQuaternion.set(
			frames[ offset ], frames[ offset + 1 ], frames[ offset + 2 ], frames[ offset + 3 ],
		).normalize();
		bone.parent.getWorldQuaternion( this._parentWorldQuaternion ).invert();
		this._candidate.copy( this._jointWorldQuaternion )
			.premultiply( this._parentWorldQuaternion ).normalize();
		const bounded = this._boundJoint( leg, bone, this._candidate, role );
		bone.quaternion.slerpQuaternions(
			leg.restQuaternions.get( bone ), bounded, influence,
		);
		bone.updateWorldMatrix( false, true );

	}

	_applySegment( leg, bone, positions, startOffset, endOffset, surfaceNormal, role, influence,
		bounded = true, fromRest = true ) {

		this._segmentStart.fromArray( positions, startOffset );
		this._segmentEnd.fromArray( positions, endOffset );
		this._segmentDirection.subVectors( this._segmentEnd, this._segmentStart );
		if ( this._segmentDirection.lengthSq() < 1e-10 ) return;
		this._segmentDirection.normalize();
		bone.parent.getWorldQuaternion( this._parentWorldQuaternion );
		this._restWorld.copy( this._parentWorldQuaternion )
			.multiply( leg.restQuaternions.get( bone ) ).normalize();
		this._restAxis.copy( LOCAL_UP ).applyQuaternion( this._restWorld ).normalize();
		this._delta.setFromUnitVectors( this._restAxis, this._segmentDirection );
		this._jointWorldQuaternion.copy( this._delta ).multiply( this._restWorld ).normalize();
		const contactNormalLocal = leg.contactNormalLocals.get( bone );
		if ( contactNormalLocal && surfaceNormal?.lengthSq?.() > 1e-10 ) {

			this._surfaceCurrent.copy( contactNormalLocal )
				.applyQuaternion( this._jointWorldQuaternion )
				.projectOnPlane( this._segmentDirection );
			this._surfaceTarget.copy( surfaceNormal ).projectOnPlane( this._segmentDirection );
			if ( this._surfaceCurrent.lengthSq() > 1e-10 && this._surfaceTarget.lengthSq() > 1e-10 ) {

				this._surfaceCurrent.normalize();
				this._surfaceTarget.normalize();
				const sine = this._surfaceCross.crossVectors(
					this._surfaceCurrent, this._surfaceTarget,
				).dot( this._segmentDirection );
				const cosine = THREE.MathUtils.clamp(
					this._surfaceCurrent.dot( this._surfaceTarget ), -1, 1,
				);
				this._twist.setFromAxisAngle( this._segmentDirection, Math.atan2( sine, cosine ) );
				this._jointWorldQuaternion.premultiply( this._twist ).normalize();

			}

		}
		this._parentWorldQuaternion.invert();
		this._candidate.copy( this._jointWorldQuaternion )
			.premultiply( this._parentWorldQuaternion ).normalize();
		const desired = bounded ? this._boundJoint( leg, bone, this._candidate, role ) : this._candidate;
		if ( fromRest && bounded ) {

			const previous = leg.solvedQuaternions.get( bone );
			// This layer writes an exact fixed-step target. Temporal filtering belongs
			// to FixedRigPoseBuffer so IK never gets filtered twice and rendering can
			// stay a pure interpolation of immutable snapshots.
			previous.copy( desired );
			bone.quaternion.slerpQuaternions(
				leg.restQuaternions.get( bone ), previous, influence,
			);

		}
		else if ( fromRest ) bone.quaternion.slerpQuaternions(
			leg.restQuaternions.get( bone ), desired, influence,
		);
		else bone.quaternion.slerp( desired, influence );
		bone.updateWorldMatrix( false, true );

	}

	solve( footTargets, footNormals, wholeBodyPose = null, weight = 1,
		suspensionPose = null, renderDt = 1 / 120, suspensionScale = 1,
		landingCompression = 0, jumpPose = null ) {

		const influence = THREE.MathUtils.clamp( weight, 0, 1 );
		const boundedRenderDt = THREE.MathUtils.clamp( renderDt, 1 / 1000, 1 / 20 );
		if ( influence <= 0 ) {

			this.model.updateMatrixWorld( true );
			return;

		}
		this.applyWholeBodyPose(
			wholeBodyPose, influence, suspensionPose, suspensionScale, landingCompression, jumpPose,
		);
		for ( let index = 0; index < this.legs.length; index ++ ) {

			const offset = index * 3;
			const leg = this.legs[ index ];
			// Parent-bone axes follow the exported spine, not the animal's model
			// axes. Remove that authored rest orientation before deriving the
			// forward/up/right frame. At rest this is exactly the model frame; when
			// the trunk bends it carries only the parent's anatomical delta.
			leg.girdle.parent.getWorldQuaternion( this._legParentWorldQuaternion );
			this._legFrameWorldQuaternion.copy( this._legParentWorldQuaternion )
				.multiply( leg.parentRestToModel );
			this._bodyForward.copy( LOCAL_FORWARD )
				.applyQuaternion( this._legFrameWorldQuaternion ).normalize();
			this._bodyUp.copy( LOCAL_UP )
				.applyQuaternion( this._legFrameWorldQuaternion ).normalize();
			this._bodySide.copy( LOCAL_SIDE )
				.applyQuaternion( this._legFrameWorldQuaternion ).normalize();
			this._target.set(
				footTargets[ offset ], footTargets[ offset + 1 ], footTargets[ offset + 2 ],
			);
			this._desiredNormal.set(
				footNormals[ offset ], footNormals[ offset + 1 ], footNormals[ offset + 2 ],
			);
			if ( this._desiredNormal.lengthSq() < 1e-8 ) this._desiredNormal.copy( this._bodyUp );
			else this._desiredNormal.normalize();
			// Preserve each exported zygodactyl orientation exactly; left/right
			// asymmetries in the scanned mesh are intentional and shorten the wrist
			// reach compared with a generic front/back approximation.
			this._palmDirection.copy( this._bodyForward ).multiplyScalar( leg.restPalm[ 0 ] )
				.addScaledVector( this._bodyUp, leg.restPalm[ 1 ] )
				.addScaledVector(
					this._bodySide, leg.restPalm[ 2 ] * ( leg.side === 'L' ? -1 : 1 ),
				)
				.projectOnPlane( this._desiredNormal );
			if ( this._palmDirection.lengthSq() < 1e-8 )
				this._palmDirection.copy( this._bodyForward ).projectOnPlane( this._desiredNormal );
			this._palmDirection.normalize();
			leg.girdle.getWorldPosition( this._jointWorld );
			this._solveInput.stride = wholeBodyPose
				? THREE.MathUtils.clamp( wholeBodyPose[ WHOLE_BODY_POSE.STRIDE_0 + index ] * 1.45, -1, 1 )
				: 0;
			const flexionDrive = wholeBodyPose
				? THREE.MathUtils.clamp( wholeBodyPose[ WHOLE_BODY_POSE.FLEX_0 + index ], 0, 1 )
				: 0;
			const liftDrive = wholeBodyPose
				? THREE.MathUtils.clamp( Math.abs(
					wholeBodyPose[ WHOLE_BODY_POSE.LIFT_0 + index ],
				), 0, 1 )
				: 0;
			const strideDrive = Math.abs( this._solveInput.stride );
			this._solveInput.abduction = strideDrive * ( leg.kind === 'front' ? 0.16 : 0.20 )
				+ flexionDrive * 0.08 + liftDrive * ( leg.kind === 'front' ? 0.38 : 0.27 );
			this._solveInput.girdleElevation = liftDrive;
			this._solveInput.girdleReachWeight = THREE.MathUtils.clamp(
				0.09 + strideDrive * 0.16 + flexionDrive * 0.10 - liftDrive * 0.08,
				0.06, 0.34,
			);
			this._poleVector.copy( leg.restPoleParentLocal )
				.applyQuaternion( this._legParentWorldQuaternion )
				.addScaledVector(
					this._desiredNormal,
					liftDrive * ( leg.kind === 'front' ? 4.8 : 1.10 ),
				).normalize();
			this._solveInput.minimumFlexion = Math.max(
				leg.solver.preset.minimumFlexion,
				leg.restFlexion * MINIMUM_REST_FLEXION_RETENTION,
			)
				+ flexionDrive * ( leg.kind === 'front' ? 1.12 : 1.28 )
				+ liftDrive * ( leg.kind === 'front' ? 0.34 : 0.42 );
			this._solveInput.maximumFlexion = leg.solver.preset.maximumFlexion;
			this._solveInput.girdleSwingLimit = leg.solver.preset.girdleSwingLimit;
			this._solveInput.dt = boundedRenderDt;
			const solved = leg.solver.solve( this._solveInput );
			this._soleTargetNormal.copy( this._desiredNormal ).multiplyScalar( -1 );
			this._applySegment(
				leg, leg.girdle, solved.positions,
				ANATOMICAL_POSITION.SOCKET, ANATOMICAL_POSITION.SHOULDER,
				this._desiredNormal, 'girdle', influence,
			);
			this._applySegment(
				leg, leg.upper, solved.positions,
				ANATOMICAL_POSITION.SHOULDER, ANATOMICAL_POSITION.ELBOW,
				this._desiredNormal, 'upper', influence,
			);
			this._applySegment(
				leg, leg.lower, solved.positions,
				ANATOMICAL_POSITION.ELBOW, ANATOMICAL_POSITION.WRIST,
				this._desiredNormal, 'lower', influence,
			);
			this._applySegment(
				leg, leg.palm, solved.positions,
				ANATOMICAL_POSITION.WRIST, ANATOMICAL_POSITION.PALM_END,
				this._soleTargetNormal, 'palm', influence,
			);
			this._applySegment(
				leg, leg.inner, solved.positions,
				ANATOMICAL_POSITION.PALM_END, ANATOMICAL_POSITION.DIGIT_INNER,
				this._soleTargetNormal, 'palm', influence,
			);
			this._applySegment(
				leg, leg.outer, solved.positions,
				ANATOMICAL_POSITION.PALM_END, ANATOMICAL_POSITION.DIGIT_OUTER,
				this._soleTargetNormal, 'palm', influence,
			);

		}
		this.model.updateMatrixWorld( true );

	}

	applyPassive( positions, weight = 1, boundedRecovery = false ) {

		const influence = THREE.MathUtils.clamp( weight, 0, 1 );
		this.model.getWorldQuaternion( this._modelWorldQuaternion );
		this._bodyForward.copy( LOCAL_FORWARD ).applyQuaternion( this._modelWorldQuaternion ).normalize();
		for ( let index = 0; index < this.legs.length; index ++ ) {

			const leg = this.legs[ index ];
			const base = index * PASSIVE_LIMB_NODE_COUNT * 3;
			for ( let segment = 0; segment < 4; segment ++ ) {

				const bone = leg.passiveBones[ segment ];
				this._applySegment(
					leg, bone, positions, base + segment * 3, base + ( segment + 1 ) * 3,
					this._bodyForward, segment === 0 ? 'girdle' : segment === 1 ? 'upper'
						: segment === 2 ? 'lower' : 'palm', influence, boundedRecovery, false,
				);

			}

		}
		this.model.updateMatrixWorld( true );

	}

}

/**
 * Fixed-step authority for every local bone transform.
 *
 * IK is evaluated once per physics tick. Rendering only interpolates two
 * immutable snapshots, so neither display refresh rate nor duplicate renders
 * can advance the gait. All vectors/quaternions are allocated once here.
 */
class FixedRigPoseBuffer {

	constructor( rig, response = 32, maximumAngularSpeed = 5.8,
		maximumAngularAcceleration = 120 ) {

		this.rig = rig;
		// Tail bones have their own XPBD interpolation and are applied after this
		// buffer. Excluding them avoids two redundant quaternion passes per render.
		this.bones = rig.bones.filter( ( bone ) => ! bone.name.startsWith( 'tail_' ) );
		this.response = response;
		this.maximumAngularSpeed = maximumAngularSpeed;
		this.maximumAngularAcceleration = maximumAngularAcceleration;
		this.previousQuaternions = this.bones.map( ( bone ) => bone.quaternion.clone() );
		this.currentQuaternions = this.bones.map( ( bone ) => bone.quaternion.clone() );
		this.targetQuaternions = this.bones.map( ( bone ) => bone.quaternion.clone() );
		this.previousPositions = this.bones.map( ( bone ) => bone.position.clone() );
		this.currentPositions = this.bones.map( ( bone ) => bone.position.clone() );
		this.targetPositions = this.bones.map( ( bone ) => bone.position.clone() );
		this.angularVelocities = new Float32Array( this.bones.length * 3 );
		this.positionBoneIndex = this.bones.indexOf( rig.pelvis );
		this.linearVelocities = new Float32Array( 3 );
		this._inverseQuaternion = new THREE.Quaternion();
		this._errorQuaternion = new THREE.Quaternion();
		this._incrementQuaternion = new THREE.Quaternion();
		this._axis = new THREE.Vector3();

	}

	resetFromRig() {

		for ( let index = 0; index < this.bones.length; index ++ ) {

			const bone = this.bones[ index ];
			this.previousQuaternions[ index ].copy( bone.quaternion );
			this.currentQuaternions[ index ].copy( bone.quaternion );
			this.targetQuaternions[ index ].copy( bone.quaternion );
			this.previousPositions[ index ].copy( bone.position );
			this.currentPositions[ index ].copy( bone.position );
			this.targetPositions[ index ].copy( bone.position );

		}
		this.angularVelocities.fill( 0 );
		this.linearVelocities.fill( 0 );
		return this;

	}

	commitSolvedPose( dt, snap = false ) {

		const fixedDt = THREE.MathUtils.clamp( dt, 1 / 1000, 1 / 20 );
		const frequencySquared = this.response * this.response;
		const criticalDamping = 2 * this.response;
		for ( let index = 0; index < this.bones.length; index ++ ) {

			const bone = this.bones[ index ];
			const previousQuaternion = this.previousQuaternions[ index ];
			const currentQuaternion = this.currentQuaternions[ index ];
			const previousPosition = this.previousPositions[ index ];
			const currentPosition = this.currentPositions[ index ];
			previousQuaternion.copy( currentQuaternion );
			previousPosition.copy( currentPosition );
			this.targetQuaternions[ index ].copy( bone.quaternion );
			this.targetPositions[ index ].copy( bone.position );
			const velocityOffset = index * 3;
			if ( snap ) {

				currentQuaternion.copy( this.targetQuaternions[ index ] );
				currentPosition.copy( this.targetPositions[ index ] );
				for ( let lane = 0; lane < 3; lane ++ ) {

					this.angularVelocities[ velocityOffset + lane ] = 0;

				}
				if ( index === this.positionBoneIndex ) this.linearVelocities.fill( 0 );

			} else {

				// Parent-space shortest-arc error. Persisting angular velocity turns the
				// pose filter into a true critically damped servo: it cannot reverse a
				// limb in one tick as a positional slerp can.
				this._inverseQuaternion.copy( currentQuaternion ).invert();
				this._errorQuaternion.multiplyQuaternions(
					this.targetQuaternions[ index ], this._inverseQuaternion,
				).normalize();
				if ( this._errorQuaternion.w < 0 ) this._errorQuaternion.set(
					-this._errorQuaternion.x, -this._errorQuaternion.y,
					-this._errorQuaternion.z, -this._errorQuaternion.w,
				);
				const sine = Math.hypot(
					this._errorQuaternion.x,
					this._errorQuaternion.y,
					this._errorQuaternion.z,
				);
				const angle = 2 * Math.atan2( sine, Math.max( 0, this._errorQuaternion.w ) );
				const errorScale = sine > 1e-8 ? angle / sine : 2;
				let velocityX = this.angularVelocities[ velocityOffset ];
				let velocityY = this.angularVelocities[ velocityOffset + 1 ];
				let velocityZ = this.angularVelocities[ velocityOffset + 2 ];
				let accelerationX = this._errorQuaternion.x * errorScale * frequencySquared
					- velocityX * criticalDamping;
				let accelerationY = this._errorQuaternion.y * errorScale * frequencySquared
					- velocityY * criticalDamping;
				let accelerationZ = this._errorQuaternion.z * errorScale * frequencySquared
					- velocityZ * criticalDamping;
				const acceleration = Math.hypot( accelerationX, accelerationY, accelerationZ );
				if ( acceleration > this.maximumAngularAcceleration ) {

					const scale = this.maximumAngularAcceleration / acceleration;
					accelerationX *= scale;
					accelerationY *= scale;
					accelerationZ *= scale;

				}
				velocityX += accelerationX * fixedDt;
				velocityY += accelerationY * fixedDt;
				velocityZ += accelerationZ * fixedDt;
				const angularSpeed = Math.hypot( velocityX, velocityY, velocityZ );
				if ( angularSpeed > this.maximumAngularSpeed ) {

					const scale = this.maximumAngularSpeed / angularSpeed;
					velocityX *= scale;
					velocityY *= scale;
					velocityZ *= scale;

				}
				this.angularVelocities[ velocityOffset ] = velocityX;
				this.angularVelocities[ velocityOffset + 1 ] = velocityY;
				this.angularVelocities[ velocityOffset + 2 ] = velocityZ;
				const incrementAngle = Math.hypot( velocityX, velocityY, velocityZ ) * fixedDt;
				if ( incrementAngle > 1e-9 ) {

					this._axis.set( velocityX, velocityY, velocityZ ).normalize();
					this._incrementQuaternion.setFromAxisAngle( this._axis, incrementAngle );
					currentQuaternion.premultiply( this._incrementQuaternion ).normalize();

				}

				// The few translated rig bones use the same persistent-velocity principle.
				// A bounded linear servo prevents suspension/bob offsets from acquiring a
				// separate first-order twitch while remaining allocation-free.
				if ( index === this.positionBoneIndex ) {

					for ( let lane = 0; lane < 3; lane ++ ) {

						const coordinate = lane === 0 ? 'x' : lane === 1 ? 'y' : 'z';
						let linearVelocity = this.linearVelocities[ lane ];
						let linearAcceleration = (
							this.targetPositions[ index ][ coordinate ] - currentPosition[ coordinate ]
						) * frequencySquared - linearVelocity * criticalDamping;
						linearAcceleration = THREE.MathUtils.clamp( linearAcceleration, -8, 8 );
						linearVelocity = THREE.MathUtils.clamp(
							linearVelocity + linearAcceleration * fixedDt, -0.8, 0.8,
						);
						this.linearVelocities[ lane ] = linearVelocity;
						currentPosition[ coordinate ] += linearVelocity * fixedDt;

					}

				} else currentPosition.copy( this.targetPositions[ index ] );

			}
			bone.quaternion.copy( currentQuaternion );
			bone.position.copy( currentPosition );

		}
		this.rig.model.updateMatrixWorld( true );
		return this;

	}

	applyInterpolated( alpha ) {

		const t = THREE.MathUtils.clamp( alpha, 0, 1 );
		for ( let index = 0; index < this.bones.length; index ++ ) {

			const bone = this.bones[ index ];
			bone.quaternion.slerpQuaternions(
				this.previousQuaternions[ index ], this.currentQuaternions[ index ], t,
			).normalize();
			if ( index === this.positionBoneIndex ) bone.position.lerpVectors(
				this.previousPositions[ index ], this.currentPositions[ index ], t,
			);

		}
		this.rig.model.updateMatrixWorld( true );
		return this;

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
	const activeRigPose = new FixedRigPoseBuffer( rig, 32 );
	for ( const leg of rig.legs ) leg.shoulderBodyOffset = leg.upper
		.getWorldPosition( new THREE.Vector3() ).sub( spawn );
	const tailVisualRig = new PassiveTailVisualRig( model );
	const tailInitialPositions = tailVisualRig.captureRestWorldPositions();
	const tailRootBodyOffset = new THREE.Vector3(
		tailInitialPositions[ 0 ] - spawn.x,
		tailInitialPositions[ 1 ] - spawn.y,
		tailInitialPositions[ 2 ] - spawn.z,
	);
	const tailKinematicBodyOffsets = new Float32Array(
		( tailVisualRig.physicsKinematicBoneCount + 1 ) * 3,
	);
	for ( let index = 0; index < tailKinematicBodyOffsets.length; index += 3 ) {

		tailKinematicBodyOffsets[ index ] = tailInitialPositions[ index ] - spawn.x;
		tailKinematicBodyOffsets[ index + 1 ] = tailInitialPositions[ index + 1 ] - spawn.y;
		tailKinematicBodyOffsets[ index + 2 ] = tailInitialPositions[ index + 2 ] - spawn.z;

	}
	const authoredTailRadii = tailVisualRig.metadata.tail_collision_node_radii;
	const validTailRadii = Array.isArray( authoredTailRadii )
		&& authoredTailRadii.length === PASSIVE_TAIL_NODE_COUNT
		&& authoredTailRadii.every( ( radius ) => Number.isFinite( radius ) && radius > 0 );
	const tailRadii = new Float32Array(
		validTailRadii ? authoredTailRadii : TAIL_COLLISION_RADII_FALLBACK,
	);
	const tailPhysics = new PassiveTailPhysics( {
		fixedDt: physics.fixedDt || 1 / 120,
		maxSubsteps: 1,
		solverIterations: 7,
		stretchCompliance: 0,
		bendCompliance: 5e-6,
		bendComplianceProfile: [ 0.04, 0.12, 0.35, 0.70, 1, 1, 1, 1, 1, 1, 1 ],
		damping: 3.2,
		collisionFriction: 0.68,
		collisionStaticFrictionSpeed: 0.055,
		maxSpeed: 8,
		gravity: physics.world.gravity,
		initialPositions: tailInitialPositions,
		radii: tailRadii,
		kinematicSegmentCount: tailVisualRig.physicsKinematicBoneCount,
	} );
	const tailKinematicAnchors = new Float32Array( tailPhysics.kinematicNodeCount * 3 );
	for ( let node = tailPhysics.kinematicNodeCount; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

		const ratio = node / ( PASSIVE_TAIL_NODE_COUNT - 1 );
		tailPhysics.inverseMasses[ node ] = THREE.MathUtils.lerp( 0.38, 1, ratio );

	}
	const passiveLimbInitialPositions = new Float32Array( PASSIVE_LIMB_COMPONENT_COUNT );
	rig.writePassiveLimbPositions( passiveLimbInitialPositions );
	const passiveLimbBodyOffsets = new Float32Array( PASSIVE_LIMB_COMPONENT_COUNT );
	const passiveLimbMuscleTargets = new Float32Array( PASSIVE_LIMB_COMPONENT_COUNT );
	for ( let offset = 0; offset < PASSIVE_LIMB_COMPONENT_COUNT; offset += 3 ) {

		passiveLimbBodyOffsets[ offset ] = passiveLimbInitialPositions[ offset ] - spawn.x;
		passiveLimbBodyOffsets[ offset + 1 ] = passiveLimbInitialPositions[ offset + 1 ] - spawn.y;
		passiveLimbBodyOffsets[ offset + 2 ] = passiveLimbInitialPositions[ offset + 2 ] - spawn.z;

	}
	const passiveLimbBodyCapsules = new Float32Array( [
		spawn.x - 0.3, spawn.y + 0.04, spawn.z,
		spawn.x + 0.14, spawn.y + 0.04, spawn.z, 0.16,
		spawn.x - 0.38, spawn.y + 0.055, spawn.z,
		spawn.x - 0.38, spawn.y + 0.055, spawn.z, 0.18,
	] );
	const passiveLimbPhysics = new PassiveLimbRagdoll( {
		fixedDt: physics.fixedDt || 1 / 120,
		// Evaluated only for the selected/held animal: the added local accuracy
		// has no cost in the normal locomotion hot path.
		solverIterations: 14,
		damping: 2.65,
		stretchCompliance: 0,
		bendCompliance: 8e-8,
		collisionFriction: 0.42,
		maxSpeed: 8,
		gravity: physics.world.gravity,
		initialPositions: passiveLimbInitialPositions,
		minimumBend: 0.1,
		maximumBend: 2.52,
		muscleTone: 0.18,
		bodyCapsules: passiveLimbBodyCapsules,
		selfCollision: true,
		selfCollisionMargin: 0.004,
	} );
	const passiveLimbRootAnchors = new Float32Array( 12 );

	const { RAPIER, world } = physics;
	const body = world.createRigidBody(
		RAPIER.RigidBodyDesc.dynamic()
			.setTranslation( spawn.x, spawn.y, spawn.z )
			.setLinearDamping( 0.7 )
			// The torso is intentionally a single inexpensive proxy. A little more
			// angular damping prevents the proxy from storing roll energy between two
			// alternating claw supports without making the visual rig feel inert.
			.setAngularDamping( 1.85 )
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
	// Both colliders and their masses are final here. Cache the scalar controller
	// inertia once; Rapier's wrapper accessors must not allocate in the 120 Hz path.
	const principalInertia = body.principalInertia();
	const effectiveAngularInertia = Math.max(
		principalInertia.x, principalInertia.y, principalInertia.z, 0.002,
	);
	physics.registerBody?.( body, { collider: torsoCollider } );

	const corePart = { name: 'body', body, collider: torsoCollider, colliders: [ torsoCollider, headCollider ] };
	const footNames = LEG_SPECS.map( ( spec ) => spec.palm );
	const feet = footNames.map( ( name, order ) => ( {
		order,
		part: { name, body, collider: torsoCollider },
		anchor: null,
		_anchorStore: new THREE.Vector3(),
		_visualAnchorStore: new THREE.Vector3(),
		_candidateSurface: null,
		_candidateCollider: null,
		_lockedSurface: null,
		_lockedCollider: null,
		normal: new THREE.Vector3( 0, 1, 0 ),
		surface: null,
		collider: null,
		load: 0,
		state: 'reaching',
	} ) );
	const tail = Object.freeze( {
		name: 'tail_original',
		deformationMode: 'passive-xpbd-original-mesh',
		physicsDofs: PASSIVE_TAIL_NODE_COUNT - 1,
		nodeCount: PASSIVE_TAIL_NODE_COUNT,
		solver: tailPhysics,
		visualRig: tailVisualRig,
	} );

	const settings = {
		motorStrength: 1,
		motorDamping: 1,
		moveSpeed: 0.68,
		sprintMultiplier: 1.75,
		moveForce: 13,
		turnTorque: 2.6,
		gripEnabled: true,
		gripStrength: 32,
		gripStiffness: 175,
		gripDamping: 8,
		gripReach: 0.42,
		rightingStrength: 1.15,
		surfaceCommitTime: 0.85,
		gaitFrequency: 0.92,
		animationSpeed: 1,
		stepLength: 0.19,
		stepHeight: 0.09,
		strideAmplitude: 0.64,
		limbLift: 0.43,
		jointFlex: 0.82,
		bodyMotion: 1,
		suspension: 1,
		limbMuscleTone: 0.18,
		tailDamping: 3.2,
		tailFlexibility: 0.46,
		tailCollisionScale: 1,
		tailGravity: 1,
	};
	const command = {
		move: new THREE.Vector3(),
		facing: new THREE.Vector3( -1, 0, 0 ),
		sourceNormal: new THREE.Vector3( 0, 1, 0 ),
		sprint: false,
		turning: 0,
		release: false,
		fullRagdoll: false,
	};
	const gait = new ChameleonProceduralGait( {
		fixedStep: physics.fixedDt || 1 / 120,
		maxSubsteps: 1,
		stepDistance: settings.stepLength,
		stepHeight: settings.stepHeight,
		minSwingDuration: 0.09,
		maxSwingDuration: 0.24,
		minTargetError: 0.018,
		bodyClearance: 0,
	} );
	const wholeBodyGait = new WholeBodyGaitModel( {
		// Fast enough to follow a 90 ms swing, but below the frequency at which a
		// newly activated shoulder lane can move visibly in one 120 Hz tick.
		responseFrequency: 8.5,
		dampingRatio: 1.05,
	} );
	const headLook = new ChameleonHeadLookModel( {
		seed: 0x7f4a7c15,
		responseFrequency: 3.8,
		weightResponseFrequency: 4.2,
		neckYawSpeed: 0.62,
		neckPitchSpeed: 0.52,
		headYawSpeed: 0.80,
		headPitchSpeed: 0.60,
	} );
	const suspension = new AnatomicalSuspensionModel( {
		responseFrequency: 5.2,
		dampingRatio: 1.05,
		maximumOffset: 0.055,
		maximumAngle: 0.13,
	} );
	const wholeBodyInput = Object.seal( {
		gaitView: gait.getView(),
		speed: 0,
		strideAmplitude: settings.strideAmplitude,
		limbLift: settings.limbLift,
		jointFlex: settings.jointFlex,
		bodyMotion: settings.bodyMotion,
		idleWeight: 1,
		attentionTime: 0,
		attentionSeed: 0.73,
	} );
	const headLookInput = Object.seal( {
		targetYaw: 0,
		targetPitch: 0,
		targetWeight: 0,
		idleWeight: 1,
	} );
	const lookTarget = new THREE.Vector3();
	let lookTargetWeight = 0;
	const candidatePositions = new Float32Array( 12 );
	const candidateNormals = new Float32Array( 12 );
	const previousFootPositions = new Float32Array( 12 );
	const currentFootPositions = new Float32Array( 12 );
	const previousFootNormals = new Float32Array( 12 );
	const currentFootNormals = new Float32Array( 12 );
	const renderFootPositions = new Float32Array( 12 );
	const nominalFootPositions = new Float32Array( 12 );
	const suspensionSocketPositions = new Float32Array( 12 );
	// Suspension measures socket-to-contact distances, so its authored reference
	// must use that exact metric too. Mixing it with shoulder-to-wrist reach made
	// the visual suspension saturate even on a perfectly flat authored stance.
	const preferredLimbReach = new Float32Array(
		rig.legs.map( ( leg ) => leg.restSupportReach ),
	);
	const activeContacts = new Uint8Array( 4 );
	const candidateActiveContacts = new Uint8Array( 4 );
	const supportReachDistances = new Float32Array( 4 );
	const supportMaximumReaches = new Float32Array( 4 );
	const supportColliderHandles = new Float64Array( 4 );
	const supportTopologyFlags = new Uint8Array( 4 );
	const supportRejectTicks = new Uint8Array( 4 );
	const supportRejectCooldown = new Uint8Array( 4 );
	const supportCohort = new SupportCohortModel( {
		reachSlack: 0.018,
		enterSeamDistance: 0.29,
		exitSeamDistance: 0.39,
		sameSurfaceNormalDot: 0.7,
	} );
	for ( let foot = 0; foot < 4; foot ++ ) {

		const leg = rig.legs[ foot ];
		const lengths = leg.solver.lengths;
		const authoredMaximum = lengths[ 0 ] + lengths[ 1 ] + lengths[ 2 ]
			+ Math.hypot(
				leg.solver.contactOffset[ 0 ],
				leg.solver.contactOffset[ 1 ],
				leg.solver.contactOffset[ 2 ],
			);
		supportMaximumReaches[ foot ] = Math.max(
			leg.restSupportReach * 1.18,
			authoredMaximum * 0.98,
		);

	}
	const wasFootSwinging = new Uint8Array( 4 );
	const targetFootSurfaces = new Array( 4 ).fill( null );
	const targetFootColliders = new Array( 4 ).fill( null );
	const suspensionInput = Object.seal( {
		socketPositions: suspensionSocketPositions,
		contactPositions: currentFootPositions,
		contactNormals: currentFootNormals,
		active: activeContacts,
		preferredReach: preferredLimbReach,
	} );
	const bodyToFootOffsets = Array.from( { length: 4 }, () => new THREE.Vector3() );
	const bodyToSocketOffsets = Array.from( { length: 4 }, () => new THREE.Vector3() );
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
	const bodyForward = new THREE.Vector3( -1, 0, 0 );
	const renderPosition = new THREE.Vector3();
	const renderQuaternion = new THREE.Quaternion();
	const averageSupportNormal = new THREE.Vector3( 0, 1, 0 );
	const targetSupportNormal = new THREE.Vector3( 0, 1, 0 );
	const branchSupportAxis = new THREE.Vector3();
	const branchSupportRadial = new THREE.Vector3();
	const tempPosition = new THREE.Vector3();
	const tempQuaternion = new THREE.Quaternion();
	const tempInverseQuaternion = new THREE.Quaternion();
	const tempVelocity = new THREE.Vector3();
	const tempDirection = new THREE.Vector3();
	const tempRight = new THREE.Vector3();
	const candidateNominal = new THREE.Vector3();
	const probeMovement = new THREE.Vector3();
	const probeOrigin = new THREE.Vector3();
	const probeBestPoint = new THREE.Vector3();
	const probeBestNormal = new THREE.Vector3();
	const probeTransitionPoint = new THREE.Vector3();
	const probeTransitionNormal = new THREE.Vector3();
	const lockedProjectionPoint = new THREE.Vector3();
	const lockedProjectionNormal = new THREE.Vector3();
	const probeDirections = Array.from( { length: 11 }, () => new THREE.Vector3() );
	const probeRay = new RAPIER.Ray( { x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 } );
	const desiredRoot = new THREE.Vector3();
	const rootSuggestion = new THREE.Vector3();
	const rootOffset = new THREE.Vector3();
	const rootError = new THREE.Vector3();
	const rootReachCorrection = new THREE.Vector3();
	const rootReachShoulder = new THREE.Vector3();
	const rootReachWrist = new THREE.Vector3();
	const rootReachTangent = new THREE.Vector3();
	const rootReachBinormal = new THREE.Vector3();
	const rootReachContactOffset = new THREE.Vector3();
	const rootReachVector = new THREE.Vector3();
	const rootReachNormal = new THREE.Vector3();
	const supportForce = new THREE.Vector3();
	const clawForce = new THREE.Vector3();
	const clawPoint = new THREE.Vector3();
	const bodyCentreOfMass = new THREE.Vector3();
	const clawLever = new THREE.Vector3();
	const gravityVector = new THREE.Vector3();
	const desiredMovement = new THREE.Vector3();
	const transportedMovement = new THREE.Vector3();
	const transportedFacing = new THREE.Vector3();
	const surfaceTransportScratch = {
		axis: new THREE.Vector3(),
		firstCross: new THREE.Vector3(),
		secondCross: new THREE.Vector3(),
	};
	const tangentVelocity = new THREE.Vector3();
	const desiredRotation = new THREE.Quaternion();
	const desiredSwingRotation = new THREE.Quaternion();
	const torqueCurrent = new THREE.Quaternion();
	const torqueError = new THREE.Quaternion();
	const torqueVector = new THREE.Vector3();
	const swingTorque = new THREE.Vector3();
	const yawTorque = new THREE.Vector3();
	const swingAngularVelocity = new THREE.Vector3();
	const currentSurfaceForward = new THREE.Vector3();
	const yawCross = new THREE.Vector3();
	const supportInducedTorque = new THREE.Vector3();
	const supportMoment = new THREE.Vector3();
	const currentForwardWorld = new THREE.Vector3();
	const headLookOrigin = new THREE.Vector3();
	const headLookDirection = new THREE.Vector3();
	const headLookUp = new THREE.Vector3();
	const headLookSide = new THREE.Vector3();
	const angularVelocity = new THREE.Vector3();
	const desiredUp = new THREE.Vector3();
	const desiredForward = new THREE.Vector3();
	const desiredXAxis = new THREE.Vector3();
	const desiredZAxis = new THREE.Vector3();
	const desiredMatrix = new THREE.Matrix4();
	const supportFrame = {
		count: 0,
		coherentCount: 0,
		centroid: { x: 0, y: 0, z: 0 },
		normal: { x: 0, y: 1, z: 0 },
	};
	const supportForceRecord = { x: 0, y: 0, z: 0 };
	const clawForceRecord = { x: 0, y: 0, z: 0 };
	const clawPointRecord = { x: 0, y: 0, z: 0 };
	const appliedForceRecord = { x: 0, y: 0, z: 0 };
	const appliedTorqueRecord = { x: 0, y: 0, z: 0 };
	const reacquireNormal = new THREE.Vector3( 0, 1, 0 );
	const currentBodyUp = new THREE.Vector3();
	const rightingMovement = new THREE.Vector3();
	const rightingForce = new THREE.Vector3();
	const rootForceInput = {
		error: rootError,
		velocity: tempVelocity,
		mass: 1,
		frequency: 8,
		dampingRatio: 1,
		maximumAcceleration: 30,
	};
	const tailRootAnchor = new THREE.Vector3();
	const tailKinematicPoint = new THREE.Vector3();
	const tailCollisionNormalFallback = new THREE.Vector3();
	const passiveLimbRootPoint = new THREE.Vector3();
	const passiveLimbMusclePoint = new THREE.Vector3();
	const passiveLimbCapsulePoint = new THREE.Vector3();
	const collisionBodyPosition = new THREE.Vector3();
	const collisionBodyQuaternion = new THREE.Quaternion();
	const collisionBodyInverse = new THREE.Quaternion();
	const collisionLocalPoint = new THREE.Vector3();
	const collisionLocalProjection = new THREE.Vector3();
	const collisionWorldProjection = new THREE.Vector3();
	const collisionWorldNormal = new THREE.Vector3();
	const tailSurfaceProjectors = [];
	const surfaceProjectorByCollider = new Map();
	for ( const [ colliderHandle, surface ] of physics.surfaceByCollider?.entries?.() ?? [] ) {

		const collider = world.getCollider( colliderHandle );
		if ( ! collider ) continue;
		const centre = collider.translation();
		let boundRadius = Infinity;
		let oneSidedGround = false;
		let halfX = 0;
		let halfZ = 0;
		let topY = 0;
		const shapeType = collider.shapeType();
		if ( shapeType === RAPIER.ShapeType.Cuboid ) {

			const half = collider.halfExtents();
			boundRadius = Math.hypot( half.x, half.y, half.z );
			oneSidedGround = surface?.kind === 'ground' || surface?.kind === 'soil';
			if ( oneSidedGround ) {

				halfX = half.x;
				halfZ = half.z;
				topY = centre.y + half.y;

			}

		} else if ( shapeType === RAPIER.ShapeType.Cylinder
			|| shapeType === RAPIER.ShapeType.Capsule
			|| shapeType === RAPIER.ShapeType.Cone ) {

			boundRadius = Math.hypot( collider.radius(), collider.halfHeight() )
				+ ( shapeType === RAPIER.ShapeType.Capsule ? collider.radius() : 0 );

		} else if ( shapeType === RAPIER.ShapeType.Ball ) {

			boundRadius = collider.radius();

		} else {

			const vertices = collider.vertices?.();
			if ( vertices?.length >= 3 ) {

				boundRadius = 0;
				for ( let offset = 0; offset < vertices.length; offset += 3 )
					boundRadius = Math.max( boundRadius, Math.hypot(
						vertices[ offset ], vertices[ offset + 1 ], vertices[ offset + 2 ],
					) );

			}

		}
		const projectedHalfHeight = collider.halfHeight?.();
		const projector = Object.freeze( {
			collider,
			surface,
			x: centre.x,
			y: centre.y,
			z: centre.z,
			boundRadius,
			oneSidedGround,
			halfX,
			halfZ,
			topY,
			halfHeight: Number.isFinite( projectedHalfHeight )
				? projectedHalfHeight : 0,
		} );
		tailSurfaceProjectors.push( projector );
		surfaceProjectorByCollider.set( collider.handle, projector );

	}
	function branchProjectorFor( colliderHandle ) {

		let projector = surfaceProjectorByCollider.get( colliderHandle );
		if ( projector ) return projector;
		const surface = physics.surfaceByCollider?.get( colliderHandle );
		if ( surface?.kind !== 'branch' ) return null;
		const collider = world.getCollider( colliderHandle );
		if ( ! collider || ! collider.isValid?.() ) return null;
		const centre = collider.translation();
		const halfHeight = collider.halfHeight?.();
		projector = Object.freeze( {
			collider,
			surface,
			x: centre.x,
			y: centre.y,
			z: centre.z,
			halfHeight: Number.isFinite( halfHeight ) ? halfHeight : 0,
		} );
		surfaceProjectorByCollider.set( colliderHandle, projector );
		return projector;

	}
	let contactCount = 0;
	let candidateContactCount = 0;
	let coherentContactMask = 0;
	let dragging = false;
	let passiveLimbActive = false;
	let passiveLimbBlend = 0;
	let supportReacquireSeconds = 0;
	let pendingSupportReset = false;
	let reacquireSurface = null;
	let reacquireCollider = null;
	let reacquireState = 'attached';
	let reacquireOwnerAge = 0;
	let reacquireVentralAlignment = 1;
	let elapsed = 0;
	let landingCompression = 0;
	const jumpPose = Object.seal( {
		preloadCompression: 0,
		takeoffExtension: 0,
		airborneTuck: 0,
		forwardLean: 0,
		muscleCompliance: 0,
	} );
	let wasSupportReleased = false;
	let staticGripSeconds = 0;
	let staticGripLocked = false;
	let excludedProbeColliderHandle = -1;

	function acceptsProbeCollider( collider ) {

		return collider.handle !== excludedProbeColliderHandle
			&& physics.surfaceByCollider?.has( collider.handle ) === true;

	}

	function releaseStaticGrip( wake = true ) {

		staticGripSeconds = 0;
		staticGripLocked = false;
		if ( wake && body.isSleeping?.() ) body.wakeUp();

	}

	function changesFacingIntent( facing ) {

		const facingLengthSquared = facing.x * facing.x + facing.y * facing.y + facing.z * facing.z;
		const previousLengthSquared = command.facing.lengthSq();
		if ( facingLengthSquared <= 1e-10 || previousLengthSquared <= 1e-10 ) return false;
		const cosine = ( facing.x * command.facing.x + facing.y * command.facing.y
			+ facing.z * command.facing.z ) / Math.sqrt(
			facingLengthSquared * previousLengthSquared,
		);
		// About 1.15 degrees: enough hysteresis for solver noise, but less than a
		// single full-strength 120 Hz arcade steering tick.
		return cosine < 0.9998;

	}

	function clearSupportLocks() {

		releaseStaticGrip( false );
		contactCount = 0;
		candidateContactCount = 0;
		activeContacts.fill( 0 );
		candidateActiveContacts.fill( 0 );
		supportRejectTicks.fill( 0 );
		supportRejectCooldown.fill( 0 );
		coherentContactMask = 0;
		targetFootSurfaces.fill( null );
		targetFootColliders.fill( null );
		for ( const foot of feet ) {

			foot._lockedSurface = null;
			foot._lockedCollider = null;
			foot._candidateSurface = null;
			foot._candidateCollider = null;
			foot.surface = null;
			foot.collider = null;
			foot.load = 0;
			foot.state = 'released';

		}

	}

	function armSupportReacquisition() {

		reacquireSurface = null;
		reacquireCollider = null;
		readVector( body.linvel(), tempVelocity );
		const supportSpeed = tempVelocity.dot( averageSupportNormal );
		probeMovement.copy( tempVelocity )
			.addScaledVector( averageSupportNormal, -supportSpeed );
		const ballisticSideImpact = probeMovement.lengthSq()
			> Math.max( 0.36, supportSpeed * supportSpeed * 0.55 );
		if ( ballisticSideImpact ) reacquireNormal.copy( tempVelocity ).multiplyScalar( -1 );
		else reacquireNormal.copy( averageSupportNormal );
		if ( reacquireNormal.lengthSq() < 1e-8 ) reacquireNormal.copy( WORLD_UP );
		else reacquireNormal.normalize();
		supportReacquireSeconds = 2.5;
		pendingSupportReset = true;
		reacquireState = 'seeking';
		reacquireOwnerAge = 0;

	}

	function selectReacquireSurface() {

		if ( reacquireCollider || reacquireState !== 'seeking' ) return false;
		readVector( body.linvel(), tempVelocity );
		let bestScore = -Infinity;
		let bestHandle = Infinity;
		let bestSurface = null;
		let bestCollider = null;
		let bestNormalX = 0;
		let bestNormalY = 1;
		let bestNormalZ = 0;
		// Reacquisition is impact-authoritative: only Rapier manifolds may claim
		// an owner. This prevents the old 0.88 m remote "magnet" and makes corner
		// choice deterministic instead of depending on broad-phase callback order.
		for ( const coreCollider of [ torsoCollider, headCollider ] ) {

			world.contactPairsWith( coreCollider, ( other ) => {

				const surface = physics.surfaceByCollider?.get( other.handle );
				if ( ! surface?.clawEligible ) return;
				world.contactPair( coreCollider, other, ( manifold, flipped ) => {

					const solverContacts = manifold.numSolverContacts();
					const geometricContacts = manifold.numContacts();
					if ( solverContacts <= 0 && geometricContacts <= 0 ) return;
					const rawNormal = manifold.normal();
					let nx = flipped ? rawNormal.x : -rawNormal.x;
					let ny = flipped ? rawNormal.y : -rawNormal.y;
					let nz = flipped ? rawNormal.z : -rawNormal.z;
					const normalLength = Math.hypot( nx, ny, nz );
					if ( normalLength <= 1e-8 ) return;
					nx /= normalLength; ny /= normalLength; nz /= normalLength;
					const point = solverContacts > 0 ? manifold.solverContactPoint( 0 ) : null;
					const centre = coreCollider.translation();
					let px = point?.x ?? centre.x - nx * 0.16;
					let py = point?.y ?? centre.y - ny * 0.16;
					let pz = point?.z ?? centre.z - nz * 0.16;
					if ( nx * ( centre.x - px ) + ny * ( centre.y - py )
						+ nz * ( centre.z - pz ) < 0 ) {

						nx = -nx; ny = -ny; nz = -nz;

					}
					let impulse = 0;
					let penetration = 0;
					for ( let contact = 0; contact < geometricContacts; contact ++ ) {

						impulse += Math.abs( manifold.contactImpulse( contact ) );
						penetration = Math.max( penetration, -manifold.contactDist( contact ) );

					}
					const approach = Math.max( 0,
						-( tempVelocity.x * nx + tempVelocity.y * ny + tempVelocity.z * nz ),
					);
					const surfaceGrip = Number.isFinite( surface.gripStrengthScale )
						? surface.gripStrengthScale : 1;
					const score = impulse * 3.5 + approach * 0.45 + penetration * 12
						+ solverContacts * 0.035 + surfaceGrip * 0.01;
					if ( score < bestScore - 1e-8
						|| ( Math.abs( score - bestScore ) <= 1e-8 && other.handle >= bestHandle ) )
						return;
					bestScore = score;
					bestHandle = other.handle;
					bestSurface = surface;
					bestCollider = other;
					bestNormalX = nx; bestNormalY = ny; bestNormalZ = nz;

				} );

			} );

		}
		if ( ! bestCollider ) return false;
		reacquireSurface = bestSurface;
		reacquireCollider = bestCollider;
		reacquireNormal.set( bestNormalX, bestNormalY, bestNormalZ ).normalize();
		reacquireState = 'righting';
		reacquireOwnerAge = 0;
		supportReacquireSeconds = Math.max(
			1.25, THREE.MathUtils.clamp( settings.surfaceCommitTime, 0.2, 2 ),
		);
		return true;

	}

	function projectCandidateToReacquireSurface( nominal, contact ) {

		if ( supportReacquireSeconds <= 0 || ! reacquireSurface || ! reacquireCollider ) return null;
		if ( reacquireState === 'righting' || reacquireVentralAlignment < 0.42 ) return null;
		const projection = reacquireCollider.projectPoint( nominal, false );
		if ( ! projection ) return null;
		let nx = projection.isInside
			? projection.point.x - nominal.x : nominal.x - projection.point.x;
		let ny = projection.isInside
			? projection.point.y - nominal.y : nominal.y - projection.point.y;
		let nz = projection.isInside
			? projection.point.z - nominal.z : nominal.z - projection.point.z;
		const distance = Math.hypot( nx, ny, nz );
		if ( distance > settings.gripReach * 1.12 ) return null;
		if ( distance > 1e-8 ) {

			nx /= distance; ny /= distance; nz /= distance;

		} else {

			nx = reacquireNormal.x; ny = reacquireNormal.y; nz = reacquireNormal.z;

		}
		lockedProjectionNormal.set( nx, ny, nz ).normalize();
		if ( lockedProjectionNormal.dot( reacquireNormal ) < 0.72 ) return null;
		const bodyPosition = body.translation();
		if ( ( projection.point.x - bodyPosition.x ) * currentBodyUp.x
			+ ( projection.point.y - bodyPosition.y ) * currentBodyUp.y
			+ ( projection.point.z - bodyPosition.z ) * currentBodyUp.z > 0.08 ) return null;
		contact.anchor = contact._anchorStore.set(
			projection.point.x, projection.point.y, projection.point.z,
		).addScaledVector( lockedProjectionNormal, 0.008 );
		contact.normal.copy( lockedProjectionNormal );
		contact._candidateSurface = reacquireSurface;
		contact._candidateCollider = reacquireCollider;
		return contact;

	}

	function surfaceProbe( nominal, preferredNormal, movement, contact ) {

		const reach = Math.max( 0.1, settings.gripReach );
		const currentRotation = readQuaternion( body.rotation(), tempQuaternion );
		probeDirections[ 0 ].copy( preferredNormal ).multiplyScalar( -1 );
		probeDirections[ 1 ].copy( movement );
		probeDirections[ 2 ].copy( movement ).multiplyScalar( -1 );
		probeDirections[ 3 ].copy( movement.lengthSq() > 1e-6 ? movement : LOCAL_FORWARD )
			.cross( preferredNormal ).normalize();
		probeDirections[ 4 ].copy( probeDirections[ 3 ] ).multiplyScalar( -1 );
		for ( let axis = 0; axis < PROBE_AXES.length; axis ++ )
			probeDirections[ 5 + axis ].copy( PROBE_AXES[ axis ] ).applyQuaternion( currentRotation );
		let bestScore = Infinity;
		let bestSurface = null;
		let bestCollider = null;
		let transitionScore = Infinity;
		let transitionDistance = Infinity;
		let transitionSurface = null;
		let transitionCollider = null;
		for ( let directionIndex = 0; directionIndex < probeDirections.length; directionIndex ++ ) {

			const rawDirection = probeDirections[ directionIndex ];
			if ( rawDirection.lengthSq() < 1e-8 ) continue;
			const direction = rawDirection.normalize();
			const lift = reach * 0.48;
			probeOrigin.copy( nominal ).addScaledVector( direction, -lift );
			const advancingIntoNeighbour = directionIndex === 1
				&& movement.lengthSq() > 1e-8 && contact._lockedCollider;
			if ( advancingIntoNeighbour ) probeOrigin.addScaledVector(
				preferredNormal, reach * ( contact.order < 2 ? 0.62 : 0.42 ),
			);
			probeRay.origin.x = probeOrigin.x;
			probeRay.origin.y = probeOrigin.y;
			probeRay.origin.z = probeOrigin.z;
			probeRay.dir.x = direction.x;
			probeRay.dir.y = direction.y;
			probeRay.dir.z = direction.z;
			excludedProbeColliderHandle = advancingIntoNeighbour
				? contact._lockedCollider.handle : -1;
			const hit = world.castRayAndGetNormal(
				probeRay,
				reach * 1.55,
				false,
				undefined,
				undefined,
				undefined,
				body,
				acceptsProbeCollider,
			);
			if ( ! hit || ! isExternalGripRayHit( hit.timeOfImpact, hit.normal, direction ) ) continue;
			const surface = physics.surfaceByCollider.get( hit.collider.handle );
			if ( ! surface?.clawEligible ) continue;
			probeBestNormal.set( hit.normal.x, hit.normal.y, hit.normal.z ).normalize();
			if ( ( surface.kind === 'ground' || surface.kind === 'soil' )
				&& probeBestNormal.dot( WORLD_UP ) < 0.25 ) continue;
			if ( supportReacquireSeconds > 0
				&& probeBestNormal.dot( preferredNormal ) < 0.28 ) continue;
			const normalContinuity = probeBestNormal.dot( preferredNormal );
			const movementAlignment = movement.lengthSq() > 1e-8
				? probeBestNormal.dot( movement ) : 0;
			const sameOwner = contact._lockedCollider?.handle === hit.collider.handle;
			// Interior-exit rejection is needed for reverse lip rays and for the
			// collider already surrounding a planted claw. Keeping the query on those
			// cases avoids multiplying an extra shape query across every probe axis.
			if ( ( directionIndex === 2 || sameOwner )
				&& hit.collider.containsPoint?.( probeRay.origin ) ) continue;
			const concaveTransition = directionIndex === 1 && movementAlignment < -0.48;
			const convexWrap = sameOwner && directionIndex === 2 && movementAlignment > 0.48;
			// A backwards ray is useful only to wrap around the lip of the collider
			// already held by that claw. On another convex object it sees the exit
			// face through the volume and would incorrectly attach to the far side.
			if ( directionIndex === 2 && movementAlignment > 0.48 && ! sameOwner ) continue;
			// A convex collider cannot be entered through one face and exited through
			// its opposite/underside. Only the backwards ray from beyond the lip may
			// wrap to another face of the same collider.
			if ( sameOwner && ! convexWrap && normalContinuity < 0.2
				&& movementAlignment < -0.35 ) continue;
			if ( sameOwner && ! convexWrap && normalContinuity < -0.18 ) continue;
			const distanceFromNominal = Math.abs( hit.timeOfImpact - lift );
			// Keep a separate, explicit transition owner. A valid ground ray has an
			// almost-zero score and otherwise wins forever against the wall directly
			// in front of the claws. The leading pair may claim that wall while it is
			// still close; the rear pair is admitted only after the support frame has
			// already rotated towards it. This gives a monotone floor -> edge -> wall
			// transfer without snapping the complete animal to a remote collider.
			const transitionStrength = concaveTransition
				? -movementAlignment : convexWrap ? movementAlignment : 0;
			const transitionEligible = ( concaveTransition || convexWrap )
				&& normalContinuity < 0.88
				&& ( contact.order < 2 || normalContinuity > 0.34 )
				&& distanceFromNominal <= reach * ( contact.order < 2 ? 0.92 : 0.72 );
			const candidateTransitionScore = distanceFromNominal
				+ ( 1 - transitionStrength ) * 0.06
				+ Math.max( 0, -normalContinuity ) * 0.04;
			if ( transitionEligible && candidateTransitionScore < transitionScore ) {

				transitionScore = candidateTransitionScore;
				transitionDistance = distanceFromNominal;
				probeTransitionPoint.copy( probeOrigin )
					.addScaledVector( direction, hit.timeOfImpact )
					.addScaledVector( probeBestNormal, 0.008 );
				probeTransitionNormal.copy( probeBestNormal );
				transitionSurface = surface;
				transitionCollider = hit.collider;

			}
			const score = Math.abs( hit.timeOfImpact - lift )
				+ ( 1 - normalContinuity ) * 0.075;
			if ( score >= bestScore ) continue;
			bestScore = score;
			probeBestPoint.copy( probeOrigin ).addScaledVector( direction, hit.timeOfImpact )
				.addScaledVector( probeBestNormal, 0.008 );
			contact.normal.copy( probeBestNormal );
			bestSurface = surface;
			bestCollider = hit.collider;

		}
		if ( transitionSurface !== null && transitionDistance < Infinity ) {

			contact.anchor = contact._anchorStore.copy( probeTransitionPoint );
			contact.normal.copy( probeTransitionNormal );
			contact._candidateSurface = transitionSurface;
			contact._candidateCollider = transitionCollider;
			return contact;

		}
		if ( bestSurface === null ) {

			contact.anchor = null;
			contact._candidateSurface = null;
			contact._candidateCollider = null;
			return null;

		}
		contact.anchor = contact._anchorStore.copy( probeBestPoint );
		contact._candidateSurface = bestSurface;
		contact._candidateCollider = bestCollider;
		return contact;

	}

	function projectCandidateFromLockedSurface( nominal, preferredNormal, contact ) {

		let bestDistance = Infinity;
		let bestSurface = null;
		let bestCollider = null;
		for ( const source of feet ) {

			if ( ! source._lockedSurface || ! source._lockedCollider ) continue;
			const projection = source._lockedCollider.projectPoint( nominal, false );
			if ( ! projection ) continue;
			let nx = projection.isInside
				? projection.point.x - nominal.x : nominal.x - projection.point.x;
			let ny = projection.isInside
				? projection.point.y - nominal.y : nominal.y - projection.point.y;
			let nz = projection.isInside
				? projection.point.z - nominal.z : nominal.z - projection.point.z;
			const distance = Math.hypot( nx, ny, nz );
			if ( distance >= bestDistance || distance > settings.gripReach * 1.1 ) continue;
			if ( distance > 1e-8 ) {

				nx /= distance;
				ny /= distance;
				nz /= distance;

			} else {

				nx = source.normal.x;
				ny = source.normal.y;
				nz = source.normal.z;

			}
			lockedProjectionPoint.set(
				projection.point.x, projection.point.y, projection.point.z,
			);
			lockedProjectionNormal.set( nx, ny, nz ).normalize();
			if ( ( source._lockedSurface.kind === 'ground'
					|| source._lockedSurface.kind === 'soil' )
				&& lockedProjectionNormal.dot( WORLD_UP ) < 0.25 ) continue;
			if ( lockedProjectionNormal.dot( preferredNormal ) < -0.18 ) continue;
			if ( supportReacquireSeconds > 0
				&& lockedProjectionNormal.dot( preferredNormal ) < 0.28 ) continue;
			bestDistance = distance;
			bestSurface = source._lockedSurface;
			bestCollider = source._lockedCollider;

		}
		if ( ! bestSurface ) for ( const entry of tailSurfaceProjectors ) {

			if ( ! entry.surface?.clawEligible ) continue;
			const projection = entry.collider.projectPoint( nominal, false );
			if ( ! projection ) continue;
			let nx = projection.isInside
				? projection.point.x - nominal.x : nominal.x - projection.point.x;
			let ny = projection.isInside
				? projection.point.y - nominal.y : nominal.y - projection.point.y;
			let nz = projection.isInside
				? projection.point.z - nominal.z : nominal.z - projection.point.z;
			const distance = Math.hypot( nx, ny, nz );
			if ( distance >= bestDistance || distance > settings.gripReach * 1.1 ) continue;
			if ( distance > 1e-8 ) {

				nx /= distance;
				ny /= distance;
				nz /= distance;

			} else {

				nx = averageSupportNormal.x;
				ny = averageSupportNormal.y;
				nz = averageSupportNormal.z;

			}
			lockedProjectionPoint.set(
				projection.point.x, projection.point.y, projection.point.z,
			);
			lockedProjectionNormal.set( nx, ny, nz ).normalize();
			if ( entry.oneSidedGround && lockedProjectionNormal.dot( WORLD_UP ) < 0.25 ) continue;
			if ( lockedProjectionNormal.dot( preferredNormal ) < -0.18 ) continue;
			if ( supportReacquireSeconds > 0
				&& lockedProjectionNormal.dot( preferredNormal ) < 0.28 ) continue;
			bestDistance = distance;
			bestSurface = entry.surface;
			bestCollider = entry.collider;

		}
		// Obstacles can be added to the laboratory after the animal was created.
		// Query those colliders lazily only after all constant-time cached probes
		// missed; normal locomotion therefore keeps the original fixed cost.
		if ( ! bestSurface && physics.surfaceByCollider ) for ( const [ handle, surface ] of physics.surfaceByCollider ) {

			if ( ! surface?.clawEligible ) continue;
			const collider = world.getCollider( handle );
			if ( ! collider || ! collider.isValid?.() ) continue;
			const projection = collider.projectPoint( nominal, false );
			if ( ! projection ) continue;
			let nx = projection.isInside
				? projection.point.x - nominal.x : nominal.x - projection.point.x;
			let ny = projection.isInside
				? projection.point.y - nominal.y : nominal.y - projection.point.y;
			let nz = projection.isInside
				? projection.point.z - nominal.z : nominal.z - projection.point.z;
			const distance = Math.hypot( nx, ny, nz );
			if ( distance >= bestDistance || distance > settings.gripReach * 1.1 ) continue;
			if ( distance > 1e-8 ) {

				nx /= distance; ny /= distance; nz /= distance;

			} else {

				nx = preferredNormal.x; ny = preferredNormal.y; nz = preferredNormal.z;

			}
			lockedProjectionNormal.set( nx, ny, nz ).normalize();
			if ( ( surface.kind === 'ground' || surface.kind === 'soil' )
				&& lockedProjectionNormal.dot( WORLD_UP ) < 0.25 ) continue;
			if ( lockedProjectionNormal.dot( preferredNormal ) < -0.18 ) continue;
			if ( supportReacquireSeconds > 0
				&& lockedProjectionNormal.dot( preferredNormal ) < 0.28 ) continue;
			bestDistance = distance;
			lockedProjectionPoint.set( projection.point.x, projection.point.y, projection.point.z );
			bestSurface = surface;
			bestCollider = collider;

		}
		if ( ! bestSurface ) return null;
		contact.anchor = contact._anchorStore.copy( lockedProjectionPoint )
			.addScaledVector( lockedProjectionNormal, 0.008 );
		contact.normal.copy( lockedProjectionNormal );
		contact._candidateSurface = bestSurface;
		contact._candidateCollider = bestCollider;
		return contact;

	}

	function updateCandidates() {

		const position = readVector( body.translation(), tempPosition );
		const rotation = readQuaternion( body.rotation(), tempQuaternion );
		currentBodyUp.copy( LOCAL_UP ).applyQuaternion( rotation ).normalize();
		reacquireVentralAlignment = reacquireCollider
			? currentBodyUp.dot( reacquireNormal ) : 1;
		if ( pendingSupportReset && reacquireState === 'righting'
			&& reacquireVentralAlignment >= 0.48 ) reacquireState = 'gripping';
		const preferredSupportNormal = supportReacquireSeconds > 0
			? reacquireNormal : averageSupportNormal;
		const movement = probeMovement.set( 0, 0, 0 );
		if ( command.move.lengthSq() > 1e-8 ) parallelTransportTangent(
			movement, command.move, command.sourceNormal,
			preferredSupportNormal, surfaceTransportScratch,
		);
		if ( movement.lengthSq() > 1e-8 ) movement.normalize();
		candidateContactCount = 0;
		for ( let foot = 0; foot < 4; foot ++ ) {

			const offset = foot * 3;
			const nominal = candidateNominal.copy( bodyToFootOffsets[ foot ] )
				.applyQuaternion( rotation ).add( position );
			if ( movement.lengthSq() > 0 )
				nominal.addScaledVector( movement, Math.max( 0.055, settings.stepLength * 0.72 ) );
			nominalFootPositions[ offset ] = nominal.x;
			nominalFootPositions[ offset + 1 ] = nominal.y;
			nominalFootPositions[ offset + 2 ] = nominal.z;
			const gripAvailable = settings.gripEnabled && ! command.release
				&& ! command.fullRagdoll && ! dragging;
			const ownerLocked = !! reacquireCollider && supportReacquireSeconds > 0;
			let hit = gripAvailable
				? pendingSupportReset || ownerLocked
					? projectCandidateToReacquireSurface( nominal, feet[ foot ] )
					: surfaceProbe( nominal, preferredSupportNormal, movement, feet[ foot ] )
				: null;
			if ( ! pendingSupportReset && ! ownerLocked && ! hit && gripAvailable
				&& ! command.fullRagdoll && ! dragging )
				hit = projectCandidateFromLockedSurface(
					nominal, preferredSupportNormal, feet[ foot ],
				);
			if ( hit ) {

				candidatePositions[ offset ] = hit.anchor.x;
				candidatePositions[ offset + 1 ] = hit.anchor.y;
				candidatePositions[ offset + 2 ] = hit.anchor.z;
				candidateNormals[ offset ] = hit.normal.x;
				candidateNormals[ offset + 1 ] = hit.normal.y;
				candidateNormals[ offset + 2 ] = hit.normal.z;
				candidateActiveContacts[ foot ] = 1;
				candidateContactCount ++;

			} else {

				candidatePositions[ offset ] = nominal.x;
				candidatePositions[ offset + 1 ] = nominal.y;
				candidatePositions[ offset + 2 ] = nominal.z;
				candidateNormals[ offset ] = preferredSupportNormal.x;
				candidateNormals[ offset + 1 ] = preferredSupportNormal.y;
				candidateNormals[ offset + 2 ] = preferredSupportNormal.z;
				candidateActiveContacts[ foot ] = 0;

			}

		}

	}

	function resolveBranchSupportNormal( bodyPosition, target ) {

		let dominantHandle = -1;
		let dominantCount = 0;
		for ( let foot = 0; foot < 4; foot ++ ) {

			if ( ! activeContacts[ foot ] || ! feet[ foot ]._lockedCollider ) continue;
			const handle = feet[ foot ]._lockedCollider.handle;
			let count = 0;
			for ( let other = 0; other < 4; other ++ )
				if ( activeContacts[ other ]
					&& feet[ other ]._lockedCollider?.handle === handle ) count ++;
			if ( count > dominantCount ) {

				dominantCount = count;
				dominantHandle = handle;

			}

		}
		if ( dominantCount < 2 ) return false;
		const projector = branchProjectorFor( dominantHandle );
		if ( ! projector || projector.surface?.kind !== 'branch' ) return false;
		const authoredAxis = projector.surface.branchAxis;
		if ( authoredAxis?.length >= 3
			&& Number.isFinite( authoredAxis[ 0 ] )
			&& Number.isFinite( authoredAxis[ 1 ] )
			&& Number.isFinite( authoredAxis[ 2 ] ) ) {

			branchSupportAxis.fromArray( authoredAxis );

		} else if ( Number.isFinite( authoredAxis?.x )
			&& Number.isFinite( authoredAxis?.y )
			&& Number.isFinite( authoredAxis?.z ) ) {

			branchSupportAxis.set( authoredAxis.x, authoredAxis.y, authoredAxis.z );

		} else {

			const colliderRotation = projector.collider.rotation();
			tempInverseQuaternion.set(
				colliderRotation.x, colliderRotation.y,
				colliderRotation.z, colliderRotation.w,
			).normalize();
			branchSupportAxis.set( 0, 1, 0 ).applyQuaternion( tempInverseQuaternion );

		}
		const axisLengthSquared = branchSupportAxis.lengthSq();
		if ( ! Number.isFinite( axisLengthSquared ) || axisLengthSquared < 1e-8 ) return false;
		branchSupportAxis.normalize();
		branchSupportRadial.set(
			bodyPosition.x - projector.x,
			bodyPosition.y - projector.y,
			bodyPosition.z - projector.z,
		);
		const axialDistance = branchSupportRadial.dot( branchSupportAxis );
		if ( projector.halfHeight > 0
			&& Math.abs( axialDistance ) > projector.halfHeight + settings.gripReach * 0.25 )
			return false;
		branchSupportRadial.addScaledVector( branchSupportAxis, -axialDistance );
		const radialLengthSquared = branchSupportRadial.lengthSq();
		if ( ! Number.isFinite( radialLengthSquared ) || radialLengthSquared < 1e-8 ) return false;
		branchSupportRadial.normalize();
		let coherentContacts = 0;
		for ( let foot = 0; foot < 4; foot ++ ) {

			if ( ! activeContacts[ foot ]
				|| feet[ foot ]._lockedCollider?.handle !== dominantHandle ) continue;
			const radialAlignment = feet[ foot ].normal.dot( branchSupportRadial );
			const axialAlignment = Math.abs( feet[ foot ].normal.dot( branchSupportAxis ) );
			// Only cylindrical flank contacts vote for the analytic radial frame.
			// End-cap normals are axial and must remain free to carry the support
			// continuously over the rim or onto the following object.
			if ( Number.isFinite( radialAlignment ) && Number.isFinite( axialAlignment )
				&& radialAlignment > 0.32 && radialAlignment > axialAlignment + 0.08 )
				coherentContacts ++;

		}
		if ( coherentContacts < 2 ) return false;
		target.copy( branchSupportRadial );
		return true;

	}

	function updateGait( dt ) {

		for ( let foot = 0; foot < 4; foot ++ )
			if ( supportRejectCooldown[ foot ] > 0 ) supportRejectCooldown[ foot ] --;
		previousFootPositions.set( currentFootPositions );
		previousFootNormals.set( currentFootNormals );
		const velocity = readVector( body.linvel(), tempVelocity );
		const currentRotation = readQuaternion( body.rotation(), tempQuaternion );
		const forward = tempDirection.copy( LOCAL_FORWARD ).applyQuaternion( currentRotation );
		// A ballistic body must not keep cycling a planted walking stroke. Preserve
		// the last bounded pose while support is released, then let the jump overlay
		// own flexion/tuck until at least one claw has genuinely reacquired a surface.
		const hasLocomotionSupport = ! command.release && ! command.fullRagdoll
			&& ! dragging && contactCount >= 1;
		const translationGaitSpeed = hasLocomotionSupport
			? command.move.length() * settings.moveSpeed
				* ( command.sprint ? settings.sprintMultiplier : 1 ) : 0;
		const pivotGaitSpeed = hasLocomotionSupport
			? Math.abs( command.turning ) * settings.moveSpeed * 0.52 : 0;
		gaitInput.speed = Math.max( translationGaitSpeed, pivotGaitSpeed );
		gaitInput.velocityX = velocity.x;
		gaitInput.velocityY = velocity.y;
		gaitInput.velocityZ = velocity.z;
		gaitInput.forwardX = forward.x;
		gaitInput.forwardY = forward.y;
		gaitInput.forwardZ = forward.z;
		const cadence = Math.max( 0.1, settings.gaitFrequency * settings.animationSpeed );
		gait.stepDistance = THREE.MathUtils.clamp( settings.stepLength, 0.08, 0.34 );
		gait.stepHeight = THREE.MathUtils.clamp( settings.stepHeight, 0.015, 0.20 );
		gait.minSwingDuration = 0.16 / cadence;
		gait.maxSwingDuration = 0.34 / cadence;
		if ( pendingSupportReset && reacquireState === 'gripping'
			&& reacquireVentralAlignment >= 0.48 && candidateContactCount >= 2 ) {

			// The former ground stance is meaningless after a mouse throw. Seed a
			// fresh support polygon on the impacted surface while the passive-limb
			// blend is still fading, so attachment is strong but never teleports.
			gait.reset( gaitInput );
			wasFootSwinging.fill( 0 );
			for ( let foot = 0; foot < 4; foot ++ ) {

				feet[ foot ]._lockedSurface = candidateActiveContacts[ foot ]
					? feet[ foot ]._candidateSurface : null;
				feet[ foot ]._lockedCollider = candidateActiveContacts[ foot ]
					? feet[ foot ]._candidateCollider : null;
				supportRejectTicks[ foot ] = 0;
				supportRejectCooldown[ foot ] = 0;

			}
			// A manifold-authoritative landing deliberately changes support
			// hemisphere. Seed the temporal frame from that impact before the first
			// planted aggregation; otherwise a slightly downward cylinder normal can
			// be rejected against the stale pre-jump world-up frame.
			supportFrame.normal.x = reacquireNormal.x;
			supportFrame.normal.y = reacquireNormal.y;
			supportFrame.normal.z = reacquireNormal.z;
			averageSupportNormal.copy( reacquireNormal );
			targetSupportNormal.copy( reacquireNormal );
			gait.requestSettlement();
			pendingSupportReset = false;
			reacquireState = 'attached';
			reacquireOwnerAge = 0;
			// Keep the chosen collider through the landing transient. The former
			// immediate release let adjacent walls and cylinders steal alternate
			// feet on successive frames.
			supportReacquireSeconds = Math.max( supportReacquireSeconds, 0.85 );

		}
		const preUpdateView = gait.getView();
		for ( let foot = 0; foot < 4; foot ++ ) {

			if ( feet[ foot ]._lockedSurface || ! candidateActiveContacts[ foot ] ) continue;
			const offset = foot * 3;
			const dx = preUpdateView.footPositions[ offset ] - candidatePositions[ offset ];
			const dy = preUpdateView.footPositions[ offset + 1 ] - candidatePositions[ offset + 1 ];
			const dz = preUpdateView.footPositions[ offset + 2 ] - candidatePositions[ offset + 2 ];
			if ( dx * dx + dy * dy + dz * dz > 0.0025 ) {

				gait.requestSettlement();
				break;

			}

		}
		const view = gait.update( dt, gaitInput );
		wholeBodyInput.gaitView = view;
		wholeBodyInput.speed = gaitInput.speed;
		wholeBodyInput.strideAmplitude = settings.strideAmplitude;
		wholeBodyInput.limbLift = settings.limbLift;
		wholeBodyInput.jointFlex = settings.jointFlex;
		wholeBodyInput.bodyMotion = settings.bodyMotion;
		wholeBodyInput.idleWeight = hasLocomotionSupport ? 1 : 0;
		wholeBodyInput.attentionTime = elapsed;
		wholeBodyGait.update( dt, wholeBodyInput );
		currentForwardWorld.copy( forward ).normalize();
		headLookUp.copy( LOCAL_UP ).applyQuaternion( currentRotation ).normalize();
		headLookSide.crossVectors( headLookUp, currentForwardWorld ).normalize();
		readVector( body.translation(), headLookOrigin )
			.addScaledVector( currentForwardWorld, 0.34 )
			.addScaledVector( headLookUp, 0.07 );
		headLookInput.targetWeight = 0;
		if ( lookTargetWeight > 0 ) {

			headLookDirection.subVectors( lookTarget, headLookOrigin );
			const distanceSquared = headLookDirection.lengthSq();
			if ( distanceSquared > 1e-8 ) {

				headLookDirection.multiplyScalar( 1 / Math.sqrt( distanceSquared ) );
				const forwardAmount = headLookDirection.dot( currentForwardWorld );
				const sideAmount = headLookDirection.dot( headLookSide );
				const upAmount = headLookDirection.dot( headLookUp );
				headLookInput.targetYaw = Math.atan2( sideAmount, forwardAmount );
				headLookInput.targetPitch = Math.atan2(
					upAmount, Math.max( 1e-6, Math.hypot( forwardAmount, sideAmount ) ),
				);
				headLookInput.targetWeight = lookTargetWeight;

			}

		}
		// Even while walking the eyes and neck keep a restrained independent scan.
		// At rest it expands into longer observation poses over a subtle breathing
		// cycle; ragdoll/dragging releases the overlay cleanly to the passive pose.
		headLookInput.idleWeight = command.fullRagdoll || command.release || dragging
			? 0 : THREE.MathUtils.lerp( 1, 0.32, THREE.MathUtils.clamp( gaitInput.speed / 0.32, 0, 1 ) );
		headLook.updateFixed( dt, headLookInput );
		currentFootPositions.set( view.footPositions );
		currentFootNormals.set( view.footNormals );
		contactCount = 0;
		// Surface ownership follows the gait state. A stance claw stays attached
		// to its collider even if the next-candidate ray temporarily points
		// elsewhere; a swing transfers ownership only on touchdown.
		for ( let foot = 0; foot < 4; foot ++ ) {

			const offset = foot * 3;
			const swinging = view.footSwinging[ foot ] === 1;
			if ( swinging && ! wasFootSwinging[ foot ] ) {

				targetFootSurfaces[ foot ] = feet[ foot ]._candidateSurface;
				targetFootColliders[ foot ] = feet[ foot ]._candidateCollider;

			} else if ( ! swinging && wasFootSwinging[ foot ] ) {

				feet[ foot ]._lockedSurface = supportRejectCooldown[ foot ] === 0
					? targetFootSurfaces[ foot ] : null;
				feet[ foot ]._lockedCollider = supportRejectCooldown[ foot ] === 0
					? targetFootColliders[ foot ] : null;

			}
			const candidateDx = view.footPositions[ offset ] - candidatePositions[ offset ];
			const candidateDy = view.footPositions[ offset + 1 ] - candidatePositions[ offset + 1 ];
			const candidateDz = view.footPositions[ offset + 2 ] - candidatePositions[ offset + 2 ];
			const candidateClose = candidateDx * candidateDx + candidateDy * candidateDy
				+ candidateDz * candidateDz <= Math.pow( settings.gripReach * 0.35, 2 );
			if ( ! swinging && supportRejectCooldown[ foot ] === 0
				&& ! feet[ foot ]._lockedSurface
				&& candidateActiveContacts[ foot ] && candidateClose ) {

				feet[ foot ]._lockedSurface = feet[ foot ]._candidateSurface;
				feet[ foot ]._lockedCollider = feet[ foot ]._candidateCollider;

			}
			wasFootSwinging[ foot ] = swinging ? 1 : 0;
			feet[ foot ].anchor = feet[ foot ]._visualAnchorStore.set(
				currentFootPositions[ offset ],
				currentFootPositions[ offset + 1 ],
				currentFootPositions[ offset + 2 ],
			);
			feet[ foot ].normal.set(
				currentFootNormals[ offset ],
				currentFootNormals[ offset + 1 ],
				currentFootNormals[ offset + 2 ],
			).normalize();
			feet[ foot ].surface = feet[ foot ]._lockedSurface;
			feet[ foot ].collider = feet[ foot ]._lockedCollider;
			const active = settings.gripEnabled && ! command.release
				&& ! command.fullRagdoll && ! dragging && ! swinging
				&& feet[ foot ]._lockedSurface && feet[ foot ]._lockedCollider;
			activeContacts[ foot ] = active ? 1 : 0;
			feet[ foot ].load = active ? 0.35 : 0;
			feet[ foot ].state = active ? 'holding' : swinging ? 'swinging' : 'reaching';
			if ( active ) contactCount ++;

		}
		const bodyPosition = readVector( body.translation(), tempPosition );
		for ( let foot = 0; foot < 4; foot ++ ) {

			const offset = foot * 3;
			tempDirection.copy( bodyToSocketOffsets[ foot ] )
				.applyQuaternion( currentRotation ).add( bodyPosition );
			suspensionSocketPositions[ offset ] = tempDirection.x;
			suspensionSocketPositions[ offset + 1 ] = tempDirection.y;
			suspensionSocketPositions[ offset + 2 ] = tempDirection.z;

		}
		// Collider identity is not a surface identity: one box owns six faces and a
		// trimesh may own disconnected islands. Ordinary coplanar contacts and a
		// registered branch take the constant fast path; every owner/face hand-off is
		// validated as a locally connected anatomical cohort.
		let provisionalMask = 0;
		let requiresCohort = false;
		for ( let foot = 0; foot < 4; foot ++ ) {

			if ( ! activeContacts[ foot ] ) {

				supportColliderHandles[ foot ] = NaN;
				supportTopologyFlags[ foot ] = 0;
				continue;

			}
			provisionalMask |= 1 << foot;
			supportColliderHandles[ foot ] = feet[ foot ]._lockedCollider?.handle ?? NaN;
			const surfaceTopology = feet[ foot ]._lockedSurface?.supportTopology;
			supportTopologyFlags[ foot ] = surfaceTopology === 'radial-branch'
				|| feet[ foot ]._lockedSurface?.branchAxis
				? 1
				: surfaceTopology === 'faceted-shell'
					|| feet[ foot ]._lockedCollider?.shapeType() === RAPIER.ShapeType.Cuboid
						? 2 : 0;

		}
		for ( let first = 0; first < 4 && ! requiresCohort; first ++ ) {

			if ( ( provisionalMask & ( 1 << first ) ) === 0 ) continue;
			for ( let second = first + 1; second < 4; second ++ ) {

				if ( ( provisionalMask & ( 1 << second ) ) === 0 ) continue;
				const sameHandle = supportColliderHandles[ first ]
					=== supportColliderHandles[ second ];
				if ( ! sameHandle ) {

					requiresCohort = true;
					break;

				}
				if ( supportTopologyFlags[ first ] === 1
					&& supportTopologyFlags[ second ] === 1 ) continue;
				if ( supportTopologyFlags[ first ] === 2
					&& supportTopologyFlags[ second ] === 2 ) {

					const firstOffset = first * 3;
					const secondOffset = second * 3;
					const shellDot = currentFootNormals[ firstOffset ]
						* currentFootNormals[ secondOffset ]
						+ currentFootNormals[ firstOffset + 1 ]
							* currentFootNormals[ secondOffset + 1 ]
						+ currentFootNormals[ firstOffset + 2 ]
							* currentFootNormals[ secondOffset + 2 ];
					if ( shellDot >= -0.25 ) continue;

				}
				const firstOffset = first * 3;
				const secondOffset = second * 3;
				const normalDot = currentFootNormals[ firstOffset ]
					* currentFootNormals[ secondOffset ]
					+ currentFootNormals[ firstOffset + 1 ]
						* currentFootNormals[ secondOffset + 1 ]
					+ currentFootNormals[ firstOffset + 2 ]
						* currentFootNormals[ secondOffset + 2 ];
				if ( normalDot < supportCohort.sameSurfaceNormalDot ) {

					requiresCohort = true;
					break;

				}

			}

		}
		if ( requiresCohort ) {

			supportCohort.enterSeamDistance = THREE.MathUtils.clamp(
				Math.max(
					settings.stepLength * 2 + 0.12,
					settings.gripReach * 1.7,
				),
				0.42,
				0.72,
			);
			supportCohort.exitSeamDistance = Math.min(
				settings.gripReach * 2,
				supportCohort.enterSeamDistance + 0.12,
			);
			for ( let foot = 0; foot < 4; foot ++ ) {

				if ( ! activeContacts[ foot ] ) {

					supportReachDistances[ foot ] = Infinity;
					continue;

				}
				const offset = foot * 3;
				supportReachDistances[ foot ] = Math.hypot(
					currentFootPositions[ offset ] - suspensionSocketPositions[ offset ],
					currentFootPositions[ offset + 1 ] - suspensionSocketPositions[ offset + 1 ],
					currentFootPositions[ offset + 2 ] - suspensionSocketPositions[ offset + 2 ],
				);

			}
			supportCohort.buildCompatibility(
				currentFootPositions,
				currentFootNormals,
				supportColliderHandles,
				supportTopologyFlags,
				activeContacts,
				coherentContactMask,
			);
			coherentContactMask = supportCohort.select(
				supportReachDistances,
				supportMaximumReaches,
				activeContacts,
				coherentContactMask,
				supportCohort.compatibility,
			).mask;

		} else coherentContactMask = provisionalMask;
		contactCount = 0;
		let releasedIncoherentContact = false;
		for ( let foot = 0; foot < 4; foot ++ ) {

			const selected = ( coherentContactMask & ( 1 << foot ) ) !== 0;
			if ( selected ) {

				activeContacts[ foot ] = 1;
				supportRejectTicks[ foot ] = 0;
				feet[ foot ].load = 0.35;
				feet[ foot ].state = 'holding';
				contactCount ++;
				continue;

			}
			const wasProvisional = activeContacts[ foot ] === 1;
			activeContacts[ foot ] = 0;
			feet[ foot ].load = 0;
			if ( wasProvisional ) {

				feet[ foot ].state = 'reaching';
				supportRejectTicks[ foot ] = Math.min( 255, supportRejectTicks[ foot ] + 1 );
				if ( supportRejectTicks[ foot ] >= 3 ) {

					feet[ foot ]._lockedSurface = null;
					feet[ foot ]._lockedCollider = null;
					feet[ foot ].surface = null;
					feet[ foot ].collider = null;
					targetFootSurfaces[ foot ] = null;
					targetFootColliders[ foot ] = null;
					supportRejectTicks[ foot ] = 0;
					supportRejectCooldown[ foot ] = 4;
					releasedIncoherentContact = true;

				}

			} else supportRejectTicks[ foot ] = 0;

		}
		if ( releasedIncoherentContact ) gait.requestSettlement();
		suspension.update( dt, suspensionInput );
		const frame = supportFrameFromContacts(
			currentFootPositions, currentFootNormals, activeContacts,
			supportFrame, averageSupportNormal,
		);
		if ( frame.coherentCount >= 1 ) {

			targetSupportNormal.set( frame.normal.x, frame.normal.y, frame.normal.z ).normalize();
			resolveBranchSupportNormal( bodyPosition, targetSupportNormal );
			// Keep edge transitions monotone instead of switching the complete body
			// frame whenever a single swing foot reaches the neighbouring face. A
			// hard reacquisition may start almost orthogonal, in which case snapping
			// once is safer than interpolating through an invalid diagonal support.
			if ( averageSupportNormal.dot( targetSupportNormal ) < 0.12 )
				averageSupportNormal.copy( targetSupportNormal );
			else averageSupportNormal.lerp(
				targetSupportNormal,
				1 - Math.exp( -dt * ( frame.coherentCount >= 3 ? 24 : 16 ) ),
			).normalize();

		}

	}

	function applyRootController() {

		if ( command.fullRagdoll || command.release || dragging || contactCount < 1 ) return;
		if ( staticGripLocked && body.isSleeping?.() ) return;
		const position = readVector( body.translation(), tempPosition );
		readVector( body.worldCom(), bodyCentreOfMass );
		const rotation = readQuaternion( body.rotation(), tempQuaternion );
		const velocity = readVector( body.linvel(), tempVelocity );
		readVector( body.angvel(), angularVelocity );
		desiredRoot.set( 0, 0, 0 );
		let suggestions = 0;
		let supportGripScale = 0;
		for ( let foot = 0; foot < 4; foot ++ ) {

			if ( ! activeContacts[ foot ] ) continue;
			const offset = foot * 3;
			rootSuggestion.set(
				currentFootPositions[ offset ],
				currentFootPositions[ offset + 1 ],
				currentFootPositions[ offset + 2 ],
			).sub( rootOffset.copy( bodyToFootOffsets[ foot ] ).applyQuaternion( rotation ) );
			desiredRoot.add( rootSuggestion );
			const rawGripScale = feet[ foot ]._lockedSurface?.gripStrengthScale;
			supportGripScale += THREE.MathUtils.clamp(
				Number.isFinite( rawGripScale ) ? rawGripScale : 1,
				0.55,
				1.6,
			);
			suggestions ++;

		}
		if ( suggestions > 0 ) {

			desiredRoot.multiplyScalar( 1 / suggestions );
			supportGripScale /= suggestions;

		}
		else desiredRoot.copy( position );
		if ( suggestions === 0 ) supportGripScale = 1;
		// The authored soles are not flat bone sticks: aligning their exported
		// normals can lower a wrist relative to its patch. Solve the resulting
		// crouch at the physical root so rear knees keep their flexion without
		// sacrificing contact. Two fixed, allocation-free projection passes form
		// a bounded minimax correction across mixed floor/wall/branch supports.
		rootReachCorrection.set( 0, 0, 0 );
		for ( let pass = 0; pass < 2; pass ++ ) for ( let foot = 0; foot < 4; foot ++ ) {

			if ( ! activeContacts[ foot ] ) continue;
			const leg = rig.legs[ foot ];
			const offset = foot * 3;
			rootReachNormal.set(
				currentFootNormals[ offset ],
				currentFootNormals[ offset + 1 ],
				currentFootNormals[ offset + 2 ],
			).normalize();
			rootReachShoulder.copy( leg.shoulderBodyOffset ).applyQuaternion( rotation )
				.add( desiredRoot ).add( rootReachCorrection );
			rootReachTangent.copy( leg.restPalmTangentBody ).applyQuaternion( rotation )
				.projectOnPlane( rootReachNormal );
			if ( rootReachTangent.lengthSq() < 1e-8 )
				rootReachTangent.copy( LOCAL_FORWARD ).applyQuaternion( rotation )
					.projectOnPlane( rootReachNormal );
			if ( rootReachTangent.lengthSq() < 1e-8 )
				rootReachTangent.copy( LOCAL_UP ).applyQuaternion( rotation )
					.projectOnPlane( rootReachNormal );
			rootReachTangent.normalize();
			rootReachBinormal.crossVectors( rootReachNormal, rootReachTangent ).normalize();
			const contactOffset = leg.solver.contactOffset;
			rootReachContactOffset.copy( rootReachTangent ).multiplyScalar( contactOffset[ 0 ] )
				.addScaledVector( rootReachNormal, contactOffset[ 1 ] )
				.addScaledVector( rootReachBinormal, contactOffset[ 2 ] );
			rootReachWrist.set(
				currentFootPositions[ offset ],
				currentFootPositions[ offset + 1 ],
				currentFootPositions[ offset + 2 ],
			).addScaledVector( rootReachNormal, leg.solver.contactClearance )
				.sub( rootReachContactOffset );
			rootReachVector.subVectors( rootReachWrist, rootReachShoulder );
			const normalDistance = rootReachVector.dot( rootReachNormal );
			if ( normalDistance >= 0 ) continue;
			const upperLength = leg.solver.lengths[ 1 ];
			const lowerLength = leg.solver.lengths[ 2 ];
			const desiredFlexion = Math.max(
				leg.solver.preset.minimumFlexion,
				leg.restFlexion * REST_FLEXION_RETENTION,
			);
			const desiredReachSquared = upperLength * upperLength + lowerLength * lowerLength
				+ 2 * upperLength * lowerLength * Math.cos( desiredFlexion );
			const tangentDistanceSquared = Math.max(
				0, rootReachVector.lengthSq() - normalDistance * normalDistance,
			);
			if ( tangentDistanceSquared >= desiredReachSquared ) continue;
			const requiredApproach = -Math.sqrt(
				desiredReachSquared - tangentDistanceSquared,
			) - normalDistance;
			if ( requiredApproach > 0 ) rootReachCorrection.addScaledVector(
				rootReachNormal, -Math.min( requiredApproach, 0.065 ),
			);

		}
		clampVector( rootReachCorrection, 0.07 );
		desiredRoot.add( rootReachCorrection );
		const totalMass = Math.max( body.mass(), 0.1 );
		rootError.subVectors( desiredRoot, position );
		rootForceInput.mass = totalMass;
		rootForceInput.frequency = ( 5.5 + settings.motorStrength * 2.5 ) * Math.sqrt(
			Math.max( 0.05, settings.gripStiffness / 175 ),
		);
		rootForceInput.dampingRatio = settings.motorDamping
			* THREE.MathUtils.clamp( settings.gripDamping / 8, 0.2, 2.5 );
		rootForceInput.maximumAcceleration = Math.max( 8, settings.gripStrength / totalMass )
			* supportGripScale;
		stableRootForce( rootForceInput, supportForceRecord );
		supportForce.set( supportForceRecord.x, supportForceRecord.y, supportForceRecord.z );
		readVector( world.gravity, gravityVector );
		// Four claw contacts carry the full weight even on vertical or inverted
		// surfaces. Cancelling only the normal component made wall attachment
		// slide under gravity and eventually fall back to the floor.
		supportForce.addScaledVector( gravityVector, -totalMass );
		transportedMovement.set( 0, 0, 0 );
		if ( command.move.lengthSq() > 1e-8 ) parallelTransportTangent(
			transportedMovement, command.move, command.sourceNormal,
			averageSupportNormal, surfaceTransportScratch,
		);
		desiredMovement.copy( transportedMovement );
		if ( desiredMovement.lengthSq() > 1e-8 ) {

			const commandMagnitude = Math.min( 1, desiredMovement.length() );
			const turnTrackingGain = settings.moveForce
				* ( 1 + Math.abs( command.turning ) * 2 );
			desiredMovement.normalize().multiplyScalar(
				settings.moveSpeed * ( command.sprint ? settings.sprintMultiplier : 1 )
					* commandMagnitude,
			);
			tangentVelocity.copy( velocity ).projectOnPlane( averageSupportNormal );
			supportForce.add(
				desiredMovement.sub( tangentVelocity ).multiplyScalar( totalMass * turnTrackingGain ),
			);

		} else {

			// Releasing the stick must stop the compact turn arc instead of letting its
			// world-space momentum become a backwards/sideways slide as the body finishes
			// rotating. This is support friction, so it remains tangent on every surface.
			tangentVelocity.copy( velocity ).projectOnPlane( averageSupportNormal );
			supportForce.addScaledVector(
				tangentVelocity, -totalMass * settings.moveForce,
			);

		}
		const turnForceScale = 1 + Math.abs( command.turning ) * 2;
		clampVector(
			supportForce,
			settings.moveForce * turnForceScale * totalMass + totalMass * 10,
		);
		// Distribute the exact, critically damped root resultant over the stance
		// pads. Translation therefore preserves the proven stable controller while
		// Rapier receives forces at the actual claws. The induced moment is measured
		// below and compensated explicitly, leaving independent roll and yaw motors.
		const inverseContacts = 1 / Math.max( 1, suggestions );
		clawForce.copy( supportForce ).multiplyScalar( inverseContacts );
		clawForceRecord.x = clawForce.x;
		clawForceRecord.y = clawForce.y;
		clawForceRecord.z = clawForce.z;
		supportInducedTorque.set( 0, 0, 0 );
		for ( let foot = 0; foot < 4; foot ++ ) {

			if ( ! activeContacts[ foot ] ) continue;
			const offset = foot * 3;
			clawPoint.set(
				currentFootPositions[ offset ],
				currentFootPositions[ offset + 1 ],
				currentFootPositions[ offset + 2 ],
			);
			clawLever.subVectors( clawPoint, bodyCentreOfMass );
			clawPointRecord.x = clawPoint.x;
			clawPointRecord.y = clawPoint.y;
			clawPointRecord.z = clawPoint.z;
			body.addForceAtPoint( clawForceRecord, clawPointRecord, true );
			supportMoment.crossVectors( clawLever, clawForce );
			supportInducedTorque.add( supportMoment );
			feet[ foot ].load = inverseContacts;

		}
		// Keep ventral righting and anatomical yaw as independent actuators. A single
		// clamped quaternion motor lets roll/pitch correction consume the yaw budget
		// on branches and walls, which makes the same input feel arbitrarily heavy.
		const steepness = 1 - Math.abs( averageSupportNormal.dot( WORLD_UP ) );
		transportedFacing.set( 0, 0, 0 );
		if ( command.facing.lengthSq() > 1e-8 ) parallelTransportTangent(
			transportedFacing, command.facing, command.sourceNormal,
			averageSupportNormal, surfaceTransportScratch,
		);
		else transportedFacing.copy( transportedMovement );
		currentSurfaceForward.copy( LOCAL_FORWARD ).applyQuaternion( rotation )
			.projectOnPlane( averageSupportNormal );
		if ( currentSurfaceForward.lengthSq() < 1e-8 )
			currentSurfaceForward.copy( transportedFacing );
		if ( currentSurfaceForward.lengthSq() < 1e-8 )
			currentSurfaceForward.copy( desiredForward ).projectOnPlane( averageSupportNormal );
		currentSurfaceForward.normalize();
		desiredBodyQuaternion(
			rotation, averageSupportNormal, currentSurfaceForward, desiredSwingRotation,
			desiredUp, desiredForward, desiredXAxis, desiredZAxis, desiredMatrix,
		);
		const yawRate = angularVelocity.dot( averageSupportNormal );
		swingAngularVelocity.copy( angularVelocity )
			.addScaledVector( averageSupportNormal, -yawRate );
		quaternionTorque(
			rotation,
			desiredSwingRotation,
			swingAngularVelocity,
			effectiveAngularInertia,
			9.5 + settings.motorStrength * 2.5 + steepness * 3.5,
			settings.motorDamping,
			settings.turnTorque * THREE.MathUtils.clamp( settings.rightingStrength, 0.2, 2 )
				* supportGripScale
				* ( 1 + steepness * 2.4 ),
			swingTorque,
			torqueCurrent,
			torqueError,
		);
		// Numerical swing construction can contain a minute twist component. Remove
		// it explicitly so the yaw motor owns all rotation around the support normal.
		swingTorque.addScaledVector(
			averageSupportNormal, -swingTorque.dot( averageSupportNormal ),
		);
		yawCross.crossVectors( currentSurfaceForward, transportedFacing );
		const yawError = Math.atan2(
			yawCross.dot( averageSupportNormal ),
			THREE.MathUtils.clamp( currentSurfaceForward.dot( transportedFacing ), -1, 1 ),
		);
		axisTwistTorque(
			averageSupportNormal,
			yawError,
			angularVelocity,
			-command.turning * DEFAULT_ARCADE_TURN_RATE,
			effectiveAngularInertia,
			( 11.5 + settings.motorStrength * 2 )
				* ( Math.abs( command.turning ) > 1e-5 ? 1 : 1.6 ),
			0.82 * settings.motorDamping,
			settings.turnTorque * THREE.MathUtils.clamp( settings.rightingStrength, 0.2, 2 )
				* ( Math.abs( command.turning ) > 1e-5 ? 1 : 2.2 ),
			yawTorque,
		);
		torqueVector.copy( swingTorque ).add( yawTorque ).sub( supportInducedTorque );
		const torque = torqueVector;
		appliedTorqueRecord.x = torque.x;
		appliedTorqueRecord.y = torque.y;
		appliedTorqueRecord.z = torque.z;
		body.addTorque( appliedTorqueRecord, true );

	}

	function updateStaticGripLock( dt ) {

		const idleCommand = command.move.lengthSq() <= 1e-10
			&& Math.abs( command.turning ) <= 1e-5
			&& ! command.sprint && ! command.release && ! command.fullRagdoll && ! dragging;
		const gaitView = gait.getView();
		let swinging = gaitView.activePair >= 0;
		if ( ! swinging ) for ( let foot = 0; foot < 4; foot ++ )
			if ( gaitView.footSwinging[ foot ] ) {

				swinging = true;
				break;

			}
		if ( staticGripLocked ) {

			// An external collision wakes Rapier. Resume the bounded controller on
			// the next fixed step instead of fighting that impulse with a hidden lock.
			if ( ! idleCommand || contactCount < 2 || swinging || ! body.isSleeping?.() )
				releaseStaticGrip( ! idleCommand );
			return;

		}
		if ( ! idleCommand || contactCount < 2 || swinging || pendingSupportReset
			|| supportReacquireSeconds > 0 ) {

			staticGripSeconds = 0;
			return;

		}
		// applyRootController has already refreshed both scratch vectors on every
		// eligible acquisition step; re-reading Rapier would create two wrappers.
		const stable = tempVelocity.lengthSq() <= 0.018 * 0.018
			&& angularVelocity.lengthSq() <= 0.035 * 0.035
			&& rootError.lengthSq() <= 0.022 * 0.022;
		if ( ! stable ) {

			staticGripSeconds = 0;
			return;

		}
		staticGripSeconds += dt;
		if ( staticGripSeconds < 0.32 ) return;
		// Sleeping is the physically correct static-friction state here: no force
		// is injected and the body wakes normally on input, impact or mouse grab.
		body.resetForces( false );
		body.resetTorques( false );
		body.sleep?.();
		staticGripLocked = body.isSleeping?.() === true;

	}

	function applyRightingReflex() {

		if ( command.fullRagdoll || command.release || dragging || ! pendingSupportReset ) return;
		const rotation = readQuaternion( body.rotation(), tempQuaternion );
		const targetNormal = reacquireCollider ? reacquireNormal : WORLD_UP;
		currentBodyUp.copy( LOCAL_UP ).applyQuaternion( rotation ).normalize();
		reacquireVentralAlignment = currentBodyUp.dot( targetNormal );
		rightingMovement.copy( command.move );
		if ( rightingMovement.lengthSq() < 1e-8 )
			rightingMovement.copy( readVector( body.linvel(), tempVelocity ) )
				.projectOnPlane( targetNormal );
		desiredBodyQuaternion(
			rotation, targetNormal, rightingMovement, desiredRotation,
			desiredUp, desiredForward, desiredXAxis, desiredZAxis, desiredMatrix,
		);
		readVector( body.angvel(), angularVelocity );
		const ownerStrength = reacquireCollider ? 1 : 0.46;
		const strength = THREE.MathUtils.clamp( settings.rightingStrength, 0, 2 );
		const torque = quaternionTorque(
			rotation,
			desiredRotation,
			angularVelocity,
			effectiveAngularInertia,
			( 8 + ownerStrength * 8 ) * Math.max( 0.15, strength ),
			1.12,
			( 1.8 + ownerStrength * 4.2 ) * strength,
			torqueVector,
			torqueCurrent,
			torqueError,
		);
		appliedTorqueRecord.x = torque.x;
		appliedTorqueRecord.y = torque.y;
		appliedTorqueRecord.z = torque.z;
		body.addTorque( appliedTorqueRecord, true );

		if ( ! reacquireCollider ) return;
		if ( reacquireState === 'righting' && reacquireVentralAlignment >= 0.48 )
			reacquireState = 'gripping';
		// Never glue the back or flank. A smooth ventral gate begins only after
		// the body has substantially righted itself; the actual claws take over
		// as soon as two same-owner contacts are reachable.
		const ventralGrip = THREE.MathUtils.smoothstep(
			reacquireVentralAlignment, 0.25, 0.78,
		);
		if ( ventralGrip <= 0 ) return;
		const totalMass = Math.max( body.mass(), 0.1 );
		rightingForce.copy( reacquireNormal ).multiplyScalar(
			-totalMass * ( 5 + settings.gripStrength * 0.22 ) * ventralGrip,
		);
		clampVector( rightingForce, Math.max( 8, settings.gripStrength * 0.65 ) );
		appliedForceRecord.x = rightingForce.x;
		appliedForceRecord.y = rightingForce.y;
		appliedForceRecord.z = rightingForce.z;
		body.addForce( appliedForceRecord, true );

	}

	function projectCollisionPoint( point, radius, outPoint, outNormal, collisionScale, includeBody = true ) {

		const scaledRadius = radius * THREE.MathUtils.clamp( collisionScale, 0.25, 2 );
		let bestCorrection = 0;
		let bestPointX = 0;
		let bestPointY = 0;
		let bestPointZ = 0;
		let bestNormalX = 0;
		let bestNormalY = 1;
		let bestNormalZ = 0;
		for ( const entry of tailSurfaceProjectors ) {

			if ( entry.oneSidedGround
				&& Math.abs( point.x - entry.x ) <= entry.halfX + scaledRadius
				&& Math.abs( point.z - entry.z ) <= entry.halfZ + scaledRadius ) {

				const correction = entry.topY + scaledRadius - point.y;
				if ( correction > bestCorrection ) {

					bestCorrection = correction;
					bestNormalX = 0;
					bestNormalY = 1;
					bestNormalZ = 0;
					bestPointX = point.x;
					bestPointY = entry.topY + scaledRadius;
					bestPointZ = point.z;

				}
				continue;

			}
			const broadRadius = entry.boundRadius + scaledRadius;
			if ( Number.isFinite( broadRadius ) ) {

				const broadX = point.x - entry.x;
				const broadY = point.y - entry.y;
				const broadZ = point.z - entry.z;
				if ( broadX * broadX + broadY * broadY + broadZ * broadZ
					> broadRadius * broadRadius ) continue;

			}
			const projection = entry.collider.projectPoint( point, false );
			if ( ! projection ) continue;
			let nx = projection.isInside
				? projection.point.x - point.x
				: point.x - projection.point.x;
			let ny = projection.isInside
				? projection.point.y - point.y
				: point.y - projection.point.y;
			let nz = projection.isInside
				? projection.point.z - point.z
				: point.z - projection.point.z;
			const distance = Math.hypot( nx, ny, nz );
			const correction = projection.isInside
				? distance + scaledRadius
				: scaledRadius - distance;
			if ( correction <= bestCorrection ) continue;
			if ( distance > 1e-8 ) {

				nx /= distance;
				ny /= distance;
				nz /= distance;

			} else {

				tailCollisionNormalFallback.set(
					point.x - entry.x,
					point.y - entry.y,
					point.z - entry.z,
				);
				if ( tailCollisionNormalFallback.lengthSq() < 1e-8 )
					tailCollisionNormalFallback.copy( averageSupportNormal );
				if ( tailCollisionNormalFallback.lengthSq() < 1e-8 )
					tailCollisionNormalFallback.copy( WORLD_UP );
				tailCollisionNormalFallback.normalize();
				nx = tailCollisionNormalFallback.x;
				ny = tailCollisionNormalFallback.y;
				nz = tailCollisionNormalFallback.z;

			}
			bestCorrection = correction;
			bestNormalX = nx;
			bestNormalY = ny;
			bestNormalZ = nz;
			bestPointX = projection.point.x + nx * scaledRadius;
			bestPointY = projection.point.y + ny * scaledRadius;
			bestPointZ = projection.point.z + nz * scaledRadius;

		}
		if ( includeBody ) {

		collisionLocalPoint.set( point.x, point.y, point.z )
			.sub( collisionBodyPosition ).applyQuaternion( collisionBodyInverse );
		const capsuleX = THREE.MathUtils.clamp( collisionLocalPoint.x, -0.3, 0.14 );
		let localDx = collisionLocalPoint.x - capsuleX;
		let localDy = collisionLocalPoint.y - 0.04;
		let localDz = collisionLocalPoint.z;
		let localDistance = Math.hypot( localDx, localDy, localDz );
		let inflatedRadius = 0.16 + scaledRadius;
		let bodyCorrection = inflatedRadius - localDistance;
		if ( bodyCorrection > bestCorrection ) {

			if ( localDistance < 1e-8 ) {

				localDx = 0;
				localDy = 1;
				localDz = 0;
				localDistance = 1;

			}
			collisionLocalProjection.set(
				capsuleX + localDx / localDistance * inflatedRadius,
				0.04 + localDy / localDistance * inflatedRadius,
				localDz / localDistance * inflatedRadius,
			);
			collisionWorldProjection.copy( collisionLocalProjection )
				.applyQuaternion( collisionBodyQuaternion ).add( collisionBodyPosition );
			collisionWorldNormal.set( localDx, localDy, localDz ).normalize()
				.applyQuaternion( collisionBodyQuaternion ).normalize();
			bestCorrection = bodyCorrection;
			bestPointX = collisionWorldProjection.x;
			bestPointY = collisionWorldProjection.y;
			bestPointZ = collisionWorldProjection.z;
			bestNormalX = collisionWorldNormal.x;
			bestNormalY = collisionWorldNormal.y;
			bestNormalZ = collisionWorldNormal.z;

		}
		localDx = collisionLocalPoint.x + 0.38;
		localDy = collisionLocalPoint.y - 0.055;
		localDz = collisionLocalPoint.z;
		localDistance = Math.hypot( localDx, localDy, localDz );
		inflatedRadius = 0.18 + scaledRadius;
		bodyCorrection = inflatedRadius - localDistance;
		if ( bodyCorrection > bestCorrection ) {

			if ( localDistance < 1e-8 ) {

				localDx = -1;
				localDy = 0;
				localDz = 0;
				localDistance = 1;

			}
			collisionLocalProjection.set(
				-0.38 + localDx / localDistance * inflatedRadius,
				0.055 + localDy / localDistance * inflatedRadius,
				localDz / localDistance * inflatedRadius,
			);
			collisionWorldProjection.copy( collisionLocalProjection )
				.applyQuaternion( collisionBodyQuaternion ).add( collisionBodyPosition );
			collisionWorldNormal.set( localDx, localDy, localDz ).normalize()
				.applyQuaternion( collisionBodyQuaternion ).normalize();
			bestCorrection = bodyCorrection;
			bestPointX = collisionWorldProjection.x;
			bestPointY = collisionWorldProjection.y;
			bestPointZ = collisionWorldProjection.z;
			bestNormalX = collisionWorldNormal.x;
			bestNormalY = collisionWorldNormal.y;
			bestNormalZ = collisionWorldNormal.z;

		}

		}
		if ( bestCorrection <= 0 ) return false;
		outNormal.x = bestNormalX;
		outNormal.y = bestNormalY;
		outNormal.z = bestNormalZ;
		outPoint.x = bestPointX;
		outPoint.y = bestPointY;
		outPoint.z = bestPointZ;
		return true;

	}

	function projectTailPoint( point, radius, outPoint, outNormal ) {

		const dx = point.x - tailRootAnchor.x;
		const dy = point.y - tailRootAnchor.y;
		const dz = point.z - tailRootAnchor.z;
		return projectCollisionPoint(
			point, radius, outPoint, outNormal,
			THREE.MathUtils.clamp( settings.tailCollisionScale, 0.25, 2 ),
			dx * dx + dy * dy + dz * dz > 0.22 * 0.22,
		);

	}

	function projectLimbPoint( point, radius, outPoint, outNormal, _limb, node ) {

		// The fixed-buffer capsule solver owns torso/self collisions. This callback
		// therefore performs only one bounded environment query per free node.
		if ( node <= 1 ) return false;
		return projectCollisionPoint( point, radius, outPoint, outNormal, 1, false );

	}

	function updateBodyCollisionTransform() {

		readVector( body.translation(), collisionBodyPosition );
		readQuaternion( body.rotation(), collisionBodyQuaternion );
		collisionBodyInverse.copy( collisionBodyQuaternion ).invert();

	}
	function updatePassiveTail() {

		for ( let offset = 0; offset < tailKinematicAnchors.length; offset += 3 ) {

			// The pelvis/spine pose is part of the fixed-step animation authority.
			// Read the actual authored collar origins after that pose has been solved;
			// rigid body offsets miss pelvis bob/roll and force the visual mapper to
			// rotate the collision-safe rod afterwards, invalidating its contacts.
			tailVisualRig.bones[ offset / 3 ].getWorldPosition( tailKinematicPoint );
			tailKinematicAnchors[ offset ] = tailKinematicPoint.x;
			tailKinematicAnchors[ offset + 1 ] = tailKinematicPoint.y;
			tailKinematicAnchors[ offset + 2 ] = tailKinematicPoint.z;

		}
		tailPhysics.setKinematicAnchors( tailKinematicAnchors );
		tailRootAnchor.fromArray( tailKinematicAnchors, 0 );
		// tail_01 forms the short rigid sacral collar. Physics starts at tail_02;
		// the exported geodesic skin weights spread that freedom progressively over
		// the rump instead of introducing another render-only hinge.
		tailPhysics.gravityX = world.gravity.x * settings.tailGravity;
		tailPhysics.gravityY = world.gravity.y * settings.tailGravity;
		tailPhysics.gravityZ = world.gravity.z * settings.tailGravity;
		tailPhysics.damping = THREE.MathUtils.clamp( settings.tailDamping, 0, 8 );
		tailPhysics.bendCompliance = 2e-7 * Math.pow(
			10,
			THREE.MathUtils.clamp( settings.tailFlexibility, 0, 1 ) * 3.2,
		);
		tailPhysics.stepFixed( null, projectTailPoint );

	}

	function updateActiveRigPose( dt, snap = false ) {

		const position = readVector( body.translation(), tempPosition );
		const rotation = readQuaternion( body.rotation(), tempQuaternion );
		visualRoot.position.copy( position );
		visualRoot.quaternion.copy( rotation );
		visualRoot.updateMatrixWorld( true );
		rig.restoreActive();
		const activeMuscleWeight = settings.motorStrength > 0 && ! dragging
			&& ! command.fullRagdoll
			? THREE.MathUtils.clamp( 1 - jumpPose.muscleCompliance * 0.58, 0.36, 1 )
			: 0;
		rig.solve(
			currentFootPositions,
			currentFootNormals,
			wholeBodyGait.getView().current,
			activeMuscleWeight,
			suspension.getView().current,
			dt,
			settings.suspension,
			landingCompression,
			jumpPose,
		);
		rig.applyHeadLookPose(
			headLook.getView().current,
			activeMuscleWeight,
		);
		activeRigPose.commitSolvedPose( dt, snap );

	}

	function capturePassiveLimbs() {

		rig.writePassiveLimbPositions( passiveLimbInitialPositions );
		passiveLimbPhysics.resetPositions( passiveLimbInitialPositions );
		for ( let offset = 0; offset < PASSIVE_LIMB_COMPONENT_COUNT; offset += 3 ) {

			passiveLimbRootPoint.set(
				passiveLimbInitialPositions[ offset ],
				passiveLimbInitialPositions[ offset + 1 ],
				passiveLimbInitialPositions[ offset + 2 ],
			).sub( collisionBodyPosition ).applyQuaternion( collisionBodyInverse );
			passiveLimbBodyOffsets[ offset ] = passiveLimbRootPoint.x;
			passiveLimbBodyOffsets[ offset + 1 ] = passiveLimbRootPoint.y;
			passiveLimbBodyOffsets[ offset + 2 ] = passiveLimbRootPoint.z;

		}
		passiveLimbActive = true;
		passiveLimbBlend = 1;

	}

	function updatePassiveLimbs( dt ) {

		const requested = dragging || command.fullRagdoll;
		if ( requested && ! passiveLimbActive ) capturePassiveLimbs();
		if ( ! requested && passiveLimbActive ) passiveLimbActive = false;
		if ( ! requested ) {

			passiveLimbBlend = Math.max( 0, passiveLimbBlend - dt / 0.28 );
			return;

		}
		for ( let offset = 0; offset < PASSIVE_LIMB_COMPONENT_COUNT; offset += 3 ) {

			passiveLimbMusclePoint.fromArray( passiveLimbBodyOffsets, offset )
				.applyQuaternion( collisionBodyQuaternion ).add( collisionBodyPosition );
			passiveLimbMuscleTargets[ offset ] = passiveLimbMusclePoint.x;
			passiveLimbMuscleTargets[ offset + 1 ] = passiveLimbMusclePoint.y;
			passiveLimbMuscleTargets[ offset + 2 ] = passiveLimbMusclePoint.z;

		}
		for ( let limb = 0; limb < 4; limb ++ ) {

			const source = limb * PASSIVE_LIMB_NODE_COUNT * 3;
			const target = limb * 3;
			passiveLimbRootAnchors[ target ] = passiveLimbMuscleTargets[ source ];
			passiveLimbRootAnchors[ target + 1 ] = passiveLimbMuscleTargets[ source + 1 ];
			passiveLimbRootAnchors[ target + 2 ] = passiveLimbMuscleTargets[ source + 2 ];

		}
		passiveLimbCapsulePoint.set( -0.3, 0.04, 0 )
			.applyQuaternion( collisionBodyQuaternion ).add( collisionBodyPosition )
			.toArray( passiveLimbBodyCapsules, 0 );
		passiveLimbCapsulePoint.set( 0.14, 0.04, 0 )
			.applyQuaternion( collisionBodyQuaternion ).add( collisionBodyPosition )
			.toArray( passiveLimbBodyCapsules, 3 );
		passiveLimbBodyCapsules[ 6 ] = 0.16;
		passiveLimbCapsulePoint.set( -0.38, 0.055, 0 )
			.applyQuaternion( collisionBodyQuaternion ).add( collisionBodyPosition )
			.toArray( passiveLimbBodyCapsules, 7 );
		passiveLimbCapsulePoint.toArray( passiveLimbBodyCapsules, 10 );
		passiveLimbBodyCapsules[ 13 ] = 0.18;
		passiveLimbPhysics.setMuscleTargets( passiveLimbMuscleTargets );
		passiveLimbPhysics.setMuscleTone(
			THREE.MathUtils.clamp( settings.limbMuscleTone, 0, 1 ),
		);
		passiveLimbPhysics.setBodyCapsules( passiveLimbBodyCapsules );
		passiveLimbPhysics.gravityX = world.gravity.x;
		passiveLimbPhysics.gravityY = world.gravity.y;
		passiveLimbPhysics.gravityZ = world.gravity.z;
		passiveLimbPhysics.stepFixed( passiveLimbRootAnchors, projectLimbPoint );

	}

	function beforeStep( dt ) {

		elapsed += dt;
		body.resetForces( false );
		body.resetTorques( false );
		if ( command.release && ! wasSupportReleased ) {

			clearSupportLocks();
			pendingSupportReset = false;
			supportReacquireSeconds = 0;
			reacquireSurface = null;
			reacquireCollider = null;
			reacquireState = 'released';
			reacquireOwnerAge = 0;

		} else if ( ! command.release && wasSupportReleased ) {

			armSupportReacquisition();

		}
		wasSupportReleased = command.release;
		if ( pendingSupportReset && ! reacquireCollider ) selectReacquireSurface();
		if ( reacquireCollider ) reacquireOwnerAge += dt;
		previousPosition.copy( currentPosition );
		previousQuaternion.copy( currentQuaternion );
		updateBodyCollisionTransform();
		// Once Rapier has accepted the static-friction sleep, the four locked claw
		// contacts remain authoritative until intent or an impact wakes the body.
		// Skipping the 44-ray probe fan removes the dominant idle CPU/GC cost while
		// preserving the animated visual rig and passive tail below.
		const preserveStaticContacts = staticGripLocked && body.isSleeping?.()
			&& command.move.lengthSq() <= 1e-10 && Math.abs( command.turning ) <= 1e-5
			&& ! command.sprint && ! command.release && ! command.fullRagdoll && ! dragging;
		if ( ! preserveStaticContacts ) updateCandidates();
		updateGait( dt );
		updateActiveRigPose( dt );
		updatePassiveTail();
		updatePassiveLimbs( dt );
		if ( ! preserveStaticContacts ) {

			applyRightingReflex();
			applyRootController();

		}
		updateStaticGripLock( dt );
		supportReacquireSeconds = Math.max( 0, supportReacquireSeconds - dt );
		if ( supportReacquireSeconds <= 0 ) {

			pendingSupportReset = false;
			if ( reacquireState !== 'attached'
				|| reacquireOwnerAge >= THREE.MathUtils.clamp( settings.surfaceCommitTime, 0.2, 2 ) ) {

				reacquireSurface = null;
				reacquireCollider = null;
				reacquireState = 'attached';

			}

		}

	}

	function afterStep() {

		readVector( body.translation(), currentPosition );
		readQuaternion( body.rotation(), currentQuaternion );
		bodyForward.copy( LOCAL_FORWARD ).applyQuaternion( currentQuaternion ).normalize();

	}

	function syncVisual( alpha = 1, _renderDt = 1 / 120 ) {

		const t = THREE.MathUtils.clamp( alpha, 0, 1 );
		renderPosition.lerpVectors( previousPosition, currentPosition, t );
		renderQuaternion.slerpQuaternions( previousQuaternion, currentQuaternion, t );
		visualRoot.position.copy( renderPosition );
		visualRoot.quaternion.copy( renderQuaternion );
		visualRoot.updateMatrixWorld( true );
		for ( let index = 0; index < 12; index ++ )

			renderFootPositions[ index ] = THREE.MathUtils.lerp(
				previousFootPositions[ index ], currentFootPositions[ index ], t,
			);
		activeRigPose.applyInterpolated( t );
		if ( passiveLimbBlend > 0 ) rig.applyPassive(
			passiveLimbPhysics.interpolate( t ),
			THREE.MathUtils.clamp( passiveLimbBlend, 0, 1 ),
			true,
		);
		tailVisualRig.applyPositions( tailPhysics.interpolate( t ) );
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
		rig.resetDynamics();
		activeRigPose.resetFromRig();
		rig.writePalmPositions( nominalFootPositions );
		rig.writeSocketPositions( suspensionSocketPositions );
		averageSupportNormal.copy( WORLD_UP );
		for ( let foot = 0; foot < 4; foot ++ ) {

			bodyToFootOffsets[ foot ].set(
				nominalFootPositions[ foot * 3 ] - nextSpawn.x,
				nominalFootPositions[ foot * 3 + 1 ] - nextSpawn.y,
				nominalFootPositions[ foot * 3 + 2 ] - nextSpawn.z,
			);
			bodyToSocketOffsets[ foot ].set(
				suspensionSocketPositions[ foot * 3 ] - nextSpawn.x,
				suspensionSocketPositions[ foot * 3 + 1 ] - nextSpawn.y,
				suspensionSocketPositions[ foot * 3 + 2 ] - nextSpawn.z,
			);

		}
		updateCandidates();
		// Keep the anatomical rest offsets captured from the exported contact
		// patches. The root controller must lower/tilt the body towards projected
		// terrain contacts; replacing these offsets with the first raycast result
		// would freeze the spawn height and force the limbs to stretch to the floor.
		gait.reset( gaitInput );
		wholeBodyGait.reset();
		headLook.reset();
		lookTargetWeight = 0;
		suspension.reset();
		tailRootAnchor.copy( tailRootBodyOffset ).add( nextSpawn );
		tailPhysics.reset( tailRootAnchor );
		for ( let offset = 0; offset < tailKinematicAnchors.length; offset += 3 ) {

			tailKinematicAnchors[ offset ] = nextSpawn.x + tailKinematicBodyOffsets[ offset ];
			tailKinematicAnchors[ offset + 1 ] = nextSpawn.y + tailKinematicBodyOffsets[ offset + 1 ];
			tailKinematicAnchors[ offset + 2 ] = nextSpawn.z + tailKinematicBodyOffsets[ offset + 2 ];

		}
		tailPhysics.setKinematicAnchors( tailKinematicAnchors );
		rig.writePassiveLimbPositions( passiveLimbInitialPositions );
		passiveLimbPhysics.resetPositions( passiveLimbInitialPositions );
		for ( let offset = 0; offset < PASSIVE_LIMB_COMPONENT_COUNT; offset += 3 ) {

			passiveLimbBodyOffsets[ offset ] = passiveLimbInitialPositions[ offset ] - nextSpawn.x;
			passiveLimbBodyOffsets[ offset + 1 ] = passiveLimbInitialPositions[ offset + 1 ] - nextSpawn.y;
			passiveLimbBodyOffsets[ offset + 2 ] = passiveLimbInitialPositions[ offset + 2 ] - nextSpawn.z;

		}
		passiveLimbActive = false;
		passiveLimbBlend = 0;
		currentFootPositions.set( gait.getView().footPositions );
		currentFootNormals.set( gait.getView().footNormals );
		previousFootPositions.set( currentFootPositions );
		previousFootNormals.set( currentFootNormals );
		wasFootSwinging.fill( 0 );
		supportRejectTicks.fill( 0 );
		supportRejectCooldown.fill( 0 );
		contactCount = 0;
		coherentContactMask = 0;
		for ( let foot = 0; foot < 4; foot ++ ) {

			feet[ foot ]._lockedSurface = candidateActiveContacts[ foot ]
				? feet[ foot ]._candidateSurface : null;
			feet[ foot ]._lockedCollider = candidateActiveContacts[ foot ]
				? feet[ foot ]._candidateCollider : null;
			feet[ foot ].surface = feet[ foot ]._lockedSurface;
			feet[ foot ].collider = feet[ foot ]._lockedCollider;
			activeContacts[ foot ] = feet[ foot ]._lockedSurface ? 1 : 0;
			if ( activeContacts[ foot ] ) {

				contactCount ++;
				coherentContactMask |= 1 << foot;

			}
			targetFootSurfaces[ foot ] = null;
			targetFootColliders[ foot ] = null;

		}

	}

	function reset( nextSpawn = spawn ) {

		elapsed = 0;
		dragging = false;
		supportReacquireSeconds = 0;
		pendingSupportReset = false;
		landingCompression = 0;
		jumpPose.preloadCompression = 0;
		jumpPose.takeoffExtension = 0;
		jumpPose.airborneTuck = 0;
		jumpPose.forwardLean = 0;
		jumpPose.muscleCompliance = 0;
		wasSupportReleased = false;
		staticGripSeconds = 0;
		staticGripLocked = false;
		command.release = false;
		command.move.set( 0, 0, 0 );
		command.sprint = false;
		command.turning = 0;
		command.fullRagdoll = false;
		command.facing.copy( LOCAL_FORWARD );
		command.sourceNormal.copy( WORLD_UP );
		reacquireSurface = null;
		reacquireCollider = null;
		reacquireState = 'attached';
		reacquireOwnerAge = 0;
		reacquireVentralAlignment = 1;
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
		bodyForward.copy( LOCAL_FORWARD );
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
		wholeBodyGait,
		headLook,
		suspension,
		tailPhysics,
		passiveLimbPhysics,
		tailVisualRig,
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
		get forward() {

			return bodyForward;

		},
		get contactCount() {

			return contactCount;

		},
		get candidateContactCount() {

			return candidateContactCount;

		},
		get candidateContactNormals() {

			return candidateNormals;

		},
		get candidateActiveContacts() {

			return candidateActiveContacts;

		},
		get nominalFootPositions() {

			return nominalFootPositions;

		},
		get supportReacquireSeconds() {

			return supportReacquireSeconds;

		},
		get reacquireState() {

			return reacquireState;

		},
		get reacquireColliderHandle() {

			return reacquireCollider?.handle ?? null;

		},
		get reacquireVentralAlignment() {

			return reacquireVentralAlignment;

		},
		get desiredRoot() {

			return desiredRoot;

		},
		get staticGripLocked() {

			return staticGripLocked;

		},
		setCommand( next ) {

			const requestsMotion = ( next.move?.lengthSq?.() ?? 0 ) > 1e-10
				|| Math.abs( Number.isFinite( next.turning ) ? next.turning : 0 ) > 1e-5
				|| ( next.facing ? changesFacingIntent( next.facing ) : false )
				|| next.release === true || next.fullRagdoll === true;
			if ( requestsMotion ) {

				staticGripSeconds = 0;
				if ( staticGripLocked ) releaseStaticGrip();

			}
			if ( next.move ) command.move.copy( next.move );
			if ( next.move && ! next.facing && next.move.lengthSq() > 1e-8 )
				command.facing.copy( next.move ).normalize();
			if ( next.facing ) {

				command.facing.copy( next.facing );
				if ( command.facing.lengthSq() < 1e-8 ) command.facing.copy( bodyForward );
				else command.facing.normalize();

			}
			if ( next.sourceNormal ) {

				command.sourceNormal.copy( next.sourceNormal );
				if ( command.sourceNormal.lengthSq() < 1e-8 ) command.sourceNormal.copy( WORLD_UP );
				else command.sourceNormal.normalize();

			}
			if ( next.sprint !== undefined ) command.sprint = !! next.sprint;
			if ( next.turning !== undefined ) command.turning = THREE.MathUtils.clamp(
				Number.isFinite( next.turning ) ? next.turning : 0, -1, 1,
			);
			if ( next.release !== undefined ) command.release = !! next.release;
			if ( next.fullRagdoll !== undefined ) command.fullRagdoll = !! next.fullRagdoll;

		},
		setLookTarget( target, weight = 1 ) {

			if ( ! target || ! Number.isFinite( target.x )
				|| ! Number.isFinite( target.y ) || ! Number.isFinite( target.z ) )
				throw new TypeError( 'look target must contain finite x/y/z coordinates' );
			lookTarget.copy( target );
			lookTargetWeight = THREE.MathUtils.clamp(
				Number.isFinite( weight ) ? weight : 1, 0, 1,
			);

		},
		clearLookTarget() {

			lookTargetWeight = 0;

		},
		setDragging( value ) {

			const next = !! value;
			if ( next ) releaseStaticGrip();
			if ( ! dragging && next ) {

				contactCount = 0;
				reacquireSurface = null;
				reacquireCollider = null;
				reacquireState = 'released';
				reacquireOwnerAge = 0;
				pendingSupportReset = false;
				supportReacquireSeconds = 0;
				activeContacts.fill( 0 );
				supportRejectTicks.fill( 0 );
				supportRejectCooldown.fill( 0 );
				coherentContactMask = 0;
				for ( const foot of feet ) {

					foot._lockedSurface = null;
					foot._lockedCollider = null;
					foot.surface = null;
					foot.collider = null;
					foot.load = 0;
					foot.state = 'released';

				}

			}
			if ( dragging && ! next ) {

				armSupportReacquisition();

			}
			dragging = next;

		},
		setLandingCompression( value ) {

			landingCompression = THREE.MathUtils.clamp(
				Number.isFinite( value ) ? value : 0, 0, 1,
			);

		},
		setJumpPose( value ) {

			jumpPose.preloadCompression = THREE.MathUtils.clamp(
				Number.isFinite( value?.preloadCompression ) ? value.preloadCompression : 0, 0, 1,
			);
			jumpPose.takeoffExtension = THREE.MathUtils.clamp(
				Number.isFinite( value?.takeoffExtension ) ? value.takeoffExtension : 0, 0, 1,
			);
			jumpPose.airborneTuck = THREE.MathUtils.clamp(
				Number.isFinite( value?.airborneTuck ) ? value.airborneTuck : 0, 0, 1,
			);
			jumpPose.forwardLean = THREE.MathUtils.clamp(
				Number.isFinite( value?.forwardLean ) ? value.forwardLean : 0, 0, 1,
			);
			jumpPose.muscleCompliance = THREE.MathUtils.clamp(
				Number.isFinite( value?.muscleCompliance ) ? value.muscleCompliance : 0, 0, 1,
			);

		},
		beforeStep,
		afterStep,
		syncVisual,
		reset,
		setDebugVisible,
		dispose,
	};

}
