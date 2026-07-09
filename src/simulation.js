// Simulation de fourmis 100 % GPU (TSL / WebGPU).
//
// Modèle : double carte de phéromones (Sebastian Lague) + dépôt qui s'affaiblit
// avec le temps écoulé depuis la dernière source (Pezzza's Work), ce qui fait
// émerger les chemins courts.
//
//   état 0 (exploratrice) : lit la carte « nourriture », écrit la carte « maison »
//   état 1 (porteuse)     : lit la carte « maison »,     écrit la carte « nourriture »
//
// Les dépôts passent par un buffer u32 atomique (accumulation sans perte entre
// milliers de fourmis), injecté chaque frame dans une paire de textures
// rgba16float en ping-pong (évaporation + diffusion), qui sert aussi à
// l'affichage : R = maison, G = nourriture, B = nourriture au sol, A = mur.
//
// COLONIE (params.colony) : castes dérivées d'un hash stable (reine = index 0,
// nourrices, soldates, éclaireuses, ouvrières), énergie individuelle (famine),
// monde SOUTERRAIN (bit 3 d'antState) : les porteuses descendent déposer leur
// bille au grenier, les nourrices font la navette grenier → reine/couvain, la
// reine mange et pond (stats[4]), le couvain vit dans un kernel séparé
// (colony.js). La topologie souterraine vient de buildNestLayout (colony.js).
//
// LIMITE CRITIQUE : 16 storage buffers max par étage (demandés dans main.js).
// Le kernel fourmis en lie 12 — toute donnée nouvelle par fourmi passe par le
// REPACKING (bits d'antState, canaux d'antVital), jamais par un buffer neuf.

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, uniformArray, instancedArray, instanceIndex,
	float, int, uint, vec2, vec3, vec4, ivec2, uvec2,
	exp, cos, sin, sqrt, floor, ceil, max, min, clamp, mix, length, select,
	atomicAdd, atomicSub, atomicLoad, atomicStore, atomicMax,
	textureLoad, textureStore, hash, frameId, PI, PI2,
} from 'three/tsl';

import { GRID, WORLD, MAX_ANTS, MAX_SPIDERS, FIXED, NEST, params, gfx } from './config.js';
import { tryAcquireReadback, releaseReadback } from './readback.js';

// gisements de départ (partagés avec la caméra cinématique)
// (1 bille = 1 unité : zones élargies pour offrir ~15-25 billes chacune)
export const SEED_BLOBS = [
	{ angle: 0.5, dist: 250, radius: 9 },
	{ angle: 2.0, dist: 320, radius: 12 },
	{ angle: 2.6, dist: 200, radius: 8 },
	{ angle: 3.7, dist: 270, radius: 8 },
	{ angle: 4.4, dist: 300, radius: 10 },
	{ angle: 5.1, dist: 360, radius: 11 },
];

export class AntSimulation {

	// layout : topologie de la fourmilière souterraine (buildNestLayout de
	// colony.js) — chambres, mangeoires, graphe de navigation, carte de
	// profondeur/praticabilité échantillonnée par le kernel de creusage.
	constructor( renderer, layout ) {

		this.renderer = renderer;
		this.layout = layout;

		// --- uniforms pilotés par l'UI ---
		const u = this.u = {
			dt: uniform( 0 ),
			antCount: uniform( params.antCount ),
			moveSpeed: uniform( params.moveSpeed ),
			steer: uniform( params.steerStrength ),
			wander: uniform( params.wanderStrength ),
			sensorAngle: uniform( params.sensorAngleDeg * Math.PI / 180 ),
			sensorDist: uniform( params.sensorDist ),
			depositRate: uniform( params.depositRate ),
			fade: uniform( params.fade ),
			evap: uniform( params.evaporation ),
			diffuse: uniform( params.diffusion ),
			nest: uniform( new THREE.Vector2( NEST.x, NEST.y ) ),
			nestRadius: uniform( NEST.radius ),
			reinitFrom: uniform( 0 ),    // ré-initialisation partielle des fourmis (slider)
			stampCount: uniform( 0 ),    // nombre de coups de pinceau de la frame
			obstacleCount: uniform( 0 ),
			ballSpacing: uniform( gfx.foodBallSpacing ),  // texels entre billes de nourriture
			haloSpread: uniform( gfx.haloSpread ),        // portée du halo lumineux
			seed: uniform( 0 ),                           // graine de run (banc d'essai)
			spiderCount: uniform( 0 ),                    // prédateurs actifs
			fleeRadius: uniform( params.fleeRadius ),     // rayon de panique (texels)
			soldierRatio: uniform( params.soldierRatio ), // part de soldates dans la colonie
			alarmDecay: uniform( 0.35 ),                  // évanouissement de l'alarme (/s)
			// prédation : envenimation graduée
			bitesToKill: uniform( params.bitesToKill ),        // morsures cumulées → mort
			biteInterval: uniform( params.biteInterval ),      // s entre deux morsures
			paralysisFactor: uniform( params.paralysisFactor ), // vitesse après 1 morsure
			venomRecovery: uniform( params.venomRecovery ),    // dissipation du venin /s
			antHitR: uniform( params.antRadius * GRID / WORLD ), // rayon hitbox fourmi (texels)
			maxAntCorpses: uniform( gfx.maxAntCorpses ),        // cadavres de fourmis gardés (cap perf)

			// --- colonie : castes, énergie, reine, souterrain ---
			colonyOn: uniform( params.colony ? 1 : 0 ),  // 0 = comportement historique
			nurseRatio: uniform( params.nurseRatio ),
			scoutRatio: uniform( params.scoutRatio ),
			scoutWander: uniform( params.scoutWander ),
			scoutTrail: uniform( params.scoutTrailFollow ),
			scoutSpeed: uniform( params.scoutSpeedMult ),
			soldierSpeed: uniform( params.soldierSpeedMult ),
			energyLife: uniform( params.energyLife ),
			eatThreshold: uniform( params.eatThreshold ),
			hungryHome: uniform( params.hungryHome ),
			queenEnergyLife: uniform( params.queenEnergyLife ),
			queenMealValue: uniform( params.queenMealValue ),
			queenLayInterval: uniform( params.queenLayInterval ),
			queenLayCost: uniform( params.queenLayCost ),
			queenLayMin: uniform( params.queenLayMin ),
			granaryStart: uniform( params.granaryStart ),
			spawnMode: uniform( 0 ),                     // kInitAnts : 0 = disque du nid, 1 = éclosion (couvain, sous terre)
			entranceR: uniform( 3 ),                     // rayon d'arrivée au nœud d'entrée (texels)
		};

		// --- topologie souterraine (uniforms remplis depuis le layout) ---
		// nœuds du graphe : (x, y texels, rayon d'arrivée, 0)
		this._nodeVecs = layout.nodes.map( ( n ) => new THREE.Vector4( n.x, n.y, n.r, 0 ) );
		u.nodes = uniformArray( this._nodeVecs );
		u.nodeCount = uniform( layout.nodes.length );
		// next-hop aplati : [nœud × 8 + objectif] → indice du nœud suivant
		u.nextHop = uniformArray( Array.from( layout.nextHop ) );
		// objectif → nœud terminal (0 aucun, 1 grenier, 2 reine, 3 couvain, 4 sortie)
		const goals = layout.GOAL_NODE.slice();
		while ( goals.length < 8 ) goals.push( - 1 );
		u.goalNode = uniformArray( goals );
		// chambres / mangeoires
		u.granaryPos = uniform( new THREE.Vector2( layout.troughs.granary.x, layout.troughs.granary.y ) );
		u.queenPos = uniform( new THREE.Vector2( layout.troughs.queen.x, layout.troughs.queen.y ) );
		u.broodPos = uniform( new THREE.Vector2( layout.troughs.brood.x, layout.troughs.brood.y ) );
		u.queenR = uniform( layout.chambers.queen.R );
		u.broodR = uniform( layout.chambers.brood1.R );
		u.granaryR = uniform( layout.chambers.granary.R );
		u.troughGranary = uniform( layout.troughs.granary.cell );
		u.troughQueen = uniform( layout.troughs.queen.cell );
		u.troughBrood = uniform( layout.troughs.brood.cell );
		u.broodNode = uniform( layout.GOAL_NODE[ 3 ] );   // nœud du couvain (spawn)

		// menace par SECTEURS (grille 8×8, 2 araignées les plus proches par secteur) :
		// coût constant côté fourmis quel que soit le nombre de prédateurs.
		// A = (x, y grille, frappe 0/1, rayon de mort texels ; w=0 → slot vide)
		// B = (id araignée, dist² au centre du secteur, 0, 0)
		this._sectorA = Array.from( { length: 128 }, () => new THREE.Vector4() );
		this._sectorB = Array.from( { length: 128 }, () => new THREE.Vector4() );
		u.sectorA = uniformArray( this._sectorA );
		u.sectorB = uniformArray( this._sectorB );

		// morsures des soldates, cumulées par araignée (relu par le CPU ~2×/s)
		this.spiderDamage = instancedArray( MAX_SPIDERS, 'uint' ).toAtomic();
		// pression d'alarme ressentie par CHAQUE araignée (fourmis paniquées autour) :
		// fait fuir le prédateur ; et proies tuées par CHAQUE araignée (→ passe à la
		// dévoration). Cumulés, relus par delta côté CPU comme spiderDamage.
		this.spiderAlarm = instancedArray( MAX_SPIDERS, 'uint' ).toAtomic();
		this.spiderKills = instancedArray( MAX_SPIDERS, 'uint' ).toAtomic();
		// position (grille) de la dernière proie tuée par CHAQUE araignée → le
		// prédateur va s'y placer pour dévorer le cadavre (dernier écrivain gagne)
		this.spiderKillPos = instancedArray( MAX_SPIDERS, 'vec2' );

		// obstacles du décor (bûches, souches, troncs…) rasterisés dans la grille de murs
		// A = (cx, cy, demi-longueur, demi-largeur) en texels ; B = (axe.x, axe.y, type, 0)
		this._obstacleA = Array.from( { length: 64 }, () => new THREE.Vector4() );
		this._obstacleB = Array.from( { length: 64 }, () => new THREE.Vector4() );
		u.obstacleA = uniformArray( this._obstacleA );
		u.obstacleB = uniformArray( this._obstacleB );
		this._obstacles = null;

		// coups de pinceau de la frame : (x, y, rayon, mode 0/1/2) + quantité de nourriture
		this._stampVecs = Array.from( { length: 16 }, () => new THREE.Vector4() );
		this._stampFood = new Array( 16 ).fill( 0 );
		u.stamps = uniformArray( this._stampVecs );
		u.stampFood = uniformArray( this._stampFood );

		// --- état GPU ---
		// fourmis : x, y (grille), angle, temps depuis la dernière source
		// (pour la reine, w = chrono de ponte)
		this.antData = instancedArray( MAX_ANTS, 'vec4' );
		// antState PACKÉ en bits (jamais d'assign littéral — toujours re-packer) :
		//   bits 0-2 = état (0 exploratrice, 1 porteuse, 2 cadavre, 3 dévorée)
		//   bit  3   = souterraine (INVARIANT : toujours 0 en surface, les
		//              araignées filtrent sur la valeur brute — voir spiders.js)
		//   bits 4-6 = objectif souterrain (0 aucun, 1 grenier, 2 reine,
		//              3 couvain, 4 sortie)
		//   bits 7-10 = nœud courant du graphe (la navigation suit les arêtes :
		//              « nœud le plus proche » est AMBIGU entre deux tunnels
		//              voisins et coinçait les fourmis contre la terre)
		this.antState = instancedArray( MAX_ANTS, 'uint' );
		// signes vitaux (mono-écrivain : chaque fourmi possède son élément) :
		//   x = venin (0 = saine ; ≥ bitesToKill = morte)
		//   y = horloge de morsure (vivante) / n° de série du cadavre (morte)
		//   z = énergie 0..1 (0 = mort de faim)
		//   w = libre
		this.antVital = instancedArray( MAX_ANTS, 'vec4' );

		this.deposit = instancedArray( GRID * GRID * 2, 'uint' ).toAtomic(); // accumulateur virgule fixe
		this.alarm = instancedArray( GRID * GRID, 'uint' ).toAtomic();       // phéromone d'alarme
		this.food = instancedArray( GRID * GRID, 'uint' ).toAtomic();        // unités de nourriture
		// murs PACKÉS : bit 0 = mur de surface, bit 1 = cellule souterraine creusée
		this.wall = instancedArray( GRID * GRID, 'uint' );
		// [0] livrées, [1] ramassées, [2] tuées (série des cadavres), [3] dévorées,
		// [4] œufs pondus, [5] éclosions, [6] stock du grenier (instantané),
		// [7] énergie de la reine ×1000 (instantané, mono-écrivain)
		this.stats = instancedArray( 8, 'uint' ).toAtomic();

		// --- textures ping-pong du champ de phéromones ---
		this.textures = [ 0, 1 ].map( () => {

			const t = new THREE.StorageTexture( GRID, GRID );
			t.format = THREE.RGBAFormat;
			t.type = THREE.HalfFloatType;         // rgba16float : storage + filtrage linéaire
			t.minFilter = THREE.LinearFilter;
			t.magFilter = THREE.LinearFilter;
			t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
			t.generateMipmaps = false;
			return t;

		} );
		this.cur = 0;

		this._buildKernels();

		this._brushQueue = [];
		this._regenAccum = 0;
		this.statsData = { delivered: 0, picked: 0, eaten: 0, devoured: 0, laid: 0, hatched: 0, granary: 0, queenEnergy: 1 };

		// nœuds TSL texture(...) qui affichent le champ (sol, herbe…) :
		// leur .value doit suivre le ping-pong à chaque étape
		this.fieldNodes = [];

	}

