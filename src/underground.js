// VUE EN COUPE — la terre est un VOLUME traversé au rayon, plus une surface.
//
// Ce que remplace ce fichier : quatre maillages de plancher déformés dans le
// vertex shader, une découpe en disque dans le sol, un cylindre de paroi. Ça
// donnait des rideaux verticaux, un tube flottant et la skybox en arrière-plan.
//
// Le principe ici est inverse. Une BOÎTE de terre pleine englobe le nid. Pour
// chaque pixel on lance un rayon depuis la caméra et on avance jusqu'à trouver
// de la matière (champ de distance de nestvolume.js). Trois conséquences :
//
//   • ON NE PEUT PAS VOIR À TRAVERS de la terre pleine. Plus de skybox derrière
//     le nid, plus de trou : le volume est fermé par construction.
//   • LA COUPE est un simple décalage du départ du rayon. On démarre au plan de
//     coupe : là où il tombe dans la terre, on voit la tranche ; là où il tombe
//     dans une cavité, le rayon continue et révèle l'intérieur de la galerie.
//     C'est exactement la lecture d'une planche naturaliste.
//   • LA PROFONDEUR est écrite par le shader (depthNode) : les fourmis et le
//     décor se composent correctement avec la terre, sans tri ni transparence.
//
// La plupart des pixels touchent la tranche au PREMIER pas — seuls ceux qui
// tombent dans une ouverture de galerie marchent réellement. C'est ce qui rend
// le raymarching abordable ici.

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, Discard, uniform, texture3D,
	positionWorld, cameraPosition, cameraNear, cameraFar, cameraViewMatrix,
	viewZToPerspectiveDepth,
	vec3, vec4, float, max, min, abs, clamp, mix, dot, length, normalize,
	select, smoothstep, exp, color, mx_noise_float,
} from 'three/tsl';

import { GRID, WORLD, NEST, gfx } from './config.js';
import { uPitR, uCutOn, uCutN, uCutP } from './environment.js';

