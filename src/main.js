// AntSystem — simulation de fourmilière en Three.js / WebGPU.
// Inspiré de « J'ai simulé 869 fourmis pour mieux les comprendre »
// (Sebastian Lague / Pezzza's Work pour les modèles de référence).

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { params, gfx, MAX_ANTS } from './config.js';
import { AntSimulation } from './simulation.js';
import { createAnts } from './ants.js';
import { buildNestLayoutAsync, createColony } from './colony.js';
import { createUnderground } from './underground.js';
import { createNestVolume } from './nestvolume.js';
import { createEnvironment, uShowWalls, uTrailGamma } from './environment.js';
import { createSky } from './graphics/sky.js';
import { createGrass } from './graphics/grass.js';
import { createProps } from './graphics/props.js';
import { createGodrays } from './graphics/godrays.js';
import { createCinematic } from './graphics/cinematic.js';
import { createFoodBalls } from './graphics/foodballs.js';
import { createDebugCones } from './graphics/debugcones.js';
import { createBench } from './bench.js';
import { createColonyTests } from './tests.js';
import { createWarden } from './warden.js';
import { createEditor } from './editor.js';
import { createSpiders } from './spiders.js';
import { loadButterflyAsset, loadPollinatorAssets } from './pollinator-assets.js';
import { createPollinators } from './pollinators.js';
import { createRagdoll } from './ragdoll.js';
import { createAntFollow } from './antfollow.js';
import { createSimulationGuide } from './guide.js';
import { createUI } from './ui.js';
import { tryAcquireReadback, releaseReadback } from './readback.js';

import { SimulationClock } from './simulation-clock.js';
import {
	MAX_SIMULATION_STEPS_PER_FRAME,
	MAX_GPU_STEP_DT,
	planGpuSimulationFrame,
	SIMULATION_HZ,
	authorityDueAt,
	computeNextAuthorityTick,
} from './simulation-authority.js';

const FLUID_RAGDOLL_STEP = 1 / 60;

