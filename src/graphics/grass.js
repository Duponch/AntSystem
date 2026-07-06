// Tapis d'herbe 100 % GPU : un DISQUE CONTINU de brins centré sur la caméra.
//
// Chaque brin possède une position de réseau stable dérivée de instanceIndex ;
// le shader la réplique sur un pavage toroïdal de période 2R et choisit la
// réplique la plus proche de la caméra. Résultat : les brins sont fixes dans
// le monde tant qu'ils sont dans le disque, et se recyclent silencieusement
// d'un bord à l'autre (le bord est masqué en fondu) quand la caméra avance —
// un vrai cercle de brins qui suit la caméra, sans chunks.
//
// Camouflage : un brin affiche EXACTEMENT l'albédo + l'émissif du sol à sa
// racine (fonctions partagées de environment.js) avec une normale verticale —
// même éclairage que le sol, indiscernable sauf en silhouette.

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, uv, hash, instanceIndex, positionLocal, time, varyingProperty,
	float, uint, vec2, vec3, sin, cos, floor, length, smoothstep, transformNormalToView,
} from 'three/tsl';

import { WORLD, gfx } from '../config.js';
import { makeFieldSampler, groundAlbedo, groundEmissive } from '../environment.js';

const MAX_BLADES = 2_000_000;

