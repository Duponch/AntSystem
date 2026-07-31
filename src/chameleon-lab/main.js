import * as THREE from 'three/webgpu';

import './lab.css';
import { createPhysicsWorld } from './physics-world.js';
import { createLabEnvironment } from './environment.js';
import { createActiveRagdoll } from './active-ragdoll.js';
import {
	AutonomousExplorer,
	cameraRelativeMovement,
	LabInputController,
	ThirdPersonCamera,
} from './third-person-controller.js';
import { GrabController } from './grab-controller.js';
import { createLabUI } from './lab-ui.js';

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
	const ragdoll = await createActiveRagdoll( { scene, physics } );
	const input = new LabInputController( window );
	const explorer = new AutonomousExplorer();
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
		cameraRig.snap();

	};
	const ui = createLabUI( { ragdoll, physics, state, renderer, onReset: reset } );
	loading.done();

	const move = new THREE.Vector3();
	const cameraForward = new THREE.Vector3();
	const creaturePosition = new THREE.Vector3();
	let previousTime = performance.now();
	let releaseSeconds = 0;
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

		if ( input.consume( 'toggleAutoQueued' ) ) state.autonomous = ! state.autonomous;
		if ( input.consume( 'toggleRagdollQueued' ) ) state.fullRagdoll = ! state.fullRagdoll;
		if ( input.consume( 'toggleDebugQueued' ) ) {

			state.debug = ! state.debug;
			ragdoll.setDebugVisible( state.debug );

		}
		if ( input.consume( 'resetQueued' ) ) reset();
		if ( input.consume( 'jumpQueued' ) ) {

			releaseSeconds = 0.18;
			const normal = ragdoll.supportNormal.clone().addScaledVector( new THREE.Vector3( 0, 1, 0 ), 0.35 ).normalize();
			ragdoll.pelvis.body.applyImpulse(
				{ x: normal.x * 0.42, y: normal.y * 0.42, z: normal.z * 0.42 },
				true,
			);

		}

		const pelvisTranslation = ragdoll.pelvis.body.translation();
		creaturePosition.set( pelvisTranslation.x, pelvisTranslation.y, pelvisTranslation.z );
		if ( state.autonomous ) {

			explorer.update( dt, ragdoll.supportNormal, creaturePosition, move );

		} else {

			cameraRig.getForward( cameraForward );
			cameraRelativeMovement( input.axes, cameraForward, ragdoll.supportNormal, move );

		}
		if ( grabbedBone ) move.set( 0, 0, 0 );
		ragdoll.setCommand( {
			move,
			sprint: input.sprint,
			release: releaseSeconds > 0,
			fullRagdoll: state.fullRagdoll,
		} );

		const result = physics.step(
			dt,
			( fixedDt ) => {

				releaseSeconds = Math.max( 0, releaseSeconds - fixedDt );
				ragdoll.beforeStep( fixedDt );
				grab.beforeStep( fixedDt );

			},
			() => ragdoll.afterStep(),
		);
		ragdoll.syncVisual( result.alpha );
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
		grab,
		state,
		reset,
		get grabbedBone() {

			return grabbedBone;

		},
	};

}

main().catch( showFatalError );
