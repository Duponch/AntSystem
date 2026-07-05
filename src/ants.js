// Rendu des fourmis : le maillage du GLB instancié, transformé dans le vertex
// shader directement depuis les buffers de la simulation (aucun aller-retour CPU).
//
// Le GLB n'a pas de normales → three bascule automatiquement en flat shading
// (normales dérivées des positions transformées), donc l'éclairage des
// instances tournées est correct sans retouche.

import * as THREE from 'three/webgpu';
import {
	Fn, instanceIndex, positionLocal,
	vec3, mat3, float, cos, sin, time, abs,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { GRID, WORLD, params } from './config.js';

const ANT_LENGTH = 0.95; // longueur du corps en unités monde

export async function createAnts( sim ) {

	// --- géométrie : fusion des primitives du GLB, pieds au sol, taille normalisée ---
	const gltf = await new GLTFLoader().loadAsync( '/Ant.glb' );
	gltf.scene.updateMatrixWorld( true );

	const parts = [];
	gltf.scene.traverse( ( o ) => {

		if ( o.isMesh ) {

			const g = o.geometry.clone();
			g.applyMatrix4( o.matrixWorld );
			parts.push( g );

		}

	} );

	const merged = mergeGeometries( parts, false );
	merged.computeBoundingBox();

	const bb = merged.boundingBox;
	const size = new THREE.Vector3();
	bb.getSize( size );

	const scale = ANT_LENGTH / size.z;
	merged.translate(
		- ( bb.min.x + bb.max.x ) / 2,
		- bb.min.y,
		- ( bb.min.z + bb.max.z ) / 2,
	);
	merged.scale( scale, scale, scale );

	const headZ = ( size.z / 2 ) * scale;     // avant du corps (+Z supposé)
	const bodyH = size.y * scale;

	// --- transformation par instance, partagée par le corps et le point de nourriture ---
	const texel = WORLD / GRID;

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

	// --- corps ---
	const bodyGeo = new THREE.InstancedBufferGeometry();
	bodyGeo.index = merged.index;
	bodyGeo.attributes = merged.attributes;
	bodyGeo.instanceCount = params.antCount;

	const bodyMat = new THREE.MeshStandardNodeMaterial( {
		color: 0x16120e,
		roughness: 0.6,
		metalness: 0.0,
	} );

	bodyMat.positionNode = Fn( () => {

		const { rot, world } = instanceTransform();

		// léger trottinement
		const bob = abs( sin( time.mul( 26 ).add( instanceIndex.toFloat().mul( 1.71 ) ) ) ).mul( 0.02 );

		return rot.mul( positionLocal ).add( world ).add( vec3( 0, bob, 0 ) );

	} )();

	const body = new THREE.Mesh( bodyGeo, bodyMat );
	body.frustumCulled = false;
	body.castShadow = true;
	body.receiveShadow = true;

	// --- grain de nourriture porté (échelle 0 quand la fourmi n'a rien) ---
	const grainGeo = new THREE.InstancedBufferGeometry();
	const ico = new THREE.IcosahedronGeometry( 0.14, 1 );
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
		const offset = rot.mul( vec3( 0, bodyH * 0.65, headZ * 0.9 ) );

		return positionLocal.mul( carrying ).add( offset ).add( world );

	} )();

	const grain = new THREE.Mesh( grainGeo, grainMat );
	grain.frustumCulled = false;
	grain.castShadow = true;

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
			grain.castShadow = on;

		},
	};

}
