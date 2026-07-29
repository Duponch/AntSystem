import * as THREE from 'three/webgpu';

import { WORLD, gfx } from './config.js';
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

const FOOT_CONTACT_COUNT = 4;
const STATIONARY_EPSILON = 1e-5;

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

	const surfaceGraphBaker = new ChameleonSurfaceGraphBaker();
	let surfaceGraph = null;
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

	const forward = new THREE.Vector3();
	const up = new THREE.Vector3();
	const localX = new THREE.Vector3();
	const localZ = new THREE.Vector3();
	const rotationMatrix = new THREE.Matrix4();
	const tongueDirection = new THREE.Vector3();
	const authoredMouth = new THREE.Vector3();
	const visualTongueTip = new THREE.Vector3();
	const mouthCorrection = new THREE.Vector3();
	const targetBodyQuaternion = new THREE.Quaternion();

	const supportFrontPosition = new THREE.Vector3();
	const supportBackPosition = new THREE.Vector3();
	const supportCentrePosition = new THREE.Vector3();
	const supportFrontNormal = new THREE.Vector3();
	const supportBackNormal = new THREE.Vector3();
	const supportCentreNormal = new THREE.Vector3();
	const supportCentreTangent = new THREE.Vector3();
	const footContacts = new Float32Array( FOOT_CONTACT_COUNT * 3 );
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

	function makeContinuousHandoff( candidate, px, py, pz, pnx, pny, pnz ) {

		const gap = Math.hypot(
			candidate.x[ 0 ] - px,
			candidate.y[ 0 ] - py,
			candidate.z[ 0 ] - pz,
		);
		if ( gap <= 1e-4 ) return candidate;
		const bridgeCount = Math.min( 32, Math.max( 1, Math.ceil( gap / 0.72 ) ) );
		const count = candidate.count + bridgeCount;
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
			graphNode: new Uint32Array( count ),
			startNode: candidate.startNode,
			targetNode: candidate.targetNode,
			pathNodeCount: candidate.pathNodeCount,
			effectiveSpacing: candidate.effectiveSpacing,
			supportCount: candidate.supportCount,
			supports: candidate.supports,
			handoff: true,
		};
		for ( let index = 0; index < bridgeCount; index ++ ) {

			const alpha = index / bridgeCount;
			corridor.x[ index ] = px + ( candidate.x[ 0 ] - px ) * alpha;
			corridor.y[ index ] = py + ( candidate.y[ 0 ] - py ) * alpha;
			corridor.z[ index ] = pz + ( candidate.z[ 0 ] - pz ) * alpha;
			corridor.normalX[ index ] = pnx + ( candidate.normalX[ 0 ] - pnx ) * alpha;
			corridor.normalY[ index ] = pny + ( candidate.normalY[ 0 ] - pny ) * alpha;
			corridor.normalZ[ index ] = pnz + ( candidate.normalZ[ 0 ] - pnz ) * alpha;
			corridor.kind[ index ] = CHAMELEON_SURFACE_KIND.TRANSITION;
			corridor.supportId[ index ] = - 1;
			corridor.graphNode[ index ] = candidate.startNode;

		}
		for ( let index = 0; index < candidate.count; index ++ ) {

			const target = bridgeCount + index;
			for ( const key of [ 'x', 'y', 'z', 'normalX', 'normalY', 'normalZ', 'kind', 'supportId' ] )
				corridor[ key ][ target ] = candidate[ key ][ index ];
			corridor.graphNode[ target ] = candidate.graphNode?.[ index ] ?? candidate.targetNode;

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
			const normalLength = Math.hypot( nx, ny, nz ) || 1;
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

	function installCorridor( candidate, preservePosition = false ) {

		let next = candidate;
		const preserveHeading = !! track;
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
				supportCentreNormal.x, supportCentreNormal.y, supportCentreNormal.z,
			);

		}
		track = next;
		simulation.trackPosition = 0;
		simulation.patrolDirection = 1;
		simulation.setTrackSamples( track );
		if ( preserveHeading ) simulation.setHeading( headingX, headingY, headingZ );
		normalSegment = 0;
		return track;

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

	function rebuildTrack( force = false ) {

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
		if ( ! force && ! routePublicationIsSafe( roamingEnabled ) ) return false;

		const previousTrack = track;
		const previousX = simulation.x;
		const previousY = simulation.y;
		const previousZ = simulation.z;
		host = selectChameleonHost( props.registry );
		const baked = surfaceGraphBaker.update( props.registry, {
			revision,
			host,
			worldSize: WORLD,
			scales: {
				obstacles: nextObstacleScale,
				trees: nextTreeScale,
				rocks: nextRockScale,
			},
			supportClearance,
			groundClearance,
		} );
		surfaceGraph = baked.graph;
		surfaceRouter = new ChameleonSurfaceRouter( surfaceGraph, {
			seed: 0x51f15e,
			horizonDistance: 11,
			maxSamples: 352,
		} );
		if ( previousTrack ) surfaceRouter.rebase( previousX, previousY, previousZ );
		const roamingRadius = Math.max( 2,
			setting( settings, 'chameleonRoamingRadius', Math.ceil( WORLD * Math.SQRT2 ) ) );
		installCorridor( surfaceRouter.exploreNext( roamingRadius ), !! previousTrack );
		propRevision = revision;
		obstacleScale = nextObstacleScale;
		treeScale = nextTreeScale;
		rockScale = nextRockScale;
		cachedSupportClearance = supportClearance;
		cachedGroundClearance = groundClearance;
		lastNetworkRevision ++;
		group.visible = surfaceVisible && setting( settings, 'chameleonEnabled', true ) !== false;
		return true;

	}

	function advanceExplorationRoute() {

		if ( ! surfaceRouter || ! simulation.routeCompleted ) return false;
		if ( setting( settings, 'chameleonRoamingEnabled', true ) === false ) return false;
		if ( simulation.state !== CHAMELEON_STATE.REST_SCAN
			|| simulation.targetIndex >= 0 || simulation.capturedIndex >= 0 ) return false;
		const roamingRadius = Math.max( 2,
			setting( settings, 'chameleonRoamingRadius', Math.ceil( WORLD * Math.SQRT2 ) ) );
		installCorridor( surfaceRouter.exploreNext( roamingRadius ) );
		return true;

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

	}

	function orientBody( view, renderDt = 0 ) {

		forward.set( view.headingX, view.headingY, view.headingZ ).normalize();
		sampleSupport(
			view.trackPosition, supportCentrePosition, supportCentreNormal, supportCentreTangent,
		);
		const routeSign = forward.dot( supportCentreTangent ) < 0 ? - 1 : 1;
		const halfContactLength = Math.max( 0.12,
			setting( settings, 'chameleonLength', CHAMELEON_WORLD_LENGTH ) * visualScale * 0.27 );
		sampleSupport(
			view.trackPosition + routeSign * halfContactLength,
			supportFrontPosition, supportFrontNormal,
		);
		sampleSupport(
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
		up.addScaledVector( forward, - up.dot( forward ) );
		if ( up.lengthSq() < 1e-7 ) up.set( 0, 1, 0 );
		up.normalize();
		localX.copy( forward ).multiplyScalar( - 1 );
		localZ.crossVectors( localX, up ).normalize();
		up.crossVectors( localZ, localX ).normalize();
		rotationMatrix.makeBasis( localX, up, localZ );
		targetBodyQuaternion.setFromRotationMatrix( rotationMatrix );
		if ( ! bodyOrientationReady || renderDt <= 0 ) {

			bodyRoot.quaternion.copy( targetBodyQuaternion );
			bodyOrientationReady = true;

		} else {

			const response = Math.max( 0.1, setting( settings, 'chameleonTurnSpeed', 6 ) );
			const blend = 1 - Math.exp( - response * Math.min( 0.1, renderDt ) );
			bodyRoot.quaternion.slerp( targetBodyQuaternion, blend );

		}
		bodyRoot.position.set( view.x, view.y, view.z );
		localZ.set( 0, 0, 1 ).applyQuaternion( bodyRoot.quaternion );

		// Four stable support contacts approximate the authored foot IK targets.
		// They straddle the baked curve, so the body frame anticipates log ends
		// without executing an IK solve or a geometry query in the render loop.
		const halfWidth = Math.max( 0.025, asset.metrics.width * modelUnitScale * 0.28 );
		footContacts[ 0 ] = supportFrontPosition.x + localZ.x * halfWidth;
		footContacts[ 1 ] = supportFrontPosition.y + localZ.y * halfWidth;
		footContacts[ 2 ] = supportFrontPosition.z + localZ.z * halfWidth;
		footContacts[ 3 ] = supportFrontPosition.x - localZ.x * halfWidth;
		footContacts[ 4 ] = supportFrontPosition.y - localZ.y * halfWidth;
		footContacts[ 5 ] = supportFrontPosition.z - localZ.z * halfWidth;
		footContacts[ 6 ] = supportBackPosition.x + localZ.x * halfWidth;
		footContacts[ 7 ] = supportBackPosition.y + localZ.y * halfWidth;
		footContacts[ 8 ] = supportBackPosition.z + localZ.z * halfWidth;
		footContacts[ 9 ] = supportBackPosition.x - localZ.x * halfWidth;
		footContacts[ 10 ] = supportBackPosition.y - localZ.y * halfWidth;
		footContacts[ 11 ] = supportBackPosition.z - localZ.z * halfWidth;

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

	function updateTongue( view ) {

		const visible = !! view.tongueVisible && surfaceVisible && group.visible;
		tongue.visible = visible;
		if ( ! visible ) return;
		instance.model.updateMatrixWorld( true );
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
		if ( ! group.visible ) tongue.visible = false;

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
			syncDebugView( disabledView, dt, true );
			return disabledView;

		}
		updateCamouflageSchedule( dt );
		const prey = typeof getButterflyPredationContext === 'function'
			? getButterflyPredationContext() || EMPTY_PREY
			: EMPTY_PREY;
		const view = simulation.update( dt, prey );
		syncDebugView( view, dt, true );
		return view;

	}

	function renderFrame( renderDt = 0, visible = surfaceVisible ) {

		if ( ! Number.isFinite( renderDt ) || renderDt < 0 )
			throw new RangeError( 'renderDt must be a finite non-negative number' );
		if ( disposed ) return simulation.getView();
		surfaceVisible = !! visible;
		applyVisualScale();
		rebuildTrack();
		syncVisualSettings();
		const enabled = surfaceVisible
			&& setting( settings, 'chameleonEnabled', true ) !== false
			&& !! track;
		group.visible = enabled;
		if ( ! enabled ) {

			tongue.visible = false;
			const disabledView = simulation.getView();
			syncDebugView( disabledView );
			return disabledView;

		}
		const view = simulation.getView();
		orientBody( view, renderDt );
		updateAnimation( renderDt, view );
		updateTongue( view );
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

		simulation = createKernel();
		surfaceGraphBaker.invalidate();
		surfaceGraph = null;
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
		debugHasPosition = false;
		avoidanceView.velocityX = 0;
		avoidanceView.velocityY = 0;
		avoidanceView.velocityZ = 0;
		avoidanceView.speed = 0;
		scheduleNextCamouflage();
		applyVisualScale( true );
		rebuildTrack( true );
		const view = simulation.update( 0, EMPTY_PREY );
		if ( track ) orientBody( view );
		updateAnimation( 0, view );
		updateTongue( view );
		syncDebugView( view );
		syncCamouflageVisual( 0, true );

	}

	function dispose() {

		if ( disposed ) return;
		disposed = true;
		avoidanceView.active = false;
		avoidanceView.visible = false;
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
	if ( track ) orientBody( initialView );
	updateAnimation( 0, initialView );
	updateTongue( initialView );
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
