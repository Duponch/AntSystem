// AntSystem — simulation de fourmilière en Three.js / WebGPU.
// Inspiré de « J'ai simulé 869 fourmis pour mieux les comprendre »
// (Sebastian Lague / Pezzza's Work pour les modèles de référence).

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { params, gfx } from './config.js';
import { AntSimulation } from './simulation.js';
import { createAnts } from './ants.js';
import { createEnvironment, uShowWalls, uTrailGamma } from './environment.js';
import { createSky } from './graphics/sky.js';
import { createGrass } from './graphics/grass.js';
import { createProps } from './graphics/props.js';
import { createGodrays } from './graphics/godrays.js';
import { createCinematic } from './graphics/cinematic.js';
import { createFoodBalls } from './graphics/foodballs.js';
import { createDebugCones } from './graphics/debugcones.js';
import { createBench } from './bench.js';
import { createEditor } from './editor.js';
import { createUI } from './ui.js';

async function main() {

	if ( navigator.gpu === undefined ) {

		showError();
		return;

	}

	// --- renderer ---
	const renderer = new THREE.WebGPURenderer( { antialias: true } );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
	// jamais 0×0 (fenêtre cachée/minimisée) : une swapchain vide invalide tout
	renderer.setSize( Math.max( 2, window.innerWidth ), Math.max( 2, window.innerHeight ) );
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.35;
	renderer.shadowMap.enabled = params.shadows;

	try {

		await renderer.init();

	} catch ( err ) {

		console.error( err );
		showError();
		return;

	}

	renderer.onDeviceLost = ( info ) => {

		console.error( info );
		showError(
			'Contexte GPU perdu 😕',
			'Le périphérique graphique a été réinitialisé.<br>Rechargez la page pour relancer la simulation.',
		);

	};

	document.getElementById( 'app' ).appendChild( renderer.domElement );

	// --- scène / caméra ---
	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(
		55, window.innerWidth / window.innerHeight, 0.1, 2600,
	);
	camera.position.set( 0, 42, 68 );

	const controls = new OrbitControls( camera, renderer.domElement );
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.target.set( 0, 0, 0 );
	controls.maxPolarAngle = Math.PI / 2 - 0.05;
	controls.minDistance = 6;
	controls.maxDistance = 280;

	// --- simulation + monde ---
	const sim = new AntSimulation( renderer );
	const sky = createSky( scene );

	// décor édité sauvegardé (sinon génération procédurale)
	let decorDoc = null;

	try {

		decorDoc = JSON.parse( localStorage.getItem( 'antsystem-decor-v1' ) ) || null;

	} catch { /* document illisible : on repart du procédural */ }

	// sol/fourmilière + décor + fourmis en parallèle (chargements de fichiers)
	const [ env, props, ants ] = await Promise.all( [
		createEnvironment( scene, sim ),
		createProps( scene, decorDoc ),
		createAnts( sim ),
	] );
	const grass = createGrass( scene, sim );
	const foodballs = createFoodBalls( scene, sim );
	scene.add( ants.group );

	// murs ajustés à la main : prioritaires sur les empreintes automatiques
	sim.setSavedWalls( localStorage.getItem( 'antsystem-walls-v1' ) );
	await sim.init();
	await sim.setObstacles( props.wallStamps );

	const godrays = createGodrays( renderer, scene, camera, sky );
	const cinematic = createCinematic( { camera, controls, sim, renderer } );
	const bench = createBench( { sim } );
	const cones = createDebugCones( scene, sim );
	const editor = createEditor( { scene, camera, renderer, controls, props, sim, ground: env.ground } );

	// --- musique d'ambiance (l'autoplay attend le premier geste utilisateur) ---
	const musicEl = new Audio( '/music.ogg' );
	musicEl.loop = true;
	musicEl.volume = gfx.musicVolume;

	const music = {
		set( on ) {

			if ( on ) musicEl.play().catch( () => { /* déclenché au prochain geste */ } );
			else musicEl.pause();

		},
		setVolume( v ) {

			musicEl.volume = v;

		},
	};

	if ( gfx.music ) {

		const once = () => {

			if ( gfx.music ) musicEl.play().catch( () => {} );
			window.removeEventListener( 'pointerdown', once );

		};

		window.addEventListener( 'pointerdown', once );
		musicEl.play().catch( () => {} );

	}

	// --- interface ---
	const ui = createUI( {
		scene, sim, ants, env, sky, grass, props, foodballs, cones, editor,
		godrays, cinematic, bench, music, controls, camera, renderer,
		onReset: async () => {

			await sim.reset();

			// réécrit les marqueurs (nid, nourriture semée) dans la texture affichée,
			// indispensable quand la simulation est en pause
			sim.refreshDisplay();
			sim.updateFieldNodes();

		},
	} );

	// --- boucle ---
	const timer = new THREE.Timer();
	let frame = 0;
	let fpsAccum = 0;
	let fpsCount = 0;
	let fps = 0;

	renderer.setAnimationLoop( () => {

		timer.update();
		const rawDt = Math.min( timer.getDelta(), 1 / 30 );
		fpsAccum += rawDt;
		fpsCount ++;

		const painted = sim.drainBrush();
		const running = ! params.paused && params.simSpeed > 0;
		const simDt = running ? rawDt * params.simSpeed : 0;

		if ( running ) {

			sim.step( simDt );
			sim.updateFieldNodes();

		} else if ( painted || ui.consumePaintFlag() ) {

			// peinture pendant la pause : on rafraîchit l'affichage sans simuler
			sim.refreshDisplay();
			sim.updateFieldNodes();

		}

		ants.tick( simDt, camera );
		sky.update( camera );
		grass.update( camera, rawDt );
		cinematic.update( rawDt );

		// OrbitControls.update() repositionne la caméra même désactivé :
		// on le saute pendant les plans cinématiques
		if ( ! params.cinematic ) controls.update();

		// early-out réel : sans godrays, aucun post-processing n'est payé
		if ( gfx.godrays ) godrays.render();
		else renderer.render( scene, camera );

		frame ++;

		if ( frame % 30 === 0 ) {

			fps = Math.round( fpsCount / fpsAccum );
			fpsAccum = 0;
			fpsCount = 0;
			sim.readStats().then( ( stats ) => ui.updateOverlay( stats, fps ) );

		}

	} );

	// accès console pour le débogage
	window.__antsys = { renderer, scene, camera, controls, sim, params, gfx, ants, sky, grass, props, foodballs, godrays, cinematic, bench, cones, editor, envu: { uShowWalls, uTrailGamma } };

	// banc d'essai automatique : ?bench=5x90
	const benchMatch = location.search.match( /bench=(\d+)x(\d+)/ );

	if ( benchMatch ) {

		setTimeout( () => bench.run( { runs: + benchMatch[ 1 ], seconds: + benchMatch[ 2 ] } ), 800 );

	}

	window.addEventListener( 'resize', () => {

		const w = Math.max( 2, window.innerWidth );
		const h = Math.max( 2, window.innerHeight );
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
		renderer.setSize( w, h );

	} );

}

function showError(
	title = 'WebGPU indisponible 😕',
	body = 'Cette simulation nécessite un navigateur avec WebGPU :<br>Chrome / Edge 113+, Firefox 141+ ou Safari 26+.',
) {

	const el = document.getElementById( 'webgpu-error' );
	el.style.display = 'flex';
	el.innerHTML = `<div><h2>${title}</h2><p>${body}</p></div>`;

}

main().catch( ( err ) => {

	console.error( err );
	showError(
		'Erreur au démarrage 😕',
		'Un fichier requis n\'a pas pu être chargé ou l\'initialisation a échoué.<br>Voir la console pour les détails.',
	);

} );
