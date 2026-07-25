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
//     les 32 octets de la fourmi suivie dans un mini-buffer, relu en async
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
	uint, dot, min, atomicMin, atomicStore, vec4,
} from 'three/tsl';

import { params, MAX_ANTS, TEXEL } from './config.js';
import { tryAcquireReadback, releaseReadback } from './readback.js';

const PICK_PX = 26;          // rayon de tolérance du clic (pixels CSS)
const JUMP_U = 1.2;          // saut suspect (unités monde entre deux readbacks)
const CASTES = [ 'ouvrière', 'soldate', 'nourrice', 'éclaireuse' ];
const ETATS = [ 'exploratrice', 'porteuse', 'cadavre', 'dévorée' ];

export function createAntFollow( { sim, pose, renderer, camera, controls } ) {

	const antPose = pose.antPose;

	// --- buffers minuscules (lus en async, jamais de stall) ---
	const pickBuf = instancedArray( 1, 'uint' ).toAtomic();
	// [0] position+échelle · [1] phase/venin/caste/drapeaux · [2] antDyn brut
	// [3] énergie, état, nappe, attaque (dépackés côté GPU, zéro décodage CPU)
	const followBuf = instancedArray( 4, 'vec4' );

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
		followBuf.element( 3 ).assign( vec4(
			vt.z,                                        // énergie 0..1
			st.bitAnd( uint( 7 ) ).toFloat(),            // état 0..3
			st.shiftRight( uint( 14 ) ).bitAnd( uint( 3 ) ).toFloat(),  // nappe
			st.shiftRight( uint( 24 ) ).bitAnd( uint( 1 ) ).toFloat(),  // attaque
		) );

	} )().compute( 1 );

	// ------------------------------------------------------------------
	// Panneau HUD (créé une fois, caché par défaut). La surbrillance visuelle
	// de la fourmi, elle, vit dans ants.js (mesh `followMesh` jaune émissive,
	// visible à travers tout) — plus d'anneau flottant. Le panneau est
	// MULTI-LIGNES : tout ce qui sert à traquer le bug de téléportation —
	// état, énergie, vitesse simulée ET mesurée, compteur de sauts.
	// ------------------------------------------------------------------
	const hud = document.createElement( 'div' );
	hud.style.cssText = 'position:absolute;left:12px;bottom:34px;'
		+ 'padding:6px 10px;border-radius:6px;background:rgba(10,14,10,.78);'
		+ 'color:#ffd24a;font:11px/1.45 monospace;pointer-events:none;display:none;'
		+ 'white-space:pre;z-index:5';
	document.getElementById( 'app' ).appendChild( hud );

	// ------------------------------------------------------------------
	// État
	// ------------------------------------------------------------------
	const position = new THREE.Vector3();    // dernière position connue (CPU)
	const smoothPos = new THREE.Vector3();   // cible caméra stabilisée
	const prevPos = new THREE.Vector3();     // position au readback précédent
	let selected = - 1;
	let hasPos = false;                      // vrai après le 1er readback de suivi
	let hasSmooth = false;
	let hasPrev = false;
	let pickPending = false;                 // un clic attend son dispatch
	let pickReading = false;                 // un readback de picking est en vol
	let followReading = false;               // un readback de suivi est en vol
	let lastHudText = '';
	let savedMinDistance = 0;
	// infos dépackées du readback (pour le HUD) et détection de saut
	let info = { energy: 0, venom: 0, state: 0, layer: 0, attacking: 0, speed: 0, measSpeed: 0 };
	let jumpCount = 0;
	let lastJumpMag = 0;
	let lastJumpAt = - 1e9;
	let lastReadAt = 0;

	function buildHud( flags, caste ) {

		const under = ( Math.floor( flags / 4 ) % 2 ) === 1;
		const queen = ( Math.floor( flags / 8 ) % 2 ) === 1;
		const carrying = ( Math.floor( flags / 16 ) % 2 ) === 1;
		const name = queen ? 'reine' : CASTES[ caste ] || 'ouvrière';
		const lieu = under ? `souterraine (nappe ${ info.layer })` : 'surface';
		const act = ETATS[ info.state ] || '?';
		const l1 = `#${ selected } ${ name } · ${ lieu } · ${ act }`
			+ ( carrying ? ' · transporte' : '' )
			+ ( info.attacking ? ' · ATTAQUE' : '' );
		const l2 = `énergie ${ ( info.energy * 100 ).toFixed( 0 ) } % · venin ${ ( info.venom * 100 ).toFixed( 0 ) } %`
			+ ` · v ${ info.speed.toFixed( 2) } u/s (mesurée ${ info.measSpeed.toFixed( 2 ) })`;
		const l3 = `pos ${ position.x.toFixed( 2 ) }, ${ position.y.toFixed( 2 ) }, ${ position.z.toFixed( 2 ) }`;
		const l4 = jumpCount > 0
			? `⚠ ${ jumpCount } saut${ jumpCount > 1 ? 's' : '' } — dernier +${ lastJumpMag.toFixed( 1 ) } u il y a ${ ( ( performance.now() - lastJumpAt ) / 1000 ).toFixed( 1 ) } s`
			: null;
		return [ l1, l2, l3, l4, 'molette : zoom · clic vide / Échap : lâcher' ]
			.filter( Boolean ).join( '\n' );

	}

	function setHud( text ) {

		if ( text === lastHudText ) return;
		lastHudText = text;
		hud.textContent = text;
		hud.style.display = text ? 'block' : 'none';
		// rouge vif tant qu'un saut est récent : l'anomalie ne passe pas inaperçue
		hud.style.color = ( performance.now() - lastJumpAt < 2500 ) ? '#ff5a4a' : '#ffd24a';

	}

	function select( index ) {

		if ( index < 0 || index >= params.antCount ) return;
		selected = index;
		hasPos = false;
		hasSmooth = false;
		hasPrev = false;
		jumpCount = 0;
		lastJumpAt = - 1e9;
		uFollowIdx.value = index;
		savedMinDistance = controls.minDistance;
		controls.minDistance = 0.8;      // inspection rapprochée de la fourmi
		setHud( `#${ index } — en approche…` );

	}

	function clear() {

		if ( selected < 0 ) return;
		selected = - 1;
		hasPos = false;
		controls.minDistance = savedMinDistance;
		setHud( '' );

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
				info.speed = Math.hypot( f[ 8 ], f[ 9 ] ) * TEXEL;   // texels/s → u/s
				info.energy = f[ 12 ];
				info.state = Math.round( f[ 13 ] );
				info.layer = Math.round( f[ 14 ] );
				info.attacking = Math.round( f[ 15 ] );

				if ( hasPrev ) {

					const d = position.distanceTo( prevPos );
					info.measSpeed = d / Math.max( ( now - lastReadAt ) / 1000, 1e-3 );
					if ( d > JUMP_U ) {

						jumpCount ++;
						lastJumpMag = d;
						lastJumpAt = now;

					}

				}
				prevPos.copy( position );
				hasPrev = true;
				lastReadAt = now;

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

	return {
		update,
		requestPick,
		select,
		clear,
		position,
		get selected() { return selected; },
	};

}
