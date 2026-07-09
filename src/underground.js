// Vue en fosse de la fourmilière : quand « Vue souterraine » est activée,
// le sol et le socle DISCARDENT leurs fragments dans un disque autour du nid
// (voir environment.js), révélant un diorama creusé dans la terre :
//   - plancher continu généré depuis la carte de profondeur du layout
//     (même source de vérité que le y des fourmis souterraines) ;
//   - paroi circulaire de la découpe (l'épaisseur de terre du bord) ;
//   - lueur chaude discrète pour rester lisible en pleine nuit.
//
// L'ouverture est animée (rayon qui s'étend), l'herbe s'efface dans le
// disque, la fourmilière (GLB) se retire le temps de la vue.

import * as THREE from 'three/webgpu';
import {
	Fn, positionWorld, vec3, float, color, mix, clamp, smoothstep, mx_noise_float,
} from 'three/tsl';

import { GRID, WORLD, NEST, gfx } from './config.js';
import { uPitR } from './environment.js';
import { DEPTH_SIZE } from './colony.js';

const TEXEL = WORLD / GRID;

export function createUnderground( { scene, layout, env, grass, camera } ) {

	const group = new THREE.Group();
	group.visible = true;   // occlus naturellement par le sol tant que la vue est fermée
	scene.add( group );

	// ------------------------------------------------------------------
	// Plancher : grille sur la région de profondeur (construit une fois)
	// ------------------------------------------------------------------
	const RES = 160;                                   // sommets par côté
	const SIZE = DEPTH_SIZE * TEXEL;                   // étendue monde de la région
	const SHELF = - 0.3;                               // « épaule » de terre non creusée

	const geo = new THREE.PlaneGeometry( SIZE, SIZE, RES - 1, RES - 1 ).rotateX( - Math.PI / 2 );
	const pos = geo.attributes.position;
	const centerX = ( NEST.x / GRID - 0.5 ) * WORLD;
	const centerZ = ( NEST.y / GRID - 0.5 ) * WORLD;

	for ( let i = 0; i < pos.count; i ++ ) {

		const wx = pos.getX( i ) + centerX;
		const wz = pos.getZ( i ) + centerZ;
		const gx = wx / TEXEL + GRID / 2;               // → texels grille
		const gy = wz / TEXEL + GRID / 2;
		const d = layout.depthAt( gx, gy );

		// micro-relief pour casser l'aspect plastique
		const n = ( Math.sin( gx * 1.7 ) * Math.cos( gy * 2.3 ) ) * 0.045;
		pos.setY( i, Math.min( d, SHELF ) + n );
		pos.setX( i, pos.getX( i ) + centerX );
		pos.setZ( i, pos.getZ( i ) + centerZ );

	}

	geo.computeVertexNormals();

	const floorMat = new THREE.MeshStandardNodeMaterial( { roughness: 0.96, metalness: 0 } );

	floorMat.colorNode = Fn( () => {

		// terre : plus sombre en profondeur, bruit organique
		const depthT = clamp( positionWorld.y.negate().div( 4.2 ), 0, 1 );
		const n = mx_noise_float( positionWorld.xz.mul( 0.9 ) ).mul( 0.5 ).add( 0.5 );
		const base = mix( color( 0x4a331e ), color( 0x241708 ), depthT );
		return base.mul( n.mul( 0.35 ).add( 0.75 ) );

	} )();

	// lisible de nuit : la terre garde une lueur interne discrète
	floorMat.emissiveNode = Fn( () => {

		const depthT = clamp( positionWorld.y.negate().div( 4.2 ), 0, 1 );
		return mix( color( 0x1a1208 ), color( 0x2e1c0d ), depthT ).mul( 0.4 );

	} )();

	// DoubleSide : vue rasante depuis l'extérieur de la carte, le dessous des
	// chambres reste de la terre (jamais de trou de backface-culling)
	floorMat.side = THREE.DoubleSide;

	const floor = new THREE.Mesh( geo, floorMat );
	floor.receiveShadow = false;
	group.add( floor );

	// ------------------------------------------------------------------
	// Paroi de la découpe : anneau de terre entre le sol (y=0) et l'épaule
	// ------------------------------------------------------------------
	const rimGeo = new THREE.CylinderGeometry( 1, 1, 1, 96, 1, true );
	const rimMat = new THREE.MeshStandardNodeMaterial( {
		roughness: 1, metalness: 0, side: THREE.BackSide,
	} );
	rimMat.colorNode = Fn( () => {

		const n = mx_noise_float( positionWorld.xz.mul( 1.4 ).add( positionWorld.y.mul( 3 ) ) )
			.mul( 0.5 ).add( 0.5 );
		return color( 0x33241a ).mul( n.mul( 0.4 ).add( 0.7 ) );

	} )();

	const rim = new THREE.Mesh( rimGeo, rimMat );
	rim.position.set( centerX, SHELF / 2, centerZ );
	group.add( rim );

	// ------------------------------------------------------------------
	// Lueur chaude de la fourmilière (uniquement quand la vue est ouverte)
	// ------------------------------------------------------------------
	const glow = new THREE.PointLight( 0xffb060, 0, 34, 1.6 );
	glow.position.set( centerX, - 2.5, centerZ );
	group.add( glow );

	// ------------------------------------------------------------------
	// Animation d'ouverture / fermeture
	// ------------------------------------------------------------------
	let reveal = 0;          // 0 fermé → 1 ouvert (lissé)

	function update( dt ) {

		const target = gfx.undergroundView ? 1 : 0;
		const k = 1 - Math.exp( - dt * 5 );
		reveal += ( target - reveal ) * k;
		if ( Math.abs( reveal - target ) < 0.002 ) reveal = target;

		const eased = reveal * reveal * ( 3 - 2 * reveal );     // smoothstep
		const r = gfx.pitRadius * eased;

		uPitR.value = r;
		rim.scale.set( Math.max( 0.001, r ), Math.max( 0.001, - SHELF + 0.04 ), Math.max( 0.001, r ) );
		rim.visible = r > 0.05;
		glow.intensity = eased * 14;

		// l'herbe s'efface dans le disque (jamais en-deçà du trou du nid)
		if ( grass && grass.u && grass.u.holeIn ) {

			grass.u.holeIn.value = Math.max( 3.6, r - 1.4 );
			grass.u.holeOut.value = Math.max( 5.2, r );

		}

		// la fourmilière (GLB) se retire pendant la vue souterraine
		if ( env.anthill ) {

			const s = 1 - eased;
			env.anthill.visible = s > 0.02;
			env.anthill.scale.setScalar( env.anthill.userData.baseScale * Math.max( 0.001, s ) );

		}

		// caméra trop rasante à l'ouverture : on la relève en douceur, sinon
		// on ne voit que la paroi de la fosse (jamais les chambres)
		if ( gfx.undergroundView && reveal < 0.97 && camera && camera.position.y < 24 ) {

			camera.position.y += ( 26 - camera.position.y ) * k;

		}

	}

	return { group, update, get reveal() { return reveal; } };

}
