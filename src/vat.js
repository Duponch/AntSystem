// Vertex Animation Texture : le cycle de marche squelettique du GLB rigué est
// échantillonné une fois au chargement (CPU), puis stocké dans une texture
// float32 (colonne = sommet, ligne = frame). Le vertex shader instancié lit
// deux frames et interpole — le skinning ne coûte plus rien, quel que soit le
// nombre de fourmis. Pas de normales : le flat shading les dérive des
// positions déformées.

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Conversion float32 → demi-flottants. La VAT est le poste de bande passante
// DOMINANT du rendu (2-3 fetchs par sommet × des dizaines de millions
// d'invocations) : la passer en rgba16float divise son trafic par deux.
// Précision : les coordonnées normalisées vivent dans [-0,5 ; +0,5], où l'ULP
// d'un half vaut ~2,4e-4 unité monde — soit ~1,5 % d'un pixel à la distance de
// plein détail. Invisible.
function toHalfRGBA( src ) {

	const out = new Uint16Array( src.length );
	for ( let i = 0; i < src.length; i ++ ) out[ i ] = THREE.DataUtils.toHalfFloat( src[ i ] );
	return out;

}

// Repli des pattes à la mort. Fait entomologique : chez l'insecte l'EXTENSION
// des pattes est hydraulique (pression de l'hémolymphe) et la FLEXION est
// musculaire. À la mort la pression tombe, les fléchisseurs l'emportent seuls :
// les pattes se recroquevillent sous le corps. C'est pour ça qu'un insecte mort
// se retrouve « sur le dos, pattes en l'air et repliées » — la pose n'est pas
// une convention graphique, c'est le résultat d'un processus. Ici on la BAKE
// pour que la fourmi l'atteigne par la physique au lieu qu'on la lui plaque.
const DEATH_CURL = {
	femur: 0.55,      // rad, repli du fémur vers le ventre
	tibia: 1.30,      // rad, flexion du genou (dominante)
	inward: 0.35,     // rad, rentrée vers l'axe du corps
	head: 0.22,       // tête qui retombe
	abdomen: 0.30,    // gastre qui s'enroule
	antenna: 0.55,    // antennes qui retombent
};

// Applique une rotation MONDE d'angle `angle` autour de l'axe `axis` à un os,
// autour de sa propre origine (la hiérarchie porte le reste de la chaîne).
const _pq = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _dq = new THREE.Quaternion();

