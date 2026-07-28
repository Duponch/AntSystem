/**
 * Deterministic, renderer-agnostic honey-bee foraging kernel.
 *
 * Biology is split in two fixed-cost layers: visible adult representatives
 * forage, while aggregate cohorts model queen, brood and worker renewal.
 * Durations are game seconds; a configurable biological clock preserves ratios.
 */

export const BEE_STATE = Object.freeze( {
	IN_HIVE: 0,
	ORIENTATION: 1,
	OUTBOUND: 2,
	APPROACH: 3,
	FORAGE: 4,
	RETURN: 5,
	UNLOAD: 6,
	REST: 7,
} );

export const BEE_STATE_NAMES = Object.freeze( [
	'IN_HIVE',
	'ORIENTATION',
	'OUTBOUND',
	'APPROACH',
	'FORAGE',
	'RETURN',
	'UNLOAD',
	'REST',
] );

export const BEE_RESOURCE = Object.freeze( {
	NECTAR: 0,
	POLLEN: 1,
} );

export const BEE_CLIP = Object.freeze( {
	FLIGHT: 0,
	FORAGE: 1,
	HIDDEN: 2,
} );

// A fixed candidate budget makes flower assignment O(1), independently of
// flower count. Patch memory and resource quality break purely random choices.
export const FLOWER_CANDIDATE_SAMPLES = 4;

const UINT32_SCALE = 1 / 4294967296;
const TWO_PI = Math.PI * 2;
const NO_TARGET = - 1;
const DEFAULT_WEATHER = Object.freeze( {
	temperatureC: 20,
	rain: 0,
	windSpeed: 0,
} );
const DEFAULT_DEMAND = Object.freeze( {
	nectar: 0.65,
	pollen: 0.35,
} );
const DEFAULT_COLONY = Object.freeze( {
	nutrition: 1,
	season: 1,
	layingMultiplier: 1,
} );
const DEFAULT_HIVE = Object.freeze( {
	x: 0,
	y: 1,
	z: 0,
} );

function clamp01( value ) {

	return value <= 0 ? 0 : value >= 1 ? 1 : value;

}

function smoothstep( low, high, value ) {

	const x = clamp01( ( value - low ) / ( high - low ) );
	return x * x * ( 3 - 2 * x );

}

function hash32( value ) {

	let x = value >>> 0;
	x ^= x >>> 16;
	x = Math.imul( x, 0x7feb352d );
	x ^= x >>> 15;
	x = Math.imul( x, 0x846ca68b );
	x ^= x >>> 16;
	return x >>> 0 || 0x9e3779b9;

}

function assertPositiveInteger( name, value ) {

	if ( ! Number.isInteger( value ) || value <= 0 ) {

		throw new RangeError( `${ name } must be a positive integer` );

	}

}

/**
 * Inputs accepted by update(dt, context):
 * {
 *   daylight: 0..1,
 *   weather: { temperatureC, rain: 0..1, windSpeed },
 *   hive: { x, y, z },
 *   demand: { nectar: 0..1, pollen: 0..1 },
 *   colony: { queenPresent?, nutrition?, season?, layingMultiplier? },
 *   flowers: {
 *     count, x, y, z,                  // required SoA position arrays
 *     active?, patch?, quality?,       // optional indexed arrays
 *     nectar?, pollen?                 // optional mutable stocks
 *   }
 * }
 */
export class BeeSimulation {

