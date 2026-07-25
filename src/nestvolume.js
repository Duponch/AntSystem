// LE NID COMME VOLUME — champ de distance signé 3D, écrit par un compute.
//
// POURQUOI CHANGER D'APPROCHE. Le rendu précédent creusait des cuvettes dans
// une carte de hauteurs et en dessinait la surface. Trois choses en découlaient,
// toutes fatales :
//   • une carte de hauteurs ne produit que des formes à symétrie de révolution
//     — des cylindres. Aucun réglage ne peut les rendre organiques ;
//   • une surface trouée n'est pas un volume : dès qu'on regardait par le côté,
//     on voyait à travers, et la skybox apparaissait ;
//   • deux sommets voisins, l'un dans une chambre profonde et l'autre dans la
//     terre pleine, engendraient un triangle vertical de toute la hauteur du
//     nid — les rideaux parasites.
//
// Ici le nid n'est plus une surface, c'est un CHAMP : pour chaque point de
// l'espace, la distance signée à la cavité la plus proche (négative dedans,
// positive dans la terre). La terre devient un volume PLEIN qu'on traverse au
// rayon. Conséquences directes :
//   • les formes viennent d'une union DOUCE (smin) entre lentilles et capsules,
//     déformée par du bruit : c'est ce qui donne des contours irréguliers et
//     des chambres qui se fondent l'une dans l'autre, impossibles à obtenir
//     avec des disques ;
//   • il n'y a plus de « derrière » : on ne peut pas voir à travers de la terre
//     pleine ;
//   • aucun maillage, donc aucun artefact de maillage.
//
// Le champ est baké UNE FOIS par géométrie de nid dans une Storage3DTexture
// (rgba16float : storage-writable ET filtrable en WebGPU), puis simplement
// échantillonné par le raymarcheur. La simulation, elle, continue d'utiliser la
// carte de hauteurs — les fourmis n'ont pas besoin de savoir tout ça.

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, instanceIndex, uniform, uniformArray, uvec3, ivec3,
	float, int, uint, vec3, vec4,
	abs, min, max, clamp, length, dot, select, textureStore, mx_noise_float,
} from 'three/tsl';

import { TEXEL, NEST, GRID, WORLD, gfx } from './config.js';
import { K_MAX, tunnelPath } from './nest.js';

// Résolution du volume. Le nid fait ~45 unités de large pour ~20 de profondeur ;
// à 128×64×128 un voxel vaut ~0,4 unité, soit trois voxels en travers d'un
// tunnel. C'est le minimum pour que l'interpolation trilinéaire donne des
// parois lisses. Coût mémoire : 128·64·128·4·2 = 8 Mo.
export const VOL_X = 128, VOL_Y = 64, VOL_Z = 128;

// nombre de capsules par tunnel. Chaque voxel les évalue TOUTES : c'est le
// poste dominant du bake, d'où un pas volontairement grossier (le lissage du
// smin rattrape la discrétisation).
const SEGS = 5;
const MAX_SEGS = K_MAX * SEGS;

