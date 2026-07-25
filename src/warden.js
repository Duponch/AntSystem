// LE SURVEILLANT (warden) — batterie de tests d'intégration de la simulation.
//
// Usage : URL ?test=warden (au chargement) ou console : __antsys.warden.run()
//
// Pourquoi ce module existe : des comportements cassés (fourmis qui se
// TÉLÉPORTENT d'une nappe à l'autre, fourmis qui font la TOUPIE dans une
// cavité jusqu'à mourir de faim) ne se voient qu'en regardant des centaines
// de vies de fourmis à la fois. Ici, chaque scénario rejoue la simulation en
// pas MANUELS (boucle rAF figée) avec un noyau de surveillance qui relit
// CHAQUE fourmi à CHAQUE pas et compte les anomalies — puis un rapport
// consolidé sort en console et sur window.__antwarden.
//
// DÉTECTEURS (noyau kWatch, 1 invocation par fourmi et par pas) :
//   1 TÉLÉPORTATION Y — le plancher résolu d'une souterraine change de plus
//     d'1 u en un pas sans qu'elle vole (dyn.z ≈ 0). C'est le symptôme.
//   2 NAPPE EMPRUNTÉE — la cause racine : la navigation est 2D (une cellule
//     est praticable dès qu'UNE nappe y a une cavité) mais la hauteur dépend
//     de la nappe de la fourmi. Quand sa colonne n'a PAS de cavité sur sa
//     propre nappe, le rendu la rabat sur la cavité la plus haute : elle
//     « emprunte » le plancher d'une autre nappe → saut vertical.
//   3 WARP XZ — déplacement planaire > 8 texels en un pas (impossible à pied).
//   4 TOUPIE — fenêtre glissante de 8 s : rotation cumulée > 6π avec moins de
//     3 texels de déplacement → la fourmi tourne sur place.
//   5 BLOQUÉE — moins de 0,5 texel de déplacement sur 8 s (même sans tourner).
//   6 SOUS LE NID / EN SURFACE — plancher résolu hors des bornes physiques.
//   7 MORT EN TOUPIE — une fourmi marquée toupie qui meurt : à rapprocher de
//     son énergie (faim) pour distinguer bug et famine légitime.
//
// CYCLE DE VIE (CPU) : un échantillon de fourmis est suivi toute la durée du
// scénario — chemin parcouru, états traversés, énergie, cause de mort — avec
// des gardes-fous : « une ouvrière doit bouger », « elle doit alterner
// exploratrice/porteuse », « une mort s'explique (faim ou venin) ».
//
// Budget performance : NUL en jeu normal — les noyaux ne sont jamais
// dispatchés hors campagne de tests (pas manuels). Les tampons dédiés
// (~2 Mo de VRAM) dorment.
//
// Rappels des pièges (mémoire du projet, voir tests.js) : readbacks sérialisés
// derrière le verrou global ; yield à l'event loop entre les chunks ; la sim
// est stochastique → assertions en BORNES, pas en exacts.

import {
	Fn, If, instanceIndex, uniform, instancedArray, textureLoad,
	uint, int, float, vec2, vec4, ivec2,
	abs, min, clamp, length, select, PI2, atomicAdd, atomicStore,
} from 'three/tsl';

import { params, gfx, TEXEL, MAX_ANTS } from './config.js';
import { nestUnit, buildNest, K_MAX } from './nest.js';

const N_EVENTS = 256;         // anneau d'événements d'anomalies relus par le CPU
const SPIN_T = 8.0;           // fenêtre toupie/blocage (s sim)
const DY_TELEPORT = 1.0;      // saut vertical suspect (u monde)
const DXZ_WARP = 8.0;         // warp planaire suspect (texels)
const SPIN_ROT = 2 * Math.PI; // rotation cumulée de toupie sur la fenêtre (rad) :
                              // un tour complet en 8 s quasi sur place — lent
                              // mais anormal pour une fourmi en déplacement
const SPIN_MOVE = 3.0;        // … avec moins de ça de déplacement (texels)
const STUCK_MOVE = 0.5;       // déplacement de blocage sur la fenêtre (texels)

