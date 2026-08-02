import * as THREE from 'three/webgpu';

import { MAX_BUTTERFLIES, WORLD, gfx } from './config.js';
import {
	CHAMELEON_CAMOUFLAGE_SETTLE_SECONDS,
	CHAMELEON_STATE,
	ChameleonSimulation,
	advanceChameleonCamouflageDwell,
} from './chameleon-simulation.js';
import { createMainChameleonSurfaceWorld } from './chameleon-main-surfaces.js';
import { createHybridChameleon } from './chameleon-lab/hybrid-chameleon.js';
import { createRigDebugView } from './chameleon-lab/rig-debug-view.js';
import { createSurfaceCamouflageController } from './chameleon-lab/surface-camouflage.js';
import { SurfaceRouteDebugView } from './chameleon-lab/surface-route-debug-view.js';
import {
	AutonomousExplorer,
	SurfaceRoutePlanner,
} from './chameleon-lab/third-person-controller.js';

const LOCAL_BONE_AXIS = Object.freeze( new THREE.Vector3( 0, 1, 0 ) );
const WORLD_UP = Object.freeze( new THREE.Vector3( 0, 1, 0 ) );
const ZERO_PREY = Object.freeze( { count: 0 } );
const ATTACK_STATES = new Set( [
	CHAMELEON_STATE.AIM_AND_BRACE,
	CHAMELEON_STATE.STRIKE_EXTEND,
	CHAMELEON_STATE.CONTACT,
	CHAMELEON_STATE.RETRACT_WITH_PREY,
	CHAMELEON_STATE.BITE_AND_SWALLOW,
	CHAMELEON_STATE.COOLDOWN,
] );
const MOVING_ATTACK_STATE = CHAMELEON_STATE.TRACK_PREY;
const MAX_ROUTE_ATTEMPTS = 12;
const ROUTE_REPLAN_SECONDS = 0.82;
const EXPLORER_SEED = 0x6a09e667;
const BEHAVIOUR_RANDOM_SEED = 0xbb67ae85;
const PREY_ROUTE_CANDIDATES = 8;

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function clamp( value, minimum, maximum ) {

	return Math.min( maximum, Math.max( minimum, finiteOr( value, minimum ) ) );

}

function numericHandle( value ) {

	const handle = Number( value?.handle ?? value );
	return Number.isFinite( handle ) ? handle : null;

}

function nextRandom( state ) {

	state.value = ( Math.imul( state.value, 1664525 ) + 1013904223 ) >>> 0;
	return state.value / 0x100000000;

}

function metadataText( metadata ) {

	return [
		metadata?.model,
		metadata?.kind,
		metadata?.category,
		metadata?.provenance?.model,
		metadata?.provenance?.kind,
		metadata?.provenance?.category,
	].filter( Boolean ).join( ' ' ).toLowerCase();

}

export function chameleonDestinationWeight( metadata ) {

	const text = metadataText( metadata );
	if ( /log_?0?[12]|\blog\b/.test( text ) ) return 9;
	if ( /branch|branche/.test( text ) ) return 8;
	if ( /tree|arbre|trunk|tronc/.test( text ) ) return 6;
	if ( /rock|rocher|stone|pierre/.test( text ) ) return 4.5;
	if ( /stump|souche/.test( text ) ) return 3.5;
	if ( /ground|soil|terrain|sol/.test( text ) ) return 0.35;
	return 1.5;

}

/**
 * Returns the collider owned by the strongest coherent foot cohort. Four feet
 * are a fixed anatomical bound, so this remains allocation-free and O(1).
 */
export function dominantChameleonSupportCollider( feet, fallback = null ) {

	let best = null;
	let bestScore = -Infinity;
	const list = feet || [];
	for ( let candidate = 0; candidate < list.length; candidate ++ ) {

		const foot = list[ candidate ];
		const handle = numericHandle( foot?.collider );
		if ( handle === null || foot?.state !== 'holding' ) continue;
		let seen = false;
		for ( let previous = 0; previous < candidate; previous ++ ) {

			if ( list[ previous ]?.state === 'holding'
				&& numericHandle( list[ previous ]?.collider ) === handle ) {

				seen = true;
				break;

			}

		}
		if ( seen ) continue;
		let score = 0;
		for ( let index = 0; index < list.length; index ++ ) {

			const other = list[ index ];
			if ( other?.state === 'holding' && numericHandle( other.collider ) === handle )
				score += 1 + clamp( other.load, 0, 1 ) * 0.15;

		}
		if ( score > bestScore ) {

			best = foot.collider;
			bestScore = score;

		}

	}
	return best || fallback;

}

export function chameleonJawOpening( state, attackClipPhase ) {

	const phase = clamp( attackClipPhase, 0, 1 );
	if ( state === CHAMELEON_STATE.AIM_AND_BRACE )
		return THREE.MathUtils.smoothstep( phase, 0.04, 0.395 );
	if ( state === CHAMELEON_STATE.STRIKE_EXTEND
		|| state === CHAMELEON_STATE.CONTACT
		|| state === CHAMELEON_STATE.RETRACT_WITH_PREY ) return 1;
	if ( state === CHAMELEON_STATE.BITE_AND_SWALLOW )
		return 1 - THREE.MathUtils.smoothstep( phase, 0.651, 1 );
	return 0;

}

function createTongueVisual( scene ) {

	const material = new THREE.MeshStandardNodeMaterial( {
		color: gfx.chameleonTongueColor,
		roughness: 0.76,
		metalness: 0,
	} );
	const tube = new THREE.Mesh( new THREE.CylinderGeometry( 0.025, 0.038, 1, 10, 1 ), material );
	const pad = new THREE.Mesh( new THREE.SphereGeometry( 0.065, 12, 8 ), material );
	tube.name = 'PhysicalChameleonTongue';
	pad.name = 'PhysicalChameleonTonguePad';
	tube.visible = false;
	pad.visible = false;
	tube.castShadow = true;
	tube.receiveShadow = true;
	pad.castShadow = true;
	pad.receiveShadow = true;
	scene.add( tube, pad );
	return {
		tube,
		pad,
		material,
		dispose() {

			tube.removeFromParent();
			pad.removeFromParent();
			tube.geometry.dispose();
			pad.geometry.dispose();
			material.dispose();

		},
	};

}

function resolveSurfaceMetadata( surfaceWorld, handle ) {

	return surfaceWorld.supportMetadataByHandle?.get?.( handle )
		|| surfaceWorld.physics?.surfaceByCollider?.get?.( handle )
		|| null;

}