	get currentTexture() {

		return this.textures[ this.cur ];

	}

	updateFieldNodes() {

		for ( const n of this.fieldNodes ) n.value = this.currentTexture;

	}

	_buildKernels() {

		const u = this.u;
		const { antData, antState, antVital, deposit, alarm, food, wall, stats, spiderDamage, spiderAlarm, spiderKills, spiderKillPos } = this;
		const layout = this.layout;

		const cellIndex = ( c ) => c.y.mul( GRID ).add( c.x );

		// --- murs packés en bits : bit 0 = mur de SURFACE, bit 1 = creusé ---
		const surfaceWall = ( w ) => w.bitAnd( uint( 1 ) ).notEqual( uint( 0 ) );
		const dug = ( w ) => w.bitAnd( uint( 2 ) ).notEqual( uint( 0 ) );

		// --- caste par hashs INDÉPENDANTS (stables par fourmi, zéro stockage,
		// même formule côté rendu — voir ants.js via this.casteOf) : bouger un
		// ratio ne re-mélange pas les autres castes. Colonie coupée : seule la
		// part de soldates subsiste, formule et graine historiques exactes. ---
		const casteOf = ( antId ) => {

			const colony = u.colonyOn.greaterThan( 0.5 );
			const isQueen = colony.and( antId.equal( uint( 0 ) ) );
			const isNurse = colony.and( isQueen.not() )
				.and( hash( antId.add( uint( 0x14BB5E ) ) ).lessThan( u.nurseRatio ) );
			const isSoldier = isQueen.not().and( isNurse.not() )
				.and( hash( antId.add( uint( 0xCA57E ) ) ).lessThan( u.soldierRatio ) );
			const isScout = colony.and( isQueen.not() ).and( isNurse.not() ).and( isSoldier.not() )
				.and( hash( antId.add( uint( 0x5C0F7 ) ) ).lessThan( u.scoutRatio ) );

			return { isQueen, isNurse, isSoldier, isScout };

		};

		// partagé avec le rendu (ants.js) : mêmes hashs, mêmes uniforms
		this.casteOf = casteOf;

		// prend UNE unité de nourriture dans une cellule, avec restitution si la
		// course est perdue (le compteur u32 wrappe) — onOk : callback TSL succès
		const takeOne = ( cellNode, onOk ) => {

			const prev = atomicSub( food.element( cellNode ), uint( 1 ) ).toVar();

			If( prev.equal( uint( 0 ) ).or( prev.greaterThanEqual( uint( 0x80000000 ) ) ), () => {

				atomicAdd( food.element( cellNode ), uint( 1 ) );

			} ).Else( onOk );

		};

		// ------------------------------------------------------------------
		// Initialisation des fourmis. spawnMode 0 : reine en chambre royale,
		// nourrices au couvain (sous terre), le reste en disque autour du nid.
		// spawnMode 1 (éclosion) : naissance au couvain, sous terre, objectif
		// sortie (les nourrices restent). Énergie initiale RANDOMISÉE pour
		// désynchroniser la première vague de repas (sinon famine synchrone).
		// ------------------------------------------------------------------
		this.kInitAnts = Fn( () => {

			// reinitFrom > 0 : seules les fourmis nouvellement activées repartent du nid
			If( instanceIndex.toFloat().greaterThanEqual( u.reinitFrom ), () => {

				const i = instanceIndex.add( u.seed.toUint().mul( uint( 2654435761 ) ) );
				const around = hash( i.add( uint( 17 ) ) ).mul( PI2 );
				const { isQueen, isNurse } = casteOf( instanceIndex );

				const pos = vec2( 0 ).toVar();
				const st = uint( 0 ).toVar();

				If( isQueen, () => {

					// la reine naît (et renaît) au fond de la chambre royale
					pos.assign( u.queenPos.add( vec2( cos( around ), sin( around ) )
						.mul( hash( i.add( uint( 531 ) ) ).mul( 4 ) ) ) );
					st.assign( uint( 8 ) );        // souterraine, état 0, sans objectif

				} ).ElseIf( u.colonyOn.greaterThan( 0.5 )
					.and( isNurse.or( u.spawnMode.greaterThan( 0.5 ) ) ), () => {

					// nourrices et nouvelles écloses : chambre du couvain
					const radius = sqrt( hash( i.add( uint( 531 ) ) ) ).mul( u.broodR.mul( 0.6 ) );
					pos.assign( u.broodPos.add( vec2( cos( around ), sin( around ) ).mul( radius ) ) );
					// nourrice → navette grenier ; éclose d'une autre caste → sortie ;
					// nœud courant = chambre de couvain
					const goal = select( isNurse, uint( 1 ), uint( 4 ) );
					st.assign( uint( 8 ).bitOr( goal.shiftLeft( uint( 4 ) ) )
						.bitOr( u.broodNode.toUint().shiftLeft( uint( 7 ) ) ) );

				} ).Else( () => {

					// disque de surface autour du nid (comportement historique)
					const radius = sqrt( hash( i.add( uint( 531 ) ) ) ).mul( u.nestRadius.mul( 0.8 ) );
					pos.assign( u.nest.add( vec2( cos( around ), sin( around ) ).mul( radius ) ) );
					st.assign( uint( 0 ) );

				} );

				antData.element( instanceIndex ).assign( vec4(
					pos, hash( i.add( uint( 923 ) ) ).mul( PI2 ), 0,
				) );
				antState.element( instanceIndex ).assign( st );
				antVital.element( instanceIndex ).assign( vec4(
					0, 0, hash( i.add( uint( 4409 ) ) ).mul( 0.5 ).add( 0.5 ), 0,
				) );

			} );

		} )().compute( MAX_ANTS );

		// ------------------------------------------------------------------
		// Remise à zéro du terrain (dépôts, nourriture, murs, textures)
		// ------------------------------------------------------------------
		this.kClearField = Fn( () => {

			const i = instanceIndex;
			atomicStore( deposit.element( i.mul( 2 ) ), uint( 0 ) );
			atomicStore( deposit.element( i.mul( 2 ).add( 1 ) ), uint( 0 ) );
			atomicStore( alarm.element( i ), uint( 0 ) );
			atomicStore( food.element( i ), uint( 0 ) );
			wall.element( i ).assign( uint( 0 ) );

			const coord = uvec2( i.mod( uint( GRID ) ), i.div( uint( GRID ) ) );
			textureStore( this.textures[ 0 ], coord, vec4( 0 ) );
			textureStore( this.textures[ 1 ], coord, vec4( 0 ) );

		} )().compute( GRID * GRID );

		this.kClearStats = Fn( () => {

			atomicStore( stats.element( instanceIndex ), uint( 0 ) );

		} )().compute( 8 );

		this.kClearSpiderDamage = Fn( () => {

			atomicStore( spiderDamage.element( instanceIndex ), uint( 0 ) );
			atomicStore( spiderAlarm.element( instanceIndex ), uint( 0 ) );
			atomicStore( spiderKills.element( instanceIndex ), uint( 0 ) );

		} )().compute( MAX_SPIDERS );

		// pression d'alarme = valeur INSTANTANÉE (remise à zéro chaque frame avant
		// le noyau fourmis) : elle reflète la peur ambiante autour de l'araignée à
		// l'instant t, et ne peut pas déborder (contrairement à spiderDamage/Kills,
		// cumulés et relus par delta).
		this.kClearSpiderAlarm = Fn( () => {

			atomicStore( spiderAlarm.element( instanceIndex ), uint( 0 ) );

		} )().compute( MAX_SPIDERS );

		// ------------------------------------------------------------------
		// Creusage de la fourmilière : le kernel échantillonne la carte de
		// praticabilité du layout (texture — hors budget storage) et pose le
		// bit 1 des cellules creusées. Rejoué à chaque init, APRÈS les murs
		// sauvegardés et les obstacles (qui ne touchent que le bit 0).
		// ------------------------------------------------------------------
		const depthTexSize = layout.depthTexture.image.width;

		this.kDig = Fn( () => {

			const gi = instanceIndex;
			const lx = gi.mod( uint( GRID ) ).toInt().sub( int( layout.origin.x ) );
			const ly = gi.div( uint( GRID ) ).toInt().sub( int( layout.origin.y ) );

			If( lx.greaterThanEqual( int( 0 ) ).and( lx.lessThan( int( depthTexSize ) ) )
				.and( ly.greaterThanEqual( int( 0 ) ) ).and( ly.lessThan( int( depthTexSize ) ) ), () => {

				const t = textureLoad( layout.depthTexture, ivec2( lx, ly ) );

				If( t.y.greaterThan( 0.5 ), () => {

					wall.element( gi ).assign( wall.element( gi ).bitOr( uint( 2 ) ) );

				} );

			} );

		} )().compute( GRID * GRID );

		// réserves de départ des mangeoires (le temps que le fourragement démarre)
		this.kSeedGranary = Fn( () => {

			If( instanceIndex.equal( uint( 0 ) ), () => {

				atomicStore( food.element( u.troughGranary.toInt() ), u.granaryStart.toUint() );
				atomicStore( food.element( u.troughQueen.toInt() ), uint( 12 ) );
				atomicStore( food.element( u.troughBrood.toInt() ), uint( 8 ) );

			} );

		} )().compute( 1 );

		// ------------------------------------------------------------------
		// Mise à jour des fourmis (capteurs → pilotage → déplacement → dépôt)
		// ------------------------------------------------------------------
		const makeAntKernel = ( readTex ) => Fn( () => {

			If( instanceIndex.toFloat().lessThan( u.antCount ), () => {

				// graine entière par fourmi, par frame et par run (hash() tronque les flottants)
				const iseed = instanceIndex
					.add( frameId.mul( uint( 0x9E3779B9 ) ) )
					.add( u.seed.toUint().mul( uint( 2654435761 ) ) );
				const a = antData.element( instanceIndex );

				// dépacking d'antState : état, niveau, objectif, nœud (voir constructor)
				const stPacked = antState.element( instanceIndex );
				const state = stPacked.bitAnd( uint( 7 ) ).toVar();
				const under = stPacked.shiftRight( uint( 3 ) ).bitAnd( uint( 1 ) ).toVar();
				const goal = stPacked.shiftRight( uint( 4 ) ).bitAnd( uint( 7 ) ).toVar();
				const node = stPacked.shiftRight( uint( 7 ) ).bitAnd( uint( 15 ) ).toVar();

				const pos = a.xy.toVar();
				const ang = a.z.toVar();
				const timer = min( a.w.add( u.dt ), 600 ).toVar();
				const carrying = state.equal( uint( 1 ) ).toVar();

				// alive = vivante (drapeau flottant) : cadavres ET dévorées restent figés.
				const alive = select( state.lessThan( uint( 2 ) ), float( 1 ), float( 0 ) ).toVar();

				// signes vitaux : venin, horloge/série, énergie
				const vital = antVital.element( instanceIndex );
				const venom = vital.x.toVar();
				const biteClock = vital.y.toVar();
				const energy = vital.z.toVar();

				// CAP DE CADAVRES : un cadavre (état 2) dont le numéro de série est plus
				// vieux que les maxAntCorpses derniers créés disparaît (état 3, non rendu)
				// — borne le coût d'affichage. (stats[2] = total mortes = compteur de série,
				// la série est stockée dans vital.y, inutilisé une fois morte.)
				If( state.equal( uint( 2 ) ), () => {

					If( biteClock.add( u.maxAntCorpses )
						.lessThan( atomicLoad( stats.element( 2 ) ).toFloat() ), () => {

						state.assign( uint( 3 ) );

					} );

				} );

				// --- caste (hash stable, zéro stockage — reine = index 0) ---
				const { isQueen, isNurse, isSoldier, isScout } = casteOf( instanceIndex );
				const soldier = isSoldier;

				const panic = float( 0 ).toVar();
				const rage = float( 0 ).toVar();
				const fleeDir = vec2( 0 ).toVar();
				// saisie par les pattes : une araignée qui agrippe (mode morsure) fige
				// fortement la proie SOUS elle (zone large, pattes), pour que sa bouche
				// (petite zone) puisse la rejoindre et la mordre. Immobiliser PUIS mordre.
				const grabbed = float( 0 ).toVar();

				// menace + DÉVORATION : accessible aux vivantes ET aux cadavres (état < 3),
				// jamais aux dévorées, et SURFACE UNIQUEMENT — les souterraines sont hors
				// de portée des araignées (pas de morsure ni d'alarme à travers le sol).
				// Sans prédateur, on n'accède JAMAIS aux secteurs (données périmées).
				If( state.lessThan( uint( 3 ) ).and( under.equal( uint( 0 ) ) )
					.and( u.spiderCount.greaterThan( 0 ) ), () => {

					// --- les 2 araignées du secteur de la fourmi (coût constant quel que
					// soit le nombre de prédateurs — grille 8×8) ---
					const sCell = ivec2( pos ).div( int( GRID / 8 ) ).clamp( ivec2( 0 ), ivec2( 7 ) );
					const sBase = sCell.y.mul( int( 8 ) ).add( sCell.x ).mul( int( 2 ) );

					Loop( { start: int( 0 ), end: int( 2 ), type: 'int', condition: '<' }, ( { i: sk } ) => {

						const sp = u.sectorA.element( sBase.add( sk ) );   // (centre.xy, mode 0/1/2, rayon crochets)
						const sB = u.sectorB.element( sBase.add( sk ) );   // (id, dist², bouche.xy)

						If( sp.w.greaterThan( 0 ), () => {

							const away = pos.sub( sp.xy );
							const dSp = max( length( away ), 0.001 );
							const spiderId = sB.x.toInt();
							// contact = les hitbox se touchent : corps araignée (sp.w) + corps fourmi
							const contact = sp.w.add( u.antHitR );

							// DÉVORATION (mode 2) : un cadavre SOUS le corps d'une araignée qui
							// mange disparaît (husk consommé, plus rien à l'écran). sp.w déjà
							// élargi (×CONSUME_MULT) côté CPU pour ce mode.
							If( alive.lessThan( 0.5 ).and( state.equal( uint( 2 ) ) )
								.and( sp.z.greaterThan( 1.5 ) ).and( dSp.lessThan( contact ) ), () => {

								state.assign( uint( 3 ) );
								atomicAdd( stats.element( 3 ), uint( 1 ) );

							} );

							// réactions des VIVANTES près d'une araignée
							If( alive.greaterThan( 0.5 ).and( dSp.lessThan( u.fleeRadius ) ), () => {

								const w = float( 1 ).sub( dSp.div( u.fleeRadius ) );

								If( soldier, () => {

									// soldates : CHARGENT, morsures au contact du corps
									rage.assign( max( rage, w ) );
									fleeDir.subAssign( away.div( dSp ).mul( w ) );

									If( dSp.lessThan( float( 13 ) ), () => {

										atomicAdd( spiderDamage.element( spiderId ), uint( 1 ) );

									} );

								} ).Else( () => {

									// ouvrières : paniquent, fuient — et leur peur nourrit la
									// pression d'alarme ressentie PAR CETTE araignée (→ fuite)
									panic.assign( max( panic, w ) );
									fleeDir.addAssign( away.div( dSp ).mul( w ) );
									atomicAdd( spiderAlarm.element( spiderId ), w.mul( FIXED ).toUint() );

								} );

								// SAISIE (mode morsure) : toute fourmi passant PRÈS d'une araignée
								// qui chasse (rayon du corps/pattes, distance au CENTRE — robuste,
								// sans viser précisément) est fortement ralentie. L'araignée la fige
								// sous elle pour que sa BOUCHE (petite zone) la rejoigne et la morde.
								// La saisie NE TUE PAS : seule la bouche tue (« sur » la fourmi).
								If( sp.z.greaterThan( 0.5 ).and( sp.z.lessThan( 1.5 ) )
									.and( dSp.lessThan( u.fleeRadius.mul( 0.85 ) ) ), () => {

									grabbed.assign( 1 );

								} );
								// ENVENIMATION (mode 1) : tant que la fourmi est SOUS le CORPS de
								// l'araignée (hitbox corps araignée + hitbox fourmi se touchent —
								// distance au CENTRE, pas à une patte avant), le venin s'accumule
								// au rythme d'≈ 1 dose / biteInterval. Modèle CONTINU : pas besoin
								// de morsures répétées parfaitement replacées (impossible à viser
								// avec un échantillon CPU épars) — RESTER sur la fourmi suffit, ce
								// que la saisie (immobilisation) garantit. Au-delà de bitesToKill
								// doses → mort.
								If( sp.z.greaterThan( 0.5 ).and( sp.z.lessThan( 1.5 ) )
									.and( dSp.lessThan( contact ) ), () => {

									venom.addAssign( u.dt.div( u.biteInterval ) );
									biteClock.assign( 0 );

									If( venom.greaterThanEqual( u.bitesToKill ), () => {

										state.assign( uint( 2 ) );
										alive.assign( float( 0 ) );
										// stats[2] = nombre total de mortes = compteur de série des
										// cadavres ; on stocke le numéro de série de CE cadavre dans
										// vital.y (inutilisé une fois morte) pour le cap de cadavres
										const serial = atomicAdd( stats.element( 2 ), uint( 1 ) );
										biteClock.assign( serial.toFloat() );
										atomicAdd( spiderKills.element( spiderId ), uint( 1 ) );
										spiderKillPos.element( spiderId ).assign( pos );   // où dévorer

									} );

								} );

							} );

						} );

					} );

				} );

				// --- ÉNERGIE (colonie) : drain permanent, mort de faim à zéro ---
				If( alive.greaterThan( 0.5 ).and( u.colonyOn.greaterThan( 0.5 ) ), () => {

					const life = select( isQueen, u.queenEnergyLife, u.energyLife );
					energy.subAssign( u.dt.div( max( life, 1 ) ) );

					If( energy.lessThanEqual( 0 ), () => {

						energy.assign( 0 );
						state.assign( uint( 2 ) );          // morte de faim (cadavre)
						alive.assign( float( 0 ) );
						const serial = atomicAdd( stats.element( 2 ), uint( 1 ) );
						biteClock.assign( serial.toFloat() );

					} );

				} );

				// --- reste du comportement, sauté pour les cadavres (fraîchement
				// mortes ou déjà mortes) : la fourmi reste figée à sa position ---
				If( alive.greaterThan( 0.5 ), () => {

				// --- envenimation : l'horloge de morsure avance ; passé ~1,8×
				// l'intervalle sans nouvelle morsure (araignée décrochée), le venin se
				// dissipe (guérison). La vitesse de marche chute avec la charge de venin :
				// 1 morsure → ×paralysisFactor, davantage → quasi immobile. ---
				biteClock.addAssign( u.dt );

				If( biteClock.greaterThan( u.biteInterval.mul( 1.8 ) ), () => {

					venom.assign( max( venom.sub( u.venomRecovery.mul( u.dt ) ), 0 ) );

				} );

				const paralysis = max(
					float( 0.06 ),
					float( 1 ).sub( venom.mul( float( 1 ).sub( u.paralysisFactor ) ) ),
				).toVar();

				// saisie par les pattes : ralentissement immédiat (immobilisation), même
				// avant la première morsure — on garde le plus fort des deux effets
				paralysis.assign( min( paralysis, select( grabbed.greaterThan( 0.5 ), float( 0.22 ), float( 1 ) ) ) );

				// faim : sous le seuil de retour, une fourmi de surface suit la carte
				// « maison » pour rentrer manger au grenier
				const hungry = u.colonyOn.greaterThan( 0.5 ).and( energy.lessThan( u.hungryHome ) ).toVar();

				If( isQueen, () => {

					// ============================ REINE ============================
					// Confinée en chambre royale, elle mange à la mangeoire royale
					// (remplie par les nourrices) et pond quand elle a l'énergie.
					// (Si la colonie vient d'être activée en cours de partie, elle
					// rejoint sa chambre d'un coup — assumé.)
					If( under.equal( uint( 0 ) ), () => {

						under.assign( uint( 1 ) );
						pos.assign( u.queenPos );

					} );

					const toTrough = u.queenPos.sub( pos );
					const dTrough = length( toTrough ).toVar();
					const hungryQ = energy.lessThan( 0.75 );

					// manger : une unité quand elle est sur la mangeoire
					If( hungryQ.and( dTrough.lessThan( 3 ) ), () => {

						takeOne( u.troughQueen.toInt(), () => {

							energy.assign( min( energy.add( u.queenMealValue ), 1 ) );

						} );

					} );

					// cap : mangeoire si faim, retour au centre si écartée, sinon errance
					const dir = vec2( cos( ang ), sin( ang ) );
					const wantRaw = select( hungryQ.and( dTrough.greaterThan( 2 ) ), toTrough,
						select( dTrough.greaterThan( u.queenR.mul( 0.55 ) ), toTrough,
							dir ) ).toVar();
					const wl = max( length( wantRaw ), 0.0001 );
					const wantN = wantRaw.div( wl );
					const crossZ = dir.x.mul( wantN.y ).sub( dir.y.mul( wantN.x ) );
					const dotv = dir.x.mul( wantN.x ).add( dir.y.mul( wantN.y ) );
					ang.addAssign( select( crossZ.greaterThanEqual( 0 ), float( 1 ), float( - 1 ) )
						.mul( u.steer ).mul( 1.4 ).mul( u.dt ).mul( float( 1.2 ).sub( dotv.mul( 0.8 ) ) ) );
					ang.addAssign( hash( iseed.add( uint( 0x11 ) ) ).sub( 0.5 ).mul( 0.6 ).mul( u.dt ) );

					// pas lent et majestueux, bornée à sa chambre
					pos.addAssign( vec2( cos( ang ), sin( ang ) ).mul( u.moveSpeed.mul( 0.2 ).mul( u.dt ) ) );
					const off = pos.sub( u.queenPos );
					const offL = max( length( off ), 0.0001 );

					If( offL.greaterThan( u.queenR.sub( 2.5 ) ), () => {

						pos.assign( u.queenPos.add( off.div( offL ).mul( u.queenR.sub( 2.5 ) ) ) );

					} );

					// PONTE : chrono porté par a.w — assez d'énergie requise
					If( timer.greaterThan( u.queenLayInterval ).and( energy.greaterThan( u.queenLayMin ) ), () => {

						atomicAdd( stats.element( 4 ), uint( 1 ) );
						energy.subAssign( u.queenLayCost );
						timer.assign( 0 );

					} );

					// énergie publiée (overlay + décision des nourrices) — mono-écrivain
					atomicStore( stats.element( 7 ), energy.mul( 1000 ).toUint() );

				} ).Else( () => {

					// vitesse effective (remplie par la branche surface ou souterraine)
					const moveMult = float( 1 ).toVar();

					If( under.equal( uint( 1 ) ).and( u.colonyOn.greaterThan( 0.5 ) ), () => {

						// ==================== SOUS TERRE : graphe ====================
						// La navigation suit les ARÊTES : le nœud courant (bits 7-10)
						// donne le prochain saut vers l'objectif ; on ne « devine »
						// jamais le nœud par proximité (ambigu entre deux tunnels
						// voisins → fourmis coincées contre la terre pleine).
						// anti-softlock : une non-nourrice sans objectif remonte, et
						// on resynchronise son nœud courant au plus proche (cas rare)
						If( goal.equal( uint( 0 ) ), () => {

							goal.assign( select( isNurse, uint( 1 ), uint( 4 ) ) );

							const bestI = int( 0 ).toVar();
							const bestD = float( 1e20 ).toVar();

							Loop( { start: int( 0 ), end: u.nodeCount.toInt(), type: 'int', condition: '<' }, ( { i } ) => {

								const d = length( pos.sub( u.nodes.element( i ).xy ) );

								If( d.lessThan( bestD ), () => {

									bestD.assign( d );
									bestI.assign( i );

								} );

							} );

							node.assign( bestI.toUint() );

						} );

						// saut courant ; nœud atteint → on avance d'une arête
						const hop1 = u.nextHop.element( node.toInt().mul( 8 ).add( goal.toInt() ) ).toInt();
						const hop1Node = u.nodes.element( hop1 );

						If( length( pos.sub( hop1Node.xy ) ).lessThan( hop1Node.z ), () => {

							node.assign( hop1.toUint() );

						} );

						// cible : la mangeoire de l'objectif quand on approche de sa
						// chambre, sinon le prochain nœud du graphe (recalculé après
						// la mise à jour du nœud courant)
						const hop = u.nextHop.element( node.toInt().mul( 8 ).add( goal.toInt() ) ).toInt();
						const goalPos = select( goal.equal( uint( 1 ) ), u.granaryPos,
							select( goal.equal( uint( 2 ) ), u.queenPos,
								select( goal.equal( uint( 3 ) ), u.broodPos,
									u.nodes.element( 0 ).xy ) ) ).toVar();
						const dGoal = length( pos.sub( goalPos ) ).toVar();
						const target = select( dGoal.lessThan( 14 ), goalPos, u.nodes.element( hop ).xy );

						// virage vers la cible + légère errance (files organiques)
						const dir = vec2( cos( ang ), sin( ang ) );
						const to = target.sub( pos );
						const toN = to.div( max( length( to ), 0.0001 ) );
						const crossZ = dir.x.mul( toN.y ).sub( dir.y.mul( toN.x ) );
						const dotv = dir.x.mul( toN.x ).add( dir.y.mul( toN.y ) );
						ang.addAssign( select( crossZ.greaterThanEqual( 0 ), float( 1 ), float( - 1 ) )
							.mul( u.steer ).mul( 2.6 ).mul( u.dt ).mul( float( 1.3 ).sub( dotv.mul( 0.9 ) ) ) );
						ang.addAssign( hash( iseed.add( uint( 0x77 ) ) ).sub( 0.5 ).mul( 0.9 ).mul( u.dt ) );

						moveMult.assign( float( 0.8 ).mul( paralysis ) );

					} ).Else( () => {

						// ==================== SURFACE (historique + castes) ====================

						// --- phéromone d'alarme : déposée par les paniquées (les soldates
						// en laissent aussi : elle RECRUTE les autres soldates au combat) ---
						const alarmLevel = max( panic, rage.mul( 0.7 ) );

						If( alarmLevel.greaterThan( 0.12 ), () => {

							const cellA = ivec2( pos );
							atomicMax( alarm.element( cellIndex( cellA ) ), alarmLevel.mul( FIXED ).toUint() );

						} );

						// --- capteurs : 3 cônes de 3×3 texels sur la carte recherchée ---
						// une affamée suit la carte « maison » (elle rentre manger) ; une
						// éclaireuse pondère peu les pistes existantes (exploration)
						const followHome = carrying.or( hungry );
						const trailW = select( isScout.and( carrying.not() ), u.scoutTrail, float( 1 ) );

						const sense = ( angleOffset ) => {

							const sang = ang.add( angleOffset );
							const sp = pos.add( vec2( cos( sang ), sin( sang ) ).mul( u.sensorDist ) );
							let w = float( 0 );

							for ( let oy = - 1; oy <= 1; oy ++ ) {

								for ( let ox = - 1; ox <= 1; ox ++ ) {

									const c = clamp(
										ivec2( sp ).add( ivec2( ox, oy ) ),
										ivec2( 0 ), ivec2( GRID - 1 ),
									);
									const t = textureLoad( readTex, c );
									// porteuse/affamée → carte « maison » (R) ; exploratrice → « nourriture » (G)
									// murs (B négatif) répulsifs ; alarme (B positif) : les ouvrières
									// l'évitent, les soldates y foncent (recrutement au combat)
									const alarmS = clamp( t.z, 0, 1 );
									w = w.add( select( followHome, t.x, t.y ).mul( trailW ) )
										.sub( clamp( t.z.negate(), 0, 1 ).mul( 0.8 ) )
										.add( select( soldier, alarmS.mul( 2.2 ), alarmS.mul( - 1.4 ) ) );

								}

							}

							return w.toVar();

						};

						const wForward = sense( float( 0 ) );
						const wLeft = sense( u.sensorAngle );
						const wRight = sense( u.sensorAngle.negate() );

						// --- pilotage (arbre de priorité de Lague) ---
						const r1 = hash( iseed );
						const steerAmt = u.steer.mul( u.dt );

						If( wForward.lessThan( wLeft ).or( wForward.lessThan( wRight ) ), () => {

							If( wForward.lessThan( wLeft ).and( wForward.lessThan( wRight ) ), () => {

								// tout droit est le pire : errance aléatoire
								ang.addAssign( r1.sub( 0.5 ).mul( 2 ).mul( steerAmt ) );

							} ).ElseIf( wRight.greaterThan( wLeft ), () => {

								ang.subAssign( r1.mul( steerAmt ) );

							} ).Else( () => {

								ang.addAssign( r1.mul( steerAmt ) );

							} );

						} );

						// errance permanente — réduite quand on porte, amplifiée pour les
						// éclaireuses (elles cherchent du NOUVEAU au lieu des autoroutes)
						const r2 = hash( iseed.add( uint( 0x85EBCA6B ) ) );
						const wander = u.wander.mul( select( carrying, 0.5, 1 ) )
							.mul( select( isScout.and( carrying.not() ), u.scoutWander, float( 1 ) ) );
						ang.addAssign( r2.sub( 0.5 ).mul( 2 ).mul( wander ).mul( u.dt ) );

						// panique/charge : virage prononcé vers la direction voulue (sans atan)
						const urgency = max( panic, rage ).toVar();

						If( urgency.greaterThan( 0.01 ), () => {

							const dirv = vec2( cos( ang ), sin( ang ) );
							const crossZ = dirv.x.mul( fleeDir.y ).sub( dirv.y.mul( fleeDir.x ) );
							const dotv = dirv.x.mul( fleeDir.x ).add( dirv.y.mul( fleeDir.y ) );
							const turn = select( crossZ.greaterThanEqual( 0 ), float( 1 ), float( - 1 ) );
							ang.addAssign(
								turn.mul( urgency ).mul( u.steer ).mul( 2.2 ).mul( u.dt )
									.mul( float( 1.4 ).sub( dotv.mul( 0.4 ) ) ),
							);

						} );

						// une candidate à la descente (porteuse, affamée, nourrice égarée)
						// proche du nid vise la BOUCHE du nid (tête de spirale) en direct
						const wantsIn = u.colonyOn.greaterThan( 0.5 )
							.and( carrying.or( hungry ).or( isNurse ) ).toVar();
						const entry = u.nodes.element( 0 ).xy;
						const dNestHere = length( pos.sub( u.nest ) );

						If( wantsIn.and( dNestHere.lessThan( u.nestRadius.mul( 1.8 ) ) ), () => {

							const dirv = vec2( cos( ang ), sin( ang ) );
							const toE = entry.sub( pos );
							const toEN = toE.div( max( length( toE ), 0.0001 ) );
							const crossZ = dirv.x.mul( toEN.y ).sub( dirv.y.mul( toEN.x ) );
							ang.addAssign( select( crossZ.greaterThanEqual( 0 ), float( 1 ), float( - 1 ) )
								.mul( u.steer ).mul( 2.4 ).mul( u.dt ) );

						} );

						// vitesse : panique/charge +45 %, venin/saisie ralentissent,
						// multiplicateur de caste (éclaireuse rapide, soldate lourde)
						const casteSpeed = select( isScout, u.scoutSpeed,
							select( soldier, u.soldierSpeed, float( 1 ) ) );
						moveMult.assign( urgency.mul( 0.45 ).add( 1 ).mul( paralysis ).mul( casteSpeed ) );

					} );

					// --- déplacement + rebond sur murs / bords (réflexion par axe) ---
					// Surface : bit 0 (une fourmi enterrée sous un mur fraîchement peint
					// ignore les murs le temps d'en sortir). Sous terre : tout ce qui
					// n'est PAS creusé (bit 1) est de la terre pleine.
					const startWalled = surfaceWall( wall.element(
						cellIndex( clamp( ivec2( pos ), ivec2( 1 ), ivec2( GRID - 2 ) ) ),
					) ).toVar();

					const blockedAt = ( px, py ) => {

						const c = clamp( ivec2( px, py ), ivec2( 1 ), ivec2( GRID - 2 ) );
						const w = wall.element( cellIndex( c ) );
						const hitWall = select( under.equal( uint( 1 ) ),
							dug( w ).not(),
							surfaceWall( w ).and( startWalled.not() ) );
						const out = px.lessThan( 1 ).or( px.greaterThanEqual( GRID - 1 ) )
							.or( py.lessThan( 1 ) ).or( py.greaterThanEqual( GRID - 1 ) );
						return out.or( hitWall );

					};

					// sous-pas de ≤ 1 texel pour ne pas traverser les murs minces
					const stepLen = u.moveSpeed.mul( u.dt ).mul( moveMult );
					const nSub = clamp( ceil( stepLen ).toInt(), int( 1 ), int( 16 ) ).toVar();
					const subLen = stepLen.div( nSub.toFloat() );

					Loop( { start: int( 0 ), end: nSub, type: 'int', condition: '<' }, () => {

						const next = pos.add( vec2( cos( ang ), sin( ang ) ).mul( subLen ) ).toVar();
						const bx = blockedAt( next.x, pos.y ).toVar();
						const by = blockedAt( pos.x, next.y ).toVar();

						If( bx.or( by ), () => {

							If( bx, () => {

								ang.assign( PI.sub( ang ) );

							} );
							If( by, () => {

								ang.assign( ang.negate() );

							} );
							next.assign( pos.add( vec2( cos( ang ), sin( ang ) ).mul( subLen ) ) );

						} );

						// coin en diagonale : on reste sur place et on repart au hasard
						If( blockedAt( next.x, next.y ), () => {

							next.assign( pos );
							ang.assign( hash( iseed.add( uint( 0xC2B2AE35 ) ) ).mul( PI2 ) );

						} );

						pos.assign( next );

					} );

					// --- événements ---
					If( under.equal( uint( 1 ) ).and( u.colonyOn.greaterThan( 0.5 ) ), () => {

						// ================== ARRIVÉES SOUTERRAINES ==================
						const dGranary = length( pos.sub( u.granaryPos ) );
						const dQueenT = length( pos.sub( u.queenPos ) );
						const dBroodT = length( pos.sub( u.broodPos ) );

						If( goal.equal( uint( 1 ) ).and( dGranary.lessThan( 4 ) ), () => {

							If( state.equal( uint( 1 ) ), () => {

								// porteuse : la bille rejoint le stock du grenier — LIVRÉE
								atomicAdd( food.element( u.troughGranary.toInt() ), uint( 1 ) );
								atomicAdd( stats.element( 0 ), uint( 1 ) );
								state.assign( uint( 0 ) );
								goal.assign( select( isNurse, uint( 1 ), uint( 4 ) ) );

							} ).Else( () => {

								// affamée : manger d'abord
								If( energy.lessThan( u.eatThreshold ), () => {

									takeOne( u.troughGranary.toInt(), () => {

										energy.assign( 1 );

									} );

								} ).Else( () => {

									If( isNurse, () => {

										// nourrice : prend une unité pour la navette
										takeOne( u.troughGranary.toInt(), () => {

											state.assign( uint( 1 ) );
											// destination : la reine si elle a faim, sinon
											// répartition reine/couvain (les larves mangent)
											const qe = atomicLoad( stats.element( 7 ) ).toFloat().div( 1000 );
											const toQueen = qe.lessThan( 0.55 )
												.or( hash( iseed.add( uint( 0xF00D ) ) ).lessThan( 0.3 ) );
											goal.assign( select( toQueen, uint( 2 ), uint( 3 ) ) );

										} );

									} ).Else( () => {

										// rassasiée, rien à faire en bas : remonter
										goal.assign( uint( 4 ) );

									} );

								} );

							} );

						} );

						// livraison à la mangeoire royale / du couvain
						If( goal.equal( uint( 2 ) ).and( dQueenT.lessThan( 4 ) ), () => {

							If( state.equal( uint( 1 ) ), () => {

								atomicAdd( food.element( u.troughQueen.toInt() ), uint( 1 ) );
								state.assign( uint( 0 ) );

							} );
							goal.assign( uint( 1 ) );

						} );

						If( goal.equal( uint( 3 ) ).and( dBroodT.lessThan( 4 ) ), () => {

							If( state.equal( uint( 1 ) ), () => {

								atomicAdd( food.element( u.troughBrood.toInt() ), uint( 1 ) );
								state.assign( uint( 0 ) );

							} );
							goal.assign( uint( 1 ) );

						} );

						// sortie : au nœud d'entrée (profondeur ≈ 0) → surface, bits
						// hauts remis à zéro (INVARIANT araignées, voir antState)
						If( goal.equal( uint( 4 ) ), () => {

							const dExit = length( pos.sub( u.nodes.element( 0 ).xy ) );

							If( dExit.lessThan( u.entranceR ), () => {

								under.assign( uint( 0 ) );
								goal.assign( uint( 0 ) );
								node.assign( uint( 0 ) );
								timer.assign( 0 );          // elle sort du nid : fraîcheur pleine

							} );

						} );

					} ).Else( () => {

						// ================== ÉVÉNEMENTS DE SURFACE ==================
						const cell = ivec2( pos );
						const ci = cellIndex( cell ).toVar();
						const foodHere = atomicLoad( food.element( ci ) ).toVar();
						const dNest = length( pos.sub( u.nest ) ).toVar();
						// une cellule creusée appartient au monde d'en bas : sa
						// nourriture (grenier, mangeoires) est INVISIBLE en surface
						const dugHere = dug( wall.element( ci ) ).toVar();
						const foodOk = foodHere.greaterThan( uint( 0 ) )
							.and( foodHere.lessThan( uint( 0x80000000 ) ) )
							.and( dugHere.not() ).toVar();

						If( carrying.not(), () => {

							// manger sur place si affamée et qu'il y a une bille ici
							const canEat = u.colonyOn.greaterThan( 0.5 )
								.and( energy.lessThan( u.eatThreshold ) ).and( foodOk );

							If( canEat, () => {

								takeOne( ci, () => {

									energy.assign( 1 );

								} );

							} ).ElseIf( foodOk, () => {

								// tentative atomique : si une autre fourmi a pris la dernière
								// unité entre-temps (prev == 0, ou compteur wrappé par une
								// course à trois), on restitue pour que le compteur reconverge.
								takeOne( ci, () => {

									state.assign( uint( 1 ) );
									ang.addAssign( PI );
									timer.assign( 0 );
									atomicAdd( stats.element( 1 ), uint( 1 ) );

								} );

							} ).ElseIf( dNest.lessThan( u.nestRadius ), () => {

								timer.assign( 0 ); // passage au nid : dépôt « maison » rechargé

								// affamée ou nourrice égarée : elle DESCEND par l'entrée
								If( u.colonyOn.greaterThan( 0.5 ).and( hungry.or( isNurse ) ), () => {

									const dEntry = length( pos.sub( u.nodes.element( 0 ).xy ) );

									If( dEntry.lessThan( u.entranceR ), () => {

										under.assign( uint( 1 ) );
										goal.assign( uint( 1 ) );   // au grenier (manger / navette)
										node.assign( uint( 0 ) );   // départ : tête de spirale

									} );

								} );

							} );

						} ).Else( () => {

							If( dNest.lessThan( u.nestRadius ), () => {

								If( u.colonyOn.greaterThan( 0.5 ), () => {

									// COLONIE : la porteuse passe par l'entrée et va déposer
									// sa bille au grenier (la livraison est comptée en bas)
									const dEntry = length( pos.sub( u.nodes.element( 0 ).xy ) );

									If( dEntry.lessThan( u.entranceR ), () => {

										under.assign( uint( 1 ) );
										goal.assign( uint( 1 ) );
										node.assign( uint( 0 ) );   // départ : tête de spirale
										timer.assign( 0 );

									} );

								} ).Else( () => {

									// historique : livraison instantanée au nid
									state.assign( uint( 0 ) );
									ang.addAssign( PI );
									timer.assign( 0 );
									atomicAdd( stats.element( 0 ), uint( 1 ) );

								} );

							} ).ElseIf( foodOk, () => {

								timer.assign( 0 ); // passage sur la nourriture : dépôt rechargé

							} );

						} );

						// --- dépôt de phéromone : sémantique de FRAÎCHEUR (Pezzza) ---
						// la valeur du champ = exp(-fade·temps_depuis_source) du visiteur le
						// plus « frais » (atomicMax), pas une accumulation : le gradient vers
						// la source reste net même sous très fort trafic, aucune saturation.
						// exploratrice (0) → canal maison (0) ; porteuse (1) → canal nourriture (1)
						// la peur coupe le dépôt : pas de piste fiable près d'un prédateur —
						// la colonie apprend d'elle-même à contourner la zone
						const freshness = clamp(
							exp( u.fade.negate().mul( timer ) ).mul( u.depositRate.div( 12 ) ),
							0, 1,
						).mul( float( 1 ).sub( panic.mul( 0.85 ) ) ).mul( FIXED ).toUint();

						If( freshness.greaterThan( uint( 0 ) ), () => {

							atomicMax( deposit.element( ci.mul( 2 ).add( state.toInt() ) ), freshness );

						} );

					} );

				} ); // fin Else (non-reine)

				// normalisation de l'angle dans [0, 2π)
				ang.assign( ang.sub( floor( ang.div( PI2 ) ).mul( PI2 ) ) );

				a.assign( vec4( pos, ang, timer ) );

				} ); // fin If(alive) — reste du comportement

				// --- écriture finale : état re-packé + signes vitaux ---
				// (aussi pour les mortes : le cap de cadavres et la dévoration font
				// évoluer leur état ; leur position, elle, reste figée)
				antState.element( instanceIndex ).assign(
					state.bitOr( under.shiftLeft( uint( 3 ) ) )
						.bitOr( goal.shiftLeft( uint( 4 ) ) )
						.bitOr( node.shiftLeft( uint( 7 ) ) ),
				);
				antVital.element( instanceIndex ).assign( vec4( venom, biteClock, energy, 0 ) );

			} );

		} )().compute( MAX_ANTS );

		// ------------------------------------------------------------------
		// Passe grille : diffusion + évaporation + injection des dépôts,
		// marqueurs permanents (nid, nourriture), écriture de l'affichage.
		// ------------------------------------------------------------------
		const makeGridKernel = ( readTex, writeTex ) => Fn( () => {

			const i = instanceIndex;
			const ix = i.mod( uint( GRID ) );
			const iy = i.div( uint( GRID ) );
			const c = ivec2( ix.toInt(), iy.toInt() );

			// flou 3×3 : canaux R/G pour la diffusion des phéromones,
			// canal A pour le halo lumineux de la nourriture (mêmes fetchs = gratuit)
			let sum = vec3( 0 );

			for ( let oy = - 1; oy <= 1; oy ++ ) {

				for ( let ox = - 1; ox <= 1; ox ++ ) {

					const nc = clamp( c.add( ivec2( ox, oy ) ), ivec2( 0 ), ivec2( GRID - 1 ) );
					sum = sum.add( textureLoad( readTex, nc ).xyw );

				}

			}

			const center4 = textureLoad( readTex, c );
			const center = center4.xy;
			const blurred = sum.xy.div( 9 );

			const pher = mix( center, blurred, clamp( u.diffuse.mul( u.dt ), 0, 1 ) ).toVar();
			pher.assign( max( pher.sub( u.evap.mul( u.dt ) ), vec2( 0 ) ) );

			// injection des dépôts : le champ prend la fraîcheur maximale vue
			// (rafraîchissement, pas accumulation) puis l'accumulateur est vidé
			const d0 = atomicLoad( deposit.element( i.mul( 2 ) ) );
			const d1 = atomicLoad( deposit.element( i.mul( 2 ).add( 1 ) ) );
			atomicStore( deposit.element( i.mul( 2 ) ), uint( 0 ) );
			atomicStore( deposit.element( i.mul( 2 ).add( 1 ) ), uint( 0 ) );
			pher.assign( max( pher, vec2( d0.toFloat(), d1.toFloat() ).div( FIXED ) ) );

			// marqueurs permanents : la nourriture sature G, le nid sature R.
			// Une cellule CREUSÉE (bit 1) appartient au souterrain : son stock
			// (grenier, mangeoires) n'apparaît JAMAIS sur les cartes de surface.
			const foodHere = atomicLoad( food.element( i ) );
			const wallHere = wall.element( i );
			const isDug = wallHere.bitAnd( uint( 2 ) ).notEqual( uint( 0 ) );
			const isWall = wallHere.bitAnd( uint( 1 ) ).notEqual( uint( 0 ) );
			const p = vec2( ix.toFloat(), iy.toFloat() );

			If( foodHere.greaterThan( uint( 0 ) ).and( isDug.not() ), () => {

				pher.y.assign( 1 );

			} );
			If( length( p.sub( u.nest ) ).lessThan( u.nestRadius ), () => {

				pher.x.assign( 1 );

			} );
			If( isWall, () => {

				pher.assign( vec2( 0 ) );

			} );

			pher.assign( clamp( pher, vec2( 0 ), vec2( 1 ) ) );

			// halo : diffusion itérée (bord exponentiel) réalimentée par les billes
			const foodVis = min( foodHere.toFloat().div( 12 ), 1 )
				.mul( select( isDug, float( 0 ), float( 1 ) ) );
			const halo = clamp( max( sum.z.div( 9 ).mul( u.haloSpread ), foodVis ), 0, 1 );

			// alarme : injection (max) puis évanouissement rapide, sans diffusion
			const aDep = atomicLoad( alarm.element( i ) );
			atomicStore( alarm.element( i ), uint( 0 ) );
			const alarmV = clamp( max(
				clamp( center4.z, 0, 1 ).sub( u.alarmDecay.mul( u.dt ) ),
				aDep.toFloat().div( FIXED ),
			), 0, 1 );

			// packing : B = alarme (+) / mur (−), A = halo
			const bPacked = select( isWall, float( - 1 ), alarmV );

			textureStore( writeTex, uvec2( ix, iy ), vec4( pher.x, pher.y, bPacked, halo ) );

			// stock du grenier publié pour l'overlay (UN seul thread écrit)
			If( i.equal( u.troughGranary.toUint() ), () => {

				atomicStore( stats.element( 6 ), foodHere );

			} );

		} )().compute( GRID * GRID );

		// ------------------------------------------------------------------
		// Rasterisation des obstacles du décor dans la grille de murs
		// (bit 0 uniquement — le réseau creusé, bit 1, est préservé)
		// ------------------------------------------------------------------
		this.kObstacles = Fn( () => {

			const gi = instanceIndex;
			const p = vec2( gi.mod( uint( GRID ) ).toFloat(), gi.div( uint( GRID ) ).toFloat() );

			Loop( { start: int( 0 ), end: u.obstacleCount.toInt(), type: 'int', condition: '<' }, ( { i } ) => {

				const A = u.obstacleA.element( i );      // cx, cy, hw, hh
				const B = u.obstacleB.element( i );      // axe.x, axe.y, type
				const d = p.sub( A.xy );

				If( B.z.lessThan( 0.5 ), () => {

					// disque
					If( length( d ).lessThan( A.z ), () => {

						wall.element( gi ).assign( wall.element( gi ).bitOr( uint( 1 ) ) );

					} );

				} ).Else( () => {

					// rectangle orienté (axe = direction de la longueur)
					const along = d.x.mul( B.x ).add( d.y.mul( B.y ) );
					const across = d.x.mul( B.y.negate() ).add( d.y.mul( B.x ) );

					If( along.abs().lessThan( A.z ).and( across.abs().lessThan( A.w ) ), () => {

						wall.element( gi ).assign( wall.element( gi ).bitOr( uint( 1 ) ) );

					} );

				} );

			} );

		} )().compute( GRID * GRID );

		const [ tA, tB ] = this.textures;
		this.kAnt = [ makeAntKernel( tA ), makeAntKernel( tB ) ];
		this.kGrid = [ makeGridKernel( tA, tB ), makeGridKernel( tB, tA ) ];

		// ------------------------------------------------------------------
		// Pinceau : nourriture / mur / gomme dans un disque
		// (ne touche JAMAIS le bit 1 « creusé », ni la nourriture souterraine)
		// ------------------------------------------------------------------
		this.kBrush = Fn( () => {

			const gi = instanceIndex;
			const p = vec2( gi.mod( uint( GRID ) ).toFloat(), gi.div( uint( GRID ) ).toFloat() );

			Loop( { start: int( 0 ), end: u.stampCount.toInt(), type: 'int', condition: '<' }, ( { i } ) => {

				const s = u.stamps.element( i );          // x, y, rayon, mode
				const d = length( p.sub( s.xy ) );

				If( d.lessThanEqual( s.z ), () => {

					const wallHere = wall.element( gi );
					const isDug = wallHere.bitAnd( uint( 2 ) ).notEqual( uint( 0 ) );

					If( s.w.lessThan( 0.5 ), () => {

						// nourriture en VRAIES billes : une bille = une cellule, au
						// centre jitteré de son bloc (même formule que le rendu des
						// billes dans graphics/foodballs.js). Jamais sur une cellule
						// creusée : son stock appartient au grenier souterrain.
						If( wallHere.bitAnd( uint( 3 ) ).equal( uint( 0 ) ), () => {

							const P = u.ballSpacing;
							const bloc = floor( p.div( P ) );
							const isBall = float( 0 ).toVar();

							for ( let by = - 1; by <= 1; by ++ ) {

								for ( let bx = - 1; bx <= 1; bx ++ ) {

									const b = bloc.add( vec2( bx, by ) );
									const b8 = b.add( vec2( 8 ) );          // graines positives
									const jx = hash( b8.x.mul( 127.1 ).add( b8.y.mul( 311.7 ) ) );
									const jy = hash( b8.x.mul( 269.5 ).add( b8.y.mul( 183.3 ) ) );
									// jitter borné à ±0.25·P : deux centres adjacents sont
									// toujours séparés d'au moins 0.5·P — jamais de billes
									// imbriquées (le rayon visuel est plafonné en dessous)
									const center = b.add( vec2( 0.25 ) ).add( vec2( jx, jy ).mul( 0.5 ) ).mul( P );
									const cell = floor( center );

									// ce texel est-il LA cellule de la bille, et la bille dans le pinceau ?
									If( cell.x.equal( p.x ).and( cell.y.equal( p.y ) )
										.and( length( center.sub( s.xy ) ).lessThanEqual( s.z ) ), () => {

										isBall.assign( 1 );

									} );

								}

							}

							If( isBall.greaterThan( 0.5 ), () => {

								atomicStore( food.element( gi ), u.stampFood.element( i ).toUint() );

							} );

						} );

					} ).ElseIf( s.w.lessThan( 1.5 ), () => {

						// mur — interdit sur et autour du nid ; ne touche que le bit 0,
						// et n'efface jamais un stock souterrain
						If( length( p.sub( u.nest ) ).greaterThan( u.nestRadius.add( 10 ) ), () => {

							wall.element( gi ).assign( wall.element( gi ).bitOr( uint( 1 ) ) );

							If( isDug.not(), () => {

								atomicStore( food.element( gi ), uint( 0 ) );

							} );

						} );

					} ).Else( () => {

						// gomme : efface le mur de surface (bit 0) et la nourriture de
						// surface — le réseau creusé et le grenier restent intacts
						wall.element( gi ).assign( wall.element( gi ).bitAnd( uint( 0xFFFFFFFE ) ) );

						If( isDug.not(), () => {

							atomicStore( food.element( gi ), uint( 0 ) );

						} );

					} );

				} );

			} );

		} )().compute( GRID * GRID );

	}

