/**
 * Deterministic fixed-step simulation clock.
 *
 * Wall-clock deltas are converted to integer time units while their sub-unit
 * remainder is retained as an exact dyadic rational. Therefore neither frame
 * partitioning nor a catch-up budget can silently discard simulation time.
 */

export const DEFAULT_SIMULATION_STEP = 1 / 60;

// Divisible by 60, 120 and 240. One unit is roughly 16.7 picoseconds, which is
// fine enough to absorb IEEE-754 representation noise without long-term drift.
export const SIMULATION_TIME_UNITS_PER_SECOND = 60_000_000_000n;

const UNITS_PER_SECOND_NUMBER = Number( SIMULATION_TIME_UNITS_PER_SECOND );
const MAX_SAFE_BIGINT = BigInt( Number.MAX_SAFE_INTEGER );
const NOOP = () => {};

const floatBuffer = new ArrayBuffer( 8 );
const floatView = new DataView( floatBuffer );

function assertFiniteNonNegative( value, name ) {

	if ( ! Number.isFinite( value ) || value < 0 ) {

		throw new RangeError( `${ name } must be a finite non-negative number` );

	}

}

function decomposePositiveDouble( value ) {

	if ( value === 0 ) return { coefficient: 0n, exponent: 0 };

	floatView.setFloat64( 0, value, false );
	const high = floatView.getUint32( 0, false );
	const low = floatView.getUint32( 4, false );
	const exponentBits = ( high >>> 20 ) & 0x7ff;
	const fraction = ( BigInt( high & 0xfffff ) << 32n ) | BigInt( low );

	if ( exponentBits === 0 ) {

		// Subnormal: fraction * 2^-1074.
		return { coefficient: fraction, exponent: - 1074 };

	}

	// Normal: (2^52 + fraction) * 2^(unbiasedExponent - 52).
	return {
		coefficient: ( 1n << 52n ) | fraction,
		exponent: exponentBits - 1023 - 52,
	};

}

function addDyadic( leftCoefficient, leftExponent, rightCoefficient, rightExponent ) {

	if ( leftCoefficient === 0n ) return {
		coefficient: rightCoefficient,
		exponent: rightExponent,
	};
	if ( rightCoefficient === 0n ) return {
		coefficient: leftCoefficient,
		exponent: leftExponent,
	};

	const exponent = Math.min( leftExponent, rightExponent );
	const leftShift = BigInt( leftExponent - exponent );
	const rightShift = BigInt( rightExponent - exponent );
	return {
		coefficient:
			( leftCoefficient << leftShift ) +
			( rightCoefficient << rightShift ),
		exponent,
	};

}

function roundDyadicToInteger( coefficient, exponent ) {

	if ( coefficient === 0n ) return 0n;
	if ( exponent >= 0 ) return coefficient << BigInt( exponent );

	const divisor = 1n << BigInt( - exponent );
	const negative = coefficient < 0n;
	const magnitude = negative ? - coefficient : coefficient;
	let quotient = magnitude / divisor;
	const remainder = magnitude % divisor;

	// Half units are rounded away from zero. In practice ties are exceptionally
	// rare; the retained residual makes the choice deterministic either way.
	if ( remainder * 2n >= divisor ) quotient ++;
	return negative ? - quotient : quotient;

}

function secondsToNearestUnits( seconds ) {

	const value = decomposePositiveDouble( seconds );
	return roundDyadicToInteger(
		value.coefficient * SIMULATION_TIME_UNITS_PER_SECOND,
		value.exponent,
	);

}

function unitsToSeconds( units ) {

	return Number( units ) / UNITS_PER_SECOND_NUMBER;

}

function exactCountToNumber( count ) {

	return count <= MAX_SAFE_BIGINT ? Number( count ) : Number.POSITIVE_INFINITY;

}

function validateBudget( value ) {

	if ( value === Number.POSITIVE_INFINITY ) return value;
	if ( ! Number.isSafeInteger( value ) || value < 0 ) {

		throw new RangeError( 'maxStepsPerAdvance must be a non-negative safe integer or Infinity' );

	}
	return value;

}

export class SimulationClock {

	constructor( {
		fixedStep = DEFAULT_SIMULATION_STEP,
		maxStepsPerAdvance = Number.POSITIVE_INFINITY,
	} = {} ) {

		if ( ! Number.isFinite( fixedStep ) || fixedStep <= 0 ) {

			throw new RangeError( 'fixedStep must be a finite positive number' );

		}

		this._stepUnits = secondsToNearestUnits( fixedStep );
		if ( this._stepUnits <= 0n ) {

			throw new RangeError( 'fixedStep is smaller than the clock resolution' );

		}

		this.fixedStep = unitsToSeconds( this._stepUnits );
		this.maxStepsPerAdvance = validateBudget( maxStepsPerAdvance );

		this._tickExact = 0n;
		this._effectiveUnits = 0n;
		this._requestedUnits = 0n;
		this._backlogUnits = 0n;
		this._fractionCoefficient = 0n;
		this._fractionExponent = 0;

		this._telemetry = {
			requested: 0,
			effective: 0,
			backlog: 0,
			requestedTotal: 0,
			effectiveTotal: 0,
			requestedUnits: 0n,
			effectiveUnits: 0n,
			backlogUnits: 0n,
			requestedSteps: 0,
			effectiveSteps: 0,
			backlogSteps: 0,
			requestedStepsExact: 0n,
			effectiveStepsExact: 0n,
			backlogStepsExact: 0n,
			tick: 0,
			tickExact: 0n,
			time: 0,
			timeUnits: 0n,
			alpha: 0,
			budgetLimited: false,
		};

	}

