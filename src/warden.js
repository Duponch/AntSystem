// LE SURVEILLANT (warden) — tests d'intégration GPU de la navigation v2.
//
// Usage : URL ?test=warden (au chargement) ou console : __antsys.warden.run().
// Chaque scénario avance la simulation par pas manuels et contrôle chaque
// fourmi. Le rapport consolidé est publié en console et sur window.__antwarden.
//
// ORACLES STRICTS (noyau kWatch, une invocation par fourmi et par pas) :
//   1 POSE INTRINSÈQUE — reconstruction indépendante depuis corridor, progrès,
//     voie et profondeur ; tout écart au corridor échoue.
//   2 CINÉMATIQUE 3D — déplacement couvert par la distance curviligne accumulée,
//     majorée par l'étirement géométrique mesuré des voies.
//   3 WARP XZ — aucun saut planaire inexpliqué par la progression de route.
//   4 TOUPIE / BLOCAGE — fenêtre de 8 s hors repos et destination atteinte ;
//     une transition surface/sous-sol ouvre toujours une nouvelle fenêtre.
//   5 BORNES DU VOLUME — aucune souterraine hors du volume réellement compilé,
//     y compris avec le jitter des chambres profondes.
//   6 MORT EN TOUPIE — corrélation entre anomalie et mort ultérieure.
//
// Un échantillon CPU conserve chemins, états, énergie et traces intrinsèques.
// Les verdicts n'acceptent aucune anomalie structurelle ; les indicateurs
// biologiques stochastiques restent diagnostiques et séparés.
//
// Coût en jeu normal : nul. Ces noyaux et leurs tampons ne sont dispatchés que
// pendant une campagne Warden ; les lectures GPU sont sérialisées par chunks.

import {
	Fn, If, instanceIndex, uniform, instancedArray, textureLoad,
	uint, int, float, vec2, vec4, ivec2,
	abs, min, max, clamp, floor, mix, sqrt, length, select, PI2, atomicAdd, atomicStore, atomicLoad,
	hash,
} from 'three/tsl';

import { params, gfx, TEXEL, MAX_ANTS } from './config.js';
import { nestUnit, buildNest, K_MAX, MIN_TUNNEL_WIDTH } from './nest.js';

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
const EV_NOMS = [ '', 'dépassement cinématique 3D', 'warp XZ', 'hors corridor', 'toupie', 'bloquée', 'sous le nid', 'en surface', 'mort en toupie' ];

