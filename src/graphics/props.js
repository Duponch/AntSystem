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

import { WORLD, GRID, worldToGrid, gfx } from '../config.js';

const T = GRID / WORLD;   // texels par unité monde

// catalogue des modèles plaçables par l'éditeur de décor
export const CATALOG = {
	Tree_01: { fit: 'height', category: 'trees', defaultScale: 18 },
	Tree_02: { fit: 'height', category: 'trees', defaultScale: 26 },
	Tree_06: { fit: 'height', category: 'trees', defaultScale: 17 },
	Tree_07: { fit: 'height', category: 'trees', defaultScale: 20 },
	Tree_08: { fit: 'height', category: 'trees', defaultScale: 16 },
	Log_01: { fit: 'length', category: 'obstacles', defaultScale: 12 },
	Log_02: { fit: 'length', category: 'obstacles', defaultScale: 9 },
	Branch: { fit: 'length', category: 'obstacles', defaultScale: 6 },
	Stump_01: { fit: 'height', category: 'obstacles', defaultScale: 1.6 },
	BigRock_03: { fit: 'height', category: 'obstacles', defaultScale: 3.4 },
	Rock_01: { fit: 'footprint', category: 'rocks', defaultScale: 0.8 },
	Rock_02: { fit: 'footprint', category: 'rocks', defaultScale: 0.8 },
	Rock_03: { fit: 'footprint', category: 'rocks', defaultScale: 0.8 },
	Rock_04: { fit: 'footprint', category: 'rocks', defaultScale: 0.8 },
	Rock_05: { fit: 'footprint', category: 'rocks', defaultScale: 0.8 },
	Mushroom_01: { fit: 'height', category: 'mushrooms', defaultScale: 1.0 },
	Mushroom_03: { fit: 'height', category: 'mushrooms', defaultScale: 0.9 },
	Plant_01: { fit: 'footprint', category: 'plants', defaultScale: 2.6 },
	Plant_02: { fit: 'footprint', category: 'plants', defaultScale: 2.6 },
};

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

