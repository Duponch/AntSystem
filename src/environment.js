// Sol de la clairière : mousse nocturne avec taches organiques, visualisation
// du champ de phéromones en émissif, murs/terre, fourmilière (GLB).
//
// Les fonctions de couleur du sol sont PARTAGÉES avec l'herbe (grass.js) :
// un brin affiche exactement l'albédo et l'émissif du sol à sa racine, avec
// la même normale verticale → il est indiscernable du sol tant qu'on ne voit
// pas sa silhouette dépasser.

import * as THREE from 'three/webgpu';
import {
	Fn, texture, uniform, positionWorld,
	vec3, float, color, mix, clamp, smoothstep, length, mx_noise_float,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { WORLD, NEST, GRID, params } from './config.js';

// intensité des pistes, partagée sol/herbe (réglée par l'UI)
export const uTrail = uniform( params.trailIntensity );

// Crée un nœud d'échantillonnage du champ, enregistré pour suivre le ping-pong.
export function makeFieldSampler( sim, uvNode ) {

	const node = texture( sim.currentTexture, uvNode );
	sim.fieldNodes.push( node );
	return node;

}

// Albédo du sol en un point (worldXZ vec2, f = échantillon vec4 du champ).
export function groundAlbedo( worldXZ, f ) {

	const wallM = smoothstep( 0.2, 0.8, f.w );
	const foodM = clamp( f.z, 0, 1 );

	// mousse : deux verts mélangés par un bruit organique multi-échelle
	const patches = mx_noise_float( worldXZ.mul( 0.055 ) ).mul( 0.5 ).add( 0.5 );
	const detail = mx_noise_float( worldXZ.mul( 0.6 ) ).mul( 0.5 ).add( 0.5 );
	const col = mix( color( 0x2b3a21 ), color( 0x4a5c3a ), patches )
		.mul( detail.mul( 0.3 ).add( 0.85 ) ).toVar();

	// bords assombris (lisière de forêt)
	const vignette = float( 1 ).sub(
		smoothstep( 0.32, 0.72, length( worldXZ ).div( WORLD ) ).mul( 0.3 ),
	);
	col.mulAssign( vignette );

	col.assign( mix( col, color( 0x4a453c ), wallM ) );            // murs/terre
	col.assign( mix( col, color( 0x8a5a20 ), foodM.mul( 0.85 ) ) ); // nourriture ambrée

	return col;

}

// Émissif du sol : pistes de phéromones + nourriture luminescente (lucioles).
export function groundEmissive( f ) {

	const wallM = smoothstep( 0.2, 0.8, f.w );
	const foodM = clamp( f.z, 0, 1 );

	// quadratique : les pistes structurées ressortent, le voile diffus s'éteint
	const home = vec3( 0.05, 0.4, 1.0 ).mul( f.x.mul( f.x ) ).mul( 0.45 );
	const food = vec3( 1.0, 0.33, 0.05 ).mul( f.y.mul( f.y ) ).mul( 0.9 );

	const trails = home.add( food ).mul( uTrail )
		.mul( float( 1 ).sub( wallM ) )
		.mul( float( 1 ).sub( foodM.mul( 0.85 ) ) );

	// la nourriture rougeoie comme des lucioles posées dans l'herbe
	const foodGlow = vec3( 1.0, 0.62, 0.18 ).mul( foodM ).mul( 0.85 );

	return trails.add( foodGlow );

}

export async function createEnvironment( scene, sim ) {

	// ------------------------------------------------------------------
	// Sol
	// ------------------------------------------------------------------
	const groundGeo = new THREE.PlaneGeometry( WORLD, WORLD ).rotateX( - Math.PI / 2 );
	const groundMat = new THREE.MeshStandardNodeMaterial( { roughness: 0.95, metalness: 0 } );

	const guv = positionWorld.xz.div( WORLD ).add( 0.5 );
	const fieldNode = makeFieldSampler( sim, guv );

	groundMat.colorNode = Fn( () => groundAlbedo( positionWorld.xz, fieldNode ) )();
	groundMat.emissiveNode = Fn( () => groundEmissive( fieldNode ) )();

	const ground = new THREE.Mesh( groundGeo, groundMat );
	ground.receiveShadow = true;
	scene.add( ground );

	// ------------------------------------------------------------------
	// Fourmilière (GLB), pieds au sol, empreinte ≈ zone du nid
	// ------------------------------------------------------------------
	const nestWorldR = ( NEST.radius / GRID ) * WORLD;

	const gltf = await new GLTFLoader().loadAsync( '/Anthill.glb' );
	gltf.scene.updateMatrixWorld( true );

	let anthillGeo = null;
	gltf.scene.traverse( ( o ) => {

		if ( o.isMesh && ! anthillGeo ) {

			anthillGeo = o.geometry.clone();
			anthillGeo.applyMatrix4( o.matrixWorld );

		}

	} );

	anthillGeo.computeBoundingBox();
	const bb = anthillGeo.boundingBox;
	const size = new THREE.Vector3();
	bb.getSize( size );

	const s = 1 / Math.max( size.x, size.z );      // empreinte unité
	anthillGeo.translate( - ( bb.min.x + bb.max.x ) / 2, - bb.min.y, - ( bb.min.z + bb.max.z ) / 2 );
	anthillGeo.scale( s, s, s );

	const anthill = new THREE.Mesh(
		anthillGeo,
		new THREE.MeshStandardNodeMaterial( { color: 0x6f5a3c, roughness: 1 } ),
	);
	anthill.scale.setScalar( nestWorldR * 2.4 );
	anthill.position.y = - nestWorldR * 0.08;      // base légèrement enterrée
	anthill.castShadow = true;
	anthill.receiveShadow = true;
	scene.add( anthill );

	return {
		ground,
		uTrail,
	};

}
