// Rendu des fourmis : maillage rigué baké en VAT (voir vat.js), instancié et
// transformé dans le vertex shader depuis les buffers de la simulation.
// Le cycle de marche est lu dans la texture VAT avec une phase par instance,
// cadencé par le temps de SIMULATION (la pause fige la démarche) et par la
// vitesse de déplacement (les fourmis trottinent d'autant plus vite).

import * as THREE from 'three/webgpu';
import {
	Fn, instanceIndex, vertexIndex, positionLocal, uniform,
	vec3, mat3, float, int, ivec2, uint, cos, sin, fract, floor, mix, hash,
	textureLoad,
} from 'three/tsl';

import { loadAntVAT } from './vat.js';
import { GRID, WORLD, params } from './config.js';

export async function createAnts( sim ) {

	const vat = await loadAntVAT( '/AntRigged.glb', { frames: 20, targetLength: 0.95 } );

	// phase de marche accumulée côté CPU (dans [0,1) : pas de saut quand la
	// fréquence change, pas de perte de précision f32 en session longue)
	const uPhase = uniform( 0 );
	let phaseAcc = 0;

	const texel = WORLD / GRID;
	const framesF = float( vat.frames );

	// --- transformation par instance, partagée par le corps et le grain ---
	const instanceTransform = () => {

		const a = sim.antData.element( instanceIndex );
		const gp = a.xy;
		const angle = a.z;

		// grille (cos a, sin a) → monde XZ ; le modèle regarde +Z → lacet = π/2 − angle
		const yaw = float( Math.PI / 2 ).sub( angle );
		const c = cos( yaw );
		const s = sin( yaw );
		const rot = mat3(
			vec3( c, 0, s.negate() ),
			vec3( 0, 1, 0 ),
			vec3( s, 0, c ),
		);

		const world = vec3(
			gp.x.mul( texel ).sub( WORLD / 2 ),
			0,
			gp.y.mul( texel ).sub( WORLD / 2 ),
		);

		return { rot, world };

	};

	// --- corps : sommets lus dans la VAT (deux frames interpolées) ---
	const bodyGeo = new THREE.InstancedBufferGeometry();
	bodyGeo.index = vat.geometry.index;
	bodyGeo.attributes = vat.geometry.attributes;
	bodyGeo.instanceCount = params.antCount;

	const bodyMat = new THREE.MeshStandardNodeMaterial( {
		color: 0x16120e,
		roughness: 0.6,
		metalness: 0.0,
	} );

	bodyMat.positionNode = Fn( () => {

		const { rot, world } = instanceTransform();

		// phase de marche accumulée + décalage par fourmi
		const cycle = uPhase.add( hash( instanceIndex.add( uint( 1013 ) ) ) );
		const ff = fract( cycle ).mul( framesF );
		const f0 = floor( ff ).toInt();
		const f1 = f0.add( 1 ).mod( int( vat.frames ) );
		const w = fract( ff );

		const p0 = textureLoad( vat.texture, ivec2( vertexIndex.toInt(), f0 ) ).xyz;
		const p1 = textureLoad( vat.texture, ivec2( vertexIndex.toInt(), f1 ) ).xyz;
		const animated = mix( p0, p1, w );

		return rot.mul( animated ).add( world );

	} )();

	const body = new THREE.Mesh( bodyGeo, bodyMat );
	body.frustumCulled = false;
	body.castShadow = true;
	body.receiveShadow = true;

	// --- grain de nourriture porté (échelle 0 quand la fourmi n'a rien) ---
	const grainGeo = new THREE.InstancedBufferGeometry();
	const ico = new THREE.IcosahedronGeometry( 0.085, 0 );
	grainGeo.index = ico.index;
	grainGeo.attributes = ico.attributes;
	grainGeo.instanceCount = params.antCount;

	const grainMat = new THREE.MeshStandardNodeMaterial( {
		color: 0x3fae4a,
		emissive: 0x1d7c2e,
		emissiveIntensity: 0.7,
		roughness: 0.4,
	} );

	grainMat.positionNode = Fn( () => {

		const { rot, world } = instanceTransform();
		const carrying = sim.antState.element( instanceIndex ).toFloat();
		const offset = rot.mul( vec3( 0, vat.bounds.height * 0.62, vat.bounds.headZ * 0.9 ) );

		return positionLocal.mul( carrying ).add( offset ).add( world );

	} )();

	const grain = new THREE.Mesh( grainGeo, grainMat );
	grain.frustumCulled = false;
	// pas d'ombre pour un grain de 8 cm sous la lune

	const group = new THREE.Group();
	group.add( body, grain );

	return {
		group,
		setCount( n ) {

			bodyGeo.instanceCount = n;
			grainGeo.instanceCount = n;

		},
		setShadows( on ) {

			body.castShadow = on;

		},
		// à appeler chaque frame avec le dt de SIMULATION (0 si pause)
		tick( simDt ) {

			phaseAcc = ( phaseAcc + simDt * params.moveSpeed * params.walkAnim * 0.14 ) % 1;
			uPhase.value = phaseAcc;

		},
	};

}