	constructor( {
		capacity = 256,
		initialCount = 0,
		seed = 0xbee5eed,
		flightSpeed = 7,
		approachSpeed = 2.4,
		approachRadius = 0.55,
		landingRadius = 0.16,
		orientationRadius = 1.6,
		loadCapacity = 1,
		harvestPerVisit = 0.34,
		flightEnergyPerUnit = 0.0018,
		biologicalDaysPerSecond = 0.0125,
		durationScale = 1,
		queenPresent = true,
		queenEggsPerDay = 1200,
		initialAdultWorkers = 12000,
		initialEggs = 0,
		initialLarvae = 0,
		initialPupae = 0,
		adultDailyMortality = 0.02,
		adultCapacityForFullLaying = 5000,
		eggDurationDays = 3,
		larvaDurationDays = 6,
		pupaDurationDays = 12,
		eggSurvival = 0.96,
		larvaSurvival = 0.94,
		pupaSurvival = 0.98,
		cohortStepDays = 0.25,
		representativeLifespanDays = 8,
		representativeLifespanSpreadDays = 4,
	} = {} ) {

		assertPositiveInteger( 'capacity', capacity );
		if ( ! Number.isInteger( initialCount ) || initialCount < 0 || initialCount > capacity ) {

			throw new RangeError( 'initialCount must be an integer within capacity' );

		}

		this.capacity = capacity;
		this.count = 0;
		this.seed = seed >>> 0;
		this.time = 0;

		this.flightSpeed = Math.max( 0.01, flightSpeed );
		this.approachSpeed = Math.max( 0.01, approachSpeed );
		this.approachRadius = Math.max( landingRadius, approachRadius );
		this.landingRadius = Math.max( 0.01, landingRadius );
		this.orientationRadius = Math.max( 0.05, orientationRadius );
		this.loadCapacity = Math.max( 0.01, loadCapacity );
		this.harvestPerVisit = Math.max( 0.001, harvestPerVisit );
		this.flightEnergyPerUnit = Math.max( 0, flightEnergyPerUnit );
		this.biologicalDaysPerSecond = Math.max( 0, biologicalDaysPerSecond );
		this.durationScale = Math.max( 0.01, durationScale );
		this.queenPresent = !! queenPresent;
		this.queenEggsPerDay = Math.max( 0, queenEggsPerDay );
		this.adultWorkers = Math.max( 0, initialAdultWorkers );
		this.adultDailyMortality = Math.max( 0, adultDailyMortality );
		this.adultCapacityForFullLaying = Math.max( 1, adultCapacityForFullLaying );
		this.eggSurvival = clamp01( eggSurvival );
		this.larvaSurvival = clamp01( larvaSurvival );
		this.pupaSurvival = clamp01( pupaSurvival );
		this.cohortStepDays = Math.max( 1 / 24, cohortStepDays );
		this.representativeLifespanDays = Math.max( 0.1, representativeLifespanDays );
		this.representativeLifespanSpreadDays = Math.max( 0, representativeLifespanSpreadDays );

		// Fixed delay lines approximate the biological 3 d egg + 6 d larva +
		// 12 d pupa sequence. Cost depends on resolution, never population size.
		const eggBucketCount = Math.max( 1, Math.round( Math.max( this.cohortStepDays, eggDurationDays ) / this.cohortStepDays ) );
		const larvaBucketCount = Math.max( 1, Math.round( Math.max( this.cohortStepDays, larvaDurationDays ) / this.cohortStepDays ) );
		const pupaBucketCount = Math.max( 1, Math.round( Math.max( this.cohortStepDays, pupaDurationDays ) / this.cohortStepDays ) );
		this.eggCohorts = new Float64Array( eggBucketCount );
		this.larvaCohorts = new Float64Array( larvaBucketCount );
		this.pupaCohorts = new Float64Array( pupaBucketCount );
		this.eggHead = 0;
		this.larvaHead = 0;
		this.pupaHead = 0;
		this.eggCount = Math.max( 0, initialEggs );
		this.larvaCount = Math.max( 0, initialLarvae );
		this.pupaCount = Math.max( 0, initialPupae );
		const eggsPerBucket = this.eggCount / this.eggCohorts.length;
		const larvaePerBucket = this.larvaCount / this.larvaCohorts.length;
		const pupaePerBucket = this.pupaCount / this.pupaCohorts.length;
		this.eggCohorts.fill( eggsPerBucket );
		this.larvaCohorts.fill( larvaePerBucket );
		this.pupaCohorts.fill( pupaePerBucket );
		this._cohortAccumulatorDays = 0;

		// Structure-of-arrays: fixed backing stores, suitable for direct upload
		// to GPU storage/instance buffers.
		this.state = new Uint8Array( capacity );
		this.clip = new Uint8Array( capacity );
		this.resource = new Uint8Array( capacity );
		this.orientationTrips = new Uint8Array( capacity );
		this.targetFlower = new Int32Array( capacity );
		this.targetPatch = new Int32Array( capacity );
		this.lastPatch = new Int32Array( capacity );
		this.rngState = new Uint32Array( capacity );
		this.generation = new Uint32Array( capacity );

		this.x = new Float32Array( capacity );
		this.y = new Float32Array( capacity );
		this.z = new Float32Array( capacity );
		this.headingX = new Float32Array( capacity );
		this.headingY = new Float32Array( capacity );
		this.headingZ = new Float32Array( capacity );
		this.stateTime = new Float32Array( capacity );
		this.animationTime = new Float32Array( capacity );
		this.ageDays = new Float32Array( capacity );
		this.experience = new Float32Array( capacity );
		this.energy = new Float32Array( capacity );
		this.load = new Float32Array( capacity );
		this.specialization = new Float32Array( capacity );
		this.retireAgeDays = new Float32Array( capacity );

		this.targetFlower.fill( NO_TARGET );
		this.targetPatch.fill( NO_TARGET );
		this.lastPatch.fill( NO_TARGET );

		this._stateCounts = new Uint32Array( BEE_STATE_NAMES.length );
		this._telemetry = {
			time: 0,
			count: 0,
			airborne: 0,
			foraging: 0,
			atHive: 0,
			flightCondition: 0,
			meanEnergy: 0,
			meanLoad: 0,
			tripsStarted: 0,
			tripsCompleted: 0,
			flowerVisits: 0,
			abortedTrips: 0,
			deliveredNectar: 0,
			deliveredPollen: 0,
			distanceTravelled: 0,
			stateCounts: this._stateCounts,
		};

		// Stable object identity: render loops can cache this once.
		this._views = Object.freeze( {
			state: this.state,
			clip: this.clip,
			resource: this.resource,
			targetFlower: this.targetFlower,
			targetPatch: this.targetPatch,
			x: this.x,
			y: this.y,
			z: this.z,
			headingX: this.headingX,
			headingY: this.headingY,
			headingZ: this.headingZ,
			animationTime: this.animationTime,
			ageDays: this.ageDays,
			experience: this.experience,
			energy: this.energy,
			load: this.load,
			generation: this.generation,
			retireAgeDays: this.retireAgeDays,
		} );

		this._demographyTelemetry = {
			queenPresent: this.queenPresent,
			layingRatePerDay: 0,
			eggs: 0,
			larvae: 0,
			pupae: 0,
			adultWorkers: this.adultWorkers,
			laidEggs: 0,
			emergedWorkers: 0,
			adultDeaths: 0,
			broodDeaths: 0,
			representativeRecycles: 0,
			workersPerRepresentative: 0,
			cohortAdvances: 0,
			eggHead: 0,
			larvaHead: 0,
			pupaHead: 0,
		};
		this._demographyViews = Object.freeze( {
			eggs: this.eggCohorts,
			larvae: this.larvaCohorts,
			pupae: this.pupaCohorts,
		} );
		this._telemetry.demography = this._demographyTelemetry;

		this.addBees( initialCount );
		this._updateDemography( 0, DEFAULT_COLONY );

	}

