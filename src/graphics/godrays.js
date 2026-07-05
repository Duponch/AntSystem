// Rayons de lune (godrays) en post-process : marche radiale vers la position
// écran de la lune sur un masque de luminance, additionnée à la scène.
//
// Quand l'effet est désactivé, le post-processing est ENTIÈREMENT contourné
// (renderer.render direct) — early-out réel pour comparer les performances.

import * as THREE from 'three/webgpu';
import {
	Fn, pass, uniform, uv, Loop, int, float, vec2, vec3, smoothstep, dot,
} from 'three/tsl';

import { gfx } from '../config.js';

const TAPS = 40;

export function createGodrays( renderer, scene, camera, sky ) {

	const post = new THREE.PostProcessing( renderer );
	const scenePass = pass( scene, camera );
	const sceneColor = scenePass.getTextureNode();

	const uMoonScreen = uniform( new THREE.Vector2( 0.5, 0.8 ) );
	const uIntensity = uniform( gfx.godrayIntensity );
	const uOnScreen = uniform( 0 );      // fondu quand la lune sort du champ

	post.outputNode = Fn( () => {

		const base = sceneColor;

		// marche radiale : échantillons entre le pixel et la lune, poids décroissant
		const toMoon = uMoonScreen.sub( uv() );
		const acc = vec3( 0 ).toVar();
		const weight = float( 1 ).toVar();
		const total = float( 0 ).toVar();

		Loop( { start: int( 1 ), end: int( TAPS ), type: 'int', condition: '<=' }, ( { i } ) => {

			const p = uv().add( toMoon.mul( float( i ).div( TAPS ) ).mul( 0.85 ) );
			const s = sceneColor.sample( p ).rgb;

			// masque de luminance : ne laisse rayonner que la lune et son halo
			const lum = dot( s, vec3( 0.2126, 0.7152, 0.0722 ) );
			const mask = smoothstep( 0.42, 0.95, lum );

			acc.addAssign( s.mul( mask ).mul( weight ) );
			total.addAssign( weight );
			weight.mulAssign( 0.955 );

		} );

		const rays = acc.div( total ).mul( uIntensity ).mul( uOnScreen );

		return base.add( vec3( 0.75, 0.85, 1.0 ).mul( rays ) );

	} )();

	// --- projection de la lune à l'écran, chaque frame ---
	const moonWorld = new THREE.Vector3();
	const camDir = new THREE.Vector3();

	function update() {

		moonWorld.copy( sky.moonDir ).multiplyScalar( 1000 ).project( camera );
		uMoonScreen.value.set( ( moonWorld.x + 1 ) / 2, ( moonWorld.y + 1 ) / 2 );

		// fondu : plein quand la lune est devant, nul derrière/loin du cadre
		camera.getWorldDirection( camDir );
		const facing = camDir.dot( sky.moonDir );
		const inFrame =
			THREE.MathUtils.smoothstep( facing, 0.15, 0.45 ) *
			THREE.MathUtils.smoothstep( 0.9 - Math.abs( moonWorld.x ), 0, 0.55 ) *
			THREE.MathUtils.smoothstep( 0.9 - Math.abs( moonWorld.y ), 0, 0.55 );
		uOnScreen.value = inFrame;

	}

	return {
		uIntensity,
		update,
		render() {

			update();
			post.render();

		},
	};

}
