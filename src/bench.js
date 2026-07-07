// Banc d'essai : enchaîne N simulations headless (graines différentes) en
// accéléré GPU — aucun rendu entre les pas — et relève la nourriture livrée à
// intervalles réguliers. Sert à comparer objectivement des jeux de paramètres
// (moyenne ± écart-type, efficacité par fourmi et par minute).
//
// Usage : bouton « ▶ Lancer » (UI), URL ?bench=5x90, ou en console :
//   __antsys.bench.run({ runs: 5, seconds: 90 })

import { params } from './config.js';

export function createBench( { sim, onProgress } ) {

	async function runOne( { seconds, seed } ) {

		sim.u.seed.value = seed;
		// banc d'essai = mesure du fourragement pur : pas de prédateur (le kernel
		// n'accède alors jamais aux secteurs, pilotés par spiders.update hors headless)
		const savedSpiders = sim.u.spiderCount.value;
		sim.u.spiderCount.value = 0;
		await sim.reset();

		const dt = 1 / 60;
		const steps = Math.round( seconds / dt );
		const chunk = 900;                 // point de contrôle toutes les 15 s sim
		const checkpoints = [];

		for ( let done = 0; done < steps; ) {

			const n = Math.min( chunk, steps - done );
			for ( let s = 0; s < n; s ++ ) sim.step( dt );
			done += n;

			const st = await sim.readStatsDirect();   // sert aussi de synchro GPU
			checkpoints.push( { t: Math.round( done * dt ), delivered: st.delivered, picked: st.picked } );

		}

		sim.u.spiderCount.value = savedSpiders;
		return checkpoints;

	}

	async function run( { runs = 5, seconds = 90, label = '' } = {} ) {

		const wasPaused = params.paused;
		params.paused = true;              // fige la boucle principale

		const results = [];

		for ( let i = 0; i < runs; i ++ ) {

			if ( onProgress ) onProgress( `🧪 Essai ${i + 1}/${runs}…` );
			results.push( await runOne( { seconds, seed: 1000 + i * 7919 } ) );

		}

		sim.u.seed.value = 0;
		await sim.reset();
		params.paused = wasPaused;

		const finals = results.map( ( r ) => r[ r.length - 1 ].delivered );
		const mean = finals.reduce( ( a, b ) => a + b, 0 ) / finals.length;
		const sd = Math.sqrt( finals.reduce( ( a, b ) => a + ( b - mean ) ** 2, 0 ) / finals.length );

		// taux de retour : livrées / ramassées — LA mesure du « chemin trouvé »
		const pickedMean = results.reduce( ( a, r ) => a + r[ r.length - 1 ].picked, 0 ) / results.length;
		const returnRate = pickedMean > 0 ? mean / pickedMean : 0;

		const summary = {
			label,
			runs,
			seconds,
			antCount: params.antCount,
			deliveredMean: + mean.toFixed( 1 ),
			deliveredSd: + sd.toFixed( 1 ),
			pickedMean: + pickedMean.toFixed( 1 ),
			returnRate: + returnRate.toFixed( 3 ),
			perAntPerMin: + ( mean / params.antCount / ( seconds / 60 ) ).toFixed( 4 ),
			finals,
			params: {
				moveSpeed: params.moveSpeed, steerStrength: params.steerStrength,
				wanderStrength: params.wanderStrength, sensorAngleDeg: params.sensorAngleDeg,
				sensorDist: params.sensorDist, depositRate: params.depositRate,
				fade: params.fade, evaporation: params.evaporation, diffusion: params.diffusion,
			},
		};

		console.log( '🧪 Banc d\'essai —', label || '(paramètres courants)', summary );
		console.table( results.map( ( r, i ) => Object.fromEntries( [
			[ 'essai', i + 1 ],
			...r.map( ( c ) => [ 't=' + c.t + 's', c.delivered ] ),
		] ) ) );

		return summary;

	}

	// compare plusieurs jeux de paramètres (chacun : { label, overrides })
	async function compare( configs, { runs = 3, seconds = 90 } = {} ) {

		const backup = { ...params };
		const out = [];

		for ( const cfg of configs ) {

			Object.assign( params, cfg.overrides );
			syncUniforms();
			out.push( await run( { runs, seconds, label: cfg.label } ) );

		}

		Object.assign( params, backup );
		syncUniforms();
		await sim.reset();

		console.table( out.map( ( s ) => ( {
			config: s.label,
			'livrées (moy)': s.deliveredMean,
			'± sd': s.deliveredSd,
			'ramassées': s.pickedMean,
			'taux de retour': s.returnRate,
			'par fourmi/min': s.perAntPerMin,
		} ) ) );

		return out;

	}

	function syncUniforms() {

		sim.u.moveSpeed.value = params.moveSpeed;
		sim.u.steer.value = params.steerStrength;
		sim.u.wander.value = params.wanderStrength;
		sim.u.sensorAngle.value = params.sensorAngleDeg * Math.PI / 180;
		sim.u.sensorDist.value = params.sensorDist;
		sim.u.depositRate.value = params.depositRate;
		sim.u.fade.value = params.fade;
		sim.u.evap.value = params.evaporation;
		sim.u.diffuse.value = params.diffusion;

	}

	return { run, runOne, compare, syncUniforms };

}