	_random( index ) {

		let x = this.rngState[ index ];
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		this.rngState[ index ] = x || 0x9e3779b9;
		return x * UINT32_SCALE;

	}

	_duration( index, minimum, spread ) {

		return ( minimum + this._random( index ) * spread ) * this.durationScale;

	}

	_setState( index, state, duration ) {

		this.state[ index ] = state;
		this.stateTime[ index ] = duration;
		const nextClip = state === BEE_STATE.FORAGE || state === BEE_STATE.UNLOAD ?
			BEE_CLIP.FORAGE :
			state === BEE_STATE.IN_HIVE || state === BEE_STATE.REST ?
				BEE_CLIP.HIDDEN :
				BEE_CLIP.FLIGHT;
		if ( this.clip[ index ] !== nextClip ) this.animationTime[ index ] = 0;
		this.clip[ index ] = nextClip;

	}

	addBees( amount, hive = DEFAULT_HIVE ) {

		if ( ! Number.isInteger( amount ) || amount < 0 || this.count + amount > this.capacity ) {

			throw new RangeError( 'amount must fit the remaining bee capacity' );

		}

		const end = this.count + amount;
		for ( let i = this.count; i < end; i ++ ) {

			this.rngState[ i ] = hash32( this.seed + Math.imul( i + 1, 0x9e3779b9 ) );
			this.x[ i ] = hive.x;
			this.y[ i ] = hive.y;
			this.z[ i ] = hive.z;
			this.headingX[ i ] = 1;
			this.headingY[ i ] = 0;
			this.headingZ[ i ] = 0;
			this.ageDays[ i ] = 18 + this._random( i ) * 8;
			this.experience[ i ] = this._random( i ) * 0.2;
			this.energy[ i ] = 0.72 + this._random( i ) * 0.28;
			this.load[ i ] = 0;
			// Low values bias nectar, high values pollen. Specialization is a
			// preference rather than a rigid caste, matching observed plasticity.
			this.specialization[ i ] = 0.15 + this._random( i ) * 0.7;
			this.orientationTrips[ i ] = 1 + ( this._random( i ) < 0.35 ? 1 : 0 );
			this.generation[ i ] = 0;
			this.retireAgeDays[ i ] = this.ageDays[ i ] + this.representativeLifespanDays +
				this._random( i ) * this.representativeLifespanSpreadDays;
			this.targetFlower[ i ] = NO_TARGET;
			this.targetPatch[ i ] = NO_TARGET;
			this.lastPatch[ i ] = NO_TARGET;
			this._setState( i, BEE_STATE.IN_HIVE, this._duration( i, 0.2, 2.2 ) );

		}

		this.count = end;
		if ( this._demographyTelemetry ) {

			this._demographyTelemetry.workersPerRepresentative = this.count > 0 ?
				this.adultWorkers / this.count :
				0;

		}
		return this.count;

	}

