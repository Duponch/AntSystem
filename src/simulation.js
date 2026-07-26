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
	exp, cos, sin, sqrt, floor, ceil, fract, pow, abs, atan, max, min, clamp, mix, length, select,
	atomicAdd, atomicSub, atomicLoad, atomicStore, atomicMax,
	textureLoad, textureStore, hash, frameId, PI, PI2,
} from 'three/tsl';

import { GRID, WORLD, TEXEL, MAX_ANTS, MAX_SPIDERS, FIXED, NEST, params, gfx } from './config.js';
import { NAV_UNREACH } from './nest.js';
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

// RNG CPU sans état caché, miroir du contrat déterministe GPU : un résultat
// dépend uniquement de la seed du run, du tick/série et du flux demandé.
function random01( seed, serial, stream ) {

	let x = ( seed ^ Math.imul( serial + 1, 0x9E3779B9 ) ^ Math.imul( stream + 1, 0x85EBCA6B ) ) >>> 0;
	x ^= x >>> 16;
	x = Math.imul( x, 0x7FEB352D ) >>> 0;
	x ^= x >>> 15;
	x = Math.imul( x, 0x846CA68B ) >>> 0;
	x ^= x >>> 16;
	return x / 0x100000000;

}

export class AntSimulation {

	// layout : topologie de la fourmilière souterraine (buildNestLayout de
	// colony.js) — chambres, mangeoires, graphe de navigation, carte de
	// profondeur/praticabilité échantillonnée par le kernel de creusage.
	constructor( renderer, layout ) {

		this.renderer = renderer;
		this.layout = layout;

		// --- uniforms pilotés par l'UI ---
		const u = this.u = {
			tick: uniform( 0 ),
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
			// Durée du clip Attack_Soldier exporté (47 images à 60 fps).
			// ants.js la remplacera par la durée lue dans l'asset.
			soldierAttackDuration: uniform( 47 / 60 ),
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

			// --- PHYSIQUE ---
			// physOn = 0 : chemin cinématique historique, bit à bit (témoin perf).
			// Les vitesses de fourmi vivent en TEXELS/s (comme pos) ; la hauteur,
			// la vitesse verticale et la gravité en UNITÉS MONDE (comme le rendu).
			physOn: uniform( params.physics ? 1 : 0 ),
			gravity: uniform( params.gravity ),
			antAccel: uniform( params.antAccel ),
			groundDrag: uniform( params.groundDrag ),
			airDrag: uniform( params.airDrag ),
			restitution: uniform( params.restitution ),
			wallBounce: uniform( params.wallBounce ),
			biteKnock: uniform( params.biteKnockback / TEXEL ),   // u/s → texels/s
			bitePop: uniform( params.bitePop ),
			deathPop: uniform( params.deathPop ),
			deathFling: uniform( params.deathFling / TEXEL ),
			chargeImpulse: uniform( params.chargeImpulse / TEXEL ),
			landShock: uniform( params.landShock / TEXEL ),
			walkAnim: uniform( params.walkAnim ),
			// --- VIE SOUTERRAINE (micro-gestion) ---
			// simTime : horloge globale de la simulation, seule source du cycle de
			// repos. Repliee modulo 840 s pour ne pas perdre la precision float32
			// (un saut de phase collectif toutes les 14 min, invisible).
			simTime: uniform( 0 ),
			seatScatter: uniform( params.seatScatter ),
			// rayon d'echange a une mangeoire : c'est LUI qui decide de la taille
			// de l'attroupement. A 4 texels tout le monde devait toucher le meme
			// point ; elargi, la foule s'etale sur un disque au lieu d'un point.
			troughReach: uniform( params.troughReach ),
			laneOffset: uniform( params.laneOffset ),
			lazyFrac: uniform( params.lazyFrac ),
			speedSpread: uniform( params.speedSpread ),
			queenScale: uniform( gfx.queenScale ),
		};

		// --- topologie souterraine (uniforms remplis depuis le layout) ---
		// nœuds du graphe : (x, y texels, rayon d'arrivée, 0)
		u.nodeCount = uniform( layout.nodeCount );
		// next-hop et table des nœuds vivent dans des TEXTURES (voir colony.js) :
		// hors du budget de storage buffers, et surtout redimensionnables sans
		// recompiler le noyau — le nid grandit en cours de partie.
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
		u.granaryLayer = uniform( layout.nodes[ layout.GOAL_NODE[ 1 ] ].layer );
		u.granaryNode = uniform( layout.GOAL_NODE[ 1 ] );
		u.troughGranary = uniform( layout.troughs.granary.cell );
		u.troughQueen = uniform( layout.troughs.queen.cell );
		u.troughBrood = uniform( layout.troughs.brood.cell );
		u.broodNode = uniform( layout.GOAL_NODE[ 3 ] );   // nœud du couvain (spawn)
		u.broodLayer = uniform( layout.nodes[ layout.GOAL_NODE[ 3 ] ].layer );
		u.queenNode = uniform( layout.GOAL_NODE[ 2 ] );
		u.queenLayer = uniform( layout.nodes[ layout.GOAL_NODE[ 2 ] ].layer );

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
		//   bits 7-13 = nœud courant du graphe (la navigation suit les arêtes :
		//              « nœud le plus proche » est AMBIGU entre deux tunnels
		//              voisins et coinçait les fourmis contre la terre)
		//   bits 14-15 = nappe/étage souterrain
		//   bits 16-23 = mot de mort (culbute figée)
		//   bit  24    = soldate en train d'attaquer (hystérésis de contact)
		//   bits 25-31 = plancher résolu au pas précédent (pas de 0,25 u, valeur
		//              positive) — détection du creusage sous elle → chute
		//              balistique au lieu d'un rabattement sec
		this.antState = instancedArray( MAX_ANTS, 'uint' );
		// signes vitaux (mono-écrivain : chaque fourmi possède son élément) :
		//   x = venin (0 = saine ; ≥ bitesToKill = morte)
		//   y = horloge de morsure (vivante) / n° de série du cadavre (morte)
		//   z = énergie 0..1 (0 = mort de faim)
		//   w = POLYMORPHE : phase de démarche 0..1 (vivante, pilotée par la
		//       DISTANCE réellement parcourue → zéro patinage) / temps écoulé
		//       depuis la mort en s, plafonné à 8 (morte, horloge de culbute)
		this.antVital = instancedArray( MAX_ANTS, 'vec4' );
		// état DYNAMIQUE (13ᵉ binding du noyau fourmis, budget 16) :
		//   xy = vitesse planaire (TEXELS/s)  — inertie, glissades, projections
		//   z  = hauteur au-dessus du sol local (unités monde, 0 = posée)
		//   w  = vitesse verticale (unités monde/s)
		// Sans ce buffer il n'y a ni masse, ni impact, ni balistique : c'est lui
		// qui remplace `pos += dir·v·dt` par une vraie intégration.
		this.antDyn = instancedArray( MAX_ANTS, 'vec4' );

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
		const { antData, antState, antVital, antDyn, deposit, alarm, food, wall, stats, spiderDamage, spiderAlarm, spiderKills, spiderKillPos } = this;
		const layout = this.layout;

		const cellIndex = ( c ) => c.y.mul( GRID ).add( c.x );

		// --- tables du nid, lues en texture ---
		// nodeAt : (x, y en texels, rayon d'arrivee, nappe)
		const nodeAt = ( i ) => textureLoad( layout.nodeTexture, ivec2( i, int( 0 ) ) );
		// point de controle du tunnel qui MENE a ce noeud (ligne 1 de la table)
		const ctrlAt = ( i ) => textureLoad( layout.nodeTexture, ivec2( i, int( 1 ) ) );

		// Cible de deplacement vers le noeud `h` : tant que la fourmi est plus
		// loin du noeud que ne l'est le point de controle, elle vise ce dernier.
		// Elle EPOUSE ainsi la courbe du tunnel au lieu d'en couper la corde et
		// de racler la terre pleine — les tunnels sont des arcs, plus des droites.
		//
		// Le point de contrôle est rangé sur le nœud ENFANT de l'arête (nest.js) :
		// c'est le milieu de l'arc parent→enfant. En DESCENDANT (n parent → h
		// enfant) on vise ctrlAt(h) ; mais en REMONTANT (n enfant → h parent) il
		// faut viser ctrlAt(n) — l'arc de SON tunnel. Viser ctrlAt(h) dans ce
		// cas, c'est tirer la fourmi sur l'arc de l'AUTRE côté de la chambre
		// cible, à travers les falaises : tout le trafic ascendant s'y cassait
		// (toupies/blocages mesurés par le warden). L'enfant d'une arête est
		// toujours le plus grand des deux indices (registre append-only).
		const hopTarget = ( h, pos, n ) => {

			const child = max( n, h );
			const hn = nodeAt( h );
			const hc = ctrlAt( child );
			const dNode = length( pos.sub( hn.xy ) );
			const dCtrl = length( hc.xy.sub( hn.xy ) );
			return select( dNode.greaterThan( dCtrl.mul( 1.08 ) ), hc.xy, hn.xy );

		};
		// hop : noeud suivant pour aller de `n` vers l'objectif `g`
		const hopOf = ( n, g ) => textureLoad( layout.navTexture, ivec2( n, g ) ).x.add( 0.5 ).toInt();

		// --- réseau intrinsèque 3D -------------------------------------------------
		// antDyn est volontairement polymorphe afin de rester sous la limite WebGPU
		// de 16 storage buffers : en surface (vx,vz,h,vy), sous terre
		// (corridorId,t,profondeur,distanceCumulée). Les courbes et le SDF sont issus
		// de la même source ; aucune projection heightfield n'intervient ici.
		const navNodeAt = ( i ) => textureLoad( layout.navNodeTexture, ivec2( i, int( 0 ) ) );
		const corridorMetaAt = ( i ) => textureLoad( layout.corridorMetaTexture, ivec2( i, int( 0 ) ) );
		const corridorPointAt = ( edge, sample ) =>
			textureLoad( layout.corridorTexture, ivec2( sample, edge ) );
		const smooth01 = ( x ) => {

			const q = clamp( x, 0, 1 );
			return q.mul( q ).mul( float( 3 ).sub( q.mul( 2 ) ) );

		};
		const sampleCorridor = ( edge, t, direction, laneMagnitude ) => {

			const f = clamp( t, 0, 1 ).mul( layout.CORRIDOR_SAMPLES - 1 );
			const i0 = clamp( floor( f ).toInt(), int( 0 ), int( layout.CORRIDOR_SAMPLES - 2 ) );
			const i1 = i0.add( int( 1 ) );
			const p0 = corridorPointAt( edge, i0 );
			const p1 = corridorPointAt( edge, i1 );
			const pBefore = corridorPointAt( edge, max( i0.sub( int( 1 ) ), int( 0 ) ) );
			const pAfter = corridorPointAt( edge,
				min( i1.add( int( 1 ) ), int( layout.CORRIDOR_SAMPLES - 1 ) ) );
			const local = f.sub( i0.toFloat() );
			const center = mix( p0.xyz, p1.xyz, local ).toVar();
			const segment = p1.xy.sub( p0.xy );
			const fallback = select( length( segment ).greaterThan( 1e-5 ),
				segment.div( max( length( segment ), 1e-5 ) ), vec2( 1, 0 ) );
			const tangent0Raw = p1.xy.sub( pBefore.xy );
			const tangent1Raw = pAfter.xy.sub( p0.xy );
			const tangent0 = select( length( tangent0Raw ).greaterThan( 1e-5 ),
				tangent0Raw.div( max( length( tangent0Raw ), 1e-5 ) ), fallback );
			const tangent1 = select( length( tangent1Raw ).greaterThan( 1e-5 ),
				tangent1Raw.div( max( length( tangent1Raw ), 1e-5 ) ), fallback );
			const tangentRaw = mix( tangent0, tangent1, local );
			const tangent = select( length( tangentRaw ).greaterThan( 1e-5 ),
				tangentRaw.div( max( length( tangentRaw ), 1e-5 ) ), fallback ).toVar();
			const fade = smooth01( t.div( 0.12 ) )
				.mul( smooth01( float( 1 ).sub( t ).div( 0.12 ) ) );
			const safeLane = min( laneMagnitude, corridorMetaAt( edge ).w );
			const offset = safeLane.mul( direction ).mul( fade );
			const position = center.xy.add( vec2( tangent.y.negate(), tangent.x ).mul( offset ) );

			return {
				position,
				depth: center.z,
				tangent: tangent.mul( direction ),
			};

		};

		// --- murs packés en bits : bit 0 = mur de SURFACE, bit 1 = creusé ---
		const surfaceWall = ( w ) => w.bitAnd( uint( 1 ) ).notEqual( uint( 0 ) );
		const dug = ( w ) => w.bitAnd( uint( 2 ) ).notEqual( uint( 0 ) );

		// Le stock souterrain ne vit QUE dans les trois cellules de mangeoire.
		// On excluait auparavant toute cellule creusee de la surface — tenable
		// avec un nid de 40 texels de rayon, ca sterilise un quart de la
		// clairiere maintenant qu'il en fait 100 : plus moyen de poser ni de
		// ramasser de la nourriture au-dessus du nid.
		const isTrough = ( ci ) => ci.equal( u.troughGranary.toInt() )
			.or( ci.equal( u.troughQueen.toInt() ) )
			.or( ci.equal( u.troughBrood.toInt() ) );

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

		// Politique de repos UNIQUE, partagée par la simulation, le Warden et le
		// panneau de suivi. Le diagnostic ne doit jamais tenter de deviner après
		// coup pourquoi une fourmi est immobile : il évalue exactement les mêmes
		// hashs, phase, garde-fous de faim/transport et état de la reine.
		const restStateOf = ( antId, carrying, hungry, isNurse ) => {

			const period = hash( antId.add( uint( 0xC10C ) ) ).mul( 14 ).add( 6 );
			const phase = fract( u.simTime.add(
				hash( antId.add( uint( 0xC10D ) ) ).mul( 97 ) ).div( period ) );
			const lazy = hash( antId.add( uint( 0x1A21 ) ) ).lessThan( u.lazyFrac );
			const duty = select( lazy, float( 0.82 ),
				hash( antId.add( uint( 0xC10E ) ) ).mul( u.lazyFrac ).mul( 0.5 ) );
			const queenFed = atomicLoad( stats.element( 7 ) ).toFloat().div( 1000 ).greaterThan( 0.55 );
			const allowed = carrying.not().and( hungry.not() ).and( isNurse.not().or( queenFed ) );
			const resting = phase.lessThan( duty ).and( allowed );
			const remaining = select( resting, duty.sub( phase ).mul( period ), float( 0 ) );

			return { period, phase, duty, allowed, resting, remaining };

		};

		this.restStateOf = restStateOf;

		// MOT DE MORT (8 bits, rangés dans antState bits 16-23) : tiré UNE FOIS,
		// à l'instant de la mort, il fige la culbute d'un cadavre.
		//   bits 0-1  quadrant de repos  0 sur pattes · 1 flanc · 2 dos · 3 flanc
		//   bits 2-3  demi-tours supplémentaires pendant la chute
		//   bits 4-6  tangage final (8 pas)
		//   bit  7    sens de rotation
		// Un insecte mort finit RAREMENT sur ses pattes : la flexion des pattes
		// (voir la pose de mort bakée dans vat.js) déplace son centre de masse
		// au-dessus du polygone de sustentation et il bascule. D'où la
		// distribution : 14 % debout, 86 % flanc ou dos.
		const makeDeathWord = ( iseed ) => {

			const r0 = hash( iseed.add( uint( 0xD1E ) ) );
			const restQ = select( r0.lessThan( 0.14 ), uint( 0 ),
				select( r0.lessThan( 0.47 ), uint( 1 ),
					select( r0.lessThan( 0.80 ), uint( 2 ), uint( 3 ) ) ) );
			const spinN = hash( iseed.add( uint( 0xD1F ) ) ).mul( 2.999 ).toUint();
			const pitchQ = hash( iseed.add( uint( 0xD20 ) ) ).mul( 7.999 ).toUint();
			const dirS = select( hash( iseed.add( uint( 0xD21 ) ) ).lessThan( 0.5 ), uint( 1 ), uint( 0 ) );

			return restQ
				.bitOr( spinN.shiftLeft( uint( 2 ) ) )
				.bitOr( pitchQ.shiftLeft( uint( 4 ) ) )
				.bitOr( dirS.shiftLeft( uint( 7 ) ) );

		};

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
				const dyn0 = vec4( 0 ).toVar();

				If( isQueen, () => {

					// la reine naît (et renaît) au fond de la chambre royale
					pos.assign( u.queenPos.add( vec2( cos( around ), sin( around ) )
						.mul( hash( i.add( uint( 531 ) ) ).mul( 4 ) ) ) );
					// souterraine, etat 0, sans objectif, sur la nappe de sa chambre
					st.assign( uint( 8 ).bitOr( u.queenNode.toUint().shiftLeft( uint( 7 ) ) )
						.bitOr( u.queenLayer.toUint().shiftLeft( uint( 14 ) ) ) );
					dyn0.z.assign( navNodeAt( u.queenNode.toInt() ).z );

				} ).ElseIf( u.colonyOn.greaterThan( 0.5 )
					.and( isNurse.or( u.spawnMode.greaterThan( 0.5 ) ) ), () => {

					// nourrices et nouvelles écloses : chambre du couvain
					const radius = sqrt( hash( i.add( uint( 531 ) ) ) ).mul( u.broodR.mul( 0.6 ) );
					pos.assign( u.broodPos.add( vec2( cos( around ), sin( around ) ).mul( radius ) ) );
					// nourrice → navette grenier ; éclose d'une autre caste → sortie ;
					// nœud courant = chambre de couvain
					const goal = select( isNurse, uint( 1 ), uint( 4 ) );
					st.assign( uint( 8 ).bitOr( goal.shiftLeft( uint( 4 ) ) )
						.bitOr( u.broodNode.toUint().shiftLeft( uint( 7 ) ) )
						.bitOr( u.broodLayer.toUint().shiftLeft( uint( 14 ) ) ) );
					dyn0.z.assign( navNodeAt( u.broodNode.toInt() ).z );

				} ).Else( () => {

					// disque de surface autour du nid (comportement historique)
					const radius = sqrt( hash( i.add( uint( 531 ) ) ) ).mul( u.nestRadius.mul( 0.8 ) );
					pos.assign( u.nest.add( vec2( cos( around ), sin( around ) ).mul( radius ) ) );
					st.assign( uint( 0 ) );

				} );

				antData.element( instanceIndex ).assign( vec4(
					pos, hash( i.add( uint( 923 ) ) ).mul( PI2 ), 0,
				) );
				// st est construit de zéro : le MOT DE MORT (bits 11+) repart donc
				// à 0 — une fourmi éclose qui recycle un slot n'hérite pas de la
				// culbute de l'ancienne occupante.
				antState.element( instanceIndex ).assign( st );
				antVital.element( instanceIndex ).assign( vec4(
					0, 0, hash( i.add( uint( 4409 ) ) ).mul( 0.5 ).add( 0.5 ),
					hash( i.add( uint( 7717 ) ) ),      // phase de démarche désynchronisée
				) );
				antDyn.element( instanceIndex ).assign( dyn0 );

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

				// la carte porte 4 planchers superposes : la cellule est praticable
				// des qu'UNE nappe y a une cavite (la navigation est 2D, seule la
				// hauteur de rendu depend de la nappe)
				const t = textureLoad( layout.depthTexture, ivec2( lx, ly ) );
				const anyDug = min( min( t.x, t.y ), min( t.z, t.w ) );

				If( anyDug.lessThan( - 1e-4 ), () => {

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
					.add( u.tick.toUint().mul( uint( 0x9E3779B9 ) ) )
					.add( u.seed.toUint().mul( uint( 2654435761 ) ) );
				const a = antData.element( instanceIndex );

				// dépacking d'antState : état, niveau, objectif, nœud (voir constructor)
				const stPacked = antState.element( instanceIndex );
				const state = stPacked.bitAnd( uint( 7 ) ).toVar();
				const under = stPacked.shiftRight( uint( 3 ) ).bitAnd( uint( 1 ) ).toVar();
				const goal = stPacked.shiftRight( uint( 4 ) ).bitAnd( uint( 7 ) ).toVar();
				// 7 bits de noeud (128 max) : le graphe du nid grandit avec la colonie,
				// les 4 bits d'origine ne tenaient que 16 noeuds.
				const node = stPacked.shiftRight( uint( 7 ) ).bitAnd( uint( 127 ) ).toVar();
				// NAPPE courante (2 bits) : a quel etage superpose la fourmi se trouve.
				// Ne sert qu'a savoir a quelle HAUTEUR la dessiner — la navigation,
				// elle, reste strictement 2D.
				const layer = stPacked.shiftRight( uint( 14 ) ).bitAnd( uint( 3 ) ).toVar();
				// MOT DE MORT (bits 11-18) : figé à l'instant de la mort, il décrit
				// la culbute (quadrant de repos, tours, tangage, sens). Il DOIT être
				// relu ici et ré-inclus au re-pack, sinon tous les cadavres
				// repartiraient à zéro dès la frame suivante.
				const deathWord = stPacked.shiftRight( uint( 16 ) ).bitAnd( uint( 255 ) ).toVar();
				const wasAttacking = stPacked.shiftRight( uint( 24 ) ).bitAnd( uint( 1 ) )
					.notEqual( uint( 0 ) );

				const pos = a.xy.toVar();
				const pos0 = a.xy.toVar();          // origine du pas : distance réelle → démarche
				const ang = a.z.toVar();
				const timer = min( a.w.add( u.dt ), 600 ).toVar();
				const carrying = state.equal( uint( 1 ) ).toVar();

				// --- état dynamique : vitesse planaire, hauteur, vitesse verticale ---
				const dyn = antDyn.element( instanceIndex );
				const vel = select( under.equal( uint( 0 ) ), dyn.xy, vec2( 0 ) ).toVar();
				const height = select( under.equal( uint( 0 ) ), dyn.z, float( 0 ) ).toVar();
				const vHeight = select( under.equal( uint( 0 ) ), dyn.w, float( 0 ) ).toVar();
				const navEdge = select( under.equal( uint( 1 ) ), dyn.x, float( 0 ) ).toVar();
				const navT = select( under.equal( uint( 1 ) ), dyn.y, float( 0 ) ).toVar();
				const navFloor = select( under.equal( uint( 1 ) ), dyn.z, float( 0 ) ).toVar();
				const navDistance = select( under.equal( uint( 1 ) ), dyn.w, float( 0 ) ).toVar();
				const phys = u.physOn.greaterThan( 0.5 );

				// alive = vivante (drapeau flottant) : cadavres ET dévorées restent figés.
				const alive = select( state.lessThan( uint( 2 ) ), float( 1 ), float( 0 ) ).toVar();

				// signes vitaux : venin, horloge/série, énergie, phase/horloge de mort
				const vital = antVital.element( instanceIndex );
				const venom = vital.x.toVar();
				const biteClock = vital.y.toVar();
				const energy = vital.z.toVar();
				const gait = vital.w.toVar();       // vivante : phase 0..1 ; morte : s depuis la mort

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
				const attacking = float( 0 ).toVar();
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

							// ONDE DE CHOC (mode 3) : une araignee qui retombe de son bond bouscule
							// PHYSIQUEMENT tout ce qui l'entoure. Les fourmis sont projetees en
							// eventail, celles qui sont pile dessous decollent. C'est l'impact le
							// plus brutal du jeu, et il ne casse rien : il ne concerne jamais la
							// proie deja tenue aux crochets.
							If( phys.and( alive.greaterThan( 0.5 ) ).and( sp.z.greaterThan( 2.5 ) )
								.and( dSp.lessThan( sp.w ) ), () => {

								const f = float( 1 ).sub( dSp.div( max( sp.w, 0.001 ) ) );
								vel.addAssign( away.div( dSp ).mul( f.mul( u.landShock ) ) );
								vHeight.addAssign( f.mul( u.landShock ).mul( TEXEL ).mul( 0.45 ) );
								height.addAssign( 0.001 );

							} );

							// réactions des VIVANTES près d'une araignée
							If( alive.greaterThan( 0.5 ).and( dSp.lessThan( u.fleeRadius ) ), () => {

								const w = float( 1 ).sub( dSp.div( u.fleeRadius ) );

								If( soldier, () => {

									// soldates : CHARGENT, morsures au contact du corps
									rage.assign( max( rage, w ) );
									fleeDir.subAssign( away.div( dSp ).mul( w ) );

									// Le clip démarre au contact réel (< 13), puis reste actif
									// jusqu'à 16 texels pour ne pas papilloter lors des rebonds.
									If( dSp.lessThan( float( 13 ) )
										.or( wasAttacking.and( dSp.lessThan( float( 16 ) ) ) ), () => {

										attacking.assign( 1 );

									} );

									If( dSp.lessThan( float( 13 ) ), () => {

										atomicAdd( spiderDamage.element( spiderId ), uint( 1 ) );

									} );

									// CHOC DE LA CHARGE : la soldate qui percute le corps de
									// l'araignée encaisse le contre-coup (3ᵉ loi de Newton) —
									// elle rebondit, se replace et recharge. C'est ce qui donne
									// la mêlée qui bouillonne autour du prédateur.
									If( phys.and( dSp.lessThan( contact ) ), () => {

										vel.addAssign( away.div( dSp ).mul( u.chargeImpulse ) );
										vHeight.addAssign( u.chargeImpulse.mul( TEXEL ).mul( 0.35 ) );

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

									const venomBefore = venom.toVar();
									venom.addAssign( u.dt.div( u.biteInterval ) );
									biteClock.assign( 0 );

									// COUP PORTÉ : l'envenimation est continue (le modèle
									// « rester sur la proie »), mais le CROCHET frappe par
									// à-coups. Chaque franchissement d'une dose entière = une
									// vraie frappe.
									// L'impulsion est TANGENTIELLE (perpendiculaire à l'axe
									// araignée→proie) et verticale, jamais radiale : une
									// araignée ne REPOUSSE pas sa proie, elle la tient aux
									// crochets et la SECOUE. Une impulsion radiale éjectait la
									// fourmi entre deux doses et le venin ne montait jamais au
									// seuil létal — mesuré : 1,26 pour un seuil de 2, plus
									// aucune mise à mort. La secousse agite violemment le corps
									// sans le sortir de la portée du prédateur.
									If( phys.and( floor( venom ).greaterThan( floor( venomBefore ) ) ), () => {

										const radial = away.div( dSp );
										const tang = vec2( radial.y.negate(), radial.x );
										const sway = select(
											hash( iseed.add( uint( 0x5AC ) ) ).lessThan( 0.5 ), float( 1 ), float( - 1 ) );
										vel.addAssign( tang.mul( sway ).mul( u.biteKnock ) );
										vHeight.addAssign( u.bitePop );
										height.addAssign( 0.001 );          // décollage franc

									} );

									If( venom.greaterThanEqual( u.bitesToKill ), () => {

										state.assign( uint( 2 ) );
										alive.assign( float( 0 ) );
										// stats[2] = nombre total de mortes = compteur de série des
										// cadavres ; on stocke le numéro de série de CE cadavre dans
										// vital.y (inutilisé une fois morte) pour le cap de cadavres
										const serial = atomicAdd( stats.element( 2 ), uint( 1 ) );
										biteClock.assign( serial.toFloat() );
										atomicAdd( spiderKills.element( spiderId ), uint( 1 ) );

										// mot de mort : quadrant de repos, demi-tours, tangage, sens
										deathWord.assign( makeDeathWord( iseed ) );
										gait.assign( 0 );

										// dernier soubresaut : la proie est lâchée, elle bascule.
										// Projection VOLONTAIREMENT modeste (l'araignée agrippe sa
										// proie, elle ne l'envoie pas valser) — et l'araignée est
										// dirigée vers le point d'ATTERRISSAGE, pas vers le point de
										// mort, sinon elle irait mâcher du vide.
										const kick = away.div( dSp );

										If( phys, () => {

											vel.addAssign( kick.mul( u.deathFling ) );
											vHeight.addAssign( u.deathPop );
											height.addAssign( 0.001 );

										} );

										const flightT = u.deathPop.mul( 2 ).div( max( u.gravity, 1 ) );
										spiderKillPos.element( spiderId ).assign(
											pos.add( kick.mul( u.deathFling ).mul( flightT ).mul( select( phys, 1, 0 ) ) ),
										);

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
						// épuisement : elle s'effondre SUR PLACE (aucune projection),
						// mais bascule quand même en se recroquevillant
						deathWord.assign( makeDeathWord( iseed.add( uint( 0x51A ) ) ) );
						gait.assign( 0 );

					} );

				} );

				// --- collision avec le terrain (partagée vivantes / cadavres) ---
				// Surface : bit 0 (une fourmi enterrée sous un mur fraîchement peint
				// ignore les murs le temps d'en sortir). Sous terre : tout ce qui
				// n'est PAS creusé (bit 1) est de la terre pleine — ET, depuis la
				// règle de CONTINUITÉ, toute colonne dont la cavité n'est pas à
				// hauteur de marche du plancher courant (anti-téléportation).
				//
				// RÈGLE DE CONTINUITÉ DES PLANCHERS. La navigation souterraine est
				// 2D (une cellule est praticable dès qu'UNE nappe y a une cavité),
				// mais la hauteur dépend de la nappe : une fourmi qui entrait dans
				// une colonne creusée sur une AUTRE nappe se retrouvait rabattue
				// verticalement (jusqu'à 16 u mesurés par le warden). Ici on
				// interdit le pas si AUCUNE cavité de la colonne cible n'est à
				// moins de MAX_STEP_U du plancher courant — une rampe est
				// franchissable (pente douce), un plafond/une dalle est un mur.
				const MAX_STEP_U = 0.75;    // hauteur de marche max (u) — ≥ pente des rampes

				// plancher résolu à une colonne (texels) : les 4 nappes
				const depth4At = ( gp ) => {

					const lc = clamp(
						ivec2( gp.x.sub( layout.origin.x ), gp.y.sub( layout.origin.y ) ),
						ivec2( 0 ), ivec2( depthTexSize - 1 ) );
					return textureLoad( layout.depthTexture, lc );

				};

				// PLANCHER COURANT : sur SA nappe si elle y est creusée, sinon la
				// plus profonde disponible (repli cohérent avec le rendu — ne
				// devrait plus arriver, la continuité interdit ces colonnes)
				const curFloor = select( under.equal( uint( 1 ) ), navFloor, float( 0 ) ).toVar();

				If( under.equal( uint( 1 ) ), () => {

					// La profondeur vient de la coordonnée intrinsèque du corridor.
					return;

					const t = depth4At( pos );
					const own = select( layer.equal( uint( 0 ) ), t.x,
						select( layer.equal( uint( 1 ) ), t.y,
							select( layer.equal( uint( 2 ) ), t.z, t.w ) ) ).toVar();
					curFloor.assign( select( own.lessThan( - 1e-4 ), own,
						min( min( t.x, t.y ), min( t.z, t.w ) ) ) );

				} );

				// CREUSAGE SOUS ELLE : si le plancher résolu a chuté de plus d'une
				// marche depuis le pas précédent (le nid grandit et creuse sous
				// les pattes), elle TOMBE en balistique au lieu d'être rabattue
				// d'un coup — la descente devient une chute fluide, pas un saut.
				// Le plancher de référence est rangé dans antState (bits 25-31).
				const prevFloorQ = stPacked.shiftRight( uint( 25 ) ).bitAnd( uint( 127 ) ).toVar();

				If( under.equal( uint( 1 ) ).and( prevFloorQ.greaterThan( uint( 0 ) ) ), () => {

					// Un rebuild conserve les corridors existants ; aucune projection verticale.
					return;

					const drop = prevFloorQ.toFloat().mul( - 0.25 ).sub( curFloor ).toVar();

					If( drop.greaterThan( float( MAX_STEP_U ) ), () => {

						height.addAssign( drop );

					} );

				} );

				// écart entre le plancher courant et la cavité la plus PROCHE en
				// hauteur à la colonne (px, py) — 1e9 si rien n'est creusé
				const floorGapAt = ( px, py ) => {

					const t = depth4At( vec2( px, py ) );
					const g0 = select( t.x.lessThan( - 1e-4 ), abs( t.x.sub( curFloor ) ), float( 1e9 ) );
					const g1 = select( t.y.lessThan( - 1e-4 ), abs( t.y.sub( curFloor ) ), float( 1e9 ) );
					const g2 = select( t.z.lessThan( - 1e-4 ), abs( t.z.sub( curFloor ) ), float( 1e9 ) );
					const g3 = select( t.w.lessThan( - 1e-4 ), abs( t.w.sub( curFloor ) ), float( 1e9 ) );
					return min( min( g0, g1 ), min( g2, g3 ) );

				};

				const startWalled = surfaceWall( wall.element(
					cellIndex( clamp( ivec2( pos ), ivec2( 1 ), ivec2( GRID - 2 ) ) ),
				) ).toVar();

				const blockedAt = ( px, py ) => {

					const c = clamp( ivec2( px, py ), ivec2( 1 ), ivec2( GRID - 2 ) );
					const w = wall.element( cellIndex( c ) );
					const hitWall = select( under.equal( uint( 1 ) ),
						dug( w ).not().or( floorGapAt( px, py ).greaterThan( float( MAX_STEP_U ) ) ),
						surfaceWall( w ).and( startWalled.not() ) );
					const out = px.lessThan( 1 ).or( px.greaterThanEqual( GRID - 1 ) )
						.or( py.lessThan( 1 ) ).or( py.greaterThanEqual( GRID - 1 ) );
					return out.or( hitWall );

				};

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
						node.assign( u.queenNode.toUint() );
						layer.assign( u.queenLayer.toUint() );
						navEdge.assign( 0 );
						navT.assign( 0 );
						navFloor.assign( navNodeAt( u.queenNode.toInt() ).z );
						navDistance.assign( 0 );


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
					// La reine n'emprunte pas d'arête, mais son compteur intrinsèque reste
					// un registre exact de distance pour l'oracle cinématique du Warden.
					navDistance.addAssign( length( pos.sub( pos0 ) ) );


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

						// Navigation v2 : l'objectif choisit une suite d'arêtes précompilée.
						// Aucun nearest-node, flow-field, changement de nappe ou rebond.
						If( goal.equal( uint( 0 ) ), () => {

							goal.assign( select( isNurse, uint( 1 ), uint( 4 ) ) );

						} );

						// Le repos reste un état biologique volontaire. Il ne peut ni modifier
						// la route ni l'orientation et est explicitement exclu des tests de
						// blocage.
						const restingV2 = restStateOf( instanceIndex, carrying, hungry, isNurse ).resting;
						const speedTraitV2 = hash( instanceIndex.add( uint( 0x5E01 ) ) )
							.mul( u.speedSpread ).add( float( 1 ).sub( u.speedSpread.mul( 0.5 ) ) );
						moveMult.assign( float( 0.8 ).mul( speedTraitV2 )
							.mul( select( restingV2, float( 0 ), float( 1 ) ) ).mul( paralysis ) );

						// Cette instruction arrête la construction JS de l'ancien graphe 2.5D
						// tout en conservant le code historique dans le diff pour comparaison.
						return;

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

								const d = length( pos.sub( nodeAt( i ).xy ) )
									.add( select( nodeAt( i ).w.sub( layer.toFloat() ).abs().greaterThan( 0.5 ),
										float( 1e4 ), float( 0 ) ) );

								If( d.lessThan( bestD ), () => {

									bestD.assign( d );
									bestI.assign( i );

								} );

							} );

							node.assign( bestI.toUint() );

						} );

						// RESYNCHRONISATION PÉRIODIQUE (~37 s) : un nœud courant
						// désaccordé (tunnels qui se croisent, changement de nappe
						// dans une chambre partagée) finissait en blocage durable —
						// la fourmi tournait autour d'un objectif inatteignable. On
						// réaligne au nœud le plus proche EN PÉNALISANT les autres
						// nappes, sans aucun bit d'état (fenêtre tirée de l'horloge
						// globale et d'un hash stable).
						const resyncPhase = fract( u.simTime.add(
							hash( instanceIndex.add( uint( 0x3E5C ) ) ).mul( 211 ) ).div( 37 ) );

						If( resyncPhase.lessThan( u.dt.div( 37 ).mul( 1.5 ) ), () => {

							const bestI = int( 0 ).toVar();
							const bestD = float( 1e20 ).toVar();

							Loop( { start: int( 0 ), end: u.nodeCount.toInt(), type: 'int', condition: '<' }, ( { i } ) => {

								const d = length( pos.sub( nodeAt( i ).xy ) )
									.add( select( nodeAt( i ).w.sub( layer.toFloat() ).abs().greaterThan( 0.5 ),
										float( 1e4 ), float( 0 ) ) );

								If( d.lessThan( bestD ), () => {

									bestD.assign( d );
									bestI.assign( i );

								} );

							} );

							node.assign( bestI.toUint() );

						} );

						// saut courant ; nœud atteint → on avance d'une arête.
						// PORTE DE NŒUD : la proximité 2D ne suffit pas — un tunnel
						// qui passe AU-DESSUS d'une chambre validait le nœud alors
						// que la fourmi est à deux étages de lui. Il faut aussi une
						// cavité de la nappe du nœud à hauteur de marche : elle
						// « entre » alors dans la nappe du nœud (montée comme
						// descente) et l'arête est franchie pour de vrai.
						const hop1 = hopOf( node.toInt(), goal.toInt() );
						const hop1Node = nodeAt( hop1 );

						If( length( pos.sub( hop1Node.xy ) ).lessThan( hop1Node.z ), () => {

							const tN = depth4At( pos );
							const lN = hop1Node.w.add( 0.5 ).toUint();
							const dN = select( lN.equal( uint( 0 ) ), tN.x,
								select( lN.equal( uint( 1 ) ), tN.y,
									select( lN.equal( uint( 2 ) ), tN.z, tN.w ) ) ).toVar();

							If( dN.lessThan( - 1e-4 )
								.and( abs( dN.sub( curFloor ) ).lessThan( float( MAX_STEP_U ) ) ), () => {

								layer.assign( lN );
								curFloor.assign( dN );
								node.assign( hop1.toUint() );

							} );

						} );

						// cible : la mangeoire de l'objectif quand on approche de sa
						// chambre, sinon le prochain nœud du graphe (recalculé après
						// la mise à jour du nœud courant)
						const hop = hopOf( node.toInt(), goal.toInt() );
						// NAPPE : plus d'assignation d'office — la règle de continuité
						// (voir blockedAt) fait adopter à la fourmi la nappe de la
						// cavité qu'elle emprunte réellement, au fil des colonnes.
						// Fini le rabattement vertical sur la nappe du nœud visé.
						const goalPos = select( goal.equal( uint( 1 ) ), u.granaryPos,
							select( goal.equal( uint( 2 ) ), u.queenPos,
								select( goal.equal( uint( 3 ) ), u.broodPos,
									nodeAt( int( 0 ) ).xy ) ) ).toVar();

						// SIÈGE PERSONNEL. Toutes les fourmis d'un même objectif visaient
						// EXACTEMENT le même texel (une mangeoire = une cellule) : elles
						// s'empilaient littéralement les unes dans les autres. Chacune vise
						// maintenant son propre point, tiré une fois pour toutes par un hash
						// stable dans un disque autour de la mangeoire — assez petit pour
						// que le rayon d'arrivée (4 texels) reste franchi, donc l'économie
						// est intacte. Racine carrée = distribution uniforme en AIRE, sinon
						// tout le monde se retasse au centre.
						const seatA = hash( instanceIndex.add( uint( 0x5EA7 ) ) );
						const seatB = hash( instanceIndex.add( uint( 0x5EA8 ) ) ).mul( PI2 );
						const seat = goalPos.add(
							vec2( cos( seatB ), sin( seatB ) ).mul( sqrt( seatA ).mul( u.seatScatter ) ) ).toVar();

						const dGoal = length( pos.sub( goalPos ) ).toVar();
						// PORTE D'OBJECTIF : le siège n'est visé que depuis la
						// nappe de l'objectif (à hauteur de marche). Sans ça une
						// fourmi dans un tunnel passant AU-DESSUS du grenier
						// « arrive » en 2D et tourne en rond au plafond de la
						// chambre, sans jamais pouvoir y descendre.
						const goalLayerF = select( goal.equal( uint( 1 ) ), u.granaryLayer,
							select( goal.equal( uint( 2 ) ), u.queenLayer,
								select( goal.equal( uint( 3 ) ), u.broodLayer, float( 0 ) ) ) ).toVar();
						const tG = depth4At( pos );
						const dG = select( goalLayerF.lessThan( 0.5 ), tG.x,
							select( goalLayerF.lessThan( 1.5 ), tG.y,
								select( goalLayerF.lessThan( 2.5 ), tG.z, tG.w ) ) ).toVar();
						const atGoalDoor = dG.lessThan( - 1e-4 )
							.and( abs( dG.sub( curFloor ) ).lessThan( float( MAX_STEP_U ) ) ).toVar();

						// CHAMP DE NAVIGATION (bake BFS à chaque changement du nid,
						// nest.js) : la cible est la colonne voisine dont la distance
						// à l'objectif est la plus faible — la fourmi descend le
						// gradient. La distance retenue à une colonne est le MIN sur
						// les canaux CONTINUS avec son plancher courant (≤ hauteur de
						// marche) : changer de canal est justement ce qui ouvre les
						// routes (puits → tube d'un autre canal) ; lire seulement son
						// canal actuel rendrait ces routes invisibles.
						const navMin = ( tF, tN ) => min( min(
							select( tF.x.lessThan( - 1e-4 ).and( abs( tF.x.sub( curFloor ) ).lessThan( float( MAX_STEP_U ) ) ), tN.x, float( NAV_UNREACH ) ),
							select( tF.y.lessThan( - 1e-4 ).and( abs( tF.y.sub( curFloor ) ).lessThan( float( MAX_STEP_U ) ) ), tN.y, float( NAV_UNREACH ) ) ),
							min(
								select( tF.z.lessThan( - 1e-4 ).and( abs( tF.z.sub( curFloor ) ).lessThan( float( MAX_STEP_U ) ) ), tN.z, float( NAV_UNREACH ) ),
								select( tF.w.lessThan( - 1e-4 ).and( abs( tF.w.sub( curFloor ) ).lessThan( float( MAX_STEP_U ) ) ), tN.w, float( NAV_UNREACH ) ) ) );

						const navAt = ( gp ) => {

							const lc = clamp(
								ivec2( gp.x.sub( layout.origin.x ), gp.y.sub( layout.origin.y ) ),
								ivec2( 0 ), ivec2( depthTexSize - 1 ) );
							const tF = textureLoad( layout.depthTexture, lc );
							const d = float( NAV_UNREACH ).toVar();

							If( goal.equal( uint( 1 ) ), () => {

								d.assign( navMin( tF, textureLoad( layout.navFieldTex[ 0 ], lc ) ) );

							} ).ElseIf( goal.equal( uint( 2 ) ), () => {

								d.assign( navMin( tF, textureLoad( layout.navFieldTex[ 1 ], lc ) ) );

							} ).ElseIf( goal.equal( uint( 3 ) ), () => {

								d.assign( navMin( tF, textureLoad( layout.navFieldTex[ 2 ], lc ) ) );

							} ).Else( () => {

								d.assign( navMin( tF, textureLoad( layout.navFieldTex[ 3 ], lc ) ) );

							} );

							return d;

						};
						const navBest = navAt( pos ).toVar();
						const navDir = vec2( 0 ).toVar();

						for ( const [ ndx, ndy ] of [ [ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ],
							[ 1, 1 ], [ 1, - 1 ], [ - 1, 1 ], [ - 1, - 1 ] ] ) {

							const dN = navAt( pos.add( vec2( ndx, ndy ) ) );

							If( dN.lessThan( navBest ), () => {

								navBest.assign( dN );
								navDir.assign( vec2( ndx, ndy ) );

							} );

						}

						// objectif inaccessible depuis ici (poche fermée — creusage
						// en cours, cas transitoire) : repli sur l'ancien guidage
						const target = select( dGoal.lessThan( 14 ).and( atGoalDoor ),
							seat,
							select( navBest.greaterThanEqual( float( NAV_UNREACH - 1 ) ),
								hopTarget( hop, pos, node ),
								pos.add( navDir ).add( 0.5 ) ) ).toVar();

						// VOIES DE CIRCULATION : un décalage latéral stable, sur la
						// perpendiculaire du trajet. Les montantes et les descendantes se
						// séparent en deux files au lieu de se rentrer dedans au milieu du
						// tunnel. Borné bien en deçà de la demi-largeur praticable.
						If( dGoal.greaterThanEqual( 14 ).or( atGoalDoor.not() ), () => {

							const tv = target.sub( pos );
							const tn = tv.div( max( length( tv ), 0.0001 ) );
							target.addAssign( vec2( tn.y.negate(), tn.x )
								.mul( hash( instanceIndex.add( uint( 0x1A4E ) ) ).sub( 0.5 ).mul( u.laneOffset ) ) );

						} );

						// REPOS. Une part importante d'une vraie colonie ne fait rien à un
						// instant donné (immobilité prolongée mesurée chez plusieurs
						// espèces). Ici c'est surtout ce qui supprime la fourmi qui
						// « tourne sur elle-même » : quand sa course est impossible
						// (grenier vide), elle restait à virer indéfiniment autour de la
						// mangeoire. Le cycle est dérivé de hashs stables + horloge globale
						// — AUCUN bit d'état, AUCUN buffer.
						const period = hash( instanceIndex.add( uint( 0xC10C ) ) ).mul( 14 ).add( 6 );
						const phaseR = fract( u.simTime.add(
							hash( instanceIndex.add( uint( 0xC10D ) ) ).mul( 97 ) ).div( period ) );
						const lazy = hash( instanceIndex.add( uint( 0x1A21 ) ) ).lessThan( u.lazyFrac );
						// le curseur pilote AUSSI la sieste des actives, pour qu'a 0 il
						// n'y ait vraiment plus aucun repos (temoin de comparaison)
						const duty = select( lazy, float( 0.82 ),
							hash( instanceIndex.add( uint( 0xC10E ) ) ).mul( u.lazyFrac ).mul( 0.5 ) );
						// GARDE-FOU : jamais de repos pour une porteuse ni une affamée, et
						// pas pour une nourrice tant que la reine n'est pas rassasiée —
						// sinon la navette s'arrête et la colonie meurt.
						const qFed = atomicLoad( stats.element( 7 ) ).toFloat().div( 1000 ).greaterThan( 0.55 );
						const mayRest = carrying.not().and( hungry.not() ).and( isNurse.not().or( qFed ) );
						const resting = phaseR.lessThan( duty ).and( mayRest ).toVar();

						// virage vers la cible + légère errance (files organiques).
						// AU REPOS ON NE VIRE PAS : sans cette garde, une fourmi immobile
						// continuerait de tourner sur place — le bug qu'on corrige.
						If( resting.not(), () => {

							const dir = vec2( cos( ang ), sin( ang ) );
							const to = target.sub( pos );
							const toN = to.div( max( length( to ), 0.0001 ) );
							const crossZ = dir.x.mul( toN.y ).sub( dir.y.mul( toN.x ) );
							const dotv = dir.x.mul( toN.x ).add( dir.y.mul( toN.y ) );
							ang.addAssign( select( crossZ.greaterThanEqual( 0 ), float( 1 ), float( - 1 ) )
								.mul( u.steer ).mul( 2.6 ).mul( u.dt ).mul( float( 1.3 ).sub( dotv.mul( 0.9 ) ) ) );
							ang.addAssign( hash( iseed.add( uint( 0x77 ) ) ).sub( 0.5 ).mul( 0.9 ).mul( u.dt ) );

						} );

						// DIVERSITÉ DE VITESSE : toutes les souterraines avançaient à
						// exactement 0,8× — d'où l'aspect « banc de poissons ». Chaque
						// fourmi a maintenant son tempérament, stable dans le temps.
						const speedTrait = hash( instanceIndex.add( uint( 0x5E01 ) ) )
							.mul( u.speedSpread ).add( float( 1 ).sub( u.speedSpread.mul( 0.5 ) ) );
						moveMult.assign( float( 0.8 ).mul( speedTrait )
							.mul( select( resting, float( 0 ), float( 1 ) ) ).mul( paralysis ) );

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
						const entry = nodeAt( int( 0 ) ).xy;
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

					// ================== DÉPLACEMENT ==================
					// PHYSIQUE : la vitesse est un ÉTAT persistant, pas une constante
					// recalculée. Le muscle ne place pas la fourmi, il TIRE sa vitesse
					// vers la vitesse voulue (d'où l'inertie : démarrages, arrêts et
					// virages ont une durée). Les impacts s'ajoutent directement à cette
					// vitesse et se dissipent par la friction du sol. Dès qu'elle décolle
					// (h > 0), plus aucun contrôle : c'est un projectile balistique.
					// physOn = 0 rétablit le pas cinématique historique, bit à bit.
					const stepLen = u.moveSpeed.mul( u.dt ).mul( moveMult );
					const disp = vec2( 0 ).toVar();

					// Mouvement intrinsèque 3D : progression scalaire monotone, puis
					// Évaluation de la courbe. La position ne peut structurellement ni
					// couper un virage, ni sortir de la galerie, ni changer d'étage.
					If( under.equal( uint( 1 ) ), () => {

						const remaining = stepLen.toVar();
						const laneMagnitude = hash( instanceIndex.add( uint( 0x1A4E ) ) )
							.mul( u.laneOffset );

						// edge=0 signifie « dans le patch sûr du nœud ». Une fourmi née
						// ailleurs dans la chambre rejoint d'abord son hub, sans snap.
						If( navEdge.lessThan( 0.5 ), () => {

							const here = navNodeAt( node.toInt() );
							const hopRoom = hopOf( node.toInt(), goal.toInt() );
							const atTarget = hopRoom.equal( node.toInt() );
							const seatA = hash( instanceIndex.add( uint( 0x5EA7 ) ) ).mul( PI2 );
							const seatR = sqrt( hash( instanceIndex.add( uint( 0x5EA8 ) ) ) )
								.mul( min( u.seatScatter, here.w.mul( 0.45 ) ) );
							const seat = here.xy.add( vec2( cos( seatA ), sin( seatA ) ).mul( seatR ) );
							const roomTarget = select( atTarget, seat, here.xy );
							const roomDelta = roomTarget.sub( pos ).toVar();
							const roomDistance = length( roomDelta ).toVar();
							const roomStep = min( remaining, roomDistance ).toVar();

							If( roomDistance.greaterThan( 1e-5 ), () => {

								const roomDirection = roomDelta.div( roomDistance );
								pos.addAssign( roomDirection.mul( roomStep ) );
								ang.assign( atan( roomDirection.y, roomDirection.x ) );
								navDistance.addAssign( roomStep );
								remaining.subAssign( roomStep );

							} );

							If( atTarget.not().and( roomDistance.lessThanEqual( stepLen.add( 1e-5 ) ) ), () => {

								pos.assign( here.xy );
								navFloor.assign( here.z );
								const edge = max( node.toInt(), hopRoom );
								const meta = corridorMetaAt( edge );
								const direction = select( meta.x.add( 0.5 ).toInt().equal( node.toInt() ),
									float( 1 ), float( - 1 ) );
								navEdge.assign( edge.toFloat() );
								navT.assign( select( direction.greaterThan( 0 ), float( 0 ), float( 1 ) ) );

							} );

						} );

						If( navEdge.greaterThan( 0.5 ).and( remaining.greaterThan( 1e-6 ) ), () => {

							const edge = navEdge.add( 0.5 ).toInt();
							const meta = corridorMetaAt( edge );
							const reachedNode = select( meta.x.add( 0.5 ).toInt().equal( node.toInt() ), meta.y, meta.x ).add( 0.5 ).toInt();
							const direction = select( meta.x.add( 0.5 ).toInt().equal( node.toInt() ),
								float( 1 ), float( - 1 ) );
							const available = select( direction.greaterThan( 0 ),
								float( 1 ).sub( navT ), navT ).mul( meta.z );
							const travel = min( remaining, available ).toVar();
							navT.addAssign( direction.mul( travel.div( max( meta.z, 1e-5 ) ) ) );
							navT.assign( clamp( navT, 0, 1 ) );
							navDistance.addAssign( travel );

							const sampled = sampleCorridor( edge, navT, direction, laneMagnitude );
							pos.assign( sampled.position );
							navFloor.assign( sampled.depth );
							ang.assign( atan( sampled.tangent.y, sampled.tangent.x ) );

							If( available.lessThanEqual( remaining.add( 1e-5 ) ), () => {

								node.assign( reachedNode.toUint() );
								layer.assign( nodeAt( reachedNode ).w.add( 0.5 ).toUint() );
								navEdge.assign( 0 );
								navT.assign( 0 );
								const reached = navNodeAt( reachedNode );
								pos.assign( reached.xy );
								navFloor.assign( reached.z );

							} );

						} );

					} );
					If( phys.and( under.equal( uint( 0 ) ) ), () => {

						const grounded = height.lessThanEqual( 1e-4 ).and( vHeight.lessThanEqual( 0 ) );
						const vDes = vec2( cos( ang ), sin( ang ) ).mul( u.moveSpeed.mul( moveMult ) );

						If( grounded, () => {

							height.assign( 0 );
							vHeight.assign( 0 );
							// relaxation exponentielle vers la vitesse voulue : c'est à la
							// fois le moteur et la friction (une fourmi projetée retrouve
							// sa marche en ~1/antAccel seconde, en dérapant d'abord)
							vel.addAssign( vDes.sub( vel ).mul( clamp( u.antAccel.mul( u.dt ), 0, 1 ) ) );

						} ).Else( () => {

							vHeight.subAssign( u.gravity.mul( u.dt ) );
							height.addAssign( vHeight.mul( u.dt ) );
							vel.mulAssign( exp( u.airDrag.negate().mul( u.dt ) ) );

							If( height.lessThanEqual( 0 ), () => {

								// impact au sol : rebond amorti, l'horizontale prend le choc
								height.assign( 0 );
								vHeight.assign( vHeight.negate().mul( u.restitution ) );
								If( vHeight.lessThan( 0.3 ), () => {

									vHeight.assign( 0 );

								} );
								vel.mulAssign( 0.55 );

							} );

						} );

						disp.assign( vel.mul( u.dt ) );

					} ).ElseIf( under.equal( uint( 0 ) ), () => {

						disp.assign( vec2( cos( ang ), sin( ang ) ).mul( stepLen ) );

					} );

					// sous-pas de ≤ 1 texel pour ne pas traverser les murs minces
					const dispLen = select( phys, length( disp ), stepLen ).toVar();
					const nSub = select( under.equal( uint( 1 ) ), int( 0 ),
						clamp( ceil( dispLen ).toInt(), int( 1 ), int( 16 ) ) ).toVar();
					const subStep = disp.div( max( nSub.toFloat(), 1 ) ).toVar();
					// en mode historique la vitesse ne doit PAS être touchée par les
					// rebonds (elle n'est pas utilisée) : le facteur vaut alors 1
					const bounceF = select( phys, u.wallBounce.negate(), float( 1 ) ).toVar();

					Loop( { start: int( 0 ), end: nSub, type: 'int', condition: '<' }, () => {

						const next = pos.add( subStep ).toVar();
						const bx = blockedAt( next.x, pos.y ).toVar();
						const by = blockedAt( pos.x, next.y ).toVar();

						If( bx.or( by ), () => {

							// réflexion par axe : le cap ET la vitesse rebondissent
							// (miroir du pas : identique au calcul historique par l'angle)
							If( bx, () => {

								ang.assign( PI.sub( ang ) );
								subStep.x.mulAssign( - 1 );
								vel.x.mulAssign( bounceF );

							} );
							If( by, () => {

								ang.assign( ang.negate() );
								subStep.y.mulAssign( - 1 );
								vel.y.mulAssign( bounceF );

							} );
							next.assign( pos.add( subStep ) );

						} );

						// coin en diagonale : on reste sur place et on repart au hasard
						If( blockedAt( next.x, next.y ), () => {

							next.assign( pos );
							ang.assign( hash( iseed.add( uint( 0xC2B2AE35 ) ) ).mul( PI2 ) );
							subStep.assign( vec2( 0 ) );
							vel.mulAssign( select( phys, float( 0 ), float( 1 ) ) );

						} );

						pos.assign( next );

					} );

					// ADOPTION DE NAPPE GUIDÉE PAR L'OBJECTIF : à colonne nouvelle,
					// parmi les cavités à hauteur de marche (≤ MAX_STEP_U — la
					// continuité du mouvement en garantit toujours une), on prend
					// celle dont la distance À L'OBJECTIF est la plus faible.
					// Prendre systématiquement la plus proche en hauteur gardait
					// la fourmi sur un canal SANS ISSUE à 0,3 u alors que le chemin
					// passait par un canal voisin à 0,7 u (mesuré : porteuses en
					// oscillation 66 s à deux colonnes du chemin). Repli : la plus
					// proche en hauteur.
					If( under.equal( uint( 1 ) ), () => {

						// v2 porte directement la profondeur et l'arête ; aucun canal à adopter.
						return;

						const t = depth4At( pos );
						const lcA = clamp(
							ivec2( pos.x.sub( layout.origin.x ), pos.y.sub( layout.origin.y ) ),
							ivec2( 0 ), ivec2( depthTexSize - 1 ) );
						const tN = vec4( float( NAV_UNREACH ) ).toVar();

						If( goal.equal( uint( 1 ) ), () => {

							tN.assign( textureLoad( layout.navFieldTex[ 0 ], lcA ) );

						} ).ElseIf( goal.equal( uint( 2 ) ), () => {

							tN.assign( textureLoad( layout.navFieldTex[ 1 ], lcA ) );

						} ).ElseIf( goal.equal( uint( 3 ) ), () => {

							tN.assign( textureLoad( layout.navFieldTex[ 2 ], lcA ) );

						} ).Else( () => {

							tN.assign( textureLoad( layout.navFieldTex[ 3 ], lcA ) );

						} );

						const bestD = float( NAV_UNREACH ).toVar();
						const bestC = uint( 4 ).toVar();      // 4 = aucun candidat

						for ( const [ fC, dC, iC ] of [
							[ t.x, tN.x, uint( 0 ) ], [ t.y, tN.y, uint( 1 ) ],
							[ t.z, tN.z, uint( 2 ) ], [ t.w, tN.w, uint( 3 ) ] ] ) {

							If( fC.lessThan( - 1e-4 )
								.and( abs( fC.sub( curFloor ) ).lessThan( float( MAX_STEP_U ) ) )
								.and( dC.lessThan( bestD ) ), () => {

								bestD.assign( dC );
								bestC.assign( iC );

							} );

						}

						If( bestC.lessThan( uint( 4 ) ), () => {

							layer.assign( bestC );
							curFloor.assign( select( bestC.equal( uint( 0 ) ), t.x,
								select( bestC.equal( uint( 1 ) ), t.y,
									select( bestC.equal( uint( 2 ) ), t.z, t.w ) ) ) );

						} ).Else( () => {

							// repli : la cavité la plus proche en hauteur (aucun
							// canal continu — ne devrait pas arriver)
							const g0 = select( t.x.lessThan( - 1e-4 ), abs( t.x.sub( curFloor ) ), float( 1e9 ) );
							const g1 = select( t.y.lessThan( - 1e-4 ), abs( t.y.sub( curFloor ) ), float( 1e9 ) );
							const g2 = select( t.z.lessThan( - 1e-4 ), abs( t.z.sub( curFloor ) ), float( 1e9 ) );
							const g3 = select( t.w.lessThan( - 1e-4 ), abs( t.w.sub( curFloor ) ), float( 1e9 ) );
							const gBest = min( min( g0, g1 ), min( g2, g3 ) ).toVar();

							If( gBest.lessThan( 1e8 ), () => {

								layer.assign( select( gBest.equal( g0 ), uint( 0 ),
									select( gBest.equal( g1 ), uint( 1 ),
										select( gBest.equal( g2 ), uint( 2 ), uint( 3 ) ) ) ) );
								curFloor.assign( select( gBest.equal( g0 ), t.x,
									select( gBest.equal( g1 ), t.y,
										select( gBest.equal( g2 ), t.z, t.w ) ) ) );

							} );

						} );

					} );

					// --- événements ---
					If( under.equal( uint( 1 ) ).and( u.colonyOn.greaterThan( 0.5 ) ), () => {

						// ================== ARRIVÉES SOUTERRAINES ==================
						const dGranary = length( pos.sub( u.granaryPos ) );
						const dQueenT = length( pos.sub( u.queenPos ) );
						const dBroodT = length( pos.sub( u.broodPos ) );

						// PORTES DE MANGEOIRE : livrer ou manger exige d'être sur la
						// nappe de la mangeoire, à hauteur de marche d'elle — sinon
						// une fourmi « livrerait » depuis le tunnel du dessus
						const tE = depth4At( pos );
						const doorAt = ( lf ) => {

							const dE = select( lf.lessThan( 0.5 ), tE.x,
								select( lf.lessThan( 1.5 ), tE.y,
									select( lf.lessThan( 2.5 ), tE.z, tE.w ) ) ).toVar();
							return dE.lessThan( - 1e-4 )
								.and( abs( dE.sub( curFloor ) ).lessThan( float( MAX_STEP_U ) ) );

						};
						const doorG = node.equal( u.granaryNode.toUint() );
						const doorQ = node.equal( u.queenNode.toUint() );
						const doorB = node.equal( u.broodNode.toUint() );

						If( goal.equal( uint( 1 ) ).and( dGranary.lessThan( u.troughReach ) ).and( doorG ), () => {

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
						If( goal.equal( uint( 2 ) ).and( dQueenT.lessThan( u.troughReach ) ).and( doorQ ), () => {

							If( state.equal( uint( 1 ) ), () => {

								atomicAdd( food.element( u.troughQueen.toInt() ), uint( 1 ) );
								state.assign( uint( 0 ) );

							} );
							goal.assign( uint( 1 ) );

						} );

						If( goal.equal( uint( 3 ) ).and( dBroodT.lessThan( u.troughReach ) ).and( doorB ), () => {

							If( state.equal( uint( 1 ) ), () => {

								atomicAdd( food.element( u.troughBrood.toInt() ), uint( 1 ) );
								state.assign( uint( 0 ) );

							} );
							goal.assign( uint( 1 ) );

						} );

						// sortie : au nœud d'entrée (profondeur ≈ 0) → surface, bits
						// hauts remis à zéro (INVARIANT araignées, voir antState)
						If( goal.equal( uint( 4 ) ), () => {

							const dExit = length( pos.sub( nodeAt( int( 0 ) ).xy ) );

							If( node.equal( uint( 0 ) ).and( dExit.lessThan( u.entranceR ) ), () => {

								under.assign( uint( 0 ) );
								goal.assign( uint( 0 ) );
								node.assign( uint( 0 ) );
								layer.assign( uint( 0 ) );
								timer.assign( 0 );          // elle sort du nid : fraîcheur pleine
								vel.assign( vec2( cos( ang ), sin( ang ) ).mul( u.moveSpeed ) );
								height.assign( 0 );
								vHeight.assign( 0 );


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
						const foodOk = foodHere.greaterThan( uint( 0 ) )
							.and( foodHere.lessThan( uint( 0x80000000 ) ) )
							.and( isTrough( ci ).not() ).toVar();

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

									const dEntry = length( pos.sub( nodeAt( int( 0 ) ).xy ) );

									If( dEntry.lessThan( u.entranceR ), () => {

										under.assign( uint( 1 ) );
										goal.assign( uint( 1 ) );   // au grenier (manger / navette)
										node.assign( uint( 0 ) );   // départ : tête de spirale
									navEdge.assign( 0 );
									navT.assign( 0 );
									navFloor.assign( navNodeAt( int( 0 ) ).z );
									navDistance.assign( 0 );


									} );

								} );

							} );

						} ).Else( () => {

							If( dNest.lessThan( u.nestRadius ), () => {

								If( u.colonyOn.greaterThan( 0.5 ), () => {

									// COLONIE : la porteuse passe par l'entrée et va déposer
									// sa bille au grenier (la livraison est comptée en bas)
									const dEntry = length( pos.sub( nodeAt( int( 0 ) ).xy ) );

									If( dEntry.lessThan( u.entranceR ), () => {

										under.assign( uint( 1 ) );
										goal.assign( uint( 1 ) );
										node.assign( uint( 0 ) );   // départ : tête de spirale
									navEdge.assign( 0 );
									navT.assign( 0 );
									navFloor.assign( navNodeAt( int( 0 ) ).z );
									navDistance.assign( 0 );

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

				// L'attaque est pilotée par le temps et possède son propre cycle.
				// Entrée et sortie repartent de la première pose de leur clip.
				If( attacking.greaterThan( 0.5 ), () => {

					gait.assign( select( wasAttacking,
						fract( gait.add( u.dt.div( max( u.soldierAttackDuration, 1e-4 ) ) ) ),
						float( 0 ) ) );

				} ).ElseIf( wasAttacking, () => {

					gait.assign( 0 );

				} ).Else( () => {

					// --- DÉMARCHE : la phase du cycle de marche avance avec la DISTANCE
					// réellement parcourue, jamais avec le temps. Fin du patinage : une
					// fourmi bloquée contre un mur cesse de pédaler, une envenimée traîne
					// vraiment la patte, une soldate a une foulée plus ample.
					// Allométrie de la fourmi : longueur de foulée ∝ v^0,42 (donc cadence
					// ∝ v^0,58, somme = 1). À vitesse nominale la formule redonne
					// EXACTEMENT l'ancienne cadence moveSpeed·walkAnim·0,14.
					If( phys, () => {

						const distW = length( pos.sub( pos0 ) ).mul( TEXEL );
						const vRef = max( u.moveSpeed.mul( TEXEL ), 1e-4 );
						const ratio = distW.div( max( u.dt, 1e-4 ) ).div( vRef );
						const sFac = clamp( pow( max( ratio, 1e-4 ), 0.4232 ), 0.35, 1.8 );
						const strMul = select( isQueen, u.queenScale,
							select( isSoldier, float( 1.45 ),
								select( isNurse, float( 0.85 ),
									select( isScout, float( 0.92 ), float( 1 ) ) ) ) );
						const stride = float( TEXEL )
							.div( max( u.walkAnim, 0.05 ).mul( 0.14 ) ).mul( sFac ).mul( strMul );
						gait.assign( fract( gait.add( distW.div( max( stride, 1e-4 ) ) ) ) );

					} );

				} );
				// normalisation de l'angle dans [0, 2π)
				ang.assign( ang.sub( floor( ang.div( PI2 ) ).mul( PI2 ) ) );

				a.assign( vec4( pos, ang, timer ) );

				} ); // fin If(alive) — reste du comportement

				// ================== CADAVRE : chute, rebond, glissade ==================
				// Le cadavre n'est plus figé à l'instant de la mort : il retombe,
				// rebondit, dérape et s'immobilise là où la physique le mène. Sa
				// position reste dans antData — donc l'araignée qui vient le dévorer
				// le trouve VRAIMENT, et la hitbox de débogage ne ment pas.
				If( phys.and( under.equal( uint( 0 ) ) )
					.and( alive.lessThan( 0.5 ) ).and( state.equal( uint( 2 ) ) ), () => {

					gait.assign( min( gait.add( u.dt ), 8 ) );   // horloge de culbute

					If( height.greaterThan( 0 ).or( vHeight.greaterThan( 0 ) ), () => {

						vHeight.subAssign( u.gravity.mul( u.dt ) );
						height.addAssign( vHeight.mul( u.dt ) );
						vel.mulAssign( exp( u.airDrag.negate().mul( u.dt ) ) );

						If( height.lessThanEqual( 0 ), () => {

							height.assign( 0 );
							vHeight.assign( vHeight.negate().mul( u.restitution ) );
							If( vHeight.lessThan( 0.25 ), () => {

								vHeight.assign( 0 );

							} );
							vel.mulAssign( 0.45 );

						} );

					} ).Else( () => {

						height.assign( 0 );
						vHeight.assign( 0 );
						// un cadavre ne glisse pas longtemps : chitine contre mousse
						vel.mulAssign( exp( u.groundDrag.mul( 2.4 ).negate().mul( u.dt ) ) );

					} );

					const cn = pos.add( vel.mul( u.dt ) ).toVar();

					If( blockedAt( cn.x, cn.y ), () => {

						cn.assign( pos );
						vel.assign( vec2( 0 ) );

					} );

					pos.assign( cn );
					a.assign( vec4( pos, ang, timer ) );

				} );
				If( under.equal( uint( 1 ) ).and( state.equal( uint( 2 ) ) ), () => {

					gait.assign( min( gait.add( u.dt ), 8 ) );

				} );


				// --- écriture finale : état re-packé + signes vitaux + dynamique ---
				// (aussi pour les mortes : le cap de cadavres et la dévoration font
				// évoluer leur état)
				// plancher résolu courant, bits 25-31 (pas de 0,25 u, valeur
				// positive) : la référence de la détection de creusage sous elle
				const floorQ = select( under.equal( uint( 1 ) ),
					clamp( curFloor.negate().mul( 4 ).add( 0.5 ), float( 0 ), float( 127 ) ).toUint(),
					uint( 0 ) );
				antState.element( instanceIndex ).assign(
					state.bitOr( under.shiftLeft( uint( 3 ) ) )
						.bitOr( goal.shiftLeft( uint( 4 ) ) )
						.bitOr( node.shiftLeft( uint( 7 ) ) )
						.bitOr( layer.shiftLeft( uint( 14 ) ) )
						.bitOr( deathWord.shiftLeft( uint( 16 ) ) )
						.bitOr( select( isSoldier.and( state.lessThan( uint( 2 ) ) )
							.and( attacking.greaterThan( 0.5 ) ),
							uint( 1 ).shiftLeft( uint( 24 ) ), uint( 0 ) ) )
						.bitOr( floorQ.shiftLeft( uint( 25 ) ) ),
				);
				antVital.element( instanceIndex ).assign( vec4( venom, biteClock, energy, gait ) );
				If( under.equal( uint( 1 ) ), () => {

					antDyn.element( instanceIndex ).assign( vec4( navEdge, navT, navFloor, navDistance ) );

				} ).Else( () => {

					antDyn.element( instanceIndex ).assign( vec4( vel, height, vHeight ) );

				} );

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
			const isDug = i.toInt().equal( u.troughGranary.toInt() )
				.or( i.toInt().equal( u.troughQueen.toInt() ) )
				.or( i.toInt().equal( u.troughBrood.toInt() ) );
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
					const isDug = isTrough( gi.toInt() );

					If( s.w.lessThan( 0.5 ), () => {

						// nourriture en VRAIES billes : une bille = une cellule, au
						// centre jitteré de son bloc (même formule que le rendu des
						// billes dans graphics/foodballs.js). Jamais sur une cellule
						// creusée : son stock appartient au grenier souterrain.
						If( wallHere.bitAnd( uint( 1 ) ).equal( uint( 0 ) )
							.and( isTrough( gi.toInt() ).not() ), () => {

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

							If( isTrough( gi.toInt() ).not(), () => {

								atomicStore( food.element( gi ), uint( 0 ) );

							} );

						} );

					} ).Else( () => {

						// gomme : efface le mur de surface (bit 0) et la nourriture de
						// surface — le réseau creusé et le grenier restent intacts
						wall.element( gi ).assign( wall.element( gi ).bitAnd( uint( 0xFFFFFFFE ) ) );

						If( isTrough( gi.toInt() ).not(), () => {

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
		this._clock = 0;
		this._tick = 0;
		this._regenSerial = 0;
		this.u.tick.value = 0;
		this._brushQueue.length = 0;
		this._regenAccum = 0;
		this.statsData = { delivered: 0, picked: 0, eaten: 0, devoured: 0, laid: 0, hatched: 0, granary: 0, queenEnergy: 1 };
		await this.init();

	}

	// Le nid a change (croissance ou reconstruction) : republier ce qui en derive
	// et re-creuser. Les positions des trois mangeoires, elles, ne bougent JAMAIS
	// — c'est l'invariant du registre (nest.js) qui garantit que les stocks de
	// nourriture atomiques ne deviennent pas orphelins.

	// Barrière rare utilisée par les transactions de géométrie. Aucun readback
	// n'est nécessaire sur WebGPU : on attend simplement la fin des commandes
	// déjà soumises avant de remplacer les textures partagées.
	async synchronize() {

		// computeAsync force d'abord la soumission de l'encodeur interne Three.js,
		// puis attend sa fin. onSubmittedWorkDone() seul ne vide pas cet encodeur.
		await this.renderer.computeAsync( this.kClearSpiderAlarm );

	}

	applyLayout() {

		const l = this.layout;
		this.u.nodeCount.value = l.nodeCount;
		this.u.granaryNode.value = l.GOAL_NODE[ 1 ];
		this.u.granaryPos.value.set( l.troughs.granary.x, l.troughs.granary.y );
		this.u.queenPos.value.set( l.troughs.queen.x, l.troughs.queen.y );
		this.u.broodPos.value.set( l.troughs.brood.x, l.troughs.brood.y );
		this.u.troughGranary.value = l.troughs.granary.cell;
		this.u.troughQueen.value = l.troughs.queen.cell;
		this.u.troughBrood.value = l.troughs.brood.cell;
		this.u.broodNode.value = l.GOAL_NODE[ 3 ];
		this.u.queenNode.value = l.GOAL_NODE[ 2 ];
		this.u.broodLayer.value = l.nodes[ l.GOAL_NODE[ 3 ] ].layer;
		this.u.queenLayer.value = l.nodes[ l.GOAL_NODE[ 2 ] ].layer;
		this.u.granaryLayer.value = l.nodes[ l.GOAL_NODE[ 1 ] ].layer;
		this.u.granaryR.value = l.chambers.granary.R;
		this.u.queenR.value = l.chambers.queen.R;
		this.u.broodR.value = l.chambers.brood1.R;
		this.renderer.compute( this.kDig );

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
		this._tick = ( this._tick || 0 ) + 1;
		this.u.tick.value = this._tick;
		this._clock = ( ( this._clock || 0 ) + dt ) % 840;
		this.u.simTime.value = this._clock;
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
				const serial = this._regenSerial ++;
				const seed = this.u.seed.value | 0;
				const angle = random01( seed, serial, 0 ) * Math.PI * 2;
				const dist = 150 + random01( seed, serial, 1 ) * 280;
				this.queueBrush(
					NEST.x + Math.cos( angle ) * dist,
					NEST.y + Math.sin( angle ) * dist,
					0,
					7 + random01( seed, serial, 2 ) * 5,
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