	// ----------------------------------------------------------------------
	// Cycle de vie
	// ----------------------------------------------------------------------

	async init() {

		const r = this.renderer;
		this.u.reinitFrom.value = 0;
		await r.computeAsync( this.kClearField );
		await r.computeAsync( this.kClearStats );
		await r.computeAsync( this.kClearSpiderDamage );
		await r.computeAsync( this.kInitAnts );

		// murs : la version ajustée à la main (sauvegardée) prime sur les
		// empreintes automatiques du décor
		if ( this._savedWalls ) this._applySavedWalls();
		else if ( this._obstacles ) await this._stampObstacles();

		// le réseau souterrain est TOUJOURS re-creusé après les murs (bit 1)
		if ( params.colony ) {

			await r.computeAsync( this.kDig );
			await r.computeAsync( this.kSeedGranary );

		}

		await this._seedFood();

	}

	async reset() {

		this.cur = 0;
		this._brushQueue.length = 0;
		this._regenAccum = 0;
		this.statsData = { delivered: 0, picked: 0, eaten: 0, devoured: 0, laid: 0, hatched: 0, granary: 0, queenEnergy: 1 };
		await this.init();

	}

	// activer/couper la colonie en cours de partie (recreuse le réseau au besoin)
	async setColonyEnabled( on ) {

		this.u.colonyOn.value = on ? 1 : 0;

		if ( on ) {

			await this.renderer.computeAsync( this.kDig );

		}

	}

