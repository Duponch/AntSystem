// BIOME SOUTERRAIN STYLISE.
//
// Sous la surface, la caméra ouvre une cavité visuelle irrégulière dans un
// volume de terre intact. Cette excavation n'altère ni le terrain, ni le nid,
// ni le pathfinding : elle est unionnée au SDF du nid uniquement au rendu.
//
// Une passe raymarchée fournit la couleur et une profondeur réelle :
//   - cinq horizons géologiques ancrés dans le monde ;
//   - relief 3D, agrégats et lumière de matière décentrée ;
//   - continuité exacte avec les tunnels et cavités du nid.
//
// Trois pools instanciés bornés ajoutent mottes, roches et racines. Une tuile
// déterministe est répétée dans le repère monde sans nouvelle allocation et
// sans dépendre du nombre de fourmis. La caméra ne fait que révéler les objets
// que sa coque rencontre ; ils restent masqués dans le vide physique du nid.
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
	select, smoothstep, exp, fract, color, mx_noise_float, fwidth,
} from 'three/tsl';

import { GRID, WORLD, gfx, params } from './config.js';
import { loadUndergroundArtifactGeometries } from './underground-assets.js';
import {
	UNDERGROUND_ARTIFACT_CATALOG,
	UNDERGROUND_VISUAL_BUDGET,
	artifactScale,
	generateUndergroundVisualLayout,
	isEmbeddedInExcavationShell,
	isInsideUndergroundBlock,
	wrapPeriodicCoordinate,
} from './underground-visual.js';