	getViews() {

		return this._views;

	}

	getTelemetry() {

		return this._telemetry;

	}

	getDemographyViews() {

		return this._demographyViews;

	}

	setQueenPresent( present ) {

		this.queenPresent = !! present;
		return this.queenPresent;

	}

	_advanceCohorts() {

		// Oldest stages advance first so even a one-bucket delay still lasts one
		// complete demographic quantum.
		let next = ( this.pupaHead + 1 ) % this.pupaCohorts.length;
		let matured = this.pupaCohorts[ next ];
		this.pupaCohorts[ next ] = 0;
		this.pupaHead = next;
		this.pupaCount = Math.max( 0, this.pupaCount - matured );
		let survivors = matured * this.pupaSurvival;
		this.adultWorkers += survivors;
		this._demographyTelemetry.emergedWorkers += survivors;
		this._demographyTelemetry.broodDeaths += matured - survivors;

		next = ( this.larvaHead + 1 ) % this.larvaCohorts.length;
		matured = this.larvaCohorts[ next ];
		this.larvaCohorts[ next ] = 0;
		this.larvaHead = next;
		this.larvaCount = Math.max( 0, this.larvaCount - matured );
		survivors = matured * this.larvaSurvival;
		this.pupaCohorts[ this.pupaHead ] += survivors;
		this.pupaCount += survivors;
		this._demographyTelemetry.broodDeaths += matured - survivors;

		next = ( this.eggHead + 1 ) % this.eggCohorts.length;
		matured = this.eggCohorts[ next ];
		this.eggCohorts[ next ] = 0;
		this.eggHead = next;
		this.eggCount = Math.max( 0, this.eggCount - matured );
		survivors = matured * this.eggSurvival;
		this.larvaCohorts[ this.larvaHead ] += survivors;
		this.larvaCount += survivors;
		this._demographyTelemetry.broodDeaths += matured - survivors;
		this._demographyTelemetry.cohortAdvances ++;

	}

	_updateDemography( biologicalDays, colony ) {

		if ( colony.queenPresent !== undefined ) this.queenPresent = !! colony.queenPresent;
		const nutrition = clamp01( colony.nutrition === undefined ? 1 : colony.nutrition );
		const season = clamp01( colony.season === undefined ? 1 : colony.season );
		const multiplier = Math.max( 0, colony.layingMultiplier === undefined ? 1 : colony.layingMultiplier );
		const workforce = clamp01( this.adultWorkers / this.adultCapacityForFullLaying );
		const layingRate = this.queenPresent ?
			this.queenEggsPerDay * nutrition * season * multiplier * workforce :
			0;
		const laid = layingRate * biologicalDays;

		if ( laid > 0 ) {

			this.eggCohorts[ this.eggHead ] += laid;
			this.eggCount += laid;
			this._demographyTelemetry.laidEggs += laid;

		}

		if ( this.adultWorkers > 0 && biologicalDays > 0 && this.adultDailyMortality > 0 ) {

			const deaths = this.adultWorkers * ( 1 - Math.exp( - this.adultDailyMortality * biologicalDays ) );
			this.adultWorkers -= deaths;
			this._demographyTelemetry.adultDeaths += deaths;

		}

		this._cohortAccumulatorDays += biologicalDays;
		while ( this._cohortAccumulatorDays + 1e-12 >= this.cohortStepDays ) {

			this._cohortAccumulatorDays -= this.cohortStepDays;
			this._advanceCohorts();

		}

		const telemetry = this._demographyTelemetry;
		telemetry.queenPresent = this.queenPresent;
		telemetry.layingRatePerDay = layingRate;
		telemetry.eggs = this.eggCount;
		telemetry.larvae = this.larvaCount;
		telemetry.pupae = this.pupaCount;
		telemetry.adultWorkers = this.adultWorkers;
		telemetry.workersPerRepresentative = this.count > 0 ? this.adultWorkers / this.count : 0;
		telemetry.eggHead = this.eggHead;
		telemetry.larvaHead = this.larvaHead;
		telemetry.pupaHead = this.pupaHead;

	}