function createDestinationRecords( surfaceWorld ) {

	const { navigation, entries = [] } = surfaceWorld;
	const colliderByHandle = new Map();
	for ( const entry of entries ) {

		const handle = numericHandle( entry?.collider );
		if ( handle !== null ) colliderByHandle.set( handle, entry.collider );

	}
	const explicit = Array.from( surfaceWorld.destinationHandles || [] );
	const allowedHandles = explicit.length > 0 ? new Set( explicit.map( numericHandle ) ) : null;
	const explicitWeightByHandle = new Map();
	for ( const destination of explicit ) {

		const handle = numericHandle( destination );
		if ( handle !== null && Number.isFinite( destination?.weight ) )
			explicitWeightByHandle.set( handle, Math.max( 0, destination.weight ) );

	}
	const nodesByHandle = new Map();
	for ( let node = 0; node < navigation.nodeCount; node ++ ) {

		const handle = numericHandle( navigation.handles[ node ] );
		if ( handle === null || ( allowedHandles && ! allowedHandles.has( handle ) ) ) continue;
		let nodes = nodesByHandle.get( handle );
		if ( ! nodes ) {

			nodes = [];
			nodesByHandle.set( handle, nodes );

		}
		nodes.push( node );

	}
	const records = [];
	for ( const [ handle, nodes ] of nodesByHandle ) {

		const metadata = resolveSurfaceMetadata( surfaceWorld, handle );
		const collider = colliderByHandle.get( handle )
			|| surfaceWorld.physics.world.getCollider?.( handle ) || null;
		if ( ! collider ) continue;
		records.push( Object.freeze( {
			handle,
			collider,
			metadata,
			weight: explicitWeightByHandle.get( handle )
				?? chameleonDestinationWeight( metadata ),
			nodes: Uint32Array.from( nodes ),
		} ) );

	}
	return Object.freeze( records );

}

function chooseSpawn( records, navigation, target ) {

	let selectedRecord = records.find( ( record ) => /log_?0?1|\blog\b/.test(
		metadataText( record.metadata ),
	) );
	selectedRecord ||= records.find( ( record ) => record.weight >= 4 );
	selectedRecord ||= records[ 0 ];
	if ( ! selectedRecord ) return { position: target.set( 0, 0.42, 0 ), collider: null };
	let bestNode = selectedRecord.nodes[ 0 ];
	let bestScore = -Infinity;
	for ( const node of selectedRecord.nodes ) {

		const offset = node * 3;
		const score = navigation.normals[ offset + 1 ] * 12 + navigation.positions[ offset + 1 ];
		if ( score > bestScore ) {

			bestScore = score;
			bestNode = node;

		}

	}
	const offset = bestNode * 3;
	target.set(
		navigation.positions[ offset ],
		navigation.positions[ offset + 1 ],
		navigation.positions[ offset + 2 ],
	);
	return { position: target, collider: selectedRecord.collider };

}

function createBehaviourKernel() {

	return new ChameleonSimulation( {
		preyCapacity: MAX_BUTTERFLIES,
		externalLocomotion: true,
		attackDistance: gfx.chameleonAttackDistance,
		detectionDistance: gfx.chameleonDetectionDistance,
		patrolSpeed: gfx.chameleonPatrolSpeed,
		trackingSpeed: gfx.chameleonTrackingSpeed,
		turnSpeed: gfx.chameleonTurnSpeed,
		aimDuration: gfx.chameleonAimDuration,
		retractDuration: gfx.chameleonTongueRetractDuration,
		cooldownDuration: gfx.chameleonAttackCooldown,
		maxIntegrationStep: 1 / 120,
	} );

}

function updateKernelSettings( simulation ) {

	simulation.setAttackDistance(
		gfx.chameleonAttackDistance,
		gfx.chameleonDetectionDistance,
	);
	simulation.patrolSpeed = gfx.chameleonPatrolSpeed;
	simulation.trackingSpeed = gfx.chameleonTrackingSpeed;
	simulation.turnSpeed = gfx.chameleonTurnSpeed;
	simulation.aimDuration = gfx.chameleonAimDuration;
	simulation.retractDuration = gfx.chameleonTongueRetractDuration;
	simulation.cooldownDuration = gfx.chameleonAttackCooldown;
	simulation.maxTongueLength = Math.max(
		simulation.attackDistance * 1.08,
		simulation.attackDistance,
	);

}

function updateHybridSettings( hybrid, tracking ) {

	const settings = hybrid.settings;
	settings.sprintMultiplier = gfx.chameleonSprintMultiplier;
	settings.moveSpeed = tracking
		? gfx.chameleonTrackingSpeed / Math.max( 1, settings.sprintMultiplier )
		: gfx.chameleonPatrolSpeed;
	settings.moveForce = gfx.chameleonMoveForce;
	settings.turnTorque = gfx.chameleonTurnTorque;
	settings.motorStrength = gfx.chameleonMotorStrength;
	settings.motorDamping = gfx.chameleonMotorDamping;
	settings.limbMuscleTone = gfx.chameleonLimbMuscleTone;
	settings.gaitFrequency = gfx.chameleonGaitFrequency;
	settings.animationSpeed = gfx.chameleonAnimationSpeed;
	settings.stepLength = gfx.chameleonStepLength;
	settings.stepHeight = gfx.chameleonStepHeight;
	settings.strideAmplitude = gfx.chameleonStrideAmplitude;
	settings.limbLift = gfx.chameleonLimbLift;
	settings.jointFlex = gfx.chameleonJointFlex;
	settings.bodyMotion = gfx.chameleonBodyMotion;
	settings.suspension = gfx.chameleonSuspension;
	settings.gripEnabled = !! gfx.chameleonGripEnabled;
	settings.gripStrength = gfx.chameleonGripStrength;
	settings.gripStiffness = gfx.chameleonGripStiffness;
	settings.gripDamping = gfx.chameleonGripDamping;
	settings.gripReach = gfx.chameleonGripReach;
	settings.supportClearance = gfx.chameleonSupportClearance;
	settings.rightingStrength = gfx.chameleonRightingStrength;
	settings.surfaceCommitTime = gfx.chameleonSurfaceCommitTime;
	settings.tailDamping = gfx.chameleonTailDamping;
	settings.tailFlexibility = gfx.chameleonTailFlexibility;
	settings.tailCollisionScale = gfx.chameleonTailCollisionScale;
	settings.tailGravity = gfx.chameleonTailGravity;

}

