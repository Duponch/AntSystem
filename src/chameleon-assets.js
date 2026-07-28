import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

export const CHAMELEON_ASSET_URL = '/Chameleon.glb';
export const CHAMELEON_WALK_CLIP = 'Walk_Chameleon_Imported';
export const CHAMELEON_ATTACK_CLIP = 'Attack_Chameleon_Imported';
export const CHAMELEON_MOUTH_SOCKET = 'mouth_socket';
export const CHAMELEON_CAPTURE_SOCKET = 'capture_socket';

const loader = new GLTFLoader();
let assetPromise = null;

function fail( message ) {

	throw new Error( `Chameleon.glb: ${ message }` );

}

export function validateChameleonAsset( gltf ) {

	if ( ! gltf?.scene ) fail( 'scène absente' );
	if ( ! Array.isArray( gltf.animations ) ) fail( 'animations absentes' );
	const walkClip = gltf.animations.find( ( clip ) => clip.name === CHAMELEON_WALK_CLIP );
	const attackClip = gltf.animations.find( ( clip ) => clip.name === CHAMELEON_ATTACK_CLIP );
	if ( ! walkClip ) fail( `clip exact ${ CHAMELEON_WALK_CLIP } absent` );
	if ( ! attackClip ) fail( `clip exact ${ CHAMELEON_ATTACK_CLIP } absent` );
	if ( ! Number.isFinite( walkClip.duration ) || walkClip.duration <= 0 ) fail( 'durée de marche invalide' );
	if ( ! Number.isFinite( attackClip.duration ) || attackClip.duration <= 0 ) fail( 'durée d’attaque invalide' );

	let skinnedMeshCount = 0;
	let jawBone = null;
	let tongueBone = null;
	let tongueMesh = null;
	gltf.scene.traverse( ( object ) => {

		if ( object.isSkinnedMesh && object.skeleton?.bones?.length > 0 ) skinnedMeshCount ++;
		if ( object.isBone && /^jaw(?:[._-]|$)/iu.test( object.name ) ) jawBone = object;
		if ( object.isBone && /^tongue(?:[._-]|$)/iu.test( object.name ) ) tongueBone = object;
		if ( object.isMesh && /tongue/iu.test( object.name ) ) tongueMesh = object;

	} );
	if ( skinnedMeshCount === 0 ) fail( 'armature skinnée absente' );
	if ( ! jawBone ) fail( 'os de mâchoire absent' );
	if ( ! tongueBone ) fail( 'chaîne d’os de langue absente' );
	if ( ! tongueMesh ) fail( 'maillage de langue exporté absent' );

	const mouthSocket = gltf.scene.getObjectByName( CHAMELEON_MOUTH_SOCKET );
	const captureSocket = gltf.scene.getObjectByName( CHAMELEON_CAPTURE_SOCKET );
	if ( ! mouthSocket ) fail( `socket exact ${ CHAMELEON_MOUTH_SOCKET } absent` );
	if ( ! captureSocket ) fail( `socket exact ${ CHAMELEON_CAPTURE_SOCKET } absent` );

	return Object.freeze( {
		walkClip,
		attackClip,
		mouthSocket,
		captureSocket,
		jawBone,
		tongueBone,
		tongueMesh,
		skinnedMeshCount,
	} );

}

function measureAsset( scene, contract ) {

	scene.updateMatrixWorld( true );
	const bounds = new THREE.Box3().setFromObject( scene );
	const size = new THREE.Vector3();
	bounds.getSize( size );
	if ( ! Number.isFinite( size.x ) || size.x <= 0 ) fail( 'longueur locale invalide' );

	const mouth = new THREE.Vector3();
	const capture = new THREE.Vector3();
	contract.mouthSocket.getWorldPosition( mouth );
	contract.captureSocket.getWorldPosition( capture );
	return Object.freeze( {
		minX: bounds.min.x,
		minY: bounds.min.y,
		minZ: bounds.min.z,
		maxX: bounds.max.x,
		maxY: bounds.max.y,
		maxZ: bounds.max.z,
		centerX: ( bounds.min.x + bounds.max.x ) * 0.5,
		centerZ: ( bounds.min.z + bounds.max.z ) * 0.5,
		length: size.x,
		height: size.y,
		width: size.z,
		mouthX: mouth.x,
		mouthY: mouth.y,
		mouthZ: mouth.z,
		captureX: capture.x,
		captureY: capture.y,
		captureZ: capture.z,
	} );

}

