// Interface : panneau de réglages, peinture au pointeur, affichage des stats.

import * as THREE from 'three/webgpu';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

import { params, worldToGrid, MAX_ANTS } from './config.js';

const TOOL_MODES = { nourriture: 0, mur: 1, gomme: 2 };

export function createUI( { sim, ants, env, controls, camera, renderer, onReset } ) {

	// ------------------------------------------------------------------
	// Panneau de réglages
	// ------------------------------------------------------------------
	const gui = new GUI( { title: '🐜 AntSystem' } );

	const fColony = gui.addFolder( 'Colonie' );
	fColony.add( params, 'antCount', 10, MAX_ANTS, 1 ).name( 'Fourmis' ).onChange( ( v ) => {

		// les fourmis nouvellement activées repartent du nid (état propre)
		const prev = sim.u.antCount.value;
		if ( v > prev ) sim.reinitAnts( prev );

		sim.u.antCount.value = v;
		ants.setCount( v );

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

	const fTools = gui.addFolder( 'Outils (clic gauche)' );
	fTools.add( params, 'tool', Object.keys( TOOL_MODES ) ).name( 'Outil' );
	fTools.add( params, 'brushRadius', 4, 40, 1 ).name( 'Taille pinceau' );
	fTools.add( params, 'foodAmount', 4, 64, 1 ).name( 'Qté nourriture' );

	const fDisplay = gui.addFolder( 'Affichage' );
	fDisplay.add( params, 'trailIntensity', 0, 3, 0.05 ).name( 'Intensité pistes' )
		.onChange( ( v ) => env.uTrail.value = v );
	fDisplay.add( params, 'shadows' ).name( 'Ombres' ).onChange( ( v ) => {

		renderer.shadowMap.enabled = v;
		ants.setShadows( v );
		env.sun.castShadow = v;

	} );
	fDisplay.close();

	// ------------------------------------------------------------------
	// Peinture : clic gauche = outil, clic droit = orbite
	// ------------------------------------------------------------------
	controls.mouseButtons = {
		LEFT: null,
		MIDDLE: THREE.MOUSE.DOLLY,
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

		if ( e.button !== 0 ) return;
		painting = true;
		lastStamp = null;
		stampAt( e );

	} );
	dom.addEventListener( 'pointermove', ( e ) => {

		if ( ! painting ) return;

		// pointerup raté (perte de focus, sortie de fenêtre…) : on s'auto-répare
		if ( ( e.buttons & 1 ) === 0 ) {

			stopPainting();
			return;

		}

		stampAt( e );

	} );
	window.addEventListener( 'pointerup', stopPainting );
	dom.addEventListener( 'pointercancel', stopPainting );
	window.addEventListener( 'blur', stopPainting );
	dom.addEventListener( 'contextmenu', ( e ) => e.preventDefault() );

	// raccourcis clavier
	window.addEventListener( 'keydown', ( e ) => {

		if ( e.key === ' ' ) {

			params.paused = ! params.paused;
			gui.controllersRecursive().forEach( ( c ) => c.updateDisplay() );
			e.preventDefault();

		} else if ( e.key === '1' ) params.tool = 'nourriture';
		else if ( e.key === '2' ) params.tool = 'mur';
		else if ( e.key === '3' ) params.tool = 'gomme';

		gui.controllersRecursive().forEach( ( c ) => c.updateDisplay() );

	} );

	// ------------------------------------------------------------------
	// Overlay (stats + aide)
	// ------------------------------------------------------------------
	const overlay = document.getElementById( 'overlay' );

	function updateOverlay( stats, fps ) {

		const carrying = Math.max( 0, stats.picked - stats.delivered );
		overlay.innerHTML =
			`🍎 <b>${stats.delivered}</b> récoltées · ` +
			`🐜 ${carrying} en transport · ` +
			`${params.antCount.toLocaleString( 'fr-FR' )} fourmis · ${fps} ips<br>` +
			`<span style="opacity:.65">Clic gauche : ${params.tool} · Clic droit : orbite · ` +
			`Molette : zoom · Espace : pause · 1/2/3 : outils</span>`;

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
