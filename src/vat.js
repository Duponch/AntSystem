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
	// colonne VAT de chaque sommet (identité pour le maillage plein ;
	// les LOD décimés pointent vers les colonnes de leurs représentants)
	const vatIndex = new Float32Array( totalVerts );
	for ( let i = 0; i < totalVerts; i ++ ) vatIndex[ i ] = i;
	geometry.setAttribute( 'vatIndex', new THREE.BufferAttribute( vatIndex, 1 ) );
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

// ---------------------------------------------------------------------------
// LOD par clustering : les sommets sont regroupés par cellule (taille en
// unités monde du modèle normalisé), chaque cluster garde UN représentant qui
// pointe vers SA colonne VAT (attribut vatIndex) — même texture d'animation,
// topologie réduite, triangles dégénérés éliminés.
// ---------------------------------------------------------------------------
export function buildLodGeometry( vat, cellSize ) {

	const pos = vat.geometry.attributes.position.array;
	const srcIndex = vat.geometry.index.array;
	const nV = vat.totalVerts;

	// cluster de chaque sommet
	const clusterKey = new Array( nV );
	const clusters = new Map();       // clé → { sum: [x,y,z], members: [] }

	for ( let i = 0; i < nV; i ++ ) {

		const key =
			Math.round( pos[ i * 3 ] / cellSize ) + ',' +
			Math.round( pos[ i * 3 + 1 ] / cellSize ) + ',' +
			Math.round( pos[ i * 3 + 2 ] / cellSize );
		clusterKey[ i ] = key;

		let c = clusters.get( key );
		if ( ! c ) clusters.set( key, c = { sx: 0, sy: 0, sz: 0, members: [] } );
		c.sx += pos[ i * 3 ]; c.sy += pos[ i * 3 + 1 ]; c.sz += pos[ i * 3 + 2 ];
		c.members.push( i );

	}

	// représentant = le membre le plus proche du centroïde
	const repOf = new Int32Array( nV );
	const newIdOf = new Map();        // vertex représentant → id compacté
	const reps = [];

	for ( const c of clusters.values() ) {

		const n = c.members.length;
		const cx = c.sx / n, cy = c.sy / n, cz = c.sz / n;
		let best = c.members[ 0 ], bd = Infinity;

		for ( const m of c.members ) {

			const d = ( pos[ m * 3 ] - cx ) ** 2 + ( pos[ m * 3 + 1 ] - cy ) ** 2 + ( pos[ m * 3 + 2 ] - cz ) ** 2;
			if ( d < bd ) { bd = d; best = m; }

		}

		newIdOf.set( best, reps.length );
		reps.push( best );
		for ( const m of c.members ) repOf[ m ] = best;

	}

	// index décimé (triangles dégénérés éliminés)
	const outIndex = [];

	for ( let t = 0; t < srcIndex.length; t += 3 ) {

		const a = repOf[ srcIndex[ t ] ], b = repOf[ srcIndex[ t + 1 ] ], c = repOf[ srcIndex[ t + 2 ] ];
		if ( a === b || b === c || a === c ) continue;
		outIndex.push( newIdOf.get( a ), newIdOf.get( b ), newIdOf.get( c ) );

	}

	const outPos = new Float32Array( reps.length * 3 );
	const outVat = new Float32Array( reps.length );

	reps.forEach( ( src, i ) => {

		outPos[ i * 3 ] = pos[ src * 3 ];
		outPos[ i * 3 + 1 ] = pos[ src * 3 + 1 ];
		outPos[ i * 3 + 2 ] = pos[ src * 3 + 2 ];
		outVat[ i ] = src;

	} );

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( outPos, 3 ) );
	geometry.setAttribute( 'vatIndex', new THREE.BufferAttribute( outVat, 1 ) );
	geometry.setIndex( new THREE.BufferAttribute( new Uint16Array( outIndex ), 1 ) );

	return { geometry, triangles: outIndex.length / 3, vertices: reps.length };

}
