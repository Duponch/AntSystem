// Environnement : sol avec visualisation du champ de phéromones, nid, lumières.

import * as THREE from 'three/webgpu';
import {
	Fn, texture, uniform, positionWorld,
	vec2, vec3, float, color, mix, clamp, smoothstep, length,
} from 'three/tsl';

import { WORLD, GRID, NEST, params } from './config.js';

export function createEnvironment( scene, sim ) {

	const uTrail = uniform( params.trailIntensity );

	// ------------------------------------------------------------------
	// Sol : couleur du terreau + murs + nourriture, pistes en émissif
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

		// terreau, légèrement assombri vers les bords
		const vignette = float( 1 ).sub(
			smoothstep( 0.35, 0.75, length( positionWorld.xz ).div( WORLD ) ).mul( 0.35 ),
		);
		let col = color( 0x453525 ).mul( vignette ).toVar();

		col.assign( mix( col, color( 0x847c6e ), wallM ) );
		col.assign( mix( col, color( 0x2f9e44 ), foodM.mul( 0.9 ) ) );

		return col;

	} )();

	groundMat.emissiveNode = Fn( () => {

		const f = fieldNode;
		const wallM = smoothstep( 0.2, 0.8, f.w );
		const foodM = clamp( f.z, 0, 1 );

		const home = vec3( 0.05, 0.4, 1.0 ).mul( f.x ).mul( 0.5 );
		const food = vec3( 1.0, 0.33, 0.05 ).mul( f.y ).mul( 0.75 );

		// pas de lueur sur les murs ni sur la nourriture (qui doit rester verte)
		return home.add( food ).mul( uTrail )
			.mul( float( 1 ).sub( wallM ) )
			.mul( float( 1 ).sub( foodM.mul( 0.85 ) ) );

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
		new THREE.MeshStandardNodeMaterial( { color: 0x3a2b1c, roughness: 1 } ),
	);
	mound.castShadow = true;
	mound.receiveShadow = true;
	scene.add( mound );

	const hole = new THREE.Mesh(
		new THREE.CircleGeometry( nestWorldR * 0.55, 32 ).rotateX( - Math.PI / 2 ),
		new THREE.MeshStandardNodeMaterial( { color: 0x0a0704, roughness: 1 } ),
	);
	hole.position.y = 0.02;
	scene.add( hole );

	// ------------------------------------------------------------------
	// Lumières et ambiance
	// ------------------------------------------------------------------
	scene.background = new THREE.Color( 0x0d0f12 );
	scene.fog = new THREE.Fog( 0x0d0f12, 200, 650 );

	const sun = new THREE.DirectionalLight( 0xfff2dd, 2.4 );
	sun.position.set( 55, 80, 25 );
	sun.castShadow = true;
	sun.shadow.mapSize.set( 2048, 2048 );
	sun.shadow.camera.left = sun.shadow.camera.bottom = - WORLD * 0.6;
	sun.shadow.camera.right = sun.shadow.camera.top = WORLD * 0.6;
	sun.shadow.camera.near = 10;
	sun.shadow.camera.far = 220;
	sun.shadow.normalBias = 0.05;
	scene.add( sun );

	const hemi = new THREE.HemisphereLight( 0x9fb4cc, 0x3a2c1e, 0.55 );
	scene.add( hemi );

	return {
		ground,
		uTrail,
		sun,
		// à appeler après chaque étape de simulation (ping-pong)
		updateFieldTexture() {

			fieldNode.value = sim.currentTexture;

		},
	};

}
