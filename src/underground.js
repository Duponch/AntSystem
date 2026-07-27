// BIOME SOUTERRAIN STYLISE.
//
// Sous la surface, la caméra ouvre une cavité visuelle irrégulière dans un
// volume de terre intact. Cette excavation n'altère ni le terrain, ni le nid,
// ni le pathfinding : elle est unionnée au SDF du nid uniquement au rendu.
//
// Une passe raymarchée fournit la couleur et une profondeur réelle :
//   - cinq horizons géologiques ancrés dans le monde ;
//   - relief 3D, agrégats et lumière chaude décentrée ;
//   - continuité exacte avec les tunnels et cavités du nid.
//
// Trois pools instanciés bornés ajoutent mottes, roches et racines. Une tuile
// déterministe suit la caméra sans nouvelle allocation et sans dépendre du
// nombre de fourmis. Les objets restent derrière la coque, dont la profondeur
// masque naturellement toute portion qui flotterait dans le vide.
//
// Le décor de surface et son fog sont coupés atomiquement dans main.js. Les
// fourmis de la couche opposée sont masquées dans ants.js.
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
// marche, sans texture ni passe supplémentaire à celle du scanner ; la boîte
// est cachée hors plongée.

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, Discard, uniform, texture3D,
	positionWorld, cameraPosition, cameraNear, cameraFar, cameraViewMatrix,
	viewZToPerspectiveDepth, time,
	vec3, vec4, float, max, min, abs, clamp, mix, dot, length, normalize,
	select, smoothstep, exp, fract, color, mx_noise_float, floor,
} from 'three/tsl';

import { GRID, WORLD, gfx, params } from './config.js';
import {
	UNDERGROUND_VISUAL_BUDGET,
	generateUndergroundVisualLayout,
	isEmbeddedInExcavationShell,
	isInsideUndergroundBlock,
	soilLayerAtDepth,
	wrapPeriodicCoordinate,
} from './underground-visual.js';