	_recycleRepresentative( index, hive ) {

		if ( this.load[ index ] > 0 ) this._telemetry.abortedTrips ++;
		this.generation[ index ] ++;
		this.x[ index ] = hive.x;
		this.y[ index ] = hive.y;
		this.z[ index ] = hive.z;
		this.headingX[ index ] = 1;
		this.headingY[ index ] = 0;
		this.headingZ[ index ] = 0;
		this.ageDays[ index ] = 20 + this._random( index ) * 3;
		this.retireAgeDays[ index ] = this.ageDays[ index ] + this.representativeLifespanDays +
			this._random( index ) * this.representativeLifespanSpreadDays;
		this.experience[ index ] = this._random( index ) * 0.08;
		this.energy[ index ] = 0.78 + this._random( index ) * 0.22;
		this.load[ index ] = 0;
		this.specialization[ index ] = 0.15 + this._random( index ) * 0.7;
		this.orientationTrips[ index ] = 1;
		this.targetFlower[ index ] = NO_TARGET;
		this.targetPatch[ index ] = NO_TARGET;
		this.lastPatch[ index ] = NO_TARGET;
		this._setState( index, BEE_STATE.IN_HIVE, this._duration( index, 0.4, 1.8 ) );
		this._demographyTelemetry.representativeRecycles ++;

	}

	_flightCondition( daylight, weather ) {

		// Honey-bee activity rises smoothly around 10-16 C, declines in rain,
		// and is increasingly constrained above roughly 3-5 m/s wind.
		const light = smoothstep( 0.08, 0.32, daylight );
		const temperature = smoothstep( 10, 16, weather.temperatureC );
		const rain = 1 - clamp01( weather.rain );
		const wind = 1 - smoothstep( 3, 7, weather.windSpeed );
		return light * temperature * rain * wind;

	}

	_chooseResource( index, demand ) {

		const nectar = Math.max( 0.001, demand.nectar );
		const pollen = Math.max( 0.001, demand.pollen );
		const colonyPollenShare = pollen / ( nectar + pollen );
		const individualBias = this.specialization[ index ];
		const pollenProbability = clamp01( colonyPollenShare * 0.72 + individualBias * 0.28 );
		this.resource[ index ] = this._random( index ) < pollenProbability ?
			BEE_RESOURCE.POLLEN :
			BEE_RESOURCE.NECTAR;

	}

	_flowerStock( flowers, resource, flowerIndex ) {

		const stock = resource === BEE_RESOURCE.POLLEN ? flowers.pollen : flowers.nectar;
		return stock ? Math.max( 0, stock[ flowerIndex ] ) : 1;

	}

	_assignFlower( index, flowers ) {

		const count = flowers ? Math.max( 0, flowers.count | 0 ) : 0;
		if ( count === 0 ) {

			this.targetFlower[ index ] = NO_TARGET;
			this.targetPatch[ index ] = NO_TARGET;
			return false;

		}

		if ( ! flowers.x || ! flowers.y || ! flowers.z ) {

			throw new TypeError( 'flowers.x, flowers.y and flowers.z are required when flower count is positive' );

		}

		let best = NO_TARGET;
		let bestScore = - Infinity;
		const resource = this.resource[ index ];
		const previousPatch = this.lastPatch[ index ];

		for ( let sample = 0; sample < FLOWER_CANDIDATE_SAMPLES; sample ++ ) {

			const candidate = Math.floor( this._random( index ) * count );
			if ( flowers.active && ! flowers.active[ candidate ] ) continue;

			const stock = this._flowerStock( flowers, resource, candidate );
			if ( stock <= 0.0001 ) continue;

			const dx = flowers.x[ candidate ] - this.x[ index ];
			const dy = flowers.y[ candidate ] - this.y[ index ];
			const dz = flowers.z[ candidate ] - this.z[ index ];
			const distance = Math.sqrt( dx * dx + dy * dy + dz * dz );
			const quality = flowers.quality ? Math.max( 0, flowers.quality[ candidate ] ) : 1;
			const patch = flowers.patch ? flowers.patch[ candidate ] | 0 : candidate;
			const familiarity = patch === previousPatch ? 0.28 : 0;
			const score = stock * quality + familiarity - distance * 0.018;

			if ( score > bestScore ) {

				bestScore = score;
				best = candidate;

			}

		}

		if ( best === NO_TARGET ) {

			this.targetFlower[ index ] = NO_TARGET;
			this.targetPatch[ index ] = NO_TARGET;
			return false;

		}

		this.targetFlower[ index ] = best;
		this.targetPatch[ index ] = flowers.patch ? flowers.patch[ best ] | 0 : best;
		return true;

	}

