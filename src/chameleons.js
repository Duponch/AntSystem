import * as THREE from 'three/webgpu';

import { WORLD, gfx } from './config.js';
import {
	CHAMELEON_HEAD_LOOK,
	ChameleonHeadLookModel,
} from './chameleon-head-look-model.js';
import {
	advanceChameleonCamouflageDwell,
	CHAMELEON_CAMOUFLAGE_SETTLE_SECONDS,
	CHAMELEON_STATE,
	ChameleonSimulation,
} from './chameleon-simulation.js';
import {
	instantiateChameleonAsset,
	loadChameleonAsset,
} from './chameleon-assets.js';
import {
	createChameleonCamouflageController,
} from './chameleon-camouflage.js';
import { ChameleonBodyContactSolver } from './chameleon-body-contact.js';
import {
	CHAMELEON_FOOT_COUNT,
	ChameleonProceduralGait,
} from './chameleon-procedural-gait.js';
import {
	CHAMELEON_TAIL_JOINT_COUNT,
	createChameleonRigBinding,
} from './chameleon-rig.js';
import { ChameleonTailContactSolver } from './chameleon-tail-contact.js';
import {
	createChameleonSurfaceHit,
	createChameleonSurfaceTraceBuffer,
} from './chameleon-surface-collider.js';
import { selectChameleonHost } from './chameleon-track.js';
import {
	CHAMELEON_SURFACE_KIND,
	CHAMELEON_SURFACE_KIND_NAMES,
	ChameleonSurfaceGraphBaker,
	ChameleonSurfaceRouter,
} from './chameleon-surface-graph.js';

export const CHAMELEON_WORLD_LENGTH = 3.1;

const EMPTY_PREY = Object.freeze( { count: 0 } );
const LOCAL_Y = new THREE.Vector3( 0, 1, 0 );
const CHAMELEON_LOCAL_UP = new THREE.Vector3( 0, 1, 0 );
const CHAMELEON_LOCAL_SIDE = new THREE.Vector3( 0, 0, 1 );

const STATIONARY_EPSILON = 1e-5;
const BODY_FRAME_EPSILON = 1e-8;

/**
 * Keeps authored gait dimensions proportional to the rendered animal.
 * The helper is exported so the scale contract can be regression-tested
 * without loading the GLB runtime.
 */
export function scaleChameleonStepHeight( stepHeight, visualScale ) {

	const height = Number.isFinite( stepHeight ) ? Math.max( 0, stepHeight ) : 0;
	const scale = Number.isFinite( visualScale ) ? Math.max( 0.05, visualScale ) : 1;
	return height * scale;

}

/**
 * Keeps the body heading tangent to its physical support. Attack aiming is
 * intentionally reserved for the head/tongue so a vertical prey direction can
 * never rotate the whole animal through the floor.
 */
export function projectChameleonBodyForward( forward, up, fallback, routeSign = 1 ) {

	forward.addScaledVector( up, - forward.dot( up ) );
	if ( forward.lengthSq() < BODY_FRAME_EPSILON
		|| ! Number.isFinite( forward.x + forward.y + forward.z ) ) {

		forward.copy( fallback ).multiplyScalar( routeSign < 0 ? - 1 : 1 );
		forward.addScaledVector( up, - forward.dot( up ) );

	}
	if ( forward.lengthSq() < BODY_FRAME_EPSILON
		|| ! Number.isFinite( forward.x + forward.y + forward.z ) ) {

		const ax = Math.abs( up.x );
		const ay = Math.abs( up.y );
		const az = Math.abs( up.z );
		if ( ax <= ay && ax <= az ) forward.set( 1, 0, 0 );
		else if ( ay <= az ) forward.set( 0, 1, 0 );
		else forward.set( 0, 0, 1 );
		forward.addScaledVector( up, - forward.dot( up ) );

	}
	return forward.normalize();

}

/**
 * A route rollover may retain world-space stance feet only when the next
 * corridor really begins at the current body position.
 */
export function isContinuousChameleonCorridorHandoff(
	candidate,
	x,
	y,
	z,
	maximumGap = null,
) {

	if ( ! candidate || candidate.count < 2
		|| ! Number.isFinite( candidate.x?.[ 0 ] )
		|| ! Number.isFinite( candidate.y?.[ 0 ] )
		|| ! Number.isFinite( candidate.z?.[ 0 ] )
		|| ! Number.isFinite( x ) || ! Number.isFinite( y ) || ! Number.isFinite( z ) ) return false;
	const spacing = Number.isFinite( candidate.effectiveSpacing )
		? Math.max( 0.001, candidate.effectiveSpacing )
		: 0.3;
	const tolerance = Number.isFinite( maximumGap )
		? Math.max( 0, maximumGap )
		: Math.max( 1e-4, Math.min( 0.08, spacing * 0.25 ) );
	const dx = candidate.x[ 0 ] - x;
	const dy = candidate.y[ 0 ] - y;
	const dz = candidate.z[ 0 ] - z;
	return dx * dx + dy * dy + dz * dz <= tolerance * tolerance;

}

/**
 * Writes a finite, orthonormal surface frame even when the requested forward
 * direction is vertical and therefore collinear with the preferred up vector.
 * All scratch objects are caller-owned; the render hot path allocates nothing.
 */
export function writeChameleonBodyQuaternion(
	forward,
	up,
	localX,
	localZ,
	rotationMatrix,
	targetQuaternion,
) {

	if ( forward.lengthSq() < BODY_FRAME_EPSILON
		|| ! Number.isFinite( forward.x + forward.y + forward.z ) ) forward.set( 1, 0, 0 );
	forward.normalize();
	up.addScaledVector( forward, - up.dot( forward ) );
	if ( up.lengthSq() < BODY_FRAME_EPSILON
		|| ! Number.isFinite( up.x + up.y + up.z ) ) {

		const ax = Math.abs( forward.x );
		const ay = Math.abs( forward.y );
		const az = Math.abs( forward.z );
		if ( ax <= ay && ax <= az ) up.set( 1, 0, 0 );
		else if ( ay <= az ) up.set( 0, 1, 0 );
		else up.set( 0, 0, 1 );
		up.addScaledVector( forward, - up.dot( forward ) );

	}
	up.normalize();
	localX.copy( forward ).multiplyScalar( - 1 );
	localZ.crossVectors( localX, up );
	if ( localZ.lengthSq() < BODY_FRAME_EPSILON ) {

		// Defensive fallback for malformed caller vectors. The least-aligned
		// axis chosen above normally makes this branch unreachable.
		up.set( Math.abs( localX.x ) < 0.9 ? 1 : 0, Math.abs( localX.x ) < 0.9 ? 0 : 1, 0 );
		up.addScaledVector( localX, - up.dot( localX ) ).normalize();
		localZ.crossVectors( localX, up );

	}
	localZ.normalize();
	up.crossVectors( localZ, localX ).normalize();
	rotationMatrix.makeBasis( localX, up, localZ );
	targetQuaternion.setFromRotationMatrix( rotationMatrix ).normalize();
	if ( ! Number.isFinite(
		targetQuaternion.x + targetQuaternion.y + targetQuaternion.z + targetQuaternion.w
	) ) targetQuaternion.identity();
	return targetQuaternion;

}

function setting( graphics, name, fallback ) {

	const value = graphics?.[ name ];
	return value === undefined ? fallback : value;

}

function attackState( state ) {

	return state >= CHAMELEON_STATE.AIM_AND_BRACE
		&& state <= CHAMELEON_STATE.BITE_AND_SWALLOW;

}

function revealingState( state ) {

	return state >= CHAMELEON_STATE.STRIKE_EXTEND
		&& state <= CHAMELEON_STATE.BITE_AND_SWALLOW;

}

function deterministicUnit( index, salt ) {

	let value = Math.imul( ( index + 1 ) ^ salt, 0x45d9f3b );
	value = Math.imul( value ^ ( value >>> 16 ), 0x45d9f3b );
	value ^= value >>> 16;
	return ( value >>> 0 ) / 4294967296;

}

/**
 * One skeletal animal, one fixed procedural tongue and one bounded CPU kernel.
 * The global surface graph is rebuilt only when prop or support settings change.
 */