	get tick() {

		return exactCountToNumber( this._tickExact );

	}

	get tickExact() {

		return this._tickExact;

	}

	get time() {

		return unitsToSeconds( this._effectiveUnits );

	}

	get timeUnits() {

		return this._effectiveUnits;

	}

	get backlog() {

		return unitsToSeconds( this._backlogUnits );

	}

	get backlogUnits() {

		return this._backlogUnits;

	}

	get alpha() {

		if ( this._backlogUnits >= this._stepUnits ) return 1;
		return Number( this._backlogUnits ) / Number( this._stepUnits );

	}

	get telemetry() {

		return this._telemetry;

	}

	setMaxStepsPerAdvance( value ) {

		this.maxStepsPerAdvance = validateBudget( value );
		return this.maxStepsPerAdvance;

	}

	reset() {

		this._tickExact = 0n;
		this._effectiveUnits = 0n;
		this._requestedUnits = 0n;
		this._backlogUnits = 0n;
		this._fractionCoefficient = 0n;
		this._fractionExponent = 0;
		this._updateTelemetry( 0n, 0n, 0n, false );
		return this._telemetry;

	}

	discardBacklog() {

		this._backlogUnits = 0n;
		this._fractionCoefficient = 0n;
		this._fractionExponent = 0;
		this._updateTelemetry( 0n, 0n, 0n, false );
		return this._telemetry;

	}

	_addRequestedTime( realDt, speed ) {

		if ( realDt === 0 || speed === 0 ) return 0n;

		const real = decomposePositiveDouble( realDt );
		const scale = decomposePositiveDouble( speed );
		const requestedCoefficient =
			real.coefficient *
			scale.coefficient *
			SIMULATION_TIME_UNITS_PER_SECOND;
		const requestedExponent = real.exponent + scale.exponent;
		const combined = addDyadic(
			this._fractionCoefficient,
			this._fractionExponent,
			requestedCoefficient,
			requestedExponent,
		);
		const wholeUnits = roundDyadicToInteger( combined.coefficient, combined.exponent );
		const residual = addDyadic(
			combined.coefficient,
			combined.exponent,
			- wholeUnits,
			0,
		);

		this._fractionCoefficient = residual.coefficient;
		this._fractionExponent = residual.exponent;
		this._requestedUnits += wholeUnits;
		this._backlogUnits += wholeUnits;
		return wholeUnits;

	}

	_updateTelemetry( requestedUnits, effectiveUnits, requestedSteps, budgetLimited ) {

		const backlogSteps = this._backlogUnits / this._stepUnits;
		const telemetry = this._telemetry;
		telemetry.requested = unitsToSeconds( requestedUnits );
		telemetry.effective = unitsToSeconds( effectiveUnits );
		telemetry.backlog = unitsToSeconds( this._backlogUnits );
		telemetry.requestedTotal = unitsToSeconds( this._requestedUnits );
		telemetry.effectiveTotal = unitsToSeconds( this._effectiveUnits );
		telemetry.requestedUnits = requestedUnits;
		telemetry.effectiveUnits = effectiveUnits;
		telemetry.backlogUnits = this._backlogUnits;
		telemetry.requestedSteps = exactCountToNumber( requestedSteps );
		telemetry.effectiveSteps = exactCountToNumber( effectiveUnits / this._stepUnits );
		telemetry.backlogSteps = exactCountToNumber( backlogSteps );
		telemetry.requestedStepsExact = requestedSteps;
		telemetry.effectiveStepsExact = effectiveUnits / this._stepUnits;
		telemetry.backlogStepsExact = backlogSteps;
		telemetry.tick = this.tick;
		telemetry.tickExact = this._tickExact;
		telemetry.time = this.time;
		telemetry.timeUnits = this._effectiveUnits;
		telemetry.alpha = this.alpha;
		telemetry.budgetLimited = budgetLimited;
		return telemetry;

	}

	advance( realDt, speed, stepFn = NOOP ) {

		assertFiniteNonNegative( realDt, 'realDt' );
		assertFiniteNonNegative( speed, 'speed' );
		if ( typeof stepFn !== 'function' ) throw new TypeError( 'stepFn must be a function' );

		// A zero speed is a true pause: new wall time is ignored and an existing
		// catch-up debt is intentionally not consumed until the simulation resumes.
		if ( speed === 0 ) return this._updateTelemetry( 0n, 0n, 0n, false );

		const requestedUnits = this._addRequestedTime( realDt, speed );
		const availableSteps = this._backlogUnits / this._stepUnits;
		const budget = this.maxStepsPerAdvance === Number.POSITIVE_INFINITY ?
			availableSteps :
			BigInt( this.maxStepsPerAdvance );
		const stepsToRun = availableSteps < budget ? availableSteps : budget;
		let executedSteps = 0n;

		for ( let index = 0n; index < stepsToRun; index ++ ) {

			const nextTick = this._tickExact + 1n;
			const nextTimeUnits = this._effectiveUnits + this._stepUnits;
			stepFn(
				this.fixedStep,
				exactCountToNumber( nextTick ),
				unitsToSeconds( nextTimeUnits ),
			);
			this._backlogUnits -= this._stepUnits;
			this._effectiveUnits = nextTimeUnits;
			this._tickExact = nextTick;
			executedSteps ++;

		}

		const effectiveUnits = executedSteps * this._stepUnits;
		return this._updateTelemetry(
			requestedUnits,
			effectiveUnits,
			availableSteps,
			executedSteps < availableSteps,
		);

	}

}

export function createSimulationClock( options ) {

	return new SimulationClock( options );

}