function updateCamouflageSettings( settings, active ) {

	settings.camouflageEnabled = !! gfx.chameleonCamouflageEnabled && active;
	settings.camouflageStrength = gfx.chameleonCamouflageStrength;
	settings.camouflageAdaptSeconds = gfx.chameleonCamouflageAdaptSeconds;
	settings.camouflageReleaseSeconds = gfx.chameleonCamouflageReleaseSeconds;
	settings.camouflageSurfaceCommitSeconds = gfx.chameleonCamouflageSurfaceCommitSeconds;
	settings.camouflageSurfaceTransitionSeconds = gfx.chameleonCamouflageSurfaceTransitionSeconds;
	settings.camouflageSupportHoldSeconds = gfx.chameleonCamouflageSupportHoldSeconds;
	settings.camouflageEyeRetention = gfx.chameleonCamouflageEyeRetention;

}

function stateLocomotionLabel( state, camouflage ) {

	if ( camouflage ) return 'camouflage immobile';
	if ( state === CHAMELEON_STATE.TRACK_PREY ) return 'poursuite physique';
	if ( state === CHAMELEON_STATE.PATROL_LOG ) return 'exploration physique';
	if ( ATTACK_STATES.has( state ) ) return 'attaque ancrée';
	return 'observation';

}

/**
 * Production runtime for the physical chameleon. The static support world and
 * immutable navigation manifold are shared infrastructure; only the one hybrid
 * body, four foot cohorts and compact route follower are stepped at 120 Hz.
 */
