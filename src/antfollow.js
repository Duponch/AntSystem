// SUIVI DE FOURMI — sélection au clic + caméra attachée (outil de débogage).
//
// Sert à observer les déplacements d'UNE fourmi (notamment ses sauts
// suspects dans les tunnels) : un clic gauche sur une fourmi la sélectionne,
// la caméra s'attache à elle (orbite + zoom molette autorisés), un clic dans
// le vide ou Échap la lâche.
//
// Budget performance : quasi NUL.
//   • PICKING — pas de raycast CPU (les positions vivent sur GPU : un raycast
//     serait de toute façon aveugle). Un noyau compute mesure la distance
//     angulaire de chaque fourmi vivante au rayon du clic et atomicMin un
//     couple (distance, index) packé dans UN uint. Deux dispatches par clic,
//     un readback de 4 octets : rien par frame.
//   • SUIVI — la position monde existe DÉJÀ : le buffer antPose de pose.js
//     (3 vec4 par fourmi, frais chaque frame). Un noyau à 1 invocation copie
//     la télémétrie de la fourmi suivie dans un mini-buffer, relu en async
//     sous le verrou global de readback.js (« je passe mon tour » : la
//     cadence s'auto-régule, jamais de stall).
//   • SURBRILLANCE — assurée par ants.js (mesh `followMesh` : copie VAT de
//     la seule fourmi suivie, jaune émissive, sans test de profondeur →
//     visible à travers tout). Ici on ne gère que la logique et le HUD.
//
// Le picking lit le MÊME antPose que le rendu : la sélection vise exactement
// ce que l'écran montre, LOD et ragdoll compris.

import * as THREE from 'three/webgpu';
import {
	Fn, If, instanceIndex, uniform, instancedArray,
	uint, dot, min, atomicMin, atomicStore, atomicLoad, vec4,
} from 'three/tsl';

import { params, MAX_ANTS, TEXEL } from './config.js';
import { tryAcquireReadback, releaseReadback } from './readback.js';
import {
	ANT_CASTE,
	classifyAntObservation,
	createAntMotionTracker,
} from './ant-observer.js';

const PICK_PX = 26;          // rayon de tolérance du clic (pixels CSS)
const JUMP_U = 1.2;          // saut suspect (unités monde entre deux readbacks)