// types d'événements (colonne « type » du rapport)
const EV = { TELEPORT: 1, WARP: 2, NAPPE: 3, TOUPIE: 4, BLOQUE: 5, HORS_NID: 6, SURFACE: 7, MORT_TOUPIE: 8 };
const EV_NOMS = [ '', 'téléport Y', 'warp XZ', 'nappe empruntée', 'toupie', 'bloquée', 'sous le nid', 'en surface', 'mort en toupie' ];

export function createWarden( { sim, colony, ants, cones, renderer } ) {

	const layout = sim.layout;
	const depthSize = layout.depthTexture.image.width;
	const origin = vec2( layout.origin.x, layout.origin.y );

	// ------------------------------------------------------------------
	// Tampons dédiés (jamais lus par le jeu normal)
	// ------------------------------------------------------------------
	// état au pas précédent : (x, y texels, cap rad, plancher résolu u | -999)
	const prevData = instancedArray( MAX_ANTS, 'vec4' );
	// fenêtre toupie : (rotation cumulée, déplacement cumulé, chrono, drapeaux)
	// drapeaux : 1 toupie · 2 bloquée · 4 mort-en-toupie comptée · 8 nappe empruntée
	const spinAcc = instancedArray( MAX_ANTS, 'vec4' );
	const counters = instancedArray( 16, 'uint' ).toAtomic();
	const evCursor = instancedArray( 1, 'uint' ).toAtomic();
	const events = instancedArray( N_EVENTS, 'vec4' );

	const uDt = uniform( 1 / 60 );
	const uSimTime = uniform( 0 );
	const uDepthMax = uniform( 18 );

	function emitEvent( type, magnitude ) {

		const c = atomicAdd( evCursor.element( 0 ), uint( 1 ) ).mod( uint( N_EVENTS ) );
		events.element( c ).assign(
			vec4( instanceIndex.toFloat(), float( type ), magnitude, uSimTime ) );

	}

	const kWatch = Fn( () => {

		If( instanceIndex.toFloat().lessThan( sim.u.antCount ), () => {

			const st = sim.antState.element( instanceIndex );
			const state = st.bitAnd( uint( 7 ) );
			const alive = state.lessThan( uint( 2 ) );
			const under = st.bitAnd( uint( 8 ) ).notEqual( uint( 0 ) );
			const a = sim.antData.element( instanceIndex );
			const pos = a.xy;
			const yaw = a.z;
			const prev = prevData.element( instanceIndex ).toVar();
			const acc = spinAcc.element( instanceIndex ).toVar();
			const fl = acc.w.toUint().toVar();          // drapeaux en entier
			const prevOk = prev.w.greaterThan( - 900 ); // prev.w = plancher | -999
			// plancher résolu CE pas : −999 tant que la fourmi n'est pas
			// souterraine — un passage surface→nid ne peut pas être pris pour
			// une téléportation (pas de plancher de référence)
			const floorNow = float( - 999 ).toVar();

			If( alive.and( under ), () => {

				const layer = st.shiftRight( uint( 14 ) ).bitAnd( uint( 3 ) );
				// plancher résolu à la colonne (texels) sur SA nappe — MÊME
				// logique que pose.js : nappe propre vide → rabat sur la plus haute
				const lc = clamp( ivec2( pos.sub( origin ) ), ivec2( 0 ), ivec2( depthSize - 1 ) );
				const t = textureLoad( layout.depthTexture, lc );
				const own = select( layer.equal( uint( 0 ) ), t.x,
					select( layer.equal( uint( 1 ) ), t.y,
						select( layer.equal( uint( 2 ) ), t.z, t.w ) ) ).toVar();
				const any = min( min( t.x, t.y ), min( t.z, t.w ) ).toVar();
				floorNow.assign( select( own.lessThan( - 1e-4 ), own, any ) );
				const dyn = sim.antDyn.element( instanceIndex );

				// --- 2 · NAPPE EMPRUNTÉE : la colonne n'a pas de cavité sur SA
				// nappe, mais une autre en a une → le rendu la rabat verticalement
				If( own.greaterThanEqual( - 1e-4 ).and( any.lessThan( - 1e-4 ) ), () => {

					atomicAdd( counters.element( 2 ), uint( 1 ) );
					If( fl.bitAnd( uint( 8 ) ).equal( uint( 0 ) ), () => {

						fl.assign( fl.bitOr( uint( 8 ) ) );
						emitEvent( EV.NAPPE, any );

					} );

				} ).Else( () => {

					fl.assign( fl.bitAnd( uint( 0xFFFFFFF7 ) ) );

				} );

				If( prevOk, () => {

					// --- 1 · TÉLÉPORTATION Y : le plancher a changé d'un coup
					// sans vol balistique (dyn.z ≈ 0)
					const dy = abs( floorNow.sub( prev.w ) ).toVar();
					If( dy.greaterThan( float( DY_TELEPORT ) ).and( dyn.z.lessThan( 0.05 ) ), () => {

						atomicAdd( counters.element( 0 ), uint( 1 ) );
						emitEvent( EV.TELEPORT, dy );

					} );

					// --- 3 · WARP XZ ---
					const dxz = length( pos.sub( prev.xy ) );
					If( dxz.greaterThan( float( DXZ_WARP ) ), () => {

						atomicAdd( counters.element( 1 ), uint( 1 ) );
						emitEvent( EV.WARP, dxz );

					} );

				} );

				// --- 6 · BORNES PHYSIQUES : une souterraine ne peut être ni au-
				// dessus du sol ni sous la fourmilière
				If( floorNow.greaterThan( - 0.05 ), () => {

					atomicAdd( counters.element( 6 ), uint( 1 ) );
					emitEvent( EV.SURFACE, floorNow );

				} );
				If( floorNow.lessThan( uDepthMax.negate().sub( 3 ) ), () => {

					atomicAdd( counters.element( 5 ), uint( 1 ) );
					emitEvent( EV.HORS_NID, floorNow );

				} );

			} );

			// --- 4/5 · TOUPIE & BLOCAGE : fenêtre glissante, toutes vivantes ---
			If( alive, () => {

				If( prevOk, () => {

					// écart angulaire ramené dans [0, π]
					const dyaw = abs( yaw.sub( prev.z ) ).mod( PI2 );
					acc.x.addAssign( select( dyaw.greaterThan( Math.PI ), PI2.sub( dyaw ), dyaw ) );
					acc.y.addAssign( length( pos.sub( prev.xy ) ) );
					acc.z.addAssign( uDt );

				} );

				If( acc.z.greaterThanEqual( float( SPIN_T ) ), () => {

					const spinning = acc.x.greaterThan( float( SPIN_ROT ) )
						.and( acc.y.lessThan( float( SPIN_MOVE ) ) );
					const stuck = acc.y.lessThan( float( STUCK_MOVE ) );

					If( spinning.and( fl.bitAnd( uint( 1 ) ).equal( uint( 0 ) ) ), () => {

						fl.assign( fl.bitOr( uint( 1 ) ) );
						atomicAdd( counters.element( 3 ), uint( 1 ) );
						emitEvent( EV.TOUPIE, acc.x );

					} );
					If( stuck.and( fl.bitAnd( uint( 2 ) ).equal( uint( 0 ) ) ), () => {

						fl.assign( fl.bitOr( uint( 2 ) ) );
						atomicAdd( counters.element( 4 ), uint( 1 ) );
						emitEvent( EV.BLOQUE, acc.y );

					} );
					// rémission : elle a bougé franchement → drapeaux retombés
					If( acc.y.greaterThan( float( SPIN_MOVE ) ), () => {

						fl.assign( fl.bitAnd( uint( 0xFFFFFFFC ) ) );

					} );

					acc.x.assign( 0 );
					acc.y.assign( 0 );
					acc.z.assign( 0 );

				} );

			} ).Else( () => {

				// --- 7 · MORT EN TOUPIE : comptée une fois, à rapprocher de
				// l'énergie relue côté CPU (faim) pour qualifier le bug
				If( state.equal( uint( 2 ) )
					.and( fl.bitAnd( uint( 1 ) ).notEqual( uint( 0 ) ) )
					.and( fl.bitAnd( uint( 4 ) ).equal( uint( 0 ) ) ), () => {

					fl.assign( fl.bitOr( uint( 4 ) ) );
					atomicAdd( counters.element( 7 ), uint( 1 ) );
					emitEvent( EV.MORT_TOUPIE, 0 );

				} );

			} );

			acc.w.assign( fl.toFloat() );
			prevData.element( instanceIndex ).assign(
				vec4( pos.x, pos.y, yaw, floorNow ) );
			spinAcc.element( instanceIndex ).assign( acc );

		} );

	} )().compute( MAX_ANTS );

	const kWatchReset = Fn( () => {

		prevData.element( instanceIndex ).assign( vec4( 0, 0, 0, - 999 ) );
		spinAcc.element( instanceIndex ).assign( vec4( 0 ) );

	} )().compute( MAX_ANTS );

	const kCountersReset = Fn( () => {

		atomicStore( counters.element( instanceIndex ), uint( 0 ) );

	} )().compute( 16 );

	const kCursorReset = Fn( () => {

		atomicStore( evCursor.element( 0 ), uint( 0 ) );

	} )().compute( 1 );

	// ------------------------------------------------------------------
	// Orchestrateur CPU
	// ------------------------------------------------------------------
	let simClock = 0;

	function resetWatch() {

		renderer.compute( [ kWatchReset, kCountersReset, kCursorReset ] );
		simClock = 0;
		uDepthMax.value = layout.depthMax || 18;

	}

	// pas manuels surveillés : sim → colonie → veille (les readbacks async
	// respirent périodiquement via readStatsDirect)
	async function steps( seconds, withColony = true ) {

		const total = Math.round( seconds * 60 );

		for ( let i = 0; i < total; i ++ ) {

			sim.step( 1 / 60 );
			if ( withColony ) colony.step( 1 / 60 );
			simClock += 1 / 60;
			uSimTime.value = simClock;
			renderer.compute( kWatch );
			if ( i % 240 === 239 ) await sim.readStatsDirect();   // synchro + yield

		}

	}

	async function readWatch() {

		const c = new Uint32Array( await renderer.getArrayBufferAsync( counters.value ) );
		const cur = new Uint32Array( await renderer.getArrayBufferAsync( evCursor.value ) )[ 0 ];
		const ev = new Float32Array( await renderer.getArrayBufferAsync( events.value ) );
		const n = Math.min( cur, N_EVENTS );
		const list = [];

		for ( let i = 0; i < n; i ++ ) {

			list.push( { ant: Math.round( ev[ i * 4 ] ), type: Math.round( ev[ i * 4 + 1 ] ),
				typeNom: EV_NOMS[ Math.round( ev[ i * 4 + 1 ] ) ] || '?',
				value: + ev[ i * 4 + 2 ].toFixed( 2 ), t: + ev[ i * 4 + 3 ].toFixed( 1 ) } );

		}

		return { counters: Array.from( c ), events: list, overflow: cur > N_EVENTS };

	}

	function hooks() {

		return {

			activateAnts( k ) {

				const from = params.antCount;
				const target = Math.min( 65536, from + k );
				if ( target <= from ) return;
				sim.spawnHatched( from );
				params.antCount = target;
				sim.u.antCount.value = target;
				ants.setCount( target );
				cones.setCount( target );

			},
		};

	}

	async function tickColony() {

		const st = await sim.readStatsDirect();
		colony.onStats( st, hooks() );
		await colony._dbg.pollBrood();
		return st;

	}

	// ------------------------------------------------------------------
	// CYCLE DE VIE : suivi d'un échantillon de fourmis pendant le scénario
	// ------------------------------------------------------------------
	function makeLifeTracker( sampleN ) {

		const n = Math.min( sampleN, params.antCount );
		const antsT = [];

		for ( let i = 0; i < n; i ++ ) {

			// stratifié : reine + population répartie sur tout l'indice
			const idx = i === 0 ? 0 : Math.floor( ( i - 1 ) * ( params.antCount - 1 ) / Math.max( 1, n - 2 ) );
			antsT.push( { idx, path: 0, states: new Set(), minEnergy: 1,
				dead: - 1, deathEnergy: - 1, lastPos: null } );

		}

		return {

			antsT,

			async sample() {

				const N = params.antCount;
				const st = new Uint32Array( await renderer.getArrayBufferAsync( sim.antState.value, null, 0, N * 4 ) );
				const d = new Float32Array( await renderer.getArrayBufferAsync( sim.antData.value, null, 0, N * 16 ) );
				const v = new Float32Array( await renderer.getArrayBufferAsync( sim.antVital.value, null, 0, N * 16 ) );

				for ( const t of antsT ) {

					if ( t.idx >= N ) continue;
					const state = st[ t.idx ] & 7;
					const px = d[ t.idx * 4 ], py = d[ t.idx * 4 + 1 ];
					const energy = v[ t.idx * 4 + 2 ];

					if ( t.lastPos ) t.path += Math.hypot( px - t.lastPos[ 0 ], py - t.lastPos[ 1 ] ) * TEXEL;
					t.lastPos = [ px, py ];
					t.states.add( state );
					if ( state < 2 ) t.minEnergy = Math.min( t.minEnergy, energy );
					if ( state === 2 && t.dead < 0 ) { t.dead = simClock; t.deathEnergy = energy; }

				}

			},

			report() {

				// gardes-fous du cycle de vie (bornes, la sim est stochastique)
				const bad = [];
				let healthy = 0;

				for ( const t of antsT ) {

					const issues = [];
					const isQueen = t.idx === 0;
					const lived = t.dead < 0 ? simClock : t.dead;

					// « elle se déplace » — une vivante parcourt un vrai chemin
					// (la reine, sédentaire, en est exempte ; 20 s de grâce)
					if ( ! isQueen && lived > 20 && t.path < 5 ) issues.push( `immobile (${ t.path.toFixed( 1 ) } u)` );
					// « elle fait quelque chose » — hors reine, une fourmi active
					// change d'état au moins une fois en 4 min (sinon robot figé)
					if ( ! isQueen && lived > 200 && t.states.size < 2 ) issues.push( 'jamais changé d\'état' );
					// « sa mort s'explique » — faim ou venin, jamais « gratuitement »
					if ( t.dead >= 0 && t.deathEnergy > 0.05 ) issues.push( `morte énergie=${ t.deathEnergy.toFixed( 2 ) }` );

					if ( issues.length ) bad.push( { idx: t.idx, issues, path: + t.path.toFixed( 1 ),
						states: [ ...t.states ], dead: + t.dead.toFixed( 1 ), minEnergy: + t.minEnergy.toFixed( 2 ) } );
					else healthy ++;

				}

				return { total: antsT.length, healthy, bad };

			},

		};

	}

	// ------------------------------------------------------------------
	// TESTS UNITAIRES du nid (purs, instantanés, sans GPU)
	// ------------------------------------------------------------------
	function unitTests() {

		const out = [];
		const ok = ( name, pass, detail ) => out.push( { name, pass, detail } );

		// déterminisme du registre : même k → même loge, quel que soit l'ordre
		{

			const a = nestUnit( 7, 18 ), b = nestUnit( 7, 18 );
			ok( 'nestUnit déterministe',
				a.x === b.x && a.y === b.y && a.depth === b.depth && a.rwx === b.rwx,
				`loge 7 : (${ a.x.toFixed( 1 ) }, ${ a.y.toFixed( 1 ) }, prof ${ a.depth.toFixed( 1 ) })` );

		}
		// append-only : agrandir ne déplace JAMAIS une loge existante
		{

			const n10 = buildNest( 10, 18, 6 );
			const n20 = buildNest( 20, 18, 6 );
			let moved = 0;

			for ( let k = 0; k < 10; k ++ ) {

				if ( n10.units[ k ].x !== n20.units[ k ].x || n10.units[ k ].depth !== n20.units[ k ].depth ) moved ++;

			}

			ok( 'registre append-only', moved === 0, `${ moved } loge(s) déplacée(s) en grandissant 10→20` );

		}
		// bornes physiques du registre complet. La profondeur d'une loge est
		// −depthMax·zf·(0,94+0,12·vdc) : le jitter la pousse jusqu'à
		// −depthMax·1,06 — EN DESSOUS du depthMax nominal, mais la marge +3 du
		// volume baké (nestvolume.js) la couvre. La garde est donc à 1,06.
		{

			let badDepth = 0, badLayer = 0, badParent = 0;
			const nAll = buildNest( K_MAX, 18, 6 );

			for ( const uN of nAll.units ) {

				if ( uN.depth > 0.01 || uN.depth < - 18 * 1.06 - 0.01 ) badDepth ++;
				if ( uN.layer < 0 || uN.layer > 3 ) badLayer ++;

			}

			for ( let k = 0; k < K_MAX; k ++ ) if ( nAll.parents[ k ] >= k || nAll.parents[ k ] < - 1 ) badParent ++;
			ok( 'bornes du registre (profondeur, nappe, parent)',
				badDepth === 0 && badLayer === 0 && badParent === 0,
				`profondeur hors [−19,1,0]=${ badDepth }, nappe hors 0..3=${ badLayer }, parents invalides=${ badParent }` );

		}
		// connexité : chaque nœud retombe sur la racine (parent −1 = puits)
		{

			const nAll = buildNest( K_MAX, 18, 6 );
			let orphans = 0;

			for ( let k = 1; k < K_MAX; k ++ ) {

				let j = k, hops = 0;
				while ( nAll.parents[ j ] >= 0 && hops <= K_MAX ) { j = nAll.parents[ j ]; hops ++; }
				if ( nAll.parents[ j ] >= 0 ) orphans ++;   // cycle : jamais retombé

			}

			ok( 'graphe du nid connexe', orphans === 0, `${ orphans } nœud(s) en cycle sans racine` );

		}
		// chaque loge active a bien une cavité dans la carte (sur SA nappe)
		{

			const nAll = buildNest( 24, 18, 6 );
			let missing = 0;

			for ( let k = 0; k < 24; k ++ ) {

				const uN = nAll.units[ k ];
				if ( nAll.depthAt( Math.round( uN.x ), Math.round( uN.y ), uN.layer ) > - 1e-4 ) missing ++;

			}

			ok( 'loges creusées sur leur nappe', missing === 0,
				`${ missing } centre(s) de loge sans cavité sur leur propre nappe` );

		}

		return out;

	}

	// ------------------------------------------------------------------
	// SCÉNARIOS DE LA CAMPAGNE
	// ------------------------------------------------------------------
	async function runScenario( sc ) {

		console.log( `🛡 Scénario « ${ sc.name } » (${ sc.seconds } s sim, ${ sc.ants } fourmis)…` );
		params.antCount = sc.ants;
		sim.u.antCount.value = sc.ants;
		ants.setCount( sc.ants );
		cones.setCount( sc.ants );
		if ( sc.configure ) sc.configure();
		await sim.reset();
		await colony.reset();
		resetWatch();

		const life = makeLifeTracker( 48 );
		let lastStats = null;
		const chunks = Math.max( 1, Math.round( sc.seconds / 10 ) );

		for ( let c = 0; c < chunks; c ++ ) {

			await steps( sc.seconds / chunks );
			lastStats = await tickColony();
			await life.sample();

		}

		const watch = await readWatch();
		const lifeRep = life.report();
		const st = lastStats || {};

		const rep = {

			name: sc.name,
			seconds: sc.seconds,
			ants: params.antCount,
			stats: { morts: st.eaten ?? - 1, livraisons: st.delivered ?? - 1,
				pontes: st.laid ?? - 1, éclosions: st.hatched ?? - 1 },
			anomalies: {
				téléportY: watch.counters[ 0 ],
				warpXZ: watch.counters[ 1 ],
				nappeEmpruntéePas: watch.counters[ 2 ],
				toupies: watch.counters[ 3 ],
				bloquées: watch.counters[ 4 ],
				sousLeNid: watch.counters[ 5 ],
				enSurface: watch.counters[ 6 ],
				mortsEnToupie: watch.counters[ 7 ],
			},
			events: watch.events.slice( 0, 40 ),
			eventsOverflow: watch.overflow,
			cycleDeVie: lifeRep,

		};

		// verdict de scénario (bornes : la sim est stochastique)
		const antMinutes = Math.max( 1, params.antCount * sc.seconds / 60 );
		const teleportRatio = rep.anomalies.téléportY / antMinutes;
		const ok =
			rep.anomalies.warpXZ === 0 &&
			rep.anomalies.sousLeNid === 0 &&
			rep.anomalies.enSurface === 0 &&
			teleportRatio < 0.01 &&                    // < 1 % de fourmi·minute téléportée
			rep.cycleDeVie.bad.length <= Math.ceil( rep.cycleDeVie.total * 0.15 );

		rep.pass = ok;
		console.log( `${ ok ? '✅' : '❌' } « ${ sc.name } » — téléportY=${ rep.anomalies.téléportY }`
			+ ` nappeEmpruntée=${ rep.anomalies.nappeEmpruntéePas } pas, toupies=${ rep.anomalies.toupies }`
			+ ` bloquées=${ rep.anomalies.bloquées } mortsEnToupie=${ rep.anomalies.mortsEnToupie }`
			+ ` cycle=${ rep.cycleDeVie.healthy }/${ rep.cycleDeVie.total } saines` );

		return rep;

	}

	async function run( opts = {} ) {

		const seconds = opts.seconds || + new URLSearchParams( location.search ).get( 'wdur' ) || 120;
		console.log( `🛡 WARDEN — campagne (${ seconds } s sim par scénario)` );

		const saved = JSON.parse( JSON.stringify( { params: { ...params }, gfx: { ...gfx } } ) );
		const savedPop = params.antCount;
		params.paused = true;
		colony._dbg.setManualTick( true );

		const report = { unit: [], scenarios: [], startedAt: new Date().toISOString() };

		try {

			// --- tests unitaires (instantanés) ---
			report.unit = unitTests();

			for ( const t of report.unit ) {

				console.log( `${ t.pass ? '✅' : '❌' } [unit] ${ t.name } — ${ t.detail }` );

			}

			// --- scénarios d'intégration ---
			const scenarios = [
				{ name: 'référence', ants: 869, seconds },
				{ name: 'colonie dense', ants: 2048, seconds },
				{ name: 'tunnels étroits', ants: 869, seconds,
					configure: () => { params.nestTunnelW = 3; sim.layout.rebuild(); } },
				{ name: 'tunnels larges', ants: 869, seconds,
					configure: () => { params.nestTunnelW = 10; sim.layout.rebuild(); } },
				{ name: 'famine', ants: 869, seconds: Math.min( seconds, 150 ),
					configure: () => {

						sim.u.granaryStart.value = 0;
						sim.u.energyLife.value = 45;

					} },
			];

			for ( const sc of scenarios ) {

				report.scenarios.push( await runScenario( sc ) );
				// remet les réglages du scénario précédent
				Object.assign( params, saved.params );
				sim.u.energyLife.value = params.energyLife;
				sim.u.granaryStart.value = params.granaryStart;
				sim.layout.rebuild();

			}

		} finally {

			Object.assign( params, saved.params );
			Object.assign( gfx, saved.gfx );
			params.antCount = savedPop;
			sim.u.antCount.value = savedPop;
			ants.setCount( savedPop );
			cones.setCount( savedPop );
			sim.layout.rebuild();
			await sim.reset();
			await colony.reset();
			sim.refreshDisplay();
			sim.updateFieldNodes();
			colony._dbg.setManualTick( false );
			params.paused = false;

		}

		const passed = report.scenarios.filter( ( r ) => r.pass ).length
			+ report.unit.filter( ( r ) => r.pass ).length;
		const total = report.scenarios.length + report.unit.length;
		report.score = `${ passed }/${ total }`;
		console.log( `🛡 WARDEN — fin de campagne : ${ report.score }` );

		window.__antwarden = report;
		return report;

	}

	return { run };

}
