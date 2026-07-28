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
	positionLocal, float, uint, vec2, vec3, vec4,
	cos, sin, length, min, max, pow, select, hash,
	atomicAdd, atomicSub,
} from 'three/tsl';

import { GRID, WORLD, NEST, MAX_BROOD, params, gfx } from './config.js';
import { tryAcquireReadback, releaseReadback } from './readback.js';
import {
	buildNest, growNest, nestParams,
	LAYERS, K_MAX, DEPTH_SIZE as NEST_DEPTH_SIZE,
} from './nest.js';
import {
	buildCorridorNetwork, buildCorridorNetworkAsync,
	CORRIDOR_SAMPLES, CORRIDOR_SURFACE_TRACKS, validateNetwork,
} from './navigation/corridor-network.js';
import { createNestMutationQueue } from './navigation/nest-mutation-transaction.js';
import { colonyTroughSnapshot, troughRenderDepth } from './colony-layout.js';

const TEXEL = WORLD / GRID;

export function colonyEggRandom01( seed, ordinal, stream ) {

	let value = (
		( seed | 0 )
		^ Math.imul( ( ordinal | 0 ) + 1, 0x9E3779B9 )
		^ Math.imul( ( stream | 0 ) + 1, 0x85EBCA6B )
	) >>> 0;
	value ^= value >>> 16;
	value = Math.imul( value, 0x7FEB352D ) >>> 0;
	value ^= value >>> 15;
	value = Math.imul( value, 0x846CA68B ) >>> 0;
	value ^= value >>> 16;
	return value / 0x100000000;

}

export function planHatchActivation( { hatched, activatedHatch, antCount, maxPopulation } ) {

	const normalizedHatched = Math.max( 0, Math.floor( Number( hatched ) || 0 ) );
	const normalizedActivated = Math.max( 0, Math.floor( Number( activatedHatch ) || 0 ) );
	const pendingHatch = Math.max( 0, normalizedHatched - normalizedActivated );
	const availableSlots = Math.max(
		0,
		Math.floor( Number( maxPopulation ) || 0 ) - Math.max( 0, Math.floor( Number( antCount ) || 0 ) ),
	);
	return {
		activateCount: Math.min( pendingHatch, availableSlots ),
		pendingHatch,
	};

}

export function validateHatchActivationResult( requested, activated ) {

	const requestedCount = Math.max( 0, Math.floor( Number( requested ) || 0 ) );
	if (
		! Number.isSafeInteger( activated )
		|| activated < 0
		|| activated > requestedCount
	) {

		throw new RangeError(
			`activateAnts must resolve to an integer between 0 and ${ requestedCount }`,
		);

	}
	return activated;

}

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

const navigationOptions = ( source ) => ( {
	samples: CORRIDOR_SAMPLES,
	maxNodes: MAX_NODES,
	tunnelWidth: source.tunnelW,
	agentRadiusWorld: 0.45 * 1.45,
	safetyWorld: 0.05,
} );

function surfaceWorkerOptions( options = {} ) {

	return {
		maxSurfaceWorkers: options.maxSurfaceWorkers,
		surfaceWorkerTimeoutMs: options.surfaceWorkerTimeoutMs,
		surfaceWorkerFactory: options.surfaceWorkerFactory,
	};

}

function mutationCommitHook( options = {} ) {

	const hook = typeof options === 'function' ? options : options.beforeCommit;
	if ( hook !== undefined && typeof hook !== 'function' )
		throw new TypeError( 'beforeCommit must be a function' );
	return hook;

}

