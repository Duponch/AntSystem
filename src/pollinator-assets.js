import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { loadVATMulti } from './vat.js';

const loader = new GLTFLoader();
let assetsPromise = null;
let butterflyPromise = null;

function materialAt( mesh, materialIndex = 0 ) {

	return Array.isArray( mesh.material )
		? mesh.material[ materialIndex ] || mesh.material[ 0 ]
		: mesh.material;

}

function flattenFlowerPart( mesh ) {

	let geometry = mesh.geometry.clone();
	geometry.applyMatrix4( mesh.matrixWorld );
	if ( geometry.index ) geometry = geometry.toNonIndexed();
	if ( ! geometry.getAttribute( 'normal' ) ) geometry.computeVertexNormals();

	const vertexCount = geometry.getAttribute( 'position' ).count;
	const colors = new Float32Array( vertexCount * 3 );
	const paint = ( start, count, material ) => {

		const color = material?.color || new THREE.Color( 0xffffff );
		const end = Math.min( vertexCount, start + count );
		for ( let i = Math.max( 0, start ); i < end; i ++ ) {

			colors[ i * 3 ] = color.r;
			colors[ i * 3 + 1 ] = color.g;
			colors[ i * 3 + 2 ] = color.b;

		}

	};

	if ( geometry.groups.length > 0 ) {

		for ( const group of geometry.groups ) {

			paint( group.start, group.count, materialAt( mesh, group.materialIndex ) );

		}

	} else {

		paint( 0, vertexCount, materialAt( mesh ) );

	}

	geometry.clearGroups();
	geometry.setAttribute( 'color', new THREE.BufferAttribute( colors, 3 ) );
	for ( const name of Object.keys( geometry.attributes ) ) {

		if ( name !== 'position' && name !== 'normal' && name !== 'color' ) geometry.deleteAttribute( name );

	}

	return geometry;

}

export function normalizeFlowerGeometry( scene ) {

	scene.updateMatrixWorld( true );
	const parts = [];
	scene.traverse( ( object ) => {

		if ( object.isMesh && object.geometry ) parts.push( flattenFlowerPart( object ) );

	} );

	if ( parts.length === 0 ) throw new Error( 'Flower.glb ne contient aucun maillage.' );
	const geometry = parts.length === 1 ? parts[ 0 ] : mergeGeometries( parts, false );
	if ( ! geometry ) throw new Error( 'Les primitives de Flower.glb ne peuvent pas être fusionnées.' );

	geometry.computeBoundingBox();
	const box = geometry.boundingBox;
	const size = new THREE.Vector3();
	box.getSize( size );
	if ( ! Number.isFinite( size.y ) || size.y <= 0 ) throw new Error( 'Flower.glb a une hauteur invalide.' );

	geometry.translate(
		- ( box.min.x + box.max.x ) * 0.5,
		- box.min.y,
		- ( box.min.z + box.max.z ) * 0.5,
	);
	geometry.scale( 1 / size.y, 1 / size.y, 1 / size.y );
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	return geometry;

}

export function loadPollinatorAssets() {

	if ( assetsPromise ) return assetsPromise;

	assetsPromise = Promise.all( [
		loader.loadAsync( '/assets/Flower.glb' ),
		loader.loadAsync( '/Bee.glb' ),
		loadVATMulti( '/BeeRigged.glb', {
			clipNames: [ 'Flight_Bee', 'Forage_Bee' ],
			fps: 16,
			targetLength: 0.72,
			preserveUv: true,
		} ),
	] ).then( ( [ flower, hive, beeVat ] ) => ( {
		flowerGeometry: normalizeFlowerGeometry( flower.scene ),
		hiveScene: hive.scene,
		beeVat,
	} ) );

	return assetsPromise;

}
export function loadButterflyAsset() {

	if ( butterflyPromise ) return butterflyPromise;

	butterflyPromise = loadVATMulti( '/Butterfly.glb', {
		clipNames: [ 'Flight_Butterfly' ],
		fps: 16,
		targetLength: 1.1,
		preserveUv: true,
	} );
	return butterflyPromise;

}
