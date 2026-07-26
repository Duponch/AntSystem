// Tests de COHÉRENCE de la colonie, lançables en jeu (headless, GPU réel).
//
// Usage : URL ?test=colony (au chargement) ou console : __antsys.tests.run()
//
// Chaque scénario : reset → configuration → pas de simulation MANUELS (la
// boucle rAF est figée) → assertions sur les buffers GPU relus → restauration.
// Rappels des pièges (mémoire du projet) : les readbacks sont sérialisés
// derrière le verrou global ; on yield à l'event loop entre les chunks ; la
// sim étant stochastique, les assertions sont des BORNES, pas des exacts.

import { params, gfx, NEST } from './config.js';
import { STARTUP_DELAY } from './colony-startup.js';
import {
	CORRIDOR_SURFACE_TRACKS,
	sampleCorridorSurface,
} from './navigation/corridor-network.js';
import { chamberPrimitive } from './navigation/support-geometry.js';

const CONFINEMENT_EPSILON_WORLD = 0.005;

// Oracle CPU du contrat NAV-SURFACE utilisé par T4. Une enceinte radiale ne
// représente plus un nid adaptatif : une chambre légitime peut se trouver bien
// au-delà de l'ancien rayon de 130 texels. L'état intrinsèque est l'autorité :
// edge=0 doit rester dans le patch du nœud encodé ; edge>0 doit coïncider avec
// l'une des pistes de contact réellement compilées.
export function undergroundConfinementIssue( layout, antId, packedState, data, dyn ) {

	const lifeState = packedState & 7;
	if ( ( packedState & 8 ) === 0 || lifeState >= 2 ) return null;
	const navigation = layout?.navigation;
	const node = ( packedState >>> 7 ) & 127;
	const navNode = navigation?.nodes?.[ node ];
	if ( ! navNode ) return `nœud ${ node } invalide`;

	const x = data[ 0 ], y = data[ 1 ];
	const edge = Math.round( dyn[ 0 ] );
	const progress = dyn[ 1 ];
	const depth = dyn[ 2 ];
	if ( ! [ x, y, edge, progress, depth ].every( Number.isFinite ) )
		return 'état intrinsèque non fini';

	if ( edge === 0 ) {

		const unit = node >= 2 ? layout.units?.[ node - 2 ] : null;
		if ( unit ) {

			const chamber = chamberPrimitive( unit );
			const dx = ( x - unit.x ) * navigation.texel;
			const dz = ( y - unit.y ) * navigation.texel;
			const dy = depth - ( unit.depth + unit.rh * 0.5 );
			const ellipsoid = ( dx / chamber.radiusX ) ** 2
				+ ( dy / chamber.radiusY ) ** 2
				+ ( dz / chamber.radiusZ ) ** 2;
			if ( depth < chamber.floorDepth - CONFINEMENT_EPSILON_WORLD
				|| ellipsoid > 1 + CONFINEMENT_EPSILON_WORLD )
				return `hors chambre du nœud ${ node }`;
			return null;

		}

		// L'entrée et le vestibule n'ont pas de primitive de chambre : leur
		// patch compact est l'enceinte physique qui relie les corridors.
		const radius = Math.max( 0.1, navNode.radius * 0.5 + 0.1 );
		if ( Math.hypot( x - navNode.x, y - navNode.y ) > radius )
			return `hors patch du nœud ${ node }`;
		if ( Math.abs( depth - navNode.depth ) > CONFINEMENT_EPSILON_WORLD )
			return `profondeur hors nœud ${ node }`;
		return null;

	}

	const corridor = navigation.corridors?.[ edge ];
	if ( ! corridor ) return `arête ${ edge } invalide`;
	if ( corridor.from !== node && corridor.to !== node )
		return `arête ${ edge } non incidente au nœud ${ node }`;
	if ( progress < - 1e-5 || progress > 1.00001 )
		return `progression ${ progress } hors arête`;

	let closest = Infinity;
	for ( let track = 0; track < CORRIDOR_SURFACE_TRACKS; track ++ ) {

		const angle = track / CORRIDOR_SURFACE_TRACKS * Math.PI * 2;
		const expected = sampleCorridorSurface( navigation, edge, progress, angle, 1 );
		closest = Math.min( closest, Math.hypot(
			( x - expected.x ) * navigation.texel,
			depth - expected.depth,
			( y - expected.y ) * navigation.texel,
		) );

	}
	return closest <= CONFINEMENT_EPSILON_WORLD
		? null
		: `hors piste ${ edge } (${ closest.toFixed( 4 ) } u)`;

}

