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

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, uniformArray, instancedArray, instanceIndex,
	float, int, uint, vec2, vec3, vec4, ivec2, uvec2,
	exp, cos, sin, sqrt, floor, ceil, max, min, clamp, mix, length, select,
	atomicAdd, atomicSub, atomicLoad, atomicStore, atomicMax,
	textureLoad, textureStore, hash, frameId, PI, PI2,
} from 'three/tsl';

import { GRID, MAX_ANTS, MAX_SPIDERS, FIXED, NEST, params, gfx } from './config.js';

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

	constructor( renderer ) {

		this.renderer = renderer;

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
		};

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
		this.antData = instancedArray( MAX_ANTS, 'vec4' );
		this.antState = instancedArray( MAX_ANTS, 'uint' );        // 0 exploratrice, 1 porteuse

		this.deposit = instancedArray( GRID * GRID * 2, 'uint' ).toAtomic(); // accumulateur virgule fixe
		this.alarm = instancedArray( GRID * GRID, 'uint' ).toAtomic();       // phéromone d'alarme
		this.food = instancedArray( GRID * GRID, 'uint' ).toAtomic();        // unités de nourriture
		this.wall = instancedArray( GRID * GRID, 'uint' );                   // 0/1
		// [0] livrées, [1] ramassées, [2] croquées, [3..6] morsures par araignée
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
		this._readingStats = false;
		this.statsData = { delivered: 0, picked: 0, eaten: 0 };

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
		const { antData, antState, deposit, alarm, food, wall, stats, spiderDamage } = this;

		const cellIndex = ( c ) => c.y.mul( GRID ).add( c.x );

		// ------------------------------------------------------------------
		// Initialisation des fourmis : disque autour du nid, angles aléatoires
		// ------------------------------------------------------------------
		this.kInitAnts = Fn( () => {

			// reinitFrom > 0 : seules les fourmis nouvellement activées repartent du nid
			If( instanceIndex.toFloat().greaterThanEqual( u.reinitFrom ), () => {

				const i = instanceIndex.add( u.seed.toUint().mul( uint( 2654435761 ) ) );
				const around = hash( i.add( uint( 17 ) ) ).mul( PI2 );
				const radius = sqrt( hash( i.add( uint( 531 ) ) ) ).mul( u.nestRadius.mul( 0.8 ) );

				antData.element( instanceIndex ).assign( vec4(
					u.nest.x.add( cos( around ).mul( radius ) ),
					u.nest.y.add( sin( around ).mul( radius ) ),
					hash( i.add( uint( 923 ) ) ).mul( PI2 ),
					0,
				) );
				antState.element( instanceIndex ).assign( uint( 0 ) );

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

		} )().compute( MAX_SPIDERS );

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
				const st = antState.element( instanceIndex );

				const pos = a.xy.toVar();
				const ang = a.z.toVar();
				const timer = min( a.w.add( u.dt ), 600 ).toVar();
				const carrying = st.equal( uint( 1 ) ).toVar();

				// une fourmi morte (état 2) reste un cadavre figé, jamais retraité
				// (drapeau flottant : 1 = vivante, 0 = cadavre)
				const alive = select( st.notEqual( uint( 2 ) ), float( 1 ), float( 0 ) ).toVar();

				// --- caste : soldate (stable par fourmi, même formule que le rendu) ---
				const soldier = hash( instanceIndex.add( uint( 0xCA57E ) ) ).lessThan( u.soldierRatio ).toVar();

				const panic = float( 0 ).toVar();
				const rage = float( 0 ).toVar();
				const fleeDir = vec2( 0 ).toVar();

				// gardé aussi par spiderCount : sans prédateur, on n'accède JAMAIS aux
				// secteurs (données potentiellement périmées côté headless/bench)
				If( alive.greaterThan( 0.5 ).and( u.spiderCount.greaterThan( 0 ) ), () => {

					// --- menace : les 2 araignées du secteur de la fourmi (coût constant
					// quel que soit le nombre de prédateurs — grille 8×8) ---
					const sCell = ivec2( pos ).div( int( GRID / 8 ) ).clamp( ivec2( 0 ), ivec2( 7 ) );
					const sBase = sCell.y.mul( int( 8 ) ).add( sCell.x ).mul( int( 2 ) );

					Loop( { start: int( 0 ), end: int( 2 ), type: 'int', condition: '<' }, ( { i: sk } ) => {

						const sp = u.sectorA.element( sBase.add( sk ) );

						If( sp.w.greaterThan( 0 ), () => {

							const away = pos.sub( sp.xy );
							const dSp = max( length( away ), 0.001 );

							If( dSp.lessThan( u.fleeRadius ), () => {

								const w = float( 1 ).sub( dSp.div( u.fleeRadius ) );

								If( soldier, () => {

									// les soldates CHARGENT : cap sur l'araignée, morsures au contact
									rage.assign( max( rage, w ) );
									fleeDir.subAssign( away.div( dSp ).mul( w ) );

									If( alive.greaterThan( 0.5 ).and( dSp.lessThan( sp.w.mul( 1.5 ) ) ), () => {

										const spiderId = u.sectorB.element( sBase.add( sk ) ).x.toInt();
										atomicAdd( spiderDamage.element( spiderId ), uint( 1 ) );

									} );

								} ).Else( () => {

									panic.assign( max( panic, w ) );
									fleeDir.addAssign( away.div( dSp ).mul( w ) );

								} );

								// frappe : la fourmi est TUÉE → cadavre figé sur place
								// (probabilité < 1 : certaines échappent aux crochets). Le
								// garde « alive » évite qu'une 2e araignée du secteur re-tue
								// et double-compte une fourmi déjà morte au slot précédent.
								If( alive.greaterThan( 0.5 ).and( sp.z.greaterThan( 0.5 ) ).and( dSp.lessThan( sp.w ) )
									.and( hash( iseed.add( uint( 0x2545F491 ) ) ).lessThan( 0.6 ) ), () => {

									st.assign( uint( 2 ) );
									alive.assign( float( 0 ) );
									atomicAdd( stats.element( 2 ), uint( 1 ) );

								} );

							} );

						} );

					} );

				} );

				// --- reste du comportement, sauté pour les cadavres (fraîchement
				// tués ou déjà morts) : la fourmi reste figée à sa position ---
				If( alive.greaterThan( 0.5 ), () => {

				// --- phéromone d'alarme : déposée par les paniquées (les soldates
				// en laissent aussi : elle RECRUTE les autres soldates au combat) ---
				const alarmLevel = max( panic, rage.mul( 0.7 ) );

				If( alarmLevel.greaterThan( 0.12 ), () => {

					const cellA = ivec2( pos );
					atomicMax( alarm.element( cellIndex( cellA ) ), alarmLevel.mul( FIXED ).toUint() );

				} );

				// --- capteurs : 3 cônes de 3×3 texels sur la carte recherchée ---
				// (canal B du champ : nourriture si > 0, mur si < 0 ; A = halo, ignoré)
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
							// porteuse → suit la carte « maison » (R) ; exploratrice → « nourriture » (G)
							// murs (B négatif) répulsifs ; alarme (B positif) : les ouvrières
							// l'évitent, les soldates y foncent (recrutement au combat)
							const alarmS = clamp( t.z, 0, 1 );
							w = w.add( select( carrying, t.x, t.y ) )
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

				// errance permanente — réduite quand on porte : la porteuse s'engage
				// sur la piste au lieu de zigzaguer (asymétrie des modèles de référence)
				const r2 = hash( iseed.add( uint( 0x85EBCA6B ) ) );
				const wander = u.wander.mul( select( carrying, 0.5, 1 ) );
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

				// --- déplacement + rebond sur murs / bords (réflexion par axe) ---
				// une fourmi enterrée sous un mur fraîchement peint ignore les murs
				// (mais pas les bords) le temps d'en sortir
				const startWalled = wall.element(
					cellIndex( clamp( ivec2( pos ), ivec2( 1 ), ivec2( GRID - 2 ) ) ),
				).greaterThan( uint( 0 ) ).toVar();

				const blockedAt = ( px, py ) => {

					const c = clamp( ivec2( px, py ), ivec2( 1 ), ivec2( GRID - 2 ) );
					const hitWall = wall.element( cellIndex( c ) ).greaterThan( uint( 0 ) )
						.and( startWalled.not() );
					const out = px.lessThan( 1 ).or( px.greaterThanEqual( GRID - 1 ) )
						.or( py.lessThan( 1 ) ).or( py.greaterThanEqual( GRID - 1 ) );
					return out.or( hitWall );

				};

				// sous-pas de ≤ 1 texel pour ne pas traverser les murs minces
				// (panique ou charge : +45 % de vitesse)
				const stepLen = u.moveSpeed.mul( u.dt ).mul( urgency.mul( 0.45 ).add( 1 ) );
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

				// --- événements : ramassage / livraison / recharge du chrono ---
				const cell = ivec2( pos );
				const ci = cellIndex( cell ).toVar();
				const foodHere = atomicLoad( food.element( ci ) ).toVar();
				const dNest = length( pos.sub( u.nest ) ).toVar();

				If( carrying.not(), () => {

					If( foodHere.greaterThan( uint( 0 ) ).and( foodHere.lessThan( uint( 0x80000000 ) ) ), () => {

						// tentative atomique : si une autre fourmi a pris la dernière
						// unité entre-temps (prev == 0, ou compteur wrappé par une
						// course à trois), on restitue pour que le compteur reconverge.
						const prev = atomicSub( food.element( ci ), uint( 1 ) ).toVar();

						If( prev.equal( uint( 0 ) ).or( prev.greaterThanEqual( uint( 0x80000000 ) ) ), () => {

							atomicAdd( food.element( ci ), uint( 1 ) );

						} ).Else( () => {

							st.assign( uint( 1 ) );
							ang.addAssign( PI );
							timer.assign( 0 );
							atomicAdd( stats.element( 1 ), uint( 1 ) );

						} );

					} ).ElseIf( dNest.lessThan( u.nestRadius ), () => {

						timer.assign( 0 ); // passage au nid : dépôt « maison » rechargé

					} );

				} ).Else( () => {

					If( dNest.lessThan( u.nestRadius ), () => {

						st.assign( uint( 0 ) );
						ang.addAssign( PI );
						timer.assign( 0 );
						atomicAdd( stats.element( 0 ), uint( 1 ) );

					} ).ElseIf( foodHere.greaterThan( uint( 0 ) ).and( foodHere.lessThan( uint( 0x80000000 ) ) ), () => {

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

					atomicMax( deposit.element( ci.mul( 2 ).add( st.toInt() ) ), freshness );

				} );

				// normalisation de l'angle dans [0, 2π)
				ang.assign( ang.sub( floor( ang.div( PI2 ) ).mul( PI2 ) ) );

				a.assign( vec4( pos, ang, timer ) );

				} ); // fin If(alive) — reste du comportement

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

			// marqueurs permanents : la nourriture sature G, le nid sature R
			const foodHere = atomicLoad( food.element( i ) );
			const wallHere = wall.element( i );
			const p = vec2( ix.toFloat(), iy.toFloat() );

			If( foodHere.greaterThan( uint( 0 ) ), () => {

				pher.y.assign( 1 );

			} );
			If( length( p.sub( u.nest ) ).lessThan( u.nestRadius ), () => {

				pher.x.assign( 1 );

			} );
			If( wallHere.greaterThan( uint( 0 ) ), () => {

				pher.assign( vec2( 0 ) );

			} );

			pher.assign( clamp( pher, vec2( 0 ), vec2( 1 ) ) );

			// halo : diffusion itérée (bord exponentiel) réalimentée par les billes
			const foodVis = min( foodHere.toFloat().div( 12 ), 1 );
			const halo = clamp( max( sum.z.div( 9 ).mul( u.haloSpread ), foodVis ), 0, 1 );

			// alarme : injection (max) puis évanouissement rapide, sans diffusion
			const aDep = atomicLoad( alarm.element( i ) );
			atomicStore( alarm.element( i ), uint( 0 ) );
			const alarmV = clamp( max(
				clamp( center4.z, 0, 1 ).sub( u.alarmDecay.mul( u.dt ) ),
				aDep.toFloat().div( FIXED ),
			), 0, 1 );

			// packing : B = alarme (+) / mur (−), A = halo
			const bPacked = select( wallHere.greaterThan( uint( 0 ) ), float( - 1 ), alarmV );

			textureStore( writeTex, uvec2( ix, iy ), vec4( pher.x, pher.y, bPacked, halo ) );

		} )().compute( GRID * GRID );

		// ------------------------------------------------------------------
		// Rasterisation des obstacles du décor dans la grille de murs
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

						wall.element( gi ).assign( uint( 1 ) );

					} );

				} ).Else( () => {

					// rectangle orienté (axe = direction de la longueur)
					const along = d.x.mul( B.x ).add( d.y.mul( B.y ) );
					const across = d.x.mul( B.y.negate() ).add( d.y.mul( B.x ) );

					If( along.abs().lessThan( A.z ).and( across.abs().lessThan( A.w ) ), () => {

						wall.element( gi ).assign( uint( 1 ) );

					} );

				} );

			} );

		} )().compute( GRID * GRID );

		const [ tA, tB ] = this.textures;
		this.kAnt = [ makeAntKernel( tA ), makeAntKernel( tB ) ];
		this.kGrid = [ makeGridKernel( tA, tB ), makeGridKernel( tB, tA ) ];

		// ------------------------------------------------------------------
		// Pinceau : nourriture / mur / gomme dans un disque
		// ------------------------------------------------------------------
		this.kBrush = Fn( () => {

			const gi = instanceIndex;
			const p = vec2( gi.mod( uint( GRID ) ).toFloat(), gi.div( uint( GRID ) ).toFloat() );

			Loop( { start: int( 0 ), end: u.stampCount.toInt(), type: 'int', condition: '<' }, ( { i } ) => {

				const s = u.stamps.element( i );          // x, y, rayon, mode
				const d = length( p.sub( s.xy ) );

				If( d.lessThanEqual( s.z ), () => {

					If( s.w.lessThan( 0.5 ), () => {

						// nourriture en VRAIES billes : une bille = une cellule, au
						// centre jitteré de son bloc (même formule que le rendu des
						// billes dans graphics/foodballs.js)
						If( wall.element( gi ).equal( uint( 0 ) ), () => {

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

						// mur — interdit sur et autour du nid
						If( length( p.sub( u.nest ) ).greaterThan( u.nestRadius.add( 10 ) ), () => {

							wall.element( gi ).assign( uint( 1 ) );
							atomicStore( food.element( gi ), uint( 0 ) );

						} );

					} ).Else( () => {

						wall.element( gi ).assign( uint( 0 ) );
						atomicStore( food.element( gi ), uint( 0 ) );

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

		await this._seedFood();

	}

	async reset() {

		this.cur = 0;
		this._brushQueue.length = 0;
		this.statsData = { delivered: 0, picked: 0, eaten: 0 };
		await this.init();

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
		this.renderer.compute( this.kAnt[ this.cur ] );
		this.renderer.compute( this.kGrid[ this.cur ] );
		this.cur ^= 1;

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
	// ----------------------------------------------------------------------

	setSavedWalls( base64OrNull ) {

		this._savedWalls = base64OrNull || null;

	}

	async readWallsBase64() {

		const buf = await this.renderer.getArrayBufferAsync( this.wall.value );
		const cells = new Uint32Array( buf );
		const bits = new Uint8Array( Math.ceil( cells.length / 8 ) );

		for ( let i = 0; i < cells.length; i ++ ) {

			if ( cells[ i ] > 0 ) bits[ i >> 3 ] |= 1 << ( i & 7 );

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

	// ----------------------------------------------------------------------
	// Statistiques (lecture GPU → CPU, non bloquante)
	// ----------------------------------------------------------------------

	// lecture directe, sans garde de concurrence (banc d'essai)
	async readStatsDirect() {

		const buffer = await this.renderer.getArrayBufferAsync( this.stats.value );
		const data = new Uint32Array( buffer );
		return { delivered: data[ 0 ], picked: data[ 1 ], eaten: data[ 2 ] };

	}

	async readStats() {

		if ( this._readingStats ) return this.statsData;
		this._readingStats = true;

		try {

			const buffer = await this.renderer.getArrayBufferAsync( this.stats.value );
			const data = new Uint32Array( buffer );
			this.statsData = { delivered: data[ 0 ], picked: data[ 1 ], eaten: data[ 2 ] };

		} finally {

			this._readingStats = false;

		}

		return this.statsData;

	}

}
