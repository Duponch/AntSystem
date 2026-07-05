// Décor low-poly depuis E:/Code/Simulation/Pack_assets : arbres en lisière,
// bûches/souche/rocher comme OBSTACLES (leur empreinte est rasterisée dans la
// grille de murs de la simulation → les fourmis les contournent), champignons,
// fougères et cailloux en déco.
//
// Pattern du projet source : FBX fusionné en une géométrie unité (base à y=0),
// UN matériau partagé (atlas 1024² de gradients), un InstancedMesh par
// variété (< 1024 instances — limite du buffer uniform d'instanceMatrix en
// WebGPU), échelle portée par la matrice d'instance.

import * as THREE from 'three/webgpu';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { WORLD, GRID, worldToGrid } from '../config.js';

const T = GRID / WORLD;   // texels par unité monde

// ---------------------------------------------------------------------------
// Composition de la clairière (coordonnées monde, terrain ±80)
// ---------------------------------------------------------------------------

// obstacles physiques : 'rect' = normalisé sur la longueur Z (bûches, branche),
// 'disc' = normalisé sur la hauteur (souche, rocher). L'empreinte murale est
// dérivée de l'encombrement MESURÉ de la géométrie, pas de constantes.
const OBSTACLES = [
	{ model: 'Log_01', kind: 'rect', x: - 16, z: - 14, yaw: 0.52, scale: 13.0 },
	{ model: 'Log_02', kind: 'rect', x: 16, z: 30, yaw: - 0.87, scale: 9.5 },
	{ model: 'Branch', kind: 'rect', x: 36, z: - 16, yaw: 1.75, scale: 6.0 },
	{ model: 'Stump_01', kind: 'disc', x: 10, z: - 32, yaw: 0.3, scale: 1.6 },
	{ model: 'BigRock_03', kind: 'disc', x: - 34, z: 22, yaw: 2.1, scale: 3.4 },
];

// points à éviter pour la déco : nid + gisements de départ (voir _seedFood)
const KEEP_CLEAR = [
	{ x: 0, z: 0, r: 14 },
	{ x: 34.2, z: 18.8, r: 6 }, { x: - 20.8, z: 45.4, r: 6 },
	{ x: - 26.8, z: 16.1, r: 6 }, { x: - 35.8, z: - 22.3, r: 6 },
	{ x: - 14.4, z: - 44.7, r: 6 }, { x: 21.1, z: - 52.1, r: 6 },
	...OBSTACLES.map( ( o ) => ( { x: o.x, z: o.z, r: o.scale / 2 + 4 } ) ),
];

