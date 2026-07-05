// Ambiance nocturne — portée de E:/Code/Simulation (déjà en TSL r185) :
// dôme dégradé zénith/horizon, lune billboard procédurale (disque + halo +
// cratères), étoiles procédurales scintillantes, brouillard exponentiel
// asservi à la couleur d'horizon, clair de lune directionnel + ambiante bleutée.

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, uv, time, positionLocal,
	float, vec2, vec3, color, mix, smoothstep, step, fract, floor, hash,
	sin, length,
} from 'three/tsl';

import { WORLD, gfx } from '../config.js';

const SKY_R = 1200;

// palette nuit (E:/Code/Simulation, index.html l.1988-1997)
const NIGHT = {
	zenith: 0x070b18,
	horizon: 0x162038,
	ambient: 0x1c2c50,
	moonLight: 0xaec3ff,
	moonCore: 0xeef2ff,
	moonGlow: 0x9fbdf0,
};

export function createSky( scene ) {

	const uStars = uniform( gfx.stars );

	// ------------------------------------------------------------------
	// Dôme : dégradé statique + étoiles procédurales
	// ------------------------------------------------------------------
	const domeMat = new THREE.MeshBasicNodeMaterial( {
		side: THREE.BackSide,
		depthWrite: false,
		fog: false,
	} );

	domeMat.colorNode = Fn( () => {

		const dir = positionLocal.div( SKY_R );
		const h = dir.y.mul( 0.5 ).add( 0.5 );          // 0 bas, 0.5 horizon, 1 zénith

		const base = mix(
			color( NIGHT.horizon ),
			color( NIGHT.zenith ),
			smoothstep( 0.5, 1.0, h ),
		);

		// étoiles : cellules 3D sur la coquille, taille/éclat aléatoires, scintillement
		// (hash() TSL tronque en uint : les graines doivent rester positives)
		const g = dir.mul( 58 );
		const cell = floor( g ).add( vec3( 96 ) );
		const f = fract( g ).sub( 0.5 );
		const rnd = hash( cell.x.mul( 127.1 ).add( cell.y.mul( 311.7 ) ).add( cell.z.mul( 74.7 ) ) );
		const rnd2 = hash( cell.x.mul( 269.5 ).add( cell.y.mul( 183.3 ) ).add( cell.z.mul( 246.1 ) ) );

		const isStar = step( float( 1 ).sub( uStars.mul( 0.14 ) ), rnd );
		const twinkle = sin( time.mul( rnd2.mul( 2 ).add( 0.7 ) ).add( rnd.mul( 40 ) ) )
			.mul( 0.35 ).add( 0.65 );
		const spot = smoothstep( float( 0.16 ).mul( rnd2.add( 0.4 ) ), float( 0 ), length( f ) );
		const starLight = isStar.mul( spot ).mul( twinkle )
			.mul( smoothstep( 0.52, 0.62, h ) );      // pas d'étoiles sous l'horizon

		return base.add( vec3( 0.75, 0.82, 1.0 ).mul( starLight ).mul( 2.4 ) );

	} )();

	const dome = new THREE.Mesh( new THREE.SphereGeometry( SKY_R, 32, 16 ), domeMat );
	dome.frustumCulled = false;
	dome.renderOrder = - 1;
	scene.add( dome );

	// ------------------------------------------------------------------
	// Lune : billboard + disque net / halo doux / 3 cratères (verbatim TSL)
	// ------------------------------------------------------------------
	const moonMat = new THREE.MeshBasicNodeMaterial( {
		transparent: true,
		depthWrite: false,
		fog: false,
		side: THREE.DoubleSide,
		toneMapped: false,
	} );

	const moonCore = uniform( new THREE.Color( NIGHT.moonCore ) );
	const moonGlow = uniform( new THREE.Color( NIGHT.moonGlow ) );

	moonMat.colorNode = Fn( () => {

		const r = uv().sub( vec2( 0.5, 0.5 ) ).length().mul( 2 );
		const disc = float( 0.46 ).sub( r ).mul( 22 ).clamp( 0, 1 );
		let col = mix( moonGlow, moonCore, disc );

		const crater = ( px, py, sc ) =>
			uv().sub( vec2( px, py ) ).length().mul( sc ).oneMinus().clamp( 0, 1 ).pow( 6 );

		const craters = crater( 0.40, 0.56, 2.0 ).mul( 0.22 )
			.add( crater( 0.61, 0.45, 2.7 ).mul( 0.16 ) )
			.add( crater( 0.52, 0.66, 3.4 ).mul( 0.12 ) );

		return col.mul( craters.mul( disc ).oneMinus() );

	} )();

	moonMat.opacityNode = Fn( () => {

		const r = uv().sub( vec2( 0.5, 0.5 ) ).length().mul( 2 );
		const disc = float( 0.46 ).sub( r ).mul( 22 ).clamp( 0, 1 );
		const halo = r.oneMinus().clamp( 0, 1 ).pow( 3.2 );
		return disc.add( halo.mul( 0.42 ) ).clamp( 0, 1 );

	} )();

	const moonDir = new THREE.Vector3( - 0.30, 0.44, - 0.85 ).normalize();
	const moon = new THREE.Mesh( new THREE.PlaneGeometry( 92, 92 ), moonMat );
	moon.frustumCulled = false;
	moon.renderOrder = - 0.9;
	scene.add( moon );

	// ------------------------------------------------------------------
	// Lumières : clair de lune (caster unique) + ambiante bleutée
	// ------------------------------------------------------------------
	const moonLight = new THREE.DirectionalLight( NIGHT.moonLight, gfx.moonIntensity );
	moonLight.castShadow = true;
	moonLight.shadow.mapSize.set( 2048, 2048 );
	moonLight.shadow.camera.left = moonLight.shadow.camera.bottom = - WORLD * 0.75;
	moonLight.shadow.camera.right = moonLight.shadow.camera.top = WORLD * 0.75;
	moonLight.shadow.camera.near = 10;
	moonLight.shadow.camera.far = 520;
	moonLight.shadow.bias = - 0.0008;
	moonLight.shadow.normalBias = 0.04;
	scene.add( moonLight );

	const ambient = new THREE.AmbientLight( NIGHT.ambient, gfx.ambientIntensity );
	scene.add( ambient );

	// ------------------------------------------------------------------
	// Brouillard : couleur = horizon (cohérence dôme/lointain)
	// ------------------------------------------------------------------
	scene.background = null;
	const fog = new THREE.FogExp2( NIGHT.horizon, gfx.fogDensity );
	scene.fog = fog;

	// ------------------------------------------------------------------
	// Heure de la nuit : arc de lune de l'est (t=0) au zénith (0.5) à l'ouest (1)
	// ------------------------------------------------------------------
	let baseMoonIntensity = gfx.moonIntensity;

	function applyMoonIntensity() {

		// le clair de lune faiblit près de l'horizon
		const horizon = THREE.MathUtils.smoothstep( moonDir.y, 0.03, 0.25 );
		moonLight.intensity = baseMoonIntensity * horizon;

	}

	function setTime( t ) {

		const el = ( 6 + 63 * Math.sin( Math.PI * t ) ) * Math.PI / 180;
		const az = - 1.9 + 3.8 * t;
		moonDir.set(
			Math.sin( az ) * Math.cos( el ),
			Math.sin( el ),
			- Math.cos( az ) * Math.cos( el ),
		).normalize();

		moon.position.copy( moonDir ).multiplyScalar( SKY_R * 0.9 );
		moonLight.position.copy( moonDir ).multiplyScalar( 220 );
		applyMoonIntensity();

	}

	setTime( gfx.nightTime );

	return {
		moonLight,
		ambient,
		fog,
		uStars,
		moonDir,
		setTime,
		setMoonIntensity( v ) {

			baseMoonIntensity = v;
			applyMoonIntensity();

		},
		update( camera ) {

			moon.lookAt( camera.position );

		},
	};

}