function rotateBoneWorld( bone, axis, angle ) {

	if ( ! bone || Math.abs( angle ) < 1e-6 ) return;
	bone.parent.getWorldQuaternion( _pq );
	bone.getWorldQuaternion( _wq );
	_dq.setFromAxisAngle( axis, angle );
	_wq.premultiply( _dq );
	bone.quaternion.copy( _pq.invert().multiply( _wq ) );

}

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

	// une rangée SUPPLÉMENTAIRE (indice `frames`) porte la pose de mort
	const rows = frames + 1;

	// --- échantillonnage des frames (espace monde du GLB) ---
	const data = new Float32Array( totalVerts * rows * 4 );
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

	// --- pose de MORT : frame 0 du cycle, puis repli des appendices ---
	// (échantillonnée APRÈS les bornes du cycle de marche : la normalisation
	// reste EXACTEMENT celle d'avant, le rendu de la marche est inchangé)
	const bones = {};
	root.traverse( ( o ) => {

		if ( o.isBone ) bones[ o.name ] = o;

	} );

	mixer.setTime( 0 );
	root.updateMatrixWorld( true );

	const rootBone = bones.root || skinned[ 0 ].skeleton.bones[ 0 ];
	const rootPos = new THREE.Vector3().setFromMatrixPosition( rootBone.matrixWorld );
	const UP = new THREE.Vector3( 0, 1, 0 );
	const radial = new THREE.Vector3();
	const tangent = new THREE.Vector3();

	for ( const side of [ 'L', 'R' ] ) {

		for ( const pair of [ 'F', 'M', 'R' ] ) {

			const femur = bones[ `leg${pair}${side}F` ];
			const tibia = bones[ `leg${pair}${side}T` ];
			if ( ! femur ) continue;

			// axe de repli : perpendiculaire au rayon corps→patte, dans le plan
			// horizontal. Une rotation positive autour de lui rabat la pointe
			// vers le ventre — le geste exact du fléchisseur.
			radial.setFromMatrixPosition( femur.matrixWorld ).sub( rootPos );
			radial.y = 0;
			if ( radial.lengthSq() < 1e-9 ) radial.set( 1, 0, 0 );
			radial.normalize();
			tangent.crossVectors( UP, radial ).normalize();

			rotateBoneWorld( femur, tangent, DEATH_CURL.femur );
			// rentrée vers l'axe du corps (les pattes se rassemblent)
			rotateBoneWorld( femur, UP, - DEATH_CURL.inward * Math.sign( radial.x || 1 ) );
			root.updateMatrixWorld( true );
			rotateBoneWorld( tibia, tangent, DEATH_CURL.tibia );

		}

	}

	root.updateMatrixWorld( true );

	// tête, gastre et antennes retombent (axe transversal du corps)
	const sideAxis = new THREE.Vector3( 1, 0, 0 );
	rotateBoneWorld( bones.head, sideAxis, DEATH_CURL.head );
	rotateBoneWorld( bones.abdomen, sideAxis, - DEATH_CURL.abdomen );
	root.updateMatrixWorld( true );
	rotateBoneWorld( bones.antL, sideAxis, DEATH_CURL.antenna );
	rotateBoneWorld( bones.antR, sideAxis, DEATH_CURL.antenna );
	root.updateMatrixWorld( true );

	{

		let column = 0;

		for ( const m of skinned ) {

			const n = m.geometry.attributes.position.count;

			for ( let i = 0; i < n; i ++ ) {

				m.getVertexPosition( i, v );
				const o = ( frames * totalVerts + column ) * 4;
				data[ o ] = v.x;
				data[ o + 1 ] = v.y;
				data[ o + 2 ] = v.z;
				data[ o + 3 ] = 1;
				column ++;

			}

		}

	}

	// --- normalisation : centré en X/Z, pieds à y=0, longueur cible sur Z ---
	// (bornes calculées sur le CYCLE DE MARCHE seul → non-régression stricte)
	const size = new THREE.Vector3().subVectors( max, min );
	const scale = targetLength / size.z;
	const cx = ( min.x + max.x ) / 2;
	const cz = ( min.z + max.z ) / 2;

	for ( let i = 0; i < totalVerts * rows; i ++ ) {

		const o = i * 4;
		data[ o ] = ( data[ o ] - cx ) * scale;
		data[ o + 1 ] = ( data[ o + 1 ] - min.y ) * scale;
		data[ o + 2 ] = ( data[ o + 2 ] - cz ) * scale;

	}

	// pivot du corps = articulation « root » du rig : c'est autour d'ELLE que
	// la fourmi culbute (pas autour de ses pieds). Tout le rendu compense ce
	// décalage, la valeur ne doit JAMAIS être codée en dur.
	const pivotY = ( rootPos.y - min.y ) * scale;

	// hauteur de repos du CADAVRE pour les 4 quadrants de roulis (debout, flanc,
	// dos, flanc) : de combien relever le pivot pour que le point le plus bas de
	// la pose de mort effleure le sol. Bakée, jamais devinée — sinon le cadavre
	// s'enfonce ou flotte selon le quadrant.
	const restY = [ 0, 0, 0, 0 ];

	for ( let q = 0; q < 4; q ++ ) {

		const a = ( q * Math.PI ) / 2;
		const c = Math.cos( a );
		const s = Math.sin( a );
		let lowest = Infinity;

		for ( let i = 0; i < totalVerts; i ++ ) {

			const o = ( frames * totalVerts + i ) * 4;
			const x = data[ o ];
			const y = data[ o + 1 ] - pivotY;
			// roulis autour de l'axe AVANT (+Z) : (x, y) → (x·c − y·s, x·s + y·c)
			const ry = x * s + y * c;
			if ( ry < lowest ) lowest = ry;

		}

		restY[ q ] = - lowest;

	}

	const texture = new THREE.DataTexture( toHalfRGBA( data ), totalVerts, rows, THREE.RGBAFormat, THREE.HalfFloatType );
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

	// --- rig : 1 os dominant par sommet + repères de bind (espace normalisé) ---
	// Le skinning de ce GLB est RIGIDE (1 influence par sommet, vérifié au parse) :
	// un seul index d'os par sommet suffit, et le ragdoll n'a besoin que d'UNE
	// matrice par sommet au lieu de quatre.
	const skeleton = skinned[ 0 ].skeleton;
	const boneNames = skeleton.bones.map( ( b ) => b.name );
	const boneOf = new Uint8Array( totalVerts );
	{

		let column = 0;

		for ( const m of skinned ) {

			const si = m.geometry.attributes.skinIndex;
			const sw = m.geometry.attributes.skinWeight;
			const n = m.geometry.attributes.position.count;

			for ( let i = 0; i < n; i ++ ) {

				let best = 0;
				let bw = - 1;

				for ( let k = 0; k < 4; k ++ ) {

					const w = sw.getComponent( i, k );
					if ( w > bw ) { bw = w; best = si.getComponent( i, k ); }

				}

				boneOf[ column ++ ] = best;

			}

		}

	}

	// Repères de bind de chaque os, dans l'espace VAT normalisé — c'est là que
	// le ragdoll place ses particules et reconstruit ses rotations.
	//   boneRest = origine de l'os
	//   boneAxis = son axe propre (+Y local : le rig fait pointer chaque os vers
	//              son enfant par cette translation, vérifié au parse du GLB)
	//   boneLen  = extension maximale de la chair portée par cet os le long de
	//              son axe → donne la position du TARSE (bout de patte), qu'aucun
	//              os ne matérialise
	mixer.setTime( 0 );
	root.updateMatrixWorld( true );
	const nBones = skeleton.bones.length;
	const boneRest = new Float32Array( nBones * 3 );
	const boneAxis = new Float32Array( nBones * 3 );
	const boneLen = new Float32Array( nBones );
	const bp = new THREE.Vector3();
	const ba = new THREE.Vector3();

	skeleton.bones.forEach( ( b, i ) => {

		bp.setFromMatrixPosition( b.matrixWorld );
		boneRest[ i * 3 ] = ( bp.x - cx ) * scale;
		boneRest[ i * 3 + 1 ] = ( bp.y - min.y ) * scale;
		boneRest[ i * 3 + 2 ] = ( bp.z - cz ) * scale;
		// axe = colonne Y de la matrice monde (l'échelle uniforme ne le tourne pas)
		ba.set( b.matrixWorld.elements[ 4 ], b.matrixWorld.elements[ 5 ], b.matrixWorld.elements[ 6 ] ).normalize();
		boneAxis[ i * 3 ] = ba.x;
		boneAxis[ i * 3 + 1 ] = ba.y;
		boneAxis[ i * 3 + 2 ] = ba.z;

	} );

	// extension de chaque os : le sommet le plus éloigné le long de son axe
	// parmi ceux qu'il pilote (rig rigide → appartenance sans ambiguïté)
	for ( let v = 0; v < totalVerts; v ++ ) {

		const b = boneOf[ v ];
		const o = v * 4;                       // ligne 0 = frame 0, déjà normalisée
		const dx = data[ o ] - boneRest[ b * 3 ];
		const dy = data[ o + 1 ] - boneRest[ b * 3 + 1 ];
		const dz = data[ o + 2 ] - boneRest[ b * 3 + 2 ];
		const t = dx * boneAxis[ b * 3 ] + dy * boneAxis[ b * 3 + 1 ] + dz * boneAxis[ b * 3 + 2 ];
		if ( t > boneLen[ b ] ) boneLen[ b ] = t;

	}

	console.info(
		`AntSystem rig : ${skeleton.bones.length} os, pivot Y = ${pivotY.toFixed( 4 )} `
		+ `(${( pivotY / bounds.height * 100 ).toFixed( 0 )} % de la hauteur), `
		+ `repos cadavre = [${restY.map( ( r ) => r.toFixed( 3 ) ).join( ', ' )}]`,
	);

	// counts[0] = sommets du corps (1er matériau), counts[1] = yeux/antennes
	return {
		texture, geometry, frames, totalVerts, counts, bounds,
		cycleDuration: clip.duration,
		deathRow: frames,       // rangée de la pose de mort dans la VAT
		pivotY,                 // hauteur du pivot corporel (espace normalisé)
		restY,                  // hauteur de repos du cadavre par quadrant de roulis
		rig: {
			boneNames, boneOf, boneRest, boneAxis, boneLen,
			parentOf: skeleton.bones.map( ( b ) => skeleton.bones.indexOf( b.parent ) ),
		},
	};

}