	async _seedFood() {

		// petits gisements de départ autour du nid, semés en un seul dispatch
		const blobs = SEED_BLOBS;

		blobs.forEach( ( b, k ) => {

			this._stampVecs[ k ].set(
				NEST.x + Math.cos( b.angle ) * b.dist,
				NEST.y + Math.sin( b.angle ) * b.dist,
				b.radius,
				0,
			);
			this._stampFood[ k ] = params.foodAmount;

		} );

		this.u.stampCount.value = blobs.length;
		await this.renderer.computeAsync( this.kBrush );
		this.u.stampCount.value = 0;

	}

	// Une étape de simulation (appelée chaque frame quand non-pausé).
	step( dt ) {

		this.u.dt.value = dt;
		// alarme ressentie par les araignées : instantanée → on la vide avant le
		// noyau fourmis, qui la re-remplit selon la panique locale de cette frame
		if ( this.u.spiderCount.value > 0 ) this.renderer.compute( this.kClearSpiderAlarm );
		this.renderer.compute( this.kAnt[ this.cur ] );
		this.renderer.compute( this.kGrid[ this.cur ] );
		this.cur ^= 1;

		// RÉGÉNÉRATION des gisements (colonie) : l'économie d'énergie consomme
		// la nourriture — sans nouvelles sources, n'importe quel réglage finit
		// en famine. Un blob aléatoire hors du nid toutes les 60/foodRegen s.
		if ( params.colony && params.foodRegen > 0 ) {

			this._regenAccum += dt;

			if ( this._regenAccum > 60 / params.foodRegen ) {

				this._regenAccum = 0;
				const angle = Math.random() * Math.PI * 2;
				const dist = 150 + Math.random() * 280;
				this.queueBrush(
					NEST.x + Math.cos( angle ) * dist,
					NEST.y + Math.sin( angle ) * dist,
					0,
					7 + Math.random() * 5,
					params.foodAmount,
				);

			}

		}

	}