export function createAntFollow( { sim, pose, renderer, camera, controls } ) {

	const antPose = pose.antPose;

	// --- buffers minuscules (lus en async, jamais de stall) ---
	const pickBuf = instancedArray( 1, 'uint' ).toAtomic();
	// [0] position+échelle · [1] phase/venin/caste/drapeaux · [2] antDyn brut
	// antDyn est polymorphe :
	//   surface    = (vx, vz, hauteur, vitesse verticale)
	//   souterrain = (corridor, progression 0..1, profondeur du sol, distance cumulee)
	// Le bit souterrain des drapeaux choisit le decodeur CPU approprie.
	// [3] énergie, état, nappe, attaque
	// [4] objectif, nœud, repos exact, temps restant de repos
	// [5] stocks grenier/reine/couvain, faim
	// [6] chrono de ponte (capacité restante réservée aux diagnostics)
	const followBuf = instancedArray( 7, 'vec4' );

	const uRO = uniform( new THREE.Vector3() );       // rayon du clic : origine
	const uRD = uniform( new THREE.Vector3( 0, 0, - 1 ) ); // ... et direction
	const uFollowIdx = uniform( 0, 'uint' );

	// ------------------------------------------------------------------
	// PICKING : le uint partagé contient (metricQ << 16) | index ; atomicMin
	// garde la fourmi la plus proche ANGULAIREMENT du rayon du clic.
	// metricQ = tan²(angle) × 1e6, plafonné à 65535 — largement assez fin
	// pour discriminer deux fourmis côte à côte à l'écran.
	// ------------------------------------------------------------------
	const kPickReset = Fn( () => {

		atomicStore( pickBuf.element( 0 ), uint( 0xFFFFFFFF ) );

	} )().compute( 1 );

	const kPick = Fn( () => {

		If( instanceIndex.toFloat().lessThan( sim.u.antCount ), () => {

			const b = instanceIndex.mul( uint( 3 ) );
			const p = antPose.element( b );                 // xyz monde + gabarit
			const m = antPose.element( b.add( uint( 2 ) ) ); // phase, venin, caste, drapeaux
			// drapeaux = kind + 4·souterraine + 8·reine + 16·porteuse (pose.js) :
			// seules les VIVANTES (kind 0) sont sélectionnables — suivre un
			// cadavre n'aide pas à déboguer un déplacement.
			If( m.w.mod( 4 ).lessThan( 0.5 ), () => {

				const toA = p.xyz.sub( uRO );
				const t = dot( toA, uRD );
				If( t.greaterThan( 0.5 ), () => {

					const metric = dot( toA, toA ).sub( t.mul( t ) ).div( t.mul( t ) );
					const mq = min( metric.mul( 1e6 ), 65535 ).toUint();
					atomicMin( pickBuf.element( 0 ),
						mq.shiftLeft( uint( 16 ) ).bitOr( instanceIndex ) );

				} );

			} );

		} );

	} )().compute( MAX_ANTS );

	// ------------------------------------------------------------------
	// SUIVI : copie de la fourmi sélectionnée — position monde + drapeaux,
	// état DYNAMIQUE brut (vitesse, hauteur balistique) et état SIMULATION
	// dépacké (énergie, état, nappe, attaque). 1 invocation, coût indécelable.
	// ------------------------------------------------------------------
	const kFollow = Fn( () => {

		const i = uFollowIdx;
		const b = i.mul( uint( 3 ) );
		followBuf.element( 0 ).assign( antPose.element( b ) );
		followBuf.element( 1 ).assign( antPose.element( b.add( uint( 2 ) ) ) );
		followBuf.element( 2 ).assign( sim.antDyn.element( i ) );
		const st = sim.antState.element( i );
		const vt = sim.antVital.element( i );
		const state = st.bitAnd( uint( 7 ) );
		const goal = st.shiftRight( uint( 4 ) ).bitAnd( uint( 7 ) );
		const node = st.shiftRight( uint( 7 ) ).bitAnd( uint( 127 ) );
		const hungry = sim.u.colonyOn.greaterThan( 0.5 ).and( vt.z.lessThan( sim.u.hungryHome ) );
		const caste = sim.casteOf( i );
		const rest = sim.restStateOf( i, state.equal( uint( 1 ) ), hungry, caste.isNurse );
		const observedResting = rest.resting.and( caste.isQueen.not() );
		const observedRestRemaining = rest.remaining.mul( caste.isQueen.not().toFloat() );
		followBuf.element( 3 ).assign( vec4(
			vt.z,                                        // énergie 0..1
			state.toFloat(),                             // état 0..3
			st.shiftRight( uint( 14 ) ).bitAnd( uint( 3 ) ).toFloat(),  // nappe
			st.shiftRight( uint( 24 ) ).bitAnd( uint( 1 ) ).toFloat(),  // attaque
		) );

		followBuf.element( 4 ).assign( vec4(
			goal.toFloat(), node.toFloat(), observedResting.toFloat(), observedRestRemaining,
		) );
		followBuf.element( 5 ).assign( vec4(
			atomicLoad( sim.food.element( sim.u.troughGranary.toInt() ) ).toFloat(),
			atomicLoad( sim.food.element( sim.u.troughQueen.toInt() ) ).toFloat(),
			atomicLoad( sim.food.element( sim.u.troughBrood.toInt() ) ).toFloat(),
			hungry.toFloat(),
		) );
		followBuf.element( 6 ).assign( vec4(
			sim.antData.element( i ).w, 0, 0, 0,
		) );

	} )().compute( 1 );

	// ------------------------------------------------------------------
	// Panneau HUD (créé une fois, caché par défaut). La surbrillance visuelle
	// de la fourmi, elle, vit dans ants.js (mesh `followMesh` jaune émissive,
	// visible à travers tout) — plus d'anneau flottant. Le panneau est
	// MULTI-LIGNES : tout ce qui sert à traquer le bug de téléportation —
	// état, énergie, vitesse simulée ET mesurée, compteur de sauts.
	// ------------------------------------------------------------------
	const hudStyle = document.createElement( 'style' );
	hudStyle.textContent = `
		#ant-inspector {
			position: fixed; left: 14px; top: 14px; z-index: 20;
			width: min(390px, calc(100vw - 28px)); box-sizing: border-box;
			padding: 12px 14px; border: 1px solid rgba(159, 199, 120, .35);
			border-radius: 10px; background: rgba(10, 15, 11, .9);
			box-shadow: 0 12px 35px rgba(0, 0, 0, .34);
			backdrop-filter: blur(8px); color: #e8eee3;
			font: 12px/1.45 system-ui, sans-serif; pointer-events: none;
			display: none; user-select: none;
		}
		#ant-inspector[data-tone="expected"] { border-color: rgba(244, 196, 92, .7); }
		#ant-inspector[data-tone="danger"] { border-color: #ff665c; box-shadow: 0 0 0 1px rgba(255, 102, 92, .25), 0 12px 35px rgba(0,0,0,.4); }
		#ant-inspector[data-tone="neutral"] { border-color: rgba(180, 180, 180, .45); }
		.ant-follow-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }
		.ant-follow-title { color:#f3d66d; font-weight:750; letter-spacing:.02em; text-transform:uppercase; }
		.ant-follow-place { padding:2px 7px; border-radius:999px; background:rgba(135,173,105,.16); color:#bcd6a7; font-size:10px; letter-spacing:.07em; }
		.ant-follow-intent { color:#fff; font-size:16px; font-weight:700; margin-bottom:2px; }
		.ant-follow-motion { color:#acd98d; font-weight:650; margin-bottom:7px; }
		#ant-inspector[data-tone="expected"] .ant-follow-motion { color:#f4c45c; }
		#ant-inspector[data-tone="danger"] .ant-follow-motion { color:#ff665c; }
		.ant-follow-reason { color:#b9c3b4; margin-bottom:10px; }
		.ant-follow-grid { display:grid; grid-template-columns:max-content 1fr; gap:3px 10px; padding-top:8px; border-top:1px solid rgba(255,255,255,.08); }
		.ant-follow-label { color:#74816f; }
		.ant-follow-value { color:#dce5d7; overflow-wrap:anywhere; }
		.ant-follow-alert { color:#ff756c; font-weight:700; margin-top:8px; }
		.ant-follow-help { color:#697366; font-size:10px; margin-top:9px; }
		@media (max-width: 620px) { #ant-inspector { top:8px; left:8px; width:calc(100vw - 16px); } }
	`;
	document.head.appendChild( hudStyle );

	const hud = document.createElement( 'section' );
	hud.id = 'ant-inspector';
	hud.setAttribute( 'aria-live', 'polite' );
	document.getElementById( 'app' ).appendChild( hud );

	// ------------------------------------------------------------------
	// État CPU de l'inspecteur. Le tracker ne coûte rien à la population :
	// il ne conserve que les échantillons de l'unique fourmi sélectionnée.
	// ------------------------------------------------------------------
	const position = new THREE.Vector3();
	const smoothPos = new THREE.Vector3();
	const prevPos = new THREE.Vector3();
	const motionTracker = createAntMotionTracker( { movingSpeed: 0.08 } );
	let selected = - 1;
	let hasPos = false;
	let hasSmooth = false;
	let hasPrev = false;
	let pickPending = false;
	let pickReading = false;
	let followReading = false;
	let lastHudText = '';
	let lastDiagnostic = null;
	let savedMinDistance = 0;
	let info = {
		energy: 0, venom: 0, state: 0, layer: 0, attacking: 0,
		speed: 0, measSpeed: 0, stationarySeconds: 0,
		corridor: - 1, progress: 0, floorDepth: 0, distance: 0,
		goal: 0, node: 0, resting: false, restRemaining: 0, hungry: false,
		granaryStock: 0, queenStock: 0, broodStock: 0, layTimer: 0,
	};
	let jumpCount = 0;
	let lastJumpMag = 0;
	let lastJumpAt = - 1e9;

	function buildHud( flags, rawCaste ) {

		const under = ( Math.floor( flags / 4 ) % 2 ) === 1;
		const isQueen = ( Math.floor( flags / 8 ) % 2 ) === 1;
		const carrying = ( Math.floor( flags / 16 ) % 2 ) === 1;
		const caste = isQueen ? ANT_CASTE.QUEEN : rawCaste;
		const goalNode = sim.layout.GOAL_NODE?.[ info.goal ];
		const atGoal = under && info.corridor < 0.5
			&& Number.isFinite( goalNode ) && info.node === goalNode;
		const diagnostic = classifyAntObservation( {
			id: selected, state: info.state, caste, isQueen, under, carrying,
			attacking: Boolean( info.attacking ), goal: info.goal, node: info.node,
			atGoal, resting: info.resting, restRemaining: info.restRemaining,
			hungry: info.hungry, energy: info.energy, venom: info.venom,
			granaryStock: info.granaryStock, queenStock: info.queenStock,
			broodStock: info.broodStock, layTimer: info.layTimer,
			layInterval: params.queenLayInterval, layEnergyMin: params.queenLayMin,
			stationarySeconds: info.stationarySeconds, measuredSpeed: info.measSpeed,
			corridor: info.corridor, progress: info.progress,
		} );

		lastDiagnostic = {
			...diagnostic, id: selected, under, carrying, atGoal,
			position: { x: position.x, y: position.y, z: position.z },
			telemetry: { ...info }, jumpCount,
		};

		const place = under ? `SOUTERRAIN · NAPPE ${ info.layer }` : 'SURFACE';
		const route = isQueen
			? `Chambre royale · ponte ${ info.layTimer.toFixed( 1 ) } / ${ params.queenLayInterval.toFixed( 1 ) } s`
			: under
				? ( info.corridor > 0
					? `Corridor ${ info.corridor } · ${ ( info.progress * 100 ).toFixed( 1 ) } % · nœud ${ info.node }`
					: `Zone sûre du nœud ${ info.node }` )
				: 'Navigation par pistes de phéromones';
		const stocks = `grenier ${ info.granaryStock } · reine ${ info.queenStock } · couvain ${ info.broodStock }`;
		const recentJump = performance.now() - lastJumpAt < 2500;
		const jump = jumpCount > 0
			? `<div class="ant-follow-alert">⚠ ${ jumpCount } saut${ jumpCount > 1 ? 's' : '' } détecté${ jumpCount > 1 ? 's' : '' } · dernier ${ lastJumpMag.toFixed( 1 ) } u</div>`
			: '';

		return {
			tone: recentJump ? 'danger' : diagnostic.tone,
			html: `<div class="ant-follow-head">
				<div class="ant-follow-title">Fourmi #${ selected } · ${ diagnostic.casteLabel }</div>
				<div class="ant-follow-place">${ place }</div>
			</div>
			<div class="ant-follow-intent">${ diagnostic.intentLabel }</div>
			<div class="ant-follow-motion">${ diagnostic.motionLabel }</div>
			<div class="ant-follow-reason">${ diagnostic.reason }</div>
			<div class="ant-follow-grid">
				<div class="ant-follow-label">Objectif</div><div class="ant-follow-value">${ diagnostic.goalLabel }</div>
				<div class="ant-follow-label">Route</div><div class="ant-follow-value">${ route }</div>
				<div class="ant-follow-label">État réel</div><div class="ant-follow-value">${ diagnostic.stateLabel }${ carrying ? ' · charge en bouche' : '' }</div>
				<div class="ant-follow-label">Vitalité</div><div class="ant-follow-value">énergie ${ Math.round( info.energy * 100 ) } % · venin ${ Math.round( info.venom * 100 ) } %${ info.hungry ? ' · faim' : '' }</div>
				<div class="ant-follow-label">Mouvement</div><div class="ant-follow-value">${ info.measSpeed.toFixed( 2 ) } u/s · distance route ${ info.distance.toFixed( 2 ) } u</div>
				<div class="ant-follow-label">Stocks</div><div class="ant-follow-value">${ stocks }</div>
				<div class="ant-follow-label">Position</div><div class="ant-follow-value">${ position.x.toFixed( 2 ) }, ${ position.y.toFixed( 2 ) }, ${ position.z.toFixed( 2 ) }</div>
			</div>${ jump }
			<div class="ant-follow-help">Molette : zoom · clic vide / Échap : lâcher</div>`,
		};

	}

	function setHud( view ) {

		if ( ! view ) {

			lastHudText = '';
			hud.innerHTML = '';
			hud.style.display = 'none';
			return;

		}

		const html = typeof view === 'string' ? view : view.html;
		if ( html === lastHudText ) return;
		lastHudText = html;
		hud.innerHTML = html;
		hud.dataset.tone = typeof view === 'string' ? 'neutral' : view.tone;
		hud.style.display = 'block';

	}

	function select( index ) {

		if ( index < 0 || index >= params.antCount ) return;
		selected = index;
		hasPos = false;
		hasSmooth = false;
		hasPrev = false;
		jumpCount = 0;
		info.measSpeed = 0;
		info.stationarySeconds = 0;
		lastJumpAt = - 1e9;
		lastDiagnostic = null;
		motionTracker.reset();
		uFollowIdx.value = index;
		savedMinDistance = controls.minDistance;
		controls.minDistance = 0.8;
		setHud( `<div class="ant-follow-title">Fourmi #${ index }</div><div class="ant-follow-reason">Lecture de son état réel…</div>` );

	}

	function clear() {

		if ( selected < 0 ) return;
		selected = - 1;
		hasPos = false;
		lastDiagnostic = null;
		motionTracker.reset();
		controls.minDistance = savedMinDistance;
		setHud( null );

	}

	// Clic gauche converti en rayon monde, à dispatcher au prochain tour.
	function requestPick( ro, rd ) {

		uRO.value.copy( ro );
		uRD.value.copy( rd );
		pickPending = true;

	}

	// À appeler APRÈS ants.tick() : antPose est frais, les dispatches lisent la
	// pose de la frame courante.
	function update( dt ) {

		// --- picking : dispatch puis lecture du résultat quand le verrou le
		// permet (les dispatches, eux, n'ont pas besoin du verrou) ---
		if ( pickPending ) {

			renderer.compute( [ kPickReset, kPick ] );
			pickPending = false;
			pickReading = true;

		}

		if ( pickReading && ! followReading && tryAcquireReadback() ) {

			pickReading = false;
			renderer.getArrayBufferAsync( pickBuf.value ).then( ( buf ) => {

				releaseReadback();
				const packed = new Uint32Array( buf )[ 0 ];
				if ( packed === 0xFFFFFFFF ) { clear(); return; }   // clic dans le vide

				const mq = ( packed >>> 16 ) / 1e6;
				// tolérance angulaire : PICK_PX pixels CSS à l'écran
				const tanHalf = Math.tan( camera.fov * Math.PI / 360 );
				const frac = 2 * tanHalf * PICK_PX / renderer.domElement.clientHeight;
				if ( mq > frac * frac ) { clear(); return; }

				select( packed & 0xFFFF );

			} ).catch( releaseReadback );

		}

		// --- suivi : copie GPU puis readback async (cadence auto-régulée par
		// le verrou global : on ne s'empile jamais) ---
		if ( selected < 0 ) return;

		renderer.compute( kFollow );

		if ( ! followReading && ! pickReading && tryAcquireReadback() ) {

			followReading = true;
			renderer.getArrayBufferAsync( followBuf.value ).then( ( buf ) => {

				releaseReadback();
				followReading = false;
				const f = new Float32Array( buf );
				position.set( f[ 0 ], f[ 1 ], f[ 2 ] );
				hasPos = true;

				const kind = f[ 7 ] % 4;
				if ( kind >= 1.5 && kind < 2.5 ) { clear(); return; }  // dévorée

				// --- télémétrie + DÉTECTION DE SAUT (le bug qu'on traque) ---
				// Un déplacement supérieur à JUMP_U entre deux readbacks est
				// impossible pour une marche normale (≤ ~0,1 u) : c'est une
				// téléportation. Comptée, datée, et flashée en rouge au HUD.
				const now = performance.now();
				info.venom = f[ 5 ];
				info.speed = Math.hypot( f[ 8 ], f[ 9 ] ) * TEXEL;
				info.energy = f[ 12 ];
				info.state = Math.round( f[ 13 ] );
				info.layer = Math.round( f[ 14 ] );
				info.attacking = Math.round( f[ 15 ] );
				info.goal = Math.round( f[ 16 ] );
				info.node = Math.round( f[ 17 ] );
				info.resting = f[ 18 ] > 0.5;
				info.restRemaining = Math.max( 0, f[ 19 ] );
				info.granaryStock = Math.max( 0, Math.round( f[ 20 ] ) );
				info.queenStock = Math.max( 0, Math.round( f[ 21 ] ) );
				info.broodStock = Math.max( 0, Math.round( f[ 22 ] ) );
				info.hungry = f[ 23 ] > 0.5;
				info.layTimer = Math.max( 0, f[ 24 ] );

				const under = ( Math.floor( f[ 7 ] / 4 ) % 2 ) === 1;

				if ( under ) {

					// Coordonnées intrinsèques exactes du réseau de corridors.
					info.corridor = Math.round( f[ 8 ] );
					info.progress = f[ 9 ];
					info.floorDepth = f[ 10 ];
					info.distance = f[ 11 ];
					info.speed = 0;

				} else {

					info.corridor = 0;
					info.progress = 0;
					info.floorDepth = 0;
					info.distance = 0;

				}

				const motion = motionTracker.sample( {
					id: selected,
					timeMs: now,
					position,
				} );
				info.measSpeed = motion.measuredSpeed;
				info.stationarySeconds = motion.stationarySeconds;

				if ( hasPrev ) {

					const d = position.distanceTo( prevPos );
					if ( d > JUMP_U ) {

						jumpCount ++;
						lastJumpMag = d;
						lastJumpAt = now;

					}

				}
				prevPos.copy( position );
				hasPrev = true;

				setHud( buildHud( f[ 7 ], Math.round( f[ 6 ] ) ) );

			} ).catch( ( e ) => { releaseReadback(); followReading = false; } );

		}

		// Caméra STABILISÉE sur la fourmi : la cible est lissée (le rebond de
		// démarche, bob, ne secoue plus la caméra) MAIS un saut de position —
		// la téléportation qu'on traque — est recopié d'un coup : il reste
		// visible comme un bond net, jamais masqué par le lissage.
		if ( hasPos ) {

			if ( ! hasSmooth ) { smoothPos.copy( position ); hasSmooth = true; }
			if ( position.distanceTo( smoothPos ) > JUMP_U ) smoothPos.copy( position );
			else smoothPos.lerp( position, 1 - Math.exp( - Math.min( dt, 0.1 ) * 9 ) );
			controls.target.copy( smoothPos );

		}

	}

	function diagnostics() {

		if ( ! lastDiagnostic ) return null;
		return { ...lastDiagnostic, position: { ...lastDiagnostic.position }, telemetry: { ...lastDiagnostic.telemetry } };

	}

	return {
		update,
		requestPick,
		select,
		clear,
		diagnostics,
		position,
		get selected() { return selected; },
	};

}