	_moveToward( index, targetX, targetY, targetZ, speed, dt, airborne ) {

		const dx = targetX - this.x[ index ];
		const dy = targetY - this.y[ index ];
		const dz = targetZ - this.z[ index ];
		const distanceSquared = dx * dx + dy * dy + dz * dz;
		if ( distanceSquared <= 1e-12 ) return 0;

		const distance = Math.sqrt( distanceSquared );
		const inverse = 1 / distance;
		const step = Math.min( distance, speed * dt );
		const nx = dx * inverse;
		const ny = dy * inverse;
		const nz = dz * inverse;

		this.x[ index ] += nx * step;
		this.y[ index ] += ny * step;
		this.z[ index ] += nz * step;
		this.headingX[ index ] = nx;
		this.headingY[ index ] = ny;
		this.headingZ[ index ] = nz;

		this._telemetry.distanceTravelled += step;
		if ( airborne ) this.energy[ index ] = Math.max( 0, this.energy[ index ] - step * this.flightEnergyPerUnit );
		return distance - step;

	}

	_startTrip( index, flowers, demand ) {

		this._chooseResource( index, demand );
		if ( ! this._assignFlower( index, flowers ) ) return false;
		this._setState( index, BEE_STATE.OUTBOUND, this._duration( index, 12, 10 ) );
		this._telemetry.tripsStarted ++;
		return true;

	}

	_abortToHive( index ) {

		this.targetFlower[ index ] = NO_TARGET;
		this.targetPatch[ index ] = NO_TARGET;
		this._setState( index, BEE_STATE.RETURN, this._duration( index, 10, 8 ) );
		this._telemetry.abortedTrips ++;

	}

	_harvest( index, flowers ) {

		const target = this.targetFlower[ index ];
		if ( target < 0 || target >= ( flowers ? flowers.count | 0 : 0 ) ) return;

		const capacityLeft = Math.max( 0, this.loadCapacity - this.load[ index ] );
		const requested = Math.min(
			capacityLeft,
			this.harvestPerVisit * ( 0.75 + this._random( index ) * 0.5 ),
		);
		const stockArray = this.resource[ index ] === BEE_RESOURCE.POLLEN ? flowers.pollen : flowers.nectar;
		const available = stockArray ? Math.max( 0, stockArray[ target ] ) : requested;
		const harvested = Math.min( requested, available );

		if ( stockArray ) stockArray[ target ] = available - harvested;
		this.load[ index ] += harvested;
		this.lastPatch[ index ] = this.targetPatch[ index ];
		this.experience[ index ] = Math.min( 1, this.experience[ index ] + 0.012 );
		this._telemetry.flowerVisits ++;

	}

