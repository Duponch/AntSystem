// La COLONIE vivante : topologie de la fourmilière souterraine (chambres,
// tunnels, graphe de navigation), couvain (œufs → larves → nymphes →
// éclosions) et poller CPU basse fréquence qui active les fourmis écloses.
//
// Tout le temps-réel est GPU :
//   - le kernel couvain avance les stades et fait manger les larves à la
//     mangeoire (atomicSub sur le buffer de nourriture partagé) ;
//   - la ponte de la reine vit dans le kernel fourmis (stats[4]++) ;
//   - le CPU ne fait que (1) semer les œufs pondus via un PETIT kernel de
//     spawn piloté par uniforms — jamais d'écriture directe des buffers, un
//     upload complet écraserait les transitions GPU en vol — et (2) lire
//     stats/broodState ~1 Hz pour libérer les slots éclos et monter antCount.
//
// La topologie est UNE source de vérité (buildNestLayout) partagée par :
// le kernel fourmis (graphe de navigation, mangeoires), le kernel de
// creusage (texture de profondeur), le rendu (y des fourmis souterraines,
// plancher de la fosse, couvain, tas de nourriture).

import * as THREE from 'three/webgpu';
import {
	Fn, If, uniform, uniformArray, instancedArray, instanceIndex, storage,
	positionLocal, float, uint, vec2, vec3, vec4, ivec2,
	cos, sin, length, min, max, clamp, pow, select, hash,
	atomicAdd, atomicSub, textureLoad,
} from 'three/tsl';

import { GRID, WORLD, NEST, MAX_BROOD, params, gfx } from './config.js';
import { tryAcquireReadback, releaseReadback } from './readback.js';
import {
	buildNest, growNest, nestParams, nestBudget, quantK,
	LAYERS, K_MAX, DEPTH_SIZE as NEST_DEPTH_SIZE, NODE_CHAMBER0, ROOM,
} from './nest.js';

const TEXEL = WORLD / GRID;

// région couverte par la carte de profondeur (voir nest.js)
export const DEPTH_SIZE = NEST_DEPTH_SIZE;
export { LAYERS };

// ---------------------------------------------------------------------------
// Topologie de la fourmilière (déterministe) — unités : TEXELS grille,
// profondeurs : unités MONDE (y négatif).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Topologie de la fourmiliere : elle vient maintenant du REGISTRE (nest.js),
// qui grandit avec la colonie et empile ses cavites sur 4 nappes.
//
// Cette fonction ne fait plus que l'habillage GPU : construire la texture de
// profondeur (4 canaux = 4 planchers superposes), la table de navigation et
// les tables de noeuds, et exposer l'interface que le reste du projet attend.
// La texture est allouee UNE FOIS a sa taille maximale : en creer une nouvelle
// a chaud recompilerait tous les materiaux qui l'echantillonnent.
// ---------------------------------------------------------------------------
const MAX_NODES = 128;                 // 7 bits dans antState
const MAX_GOALS = 8;                   // 3 bits dans antState

