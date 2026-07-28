import * as THREE from 'three/webgpu';

import { gfx } from './config.js';
import {
	CHAMELEON_STATE,
	ChameleonSimulation,
} from './chameleon-simulation.js';
import {
	instantiateChameleonAsset,
	loadChameleonAsset,
} from './chameleon-assets.js';
import {
	buildChameleonTrack,
	selectChameleonHost,
} from './chameleon-track.js';

export const CHAMELEON_WORLD_LENGTH = 3.1;

const EMPTY_PREY = Object.freeze( { count: 0 } );
const LOCAL_Y = new THREE.Vector3( 0, 1, 0 );

function setting( graphics, name, fallback ) {

	const value = graphics?.[ name ];
	return value === undefined ? fallback : value;

}

function attackState( state ) {

	return state >= CHAMELEON_STATE.AIM_AND_BRACE
		&& state <= CHAMELEON_STATE.BITE_AND_SWALLOW;

}

/**
 * One skeletal animal, one fixed procedural tongue and one bounded CPU kernel.
 * Track relief is rebuilt only when props or their obstacle scale change.
 */
export async function createChameleons( {
	scene,
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

	let track = null;
	let host = null;
	let propRevision = - 1;
	let obstacleScale = NaN;
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

	const forward = new THREE.Vector3();
	const up = new THREE.Vector3();
	const localX = new THREE.Vector3();
	const localZ = new THREE.Vector3();
	const rotationMatrix = new THREE.Matrix4();
	const tongueDirection = new THREE.Vector3();
	const authoredMouth = new THREE.Vector3();
	const visualTongueTip = new THREE.Vector3();
	const mouthCorrection = new THREE.Vector3();

	function createKernel() {

		return new ChameleonSimulation( {
			preyCapacity: Math.max( 1, Math.round( setting( settings, 'maxButterflies', 64 ) ) ),
			scanFrequency: setting( settings, 'chameleonScanFrequency', 9 ),
			attackDistance: setting( settings, 'chameleonAttackDistance', 3.2 ),
			detectionDistance: setting( settings, 'chameleonDetectionDistance', 4.8 ),
			maxTongueLength: setting( settings, 'chameleonTongueLength', 3.5 ),
			patrolSpeed: setting( settings, 'chameleonPatrolSpeed', 0.62 ),
			trackingSpeed: setting( settings, 'chameleonTrackingSpeed', 0.95 ),
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

	function rebuildTrack( force = false ) {

		const revision = typeof props.getRevision === 'function' ? props.getRevision() : 0;
		const scale = Math.max( 0.01, setting( settings, 'scaleObstacles', 1 ) );
		if ( ! force && revision === propRevision && scale === obstacleScale ) return false;
		host = selectChameleonHost( props.registry );
		if ( ! host ) {

			track = null;
			propRevision = revision;
			obstacleScale = scale;
			group.visible = false;
			tongue.visible = false;
			return false;

		}
		track = buildChameleonTrack( host, {
			scales: { obstacles: scale },
			clearance: setting( settings, 'chameleonLogClearance', 0.006 ),
		} );
		simulation.setTrackSamples( track.x, track.y, track.z, track.count );
		normalSegment = 0;
		propRevision = revision;
		obstacleScale = scale;
		return true;

	}

	function sampleSupportNormal( distance ) {

		const lastSegment = track.count - 2;
		while ( normalSegment > 0 && distance < track.distance[ normalSegment ] ) normalSegment --;
		while (
			normalSegment < lastSegment
			&& distance > track.distance[ normalSegment + 1 ]
		) normalSegment ++;
		const start = track.distance[ normalSegment ];
		const end = track.distance[ normalSegment + 1 ];
		const alpha = end > start ? ( distance - start ) / ( end - start ) : 0;
		up.set(
			track.normalX[ normalSegment ]
				+ ( track.normalX[ normalSegment + 1 ] - track.normalX[ normalSegment ] ) * alpha,
			track.normalY[ normalSegment ]
				+ ( track.normalY[ normalSegment + 1 ] - track.normalY[ normalSegment ] ) * alpha,
			track.normalZ[ normalSegment ]
				+ ( track.normalZ[ normalSegment + 1 ] - track.normalZ[ normalSegment ] ) * alpha,
		).normalize();

	}

	function orientBody( view ) {

		forward.set( view.headingX, view.headingY, view.headingZ ).normalize();
		sampleSupportNormal( view.trackPosition );
		up.addScaledVector( forward, - up.dot( forward ) );
		if ( up.lengthSq() < 1e-7 ) up.set( 0, 1, 0 );
		up.normalize();
		localX.copy( forward ).multiplyScalar( - 1 );
		localZ.crossVectors( localX, up ).normalize();
		up.crossVectors( localZ, localX ).normalize();
		rotationMatrix.makeBasis( localX, up, localZ );
		bodyRoot.quaternion.setFromRotationMatrix( rotationMatrix );
		bodyRoot.position.set( view.x, view.y, view.z );

	}

	function updateAnimation( dt, view ) {

		const telemetry = simulation.getTelemetry();
		const travelled = Math.max( 0, telemetry.distanceTravelled - previousDistanceTravelled );
		previousDistanceTravelled = telemetry.distanceTravelled;
		const stride = Math.max( 0.1, setting( settings, 'chameleonStrideLength', 1.35 ) * visualScale );
		walkPhase = ( walkPhase + travelled / stride ) % 1;
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
			const prey = typeof getButterflyPredationContext === 'function'
				? getButterflyPredationContext()
				: null;
			const index = view.capturedIndex;
			if ( prey?.setCapturedPosition && prey.x && prey.y && prey.z ) {

				prey.setCapturedPosition(
					index,
					prey.x[ index ] + mouthCorrection.x,
					prey.y[ index ] + mouthCorrection.y,
					prey.z[ index ] + mouthCorrection.z,
				);

			}

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

	function syncRuntimeSettings() {

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
		const nextCast = !! setting( settings, 'chameleonCastShadow', castShadow );
		const nextReceive = !! setting( settings, 'chameleonReceiveShadow', receiveShadow );
		if ( nextCast !== castShadow ) setCastShadow( nextCast );
		if ( nextReceive !== receiveShadow ) setReceiveShadow( nextReceive );
		group.visible = surfaceVisible && setting( settings, 'chameleonEnabled', true ) !== false && !! track;

	}

	function update( dt ) {

		if ( disposed ) return;
		applyVisualScale();
		rebuildTrack();
		syncRuntimeSettings();
		const enabled = surfaceVisible
			&& setting( settings, 'chameleonEnabled', true ) !== false
			&& !! track;
		group.visible = enabled;
		if ( ! enabled ) {

			tongue.visible = false;
			return;

		}
		const prey = typeof getButterflyPredationContext === 'function'
			? getButterflyPredationContext() || EMPTY_PREY
			: EMPTY_PREY;
		const view = simulation.update( dt, prey );
		orientBody( view );
		updateAnimation( dt, view );
		updateTongue( view );

	}

	function reset() {

		simulation = createKernel();
		propRevision = - 1;
		obstacleScale = NaN;
		visualScale = NaN;
		attackBlend = 0;
		walkPhase = 0;
		previousDistanceTravelled = 0;
		applyVisualScale( true );
		rebuildTrack( true );
		const view = simulation.update( 0, EMPTY_PREY );
		if ( track ) orientBody( view );
		updateAnimation( 0, view );
		updateTongue( view );

	}

	function dispose() {

		if ( disposed ) return;
		disposed = true;
		mixer.stopAllAction();
		scene.remove( group );
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
	const initialView = simulation.update( 0, EMPTY_PREY );
	if ( track ) orientBody( initialView );
	updateAnimation( 0, initialView );
	updateTongue( initialView );

	return {
		group,
		model: instance.model,
		tongue,
		tongueTube,
		tonguePad,
		update,
		reset,
		dispose,
		setSurfaceVisible,
		setCastShadow,
		setReceiveShadow,
		getSimulation: () => simulation,
		getTelemetry: () => simulation.getTelemetry(),
		getTrack: () => track,
		getHost: () => host,
	};

}