function createNestLayout(
	initialNest, initialNavigation = null, asyncWorkerOptions = {},
) {

	let nest = initialNest;
	const mutationQueue = createNestMutationQueue();
	const workerOptions = surfaceWorkerOptions( asyncWorkerOptions );

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

	// Réseau intrinsèque 3D. Une ligne de corridorTexture correspond à une
	// arête (son id est le nœud enfant) et contient des échantillons à longueur
	// d'arc uniforme : (x grille, z grille, profondeur monde, marge de voie).
	let navigation = null;
	const corridorData = new Float32Array( MAX_NODES * CORRIDOR_SAMPLES * 4 );
	const corridorFrameData = new Float32Array( MAX_NODES * CORRIDOR_SAMPLES * 4 );
	const corridorSurfaceData = new Float32Array(
		MAX_NODES * CORRIDOR_SAMPLES * CORRIDOR_SURFACE_TRACKS * 4 );
	const corridorSurfaceSupportData = new Float32Array(
		MAX_NODES * CORRIDOR_SAMPLES * CORRIDOR_SURFACE_TRACKS * 4 );
	const corridorMetaData = new Float32Array( MAX_NODES * 4 );
	const navNodeData = new Float32Array( MAX_NODES * 4 );
	const corridorTexture = new THREE.DataTexture(
		corridorData, CORRIDOR_SAMPLES, MAX_NODES, THREE.RGBAFormat, THREE.FloatType );
	const corridorFrameTexture = new THREE.DataTexture(
		corridorFrameData, CORRIDOR_SAMPLES, MAX_NODES, THREE.RGBAFormat, THREE.FloatType );
	const corridorSurfaceTexture = new THREE.DataTexture(
		corridorSurfaceData, CORRIDOR_SAMPLES * CORRIDOR_SURFACE_TRACKS,
		MAX_NODES, THREE.RGBAFormat, THREE.FloatType );
	const corridorSurfaceSupportTexture = new THREE.DataTexture(
		corridorSurfaceSupportData, CORRIDOR_SAMPLES * CORRIDOR_SURFACE_TRACKS,
		MAX_NODES, THREE.RGBAFormat, THREE.FloatType );
	const corridorMetaTexture = new THREE.DataTexture(
		corridorMetaData, MAX_NODES, 1, THREE.RGBAFormat, THREE.FloatType );
	const navNodeTexture = new THREE.DataTexture(
		navNodeData, MAX_NODES, 1, THREE.RGBAFormat, THREE.FloatType );
	for ( const texture of [
		corridorTexture, corridorFrameTexture, corridorSurfaceTexture, corridorSurfaceSupportTexture,
		corridorMetaTexture, navNodeTexture,
	] ) {

		texture.minFilter = texture.magFilter = THREE.NearestFilter;
		texture.generateMipmaps = false;

	}

	// champ de navigation : distance BFS à chaque objectif, PAR (cellule,
	// canal) — 4 textures (grenier, reine, couvain, sortie), rebakées à chaque
	// changement du nid (publish)

	const layout = {
		depthTexture, navTexture, nodeTexture,
		corridorTexture, corridorFrameTexture, corridorSurfaceTexture, corridorSurfaceSupportTexture,
		corridorMetaTexture, navNodeTexture,
		origin: nest.origin,
		LAYERS, MAX_NODES, CORRIDOR_SAMPLES, CORRIDOR_SURFACE_TRACKS,
	};
	const publishListeners = new Set();
	layout.onPublished = ( listener ) => {

		if ( typeof listener !== 'function' )
			throw new TypeError( 'Nest publish listener must be a function' );
		publishListeners.add( listener );
		return () => publishListeners.delete( listener );

	};

	const compileNavigation = ( source ) => buildCorridorNetwork(
		source, navigationOptions( source ) );
	const compileNavigationAsync = ( source ) => buildCorridorNetworkAsync( source, {
		...navigationOptions( source ),
		...workerOptions,
	} );

	function assertValidNavigation( candidate ) {

		const verdict = validateNetwork( candidate );
		if ( ! verdict.ok )
			throw new Error( `Invalid navigation candidate: ${ verdict.errors.join( '; ' ) }` );

	}

	function assertAppendOnlyNavigation( previous, candidate ) {

		assertValidNavigation( candidate );
		const fail = ( part, index ) => {

			throw new Error( `Nest growth changed occupied navigation (${ part } ${ index })` );

		};
		const oldNodes = previous.nodes.length;
		for ( let i = 0; i < oldNodes; i ++ ) {

			const a = previous.nodes[ i ], b = candidate.nodes[ i ];
			if ( ! b || a.x !== b.x || a.y !== b.y || a.depth !== b.depth || a.parent !== b.parent )
				fail( 'node', i );

		}
		for ( let edge = 1; edge < oldNodes; edge ++ ) {

			const a = previous.corridors[ edge ], b = candidate.corridors[ edge ];
			if ( ! b || a.from !== b.from || a.to !== b.to || a.length !== b.length
				|| a.safeLane !== b.safeLane || a.maxLaneStretch !== b.maxLaneStretch )
				fail( 'corridor', edge );
			const start = edge * CORRIDOR_SAMPLES * 4;
			const end = start + CORRIDOR_SAMPLES * 4;
			for ( let i = start; i < end; i ++ ) {

				if ( previous.sampleData[ i ] !== candidate.sampleData[ i ] ) fail( 'sample', i );
				if ( previous.frameData[ i ] !== candidate.frameData[ i ] ) fail( 'frame', i );

			}
			const surfaceStart = edge * CORRIDOR_SURFACE_TRACKS * CORRIDOR_SAMPLES * 4;
			const surfaceEnd = surfaceStart + CORRIDOR_SURFACE_TRACKS * CORRIDOR_SAMPLES * 4;
			for ( let i = surfaceStart; i < surfaceEnd; i ++ ) {

				if ( previous.surfaceData[ i ] !== candidate.surfaceData[ i ] ) fail( 'surface', i );
				if ( previous.surfaceSupportData[ i ] !== candidate.surfaceSupportData[ i ] )
					fail( 'surface-support', i );

			}

		}
		for ( let node = 0; node < oldNodes; node ++ ) for ( let goal = 0; goal < previous.maxGoals; goal ++ ) {

			const i = node * previous.maxGoals + goal;
			if ( previous.nextHop[ i ] !== candidate.nextHop[ i ] ) fail( 'route', i );

		}

	}

	function publish( compiled = null ) {

		const n = Math.min( nest.nodes.length, MAX_NODES );
		nodeData.fill( 0 );
		navigation = compiled ?? compileNavigation( nest );
		corridorData.set( navigation.sampleData );
		corridorFrameData.set( navigation.frameData );
		corridorSurfaceData.set( navigation.surfaceData );
		corridorSurfaceSupportData.set( navigation.surfaceSupportData );
		corridorMetaData.set( navigation.metaData );
		navNodeData.set( navigation.nodeData );
		corridorTexture.needsUpdate = true;
		corridorFrameTexture.needsUpdate = true;
		corridorSurfaceTexture.needsUpdate = true;
		corridorSurfaceSupportTexture.needsUpdate = true;
		corridorMetaTexture.needsUpdate = true;
		navNodeTexture.needsUpdate = true;

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

		// champ de navigation : rebaké à chaque changement de forme du nid

		// interface consommee par le reste du projet
		layout.nodes = nest.nodes;
		layout.edges = nest.edges;
		layout.navigation = navigation;
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
		layout.tunnelW = nest.tunnelW;
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

		for ( const listener of publishListeners ) try {

			listener( layout );

		} catch ( error ) {

			console.error( 'Nest publish listener failed', error );

		}

	}

	publish( initialNavigation );

	function commitGrowth( rebuilt, target, candidateNavigation ) {

		// No shared field or public layout state changes before this short commit.
		growNest( nest, target, nest.tunnelW );
		nest.K = target;
		rebuilt.field = nest.field;
		rebuilt.depthAt = nest.depthAt;
		nest = rebuilt;
		publish( candidateNavigation );

	}

	function commitRebuild( fresh, candidateNavigation ) {

		// Keep the DataTexture allocation stable while replacing all of its data.
		nest.field.set( fresh.field );
		fresh.field = nest.field;
		nest = fresh;
		publish( candidateNavigation );

	}

	// Synchronous variants remain explicit for deterministic Node tests and
	// Warden. They refuse to race an in-flight UI transaction.
	layout.growTo = function ( K ) {

		mutationQueue.assertIdle( 'growTo' );
		const target = Math.min( K_MAX, K );
		if ( target <= nest.K ) return false;
		const rebuilt = buildNest( target, nest.depthMax, nest.tunnelW, false );
		const candidateNavigation = compileNavigation( rebuilt );
		assertAppendOnlyNavigation( navigation, candidateNavigation );
		commitGrowth( rebuilt, target, candidateNavigation );
		return true;

	};

	layout.growToAsync = function ( K, options = {} ) {

		const requestedTarget = Math.min( K_MAX, K );
		const beforeCommit = mutationCommitHook( options );
		return mutationQueue.run( async () => {

			if ( requestedTarget <= nest.K ) return false;
			const fromK = nest.K;
			const rebuilt = buildNest(
				requestedTarget, nest.depthMax, nest.tunnelW, false );
			const candidateNavigation = await compileNavigationAsync( rebuilt );
			// Validation happens after the worker result and before touching the
			// cumulative field, textures, topology or public layout properties.
			assertAppendOnlyNavigation( navigation, candidateNavigation );
			if ( beforeCommit ) await beforeCommit( {
				kind: 'growth', fromK, toK: requestedTarget,
			} );
			commitGrowth( rebuilt, requestedTarget, candidateNavigation );
			return true;

		} );

	};

	// RECONSTRUCTION COMPLETE (depth or tunnel width change, with reset).
	layout.rebuild = function () {

		mutationQueue.assertIdle( 'rebuild' );
		const p = nestParams();
		const fresh = buildNest( p.K, p.depthMax, p.tunnelW );
		const candidateNavigation = compileNavigation( fresh );
		assertValidNavigation( candidateNavigation );
		commitRebuild( fresh, candidateNavigation );
		return true;

	};

	layout.rebuildAsync = function ( options = {} ) {

		// Snapshot settings at request time; FIFO serialization preserves order.
		const p = nestParams();
		const beforeCommit = mutationCommitHook( options );
		return mutationQueue.run( async () => {

			const fromK = nest.K;
			const fresh = buildNest( p.K, p.depthMax, p.tunnelW );
			const candidateNavigation = await compileNavigationAsync( fresh );
			assertValidNavigation( candidateNavigation );
			if ( beforeCommit ) await beforeCommit( {
				kind: 'rebuild', fromK, toK: p.K,
			} );
			commitRebuild( fresh, candidateNavigation );
			return true;

		} );

	};

	Object.defineProperties( layout, {
		nestMutationBusy: { enumerable: true, get: () => mutationQueue.busy },
		nestMutationPending: { enumerable: true, get: () => mutationQueue.pending },
	} );

	return layout;

}