export function buildNestLayout() {

	const np = nestParams();
	let nest = buildNest( np.K, np.depthMax, np.tunnelW );

	// carte de profondeur : R,G,B,A = plancher des nappes 0..3 (0 = pas de cavite)
	const depthTexture = new THREE.DataTexture(
		nest.field, DEPTH_SIZE, DEPTH_SIZE, THREE.RGBAFormat, THREE.FloatType );
	depthTexture.minFilter = THREE.NearestFilter;
	depthTexture.magFilter = THREE.NearestFilter;
	depthTexture.generateMipmaps = false;
	depthTexture.needsUpdate = true;

	// table de navigation : ligne = noeud, colonne = objectif -> noeud suivant.
	// En texture et non en uniformArray : la longueur d'un uniformArray est figee
	// a la compilation du shader, or le graphe grandit.
	const navData = new Float32Array( MAX_NODES * MAX_GOALS * 4 );
	const navTexture = new THREE.DataTexture(
		navData, MAX_NODES, MAX_GOALS, THREE.RGBAFormat, THREE.FloatType );
	navTexture.minFilter = navTexture.magFilter = THREE.NearestFilter;
	navTexture.generateMipmaps = false;

	// table des noeuds : ligne 0 = (x, y en texels, rayon d'arrivee, nappe)
	//                    ligne 1 = (point de controle x, y du tunnel d'acces)
	const nodeData = new Float32Array( MAX_NODES * 2 * 4 );
	const nodeTexture = new THREE.DataTexture(
		nodeData, MAX_NODES, 2, THREE.RGBAFormat, THREE.FloatType );
	nodeTexture.minFilter = nodeTexture.magFilter = THREE.NearestFilter;
	nodeTexture.generateMipmaps = false;

	const layout = {
		depthTexture, navTexture, nodeTexture,
		origin: nest.origin,
		LAYERS, MAX_NODES,
	};

	function publish() {

		const n = Math.min( nest.nodes.length, MAX_NODES );
		nodeData.fill( 0 );
		for ( let i = 0; i < n; i ++ ) {

			const nd = nest.nodes[ i ];
			nodeData[ i * 4 ] = nd.x;
			nodeData[ i * 4 + 1 ] = nd.y;
			nodeData[ i * 4 + 2 ] = nd.r;
			nodeData[ i * 4 + 3 ] = nd.layer;
			nodeData[ ( MAX_NODES + i ) * 4 ] = nd.cx;
			nodeData[ ( MAX_NODES + i ) * 4 + 1 ] = nd.cy;

		}
		nodeTexture.needsUpdate = true;

		navData.fill( 0 );
		for ( let g = 0; g < MAX_GOALS; g ++ ) {

			for ( let i = 0; i < n; i ++ ) {

				navData[ ( g * MAX_NODES + i ) * 4 ] = g === 0 ? i : nest.nextHop[ i * 16 + g ];

			}

		}
		navTexture.needsUpdate = true;
		depthTexture.needsUpdate = true;

		// interface consommee par le reste du projet
		layout.nodes = nest.nodes;
		layout.edges = nest.edges;
		layout.nextHop = nest.nextHop;
		layout.GOAL_NODE = nest.GOAL_NODE;
		layout.troughs = nest.troughs;
		layout.field = nest.field;
		layout.depthAt = nest.depthAt;
		layout.nodeCount = n;
		layout.K = nest.K;
		layout.depthMax = nest.depthMax;
		layout.radiusTexels = nest.radiusTexels;
		layout.radiusWorld = nest.radiusWorld;
		layout.units = nest.units;
		layout.parents = nest.parents;
		layout.shaft = nest.shaft;
		layout.entry = nest.entry;
		layout.tunnelW = params.nestTunnelW;
		// chambres remarquables, sous le nom historique
		const nodeOf = ( g ) => nest.nodes[ nest.GOAL_NODE[ g ] ];
		layout.chambers = {
			granary: { ...nodeOf( 1 ), R: nodeOf( 1 ).r * 2 },
			queen: { ...nodeOf( 2 ), R: nodeOf( 2 ).r * 2 },
			brood1: { ...nodeOf( 3 ), R: nodeOf( 3 ).r * 2 },
		};
		layout.chamberDiscs = nest.units.slice( 0, nest.K ).map( ( u ) => ( {
			x: u.x, y: u.y, R: u.R, depth: u.depth, layer: u.layer, type: u.type,
		} ) );

	}

	publish();

	// CROISSANCE : ajoute des loges sans jamais deplacer les anciennes.
	// Renvoie true si quelque chose a change (l'appelant re-creuse et republie).
	layout.growTo = function ( K ) {

		const target = Math.min( K_MAX, K );
		if ( target <= nest.K ) return false;
		growNest( nest, target, params.nestTunnelW );
		nest.K = target;
		// le graphe doit etre recalcule : on rebatit a l'identique (l'invariant
		// garantit que les loges deja creusees retombent aux memes coordonnees)
		// on ne recalcule QUE le graphe : le creusage vient d'etre fait de maniere
		// incrementale ci-dessus, re-creuser tout serait du travail jete
		const rebuilt = buildNest( target, nest.depthMax, params.nestTunnelW, false );
		rebuilt.field = nest.field;              // on garde le creusage cumule
		rebuilt.depthAt = nest.depthAt;
		nest = rebuilt;
		publish();
		return true;

	};

	// RECONSTRUCTION COMPLETE (profondeur ou largeur de tunnel changee, reset)
	layout.rebuild = function () {

		const p = nestParams();
		const fresh = buildNest( p.K, p.depthMax, p.tunnelW );
		nest.field.set( fresh.field );
		fresh.field = nest.field;
		nest = fresh;
		publish();

	};

	return layout;

}