export function createGrass( scene, sim ) {

	const u = {
		height: uniform( gfx.grassHeight ),
		width: uniform( gfx.grassWidth ),
		radius: uniform( gfx.grassRadius ),
		wind: uniform( gfx.grassWind ),
		windDir: uniform( new THREE.Vector2( 1, 0 ) ),
		windStrength: uniform( 0.8 ),
		windGust: uniform( 0 ),
		cam: uniform( new THREE.Vector2() ),
	};

	// --- géométrie d'un brin : quad effilé + penché (4 sommets, 2 triangles) ---
	const blade = ( () => {

		const halfW0 = 0.038, halfW1 = 0.003, lean = 0.035;
		const pos = [ - halfW0, 0, 0, halfW0, 0, 0, - halfW1, 1, lean, halfW1, 1, lean ];
		const uvs = [ 0, 0, 1, 0, 0, 1, 1, 1 ];
		const idx = [ 0, 2, 1, 1, 2, 3 ];
		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( pos, 3 ) );
		g.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
		g.setIndex( idx );
		return g;

	} )();

	const material = new THREE.MeshStandardNodeMaterial( {
		roughness: 0.95,          // = sol
		metalness: 0,
		side: THREE.DoubleSide,
	} );

	material.positionNode = Fn( () => {

		// réseau toroïdal de période 2R : réplique la plus proche de la caméra
		const period = u.radius.mul( 2 );
		const Lx = hash( instanceIndex ).mul( period );
		const Lz = hash( instanceIndex.add( uint( 11 ) ) ).mul( period );
		const bx = Lx.add( floor( u.cam.x.sub( Lx ).div( period ).add( 0.5 ) ).mul( period ) ).toVar();
		const bz = Lz.add( floor( u.cam.y.sub( Lz ).div( period ).add( 0.5 ) ).mul( period ) ).toVar();

		const root = vec2( bx, bz );
		varyingProperty( 'vec2', 'vGrassRoot' ).assign( root );

		const yaw = hash( instanceIndex.add( uint( 29 ) ) ).mul( 6.28318530718 );
		const c = cos( yaw );
		const s = sin( yaw );
		const bladeT = uv().y;

		// masque : bord du disque en fondu, LIMITES STRICTES du terrain, nid —
		// appliqué au brin ENTIER (largeur comprise), rien ne dépasse de la carte
		const dCam = length( root.sub( u.cam ) );
		const mask = float( 1 ).sub( smoothstep( u.radius.mul( 0.86 ), u.radius, dCam ) )
			.mul( float( 1 ).sub( smoothstep( WORLD / 2 - 0.6, WORLD / 2 - 0.15, bx.abs() ) ) )
			.mul( float( 1 ).sub( smoothstep( WORLD / 2 - 0.6, WORLD / 2 - 0.15, bz.abs() ) ) )
			.mul( smoothstep( 3.6, 5.2, length( root ) ) );

		const height = hash( instanceIndex.add( uint( 43 ) ) ).mul( 0.36 ).add( 0.32 ).mul( u.height ).mul( mask );
		const width = hash( instanceIndex.add( uint( 59 ) ) ).mul( 0.55 ).add( 0.72 ).mul( u.width ).mul( mask );

		const lx = positionLocal.x.mul( width );
		const ly = positionLocal.y.mul( height );
		const lz = positionLocal.z.mul( width );

		// balancement en espace monde le long du vent (base plantée, pointe souple)
		// (le saut de phase au recyclage est invisible : le bord est masqué)
		const phase = time.mul( 1.35 ).add( yaw ).add( bx.mul( 0.17 ) ).add( bz.mul( 0.11 ) );
		const sway = sin( phase ).mul( u.wind ).mul( u.windStrength ).mul( bladeT.mul( bladeT ) ).mul( 0.34 )
			.add( sin( phase.mul( 2.7 ).add( bx.mul( 0.3 ) ) ).mul( u.windGust ).mul( u.wind ).mul( bladeT.mul( bladeT ) ).mul( 0.22 ) );

		const rx = lx.mul( c ).add( lz.mul( s ) );
		const rz = lz.mul( c ).sub( lx.mul( s ) );

		return vec3(
			bx.add( rx ).add( u.windDir.x.mul( sway ) ),
			ly.add( 0.02 ),
			bz.add( rz ).add( u.windDir.y.mul( sway ) ),
		);

	} )();

	// camouflage : couleur et émissif du SOL à la racine du brin
	const rootVar = varyingProperty( 'vec2', 'vGrassRoot' );
	const rootUv = rootVar.div( WORLD ).add( 0.5 );
	const fieldNode = makeFieldSampler( sim, rootUv );

	material.colorNode = Fn( () => groundAlbedo( rootVar, fieldNode ) )();
	material.emissiveNode = Fn( () => groundEmissive( fieldNode ) )();

	// normale strictement verticale : éclairé exactement comme le sol
	material.normalNode = transformNormalToView( vec3( 0, 1, 0 ) );

	// --- mesh unique ---
	const geo = new THREE.InstancedBufferGeometry();
	geo.index = blade.index;
	geo.attributes = blade.attributes;
	geo.instanceCount = 0;

	const mesh = new THREE.Mesh( geo, material );
	mesh.frustumCulled = false;               // suit la caméra en permanence
	mesh.receiveShadow = true;
	mesh.castShadow = gfx.grassShadows;
	scene.add( mesh );

	// --- vent animé (errance lente + rafales) ---
	let windAngle = 0.6;
	let windTime = 0;
	const fwd = new THREE.Vector3();

	function update( camera, dt ) {

		windTime += dt;
		windAngle += dt * 0.05 * Math.sin( windTime * 0.13 );
		u.windDir.value.set( Math.cos( windAngle ), Math.sin( windAngle ) );
		u.windStrength.value = 0.75 + 0.35 * Math.sin( windTime * 0.4 );
		u.windGust.value = Math.max( 0, Math.sin( windTime * 0.9 ) * Math.sin( windTime * 0.23 ) );

		// disque décalé DEVANT la caméra : les brins couvrent ce qu'on regarde
		// au lieu d'être calculés pour moitié dans le dos
		camera.getWorldDirection( fwd );
		const ahead = gfx.grassRadius * 0.45;
		u.cam.value.set(
			camera.position.x + fwd.x * ahead,
			camera.position.z + fwd.z * ahead,
		);
		u.radius.value = gfx.grassRadius;

		// densité : pleine près du sol, 12 % vu de très haut
		const camH = Math.max( 0, camera.position.y );
		const t = THREE.MathUtils.clamp( 1 - ( camH - 8 ) / 70, 0, 1 );
		const ratio = 0.12 + t * t * 0.88;

		const area = 4 * gfx.grassRadius * gfx.grassRadius;
		geo.instanceCount = gfx.grass
			? Math.min( MAX_BLADES, Math.round( gfx.grassDensity * area * ratio ) )
			: 0;
		mesh.visible = gfx.grass;

	}

	function setShadows( on ) {

		mesh.castShadow = on;

	}

	return { mesh, u, update, setShadows };

}
