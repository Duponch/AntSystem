import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const DEFAULT_CATALOG = Object.freeze( {
	rock: '/assets/Rock.glb',
	bone: '/assets/Bone.glb',
	fishBone: '/assets/FishBone.glb',
} );

const loader = new GLTFLoader();
const geometryPromises = new Map();

function preparePart( part ) {

	if ( ! part?.geometry?.isBufferGeometry ) {

		throw new TypeError( 'Each underground artifact part must contain a BufferGeometry.' );

	}

	let geometry = part.geometry.clone();
	geometry.applyMatrix4( part.matrixWorld || new THREE.Matrix4() );
	geometry.clearGroups();
	geometry.morphAttributes = {};
	geometry.morphTargetsRelative = false;

	for ( const name of Object.keys( geometry.attributes ) ) {

		if ( name !== 'position' && name !== 'normal' ) geometry.deleteAttribute( name );

	}

	if ( ! geometry.getAttribute( 'position' ) ) {

		throw new TypeError( 'An underground artifact mesh has no position attribute.' );

	}

	if ( ! geometry.getAttribute( 'normal' ) ) geometry.computeVertexNormals();

	return geometry;

}

/**
 * Clone, flatten and normalize mesh parts without mutating their source data.
 *
 * @param {Array<{ geometry: THREE.BufferGeometry, matrixWorld?: THREE.Matrix4 }>} parts
 * @returns {THREE.BufferGeometry} Geometry centered on the origin, whose largest
 * dimension is exactly one.
 */
export function normalizeUndergroundArtifactGeometry( parts ) {

	if ( ! Array.isArray( parts ) || parts.length === 0 ) {

		throw new TypeError( 'An underground artifact must contain at least one mesh part.' );

	}

	let geometries = parts.map( preparePart );
	const hasIndexed = geometries.some( ( geometry ) => geometry.index !== null );
	const hasNonIndexed = geometries.some( ( geometry ) => geometry.index === null );

	if ( hasIndexed && hasNonIndexed ) {

		geometries = geometries.map( ( geometry ) => geometry.index ? geometry.toNonIndexed() : geometry );

	}

	const geometry = geometries.length === 1
		? geometries[ 0 ]
		: mergeGeometries( geometries, false );

	if ( ! geometry ) {

		throw new Error( 'Underground artifact mesh parts could not be merged.' );

	}

	geometry.computeBoundingBox();
	const size = new THREE.Vector3();
	const center = new THREE.Vector3();
	geometry.boundingBox.getSize( size );
	geometry.boundingBox.getCenter( center );
	const maxDimension = Math.max( size.x, size.y, size.z );

	if ( ! Number.isFinite( maxDimension ) || maxDimension <= 0 ) {

		throw new RangeError( 'Underground artifact geometry has invalid or empty bounds.' );

	}

	geometry.translate( - center.x, - center.y, - center.z );
	geometry.scale( 1 / maxDimension, 1 / maxDimension, 1 / maxDimension );
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();

	return geometry;

}

function catalogUrl( entry ) {

	const url = typeof entry === 'string' ? entry : entry?.url;

	if ( typeof url !== 'string' || url.length === 0 ) {

		throw new TypeError( 'Underground artifact catalog entries require a non-empty url.' );

	}

	return url;

}

function loadGeometryOnce( url ) {

	if ( ! geometryPromises.has( url ) ) {

		geometryPromises.set( url, ( async () => {

			const gltf = await loader.loadAsync( url );
			gltf.scene.updateMatrixWorld( true );

			const parts = [];
			gltf.scene.traverse( ( object ) => {

				if ( object.isMesh && object.geometry ) {

					parts.push( {
						geometry: object.geometry,
						matrixWorld: object.matrixWorld,
					} );

				}

			} );

			return normalizeUndergroundArtifactGeometry( parts );

		} )() );

	}

	return geometryPromises.get( url );

}

/**
 * Load every catalog entry in parallel. A URL is fetched and normalized only
 * once for the lifetime of the module, including across concurrent calls.
 *
 * Catalog values may be either a URL string or an object shaped as `{ url }`.
 * The resolved object preserves the catalog keys and maps them to geometries.
 */
export async function loadUndergroundArtifactGeometries( catalog = DEFAULT_CATALOG ) {

	const entries = Object.entries( catalog );
	const loaded = await Promise.all( entries.map( async ( [ key, entry ] ) => [
		key,
		await loadGeometryOnce( catalogUrl( entry ) ),
	] ) );

	return Object.fromEntries( loaded );

}