export function createColonyTests( { sim, colony, spiders, ants, cones, renderer } ) {

	const results = [];

	function report( name, pass, detail ) {

		results.push( { name, pass, detail } );
		console.log( `${pass ? '✅' : '❌'} ${name} — ${detail}` );

	}

	// pas manuels avec yield périodique (les readbacks async doivent respirer)
	async function steps( seconds, withColony = true ) {

		const total = Math.round( seconds * 60 );

		for ( let i = 0; i < total; i ++ ) {

			sim.step( 1 / 60 );
			if ( withColony ) colony.step( 1 / 60 );
			if ( i % 240 === 239 ) await sim.readStatsDirect();   // synchro + yield

		}

	}

	async function readAntSample( n ) {

		n = Math.min( n, params.antCount );
		const st = new Uint32Array( await renderer.getArrayBufferAsync( sim.antState.value, null, 0, n * 4 ) );
		const d = new Float32Array( await renderer.getArrayBufferAsync( sim.antData.value, null, 0, n * 16 ) );
		const v = new Float32Array( await renderer.getArrayBufferAsync( sim.antVital.value, null, 0, n * 16 ) );
		const dyn = new Float32Array( await renderer.getArrayBufferAsync( sim.antDyn.value, null, 0, n * 16 ) );
		return { st, d, v, dyn, n };

	}

	async function readAntStates( n ) {

		n = Math.min( n, params.antCount );
		return new Uint32Array(
			await renderer.getArrayBufferAsync( sim.antState.value, null, 0, n * 4 ) );

	}

	// poller colonie « à la main » (ponte → semis, éclosion → activation)
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

	async function tick() {

		const st = await sim.readStatsDirect();
		colony.onStats( st, hooks() );
		await colony._dbg.pollBrood();
		return st;

	}

	// ------------------------------------------------------------------
	async function run() {

		results.length = 0;
		console.log( '🧪 Tests de cohérence de la colonie — début' );

		const saved = JSON.parse( JSON.stringify( { params: { ...params }, gfx: { ...gfx } } ) );
		const savedPop = params.antCount;
		params.paused = true;
		colony._dbg.setManualTick( true );
		if ( spiders && spiders._dbg ) spiders._dbg.setManualPoll( true );

		try {

			// T1 — COL-START : une colonie établie reprend depuis ses chambres.
			// La reine est déjà active ; toutes les autres activités sont échelonnées.
			{

				params.antCount = 869;
				sim.u.antCount.value = 869;
				await sim.reset();
				await colony.reset();
				const { st, d, v, dyn, n } = await readAntSample( 869 );
				const queenUnder = ( st[ 0 ] & 8 ) !== 0;
				const qx = d[ 0 ], qy = d[ 1 ];
				const L = sim.layout;
				const dQueen = Math.hypot( qx - L.troughs.queen.x, qy - L.troughs.queen.y );
				const queenMission = ( ( st[ 0 ] >> 4 ) & 7 ) === 0
					&& ( ( st[ 0 ] >> 7 ) & 127 ) === L.GOAL_NODE[ 2 ];
				const homeAtEntrance = Math.hypot(
					sim.u.nest.value.x - L.entry.x, sim.u.nest.value.y - L.entry.y,
				) < 1e-6;
				const exitNodes = new Set();
				let under = 0, awaitingActivation = 0, nurseMissions = 0;
				let badEnergy = 0, badDelay = 0, badMission = 0, badNode = 0;
				let badContact = 0, badIntrinsicState = 0;

				for ( let i = 0; i < n; i ++ ) {

					if ( st[ i ] & 8 ) under ++;
					if ( d[ i * 4 + 3 ] < 0 ) awaitingActivation ++;
					if ( v[ i * 4 + 2 ] < 0.45 || v[ i * 4 + 2 ] > 1.001 ) badEnergy ++;
					if ( i === 0 ) continue;

					const goal = ( st[ i ] >> 4 ) & 7;
					const node = ( st[ i ] >> 7 ) & 127;
					const delay = - d[ i * 4 + 3 ];
					if ( delay < STARTUP_DELAY.ESTABLISHED_MIN - 1e-4
						|| delay > STARTUP_DELAY.ESTABLISHED_MAX + 1e-4 ) badDelay ++;
					if ( node < 0 || node >= L.nodeCount ) { badNode ++; continue; }
					if ( goal === 1 ) {

						nurseMissions ++;
						if ( node !== L.GOAL_NODE[ 3 ] ) badMission ++;

					} else if ( goal === 4 ) {

						if ( node < 2 ) badMission ++;
						exitNodes.add( node );

					} else badMission ++;

					const navNode = L.navigation.nodes[ node ];
					const scatter = Math.hypot( d[ i * 4 ] - navNode.x, d[ i * 4 + 1 ] - navNode.y );
					const scatterMax = Math.min( params.seatScatter, navNode.radius * 0.35 ) + 0.05;
					if ( scatter > scatterMax || Math.abs( dyn[ i * 4 + 2 ] - navNode.depth ) > 0.002 )
						badContact ++;
					if ( Math.abs( dyn[ i * 4 ] ) > 1e-5 || Math.abs( dyn[ i * 4 + 1 ] ) > 1e-5
						|| Math.abs( dyn[ i * 4 + 3 ] ) > 1e-5 ) badIntrinsicState ++;

				}

				const expectedNurses = sim.u.nurseRatio.value * ( n - 1 );
				const nurseTolerance = Math.max( 12, 6 * Math.sqrt(
					Math.max( 0, expectedNurses * ( 1 - sim.u.nurseRatio.value ) ),
				) );
				const nurseDistributionOk = Math.abs( nurseMissions - expectedNurses ) <= nurseTolerance;
				const distributedHomes = exitNodes.size >= Math.min( 8, Math.max( 1, L.nodeCount - 2 ) );
				const startupOk = queenUnder && queenMission && dQueen < 8 && under === n
					&& awaitingActivation === n - 1 && badEnergy === 0 && badDelay === 0
					&& badMission === 0 && badNode === 0 && badContact === 0
					&& badIntrinsicState === 0 && nurseDistributionOk && distributedHomes && homeAtEntrance;
				report( 'T1 démarrage naturel', startupOk,
					`reine=${queenUnder}/${queenMission} ; ${under}/${n} sous terre ; ` +
					`${awaitingActivation} activations ; nourrices=${nurseMissions}/${expectedNurses.toFixed( 1 )} ; ` +
					`foyers=${exitNodes.size} ; délais=${badDelay}, missions=${badMission}, contacts=${badContact}, ` +
					`intrinsèques=${badIntrinsicState}, énergies=${badEnergy}, bouche=${homeAtEntrance}` );

			}
			// T2 — ponte quand la reine est nourrie
			{

				await steps( 35 );
				const st = await tick();
				report( 'T2 ponte (reine nourrie)', st.laid >= 2 && st.queenEnergy > 0.4,
					`${st.laid} pontes en 35 s, énergie reine ${st.queenEnergy.toFixed( 2 )}` );

			}

			// T3 — éclosion accélérée → la population CROÎT
			{

				sim.u.antCount.value = params.antCount;
				colony.u.eggDuration.value = 4;
				colony.u.larvaMealEvery.value = 2;
				colony.u.larvaMeals.value = 1;
				colony.u.pupaDuration.value = 4;
				sim.u.queenLayInterval.value = 3;
				const before = params.antCount;

				for ( let k = 0; k < 12; k ++ ) {

					await steps( 5 );
					await tick();

				}

				const st = await tick();
				report( 'T3 éclosions → croissance', st.hatched >= 3 && params.antCount > before,
					`${st.laid} pontes, ${st.hatched} éclosions, population ${before} → ${params.antCount}` );
				colony.u.eggDuration.value = params.eggDuration;
				colony.u.larvaMealEvery.value = params.larvaMealEvery;
				colony.u.larvaMeals.value = params.larvaMeals;
				colony.u.pupaDuration.value = params.pupaDuration;
				sim.u.queenLayInterval.value = params.queenLayInterval;

			}

			// T4 — les souterraines restent dans l'enceinte de la fourmilière
			{

				const { st, d, dyn, n } = await readAntSample( 2048 );
				let out = 0, under = 0;
				const examples = [];

				for ( let i = 0; i < n; i ++ ) {

					if ( ( st[ i ] & 8 ) === 0 || ( st[ i ] & 7 ) >= 2 ) continue;
					under ++;
					const issue = undergroundConfinementIssue(
						sim.layout, i, st[ i ],
						d.subarray( i * 4, i * 4 + 4 ),
						dyn.subarray( i * 4, i * 4 + 4 ),
					);
					if ( issue ) {

						out ++;
						if ( examples.length < 3 ) examples.push( `#${ i } ${ issue }` );

					}

				}

				report( 'T4 souterraines confinées au nid', under > 0 && out === 0,
					`${under} sous terre, ${out} hors du réseau intrinsèque`
					+ ( examples.length ? ` (${ examples.join( ' ; ' ) })` : '' ) );

			}

			// T5 — livraison au grenier : nourriture proche → porteuses → stock
			{

				await sim.reset();
				await colony.reset();
				// gros gisement à 45 texels du nid : ramassage quasi immédiat
				sim.queueBrush( sim.layout.entry.x + 45, sim.layout.entry.y, 0, 12, params.foodAmount );
				sim.drainBrush();

				let delivered = 0;
				let returnedCarriers = 0;
				const trackedN = Math.min( 2048, params.antCount );
				const initialStates = await readAntStates( trackedN );
				const startedUnderground = Uint8Array.from(
					initialStates, ( packed ) => ( packed & 8 ) !== 0 ? 1 : 0 );
				const seenSurface = new Uint8Array( trackedN );
				const seenCarryingOnSurface = new Uint8Array( trackedN );
				const countedReturn = new Uint8Array( trackedN );

				// Poll every 2 s: the food patch is far enough that a carrier cannot
				// complete its whole surface leg between two observations. A counted
				// ant is proven to have left, carried food on the surface, then crossed
				// back underground through the entrance.
				for ( let k = 0; k < 60 && ( delivered === 0 || returnedCarriers === 0 ); k ++ ) {

					await steps( 2 );
					const states = await readAntStates( trackedN );
					for ( let i = 0; i < trackedN; i ++ ) {

						const lifeState = states[ i ] & 7;
						if ( lifeState >= 2 ) continue;
						const underground = ( states[ i ] & 8 ) !== 0;
						if ( startedUnderground[ i ] && ! underground ) {

							seenSurface[ i ] = 1;
							if ( lifeState === 1 ) seenCarryingOnSurface[ i ] = 1;

						} else if ( seenSurface[ i ] && seenCarryingOnSurface[ i ] && ! countedReturn[ i ] ) {

							countedReturn[ i ] = 1;
							returnedCarriers ++;

						}

					}
					const st = await tick();
					delivered = st.delivered;

				}

				report( 'T5 aller-retour bouche + livraison au grenier',
					delivered > 0 && returnedCarriers > 0,
					`${returnedCarriers} porteuse(s) suivie(s) surface→sous-sol ; ` +
					`${delivered} livraison(s) en ≤120 s (gisement à 45 texels)` );

			}

			// T6 — famine : sans AUCUNE nourriture, drain accéléré → des mortes
			{

				const savedRegen = params.foodRegen;
				params.foodRegen = 0;
				sim.u.granaryStart.value = 0;
				sim.u.energyLife.value = 20;          // 20 s d'autonomie
				await sim.reset();
				await colony.reset();
				// efface les gisements de départ (gomme sur chaque blob)
				for ( const b of [ [ 250, 0.5 ], [ 320, 2.0 ], [ 200, 2.6 ], [ 270, 3.7 ], [ 300, 4.4 ], [ 360, 5.1 ] ] ) {

					sim.queueBrush( NEST.x + Math.cos( b[ 1 ] ) * b[ 0 ], NEST.y + Math.sin( b[ 1 ] ) * b[ 0 ], 2, 16, 0 );

				}

				sim.drainBrush();
				await steps( 40 );
				const st = await sim.readStatsDirect();
				report( 'T6 famine sans nourriture', st.eaten > 50,
					`${st.eaten} mortes de faim en 40 s (autonomie forcée à 20 s)` );
				params.foodRegen = savedRegen;
				sim.u.energyLife.value = params.energyLife;
				sim.u.granaryStart.value = params.granaryStart;

			}

			// T7 — le pinceau (mur + gomme) préserve le réseau creusé (bit 1)
			{

				await sim.reset();
				await colony.reset();
				const cell = sim.layout.troughs.granary.cell;
				const gx = cell % 1024, gy = Math.floor( cell / 1024 );
				sim.queueBrush( gx, gy, 1, 10, 0 );   // mur par-dessus le grenier
				sim.drainBrush();
				await steps( 0.2 );
				sim.queueBrush( gx, gy, 2, 10, 0 );   // gomme
				sim.drainBrush();
				await steps( 0.2 );
				const wallBuf = new Uint32Array( await renderer.getArrayBufferAsync( sim.wall.value, null, cell * 4, 4 ) );
				report( 'T7 pinceau vs réseau creusé', ( wallBuf[ 0 ] & 2 ) !== 0 && ( wallBuf[ 0 ] & 1 ) === 0,
					`cellule du grenier après mur+gomme : ${wallBuf[ 0 ]} (bit creusé attendu, bit mur effacé)` );

			}

			// T8 — colonie COUPÉE : comportement historique (livraison au nid,
			// personne sous terre)
			{

				sim.u.colonyOn.value = 0;
				await sim.reset();
				await colony.reset();
				sim.queueBrush( sim.layout.entry.x + 45, sim.layout.entry.y, 0, 12, params.foodAmount );
				sim.drainBrush();
				await steps( 45, false );
				const st = await sim.readStatsDirect();
				const { st: stB, n } = await readAntSample( 2048 );
				let under = 0;
				for ( let i = 0; i < n; i ++ ) if ( stB[ i ] & 8 ) under ++;
				report( 'T8 mode historique (colonie off)', st.delivered > 0 && under === 0,
					`${st.delivered} livraisons directes au nid, ${under} fourmi(s) sous terre` );
				sim.u.colonyOn.value = params.colony ? 1 : 0;

			}

			// T9 — l'échantillon des araignées exclut mortes ET souterraines
			{

				await sim.reset();
				await colony.reset();
				// COL-START garde initialement toute la colonie au nid : on laisse
				// l'activation et le trajet vers la surface se terminer avant l'échantillon.
				await steps( 45 );

				if ( spiders && spiders._dbg ) {

					await spiders._dbg.pollAnts();
					const sampleN = spiders._dbg.sampleN();
					// même fenêtre que pollAnts : TOUTE la population courante
					const { st, n } = await readAntSample( 2048 );
					let surfaceAlive = 0;
					for ( let i = 0; i < n; i ++ ) if ( ( st[ i ] & 7 ) < 2 && ( st[ i ] & 8 ) === 0 ) surfaceAlive ++;
					report( 'T9 échantillon araignées (surface vivante)', sampleN > 0 && sampleN <= surfaceAlive + 8,
						`échantillon=${sampleN}, vivantes de surface=${surfaceAlive} (les souterraines sont exclues)` );

				} else {

					report( 'T9 échantillon araignées', false, 'module araignées indisponible' );

				}

			}

			// T10 — le toggle migre toute la population, jamais un état hybride.
			{

				params.colony = true;
				sim.u.colonyOn.value = 1;
				await sim.reset();
				await colony.reset();
				const before = await readAntStates( 512 );
				let beforeUnder = 0;
				for ( const packed of before ) if ( packed & 8 ) beforeUnder ++;

				params.colony = false;
				const migratedOff = await sim.setColonyEnabled( false );
				await colony.reset();
				const off = await readAntStates( 512 );
				let offUnder = 0, offHybrid = 0;
				for ( const packed of off ) {

					if ( packed & 8 ) offUnder ++;
					if ( packed & 0xFFFFF8 ) offHybrid ++;

				}

				params.colony = true;
				const migratedOn = await sim.setColonyEnabled( true );
				await colony.reset();
				const on = await readAntSample( 512 );
				let onUnder = 0, onAwaiting = 0;
				for ( let i = 0; i < on.n; i ++ ) {

					if ( on.st[ i ] & 8 ) onUnder ++;
					if ( i > 0 && on.d[ i * 4 + 3 ] < 0 ) onAwaiting ++;

				}

				// Deux clics sans await doivent être sérialisés : le dernier mode gagne,
				// sans deux resets GPU concurrents.
				const queuedOff = sim.setColonyEnabled( false );
				const queuedOn = sim.setColonyEnabled( true );
				const queuedMigrations = await Promise.all( [ queuedOff, queuedOn ] );
				await colony.reset();
				const queuedFinal = await readAntStates( 512 );
				let queuedUnder = 0;
				for ( const packed of queuedFinal ) if ( packed & 8 ) queuedUnder ++;

				const toggleOk = beforeUnder === before.length
					&& migratedOff && offUnder === 0 && offHybrid === 0
					&& migratedOn && onUnder === on.n && onAwaiting === on.n - 1
					&& queuedMigrations.every( Boolean ) && queuedUnder === queuedFinal.length;
				report( 'T10 toggle colonie ON→OFF→ON atomique', toggleOk,
					`avant=${beforeUnder}/${before.length} sous terre ; OFF=${offUnder}, hybrides=${offHybrid} ; `
					+ `ON=${onUnder}/${on.n}, activations=${onAwaiting}, migrations=${migratedOff}/${migratedOn}, `
					+ `file=${queuedMigrations.join( '/' )}→${queuedUnder}/${queuedFinal.length}` );

			}
		} finally {

			// restauration complète
			Object.assign( params, saved.params );
			Object.assign( gfx, saved.gfx );
			params.antCount = savedPop;
			sim.u.antCount.value = savedPop;
			ants.setCount( savedPop );
			cones.setCount( savedPop );
			sim.u.colonyOn.value = params.colony ? 1 : 0;
			await sim.reset();
			await colony.reset();
			sim.refreshDisplay();
			sim.updateFieldNodes();
			colony._dbg.setManualTick( false );
			if ( spiders && spiders._dbg ) spiders._dbg.setManualPoll( false );
			params.paused = false;

		}

		const passed = results.filter( ( r ) => r.pass ).length;
		console.log( `🧪 Tests colonie : ${passed}/${results.length} OK` );
		const summary = { passed, total: results.length, results: results.slice() };
		// Canal DOM stable pour les tests fonctionnels pilotés depuis un contexte
		// navigateur isolé (sans exposer ni sérialiser les buffers GPU).
		if ( typeof document !== 'undefined' )
			document.documentElement.dataset.antTests = JSON.stringify( summary );
		return summary;

	}

	return { run, results };

}