export function createUnderground( { scene, layout, camera, volume } ) {

	const group = new THREE.Group();
	scene.add( group );

	const entryX = ( layout.entry.x / GRID - 0.5 ) * WORLD;
	const entryZ = ( layout.entry.y / GRID - 0.5 ) * WORLD;

	// ------------------------------------------------------------------
	const uSurfaceY = uniform( 0 );
	const uHeadLight = uniform( 1 );
	const uAO = uniform( 1 );
	const uGhost = uniform( gfx.nestGhost );
	const uSoilThickness = uniform( Math.max( gfx.groundThickness, layout.depthMax + 4 ) );
	const uDigRadius = uniform( gfx.undergroundRadius );
	const uDigRelief = uniform( gfx.undergroundRelief );
	const uDigBlend = uniform( 1 );
	const uSoilContrast = uniform( gfx.undergroundContrast );
	const uSurfaceCap = uniform( - 0.004 );

	// --- scanner : activation binaire + impulsion (voir en-tête) ---
	const uScan = uniform( gfx.nestScan );         // intensité maître (UI)
	const uScanPulse = uniform( gfx.nestScanPulse );
	const uScanColor = uniform( new THREE.Color( gfx.nestScanColor ) );
	// hologramme actif : 0/1 BINAIRE (plus de fondu — voir en-tête)
	const uScanMode = uniform( 0 );
	// âge (s) de l'impulsion d'activation — compté côté CPU, 1e6 = jamais tirée
	const uScanFire = uniform( 1e6 );

	// constantes du scanner : l'onde part du puits d'entrée du nid
	const SCAN_CENTER = vec3( entryX, 0, entryZ );
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

	// Rayon de l'excavation fictive. Le bruit est évalué une seule fois par
	// rayon : la coque est irrégulière sans ajouter un bruit à chaque pas.
	const excavationRadius = ( direction ) => {

		const relief = mx_noise_float(
			direction.mul( 2.35 ).add( cameraPosition.mul( 0.045 ) ) );
		return max( uDigRadius.mul( uDigBlend )
			.mul( relief.mul( uDigRelief ).mul( 0.035 ).add( 1 ) ), 0.8 );

	};

	// Union du vide réel du nid et de la cavité purement visuelle de caméra.
	// max(sphère, plan) garde un plafond de terre juste sous y=0 ; min(...)
	// ouvre ensuite cette cavité dans le SDF existant sans modifier le nid.
	const sampleSceneSDF = ( p, radius ) => {

		const excavation = max(
			length( p.sub( cameraPosition ) ).sub( radius ),
			p.y.sub( uSurfaceCap ),
		);
		return min( sampleSDF( p ), excavation );

	};

	const gradSceneSDF = ( p, radius ) => {

		const e = float( 0.22 );
		return vec3(
			sampleSceneSDF( p.add( vec3( 0.22, 0, 0 ) ), radius )
				.sub( sampleSceneSDF( p.sub( vec3( 0.22, 0, 0 ) ), radius ) ),
			sampleSceneSDF( p.add( vec3( 0, 0.22, 0 ) ), radius )
				.sub( sampleSceneSDF( p.sub( vec3( 0, 0.22, 0 ) ), radius ) ),
			sampleSceneSDF( p.add( vec3( 0, 0, 0.22 ) ), radius )
				.sub( sampleSceneSDF( p.sub( vec3( 0, 0, 0.22 ) ), radius ) ),
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
	// Terre : cinq horizons pédologiques ancrés dans le monde. Le macro-bruit
	// ondule leurs limites ; le second point permet d'échantillonner séparément
	// les détails 3D quand un matériau réutilise la palette.
	// ------------------------------------------------------------------
	const soilAt = ( p, detail = p ) => {

		// Les limites sont ancrées dans le monde : changer de nid ou tourner la
		// caméra ne déplace jamais la géologie. Un macro-bruit ondule seulement
		// les frontières, il ne remplace pas les cinq horizons lisibles.
		const wave = mx_noise_float( p.mul( 0.09 ) ).mul( 0.018 );
		const f = clamp(
			p.y.negate().div( max( uSoilThickness, 1 ) ).add( wave ), 0, 1,
		).toVar();
		const c = color( 0x3a2114 ).toVar();
		c.assign( mix( c, color( 0x5a3018 ), smoothstep( 0.07, 0.09, f ) ) );
		c.assign( mix( c, color( 0x8a441b ), smoothstep( 0.27, 0.29, f ) ) );
		c.assign( mix( c, color( 0xc2782e ), smoothstep( 0.51, 0.53, f ) ) );
		c.assign( mix( c, color( 0xb9996a ), smoothstep( 0.77, 0.79, f ) ) );

		// Deux fréquences seulement : gros agrégats, puis cassure minérale. Le
		// détail fin s'efface avec la distance afin de ne jamais produire de moiré.
		const aggregate = mx_noise_float( detail.mul( 0.42 ) ).mul( 0.5 ).add( 0.5 );
		const crumb = mx_noise_float( detail.mul( 2.1 ) ).mul( 0.5 ).add( 0.5 );
		const fade = clamp(
			float( 1 ).sub( length( detail.sub( cameraPosition ) ).mul( 0.035 ) ), 0, 1,
		);
		const matter = aggregate.sub( 0.5 ).mul( 0.30 )
			.add( crumb.sub( 0.5 ).mul( 0.14 ).mul( fade ) ).add( 1 );
		const shaded = c.mul( matter );
		return mix( color( 0x68401f ), shaded, uSoilContrast );

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

		const radius = excavationRadius( rd ).toVar();

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
				const d = sampleSceneSDF( p, radius ).toVar();

				If( d.greaterThanEqual( 0 ), () => {

					hit.assign( 1 );
					Break();

				} );

				// dans une cavité : on avance de la distance à sa paroi. Le bruit
				// casse le caractère 1-lipschitzien du champ, d'où le facteur 0,8
				// qui évite de traverser une paroi mince.
				t.addAssign( max( d.negate().mul( 0.8 ), 0.035 ) );

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
	material.fog = false;

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

		const rd = normalize( positionWorld.sub( cameraPosition ) );
		const radius = excavationRadius( rd );
		const g = gradSceneSDF( p, radius ).toVar();
		const gl = length( g ).toVar();
		const geometricNormal = normalize( mix(
			rd.negate(), g.negate().div( max( gl, 1e-4 ) ), wallness,
		) );
		// Le relief n'est pas une texture plaquée : un gradient 3D casse la
		// normale de la coque et fait lire de véritables mottes éclairées.
		const q = p.mul( 0.82 );
		const bump0 = mx_noise_float( q );
		const bump = vec3(
			mx_noise_float( q.add( vec3( 0.19, 0, 0 ) ) ).sub( bump0 ),
			mx_noise_float( q.add( vec3( 0, 0.19, 0 ) ) ).sub( bump0 ),
			mx_noise_float( q.add( vec3( 0, 0, 0.19 ) ) ).sub( bump0 ),
		).mul( uDigRelief ).mul( 1.7 );
		const n = normalize( geometricNormal.add( bump ) ).toVar();

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
			ao.addAssign( clamp( sampleSceneSDF( p.add( n.mul( h ) ), radius ).negate().div( h ), 0, 1 ).mul( w ) );
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
		// Une lampe légèrement décentrée révèle les volumes ; une lampe placée
		// exactement dans l'objectif rendrait une coque sphérique uniformément plate.
		const toLamp = cameraPosition.add( vec3( 2.8, 3.4, 1.8 ) ).sub( p );
		const lampDistance = length( toLamp ).toVar();
		const l = toLamp.div( max( lampDistance, 1e-4 ) );
		const lambert = clamp( dot( n, l ), 0, 1 );
		const falloff = clamp(
			float( 1 ).sub( lampDistance.div( uDigRadius.mul( 2.8 ).add( 16 ) ) ), 0.12, 1,
		);
		const rawLight = lambert.mul( uHeadLight ).mul( falloff ).mul( 1.65 ).add( 0.46 );
		const celLight = floor( clamp( rawLight, 0, 2.4 ).mul( 5 ) ).div( 5 );
		const wallLight = mix( rawLight, celLight, 0.42 );
		const faceLight = float( 0.48 );
		const amount = mix( faceLight, wallLight, wallness ).toVar();

		// REBORD. L'indice qui fait basculer la lecture creux/bosse : au bord d'un
		// trou la paroi devient rasante, et une paroi rasante est dans l'ombre.
		// Sans cette ligne les galeries ressortaient en relief.
		const lip = float( 1 ).sub( abs( dot( n, l ) ) );
		const lipShade = mix( float( 1 ), float( 0.26 ), lip.mul( wallness ) ).toVar();

		// perte de lumiere avec la profondeur de galerie, mais douce : trop fort,
		// les chambres du fond disparaissaient au lieu de se lire en enfilade
		const cave = exp( max( r.w.sub( radius ), 0 ).mul( - 0.13 ) ).toVar();

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
	// Matière 3D bornée. Les positions X/Z sont une tuile monde de 26 unités
	// recyclée autour de la caméra. Les centres restent dans une fine bande
	// DERRIÈRE la coque ; son depthNode découpe donc naturellement chaque objet
	// et aucun caillou ne peut flotter au milieu du vide excavé.
	// ------------------------------------------------------------------
	let visualLayout = generateUndergroundVisualLayout( {
		world: WORLD,
		thickness: Math.max( gfx.groundThickness, layout.depthMax + 4 ),
	} );
	const clodMaterial = new THREE.MeshLambertNodeMaterial( {
		color: 0xffffff, vertexColors: true, flatShading: true, fog: false,
	} );
	clodMaterial.emissive.set( 0x120704 );
	clodMaterial.emissiveIntensity = 0.32;
	const rockMaterial = new THREE.MeshLambertNodeMaterial( {
		color: 0xffffff, vertexColors: true, flatShading: true, fog: false,
		emissive: 0x241d17, emissiveIntensity: 0.35,
	} );
	// Le depth test découpe l'excavation caméra ; ce masque supplémentaire
	// découpe le vide réel du nid. Une motte ou une roche à l'intersection d'une
	// galerie ne peut donc jamais devenir un objet flottant.
	const matterVisibility = sampleSDFClean( positionWorld ).greaterThanEqual( 0 );
	clodMaterial.maskNode = matterVisibility;
	rockMaterial.maskNode = matterVisibility;
	const rootMaterial = new THREE.MeshLambertMaterial( {
		color: 0xa9602d, flatShading: true, fog: false,
		emissive: 0x30150a, emissiveIntensity: 0.35,
	} );

	const clods = new THREE.InstancedMesh(
		new THREE.IcosahedronGeometry( 1, 0 ), clodMaterial,
		UNDERGROUND_VISUAL_BUDGET.clods,
	);
	const rocks = new THREE.InstancedMesh(
		new THREE.IcosahedronGeometry( 1, 0 ), rockMaterial,
		UNDERGROUND_VISUAL_BUDGET.rocks,
	);
	const roots = new THREE.InstancedMesh(
		new THREE.CylinderGeometry( 1, 0.72, 1, 5, 1, false ), rootMaterial,
		Math.max( 1, visualLayout.rootCount ),
	);
	for ( const mesh of [ clods, rocks, roots ] ) {

		mesh.count = 0;
		mesh.frustumCulled = false;
		mesh.renderOrder = - 1;
		mesh.visible = false;
		mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
		group.add( mesh );

	}

	const dustPositions = new Float32Array( UNDERGROUND_VISUAL_BUDGET.dust * 3 );
	for ( let i = 0; i < UNDERGROUND_VISUAL_BUDGET.dust; i ++ ) {

		dustPositions[ i * 3 ] = visualLayout.dust[ i * 4 ];
		dustPositions[ i * 3 + 1 ] = visualLayout.dust[ i * 4 + 1 ];
		dustPositions[ i * 3 + 2 ] = visualLayout.dust[ i * 4 + 2 ];

	}
	const dustGeometry = new THREE.BufferGeometry();
	dustGeometry.setAttribute( 'position', new THREE.BufferAttribute( dustPositions, 3 ) );
	const dustMaterial = new THREE.PointsMaterial( {
		color: 0xffc37a,
		size: 0.065,
		sizeAttenuation: true,
		transparent: true,
		opacity: gfx.undergroundDust * 0.42,
		depthWrite: false,
		fog: false,
		blending: THREE.AdditiveBlending,
	} );
	const dust = new THREE.Points( dustGeometry, dustMaterial );
	dust.frustumCulled = false;
	dust.renderOrder = 1;
	dust.visible = false;
	group.add( dust );

	// Éclairage chaud autonome : les lumières de surface sont coupées par main.js.
	const earthAmbient = new THREE.AmbientLight( 0xffbd85, 1.35 );
	const earthLamp = new THREE.PointLight( 0xffd0a0, 36, 30, 2 );
	earthAmbient.visible = false;
	earthLamp.visible = false;
	group.add( earthAmbient, earthLamp );

	const decorObject = new THREE.Object3D();
	const decorColor = new THREE.Color();
	const rootFrom = new THREE.Vector3();
	const rootTo = new THREE.Vector3();
	const rootMid = new THREE.Vector3();
	const rootDirection = new THREE.Vector3();
	const rootUp = new THREE.Vector3( 0, 1, 0 );
	const lampOffset = new THREE.Vector3( 2.8, 3.4, 1.8 );
	const lastDecorPosition = new THREE.Vector3( Infinity, Infinity, Infinity );
	const rockPalette = [ 0x796f63, 0x8f806b, 0xaa875d, 0x806b58 ];
	const decorStats = { clods: 0, rocks: 0, roots: 0 };
	let lastDecorRadius = - 1;
	let lastDecorThickness = - 1;
	let lastDecorRelief = - 1;

	function fillPeriodicInstances( mesh, data, cameraPositionCPU, radius, type ) {

		const thickness = Math.max( 1, gfx.groundThickness );
		const half = WORLD * 0.5 + 2.2;
		let count = 0;
		for ( let offset = 0, index = 0; offset < data.length; offset += 9, index ++ ) {

			const x = wrapPeriodicCoordinate(
				data[ offset ], cameraPositionCPU.x, visualLayout.tileSpan );
			const y = data[ offset + 1 ];
			const z = wrapPeriodicCoordinate(
				data[ offset + 2 ], cameraPositionCPU.z, visualLayout.tileSpan );
			if ( Math.abs( x ) > half || Math.abs( z ) > half || y >= 0 || y < - thickness ) continue;
			const distance = Math.hypot(
				x - cameraPositionCPU.x, y - cameraPositionCPU.y, z - cameraPositionCPU.z,
			);
			const visualScale = type === 'clod' ? 0.08 : 1.0;
			const scaleX = data[ offset + 3 ] * visualScale;
			const scaleY = data[ offset + 4 ] * visualScale;
			const scaleZ = data[ offset + 5 ] * visualScale;
			const instanceRadius = Math.max( scaleX, scaleY, scaleZ );
			// Seule une calotte traverse la coque. Le prédicat partagé avec les
			// tests garantit exactement les mêmes bandes d'ancrage en production.
			if ( ! isEmbeddedInExcavationShell(
				distance, radius, gfx.undergroundRelief, instanceRadius, type ) ) continue;

			decorObject.position.set( x, y, z );
			decorObject.scale.set( scaleX, scaleY, scaleZ );
			decorObject.rotation.set( data[ offset + 6 ], data[ offset + 7 ], data[ offset + 8 ] );
			decorObject.updateMatrix();
			mesh.setMatrixAt( count, decorObject.matrix );
			if ( type === 'clod' ) {

				decorColor.setHex( soilLayerAtDepth( - y, thickness ).color );
				decorColor.offsetHSL( ( index % 7 - 3 ) * 0.002, 0, ( index % 11 - 5 ) * 0.008 );

			} else {

				decorColor.setHex( rockPalette[ index % rockPalette.length ] );

			}
			mesh.setColorAt( count, decorColor );
			count ++;

		}
		mesh.count = count;
		mesh.instanceMatrix.needsUpdate = true;
		if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;
		return count;

	}

	function fillRoots( cameraPositionCPU, radius ) {

		const data = visualLayout.roots;
		let count = 0;
		// Une plante est une unité atomique de neuf segments : le même décalage
		// périodique et le même verdict de visibilité s'appliquent à tout le groupe.
		for ( let plantOffset = 0; plantOffset < data.length; plantOffset += 9 * 7 ) {

			const baseAnchorX = data[ plantOffset ];
			const baseAnchorZ = data[ plantOffset + 2 ];
			const shiftX = wrapPeriodicCoordinate(
				baseAnchorX, cameraPositionCPU.x, visualLayout.tileSpan ) - baseAnchorX;
			const shiftZ = wrapPeriodicCoordinate(
				baseAnchorZ, cameraPositionCPU.z, visualLayout.tileSpan ) - baseAnchorZ;
			const anchorX = baseAnchorX + shiftX;
			const anchorZ = baseAnchorZ + shiftZ;
			const anchorDistance = Math.hypot(
				anchorX - cameraPositionCPU.x, anchorZ - cameraPositionCPU.z );
			const hangsFromCeiling = cameraPositionCPU.y + radius > - 0.35
				&& anchorDistance >= 2.5 && anchorDistance < radius * 0.82;
			if ( ! hangsFromCeiling ) continue;

			for ( let segment = 0; segment < 9; segment ++ ) {

				const offset = plantOffset + segment * 7;
				rootFrom.set(
					data[ offset ] + shiftX, data[ offset + 1 ], data[ offset + 2 ] + shiftZ );
				rootTo.set(
					data[ offset + 3 ] + shiftX, data[ offset + 4 ], data[ offset + 5 ] + shiftZ );
				rootMid.addVectors( rootFrom, rootTo ).multiplyScalar( 0.5 );
				rootDirection.subVectors( rootTo, rootFrom );
				const segmentLength = rootDirection.length();
				if ( segmentLength < 1e-4 ) continue;
				decorObject.position.copy( rootMid );
				decorObject.quaternion.setFromUnitVectors( rootUp, rootDirection.normalize() );
				const rootRadius = data[ offset + 6 ];
				decorObject.scale.set( rootRadius * 0.72, segmentLength, rootRadius * 0.72 );
				decorObject.updateMatrix();
				roots.setMatrixAt( count, decorObject.matrix );
				count ++;

			}

		}
		roots.count = count;
		roots.instanceMatrix.needsUpdate = true;
		return count;

	}
	function refreshDecor( radius, force = false ) {

		const moved = lastDecorPosition.distanceToSquared( camera.position ) > 0.0324;
		const radiusChanged = Math.abs( radius - lastDecorRadius ) > 0.055;
		const thicknessChanged = Math.abs( gfx.groundThickness - lastDecorThickness ) > 0.01;
		const reliefChanged = Math.abs( gfx.undergroundRelief - lastDecorRelief ) > 0.01;
		if ( ! force && ! moved && ! radiusChanged && ! thicknessChanged && ! reliefChanged ) return;
		if ( thicknessChanged ) visualLayout = generateUndergroundVisualLayout( {
			world: WORLD,
			thickness: Math.max( 0.2, gfx.groundThickness ),
		} );
		lastDecorPosition.copy( camera.position );
		lastDecorRadius = radius;
		lastDecorThickness = gfx.groundThickness;
		lastDecorRelief = gfx.undergroundRelief;
		decorStats.clods = fillPeriodicInstances(
			clods, visualLayout.clods, camera.position, radius, 'clod' );
		decorStats.rocks = fillPeriodicInstances(
			rocks, visualLayout.rocks, camera.position, radius, 'rock' );
		decorStats.roots = fillRoots( camera.position, radius );

	}

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
	// Plongée : masques binaires, ouverture visuelle amortie, scanner optionnel
	// ------------------------------------------------------------------
	let dive = false;          // caméra DANS le bloc de terre (binaire, sans fondu)
	let scanOn = false;        // hologramme actif = plongée + case UI + colonie
	let prevScanOn = false;    // détection du front (impulsion d'activation)
	let scanFireAge = 1e6;
	let digBlend = 0;          // ouverture amortie de la cavité visuelle

	function update( dt ) {

		uHeadLight.value = gfx.nestLight;
		uAO.value = gfx.nestAO;
		uGhost.value = gfx.nestGhost;
		uSoilThickness.value = Math.max( 1, gfx.groundThickness );
		uDigRadius.value = gfx.undergroundRadius;
		uDigRelief.value = gfx.undergroundRelief;
		uSoilContrast.value = gfx.undergroundContrast;
		uScan.value = gfx.nestScan;
		uScanPulse.value = gfx.nestScanPulse;
		uScanColor.value.set( gfx.nestScanColor );

		// Le franchissement du bloc physique est binaire : surface, fog et couche
		// de fourmis basculent ensemble. Seul le rayon de l'excavation s'ouvre
		// pendant quelques dixièmes de seconde pour suggérer la caméra-forreuse.
		// Être sous y=0 mais hors des limites du terrain ne déclenche rien.
		const p = camera.position;
		const nextDive = isInsideUndergroundBlock( p, WORLD, gfx.groundThickness );
		if ( nextDive && ! dive ) digBlend = 0.42;
		if ( ! nextDive ) digBlend = 0;
		dive = nextDive;
		if ( dive ) digBlend = Math.min( 1, digBlend + dt * 1.9 );
		uDigBlend.value = digBlend;
		box.visible = dive;
		const decorVisible = dive;
		clods.visible = decorVisible;
		rocks.visible = decorVisible;
		roots.visible = decorVisible;
		dust.visible = decorVisible && gfx.undergroundDust > 0.001;
		earthAmbient.visible = decorVisible;
		earthLamp.visible = decorVisible;
		if ( dive ) {

			const visualRadius = Math.max( 0.8, gfx.undergroundRadius * digBlend );
			refreshDecor( visualRadius );
			dust.position.copy( camera.position );
			dust.scale.setScalar( visualRadius * 0.82 );
			dust.rotation.y += dt * 0.045;
			dust.rotation.x += dt * 0.012;
			dustMaterial.opacity = gfx.undergroundDust * 0.42;
			earthLamp.position.copy( camera.position ).add( lampOffset );
			earthLamp.intensity = 36 * Math.max( 0, gfx.nestLight );

		}

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
		// Le biome visuel couvre le bloc physique entier et ne dépend jamais des
		// dimensions du nid : on peut explorer de la terre vierge partout.
		const margin = Math.max( 12, gfx.undergroundRadius * 1.5 + 3 );
		const floorY = - Math.max( 1, gfx.groundThickness ) - margin;
		bMin.value.set( - WORLD * 0.5 - margin, floorY, - WORLD * 0.5 - margin );
		bSize.value.set( WORLD + margin * 2, - floorY + 0.08, WORLD + margin * 2 );
		fitBox();

	}

	return {
		group, update, box, uScanMode,
		decor: { clods, rocks, roots, dust, stats: decorStats },
		get dive() { return dive; },
		get scanMode() { return scanOn ? 1 : 0; },
	};

}
