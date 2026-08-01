import * as THREE from 'three/webgpu';

import './lab.css';
import { createPhysicsWorld } from './physics-world.js';
import { createLabEnvironment } from './environment.js';
import { createHybridChameleon } from './hybrid-chameleon.js';
import {
	AutonomousExplorer,
	LabInputController,
	ThirdPersonCamera,
} from './third-person-controller.js';
import { GrabController } from './grab-controller.js';
import { createLabUI } from './lab-ui.js';
import { PlatformerControlModel } from './platformer-control-model.js';
import { PlatformerJumpModel } from './platformer-jump-model.js';
import { createRigDebugView } from './rig-debug-view.js';

function createLoadingScreen() {

	const element = document.createElement( 'div' );
	element.className = 'chameleon-lab-loading';
	element.textContent = 'Construction du corps physique et du laboratoire…';
	document.body.append( element );
	return {
		element,
		done() {

			element.classList.add( 'done' );
			window.setTimeout( () => element.remove(), 420 );

		},
	};

}

function configureLights( scene ) {

	const hemisphere = new THREE.HemisphereLight( 0xcfe8ff, 0x382815, 1.55 );
	scene.add( hemisphere );
	const sun = new THREE.DirectionalLight( 0xffefc7, 3.1 );
	sun.position.set( -7, 12, 8 );
	sun.castShadow = true;
	sun.shadow.mapSize.set( 2048, 2048 );
	sun.shadow.camera.near = 0.5;
	sun.shadow.camera.far = 35;
	sun.shadow.camera.left = -13;
	sun.shadow.camera.right = 13;
	sun.shadow.camera.top = 13;
	sun.shadow.camera.bottom = -13;
	sun.shadow.bias = -0.00035;
	sun.shadow.normalBias = 0.025;
	scene.add( sun );
	const fill = new THREE.DirectionalLight( 0x83a9c2, 0.65 );
	fill.position.set( 8, 5, -8 );
	scene.add( fill );
	return { hemisphere, sun, fill };

}

function showFatalError( error ) {

	console.error( error );
	const element = document.getElementById( 'webgpu-error' );
	if ( ! element ) return;
	const detail = String( error?.stack || error?.message || error )
		.replaceAll( '&', '&amp;' )
		.replaceAll( '<', '&lt;' );
	element.style.display = 'flex';
	element.innerHTML = `<div><h2>Le laboratoire n'a pas pu démarrer</h2><p>WebGPU et le corps physique doivent être disponibles.</p><pre style="max-width:88vw;max-height:55vh;overflow:auto;text-align:left;white-space:pre-wrap">${ detail }</pre></div>`;

}