	// Rafraîchit l'affichage sans faire avancer la simulation (peinture en pause).
	refreshDisplay() {

		this.u.dt.value = 0;
		this.renderer.compute( this.kGrid[ this.cur ] );
		this.cur ^= 1;

	}

	// ----------------------------------------------------------------------
	// Pinceau (jusqu'à 16 coups par frame, en un seul dispatch)
	// ----------------------------------------------------------------------

	// Retourne false si la file est pleine (l'appelant peut ré-interpoler plus tard).
	queueBrush( gx, gy, mode, radius, foodAmount ) {

		if ( this._brushQueue.length >= 256 ) return false;
		this._brushQueue.push( { gx, gy, mode, radius, foodAmount } );
		return true;

	}

	drainBrush() {

		if ( this._brushQueue.length === 0 ) return false;

		const n = Math.min( this._stampVecs.length, this._brushQueue.length );

		for ( let k = 0; k < n; k ++ ) {

			const s = this._brushQueue.shift();
			this._stampVecs[ k ].set( s.gx, s.gy, s.radius, s.mode );
			this._stampFood[ k ] = s.foodAmount;

		}

		this.u.stampCount.value = n;
		this.renderer.compute( this.kBrush );
		this.u.stampCount.value = 0;

		// NB : la gomme perce aussi les empreintes du décor — ajustage à la
		// main, sauvegardable via « Sauvegarder les réglages ».
		return true;

	}