export function buildNestLayout() {

	const np = nestParams();
	return createNestLayout( buildNest( np.K, np.depthMax, np.tunnelW ) );

}

export async function buildNestLayoutAsync( workerOptions = {} ) {

	const np = nestParams();
	const nest = buildNest( np.K, np.depthMax, np.tunnelW );
	const asyncOptions = surfaceWorkerOptions( workerOptions );
	const navigation = await buildCorridorNetworkAsync( nest, {
		...navigationOptions( nest ),
		...asyncOptions,
	} );
	return createNestLayout( nest, navigation, asyncOptions );

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
		broodTroughPos: uniform( new THREE.Vector2(
			layout.troughs.brood.x, layout.troughs.brood.y ) ),
		queenTroughPos: uniform( new THREE.Vector2(
			layout.troughs.queen.x, layout.troughs.queen.y ) ),
		queenFloorDepth: uniform( troughRenderDepth( layout, layout.troughs.queen ) ),
		broodFloorDepth: uniform( troughRenderDepth( layout, layout.troughs.brood ) ),
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
	// SCANNER : chaque type d'élément souterrain luit de SA couleur (réglable
	// à l'UI) quand la vue scanner est active — main.js lève aussi le test de
	// profondeur des meshes → visibles à travers la terre
	const uScanFx = uniform( 0 );
	const uScanBroodColor = uniform( new THREE.Color( gfx.scanBroodColor ) );
	const uScanFoodColor = uniform( new THREE.Color( gfx.scanFoodColor ) );

	const broodGeo = new THREE.InstancedBufferGeometry();
	const ico = new THREE.IcosahedronGeometry( 1, 1 );
	broodGeo.index = ico.index;
	broodGeo.attributes = ico.attributes;
	broodGeo.instanceCount = MAX_BROOD;

	const broodMat = new THREE.MeshStandardNodeMaterial( { roughness: 0.35, metalness: 0 } );

	// Eggs start in the royal chamber and are carried to the brood chamber.
	// Both floors are explicit published anchors: overlapping deeper layers can
	// never pull the render down. The closest anchor selects the current layer.
	const floorY = ( pos ) => {

		const queenDistance = length( pos.sub( u.queenTroughPos ) );
		const broodDistance = length( pos.sub( u.broodTroughPos ) );
		return select( broodDistance.lessThanEqual( queenDistance ),
			u.broodFloorDepth, u.queenFloorDepth );

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

	// scanner : le couvain luit de sa couleur dédiée (profondeur levée par
	// main.js en même temps, comme la reine et les ouvrières)
	broodMat.emissiveNode = Fn( () => vec3( uScanBroodColor ).mul( uScanFx ) )();

	// ------------------------------------------------------------------
	// Tas de nourriture des mangeoires (grenier, reine, couvain)
	// ------------------------------------------------------------------
	const foodRead = storage( sim.food.value, 'uint', GRID * GRID );

	const initialTroughs = colonyTroughSnapshot( layout );
	const troughVecs = initialTroughs.map( ( trough ) => new THREE.Vector4(
		trough.x, trough.y, trough.depth, trough.cell,
	) );
	const uTroughs = uniformArray( troughVecs );

	function refreshLayoutAnchors() {

		const troughs = colonyTroughSnapshot( layout );
		u.broodTrough.value = layout.troughs.brood.cell;
		u.broodTroughPos.value.set(
			layout.troughs.brood.x, layout.troughs.brood.y );
		u.queenTroughPos.value.set(
			layout.troughs.queen.x, layout.troughs.queen.y );
		u.queenFloorDepth.value = troughs[ 1 ].depth;
		u.broodFloorDepth.value = troughs[ 2 ].depth;
		for ( let index = 0; index < troughs.length; index ++ ) {

			const trough = troughs[ index ];
			troughVecs[ index ].set(
				trough.x, trough.y, trough.depth, trough.cell );

		}

	}
	const stopLayoutRefresh = layout.onPublished?.( refreshLayoutAnchors );

	const pileGeo = new THREE.InstancedBufferGeometry();
	const hemi = new THREE.SphereGeometry( 1, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2 );
	pileGeo.index = hemi.index;
	pileGeo.attributes = hemi.attributes;
	pileGeo.instanceCount = troughVecs.length;

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
	pileMat.emissiveNode = Fn( () => vec3( uPileColor ).mul( uPileGlow ).mul( 0.5 )
		.add( vec3( uScanFoodColor ).mul( uScanFx ) ) )();

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
	let diagnosticEpoch = 0;
	let manualTick = false;
	const demo = { eggs: 0, larvae: 0, pupae: 0 };   // démographie du couvain (overlay)
	let lastReconcileTick = null;

	const pendingEggs = [];     // positions (texels) en attente de semis

	function queueEggs( n, startOrdinal = spawnedEggs ) {

		const q = layout.chambers.queen;

		for ( let i = 0; i < n; i ++ ) {

			const ordinal = startOrdinal + i;
			const seed = sim.u.seed.value | 0;
			const angle = colonyEggRandom01( seed, ordinal, 0 ) * Math.PI * 2;
			const radius = Math.sqrt( colonyEggRandom01( seed, ordinal, 1 ) ) * 10;
			pendingEggs.push( {
				x: q.x + Math.cos( angle ) * radius,
				y: q.y + Math.sin( angle ) * radius,
			} );

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

		const epoch = diagnosticEpoch;
		if ( ! tryAcquireReadback() ) return;

		try {

			const buf = await renderer.getArrayBufferAsync( broodState.value );
			if ( epoch !== diagnosticEpoch ) return;
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

	async function reconcileStatsAtTick( stats, tick, hooks ) {

		if ( ! stats || typeof stats !== 'object' )
			throw new TypeError( 'stats must be an object' );
		if ( ! params.colony ) return { spawnedEggs, activatedHatch, pendingHatch: 0 };

		const boundaryTick = tick === null || tick === undefined ? null : BigInt( tick );
		if ( boundaryTick !== null && lastReconcileTick !== null && boundaryTick < lastReconcileTick )
			throw new RangeError( 'colony reconciliation ticks must be monotonic' );

		const laid = Math.max( 0, Math.floor( Number( stats.laid ) || 0 ) );
		if ( laid > spawnedEggs ) {

			queueEggs( laid - spawnedEggs, spawnedEggs );
			spawnedEggs = laid;

		}

		const hatched = Math.max( 0, Math.floor( Number( stats.hatched ) || 0 ) );
		const hatchPlan = planHatchActivation( {
			hatched,
			activatedHatch,
			antCount: params.antCount,
			maxPopulation: params.maxPopulation,
		} );
		const { pendingHatch, activateCount: room } = hatchPlan;

		if ( room > 0 && hooks?.activateAnts ) {

			const activated = validateHatchActivationResult(
				room,
				await hooks.activateAnts( room, boundaryTick ),
			);
			activatedHatch += activated;

		}

		u.hatchBlocked.value = params.antCount >= params.maxPopulation ? 1 : 0;
		u.nursesExist.value = params.nurseRatio > 0.001 ? 1 : 0;
		if ( boundaryTick !== null ) lastReconcileTick = boundaryTick;
		return {
			spawnedEggs,
			activatedHatch,
			pendingHatch: Math.max( 0, hatched - activatedHatch ),
		};

	}

	function onStats( stats, hooks ) {

		return reconcileStatsAtTick( stats, null, hooks );

	}

	function stepSimulation( dt ) {

		if ( ! params.colony ) return;

		u.dt.value = dt;
		renderer.compute( kBrood );
		drainEggs();


	}
	function serviceDiagnostics( wallDt ) {

		if ( ! Number.isFinite( wallDt ) || wallDt < 0 )
			throw new RangeError( 'wallDt must be a finite non-negative number' );
		if ( manualTick || ! params.colony ) return;
		pollAccum += wallDt;
		if ( pollAccum < 1.1 ) return;
		pollAccum %= 1.1;
		void pollBrood();

	}

	async function reset() {

		diagnosticEpoch ++;
		spawnedEggs = 0;
		activatedHatch = 0;
		eggRing = 0;
		pendingEggs.length = 0;
		demo.eggs = demo.larvae = demo.pupae = 0;
		pollAccum = 0;
		lastReconcileTick = null;
		await renderer.computeAsync( kClear );

	}

	return {
		u, layout, demo,
		uEggColor, uLarvaColor, uPupaColor,
		uScanFx, uScanBroodColor, uScanFoodColor,
		broodMesh, piles,
		step: stepSimulation, stepSimulation, serviceDiagnostics,
		reset, onStats, reconcileStatsAtTick,
		refreshLayout: refreshLayoutAnchors,
		disposeLayoutBinding: () => stopLayoutRefresh?.(),
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