export async function createChameleons( {
	scene,
	renderer = null,
	camera = null,
	props,
	getButterflyPredationContext = null,
	settings = gfx,
} = {} ) {

	if ( ! scene?.add ) throw new TypeError( 'createChameleons requires a scene' );
	if ( ! props?.registry ) throw new TypeError( 'createChameleons requires the props registry' );

	const asset = await loadChameleonAsset();
	const instance = instantiateChameleonAsset( asset, {
		castShadow: setting( settings, 'chameleonCastShadow', true ),
		receiveShadow: setting( settings, 'chameleonReceiveShadow', true ),
	} );
	const camouflageVisual = createChameleonCamouflageController( instance.meshes, settings );
	const group = new THREE.Group();
	group.name = 'ChameleonSystem';
	const bodyRoot = new THREE.Group();
	bodyRoot.name = 'ChameleonSurfaceFrame';
	instance.model.name = 'ChameleonModel';
	bodyRoot.add( instance.model );
	group.add( bodyRoot );

	const tongueMaterial = new THREE.MeshStandardNodeMaterial( {
		color: new THREE.Color( setting( settings, 'chameleonTongueColor', 0xd96a79 ) ),
		roughness: 0.68,
		metalness: 0,
	} );
	const tongue = new THREE.Group();
	tongue.name = 'ChameleonProceduralTongue';
	tongue.visible = false;
	const tongueTube = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.54, 1, 1, 10, 2, false ),
		tongueMaterial,
	);
	tongueTube.name = 'ChameleonTongueTube';
	const tonguePad = new THREE.Mesh(
		new THREE.SphereGeometry( 1, 12, 8 ),
		tongueMaterial,
	);
	tonguePad.name = 'ChameleonTonguePad';
	tongue.add( tongueTube, tonguePad );
	group.add( tongue );
	scene.add( group );

	const mixer = new THREE.AnimationMixer( instance.model );
	const walkAction = mixer.clipAction( asset.walkClip );
	const attackAction = mixer.clipAction( asset.attackClip );
	walkAction.setLoop( THREE.LoopRepeat, Infinity );
	attackAction.setLoop( THREE.LoopOnce, 1 );
	attackAction.clampWhenFinished = true;
	walkAction.enabled = true;
	attackAction.enabled = true;
	walkAction.paused = true;
	attackAction.paused = true;
	walkAction.play();
	attackAction.play();
	const rigBinding = createChameleonRigBinding( instance.model );
	const headLook = new ChameleonHeadLookModel( {
		seed: 0x615f3a27,
		responseFrequency: 5.1,
		weightResponseFrequency: 4.8,
	} );
	const headLookInput = Object.seal( {
		targetYaw: 0,
		targetPitch: 0,
		targetWeight: 0,
		idleWeight: 1,
	} );
	const rigSolution = rigBinding.createSolution();
	const safeLocalPose = new Float32Array( rigBinding.orderedJoints.length * 10 );
	const safeTailLocalPose = new Float32Array( CHAMELEON_TAIL_JOINT_COUNT * 4 );
	const preTailLocalPose = new Float32Array( CHAMELEON_TAIL_JOINT_COUNT * 4 );
	rigSolution.poleTargets.fill( NaN );
	rigSolution.attackProtection = 0.82;
	const gait = new ChameleonProceduralGait( {
		fixedStep: 1 / Math.max( 15, setting( settings, 'chameleonContactFrequency', 60 ) ),
		maxSubsteps: 4,
		stepDistance: 0.24,
		stepHeight: setting( settings, 'chameleonStepHeight', 0.16 ),
		minSwingDuration: 0.1,
		maxSwingDuration: 0.32,
		bodyClearance: 0,
	} );
	const bodyContacts = new ChameleonBodyContactSolver( {
		frequency: setting( settings, 'chameleonBodyContactFrequency', 30 ),
	} );
	let bodyContactView = bodyContacts.getView();
	const tailContacts = new ChameleonTailContactSolver( {
		frequency: setting( settings, 'chameleonTailContactFrequency', 30 ),
		response: 14,
		maximumAngle: 0.55,
	} );
	const gaitView = gait.getView();
	const contactCandidates = new Float32Array( CHAMELEON_FOOT_COUNT * 3 );
	const nominalContactPositions = new Float32Array( CHAMELEON_FOOT_COUNT * 3 );
	const nominalContactNormals = new Float32Array( CHAMELEON_FOOT_COUNT * 3 );
	const contactCandidateNormals = new Float32Array( CHAMELEON_FOOT_COUNT * 3 );
	const contactSupportIds = new Int16Array( CHAMELEON_FOOT_COUNT );
	const contactKinds = new Uint8Array( CHAMELEON_FOOT_COUNT );
	const contactComponentIds = new Int32Array( CHAMELEON_FOOT_COUNT ).fill( - 1 );
	const bodyProbeSupportIds = new Int32Array( 3 ).fill( - 1 );
	const bodyProbeComponentIds = new Int32Array( 3 ).fill( - 1 );
	const contactTriangleHints = new Int32Array( CHAMELEON_FOOT_COUNT );
	contactTriangleHints.fill( - 1 );
	const gaitInput = Object.seal( {
		contactPositions: contactCandidates,
		contactNormals: contactCandidateNormals,
		speed: 0,
		velocityX: 0,
		velocityY: 0,
		velocityZ: 0,
		forwardX: 1,
		forwardY: 0,
		forwardZ: 0,
	} );
	const footProjectionHit = createChameleonSurfaceHit();
	const groundProjectionHit = createChameleonSurfaceHit();
	const footProjectionQuery = {
		supportId: - 1,
		includeGround: true,
		componentId: - 1,
		groundOnly: false,
		nearestGround: true,
		clearance: 0.006,
		maxDistance: 3,
		triangleId: - 1,
	};
	const groundProjectionQuery = {
		supportId: - 1,
		includeGround: true,
		groundOnly: true,
		clearance: 0.006,
		maxDistance: 3,
	};
	const handoffTrace = createChameleonSurfaceTraceBuffer( 258, 8 );
	const handoffTraceQuery = Object.seal( {
		supportId: - 1,
		includeGround: true,
		nearestGround: true,
		groundOnly: false,
		clearance: 0.006,
		maxDistance: Infinity,
		triangleId: - 1,
		tolerance: 0.012,
		maxSegmentLength: 0.16,
		maxNormalAngle: Math.PI / 12,
		maxDepth: 8,
	} );

	const tailContactInput = Object.seal( {
		enabled: true,
		collider: null,
		binding: rigBinding,
		solution: rigSolution,
		supportId: - 1,
		componentId: - 1,
		radius: 0.075,
	} );
	let tailContactView = tailContacts.getView();
	const surfaceGraphBaker = new ChameleonSurfaceGraphBaker();
	const bodyContactInput = Object.seal( {
		enabled: true,
		collider: null,
		binding: rigBinding,
		supportId: - 1,
		componentId: - 1,
		supportIds: bodyProbeSupportIds,
		componentIds: bodyProbeComponentIds,
		radius: 0.1,
		maximumOffset: 0.25,
		canonicalX: 0, canonicalY: 0, canonicalZ: 0,
		anchorX: 0, anchorY: 0, anchorZ: 0,
	} );
	let surfaceGraph = null;
	let surfaceCollider = null;
	let surfaceRouter = null;
	let track = null;
	let host = null;
	let propRevision = - 1;
	let obstacleScale = NaN;
	let treeScale = NaN;
	let rockScale = NaN;
	let cachedSupportClearance = NaN;
	let cachedGroundClearance = NaN;
	let normalSegment = 0;
	let visualScale = NaN;
	let modelUnitScale = 1;
	let attackBlend = 0;
	let walkPhase = 0;
	let previousDistanceTravelled = 0;
	let surfaceVisible = true;
	let disposed = false;
	let castShadow = !! setting( settings, 'chameleonCastShadow', true );
	let receiveShadow = !! setting( settings, 'chameleonReceiveShadow', true );
	let selected = false;
	let camouflageCycle = 0;
	let camouflageCountdown = 0;
	let camouflageRemaining = 0;
	let scheduledCamouflage = false;
	let camouflageStationaryTime = 0;
	let camouflaged = false;
	let locomotionState = 'perch';
	let lastNetworkRevision = 0;
	let debugHasPosition = false;
	let debugPreviousX = 0;
	let debugPreviousY = 0;
	let debugPreviousZ = 0;
	let bodyOrientationReady = false;
	let bodyContactFrozen = false;
	let bodyContactHasSafePosition = false;
	let bodyPoseRequiresLegResolve = false;
	let safeTailPoseReady = false;
	let tailLocallyRecovered = false;
	let pendingTrackRollback = null;
	let pendingTrackRollbackPosition = 0;
	let pendingTrackRollbackDirection = 1;
	let pendingTrackRollbackSegment = 0;
	let pendingSurfaceGraphRollback = null;
	let pendingSurfaceColliderRollback = null;
	let pendingSurfaceRouterRollback = null;
	let pendingHostRollback = null;
	let pendingNetworkMetadataRollback = null;
	let pendingRouterProposal = null;
	let routePublicationFailures = 0;
	let failedNetworkRegistry = null;
	let failedNetworkRevision = NaN;
	let failedNetworkObstacleScale = NaN;
	let failedNetworkTreeScale = NaN;
	let failedNetworkRockScale = NaN;
	let failedNetworkSupportClearance = NaN;
	let failedNetworkGroundClearance = NaN;
	let networkRebuildFailures = 0;
	let networkRebuildError = '';
	let proceduralRigActive = false;
	let gaitReady = false;
	let contactAccumulator = Infinity;
	let groundedFeet = 0;
	let currentContactTriangle = - 1;

	const forward = new THREE.Vector3();
	const up = new THREE.Vector3();
	const localX = new THREE.Vector3();
	const localZ = new THREE.Vector3();
	const rotationMatrix = new THREE.Matrix4();
	const tongueDirection = new THREE.Vector3();
	const authoredMouth = new THREE.Vector3();
	const visualTongueTip = new THREE.Vector3();
	const mouthCorrection = new THREE.Vector3();
	const lookDirection = new THREE.Vector3();
	const lookForward = new THREE.Vector3();
	const lookUp = new THREE.Vector3();
	const lookSide = new THREE.Vector3();
	const lookAxisWorld = new THREE.Vector3();
	const lookModelWorldQuaternion = new THREE.Quaternion();
	const lookBoneWorldQuaternion = new THREE.Quaternion();
	const lookParentInverseQuaternion = new THREE.Quaternion();
	const lookDeltaQuaternion = new THREE.Quaternion();
	const lookCandidateQuaternion = new THREE.Quaternion();
	const targetBodyQuaternion = new THREE.Quaternion();
	const contactWorld = new THREE.Vector3();
	const lastSafeBodyPosition = new THREE.Vector3();
	const bodyPositionBeforeValidation = new THREE.Vector3();
	const lastSafeBodyQuaternion = new THREE.Quaternion();
	const lastSafeBodyScale = new THREE.Vector3( 1, 1, 1 );

	const supportFrontPosition = new THREE.Vector3();
	const supportBackPosition = new THREE.Vector3();
	const supportCentrePosition = new THREE.Vector3();
	const supportFrontNormal = new THREE.Vector3();
	const supportBackNormal = new THREE.Vector3();
	const supportCentreNormal = new THREE.Vector3();
	const supportCentreTangent = new THREE.Vector3();
	const footContacts = gaitView.footPositions;
	const debugView = Object.seal( {
		selected: false, visible: false, x: 0, y: 0, z: 0,
		headingX: 1, headingY: 0, headingZ: 0,
		mouthX: 0, mouthY: 0, mouthZ: 0,
		state: CHAMELEON_STATE.REST_SCAN, stateName: 'REST_SCAN',
		targetIndex: - 1, capturedIndex: - 1,
		locomotionState: 'perch', camouflaged: false,
		attackDistance: 0, detectionDistance: 0,
		supportKind: 'object', supportId: 0, supportModel: '', supportSegment: 0,
		supportNormalX: 0, supportNormalY: 1, supportNormalZ: 0,
		routePosition: 0, routeLength: 0, supportCount: 0,
		graphNodeCount: 0, explorationDecisions: 0, explorationRoutes: 0,
		camouflageRemaining: 0, networkRevision: 0,
		physicalContacts: false, groundedFeet: 0, surfaceTriangleCount: 0,
		contactFrequency: 0, gaitSteps: 0, contactTriangle: - 1,
		contactFrozen: false, bodyResidual: 0, tailResidual: 0,
		tailLocallyRecovered: false, routePublicationFailures: 0,
		networkRebuildFailures: 0, networkRebuildError: '',
		contactRecovery: 'stable',
		gaitActivePair: - 1,
		footContacts,
	} );
	const avoidanceView = Object.seal( {
		x: 0, y: 0, z: 0,
		headingX: 1, headingY: 0, headingZ: 0,
		velocityX: 0, velocityY: 0, velocityZ: 0, speed: 0,
		active: false, visible: false,
		camouflaged: false, isCamouflaged: false,
		attackDistance: 0, detectionDistance: 0,
	} );

	function createKernel() {

		return new ChameleonSimulation( {
			preyCapacity: Math.max( 1, Math.round( setting( settings, 'maxButterflies', 64 ) ) ),
			scanFrequency: setting( settings, 'chameleonScanFrequency', 9 ),
			attackDistance: setting( settings, 'chameleonAttackDistance', 3.2 ),
			detectionDistance: setting( settings, 'chameleonDetectionDistance', 4.8 ),
			maxTongueLength: setting( settings, 'chameleonTongueLength', 3.5 ),
			holdAtTrackEnd: true,
			patrolSpeed: setting( settings, 'chameleonPatrolSpeed', 1.15 ),
			trackingSpeed: setting( settings, 'chameleonTrackingSpeed', 1.45 ),
			turnSpeed: setting( settings, 'chameleonTurnSpeed', 6 ),
			restScanDuration: setting( settings, 'chameleonRestDuration', 0.55 ),
			aimDuration: setting( settings, 'chameleonAimDuration', 0.55 ),
			predictionTime: setting( settings, 'chameleonPredictionTime', 0.035 ),
			extendDuration: setting( settings, 'chameleonTongueExtendDuration', 0.055 ),
			contactDuration: setting( settings, 'chameleonContactDuration', 0.028 ),
			retractDuration: setting( settings, 'chameleonTongueRetractDuration', 0.28 ),
			biteDuration: setting( settings, 'chameleonBiteDuration', 0.24 ),
			cooldownDuration: setting( settings, 'chameleonAttackCooldown', 1.1 ),
		} );

	}

	let simulation = createKernel();

	function applyVisualScale( force = false ) {

		const requested = Math.max( 0.05, setting( settings, 'chameleonScale', 1 ) );
		if ( ! force && requested === visualScale ) return;
		visualScale = requested;
		const targetLength = Math.max(
			0.1,
			setting( settings, 'chameleonLength', CHAMELEON_WORLD_LENGTH ) * visualScale,
		);
		modelUnitScale = targetLength / asset.metrics.length;
		instance.model.scale.setScalar( modelUnitScale );
		instance.model.position.set(
			- asset.metrics.centerX * modelUnitScale,
			- asset.metrics.minY * modelUnitScale,
			- asset.metrics.centerZ * modelUnitScale,
		);

		// The exported local forward is -X. These measured offsets keep the
		// procedural tongue anchored at the authored mouth instead of a guess.
		simulation.mouthForward = Math.max(
			0.02,
			- ( asset.metrics.mouthX - asset.metrics.centerX ) * modelUnitScale,
		);
		simulation.mouthHeight = Math.max(
			0.02,
			( asset.metrics.mouthY - asset.metrics.minY ) * modelUnitScale,
		);

	}

	function makeContinuousHandoff( candidate, px, py, pz ) {

		const gap = Math.hypot(
			candidate.x[ 0 ] - px,
			candidate.y[ 0 ] - py,
			candidate.z[ 0 ] - pz,
		);
		if ( gap <= 1e-4 ) return candidate;
		if ( ! surfaceCollider ) return null;
		handoffTraceQuery.clearance = Math.max( 0,
			setting( settings, 'chameleonSupportClearance', 0.006 ) );
		handoffTraceQuery.triangleId = - 1;
		surfaceCollider.traceSegment(
			px, py, pz,
			candidate.x[ 0 ], candidate.y[ 0 ], candidate.z[ 0 ],
			handoffTrace,
			handoffTraceQuery,
		);
		if ( ! handoffTrace.valid || handoffTrace.count < 2 ) return null;
		const tracedEnd = handoffTrace.count - 1;
		const endpointGap = Math.hypot(
			handoffTrace.x[ tracedEnd ] - candidate.x[ 0 ],
			handoffTrace.y[ tracedEnd ] - candidate.y[ 0 ],
			handoffTrace.z[ tracedEnd ] - candidate.z[ 0 ],
		);
		const endpointTolerance = Math.max( 0.025, Math.min(
			0.15,
			( candidate.effectiveSpacing || 0.3 ) * 0.5,
		) );
		if ( endpointGap > endpointTolerance ) return null;

		// The trace includes both endpoints. Keep its projected endpoint and skip
		// the duplicate first sample from the freshly baked corridor.
		const bridgeCount = handoffTrace.count;
		const count = bridgeCount + candidate.count - 1;
		const corridor = {
			count,
			x: new Float32Array( count ),
			y: new Float32Array( count ),
			z: new Float32Array( count ),
			normalX: new Float32Array( count ),
			normalY: new Float32Array( count ),
			normalZ: new Float32Array( count ),
			tangentX: new Float32Array( count ),
			tangentY: new Float32Array( count ),
			tangentZ: new Float32Array( count ),
			distance: new Float32Array( count ),
			kind: new Uint8Array( count ),
			supportId: new Int16Array( count ),
			componentId: new Int32Array( count ).fill( - 1 ),
			graphNode: new Uint32Array( count ),
			triangleId: new Int32Array( count ).fill( - 1 ),
			surfaceHit: new Uint8Array( count ),
			startNode: candidate.startNode,
			targetNode: candidate.targetNode,
			pathNodeCount: candidate.pathNodeCount,
			effectiveSpacing: candidate.effectiveSpacing,
			supportCount: candidate.supportCount,
			supports: candidate.supports,
			handoff: true,
			handoffValidated: true,
		};
		for ( let index = 0; index < bridgeCount; index ++ ) {

			corridor.x[ index ] = handoffTrace.x[ index ];
			corridor.y[ index ] = handoffTrace.y[ index ];
			corridor.z[ index ] = handoffTrace.z[ index ];
			corridor.normalX[ index ] = handoffTrace.normalX[ index ];
			corridor.normalY[ index ] = handoffTrace.normalY[ index ];
			corridor.normalZ[ index ] = handoffTrace.normalZ[ index ];
			corridor.kind[ index ] = CHAMELEON_SURFACE_KIND.TRANSITION;
			// Trace support ids belong to the exact collider, while corridor ids
			// belong to the graph. Mark the bridge transitional to avoid mixing them.
			corridor.supportId[ index ] = - 1;
			corridor.componentId[ index ] = handoffTrace.componentId[ index ];
			corridor.graphNode[ index ] = candidate.startNode;
			corridor.triangleId[ index ] = handoffTrace.triangleId[ index ];
			corridor.surfaceHit[ index ] = 1;

		}
		for ( let index = 1; index < candidate.count; index ++ ) {

			const target = bridgeCount + index - 1;
			for ( const key of [ 'x', 'y', 'z', 'normalX', 'normalY', 'normalZ', 'kind', 'supportId', 'componentId' ] )
				corridor[ key ][ target ] = candidate[ key ][ index ];
			corridor.graphNode[ target ] = candidate.graphNode?.[ index ] ?? candidate.targetNode;
			corridor.triangleId[ target ] = candidate.triangleId?.[ index ] ?? - 1;
			corridor.surfaceHit[ target ] = candidate.surfaceHit?.[ index ] ?? 0;

		}
		for ( let index = 0; index < count; index ++ ) {

			const before = Math.max( 0, index - 1 );
			const after = Math.min( count - 1, index + 1 );
			let tx = corridor.x[ after ] - corridor.x[ before ];
			let ty = corridor.y[ after ] - corridor.y[ before ];
			let tz = corridor.z[ after ] - corridor.z[ before ];
			const tangentLength = Math.hypot( tx, ty, tz ) || 1;
			tx /= tangentLength; ty /= tangentLength; tz /= tangentLength;
			let nx = corridor.normalX[ index ];
			let ny = corridor.normalY[ index ];
			let nz = corridor.normalZ[ index ];
			const projection = nx * tx + ny * ty + nz * tz;
			nx -= tx * projection; ny -= ty * projection; nz -= tz * projection;
			let normalLength = Math.hypot( nx, ny, nz );
			if ( normalLength <= 1e-8 ) {

				if ( Math.abs( ty ) < 0.9 ) { nx = 0; ny = 1; nz = 0; }
				else { nx = 1; ny = 0; nz = 0; }
				const fallbackProjection = nx * tx + ny * ty + nz * tz;
				nx -= tx * fallbackProjection;
				ny -= ty * fallbackProjection;
				nz -= tz * fallbackProjection;
				normalLength = Math.hypot( nx, ny, nz ) || 1;

			}
			corridor.tangentX[ index ] = tx;
			corridor.tangentY[ index ] = ty;
			corridor.tangentZ[ index ] = tz;
			corridor.normalX[ index ] = nx / normalLength;
			corridor.normalY[ index ] = ny / normalLength;
			corridor.normalZ[ index ] = nz / normalLength;
			if ( index > 0 ) corridor.distance[ index ] = corridor.distance[ index - 1 ]
				+ Math.hypot(
					corridor.x[ index ] - corridor.x[ index - 1 ],
					corridor.y[ index ] - corridor.y[ index - 1 ],
					corridor.z[ index ] - corridor.z[ index - 1 ],
				);

		}
		corridor.length = corridor.distance[ count - 1 ];
		return Object.freeze( corridor );

	}

	function invalidateContactTriangleHints() {

		contactTriangleHints.fill( - 1 );
		footProjectionQuery.triangleId = - 1;

		tailContacts.invalidateHints();
		bodyContacts.invalidateHints();
	}

	function installCorridor( candidate, {
		preservePosition = false,
		preserveGait = false,
	} = {} ) {

		let next = candidate;
		if ( ! candidate || candidate.count < 2 ) return false;
		const preserveHeading = !! track;
		const keepWorldContacts = !! track && gaitReady && preserveGait
			&& isContinuousChameleonCorridorHandoff(
				candidate,
				simulation.x,
				simulation.y,
				simulation.z,
			);
		const headingX = simulation.headingX;
		const headingY = simulation.headingY;
		const headingZ = simulation.headingZ;
		if ( preservePosition && track ) {

			sampleSupport(
				simulation.trackPosition,
				supportCentrePosition,
				supportCentreNormal,
				supportCentreTangent,
			);
			next = makeContinuousHandoff(
				candidate,
				simulation.x, simulation.y, simulation.z,
			);
			if ( ! next ) {

				contactAccumulator = Infinity;
				surfaceRouter?.rebase( simulation.x, simulation.y, simulation.z );
				routePublicationFailures ++;
				invalidateContactTriangleHints();
				return false;

			}

		}
		if ( preservePosition && track ) {

			pendingTrackRollback = track;
			pendingTrackRollbackPosition = simulation.trackPosition;
			pendingTrackRollbackDirection = simulation.patrolDirection;
			pendingTrackRollbackSegment = normalSegment;

		}
		track = next;
		simulation.trackPosition = 0;
		simulation.patrolDirection = 1;
		simulation.setTrackSamples( track );

		if ( preserveHeading ) simulation.setHeading( headingX, headingY, headingZ );
		normalSegment = 0;
		if ( ! keepWorldContacts ) gaitReady = false;
		contactAccumulator = Infinity;
		invalidateContactTriangleHints();
		routePublicationFailures = 0;
		return true;

	}

	function clearPendingCorridorRollback() {

		pendingTrackRollback = null;
		pendingTrackRollbackPosition = 0;
		pendingTrackRollbackDirection = 1;
		pendingTrackRollbackSegment = 0;
		pendingSurfaceGraphRollback = null;
		pendingSurfaceColliderRollback = null;
		pendingSurfaceRouterRollback = null;
		pendingHostRollback = null;
		pendingNetworkMetadataRollback = null;

	}
	function acceptPendingCorridorPublication() {

		const accepted = !! pendingRouterProposal || !! pendingTrackRollback;
		if ( pendingRouterProposal ) {

			pendingRouterProposal.acceptProposal();
			pendingRouterProposal = null;

		}
		clearPendingCorridorRollback();
		return accepted;

	}

	function resumeCorridorAwayFromFailure( reverseDirection = true ) {

		if ( ! track ) return false;
		let direction = simulation.patrolDirection < 0 ? - 1 : 1;
		if ( reverseDirection ) direction = - direction;
		const outwardAtStart = simulation.trackPosition <= 1e-5 && direction < 0;
		const outwardAtEnd = simulation.trackPosition >= track.length - 1e-5 && direction > 0;
		simulation.patrolDirection = direction;
		simulation.setTrackPosition( simulation.trackPosition, direction );
		// At a corridor boundary there is no safe distance left to retreat through;
		// ask the explorer for a new branch on the next fixed tick instead.
		simulation.routeCompleted = outwardAtStart || outwardAtEnd ? 1 : 0;
		surfaceRouter?.rebase( simulation.x, simulation.y, simulation.z );
		gaitReady = false;
		contactAccumulator = Infinity;
		invalidateContactTriangleHints();
		return true;

	}

	function restorePendingCorridor() {

		if ( ! pendingTrackRollback ) return false;
		if ( pendingRouterProposal ) {

			pendingRouterProposal.rejectProposal();
			pendingRouterProposal = null;

		}
		const rollbackTrack = pendingTrackRollback;
		const rollbackPosition = pendingTrackRollbackPosition;
		const rollbackDirection = pendingTrackRollbackDirection;
		const rollbackSegment = pendingTrackRollbackSegment;
		const rollbackGraph = pendingSurfaceGraphRollback;
		const rollbackCollider = pendingSurfaceColliderRollback;
		const rollbackRouter = pendingSurfaceRouterRollback;
		const rollbackHost = pendingHostRollback;
		const rollbackMetadata = pendingNetworkMetadataRollback;
		if ( rollbackMetadata ) {

			surfaceGraph = rollbackGraph;
			surfaceCollider = rollbackCollider;
			surfaceRouter = rollbackRouter;
			host = rollbackHost;
			propRevision = rollbackMetadata.propRevision;
			obstacleScale = rollbackMetadata.obstacleScale;
			treeScale = rollbackMetadata.treeScale;
			rockScale = rollbackMetadata.rockScale;
			cachedSupportClearance = rollbackMetadata.supportClearance;
			cachedGroundClearance = rollbackMetadata.groundClearance;
			lastNetworkRevision = rollbackMetadata.networkRevision;

		}
		track = rollbackTrack;
		simulation.setTrackSamples( track );
		simulation.patrolDirection = rollbackDirection;
		simulation.setTrackPosition( rollbackPosition, rollbackDirection );
		normalSegment = Math.min( track.count - 2, Math.max( 0, rollbackSegment ) );
		clearPendingCorridorRollback();
		return resumeCorridorAwayFromFailure();

	}

	function routePublicationIsSafe( roamingEnabled ) {

		if ( ! track ) return true;
		if ( attackState( simulation.state )
			|| simulation.targetIndex >= 0 || simulation.capturedIndex >= 0 ) return false;
		if ( simulation.routeCompleted ) return true;
		return ! roamingEnabled
			&& simulation.state === CHAMELEON_STATE.REST_SCAN
			&& simulation.getTelemetry().lastStepDistance <= STATIONARY_EPSILON;

	}
	function failedNetworkSignatureMatches(
		revision,
		nextObstacleScale,
		nextTreeScale,
		nextRockScale,
		supportClearance,
		groundClearance,
	) {

		return props.registry === failedNetworkRegistry
			&& revision === failedNetworkRevision
			&& nextObstacleScale === failedNetworkObstacleScale
			&& nextTreeScale === failedNetworkTreeScale
			&& nextRockScale === failedNetworkRockScale
			&& supportClearance === failedNetworkSupportClearance
			&& groundClearance === failedNetworkGroundClearance;

	}

	function clearFailedNetworkSignature() {

		failedNetworkRegistry = null;
		failedNetworkRevision = NaN;
		failedNetworkObstacleScale = NaN;
		failedNetworkTreeScale = NaN;
		failedNetworkRockScale = NaN;
		failedNetworkSupportClearance = NaN;
		failedNetworkGroundClearance = NaN;

	}

	function recordNetworkRebuildFailure(
		error,
		revision,
		nextObstacleScale,
		nextTreeScale,
		nextRockScale,
		supportClearance,
		groundClearance,
		backoff = true,
	) {

		networkRebuildFailures ++;
		networkRebuildError = String( error?.message || error || 'reconstruction refusee' ).slice( 0, 240 );
		clearFailedNetworkSignature();
		if ( ! backoff ) return;
		failedNetworkRegistry = props.registry;
		failedNetworkRevision = revision;
		failedNetworkObstacleScale = nextObstacleScale;
		failedNetworkTreeScale = nextTreeScale;
		failedNetworkRockScale = nextRockScale;
		failedNetworkSupportClearance = supportClearance;
		failedNetworkGroundClearance = groundClearance;

	}

	function rebuildTrack( force = false ) {

		// Proposals normally close in the fixed step that created them. A forced
		// rebuild still rejects an orphaned proposal defensively before replacing
		// its router.
		if ( pendingRouterProposal ) {

			if ( ! force ) return false;
			if ( ! restorePendingCorridor() ) {

				pendingRouterProposal.rejectProposal();
				pendingRouterProposal = null;
				clearPendingCorridorRollback();

			}

		}
		const revision = typeof props.getRevision === 'function' ? props.getRevision() : 0;
		const nextObstacleScale = Math.max( 0.01, setting( settings, 'scaleObstacles', 1 ) );
		const nextTreeScale = Math.max( 0.01, setting( settings, 'scaleTrees', 1 ) );
		const nextRockScale = Math.max( 0.01, setting( settings, 'scaleRocks', 1 ) );
		const roamingEnabled = setting( settings, 'chameleonRoamingEnabled', true ) !== false;
		const supportClearance = Math.max( 0, setting(
			settings,
			'chameleonSupportClearance',
			setting( settings, 'chameleonLogClearance', 0.006 ),
		) );
		const groundClearance = Math.max( 0.24, asset.metrics.width * modelUnitScale * 0.42 );
		const changed = force || ! surfaceGraph
			|| revision !== propRevision
			|| nextObstacleScale !== obstacleScale
			|| nextTreeScale !== treeScale
			|| nextRockScale !== rockScale
			|| supportClearance !== cachedSupportClearance
			|| groundClearance !== cachedGroundClearance;
		if ( ! changed ) return false;
		if ( ! force && failedNetworkSignatureMatches(
			revision,
			nextObstacleScale,
			nextTreeScale,
			nextRockScale,
			supportClearance,
			groundClearance,
		) ) return false;
		if ( ! force && ! routePublicationIsSafe( roamingEnabled ) ) return false;

		const previousTrack = track;
		const previousTrackPosition = simulation.trackPosition;
		const previousTrackDirection = simulation.patrolDirection;
		const previousNormalSegment = normalSegment;
		const previousGaitReady = gaitReady;
		const previousContactAccumulator = contactAccumulator;
		const previousX = simulation.x;
		const previousY = simulation.y;
		const previousZ = simulation.z;
		const previousSurfaceGraph = surfaceGraph;
		const previousSurfaceCollider = surfaceCollider;
		const previousSurfaceRouter = surfaceRouter;
		const previousHost = host;
		const previousNetworkMetadata = Object.freeze( {
			propRevision,
			obstacleScale,
			treeScale,
			rockScale,
			supportClearance: cachedSupportClearance,
			groundClearance: cachedGroundClearance,
			networkRevision: lastNetworkRevision,
		} );

		let nextHost;
		let nextSurfaceGraph;
		let nextSurfaceCollider;
		let nextSurfaceRouter;
		let candidate;
		try {

			nextHost = selectChameleonHost( props.registry );
			const baked = surfaceGraphBaker.update( props.registry, {
				revision,
				host: nextHost,
				worldSize: WORLD,
				scales: {
					obstacles: nextObstacleScale,
					trees: nextTreeScale,
					rocks: nextRockScale,
				},
				supportClearance,
				groundClearance,
			} );
			nextSurfaceGraph = baked.graph;
			nextSurfaceCollider = nextSurfaceGraph.collider;
			nextSurfaceRouter = new ChameleonSurfaceRouter( nextSurfaceGraph, {
				seed: 0x51f15e,
				spacing: 0.3,
				horizonDistance: 11,
				maxSamples: 352,
			} );
			if ( previousTrack ) nextSurfaceRouter.rebase( previousX, previousY, previousZ );
			const roamingRadius = Math.max( 2,
				setting( settings, 'chameleonRoamingRadius', Math.ceil( WORLD * Math.SQRT2 ) ) );
			candidate = nextSurfaceRouter.exploreNext( roamingRadius );

		} catch ( error ) {

			recordNetworkRebuildFailure(
				error,
				revision,
				nextObstacleScale,
				nextTreeScale,
				nextRockScale,
				supportClearance,
				groundClearance,
			);
			return false;

		}

		// Publish locally only for the exact collider handoff. JavaScript execution
		// is single-threaded; no renderer can observe these values before commit or
		// rollback below.
		host = nextHost;
		surfaceGraph = nextSurfaceGraph;
		surfaceCollider = nextSurfaceCollider;
		surfaceRouter = nextSurfaceRouter;
		let installed = false;
		const rebuildFailuresBeforeInstall = networkRebuildFailures;
		try {

			installed = installCorridor( candidate, {
				preservePosition: !! previousTrack,
				// A graph rebake may replace or move the support under the animal.
				// Always refresh its stance from exact contacts after publication.
				preserveGait: false,
			} );

		} catch ( error ) {

			recordNetworkRebuildFailure(
				error,
				revision,
				nextObstacleScale,
				nextTreeScale,
				nextRockScale,
				supportClearance,
				groundClearance,
			);

		}
		if ( ! installed ) {

			surfaceGraph = previousSurfaceGraph;
			surfaceCollider = previousSurfaceCollider;
			surfaceRouter = previousSurfaceRouter;
			host = previousHost;
			if ( track !== previousTrack ) {

				track = previousTrack;
				if ( previousTrack ) {

					simulation.setTrackSamples( previousTrack );
					simulation.patrolDirection = previousTrackDirection;
					simulation.setTrackPosition( previousTrackPosition, previousTrackDirection );
					normalSegment = previousNormalSegment;

				}

			}
			gaitReady = previousGaitReady;
			contactAccumulator = previousContactAccumulator;
			clearPendingCorridorRollback();
			if ( networkRebuildFailures === rebuildFailuresBeforeInstall ) recordNetworkRebuildFailure(
				'corridor handoff rejected',
				revision,
				nextObstacleScale,
				nextTreeScale,
				nextRockScale,
				supportClearance,
				groundClearance,
				! previousTrack,
			);
			return false;

		}
		if ( previousTrack ) {

			pendingSurfaceGraphRollback = previousSurfaceGraph;
			pendingSurfaceColliderRollback = previousSurfaceCollider;
			pendingSurfaceRouterRollback = previousSurfaceRouter;
			pendingHostRollback = previousHost;
			pendingNetworkMetadataRollback = previousNetworkMetadata;

		}
		propRevision = revision;
		obstacleScale = nextObstacleScale;
		treeScale = nextTreeScale;
		rockScale = nextRockScale;
		cachedSupportClearance = supportClearance;
		cachedGroundClearance = groundClearance;
		lastNetworkRevision ++;
		clearFailedNetworkSignature();
		networkRebuildError = '';
		// Geometry, handoff continuity and clearance are authoritative fixed-step
		// contracts. Publish synchronously so hidden/high-speed simulation never waits
		// for a renderer frame to continue its route lifecycle.
		acceptPendingCorridorPublication();
		group.visible = surfaceVisible && setting( settings, 'chameleonEnabled', true ) !== false;
		return true;

	}
	function advanceExplorationRoute() {

		// Defensive invariant: proposals are normally accepted or rejected before
		// this fixed-step call returns, never by a later renderer frame.
		if ( pendingRouterProposal ) return false;
		if ( ! surfaceRouter || ! simulation.routeCompleted ) return false;
		if ( setting( settings, 'chameleonRoamingEnabled', true ) === false ) return false;
		if ( simulation.state !== CHAMELEON_STATE.REST_SCAN
			|| simulation.targetIndex >= 0 || simulation.capturedIndex >= 0 ) return false;
		const roamingRadius = Math.max( 2,
			setting( settings, 'chameleonRoamingRadius', Math.ceil( WORLD * Math.SQRT2 ) ) );
		const proposalRouter = surfaceRouter;
		// Rebase once on the actual logical position before the transactional route
		// choice. This keeps long traversals and endpoint rollovers exact.
		proposalRouter.rebase( simulation.x, simulation.y, simulation.z );
		proposalRouter.beginProposal();
		let candidate;
		try {

			candidate = proposalRouter.exploreNext( roamingRadius );

		} catch ( error ) {

			proposalRouter.rejectProposal();
			throw error;

		}
		const installed = installCorridor( candidate, {
			preserveGait: true,
			preservePosition: true,
		} );
		if ( installed ) {

			pendingRouterProposal = proposalRouter;
			// The exact collider already validated the whole handoff/corridor. Accept in
			// logical time; visual IK/contact correction must never gate later fixed ticks.
			acceptPendingCorridorPublication();

		} else {

			proposalRouter.rejectProposal();
			resumeCorridorAwayFromFailure();

		}
		return installed;

	}
	function sampleSupport( distance, positionOut, normalOut, tangentOut = null ) {

		distance = Math.min( track.length, Math.max( 0, distance ) );
		const lastSegment = track.count - 2;
		while ( normalSegment > 0 && distance < track.distance[ normalSegment ] ) normalSegment --;
		while (
			normalSegment < lastSegment
			&& distance > track.distance[ normalSegment + 1 ]
		) normalSegment ++;
		const start = track.distance[ normalSegment ];
		const end = track.distance[ normalSegment + 1 ];
		const alpha = end > start ? ( distance - start ) / ( end - start ) : 0;
		positionOut.set(
			track.x[ normalSegment ]
				+ ( track.x[ normalSegment + 1 ] - track.x[ normalSegment ] ) * alpha,
			track.y[ normalSegment ]
				+ ( track.y[ normalSegment + 1 ] - track.y[ normalSegment ] ) * alpha,
			track.z[ normalSegment ]
				+ ( track.z[ normalSegment + 1 ] - track.z[ normalSegment ] ) * alpha,
		);
		normalOut.set(
			track.normalX[ normalSegment ]
				+ ( track.normalX[ normalSegment + 1 ] - track.normalX[ normalSegment ] ) * alpha,
			track.normalY[ normalSegment ]
				+ ( track.normalY[ normalSegment + 1 ] - track.normalY[ normalSegment ] ) * alpha,
			track.normalZ[ normalSegment ]
				+ ( track.normalZ[ normalSegment + 1 ] - track.normalZ[ normalSegment ] ) * alpha,
		).normalize();
		if ( tangentOut ) tangentOut.set(
			track.tangentX[ normalSegment ]
				+ ( track.tangentX[ normalSegment + 1 ] - track.tangentX[ normalSegment ] ) * alpha,
			track.tangentY[ normalSegment ]
				+ ( track.tangentY[ normalSegment + 1 ] - track.tangentY[ normalSegment ] ) * alpha,
			track.tangentZ[ normalSegment ]
				+ ( track.tangentZ[ normalSegment + 1 ] - track.tangentZ[ normalSegment ] ) * alpha,
		).normalize();
		return normalSegment;

	}

	function orientBody( view, renderDt = 0 ) {

		forward.set( view.headingX, view.headingY, view.headingZ ).normalize();
		const centreSegment = sampleSupport(
			view.trackPosition, supportCentrePosition, supportCentreNormal, supportCentreTangent,
		);
		const routeSign = forward.dot( supportCentreTangent ) < 0 ? - 1 : 1;
		const halfContactLength = Math.max( 0.12,
			setting( settings, 'chameleonLength', CHAMELEON_WORLD_LENGTH ) * visualScale * 0.27 );
		const frontSegment = sampleSupport(
			view.trackPosition + routeSign * halfContactLength,
			supportFrontPosition, supportFrontNormal,
		);
		const backSegment = sampleSupport(
			view.trackPosition - routeSign * halfContactLength,
			supportBackPosition, supportBackNormal,
		);

		if ( ! attackState( view.state ) ) {

			forward.subVectors( supportFrontPosition, supportBackPosition );
			if ( forward.lengthSq() < 1e-8 ) forward.copy( supportCentreTangent ).multiplyScalar( routeSign );
			forward.normalize();

		}
		up.copy( supportFrontNormal ).add( supportBackNormal );
		if ( up.lengthSq() < 1e-7 ) up.copy( supportCentreNormal );
		up.normalize();
		projectChameleonBodyForward( forward, up, supportCentreTangent, routeSign );
		writeChameleonBodyQuaternion(
			forward,
			up,
			localX,
			localZ,
			rotationMatrix,
			targetBodyQuaternion,
		);
		if ( bodyContactFrozen && bodyContactHasSafePosition ) {

			bodyRoot.position.copy( lastSafeBodyPosition );
			bodyRoot.quaternion.copy( lastSafeBodyQuaternion );
			bodyRoot.scale.copy( lastSafeBodyScale );
			bodyOrientationReady = true;

		} else {

			if ( ! bodyOrientationReady || renderDt <= 0 ) {

				bodyRoot.quaternion.copy( targetBodyQuaternion );
				bodyOrientationReady = true;

			} else {

				const response = Math.max( 0.1, setting( settings, 'chameleonTurnSpeed', 6 ) );
				const blend = 1 - Math.exp( - response * Math.min( 0.1, renderDt ) );
				bodyRoot.quaternion.slerp( targetBodyQuaternion, blend );

			}
			bodyRoot.position.set(
				view.x + bodyContactView.offset[ 0 ],
				view.y + bodyContactView.offset[ 1 ],
				view.z + bodyContactView.offset[ 2 ],
			);

		}
		instance.model.updateWorldMatrix( true, false );
		for ( let foot = 0; foot < CHAMELEON_FOOT_COUNT; foot ++ ) {

			const offset = foot * 3;
			const frontFoot = foot < 2;
			const segment = frontFoot ? frontSegment : backSegment;
			const normal = frontFoot ? supportFrontNormal : supportBackNormal;
			contactWorld.set(
				rigBinding.restSole[ offset ],
				rigBinding.restSole[ offset + 1 ],
				rigBinding.restSole[ offset + 2 ],
			).applyMatrix4( instance.model.matrixWorld );
			nominalContactPositions[ offset ] = contactWorld.x;
			nominalContactPositions[ offset + 1 ] = contactWorld.y;
			nominalContactPositions[ offset + 2 ] = contactWorld.z;
			nominalContactNormals[ offset ] = normal.x;
			nominalContactNormals[ offset + 1 ] = normal.y;
			nominalContactNormals[ offset + 2 ] = normal.z;
			contactSupportIds[ foot ] = track.supportId[ segment ];
			contactComponentIds[ foot ] = track.componentId?.[ segment ] ?? - 1;
			contactKinds[ foot ] = track.kind[ segment ];

		}
		// Sampling front then back mutates the cached search cursor. The canonical
		// segment remains the body centre for debug and all later route decisions.
		normalSegment = centreSegment;

	}
	function writeProjectedContact( foot, hit ) {

		const offset = foot * 3;
		contactCandidates[ offset ] = hit.x;
		contactCandidates[ offset + 1 ] = hit.y;
		contactCandidates[ offset + 2 ] = hit.z;
		contactCandidateNormals[ offset ] = hit.nx;
		contactCandidateNormals[ offset + 1 ] = hit.ny;
		contactCandidateNormals[ offset + 2 ] = hit.nz;
		contactTriangleHints[ foot ] = ! hit.isGround && hit.triangleId >= 0
			? hit.triangleId
			: - 1;
		if ( hit.triangleId >= 0 ) currentContactTriangle = hit.triangleId;
		groundedFeet ++;

	}

	function projectContactCandidate( foot ) {

		const offset = foot * 3;
		const x = nominalContactPositions[ offset ];
		const y = nominalContactPositions[ offset + 1 ];
		const z = nominalContactPositions[ offset + 2 ];
		const kind = contactKinds[ foot ];
		const graphSupportId = contactSupportIds[ foot ];
		const componentId = contactComponentIds[ foot ];
		const exactSupportId = graphSupportId >= 0
			? surfaceGraph?.colliderSupportIds?.[ graphSupportId ] ?? - 1
			: - 1;
		let selectedHit = footProjectionHit;

		if ( kind === CHAMELEON_SURFACE_KIND.TERRAIN ) {

			contactTriangleHints[ foot ] = - 1;
			surfaceCollider.projectPoint( x, y, z, groundProjectionHit, groundProjectionQuery );
			selectedHit = groundProjectionHit;

		} else {

			footProjectionQuery.supportId = exactSupportId;
			footProjectionQuery.componentId = componentId;
			if ( exactSupportId < 0 && componentId < 0 ) contactTriangleHints[ foot ] = - 1;
			footProjectionQuery.triangleId = contactTriangleHints[ foot ];
			surfaceCollider.projectPoint( x, y, z, footProjectionHit, footProjectionQuery );

		}
		if ( selectedHit.hit ) {

			writeProjectedContact( foot, selectedHit );
			return;

		}
		contactCandidates[ offset ] = x;
		contactCandidates[ offset + 1 ] = y;
		contactCandidates[ offset + 2 ] = z;
		contactCandidateNormals[ offset ] = nominalContactNormals[ offset ];
		contactCandidateNormals[ offset + 1 ] = nominalContactNormals[ offset + 1 ];
		contactCandidateNormals[ offset + 2 ] = nominalContactNormals[ offset + 2 ];
		contactTriangleHints[ foot ] = - 1;

	}

	function updateProceduralContacts( renderDt, view ) {

		const enabled = setting( settings, 'chameleonContactPhysics', true ) !== false
			&& !! surfaceCollider;
		if ( ! enabled ) {

			contactCandidates.set( nominalContactPositions );
			contactCandidateNormals.set( nominalContactNormals );
			footContacts.set( nominalContactPositions );
			gaitReady = false;
			groundedFeet = 0;
			currentContactTriangle = - 1;
			invalidateContactTriangleHints();
			return false;

		}

		const frequency = Math.max( 15, Math.min( 120,
			setting( settings, 'chameleonContactFrequency', 60 ) ) );
		const fixedStep = 1 / frequency;
		gait.fixedStep = fixedStep;
		gait.minSwingDuration = Math.max( fixedStep, 0.1 );
		gait.stepHeight = scaleChameleonStepHeight(
			setting( settings, 'chameleonStepHeight', 0.16 ), visualScale,
		);
		gait.stepDistance = Math.max( 0.04,
			setting( settings, 'chameleonStrideLength', 1.35 ) * visualScale * 0.32 );
		gait.minTargetError = gait.stepDistance * 0.12;
		const clearance = Math.max( 0,
			setting( settings, 'chameleonSupportClearance', 0.006 ) );
		footProjectionQuery.clearance = clearance;
		groundProjectionQuery.clearance = clearance;

		contactAccumulator = Number.isFinite( contactAccumulator )
			? contactAccumulator + renderDt
			: fixedStep;
		const refresh = ! gaitReady || contactAccumulator + 1e-9 >= fixedStep;
		if ( refresh ) {

			contactAccumulator %= fixedStep;
			groundedFeet = 0;
			currentContactTriangle = - 1;
			for ( let foot = 0; foot < CHAMELEON_FOOT_COUNT; foot ++ ) {

				projectContactCandidate( foot );

			}

		}
		gaitInput.speed = avoidanceView.speed;
		gaitInput.velocityX = avoidanceView.velocityX;
		gaitInput.velocityY = avoidanceView.velocityY;
		gaitInput.velocityZ = avoidanceView.velocityZ;
		gaitInput.forwardX = forward.x;
		gaitInput.forwardY = forward.y;
		gaitInput.forwardZ = forward.z;

		let discontinuity = ! gaitReady;
		const maximumLag = Math.max( 0.4,
			setting( settings, 'chameleonLength', CHAMELEON_WORLD_LENGTH ) * visualScale * 0.62 );
		if ( gaitReady && refresh ) for ( let offset = 0; offset < footContacts.length; offset += 3 ) {

			if ( Math.hypot(
				contactCandidates[ offset ] - footContacts[ offset ],
				contactCandidates[ offset + 1 ] - footContacts[ offset + 1 ],
				contactCandidates[ offset + 2 ] - footContacts[ offset + 2 ],
			) > maximumLag ) {

				discontinuity = true;
				break;

			}

		}
		if ( discontinuity ) {

			gait.reset( gaitInput );
			gaitReady = true;

		} else gait.update( renderDt, gaitInput );
		return true;

	}

	function rollbackUnsafeContact( view ) {

		// Render-only fail-closed recovery. Never rewind the deterministic kernel,
		// route direction, router history or lifecycle from a renderer observation.
		bodyContactFrozen = true;
		if ( bodyContactHasSafePosition ) {

			bodyRoot.position.copy( lastSafeBodyPosition );
			bodyRoot.quaternion.copy( lastSafeBodyQuaternion );
			bodyRoot.scale.copy( lastSafeBodyScale );
			bodyRoot.updateWorldMatrix( true, false );
			rigBinding.applyLocalPose( safeLocalPose );

		} else {

			// No validated visual pose exists yet: hide the animal for this frame
			// instead of exposing a penetrating authored pose or zeroed safe buffer.
			bodyRoot.position.set( view.x, view.y, view.z );
			group.visible = false;
			tongue.visible = false;

		}
		invalidateContactTriangleHints();

	}
	function commitSafeContactPose( view ) {

		// Defensive only: normal publications are accepted synchronously in the
		// fixed-step. Keeping this idempotent close protects future call sites.
		acceptPendingCorridorPublication();
		bodyContactFrozen = false;
		routePublicationFailures = 0;
		lastSafeBodyPosition.copy( bodyRoot.position );
		lastSafeBodyQuaternion.copy( bodyRoot.quaternion );
		lastSafeBodyScale.copy( bodyRoot.scale );
		rigBinding.writeLocalPose( safeLocalPose );
		bodyContactHasSafePosition = true;

	}

	function updateBodyContacts( renderDt, view ) {

		const segment = track && track.count > 0
			? Math.min( track.count - 1, Math.max( 0, normalSegment ) )
			: 0;
		const kind = track?.kind?.[ segment ] ?? CHAMELEON_SURFACE_KIND.TERRAIN;
		const graphSupportId = track?.supportId?.[ segment ] ?? - 1;
		const exactSupportId = graphSupportId >= 0
			? surfaceGraph?.colliderSupportIds?.[ graphSupportId ] ?? - 1
			: - 1;
		// Pelvis, centre and chest can straddle an explicit support portal. Scope
		// each fixed BVH probe to the surface sampled under that body region.
		const backGraphSupportId = contactSupportIds[ 2 ];
		const frontGraphSupportId = contactSupportIds[ 0 ];
		bodyProbeSupportIds[ 0 ] = contactKinds[ 2 ] === CHAMELEON_SURFACE_KIND.TERRAIN
			? - 1 : surfaceGraph?.colliderSupportIds?.[ backGraphSupportId ] ?? - 1;
		bodyProbeSupportIds[ 1 ] = kind === CHAMELEON_SURFACE_KIND.TERRAIN
			? - 1 : exactSupportId;
		bodyProbeSupportIds[ 2 ] = contactKinds[ 0 ] === CHAMELEON_SURFACE_KIND.TERRAIN
			? - 1 : surfaceGraph?.colliderSupportIds?.[ frontGraphSupportId ] ?? - 1;
		bodyProbeComponentIds[ 0 ] = contactKinds[ 2 ] === CHAMELEON_SURFACE_KIND.TERRAIN
			? - 1 : contactComponentIds[ 2 ];
		bodyProbeComponentIds[ 1 ] = kind === CHAMELEON_SURFACE_KIND.TERRAIN
			? - 1 : track?.componentId?.[ segment ] ?? - 1;
		bodyProbeComponentIds[ 2 ] = contactKinds[ 0 ] === CHAMELEON_SURFACE_KIND.TERRAIN
			? - 1 : contactComponentIds[ 0 ];
		bodyContacts.frequency = Math.max( 15, Math.min( 60,
			setting( settings, 'chameleonBodyContactFrequency', 30 ) ) );
		bodyContactInput.enabled = setting( settings, 'chameleonContactPhysics', true ) !== false
			&& setting( settings, 'chameleonBodyContacts', true ) !== false
			&& gaitReady && !! track && !! surfaceCollider;
		bodyContactInput.collider = surfaceCollider;
		bodyContactInput.supportId = kind === CHAMELEON_SURFACE_KIND.TERRAIN
			? - 1
			: exactSupportId;
		bodyContactInput.componentId = kind === CHAMELEON_SURFACE_KIND.TERRAIN
			? - 1
			: track?.componentId?.[ segment ] ?? - 1;
		bodyContactInput.canonicalX = view.x;
		bodyContactInput.canonicalY = view.y;
		bodyContactInput.canonicalZ = view.z;
		// The corridor already carries calibrated body clearance. Foot centroid is
		// not a body target, so collision correction starts from zero translation.
		bodyContactInput.anchorX = view.x;
		bodyContactInput.anchorY = view.y;
		bodyContactInput.anchorZ = view.z;
		const radius = Math.max( 0.02,
			setting( settings, 'chameleonBodyProbeRadius', 0.1 ) * visualScale );
		bodyContactInput.radius = radius;
		// Body safety is independent from one locally saturated limb. Coupling this
		// budget to the smallest IK slack previously collapsed it to 5 mm whenever
		// one authored foot target was unreachable and deadlocked locomotion.
		bodyContactInput.maximumOffset = Math.max( radius * 1.5, 0.28 * visualScale );
		bodyContactView = bodyContacts.update( renderDt, bodyContactInput );
		const contactFailed = bodyContactView.requiresFreeze
			|| ! bodyContactView.constraintsSatisfied
			|| bodyContactView.budgetExceeded;
		if ( ! contactFailed ) {

			bodyContactFrozen = false;
			bodyRoot.position.set(
				view.x + bodyContactView.offset[ 0 ],
				view.y + bodyContactView.offset[ 1 ],
				view.z + bodyContactView.offset[ 2 ],
			);

		}
		return bodyContactView;

	}

	function updateTailContacts( renderDt ) {

		// The tail follows the hind support, which may differ from the centre at a
		// support portal. Foot 2 is the stable left-hind representative.
		const kind = contactKinds[ 2 ];
		const graphSupportId = contactSupportIds[ 2 ];
		const exactSupportId = graphSupportId >= 0
			? surfaceGraph?.colliderSupportIds?.[ graphSupportId ] ?? - 1
			: - 1;
		tailContacts.frequency = Math.max( 15, Math.min( 60,
			setting( settings, 'chameleonTailContactFrequency', 30 ) ) );
		tailContactInput.enabled = setting( settings, 'chameleonContactPhysics', true ) !== false
			&& setting( settings, 'chameleonTailContacts', true ) !== false
			&& !! track && !! surfaceCollider;
		tailContactInput.collider = surfaceCollider;
		tailContactInput.supportId = kind === CHAMELEON_SURFACE_KIND.TERRAIN
			? - 1
			: exactSupportId;
		tailContactInput.componentId = kind === CHAMELEON_SURFACE_KIND.TERRAIN
			? - 1
			: contactComponentIds[ 2 ];
		tailContactInput.radius = Math.max( 0.005,
			setting( settings, 'chameleonTailProbeRadius', 0.075 ) * visualScale );
		tailContactView = tailContacts.update( renderDt, tailContactInput );
		return tailContactView;

	}

	function prepareProceduralRig() {

		const footIkEnabled = gaitReady
			&& setting( settings, 'chameleonFootIK', true ) !== false;
		const tailEnabled = setting( settings, 'chameleonContactPhysics', true ) !== false
			&& setting( settings, 'chameleonTailContacts', true ) !== false
			&& !! surfaceCollider;
		proceduralRigActive = footIkEnabled || tailEnabled;
		const gaitStrength = Math.max( 0, Math.min( 1,
			setting( settings, 'chameleonGaitStrength', 1 ) ) );
		if ( footIkEnabled ) {

			rigBinding.writeBodySurfaceDeltas(
				rigSolution,
				supportBackNormal.x, supportBackNormal.y, supportBackNormal.z,
				supportFrontNormal.x, supportFrontNormal.y, supportFrontNormal.z,
				0.16,
				0.36 * gaitStrength,
			);
			rigSolution.footTargets.set( gaitView.footPositions );
			rigSolution.footNormals.set( gaitView.footNormals );
			rigSolution.legWeights.fill( gaitStrength );
			rigSolution.footNormalWeights.fill( 1 );

		} else {

			rigSolution.bodyWeights.fill( 0 );
			rigSolution.legWeights.fill( 0 );
			rigSolution.footNormalWeights.fill( 0 );

		}
		return proceduralRigActive;

	}

	function applyProceduralBody() {

		if ( ! proceduralRigActive ) return 0;
		return rigBinding.applyBodySolution( rigSolution, 1, attackBlend );

	}

	function applyProceduralTailAndLegs( contactWeight ) {

		if ( ! proceduralRigActive || contactWeight <= 0 ) return 0;
		return rigBinding.applyTailAndLegSolution( rigSolution, contactWeight );

	}

	function bodyContactIsSafe() {

		return ! bodyContactView.requiresFreeze
			&& bodyContactView.constraintsSatisfied
			&& ! bodyContactView.budgetExceeded;

	}

	function finishBodyContactValidation() {

		bodyPoseRequiresLegResolve = bodyRoot.position.distanceToSquared(
			bodyPositionBeforeValidation,
		) > 1e-12;
		return bodyContactIsSafe();

	}

	function validateOrRefreshBodyPose( view ) {

		bodyPoseRequiresLegResolve = false;
		bodyPositionBeforeValidation.copy( bodyRoot.position );
		bodyContactView = bodyContacts.validateAppliedPose( rigBinding );
		if ( bodyContactIsSafe() || bodyContactView.refreshed )
			return finishBodyContactValidation();
		// First re-solve the still valid cached half-spaces against the current
		// animated probes. This is query-free and handles almost every inter-frame
		// crossing without invalidating the collider hint.
		bodyContactView = bodyContacts.resolveCachedPose( rigBinding );
		if ( bodyContactIsSafe() ) {

			bodyRoot.position.set(
				view.x + bodyContactView.offset[ 0 ],
				view.y + bodyContactView.offset[ 1 ],
				view.z + bodyContactView.offset[ 2 ],
			);
			bodyRoot.updateWorldMatrix( true, false );
			bodyContactView = bodyContacts.validateAppliedPose( rigBinding );
			if ( bodyContactIsSafe() ) return finishBodyContactValidation();

		}
		// If topology really changed, refresh once. This exceptional branch costs
		// at most three exact BVH queries and never starts route planning itself.
		bodyContacts.invalidateHints( true );
		updateBodyContacts( 0, view );
		bodyContactView = bodyContacts.validateAppliedPose( rigBinding );
		return finishBodyContactValidation();

	}

	function tailContactIsSafe() {

		return tailContactView.constraintsSatisfied && ! tailContactView.requiresFreeze;

	}

	function validateOrRestoreTailPose( contactWeight = 1 ) {

		tailContactView = tailContacts.validateAppliedPose( rigBinding );
		const hadFreshConstraints = tailContactView.refreshed;
		tailLocallyRecovered = false;
		if ( tailContactIsSafe() ) {

			rigBinding.writeTailLocalPose( safeTailLocalPose );
			safeTailPoseReady = true;
			return true;

		}
		rigBinding.applyTailLocalPose(
			safeTailPoseReady ? safeTailLocalPose : preTailLocalPose,
		);
		tailContactView = tailContacts.validateAppliedPose( rigBinding );
		tailLocallyRecovered = tailContactIsSafe();
		if ( tailLocallyRecovered ) {

			rigBinding.writeTailLocalPose( safeTailLocalPose );
			safeTailPoseReady = true;
			return true;

		}
		if ( ! hadFreshConstraints && tailContactInput.enabled ) {

			// A cached plane may become stale as the authored clip advances. Rebuild
			// its three bounded contacts against the current pose, then apply only
			// the tail overlay so feet and body IK are never evaluated twice.
			rigBinding.applyTailLocalPose( preTailLocalPose );
			tailContacts.invalidateHints( true );
			tailContactView = tailContacts.update( 0, tailContactInput );
			rigBinding.applyTailSolution( rigSolution, contactWeight );
			tailContactView = tailContacts.validateAppliedPose( rigBinding );
			tailLocallyRecovered = tailContactIsSafe();
			if ( tailLocallyRecovered ) {

				rigBinding.writeTailLocalPose( safeTailLocalPose );
				safeTailPoseReady = true;

			}

		}
		return tailLocallyRecovered;

	}

	function updateAnimation( dt, view ) {

		const telemetry = simulation.getTelemetry();
		const travelled = Math.max( 0, telemetry.distanceTravelled - previousDistanceTravelled );
		previousDistanceTravelled = telemetry.distanceTravelled;
		const stride = Math.max( 0.1, setting( settings, 'chameleonStrideLength', 1.35 ) * visualScale );
		const animationSpeed = Math.max( 0.1,
			setting( settings, 'chameleonAnimationSpeed', 1 ) );
		walkPhase = ( walkPhase + travelled / stride * animationSpeed ) % 1;
		const desiredAttack = attackState( view.state ) ? 1 : 0;
		attackBlend += ( desiredAttack - attackBlend ) * Math.min( 1, dt * 12 );
		if ( Math.abs( desiredAttack - attackBlend ) < 0.0001 ) attackBlend = desiredAttack;
		walkAction.setEffectiveWeight( 1 - attackBlend );
		attackAction.setEffectiveWeight( attackBlend );
		walkAction.time = walkPhase * asset.walkClip.duration;
		attackAction.time = Math.min(
			asset.attackClip.duration - 1e-5,
			Math.max( 0, view.attackClipPhase ) * asset.attackClip.duration,
		);
		mixer.update( 0 );

	}

	function updateHeadLookSimulation( dt, view ) {

		lookForward.set( view.headingX, view.headingY, view.headingZ );
		lookUp.set( view.upX, view.upY, view.upZ );
		if ( lookUp.lengthSq() < BODY_FRAME_EPSILON ) lookUp.set( 0, 1, 0 );
		else lookUp.normalize();
		projectChameleonBodyForward( lookForward, lookUp, forward, 1 );
		lookSide.crossVectors( lookUp, lookForward );
		if ( lookSide.lengthSq() < BODY_FRAME_EPSILON ) lookSide.set( 0, 0, 1 );
		else lookSide.normalize();
		headLookInput.targetWeight = 0;
		if ( view.targetIndex >= 0 || view.capturedIndex >= 0 ) {

			const striking = attackState( view.state );
			const targetX = striking ? view.strikeX : view.aimX;
			const targetY = striking ? view.strikeY : view.aimY;
			const targetZ = striking ? view.strikeZ : view.aimZ;
			lookDirection.set(
				targetX - view.mouthX,
				targetY - view.mouthY,
				targetZ - view.mouthZ,
			);
			const distanceSquared = lookDirection.lengthSq();
			if ( distanceSquared > BODY_FRAME_EPSILON ) {

				lookDirection.multiplyScalar( 1 / Math.sqrt( distanceSquared ) );
				const forwardAmount = lookDirection.dot( lookForward );
				const sideAmount = lookDirection.dot( lookSide );
				const upAmount = lookDirection.dot( lookUp );
				headLookInput.targetYaw = Math.atan2( sideAmount, forwardAmount );
				headLookInput.targetPitch = Math.atan2(
					upAmount, Math.max( 1e-6, Math.hypot( forwardAmount, sideAmount ) ),
				);
				headLookInput.targetWeight = striking ? 1 : 0.82;

			}

		}
		const resting = view.state === CHAMELEON_STATE.REST_SCAN || camouflaged;
		headLookInput.idleWeight = resting ? 1 : 0.38;
		headLook.updateFixed( dt, headLookInput );

	}

	function rotateLookBoneInModelSpace( bone, modelAxis, angle ) {

		if ( ! bone || Math.abs( angle ) < 1e-7 ) return;
		bone.updateWorldMatrix( true, false );
		instance.model.getWorldQuaternion( lookModelWorldQuaternion );
		lookAxisWorld.copy( modelAxis ).applyQuaternion( lookModelWorldQuaternion ).normalize();
		lookDeltaQuaternion.setFromAxisAngle( lookAxisWorld, angle );
		bone.getWorldQuaternion( lookBoneWorldQuaternion );
		lookCandidateQuaternion.copy( lookDeltaQuaternion ).multiply( lookBoneWorldQuaternion );
		bone.parent.getWorldQuaternion( lookParentInverseQuaternion ).invert();
		bone.quaternion.copy(
			lookCandidateQuaternion.premultiply( lookParentInverseQuaternion ),
		).normalize();
		bone.updateWorldMatrix( false, true );

	}

	function applyHeadLookPose() {

		const pose = headLook.getView().current;
		rotateLookBoneInModelSpace(
			rigBinding.neck, CHAMELEON_LOCAL_UP,
			pose[ CHAMELEON_HEAD_LOOK.NECK_YAW ],
		);
		rotateLookBoneInModelSpace(
			rigBinding.neck, CHAMELEON_LOCAL_SIDE,
			-pose[ CHAMELEON_HEAD_LOOK.NECK_PITCH ],
		);
		rotateLookBoneInModelSpace(
			rigBinding.head, CHAMELEON_LOCAL_UP,
			pose[ CHAMELEON_HEAD_LOOK.HEAD_YAW ],
		);
		rotateLookBoneInModelSpace(
			rigBinding.head, CHAMELEON_LOCAL_SIDE,
			-pose[ CHAMELEON_HEAD_LOOK.HEAD_PITCH ],
		);

	}

	function updateTongue( view, worldMatricesReady = false ) {

		const visible = !! view.tongueVisible && surfaceVisible && group.visible;
		tongue.visible = visible;
		if ( ! visible ) return;
		if ( ! worldMatricesReady ) instance.mouthSocket.updateWorldMatrix( true, false );
		instance.mouthSocket.getWorldPosition( authoredMouth );
		visualTongueTip.set( view.tongueTipX, view.tongueTipY, view.tongueTipZ );
		if ( view.state === CHAMELEON_STATE.RETRACT_WITH_PREY && view.capturedIndex >= 0 ) {

			const rawProgress = Math.min( 1, Math.max( 0, view.stateTime / simulation.retractDuration ) );
			const correctionWeight = rawProgress * rawProgress * ( 3 - 2 * rawProgress );
			mouthCorrection.set(
				authoredMouth.x - view.mouthX,
				authoredMouth.y - view.mouthY,
				authoredMouth.z - view.mouthZ,
			).multiplyScalar( correctionWeight );
			visualTongueTip.add( mouthCorrection );

		}
		tongueDirection.set(
			visualTongueTip.x - authoredMouth.x,
			visualTongueTip.y - authoredMouth.y,
			visualTongueTip.z - authoredMouth.z,
		);
		const length = tongueDirection.length();
		if ( length <= 1e-5 ) {

			tongue.visible = false;
			return;

		}
		tongueDirection.multiplyScalar( 1 / length );
		const width = Math.max( 0.012, setting( settings, 'chameleonTongueWidth', 0.055 ) * visualScale );
		tongueTube.position.set(
			( authoredMouth.x + visualTongueTip.x ) * 0.5,
			( authoredMouth.y + visualTongueTip.y ) * 0.5,
			( authoredMouth.z + visualTongueTip.z ) * 0.5,
		);
		tongueTube.quaternion.setFromUnitVectors( LOCAL_Y, tongueDirection );
		tongueTube.scale.set( width, length, width );
		tonguePad.position.copy( visualTongueTip );
		tonguePad.quaternion.copy( tongueTube.quaternion );
		tonguePad.scale.set( width * 1.35, width * 0.62, width * 1.35 );

	}

	function setCastShadow( enabled ) {

		castShadow = !! enabled;
		for ( const mesh of instance.meshes ) {

			if ( instance.hiddenTongueMeshes.includes( mesh ) ) continue;
			mesh.castShadow = castShadow;

		}
		tongueTube.castShadow = castShadow;
		tonguePad.castShadow = castShadow;

	}

	function setReceiveShadow( enabled ) {

		receiveShadow = !! enabled;
		for ( const mesh of instance.meshes ) {

			if ( instance.hiddenTongueMeshes.includes( mesh ) ) continue;
			mesh.receiveShadow = receiveShadow;

		}
		tongueTube.receiveShadow = receiveShadow;
		tonguePad.receiveShadow = receiveShadow;

	}

	function setSurfaceVisible( visible ) {

		surfaceVisible = !! visible;
		group.visible = surfaceVisible
			&& setting( settings, 'chameleonEnabled', true ) !== false
			&& !! track;
		if ( ! group.visible ) {
			tongue.visible = false;
			invalidateContactTriangleHints();
		}

	}

	function syncSimulationSettings() {

		simulation.setAttackDistance(
			setting( settings, 'chameleonAttackDistance', simulation.attackDistance ),
			setting( settings, 'chameleonDetectionDistance', simulation.detectionDistance ),
		);
		simulation.patrolSpeed = Math.max( 0, setting( settings, 'chameleonPatrolSpeed', simulation.patrolSpeed ) );
		simulation.trackingSpeed = Math.max( 0, setting( settings, 'chameleonTrackingSpeed', simulation.trackingSpeed ) );
		simulation.turnSpeed = Math.max( 0.1, setting( settings, 'chameleonTurnSpeed', simulation.turnSpeed ) );
		simulation.aimDuration = Math.max( 0.001, setting( settings, 'chameleonAimDuration', simulation.aimDuration ) );
		simulation.retractDuration = Math.max(
			0.001,
			setting( settings, 'chameleonTongueRetractDuration', simulation.retractDuration ),
		);
		simulation.cooldownDuration = Math.max(
			0,
			setting( settings, 'chameleonAttackCooldown', simulation.cooldownDuration ),
		);

	}

	function scheduleNextCamouflage() {

		const interval = Math.max( 0.1, setting( settings, 'chameleonCamouflageInterval', 14 ) );
		camouflageCountdown = interval * ( 0.78 + deterministicUnit( camouflageCycle, 0x51ed270b ) * 0.44 );

	}

	function updateCamouflageSchedule( dt ) {

		const enabled = setting( settings, 'chameleonCamouflageEnabled', true ) !== false;
		const roaming = setting( settings, 'chameleonRoamingEnabled', true ) !== false;
		const revealing = revealingState( simulation.state ) || simulation.capturedIndex >= 0;
		if ( ! enabled || revealing ) {

			scheduledCamouflage = false;
			camouflageRemaining = 0;
			if ( camouflageCountdown <= 0 ) scheduleNextCamouflage();

		} else if ( scheduledCamouflage ) {

			// Keep the camouflage through AIM_AND_BRACE: revealing during the
			// wind-up would make the butterfly flee before the tongue starts.
			if ( simulation.state !== CHAMELEON_STATE.AIM_AND_BRACE )
				camouflageRemaining = Math.max( 0, camouflageRemaining - dt );
			if ( camouflageRemaining <= 0 ) {

				scheduledCamouflage = false;
				camouflageCycle ++;
				scheduleNextCamouflage();

			}

		} else {

			camouflageCountdown -= dt;
			if ( camouflageCountdown <= 0 ) {

				const configuredMin = Math.max( 0.1,
					setting( settings, 'chameleonCamouflageMinDuration', 7 ) );
				const configuredMax = Math.max( configuredMin,
					setting( settings, 'chameleonCamouflageMaxDuration', 13 ) );
				camouflageRemaining = configuredMin
					+ ( configuredMax - configuredMin ) * deterministicUnit( camouflageCycle, 0x68bc21eb );
				scheduledCamouflage = true;

			}

		}

		const patrolSpeed = Math.max( 0,
			setting( settings, 'chameleonPatrolSpeed', simulation.patrolSpeed ) );
		const trackingSpeed = Math.max( 0,
			setting( settings, 'chameleonTrackingSpeed', simulation.trackingSpeed ) );
		simulation.patrolSpeed = roaming && ! scheduledCamouflage ? patrolSpeed : 0;
		simulation.trackingSpeed = scheduledCamouflage ? 0 : trackingSpeed;

	}

	function syncDebugView( view, dt = 0, advanceMotion = false ) {

		const enabled = ! disposed
			&& setting( settings, 'chameleonEnabled', true ) !== false
			&& !! track;
		const camouflageEnabled = setting( settings, 'chameleonCamouflageEnabled', true ) !== false;
		const telemetry = simulation.getTelemetry();
		const stationary = telemetry.lastStepDistance <= STATIONARY_EPSILON;
		const revealing = revealingState( view.state );
		const camouflageCandidate = enabled && camouflageEnabled && scheduledCamouflage;
		if ( advanceMotion ) camouflageStationaryTime = advanceChameleonCamouflageDwell(
			camouflageStationaryTime, dt, camouflageCandidate, stationary, revealing,
		);
		camouflaged = camouflageCandidate
			&& ! revealing
			&& stationary
			&& camouflageStationaryTime >= CHAMELEON_CAMOUFLAGE_SETTLE_SECONDS;
		locomotionState = camouflaged
			? 'camouflage'
			: attackState( view.state )
				? 'attack'
				: view.state === CHAMELEON_STATE.REST_SCAN
					? 'perch'
					: 'roam';

		let velocityX = avoidanceView.velocityX;
		let velocityY = avoidanceView.velocityY;
		let velocityZ = avoidanceView.velocityZ;
		if ( advanceMotion && dt > 0 ) {

			if ( debugHasPosition ) {

				velocityX = ( view.x - debugPreviousX ) / dt;
				velocityY = ( view.y - debugPreviousY ) / dt;
				velocityZ = ( view.z - debugPreviousZ ) / dt;

			} else velocityX = velocityY = velocityZ = 0;
			debugPreviousX = view.x;
			debugPreviousY = view.y;
			debugPreviousZ = view.z;
			debugHasPosition = true;

		}

		let supportId = - 1;
		let supportKind = 'none';
		let supportModel = '';
		if ( track ) {

			sampleSupport(
				view.trackPosition, supportCentrePosition, supportCentreNormal, supportCentreTangent,
			);
			supportId = track.supportId[ normalSegment ];
			supportKind = CHAMELEON_SURFACE_KIND_NAMES[ track.kind[ normalSegment ] ] || 'unknown';
			supportModel = supportId >= 0 ? track.supports[ supportId ]?.model || '' : 'ground';

		}

		debugView.selected = selected;
		debugView.visible = enabled && surfaceVisible;
		debugView.x = view.x; debugView.y = view.y; debugView.z = view.z;
		debugView.headingX = view.headingX;
		debugView.headingY = view.headingY;
		debugView.headingZ = view.headingZ;
		debugView.mouthX = view.mouthX;
		debugView.mouthY = view.mouthY;
		debugView.mouthZ = view.mouthZ;
		debugView.state = view.state;
		debugView.stateName = view.stateName;
		debugView.targetIndex = view.targetIndex;
		debugView.capturedIndex = view.capturedIndex;
		debugView.locomotionState = locomotionState;
		debugView.camouflaged = camouflaged;
		debugView.attackDistance = simulation.attackDistance;
		debugView.detectionDistance = simulation.detectionDistance;
		debugView.supportKind = supportKind;
		debugView.supportId = supportId;
		debugView.supportModel = supportModel;
		debugView.supportSegment = normalSegment;
		debugView.supportNormalX = supportCentreNormal.x;
		debugView.supportNormalY = supportCentreNormal.y;
		debugView.supportNormalZ = supportCentreNormal.z;
		debugView.routePosition = view.trackPosition;
		debugView.routeLength = track?.length || 0;
		debugView.supportCount = track?.supportCount || 0;
		debugView.graphNodeCount = surfaceGraph?.count || 0;
		debugView.explorationDecisions = surfaceRouter?.decisionCount || 0;
		debugView.explorationRoutes = surfaceRouter?.explorationCount || 0;
		debugView.camouflageRemaining = camouflageRemaining;
		debugView.networkRevision = lastNetworkRevision;
		const gaitTelemetry = gait.getTelemetry();
		debugView.physicalContacts = enabled && gaitReady
			&& setting( settings, 'chameleonContactPhysics', true ) !== false;
		debugView.groundedFeet = groundedFeet;
		debugView.surfaceTriangleCount = surfaceCollider?.triangleCount || 0;
		debugView.contactFrequency = setting( settings, 'chameleonContactFrequency', 60 );
		debugView.gaitSteps = gaitTelemetry.stepsCompleted;
		debugView.contactTriangle = currentContactTriangle;
		debugView.contactFrozen = bodyContactFrozen;
		debugView.bodyResidual = bodyContactView.maxResidual || 0;
		debugView.tailResidual = tailContactView.maxResidual || 0;
		debugView.tailLocallyRecovered = tailLocallyRecovered;
		debugView.routePublicationFailures = routePublicationFailures;
		debugView.networkRebuildFailures = networkRebuildFailures;
		debugView.networkRebuildError = networkRebuildError;
		debugView.contactRecovery = tailLocallyRecovered
			? 'tail-local-restore'
			: bodyContactFrozen
				? 'visual-pose-restore'
				: 'stable';

		avoidanceView.x = view.x; avoidanceView.y = view.y; avoidanceView.z = view.z;
		avoidanceView.headingX = view.headingX;
		avoidanceView.headingY = view.headingY;
		avoidanceView.headingZ = view.headingZ;
		avoidanceView.velocityX = velocityX;
		avoidanceView.velocityY = velocityY;
		avoidanceView.velocityZ = velocityZ;
		avoidanceView.speed = Math.hypot( velocityX, velocityY, velocityZ );
		avoidanceView.active = enabled;
		avoidanceView.visible = enabled;
		avoidanceView.camouflaged = camouflaged;
		avoidanceView.isCamouflaged = camouflaged;
		avoidanceView.attackDistance = simulation.attackDistance;
		avoidanceView.detectionDistance = simulation.detectionDistance;
		return debugView;

	}
	function syncCamouflageVisual( renderDt = 0, force = false ) {

		return camouflageVisual.update( renderDt, camouflaged, force );

	}

	function syncVisualSettings() {

		const nextCast = !! setting( settings, 'chameleonCastShadow', castShadow );
		const nextReceive = !! setting( settings, 'chameleonReceiveShadow', receiveShadow );
		if ( nextCast !== castShadow ) setCastShadow( nextCast );
		if ( nextReceive !== receiveShadow ) setReceiveShadow( nextReceive );
		group.visible = surfaceVisible && setting( settings, 'chameleonEnabled', true ) !== false && !! track;

	}

	function stepSimulation( dt ) {

		if ( ! Number.isFinite( dt ) || dt < 0 )
			throw new RangeError( 'dt must be a finite non-negative number' );
		if ( disposed ) return simulation.getView();
		applyVisualScale();
		const rebuilt = rebuildTrack();
		if ( ! rebuilt ) advanceExplorationRoute();
		syncSimulationSettings();
		const enabled = setting( settings, 'chameleonEnabled', true ) !== false
			&& !! track;
		if ( ! enabled ) {

			const disabledView = simulation.getView();
			invalidateContactTriangleHints();
			syncDebugView( disabledView, dt, true );
			return disabledView;

		}
		updateCamouflageSchedule( dt );
		const prey = typeof getButterflyPredationContext === 'function'
			? getButterflyPredationContext() || EMPTY_PREY
			: EMPTY_PREY;
		const view = simulation.update( dt, prey );
		updateHeadLookSimulation( dt, view );
		syncDebugView( view, dt, true );
		return view;

	}

	function renderFrame( renderDt = 0, visible = surfaceVisible ) {

		if ( ! Number.isFinite( renderDt ) || renderDt < 0 )
			throw new RangeError( 'renderDt must be a finite non-negative number' );
		if ( disposed ) return simulation.getView();
		surfaceVisible = !! visible;
		// Rendering consumes the latest fixed-step publication; it never rebuilds or
		// mutates logical routes/scales on its own cadence.
		syncVisualSettings();
		const enabled = surfaceVisible
			&& setting( settings, 'chameleonEnabled', true ) !== false
			&& !! track;
		group.visible = enabled;
		if ( ! enabled ) {

			tongue.visible = false;
			invalidateContactTriangleHints();
			const disabledView = simulation.getView();
			syncDebugView( disabledView );
			return disabledView;

		}
		const view = simulation.getView();
		orientBody( view, renderDt );
		updateProceduralContacts( renderDt, view );
		updateAnimation( renderDt, view );
		prepareProceduralRig();
		const bodyRigWeight = applyProceduralBody();
		updateBodyContacts( renderDt, view );
		updateTailContacts( renderDt );
		rigBinding.writeTailLocalPose( preTailLocalPose );
		const rigWeight = applyProceduralTailAndLegs( bodyRigWeight );
		const bodyContactFailed = ! validateOrRefreshBodyPose( view );
		if ( ! bodyContactFailed && bodyPoseRequiresLegResolve && rigWeight > 0 )
			rigBinding.applyLegSolution( rigSolution, rigWeight );
		const tailSafe = validateOrRestoreTailPose( rigWeight );
		const contactFailed = bodyContactFailed || ! tailSafe;
		if ( contactFailed ) rollbackUnsafeContact( view );
		else commitSafeContactPose( view );
		applyHeadLookPose();
		updateTongue( view, true );
		syncDebugView( view );
		syncCamouflageVisual( renderDt );
		return view;

	}

	function update( dt ) {

		const view = stepSimulation( dt );
		renderFrame( dt, surfaceVisible );
		return view;

	}


	function select() {

		selected = true;
		debugView.selected = true;
		return debugView;

	}

	function clearSelection() {

		selected = false;
		debugView.selected = false;
		return debugView;

	}

	function reset() {

		pendingRouterProposal?.rejectProposal();
		pendingRouterProposal = null;
		simulation = createKernel();
		surfaceGraphBaker.invalidate();
		surfaceGraph = null;
		surfaceCollider = null;
		surfaceRouter = null;
		track = null;
		host = null;
		propRevision = - 1;
		obstacleScale = NaN;
		treeScale = NaN;
		rockScale = NaN;
		cachedSupportClearance = NaN;
		cachedGroundClearance = NaN;
		visualScale = NaN;
		attackBlend = 0;
		walkPhase = 0;
		previousDistanceTravelled = 0;
		camouflageCycle = 0;
		camouflageCountdown = 0;
		camouflageRemaining = 0;
		scheduledCamouflage = false;
		camouflageStationaryTime = 0;
		camouflaged = false;
		camouflageVisual.reset();
		locomotionState = 'perch';
		bodyOrientationReady = false;
		bodyContactFrozen = false;
		bodyContactHasSafePosition = false;
		clearPendingCorridorRollback();
		routePublicationFailures = 0;
		networkRebuildFailures = 0;
		networkRebuildError = '';
		clearFailedNetworkSignature();
		safeTailPoseReady = false;
		tailLocallyRecovered = false;
		lastSafeBodyPosition.set( 0, 0, 0 );
		lastSafeBodyQuaternion.identity();
		lastSafeBodyScale.set( 1, 1, 1 );
		safeLocalPose.fill( 0 );
		safeTailLocalPose.fill( 0 );
		preTailLocalPose.fill( 0 );
		proceduralRigActive = false;
		gaitReady = false;
		tailContacts.reset();
		bodyContacts.reset();
		contactAccumulator = Infinity;
		groundedFeet = 0;
		currentContactTriangle = - 1;
		invalidateContactTriangleHints();
		debugHasPosition = false;
		avoidanceView.velocityX = 0;
		avoidanceView.velocityY = 0;
		avoidanceView.velocityZ = 0;
		avoidanceView.speed = 0;
		scheduleNextCamouflage();
		applyVisualScale( true );
		rebuildTrack( true );
		const view = simulation.update( 0, EMPTY_PREY );
		headLook.reset();
		updateHeadLookSimulation( 0, view );
		if ( track ) orientBody( view );
		if ( track ) updateProceduralContacts( 0, view );
		updateAnimation( 0, view );
		prepareProceduralRig();
		const bodyRigWeight = applyProceduralBody();
		updateBodyContacts( 0, view );
		updateTailContacts( 0 );
		rigBinding.writeTailLocalPose( preTailLocalPose );
		const rigWeight = applyProceduralTailAndLegs( bodyRigWeight );
		const bodyContactFailed = ! validateOrRefreshBodyPose( view );
		if ( ! bodyContactFailed && bodyPoseRequiresLegResolve && rigWeight > 0 )
			rigBinding.applyLegSolution( rigSolution, rigWeight );
		const tailSafe = validateOrRestoreTailPose( rigWeight );
		const contactFailed = bodyContactFailed || ! tailSafe;
		if ( contactFailed ) rollbackUnsafeContact( view );
		else commitSafeContactPose( view );
		applyHeadLookPose();
		updateTongue( view, true );
		syncDebugView( view );
		syncCamouflageVisual( 0, true );

	}

	function dispose() {

		if ( disposed ) return;
		pendingRouterProposal?.rejectProposal();
		pendingRouterProposal = null;
		disposed = true;
		avoidanceView.active = false;
		avoidanceView.visible = false;
		invalidateContactTriangleHints();
		mixer.stopAllAction();
		scene.remove( group );
		camouflageVisual.dispose();
		tongueTube.geometry.dispose();
		tonguePad.geometry.dispose();
		tongueMaterial.dispose();
		for ( const material of instance.materials ) material.dispose();

	}

	applyVisualScale( true );
	rebuildTrack( true );
	setCastShadow( castShadow );
	setReceiveShadow( receiveShadow );
	setSurfaceVisible( true );
	scheduleNextCamouflage();
	const initialView = simulation.update( 0, EMPTY_PREY );
	updateHeadLookSimulation( 0, initialView );
	if ( track ) orientBody( initialView );
	if ( track ) updateProceduralContacts( 0, initialView );
	updateAnimation( 0, initialView );
	prepareProceduralRig();
	const initialBodyRigWeight = applyProceduralBody();
	updateBodyContacts( 0, initialView );
	updateTailContacts( 0 );
	rigBinding.writeTailLocalPose( preTailLocalPose );
	const initialRigWeight = applyProceduralTailAndLegs( initialBodyRigWeight );
	const initialBodyContactFailed = ! validateOrRefreshBodyPose( initialView );
	if ( ! initialBodyContactFailed && bodyPoseRequiresLegResolve && initialRigWeight > 0 )
		rigBinding.applyLegSolution( rigSolution, initialRigWeight );
	const initialTailSafe = validateOrRestoreTailPose( initialRigWeight );
	const initialContactFailed = initialBodyContactFailed || ! initialTailSafe;
	if ( initialContactFailed ) rollbackUnsafeContact( initialView );
	else commitSafeContactPose( initialView );
	applyHeadLookPose();
	updateTongue( initialView, true );
	syncDebugView( initialView );
	syncCamouflageVisual( 0, true );

	group.userData.pickType = 'chameleon';
	instance.model.userData.pickType = 'chameleon';
	for ( const mesh of instance.meshes ) mesh.userData.pickType = 'chameleon';

	try {

		await camouflageVisual.prewarm( renderer, camera, instance.model, scene );

	} catch ( error ) {

		console.warn( 'Préchauffage du camouflage optique impossible.', error );

	}

	return {
		group,
		model: instance.model,
		pickable: instance.model,
		tongue,
		tongueTube,
		tonguePad,
		update,
		stepSimulation,
		renderFrame,
		reset,
		dispose,
		setSurfaceVisible,
		setCastShadow,
		setReceiveShadow,
		select,
		clearSelection,
		getSimulation: () => simulation,
		getTelemetry: () => simulation.getTelemetry(),
		getTrack: () => track,
		getSupportNetwork: () => surfaceGraph,
		getSurfaceCollider: () => surfaceCollider,
		getProceduralGait: () => gait,
		getRigBinding: () => rigBinding,
		getTailContactSolver: () => tailContacts,
		getBodyContactSolver: () => bodyContacts,
		getBodyContactView: () => bodyContactView,
		getTailContactView: () => tailContactView,
		getSurfaceGraph: () => surfaceGraph,
		getSurfaceRouter: () => surfaceRouter,
		getHost: () => host,
		getDebugView: () => debugView,
		getDebugSnapshot: () => debugView,
		getAvoidanceContext: () => avoidanceView,
		getLocomotionState: () => locomotionState,
		getFootContacts: () => footContacts,
	};

}