export function createNestVolume( { renderer, layout } ) {

	// rgba16float : l'un des rares formats à la fois inscriptible par un compute
	// ET filtrable — indispensable, un SDF non filtré donne des parois en escalier
	const volume = new THREE.Storage3DTexture( VOL_X, VOL_Y, VOL_Z );
	volume.format = THREE.RGBAFormat;
	volume.type = THREE.HalfFloatType;
	volume.minFilter = THREE.LinearFilter;
	volume.magFilter = THREE.LinearFilter;
	volume.wrapS = volume.wrapT = volume.wrapR = THREE.ClampToEdgeWrapping;

	// --- bornes monde du volume (mises à jour à chaque reconstruction) ---
	const uMin = uniform( new THREE.Vector3() );
	const uSize = uniform( new THREE.Vector3( 1, 1, 1 ) );
	const uChamberCount = uniform( 0 );
	const uSegCount = uniform( 0 );
	// rayon de fusion : c'est LUI qui fait que deux chambres voisines se fondent
	// en une poche unique aux contours mous au lieu de deux boules tangentes
	const uBlend = uniform( gfx.nestBlend );
	const uNoiseAmp = uniform( gfx.nestNoise );
	const uNoiseFreq = uniform( 0.35 );

	// primitives : allouées à la taille MAXIMALE (la longueur d'un uniformArray
	// est figée à la compilation du shader), bornées à l'exécution par un compteur
	const chamberA = Array.from( { length: K_MAX }, () => new THREE.Vector4() );  // xyz + demi-axe x
	const chamberB = Array.from( { length: K_MAX }, () => new THREE.Vector4() );  // demi-axes y, z
	const segA = Array.from( { length: MAX_SEGS }, () => new THREE.Vector4() );   // xyz + rayon
	const segB = Array.from( { length: MAX_SEGS }, () => new THREE.Vector4() );   // xyz du 2e point
	const uChamberA = uniformArray( chamberA );
	const uChamberB = uniformArray( chamberB );
	const uSegA = uniformArray( segA );
	const uSegB = uniformArray( segB );

	// ------------------------------------------------------------------
	// Primitives de distance
	// ------------------------------------------------------------------
	// ellipsoïde : la distance exacte n'a pas de forme fermée, on utilise la
	// borne classique de Quilez — sous-estimée, donc SÛRE pour le sphere tracing
	const sdEllipsoid = ( p, r ) => {

		const k0 = length( p.div( r ) );
		const k1 = length( p.div( r.mul( r ) ) );
		return k0.mul( k0.sub( 1 ) ).div( max( k1, 1e-5 ) );

	};

	const sdCapsule = ( p, a, b, r ) => {

		const pa = p.sub( a ), ba = b.sub( a );
		const h = clamp( dot( pa, ba ).div( max( dot( ba, ba ), 1e-5 ) ), 0, 1 );
		return length( pa.sub( ba.mul( h ) ) ).sub( r );

	};

	// union DOUCE : le cœur de l'organicité. Deux primitives distantes de moins
	// de `k` se raccordent par un congé au lieu d'une arête.
	const smin = ( a, b, k ) => {

		const h = clamp( max( k.sub( abs( a.sub( b ) ) ), 0 ).div( k ), 0, 1 );
		return min( a, b ).sub( h.mul( h ).mul( k ).mul( 0.25 ) );

	};

	// ------------------------------------------------------------------
	// Bake : un thread par voxel
	// ------------------------------------------------------------------
	const kBake = Fn( () => {

		const i = instanceIndex;
		const vx = i.mod( uint( VOL_X ) );
		const vy = i.div( uint( VOL_X ) ).mod( uint( VOL_Y ) );
		const vz = i.div( uint( VOL_X * VOL_Y ) );

		// centre du voxel en coordonnées monde
		const p = uMin.add( vec3(
			vx.toFloat().add( 0.5 ).div( VOL_X ),
			vy.toFloat().add( 0.5 ).div( VOL_Y ),
			vz.toFloat().add( 0.5 ).div( VOL_Z ),
		).mul( uSize ) ).toVar();

		const d = float( 1e6 ).toVar();

		Loop( { start: uint( 0 ), end: uChamberCount.toUint(), type: 'uint', condition: '<' }, ( { i: c } ) => {

			const A = uChamberA.element( c.toInt() );
			const B = uChamberB.element( c.toInt() );
			d.assign( smin( d, sdEllipsoid( p.sub( A.xyz ), vec3( A.w, B.x, B.y ) ), uBlend ) );

		} );

		Loop( { start: uint( 0 ), end: uSegCount.toUint(), type: 'uint', condition: '<' }, ( { i: c } ) => {

			const A = uSegA.element( c.toInt() );
			const B = uSegB.element( c.toInt() );
			d.assign( smin( d, sdCapsule( p, A.xyz, B.xyz, A.w ), uBlend.mul( 0.6 ) ) );

		} );

		// DÉFORMATION. Sans elle, les chambres restent des ellipsoïdes lisses :
		// c'est ce bruit qui donne les parois bosselées et les contours
		// irréguliers d'une vraie galerie creusée dans la terre. Deux octaves :
		// l'un pour la silhouette, l'autre pour le grain.
		//
		// Canal G (pour la vue scanner) : le champ PROPRE, pris AVANT le bruit,
		// avec un plafond plat — le scanner y détecte des parois nettes, sans
		// les faux franchissements que le bruit sème dans la terre pleine.
		const dClean = max( d, p.y.add( 0.55 ) );
		const n1 = mx_noise_float( p.mul( uNoiseFreq ) );
		const n2 = mx_noise_float( p.mul( uNoiseFreq.mul( 2.7 ) ).add( 31.7 ) );
		d.subAssign( n1.mul( uNoiseAmp ).add( n2.mul( uNoiseAmp.mul( 0.35 ) ) ) );

		// PLAFOND. La deformation par bruit fait deboucher les chambres les plus
		// hautes AU-DESSUS du sol : vue de biais, la coupe laissait alors voir
		// le ciel a travers le nid. On intersecte donc le champ avec le
		// demi-espace « sous la surface » — max() entre deux distances signees
		// est l'intersection des deux solides. Le seuil est lui-meme ondule par
		// le meme bruit, sans quoi tout l'etage superieur se retrouvait coiffe
		// d'un plafond parfaitement plat.
		d.assign( max( d, p.y.add( 0.55 ).add( n1.mul( 0.45 ) ) ) );

		textureStore( volume, ivec3( vx.toInt(), vy.toInt(), vz.toInt() ), vec4( d, dClean, 0, 0 ) ).toStack();

	} )().compute( VOL_X * VOL_Y * VOL_Z );

	// ------------------------------------------------------------------
	// Remplissage des primitives depuis le registre, puis bake
	// ------------------------------------------------------------------
	const cx = ( NEST.x / GRID - 0.5 ) * WORLD;
	const cz = ( NEST.y / GRID - 0.5 ) * WORLD;

	function rebuild() {

		const units = layout.units || [];
		const K = Math.min( layout.K || 0, K_MAX );

		// bornes : le nid plus une marge, et on remonte jusqu'à la surface
		const radius = ( layout.radiusWorld || 20 ) + 4;
		const depth = ( layout.depthMax || 18 ) + 3;
		uMin.value.set( cx - radius, - depth, cz - radius );
		uSize.value.set( radius * 2, depth + 1.5, radius * 2 );

		// --- chambres : lentilles aplaties ---
		for ( let k = 0; k < K; k ++ ) {

			const u = units[ k ];
			// Le centre est remonte des TROIS QUARTS de la demi-hauteur : le sol de
			// la lentille tombe ainsi juste sous la profondeur ou marchent les
			// fourmis (celle lue dans la carte de profondeur), avec la marge qu'il
			// faut pour que la deformation par bruit ne creve pas le plancher.
			chamberA[ k ].set(
				( u.x / GRID - 0.5 ) * WORLD, u.depth + u.rh * 0.75, ( u.y / GRID - 0.5 ) * WORLD, u.rwx );
			chamberB[ k ].set( u.rh, u.rwz, 0, 0 );

		}
		uChamberCount.value = K;

		// --- tunnels : capsules le long de l'arc réel ---
		const tw = Math.max( 0.6, ( layout.tunnelW || 7 ) * TEXEL * 0.85 );
		let n = 0;

		for ( let k = 0; k < K && n < MAX_SEGS; k ++ ) {

			const c = units[ k ];
			const pi = layout.parents ? layout.parents[ k ] : - 1;
			const par = pi < 0 ? layout.shaft : units[ pi ];
			if ( ! par ) continue;
			const path = tunnelPath( par, c, k, SEGS );

			for ( let s = 0; s < path.length - 1 && n < MAX_SEGS; s ++ ) {

				const a = path[ s ], b = path[ s + 1 ];
				segA[ n ].set( ( a.x / GRID - 0.5 ) * WORLD, a.depth + tw * 0.4, ( a.y / GRID - 0.5 ) * WORLD, tw );
				segB[ n ].set( ( b.x / GRID - 0.5 ) * WORLD, b.depth + tw * 0.4, ( b.y / GRID - 0.5 ) * WORLD, 0 );
				n ++;

			}

		}
		uSegCount.value = n;

		renderer.compute( kBake );

	}

	return {
		volume, rebuild,
		uMin, uSize,
		u: { blend: uBlend, noiseAmp: uNoiseAmp, noiseFreq: uNoiseFreq },
		get bounds() {

			return {
				min: uMin.value.clone(),
				max: uMin.value.clone().add( uSize.value ),
			};

		},
	};

}
