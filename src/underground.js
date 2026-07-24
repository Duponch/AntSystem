// Vue en fosse de la fourmilière : quand « Vue souterraine » est activée,
// le sol et le socle DISCARDENT leurs fragments dans un disque autour du nid
// (voir environment.js), révélant un diorama creusé dans la terre :
//   - plancher continu généré depuis la carte de profondeur du layout
//     (même source de vérité que le y des fourmis souterraines) ;
//   - paroi circulaire de la découpe (l'épaisseur de terre du bord) ;
//   - lueur chaude discrète pour rester lisible en pleine nuit.
//
// L'ouverture est animée (rayon qui s'étend), l'herbe s'efface dans le
// disque, la fourmilière (GLB) se retire le temps de la vue.

import * as THREE from 'three/webgpu';
import {
	Fn, If, positionWorld, positionLocal, uniform, vec3, float, ivec2, color,
	mix, min, clamp, select, smoothstep, normalize, textureLoad, Discard, mx_noise_float,
} from 'three/tsl';

import { GRID, WORLD, NEST, gfx } from './config.js';
import { uPitR } from './environment.js';
import { DEPTH_SIZE, LAYERS } from './colony.js';

const TEXEL = WORLD / GRID;

export function createUnderground( { scene, layout, env, grass, camera } ) {

	const group = new THREE.Group();
	group.visible = true;   // occlus naturellement par le sol tant que la vue est fermée
	scene.add( group );

	// ------------------------------------------------------------------
	// PLANCHERS : une nappe par etage de cavites.
	//
	// La carte porte quatre planchers superposes par colonne. On dessine donc
	// QUATRE nappes, chacune ne s'affichant que la ou sa cavite existe : c'est
	// ce qui donne des chambres reellement empilees en coupe, au lieu de
	// cuvettes creusees dans une seule surface.
	//
	// Le relief est applique dans le VERTEX SHADER et non sur le maillage CPU :
	// le nid grandit en cours de partie, et reconstruire quatre grilles a chaque
	// palier couterait plusieurs millisecondes. Ici la geometrie est statique et
	// ne change jamais.
	// ------------------------------------------------------------------
	const RES = 288;                                   // sommets par côté
	const SIZE = DEPTH_SIZE * TEXEL;                   // étendue monde de la région
	const SHELF = - 0.3;                               // « épaule » de terre non creusée

	const centerX = ( NEST.x / GRID - 0.5 ) * WORLD;
	const centerZ = ( NEST.y / GRID - 0.5 ) * WORLD;

	const uDepthMax = uniform( layout.depthMax || 60 );

	// position monde -> texel de la carte de profondeur
	const mapTexel = ( p ) => clamp(
		ivec2(
			p.x.div( TEXEL ).add( GRID / 2 ).sub( layout.origin.x ),
			p.z.div( TEXEL ).add( GRID / 2 ).sub( layout.origin.y ) ),
		ivec2( 0 ), ivec2( DEPTH_SIZE - 1 ) );

	const layerOf = ( t, l ) => ( l === 0 ? t.x : l === 1 ? t.y : l === 2 ? t.z : t.w );

	// TERRE : horizons pedologiques empiles. Le profil ne depend que de la
	// profondeur, avec une frontiere ondulee par un seul bruit — le reste est
	// une suite de melanges, donc quasi gratuit par fragment.
	const soilAt = ( y ) => {

		const n = mx_noise_float( vec3( positionWorld.x.mul( 0.25 ), y.mul( 0.9 ), positionWorld.z.mul( 0.25 ) ) )
			.mul( 0.5 ).add( 0.5 );
		const f = clamp( y.negate().div( uDepthMax ).add( n.sub( 0.5 ).mul( 0.06 ) ), 0, 1 ).toVar();
		const c = mix( color( 0x4a3a22 ), color( 0x6b4a26 ), smoothstep( 0.00, 0.10, f ) ).toVar();
		c.assign( mix( c, color( 0x8a5c2c ), smoothstep( 0.10, 0.34, f ) ) );   // horizon A
		c.assign( mix( c, color( 0x9c7040 ), smoothstep( 0.34, 0.58, f ) ) );   // horizon B compact
		c.assign( mix( c, color( 0x7a6a52 ), smoothstep( 0.58, 0.82, f ) ) );   // horizon C
		c.assign( mix( c, color( 0x4c4a45 ), smoothstep( 0.82, 1.00, f ) ) );   // roche mère
		return c.mul( n.mul( 0.28 ).add( 0.82 ) );

	};

	const floors = [];

	for ( let l = 0; l < LAYERS; l ++ ) {

		const geo = new THREE.PlaneGeometry( SIZE, SIZE, RES - 1, RES - 1 )
			.rotateX( - Math.PI / 2 ).translate( centerX, 0, centerZ );

		const mat = new THREE.MeshStandardNodeMaterial( { roughness: 0.96, metalness: 0 } );
		mat.side = THREE.DoubleSide;

		mat.positionNode = Fn( () => {

			const d = layerOf( textureLoad( layout.depthTexture, mapTexel( positionLocal ) ), l );
			// pas de cavite ici : on plaque le sommet sur l'epaule, le fragment
			// sera de toute facon jete
			return vec3( positionLocal.x, select( d.lessThan( - 1e-4 ), d, float( SHELF ) ), positionLocal.z );

		} )();

		// normales en differences finies sur la carte : le relief n'existe que
		// dans le shader, three ne peut pas les calculer pour nous
		mat.normalNode = Fn( () => {

			const e = 1.5;
			const px = positionWorld.add( vec3( e * TEXEL, 0, 0 ) );
			const mx = positionWorld.sub( vec3( e * TEXEL, 0, 0 ) );
			const pz = positionWorld.add( vec3( 0, 0, e * TEXEL ) );
			const mz = positionWorld.sub( vec3( 0, 0, e * TEXEL ) );
			const dx = layerOf( textureLoad( layout.depthTexture, mapTexel( px ) ), l )
				.sub( layerOf( textureLoad( layout.depthTexture, mapTexel( mx ) ), l ) );
			const dz = layerOf( textureLoad( layout.depthTexture, mapTexel( pz ) ), l )
				.sub( layerOf( textureLoad( layout.depthTexture, mapTexel( mz ) ), l ) );
			return normalize( vec3( dx.negate(), float( 2 * e * TEXEL ), dz.negate() ) );

		} )();

		mat.colorNode = Fn( () => {

			const d = layerOf( textureLoad( layout.depthTexture, mapTexel( positionWorld ) ), l );
			Discard( d.greaterThan( - 1e-4 ) );
			return soilAt( positionWorld.y );

		} )();

		mat.emissiveNode = Fn( () => {

			// la terre garde une lueur interne : sans elle, un nid de 60 unites
			// de profondeur est illisible en pleine nuit
			const t = clamp( positionWorld.y.negate().div( uDepthMax ), 0, 1 );
			return mix( color( 0x1c1409 ), color( 0x2b1d10 ), t ).mul( 0.45 );

		} )();

		const mesh = new THREE.Mesh( geo, mat );
		mesh.receiveShadow = false;
		// le relief vit dans le vertex shader : la sphere englobante de three est
		// restee plate a y = 0, elle ne couvre plus la descente
		mesh.frustumCulled = false;
		mesh.renderOrder = - 1 + l * 0.001;
		group.add( mesh );
		floors.push( mesh );

	}

	// ------------------------------------------------------------------
	// Paroi de la découpe : anneau de terre entre le sol (y=0) et le fond
	// ------------------------------------------------------------------
	const rimGeo = new THREE.CylinderGeometry( 1, 1, 1, 96, 1, true );
	const rimMat = new THREE.MeshStandardNodeMaterial( {
		roughness: 1, metalness: 0, side: THREE.BackSide,
	} );
	rimMat.colorNode = Fn( () => soilAt( positionWorld.y ) )();
	rimMat.emissiveNode = Fn( () => {

		const t = clamp( positionWorld.y.negate().div( uDepthMax ), 0, 1 );
		return mix( color( 0x1c1409 ), color( 0x2b1d10 ), t ).mul( 0.35 );

	} )();

	const rim = new THREE.Mesh( rimGeo, rimMat );
	rim.frustumCulled = false;
	group.add( rim );

	// ------------------------------------------------------------------
	// Lueur chaude de la fourmilière (uniquement quand la vue est ouverte)
	// ------------------------------------------------------------------
	// deux sources : une pres de la surface, une au fond. Avec un nid de
	// plusieurs dizaines d'unites de profondeur, une seule lampe laisse les
	// etages bas dans le noir absolu.
	const glow = new THREE.PointLight( 0xffb060, 0, 60, 1.4 );
	group.add( glow );
	const glowDeep = new THREE.PointLight( 0xff9a50, 0, 70, 1.3 );
	group.add( glowDeep );

	// ------------------------------------------------------------------
	// Animation d'ouverture / fermeture
	// ------------------------------------------------------------------
	let reveal = 0;          // 0 fermé → 1 ouvert (lissé)

	function update( dt ) {

		const target = gfx.undergroundView ? 1 : 0;
		const k = 1 - Math.exp( - dt * 5 );
		reveal += ( target - reveal ) * k;
		if ( Math.abs( reveal - target ) < 0.002 ) reveal = target;

		const eased = reveal * reveal * ( 3 - 2 * reveal );     // smoothstep
		const r = gfx.pitRadius * eased;

		uPitR.value = r;

		// la paroi doit descendre jusqu'au fond du nid, pas seulement sous
		// l'epaule : le nid fait desormais des dizaines d'unites de profondeur
		const H = ( layout.depthMax || 60 ) + 2;
		uDepthMax.value = layout.depthMax || 60;
		rim.scale.set( Math.max( 0.001, r ), Math.max( 0.001, H ), Math.max( 0.001, r ) );
		rim.position.set( centerX, - H / 2, centerZ );
		rim.visible = r > 0.05;
		glow.position.set( centerX, - H * 0.12, centerZ );
		glowDeep.position.set( centerX, - H * 0.62, centerZ );
		glow.intensity = eased * 22;
		glowDeep.intensity = eased * 26;

		// l'herbe s'efface dans le disque (jamais en-deçà du trou du nid)
		if ( grass && grass.u && grass.u.holeIn ) {

			grass.u.holeIn.value = Math.max( 3.6, r - 1.4 );
			grass.u.holeOut.value = Math.max( 5.2, r );

		}

		// la fourmilière (GLB) se retire pendant la vue souterraine
		if ( env.anthill ) {

			const s = 1 - eased;
			env.anthill.visible = s > 0.02;
			env.anthill.scale.setScalar( env.anthill.userData.baseScale * Math.max( 0.001, s ) );

		}

		// caméra trop rasante à l'ouverture : on la relève en douceur, sinon
		// on ne voit que la paroi de la fosse (jamais les chambres)
		if ( gfx.undergroundView && reveal < 0.97 && camera && camera.position.y < 24 ) {

			camera.position.y += ( 26 - camera.position.y ) * k;

		}

	}

	return { group, update, get reveal() { return reveal; } };

}
