// Interface : panneau de réglages, peinture au pointeur, affichage des stats.

import * as THREE from 'three/webgpu';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

import { params, gfx, worldToGrid, MAX_ANTS, TEXEL, saveSettings, clearSettings } from './config.js';
import { uGroundA, uGroundB, uFoodColor, uFoodGlow, uHaloStrength, uTrailGamma, uShowWalls } from './environment.js';
import { CATALOG } from './graphics/props.js';

const TOOL_MODES = { nourriture: 0, mur: 1, gomme: 2 };
const TOOL_COLORS = { nourriture: 0xffb45c, mur: 0xa8a29a, gomme: 0xff6b6b };

export function createUI( { scene, sim, ants, env, sky, grass, props, foodballs, cones, editor, godrays, cinematic, bench, music, controls, camera, renderer, onReset } ) {

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
	fColony.add( params, 'antCount', 10, MAX_ANTS, 1 ).name( 'Fourmis' ).onChange( ( v ) => {

		// les fourmis nouvellement activées repartent du nid (état propre)
		const prev = sim.u.antCount.value;
		if ( v > prev ) sim.reinitAnts( prev );

		sim.u.antCount.value = v;
		ants.setCount( v );
		cones.setCount( v );
		applyAntShadows();

	} );
	fColony.add( params, 'simSpeed', 0, 4, 0.1 ).name( 'Vitesse ×' );
	fColony.add( params, 'paused' ).name( 'Pause' );
	fColony.add( { reset: onReset }, 'reset' ).name( '🔄 Réinitialiser' );

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

	const fPredators = gui.addFolder( '🕷 Prédateurs' );
	fPredators.add( params, 'spiderCount', 0, 3, 1 ).name( 'Araignées' );
	fPredators.add( params, 'spiderAggro', 0, 1, 0.05 ).name( 'Agressivité' );
	fPredators.close();

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
	fDisplay.add( params, 'walkAnim', 0.2, 4, 0.05 ).name( 'Calibrage animation' );
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

	function updateOverlay( stats, fps ) {

		const carrying = Math.max( 0, stats.picked - stats.delivered );
		const eaten = stats.eaten || 0;
		overlay.innerHTML =
			`🍎 <b>${stats.delivered}</b> récoltées · ` +
			`🐜 ${carrying} en transport · ` +
			( params.spiderCount > 0 ? `🕷 ${eaten} croquées · ` : '' ) +
			`${params.antCount.toLocaleString( 'fr-FR' )} fourmis · ${fps} ips<br>` +
			`<span style="opacity:.65">${params.brushMode ? 'Clic gauche : ' + params.tool : 'B : mode pinceau'} · ` +
			`Clic droit : orbite · Clic molette : déplacer · Molette : zoom · ` +
			`Espace : pause · 1/2/3 : outils</span>`;

	}

	return {
		updateOverlay,
		consumePaintFlag() {

			const p = paintedThisFrame;
			paintedThisFrame = false;
			return p;

		},
	};

}
