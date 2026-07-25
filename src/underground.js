// LE BLOC DE TERRE — la map est un pavé de terre, et c'est tout.
//
// Ce que remplace ce fichier : quatre maillages de plancher déformés dans le
// vertex shader, une découpe en disque dans le sol, un cylindre de paroi, puis
// un « mode coupe » avec plan de coupe et fosse. Rideaux verticaux, tube
// flottant, skybox en arrière-plan, bascules de mode : tout cela est supprimé.
//
// Le principe : IL N'Y A AUCUN MODE. Depuis la surface le bloc est un simple
// pavé opaque (environment.js) — la fourmilière est enterrée, invisible. La
// caméra qui ENTRE dans le bloc (comme une caméra au bout d'une forreuse qui
// ne creuse pas) voit simplement ce qui l'entoure :
//
//   • LA TERRE au contact : une boîte englobe le nid et lance un rayon par
//     pixel jusqu'au champ de distance de nestvolume.js. Dans la terre pleine
//     le contact est immédiat — on voit la texture de terre ; dans une cavité
//     le rayon la traverse et révèle ses parois éclairées. On ne voit que ce
//     qui entoure réellement la caméra : tunnels et loges autour d'elle.
//   • UN FOND DE TERRE uniforme (grande boîte vue de l'intérieur) : la skybox
//     n'existe plus. La strate est prise à la profondeur de la caméra (une
//     seule couche, aucun horizon), le grain en 3D réel (pas de rayures).
//   • Le décor de surface disparaît (main.js), les fourmis de surface
//     deviennent semi-transparentes (ants.js, uDive), les souterraines
//     apparaissent — tout cela au franchissement exact de la paroi du bloc.
//
// La plupart des pixels touchent la matière au PREMIER pas — seuls ceux qui
// tombent dans une cavité marchent réellement : le raymarching reste
// abordable. La PROFONDEUR est écrite par le shader (depthNode) : fourmis et
// œufs se composent correctement avec la terre, sans tri ni transparence.
//
// LE SCANNER (style Deep Rock Galactic) est un simple BONUS par-dessus, armé
// par la case « Vue scanner » de l'UI et affiché seulement caméra dans le
// bloc : une boîte additive SANS test de profondeur dessine le nid COMPLET en
// fil de fer. Le rayon traverse tout le volume et chaque franchissement de
// paroi (changement de signe du canal G, le champ PROPRE sans bruit) émet une
// ligne de la cage 3D à la position affinée par bissection : 100 % de la
// fourmilière, de tout angle, sans masque lié à la caméra.
//
// Une impulsion sphérique (périodique + une grosse à l'activation) fait
// flamboyer l'hologramme à son passage. Coût : quelques ALU par pas de
// marche, ZÉRO passe ni texture ajoutée ; la boîte est cachée hors plongée.

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, Discard, uniform, texture3D,
	positionWorld, cameraPosition, cameraNear, cameraFar, cameraViewMatrix,
	viewZToPerspectiveDepth, time,
	vec3, vec4, float, max, min, abs, clamp, mix, dot, length, normalize,
	select, smoothstep, exp, fract, color, mx_noise_float,
} from 'three/tsl';

import { GRID, WORLD, NEST, gfx, params } from './config.js';