// ---------------------------------------------------------------------------
// Couvain + poller colonie
// ---------------------------------------------------------------------------
export function createColony( { scene, sim, renderer, layout } ) {

	const u = {
		dt: uniform( 0 ),
		eggDuration: uniform( params.eggDuration ),
		larvaMeals: uniform( params.larvaMeals ),
		larvaMealEvery: uniform( params.larvaMealEvery ),
		larvaStarveTime: uniform( params.larvaStarveTime ),
		pupaDuration: uniform( params.pupaDuration ),
		hatchBlocked: uniform( 0 ),          // population au plafond : les nymphes attendent
		nursesExist: uniform( 1 ),           // ≥1 nourrice → les œufs sont transportés au couvain
		broodTrough: uniform( layout.troughs.brood.cell ),
		broodTroughPos: uniform( new THREE.Vector2( layout.troughs.brood.x, layout.troughs.brood.y ) ),
		eggCount: uniform( 0 ),              // œufs à semer cette frame
		eggRing: uniform( 0 ),               // tête de l'anneau d'allocation des slots
	};

	// positions des œufs à semer (remplies par le CPU avant kSpawn)
	const eggVecs = Array.from( { length: 16 }, () => new THREE.Vector4() );
	u.eggPos = uniformArray( eggVecs );

	// broodData : x, y (texels), progrès 0..1 dans le stade, faim (s sans repas)
	// broodState : bits 0-1 = stade (0 vide, 1 œuf, 2 larve, 3 nymphe), bits 2-5 = repas pris
	const broodData = instancedArray( MAX_BROOD, 'vec4' );
	const broodState = instancedArray( MAX_BROOD, 'uint' );

	const { food, stats } = sim;

	// ------------------------------------------------------------------
	// Kernel couvain : avance les stades, nourrit les larves à la mangeoire
	// ------------------------------------------------------------------
	const kBrood = Fn( () => {

		const st = broodState.element( instanceIndex );
		const stage = st.bitAnd( uint( 3 ) ).toVar();

		If( stage.greaterThan( uint( 0 ) ), () => {

			const b = broodData.element( instanceIndex );
			const pos = b.xy.toVar();
			const progress = b.z.toVar();
			const hunger = b.w.toVar();
			const meals = st.shiftRight( uint( 2 ) ).bitAnd( uint( 15 ) ).toVar();

			If( stage.equal( uint( 1 ) ), () => {

				// ŒUF : transporté (abstraction nourrices) vers le couvain, incube
				If( u.nursesExist.greaterThan( 0.5 ), () => {

					const target = u.broodTroughPos.add( vec2(
						hash( instanceIndex.add( uint( 77 ) ) ).sub( 0.5 ).mul( 14 ),
						hash( instanceIndex.add( uint( 191 ) ) ).sub( 0.5 ).mul( 14 ),
					) );
					const to = target.sub( pos );
					const d = max( length( to ), 0.0001 );
					const step = min( u.dt.mul( 2.2 ), d );
					pos.assign( pos.add( to.div( d ).mul( step ) ) );

				} );

				progress.addAssign( u.dt.div( max( u.eggDuration, 0.1 ) ) );

				If( progress.greaterThanEqual( 1 ), () => {

					stage.assign( uint( 2 ) );
					progress.assign( 0 );
					hunger.assign( 0 );
					meals.assign( uint( 0 ) );

				} );

			} ).ElseIf( stage.equal( uint( 2 ) ), () => {

				// LARVE : doit être nourrie (mangeoire du couvain) pour se nymphoser
				hunger.addAssign( u.dt );

				If( hunger.greaterThan( u.larvaMealEvery ).and( meals.toFloat().lessThan( u.larvaMeals ) ), () => {

					// une unité à la mangeoire — restitution si course perdue (wrap u32)
					const prev = atomicSub( food.element( u.broodTrough.toInt() ), uint( 1 ) ).toVar();

					If( prev.equal( uint( 0 ) ).or( prev.greaterThanEqual( uint( 0x80000000 ) ) ), () => {

						atomicAdd( food.element( u.broodTrough.toInt() ), uint( 1 ) );

					} ).Else( () => {

						meals.addAssign( uint( 1 ) );
						hunger.assign( 0 );

					} );

				} );

				If( meals.toFloat().greaterThanEqual( u.larvaMeals ), () => {

					stage.assign( uint( 3 ) );
					progress.assign( 0 );

				} ).ElseIf( hunger.greaterThan( u.larvaStarveTime ), () => {

					stage.assign( uint( 0 ) );   // morte de faim (slot libéré)

				} );

			} ).ElseIf( stage.equal( uint( 3 ) ), () => {

				// NYMPHE : minuteur → éclosion (comptée, slot libéré ; le CPU
				// activera la nouvelle fourmi). Population au plafond : attend.
				progress.addAssign( u.dt.div( max( u.pupaDuration, 0.1 ) ) );

				If( progress.greaterThanEqual( 1 ).and( u.hatchBlocked.lessThan( 0.5 ) ), () => {

					stage.assign( uint( 0 ) );
					atomicAdd( stats.element( 5 ), uint( 1 ) );

				} );

			} );

			b.assign( vec4( pos, progress, hunger ) );
			st.assign( stage.bitOr( meals.shiftLeft( uint( 2 ) ) ) );

		} );

	} )().compute( MAX_BROOD );

	// ------------------------------------------------------------------
	// Semis des œufs pondus (≤16 par frame, slots en anneau, jamais d'upload
	// CPU des buffers : un slot occupé est sauté — retenté au tick suivant)
	// ------------------------------------------------------------------
	const kSpawn = Fn( () => {

		If( instanceIndex.toFloat().lessThan( u.eggCount ), () => {

			const slot = u.eggRing.toUint().add( instanceIndex ).mod( uint( MAX_BROOD ) );

			If( broodState.element( slot ).bitAnd( uint( 3 ) ).equal( uint( 0 ) ), () => {

				const p = u.eggPos.element( instanceIndex );
				broodData.element( slot ).assign( vec4( p.x, p.y, 0, 0 ) );
				broodState.element( slot ).assign( uint( 1 ) );

			} );

		} );

	} )().compute( 16 );

	const kClear = Fn( () => {

		broodState.element( instanceIndex ).assign( uint( 0 ) );
		broodData.element( instanceIndex ).assign( vec4( 0 ) );

	} )().compute( MAX_BROOD );

	// ------------------------------------------------------------------
	// Rendu du couvain : œufs / larves / nymphes (pattern billes de nourriture)
	// ------------------------------------------------------------------
	const uEggColor = uniform( new THREE.Color( gfx.eggColor ) );
	const uLarvaColor = uniform( new THREE.Color( gfx.larvaColor ) );
	const uPupaColor = uniform( new THREE.Color( gfx.pupaColor ) );

	const broodGeo = new THREE.InstancedBufferGeometry();
	const ico = new THREE.IcosahedronGeometry( 1, 1 );
	broodGeo.index = ico.index;
	broodGeo.attributes = ico.attributes;
	broodGeo.instanceCount = MAX_BROOD;

	const broodMat = new THREE.MeshStandardNodeMaterial( { roughness: 0.35, metalness: 0 } );

	const depthOrigin = vec2( layout.origin.x, layout.origin.y );

	// profondeur du plancher au point (texels) — même source que le plancher
	const floorY = ( pos ) => {

		const c = clamp(
			ivec2( pos.sub( depthOrigin ) ),
			ivec2( 0 ), ivec2( DEPTH_SIZE - 1 ),
		);
		// couvain et tas de nourriture : ils vivent dans une chambre donnee, on
		// prend donc la cavite la plus PROFONDE de la colonne (celle qui les
		// porte) plutot que la nappe 0
		const t = textureLoad( layout.depthTexture, c );
		return min( min( t.x, t.y ), min( t.z, t.w ) );

	};

	broodMat.positionNode = Fn( () => {

		const st = broodState.element( instanceIndex );
		const stage = st.bitAnd( uint( 3 ) );
		const b = broodData.element( instanceIndex );

		// gabarit par stade (0 = slot vide → dégénéré, invisible)
		const stageSize = select( stage.equal( uint( 1 ) ), float( 0.14 ),
			select( stage.equal( uint( 2 ) ), float( 0.23 ),
				select( stage.equal( uint( 3 ) ), float( 0.27 ), float( 0 ) ) ) );

		// larve : gonfle avec les repas pris
		const meals = st.shiftRight( uint( 2 ) ).bitAnd( uint( 15 ) ).toFloat();
		const fatten = select( stage.equal( uint( 2 ) ), meals.mul( 0.03 ), float( 0 ) );
		const scale = stageSize.add( fatten );

		const world = vec3(
			b.x.mul( TEXEL ).sub( WORLD / 2 ),
			floorY( b.xy ).add( scale.mul( 0.7 ) ).add( 0.03 ),
			b.y.mul( TEXEL ).sub( WORLD / 2 ),
		);

		// ovoïde orienté par slot (fouillis organique) : yaw stable par hash
		const yaw = hash( instanceIndex.add( uint( 3301 ) ) ).mul( 6.2831853 );
		const c = cos( yaw );
		const s = sin( yaw );
		const lx = positionLocal.x.mul( scale );
		const ly = positionLocal.y.mul( scale.mul( 0.78 ) );
		const lz = positionLocal.z.mul( scale.mul( 1.45 ) );
		const local = vec3(
			lx.mul( c ).add( lz.mul( s ) ),
			ly,
			lz.mul( c ).sub( lx.mul( s ) ),
		);

		return local.add( world );

	} )();

	broodMat.colorNode = Fn( () => {

		const st = broodState.element( instanceIndex );
		const stage = st.bitAnd( uint( 3 ) );
		// larve : plus elle est nourrie, plus elle blanchit (satiété lisible)
		const meals = st.shiftRight( uint( 2 ) ).bitAnd( uint( 15 ) ).toFloat();
		const larva = vec3( uLarvaColor ).mul( meals.mul( 0.09 ).add( 0.85 ) );
		return select( stage.equal( uint( 1 ) ), vec3( uEggColor ),
			select( stage.equal( uint( 2 ) ), larva, vec3( uPupaColor ) ) );

	} )();

	const broodMesh = new THREE.Mesh( broodGeo, broodMat );
	broodMesh.frustumCulled = false;
	scene.add( broodMesh );

	// ------------------------------------------------------------------
	// Tas de nourriture des mangeoires (grenier, reine, couvain)
	// ------------------------------------------------------------------
	const foodRead = storage( sim.food.value, 'uint', GRID * GRID );

	const troughList = [ layout.troughs.granary, layout.troughs.queen, layout.troughs.brood ];
	const troughVecs = troughList.map( ( t ) => new THREE.Vector4(
		t.x, t.y, layout.depthAt( t.x, t.y ), t.cell,
	) );
	const uTroughs = uniformArray( troughVecs );

	const pileGeo = new THREE.InstancedBufferGeometry();
	const hemi = new THREE.SphereGeometry( 1, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2 );
	pileGeo.index = hemi.index;
	pileGeo.attributes = hemi.attributes;
	pileGeo.instanceCount = troughList.length;

	const pileMat = new THREE.MeshStandardNodeMaterial( { roughness: 0.5, metalness: 0 } );
	const uPileColor = uniform( new THREE.Color( gfx.foodColor ) );
	const uPileGlow = uniform( gfx.foodGlow );

	pileMat.positionNode = Fn( () => {

		const t = uTroughs.element( instanceIndex );
		const stock = foodRead.element( t.w.toInt() ).toFloat();
		// tas en racine cubique, plafonné (un grenier plein reste dans sa chambre)
		const scale = pow( min( stock, 400 ), 0.34 ).mul( 0.16 )
			.mul( select( stock.greaterThan( 0.5 ), 1, 0 ) );

		const world = vec3(
			t.x.mul( TEXEL ).sub( WORLD / 2 ),
			t.z.add( 0.02 ),
			t.y.mul( TEXEL ).sub( WORLD / 2 ),
		);

		return positionLocal.mul( scale ).add( world );

	} )();

	pileMat.colorNode = uPileColor;
	pileMat.emissiveNode = Fn( () => vec3( uPileColor ).mul( uPileGlow ).mul( 0.5 ) )();

	const piles = new THREE.Mesh( pileGeo, pileMat );
	piles.frustumCulled = false;
	scene.add( piles );

	// ------------------------------------------------------------------
	// Poller CPU (~1 Hz) : sème les pontes, active les éclosions
	// ------------------------------------------------------------------
	let spawnedEggs = 0;        // œufs semés (vs stats[4] = pontes)
	let activatedHatch = 0;     // fourmis activées (vs stats[5] = éclosions)
	let eggRing = 0;
	let pollAccum = 0;
	let manualTick = false;
	const demo = { eggs: 0, larvae: 0, pupae: 0 };   // démographie du couvain (overlay)

	const pendingEggs = [];     // positions (texels) en attente de semis

	function queueEggs( n ) {

		const q = layout.chambers.queen;

		for ( let i = 0; i < n; i ++ ) {

			const a = Math.random() * Math.PI * 2;
			const r = Math.sqrt( Math.random() ) * 10;
			pendingEggs.push( { x: q.x + Math.cos( a ) * r, y: q.y + Math.sin( a ) * r } );

		}

	}

	// sème jusqu'à 16 œufs en attente (appelé chaque frame, coût nul si vide)
	function drainEggs() {

		if ( pendingEggs.length === 0 ) return;

		const n = Math.min( 16, pendingEggs.length );

		for ( let i = 0; i < n; i ++ ) {

			const e = pendingEggs.shift();
			eggVecs[ i ].set( e.x, e.y, 0, 0 );

		}

		u.eggCount.value = n;
		u.eggRing.value = eggRing;
		eggRing = ( eggRing + n ) % MAX_BROOD;
		renderer.compute( kSpawn );
		u.eggCount.value = 0;

	}

	// lecture du couvain (16 Ko) — DERRIÈRE le verrou readback GLOBAL :
	// deux getArrayBufferAsync concurrents se corrompent mutuellement
	async function pollBrood() {

		if ( ! tryAcquireReadback() ) return;

		try {

			const buf = await renderer.getArrayBufferAsync( broodState.value );
			const st = new Uint32Array( buf );
			let e = 0, l = 0, p = 0;

			for ( let i = 0; i < st.length; i ++ ) {

				const s = st[ i ] & 3;
				if ( s === 1 ) e ++;
				else if ( s === 2 ) l ++;
				else if ( s === 3 ) p ++;

			}

			demo.eggs = e; demo.larvae = l; demo.pupae = p;

		} catch { /* device occupé */ } finally {

			releaseReadback();

		}

	}

	// appliqué aux stats déjà lues par la boucle principale (1×/30 frames) :
	// zéro readback supplémentaire pour la ponte/éclosion
	function onStats( stats, hooks ) {

		if ( ! params.colony ) return;

		// pontes → œufs à semer
		const laid = stats.laid || 0;

		if ( laid > spawnedEggs ) {

			queueEggs( laid - spawnedEggs );
			spawnedEggs = laid;

		}

		// éclosions → activer de nouvelles fourmis (bornées par le plafond)
		const hatched = stats.hatched || 0;

		if ( hatched > activatedHatch ) {

			const room = Math.min(
				hatched - activatedHatch,
				Math.max( 0, Math.floor( params.maxPopulation ) - params.antCount ),
			);

			if ( room > 0 && hooks && hooks.activateAnts ) {

				hooks.activateAnts( room );

			}

			activatedHatch = hatched;   // les éclosions au-delà du plafond sont perdues (assumé)

		}

		u.hatchBlocked.value = params.antCount >= params.maxPopulation ? 1 : 0;
		u.nursesExist.value = params.nurseRatio > 0.001 ? 1 : 0;

	}

	function step( dt ) {

		if ( ! params.colony ) return;

		u.dt.value = dt;
		renderer.compute( kBrood );
		drainEggs();

		pollAccum += dt;

		if ( ! manualTick && pollAccum > 1.1 ) {

			pollAccum = 0;
			pollBrood();

		}

	}

	async function reset() {

		spawnedEggs = 0;
		activatedHatch = 0;
		eggRing = 0;
		pendingEggs.length = 0;
		demo.eggs = demo.larvae = demo.pupae = 0;
		await renderer.computeAsync( kClear );

	}

	return {
		u, layout, demo,
		uEggColor, uLarvaColor, uPupaColor,
		step, reset, onStats,
		setVisible( v ) {

			broodMesh.visible = v;
			piles.visible = v;

		},
		_dbg: {
			broodData, broodState, queueEggs, drainEggs, pollBrood,
			demo, setManualTick( v ) { manualTick = !! v; },
			counters: () => ( { spawnedEggs, activatedHatch, eggRing } ),
		},
	};

}