export async function createChameleonPhysicalSystem( {
	scene,
	renderer = null,
	camera = null,
	props,
	environment = null,
	getButterflyPredationContext = null,
} = {} ) {

	if ( ! scene?.isObject3D ) throw new TypeError( 'createChameleonPhysicalSystem requires a scene' );
	if ( ! props?.registry ) throw new TypeError( 'createChameleonPhysicalSystem requires the props registry' );
	if ( ! environment?.ground?.isMesh )
		throw new TypeError( 'createChameleonPhysicalSystem requires the exact environment ground' );
	if ( getButterflyPredationContext !== null
		&& typeof getButterflyPredationContext !== 'function' ) {

		throw new TypeError( 'getButterflyPredationContext must be a function or null' );

	}

	const surfaceWorld = await createMainChameleonSurfaceWorld( {
		props,
		ground: environment.ground,
		worldSize: WORLD,
		fixedDt: 1 / 120,
		maxSubsteps: 4,
	} );
	const records = createDestinationRecords( surfaceWorld );
	const spawnPosition = new THREE.Vector3();
	const spawn = chooseSpawn( records, surfaceWorld.navigation, spawnPosition );
	let hybrid;
	try {

		hybrid = await createHybridChameleon( {
			scene,
			physics: surfaceWorld.physics,
			spawn: spawn.position,
			assetUrl: '/assets/ChameleonPhysical.glb',
		} );

	} catch ( error ) {

		surfaceWorld.dispose();
		throw error;

	}
	const routePlanner = new SurfaceRoutePlanner( surfaceWorld.navigation );
	const explorer = new AutonomousExplorer( EXPLORER_SEED );
	const routeDebug = new SurfaceRouteDebugView( {
		scene,
		visible: false,
		maximumWaypoints: 64,
	} );
	const rigDebug = createRigDebugView( {
		scene,
		root: hybrid.model,
		visible: false,
	} );

	const meshes = [];
	hybrid.model.traverse( ( object ) => {

		if ( object.isMesh ) {

			meshes.push( object );
			object.userData.pickType = 'chameleon';
			object.castShadow = !! gfx.chameleonCastShadow;
			object.receiveShadow = !! gfx.chameleonReceiveShadow;

		}

	} );
	hybrid.model.userData.pickType = 'chameleon';
	hybrid.visualRoot.userData.pickType = 'chameleon';

	const camouflageSettings = {
		camouflageEnabled: false,
		camouflageStrength: gfx.chameleonCamouflageStrength,
		camouflageAdaptSeconds: gfx.chameleonCamouflageAdaptSeconds,
		camouflageReleaseSeconds: gfx.chameleonCamouflageReleaseSeconds,
		camouflageSurfaceCommitSeconds: gfx.chameleonCamouflageSurfaceCommitSeconds,
		camouflageSurfaceTransitionSeconds: gfx.chameleonCamouflageSurfaceTransitionSeconds,
		camouflageSupportHoldSeconds: gfx.chameleonCamouflageSupportHoldSeconds,
		camouflageEyeRetention: gfx.chameleonCamouflageEyeRetention,
	};
	const camouflage = createSurfaceCamouflageController( meshes, camouflageSettings );
	const tongue = createTongueVisual( scene );
	const jaw = hybrid.rig.byName.get( 'jaw' ) || null;
	const mouthSocket = new THREE.Object3D();
	mouthSocket.name = 'PhysicalChameleonMouthSocket';
	const jawLength = Math.max( 0.08, finiteOr( jaw?.userData?.rest_length, 0.18 ) );
	if ( jaw ) {

		mouthSocket.position.copy( LOCAL_BONE_AXIS ).multiplyScalar( jawLength * 0.92 );
		jaw.add( mouthSocket );

	} else {

		mouthSocket.position.set( -0.48, 0.03, 0 );
		hybrid.model.add( mouthSocket );

	}
	const jawAxis = new THREE.Vector3( 0, 0, 1 );
	const jawDelta = new THREE.Quaternion();
	// The jaw is not driven by the active-ragdoll solver. Keep its authored
	// local rest rotation as the absolute reference so render interpolation can
	// never accumulate the attack delta from one frame to the next.
	const jawRestQuaternion = jaw?.quaternion.clone() || new THREE.Quaternion();
	const tongueDirection = new THREE.Vector3();
	const tongueMidpoint = new THREE.Vector3();
	const physicalPosition = new THREE.Vector3();
	const physicalForward = new THREE.Vector3();
	const physicalUp = new THREE.Vector3();
	const physicalSide = new THREE.Vector3();
	const mouthPosition = new THREE.Vector3();
	const renderedMouthPosition = new THREE.Vector3();
	const preyPosition = new THREE.Vector3();
	const destinationPosition = new THREE.Vector3();
	const destinationNormal = new THREE.Vector3();
	const move = new THREE.Vector3();
	const randomState = { value: BEHAVIOUR_RANDOM_SEED };
	const preyCandidateNodes = new Int32Array( PREY_ROUTE_CANDIDATES );
	const preyCandidateScores = new Float64Array( PREY_ROUTE_CANDIDATES );
	const command = Object.seal( {
		move,
		facing: hybrid.forward,
		turning: 0,
		sourceNormal: hybrid.supportNormal,
		sprint: false,
		release: false,
		fullRagdoll: false,
	} );

	hybrid.syncVisual( 1, 0 );
	hybrid.model.updateWorldMatrix( true, true );
	mouthSocket.getWorldPosition( renderedMouthPosition );
	const initialBody = hybrid.pelvis.body.translation();
	physicalPosition.set( initialBody.x, initialBody.y, initialBody.z );
	physicalUp.copy( hybrid.supportNormal ).normalize();
	physicalForward.copy( hybrid.forward ).projectOnPlane( physicalUp ).normalize();
	physicalSide.crossVectors( physicalForward, physicalUp ).normalize();
	mouthPosition.copy( renderedMouthPosition );

	let sourcePreyContext = ZERO_PREY;
	const visibilityRay = new surfaceWorld.physics.RAPIER.Ray(
		{ x: 0, y: 0, z: 0 },
		{ x: 1, y: 0, z: 0 },
	);
	const acceptsVisibilityCollider = ( collider ) =>
		surfaceWorld.supportMetadataByHandle.has( collider.handle );
	function environmentSegmentClear(
		startX, startY, startZ,
		endX, endY, endZ,
		endClearance,
	) {

		let dx = endX - startX;
		let dy = endY - startY;
		let dz = endZ - startZ;
		const length = Math.hypot( dx, dy, dz );
		const maximum = length - Math.max( 0, endClearance );
		if ( ! Number.isFinite( maximum ) || maximum <= 1e-5 ) return true;
		dx /= length; dy /= length; dz /= length;
		visibilityRay.origin.x = startX;
		visibilityRay.origin.y = startY;
		visibilityRay.origin.z = startZ;
		visibilityRay.dir.x = dx;
		visibilityRay.dir.y = dy;
		visibilityRay.dir.z = dz;
		return ! surfaceWorld.physics.world.castRay(
			visibilityRay,
			maximum,
			false,
			undefined,
			undefined,
			undefined,
			hybrid.pelvis.body,
			acceptsVisibilityCollider,
		);

	}
	const physicalPreyContext = {
		count: 0,
		capacity: MAX_BUTTERFLIES,
		x: null, y: null, z: null,
		active: null, visible: null, captured: null,
		headingX: null, headingY: null, headingZ: null, speed: null,
		hasLineOfSight( index, startX, startY, startZ, endX, endY, endZ ) {

			if ( sourcePreyContext.hasLineOfSight?.(
				index, startX, startY, startZ, endX, endY, endZ,
			) === false ) return false;
			return environmentSegmentClear(
				startX, startY, startZ, endX, endY, endZ, 0.07,
			);

		},
		isTongueSegmentClear( index, startX, startY, startZ, endX, endY, endZ ) {

			if ( sourcePreyContext.isTongueSegmentClear?.(
				index, startX, startY, startZ, endX, endY, endZ,
			) === false ) return false;
			return environmentSegmentClear(
				startX, startY, startZ, endX, endY, endZ, 0.018,
			);

		},
		tryCapture: ( index ) => sourcePreyContext.tryCapture?.( index ) !== false,
		setCapturedPosition: ( index, x, y, z ) =>
			sourcePreyContext.setCapturedPosition?.( index, x, y, z ) !== false,
		releaseCapture: ( index ) => sourcePreyContext.releaseCapture?.( index ) !== false,
		consume: ( index ) => sourcePreyContext.consume?.( index ) !== false,
	};

	try {

		await camouflage.prewarm( renderer, camera, hybrid.visualRoot, scene );

	} catch ( error ) {

		console.warn( 'Pré-chauffage du camouflage physique impossible.', error );

	}

	let simulation = createBehaviourKernel();
	let surfaceVisible = true;
	let selected = false;
	let disposed = false;
	let lastPhysicsAlpha = 1;
	let pendingVisualSimulationDt = 0;
	let destinationCollider = null;
	let currentDestinationHandle = null;
	let routeRequest = 0; // 1 = exploration, 2 = proie, 3 = replanification.
	let routeTargetIndex = -1;
	let preyRouteCountdown = 0;
	let explorationRetryCountdown = 0;
	let explorationDecisions = 0;
	let routeFailures = 0;
	let lastState = simulation.getView().state;
	let lastTargetIndex = -1;
	let camouflageCountdown = Math.max( 0.1, gfx.chameleonCamouflageInterval );
	let camouflageRemaining = 0;
	let camouflageDwell = 0;
	let camouflageScheduled = false;
	let camouflaged = false;

	const colliderByHandle = new Map();
	for ( const entry of surfaceWorld.entries ) {

		const handle = numericHandle( entry?.collider );
		if ( handle !== null ) colliderByHandle.set( handle, entry.collider );

	}
	const debugView = Object.seal( {
		visible: true,
		selected: false,
		x: physicalPosition.x,
		y: physicalPosition.y,
		z: physicalPosition.z,
		mouthX: renderedMouthPosition.x,
		mouthY: renderedMouthPosition.y,
		mouthZ: renderedMouthPosition.z,
		state: simulation.getView().state,
		stateName: simulation.getView().stateName,
		targetIndex: -1,
		capturedIndex: -1,
		attackDistance: gfx.chameleonAttackDistance,
		detectionDistance: gfx.chameleonDetectionDistance,
		camouflaged: false,
		camouflageRemaining: 0,
		camouflageProfile: null,
		locomotionState: 'observation',
		supportKind: 'sol',
		supportModel: 'sol',
		supportSegment: 0,
		routePosition: 0,
		routeLength: 0,
		explorationDecisions: 0,
		physicalContacts: true,
		groundedFeet: hybrid.contactCount,
		contactFrequency: 120,
		pathReachable: false,
		pathFailures: 0,
	} );
	const avoidanceView = Object.seal( {
		x: physicalPosition.x,
		y: physicalPosition.y,
		z: physicalPosition.z,
		headingX: physicalForward.x,
		headingY: physicalForward.y,
		headingZ: physicalForward.z,
		active: true,
		enabled: true,
		visible: true,
		camouflaged: false,
		isCamouflaged: false,
	} );

	function colliderForHandle( handle ) {

		if ( ! Number.isFinite( handle ) ) return null;
		return colliderByHandle.get( handle )
			|| surfaceWorld.physics.world.getCollider?.( handle ) || null;

	}

	function currentSupportCollider() {

		const reacquire = colliderForHandle( hybrid.reacquireColliderHandle );
		// A route only has a meaningful source while the animal physically owns a
		// support. Falling or being thrown must never be snapped to the spawn surface.
		const fallback = hybrid.contactCount > 0 ? reacquire : null;
		return dominantChameleonSupportCollider( hybrid.feet, fallback );

	}

	function readPhysicalPose() {

		const translation = hybrid.pelvis.body.translation();
		physicalPosition.set( translation.x, translation.y, translation.z );
		physicalUp.copy( hybrid.supportNormal );
		if ( physicalUp.lengthSq() < 1e-8 ) physicalUp.copy( WORLD_UP );
		else physicalUp.normalize();
		physicalForward.copy( hybrid.forward ).projectOnPlane( physicalUp );
		if ( physicalForward.lengthSq() < 1e-8 ) {

			physicalForward.set( -1, 0, 0 ).projectOnPlane( physicalUp );
			if ( physicalForward.lengthSq() < 1e-8 )
				physicalForward.set( 0, 0, -1 ).projectOnPlane( physicalUp );

		}
		physicalForward.normalize();
		physicalSide.crossVectors( physicalForward, physicalUp );
		if ( physicalSide.lengthSq() < 1e-8 ) physicalSide.set( 0, 0, 1 );
		else physicalSide.normalize();
		physicalUp.crossVectors( physicalSide, physicalForward ).normalize();

	}

	function preyContext() {

		return getButterflyPredationContext?.() || ZERO_PREY;

	}

	function preparePhysicalPreyContext() {

		const source = preyContext();
		sourcePreyContext = source?.prey || source || ZERO_PREY;
		for ( const property of [
			'count', 'capacity',
			'x', 'y', 'z',
			'active', 'visible', 'captured',
			'headingX', 'headingY', 'headingZ', 'speed',
		] ) physicalPreyContext[ property ] = sourcePreyContext[ property ] ?? null;
		physicalPreyContext.count = Math.max(
			0,
			Math.min( MAX_BUTTERFLIES, Math.trunc( sourcePreyContext.count ?? 0 ) ),
		);
		return physicalPreyContext;

	}

	function readSolvedMouth( view, target, restoreJaw ) {

		if ( jaw ) {

			jaw.quaternion.copy( jawRestQuaternion );
			const opening = chameleonJawOpening( view.state, view.attackClipPhase );
			if ( opening > 1e-5 ) {

				jawDelta.setFromAxisAngle( jawAxis, -0.34 * opening );
				jaw.quaternion.multiply( jawDelta ).normalize();

			}

		}
		hybrid.model.updateWorldMatrix( true, true );
		mouthSocket.getWorldPosition( target );
		if ( jaw && restoreJaw ) jaw.quaternion.copy( jawRestQuaternion );
		return target;

	}

	function readPreyPosition( context, index, target ) {

		const prey = context?.prey || context;
		if ( ! Number.isInteger( index ) || index < 0 || index >= ( prey?.count || 0 )
			|| ! prey.x || ! prey.y || ! prey.z ) return false;
		const x = prey.x[ index ];
		const y = prey.y[ index ];
		const z = prey.z[ index ];
		if ( ! Number.isFinite( x ) || ! Number.isFinite( y ) || ! Number.isFinite( z ) )
			return false;
		target.set( x, y, z );
		return true;

	}

	function scheduleNextCamouflage() {

		camouflageCountdown = Math.max( 0.1, gfx.chameleonCamouflageInterval )
			* ( 0.72 + nextRandom( randomState ) * 0.56 );

	}

	function stopCamouflageCycle() {

		camouflageScheduled = false;
		camouflaged = false;
		camouflageRemaining = 0;
		camouflageDwell = 0;
		scheduleNextCamouflage();

	}

	function updateCamouflageCycle( dt, state ) {

		if ( ! gfx.chameleonCamouflageEnabled ) {

			if ( camouflageScheduled || camouflaged ) stopCamouflageCycle();
			return;

		}
		const revealing = state === CHAMELEON_STATE.STRIKE_EXTEND
			|| state === CHAMELEON_STATE.CONTACT
			|| state === CHAMELEON_STATE.RETRACT_WITH_PREY
			|| state === CHAMELEON_STATE.BITE_AND_SWALLOW;
		if ( revealing ) {

			if ( camouflageScheduled || camouflaged ) stopCamouflageCycle();
			return;

		}
		if ( ! camouflageScheduled ) {

			camouflageCountdown -= dt;
			if ( camouflageCountdown <= 0
				&& ( state === CHAMELEON_STATE.REST_SCAN
					|| state === CHAMELEON_STATE.PATROL_LOG ) ) {

				camouflageScheduled = true;
				camouflageRemaining = THREE.MathUtils.lerp(
					Math.min( gfx.chameleonCamouflageMinDuration, gfx.chameleonCamouflageMaxDuration ),
					Math.max( gfx.chameleonCamouflageMinDuration, gfx.chameleonCamouflageMaxDuration ),
					nextRandom( randomState ),
				);
				camouflageDwell = 0;

			}

		}
		if ( ! camouflageScheduled ) return;
		camouflageRemaining = Math.max( 0, camouflageRemaining - dt );
		const velocity = hybrid.pelvis.body.linvel();
		const stationary = velocity.x * velocity.x + velocity.y * velocity.y
			+ velocity.z * velocity.z <= 0.065 * 0.065;
		camouflageDwell = advanceChameleonCamouflageDwell(
			camouflageDwell,
			dt,
			true,
			stationary,
			false,
		);
		// The avoidance contract must follow visible pigmentation, not merely the
		// short stationary debounce. The shader reaches 95% adaptation after its
		// configured duration, once the physical support vote has committed.
		const concealmentDelay = Math.max(
			CHAMELEON_CAMOUFLAGE_SETTLE_SECONDS,
			Math.max( 0, gfx.chameleonCamouflageSurfaceCommitSeconds )
				+ Math.max( 0.1, gfx.chameleonCamouflageAdaptSeconds ),
		);
		camouflaged = camouflageDwell >= concealmentDelay;
		if ( camouflageRemaining <= 0 ) stopCamouflageCycle();

	}

	function routeNodeWithinRoamingRadius( node ) {

		const offset = node * 3;
		const dx = surfaceWorld.navigation.positions[ offset ] - spawnPosition.x;
		const dy = surfaceWorld.navigation.positions[ offset + 1 ] - spawnPosition.y;
		const dz = surfaceWorld.navigation.positions[ offset + 2 ] - spawnPosition.z;
		const radius = Math.max( 2, gfx.chameleonRoamingRadius );
		return dx * dx + dy * dy + dz * dz <= radius * radius;

	}

	function planToNode( node, targetCollider ) {

		if ( ! Number.isInteger( node ) || node < 0 || node >= surfaceWorld.navigation.nodeCount
			|| ! targetCollider ) return false;
		const sourceCollider = currentSupportCollider();
		if ( ! sourceCollider ) return false;
		const offset = node * 3;
		destinationPosition.set(
			surfaceWorld.navigation.positions[ offset ],
			surfaceWorld.navigation.positions[ offset + 1 ],
			surfaceWorld.navigation.positions[ offset + 2 ],
		);
		destinationNormal.set(
			surfaceWorld.navigation.normals[ offset ],
			surfaceWorld.navigation.normals[ offset + 1 ],
			surfaceWorld.navigation.normals[ offset + 2 ],
		).normalize();
		if ( physicalPosition.distanceToSquared( destinationPosition ) < 0.72 * 0.72 ) return false;
		const route = routePlanner.plan(
			physicalPosition,
			sourceCollider,
			destinationPosition,
			destinationNormal,
			targetCollider,
			hybrid.supportNormal,
		);
		if ( ! route.reachable ) return false;
		explorer.setDestination(
			destinationPosition,
			destinationNormal,
			physicalPosition,
			route,
		);
		routeDebug.setRoute( route );
		destinationCollider = targetCollider;
		currentDestinationHandle = numericHandle( targetCollider );
		explorationDecisions ++;
		return true;

	}

	function chooseWeightedRecord() {

		let total = 0;
		for ( const record of records ) {

			const same = record.handle === currentDestinationHandle;
			total += record.weight * ( same ? 0.18 : 1 );

		}
		if ( total <= 0 ) return null;
		let cursor = nextRandom( randomState ) * total;
		for ( const record of records ) {

			const same = record.handle === currentDestinationHandle;
			cursor -= record.weight * ( same ? 0.18 : 1 );
			if ( cursor <= 0 ) return record;

		}
		return records[ records.length - 1 ] || null;

	}

	function planExplorationDestination() {

		for ( let attempt = 0; attempt < MAX_ROUTE_ATTEMPTS; attempt ++ ) {

			const record = chooseWeightedRecord();
			if ( ! record || record.nodes.length === 0 ) break;
			const node = record.nodes[
				Math.min( record.nodes.length - 1, Math.floor( nextRandom( randomState ) * record.nodes.length ) )
			];
			if ( ! routeNodeWithinRoamingRadius( node ) ) continue;
			if ( planToNode( node, record.collider ) ) return true;

		}
		return false;

	}

	function planTowardsPrey( index ) {

		const context = preyContext();
		if ( ! readPreyPosition( context, index, preyPosition ) ) return false;
		const candidateCount = surfaceWorld.nodeSpatialIndex.queryNearest(
			preyPosition.x,
			preyPosition.y,
			preyPosition.z,
			preyCandidateNodes,
			preyCandidateScores,
			PREY_ROUTE_CANDIDATES,
			spawnPosition.x,
			spawnPosition.y,
			spawnPosition.z,
			Math.max( 2, gfx.chameleonRoamingRadius ),
		);
		for ( let candidate = 0; candidate < candidateCount; candidate ++ ) {

			const node = preyCandidateNodes[ candidate ];
			const handle = surfaceWorld.navigation.handles[ node ];
			if ( planToNode( node, colliderForHandle( handle ) ) ) return true;

		}
		return false;

	}

	function replanCurrentDestination() {

		if ( ! explorer.destinationActive || ! destinationCollider ) return false;
		const sourceCollider = currentSupportCollider();
		if ( ! sourceCollider ) return false;
		const route = routePlanner.plan(
			physicalPosition,
			sourceCollider,
			explorer.destination,
			explorer.destinationNormal,
			destinationCollider,
			hybrid.supportNormal,
		);
		if ( ! route.reachable ) return false;
		explorer.setDestination(
			explorer.destination,
			explorer.destinationNormal,
			physicalPosition,
			route,
		);
		routeDebug.setRoute( route );
		return true;

	}

	function serviceRouteRequest() {

		if ( routeRequest === 0 || disposed ) return;
		const requestedType = routeRequest;
		readPhysicalPose();
		let accepted = false;
		if ( routeRequest === 1 ) accepted = planExplorationDestination();
		else if ( routeRequest === 2 ) accepted = planTowardsPrey( routeTargetIndex );
		else if ( routeRequest === 3 ) accepted = replanCurrentDestination();
		if ( ! accepted ) {

			routeFailures ++;
			explorer.clearDestination();
			destinationCollider = null;
			currentDestinationHandle = null;
			routeDebug.clear();
			if ( requestedType === 2 ) simulation.rejectTarget( routeTargetIndex );
			if ( requestedType === 1 ) {

				explorationRetryCountdown = 0.35;

			}

		} else if ( requestedType === 1 ) explorationRetryCountdown = 0;
		routeRequest = 0;

	}

	function requestRoute( type, targetIndex = -1 ) {

		// Predation always outranks an exploration/recovery request.
		if ( routeRequest === 2 && type !== 2 ) return;
		routeRequest = type;
		routeTargetIndex = targetIndex;

	}

	function updateLookTarget( context, view ) {

		const index = view.targetIndex >= 0 ? view.targetIndex : view.capturedIndex;
		if ( readPreyPosition( context, index, preyPosition ) )
			hybrid.setLookTarget( preyPosition, ATTACK_STATES.has( view.state ) ? 1 : 0.82 );
		else hybrid.clearLookTarget();

	}

	function beforePhysicsStep( fixedDt ) {

		readPhysicalPose();
		explorationRetryCountdown = Math.max( 0, explorationRetryCountdown - fixedDt );
		updateKernelSettings( simulation );
		simulation.setExternalPose(
			physicalPosition.x, physicalPosition.y, physicalPosition.z,
			physicalForward.x, physicalForward.y, physicalForward.z,
			physicalUp.x, physicalUp.y, physicalUp.z,
			mouthPosition.x, mouthPosition.y, mouthPosition.z,
			explorer.destinationCompleted,
		);
		const context = preparePhysicalPreyContext();
		const view = simulation.update( fixedDt, context );
		updateCamouflageCycle( fixedDt, view.state );
		updateLookTarget( context, view );

		if ( view.state !== lastState || view.targetIndex !== lastTargetIndex ) {

			if ( view.state === MOVING_ATTACK_STATE && ! camouflageScheduled ) {

				requestRoute( 2, view.targetIndex );
				preyRouteCountdown = ROUTE_REPLAN_SECONDS;

			} else if ( view.state === CHAMELEON_STATE.PATROL_LOG
				&& gfx.chameleonRoamingEnabled
				&& explorationRetryCountdown <= 0
				&& ( ! explorer.destinationActive || explorer.destinationCompleted ) ) {

				requestRoute( 1 );

			}
			lastState = view.state;
			lastTargetIndex = view.targetIndex;

		}

		const tracking = view.state === MOVING_ATTACK_STATE;
		updateHybridSettings( hybrid, tracking );
		move.set( 0, 0, 0 );
		const locomotionAllowed = ! camouflageScheduled
			&& ! ATTACK_STATES.has( view.state )
			&& ( view.state === CHAMELEON_STATE.PATROL_LOG
				|| view.state === MOVING_ATTACK_STATE );
		if ( locomotionAllowed && explorer.destinationActive ) {

			explorer.goalTurnRate = Math.max( 0.5, gfx.chameleonTurnSpeed );
			explorer.update(
				fixedDt,
				hybrid.supportNormal,
				physicalPosition,
				move,
				currentSupportCollider(),
			);

		}
		if ( view.state === MOVING_ATTACK_STATE && ! camouflageScheduled ) {

			preyRouteCountdown -= fixedDt;
			if ( preyRouteCountdown <= 0 ) {

				preyRouteCountdown = ROUTE_REPLAN_SECONDS;
				requestRoute( 2, view.targetIndex );

			}

		}
		if ( explorer.consumeReplanRequest() ) requestRoute( 3 );
		if ( view.state === CHAMELEON_STATE.PATROL_LOG
			&& gfx.chameleonRoamingEnabled
			&& explorationRetryCountdown <= 0
			&& ! explorer.destinationActive && ! explorer.destinationCompleted ) requestRoute( 1 );

		command.facing = move.lengthSq() > 1e-8 ? move : hybrid.forward;
		command.sourceNormal = hybrid.supportNormal;
		command.sprint = tracking && move.lengthSq() > 1e-8;
		command.release = false;
		command.fullRagdoll = false;
		hybrid.setCommand( command );
		hybrid.beforeStep( fixedDt );
		// The fixed-step socket includes the solved neck/head look and jaw pose.
		// It becomes the authoritative logical mouth on the following 1/120 s step,
		// matching the interpolated render without making simulation depend on FPS.
		readSolvedMouth( view, mouthPosition, true );

	}

	function stepSimulation( dt ) {

		if ( ! Number.isFinite( dt ) || dt < 0 )
			throw new RangeError( 'dt must be a finite non-negative number' );
		if ( disposed || ! gfx.chameleonEnabled || dt === 0 ) return simulation.getTelemetry();
		pendingVisualSimulationDt += dt;
		const result = surfaceWorld.physics.step(
			dt,
			beforePhysicsStep,
			() => hybrid.afterStep(),
		);
		lastPhysicsAlpha = result.alpha;
		serviceRouteRequest();
		updateAvoidanceView();
		return simulation.getTelemetry();

	}

	function updateAvoidanceView() {

		readPhysicalPose();
		avoidanceView.x = physicalPosition.x;
		avoidanceView.y = physicalPosition.y;
		avoidanceView.z = physicalPosition.z;
		avoidanceView.headingX = physicalForward.x;
		avoidanceView.headingY = physicalForward.y;
		avoidanceView.headingZ = physicalForward.z;
		avoidanceView.active = !! gfx.chameleonEnabled;
		avoidanceView.enabled = !! gfx.chameleonEnabled;
		avoidanceView.visible = !! gfx.chameleonEnabled && surfaceVisible;
		avoidanceView.camouflaged = camouflaged;
		avoidanceView.isCamouflaged = camouflaged;

	}

	function renderAttack( view ) {

		readSolvedMouth( view, renderedMouthPosition, false );
		const tongueVisible = view.tongueVisible === 1 && surfaceVisible && gfx.chameleonEnabled;
		if ( ! tongueVisible ) {

			tongue.tube.visible = false;
			tongue.pad.visible = false;
			return;

		}
		tongueDirection.set(
			view.tongueTipX - renderedMouthPosition.x,
			view.tongueTipY - renderedMouthPosition.y,
			view.tongueTipZ - renderedMouthPosition.z,
		);
		const length = tongueDirection.length();
		if ( ! Number.isFinite( length ) || length <= 1e-5 ) {

			tongue.tube.visible = false;
			tongue.pad.visible = false;
			return;

		}
		tongueDirection.multiplyScalar( 1 / length );
		tongueMidpoint.set(
			( renderedMouthPosition.x + view.tongueTipX ) * 0.5,
			( renderedMouthPosition.y + view.tongueTipY ) * 0.5,
			( renderedMouthPosition.z + view.tongueTipZ ) * 0.5,
		);
		tongue.tube.position.copy( tongueMidpoint );
		tongue.tube.quaternion.setFromUnitVectors( LOCAL_BONE_AXIS, tongueDirection );
		tongue.tube.scale.set( 1, length, 1 );
		tongue.pad.position.set( view.tongueTipX, view.tongueTipY, view.tongueTipZ );
		tongue.tube.visible = true;
		tongue.pad.visible = true;

	}

	function updateDebugView( view ) {

		const supportCollider = currentSupportCollider();
		const supportHandle = numericHandle( supportCollider );
		const metadata = supportHandle === null ? null
			: resolveSurfaceMetadata( surfaceWorld, supportHandle );
		debugView.visible = !! gfx.chameleonEnabled && surfaceVisible;
		debugView.selected = selected;
		debugView.x = physicalPosition.x;
		debugView.y = physicalPosition.y;
		debugView.z = physicalPosition.z;
		debugView.mouthX = renderedMouthPosition.x;
		debugView.mouthY = renderedMouthPosition.y;
		debugView.mouthZ = renderedMouthPosition.z;
		debugView.state = view.state;
		debugView.stateName = view.stateName;
		debugView.targetIndex = view.targetIndex;
		debugView.capturedIndex = view.capturedIndex;
		debugView.attackDistance = simulation.attackDistance;
		debugView.detectionDistance = simulation.detectionDistance;
		debugView.camouflaged = camouflaged;
		debugView.camouflageRemaining = camouflageRemaining;
		debugView.camouflageProfile = camouflage.getView().profile;
		debugView.locomotionState = stateLocomotionLabel( view.state, camouflaged );
		debugView.supportKind = metadata?.kind || 'sol';
		debugView.supportModel = metadata?.model
			|| metadata?.provenance?.model || debugView.supportKind;
		debugView.supportSegment = explorer.routeProgressIndex;
		debugView.routePosition = explorer.routeProgressIndex;
		debugView.routeLength = explorer.routeCount;
		debugView.explorationDecisions = explorationDecisions;
		debugView.groundedFeet = hybrid.contactCount;
		debugView.pathReachable = explorer.destinationActive || explorer.destinationCompleted;
		debugView.pathFailures = routeFailures;

	}

	function renderFrame( renderDt = 0, visible = true ) {

		if ( ! Number.isFinite( renderDt ) || renderDt < 0 )
			throw new RangeError( 'renderDt must be a finite non-negative number' );
		if ( disposed ) return simulation.getTelemetry();
		surfaceVisible = !! visible;
		hybrid.visualRoot.visible = !! gfx.chameleonEnabled && surfaceVisible;
		tongue.material.color.set( gfx.chameleonTongueColor );
		if ( ! gfx.chameleonEnabled ) {

			debugView.visible = false;
			tongue.tube.visible = false;
			tongue.pad.visible = false;
			routeDebug.setVisible( false );
			rigDebug.setVisible( false );
			hybrid.setDebugVisible( false );
			updateAvoidanceView();
			return simulation.getTelemetry();

		}

		hybrid.syncVisual( lastPhysicsAlpha, renderDt );
		const view = simulation.getView();
		renderAttack( view );
		const visualDt = Math.min( 2, pendingVisualSimulationDt );
		pendingVisualSimulationDt = 0;
		updateCamouflageSettings( camouflageSettings, camouflaged );
		camouflage.update( visualDt, hybrid.feet );
		const showRoute = selected && surfaceVisible && !! gfx.chameleonDebugRoute;
		const showContacts = selected && surfaceVisible && !! gfx.chameleonDebugContacts;
		const showRig = selected && surfaceVisible && !! gfx.chameleonDebugRig;
		routeDebug.setVisible( showRoute );
		routeDebug.setProgress( explorer.routeProgressIndex );
		hybrid.setDebugVisible( showContacts );
		rigDebug.setVisible( showRig );
		if ( showRig ) rigDebug.update( true );
		updateAvoidanceView();
		updateDebugView( view );
		return simulation.getTelemetry();

	}

	function reset() {

		const previousView = simulation.getView();
		if ( previousView.capturedIndex >= 0 )
			preyContext()?.releaseCapture?.( previousView.capturedIndex );
		simulation = createBehaviourKernel();
		hybrid.reset( spawnPosition );
		explorer.clearDestination();
		explorer.resetProgress( spawnPosition );
		explorer.seed = EXPLORER_SEED;
		explorer.timeToChange = 0;
		explorer.phase = 0;
		explorer.heading.set( -1, 0, 0 );
		randomState.value = BEHAVIOUR_RANDOM_SEED;
		routeDebug.clear();
		camouflage.reset();
		destinationCollider = null;
		currentDestinationHandle = null;
		routeRequest = 0;
		routeTargetIndex = -1;
		preyRouteCountdown = 0;
		explorationRetryCountdown = 0;
		explorationDecisions = 0;
		routeFailures = 0;
		lastState = simulation.getView().state;
		lastTargetIndex = -1;
		camouflageRemaining = 0;
		camouflageDwell = 0;
		camouflageScheduled = false;
		camouflaged = false;
		scheduleNextCamouflage();
		pendingVisualSimulationDt = 0;
		lastPhysicsAlpha = 1;
		readPhysicalPose();
		hybrid.syncVisual( 1, 0 );
		readSolvedMouth( simulation.getView(), mouthPosition, true );
		updateAvoidanceView();
		renderFrame( 0, surfaceVisible );
		return simulation.getTelemetry();

	}

	function setSurfaceVisible( visible ) {

		surfaceVisible = !! visible;
		hybrid.visualRoot.visible = surfaceVisible && !! gfx.chameleonEnabled;
		if ( ! surfaceVisible ) {

			tongue.tube.visible = false;
			tongue.pad.visible = false;
			routeDebug.setVisible( false );
			rigDebug.setVisible( false );
			hybrid.setDebugVisible( false );

		}
		updateAvoidanceView();
		return surfaceVisible;

	}

	function setCastShadow( value ) {

		const enabled = !! value;
		for ( const mesh of meshes ) mesh.castShadow = enabled;
		tongue.tube.castShadow = enabled;
		tongue.pad.castShadow = enabled;
		return enabled;

	}

	function setReceiveShadow( value ) {

		const enabled = !! value;
		for ( const mesh of meshes ) mesh.receiveShadow = enabled;
		tongue.tube.receiveShadow = enabled;
		tongue.pad.receiveShadow = enabled;
		return enabled;

	}

	function select() {

		selected = true;
		debugView.selected = true;
		return debugView;

	}

	function clearSelection() {

		selected = false;
		debugView.selected = false;
		routeDebug.setVisible( false );
		rigDebug.setVisible( false );
		hybrid.setDebugVisible( false );
		return debugView;

	}

	function dispose() {

		if ( disposed ) return;
		const view = simulation.getView();
		if ( view.capturedIndex >= 0 ) preyContext()?.releaseCapture?.( view.capturedIndex );
		disposed = true;
		camouflage.dispose();
		routeDebug.dispose();
		rigDebug.dispose();
		tongue.dispose();
		hybrid.dispose();
		surfaceWorld.dispose();

	}

	scheduleNextCamouflage();
	setCastShadow( gfx.chameleonCastShadow );
	setReceiveShadow( gfx.chameleonReceiveShadow );
	updateAvoidanceView();

	return {
		architecture: 'shared-rapier-hybrid-surface-manifold',
		group: hybrid.visualRoot,
		model: hybrid.model,
		pickable: hybrid.model,
		tongue: tongue.tube,
		tongueTube: tongue.tube,
		tonguePad: tongue.pad,
		stepSimulation,
		renderFrame,
		update( dt, visible = true ) {

			const telemetry = stepSimulation( dt );
			renderFrame( dt, visible );
			return telemetry;

		},
		reset,
		dispose,
		setSurfaceVisible,
		setCastShadow,
		setReceiveShadow,
		select,
		clearSelection,
		getSimulation: () => simulation,
		getTelemetry: () => simulation.getTelemetry(),
		getDebugView: () => debugView,
		getDebugSnapshot: () => debugView,
		getAvoidanceContext: () => avoidanceView,
		getAvoidanceView: () => avoidanceView,
		getSupportNetwork: () => surfaceWorld.navigation,
		getSurfaceWorld: () => surfaceWorld,
		getSurfaceRouter: () => routePlanner,
		getTrack: () => explorer,
		getProceduralGait: () => hybrid.wholeBodyGait,
		getRigBinding: () => hybrid.rig,
		getTailContactSolver: () => hybrid.tailPhysics,
		getBodyContactView: () => ( {
			contacts: hybrid.contactCount,
			supportNormal: hybrid.supportNormal,
		} ),
		getLocomotionState: () => stateLocomotionLabel(
			simulation.getView().state,
			camouflaged,
		),
		getFootContacts: () => hybrid.feet,
	};

}
