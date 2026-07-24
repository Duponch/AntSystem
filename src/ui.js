// Interface : panneau de réglages, peinture au pointeur, affichage des stats.

import * as THREE from 'three/webgpu';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

import { params, gfx, worldToGrid, MAX_ANTS, MAX_SPIDERS, TEXEL, saveSettings, clearSettings } from './config.js';
import { uGroundA, uGroundB, uFoodColor, uFoodGlow, uHaloStrength, uTrailGamma, uShowWalls } from './environment.js';
import { CATALOG } from './graphics/props.js';

const TOOL_MODES = { nourriture: 0, mur: 1, gomme: 2 };
const TOOL_COLORS = { nourriture: 0xffb45c, mur: 0xa8a29a, gomme: 0xff6b6b };

export function createUI( { scene, sim, ants, env, sky, grass, props, foodballs, cones, editor, godrays, cinematic, bench, music, spiders, colony, controls, camera, renderer, onReset } ) {

	// ------------------------------------------------------------------
	// Panneau de réglages
	// ------------------------------------------------------------------
	const gui = new GUI( { title: '🐜 AntSystem' } );

	// au-delà de ce nombre, les ombres des fourmis doublent le coût vertex
	// pour un gain visuel nul : on les coupe automatiquement
	const ANT_SHADOW_MAX = 16384;
	const applyAntShadows = () =>
		ants.setShadows( params.shadows && params.antCount <= ANT_SHADOW_MAX );

	const fColony = gui.addFolder( 'Colonie' );

	// UNIQUE point d'entrée pour changer la population (slider ET éclosions) :
	// params, uniform, compteurs de rendu, ombres et affichage du slider
	// restent toujours synchronisés.
	let antCountCtrl = null;

	function setPopulation( v ) {

		v = Math.round( Math.min( MAX_ANTS, Math.max( 10, v ) ) );
		params.antCount = v;
		sim.u.antCount.value = v;
		ants.setCount( v );
		cones.setCount( v );
		applyAntShadows();
		if ( antCountCtrl ) antCountCtrl.updateDisplay();

	}

	antCountCtrl = fColony.add( params, 'antCount', 10, MAX_ANTS, 1 ).name( 'Fourmis' ).onChange( ( v ) => {

		// les fourmis nouvellement activées repartent du nid (état propre)
		const prev = sim.u.antCount.value;
		if ( v > prev ) sim.reinitAnts( prev );

		setPopulation( v );

	} );
	fColony.add( params, 'simSpeed', 0, 4, 0.1 ).name( 'Vitesse ×' );
	fColony.add( params, 'paused' ).name( 'Pause' );
	fColony.add( { reset: onReset }, 'reset' ).name( '🔄 Réinitialiser' );

	// ------------------------------------------------------------------
	// La colonie VIVANTE : reine, castes, énergie, couvain, souterrain
	// ------------------------------------------------------------------
	const fLife = gui.addFolder( '👑 Fourmilière & castes' );

	fLife.add( params, 'colony' ).name( 'Colonie vivante (reine, castes)' ).onChange( async ( v ) => {

		await sim.setColonyEnabled( v );
		ants.queen.visible = v;
		colony.setVisible( v );
		if ( ! v ) gfx.undergroundView = false;
		gui.controllersRecursive().forEach( ( c ) => c.updateDisplay() );

	} );

	fLife.add( gfx, 'undergroundView' ).name( '⛏ Vue souterraine (fosse)' );
	fLife.add( gfx, 'pitRadius', 8, 20, 0.5 ).name( 'Rayon de la fosse (u)' );

	const fCastes = fLife.addFolder( 'Castes' );
	fCastes.add( params, 'nurseRatio', 0, 0.4, 0.01 ).name( 'Part de nourrices' )
		.onChange( ( v ) => sim.u.nurseRatio.value = v );
	fCastes.add( params, 'scoutRatio', 0, 0.4, 0.01 ).name( 'Part d\'éclaireuses' )
		.onChange( ( v ) => sim.u.scoutRatio.value = v );
	fCastes.add( params, 'scoutWander', 1, 4, 0.1 ).name( 'Errance éclaireuse (×)' )
		.onChange( ( v ) => sim.u.scoutWander.value = v );
	fCastes.add( params, 'scoutTrailFollow', 0, 1, 0.05 ).name( 'Suivi de piste éclaireuse' )
		.onChange( ( v ) => sim.u.scoutTrail.value = v );
	fCastes.add( params, 'scoutSpeedMult', 0.8, 1.5, 0.05 ).name( 'Vitesse éclaireuse (×)' )
		.onChange( ( v ) => sim.u.scoutSpeed.value = v );
	fCastes.add( params, 'soldierSpeedMult', 0.5, 1.2, 0.05 ).name( 'Vitesse soldate (×)' )
		.onChange( ( v ) => sim.u.soldierSpeed.value = v );
	fCastes.close();

	const fEnergy = fLife.addFolder( 'Énergie & nourriture' );
	fEnergy.add( params, 'energyLife', 60, 1800, 10 ).name( 'Autonomie (s)' )
		.onChange( ( v ) => sim.u.energyLife.value = v );
	fEnergy.add( params, 'eatThreshold', 0.1, 0.9, 0.05 ).name( 'Seuil de repas' )
		.onChange( ( v ) => sim.u.eatThreshold.value = v );
	fEnergy.add( params, 'hungryHome', 0.05, 0.6, 0.05 ).name( 'Seuil de retour (faim)' )
		.onChange( ( v ) => sim.u.hungryHome.value = v );
	fEnergy.add( params, 'foodRegen', 0, 12, 0.5 ).name( 'Gisements régénérés /min' );
	fEnergy.add( params, 'granaryStart', 0, 400, 10 ).name( 'Grenier de départ (reset)' )
		.onChange( ( v ) => sim.u.granaryStart.value = v );
	fEnergy.close();

	const fQueen = fLife.addFolder( 'Reine & ponte' );
	fQueen.add( params, 'queenLayInterval', 2, 60, 1 ).name( 'Intervalle de ponte (s)' )
		.onChange( ( v ) => sim.u.queenLayInterval.value = v );
	fQueen.add( params, 'queenLayCost', 0.02, 0.4, 0.01 ).name( 'Coût d\'une ponte' )
		.onChange( ( v ) => sim.u.queenLayCost.value = v );
	fQueen.add( params, 'queenLayMin', 0.2, 0.9, 0.05 ).name( 'Énergie min de ponte' )
		.onChange( ( v ) => sim.u.queenLayMin.value = v );
	fQueen.add( params, 'queenEnergyLife', 60, 1200, 10 ).name( 'Autonomie reine (s)' )
		.onChange( ( v ) => sim.u.queenEnergyLife.value = v );
	fQueen.add( params, 'queenMealValue', 0.1, 1, 0.05 ).name( 'Énergie par repas' )
		.onChange( ( v ) => sim.u.queenMealValue.value = v );
	fQueen.add( gfx, 'queenScale', 1.4, 4, 0.1 ).name( 'Gabarit de la reine (×)' )
		.onChange( ( v ) => { ants.uQueenScale.value = v; sim.u.queenScale.value = v; } );
	fQueen.close();

	const fBrood = fLife.addFolder( 'Couvain' );
	fBrood.add( params, 'eggDuration', 5, 120, 1 ).name( 'Durée œuf (s)' )
		.onChange( ( v ) => colony.u.eggDuration.value = v );
	fBrood.add( params, 'larvaMeals', 1, 8, 1 ).name( 'Repas par larve' )
		.onChange( ( v ) => colony.u.larvaMeals.value = v );
	fBrood.add( params, 'larvaMealEvery', 5, 90, 1 ).name( 'Cadence des repas (s)' )
		.onChange( ( v ) => colony.u.larvaMealEvery.value = v );
	fBrood.add( params, 'larvaStarveTime', 20, 300, 5 ).name( 'Famine fatale larve (s)' )
		.onChange( ( v ) => colony.u.larvaStarveTime.value = v );
	fBrood.add( params, 'pupaDuration', 5, 120, 1 ).name( 'Durée nymphe (s)' )
		.onChange( ( v ) => colony.u.pupaDuration.value = v );
	fBrood.add( params, 'maxPopulation', 100, MAX_ANTS, 50 ).name( 'Plafond de population' );
	fBrood.close();

	const fBehavior = gui.addFolder( 'Comportement' );
	fBehavior.add( params, 'moveSpeed', 5, 100, 1 ).name( 'Vitesse' )
		.onChange( ( v ) => sim.u.moveSpeed.value = v );
	fBehavior.add( params, 'steerStrength', 0, 20, 0.1 ).name( 'Pilotage' )
		.onChange( ( v ) => sim.u.steer.value = v );
	fBehavior.add( params, 'wanderStrength', 0, 6, 0.1 ).name( 'Errance' )
		.onChange( ( v ) => sim.u.wander.value = v );
	fBehavior.add( params, 'sensorAngleDeg', 10, 60, 1 ).name( 'Angle capteurs (°)' )
		.onChange( ( v ) => sim.u.sensorAngle.value = v * Math.PI / 180 );
	fBehavior.add( params, 'sensorDist', 3, 30, 1 ).name( 'Portée capteurs' )
		.onChange( ( v ) => sim.u.sensorDist.value = v );
	fBehavior.close();

	const fPredators = gui.addFolder( '🕷 Prédateurs & défense' );
	fPredators.add( params, 'spiderCount', 0, MAX_SPIDERS, 1 ).name( 'Araignées' );
	fPredators.add( params, 'spiderAggro', 0, 1, 0.05 ).name( 'Agressivité' );
	fPredators.add( params, 'spiderSpeed', 1, 20, 0.5 ).name( 'Vitesse araignée' );
	fPredators.add( params, 'spiderWalkAnim', 0.3, 4, 0.05 ).name( 'Calibrage animation' );
	fPredators.add( params, 'spiderVision', 10, 90, 1 ).name( 'Portée de vision' );
	fPredators.add( params, 'spiderFOV', 20, 300, 5 ).name( 'Champ de vision (°)' );
	fPredators.add( params, 'fleeRadius', 10, 90, 1 ).name( 'Rayon de peur' )
		.onChange( ( v ) => sim.u.fleeRadius.value = v );
	fPredators.add( params, 'soldierRatio', 0, 0.3, 0.01 ).name( 'Part de soldates' )
		.onChange( ( v ) => sim.u.soldierRatio.value = v );

	// --- prédation : morsure « sur » le corps → envenimation → mort → dévoration ---
	fPredators.add( params, 'bodyRadius', 0.3, 3, 0.05 ).name( 'Hitbox corps araignée (u)' );
	fPredators.add( params, 'antRadius', 0.1, 1.5, 0.05 ).name( 'Hitbox corps fourmi (u)' )
		.onChange( ( v ) => { sim.u.antHitR.value = v / TEXEL; ants.uAntHitR.value = v; } );
	fPredators.add( params, 'bitesToKill', 1, 5, 1 ).name( 'Morsures fatales' )
		.onChange( ( v ) => sim.u.bitesToKill.value = v );
	fPredators.add( params, 'biteInterval', 0.1, 2, 0.05 ).name( 'Cadence morsure (s)' )
		.onChange( ( v ) => sim.u.biteInterval.value = v );
	fPredators.add( params, 'paralysisFactor', 0.05, 1, 0.05 ).name( 'Vitesse envenimée (×)' )
		.onChange( ( v ) => sim.u.paralysisFactor.value = v );
	fPredators.add( params, 'venomRecovery', 0, 2, 0.05 ).name( 'Guérison venin (/s)' )
		.onChange( ( v ) => sim.u.venomRecovery.value = v );
	fPredators.add( params, 'eatDuration', 0.5, 8, 0.5 ).name( 'Durée du repas (s)' );
	fPredators.add( params, 'alarmFleeThreshold', 0, 1, 0.05 ).name( 'Seuil de fuite (alarme)' );
	fPredators.add( params, 'alarmWait', 1, 15, 0.5 ).name( 'Attente après fuite (s)' );
	fPredators.add( gfx, 'debugSpider' ).name( '🔍 Hitbox & vision (debug)' )
		.onChange( ( v ) => { spiders.setDebugVisible( v ); ants.setHitboxVisible( v ); } );
	fPredators.close();

	// ------------------------------------------------------------------
	// PHYSIQUE — l'interrupteur maître et son early-out
	// ------------------------------------------------------------------
	const fPhys = gui.addFolder( '⚙️ Physique' );

	fPhys.add( params, 'physics' ).name( 'Mode physique' ).onChange( ( v ) => {

		sim.u.physOn.value = v ? 1 : 0;
		overlayFlash( v
			? '⚙️ Physique ON — vitesses, impacts, culbutes'
			: '⚙️ Physique OFF — déplacement cinématique historique' );

	} );

	fPhys.add( { info: () => {

		overlayFlash( 'Comparaison honnête : ouvrez ?physics=0 et ?physics=1 dans deux onglets rechargés' );

	} }, 'info' ).name( '❔ Comment comparer' );

	const fForces = fPhys.addFolder( 'Forces & matière' );
	fForces.add( params, 'gravity', 5, 200, 1 ).name( 'Gravité (u/s²)' )
		.onChange( ( v ) => sim.u.gravity.value = v );
	fForces.add( params, 'antAccel', 2, 60, 0.5 ).name( 'Réactivité musculaire' )
		.onChange( ( v ) => sim.u.antAccel.value = v );
	fForces.add( params, 'groundDrag', 0.2, 12, 0.1 ).name( 'Friction au sol' )
		.onChange( ( v ) => sim.u.groundDrag.value = v );
	fForces.add( params, 'airDrag', 0, 4, 0.05 ).name( 'Traînée en vol' )
		.onChange( ( v ) => sim.u.airDrag.value = v );
	fForces.add( params, 'restitution', 0, 0.9, 0.02 ).name( 'Rebond au sol' )
		.onChange( ( v ) => sim.u.restitution.value = v );
	fForces.add( params, 'wallBounce', 0, 1, 0.05 ).name( 'Rebond sur les murs' )
		.onChange( ( v ) => sim.u.wallBounce.value = v );
	fForces.close();

	const fImpacts = fPhys.addFolder( 'Impacts & projections' );
	fImpacts.add( params, 'biteKnockback', 0, 30, 0.5 ).name( 'Recul encaissé (u/s)' )
		.onChange( ( v ) => sim.u.biteKnock.value = v / TEXEL );
	fImpacts.add( params, 'bitePop', 0, 10, 0.1 ).name( 'Soulèvement du coup (u/s)' )
		.onChange( ( v ) => sim.u.bitePop.value = v );
	fImpacts.add( params, 'deathPop', 0, 10, 0.1 ).name( 'Sursaut de mort (u/s)' )
		.onChange( ( v ) => sim.u.deathPop.value = v );
	fImpacts.add( params, 'deathFling', 0, 15, 0.1 ).name( 'Projection de mort (u/s)' )
		.onChange( ( v ) => sim.u.deathFling.value = v / TEXEL );
	fImpacts.add( params, 'chargeImpulse', 0, 15, 0.1 ).name( 'Contre-coup de la charge' )
		.onChange( ( v ) => sim.u.chargeImpulse.value = v / TEXEL );
	fImpacts.add( params, 'spiderKnockback', 0, 12, 0.1 ).name( 'Recul de l\'araignée (u/s)' );
	fImpacts.close();

	const fBody = fPhys.addFolder( 'Démarche' );
	fBody.add( gfx, 'bobAmp', 0, 0.08, 0.002 ).name( 'Rebond du corps' )
		.onChange( ( v ) => ants.pose.u.bobAmp.value = v );
	fBody.add( gfx, 'swayAmp', 0, 0.3, 0.005 ).name( 'Roulis du trépied' )
		.onChange( ( v ) => ants.pose.u.swayAmp.value = v );
	fBody.add( gfx, 'pitchAmp', 0, 0.2, 0.005 ).name( 'Tangage' )
		.onChange( ( v ) => ants.pose.u.pitchAmp.value = v );
	fBody.close();

	fPhys.add( gfx, 'perfHud' ).name( '⏱ Chronos GPU (recharge)' ).onFinishChange( () => {

		saveSettings();
		location.reload();

	} );
	fPhys.close();

	const fPher = gui.addFolder( 'Phéromones' );
	fPher.add( params, 'depositRate', 0, 40, 0.5 ).name( 'Dépôt' )
		.onChange( ( v ) => sim.u.depositRate.value = v );
	fPher.add( params, 'fade', 0, 0.2, 0.005 ).name( 'Affaiblissement' )
		.onChange( ( v ) => sim.u.fade.value = v );
	fPher.add( params, 'evaporation', 0.01, 1, 0.01 ).name( 'Évaporation' )
		.onChange( ( v ) => sim.u.evap.value = v );
	fPher.add( params, 'diffusion', 0, 5, 0.1 ).name( 'Diffusion' )
		.onChange( ( v ) => sim.u.diffuse.value = v );
	fPher.close();

	// les murs ne sont affichés qu'en mode pinceau ou dans l'éditeur
	function syncWalls() {

		uShowWalls.value = ( params.brushMode || editor.enabled ) ? 1 : 0;

	}

	const fTools = gui.addFolder( 'Outils' );
	const brushCtrl = fTools.add( params, 'brushMode' ).name( '✏️ Mode pinceau (B)' )
		.onChange( () => syncWalls() );
	fTools.add( params, 'tool', Object.keys( TOOL_MODES ) ).name( 'Outil' );
	fTools.add( params, 'brushRadius', 4, 40, 1 ).name( 'Taille pinceau' );
	// (1 bille = 1 unité, littéralement prise du sol — plus de stock caché)

	const fDisplay = gui.addFolder( 'Affichage' );
	fDisplay.add( params, 'trailIntensity', 0, 3, 0.05 ).name( 'Intensité pistes' )
		.onChange( ( v ) => env.uTrail.value = v );
	fDisplay.add( gfx, 'trailGamma', 0.6, 2.5, 0.05 ).name( 'Contraste pistes' )
		.onChange( ( v ) => uTrailGamma.value = v );
	fDisplay.add( gfx, 'music' ).name( '🎵 Musique' ).onChange( ( v ) => music.set( v ) );
	fDisplay.add( gfx, 'musicVolume', 0, 1, 0.01 ).name( 'Volume' )
		.onChange( ( v ) => music.setVolume( v ) );
	// l'animation reste proportionnelle à la vitesse ; ceci règle le rapport
	fDisplay.add( params, 'walkAnim', 0.2, 4, 0.05 ).name( 'Calibrage animation' )
		.onChange( ( v ) => sim.u.walkAnim.value = v );
	fDisplay.add( params, 'shadows' ).name( 'Ombres' ).onChange( ( v ) => {

		renderer.shadowMap.enabled = v;
		sky.moonLight.castShadow = v;
		applyAntShadows();

	} );
	const cineCtrl = fDisplay.add( params, 'cinematic' ).name( '🎬 Caméra cinématique' )
		.onChange( ( v ) => cinematic.setEnabled( v ) );
	cinematic.bindController( cineCtrl );
	fDisplay.add( gfx, 'debugCones' ).name( '🔍 Cônes de vision (debug)' )
		.onChange( ( v ) => cones.setVisible( v ) );
	fDisplay.close();
	applyAntShadows();

	const fGfx = gui.addFolder( 'Graphismes' );

	const fMap = fGfx.addFolder( 'Carte' );
	fMap.add( gfx, 'mapSize', 100, 320, 10 ).name( 'Taille (recharge)' )
		.onFinishChange( () => {

			saveSettings();
			location.reload();

		} );
	fMap.add( gfx, 'groundThickness', 0.2, 10, 0.1 ).name( 'Épaisseur du sol' )
		.onChange( ( v ) => env.setThickness( v ) );

	const fColors = fGfx.addFolder( 'Couleurs' );
	fColors.addColor( gfx, 'groundColorA' ).name( 'Sol/herbe sombre' )
		.onChange( ( v ) => uGroundA.value.set( v ) );
	fColors.addColor( gfx, 'groundColorB' ).name( 'Sol/herbe clair' )
		.onChange( ( v ) => uGroundB.value.set( v ) );
	fColors.addColor( gfx, 'antColor' ).name( 'Fourmis' )
		.onChange( ( v ) => ants.uBodyColor.value.set( v ) );
	fColors.addColor( gfx, 'antAccentColor' ).name( 'Yeux / antennes' )
		.onChange( ( v ) => ants.uAccentColor.value.set( v ) );
	fColors.addColor( gfx, 'soldierColor' ).name( 'Soldates' )
		.onChange( ( v ) => ants.uSoldierColor.value.set( v ) );
	fColors.addColor( gfx, 'nurseColor' ).name( 'Nourrices' )
		.onChange( ( v ) => ants.uNurseColor.value.set( v ) );
	fColors.addColor( gfx, 'scoutColor' ).name( 'Éclaireuses' )
		.onChange( ( v ) => ants.uScoutColor.value.set( v ) );
	fColors.addColor( gfx, 'queenColor' ).name( 'Reine' )
		.onChange( ( v ) => ants.uQueenColor.value.set( v ) );
	fColors.addColor( gfx, 'eggColor' ).name( 'Œufs' )
		.onChange( ( v ) => colony.uEggColor.value.set( v ) );
	fColors.addColor( gfx, 'larvaColor' ).name( 'Larves' )
		.onChange( ( v ) => colony.uLarvaColor.value.set( v ) );
	fColors.addColor( gfx, 'pupaColor' ).name( 'Nymphes' )
		.onChange( ( v ) => colony.uPupaColor.value.set( v ) );
	fColors.addColor( gfx, 'spiderColor' ).name( 'Araignée' )
		.onChange( ( v ) => spiders.uSpiderColor.value.set( v ) );
	fColors.addColor( gfx, 'spiderAccent' ).name( 'Araignée (pattes)' )
		.onChange( ( v ) => spiders.uSpiderAccent.value.set( v ) );
	fColors.addColor( gfx, 'anthillColor' ).name( 'Fourmilière' )
		.onChange( ( v ) => env.anthillMat.color.set( v ) );
	fColors.addColor( gfx, 'foodColor' ).name( 'Nourriture' ).onChange( ( v ) => {

		uFoodColor.value.set( v );
		ants.grainMat.color.set( v );
		ants.grainMat.emissive.set( v );

	} );

	const fFood = fGfx.addFolder( 'Nourriture' );
	fFood.add( gfx, 'foodBallSpacing', 3, 14, 1 ).name( 'Espacement billes' ).onChange( ( v ) => {

		sim.u.ballSpacing.value = v;
		foodballs.refresh();

	} );
	fFood.add( gfx, 'foodBallRadius', 0.06, 0.4, 0.01 ).name( 'Taille billes' )
		.onChange( ( v ) => foodballs.u.ballSize.value = v );
	fFood.add( gfx, 'foodGlow', 0, 4, 0.05 ).name( 'Brillance' )
		.onChange( ( v ) => uFoodGlow.value = v );
	fFood.add( gfx, 'haloSize', 0, 3, 0.05 ).name( 'Halo luciole : taille' ).onChange( ( v ) => {

		foodballs.u.haloSize.value = v;
		ants.uGrainHalo.value = v;

	} );
	fFood.add( gfx, 'haloIntensity', 0, 3, 0.05 ).name( 'Halo luciole : intensité' ).onChange( ( v ) => {

		foodballs.u.haloIntensity.value = v;
		ants.uGrainHaloIntensity.value = v;

	} );
	fFood.add( gfx, 'haloSpread', 0.5, 0.99, 0.005 ).name( 'Halo au sol : portée' )
		.onChange( ( v ) => sim.u.haloSpread.value = v );
	fFood.add( gfx, 'haloStrength', 0, 2.5, 0.05 ).name( 'Halo au sol : intensité' )
		.onChange( ( v ) => uHaloStrength.value = v );

	const fPerf = fGfx.addFolder( 'Performances' );
	fPerf.add( gfx, 'lodDist0', 6, 40, 1 ).name( 'Plein détail (u)' );
	fPerf.add( gfx, 'lodDist1', 20, 100, 1 ).name( 'Distance d\'animation (u)' );
	fPerf.add( gfx, 'lodBudget', 500, 12000, 100 ).name( 'Budget plein détail' );
	fPerf.add( gfx, 'maxAntCorpses', 0, 20000, 100 ).name( 'Cadavres fourmis max' )
		.onChange( ( v ) => sim.u.maxAntCorpses.value = v );
	fPerf.add( gfx, 'maxSpiderCorpses', 0, 1000, 5 ).name( 'Cadavres araignées max' );

	const fScales = fGfx.addFolder( 'Tailles du décor' );
	const rescale = ( cat, restamp ) => () => {

		props.setCategoryScale( cat );
		if ( restamp ) sim.setObstacles( props.computeWallStamps() );

	};

	fScales.add( gfx, 'scaleTrees', 0.3, 2.5, 0.05 ).name( 'Arbres' ).onChange( rescale( 'trees', true ) );
	fScales.add( gfx, 'scaleObstacles', 0.3, 2.5, 0.05 ).name( 'Bûches / rochers-obstacles' ).onChange( rescale( 'obstacles', true ) );
	fScales.add( gfx, 'scaleMushrooms', 0.3, 3, 0.05 ).name( 'Champignons' ).onChange( rescale( 'mushrooms', false ) );
	fScales.add( gfx, 'scalePlants', 0.3, 3, 0.05 ).name( 'Plantes' ).onChange( rescale( 'plants', false ) );
	fScales.add( gfx, 'scaleRocks', 0.3, 3, 0.05 ).name( 'Cailloux' ).onChange( rescale( 'rocks', false ) );

	const fGrass = fGfx.addFolder( 'Herbe' );
	fGrass.add( gfx, 'grass' ).name( 'Herbe' );
	fGrass.add( gfx, 'grassDensity', 5, grass.MAX_DENSITY, 1 ).name( 'Densité (brins/m²)' );
	fGrass.add( gfx, 'grassHeight', 0.25, 1.6, 0.05 ).name( 'Hauteur' )
		.onChange( ( v ) => grass.u.height.value = v );
	fGrass.add( gfx, 'grassWidth', 0.3, 2, 0.05 ).name( 'Largeur' )
		.onChange( ( v ) => grass.u.width.value = v );
	fGrass.add( gfx, 'grassRadius', 15, 90, 1 ).name( 'Rayon du tapis' );
	fGrass.add( gfx, 'grassWind', 0, 1, 0.02 ).name( 'Vent' )
		.onChange( ( v ) => grass.u.wind.value = v );
	fGrass.add( gfx, 'grassChaos', 0, 1, 0.01 ).name( 'Irrégularité' )
		.onChange( ( v ) => grass.u.chaos.value = v );
	fGrass.add( gfx, 'grassShadows' ).name( 'Ombres des brins' )
		.onChange( ( v ) => grass.setShadows( v ) );

	const fNight = fGfx.addFolder( 'Nuit' );
	fNight.add( gfx, 'nightTime', 0, 1, 0.005 ).name( 'Heure de la nuit' )
		.onChange( ( v ) => sky.setTime( v ) );
	fNight.add( gfx, 'moonIntensity', 0, 4, 0.05 ).name( 'Clair de lune' )
		.onChange( ( v ) => sky.setMoonIntensity( v ) );
	fNight.add( gfx, 'ambientIntensity', 0, 2.5, 0.05 ).name( 'Ambiante' )
		.onChange( ( v ) => sky.ambient.intensity = v );
	fNight.add( gfx, 'fogDensity', 0, 0.025, 0.0005 ).name( 'Brouillard' )
		.onChange( ( v ) => sky.fog.density = v );
	fNight.add( gfx, 'stars', 0, 1, 0.02 ).name( 'Étoiles' )
		.onChange( ( v ) => sky.uStars.value = v );
	fNight.add( gfx, 'godrays' ).name( 'Rayons de lune (godrays)' );
	fNight.add( gfx, 'godrayIntensity', 0, 2.5, 0.05 ).name( 'Intensité des rayons' )
		.onChange( ( v ) => godrays.uIntensity.value = v );

	fGfx.close();

	// --- éditeur de décor ---
	const fEdit = gui.addFolder( '🛠 Éditeur de décor' );
	const edState = { enabled: false, model: 'Tree_07', rotation: 0, scale: 1 };

	const edToggle = fEdit.add( edState, 'enabled' ).name( 'Activer' ).onChange( ( v ) => {

		editor.setEnabled( v );
		syncWalls();
		renderer.domElement.style.cursor = v ? 'default' : 'crosshair';
		overlayFlash( v
			? '🛠 Éditeur : clic = sélectionner · glisser = déplacer'
			: 'Éditeur désactivé' );

	} );

	fEdit.add( edState, 'model', Object.keys( CATALOG ) ).name( 'Modèle' );
	fEdit.add( { place: () => {

		if ( ! edState.enabled ) {

			edState.enabled = true;
			editor.setEnabled( true );
			edToggle.updateDisplay();

		}

		editor.startPlacing( edState.model );
		overlayFlash( `➕ Cliquez sur la carte pour poser « ${edState.model} »` );

	} }, 'place' ).name( '➕ Placer (puis clic carte)' );

	const edRot = fEdit.add( edState, 'rotation', 0, 360, 1 ).name( 'Rotation (°)' )
		.onChange( ( v ) => editor.applyToSelection( { yaw: v * Math.PI / 180 } ) );
	const edScale = fEdit.add( edState, 'scale', 0.2, 40, 0.1 ).name( 'Taille' )
		.onChange( ( v ) => editor.applyToSelection( { scale: v } ) );
	fEdit.add( { del: () => editor.deleteSelection() }, 'del' ).name( '🗑 Supprimer la sélection' );
	fEdit.close();

	// le panneau reflète l'objet sélectionné
	editor.bindOnSelect( ( sel ) => {

		if ( ! sel ) return;
		const p = sel.entry.placements[ sel.index ];
		edState.rotation = Math.round( ( ( p.yaw || 0 ) * 180 / Math.PI ) % 360 + 360 ) % 360;
		edState.scale = p.scale;
		edRot.updateDisplay();
		edScale.updateDisplay();
		overlayFlash( `Sélection : ${sel.entry.model}` );

	} );

	// --- banc d'essai statistique ---
	const fBench = gui.addFolder( '🧪 Banc d\'essai' );
	const benchCfg = { runs: 5, seconds: 90 };
	fBench.add( benchCfg, 'runs', 1, 20, 1 ).name( 'Essais' );
	fBench.add( benchCfg, 'seconds', 30, 300, 15 ).name( 'Durée sim (s)' );
	fBench.add( { go: async () => {

		overlayFlash( `🧪 ${benchCfg.runs} essais de ${benchCfg.seconds}s en cours…` );
		const s = await bench.run( benchCfg );
		overlayFlash( `🧪 ${s.deliveredMean} ± ${s.deliveredSd} livrées en ${benchCfg.seconds}s` +
			` (${s.perAntPerMin}/fourmi/min) — détails en console (F12)` );

	} }, 'go' ).name( '▶ Lancer' );
	fBench.close();

	// --- persistance (réglages + grille de murs ajustée à la main) ---
	gui.add( { save: async () => {

		saveSettings();

		if ( props.isEdited() ) {

			localStorage.setItem( 'antsystem-decor-v1', JSON.stringify( props.exportDoc() ) );

		}

		try {

			localStorage.setItem( 'antsystem-walls-v1', await sim.readWallsBase64() );
			overlayFlash( '💾 Réglages, décor et murs sauvegardés' );

		} catch {

			overlayFlash( '💾 Réglages sauvegardés (murs : échec de lecture)' );

		}

	} }, 'save' ).name( '💾 Sauvegarder les réglages' );

	gui.add( { reset: () => {

		clearSettings();
		localStorage.removeItem( 'antsystem-walls-v1' );
		localStorage.removeItem( 'antsystem-decor-v1' );
		location.reload();

	} }, 'reset' ).name( '♻️ Réglages par défaut' );

	// ------------------------------------------------------------------
	// Peinture : clic gauche = outil, clic droit = orbite
	// ------------------------------------------------------------------
	// clic gauche : outil · clic molette maintenu : déplacement · clic droit : orbite
	controls.mouseButtons = {
		LEFT: null,
		MIDDLE: THREE.MOUSE.PAN,
		RIGHT: THREE.MOUSE.ROTATE,
	};
	// tactile : un doigt peint, deux doigts zooment/déplacent
	controls.touches = {
		ONE: null,
		TWO: THREE.TOUCH.DOLLY_PAN,
	};

	const raycaster = new THREE.Raycaster();
	const pointer = new THREE.Vector2();
	let painting = false;
	let lastStamp = null;
	let paintedThisFrame = false;

	// --- curseur du pinceau : cercle au sol de la taille du pinceau ---
	const brushCursor = new THREE.Mesh(
		new THREE.RingGeometry( 0.92, 1, 48 ).rotateX( - Math.PI / 2 ),
		new THREE.MeshBasicNodeMaterial( {
			color: TOOL_COLORS[ params.tool ], transparent: true, opacity: 0.9,
			depthWrite: false, fog: false,
		} ),
	);
	brushCursor.position.y = 0.05;
	brushCursor.renderOrder = 4;
	brushCursor.visible = false;
	scene.add( brushCursor );
	renderer.domElement.style.cursor = 'crosshair';

	function updateBrushCursor( event ) {

		if ( ! params.brushMode || editor.enabled || params.cinematic ) {

			brushCursor.visible = false;
			return;

		}

		const rect = renderer.domElement.getBoundingClientRect();
		pointer.set(
			( ( event.clientX - rect.left ) / rect.width ) * 2 - 1,
			- ( ( event.clientY - rect.top ) / rect.height ) * 2 + 1,
		);
		raycaster.setFromCamera( pointer, camera );
		const hit = raycaster.intersectObject( env.ground, false )[ 0 ];

		if ( ! hit ) {

			brushCursor.visible = false;
			return;

		}

		brushCursor.position.set( hit.point.x, 0.05, hit.point.z );
		brushCursor.scale.setScalar( params.brushRadius * TEXEL );
		brushCursor.material.color.set( TOOL_COLORS[ params.tool ] );
		brushCursor.visible = true;

	}

	function stampAt( event ) {

		const rect = renderer.domElement.getBoundingClientRect();
		pointer.set(
			( ( event.clientX - rect.left ) / rect.width ) * 2 - 1,
			- ( ( event.clientY - rect.top ) / rect.height ) * 2 + 1,
		);
		raycaster.setFromCamera( pointer, camera );

		const hit = raycaster.intersectObject( env.ground, false )[ 0 ];
		if ( ! hit ) return;

		const g = worldToGrid( hit.point.x, hit.point.z );
		const mode = TOOL_MODES[ params.tool ];

		// interpolation le long du déplacement pour un trait continu
		const spacing = Math.max( 2, params.brushRadius * 0.5 );
		let accepted = true;

		if ( lastStamp ) {

			const dx = g.x - lastStamp.x;
			const dy = g.y - lastStamp.y;
			const dist = Math.hypot( dx, dy );
			const steps = Math.min( 32, Math.floor( dist / spacing ) );

			for ( let s = 1; s <= steps; s ++ ) {

				accepted = sim.queueBrush(
					lastStamp.x + ( dx * s ) / ( steps + 1 ),
					lastStamp.y + ( dy * s ) / ( steps + 1 ),
					mode, params.brushRadius, params.foodAmount,
				) && accepted;

			}

		}

		accepted = sim.queueBrush( g.x, g.y, mode, params.brushRadius, params.foodAmount ) && accepted;

		// file pleine : on garde l'ancre pour ré-interpoler le segment perdu au prochain événement
		if ( accepted ) lastStamp = g;
		paintedThisFrame = true;

	}

	const dom = renderer.domElement;
	const stopPainting = () => {

		painting = false;
		lastStamp = null;

	};

	dom.addEventListener( 'pointerdown', ( e ) => {

		if ( e.button !== 0 || editor.enabled || ! params.brushMode ) return;
		painting = true;
		lastStamp = null;
		stampAt( e );

	} );
	dom.addEventListener( 'pointermove', ( e ) => {

		updateBrushCursor( e );

		if ( ! painting || editor.enabled ) return;

		// pointerup raté (perte de focus, sortie de fenêtre…) : on s'auto-répare
		if ( ( e.buttons & 1 ) === 0 ) {

			stopPainting();
			return;

		}

		stampAt( e );

	} );
	dom.addEventListener( 'pointerleave', () => {

		brushCursor.visible = false;

	} );
	window.addEventListener( 'pointerup', stopPainting );
	dom.addEventListener( 'pointercancel', stopPainting );
	window.addEventListener( 'blur', stopPainting );
	dom.addEventListener( 'contextmenu', ( e ) => e.preventDefault() );

	// raccourcis clavier
	window.addEventListener( 'keydown', ( e ) => {

		if ( e.key === ' ' ) {

			params.paused = ! params.paused;
			e.preventDefault();

		} else if ( e.key === 'b' || e.key === 'B' ) {

			params.brushMode = ! params.brushMode;
			syncWalls();

		} else if ( e.key === '1' || e.key === '2' || e.key === '3' ) {

			params.tool = [ 'nourriture', 'mur', 'gomme' ][ + e.key - 1 ];
			params.brushMode = true;      // choisir un outil active le pinceau
			syncWalls();

		}

		gui.controllersRecursive().forEach( ( c ) => c.updateDisplay() );

	} );

	// ------------------------------------------------------------------
	// Overlay (stats + aide) + messages éphémères
	// ------------------------------------------------------------------
	const overlay = document.getElementById( 'overlay' );

	const flash = document.createElement( 'div' );
	flash.style.cssText =
		'position:fixed;top:14px;left:50%;transform:translateX(-50%);color:#cde;' +
		'background:#000a;padding:6px 14px;border-radius:6px;font-size:13px;' +
		'opacity:0;transition:opacity .3s;pointer-events:none;z-index:10;';
	document.body.appendChild( flash );
	let flashTimer = null;

	function overlayFlash( text ) {

		flash.textContent = text;
		flash.style.opacity = '1';
		clearTimeout( flashTimer );
		flashTimer = setTimeout( () => flash.style.opacity = '0', 1600 );

	}

	function updateOverlay( stats, fps, perf ) {

		const carrying = Math.max( 0, stats.picked - stats.delivered );
		const eaten = stats.eaten || 0;
		const devoured = stats.devoured || 0;
		// population vivante = activées − mortes (morsures + faim, série stats[2])
		const aliveCount = Math.max( 0, params.antCount - eaten );

		let colonyLine = '';

		if ( params.colony && colony ) {

			const d = colony.demo;
			const qe = Math.round( ( stats.queenEnergy || 0 ) * 100 );
			const famine = qe < 25 ? ' ⚠️ reine affamée' : '';
			colonyLine =
				`👑 ${qe}%${famine} · 🥚 ${d.eggs} · 🐛 ${d.larvae} · 🦋 ${d.pupae} · ` +
				`🌾 ${stats.granary || 0} au grenier · ` +
				`${stats.laid || 0} pondus / ${stats.hatched || 0} éclos<br>`;

		}

		overlay.innerHTML =
			`🍎 <b>${stats.delivered}</b> récoltées · ` +
			`🐜 ${carrying} en transport · ` +
			( params.spiderCount > 0 ? `🕷 ${eaten} mortes (${devoured} dévorées) · ` : '' ) +
			`${aliveCount.toLocaleString( 'fr-FR' )} fourmis · ${fps} ips` +
			( perf && perf.compute ? ` · ⏱ compute ${perf.compute.toFixed( 2 )} ms` +
				` / rendu ${perf.render.toFixed( 2 )} ms (${perf.computeCalls} passes)` : '' ) +
			` · ⚙️ ${params.physics ? 'physique' : 'cinématique'}<br>` +
			colonyLine +
			`<span style="opacity:.65">${params.brushMode ? 'Clic gauche : ' + params.tool : 'B : mode pinceau'} · ` +
			`Clic droit : orbite · Clic molette : déplacer · Molette : zoom · ` +
			`Espace : pause · 1/2/3 : outils</span>`;

	}

	return {
		updateOverlay,
		setPopulation,
		consumePaintFlag() {

			const p = paintedThisFrame;
			paintedThisFrame = false;
			return p;

		},
	};

}