function mulberry32( seed ) {

	return () => {

		seed |= 0; seed = ( seed + 0x6D2B79F5 ) | 0;
		let t = Math.imul( seed ^ ( seed >>> 15 ), 1 | seed );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// ---------------------------------------------------------------------------

export async function createProps( scene ) {

	// --- atlas partagé (réglages anti-bleeding du projet source) ---
	const atlas = await new THREE.TextureLoader().loadAsync( '/assets/Texture_01.png' );
	atlas.colorSpace = THREE.SRGBColorSpace;
	atlas.magFilter = atlas.minFilter = THREE.NearestFilter;
	atlas.generateMipmaps = false;
	atlas.flipY = true;

	const material = new THREE.MeshStandardNodeMaterial( {
		map: atlas,
		roughness: 0.9,
		metalness: 0,
	} );

	// --- chargement + normalisation unité (cache de promesses → parallélisable) ---
	const loader = new FBXLoader();
	const cache = new Map();

	function loadUnitGeo( name, fit ) {

		if ( ! cache.has( name ) ) {

			cache.set( name, ( async () => {

				const fbx = await loader.loadAsync( `/assets/${name}.fbx` );
				fbx.updateMatrixWorld( true );

				const parts = [];
				fbx.traverse( ( o ) => {

					if ( o.isMesh ) {

						const g = o.geometry.clone();
						g.applyMatrix4( o.matrixWorld );
						g.clearGroups();
						for ( const key of Object.keys( g.attributes ) ) {

							if ( key !== 'position' && key !== 'normal' && key !== 'uv' ) g.deleteAttribute( key );

						}

						parts.push( g );

					}

				} );

				const geo = parts.length > 1 ? mergeGeometries( parts, false ) : parts[ 0 ];
				geo.computeBoundingBox();

				const bb = geo.boundingBox;
				const size = new THREE.Vector3();
				bb.getSize( size );

				// unité : hauteur=1 (arbres, souches) ou longueur Z=1 (bûches, branche)
				const s = 1 / ( fit === 'length' ? size.z : fit === 'footprint' ? Math.max( size.x, size.z ) : size.y );
				geo.translate( - ( bb.min.x + bb.max.x ) / 2, - bb.min.y, - ( bb.min.z + bb.max.z ) / 2 );
				geo.scale( s, s, s );

				return { geo, size: size.multiplyScalar( s ) };

			} )() );

		}

		return cache.get( name );

	}

	// --- placement instancié ---
	const group = new THREE.Group();
	const dummy = new THREE.Object3D();

	async function addInstances( name, fit, placements ) {

		const { geo } = await loadUnitGeo( name, fit );
		const mesh = new THREE.InstancedMesh( geo, material, placements.length );

		placements.forEach( ( p, i ) => {

			dummy.position.set( p.x, p.y || 0, p.z );
			dummy.rotation.set( 0, p.yaw || 0, 0 );
			dummy.scale.setScalar( p.scale );
			dummy.updateMatrix();
			mesh.setMatrixAt( i, dummy.matrix );

		} );

		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.instanceMatrix.needsUpdate = true;
		group.add( mesh );
		return mesh;

	}

	const rand = mulberry32( 20260705 );
	const clear = ( x, z, r ) => KEEP_CLEAR.every( ( k ) => Math.hypot( x - k.x, z - k.z ) > k.r + r );

	function scatter( count, rMin, rMax, itemR ) {

		const out = [];
		let guard = 0;

		while ( out.length < count && guard ++ < count * 40 ) {

			const a = rand() * Math.PI * 2;
			const r = rMin + ( rMax - rMin ) * Math.sqrt( rand() );
			const x = Math.cos( a ) * r;
			const z = Math.sin( a ) * r;
			if ( clear( x, z, itemR ) ) out.push( { x, z, yaw: rand() * Math.PI * 2 } );

		}

		return out;

	}

	// --- arbres : couronne en lisière + quelques-uns en bord de terrain ---
	const treeRing = ( variants, count, rMin, rMax, hMin, hMax ) => {

		const byModel = new Map( variants.map( ( v ) => [ v, [] ] ) );

		for ( let i = 0; i < count; i ++ ) {

			const a = ( i / count ) * Math.PI * 2 + rand() * 0.35;
			const r = rMin + rand() * ( rMax - rMin );
			const model = variants[ Math.floor( rand() * variants.length ) ];
			byModel.get( model ).push( {
				x: Math.cos( a ) * r,
				z: Math.sin( a ) * r,
				yaw: rand() * Math.PI * 2,
				scale: hMin + rand() * ( hMax - hMin ),
			} );

		}

		return byModel;

	};

	// préchargement parallèle de tous les modèles (le cache partage les promesses)
	await Promise.all( [
		[ 'Tree_01', 'height' ], [ 'Tree_02', 'height' ], [ 'Tree_06', 'height' ],
		[ 'Tree_07', 'height' ], [ 'Tree_08', 'height' ],
		[ 'Log_01', 'length' ], [ 'Log_02', 'length' ], [ 'Branch', 'length' ],
		[ 'Stump_01', 'height' ], [ 'BigRock_03', 'height' ],
		[ 'Rock_01', 'footprint' ], [ 'Rock_02', 'footprint' ], [ 'Rock_03', 'footprint' ],
		[ 'Rock_04', 'footprint' ], [ 'Rock_05', 'footprint' ],
		[ 'Mushroom_01', 'height' ], [ 'Mushroom_03', 'height' ],
		[ 'Plant_01', 'footprint' ], [ 'Plant_02', 'footprint' ],
	].map( ( [ n, f ] ) => loadUnitGeo( n, f ) ) );

	const ring = treeRing( [ 'Tree_07', 'Tree_07', 'Tree_08', 'Tree_06', 'Tree_01' ], 34, 78, 96, 15, 26 );

	// arbres intérieurs en bord de terrain (troncs = petits murs pour les fourmis)
	const innerTrees = scatter( 6, 58, 74, 3 ).map( ( p ) => ( { ...p, scale: 13 + rand() * 8 } ) );
	const heroTrees = [
		{ x: - 62, z: - 58, yaw: 0.8, scale: 30 },
		{ x: 66, z: 52, yaw: 2.4, scale: 28 },
	];

	for ( const [ model, list ] of ring ) {

		if ( list.length ) await addInstances( model, 'height', list );

	}

	await addInstances( 'Tree_07', 'height', innerTrees );
	await addInstances( 'Tree_02', 'height', heroTrees );

	// --- obstacles (visuels ; l'empreinte physique part dans la grille de murs) ---
	for ( const o of OBSTACLES ) {

		await addInstances( o.model, o.kind === 'rect' ? 'length' : 'height', [ {
			x: o.x, z: o.z, yaw: o.yaw, scale: o.scale,
		} ] );

	}

	// --- déco : cailloux, champignons, fougères ---
	const rocks = scatter( 18, 16, 74, 1.5 ).map( ( p ) => ( { ...p, scale: 0.5 + rand() * 0.7 } ) );
	const rockVariants = [ 'Rock_01', 'Rock_02', 'Rock_03', 'Rock_04', 'Rock_05' ];

	for ( let i = 0; i < rockVariants.length; i ++ ) {

		const mine = rocks.filter( ( _, j ) => j % rockVariants.length === i );
		if ( mine.length ) await addInstances( rockVariants[ i ], 'footprint', mine );

	}

	const shroomSpots = [
		{ x: - 22, z: - 8 }, { x: 12, z: - 29 }, { x: - 31, z: 25 }, { x: 42, z: 44 },
	];
	const shrooms = [];

	for ( const s of shroomSpots ) {

		const n = 3 + Math.floor( rand() * 3 );

		for ( let i = 0; i < n; i ++ ) {

			shrooms.push( {
				x: s.x + ( rand() - 0.5 ) * 6,
				z: s.z + ( rand() - 0.5 ) * 6,
				yaw: rand() * Math.PI * 2,
				scale: 0.6 + rand() * 0.8,
			} );

		}

	}

	await addInstances( 'Mushroom_01', 'height', shrooms.filter( ( _, i ) => i % 2 === 0 ) );
	await addInstances( 'Mushroom_03', 'height', shrooms.filter( ( _, i ) => i % 2 === 1 ) );

	const ferns = scatter( 14, 42, 76, 2.5 ).map( ( p ) => ( { ...p, scale: 2.0 + rand() * 1.4 } ) );
	await addInstances( 'Plant_01', 'footprint', ferns.filter( ( _, i ) => i % 2 === 0 ) );
	await addInstances( 'Plant_02', 'footprint', ferns.filter( ( _, i ) => i % 2 === 1 ) );

	scene.add( group );

	// --- empreintes physiques pour la grille de murs (coordonnées texels) ---
	// dérivées de l'encombrement réel : taille normalisée mesurée × échelle posée
	const wallStamps = [];

	for ( const o of OBSTACLES ) {

		const { size } = await loadUnitGeo( o.model, o.kind === 'rect' ? 'length' : 'height' );
		const g = worldToGrid( o.x, o.z );
		const footX = size.x * o.scale;
		const footZ = size.z * o.scale;

		if ( Math.max( footX, footZ ) / Math.min( footX, footZ ) > 1.3 ) {

			// empreinte oblongue : rectangle orienté, axe = longueur Z du modèle
			// en coordonnées grille (gx = x monde, gy = z monde)
			wallStamps.push( {
				type: 1, cx: g.x, cy: g.y,
				hw: ( footZ / 2 ) * 0.95 * T, hh: ( footX / 2 ) * 0.9 * T,
				ax: Math.sin( o.yaw ), ay: Math.cos( o.yaw ),
			} );

		} else {

			wallStamps.push( {
				type: 0, cx: g.x, cy: g.y,
				hw: ( ( footX + footZ ) / 4 ) * 0.95 * T, hh: 0, ax: 1, ay: 0,
			} );

		}

	}

	// troncs des arbres posés sur le terrain (intérieurs, héros, et lisière débordante)
	const treeStamp = ( t ) => {

		const g = worldToGrid( t.x, t.z );
		const r = Math.max( 1.0, 0.05 * t.scale );
		return { type: 0, cx: g.x, cy: g.y, hw: r * T, hh: 0, ax: 1, ay: 0 };

	};

	for ( const t of [ ...innerTrees, ...heroTrees ] ) wallStamps.push( treeStamp( t ) );

	for ( const list of ring.values() ) {

		for ( const t of list ) {

			if ( Math.max( Math.abs( t.x ), Math.abs( t.z ) ) < 78 ) wallStamps.push( treeStamp( t ) );

		}

	}

	return { group, wallStamps };

}
