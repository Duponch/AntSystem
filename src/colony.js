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

const TEXEL = WORLD / GRID;

// région couverte par la carte de profondeur : carré de 256 texels sur le nid
export const DEPTH_SIZE = 256;

// ---------------------------------------------------------------------------
// Topologie de la fourmilière (déterministe) — unités : TEXELS grille,
// profondeurs : unités MONDE (y négatif).
// ---------------------------------------------------------------------------
export function buildNestLayout() {

	const cx = NEST.x, cy = NEST.y;
	const T = 1 / TEXEL;                 // texels par unité monde

	const P = ( r, angDeg, depth ) => ( {
		x: cx + Math.cos( angDeg * Math.PI / 180 ) * r,
		y: cy + Math.sin( angDeg * Math.PI / 180 ) * r,
		depth,
	} );

	// --- tunnel d'entrée : SPIRALE descendante sous la fourmilière ---
	// (r 8 → 38 texels, 300°, y 0 → −2.2 : lisible en coupe, navigable grâce
	// aux nœuds intermédiaires du graphe. Profondeurs COMPRESSÉES : le socle
	// de terre fait ~3 unités d'épaisseur, les chambres restent au-dessus de
	// son fond — la hiérarchie se lit à la couleur et aux paliers, pas aux
	// mètres.)
	const spiral = [];
	const SPIRAL_SEGS = 14;

	for ( let i = 0; i <= SPIRAL_SEGS; i ++ ) {

		const t = i / SPIRAL_SEGS;
		spiral.push( P(
			8 + t * 30,                        // rayon
			90 + t * 300,                      // angle (départ plein nord)
			- 0.4 - t * 1.8,                   // profondeur
		) );

	}

	const hub = P( 40, 30, - 2.3 );        // carrefour au pied de la spirale
	const granary = P( 78, 150, - 2.7 );   // grenier (stock de la colonie)
	const brood1 = P( 62, 315, - 3.1 );    // chambre de couvain principale
	const brood2 = P( 76, 275, - 3.3 );    // chambre de couvain secondaire
	const queen = P( 60, 55, - 3.9 );      // chambre royale (la plus profonde)

	// --- graphe de navigation (arbre) : 12 nœuds ---
	// 0 entrée (surface), 1-6 spirale (un nœud par ~43° : la CORDE entre deux
	// nœuds consécutifs doit rester DANS le tunnel — à ~85° d'arc la sagitta
	// dépasse la demi-largeur et les fourmis s'écrasent contre la paroi),
	// 7 hub, 8 grenier, 9 couvain-1, 10 couvain-2, 11 reine
	const nodes = [
		{ ...spiral[ 0 ], r: 7 },
		{ ...spiral[ 2 ], r: 6 },
		{ ...spiral[ 4 ], r: 6 },
		{ ...spiral[ 6 ], r: 6 },
		{ ...spiral[ 8 ], r: 6 },
		{ ...spiral[ 10 ], r: 6 },
		{ ...spiral[ 12 ], r: 6 },
		{ ...hub, r: 9 },
		{ ...granary, r: 12 },
		{ ...brood1, r: 9 },
		{ ...brood2, r: 8 },
		{ ...queen, r: 10 },
	];

	const edges = [
		[ 0, 1 ], [ 1, 2 ], [ 2, 3 ], [ 3, 4 ], [ 4, 5 ], [ 5, 6 ], [ 6, 7 ],
		[ 7, 8 ], [ 7, 9 ], [ 9, 10 ], [ 7, 11 ],
	];

	// objectifs : 0 aucun, 1 grenier, 2 reine, 3 couvain, 4 sortie
	const GOAL_NODE = [ - 1, 8, 11, 9, 0 ];

	// table next-hop par BFS depuis chaque nœud-objectif
	const adj = nodes.map( () => [] );
	for ( const [ a, b ] of edges ) { adj[ a ].push( b ); adj[ b ].push( a ); }

	const nextHop = new Float32Array( nodes.length * 8 );

	for ( let goal = 1; goal < GOAL_NODE.length; goal ++ ) {

		const target = GOAL_NODE[ goal ];
		const parent = new Array( nodes.length ).fill( - 1 );
		const queue = [ target ];
		parent[ target ] = target;

		while ( queue.length ) {

			const n = queue.shift();

			for ( const m of adj[ n ] ) {

				if ( parent[ m ] === - 1 ) { parent[ m ] = n; queue.push( m ); }

			}

		}

		for ( let n = 0; n < nodes.length; n ++ ) {

			nextHop[ n * 8 + goal ] = parent[ n ] === - 1 ? n : parent[ n ];

		}

	}

	// --- chambres (disques creusés) et tunnels (polylignes creusées) ---
	const chamberMap = {
		hub: { ...hub, R: 12 },
		granary: { ...granary, R: 20 },
		brood1: { ...brood1, R: 15 },
		brood2: { ...brood2, R: 12 },
		queen: { ...queen, R: 17 },
	};
	const chambers = Object.values( chamberMap );

	const tunnels = [
		{ pts: spiral, w: 6 },
		{ pts: [ hub, granary ], w: 5 },
		{ pts: [ hub, brood1 ], w: 5 },
		{ pts: [ brood1, brood2 ], w: 4.5 },
		{ pts: [ hub, queen ], w: 5 },
	];

	// --- carte de profondeur + praticabilité (256², RGBA float) ---
	// R = profondeur du plancher (y monde, ≤ 0 ; 0 = non creusé)
	// G = praticable (1 = creusé, une fourmi souterraine peut y marcher)
	const ox = cx - DEPTH_SIZE / 2, oy = cy - DEPTH_SIZE / 2;
	const field = new Float32Array( DEPTH_SIZE * DEPTH_SIZE * 4 );

	const carveDisc = ( X, Y, R, depth ) => {

		const bevel = 4;
		const x0 = Math.max( 0, Math.floor( X - ox - R - bevel ) );
		const x1 = Math.min( DEPTH_SIZE - 1, Math.ceil( X - ox + R + bevel ) );
		const y0 = Math.max( 0, Math.floor( Y - oy - R - bevel ) );
		const y1 = Math.min( DEPTH_SIZE - 1, Math.ceil( Y - oy + R + bevel ) );

		for ( let gy = y0; gy <= y1; gy ++ ) {

			for ( let gx = x0; gx <= x1; gx ++ ) {

				const d = Math.hypot( gx + ox - X, gy + oy - Y );
				if ( d > R + bevel ) continue;

				const i = ( gy * DEPTH_SIZE + gx ) * 4;
				// biseau : le bord remonte vers −0.4 (épaulement de terre)
				const t = Math.max( 0, ( d - ( R - 2 ) ) / ( bevel + 2 ) );
				const y = depth + ( - 0.4 - depth ) * Math.min( 1, t ) ** 0.8;
				if ( y < field[ i ] ) field[ i ] = y;
				if ( d < R - 1.2 ) field[ i + 1 ] = 1;

			}

		}

	};

	for ( const c of chambers ) carveDisc( c.x, c.y, c.R, c.depth );

	for ( const t of tunnels ) {

		for ( let s = 0; s < t.pts.length - 1; s ++ ) {

			const a = t.pts[ s ], b = t.pts[ s + 1 ];
			const segLen = Math.hypot( b.x - a.x, b.y - a.y );
			const steps = Math.max( 2, Math.ceil( segLen / 1.5 ) );

			for ( let k = 0; k <= steps; k ++ ) {

				const u = k / steps;
				carveDisc(
					a.x + ( b.x - a.x ) * u,
					a.y + ( b.y - a.y ) * u,
					t.w,
					a.depth + ( b.depth - a.depth ) * u,
				);

			}

		}

	}

	const depthTexture = new THREE.DataTexture(
		field, DEPTH_SIZE, DEPTH_SIZE, THREE.RGBAFormat, THREE.FloatType,
	);
	depthTexture.minFilter = THREE.NearestFilter;
	depthTexture.magFilter = THREE.NearestFilter;
	depthTexture.generateMipmaps = false;
	depthTexture.needsUpdate = true;

	// --- mangeoires : LA cellule où la nourriture s'échange ---
	// (une seule cellule par chambre : le stock y est un entier, le rendu un
	// tas dont la taille suit le stock — pas de dispersion à rattraper)
	const troughCell = ( p ) => Math.floor( p.y ) * GRID + Math.floor( p.x );
	const troughs = {
		granary: { ...granary, cell: troughCell( granary ) },
		queen: { ...queen, cell: troughCell( queen ) },
		brood: { ...brood1, cell: troughCell( brood1 ) },
	};

	// profondeur en un point (texels) — pour le CPU (placement, caméra)
	const depthAt = ( x, y ) => {

		const gx = Math.round( x - ox ), gy = Math.round( y - oy );
		if ( gx < 0 || gy < 0 || gx >= DEPTH_SIZE || gy >= DEPTH_SIZE ) return 0;
		return field[ ( gy * DEPTH_SIZE + gx ) * 4 ];

	};

	return {
		nodes, edges, nextHop, GOAL_NODE,
		chambers: chamberMap,
		chamberDiscs: chambers,
		tunnels, troughs,
		field, depthTexture, depthAt,
		origin: { x: ox, y: oy },
	};

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
		return textureLoad( layout.depthTexture, c ).x;

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