	// ----------------------------------------------------------------------
	// Persistance des murs (base64 de bits, ~171 Ko en localStorage)
	// SEUL le bit 0 (mur de surface) est sérialisé : le réseau creusé (bit 1)
	// est déterministe et re-stampé à chaque init par kDig.
	// ----------------------------------------------------------------------

	setSavedWalls( base64OrNull ) {

		this._savedWalls = base64OrNull || null;

	}

	async readWallsBase64() {

		const buf = await this.renderer.getArrayBufferAsync( this.wall.value );
		const cells = new Uint32Array( buf );
		const bits = new Uint8Array( Math.ceil( cells.length / 8 ) );

		for ( let i = 0; i < cells.length; i ++ ) {

			if ( cells[ i ] & 1 ) bits[ i >> 3 ] |= 1 << ( i & 7 );

		}

		let s = '';
		for ( let i = 0; i < bits.length; i += 8192 ) {

			s += String.fromCharCode.apply( null, bits.subarray( i, i + 8192 ) );

		}

		return btoa( s );

	}

	_applySavedWalls() {

		const s = atob( this._savedWalls );
		const array = this.wall.value.array;

		// bit 0 pur : le kernel kDig re-posera le bit 1 (creusé) juste après
		for ( let i = 0; i < array.length; i ++ ) {

			array[ i ] = ( s.charCodeAt( i >> 3 ) >> ( i & 7 ) ) & 1;

		}

		this.wall.value.needsUpdate = true;

	}

