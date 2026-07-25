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
	uint, dot, min, atomicMin, atomicStore,
} from 'three/tsl';

import { params, MAX_ANTS } from './config.js';
import { tryAcquireReadback, releaseReadback } from './readback.js';

const PICK_PX = 26;          // rayon de tolérance du clic (pixels CSS)
const CASTES = [ 'ouvrière', 'soldate', 'nourrice', 'éclaireuse' ];

export function createAntFollow( { sim, pose, renderer, camera, controls } ) {

	const antPose = pose.antPose;

	// --- buffers minuscules (lus en async, jamais de stall) ---
	const pickBuf = instancedArray( 1, 'uint' ).toAtomic();
	const followBuf = instancedArray( 2, 'vec4' );

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
	// SUIVI : copie les 2 vec4 utiles de la fourmi sélectionnée (position
	// monde + drapeaux/caste). 1 invocation, coût indécelable.
	// ------------------------------------------------------------------
	const kFollow = Fn( () => {

		const b = uFollowIdx.mul( uint( 3 ) );
		followBuf.element( 0 ).assign( antPose.element( b ) );
		followBuf.element( 1 ).assign( antPose.element( b.add( uint( 2 ) ) ) );

	} )().compute( 1 );

	// ------------------------------------------------------------------
	// Pastille HUD (créée une fois, cachée par défaut). La surbrillance
	// visuelle de la fourmi, elle, vit dans ants.js (mesh `followMesh`
	// jaune émissive, visible à travers tout) — plus d'anneau flottant.
	// ------------------------------------------------------------------
	const hud = document.createElement( 'div' );
	hud.style.cssText = 'position:absolute;left:50%;bottom:34px;transform:translateX(-50%);'
		+ 'padding:4px 12px;border-radius:6px;background:rgba(10,14,10,.72);'
		+ 'color:#ffd24a;font:12px/1.4 monospace;pointer-events:none;display:none;'
		+ 'white-space:nowrap;z-index:5';
	document.getElementById( 'app' ).appendChild( hud );

	// ------------------------------------------------------------------
	// État
	// ------------------------------------------------------------------
	const position = new THREE.Vector3();    // dernière position connue (CPU)
	let selected = - 1;
	let hasPos = false;                      // vrai après le 1er readback de suivi
	let pickPending = false;                 // un clic attend son dispatch
	let pickReading = false;                 // un readback de picking est en vol
	let followReading = false;               // un readback de suivi est en vol
	let lastHudText = '';
	let savedMinDistance = 0;

	function describe( flags, caste ) {

		const under = ( Math.floor( flags / 4 ) % 2 ) === 1;
		const queen = ( Math.floor( flags / 8 ) % 2 ) === 1;
		const name = queen ? 'reine' : CASTES[ caste ] || 'ouvrière';
		return `#${ selected } ${ name } · ${ under ? 'souterraine' : 'surface' }`
			+ ' — molette : zoom · clic vide / Échap : lâcher';

	}

	function setHud( text ) {

		if ( text === lastHudText ) return;
		lastHudText = text;
		hud.textContent = text;
		hud.style.display = text ? 'block' : 'none';

	}

	function select( index ) {

		if ( index < 0 || index >= params.antCount ) return;
		selected = index;
		hasPos = false;
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
				setHud( describe( f[ 7 ], Math.round( f[ 6 ] ) ) );

			} ).catch( ( e ) => { releaseReadback(); followReading = false; } );

		}

		// caméra collée à la fourmi : PAS de lissage — un saut de position
		// (le bug qu'on traque) doit se voir comme un saut de la cible
		if ( hasPos ) controls.target.copy( position );

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
