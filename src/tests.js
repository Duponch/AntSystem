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
		return { st, d, v, n };

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

			// T1 — castes & spawn : reine en chambre royale, nourrices sous terre,
			// énergie initiale randomisée non nulle
			{

				params.antCount = 869;
				sim.u.antCount.value = 869;
				await sim.reset();
				await colony.reset();
				const { st, d, v, n } = await readAntSample( 869 );
				const queenUnder = ( st[ 0 ] & 8 ) !== 0;
				const qx = d[ 0 ], qy = d[ 1 ];
				const L = sim.layout;
				const dQueen = Math.hypot( qx - L.troughs.queen.x, qy - L.troughs.queen.y );
				let under = 0, badEnergy = 0;

				for ( let i = 0; i < n; i ++ ) {

					if ( st[ i ] & 8 ) under ++;
					if ( v[ i * 4 + 2 ] < 0.45 || v[ i * 4 + 2 ] > 1.001 ) badEnergy ++;

				}

				const expectedNurses = params.nurseRatio * n;
				report( 'T1 castes & spawn', queenUnder && dQueen < 8 && under > expectedNurses * 0.5
					&& under < expectedNurses * 2 + 10 && badEnergy === 0,
				`reine sous terre=${queenUnder} à ${dQueen.toFixed( 1 )} texels de sa chambre ; ` +
					`${under} sous terre (~${Math.round( expectedNurses )} attendues) ; énergies hors borne=${badEnergy}` );

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

				const { st, d, n } = await readAntSample( 2048 );
				let out = 0, under = 0;

				for ( let i = 0; i < n; i ++ ) {

					if ( ( st[ i ] & 8 ) === 0 || ( st[ i ] & 7 ) >= 2 ) continue;
					under ++;
					if ( Math.hypot( d[ i * 4 ] - NEST.x, d[ i * 4 + 1 ] - NEST.y ) > 130 ) out ++;

				}

				report( 'T4 souterraines confinées au nid', under > 0 && out === 0,
					`${under} sous terre, ${out} hors de l'enceinte (>130 texels)` );

			}

			// T5 — livraison au grenier : nourriture proche → porteuses → stock
			{

				await sim.reset();
				await colony.reset();
				// gros gisement à 45 texels du nid : ramassage quasi immédiat
				sim.queueBrush( NEST.x + 45, NEST.y, 0, 12, params.foodAmount );
				sim.drainBrush();

				let delivered = 0;

				for ( let k = 0; k < 24 && delivered === 0; k ++ ) {

					await steps( 5 );
					const st = await tick();
					delivered = st.delivered;

				}

				report( 'T5 livraison au grenier', delivered > 0,
					`${delivered} livraison(s) au grenier en ≤120 s (gisement à 45 texels)` );

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
				sim.queueBrush( NEST.x + 45, NEST.y, 0, 12, params.foodAmount );
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
				await steps( 3 );

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
		return { passed, total: results.length, results: results.slice() };

	}

	return { run, results };

}