export async function createUnderground( { scene, layout, camera, volume } ) {

	const artifactGeometries = await loadUndergroundArtifactGeometries(
		UNDERGROUND_ARTIFACT_CATALOG,
	);
	const artifactEntries = Object.entries( UNDERGROUND_ARTIFACT_CATALOG );
	const artifactKeys = artifactEntries.map( ( [ key ] ) => key );

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
	const uSoilHumus = uniform( new THREE.Color( gfx.undergroundColorHumus ) );
	const uSoilTopsoil = uniform( new THREE.Color( gfx.undergroundColorTopsoil ) );
	const uSoilClay = uniform( new THREE.Color( gfx.undergroundColorClay ) );
	const uSoilOchre = uniform( new THREE.Color( gfx.undergroundColorOchre ) );
	const uSoilBedrock = uniform( new THREE.Color( gfx.undergroundColorBedrock ) );
	const uSoilChaos = uniform( gfx.undergroundChaos );
	const uSoilPatchSize = uniform( gfx.undergroundPatchSize );
	const uSoilBlend = uniform( gfx.undergroundBlend );
	const uSoilGrain = uniform( gfx.undergroundGrain );
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

		const e = float( 0.50 );
		return vec3(
			sampleSceneSDF( p.add( vec3( 0.50, 0, 0 ) ), radius )
				.sub( sampleSceneSDF( p.sub( vec3( 0.50, 0, 0 ) ), radius ) ),
			sampleSceneSDF( p.add( vec3( 0, 0.50, 0 ) ), radius )
				.sub( sampleSceneSDF( p.sub( vec3( 0, 0.50, 0 ) ), radius ) ),
			sampleSceneSDF( p.add( vec3( 0, 0, 0.50 ) ), radius )
				.sub( sampleSceneSDF( p.sub( vec3( 0, 0, 0.50 ) ), radius ) ),
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

		// La profondeur ne choisit plus une bande. Deux champs 3D ancrés dans le
		// monde la déforment fortement, puis de larges transitions font cohabiter
		// plusieurs familles minérales : aucun plan horizontal n'est perceptible.
		const depth = clamp(
			p.y.negate().div( max( uSoilThickness, 1 ) ), 0, 1,
		).toVar();
		const patchPoint = p.div( max( uSoilPatchSize, 0.25 ) );
		const macro = mx_noise_float( patchPoint ).mul( 0.5 ).add( 0.5 ).toVar();
		const cross = mx_noise_float(
			patchPoint.mul( 1.73 ).add( vec3( 13.7, - 8.1, 5.2 ) ),
		).mul( 0.5 ).add( 0.5 ).toVar();
		const f = clamp(
			depth
				.add( macro.sub( 0.5 ).mul( uSoilChaos ).mul( 0.48 ) )
				.add( cross.sub( 0.5 ).mul( uSoilChaos ).mul( 0.26 ) ),
			0, 1,
		).toVar();
		const blendWidth = max( uSoilBlend, 0.08 );
		const transition = ( center ) => smoothstep(
			float( center ).sub( blendWidth ),
			float( center ).add( blendWidth ),
			f,
		);

		const c = uSoilHumus.toVar();
		c.assign( mix( c, uSoilTopsoil, transition( 0.12 ) ) );
		c.assign( mix( c, uSoilClay, transition( 0.34 ) ) );
		c.assign( mix( c, uSoilOchre, transition( 0.58 ) ) );
		c.assign( mix( c, uSoilBedrock, transition( 0.82 ) ) );

		// Des poches argile/ocre traversent les profondeurs et rompent encore la
		// lecture en strates, sans bruit supplémentaire ni texture.
		const pocket = smoothstep( 0.38, 0.88, abs( macro.sub( cross ) ) )
			.mul( clamp( uSoilChaos.mul( 0.32 ), 0, 0.42 ) )
			.mul( depth.mul( 0.55 ).add( 0.45 ) );
		c.assign( mix( c, mix( uSoilClay, uSoilOchre, cross ), pocket ) );

		// Une seule fréquence fine complète les deux champs macro. Elle s'efface
		// avec la distance pour préserver une image stable et sans moiré.
		const crumb = mx_noise_float( detail.mul( 1.9 ) ).mul( 0.5 ).add( 0.5 );
		const fade = clamp(
			float( 1 ).sub( length( detail.sub( cameraPosition ) ).mul( 0.035 ) ), 0, 1,
		);
		const matter = macro.sub( 0.5 ).mul( 0.22 )
			.add( crumb.sub( 0.5 ).mul( uSoilGrain ).mul( fade ) ).add( 1 );
		const neutral = mix( uSoilHumus, uSoilBedrock, depth ).mul( 0.72 );
		return mix( neutral, c.mul( matter ), uSoilContrast );

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
		const lastVoidT = tEnter.toVar();
		const hasVoid = float( 0 ).toVar();

		If( tEnter.lessThan( tExit ), () => {

			Loop( { start: 0, end: 72, condition: '<' }, () => {

				const p = ro.add( rd.mul( t ) );
				const d = sampleSceneSDF( p, radius ).toVar();

				If( d.greaterThanEqual( 0 ), () => {

					// The minimum march step can cross the final millimetres of
					// wall. Three bisections recover a stable sub-pixel contact,
					// and only run for pixels that actually traversed a cavity.
					If( hasVoid.greaterThan( 0.5 ), () => {

						const tA = lastVoidT.toVar();
						const tB = t.toVar();

						for ( let refinement = 0; refinement < 3; refinement ++ ) {

							const tM = tA.add( tB ).mul( 0.5 );
							const dM = sampleSceneSDF( ro.add( rd.mul( tM ) ), radius );
							If( dM.lessThan( 0 ), () => {

								tA.assign( tM );

							} ).Else( () => {

								tB.assign( tM );

							} );

						}

						t.assign( tB );

					} );
					hit.assign( 1 );
					Break();

				} );

				// dans une cavité : on avance de la distance à sa paroi. Le bruit
				// casse le caractère 1-lipschitzien du champ, d'où le facteur 0,8
				// qui évite de traverser une paroi mince.
				lastVoidT.assign( t );
				hasVoid.assign( 1 );
				t.addAssign( max( d.negate().mul( 0.8 ), 0.035 ) );

				If( t.greaterThan( tExit ), () => {

					Break();

				} );

			} );

		} );

		// A ray almost coaxial with a long tunnel can exhaust the march before a
		// physical wall. Close it with a bounded visual soil cap: this prevents a
		// black background leak and avoids far-depth precision stair-stepping.
		If( hit.lessThan( 0.5 ).and( tEnter.lessThan( tExit ) ), () => {

			const capDistance = max( radius.mul( 2.2 ), 14 );
			t.assign( max(
				tEnter,
				min( tExit.sub( 0.01 ), tEnter.add( capDistance ) ),
			) );
			hit.assign( 1 );

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
		const wallAA = max( fwidth( r.w ).mul( 1.75 ), 0.018 );
		const wallness = smoothstep( wallAA, wallAA.add( 0.55 ), r.w ).toVar();

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
		).mul( uDigRelief ).mul( 1.25 );
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
		const open = ao.div( wsum ).mul( 0.60 ).add( 0.40 );
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
		const shapedLight = smoothstep( 0, 1.45, rawLight ).mul( 1.45 );
		const wallLight = min( mix( rawLight, shapedLight, 0.24 ), 1.45 );
		const faceLight = float( 0.48 );
		const amount = mix( faceLight, wallLight, wallness ).toVar();

		// REBORD. L'indice qui fait basculer la lecture creux/bosse : au bord d'un
		// trou la paroi devient rasante, et une paroi rasante est dans l'ombre.
		// Sans cette ligne les galeries ressortaient en relief.
		const lip = float( 1 ).sub( abs( dot( n, l ) ) );
		const lipShade = mix(
			float( 1 ), float( 0.72 ),
			smoothstep( 0.18, 0.92, lip.mul( wallness ) ),
		).toVar();

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
			.mul( cave.mul( 0.62 ).add( 0.38 ) )
			.mul( mix( float( 1 ), float( 1.55 ), ghost ) );

		// lueur chaude au fond des galeries : elle vient de l'interieur du nid,
		// signale les cavites lointaines au lieu de les noyer dans le noir
		const warm = color( 0xffa055 ).mul( float( 1 ).sub( cave ) ).mul( 0.26 ).mul( occ )
			.mul( wallness )
			.add( color( 0xffb267 ).mul( ghost ).mul( 0.16 ) );

		// LISERE de bouche de galerie : un filet clair la ou la paroi rencontre la
		// tranche. L'oeil accroche le dessin des cavites.
		const rim = smoothstep( 0.30, 0.80, wallness ).mul( smoothstep( 1.1, 0.05, r.w ) );
		const edge = color( 0xf0cb96 ).mul( rim ).mul( 0.08 );

		const cavityFill = base.mul( wallness ).mul( 0.16 );

		return lit.add( warm ).add( edge ).add( cavityFill );

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
	// recyclée autour de la caméra. Chaque copie est fixe dans le repère monde ;
	// la caméra ne fait que révéler celles que sa coque rencontre.
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

	// Le depth test découpe l'excavation caméra ; ce masque supplémentaire
	// découpe le vide réel du nid. Les objets enfouis restent donc attachés à la
	// matière, même lorsqu'une galerie traverse leur volume.
	const matterVisibility = sampleSDFClean( positionWorld ).greaterThanEqual( 0 );
	clodMaterial.maskNode = matterVisibility;
	const rootMaterial = new THREE.MeshLambertMaterial( {
		color: 0xa9602d, flatShading: true, fog: false,
		emissive: 0x30150a, emissiveIntensity: 0.35,
	} );

	const clods = new THREE.InstancedMesh(
		new THREE.IcosahedronGeometry( 1, 0 ), clodMaterial,
		UNDERGROUND_VISUAL_BUDGET.clods,
	);
	const roots = new THREE.InstancedMesh(
		new THREE.CylinderGeometry( 1, 0.72, 1, 5, 1, false ), rootMaterial,
		Math.max( 1, visualLayout.rootCount ),
	);
	const artifactMeshes = {};
	const artifactMaterials = {};
	for ( const [ key, item ] of artifactEntries ) {

		const artifactColor = gfx[ `underground${item.configPrefix}Color` ];
		const material = new THREE.MeshStandardNodeMaterial( {
			color: artifactColor,
			fog: false,
			roughness: 0.72,
			metalness: 0.02,
		} );
		material.maskNode = matterVisibility;
		artifactMaterials[ key ] = material;
		artifactMeshes[ key ] = new THREE.InstancedMesh(
			artifactGeometries[ key ], material, item.capacity,
		);

	}

	for ( const mesh of [ clods, roots, ...artifactKeys.map( ( key ) => artifactMeshes[ key ] ) ] ) {

		mesh.count = 0;
		mesh.frustumCulled = false;
		mesh.renderOrder = - 1;
		mesh.visible = false;
		mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
		group.add( mesh );

	}
	// Même modelé que le décor de surface : un remplissage faible conserve les
	// ombres, tandis qu'une clé oblique révèle les normales et les silhouettes.
	const earthFill = new THREE.AmbientLight( 0xfff5e8, 0.55 );
	const earthKey = new THREE.DirectionalLight( 0xffdfb8, 2.35 );
	earthFill.visible = false;
	earthKey.visible = false;
	group.add( earthFill, earthKey, earthKey.target );

	const decorObject = new THREE.Object3D();
	const decorColor = new THREE.Color();
	const mineralColor = new THREE.Color();
	const soilPaletteCPU = Array.from( { length: 5 }, () => new THREE.Color() );
	const rootFrom = new THREE.Vector3();
	const rootTo = new THREE.Vector3();
	const rootMid = new THREE.Vector3();
	const rootDirection = new THREE.Vector3();
	const rootUp = new THREE.Vector3( 0, 1, 0 );
	const keyLocalOffset = new THREE.Vector3( - 4.5, 5.0, 3.0 );
	const keyWorldOffset = new THREE.Vector3();
	const keyDirection = new THREE.Vector3();
	const lastDecorPosition = new THREE.Vector3( Infinity, Infinity, Infinity );
	const decorStats = {
		clods: 0,
		roots: 0,
		artifacts: Object.fromEntries( artifactKeys.map( ( key ) => [ key, 0 ] ) ),
	};
	const decorSettingKeys = [
		'undergroundColorHumus',
		'undergroundColorTopsoil',
		'undergroundColorClay',
		'undergroundColorOchre',
		'undergroundColorBedrock',
		'undergroundChaos',
		'undergroundPatchSize',
		'undergroundBlend',
		'undergroundGrain',
		'undergroundArtifactExposure',
	];
	for ( const [ , item ] of artifactEntries ) decorSettingKeys.push(
		`underground${item.configPrefix}Frequency`,
		`underground${item.configPrefix}Size`,
		`underground${item.configPrefix}Variation`,
	);
	const lastDecorSettings = new Array( decorSettingKeys.length );
	let lastDecorRadius = - 1;
	let lastDecorThickness = - 1;
	let lastDecorRelief = - 1;

	const clampCPU = ( value, low = 0, high = 1 ) => Math.min( high, Math.max( low, value ) );
	const smoothstepCPU = ( low, high, value ) => {

		const t = clampCPU( ( value - low ) / Math.max( 1e-6, high - low ) );
		return t * t * ( 3 - 2 * t );

	};

	function syncSoilPaletteCPU() {

		for ( const [ index, key ] of [
			'undergroundColorHumus',
			'undergroundColorTopsoil',
			'undergroundColorClay',
			'undergroundColorOchre',
			'undergroundColorBedrock',
		].entries() ) soilPaletteCPU[ index ].set( gfx[ key ] );

	}

	function setClodColor( x, y, z, index, thickness ) {

		const depth = clampCPU( - y / Math.max( 0.001, thickness ) );
		const patchA = Math.sin( x * 0.31 + y * 0.19 + z * 0.43 + Math.sin( z * 0.17 ) );
		const patchB = Math.sin( x * - 0.23 + y * 0.37 + z * 0.27 + 2.7 );
		const f = clampCPU( depth
			+ patchA * gfx.undergroundChaos * 0.24
			+ patchB * gfx.undergroundChaos * 0.13 );
		const width = Math.max( 0.08, gfx.undergroundBlend );
		const transition = ( center ) => smoothstepCPU( center - width, center + width, f );
		decorColor.copy( soilPaletteCPU[ 0 ] );
		decorColor.lerp( soilPaletteCPU[ 1 ], transition( 0.12 ) );
		decorColor.lerp( soilPaletteCPU[ 2 ], transition( 0.34 ) );
		decorColor.lerp( soilPaletteCPU[ 3 ], transition( 0.58 ) );
		decorColor.lerp( soilPaletteCPU[ 4 ], transition( 0.82 ) );
		const pocket = smoothstepCPU( 0.38, 0.88, Math.abs( patchA - patchB ) * 0.5 )
			* clampCPU( gfx.undergroundChaos * 0.32, 0, 0.42 )
			* ( depth * 0.55 + 0.45 );
		mineralColor.copy( soilPaletteCPU[ 2 ] ).lerp(
			soilPaletteCPU[ 3 ], patchB * 0.5 + 0.5 );
		decorColor.lerp( mineralColor, pocket );
		decorColor.offsetHSL(
			( index % 7 - 3 ) * 0.002,
			0,
			( index % 11 - 5 ) * 0.004 * gfx.undergroundGrain,
		);

	}

	function fillClods( cameraPositionCPU, radius ) {

		const data = visualLayout.clods;
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
			const scaleX = data[ offset + 3 ] * 0.08;
			const scaleY = data[ offset + 4 ] * 0.08;
			const scaleZ = data[ offset + 5 ] * 0.08;
			const instanceRadius = Math.max( scaleX, scaleY, scaleZ );
			const distance = Math.hypot(
				x - cameraPositionCPU.x, y - cameraPositionCPU.y, z - cameraPositionCPU.z,
			);
			if ( ! isEmbeddedInExcavationShell(
				distance, radius, gfx.undergroundRelief, instanceRadius, 'clod' ) ) continue;

			decorObject.position.set( x, y, z );
			decorObject.scale.set( scaleX, scaleY, scaleZ );
			decorObject.rotation.set( data[ offset + 6 ], data[ offset + 7 ], data[ offset + 8 ] );
			decorObject.updateMatrix();
			clods.setMatrixAt( count, decorObject.matrix );
			setClodColor( x, y, z, index, thickness );
			clods.setColorAt( count, decorColor );
			count ++;

		}
		clods.count = count;
		clods.instanceMatrix.needsUpdate = true;
		if ( clods.instanceColor ) clods.instanceColor.needsUpdate = true;
		return count;

	}

	function fillArtifactInstances( key, cameraPositionCPU, radius ) {

		const item = UNDERGROUND_ARTIFACT_CATALOG[ key ];
		const mesh = artifactMeshes[ key ];
		const data = visualLayout.artifacts[ key ];
		const prefix = item.configPrefix;
		const frequency = gfx[ `underground${prefix}Frequency` ];
		const size = gfx[ `underground${prefix}Size` ];
		const variation = gfx[ `underground${prefix}Variation` ];
		const geometryRadius = mesh.geometry.boundingSphere?.radius || 0.5;
		const thickness = Math.max( 1, gfx.groundThickness );
		const half = WORLD * 0.5 + 2.2;
		let count = 0;
		for ( let offset = 0; offset < data.length; offset += 8 ) {

			if ( data[ offset + 7 ] > frequency || count >= item.visibleLimit ) break;
			const scale = artifactScale( size, variation, data[ offset + 6 ] );
			if ( scale <= 0 ) continue;
			const instanceRadius = geometryRadius * scale;
			const sourceX = wrapPeriodicCoordinate(
				data[ offset ], cameraPositionCPU.x, visualLayout.tileSpan );
			const sourceY = data[ offset + 1 ];
			const sourceZ = wrapPeriodicCoordinate(
				data[ offset + 2 ], cameraPositionCPU.z, visualLayout.tileSpan );
			if ( Math.abs( sourceX ) > half || Math.abs( sourceZ ) > half ) continue;
			const deltaX = sourceX - cameraPositionCPU.x;
			const deltaY = sourceY - cameraPositionCPU.y;
			const deltaZ = sourceZ - cameraPositionCPU.z;
			const distance = Math.hypot( deltaX, deltaY, deltaZ );
			if ( distance < 1e-5 || ! isEmbeddedInExcavationShell(
				distance, radius, gfx.undergroundRelief, instanceRadius,
				'artifact', gfx.undergroundArtifactExposure,
			) ) continue;
			if ( sourceY + instanceRadius >= - 0.02
				|| sourceY - instanceRadius < - thickness ) continue;

			decorObject.position.set( sourceX, sourceY, sourceZ );
			decorObject.scale.setScalar( scale );
			decorObject.rotation.set( data[ offset + 3 ], data[ offset + 4 ], data[ offset + 5 ] );
			decorObject.updateMatrix();
			mesh.setMatrixAt( count, decorObject.matrix );
			count ++;

		}
		mesh.count = count;
		mesh.instanceMatrix.needsUpdate = true;
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

	function decorSettingsChanged() {

		for ( let index = 0; index < decorSettingKeys.length; index ++ )
			if ( lastDecorSettings[ index ] !== gfx[ decorSettingKeys[ index ] ] ) return true;
		return false;

	}

	function rememberDecorSettings() {

		for ( let index = 0; index < decorSettingKeys.length; index ++ )
			lastDecorSettings[ index ] = gfx[ decorSettingKeys[ index ] ];

	}

	function refreshDecor( radius, force = false ) {

		const moved = lastDecorPosition.distanceToSquared( camera.position ) > 0.0324;
		const radiusChanged = Math.abs( radius - lastDecorRadius ) > 0.055;
		const thicknessChanged = Math.abs( gfx.groundThickness - lastDecorThickness ) > 0.01;
		const reliefChanged = Math.abs( gfx.undergroundRelief - lastDecorRelief ) > 0.01;
		const settingsChanged = decorSettingsChanged();
		if ( ! force && ! moved && ! radiusChanged && ! thicknessChanged
			&& ! reliefChanged && ! settingsChanged ) return;
		if ( thicknessChanged ) visualLayout = generateUndergroundVisualLayout( {
			world: WORLD,
			thickness: Math.max( 0.2, gfx.groundThickness ),
		} );
		lastDecorPosition.copy( camera.position );
		lastDecorRadius = radius;
		lastDecorThickness = gfx.groundThickness;
		lastDecorRelief = gfx.undergroundRelief;
		rememberDecorSettings();
		syncSoilPaletteCPU();
		decorStats.clods = fillClods( camera.position, radius );
		for ( const key of artifactKeys )
			decorStats.artifacts[ key ] = fillArtifactInstances( key, camera.position, radius );
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
		uSoilHumus.value.set( gfx.undergroundColorHumus );
		uSoilTopsoil.value.set( gfx.undergroundColorTopsoil );
		uSoilClay.value.set( gfx.undergroundColorClay );
		uSoilOchre.value.set( gfx.undergroundColorOchre );
		uSoilBedrock.value.set( gfx.undergroundColorBedrock );
		uSoilChaos.value = gfx.undergroundChaos;
		uSoilPatchSize.value = gfx.undergroundPatchSize;
		uSoilBlend.value = gfx.undergroundBlend;
		uSoilGrain.value = gfx.undergroundGrain;
		for ( const [ key, item ] of artifactEntries ) {

			const artifactColor = gfx[ `underground${item.configPrefix}Color` ];
			artifactMaterials[ key ].color.set( artifactColor );

		}
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
		roots.visible = decorVisible;
		for ( const key of artifactKeys ) artifactMeshes[ key ].visible = decorVisible;

		earthFill.visible = decorVisible;
		earthKey.visible = decorVisible;
		if ( dive ) {

			const visualRadius = Math.max( 0.8, gfx.undergroundRadius * digBlend );
			refreshDecor( visualRadius );
			keyWorldOffset.copy( keyLocalOffset ).applyQuaternion( camera.quaternion );
			camera.getWorldDirection( keyDirection );
			earthKey.position.copy( camera.position ).add( keyWorldOffset );
			earthKey.target.position.copy( camera.position ).addScaledVector( keyDirection, 8 );
			earthKey.intensity = 2.35 * Math.max( 0, gfx.nestLight );

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
		decor: { clods, roots, artifacts: artifactMeshes, stats: decorStats },
		get dive() { return dive; },
		get scanMode() { return scanOn ? 1 : 0; },
	};

}
