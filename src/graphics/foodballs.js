// Vraies billes de nourriture posées au sol.
//
// Une bille = UNE cellule de la grille (aucune abstraction : les fourmis
// prélèvent unité par unité dans cette cellule, la bille rétrécit puis
// disparaît). Le rendu est dérivé entièrement sur GPU : une instance par
// bloc du réseau jitteré (période = espacement), le vertex shader recalcule
// le centre exact de la bille du bloc (même hash que le pinceau) et lit le
// stock restant dans le buffer de nourriture — les blocs vides dégénèrent à
// l'échelle zéro. ~40k instances de 20 triangles, quasi toutes nulles :
// coût négligeable, zéro entretien CPU.
//
// Chaque bille porte en plus un halo billboard additif (effet luciole).

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, uv, hash, instanceIndex, positionLocal, storage, cameraPosition,
	float, uint, vec2, vec3, floor, length, min, clamp, pow, select, cross, normalize, smoothstep,
} from 'three/tsl';

import { GRID, WORLD, gfx, params } from '../config.js';
import { uFoodColor, uFoodGlow } from '../environment.js';

export function createFoodBalls( scene, sim ) {

	const u = {
		spacing: uniform( gfx.foodBallSpacing ),
		ballSize: uniform( gfx.foodBallRadius ),
		haloSize: uniform( gfx.haloSize ),
		haloIntensity: uniform( gfx.haloIntensity ),
		foodRef: uniform( params.foodAmount ),   // stock « plein » pour l'échelle
		blocks: uniform( Math.ceil( GRID / gfx.foodBallSpacing ) ),
	};

	// vue NON atomique du buffer de nourriture (lecture en vertex shader)
	const foodRead = storage( sim.food.value, 'uint', GRID * GRID );

	// centre de la bille du bloc + stock restant (partagé billes/halos)
	// — formule de jitter IDENTIQUE à celle du pinceau (simulation.js)
	const ballOfBlock = () => {

		const nb = u.blocks.toUint();
		const bloc = vec2(
			instanceIndex.mod( nb ).toFloat(),
			instanceIndex.div( nb ).toFloat(),
		);
		const b8 = bloc.add( vec2( 8 ) );
		const jx = hash( b8.x.mul( 127.1 ).add( b8.y.mul( 311.7 ) ) );
		const jy = hash( b8.x.mul( 269.5 ).add( b8.y.mul( 183.3 ) ) );
		const center = bloc.add( vec2( 0.1 ) ).add( vec2( jx, jy ).mul( 0.8 ) ).mul( u.spacing );

		const cell = floor( center );
		const idx = cell.y.toInt().mul( GRID ).add( cell.x.toInt() );
		const stock = foodRead.element( idx ).toFloat();

		// échelle : pleine → 0, en racine cubique (fond de bille persistant)
		const fill = clamp( stock.div( u.foodRef ), 0, 1 );
		const scale = u.ballSize.mul( pow( fill, 0.34 ) ).mul( select( stock.greaterThan( 0.5 ), 1, 0 ) );

		const world = vec3(
			center.x.div( GRID ).sub( 0.5 ).mul( WORLD ),
			0,
			center.y.div( GRID ).sub( 0.5 ).mul( WORLD ),
		);

		return { world, scale };

	};

	const count = () => Math.ceil( GRID / gfx.foodBallSpacing ) ** 2;

	// ------------------------------------------------------------------
	// Billes
	// ------------------------------------------------------------------
	const ballGeo = new THREE.InstancedBufferGeometry();
	const ico = new THREE.IcosahedronGeometry( 1, 0 );
	ballGeo.index = ico.index;
	ballGeo.attributes = ico.attributes;
	ballGeo.instanceCount = count();

	const ballMat = new THREE.MeshStandardNodeMaterial( { roughness: 0.45, metalness: 0 } );
	ballMat.colorNode = uFoodColor;
	ballMat.emissiveNode = Fn( () => uFoodColor.mul( uFoodGlow ) )();

	ballMat.positionNode = Fn( () => {

		const { world, scale } = ballOfBlock();
		return positionLocal.mul( scale ).add( world ).add( vec3( 0, scale.mul( 0.72 ), 0 ) );

	} )();

	const balls = new THREE.Mesh( ballGeo, ballMat );
	balls.frustumCulled = false;
	scene.add( balls );

	// ------------------------------------------------------------------
	// Halos lucioles : billboards additifs à fondu radial
	// ------------------------------------------------------------------
	const haloGeo = new THREE.InstancedBufferGeometry();
	const quad = new THREE.PlaneGeometry( 1, 1 );
	haloGeo.index = quad.index;
	haloGeo.attributes = quad.attributes;
	haloGeo.instanceCount = count();

	const haloMat = new THREE.MeshBasicNodeMaterial( {
		transparent: true,
		blending: THREE.AdditiveBlending,
		depthWrite: false,
		toneMapped: false,
		fog: false,
	} );

	haloMat.positionNode = Fn( () => {

		const { world, scale } = ballOfBlock();
		const center = world.add( vec3( 0, scale.mul( 0.72 ), 0 ) );

		const view = normalize( cameraPosition.sub( center ) );
		const right = normalize( cross( vec3( 0, 1, 0 ), view ) );
		const up = cross( view, right );
		const size = scale.mul( 8 ).mul( u.haloSize );

		return center
			.add( right.mul( positionLocal.x.mul( size ) ) )
			.add( up.mul( positionLocal.y.mul( size ) ) );

	} )();

	haloMat.colorNode = Fn( () => {

		const d = uv().sub( vec2( 0.5, 0.5 ) ).length().mul( 2 );
		const glow = smoothstep( 1, 0, d ).pow( 2.2 );
		return uFoodColor.mul( glow ).mul( u.haloIntensity ).mul( 0.55 );

	} )();

	const halos = new THREE.Mesh( haloGeo, haloMat );
	halos.frustumCulled = false;
	scene.add( halos );

	return {
		u,
		// à appeler quand l'espacement ou la quantité changent (UI)
		refresh() {

			u.spacing.value = gfx.foodBallSpacing;
			u.blocks.value = Math.ceil( GRID / gfx.foodBallSpacing );
			u.foodRef.value = params.foodAmount;
			ballGeo.instanceCount = count();
			haloGeo.instanceCount = count();

		},
	};

}
