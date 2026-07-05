// Vertex Animation Texture : le cycle de marche squelettique du GLB rigué est
// échantillonné une fois au chargement (CPU), puis stocké dans une texture
// float32 (colonne = sommet, ligne = frame). Le vertex shader instancié lit
// deux frames et interpole — le skinning ne coûte plus rien, quel que soit le
// nombre de fourmis. Pas de normales : le flat shading les dérive des
// positions déformées.

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadAntVAT( url, { frames = 20, targetLength = 0.95 } = {} ) {

	const gltf = await new GLTFLoader().loadAsync( url );
	const root = gltf.scene;
	root.updateMatrixWorld( true );

	const skinned = [];
	root.traverse( ( o ) => {

		if ( o.isSkinnedMesh ) skinned.push( o );

	} );

	if ( skinned.length === 0 ) throw new Error( `${url} : aucun SkinnedMesh` );

	const clip = gltf.animations.find( ( a ) => a.name === 'Walk' ) || gltf.animations[ 0 ];
	const mixer = new THREE.AnimationMixer( root );
	mixer.clipAction( clip ).play();

	const counts = skinned.map( ( m ) => m.geometry.attributes.position.count );
	const totalVerts = counts.reduce( ( a, b ) => a + b, 0 );

	// --- échantillonnage des frames (espace monde du GLB) ---
	const data = new Float32Array( totalVerts * frames * 4 );
	const v = new THREE.Vector3();
	const min = new THREE.Vector3( Infinity, Infinity, Infinity );
	const max = new THREE.Vector3( - Infinity, - Infinity, - Infinity );

	for ( let f = 0; f < frames; f ++ ) {

		mixer.setTime( ( clip.duration * f ) / frames );
		root.updateMatrixWorld( true );

		let column = 0;

		for ( const m of skinned ) {

			const n = m.geometry.attributes.position.count;

			for ( let i = 0; i < n; i ++ ) {

				// position skinnée (les matrices monde des os incluent tout)
				m.getVertexPosition( i, v );

				const o = ( f * totalVerts + column ) * 4;
				data[ o ] = v.x;
				data[ o + 1 ] = v.y;
				data[ o + 2 ] = v.z;
				data[ o + 3 ] = 1;

				min.min( v );
				max.max( v );
				column ++;

			}

		}

	}

	// --- normalisation : centré en X/Z, pieds à y=0, longueur cible sur Z ---
	const size = new THREE.Vector3().subVectors( max, min );
	const scale = targetLength / size.z;
	const cx = ( min.x + max.x ) / 2;
	const cz = ( min.z + max.z ) / 2;

	for ( let i = 0; i < totalVerts * frames; i ++ ) {

		const o = i * 4;
		data[ o ] = ( data[ o ] - cx ) * scale;
		data[ o + 1 ] = ( data[ o + 1 ] - min.y ) * scale;
		data[ o + 2 ] = ( data[ o + 2 ] - cz ) * scale;

	}

	const texture = new THREE.DataTexture( data, totalVerts, frames, THREE.RGBAFormat, THREE.FloatType );
	texture.minFilter = THREE.NearestFilter;
	texture.magFilter = THREE.NearestFilter;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;

	// --- géométrie fusionnée, dans le MÊME ordre de sommets que les colonnes ---
	// (position frame 0 conservée pour les bornes ; le rendu lit la VAT)
	const position = new Float32Array( totalVerts * 3 );

	for ( let i = 0; i < totalVerts; i ++ ) {

		position[ i * 3 ] = data[ i * 4 ];
		position[ i * 3 + 1 ] = data[ i * 4 + 1 ];
		position[ i * 3 + 2 ] = data[ i * 4 + 2 ];

	}

	let indexCount = 0;
	for ( const m of skinned ) indexCount += m.geometry.index.count;

	const index = new Uint16Array( indexCount );
	let indexOffset = 0;
	let vertexOffset = 0;

	for ( const m of skinned ) {

		const src = m.geometry.index.array;

		for ( let i = 0; i < src.length; i ++ ) index[ indexOffset + i ] = src[ i ] + vertexOffset;

		indexOffset += src.length;
		vertexOffset += m.geometry.attributes.position.count;

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( position, 3 ) );
	geometry.setIndex( new THREE.BufferAttribute( index, 1 ) );

	const bounds = {
		length: size.z * scale,
		height: size.y * scale,
		width: size.x * scale,
		headZ: ( max.z - cz ) * scale,
	};

	// counts[0] = sommets du corps (1er matériau), counts[1] = yeux/antennes
	return { texture, geometry, frames, totalVerts, counts, bounds, cycleDuration: clip.duration };

}
