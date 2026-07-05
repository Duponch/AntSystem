// Tapis d'herbe 100 % GPU — porté de E:/Code/Simulation (même three r185/TSL).
// Un brin = un quad trapézoïdal (2 triangles). AUCUNE donnée par brin côté
// CPU : position, jitter, lacet, taille, teinte et vent sont dérivés de
// instanceIndex par hash() dans le vertex shader. Le sol est uniforme, donc
// pas même besoin du buffer d'ids de tuiles du projet source.
//
// Découpage en chunks de 32×32 u : frustum culling par boundingSphere
// manuelle + rayon d'affichage + densité dégressive avec la hauteur caméra
// (instanceCount ajusté, gratuit : zéro buffer par instance).

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, uv, hash, instanceIndex, positionLocal, time,
	float, uint, vec2, vec3, mix, sin, cos, smoothstep, transformNormalToView,
} from 'three/tsl';

import { WORLD, gfx } from '../config.js';

const CHUNK = 32;                       // unités monde
const TILES = CHUNK * CHUNK;            // 1 tuile = 1 m²
const MAX_DENSITY = 160;                // brins/m² maxi (borne du slider)

export function createGrass( scene ) {

	// --- uniforms partagés ---
	const u = {
		height: uniform( gfx.grassHeight ),
		width: uniform( gfx.grassWidth ),
		wind: uniform( gfx.grassWind ),
		windDir: uniform( new THREE.Vector2( 1, 0 ) ),
		windStrength: uniform( 0.8 ),
		windGust: uniform( 0 ),
		rootColor: uniform( new THREE.Color( 0x2b3a21 ) ),   // = couleur du sol
		tipColor: uniform( new THREE.Color( 0x6f8f52 ) ),
	};

	// --- géométrie d'un brin : quad effilé + penché (4 sommets) ---
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

	// --- matériau par chunk (uniform d'origine ; même WGSL → pipeline en cache) ---
	function makeChunkMaterial( originX, originZ ) {

		const origin = uniform( new THREE.Vector2( originX, originZ ) );

		const material = new THREE.MeshStandardNodeMaterial( {
			roughness: 0.96,
			metalness: 0,
			side: THREE.DoubleSide,
		} );

		material.colorNode = Fn( () => {

			const tint = hash( instanceIndex.add( uint( 71 ) ) ).mul( 0.3 ).add( 0.85 );
			return mix( u.rootColor.mul( tint ), u.tipColor.mul( tint ), uv().y );

		} )();

		material.positionNode = Fn( () => {

			// tuile hashée (répartition uniforme même à faible densité) + jitter pleine tuile
			const tile = hash( instanceIndex.add( uint( 97 ) ) ).mul( float( TILES ) ).toUint().min( uint( TILES - 1 ) );
			const tx = tile.mod( uint( CHUNK ) ).toFloat();
			const tz = tile.div( uint( CHUNK ) ).toFloat();
			const bx = tx.add( hash( instanceIndex ) ).add( origin.x );
			const bz = tz.add( hash( instanceIndex.add( uint( 11 ) ) ) ).add( origin.y );

			const yaw = hash( instanceIndex.add( uint( 29 ) ) ).mul( 6.28318530718 );
			const c = cos( yaw );
			const s = sin( yaw );
			const bladeT = uv().y;

			let height = hash( instanceIndex.add( uint( 43 ) ) ).mul( 0.36 ).add( 0.32 ).mul( u.height );
			const width = hash( instanceIndex.add( uint( 59 ) ) ).mul( 0.55 ).add( 0.72 ).mul( u.width );

			// pas d'herbe sur le nid (les positions sont directement en monde)
			height = height.mul( smoothstep( 3.6, 5.2, vec2( bx, bz ).length() ) );

			const lx = positionLocal.x.mul( width );
			const ly = positionLocal.y.mul( height );
			const lz = positionLocal.z.mul( width );

			// balancement en espace monde le long du vent (base plantée, pointe souple)
			const phase = time.mul( 1.35 ).add( yaw ).add( tx.mul( 0.17 ) ).add( tz.mul( 0.11 ) );
			const sway = sin( phase ).mul( u.wind ).mul( u.windStrength ).mul( bladeT.mul( bladeT ) ).mul( 0.34 )
				.add( sin( phase.mul( 2.7 ).add( tx.mul( 0.3 ) ) ).mul( u.windGust ).mul( u.wind ).mul( bladeT.mul( bladeT ) ).mul( 0.22 ) );

			const rx = lx.mul( c ).add( lz.mul( s ) );
			const rz = lz.mul( c ).sub( lx.mul( s ) );

			return vec3(
				bx.add( rx ).add( u.windDir.x.mul( sway ) ),
				ly.add( 0.02 ),
				bz.add( rz ).add( u.windDir.y.mul( sway ) ),
			);

		} )();

		// normales quasi verticales : l'herbe est éclairée comme le sol et s'y fond
		material.normalNode = Fn( () => {

			const yaw = hash( instanceIndex.add( uint( 29 ) ) ).mul( 6.28318530718 );
			const n = mix( vec3( sin( yaw ), 0, cos( yaw ) ), vec3( 0, 1, 0 ), 0.9 ).normalize();
			return transformNormalToView( n );

		} )();

		return material;

	}

	// --- chunks ---
	const side = Math.ceil( WORLD / CHUNK );          // 5 → 25 chunks
	const chunks = [];
	const group = new THREE.Group();

	for ( let cz = 0; cz < side; cz ++ ) {

		for ( let cx = 0; cx < side; cx ++ ) {

			const ox = - WORLD / 2 + cx * CHUNK;
			const oz = - WORLD / 2 + cz * CHUNK;

			const geo = new THREE.InstancedBufferGeometry();
			geo.index = blade.index;
			geo.attributes = blade.attributes;
			geo.instanceCount = 0;
			geo.boundingSphere = new THREE.Sphere(
				new THREE.Vector3( ox + CHUNK / 2, 0.5, oz + CHUNK / 2 ),
				Math.hypot( CHUNK / 2, CHUNK / 2 ) + 2,
			);

			const mesh = new THREE.Mesh( geo, makeChunkMaterial( ox, oz ) );
			mesh.frustumCulled = true;
			mesh.receiveShadow = true;
			mesh.castShadow = gfx.grassShadows;

			group.add( mesh );
			chunks.push( {
				mesh,
				geo,
				center: new THREE.Vector2( ox + CHUNK / 2, oz + CHUNK / 2 ),
			} );

		}

	}

	scene.add( group );

	// --- vent animé (errance lente + rafales) ---
	let windAngle = 0.6;
	let windTime = 0;

	// --- LOD par frame ---
	const camPos = new THREE.Vector2();

	function update( camera, dt ) {

		// vent
		windTime += dt;
		windAngle += dt * 0.05 * Math.sin( windTime * 0.13 );
		u.windDir.value.set( Math.cos( windAngle ), Math.sin( windAngle ) );
		u.windStrength.value = 0.75 + 0.35 * Math.sin( windTime * 0.4 );
		u.windGust.value = Math.max( 0, Math.sin( windTime * 0.9 ) * Math.sin( windTime * 0.23 ) );

		// densité : pleine près du sol, 12 % vu de très haut
		const camH = Math.max( 0, camera.position.y );
		const t = THREE.MathUtils.clamp( 1 - ( camH - 8 ) / 70, 0, 1 );
		const ratio = 0.12 + t * t * 0.88;
		const perChunk = Math.round( gfx.grassDensity * TILES * ratio );

		camPos.set( camera.position.x, camera.position.z );

		for ( const c of chunks ) {

			const visible = gfx.grass &&
				c.center.distanceTo( camPos ) < gfx.grassDistance + CHUNK * 0.75;
			c.mesh.visible = visible;

			// instanceCount est un simple paramètre de draw : mise à jour gratuite
			if ( visible ) c.geo.instanceCount = perChunk;

		}

	}

	function setShadows( on ) {

		for ( const c of chunks ) c.mesh.castShadow = on;

	}

	return { group, u, update, setShadows, MAX_DENSITY };

}