export function createUnderground( { scene, layout, env, camera, volume } ) {

	const group = new THREE.Group();
	scene.add( group );

	const centerX = ( NEST.x / GRID - 0.5 ) * WORLD;
	const centerZ = ( NEST.y / GRID - 0.5 ) * WORLD;

	// ------------------------------------------------------------------
	const uDepthMax = uniform( 18 );
	const uSurfaceY = uniform( 0 );
	const uHeadLight = uniform( 1 );
	const uAO = uniform( 1 );
	const uGhost = uniform( gfx.nestGhost );

	// --- scanner : activation binaire + impulsion (voir en-tête) ---
	const uScan = uniform( gfx.nestScan );         // intensité maître (UI)
	const uScanPulse = uniform( gfx.nestScanPulse );
	const uScanColor = uniform( new THREE.Color( gfx.nestScanColor ) );
	// hologramme actif : 0/1 BINAIRE (plus de fondu — voir en-tête)
	const uScanMode = uniform( 0 );
	// âge (s) de l'impulsion d'activation — compté côté CPU, 1e6 = jamais tirée
	const uScanFire = uniform( 1e6 );

	// constantes du scanner : l'onde part du puits d'entrée du nid
	const SCAN_CENTER = vec3( centerX, 0, centerZ );
	const GRID_FREQ = 1.5;        // fréquence de la cage 3D (~0,67 u par maille :
	                              // dense comme le scanner DRG, sans virer au gruyère)
	const SCAN_PERIOD = 5.0;      // période de l'impulsion périodique (s)
	const SCAN_RANGE = 45.0;      // portée de l'impulsion (unités monde)

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

	// Canal G du volume : le champ PROPRE (sans bruit, plafond plat), baké pour
	// la vue scanner — le bruit du canal R sème de faux franchissements de
	// paroi dans la terre pleine, qui se lisent en grêle de points.
	const sampleSDFClean = ( p ) => {

		const uvw = p.sub( vMin ).div( vSize );
		const inside = uvw.x.greaterThan( 0 ).and( uvw.x.lessThan( 1 ) )
			.and( uvw.y.greaterThan( 0 ) ).and( uvw.y.lessThan( 1 ) )
			.and( uvw.z.greaterThan( 0 ) ).and( uvw.z.lessThan( 1 ) );
		return select( inside, texture3D( volume.volume, uvw ).y, float( 4 ) );

	};

	// ------------------------------------------------------------------
	// Terre : horizons pédologiques. Le profil ne dépend que de la profondeur,
	// avec une frontière ondulée par UN seul bruit — trois octaves par fragment
	// coûteraient dix fois le budget pour un gain invisible.
	// `detail` = point où évaluer le GRAIN (par défaut le même que la strate).
	// Le fond de plongée prend la strate à la profondeur de la caméra mais le
	// grain à la vraie position : strate uniforme SANS aplatir le bruit (sinon
	// y constant dégénère le bruit 3D en rayures verticales sur les murs).
	// ------------------------------------------------------------------
	const soilAt = ( p, detail = p ) => {

		const n = mx_noise_float( p.mul( 0.22 ) ).mul( 0.5 ).add( 0.5 );
		const f = clamp( p.y.negate().div( uDepthMax ).add( n.sub( 0.5 ).mul( 0.10 ) ), 0, 1 ).toVar();
		const c = mix( color( 0x4a3520 ), color( 0x6b4726 ), smoothstep( 0.00, 0.16, f ) ).toVar();
		c.assign( mix( c, color( 0x7c5530 ), smoothstep( 0.16, 0.42, f ) ) );   // horizon A
		c.assign( mix( c, color( 0x71563a ), smoothstep( 0.42, 0.70, f ) ) );   // horizon B compact
		c.assign( mix( c, color( 0x63513e ), smoothstep( 0.70, 1.00, f ) ) );   // horizon C
		// grain : agregats et cailloux, l'echelle qui donne la matiere « terre ».
		// Il DOIT s'estomper avec la distance : a 40 unites un motif de periode
		// 0,4 tombe sous le pixel et moire en damier sur toute la tranche.
		const g = mx_noise_float( detail.mul( 2.6 ) ).mul( 0.5 ).add( 0.5 );
		const fade = clamp( float( 1 ).sub( length( detail.sub( cameraPosition ) ).mul( 0.028 ) ), 0, 1 );
		return c.mul( g.sub( 0.5 ).mul( fade ).mul( 0.34 ).add( 1 ) );

	};

	// ------------------------------------------------------------------
	// Impulsion du scanner au point p : base constante (l'hologramme ne
	// s'éteint jamais tout à fait) + onde sphérique périodique partie du
	// puits + impulsion d'activation. uScanPulse = 0 → rendu statique.
	// ------------------------------------------------------------------
	const pulseAt = ( p ) => {

		const distC = length( p.sub( SCAN_CENTER ) ).toVar();

		// onde périodique : son rayon court de 0 à la portée à chaque période,
		// et son amplitude s'éteint en fin de course (pas de « pop » au rebouclage)
		const phase = fract( time.mul( uScanPulse ).div( SCAN_PERIOD ) ).toVar();
		const d1 = distC.sub( phase.mul( SCAN_RANGE ) );
		const wave = exp( d1.mul( d1 ).div( - 4.8 ) )
			.mul( float( 1 ).sub( phase ) ).mul( 1.6 ).mul( clamp( uScanPulse, 0, 1 ) );

		// impulsion d'activation : plus rapide, plus large, décroît avec l'âge
		const d2 = distC.sub( uScanFire.mul( 18 ) );
		const fire = exp( d2.mul( d2 ).div( - 10 ) )
			.mul( exp( uScanFire.mul( - 1.1 ) ) ).mul( 2.5 );

		// base discrète (l'hologramme reste visible entre deux impulsions)
		return float( 0.45 ).add( wave ).add( fire );

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
	// LA VUE SCANNER — hologramme autonome, SANS coupe. Le rayon traverse
	// TOUT le volume : dans la terre pleine le champ vaut la distance à la
	// cavité la plus proche, la marche y accélère donc d'elle-même. Chaque
	// franchissement de PAROI (changement de signe du champ entre deux pas)
	// émet un fil de fer à la position affinée. Toutes les parois se somment,
	// face avant comme face arrière : on voit 100 % de la fourmilière, de
	// n'importe quel angle, la boîte étant additive et sans test de
	// profondeur (l'hologramme se voit à travers le terrain, comme le
	// scanner de Deep Rock Galactic).
	// ------------------------------------------------------------------
	const marchScan = Fn( () => {

		const ro = cameraPosition;
		const rd = normalize( positionWorld.sub( cameraPosition ) ).toVar();

		// intersection avec la boîte DU VOLUME (le nid, pas la tranche)
		const safe = ( v ) => select( abs( v ).lessThan( 1e-4 ), float( 1e-4 ), v );
		const inv = vec3( 1 ).div( vec3( safe( rd.x ), safe( rd.y ), safe( rd.z ) ) );
		const t0v = vMin.sub( ro ).mul( inv );
		const t1v = vMin.add( vSize ).sub( ro ).mul( inv );
		const tsm = min( t0v, t1v ), tbg = max( t0v, t1v );
		const tEnter = max( max( max( tsm.x, tsm.y ), tsm.z ), 0.02 ).toVar();
		const tExit = min( min( tbg.x, tbg.y ), tbg.z ).toVar();

		const glow = float( 0 ).toVar();
		const dPrev = float( 1 ).toVar();
		const count = float( 0 ).toVar();
		const t = tEnter.toVar();
		const tPrev = tEnter.toVar();

		If( tEnter.lessThan( tExit ), () => {

			Loop( { start: 0, end: 96, condition: '<' }, ( { i } ) => {

				const p = ro.add( rd.mul( t ) );
				const d = sampleSDFClean( p ).toVar();

				// franchissement de paroi : le champ change de signe entre deux pas
				If( i.greaterThan( 0 ).and( d.mul( dPrev ).lessThan( 0 ) ), () => {

					// POSITION EXACTE du croisement. L'interpolation linéaire
					// seule laisse jusqu'à un demi-pas d'erreur : la cage se
					// brisait en points et en micro-segments mal liés. Deux
					// bissections sur le bracket [tPrev, t] referment l'écart,
					// l'interpolation finale donne le point au sous-millimètre :
					// la grille est continue et régulière.
					const tA = tPrev.toVar();
					const tB = t.toVar();
					const dA = dPrev.toVar();
					const dB = d.toVar();

					for ( let it = 0; it < 2; it ++ ) {

						const tM = tA.add( tB ).mul( 0.5 );
						const dM = sampleSDFClean( ro.add( rd.mul( tM ) ) ).toVar();

						If( dM.mul( dA ).lessThan( 0 ), () => {

							tB.assign( tM );
							dB.assign( dM );

						} ).Else( () => {

							tA.assign( tM );
							dA.assign( dM );

						} );

					}

					const alpha = clamp( dA.div( dA.sub( dB ).add( 1e-6 ) ), 0, 1 );
					const pC = ro.add( rd.mul( mix( tA, tB, alpha ) ) );

					// GRILLE WIREFRAME sur la paroi : les LIGNES sont les
					// intersections de la paroi avec les PLANS de la grille 3D
					// (UNE coordonnée entière → lignes de niveau, continues).
					// Piège : prendre les ARÊTES de la grille (deux coordonnées
					// entières) ne donne que des POINTS — une arête 1D ne perce
					// une paroi 2D qu'en un pixel isolé. La demi-largeur des
					// lignes grandit avec la distance pour rester ~1 px à
					// l'écran ; très loin on fond vers un voile (anti-moiré).
					// Profil RESSERRÉ (chute rapide du smoothstep) : des traits
					// fins et nets au lieu de boudins flous pixelisés.
					const lw = float( 0.022 ).mul( t.mul( 0.015 ).add( 1 ) );
					const fw = fract( pC.mul( GRID_FREQ ).add( 0.5 ) ).sub( 0.5 ).abs();
					const lx = smoothstep( lw, lw.mul( 0.35 ), fw.x );
					const ly = smoothstep( lw, lw.mul( 0.35 ), fw.y );
					const lz = smoothstep( lw, lw.mul( 0.35 ), fw.z );
					const grid = max( lx, max( ly, lz ) );
					const wire = mix( grid, float( 0.5 ), smoothstep( 60, 140, t ) );

					// décroissance par rang de paroi : les faces avant dominent,
					// les faces arrière restent lisibles sans saturer en aplat.
					// Le fondu d'entrée (smoothstep sur t) écarte les parois
					// COLÉES à la caméra — sinon leurs lignes géantes
					// envahissent tout l'écran quand on est DANS le nid.
					glow.addAssign( wire.mul( 0.7 )
						.mul( smoothstep( 0.2, 2.2, t ) )
						.mul( exp( count.mul( - 0.55 ) ) )
						.mul( exp( t.mul( - 0.012 ) ) ).mul( pulseAt( pC ) ) );
					count.addAssign( 1 );

				} );
				dPrev.assign( d );
				tPrev.assign( t );

				// terre pleine comme cavité : le champ PROPRE est lipschitzien,
				// le pas quasi plein (0,95) ne traverse aucune paroi mince
				t.addAssign( max( abs( d ).mul( 0.95 ), 0.1 ) );

				If( t.greaterThan( tExit ), () => {

					Break();

				} );

			} );

		} );

		return glow;

	} );

	// ------------------------------------------------------------------
	const material = new THREE.MeshBasicNodeMaterial();
	material.side = THREE.BackSide;      // la boîte reste valide caméra à l'intérieur
	material.depthWrite = true;

	material.colorNode = Fn( () => {

		const r = march();
		Discard( r.w.lessThan( 0 ) );
		const p = r.xyz;

		// --- TERRE AU CONTACT ou VRAIE PAROI ? ---
		// Piege : on ne peut PAS le deduire du gradient du champ. Un champ de
		// distance a un gradient unitaire PARTOUT, y compris au milieu de la terre
		// pleine — il pointe simplement vers la cavite la plus proche. Le test
		// |grad| ~ 0 ne repere que les zones saturees du champ : la terre au
		// contact entiere passait pour une paroi, se prenait la lampe frontale en
		// pleine face et saturait en beige.
		//
		// Le vrai critere est geometrique : si le rayon touche de la matiere
		// sans avoir parcouru un pouce de vide, c'est de la terre pleine au
		// contact de l'objectif. w (distance parcourue dans le vide) est donc
		// exactement le discriminant, et il donne en prime un degrade doux aux
		// bouches de galerie.
		const wallness = smoothstep( 0.04, 0.55, r.w ).toVar();

		const g = gradSDF( p ).toVar();
		const gl = length( g ).toVar();
		// au contact (wallness ≈ 0) la « paroi » fait face à la caméra :
		// normale = rayon inversé, comme une tranche de planche naturaliste
		const rd = normalize( positionWorld.sub( cameraPosition ) );
		const n = normalize( mix( rd.negate(), g.negate().div( max( gl, 1e-4 ) ), wallness ) ).toVar();

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
		// DEUX REGIMES, et c'est le point cle du rendu. La TERRE AU CONTACT fait
		// face a la camera (normale = rayon inverse), donc lambert y vaut 1
		// partout. L'eclairer comme une vraie paroi la saturait en beige
		// uniforme — les horizons pedologiques disparaissaient et les cavites,
		// elles eclairees de biais, ressortaient PLUS CLAIRES que la terre : on
		// lisait des bosses au lieu de trous. Le contact recoit donc un
		// eclairage plat, les vraies parois la lampe frontale.
		const toCam = cameraPosition.sub( p );
		const dist = length( toCam ).toVar();
		const l = toCam.div( max( dist, 1e-4 ) );
		const lambert = clamp( dot( n, l ), 0, 1 );
		const falloff = clamp( float( 1 ).sub( dist.div( uDepthMax.mul( 3 ).add( 60 ) ) ), 0.06, 1 );

		// La TERRE AU CONTACT recoit un eclairage plat et SOMBRE : c'est de la
		// terre contre l'objectif, pas une paroi eclairee. Les vraies parois,
		// elles, recoivent la lampe frontale. L'inversion de contraste est
		// volontaire : ce sont les cavites qui sont claires et ouvertes, la
		// terre qui fait le fond sombre. C'est ce qui les fait lire comme des
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
		// Le contact immediat ne montre que de la terre : les cavites a un
		// metre derriere restent invisibles. On sonde donc le champ DERRIERE le
		// contact le long du rayon et on assombrit la terre la ou du vide se
		// cache dessous. Meme principe qu'une vision a travers les murs de jeu
		// AAA, mais gratuit : le champ de distance est deja la. La branche est
		// coherente (des regions entieres sont soit contact soit paroi), donc
		// reellement sautee par le GPU.
		//
		// FONDU A LA DISTANCE : l'effet ne doit révéler que les cavités PROCHEs
		// de la caméra. Sans lui, toute la silhouette du volume baké se
		// dessinait en rectangle clair dans le lointain — le fond n'était pas
		// uni. Au-delà de ~25 u la terre redevient une masse uniforme.
		const ghost = float( 0 ).toVar();

		If( wallness.lessThan( 0.55 ).and( uGhost.greaterThan( 0.01 ) ), () => {

			const dir = normalize( p.sub( cameraPosition ) );

			for ( let i = 1; i <= 7; i ++ ) {

				const sd = sampleSDF( p.add( dir.mul( 1.3 * i ) ) );
				ghost.addAssign( clamp( sd.negate().mul( 0.9 ), 0, 1 ).mul( 1 - ( i - 1 ) / 8 ) );

			}

			ghost.assign( clamp( ghost.mul( 0.45 ), 0, 1 ).mul( uGhost )
				.mul( float( 1 ).sub( wallness ) )
				.mul( smoothstep( 26.0, 9.0, dist ) ) );

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

	// ------------------------------------------------------------------
	// Le FOND DE TERRE de la plongée : sous terre, la skybox n'existe plus.
	// Grande SPHÈRE OPAQUE vue de l'intérieur — pas une boîte : les arêtes et
	// coins d'un cube restaient perceptibles en filigrane (dégradé des normales
	// par face), une sphère n'a aucune silhouette propre. Dessinée en PREMIER
	// (renderOrder −3), SANS écriture de profondeur → fourmis, œufs et
	// hologramme passent toujours devant. Hors brouillard : le fond doit
	// rester de la terre, pas se laver vers la couleur du ciel.
	// ------------------------------------------------------------------
	const SOIL_R = 300;       // assez grand pour englober toute la carte

	const soilMat = new THREE.MeshBasicNodeMaterial();
	soilMat.side = THREE.BackSide;
	soilMat.depthWrite = false;
	soilMat.fog = false;

	soilMat.colorNode = Fn( () => {

		// La strate est prise À LA PROFONDEUR DE LA CAMÉRA : une caméra
		// enfoncée dans la terre voit UNE seule couche de sol, uniforme.
		// Échantillonner la strate à la profondeur du fragment donnait un
		// dégradé vertical — un faux horizon avec bandes haut/bas, exactement
		// l'effet « filtre sur la skybox » à proscrire. Le grain, lui, reste
		// évalué à la position réelle : à y constant le bruit 3D dégénérerait
		// en stries sur la sphère. Le facteur 0,72 épouse l'éclairage plat de
		// la terre au contact (faceLight) : aucune ligne de jonction entre le
		// raymarch et ce fond — le tout se lit comme UNE masse de terre.
		return soilAt(
			vec3( positionWorld.x, cameraPosition.y, positionWorld.z ), positionWorld ).mul( 0.72 );

	} )();

	const soilBox = new THREE.Mesh( new THREE.SphereGeometry( 1, 32, 16 ), soilMat );
	soilBox.frustumCulled = false;
	soilBox.renderOrder = - 3;
	soilBox.visible = false;
	soilBox.scale.setScalar( SOIL_R );
	soilBox.position.set( centerX, 0, centerZ );
	group.add( soilBox );

	// ------------------------------------------------------------------
	// La boîte HOLOGRAMME : fil-de-fer du nid complet. Additive, sans écriture
	// NI test de profondeur → visible à travers le terrain, dessinée en
	// dernier. Hors brouillard : un hologramme ne s'estompe pas avec la
	// distance atmosphérique.
	// ------------------------------------------------------------------
	const scanMat = new THREE.MeshBasicNodeMaterial();
	scanMat.side = THREE.BackSide;
	scanMat.transparent = true;
	scanMat.blending = THREE.AdditiveBlending;
	scanMat.depthWrite = false;
	scanMat.depthTest = false;
	scanMat.fog = false;

	scanMat.colorNode = Fn( () => {

		const g = marchScan();
		Discard( g.lessThan( 0.004 ) );
		const glow = float( 1 ).sub( exp( g.mul( - 1.8 ) ) ).mul( uScan ).mul( uScanMode );
		return vec4( uScanColor.mul( glow ), 1 );

	} )();

	const scanBox = new THREE.Mesh( new THREE.BoxGeometry( 1, 1, 1 ), scanMat );
	scanBox.frustumCulled = false;
	scanBox.renderOrder = 10;
	scanBox.visible = false;
	group.add( scanBox );

	function fitBox() {

		const s = bSize.value, m = bMin.value;
		box.scale.set( s.x, s.y, s.z );
		box.position.set( m.x + s.x / 2, m.y + s.y / 2, m.z + s.z / 2 );

	}

	// ------------------------------------------------------------------
	// Plongée binaire (fond de terre, raymarch du nid, scanner)
	// ------------------------------------------------------------------
	let dive = false;          // caméra DANS le bloc de terre (binaire, sans fondu)
	let scanOn = false;        // hologramme actif = plongée + case UI + colonie
	let prevScanOn = false;    // détection du front (impulsion d'activation)
	let scanFireAge = 1e6;     // âge de l'impulsion d'activation (1e6 = jamais)

	function update( dt ) {

		uDepthMax.value = layout.depthMax || 18;
		uHeadLight.value = gfx.nestLight;
		uAO.value = gfx.nestAO;
		uGhost.value = gfx.nestGhost;
		uScan.value = gfx.nestScan;
		uScanPulse.value = gfx.nestScanPulse;
		uScanColor.value.set( gfx.nestScanColor );

		// PLONGÉE BINAIRE : la caméra franchit la paroi du BLOC de terre (le
		// pavé d'environment.js : |x|,|z| ≤ WORLD/2, −épaisseur ≤ y < 0) →
		// bascule d'un coup, comme une caméra au bout d'une forreuse. AUCUN
		// fondu, aucune transition : le fond de terre et le raymarch du nid
		// remplacent la surface d'un frame à l'autre (main.js masque le décor
		// de surface au même instant). Être sous le niveau du sol MAIS HORS
		// du bloc (à côté de la carte, ou sous son fond) ne déclenche rien.
		const p = camera.position;
		dive = p.y < 0 && p.y >= - gfx.groundThickness
			&& Math.abs( p.x ) <= WORLD * 0.5 && Math.abs( p.z ) <= WORLD * 0.5;
		soilBox.visible = dive;
		box.visible = dive;

		// Le SCANNER n'ajoute QUE l'hologramme, et seulement dans le bloc de
		// terre (armé par l'UI, colonie existante). Rien d'autre ne change.
		scanOn = dive && gfx.scannerView && !! params.colony;
		uScanMode.value = scanOn ? 1 : 0;

		// impulsion d'activation : tirée sur le front montant, âgée côté CPU —
		// le shader n'a qu'à lire uScanFire
		if ( scanOn && ! prevScanOn ) scanFireAge = 0;
		prevScanOn = scanOn;
		if ( scanFireAge < 20 ) scanFireAge += dt;
		uScanFire.value = scanFireAge;

		// la boîte de l'hologramme épouse le VOLUME du nid
		scanBox.visible = scanOn;
		if ( scanOn ) {

			scanBox.scale.copy( vSize.value );
			scanBox.position.set(
				vMin.value.x + vSize.value.x / 2,
				vMin.value.y + vSize.value.y / 2,
				vMin.value.z + vSize.value.z / 2,
			);

		}

		// la boîte du raymarch court jusqu'au bord du terrain, et descend sous
		// le nid : hors du volume baké, sampleSDF renvoie de la terre pleine
		const half = Math.max( WORLD * 0.5, vSize.value.x * 0.5 + 8 );
		const floorY = vMin.value.y - 6;
		bMin.value.set( centerX - half, floorY, centerZ - half );
		bSize.value.set( half * 2, - floorY + 0.05, half * 2 );
		fitBox();

		if ( env.anthill ) {

			// la fourmilière de surface disparaît dès que la caméra entre dans
			// le bloc : on quitte le monde de surface
			env.anthill.visible = ! dive;

		}

	}

	return {
		group, update, box, uScanMode,
		get dive() { return dive; },
		get scanMode() { return scanOn ? 1 : 0; },
	};

}
