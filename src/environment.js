// Sol de la clairière : mousse nocturne avec taches organiques, visualisation
// du champ de phéromones en émissif, murs/terre, nid. L'éclairage, le ciel et
// le brouillard vivent dans graphics/sky.js.

import * as THREE from 'three/webgpu';
import {
	Fn, texture, uniform, positionWorld,
	vec3, float, color, mix, clamp, smoothstep, length, mx_noise_float,
} from 'three/tsl';

import { WORLD, GRID, NEST, params } from './config.js';

export function createEnvironment( scene, sim ) {

	const uTrail = uniform( params.trailIntensity );

	// ------------------------------------------------------------------
	// Sol : mousse + murs + nourriture, pistes en émissif
	// ------------------------------------------------------------------
	const groundGeo = new THREE.PlaneGeometry( WORLD, WORLD ).rotateX( - Math.PI / 2 );
	const groundMat = new THREE.MeshStandardNodeMaterial( { roughness: 0.95, metalness: 0 } );

	// nœud texture dont on échange la cible ping-pong chaque frame
	const guv = positionWorld.xz.div( WORLD ).add( 0.5 );
	const fieldNode = texture( sim.currentTexture, guv );

	groundMat.colorNode = Fn( () => {

		const f = fieldNode;
		const wallM = smoothstep( 0.2, 0.8, f.w );
		const foodM = clamp( f.z, 0, 1 );

		// mousse : deux verts mélangés par un bruit organique multi-échelle
		const patches = mx_noise_float( positionWorld.xz.mul( 0.055 ) ).mul( 0.5 ).add( 0.5 );
		const detail = mx_noise_float( positionWorld.xz.mul( 0.6 ) ).mul( 0.5 ).add( 0.5 );
		let col = mix( color( 0x2b3a21 ), color( 0x4a5c3a ), patches )
			.mul( detail.mul( 0.3 ).add( 0.85 ) ).toVar();

		// bords assombris (lisière de forêt)
		const vignette = float( 1 ).sub(
			smoothstep( 0.32, 0.72, length( positionWorld.xz ).div( WORLD ) ).mul( 0.3 ),
		);
		col.mulAssign( vignette );

		col.assign( mix( col, color( 0x4a453c ), wallM ) );          // murs/terre
		col.assign( mix( col, color( 0x2f9e44 ), foodM.mul( 0.9 ) ) ); // nourriture

		return col;

	} )();

	groundMat.emissiveNode = Fn( () => {

		const f = fieldNode;
		const wallM = smoothstep( 0.2, 0.8, f.w );
		const foodM = clamp( f.z, 0, 1 );

		// quadratique : les pistes structurées ressortent, le voile diffus s'éteint
		const home = vec3( 0.05, 0.4, 1.0 ).mul( f.x.mul( f.x ) ).mul( 0.45 );
		const food = vec3( 1.0, 0.33, 0.05 ).mul( f.y.mul( f.y ) ).mul( 0.9 );

		// nourriture légèrement luminescente (lisibilité nocturne),
		// pas de lueur de piste sur les murs ni sur la nourriture elle-même
		const trails = home.add( food ).mul( uTrail )
			.mul( float( 1 ).sub( wallM ) )
			.mul( float( 1 ).sub( foodM.mul( 0.85 ) ) );
		const foodGlow = vec3( 0.1, 0.5, 0.12 ).mul( foodM ).mul( 0.35 );

		return trails.add( foodGlow );

	} )();

	const ground = new THREE.Mesh( groundGeo, groundMat );
	ground.receiveShadow = true;
	scene.add( ground );

	// ------------------------------------------------------------------
	// Nid : monticule torique + entrée sombre
	// ------------------------------------------------------------------
	const nestWorldR = ( NEST.radius / GRID ) * WORLD;

	const mound = new THREE.Mesh(
		new THREE.TorusGeometry( nestWorldR * 0.8, nestWorldR * 0.38, 12, 48 )
			.rotateX( - Math.PI / 2 )
			.scale( 1, 0.45, 1 ),
		new THREE.MeshStandardNodeMaterial( { color: 0x54422c, roughness: 1 } ),
	);
	mound.castShadow = true;
	mound.receiveShadow = true;
	scene.add( mound );

	const hole = new THREE.Mesh(
		new THREE.CircleGeometry( nestWorldR * 0.55, 32 ).rotateX( - Math.PI / 2 ),
		new THREE.MeshStandardNodeMaterial( { color: 0x060402, roughness: 1 } ),
	);
	hole.position.y = 0.02;
	scene.add( hole );

	return {
		ground,
		uTrail,
		// à appeler après chaque étape de simulation (ping-pong)
		updateFieldTexture() {

			fieldNode.value = sim.currentTexture;

		},
	};

}