export function createWarden( { sim, colony, ants, cones, renderer } ) {

	const layout = sim.layout;
	const depthSize = layout.depthTexture.image.width;
	const origin = vec2( layout.origin.x, layout.origin.y );

	// ------------------------------------------------------------------
	// Tampons dédiés (jamais lus par le jeu normal)
	// ------------------------------------------------------------------
	// état précédent : (x, y texels, distance-route sous terre / cap en surface,
	// profondeur sous terre / marqueur surface / -999 au reset)
	const prevData = instancedArray( MAX_ANTS, 'vec4' );
	// fenêtre toupie : (rotation cumulée, déplacement cumulé, chrono, drapeaux)
	// drapeaux : 1 toupie · 2 bloquée · 4 mort-en-toupie comptée · 8 nappe empruntée
	const spinAcc = instancedArray( MAX_ANTS, 'vec4' );
	const counters = instancedArray( 16, 'uint' ).toAtomic();
	const evCursor = instancedArray( 1, 'uint' ).toAtomic();
	const events = instancedArray( N_EVENTS, 'vec4' );
	// contexte de l'événement : (x, y texels, goal+node·8, nappe) — pour
	// LOCALISER les toupies/blocages dans le nid (diagnostic, pas juste compter)
	const evExtra = instancedArray( N_EVENTS, 'vec4' );

	const uDt = uniform( 1 / 60 );
	const uSimTime = uniform( 0 );
	const uDepthMax = uniform( 18 );
	const uLaneStretch = uniform( layout.navigation?.maxLaneStretch || 1 );

	const kWatch = Fn( () => {

		If( instanceIndex.toFloat().lessThan( sim.u.antCount ), () => {

			const st = sim.antState.element( instanceIndex );
			const state = st.bitAnd( uint( 7 ) );
			const alive = state.lessThan( uint( 2 ) );
			const under = st.bitAnd( uint( 8 ) ).notEqual( uint( 0 ) );
			const caste = sim.casteOf( instanceIndex );
			const a = sim.antData.element( instanceIndex );
			const pos = a.xy;
			const yaw = a.z;
			// contexte pour la localisation des événements
			const goalE = st.shiftRight( uint( 4 ) ).bitAnd( uint( 7 ) ).toFloat();
			const nodeE = st.shiftRight( uint( 7 ) ).bitAnd( uint( 127 ) ).toFloat();
			const layerE = st.shiftRight( uint( 14 ) ).bitAnd( uint( 3 ) ).toFloat();
			const prev = prevData.element( instanceIndex ).toVar();
			const acc = spinAcc.element( instanceIndex ).toVar();
			const fl = acc.w.toUint().toVar();          // drapeaux en entier
			const prevOk = prev.w.greaterThan( - 900 ); // prev.w = plancher | -999
			const prevUnder = prev.w.lessThan( 0 );
			const sameMode = prevOk.and( prevUnder.equal( under ) );
			// plancher résolu CE pas : −999 tant que la fourmi n'est pas
			// souterraine — un passage surface→nid ne peut pas être pris pour
			// une téléportation (pas de plancher de référence)
			const floorNow = float( - 999 ).toVar();
			// Une transition surface/sous-sol change le sens de prev.z. Elle ouvre
			// toujours une nouvelle fenêtre pour éviter tout mélange distance/cap.
			If( prevOk.and( sameMode.not() ), () => {

				acc.x.assign( 0 ); acc.y.assign( 0 ); acc.z.assign( 0 );
				fl.assign( fl.bitAnd( uint( 0xFFFFFFFC ) ) );

			} );


			function emitEvent( type, magnitude ) {

				const c = atomicAdd( evCursor.element( 0 ), uint( 1 ) ).mod( uint( N_EVENTS ) );
				events.element( c ).assign(
					vec4( instanceIndex.toFloat(), float( type ), magnitude, uSimTime ) );
				evExtra.element( c ).assign(
					vec4( pos.x, pos.y, goalE.add( nodeE.mul( 8 ) ),
						select( under, sim.antDyn.element( instanceIndex ).x.add(
							sim.antDyn.element( instanceIndex ).y.mul( 0.001 ) ), layerE ) ) );

			}

			If( alive.and( under ), () => {

				// L'oracle reconstruit la pose monde depuis l'état intrinsèque. Il ne
				// consulte jamais la vieille heightmap : une divergence nav/rendu devient
				// donc une erreur mesurable au lieu d'être masquée par le même modèle.
				const dyn = sim.antDyn.element( instanceIndex );
				floorNow.assign( dyn.z );
				const edge = dyn.x.add( 0.5 ).toInt();
				const corridorFault = float( 0 ).toVar();
				const corridorError = float( 0 ).toVar();

				If( edge.greaterThan( int( 0 ) ), () => {

					If( edge.lessThan( int( layout.MAX_NODES ) ), () => {

						const meta = textureLoad( layout.corridorMetaTexture, ivec2( edge, int( 0 ) ) );
						const from = meta.x.add( 0.5 ).toInt();
						const to = meta.y.add( 0.5 ).toInt();
						const nodeI = nodeE.add( 0.5 ).toInt();
						const incident = from.equal( nodeI ).or( to.equal( nodeI ) );
						const validT = dyn.y.greaterThanEqual( - 1e-5 ).and( dyn.y.lessThanEqual( 1.00001 ) );
						const direction = select( from.equal( nodeI ), float( 1 ), float( - 1 ) );

						const f = clamp( dyn.y, 0, 1 ).mul( layout.CORRIDOR_SAMPLES - 1 );
						const i0 = clamp( floor( f ).toInt(), int( 0 ), int( layout.CORRIDOR_SAMPLES - 2 ) );
						const p0 = textureLoad( layout.corridorTexture, ivec2( i0, edge ) );
						const p1 = textureLoad( layout.corridorTexture, ivec2( i0.add( int( 1 ) ), edge ) );
						const pBefore = textureLoad( layout.corridorTexture,
							ivec2( max( i0.sub( int( 1 ) ), int( 0 ) ), edge ) );
						const pAfter = textureLoad( layout.corridorTexture,
							ivec2( min( i0.add( int( 2 ) ), int( layout.CORRIDOR_SAMPLES - 1 ) ), edge ) );
						const center = mix( p0.xyz, p1.xyz, f.sub( i0.toFloat() ) ).toVar();
						const segment = p1.xy.sub( p0.xy );
						const fallback = select( length( segment ).greaterThan( 1e-5 ),
							segment.div( max( length( segment ), 1e-5 ) ), vec2( 1, 0 ) );
						const tangent0Raw = p1.xy.sub( pBefore.xy );
						const tangent1Raw = pAfter.xy.sub( p0.xy );
						const tangent0 = select( length( tangent0Raw ).greaterThan( 1e-5 ),
							tangent0Raw.div( max( length( tangent0Raw ), 1e-5 ) ), fallback );
						const tangent1 = select( length( tangent1Raw ).greaterThan( 1e-5 ),
							tangent1Raw.div( max( length( tangent1Raw ), 1e-5 ) ), fallback );
						const tangentRaw = mix( tangent0, tangent1, f.sub( i0.toFloat() ) );
						const tangent = select( length( tangentRaw ).greaterThan( 1e-5 ),
							tangentRaw.div( max( length( tangentRaw ), 1e-5 ) ), fallback ).toVar();

						const q0 = clamp( dyn.y.div( 0.12 ), 0, 1 );
						const q1 = clamp( float( 1 ).sub( dyn.y ).div( 0.12 ), 0, 1 );
						const fade0 = q0.mul( q0 ).mul( float( 3 ).sub( q0.mul( 2 ) ) );
						const fade1 = q1.mul( q1 ).mul( float( 3 ).sub( q1.mul( 2 ) ) );
						const lane = min( hash( instanceIndex.add( uint( 0x1A4E ) ) )
							.mul( sim.u.laneOffset ), meta.w ).mul( direction ).mul( fade0 ).mul( fade1 );
						const expected = center.xy.add( vec2( tangent.y.negate(), tangent.x ).mul( lane ) );
						const horizontalError = length( pos.sub( expected ) ).mul( TEXEL );
						const error3d = sqrt( horizontalError.mul( horizontalError )
							.add( dyn.z.sub( center.z ).mul( dyn.z.sub( center.z ) ) ) );
						corridorError.assign( error3d );
						If( incident.not().or( validT.not() ).or( error3d.greaterThan( 0.002 ) ), () => {

							corridorFault.assign( 1 );

						} );

					} ).Else( () => {

						corridorFault.assign( 1 );
						corridorError.assign( dyn.x );

					} );

				} ).Else( () => {

					const here = textureLoad( layout.navNodeTexture,
						ivec2( nodeE.add( 0.5 ).toInt(), int( 0 ) ) );
					const roomDistance = length( pos.sub( here.xy ) );
					const roomRadius = select( caste.isQueen, max( sim.u.queenR.sub( 2.5 ), 4 ),
						max( here.w.mul( 1.25 ), 4 ) );
					const depthError = abs( dyn.z.sub( here.z ) );
					corridorError.assign( max( roomDistance.sub( roomRadius ).mul( TEXEL ), depthError ) );
					If( dyn.x.lessThan( - 0.01 ).or( roomDistance.greaterThan( roomRadius ) )
						.or( depthError.greaterThan( 0.002 ) ), () => {

						corridorFault.assign( 1 );

					} );

				} );

				If( corridorFault.greaterThan( 0.5 ), () => {

					atomicAdd( counters.element( 2 ), uint( 1 ) );
					If( fl.bitAnd( uint( 8 ) ).equal( uint( 0 ) ), () => {

						fl.assign( fl.bitOr( uint( 8 ) ) );
						emitEvent( EV.NAPPE, corridorError );

					} );

				} ).Else( () => {

					fl.assign( fl.bitAnd( uint( 0xFFFFFFF7 ) ) );

				} );

				If( sameMode, () => {

					const dxz = length( pos.sub( prev.xy ) );
					const dxzWorld = dxz.mul( TEXEL );
					const dy = abs( floorNow.sub( prev.w ) );
					const displacement3d = sqrt( dxzWorld.mul( dxzWorld ).add( dy.mul( dy ) ) );
					const travelledWorld = abs( dyn.w.sub( prev.z ) ).mul( TEXEL );
					const kinematicBound = travelledWorld.mul( uLaneStretch ).add( 0.003 );

					If( displacement3d.greaterThan( kinematicBound ), () => {

						atomicAdd( counters.element( 0 ), uint( 1 ) );
						emitEvent( EV.TELEPORT, displacement3d );

					} );
					const warpBound = max( float( DXZ_WARP ), abs( dyn.w.sub( prev.z ) ).mul( uLaneStretch ) );
					If( dxz.greaterThan( warpBound ), () => {

						atomicAdd( counters.element( 1 ), uint( 1 ) );
						emitEvent( EV.WARP, dxz );

					} );

				} );

				If( floorNow.greaterThan( 0.01 ), () => {

					atomicAdd( counters.element( 6 ), uint( 1 ) );
					emitEvent( EV.SURFACE, floorNow );

				} );
				If( floorNow.lessThan( uDepthMax.negate().sub( 3 ) ), () => {

					atomicAdd( counters.element( 5 ), uint( 1 ) );
					emitEvent( EV.HORS_NID, floorNow );

				} );

				// Le code 2.5D reste sous ce point uniquement le temps de la migration ;
				// ce retour JS empêche sa construction dans le graphe TSL.
				return;

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
				const legacyDyn = sim.antDyn.element( instanceIndex );

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
					If( dy.greaterThan( float( DY_TELEPORT ) ).and( legacyDyn.z.lessThan( 0.05 ) ), () => {

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
			// MAIS PAS PENDANT LE REPOS : la sim a un cycle paresseux par DESIGN
			// (simulation.js — jusqu'à ~80 % du temps immobile) ; une fourmi qui
			// dort n'est pas une fourmi bloquée. Le cycle vient de la politique
			// partagée avec la simulation et l'inspecteur ; la fenêtre de mesure
			// est gelée pendant la sieste.
			const hungryR = sim.antVital.element( instanceIndex ).z.lessThan( sim.u.hungryHome );
			const resting = under.and( caste.isQueen.not() ).and( sim.restStateOf(
				instanceIndex,
				state.equal( uint( 1 ) ),
				hungryR,
				caste.isNurse,
			).resting );
			const routeGoalNode = select( goalE.lessThan( 0.5 ), nodeE,
				select( goalE.lessThan( 1.5 ), sim.u.granaryNode,
					select( goalE.lessThan( 2.5 ), sim.u.queenNode,
						select( goalE.lessThan( 3.5 ), sim.u.broodNode, float( 0 ) ) ) ) );
			const travelRequired = under.not().or( sim.antDyn.element( instanceIndex ).x.greaterThan( 0.5 ) )
				.or( abs( nodeE.sub( routeGoalNode ) ).greaterThan( 0.5 ) );

			If( alive.and( resting.not() ).and( travelRequired ), () => {

				If( sameMode, () => {

					// écart angulaire ramené dans [0, π]
					const dyaw = abs( yaw.sub( prev.z ) ).mod( PI2 );
					const angleDelta = select( dyaw.greaterThan( Math.PI ), PI2.sub( dyaw ), dyaw );
					acc.x.addAssign( select( under, float( 0 ), angleDelta ) );
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
				vec4( pos.x, pos.y, select( under, sim.antDyn.element( instanceIndex ).w, yaw ),
					select( under, floorNow, float( 1 ) ) ) );
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

	function resetWatch( preserveClock = false ) {

		renderer.compute( [ kWatchReset, kCountersReset, kCursorReset ] );
		if ( ! preserveClock ) simClock = 0;
		const deepest = Math.min( 0,
			... ( layout.navigation?.nodes || [] ).map( ( node ) => node.depth ) );
		uDepthMax.value = Math.max( layout.depthMax || 18, - deepest );

		uLaneStretch.value = layout.navigation?.maxLaneStretch || 1;
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
		const ex = new Float32Array( await renderer.getArrayBufferAsync( evExtra.value ) );
		const n = Math.min( cur, N_EVENTS );
		const list = [];

		for ( let i = 0; i < n; i ++ ) {

			const gn = Math.round( ex[ i * 4 + 2 ] );
			list.push( { ant: Math.round( ev[ i * 4 ] ), type: Math.round( ev[ i * 4 + 1 ] ),
				typeNom: EV_NOMS[ Math.round( ev[ i * 4 + 1 ] ) ] || '?',
				value: + ev[ i * 4 + 2 ].toFixed( 2 ), t: + ev[ i * 4 + 3 ].toFixed( 1 ),
				x: + ex[ i * 4 ].toFixed( 1 ), y: + ex[ i * 4 + 1 ].toFixed( 1 ),
				goal: gn % 8, node: Math.floor( gn / 8 ), layer: Math.round( ex[ i * 4 + 3 ] ),
				edge: Math.floor( ex[ i * 4 + 3 ] + 1e-5 ),
				progress: + ( ( ex[ i * 4 + 3 ] % 1 ) * 1000 ).toFixed( 4 ) } );

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
				dead: - 1, deathEnergy: - 1, lastPos: null, routeTrace: [] } );

		}

		return {

			antsT,

			async sample() {

				const N = params.antCount;
				const st = new Uint32Array( await renderer.getArrayBufferAsync( sim.antState.value, null, 0, N * 4 ) );
				const d = new Float32Array( await renderer.getArrayBufferAsync( sim.antData.value, null, 0, N * 16 ) );
				const v = new Float32Array( await renderer.getArrayBufferAsync( sim.antVital.value, null, 0, N * 16 ) );
				const nav = new Float32Array( await renderer.getArrayBufferAsync( sim.antDyn.value, null, 0, N * 16 ) );

				for ( const t of antsT ) {

					if ( t.idx >= N ) continue;
					const state = st[ t.idx ] & 7;
					const px = d[ t.idx * 4 ], py = d[ t.idx * 4 + 1 ];
					const energy = v[ t.idx * 4 + 2 ];
					const under = ( st[ t.idx ] & 8 ) !== 0;
					const node = ( st[ t.idx ] >>> 7 ) & 127;
					const goal = ( st[ t.idx ] >>> 4 ) & 7;
					const edge = under ? Math.round( nav[ t.idx * 4 ] ) : 0;
					const progress = under ? nav[ t.idx * 4 + 1 ] : 0;
					const depth = under ? nav[ t.idx * 4 + 2 ] : 0;
					const routeDistance = under ? nav[ t.idx * 4 + 3 ] : 0;

					if ( t.lastPos ) t.path += Math.hypot(
						( px - t.lastPos[ 0 ] ) * TEXEL,
						( py - t.lastPos[ 1 ] ) * TEXEL,
						depth - t.lastPos[ 2 ] );
					t.lastPos = [ px, py, depth ];
					t.routeTrace.push( { tick: Math.round( simClock * 60 ), node, goal, edge,
						progress: + progress.toFixed( 5 ), distance: + routeDistance.toFixed( 3 ),
						x: + ( px * TEXEL ).toFixed( 3 ), z: + ( py * TEXEL ).toFixed( 3 ),
						depth: + depth.toFixed( 3 ) } );
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
					// change d'état au moins une fois en 4 min. Une éclaireuse qui
					// explore 300 s sans trouver est saine : le critère ne mord que
					// si le chemin est dérisoire (robot figé, sinon simple patience)
					if ( ! isQueen && lived > 200 && t.states.size < 2 && t.path < 50 ) issues.push( 'jamais changé d\'état' );
					// « sa mort s'explique » — faim ou venin, jamais « gratuitement »
					if ( t.dead >= 0 && t.deathEnergy > 0.05 ) issues.push( `morte énergie=${ t.deathEnergy.toFixed( 2 ) }` );

					if ( issues.length ) bad.push( { idx: t.idx, issues, path: + t.path.toFixed( 1 ),
						states: [ ...t.states ], dead: + t.dead.toFixed( 1 ), minEnergy: + t.minEnergy.toFixed( 2 ) } );
					else healthy ++;

				}

				return { total: antsT.length, healthy, bad,
					traces: antsT.map( ( ant ) => ( { idx: ant.idx, samples: ant.routeTrace } ) ) };

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
		sim.u.seed.value = sc.seed ?? 20260726;
		sim.u.antCount.value = sc.ants;
		ants.setCount( sc.ants );
		cones.setCount( sc.ants );
		if ( sc.configure ) sc.configure();
		sim.applyLayout();
		await sim.reset();
		await colony.reset();
		resetWatch();

		const life = makeLifeTracker( 48 );
		let lastStats = null;
		const watchSegments = [];
		const chunks = Math.max( sc.during ? 2 : 1, Math.round( sc.seconds / 10 ) );

		for ( let c = 0; c < chunks; c ++ ) {

			await steps( sc.seconds / chunks );
			if ( sc.during && c + 1 === Math.ceil( chunks / 2 ) ) {

				watchSegments.push( await readWatch() );
				await sc.during();
				// Nouvelle fenêtre de vitesse : le commit lui-même est couvert par la
				// validation immuable du préfixe ; les pas suivants repartent d'une pose connue.
				resetWatch( true );
				await sim.synchronize();

			}
			lastStats = await tickColony();
			await life.sample();

		}

		const watch = await readWatch();
		for ( const segment of watchSegments ) {

			for ( let i = 0; i < watch.counters.length; i ++ )
				watch.counters[ i ] += segment.counters[ i ] || 0;
			watch.events = [ ... segment.events, ... watch.events ];
			watch.overflow ||= segment.overflow;

		}
		const lifeRep = life.report();
		const st = lastStats || {};

		const rep = {

			name: sc.name,
			seconds: sc.seconds,
			ants: params.antCount,
			stats: { morts: st.eaten ?? - 1, livraisons: st.delivered ?? - 1,
				pontes: st.laid ?? - 1, éclosions: st.hatched ?? - 1 },
			anomalies: {
				depassementsCinematiques3D: watch.counters[ 0 ],
				warpXZ: watch.counters[ 1 ],
				horsCorridor: watch.counters[ 2 ],
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

		// Un seul écart structurel suffit à faire échouer la campagne.
		const ok = watch.counters.slice( 0, 8 ).every( ( value ) => value === 0 );

		rep.pass = ok;
		console.log( `${ ok ? '✅' : '❌' } « ${ sc.name } » — cinématique3D=${ rep.anomalies.depassementsCinematiques3D }`
			+ ` horsCorridor=${ rep.anomalies.horsCorridor }, toupies=${ rep.anomalies.toupies }`
			+ ` bloquées=${ rep.anomalies.bloquées } mortsEnToupie=${ rep.anomalies.mortsEnToupie }`
			+ ` cycle=${ rep.cycleDeVie.healthy }/${ rep.cycleDeVie.total } saines` );
		if ( ! ok && rep.events.length ) {

			console.log( `[warden-events] ${ JSON.stringify( rep.events.slice( 0, 8 ) ) }` );
			console.log( `[warden-traces] ${ JSON.stringify( lifeRep.traces.slice( - 8 ) ) }` );

		}

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
				{ name: 'capacité maximale', ants: MAX_ANTS, seconds: Math.min( seconds, 5 ) },
				{ name: 'profondeur extrême', ants: 869, seconds: Math.min( seconds, 10 ),
					configure: () => { params.nestDepth = 200; sim.layout.rebuild(); } },
				{ name: 'tunnels étroits', ants: 869, seconds,
					configure: () => { params.nestTunnelW = MIN_TUNNEL_WIDTH; sim.layout.rebuild(); } },
				{ name: 'tunnels larges', ants: 869, seconds,
					configure: () => { params.nestTunnelW = 10; sim.layout.rebuild(); } },
				{ name: 'famine', ants: 869, seconds: Math.min( seconds, 150 ),
					configure: () => {

						sim.u.granaryStart.value = 0;
						sim.u.energyLife.value = 45;

					} },
				{ name: 'croissance append-only en trajet', ants: 869, seconds: Math.min( seconds, 20 ),
					during: async () => {
						await sim.synchronize();
						if ( sim.layout.growTo( Math.min( K_MAX, sim.layout.K + 4 ) ) ) sim.applyLayout();
						await sim.synchronize();
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
