export const SIMULATION_HZ = 120;
export const MAX_SIMULATION_STEPS_PER_FRAME = 64;
export const MAX_GPU_SUBSTEPS = 8;
export const MAX_GPU_STEP_DT = 1 / 30;
export const SPIDER_DAMAGE_INTERVAL_TICKS = 24n;
export const SPIDER_ANT_INTERVAL_TICKS = 36n;
export const COLONY_INTERVAL_TICKS = BigInt( SIMULATION_HZ );

function assertFiniteNonNegative( value, name ) {

	if ( ! Number.isFinite( value ) || value < 0 )
		throw new RangeError( `${ name } must be a finite non-negative number` );

}

/**
 * GPU-first interactive timing policy. Realtime uses one bounded pass per
 * rendered frame. Accelerated speeds use bounded substeps; excess work is
 * reported instead of becoming an unbounded catch-up debt.
 */
export function planGpuSimulationFrame( {
	wallDt = 0,
	speed = 1,
	maxSubsteps = MAX_GPU_SUBSTEPS,
	maxStepDt = MAX_GPU_STEP_DT,
} = {} ) {

	assertFiniteNonNegative( wallDt, 'wallDt' );
	assertFiniteNonNegative( speed, 'speed' );
	if ( ! Number.isSafeInteger( maxSubsteps ) || maxSubsteps < 1 )
		throw new RangeError( 'maxSubsteps must be a positive safe integer' );
	if ( ! Number.isFinite( maxStepDt ) || maxStepDt <= 0 )
		throw new RangeError( 'maxStepDt must be a finite positive number' );

	const requestedDt = wallDt * speed;
	const eligibleDt = Math.min( wallDt, maxStepDt ) * speed;
	if ( speed === 0 || eligibleDt === 0 ) return {

		mode: speed === 0 ? 'paused' : speed <= 1 ? 'realtime' : 'accelerated',
		requestedDt,
		consumedDt: 0,
		droppedDt: requestedDt,
		stepCount: 0,
		stepDt: 0,
		budgetLimited: requestedDt > 0,

	};

	if ( speed <= 1 ) return {

		mode: 'realtime',
		requestedDt,
		consumedDt: eligibleDt,
		droppedDt: Math.max( 0, requestedDt - eligibleDt ),
		stepCount: 1,
		stepDt: eligibleDt,
		budgetLimited: requestedDt - eligibleDt > 1e-12,

	};

	const requiredSteps = Math.max( 1, Math.ceil( eligibleDt / maxStepDt - 1e-12 ) );
	const stepCount = Math.min( maxSubsteps, requiredSteps );
	const consumedDt = requiredSteps <= maxSubsteps ? eligibleDt : stepCount * maxStepDt;
	const droppedDt = Math.max( 0, requestedDt - consumedDt );
	return {

		mode: 'accelerated', requestedDt, consumedDt, droppedDt, stepCount,
		stepDt: consumedDt / stepCount,
		budgetLimited: droppedDt > 1e-12,

	};

}

function normalizeTick( tick ) {

	if ( typeof tick === 'bigint' ) {

		if ( tick < 0n ) throw new RangeError( 'tick must be non-negative' );
		return tick;

	}
	if ( ! Number.isSafeInteger( tick ) || tick < 0 )
		throw new RangeError( 'tick must be a non-negative safe integer or bigint' );
	return BigInt( tick );

}

export function nextMultipleAfter( tick, interval ) {

	const normalizedTick = normalizeTick( tick );
	if ( typeof interval !== 'bigint' || interval <= 0n )
		throw new RangeError( 'interval must be a positive bigint' );
	return ( normalizedTick / interval + 1n ) * interval;

}

export function computeNextAuthorityTick( tick, {
	spiderCount = 0,
	colony = false,
} = {} ) {

	const normalizedTick = normalizeTick( tick );
	let next = null;
	const include = ( interval ) => {

		const candidate = nextMultipleAfter( normalizedTick, interval );
		if ( next === null || candidate < next ) next = candidate;

	};
	if ( spiderCount > 0 ) {

		include( SPIDER_DAMAGE_INTERVAL_TICKS );
		include( SPIDER_ANT_INTERVAL_TICKS );

	}
	if ( colony ) include( COLONY_INTERVAL_TICKS );
	return next;

}

export function authorityDueAt( tick, {
	spiderCount = 0,
	colony = false,
} = {} ) {

	const normalizedTick = normalizeTick( tick );
	return {
		spiderAnt: spiderCount > 0
			&& normalizedTick % SPIDER_ANT_INTERVAL_TICKS === 0n,
		spiderDamage: spiderCount > 0
			&& normalizedTick % SPIDER_DAMAGE_INTERVAL_TICKS === 0n,
		colony: !! colony && normalizedTick % COLONY_INTERVAL_TICKS === 0n,
	};

}