async function main() {

	if ( ! navigator.gpu ) throw new Error( 'WebGPU is unavailable in this browser.' );
	document.body.classList.add( 'chameleon-lab' );
	const loading = createLoadingScreen();
	const app = document.getElementById( 'app' );
	app.replaceChildren();

	const renderer = new THREE.WebGPURenderer( {
		antialias: true,
		powerPreference: 'high-performance',
	} );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
	renderer.setSize( Math.max( 2, window.innerWidth ), Math.max( 2, window.innerHeight ) );
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.18;
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	await renderer.init();
	app.append( renderer.domElement );
	renderer.domElement.tabIndex = 0;
	renderer.domElement.setAttribute( 'aria-label', 'Monde 3D du laboratoire physique' );

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x17271f );
	scene.fog = new THREE.FogExp2( 0x17271f, 0.018 );
	const camera = new THREE.PerspectiveCamera(
		52,
		Math.max( 2, window.innerWidth ) / Math.max( 2, window.innerHeight ),
		0.04,
		90,
	);
	configureLights( scene );

	const physics = await createPhysicsWorld( {
		gravity: { x: 0, y: -9.81, z: 0 },
		fixedDt: 1 / 120,
		maxSubsteps: 4,
		metricsWindow: 192,
	} );
	physics.surfaceByCollider = new Map();
	const environment = createLabEnvironment( { scene, physics } );
	const ragdoll = await createHybridChameleon( { scene, physics } );
	const input = new LabInputController( window );
	const explorer = new AutonomousExplorer();
	const platformerControl = new PlatformerControlModel( {
		moveSpeed: ragdoll.settings.moveSpeed,
		sprintMultiplier: ragdoll.settings.sprintMultiplier,
	} );
	const platformerJump = new PlatformerJumpModel( { airAcceleration: 0 } );
	const rigDebugView = createRigDebugView( {
		scene,
		root: ragdoll.model,
		visible: false,
	} );
	const cameraRig = new ThirdPersonCamera( {
		camera,
		domElement: renderer.domElement,
		physics,
		targetProvider: () => {

			const position = ragdoll.pelvis.body.translation();
			return new THREE.Vector3( position.x, position.y, position.z );

		},
	} );
	cameraRig.snap();

	const state = {
		autonomous: false,
		fullRagdoll: false,
		debug: false,
		shadows: true,
		gravity: 9.81,
		rigDebug: false,
		jumpPhase: platformerJump.phase,
	};
	let grabbedBone = null;
	const grab = new GrabController( {
		camera,
		domElement: renderer.domElement,
		physics,
		onGrabChange: ( active, userData ) => {

			grabbedBone = active ? userData?.boneName ?? null : null;
			ragdoll.setDragging( active );

		},
	} );
	const reset = () => {

		grab.cancel();
		ragdoll.reset();
		explorer.resetProgress();
		platformerControl.reset( undefined, ragdoll.supportNormal );
		platformerJump.reset( true, ragdoll.supportNormal );
		ragdoll.setLandingCompression( 0 );
		input.consumeJumpState();
		state.jumpPhase = platformerJump.phase;
		cameraRig.snap();

	};
	const ui = createLabUI( {
		ragdoll,
		physics,
		state,
		renderer,
		onReset: reset,
		rigDebugView,
	} );
	loading.done();

	const move = new THREE.Vector3();
	const cameraForward = new THREE.Vector3();
	const creaturePosition = new THREE.Vector3();
	const worldUp = Object.freeze( { x: 0, y: 1, z: 0 } );
	const cameraForwardRecord = { x: 0, y: 0, z: -1 };
	const velocityRecord = { x: 0, y: 0, z: 0 };
	const appliedForce = { x: 0, y: 0, z: 0 };
	const jumpInput = { jumpPressed: false, jumpHeld: false, jumpReleased: false };
	const zeroAxes = Object.freeze( { x: 0, y: 0 } );
	let previousTime = performance.now();
	let disposed = false;

	function onResize() {

		const width = Math.max( 2, window.innerWidth );
		const height = Math.max( 2, window.innerHeight );
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
		renderer.setSize( width, height );

	}
	window.addEventListener( 'resize', onResize );

	renderer.setAnimationLoop( ( now ) => {

		if ( disposed ) return;
		const dt = Math.min( 0.05, Math.max( 0, ( now - previousTime ) / 1000 ) );
		previousTime = now;

		if ( input.consume( 'toggleAutoQueued' ) ) {

			state.autonomous = ! state.autonomous;
			if ( state.autonomous ) explorer.resetProgress();

		}
		if ( input.consume( 'toggleRagdollQueued' ) ) state.fullRagdoll = ! state.fullRagdoll;
		if ( input.consume( 'toggleDebugQueued' ) ) {

			state.debug = ! state.debug;
			ragdoll.setDebugVisible( state.debug );

		}
		if ( input.consume( 'resetQueued' ) ) reset();
		const pelvisTranslation = ragdoll.pelvis.body.translation();
		creaturePosition.set( pelvisTranslation.x, pelvisTranslation.y, pelvisTranslation.z );
		cameraRig.getForward( cameraForward );
		cameraForwardRecord.x = cameraForward.x;
		cameraForwardRecord.y = cameraForward.y;
		cameraForwardRecord.z = cameraForward.z;

		const result = physics.step(
			dt,
			( fixedDt ) => {

				const rootBody = ragdoll.pelvis.body;
				const velocity = rootBody.linvel();
				velocityRecord.x = velocity.x;
				velocityRecord.y = velocity.y;
				velocityRecord.z = velocity.z;
				const supported = ragdoll.contactCount >= 2
					&& ! state.fullRagdoll && ! grabbedBone;
				platformerControl.moveSpeed = ragdoll.settings.moveSpeed;
				platformerControl.sprintMultiplier = ragdoll.settings.sprintMultiplier;
				platformerControl.airAcceleration = 3.2 * state.airControl;
				const platformerControlView = platformerControl.update( fixedDt, {
					axes: state.autonomous || grabbedBone ? zeroAxes : input.axes,
					cameraForward: cameraForwardRecord,
					worldUp,
					supportNormal: ragdoll.supportNormal,
					velocity: velocityRecord,
					supported,
					sprint: input.sprint,
				} );
				if ( state.autonomous ) {

					const position = ragdoll.pelvis.body.translation();
					creaturePosition.set( position.x, position.y, position.z );
					explorer.update( fixedDt, ragdoll.supportNormal, creaturePosition, move );

				} else {

					move.set(
						platformerControlView.direction.x,
						platformerControlView.direction.y,
						platformerControlView.direction.z,
					);

				}
				if ( grabbedBone ) move.set( 0, 0, 0 );

				platformerJump.jumpHeight = state.jumpHeight;
				platformerJump.coyoteTime = state.coyoteTime;
				platformerJump.bufferTime = state.jumpBufferTime;
				platformerJump.fallGravityScale = state.fallGravityScale;
				platformerJump.cutGravityScale = state.jumpCutGravityScale;
				input.consumeJumpState( jumpInput );
				const platformerJumpView = platformerJump.update( fixedDt, {
					supported,
					supportNormal: ragdoll.supportNormal,
					worldUp,
					velocity: velocityRecord,
					gravity: physics.world.gravity,
					mass: rootBody.mass(),
					jumpPressed: jumpInput.jumpPressed && ! grabbedBone && ! state.fullRagdoll,
					jumpHeld: jumpInput.jumpHeld && ! grabbedBone && ! state.fullRagdoll,
					jumpReleased: jumpInput.jumpReleased,
					desiredDirection: move,
				} );
				state.jumpPhase = platformerJumpView.phase;
				ragdoll.setLandingCompression( platformerJumpView.landingCompression );
				ragdoll.setCommand( {
					move,
					sprint: input.sprint,
					release: platformerJumpView.releaseSupport,
					fullRagdoll: state.fullRagdoll,
				} );
				ragdoll.beforeStep( fixedDt );
				if ( ! grabbedBone && ! state.fullRagdoll ) {

					if ( platformerJumpView.jumped )
						rootBody.applyImpulse( platformerJumpView.impulse, true );
					const mass = Math.max( 0.1, rootBody.mass() );
					const airControl = ! supported && ! state.autonomous ? 1 : 0;
					appliedForce.x = mass * (
						platformerJumpView.additionalGravity.x
						+ platformerControlView.acceleration.x * airControl
					);
					appliedForce.y = mass * (
						platformerJumpView.additionalGravity.y
						+ platformerControlView.acceleration.y * airControl
					);
					appliedForce.z = mass * (
						platformerJumpView.additionalGravity.z
						+ platformerControlView.acceleration.z * airControl
					);
					if ( appliedForce.x * appliedForce.x + appliedForce.y * appliedForce.y
						+ appliedForce.z * appliedForce.z > 1e-12 )
						rootBody.addForce( appliedForce, true );

				}
				grab.beforeStep( fixedDt );

			},
			() => ragdoll.afterStep(),
		);
		ragdoll.syncVisual( result.alpha, dt );
		cameraRig.update( dt );
		ui.update( dt );
		renderer.render( scene, camera );

	} );

	function dispose() {

		if ( disposed ) return;
		disposed = true;
		renderer.setAnimationLoop( null );
		window.removeEventListener( 'resize', onResize );
		input.dispose();
		grab.dispose();
		cameraRig.dispose();
		ui.dispose();
		rigDebugView.dispose();
		ragdoll.dispose();
		environment.dispose();
		physics.dispose();
		renderer.dispose();

	}
	window.addEventListener( 'beforeunload', dispose, { once: true } );

	window.__chameleonLab = {
		THREE,
		renderer,
		scene,
		camera,
		physics,
		ragdoll,
		environment,
		input,
		cameraRig,
		platformerControl,
		platformerJump,
		rigDebugView,
		grab,
		state,
		reset,
		get grabbedBone() {

			return grabbedBone;

		},
	};

}

main().catch( showFatalError );