	update( dt, context ) {

		if ( ! Number.isFinite( dt ) || dt < 0 ) throw new RangeError( 'dt must be a finite non-negative number' );
		if ( ! context ) throw new TypeError( 'context is required' );
		if ( dt === 0 ) return this._telemetry;

		const weather = context.weather || DEFAULT_WEATHER;
		const demand = context.demand || DEFAULT_DEMAND;
		const colony = context.colony || DEFAULT_COLONY;
		const hive = context.hive || DEFAULT_HIVE;
		const flowers = context.flowers;
		const daylight = clamp01( context.daylight === undefined ? 1 : context.daylight );
		const flightCondition = this._flightCondition( daylight, weather );
		const canDepart = flightCondition >= 0.16;
		const count = this.count;
		const biologicalDays = dt * this.biologicalDaysPerSecond;

		this.time += dt;
		this._updateDemography( biologicalDays, colony );
		this._stateCounts.fill( 0 );
		this._telemetry.time = this.time;
		this._telemetry.count = count;
		this._telemetry.airborne = 0;
		this._telemetry.foraging = 0;
		this._telemetry.atHive = 0;
		this._telemetry.flightCondition = flightCondition;

		let energySum = 0;
		let loadSum = 0;

		for ( let i = 0; i < count; i ++ ) {

			const state = this.state[ i ];
			this.stateTime[ i ] -= dt;
			this.animationTime[ i ] += dt;
			this.ageDays[ i ] += biologicalDays;

			switch ( state ) {

				case BEE_STATE.IN_HIVE: {

					this.x[ i ] = hive.x;
					this.y[ i ] = hive.y;
					this.z[ i ] = hive.z;
					this.energy[ i ] = Math.min( 1, this.energy[ i ] + dt * 0.035 );
					if ( this.stateTime[ i ] <= 0 && canDepart && this.energy[ i ] >= 0.35 ) {

						if ( this.orientationTrips[ i ] > 0 ) {

							this.orientationTrips[ i ] --;
							this._setState( i, BEE_STATE.ORIENTATION, this._duration( i, 1.4, 1.2 ) );

						} else if ( ! this._startTrip( i, flowers, demand ) ) {

							this._setState( i, BEE_STATE.REST, this._duration( i, 1.5, 3 ) );

						}

					}
					break;

				}

				case BEE_STATE.ORIENTATION: {

					const phase = this.animationTime[ i ] * ( 2.2 + this.experience[ i ] );
					const radius = this.orientationRadius * ( 0.55 + 0.45 * clamp01( this.animationTime[ i ] ) );
					const targetX = hive.x + Math.cos( phase + i * 0.73 ) * radius;
					const targetY = hive.y + 0.7 + Math.sin( phase * 0.43 ) * 0.25;
					const targetZ = hive.z + Math.sin( phase + i * 0.73 ) * radius;
					this._moveToward( i, targetX, targetY, targetZ, this.approachSpeed, dt, true );
					if ( this.stateTime[ i ] <= 0 ) {

						if ( canDepart && this._startTrip( i, flowers, demand ) ) {

							// State set by _startTrip.

						} else {

							this._setState( i, BEE_STATE.RETURN, this._duration( i, 3, 2 ) );

						}

					}
					break;

				}

				case BEE_STATE.OUTBOUND: {

					const target = this.targetFlower[ i ];
					if ( target < 0 || ! flowers || target >= ( flowers.count | 0 ) || this.energy[ i ] < 0.12 ) {

						this._abortToHive( i );
						break;

					}
					const remaining = this._moveToward(
						i,
						flowers.x[ target ],
						flowers.y[ target ] + 0.55,
						flowers.z[ target ],
						this.flightSpeed,
						dt,
						true,
					);
					if ( remaining <= this.approachRadius * 3 ) {

						this._setState( i, BEE_STATE.APPROACH, this._duration( i, 2.2, 2 ) );

					} else if ( this.stateTime[ i ] <= 0 ) {

						this._abortToHive( i );

					}
					break;

				}

				case BEE_STATE.APPROACH: {

					const target = this.targetFlower[ i ];
					if ( target < 0 || ! flowers || target >= ( flowers.count | 0 ) ) {

						this._abortToHive( i );
						break;

					}
					const remaining = this._moveToward(
						i,
						flowers.x[ target ],
						flowers.y[ target ] + 0.08,
						flowers.z[ target ],
						this.approachSpeed,
						dt,
						true,
					);
					if ( remaining <= this.landingRadius ) {

						this.x[ i ] = flowers.x[ target ];
						this.y[ i ] = flowers.y[ target ] + 0.08;
						this.z[ i ] = flowers.z[ target ];
						this._setState( i, BEE_STATE.FORAGE, this._duration( i, 0.7, 1.1 ) );

					} else if ( this.stateTime[ i ] <= 0 ) {

						this._abortToHive( i );

					}
					break;

				}

				case BEE_STATE.FORAGE: {

					const target = this.targetFlower[ i ];
					if ( target >= 0 && flowers && target < ( flowers.count | 0 ) ) {

						this.x[ i ] = flowers.x[ target ];
						this.y[ i ] = flowers.y[ target ] + 0.08;
						this.z[ i ] = flowers.z[ target ];

					}
					if ( this.stateTime[ i ] <= 0 ) {

						this._harvest( i, flowers );
						const keepForaging =
							this.load[ i ] < this.loadCapacity * 0.82 &&
							this.energy[ i ] > 0.22 &&
							this._random( i ) < 0.72 &&
							this._assignFlower( i, flowers );

						if ( keepForaging ) {

							this._setState( i, BEE_STATE.APPROACH, this._duration( i, 2, 1.5 ) );

						} else {

							this.targetFlower[ i ] = NO_TARGET;
							this.targetPatch[ i ] = NO_TARGET;
							this._setState( i, BEE_STATE.RETURN, this._duration( i, 10, 8 ) );

						}

					}
					break;

				}

				case BEE_STATE.RETURN: {

					const remaining = this._moveToward(
						i,
						hive.x,
						hive.y + 0.12,
						hive.z,
						this.flightSpeed * ( 0.92 + this.experience[ i ] * 0.12 ),
						dt,
						true,
					);
					if ( remaining <= this.landingRadius * 2.5 ) {

						this.x[ i ] = hive.x;
						this.y[ i ] = hive.y;
						this.z[ i ] = hive.z;
						this._setState( i, BEE_STATE.UNLOAD, this._duration( i, 0.55, 0.85 ) );

					} else if ( this.stateTime[ i ] <= 0 ) {

						// Navigation fails safe at the hive instead of leaving a
						// permanently stuck bee in the world.
						this.x[ i ] = hive.x;
						this.y[ i ] = hive.y;
						this.z[ i ] = hive.z;
						this._setState( i, BEE_STATE.UNLOAD, this._duration( i, 0.55, 0.85 ) );

					}
					break;

				}

				case BEE_STATE.UNLOAD: {

					if ( this.stateTime[ i ] <= 0 ) {

						if ( this.resource[ i ] === BEE_RESOURCE.POLLEN ) {

							this._telemetry.deliveredPollen += this.load[ i ];

						} else {

							this._telemetry.deliveredNectar += this.load[ i ];

						}
						if ( this.load[ i ] > 0 ) this._telemetry.tripsCompleted ++;
						this.load[ i ] = 0;
						this._setState( i, BEE_STATE.REST, this._duration( i, 1.1, 3.2 ) );

					}
					break;

				}

				case BEE_STATE.REST: {

					this.x[ i ] = hive.x;
					this.y[ i ] = hive.y;
					this.z[ i ] = hive.z;
					this.energy[ i ] = Math.min( 1, this.energy[ i ] + dt * 0.06 );
					if ( this.stateTime[ i ] <= 0 ) {

						if ( canDepart && this.energy[ i ] >= 0.35 && this._startTrip( i, flowers, demand ) ) {

							// State set by _startTrip.

						} else {

							this._setState( i, BEE_STATE.IN_HIVE, this._duration( i, 1.2, 4.5 ) );

						}

					}
					break;

				}

			}

			if ( this.ageDays[ i ] >= this.retireAgeDays[ i ] ) this._recycleRepresentative( i, hive );

			const currentState = this.state[ i ];
			this._stateCounts[ currentState ] ++;
			if (
				currentState === BEE_STATE.ORIENTATION ||
				currentState === BEE_STATE.OUTBOUND ||
				currentState === BEE_STATE.APPROACH ||
				currentState === BEE_STATE.RETURN
			) {

				this._telemetry.airborne ++;

			} else if ( currentState === BEE_STATE.FORAGE ) {

				this._telemetry.foraging ++;

			} else {

				this._telemetry.atHive ++;

			}
			energySum += this.energy[ i ];
			loadSum += this.load[ i ];

		}

		this._telemetry.meanEnergy = count > 0 ? energySum / count : 0;
		this._telemetry.meanLoad = count > 0 ? loadSum / count : 0;
		return this._telemetry;

	}

