// Débogage : cône de vision de chaque fourmi (comme la vidéo de référence).
// Un éventail plat par fourmi, dérivé en shader depuis les buffers de la
// simulation et les uniforms RÉELS des capteurs (angle + portée) — le cône
// affiché est exactement celui que la fourmi utilise. Couleur = carte lue :
// orange (nourriture) pour une exploratrice, bleu (maison) pour une porteuse.
// Masqué par défaut : zéro coût tant que le toggle est éteint.

import * as THREE from 'three/webgpu';
import {
	Fn, instanceIndex, attribute, uniform,
	vec2, vec3, float, cos, sin, select, mix,
} from 'three/tsl';

import { GRID, WORLD, params, gfx } from '../config.js';

const SEGMENTS = 10;

export function createDebugCones( scene, sim ) {

	// éventail unitaire : sommet (ring=0) + arc de t = -1..1 (ring=1) ;
	// l'angle et la portée réels sont appliqués dans le vertex shader
	const tArr = [ 0 ];
	const ringArr = [ 0 ];

	for ( let i = 0; i <= SEGMENTS; i ++ ) {

		tArr.push( - 1 + ( 2 * i ) / SEGMENTS );
		ringArr.push( 1 );

	}

	const idx = [];
	for ( let i = 0; i < SEGMENTS; i ++ ) idx.push( 0, 1 + i, 2 + i );

	const geo = new THREE.InstancedBufferGeometry();
	geo.setAttribute( 'coneT', new THREE.Float32BufferAttribute( tArr, 1 ) );
	geo.setAttribute( 'coneRing', new THREE.Float32BufferAttribute( ringArr, 1 ) );
	// attribut position requis par three (les vraies positions viennent du shader)
	geo.setAttribute( 'position', new THREE.Float32BufferAttribute( new Float32Array( tArr.length * 3 ), 3 ) );
	geo.setIndex( idx );
	geo.instanceCount = params.antCount;

	const material = new THREE.MeshBasicNodeMaterial( {
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		fog: false,
	} );

	const texel = WORLD / GRID;

	material.positionNode = Fn( () => {

		const a = sim.antData.element( instanceIndex );
		const t = attribute( 'coneT', 'float' );
		const ring = attribute( 'coneRing', 'float' );

		// fourmi MORTE (cadavre état 2 / dévorée état 3) : pas de vision → cône
		// réduit à un point (invisible), sinon on verrait des cônes sans fourmi
		const live = select( sim.antState.element( instanceIndex ).toFloat().lessThan( 2 ), float( 1 ), float( 0 ) );
		const dir = a.z.add( t.mul( sim.u.sensorAngle ) );
		const g = a.xy.add( vec2( cos( dir ), sin( dir ) ).mul( ring.mul( sim.u.sensorDist ).mul( live ) ) );

		return vec3(
			g.x.mul( texel ).sub( WORLD / 2 ),
			0.07,
			g.y.mul( texel ).sub( WORLD / 2 ),
		);

	} )();

	material.colorNode = Fn( () => {

		const carrying = sim.antState.element( instanceIndex ).toFloat();
		// couleur de la carte LUE : exploratrice → nourriture (orange),
		// porteuse → maison (bleu)
		return mix( vec3( 1.0, 0.55, 0.15 ), vec3( 0.25, 0.55, 1.0 ), carrying );

	} )();

	material.opacityNode = Fn( () => {

		return float( 0.34 ).sub( attribute( 'coneRing', 'float' ).mul( 0.22 ) );

	} )();

	const mesh = new THREE.Mesh( geo, material );
	mesh.frustumCulled = false;
	mesh.renderOrder = 2;
	mesh.visible = gfx.debugCones;
	scene.add( mesh );

	return {
		setVisible( v ) {

			mesh.visible = v;

		},
		setCount( n ) {

			geo.instanceCount = n;

		},
	};

}