export function createUnderground( { scene, layout, env, grass, camera, volume } ) {

	const group = new THREE.Group();
	scene.add( group );

	const centerX = ( NEST.x / GRID - 0.5 ) * WORLD;
	const centerZ = ( NEST.y / GRID - 0.5 ) * WORLD;

	// ------------------------------------------------------------------
	// le plan de coupe est PARTAGÉ avec le terrain et l'herbe (environment.js) :
	// c'est la seule façon d'obtenir une vraie tranche — sans ça le sol situé
	// entre la caméra et le nid masque toute la moitié basse de la coupe
	const uOpen = uniform( 0 );                              // 0 fermé → 1 ouvert
	const uDepthMax = uniform( 18 );
	const uSurfaceY = uniform( 0 );
	const uHeadLight = uniform( 1 );
	const uAO = uniform( 1 );
	const uGhost = uniform( gfx.nestGhost );

	const vMin = volume.uMin;
	const vSize = volume.uSize;

	// BOITE PORTEUSE ≠ BOITE DU VOLUME. Le champ n'est baké qu'autour du nid,
	// mais la tranche, elle, doit courir jusqu'au bord du terrain : sinon le
	// bloc de terre s'arrete en biseau au milieu du paysage et on voit le ciel
	// derriere — exactement le « cylindre flottant » a proscrire. Hors du
	// volume sampleSDF renvoie de la terre pleine, donc tout l'espace en trop
	// se rend en terre unie pour le prix d'un test de bornes.
	const bMin = uniform( new THREE.Vector3() );
	const bSize = uniform( new THREE.Vector3( 1, 1, 1 ) );

	// ------------------------------------------------------------------
	// Échantillonnage du champ de distance.
	// Hors du volume on renvoie une grande valeur POSITIVE : de la terre pleine.
	// C'est ce qui ferme le décor — jamais de trou vers la skybox.
	// ------------------------------------------------------------------
	const sampleSDF = ( p ) => {

		const uvw = p.sub( vMin ).div( vSize );
		const inside = uvw.x.greaterThan( 0 ).and( uvw.x.lessThan( 1 ) )
			.and( uvw.y.greaterThan( 0 ) ).and( uvw.y.lessThan( 1 ) )
			.and( uvw.z.greaterThan( 0 ) ).and( uvw.z.lessThan( 1 ) );
		return select( inside, texture3D( volume.volume, uvw ).x, float( 4 ) );

	};

	// gradient du champ : sert à la normale ET à détecter la tranche plate
	const gradSDF = ( p ) => {

		const e = float( 0.35 );
		return vec3(
			sampleSDF( p.add( vec3( 0.35, 0, 0 ) ) ).sub( sampleSDF( p.sub( vec3( 0.35, 0, 0 ) ) ) ),
			sampleSDF( p.add( vec3( 0, 0.35, 0 ) ) ).sub( sampleSDF( p.sub( vec3( 0, 0.35, 0 ) ) ) ),
			sampleSDF( p.add( vec3( 0, 0, 0.35 ) ) ).sub( sampleSDF( p.sub( vec3( 0, 0, 0.35 ) ) ) ),
		).mul( float( 1 ).div( e ) );

	};

	// ------------------------------------------------------------------
	// Terre : horizons pédologiques. Le profil ne dépend que de la profondeur,
	// avec une frontière ondulée par UN seul bruit — trois octaves par fragment
	// coûteraient dix fois le budget pour un gain invisible.
	// ------------------------------------------------------------------
	const soilAt = ( p ) => {

		const n = mx_noise_float( p.mul( 0.22 ) ).mul( 0.5 ).add( 0.5 );
		const f = clamp( p.y.negate().div( uDepthMax ).add( n.sub( 0.5 ).mul( 0.10 ) ), 0, 1 ).toVar();
		const c = mix( color( 0x4a3520 ), color( 0x6b4726 ), smoothstep( 0.00, 0.16, f ) ).toVar();
		c.assign( mix( c, color( 0x7c5530 ), smoothstep( 0.16, 0.42, f ) ) );   // horizon A
		c.assign( mix( c, color( 0x71563a ), smoothstep( 0.42, 0.70, f ) ) );   // horizon B compact
		c.assign( mix( c, color( 0x63513e ), smoothstep( 0.70, 1.00, f ) ) );   // horizon C
		// grain : agregats et cailloux, l'echelle qui donne la matiere « terre ».
		// Il DOIT s'estomper avec la distance : a 40 unites un motif de periode
		// 0,4 tombe sous le pixel et moire en damier sur toute la tranche.
		const g = mx_noise_float( p.mul( 2.6 ) ).mul( 0.5 ).add( 0.5 );
		const fade = clamp( float( 1 ).sub( length( p.sub( cameraPosition ) ).mul( 0.028 ) ), 0, 1 );
		return c.mul( g.sub( 0.5 ).mul( fade ).mul( 0.34 ).add( 1 ) );

	};

	// ------------------------------------------------------------------
	// LE RAYMARCH — partagé par la couleur et la profondeur
	// ------------------------------------------------------------------
	const march = Fn( () => {

		const ro = cameraPosition;
		const rd = normalize( positionWorld.sub( cameraPosition ) ).toVar();

		// --- intersection avec la boîte du volume (méthode des dalles) ---
		const safe = ( v ) => select( abs( v ).lessThan( 1e-4 ), float( 1e-4 ), v );
		const inv = vec3( 1 ).div( vec3( safe( rd.x ), safe( rd.y ), safe( rd.z ) ) );
		const t0v = bMin.sub( ro ).mul( inv );
		const t1v = bMin.add( bSize ).sub( ro ).mul( inv );
		const tsm = min( t0v, t1v ), tbg = max( t0v, t1v );
		const tEnter = max( max( max( tsm.x, tsm.y ), tsm.z ), 0.02 ).toVar();
		const tExit = min( min( tbg.x, tbg.y ), tbg.z ).toVar();

		// --- PLAN DE COUPE : on démarre le rayon derrière lui ---
		// C'est TOUT le mécanisme de la coupe. Devant le plan rien n'existe ;
		// derrière, la terre est pleine. La tranche apparaît là où le plan tombe
		// dans la matière, et les galeries s'ouvrent là où il tombe dans le vide.
		const dn = dot( rd, uCutN ).toVar();
		const tPlane = dot( uCutP.sub( ro ), uCutN ).div( safe( dn ) );

		If( dn.lessThan( 0 ), () => {

			tEnter.assign( max( tEnter, tPlane ) );

		} ).Else( () => {

			tExit.assign( min( tExit, tPlane ) );

		} );

		// --- on ne marche que SOUS la surface ---
		If( ro.y.add( rd.y.mul( tEnter ) ).greaterThan( uSurfaceY ), () => {

			tEnter.assign( max( tEnter, uSurfaceY.sub( ro.y ).div( safe( rd.y ) ) ) );

		} );

		const hit = float( 0 ).toVar();
		const t = tEnter.toVar();
		const t0 = tEnter.toVar();

		If( tEnter.lessThan( tExit ), () => {

			Loop( { start: 0, end: 72, condition: '<' }, () => {

				const p = ro.add( rd.mul( t ) );
				const d = sampleSDF( p ).toVar();

				If( d.greaterThanEqual( 0 ).and( p.y.lessThan( uSurfaceY ) ), () => {

					hit.assign( 1 );
					Break();

				} );

				// dans une cavité : on avance de la distance à sa paroi. Le bruit
				// casse le caractère 1-lipschitzien du champ, d'où le facteur 0,8
				// qui évite de traverser une paroi mince.
				t.addAssign( max( d.negate().mul( 0.8 ), 0.1 ) );

				If( t.greaterThan( tExit ), () => {

					Break();

				} );

			} );

		} );

		// w = distance parcourue DANS LE VIDE avant de toucher la matière
		// (négative = le rayon n'a rien touché). C'est cette longueur qui donne
		// la profondeur de champ des galeries : une paroi vue au fond d'un
		// tunnel doit être bien plus sombre que la tranche elle-même.
		return vec4( ro.add( rd.mul( t ) ), select( hit.greaterThan( 0.5 ), t.sub( t0 ), float( - 1 ) ) );

	} );

	// ------------------------------------------------------------------
	const material = new THREE.MeshBasicNodeMaterial();
	material.side = THREE.BackSide;      // la boîte reste valide caméra à l'intérieur
	material.depthWrite = true;

	material.colorNode = Fn( () => {

		Discard( uOpen.lessThan( 0.01 ) );

		const r = march();
		Discard( r.w.lessThan( 0 ) );
		const p = r.xyz;

		// --- TRANCHE ou VRAIE PAROI ? ---
		// Piege : on ne peut PAS le deduire du gradient du champ. Un champ de
		// distance a un gradient unitaire PARTOUT, y compris au milieu de la terre
		// pleine — il pointe simplement vers la cavite la plus proche. Le test
		// |grad| ~ 0 ne repere que les zones saturees du champ, pas la coupe : la
		// tranche entiere passait pour une paroi, se prenait la lampe frontale en
		// pleine face et saturait en beige.
		//
		// Le vrai critere est geometrique. Tout rayon demarre AU plan de coupe ;
		// s'il touche de la matiere sans avoir parcourt un pouce de vide, c'est
		// qu'il est tombe sur la tranche. w (distance parcourue dans le vide) est
		// donc exactement le discriminant, et il donne en prime un degrade doux
		// aux bouches de galerie.
		const wallness = smoothstep( 0.04, 0.55, r.w ).toVar();

		const g = gradSDF( p ).toVar();
		const gl = length( g ).toVar();
		const n = normalize( mix( uCutN, g.negate().div( max( gl, 1e-4 ) ), wallness ) ).toVar();

		// --- OCCLUSION AMBIANTE dérivée du champ ---
		// C'est ELLE qui rend les cavités lisibles : au fond d'une galerie la
		// matière est proche de tous côtés, donc sombre ; sur la tranche elle est
		// dégagée, donc claire. Quatre échantillons suffisent.
		// On mesure l'OUVERTURE : combien d'espace libre au-dessus du point, le
		// long de sa normale. Le champ est négatif dans le vide, d'où le
		// `negate()` — sans lui l'occlusion s'inverse et ce sont les parois qui
		// noircissent au lieu des recoins.
		const ao = float( 0 ).toVar();
		const wsum = float( 0 ).toVar();

		for ( let i = 1; i <= 4; i ++ ) {

			const h = 0.45 * i;
			const w = 1 / i;
			ao.addAssign( clamp( sampleSDF( p.add( n.mul( h ) ) ).negate().div( h ), 0, 1 ).mul( w ) );
			wsum.addAssign( w );

		}

		// Sur la TRANCHE, l'occlusion n'a aucun sens (la matière continue vers la
		// caméra) : on n'applique le noircissement que sur les vraies parois.
		const open = ao.div( wsum ).mul( 0.75 ).add( 0.25 );
		const occ = mix( float( 1 ), open, wallness.mul( uAO ) ).toVar();

		// --- lumiere ---
		// DEUX REGIMES, et c'est le point cle du rendu. La TRANCHE est une coupe
		// virtuelle : sa normale est celle du plan, donc face a la camera, donc
		// lambert y vaut 1 partout. L'eclairer comme une vraie paroi la saturait
		// en beige uniforme — les horizons pedologiques disparaissaient et les
		// cavites, elles eclairees de biais, ressortaient PLUS CLAIRES que la
		// terre : on lisait des bosses au lieu de trous. La tranche recoit donc
		// un eclairage plat de planche naturaliste, les vraies parois la lampe.
		const toCam = cameraPosition.sub( p );
		const dist = length( toCam ).toVar();
		const l = toCam.div( max( dist, 1e-4 ) );
		const lambert = clamp( dot( n, l ), 0, 1 );
		const falloff = clamp( float( 1 ).sub( dist.div( uDepthMax.mul( 3 ).add( 60 ) ) ), 0.06, 1 );

		// La TRANCHE recoit un eclairage plat et SOMBRE : c'est de la terre en
		// coupe, pas une paroi eclairee. Les vraies parois, elles, recoivent la
		// lampe frontale. L'inversion de contraste est volontaire — sur une
		// planche naturaliste ce sont les cavites qui sont claires et ouvertes,
		// la terre qui fait le fond sombre. C'est ce qui les fait lire comme des
		// creux et non comme des bosses.
		const wallLight = lambert.mul( uHeadLight ).mul( falloff ).mul( 2.2 ).add( 0.10 );
		const faceLight = float( 0.72 );
		const amount = mix( faceLight, wallLight, wallness ).toVar();

		// REBORD. L'indice qui fait basculer la lecture creux/bosse : au bord d'un
		// trou la paroi devient rasante, et une paroi rasante est dans l'ombre.
		// Sans cette ligne les galeries ressortaient en relief.
		const lip = float( 1 ).sub( abs( dot( n, l ) ) );
		const lipShade = mix( float( 1 ), float( 0.26 ), lip.mul( wallness ) ).toVar();

		// perte de lumiere avec la profondeur de galerie, mais douce : trop fort,
		// les chambres du fond disparaissaient au lieu de se lire en enfilade
		const cave = exp( r.w.mul( - 0.16 ) ).toVar();

		// --- LES GALERIES PAR TRANSPARENCE ---
		// Une coupe stricte ne montre que ce que le plan traverse : le reste du
		// nid, a un metre derriere, reste invisible. On sonde donc le champ
		// DERRIERE la tranche le long du rayon et on assombrit la terre la ou du
		// vide se cache dessous. Meme principe qu'une vision a travers les murs de
		// jeu AAA, mais gratuit : le champ de distance est deja la. La branche est
		// coherente (des regions entieres sont soit tranche soit paroi), donc
		// reellement sautee par le GPU.
		const ghost = float( 0 ).toVar();

		If( wallness.lessThan( 0.55 ).and( uGhost.greaterThan( 0.01 ) ), () => {

			const dir = normalize( p.sub( cameraPosition ) );

			for ( let i = 1; i <= 7; i ++ ) {

				const sd = sampleSDF( p.add( dir.mul( 1.3 * i ) ) );
				ghost.addAssign( clamp( sd.negate().mul( 0.9 ), 0, 1 ).mul( 1 - ( i - 1 ) / 8 ) );

			}

			ghost.assign( clamp( ghost.mul( 0.45 ), 0, 1 ).mul( uGhost )
				.mul( float( 1 ).sub( wallness ) ) );

		} );

		const base = soilAt( p );
		const lit = base.mul( amount ).mul( occ ).mul( lipShade )
			.mul( cave.mul( 0.72 ).add( 0.28 ) )
			.mul( mix( float( 1 ), float( 1.55 ), ghost ) );

		// lueur chaude au fond des galeries : elle vient de l'interieur du nid,
		// signale les cavites lointaines au lieu de les noyer dans le noir
		const warm = color( 0xffa055 ).mul( float( 1 ).sub( cave ) ).mul( 0.22 ).mul( occ )
			.mul( wallness )
			.add( color( 0xffb267 ).mul( ghost ).mul( 0.16 ) );

		// LISERE de bouche de galerie : un filet clair la ou la paroi rencontre la
		// tranche. L'oeil accroche le dessin des cavites.
		const rim = smoothstep( 0.30, 0.80, wallness ).mul( smoothstep( 1.1, 0.05, r.w ) );
		const edge = color( 0xf0cb96 ).mul( rim ).mul( 0.30 );

		return lit.add( warm ).add( edge );

	} )();

	// PROFONDEUR RÉELLE du point touché : c'est ce qui permet aux fourmis de
	// s'afficher DANS les galeries et non devant ou derrière en bloc.
	material.depthNode = Fn( () => {

		const r = march();
		return viewZToPerspectiveDepth(
			cameraViewMatrix.mul( vec4( r.xyz, 1 ) ).z, cameraNear, cameraFar );

	} )();

	// ------------------------------------------------------------------
	// La boîte porteuse
	// ------------------------------------------------------------------
	const box = new THREE.Mesh( new THREE.BoxGeometry( 1, 1, 1 ), material );
	box.frustumCulled = false;
	box.renderOrder = - 2;
	box.visible = false;
	group.add( box );

	function fitBox() {

		const s = bSize.value, m = bMin.value;
		box.scale.set( s.x, s.y, s.z );
		box.position.set( m.x + s.x / 2, m.y + s.y / 2, m.z + s.z / 2 );

	}

	// ------------------------------------------------------------------
	// Animation d'ouverture
	// ------------------------------------------------------------------
	let reveal = 0;
	const camDir = new THREE.Vector3();

	function update( dt ) {

		const target = gfx.undergroundView ? 1 : 0;
		const k = 1 - Math.exp( - dt * 5 );
		reveal += ( target - reveal ) * k;
		if ( Math.abs( reveal - target ) < 0.002 ) reveal = target;

		const eased = reveal * reveal * ( 3 - 2 * reveal );
		uOpen.value = eased;
		box.visible = eased > 0.01;
		uDepthMax.value = layout.depthMax || 18;
		uHeadLight.value = gfx.nestLight;
		uAO.value = gfx.nestAO;
		uGhost.value = gfx.nestGhost;

		// la tranche court jusqu'au bord du terrain, et descend sous le nid :
		// le bloc n'a plus de silhouette propre, c'est le sol qui est ouvert
		const half = Math.max( WORLD * 0.5, vSize.value.x * 0.5 + 8 );
		const floorY = vMin.value.y - 6;
		bMin.value.set( centerX - half, floorY, centerZ - half );
		bSize.value.set( half * 2, - floorY + 0.05, half * 2 );
		fitBox();

		// LE PLAN DE COUPE SUIT LA CAMÉRA : sa normale est la direction
		// horizontale nid→caméra, si bien qu'on regarde toujours une tranche
		// fraîche quelle que soit l'orbite.
		camDir.set( camera.position.x - centerX, 0, camera.position.z - centerZ );
		if ( camDir.lengthSq() < 1e-6 ) camDir.set( 0, 0, 1 );
		camDir.normalize();
		uCutN.value.copy( camDir );
		uCutP.value.set(
			centerX + camDir.x * gfx.cutOffset, 0, centerZ + camDir.z * gfx.cutOffset );
		uCutOn.value = eased;

		// le sol de surface s'ouvre en même temps, sur un disque un peu plus
		// large que le nid pour qu'on voie la tranche depuis le dessus
		uPitR.value = eased * Math.max( gfx.pitRadius, ( layout.radiusWorld || 20 ) + 3 );

		if ( grass && grass.u && grass.u.holeIn ) {

			grass.u.holeIn.value = Math.max( 3.6, uPitR.value - 1.4 );
			grass.u.holeOut.value = Math.max( 5.2, uPitR.value );

		}

		if ( env.anthill ) {

			const s = 1 - eased;
			env.anthill.visible = s > 0.02;
			env.anthill.scale.setScalar( env.anthill.userData.baseScale * Math.max( 0.001, s ) );

		}

	}

	return { group, update, box, get reveal() { return reveal; } };

}