	// Déclare les obstacles du décor et les rasterise dans la grille de murs
	// (re-rasterisés à chaque reset, après le nettoyage du terrain).
	async setObstacles( stamps ) {

		this._obstacles = stamps.slice( 0, this._obstacleA.length );
		if ( ! this._savedWalls ) await this._stampObstacles();

	}

	async _stampObstacles() {

		this._obstacles.forEach( ( s, i ) => {

			this._obstacleA[ i ].set( s.cx, s.cy, s.hw, s.hh );
			this._obstacleB[ i ].set( s.ax, s.ay, s.type, 0 );

		} );

		this.u.obstacleCount.value = this._obstacles.length;
		await this.renderer.computeAsync( this.kObstacles );

	}

	// Ré-initialise les fourmis d'index ≥ fromIndex (activation via le slider).
	reinitAnts( fromIndex ) {

		this.u.reinitFrom.value = fromIndex;
		this.renderer.compute( this.kInitAnts );
		this.u.reinitFrom.value = 0;

	}

	// Active n fourmis écloses : elles naissent au couvain (sous terre) et
	// remontent d'elles-mêmes. L'appelant met ensuite antCount à jour.
	spawnHatched( fromIndex ) {

		this.u.spawnMode.value = 1;
		this.reinitAnts( fromIndex );
		this.u.spawnMode.value = 0;

	}