export async function createProps( scene, savedDoc = null ) {

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

	// --- placement instancié, avec registre par catégorie (échelles UI) ---
	const group = new THREE.Group();
	const dummy = new THREE.Object3D();
	const registry = [];   // { mesh, placements, category, model, fit }
	const sizes = new Map();
	let edited = false;

	const CATEGORY_KEY = {
		trees: 'scaleTrees', obstacles: 'scaleObstacles',
		mushrooms: 'scaleMushrooms', plants: 'scalePlants', rocks: 'scaleRocks',
	};

	function writeMatrices( entry ) {

		const factor = gfx[ CATEGORY_KEY[ entry.category ] ] || 1;

		entry.placements.forEach( ( p, i ) => {

			dummy.position.set( p.x, p.y || 0, p.z );
			dummy.rotation.set( 0, p.yaw || 0, 0 );
			dummy.scale.setScalar( p.scale * factor );
			dummy.updateMatrix();
			entry.mesh.setMatrixAt( i, dummy.matrix );

		} );

		entry.mesh.count = entry.placements.length;
		entry.mesh.instanceMatrix.needsUpdate = true;
		entry.mesh.computeBoundingSphere();

	}

	function makeMesh( geo, capacity ) {

		const mesh = new THREE.InstancedMesh( geo, material, capacity );
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		return mesh;

	}

	async function addInstances( name, fit, placements, category ) {

		const { geo, size } = await loadUnitGeo( name, fit );
		sizes.set( name, size );

		// marge de capacité : l'éditeur peut ajouter sans réallouer
		const mesh = makeMesh( geo, placements.length + 24 );
		const entry = { mesh, placements, category, model: name, fit };
		writeMatrices( entry );

		group.add( mesh );
		registry.push( entry );
		return entry;

	}

	function setCategoryScale( category ) {

		for ( const entry of registry ) {

			if ( entry.category === category ) writeMatrices( entry );

		}

	}

	// ------------------------------------------------------------------
	// API de l'éditeur de décor
	// ------------------------------------------------------------------
	async function addPlacement( model, placement ) {

		const info = CATALOG[ model ];
		let entry = registry.find( ( e ) => e.model === model );

		if ( ! entry ) {

			entry = await addInstances( model, info.fit, [ placement ], info.category );

		} else if ( entry.placements.length >= entry.mesh.instanceMatrix.count ) {

			// capacité pleine : mesh réalloué en double
			group.remove( entry.mesh );
			entry.mesh.dispose();
			entry.mesh = makeMesh( entry.mesh.geometry, entry.placements.length * 2 + 24 );
			group.add( entry.mesh );
			entry.placements.push( placement );
			writeMatrices( entry );

		} else {

			entry.placements.push( placement );
			writeMatrices( entry );

		}

		edited = true;
		return { entry, index: entry.placements.length - 1 };

	}

	function updatePlacement( entry, index, patch ) {

		Object.assign( entry.placements[ index ], patch );
		writeMatrices( entry );
		edited = true;

	}

	function removePlacement( entry, index ) {

		entry.placements.splice( index, 1 );
		writeMatrices( entry );
		edited = true;

	}

	function exportDoc() {

		return registry
			.filter( ( e ) => e.placements.length > 0 )
			.map( ( e ) => ( {
				model: e.model,
				fit: e.fit,
				category: e.category,
				placements: e.placements.map( ( p ) => ( {
					x: + p.x.toFixed( 2 ), z: + p.z.toFixed( 2 ),
					yaw: + ( p.yaw || 0 ).toFixed( 3 ), scale: + p.scale.toFixed( 2 ),
				} ) ),
			} ) );

	}

	// --- décor : document sauvegardé (éditeur) OU génération procédurale ---
	if ( savedDoc ) {

		for ( const d of savedDoc ) {

			await addInstances( d.model, d.fit, d.placements, d.category );

		}

	} else {

		await buildProcedural();

	}

	async function buildProcedural() {

	// positions de référence définies pour une carte de 160 : on les met à
	// l'échelle de la carte réelle (les TAILLES d'objets, elles, ne bougent pas)
	const S = WORLD / 160;
	const obstacles = OBSTACLES.map( ( o ) => ( { ...o, x: o.x * S, z: o.z * S } ) );
	const keepClear = KEEP_CLEAR.map( ( k ) => ( { ...k, x: k.x * S, z: k.z * S } ) );

	const rand = mulberry32( 20260705 );
	const clear = ( x, z, r ) => keepClear.every( ( k ) => Math.hypot( x - k.x, z - k.z ) > k.r + r );

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

	// couronne d'arbres À L'INTÉRIEUR des limites de la carte
	const half = WORLD / 2;
	const ring = treeRing(
		[ 'Tree_07', 'Tree_07', 'Tree_08', 'Tree_06', 'Tree_01' ],
		Math.round( 34 * S ), half * 0.80, half * 0.94, 15, 26,
	);

	// arbres intérieurs (troncs = petits murs pour les fourmis)
	const innerTrees = scatter( Math.round( 6 * S ), half * 0.52, half * 0.70, 3 )
		.map( ( p ) => ( { ...p, scale: 13 + rand() * 8 } ) );
	const heroTrees = [
		{ x: - half * 0.72, z: - half * 0.66, yaw: 0.8, scale: 30 },
		{ x: half * 0.76, z: half * 0.60, yaw: 2.4, scale: 28 },
	];

	for ( const [ model, list ] of ring ) {

		if ( list.length ) await addInstances( model, 'height', list, 'trees' );

	}

	await addInstances( 'Tree_07', 'height', innerTrees, 'trees' );
	await addInstances( 'Tree_02', 'height', heroTrees, 'trees' );

	// --- obstacles (visuels ; l'empreinte physique part dans la grille de murs) ---
	const obstacleSizes = new Map();

	for ( const o of obstacles ) {

		const fit = o.kind === 'rect' ? 'length' : 'height';
		const { size } = await loadUnitGeo( o.model, fit );
		obstacleSizes.set( o.model, size );
		await addInstances( o.model, fit, [ { x: o.x, z: o.z, yaw: o.yaw, scale: o.scale } ], 'obstacles' );

	}

	// --- déco : cailloux, champignons, fougères ---
	const rocks = scatter( Math.round( 18 * S ), 16 * S, 74 * S, 1.5 )
		.map( ( p ) => ( { ...p, scale: 0.5 + rand() * 0.7 } ) );
	const rockVariants = [ 'Rock_01', 'Rock_02', 'Rock_03', 'Rock_04', 'Rock_05' ];

	for ( let i = 0; i < rockVariants.length; i ++ ) {

		const mine = rocks.filter( ( _, j ) => j % rockVariants.length === i );
		if ( mine.length ) await addInstances( rockVariants[ i ], 'footprint', mine, 'rocks' );

	}

	const shroomSpots = [
		{ x: - 22 * S, z: - 8 * S }, { x: 12 * S, z: - 29 * S },
		{ x: - 31 * S, z: 25 * S }, { x: 42 * S, z: 44 * S },
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

	await addInstances( 'Mushroom_01', 'height', shrooms.filter( ( _, i ) => i % 2 === 0 ), 'mushrooms' );
	await addInstances( 'Mushroom_03', 'height', shrooms.filter( ( _, i ) => i % 2 === 1 ), 'mushrooms' );

	const ferns = scatter( Math.round( 14 * S ), 42 * S, Math.min( 76 * S, half * 0.92 ), 2.5 )
		.map( ( p ) => ( { ...p, scale: 2.0 + rand() * 1.4 } ) );
	await addInstances( 'Plant_01', 'footprint', ferns.filter( ( _, i ) => i % 2 === 0 ), 'plants' );
	await addInstances( 'Plant_02', 'footprint', ferns.filter( ( _, i ) => i % 2 === 1 ), 'plants' );

	}   // fin buildProcedural

	scene.add( group );

	// --- empreintes physiques pour la grille de murs (coordonnées texels) ---
	// dérivées du REGISTRE (procédural comme édité) : encombrement mesuré ×
	// échelle posée × échelle de catégorie
	function computeWallStamps() {

		const stamps = [];
		const oScale = gfx.scaleObstacles || 1;
		const tScale = gfx.scaleTrees || 1;
		const inMap = ( p ) => Math.max( Math.abs( p.x ), Math.abs( p.z ) ) < WORLD / 2 - 2;

		for ( const e of registry ) {

			if ( e.category === 'obstacles' ) {

				const size = sizes.get( e.model );

				for ( const p of e.placements ) {

					if ( ! inMap( p ) ) continue;
					const g = worldToGrid( p.x, p.z );
					const footX = size.x * p.scale * oScale;
					const footZ = size.z * p.scale * oScale;

					if ( Math.max( footX, footZ ) / Math.min( footX, footZ ) > 1.3 ) {

						// empreinte oblongue : rectangle orienté, axe = longueur Z
						// du modèle en grille (gx = x monde, gy = z monde)
						stamps.push( {
							type: 1, cx: g.x, cy: g.y,
							hw: ( footZ / 2 ) * 0.95 * T, hh: ( footX / 2 ) * 0.9 * T,
							ax: Math.sin( p.yaw || 0 ), ay: Math.cos( p.yaw || 0 ),
						} );

					} else {

						stamps.push( {
							type: 0, cx: g.x, cy: g.y,
							hw: ( ( footX + footZ ) / 4 ) * 0.95 * T, hh: 0, ax: 1, ay: 0,
						} );

					}

				}

			} else if ( e.category === 'trees' ) {

				for ( const p of e.placements ) {

					if ( ! inMap( p ) ) continue;
					const g = worldToGrid( p.x, p.z );
					const r = Math.max( 1.0, 0.05 * p.scale * tScale );
					stamps.push( { type: 0, cx: g.x, cy: g.y, hw: r * T, hh: 0, ax: 1, ay: 0 } );

				}

			}

		}

		return stamps;

	}

	return {
		group,
		registry,
		wallStamps: computeWallStamps(),
		computeWallStamps,
		setCategoryScale,
		addPlacement,
		updatePlacement,
		removePlacement,
		exportDoc,
		isEdited: () => edited,
	};

}
