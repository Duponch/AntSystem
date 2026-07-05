// Caméra cinématique contemplative : enchaîne des plans variés (orbite lente,
// travelling, grue, suivi d'une fourmi, panoramique au ras de l'herbe) avec
// des coupes en fondu au noir. Le suivi de fourmi lit sa position GPU (16
// octets toutes les ~0.3 s). Un clic sur le canvas rend la main.

import * as THREE from 'three/webgpu';
import { gridToWorld, GRID, WORLD } from '../config.js';
import { SEED_BLOBS, } from '../simulation.js';

const ease = ( t ) => t * t * ( 3 - 2 * t );

export function createCinematic( { camera, controls, sim, renderer, onStop } ) {

	// fondu au noir pour les coupes
	const fade = document.createElement( 'div' );
	fade.style.cssText =
		'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;' +
		'transition:opacity .45s ease;z-index:5;';
	document.body.appendChild( fade );

	// points d'intérêt : nid + gisements (coordonnées monde)
	const POIS = [
		new THREE.Vector3( 0, 0, 0 ),
		...SEED_BLOBS.map( ( b ) => {

			const g = gridToWorld(
				GRID / 2 + Math.cos( b.angle ) * b.dist,
				GRID / 2 + Math.sin( b.angle ) * b.dist,
			);
			return new THREE.Vector3( g.x, 0, g.z );

		} ),
	];

	// suivi d'une fourmi : lecture GPU périodique, position lissée
	const antWorld = new THREE.Vector3( 0, 0, 0 );
	const antSmooth = new THREE.Vector3( 0, 0, 0 );
	let antIndex = 0;
	let antPollAccum = 1;
	let antReading = false;

	async function pollAnt() {

		if ( antReading ) return;
		antReading = true;

		try {

			const buf = await renderer.getArrayBufferAsync( sim.antData.value, null, antIndex * 16, 16 );
			const d = new Float32Array( buf );
			const w = gridToWorld( d[ 0 ], d[ 1 ] );
			antWorld.set( w.x, 0, w.z );

		} catch {

			/* device occupé : on garde la dernière position */

		} finally {

			antReading = false;

		}

	}

	// --- plans ---
	let enabled = false;
	let shot = null;
	let tShot = 0;
	let cutting = false;
	let lastType = '';

	const TYPES = [ 'orbit', 'dolly', 'crane', 'follow', 'lowpan' ];

	function pickShot() {

		let type = TYPES[ Math.floor( Math.random() * TYPES.length ) ];
		if ( type === lastType ) type = TYPES[ ( TYPES.indexOf( type ) + 1 ) % TYPES.length ];
		lastType = type;

		const poi = POIS[ Math.floor( Math.random() * POIS.length ) ].clone();
		const a0 = Math.random() * Math.PI * 2;
		const s = {
			type,
			poi,
			duration: 9 + Math.random() * 5,
			a0,
			radius: 7 + Math.random() * 9,
			height: 1.6 + Math.random() * 4,
			dir: Math.random() < 0.5 ? 1 : - 1,
			speed: 0.06 + Math.random() * 0.08,
		};

		if ( type === 'follow' ) {

			antIndex = Math.floor( Math.random() * Math.min( 869, 4096 ) );
			antSmooth.copy( antWorld );

		}

		if ( type === 'dolly' ) {

			s.from = poi.clone().add( new THREE.Vector3( Math.cos( a0 ) * 16, 1.2, Math.sin( a0 ) * 16 ) );
			s.to = poi.clone().add( new THREE.Vector3( Math.cos( a0 + 0.7 ) * 6, 2.2, Math.sin( a0 + 0.7 ) * 6 ) );

		}

		if ( type === 'lowpan' ) {

			s.pos = poi.clone().add( new THREE.Vector3( Math.cos( a0 ) * 9, 0.8, Math.sin( a0 ) * 9 ) );
			s.lookA = poi.clone().add( new THREE.Vector3( Math.cos( a0 + 1.4 ) * 7, 0.3, Math.sin( a0 + 1.4 ) * 7 ) );
			s.lookB = poi.clone().add( new THREE.Vector3( Math.cos( a0 - 1.4 ) * 7, 0.3, Math.sin( a0 - 1.4 ) * 7 ) );

		}

		tShot = 0;
		shot = s;

	}

	function applyShot( dt ) {

		const p = Math.min( 1, tShot / shot.duration );
		const e = ease( p );
		const poi = shot.poi;

		if ( shot.type === 'orbit' ) {

			const a = shot.a0 + tShot * shot.speed * shot.dir * Math.PI;
			camera.position.set(
				poi.x + Math.cos( a ) * shot.radius,
				shot.height + Math.sin( tShot * 0.1 ) * 0.4,
				poi.z + Math.sin( a ) * shot.radius,
			);
			camera.lookAt( poi.x, 0.4, poi.z );

		} else if ( shot.type === 'dolly' ) {

			camera.position.lerpVectors( shot.from, shot.to, e );
			camera.lookAt( poi.x, 0.3, poi.z );

		} else if ( shot.type === 'crane' ) {

			const a = shot.a0 + tShot * 0.05 * shot.dir;
			const h = 1.2 + e * 16;
			const r = shot.radius * ( 1 - e * 0.35 );
			camera.position.set( poi.x + Math.cos( a ) * r, h, poi.z + Math.sin( a ) * r );
			camera.lookAt( poi.x, 0, poi.z );

		} else if ( shot.type === 'follow' ) {

			antPollAccum += dt;

			if ( antPollAccum > 0.3 ) {

				antPollAccum = 0;
				pollAnt();

			}

			antSmooth.lerp( antWorld, 1 - Math.exp( - dt * 2.5 ) );
			const a = shot.a0 + tShot * 0.05 * shot.dir;
			camera.position.set(
				antSmooth.x + Math.cos( a ) * 3.2,
				1.5 + Math.sin( tShot * 0.15 ) * 0.3,
				antSmooth.z + Math.sin( a ) * 3.2,
			);
			camera.lookAt( antSmooth.x, 0.25, antSmooth.z );

		} else {

			// lowpan : trépied au ras de l'herbe, panoramique lent
			camera.position.copy( shot.pos );
			const look = new THREE.Vector3().lerpVectors( shot.lookA, shot.lookB, e );
			camera.lookAt( look );

		}

	}

	function update( dt ) {

		if ( ! enabled || ! shot ) return;

		tShot += dt;
		applyShot( dt );

		if ( tShot >= shot.duration && ! cutting ) {

			cutting = true;
			fade.style.opacity = '1';

			setTimeout( () => {

				if ( enabled ) pickShot();
				fade.style.opacity = '0';
				cutting = false;

			}, 470 );

		}

	}

	function setEnabled( on ) {

		if ( on === enabled ) return;
		enabled = on;

		if ( on ) {

			controls.enabled = false;
			pollAnt();
			pickShot();

		} else {

			controls.enabled = true;
			fade.style.opacity = '0';

			// rend la main proprement : la cible d'orbite devant la caméra
			const look = new THREE.Vector3();
			camera.getWorldDirection( look );
			controls.target.copy( camera.position ).addScaledVector( look, 12 );

		}

	}

	// un clic sur la vue rend la main (et resynchronise la case de l'UI)
	let boundCtrl = null;

	renderer.domElement.addEventListener( 'pointerdown', () => {

		if ( enabled ) {

			setEnabled( false );
			if ( boundCtrl ) boundCtrl.setValue( false );
			if ( onStop ) onStop();

		}

	} );

	return {
		update,
		setEnabled,
		bindController( ctrl ) {

			boundCtrl = ctrl;

		},
	};

}