export function loadChameleonAsset() {

	if ( assetPromise ) return assetPromise;
	assetPromise = loader.loadAsync( CHAMELEON_ASSET_URL ).then( ( gltf ) => {

		const contract = validateChameleonAsset( gltf );
		const metrics = measureAsset( gltf.scene, contract );
		return Object.freeze( {
			scene: gltf.scene,
			animations: gltf.animations,
			walkClip: contract.walkClip,
			attackClip: contract.attackClip,
			metrics,
		} );

	} ).catch( ( error ) => {

		assetPromise = null;
		throw error;

	} );
	return assetPromise;

}

function pbrMaterial( source, vertexColors ) {

	const material = new THREE.MeshStandardNodeMaterial( {
		color: source?.color ? source.color.clone() : new THREE.Color( 0xffffff ),
		map: source?.map || null,
		roughness: Number.isFinite( source?.roughness ) ? source.roughness : 0.78,
		metalness: Number.isFinite( source?.metalness ) ? source.metalness : 0,
		vertexColors,
		side: source?.side ?? THREE.DoubleSide,
		transparent: !! source?.transparent,
		opacity: Number.isFinite( source?.opacity ) ? source.opacity : 1,
		alphaTest: Number.isFinite( source?.alphaTest ) ? source.alphaTest : 0,
	} );
	if ( source?.emissive ) material.emissive.copy( source.emissive );
	if ( source?.emissiveIntensity !== undefined ) material.emissiveIntensity = source.emissiveIntensity;
	material.name = `${ source?.name || 'ChameleonMaterial' }_PBR`;
	return material;

}

/**
 * Creates the only runtime clone. Allocation and material conversion happen
 * once at startup, never in update().
 */
export function instantiateChameleonAsset( asset, {
	castShadow = true,
	receiveShadow = true,
} = {} ) {

	if ( ! asset?.scene ) throw new TypeError( 'a loaded chameleon asset is required' );
	const model = cloneSkeleton( asset.scene );
	const materialCache = new Map();
	const meshes = [];
	const hiddenTongueMeshes = [];

	model.traverse( ( object ) => {

		if ( ! object.isMesh ) return;
		meshes.push( object );
		object.frustumCulled = false;
		object.castShadow = !! castShadow;
		object.receiveShadow = !! receiveShadow;
		const vertexColors = !! object.geometry?.getAttribute( 'color' );
		const sourceMaterials = Array.isArray( object.material ) ? object.material : [ object.material ];
		const converted = sourceMaterials.map( ( source ) => {

			const key = `${ source?.uuid || 'none' }:${ vertexColors ? 1 : 0 }`;
			if ( ! materialCache.has( key ) ) materialCache.set( key, pbrMaterial( source, vertexColors ) );
			return materialCache.get( key );

		} );
		object.material = Array.isArray( object.material ) ? converted : converted[ 0 ];
		if ( /tongue/iu.test( object.name ) ) {

			object.visible = false;
			object.castShadow = false;
			object.receiveShadow = false;
			hiddenTongueMeshes.push( object );

		}

	} );

	const mouthSocket = model.getObjectByName( CHAMELEON_MOUTH_SOCKET );
	const captureSocket = model.getObjectByName( CHAMELEON_CAPTURE_SOCKET );
	if ( ! mouthSocket || ! captureSocket ) fail( 'sockets perdus pendant le clonage squelette' );
	return {
		model,
		meshes,
		hiddenTongueMeshes,
		mouthSocket,
		captureSocket,
		materials: [ ...materialCache.values() ],
	};

}