// ---------------------------------------------------------------------------
// VAT MULTI-CLIPS : plusieurs clips (Idle/Walk/Attack/Death…) sont bakés dans
// UNE texture — colonnes = sommets, lignes = frames de tous les clips
// concaténées. Le rendu échantillonne par (indice de clip, phase 0..1) via une
// table {offset, frames} et peut fondre deux clips (transition douce). Le
// skinning ne coûte plus rien → des centaines/milliers d'instances animées.
// ---------------------------------------------------------------------------
export async function loadVATMulti( url, { clipNames = [], fps = 16, targetLength = 1 } = {} ) {

	const gltf = await new GLTFLoader().loadAsync( url );
	const root = gltf.scene;
	root.updateMatrixWorld( true );

	const skinned = [];
	root.traverse( ( o ) => {

		if ( o.isSkinnedMesh ) skinned.push( o );

	} );

	if ( skinned.length === 0 ) throw new Error( `${url} : aucun SkinnedMesh` );

	const clips = clipNames.map( ( n ) => {

		const clip = gltf.animations.find( ( a ) => a.name.includes( n ) );
		if ( ! clip ) throw new Error( `${url} : clip « ${n} » introuvable` );
		return clip;

	} );

	const mixer = new THREE.AnimationMixer( root );
	const counts = skinned.map( ( m ) => m.geometry.attributes.position.count );
	const totalVerts = counts.reduce( ( a, b ) => a + b, 0 );

	// table des clips (offset de ligne + nb de frames) et total de lignes
	const clipInfos = [];
	let totalRows = 0;

	for ( const clip of clips ) {

		const frames = Math.max( 2, Math.round( clip.duration * fps ) );
		clipInfos.push( { name: clip.name, offset: totalRows, frames, duration: clip.duration } );
		totalRows += frames;

	}

	// --- échantillonnage de tous les clips ---
	const data = new Float32Array( totalVerts * totalRows * 4 );
	const v = new THREE.Vector3();
	const min = new THREE.Vector3( Infinity, Infinity, Infinity );
	const max = new THREE.Vector3( - Infinity, - Infinity, - Infinity );

	clips.forEach( ( clip, ci ) => {

		mixer.stopAllAction();
		const action = mixer.clipAction( clip );
		action.reset().play();

		const info = clipInfos[ ci ];

		for ( let f = 0; f < info.frames; f ++ ) {

			mixer.setTime( ( clip.duration * f ) / info.frames );
			root.updateMatrixWorld( true );

			let column = 0;

			for ( const m of skinned ) {

				const n = m.geometry.attributes.position.count;

				for ( let i = 0; i < n; i ++ ) {

					m.getVertexPosition( i, v );
					// espace monde du GLB : inclut la rotation racine (Z-up→Y-up de
					// Blender) que getVertexPosition (espace de bind local) ignore —
					// sinon le modèle sort couché/vertical
					v.applyMatrix4( m.matrixWorld );
					const o = ( ( info.offset + f ) * totalVerts + column ) * 4;
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

		action.stop();

	} );

	// --- normalisation : centré X/Z, pieds à y=0, longueur cible sur l'axe majeur ---
	const size = new THREE.Vector3().subVectors( max, min );
	const scale = targetLength / Math.max( size.x, size.z );
	const cx = ( min.x + max.x ) / 2;
	const cz = ( min.z + max.z ) / 2;

	for ( let i = 0; i < totalVerts * totalRows; i ++ ) {

		const o = i * 4;
		data[ o ] = ( data[ o ] - cx ) * scale;
		data[ o + 1 ] = ( data[ o + 1 ] - min.y ) * scale;
		data[ o + 2 ] = ( data[ o + 2 ] - cz ) * scale;

	}

	const texture = new THREE.DataTexture( toHalfRGBA( data ), totalVerts, totalRows, THREE.RGBAFormat, THREE.HalfFloatType );
	texture.minFilter = THREE.NearestFilter;
	texture.magFilter = THREE.NearestFilter;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;

	// --- géométrie fusionnée (même ordre de sommets que les colonnes) ---
	const position = new Float32Array( totalVerts * 3 );

	for ( let i = 0; i < totalVerts; i ++ ) {

		position[ i * 3 ] = data[ i * 4 ];
		position[ i * 3 + 1 ] = data[ i * 4 + 1 ];
		position[ i * 3 + 2 ] = data[ i * 4 + 2 ];

	}

	let indexCount = 0;
	for ( const m of skinned ) indexCount += m.geometry.index.count;

	const index = new ( totalVerts > 65535 ? Uint32Array : Uint16Array )( indexCount );
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
	const vatIndex = new Float32Array( totalVerts );
	for ( let i = 0; i < totalVerts; i ++ ) vatIndex[ i ] = i;
	geometry.setAttribute( 'vatIndex', new THREE.BufferAttribute( vatIndex, 1 ) );
	geometry.setIndex( new THREE.BufferAttribute( index, 1 ) );

	const bounds = { length: Math.max( size.x, size.z ) * scale, height: size.y * scale };

	return { texture, geometry, totalVerts, counts, bounds, clipInfos };

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