	writeDebugRecord( index, output ) {

		if ( ! output || typeof output !== 'object' ) throw new TypeError( 'output object is required' );
		if ( ! Number.isInteger( index ) || index < 0 || index >= this.count ) {

			throw new RangeError( 'bee index is outside the active range' );

		}

		output.index = index;
		output.state = BEE_STATE_NAMES[ this.state[ index ] ];
		output.stateCode = this.state[ index ];
		output.clip = this.clip[ index ];
		output.positionX = this.x[ index ];
		output.positionY = this.y[ index ];
		output.positionZ = this.z[ index ];
		output.targetFlower = this.targetFlower[ index ];
		output.targetPatch = this.targetPatch[ index ];
		output.resource = this.resource[ index ] === BEE_RESOURCE.POLLEN ? 'pollen' : 'nectar';
		output.load = this.load[ index ];
		output.energy = this.energy[ index ];
		output.experience = this.experience[ index ];
		output.ageDays = this.ageDays[ index ];
		output.retireAgeDays = this.retireAgeDays[ index ];
		output.generation = this.generation[ index ];
		output.representedWorkers = this._demographyTelemetry.workersPerRepresentative;
		return output;

	}

	snapshot( index ) {

		return this.writeDebugRecord( index, {} );

	}

}

export function createBeeSimulation( options ) {

	return new BeeSimulation( options );

}