async function main() {

	if ( navigator.gpu === undefined ) {

		showError();
		return;

	}

	// --- renderer ---
	// le noyau fourmis lit/écrit >8 storage buffers (limite WebGPU par défaut) :
	// on demande le maximum de l'adaptateur (souvent 16), borné pour ne jamais
	// dépasser ce qu'il supporte — sinon requestDevice échouerait.
	let requiredLimits;

	try {

		const adapter = await navigator.gpu.requestAdapter();
		const maxSB = adapter && adapter.limits ? adapter.limits.maxStorageBuffersPerShaderStage : 8;
		requiredLimits = { maxStorageBuffersPerShaderStage: Math.min( 16, maxSB || 8 ) };

	} catch { /* adaptateur indisponible : on laisse les limites par défaut */ }

	// trackTimestamp : chronos GPU réels par passe (three demande automatiquement
	// la feature « timestamp-query » quand l'adaptateur la propose). Coûte
	// quelques écritures de compteur par passe : réservé au mode profilage,
	// activable par `?perf=1` ou par le panneau (rechargement requis).
	const renderer = new THREE.WebGPURenderer( { antialias: true, requiredLimits, trackTimestamp: gfx.perfHud } );
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

	// Ce que le device a RÉELLEMENT accordé — l'adaptateur interrogé plus haut
	// n'est pas celui que three utilise (il en redemande un avec
	// featureLevel:'compatibility'), les deux peuvent diverger. Le noyau fourmis
	// lie 13 storage buffers : sous 13 accordés, il ne s'exécuterait tout
	// simplement pas, silencieusement.
	{

		const dev = renderer.backend.device;
		const lim = dev && dev.limits;
		console.info(
			`AntSystem GPU : storageBuffers/stage = ${lim ? lim.maxStorageBuffersPerShaderStage : '?'}`
			+ ` · invocations/workgroup = ${lim ? lim.maxComputeInvocationsPerWorkgroup : '?'}`
			+ ` · compatibilityMode = ${renderer.backend.compatibilityMode}`
			+ ` · timestamps = ${renderer.backend.trackTimestamp === true}`
			+ ` · physique = ${params.physics ? 'ON' : 'OFF'}`,
		);
		if ( lim && lim.maxStorageBuffersPerShaderStage < 13 ) {

			console.error(
				`AntSystem : seulement ${lim.maxStorageBuffersPerShaderStage} storage buffers par étage `
				+ '— le noyau fourmis en demande 13, il ne tournera PAS.',
			);

		}

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
	// topologie de la fourmilière souterraine : UNE source de vérité partagée
	// par le kernel (creusage, navigation), le rendu des fourmis (profondeur)
	// et la vue en fosse
	const loadingOverlay = document.getElementById( 'overlay' );
	const loadingMessage = 'Pr\u00e9paration des galeries et surfaces de marche\u2026';
	loadingOverlay.textContent = loadingMessage;
	let layout;
	try {

		layout = await buildNestLayoutAsync();
		const bake = layout.navigation.surfaceBake;
		if ( bake ) console.info(
			`Bake des surfaces : ${ bake.mode } \u00b7 ${ bake.workerCount } worker(s) \u00b7 ${ bake.durationMs.toFixed( 1 ) } ms`,
		);

	} finally {

		if ( loadingOverlay.textContent === loadingMessage ) loadingOverlay.textContent = '';

	}
	const sim = new AntSimulation( renderer, layout );
	const sky = createSky( scene );

	// décor édité sauvegardé (sinon génération procédurale)
	let decorDoc = null;

	try {

		decorDoc = JSON.parse( localStorage.getItem( 'antsystem-decor-v1' ) ) || null;

	} catch { /* document illisible : on repart du procédural */ }

	// sol/fourmilière + décor + fourmis en parallèle (chargements de fichiers)
	const [ env, props, ants, pollinatorAssets, butterflyVat ] = await Promise.all( [
		createEnvironment( scene, sim ),
		createProps( scene, decorDoc ),
		createAnts( sim ),
		gfx.pollinators ? loadPollinatorAssets() : Promise.resolve( null ),
		gfx.pollinators && gfx.butterflies ? loadButterflyAsset() : Promise.resolve( null ),
	] );
	const grass = createGrass( scene, sim );
	const foodballs = createFoodBalls( scene, sim );
	scene.add( ants.group );

	// murs ajustés à la main : prioritaires sur les empreintes automatiques
	sim.setSavedWalls( localStorage.getItem( 'antsystem-walls-v1' ) );
	await sim.init();
	await sim.setObstacles( props.wallStamps );

	const bees = createPollinators( { scene, props, assets: pollinatorAssets, butterflyVat } );
	await bees.preload();
	const spiders = await createSpiders( { scene, sim, renderer, props } );
	spiders.setExternalAuthorityScheduling( params.timingMode === 'strict' );

	// ragdoll GPU : pool borné, dispatch indirect (voir ragdoll.js)
	const ragdoll = createRagdoll( { sim, vat: ants.vat, pose: ants.pose, renderer, camera } );
	scene.add( ragdoll.mesh );

	// couvain + mangeoires (kernel dédié) et vue en fosse de la fourmilière
	const colony = createColony( { scene, sim, renderer, layout } );
	// champ de distance 3D du nid (rendu souterrain) : bake une fois ici, puis a
	// chaque fois que le nid change de forme
	const nestVolume = createNestVolume( { renderer, layout } );
	nestVolume.rebuild();
	const underground = await createUnderground( { scene, layout, camera, volume: nestVolume } );

	// suivi de fourmi au clic (outil de débogage des déplacements — antfollow.js)
	const antfollow = createAntFollow( { sim, pose: ants.pose, renderer, camera, controls } );
	// Manuel fonctionnel indépendant des réglages lil-gui. Il consomme les
	// mêmes fichiers Markdown que doc/guide et contextualise la sélection.
	const guide = createSimulationGuide( { antfollow, mount: document.getElementById( 'app' ) } );

	// Le socle de terre doit ENGLOBER le nid : sans ca la chambre royale flotte
	// sous le terrain (le bug existait deja avec une chambre a -3,9 pour un
	// socle de 3 unites — il devient spectaculaire a 60).
	if ( params.colony ) {

		gfx.groundThickness = Math.max( gfx.groundThickness, layout.depthMax + 4 );
		env.setThickness( gfx.groundThickness );
		// la camera doit pouvoir descendre sous l'horizon pour voir la coupe
		controls.maxPolarAngle = Math.PI * 0.94;
		controls.maxDistance = Math.max( controls.maxDistance, layout.depthMax * 3 );

	}
	// Le couvain et la reine ne coûtent aucun draw depuis la surface.
	colony.setVisible( false );
	ants.queen.visible = false;

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

	function nextAuthorityAfter( tick ) {

		return computeNextAuthorityTick( tick, {
			spiderCount: params.spiderCount,
			colony: params.colony,
		} );

	}
	const simulationClock = new SimulationClock( {
		fixedStep: 1 / SIMULATION_HZ,
		maxStepsPerAdvance: MAX_SIMULATION_STEPS_PER_FRAME,
	} );
	let nextAuthorityTick = nextAuthorityAfter( 0n );
	let authorityPending = null;
	let authorityFault = null;
	let authorityEpoch = 0;
	let latestAuthorityStats = null;
	let resetPromise = null;
	let authoritativeMutationTail = Promise.resolve();
	let relaxedColonyStats = null;
	let relaxedColonyPromise = null;
	let activeTimingMode = params.timingMode;
	let fluidSimulationTime = 0;
	let fluidRagdollAccum = 0;

	function enqueueAuthoritativeMutation( mutation ) {

		++ authorityEpoch;
		const predecessor = authoritativeMutationTail.catch( () => {} );
		const operation = predecessor.then( async () => {

			if ( authorityPending ) await authorityPending.catch( () => {} );
			if ( relaxedColonyPromise ) await relaxedColonyPromise.catch( () => {} );
			const changed = await mutation();
			if ( ! changed ) return false;
			simulationClock.reset();
			fluidSimulationTime = 0;
			fluidRagdollAccum = 0;
			nextAuthorityTick = nextAuthorityAfter( 0n );
			authorityFault = null;
			latestAuthorityStats = null;
			ants.refreshPose();
			sim.refreshDisplay();
			sim.updateFieldNodes();
			return true;

		} );
		const guarded = operation.catch( ( error ) => {

			authorityFault = error;
			params.paused = true;
			throw error;

		} );
		const tracked = guarded.finally( () => {

			if ( resetPromise === tracked ) resetPromise = null;

		} );
		authoritativeMutationTail = tracked.catch( () => {} );
		resetPromise = tracked;
		return tracked;

	}

	function resetAuthoritativeSimulation() {

		return enqueueAuthoritativeMutation( async () => {

			await sim.reset();
			spiders.reset();
			await bees.reset();
			await colony.reset();
			return true;

		} );

	}

	function setColonyEnabledAuthoritatively( enabled ) {

		return enqueueAuthoritativeMutation( async () => {

			const migrated = await sim.setColonyEnabled( enabled );
			if ( ! migrated ) return false;
			spiders.reset();
			await colony.reset();
			return true;

		} );

	}
	// --- interface ---
	const ui = createUI( {
		scene, sim, ants, env, sky, grass, props, foodballs, cones, editor, bees,
		godrays, cinematic, bench, music, spiders, colony, controls, camera, renderer, nestVolume,
		onReset: resetAuthoritativeSimulation,
		onSetColonyEnabled: setColonyEnabledAuthoritatively,
	} );

	// éclosions → activation de nouvelles fourmis : nées au couvain (sous
	// terre), elles remontent d'elles-mêmes. L'ordre compte : on initialise
	// les slots AVANT de monter antCount (l'inverse rendrait une frame de
	// fourmis à l'état périmé).
	const colonyHooks = {
		async activateAnts( n ) {

			const from = params.antCount;
			const target = Math.min( MAX_ANTS, from + n );
			if ( target <= from ) return 0;
			sim.spawnHatched( from );
			await ui.setPopulationFromSimulation( target );
			return target - from;

		},
	};

	function scheduleRelaxedColonyReconciliation( stats ) {

		if ( ! params.colony ) return;
		relaxedColonyStats = stats;
		if ( relaxedColonyPromise ) return;
		const task = ( async () => {

			while ( relaxedColonyStats ) {

				const latest = relaxedColonyStats;
				relaxedColonyStats = null;
				await colony.onStats( latest, colonyHooks );

			}

		} )();
		const tracked = task.catch( ( error ) => {

			console.error( 'Reconciliation souple de la colonie interrompue.', error );

		} ).finally( () => {

			if ( relaxedColonyPromise === tracked ) relaxedColonyPromise = null;
			if ( relaxedColonyStats ) scheduleRelaxedColonyReconciliation( relaxedColonyStats );

		} );
		relaxedColonyPromise = tracked;

	}

	function beginAuthorityReconciliation( boundaryTick ) {

		if ( authorityPending || authorityFault || resetPromise ) return;
		const due = authorityDueAt( boundaryTick, {
			spiderCount: params.spiderCount,
			colony: params.colony,
		} );
		const spiderAntDue = due.spiderAnt;
		const spiderDamageDue = due.spiderDamage;
		const colonyDue = due.colony;
		if ( ! spiderAntDue && ! spiderDamageDue && ! colonyDue ) {

			nextAuthorityTick = nextAuthorityAfter( boundaryTick );
			return;

		}
		const epoch = authorityEpoch;
		const transaction = ( async () => {

			await spiders.syncAuthoritative( {
				ants: spiderAntDue,
				damage: spiderDamageDue,
			} );
			if ( epoch !== authorityEpoch ) return;
			if ( colonyDue ) {

				const stats = await sim.readStatsAuthoritative();
				if ( epoch !== authorityEpoch ) return;
				await colony.reconcileStatsAtTick( stats, boundaryTick, colonyHooks );
				if ( epoch !== authorityEpoch ) return;
				latestAuthorityStats = stats;

			}
			nextAuthorityTick = nextAuthorityAfter( boundaryTick );

		} )().catch( ( error ) => {

			if ( epoch !== authorityEpoch ) return;
			authorityFault = error;
			params.paused = true;
			console.error( 'Barriere autoritaire de simulation interrompue.', error );

		} );
		const pending = transaction.finally( () => {

			if ( authorityPending === pending ) authorityPending = null;

		} );
		authorityPending = pending;

	}

	// --- SÉLECTION D'UNE FOURMI AU CLIC (suivi caméra — antfollow.js) ---
	// Un « clic » = bouton gauche, <6 px de déplacement, <500 ms : on ne vole
	// jamais un drag d'orbite. Le pinceau, l'éditeur et le mode cinématique
	// gardent leurs clics ; Échap lâche la fourmi suivie.
	{

		const dom = renderer.domElement;
		let downX = 0, downY = 0, downT = 0;

		dom.addEventListener( 'pointerdown', ( e ) => {

			if ( e.button !== 0 ) return;
			downX = e.clientX; downY = e.clientY; downT = performance.now();

		} );

		dom.addEventListener( 'pointerup', ( e ) => {

			if ( e.button !== 0 ) return;
			if ( params.brushMode || editor.enabled || params.cinematic ) return;
			const moved = Math.hypot( e.clientX - downX, e.clientY - downY );
			if ( moved > 6 || performance.now() - downT > 500 ) return;

			const rect = dom.getBoundingClientRect();
			const nx = ( ( e.clientX - rect.left ) / rect.width ) * 2 - 1;
			const ny = - ( ( e.clientY - rect.top ) / rect.height ) * 2 + 1;
			const ro = camera.position.clone();
			const rd = new THREE.Vector3( nx, ny, 0.5 ).unproject( camera ).sub( ro ).normalize();
			antfollow.requestPick( ro, rd );

		} );

		window.addEventListener( 'keydown', ( e ) => {

			if ( e.key === 'Escape' ) antfollow.clear();

		} );

	}

	// --- boucle ---
	const timer = new THREE.Timer();
	let fpsAccum = 0;
	let fpsCount = 0;
	let fps = 0;
	let simulationWallAccum = 0;
	let simulationEffectiveAccum = 0;
	let simulationDroppedAccum = 0;
	let simulationBudgetLimited = false;
	let overlayAccum = 0;
	// Décalé de 125 ms pour ne pas mapper les timestamps et les stats ensemble.
	let timestampAccum = - 0.125;
	let lastClockSnapshot = {
		mode: params.timingMode,
		requestedMultiplier: 0,
		effectiveMultiplier: 0,
		backlog: 0,
		dropped: 0,
		budgetLimited: false,
		tick: 0,
	};
	let wasDived = false;      // mémoire de la bascule surface/sous-sol
	let wasScanOn = false;     // mémoire de la bascule du scanner (passe émissive)
	const perf = { compute: 0, render: 0, computeCalls: 0 };

	// Chronos GPU résolus toutes les 0,5 s, en décalage des stats. Le verrou
	// global interdit deux mappings concurrents sans bloquer la simulation.
	async function resolveTimings() {

		if ( renderer.backend.trackTimestamp !== true ) return;

		try {

			await renderer.resolveTimestampsAsync( THREE.TimestampQuery.COMPUTE );
			await renderer.resolveTimestampsAsync( THREE.TimestampQuery.RENDER );
			perf.compute = renderer.info.compute.timestamp;
			perf.render = renderer.info.render.timestamp;

		} catch { /* pool pas encore prêt */ }

	}

	renderer.setAnimationLoop( () => {

		timer.update();
		const wallDt = Math.max( 0, timer.getDelta() );
		const rawDt = Math.min( wallDt, MAX_GPU_STEP_DT );
		fpsAccum += wallDt;
		fpsCount ++;
		overlayAccum += wallDt;
		timestampAccum += wallDt;

		const painted = sim.drainBrush();
		const paintFlag = ui.consumePaintFlag();
		const running = ! params.paused && params.simSpeed > 0;

		const strictTiming = params.timingMode === 'strict';

		if ( params.timingMode !== activeTimingMode ) {

			activeTimingMode = params.timingMode;
			spiders.setExternalAuthorityScheduling( strictTiming );
			// Une dette du mode strict ne doit jamais ressurgir dans le mode fluide.
			simulationClock.discardBacklog();
			nextAuthorityTick = nextAuthorityAfter( simulationClock.tickExact );
			simulationWallAccum = 0;
			simulationEffectiveAccum = 0;
			simulationDroppedAccum = 0;
			simulationBudgetLimited = false;
			fluidRagdollAccum = 0;
			if ( strictTiming ) {

				// Strict replay always starts from a clean transactional state.
				if ( ! resetPromise ) void resetAuthoritativeSimulation().catch( ( error ) => {

					console.error( 'Strict timing reset failed.', error );

				} );

			} else {

				fluidSimulationTime = simulationClock.time;

			}

		}

		const requestedSpeed = running && ! resetPromise && ! authorityFault
			? params.simSpeed
			: 0;
		let logicalSteps = 0;
		let frameEffective = 0;
		let frameDropped = 0;
		let frameBudgetLimited = false;

		if ( params.timingMode === 'fluid' ) {

			// Fast path GPU : aucune lecture GPU→CPU ne bloque l'avancement. À ×1,
			// une seule passe fraîche est calculée par image ; au-delà, le budget
			// borné évite toute spirale de rattrapage.
			const fluidBlocked = !! authorityPending || !! authorityFault || !! resetPromise;
			const fluidPlan = planGpuSimulationFrame( {
				wallDt,
				speed: fluidBlocked ? 0 : requestedSpeed,
				maxSubsteps: params.maxGpuSubsteps,
				maxStepDt: MAX_GPU_STEP_DT,
			} );

			for ( let step = 0; step < fluidPlan.stepCount; step ++ ) {

				const dt = fluidPlan.stepDt;
				sim.step( dt );
				colony.stepSimulation( dt );
				spiders.stepSimulation( dt );
				bees.stepSimulation( dt );

			}

			if ( fluidPlan.consumedDt > 0 ) ants.stepSimulation( fluidPlan.consumedDt, true );
			logicalSteps = fluidPlan.stepCount;
			frameEffective = fluidPlan.consumedDt;
			frameDropped = fluidPlan.droppedDt;
			frameBudgetLimited = fluidPlan.budgetLimited;
			fluidSimulationTime += fluidPlan.consumedDt;

		} else {

			// Mode strict : pas fixe 120 Hz et frontières d'autorité exactes. Il est
			// destiné aux tests/replays, où la reproductibilité prime sur le pacing.
			let stepBudget = 0;
			const authorityBlocked = !! authorityPending || !! authorityFault
				|| !! resetPromise || !! relaxedColonyPromise;
			if ( ! authorityBlocked ) {

				const candidate = nextAuthorityAfter( simulationClock.tickExact );
				if ( nextAuthorityTick === null || ( candidate !== null && candidate < nextAuthorityTick ) )
					nextAuthorityTick = candidate;
				if ( nextAuthorityTick === null ) {

					stepBudget = MAX_SIMULATION_STEPS_PER_FRAME;

				} else {

					const ticksUntilBoundary = nextAuthorityTick - simulationClock.tickExact;
					stepBudget = ticksUntilBoundary > 0n
						? Math.min( MAX_SIMULATION_STEPS_PER_FRAME, Number( ticksUntilBoundary ) )
						: 0;

				}

			}
			simulationClock.setMaxStepsPerAdvance( stepBudget );
			const clockFrame = simulationClock.advance( wallDt, requestedSpeed, ( fixedDt, tick ) => {

				sim.step( fixedDt );
				colony.stepSimulation( fixedDt );
				ants.stepSimulation( fixedDt );
				if ( tick % 2 === 0 ) ragdoll.tick();
				spiders.stepSimulation( fixedDt );
				bees.stepSimulation( fixedDt );

			} );
			logicalSteps = clockFrame.effectiveSteps;
			frameEffective = clockFrame.effective;
			frameBudgetLimited = clockFrame.budgetLimited;
			if (
				! authorityPending
				&& ! authorityFault
				&& ! resetPromise
				&& ! relaxedColonyPromise
				&& simulationClock.tickExact === nextAuthorityTick
			) beginAuthorityReconciliation( nextAuthorityTick );

		}

		simulationWallAccum += wallDt;
		simulationEffectiveAccum += frameEffective;
		simulationDroppedAccum += frameDropped;
		simulationBudgetLimited ||= frameBudgetLimited;
		if ( logicalSteps > 0 ) sim.updateFieldNodes();
		if ( ! running && ( painted || paintFlag ) ) {

			// Peinture en pause : rafraîchir l'affichage sans avancer le temps logique.
			sim.refreshDisplay();
			sim.updateFieldNodes();

		}

		// Resolve camera motion before deriving the underground state.
		cinematic.update( rawDt );
		if ( ! params.cinematic ) controls.update();

		underground.update( rawDt );                 // plongée = caméra dans le bloc de terre
		ants.uDive.value = underground.dive ? 1 : 0; // render only the camera layer
		// SCANNER : passe émissive des souterraines (à travers la terre) + reine
		// luminescente + couvain et stocks de nourriture — chaque type d'élément
		// a SA couleur, relue chaque frame (réglable live)
		const scanOn = underground.scanMode > 0;
		ants.uScanAnts.value = scanOn ? 1 : 0;
		ants.uScanAntColor.value.set( gfx.scanAntColor );
		colony.uScanFx.value = scanOn ? 1 : 0;
		colony.uScanBroodColor.value.set( gfx.scanBroodColor );
		colony.uScanFoodColor.value.set( gfx.scanFoodColor );
		if ( scanOn !== wasScanOn ) {

			wasScanOn = scanOn;
			for ( const m of ants.scanBodies ) m.visible = scanOn;
			ants.queen.material.depthTest = ! scanOn;
			ants.queen.renderOrder = scanOn ? 11 : 0;
			colony.broodMesh.material.depthTest = ! scanOn;
			colony.broodMesh.renderOrder = scanOn ? 11 : 0;
			colony.piles.material.depthTest = ! scanOn;
			colony.piles.renderOrder = scanOn ? 11 : 0;

		}
		ants.renderFrame( camera );
		// Le mode fluide calcule la pose une fois, puis le ragdoll lit cette pose fraîche.
		if ( ! strictTiming && logicalSteps > 0 ) {

			fluidRagdollAccum = Math.min(
				FLUID_RAGDOLL_STEP,
				fluidRagdollAccum + frameEffective,
			);
			if ( fluidRagdollAccum + 1e-12 >= FLUID_RAGDOLL_STEP ) {

				ragdoll.tick();
				fluidRagdollAccum = 0;

			}

		}
		antfollow.update( rawDt );   // APRES ants.renderFrame : lit la pose fraiche de kPose
		// surbrillance jaune émissive de la fourmi suivie (visible à travers tout)
		ants.uFollowIdx.value = antfollow.selected;
		ants.followMesh.visible = antfollow.selected >= 0;
		spiders.renderFrame();

		// Entering the soil hides every surface-only renderable atomically.
		// Underground fauna and colony meshes remain available.
		const dived = underground.dive;
		bees.renderFrame( rawDt, ! dived );
		if ( dived !== wasDived ) {

			wasDived = dived;
			props.group.visible = ! dived;
			sky.dome.visible = ! dived;
			sky.moon.visible = ! dived;
			sky.moonLight.visible = ! dived;
			sky.ambient.visible = ! dived;
			scene.fog = dived ? null : sky.fog;
			foodballs.balls.visible = ! dived;
			foodballs.halos.visible = ! dived;
			env.ground.visible = ! dived;
			env.soil.visible = ! dived;
			env.entrance.visible = ! dived;
			colony.setVisible( params.colony && dived );
			ants.queen.visible = params.colony && dived;
			bees.setSurfaceVisible( ! dived );

		}
		// Surface-only debug geometry can be toggled from the UI at any time.
		cones.setVisible( ! dived && gfx.debugCones );

		// spiders.update() gère lui-même mesh.visible chaque frame : on force
		// APRÈS lui, sans toucher à sa logique interne
		if ( dived ) spiders.mesh.visible = false;

		sky.update( camera );
		grass.update( camera, rawDt );
		// grass.update() aussi réécrit mesh.visible chaque frame : on force après
		if ( dived ) grass.mesh.visible = false;

		// early-out réel : sans godrays, aucun post-processing n'est payé ;
		// sous terre les rayons de lune n'ont plus de sens
		if ( gfx.godrays && ! underground.dive ) godrays.render();
		else renderer.render( scene, camera );

		// Diagnostic copies are submitted after the visible image and may safely
		// observe it with one frame of latency.
		spiders.serviceDiagnostics();
		colony.serviceDiagnostics( wallDt );

		if ( renderer.backend.trackTimestamp === true && timestampAccum >= 0.5 ) {

			timestampAccum %= 0.5;
			if ( tryAcquireReadback() ) resolveTimings().finally( releaseReadback );

		}

		if ( overlayAccum >= 0.25 ) {

			overlayAccum %= 0.25;
			fps = fpsAccum > 0 ? Math.round( fpsCount / fpsAccum ) : 0;
			const fpsSnapshot = fps;
			const clockSnapshot = {
				mode: strictTiming ? 'strict' : 'fluid',
				requestedMultiplier: running ? params.simSpeed : 0,
				effectiveMultiplier: simulationWallAccum > 0
					? simulationEffectiveAccum / simulationWallAccum
					: 0,
				backlog: strictTiming ? simulationClock.backlog : 0,
				dropped: strictTiming ? 0 : simulationDroppedAccum,
				budgetLimited: simulationBudgetLimited,
				tick: strictTiming
					? simulationClock.tick
					: Math.round( fluidSimulationTime * SIMULATION_HZ ),
			};
			lastClockSnapshot = clockSnapshot;
			fpsAccum = 0;
			fpsCount = 0;
			simulationWallAccum = 0;
			simulationEffectiveAccum = 0;
			simulationDroppedAccum = 0;
			simulationBudgetLimited = false;
			perf.computeCalls = renderer.info.compute.frameCalls;
			const perfSnapshot = { ...perf, clock: clockSnapshot };
			const snapshotMode = clockSnapshot.mode;
			const statsEpoch = authorityEpoch;
			sim.readStats().then( ( stats ) => {

				if ( statsEpoch !== authorityEpoch ) return;
				if ( snapshotMode === 'fluid' && params.timingMode === 'fluid' ) {

					latestAuthorityStats = stats;
					scheduleRelaxedColonyReconciliation( stats );

				}
				ui.updateOverlay( stats, fpsSnapshot, perfSnapshot );

			} );

		}

	} );

	// ------------------------------------------------------------------
	// PILOTAGE PAR URL — cadrage reproductible pour l'inspection visuelle.
	//   ?ug=1              ouvre la vue en coupe
	//   ?cam=x,y,z         place la caméra
	//   ?look=x,y,z        vise ce point
	//   ?ants=N            fixe la population
	// Sert à obtenir exactement la même image d'une session à l'autre quand on
	// compare un réglage graphique.
	// ------------------------------------------------------------------
	{

		const q = new URLSearchParams( location.search );
		const v3 = ( k ) => {

			const s = q.get( k );
			if ( ! s ) return null;
			const a = s.split( ',' ).map( Number );
			return a.length === 3 && a.every( Number.isFinite ) ? a : null;

		};

		if ( q.get( 'ants' ) ) ui.setPopulation( + q.get( 'ants' ) );
		if ( q.get( 'scan' ) === '1' ) gfx.scannerView = true;
		if ( q.get( 'scan' ) === '0' ) gfx.scannerView = false;
		if ( q.get( 'follow' ) ) antfollow.select( + q.get( 'follow' ) );

		const c = v3( 'cam' ), l = v3( 'look' );
		if ( c ) camera.position.set( c[ 0 ], c[ 1 ], c[ 2 ] );
		if ( l ) controls.target.set( l[ 0 ], l[ 1 ], l[ 2 ] );
		if ( c || l ) controls.update();

	}

	// tests de cohérence de la colonie : ?test=colony ou __antsys.tests.run()
	const tests = createColonyTests( { sim, colony, spiders, ants, cones, renderer } );
	// surveillant d'anomalies (téléportations, toupies, cycle de vie) :
	// ?test=warden (&wdur=120) ou __antsys.warden.run()
	const warden = createWarden( { sim, colony, ants, cones, renderer, nestVolume } );

	// accès console pour le débogage
	const authority = {
		get pending() { return !! authorityPending; },
		get fault() { return authorityFault; },
		get nextTick() { return nextAuthorityTick; },
		get latestStats() { return latestAuthorityStats; },
		get timing() { return lastClockSnapshot; },
	};
	window.__antsys = { THREE, renderer, scene, camera, controls, sim, params, gfx, ants, ragdoll, nestVolume, sky, grass, props, foodballs, godrays, cinematic, bench, cones, editor, spiders, bees, colony, underground, antfollow, guide, layout, tests, warden, simulationClock, authority, envu: { uShowWalls, uTrailGamma } };

	// banc d'essai automatique : ?bench=5x90
	const benchMatch = location.search.match( /bench=(\d+)x(\d+)/ );

	if ( benchMatch ) {

		setTimeout( () => bench.run( { runs: + benchMatch[ 1 ], seconds: + benchMatch[ 2 ] } ), 800 );

	}

	if ( /test=colony/.test( location.search ) ) {

		setTimeout( () => tests.run(), 800 );

	}

	if ( /test=warden/.test( location.search ) ) {

		setTimeout( () => warden.run(), 800 );

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
	const detail = ( err && ( err.stack || err.message ) ) || String( err );
	showError(
		'Erreur au démarrage 😕',
		`Un fichier requis n'a pas pu être chargé ou l'initialisation a échoué.<br>`
		+ `<pre style="text-align:left;white-space:pre-wrap;font-size:11px;max-width:90vw;max-height:60vh;overflow:auto;background:#000;padding:8px;border-radius:6px;">${
			detail.replace( /&/g, '&amp;' ).replace( /</g, '&lt;' )
		}</pre>`,
	);

} );