	// ----------------------------------------------------------------------
	// Statistiques (lecture GPU → CPU, non bloquante)
	// ----------------------------------------------------------------------

	// lecture directe, sans garde de concurrence (banc d'essai)
	async readStatsDirect() {

		const buffer = await this.renderer.getArrayBufferAsync( this.stats.value );
		const data = new Uint32Array( buffer );
		return {
			delivered: data[ 0 ], picked: data[ 1 ], eaten: data[ 2 ], devoured: data[ 3 ],
			laid: data[ 4 ], hatched: data[ 5 ], granary: data[ 6 ], queenEnergy: data[ 7 ] / 1000,
		};

	}

	async readStats() {

		// verrou readback GLOBAL (partagé avec les araignées et la colonie) :
		// deux getArrayBufferAsync concurrents se corrompent mutuellement
		if ( ! tryAcquireReadback() ) return this.statsData;

		try {

			const buffer = await this.renderer.getArrayBufferAsync( this.stats.value );
			const data = new Uint32Array( buffer );
			this.statsData = {
				delivered: data[ 0 ], picked: data[ 1 ], eaten: data[ 2 ], devoured: data[ 3 ],
				laid: data[ 4 ], hatched: data[ 5 ], granary: data[ 6 ], queenEnergy: data[ 7 ] / 1000,
			};

		} finally {

			releaseReadback();

		}

		return this.statsData;

	}

}
