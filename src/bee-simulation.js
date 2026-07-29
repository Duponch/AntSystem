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
	TAKEOFF: 8,
	TOUCHDOWN: 9,
	DEPART: 10,
	HIVE_EXIT: 11,
	SCOUT_SEARCH: 12,
	PATCH_SEARCH: 13,
	HIVE_APPROACH: 14,
	HIVE_ENTRY: 15,
	DANCE: 16,
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
	'TAKEOFF',
	'TOUCHDOWN',
	'DEPART',
	'HIVE_EXIT',
	'SCOUT_SEARCH',
	'PATCH_SEARCH',
	'HIVE_APPROACH',
	'HIVE_ENTRY',
	'DANCE',
] );

export const BEE_STRATEGY = Object.freeze( {
	SCOUT: 0,
	RECRUIT: 1,
} );

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
const ARRIVAL_EPSILON = 1e-4;
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
 *   hive: { x, y, z,                   // backwards-compatible interior
 *     interiorX?, interiorY?, interiorZ?, entranceX?, entranceY?, entranceZ?,
 *     outsideX?, outsideY?, outsideZ? },
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
		flightAcceleration = 18,
		turnRate = 4.8,
		wanderStrength = 0.13,
		loadCapacity = 1,
		harvestPerVisit = 0.34,
		flightEnergyPerUnit = 0.0018,
		scoutRatio = 0.16,
		patchMemoryCapacity = 16,
		patchMemorySeconds = 90,
		biologicalDaysPerSecond = 0.0125,
		durationScale = 1,
		forageDurationSeconds = 10,
		honeyMaturationSeconds = 180,
		initialRawNectar = 35,
		initialHoney = 160,
		initialPollen = 70,
		initialNectarWater = null,
		adultSugarUsePerDay = 0.0009,
		broodPollenUsePerDay = 0.0012,
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
		assertPositiveInteger( 'patchMemoryCapacity', patchMemoryCapacity );
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
		this.flightAcceleration = Math.max( 0.01, flightAcceleration );
		this.turnRate = Math.max( 0.01, turnRate );
		this.wanderStrength = Math.max( 0, wanderStrength );
		this.loadCapacity = Math.max( 0.01, loadCapacity );
		this.harvestPerVisit = Math.max( 0.001, harvestPerVisit );
		this.flightEnergyPerUnit = Math.max( 0, flightEnergyPerUnit );
		this.scoutRatio = clamp01( scoutRatio );
		this.patchMemoryCapacity = Math.min( 64, patchMemoryCapacity );
		this.patchMemorySeconds = Math.max( 0.1, patchMemorySeconds );
		this.biologicalDaysPerSecond = Math.max( 0, biologicalDaysPerSecond );
		this.durationScale = Math.max( 0.01, durationScale );
		this.forageDurationSeconds = Math.max( 0.1, forageDurationSeconds );
		this.honeyMaturationSeconds = Math.max( 0.01, honeyMaturationSeconds );
		this.rawNectarSugar = Math.max( 0, initialRawNectar );
		this.rawNectarWater = Math.max(
			0,
			initialNectarWater === null ? this.rawNectarSugar * 1.5 : initialNectarWater,
		);
		this.honeySugar = Math.max( 0, initialHoney );
		this.honeyWater = this.honeySugar * 0.18 / 0.82;
		this.pollenStore = Math.max( 0, initialPollen );
		this.consumedSugar = 0;
		this.evaporatedWater = 0;
		this.adultSugarUsePerDay = Math.max( 0, adultSugarUsePerDay );
		this.broodPollenUsePerDay = Math.max( 0, broodPollenUsePerDay );
		this.internalNutrition = 1;
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
		this.strategy = new Uint8Array( capacity );
		this.orientationTrips = new Uint8Array( capacity );
		this.takeoffNextState = new Uint8Array( capacity );
		this.portalPhase = new Uint8Array( capacity );
		this.targetFlower = new Int32Array( capacity );
		this.targetPatch = new Int32Array( capacity );
		this.lastPatch = new Int32Array( capacity );
		this.lastFlower = new Int32Array( capacity );
		this.rngState = new Uint32Array( capacity );
		this.generation = new Uint32Array( capacity );

		this.x = new Float32Array( capacity );
		this.y = new Float32Array( capacity );
		this.z = new Float32Array( capacity );
		this.velocityX = new Float32Array( capacity );
		this.velocityY = new Float32Array( capacity );
		this.velocityZ = new Float32Array( capacity );
		this.flightSpeedCurrent = new Float32Array( capacity );
		this.banking = new Float32Array( capacity );
		this.headingX = new Float32Array( capacity );
		this.headingY = new Float32Array( capacity );
		this.headingZ = new Float32Array( capacity );
		this.transitionStartX = new Float32Array( capacity );
		this.transitionStartY = new Float32Array( capacity );
		this.transitionStartZ = new Float32Array( capacity );
		this.takeoffX = new Float32Array( capacity );
		this.takeoffY = new Float32Array( capacity );
		this.takeoffZ = new Float32Array( capacity );
		this.transitionStartVelocityX = new Float32Array( capacity );
		this.transitionStartVelocityY = new Float32Array( capacity );
		this.transitionStartVelocityZ = new Float32Array( capacity );
		this.transitionEndVelocityX = new Float32Array( capacity );
		this.transitionEndVelocityY = new Float32Array( capacity );
		this.transitionEndVelocityZ = new Float32Array( capacity );
		this.searchX = new Float32Array( capacity );
		this.searchY = new Float32Array( capacity );
		this.searchZ = new Float32Array( capacity );
		this.wanderPhaseA = new Float32Array( capacity );
		this.wanderPhaseB = new Float32Array( capacity );
		this.loadSugar = new Float32Array( capacity );
		this.loadWater = new Float32Array( capacity );
		this.tripProfit = new Float32Array( capacity );
		this.transitionElapsed = new Float32Array( capacity );
		this.transitionDuration = new Float32Array( capacity );
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
		this.lastFlower.fill( NO_TARGET );

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
			scoutTrips: 0,
			recruitedTrips: 0,
			danceEvents: 0,
			candidateEvaluations: 0,
			stateCounts: this._stateCounts,
		};

		// Fixed-size social memory: aggregate waggle-dance information, not one
		// object per real worker. It stays O(K) with K <= 64.
		this.patchId = new Int32Array( this.patchMemoryCapacity );
		this.patchFlower = new Int32Array( this.patchMemoryCapacity );
		this.patchResource = new Uint8Array( this.patchMemoryCapacity );
		this.patchX = new Float32Array( this.patchMemoryCapacity );
		this.patchY = new Float32Array( this.patchMemoryCapacity );
		this.patchZ = new Float32Array( this.patchMemoryCapacity );
		this.patchQuality = new Float32Array( this.patchMemoryCapacity );
		this.patchStrength = new Float32Array( this.patchMemoryCapacity );
		this.patchAge = new Float32Array( this.patchMemoryCapacity );
		this.patchId.fill( NO_TARGET );
		this.patchFlower.fill( NO_TARGET );
		this._colonyTelemetry = {
			rawNectar: this.rawNectarSugar,
			honey: this.honeySugar,
			pollen: this.pollenStore,
			sugarInTransit: 0,
			consumedSugar: 0,
			evaporatedWater: 0,
			knownPatches: 0,
			scoutFraction: this.scoutRatio,
			nectarDemand: 0,
			pollenDemand: 0,
		};
		this._colonyViews = Object.freeze( {
			patchId: this.patchId,
			patchQuality: this.patchQuality,
			patchStrength: this.patchStrength,
		} );
		this._telemetry.colony = this._colonyTelemetry;

		// Stable object identity: render loops can cache this once.
		this._views = Object.freeze( {
			state: this.state,
			clip: this.clip,
			resource: this.resource,
			strategy: this.strategy,
			targetFlower: this.targetFlower,
			targetPatch: this.targetPatch,
			x: this.x,
			y: this.y,
			z: this.z,
			velocityX: this.velocityX,
			velocityY: this.velocityY,
			velocityZ: this.velocityZ,
			banking: this.banking,
			headingX: this.headingX,
			headingY: this.headingY,
			headingZ: this.headingZ,
			takeoffX: this.takeoffX,
			takeoffY: this.takeoffY,
			takeoffZ: this.takeoffZ,
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

	_forageDuration( index ) {

		return this.forageDurationSeconds * ( 0.7 + this._random( index ) * 0.8 );

	}

	_flowerContactX( flowers, index ) {

		return flowers.contactX ? flowers.contactX[ index ] : flowers.x[ index ];

	}

	_flowerContactY( flowers, index ) {

		return flowers.contactY ? flowers.contactY[ index ] : flowers.y[ index ];

	}

	_flowerContactZ( flowers, index ) {

		return flowers.contactZ ? flowers.contactZ[ index ] : flowers.z[ index ];

	}

	_setState( index, state, duration ) {

		this.state[ index ] = state;
		this.stateTime[ index ] = duration;
		const nextClip = state === BEE_STATE.TOUCHDOWN || state === BEE_STATE.FORAGE ?
			BEE_CLIP.FORAGE :
			state === BEE_STATE.IN_HIVE ||
			state === BEE_STATE.UNLOAD ||
			state === BEE_STATE.DANCE ||
			state === BEE_STATE.REST ?
				BEE_CLIP.HIDDEN :
				BEE_CLIP.FLIGHT;
		if ( this.clip[ index ] !== nextClip ) this.animationTime[ index ] = 0;
		this.clip[ index ] = nextClip;

	}

	_hiveCoordinate( hive, explicit, fallback ) {

		return Number.isFinite( hive[ explicit ] ) ? hive[ explicit ] : hive[ fallback ];

	}

	_hiveInteriorX( hive ) { return this._hiveCoordinate( hive, 'interiorX', 'x' ); }
	_hiveInteriorY( hive ) { return this._hiveCoordinate( hive, 'interiorY', 'y' ); }
	_hiveInteriorZ( hive ) { return this._hiveCoordinate( hive, 'interiorZ', 'z' ); }
	_hiveEntranceX( hive ) { return this._hiveCoordinate( hive, 'entranceX', 'x' ); }
	_hiveEntranceY( hive ) { return this._hiveCoordinate( hive, 'entranceY', 'y' ); }
	_hiveEntranceZ( hive ) { return this._hiveCoordinate( hive, 'entranceZ', 'z' ); }
	_hiveOutsideX( hive ) { return this._hiveCoordinate( hive, 'outsideX', 'x' ); }
	_hiveOutsideY( hive ) { return this._hiveCoordinate( hive, 'outsideY', 'y' ); }
	_hiveOutsideZ( hive ) { return this._hiveCoordinate( hive, 'outsideZ', 'z' ); }

	_placeInsideHive( index, hive ) {

		this.x[ index ] = this._hiveInteriorX( hive );
		this.y[ index ] = this._hiveInteriorY( hive );
		this.z[ index ] = this._hiveInteriorZ( hive );
		this.velocityX[ index ] = 0;
		this.velocityY[ index ] = 0;
		this.velocityZ[ index ] = 0;
		this.flightSpeedCurrent[ index ] = 0;

	}

	addBees( amount, hive = DEFAULT_HIVE ) {

		if ( ! Number.isInteger( amount ) || amount < 0 || this.count + amount > this.capacity ) {

			throw new RangeError( 'amount must fit the remaining bee capacity' );

		}

		const end = this.count + amount;
		for ( let i = this.count; i < end; i ++ ) {

			this.rngState[ i ] = hash32( this.seed + Math.imul( i + 1, 0x9e3779b9 ) );
			this._placeInsideHive( i, hive );
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
			this.strategy[ i ] = this._random( i ) < this.scoutRatio ?
				BEE_STRATEGY.SCOUT :
				BEE_STRATEGY.RECRUIT;
			this.wanderPhaseA[ i ] = this._random( i ) * TWO_PI;
			this.wanderPhaseB[ i ] = this._random( i ) * TWO_PI;
			this.generation[ i ] = 0;
			this.retireAgeDays[ i ] = this.ageDays[ i ] + this.representativeLifespanDays +
				this._random( i ) * this.representativeLifespanSpreadDays;
			this.targetFlower[ i ] = NO_TARGET;
			this.targetPatch[ i ] = NO_TARGET;
			this.lastPatch[ i ] = NO_TARGET;
			this.lastFlower[ i ] = NO_TARGET;
			this.loadSugar[ i ] = 0;
			this.loadWater[ i ] = 0;
			this.tripProfit[ i ] = 0;
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

	getColonyViews() {

		return this._colonyViews;

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
		const nutrition = clamp01( ( colony.nutrition === undefined ? 1 : colony.nutrition ) * this.internalNutrition );
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
		this._placeInsideHive( index, hive );
		this.headingX[ index ] = 1;
		this.headingY[ index ] = 0;
		this.headingZ[ index ] = 0;
		this.ageDays[ index ] = 20 + this._random( index ) * 3;
		this.retireAgeDays[ index ] = this.ageDays[ index ] + this.representativeLifespanDays +
			this._random( index ) * this.representativeLifespanSpreadDays;
		this.experience[ index ] = this._random( index ) * 0.08;
		this.energy[ index ] = 0.78 + this._random( index ) * 0.22;
		this.load[ index ] = 0;
		this.loadSugar[ index ] = 0;
		this.loadWater[ index ] = 0;
		this.tripProfit[ index ] = 0;
		this.specialization[ index ] = 0.15 + this._random( index ) * 0.7;
		this.orientationTrips[ index ] = 1;
		this.strategy[ index ] = this._random( index ) < this.scoutRatio ?
			BEE_STRATEGY.SCOUT :
			BEE_STRATEGY.RECRUIT;
		this.targetFlower[ index ] = NO_TARGET;
		this.targetPatch[ index ] = NO_TARGET;
		this.lastPatch[ index ] = NO_TARGET;
		this.lastFlower[ index ] = NO_TARGET;
		this.wanderPhaseA[ index ] = this._random( index ) * TWO_PI;
		this.wanderPhaseB[ index ] = this._random( index ) * TWO_PI;
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

		const nectar = Math.max( 0.001, demand.nectar, this._colonyTelemetry.nectarDemand );
		const pollen = Math.max( 0.001, demand.pollen, this._colonyTelemetry.pollenDemand );
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

	_assignFlower( index, flowers, preferredPatch = NO_TARGET ) {

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

			this._telemetry.candidateEvaluations ++;
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
			const advertised = preferredPatch !== NO_TARGET && patch === preferredPatch ? 1.1 : 0;
			const wrongPatch = preferredPatch !== NO_TARGET && patch !== preferredPatch ? 0.9 : 0;
			const recentVisit = candidate === this.lastFlower[ index ] ? 0.72 : 0;
			const score = stock * quality + familiarity + advertised - wrongPatch - recentVisit - distance * 0.018;

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

	_updatePatchMemory( dt, flowers ) {

		const decay = Math.exp( - dt / this.patchMemorySeconds );
		let known = 0;
		let strengthSum = 0;
		for ( let slot = 0; slot < this.patchMemoryCapacity; slot ++ ) {

			if ( this.patchId[ slot ] === NO_TARGET ) continue;
			this.patchAge[ slot ] += dt;
			this.patchStrength[ slot ] *= decay;
			const flower = this.patchFlower[ slot ];
			const invalidFlower =
				flower < 0 ||
				! flowers ||
				flower >= ( flowers.count | 0 ) ||
				( flowers.active && ! flowers.active[ flower ] );
			if ( invalidFlower ) this.patchStrength[ slot ] *= decay;
			if ( this.patchStrength[ slot ] < 0.008 || this.patchAge[ slot ] > this.patchMemorySeconds * 4 ) {

				this.patchId[ slot ] = NO_TARGET;
				this.patchFlower[ slot ] = NO_TARGET;
				this.patchQuality[ slot ] = 0;
				this.patchStrength[ slot ] = 0;
				this.patchAge[ slot ] = 0;
				continue;

			}
			known ++;
			strengthSum += this.patchStrength[ slot ];

		}
		this._colonyTelemetry.knownPatches = known;
		return strengthSum;

	}

	_advertisePatch( index, flowers ) {

		const patch = this.lastPatch[ index ];
		const flower = this.lastFlower[ index ];
		if (
			patch === NO_TARGET ||
			flower < 0 ||
			! flowers ||
			flower >= ( flowers.count | 0 ) ||
			this.tripProfit[ index ] <= 0
		) return false;

		let slot = NO_TARGET;
		let weakest = 0;
		let weakestStrength = Infinity;
		for ( let candidate = 0; candidate < this.patchMemoryCapacity; candidate ++ ) {

			if ( this.patchId[ candidate ] === patch ) {

				slot = candidate;
				break;

			}
			if ( this.patchId[ candidate ] === NO_TARGET ) {

				slot = candidate;
				break;

			}
			if ( this.patchStrength[ candidate ] < weakestStrength ) {

				weakestStrength = this.patchStrength[ candidate ];
				weakest = candidate;

			}

		}
		if ( slot === NO_TARGET ) slot = weakest;
		const observedQuality = Math.min( 2, this.tripProfit[ index ] / Math.max( 0.01, this.loadCapacity ) );
		const previousWeight = this.patchId[ slot ] === patch ? 0.62 : 0;
		this.patchId[ slot ] = patch;
		this.patchFlower[ slot ] = flower;
		this.patchResource[ slot ] = this.resource[ index ];
		this.patchX[ slot ] = flowers.x[ flower ];
		this.patchY[ slot ] = flowers.y[ flower ];
		this.patchZ[ slot ] = flowers.z[ flower ];
		this.patchQuality[ slot ] =
			this.patchQuality[ slot ] * previousWeight + observedQuality * ( 1 - previousWeight );
		this.patchStrength[ slot ] = Math.min(
			3,
			this.patchStrength[ slot ] * previousWeight + 0.45 + observedQuality,
		);
		this.patchAge[ slot ] = 0;
		this._telemetry.danceEvents ++;
		return true;

	}

	_selectAdvertisedFlower( index, flowers ) {

		let bestSlot = NO_TARGET;
		let bestScore = - Infinity;
		for ( let slot = 0; slot < this.patchMemoryCapacity; slot ++ ) {

			const flower = this.patchFlower[ slot ];
			if (
				this.patchId[ slot ] === NO_TARGET ||
				this.patchResource[ slot ] !== this.resource[ index ] ||
				flower < 0 ||
				! flowers ||
				flower >= ( flowers.count | 0 ) ||
				( flowers.active && ! flowers.active[ flower ] ) ||
				this._flowerStock( flowers, this.resource[ index ], flower ) <= 0.0001
			) continue;
			const distance = Math.hypot(
				this.patchX[ slot ] - this.x[ index ],
				this.patchY[ slot ] - this.y[ index ],
				this.patchZ[ slot ] - this.z[ index ],
			);
			const score =
				this.patchStrength[ slot ] * ( 0.7 + this.patchQuality[ slot ] ) -
				distance * 0.012 -
				this.patchAge[ slot ] / this.patchMemorySeconds * 0.25;
			if ( score > bestScore ) {

				bestScore = score;
				bestSlot = slot;

			}

		}
		if ( bestSlot === NO_TARGET ) return false;
		const flower = this.patchFlower[ bestSlot ];
		this.targetFlower[ index ] = flower;
		this.targetPatch[ index ] = this.patchId[ bestSlot ];
		return true;

	}

	_updateColonyEconomy( dt, biologicalDays, demand ) {

		const maturation = 1 - Math.exp( - dt / this.honeyMaturationSeconds );
		if ( this.rawNectarSugar > 0 && maturation > 0 ) {

			const maturedSugar = this.rawNectarSugar * maturation;
			const sourceWater = this.rawNectarWater * maturation;
			const ripeWater = maturedSugar * 0.18 / 0.82;
			this.rawNectarSugar -= maturedSugar;
			this.rawNectarWater -= sourceWater;
			this.honeySugar += maturedSugar;
			this.honeyWater += Math.min( sourceWater, ripeWater );
			this.evaporatedWater += Math.max( 0, sourceWater - ripeWater );

		}

		let sugarNeed = this.adultWorkers * this.adultSugarUsePerDay * biologicalDays;
		const fromHoney = Math.min( sugarNeed, this.honeySugar );
		this.honeySugar -= fromHoney;
		sugarNeed -= fromHoney;
		const fromRaw = Math.min( sugarNeed, this.rawNectarSugar );
		this.rawNectarSugar -= fromRaw;
		this.consumedSugar += fromHoney + fromRaw;

		const pollenNeed = this.larvaCount * this.broodPollenUsePerDay * biologicalDays;
		this.pollenStore = Math.max( 0, this.pollenStore - pollenNeed );
		const sugarTarget = Math.max( 10, this.adultWorkers * 0.003 );
		const pollenTarget = Math.max( 5, this.larvaCount * 0.002 );
		const sugarNutrition = clamp01( ( this.rawNectarSugar + this.honeySugar ) / sugarTarget );
		const pollenNutrition = clamp01( this.pollenStore / pollenTarget );
		this.internalNutrition = Math.min( sugarNutrition, 0.35 + pollenNutrition * 0.65 );

		const externalNectar = Math.max( 0, demand.nectar );
		const externalPollen = Math.max( 0, demand.pollen );
		this._colonyTelemetry.nectarDemand = Math.max( externalNectar, 1 - sugarNutrition );
		this._colonyTelemetry.pollenDemand = Math.max( externalPollen, 1 - pollenNutrition );
		this._colonyTelemetry.rawNectar = this.rawNectarSugar;
		this._colonyTelemetry.honey = this.honeySugar;
		this._colonyTelemetry.pollen = this.pollenStore;
		this._colonyTelemetry.consumedSugar = this.consumedSugar;
		this._colonyTelemetry.evaporatedWater = this.evaporatedWater;

	}

	_refreshColonyTelemetry() {

		let sugarInTransit = 0;
		let scouts = 0;
		for ( let index = 0; index < this.count; index ++ ) {

			sugarInTransit += this.loadSugar[ index ];
			if ( this.strategy[ index ] === BEE_STRATEGY.SCOUT ) scouts ++;

		}
		this._colonyTelemetry.sugarInTransit = sugarInTransit;
		this._colonyTelemetry.scoutFraction = this.count > 0 ? scouts / this.count : 0;
		this._colonyTelemetry.rawNectar = this.rawNectarSugar;
		this._colonyTelemetry.honey = this.honeySugar;
		this._colonyTelemetry.pollen = this.pollenStore;
		this._colonyTelemetry.consumedSugar = this.consumedSugar;

	}


	_moveToward( index, targetX, targetY, targetZ, speed, dt, airborne ) {

		const dx = targetX - this.x[ index ];

		const dy = targetY - this.y[ index ];
		const dz = targetZ - this.z[ index ];
		const distanceSquared = dx * dx + dy * dy + dz * dz;
		if ( distanceSquared <= 1e-12 ) {

			this.velocityX[ index ] = 0;
			this.velocityY[ index ] = 0;
			this.velocityZ[ index ] = 0;
			this.flightSpeedCurrent[ index ] = 0;
			this.banking[ index ] *= Math.exp( - dt * 8 );
			return 0;

		}

		const distance = Math.sqrt( distanceSquared );
		const inverse = 1 / distance;
		const directX = dx * inverse;
		const directY = dy * inverse;
		const directZ = dz * inverse;
		let desiredX = directX;
		let desiredY = directY;
		let desiredZ = directZ;
		const state = this.state[ index ];
		const freeFlight =
			state === BEE_STATE.ORIENTATION ||
			state === BEE_STATE.OUTBOUND ||
			state === BEE_STATE.SCOUT_SEARCH ||
			state === BEE_STATE.PATCH_SEARCH ||
			state === BEE_STATE.RETURN;
		if ( freeFlight && distance > this.approachRadius * 1.5 && this.wanderStrength > 0 ) {

			const horizontal = Math.max( 1e-5, Math.hypot( directX, directZ ) );
			const lateralX = - directZ / horizontal;
			const lateralZ = directX / horizontal;
			const fade = Math.min( 1, distance / 3 );
			const fast = Math.sin( this.animationTime[ index ] * 3.7 + this.wanderPhaseA[ index ] );
			const slow = Math.sin( this.animationTime[ index ] * 0.83 + this.wanderPhaseB[ index ] );
			const lateral = ( fast * 0.62 + slow * 0.38 ) * this.wanderStrength * fade;
			desiredX += lateralX * lateral;
			desiredY += Math.sin(
				this.animationTime[ index ] * 2.13 + this.wanderPhaseB[ index ],
			) * this.wanderStrength * 0.32 * fade;
			desiredZ += lateralZ * lateral;
			const desiredLength = Math.hypot( desiredX, desiredY, desiredZ );
			desiredX /= desiredLength;
			desiredY /= desiredLength;
			desiredZ /= desiredLength;

		}

		const previousHeadingX = this.headingX[ index ];
		const previousHeadingY = this.headingY[ index ];
		const previousHeadingZ = this.headingZ[ index ];
		const turn = freeFlight ? Math.min( 1, this.turnRate * dt ) : 1;
		let headingX = previousHeadingX + ( desiredX - previousHeadingX ) * turn;
		let headingY = previousHeadingY + ( desiredY - previousHeadingY ) * turn;
		let headingZ = previousHeadingZ + ( desiredZ - previousHeadingZ ) * turn;
		let headingLength = Math.hypot( headingX, headingY, headingZ );
		if ( headingLength <= 1e-6 ) {

			headingX = directX;
			headingY = directY;
			headingZ = directZ;

		} else {

			headingX /= headingLength;
			headingY /= headingLength;
			headingZ /= headingLength;

		}

		const cruisePulse = freeFlight ?
			0.91 + 0.09 * Math.sin( this.animationTime[ index ] * 1.17 + this.wanderPhaseA[ index ] ) :
			1;
		const brakingSpeed = Math.sqrt( 2 * this.flightAcceleration * distance );
		const desiredSpeed = Math.min( speed * cruisePulse, brakingSpeed );
		let currentSpeed = this.flightSpeedCurrent[ index ];
		const accelerationStep = this.flightAcceleration * dt;
		currentSpeed += Math.max( - accelerationStep, Math.min( accelerationStep, desiredSpeed - currentSpeed ) );
		currentSpeed = Math.max( 0, Math.min( speed, currentSpeed ) );

		const maxStep = Math.min( distance, currentSpeed * dt );
		const snapToTarget = distance <= currentSpeed * dt * 1.01;
		const stepX = snapToTarget ? dx : headingX * maxStep;
		const stepY = snapToTarget ? dy : headingY * maxStep;
		const stepZ = snapToTarget ? dz : headingZ * maxStep;
		const travelled = Math.hypot( stepX, stepY, stepZ );
		this.x[ index ] += stepX;
		this.y[ index ] += stepY;
		this.z[ index ] += stepZ;
		if ( travelled > 1e-8 ) {

			this.headingX[ index ] = stepX / travelled;
			this.headingY[ index ] = stepY / travelled;
			this.headingZ[ index ] = stepZ / travelled;

		}
		this.velocityX[ index ] = dt > 0 ? stepX / dt : 0;
		this.velocityY[ index ] = dt > 0 ? stepY / dt : 0;
		this.velocityZ[ index ] = dt > 0 ? stepZ / dt : 0;
		this.flightSpeedCurrent[ index ] = travelled > 0 && dt > 0 ? travelled / dt : currentSpeed;
		const turnSense = previousHeadingX * this.headingZ[ index ] - previousHeadingZ * this.headingX[ index ];
		const bankTarget = Math.max( - 1, Math.min( 1, turnSense / Math.max( 1e-4, dt * 2.5 ) ) );
		this.banking[ index ] += ( bankTarget - this.banking[ index ] ) * Math.min( 1, dt * 7 );

		this._telemetry.distanceTravelled += travelled;
		if ( airborne ) this.energy[ index ] = Math.max( 0, this.energy[ index ] - travelled * this.flightEnergyPerUnit );
		return Math.hypot( targetX - this.x[ index ], targetY - this.y[ index ], targetZ - this.z[ index ] );

	}

	_beginHermite(
		index,
		state,
		duration,
		endX,
		endY,
		endZ,
		startVelocityX,
		startVelocityY,
		startVelocityZ,
		endVelocityX,
		endVelocityY,
		endVelocityZ,
	) {

		this.transitionStartX[ index ] = this.x[ index ];
		this.transitionStartY[ index ] = this.y[ index ];
		this.transitionStartZ[ index ] = this.z[ index ];
		this.takeoffX[ index ] = endX;
		this.takeoffY[ index ] = endY;
		this.takeoffZ[ index ] = endZ;
		this.transitionStartVelocityX[ index ] = startVelocityX;
		this.transitionStartVelocityY[ index ] = startVelocityY;
		this.transitionStartVelocityZ[ index ] = startVelocityZ;
		this.transitionEndVelocityX[ index ] = endVelocityX;
		this.transitionEndVelocityY[ index ] = endVelocityY;
		this.transitionEndVelocityZ[ index ] = endVelocityZ;
		this.transitionElapsed[ index ] = 0;
		this.transitionDuration[ index ] = Math.max( 1e-4, duration );
		this._setState( index, state, this.transitionDuration[ index ] );

	}

	_advanceHermite( index, dt ) {

		const duration = this.transitionDuration[ index ];
		const previousX = this.x[ index ];
		const previousY = this.y[ index ];
		const previousZ = this.z[ index ];
		const elapsed = Math.min( duration, this.transitionElapsed[ index ] + dt );
		this.transitionElapsed[ index ] = elapsed;
		const phase = elapsed / duration;
		const phase2 = phase * phase;
		const phase3 = phase2 * phase;
		const h00 = 2 * phase3 - 3 * phase2 + 1;
		const h10 = phase3 - 2 * phase2 + phase;
		const h01 = - 2 * phase3 + 3 * phase2;
		const h11 = phase3 - phase2;
		const tangentScale = duration;

		this.x[ index ] =
			h00 * this.transitionStartX[ index ] +
			h10 * tangentScale * this.transitionStartVelocityX[ index ] +
			h01 * this.takeoffX[ index ] +
			h11 * tangentScale * this.transitionEndVelocityX[ index ];
		this.y[ index ] =
			h00 * this.transitionStartY[ index ] +
			h10 * tangentScale * this.transitionStartVelocityY[ index ] +
			h01 * this.takeoffY[ index ] +
			h11 * tangentScale * this.transitionEndVelocityY[ index ];
		this.z[ index ] =
			h00 * this.transitionStartZ[ index ] +
			h10 * tangentScale * this.transitionStartVelocityZ[ index ] +
			h01 * this.takeoffZ[ index ] +
			h11 * tangentScale * this.transitionEndVelocityZ[ index ];

		const dh00 = 6 * phase2 - 6 * phase;
		const dh10 = 3 * phase2 - 4 * phase + 1;
		const dh01 = - dh00;
		const dh11 = 3 * phase2 - 2 * phase;
		const velocityX =
			dh00 * this.transitionStartX[ index ] / duration +
			dh10 * this.transitionStartVelocityX[ index ] +
			dh01 * this.takeoffX[ index ] / duration +
			dh11 * this.transitionEndVelocityX[ index ];
		const velocityY =
			dh00 * this.transitionStartY[ index ] / duration +
			dh10 * this.transitionStartVelocityY[ index ] +
			dh01 * this.takeoffY[ index ] / duration +
			dh11 * this.transitionEndVelocityY[ index ];
		const velocityZ =
			dh00 * this.transitionStartZ[ index ] / duration +
			dh10 * this.transitionStartVelocityZ[ index ] +
			dh01 * this.takeoffZ[ index ] / duration +
			dh11 * this.transitionEndVelocityZ[ index ];
		const speed = Math.hypot( velocityX, velocityY, velocityZ );
		this.velocityX[ index ] = velocityX;
		this.velocityY[ index ] = velocityY;
		this.velocityZ[ index ] = velocityZ;
		this.flightSpeedCurrent[ index ] = speed;
		if ( speed > 1e-6 ) {

			this.headingX[ index ] = velocityX / speed;
			this.headingY[ index ] = velocityY / speed;
			this.headingZ[ index ] = velocityZ / speed;

		}
		const travelled = Math.hypot(
			this.x[ index ] - previousX,
			this.y[ index ] - previousY,
			this.z[ index ] - previousZ,
		);
		this.banking[ index ] *= Math.exp( - dt * 7 );
		this._telemetry.distanceTravelled += travelled;
		this.energy[ index ] = Math.max( 0, this.energy[ index ] - travelled * this.flightEnergyPerUnit );
		return elapsed >= duration;

	}

	_beginTouchdown( index, flowers, target ) {

		const endX = this._flowerContactX( flowers, target );
		const endY = this._flowerContactY( flowers, target );
		const endZ = this._flowerContactZ( flowers, target );
		const distance = Math.hypot(
			endX - this.x[ index ],
			endY - this.y[ index ],
			endZ - this.z[ index ],
		);
		if ( distance <= ARRIVAL_EPSILON ) {

			this._setState( index, BEE_STATE.FORAGE, this._forageDuration( index ) );
			return;

		}
		const duration = Math.min( 0.9, Math.max( 0.32, distance * 1.5 / this.approachSpeed ) );
		this._beginHermite(
			index,
			BEE_STATE.TOUCHDOWN,
			duration,
			endX,
			endY,
			endZ,
			this.headingX[ index ] * this.approachSpeed,
			this.headingY[ index ] * this.approachSpeed,
			this.headingZ[ index ] * this.approachSpeed,
			0,
			0,
			0,
		);

	}

	_routeTarget( index, nextState, flowers, hive ) {

		const target = this.targetFlower[ index ];
		if ( ( nextState === BEE_STATE.OUTBOUND || nextState === BEE_STATE.SCOUT_SEARCH || nextState === BEE_STATE.PATCH_SEARCH ) && flowers && target >= 0 && target < ( flowers.count | 0 ) ) {

			if ( nextState === BEE_STATE.SCOUT_SEARCH || nextState === BEE_STATE.PATCH_SEARCH ) {

				this.takeoffX[ index ] = this.searchX[ index ];
				this.takeoffY[ index ] = this.searchY[ index ];
				this.takeoffZ[ index ] = this.searchZ[ index ];

			} else {

				this.takeoffX[ index ] = flowers.x[ target ];
				this.takeoffY[ index ] = flowers.y[ target ] + 0.55;
				this.takeoffZ[ index ] = flowers.z[ target ];

			}
			return true;

		}
		this.takeoffX[ index ] = this._hiveOutsideX( hive );
		this.takeoffY[ index ] = this._hiveOutsideY( hive );
		this.takeoffZ[ index ] = this._hiveOutsideZ( hive );
		return nextState === BEE_STATE.RETURN;

	}

	_beginTakeoff( index, nextState, flowers, hive ) {

		if ( ! this._routeTarget( index, nextState, flowers, hive ) ) nextState = BEE_STATE.RETURN;
		const routeX = this.takeoffX[ index ];
		const routeZ = this.takeoffZ[ index ];
		let directionX = routeX - this.x[ index ];
		let directionZ = routeZ - this.z[ index ];
		const horizontalDistance = Math.hypot( directionX, directionZ );
		if ( horizontalDistance > 1e-6 ) {

			directionX /= horizontalDistance;
			directionZ /= horizontalDistance;

		} else {

			directionX = this.headingX[ index ];
			directionZ = this.headingZ[ index ];
			const headingLength = Math.hypot( directionX, directionZ );
			if ( headingLength > 1e-6 ) {

				directionX /= headingLength;
				directionZ /= headingLength;

			} else {

				directionX = 1;
				directionZ = 0;

			}

		}

		const deltaX = directionX * 0.68;
		const deltaY = 0.58;
		const deltaZ = directionZ * 0.68;
		const distance = Math.hypot( deltaX, deltaY, deltaZ );
		const inverseDistance = 1 / distance;
		const velocityX = deltaX * inverseDistance * this.approachSpeed;
		const velocityY = deltaY * inverseDistance * this.approachSpeed;
		const velocityZ = deltaZ * inverseDistance * this.approachSpeed;
		this.takeoffNextState[ index ] = nextState;
		this._beginHermite(
			index,
			BEE_STATE.TAKEOFF,
			2 * distance / this.approachSpeed,
			this.x[ index ] + deltaX,
			this.y[ index ] + deltaY,
			this.z[ index ] + deltaZ,
			0,
			0,
			0,
			velocityX,
			velocityY,
			velocityZ,
		);

	}

	_beginDepart( index, flowers, hive ) {

		let nextState = this.takeoffNextState[ index ];
		if ( ! this._routeTarget( index, nextState, flowers, hive ) ) nextState = BEE_STATE.RETURN;
		const destinationX = this.takeoffX[ index ];
		const destinationY = this.takeoffY[ index ];
		const destinationZ = this.takeoffZ[ index ];
		let directionX = destinationX - this.x[ index ];
		let directionY = destinationY - this.y[ index ];
		let directionZ = destinationZ - this.z[ index ];
		const distance = Math.hypot( directionX, directionY, directionZ );
		if ( distance > 1e-6 ) {

			directionX /= distance;
			directionY /= distance;
			directionZ /= distance;

		} else {

			directionX = this.headingX[ index ];
			directionY = this.headingY[ index ];
			directionZ = this.headingZ[ index ];

		}
		const duration = 0.55;
		const startVelocityX = this.transitionEndVelocityX[ index ];
		const startVelocityY = this.transitionEndVelocityY[ index ];
		const startVelocityZ = this.transitionEndVelocityZ[ index ];
		const endVelocityX = directionX * this.flightSpeed;
		const endVelocityY = directionY * this.flightSpeed;
		const endVelocityZ = directionZ * this.flightSpeed;
		const startSpeed = Math.hypot( startVelocityX, startVelocityY, startVelocityZ );
		const departureDistance = Math.min(
			( startSpeed + this.flightSpeed ) * duration * 0.5,
			Math.max( 0.05, distance * 0.55 ),
		);
		this.takeoffNextState[ index ] = nextState;
		this._beginHermite(
			index,
			BEE_STATE.DEPART,
			duration,
			this.x[ index ] + directionX * departureDistance,
			this.y[ index ] + directionY * departureDistance,
			this.z[ index ] + directionZ * departureDistance,
			startVelocityX,
			startVelocityY,
			startVelocityZ,
			endVelocityX,
			endVelocityY,
			endVelocityZ,
		);

	}
	_prepareSearchWaypoint( index, flowers ) {

		const target = this.targetFlower[ index ];
		if ( target < 0 || ! flowers || target >= ( flowers.count | 0 ) ) return false;
		const angle = this._random( index ) * TWO_PI;
		const radius = 1.4 + this._random( index ) * 3.2;
		this.searchX[ index ] = flowers.x[ target ] + Math.cos( angle ) * radius;
		this.searchY[ index ] = flowers.y[ target ] + 0.8 + this._random( index ) * 1.1;
		this.searchZ[ index ] = flowers.z[ target ] + Math.sin( angle ) * radius;
		return true;

	}

	_beginHiveExit( index, nextState ) {

		this.takeoffNextState[ index ] = nextState;
		this.portalPhase[ index ] = 0;
		this.flightSpeedCurrent[ index ] = 0;
		this._setState( index, BEE_STATE.HIVE_EXIT, this._duration( index, 2.5, 1.2 ) );

	}

	_startTrip( index, flowers, demand, hive = null ) {

		this._chooseResource( index, demand );
		const scarcity = 1 - clamp01( this._patchStrengthSum * 0.18 );
		const dynamicScoutRatio = clamp01( this.scoutRatio + scarcity * ( 1 - this.scoutRatio ) * 0.24 );
		let nextState = BEE_STATE.OUTBOUND;
		if ( this._random( index ) >= dynamicScoutRatio && this._selectAdvertisedFlower( index, flowers ) ) {

			this.strategy[ index ] = BEE_STRATEGY.RECRUIT;
			this._telemetry.recruitedTrips ++;

		} else {

			this.strategy[ index ] = BEE_STRATEGY.SCOUT;
			if ( ! this._assignFlower( index, flowers ) ) return false;
			this._prepareSearchWaypoint( index, flowers );
			nextState = BEE_STATE.SCOUT_SEARCH;
			this._telemetry.scoutTrips ++;

		}
		this.tripProfit[ index ] = 0;
		if ( hive ) this._beginHiveExit( index, nextState );
		else this._setState(
			index,
			nextState,
			nextState === BEE_STATE.SCOUT_SEARCH ?
				this._duration( index, 2.2, 2.6 ) :
				this._duration( index, 12, 10 ),
		);
		this._telemetry.tripsStarted ++;
		return true;

	}

	_beginHiveApproach( index ) {

		this.portalPhase[ index ] = 0;
		this._setState( index, BEE_STATE.HIVE_APPROACH, this._duration( index, 2.2, 1.2 ) );

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
		this.lastFlower[ index ] = target;
		this.tripProfit[ index ] += harvested;
		if ( this.resource[ index ] === BEE_RESOURCE.POLLEN ) {

			// Pollen remains a protein store and is accounted independently.

		} else {

			this.loadSugar[ index ] += harvested;
			this.loadWater[ index ] += harvested * 1.5;

		}
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
		this._patchStrengthSum = this._updatePatchMemory( dt, flowers );
		this._updateColonyEconomy( dt, biologicalDays, demand );
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

					this._placeInsideHive( i, hive );
					this.energy[ i ] = Math.min( 1, this.energy[ i ] + dt * 0.035 );
					if ( this.stateTime[ i ] <= 0 && canDepart && this.energy[ i ] >= 0.35 ) {

						if ( this.orientationTrips[ i ] > 0 ) {

							this.orientationTrips[ i ] --;
							this._beginHiveExit( i, BEE_STATE.ORIENTATION );

						} else if ( ! this._startTrip( i, flowers, demand, hive ) ) {

							this._setState( i, BEE_STATE.REST, this._duration( i, 1.5, 3 ) );

						}

					}
					break;

				}

				case BEE_STATE.HIVE_EXIT: {

					const entrancePhase = this.portalPhase[ i ] === 0;
					const remaining = this._moveToward(
						i,
						entrancePhase ? this._hiveEntranceX( hive ) : this._hiveOutsideX( hive ),
						entrancePhase ? this._hiveEntranceY( hive ) : this._hiveOutsideY( hive ),
						entrancePhase ? this._hiveEntranceZ( hive ) : this._hiveOutsideZ( hive ),
						this.approachSpeed * ( entrancePhase ? 0.55 : 0.82 ),
						dt,
						true,
					);
					if ( remaining <= 0.025 ) {

						if ( entrancePhase ) {

							this.portalPhase[ i ] = 1;
							this.stateTime[ i ] = this._duration( i, 0.7, 0.35 );

						} else {

							const nextState = this.takeoffNextState[ i ];
							this._setState(
								i,
								nextState,
								nextState === BEE_STATE.ORIENTATION ?
									this._duration( i, 1.4, 1.2 ) :
									nextState === BEE_STATE.SCOUT_SEARCH ?
										this._duration( i, 2.2, 2.6 ) :
										this._duration( i, 12, 10 ),
							);

						}

					}
					break;

				}

				case BEE_STATE.ORIENTATION: {

					const phase = this.animationTime[ i ] * ( 2.2 + this.experience[ i ] );
					const radius = this.orientationRadius * ( 0.55 + 0.45 * clamp01( this.animationTime[ i ] ) );
					const targetX = this._hiveOutsideX( hive ) + Math.cos( phase + i * 0.73 ) * radius;
					const targetY = this._hiveOutsideY( hive ) + 0.35 + Math.sin( phase * 0.43 ) * 0.25;
					const targetZ = this._hiveOutsideZ( hive ) + Math.sin( phase + i * 0.73 ) * radius;
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

				case BEE_STATE.SCOUT_SEARCH: {

					const target = this.targetFlower[ i ];
					if (
						target < 0 ||
						! flowers ||
						target >= ( flowers.count | 0 ) ||
						( flowers.active && ! flowers.active[ target ] ) ||
						this.energy[ i ] < 0.12
					) {

						this._abortToHive( i );
						break;

					}
					const remaining = this._moveToward(
						i,
						this.searchX[ i ],
						this.searchY[ i ],
						this.searchZ[ i ],
						this.flightSpeed * 0.82,
						dt,
						true,
					);
					if ( remaining <= 0.5 || this.stateTime[ i ] <= 0 ) {

						this._setState( i, BEE_STATE.PATCH_SEARCH, this._duration( i, 1.2, 2.1 ) );

					}
					break;

				}

				case BEE_STATE.PATCH_SEARCH: {

					const target = this.targetFlower[ i ];
					if (
						target < 0 ||
						! flowers ||
						target >= ( flowers.count | 0 ) ||
						( flowers.active && ! flowers.active[ target ] )
					) {

						this._abortToHive( i );
						break;

					}
					const phase = this.animationTime[ i ] * 1.7 + this.wanderPhaseA[ i ];
					const radius = 0.55 + 0.28 * Math.sin( this.animationTime[ i ] * 0.71 + this.wanderPhaseB[ i ] );
					this.searchX[ i ] = flowers.x[ target ] + Math.cos( phase ) * radius;
					this.searchY[ i ] = flowers.y[ target ] + 0.55 + Math.sin( phase * 0.61 ) * 0.22;
					this.searchZ[ i ] = flowers.z[ target ] + Math.sin( phase ) * radius;
					this._moveToward(
						i,
						this.searchX[ i ],
						this.searchY[ i ],
						this.searchZ[ i ],
						this.approachSpeed * 1.25,
						dt,
						true,
					);
					if ( this.stateTime[ i ] <= 0 ) {

						this._setState( i, BEE_STATE.APPROACH, this._duration( i, 2.2, 2 ) );

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
						this._flowerContactX( flowers, target ),
						this._flowerContactY( flowers, target ),
						this._flowerContactZ( flowers, target ),
						this.approachSpeed,
						dt,
						true,
					);
					if ( remaining <= this.approachRadius ) {

						this._beginTouchdown( i, flowers, target );

					}
					break;

				}

				case BEE_STATE.TOUCHDOWN: {

					if ( this._advanceHermite( i, dt ) ) {

						this._setState( i, BEE_STATE.FORAGE, this._forageDuration( i ) );

					}
					break;

				}

				case BEE_STATE.FORAGE: {

					const target = this.targetFlower[ i ];
					if ( target >= 0 && flowers && target < ( flowers.count | 0 ) ) {

						this.x[ i ] = this._flowerContactX( flowers, target );
						this.y[ i ] = this._flowerContactY( flowers, target );
						this.z[ i ] = this._flowerContactZ( flowers, target );
						this.velocityX[ i ] = 0;
						this.velocityY[ i ] = 0;
						this.velocityZ[ i ] = 0;

					}
					if ( this.stateTime[ i ] <= 0 ) {

						this._harvest( i, flowers );
						const keepForaging =
							this.load[ i ] < this.loadCapacity * 0.82 &&
							this.energy[ i ] > 0.22 &&
							this._random( i ) < 0.72 &&
							this._assignFlower( i, flowers, this.lastPatch[ i ] );

						if ( keepForaging ) {

							this._prepareSearchWaypoint( i, flowers );
							this._beginTakeoff( i, BEE_STATE.PATCH_SEARCH, flowers, hive );

						} else {

							this.targetFlower[ i ] = NO_TARGET;
							this.targetPatch[ i ] = NO_TARGET;
							this._beginTakeoff( i, BEE_STATE.RETURN, flowers, hive );

						}

					}
					break;

				}

				case BEE_STATE.TAKEOFF: {

					if ( this._advanceHermite( i, dt ) ) this._beginDepart( i, flowers, hive );
					break;

				}

				case BEE_STATE.DEPART: {

					if ( this._advanceHermite( i, dt ) ) {

						const nextState = this.takeoffNextState[ i ];
						this._setState(
							i,
							nextState,
							nextState === BEE_STATE.OUTBOUND ?
								this._duration( i, 12, 10 ) :
								nextState === BEE_STATE.PATCH_SEARCH || nextState === BEE_STATE.SCOUT_SEARCH ?
									this._duration( i, 1.2, 2.1 ) :
									this._duration( i, 10, 8 ),
						);

					}
					break;

				}

				case BEE_STATE.RETURN: {

					const remaining = this._moveToward(
						i,
						this._hiveOutsideX( hive ),
						this._hiveOutsideY( hive ),
						this._hiveOutsideZ( hive ),
						this.flightSpeed * ( 0.92 + this.experience[ i ] * 0.12 ),
						dt,
						true,
					);
					if ( remaining <= 0.08 ) {

						this._beginHiveApproach( i );

					}
					break;

				}

				case BEE_STATE.HIVE_APPROACH: {

					const remaining = this._moveToward(
						i,
						this._hiveEntranceX( hive ),
						this._hiveEntranceY( hive ),
						this._hiveEntranceZ( hive ),
						this.approachSpeed * 0.62,
						dt,
						true,
					);
					if ( remaining <= 0.025 ) {

						this.portalPhase[ i ] = 1;
						this._setState( i, BEE_STATE.HIVE_ENTRY, this._duration( i, 1.4, 0.8 ) );

					}
					break;

				}

				case BEE_STATE.HIVE_ENTRY: {

					const remaining = this._moveToward(
						i,
						this._hiveInteriorX( hive ),
						this._hiveInteriorY( hive ),
						this._hiveInteriorZ( hive ),
						this.approachSpeed * 0.48,
						dt,
						true,
					);
					if ( remaining <= 0.02 ) {

						this._placeInsideHive( i, hive );
						this._setState( i, BEE_STATE.UNLOAD, this._duration( i, 0.55, 0.85 ) );

					}
					break;

				}

				case BEE_STATE.DANCE: {

					this._placeInsideHive( i, hive );
					if ( this.stateTime[ i ] <= 0 ) {

						this._setState( i, BEE_STATE.REST, this._duration( i, 1.1, 3.2 ) );

					}
					break;

				}


				case BEE_STATE.UNLOAD: {

					if ( this.stateTime[ i ] <= 0 ) {

						if ( this.resource[ i ] === BEE_RESOURCE.POLLEN ) {

							this._telemetry.deliveredPollen += this.load[ i ];
							this.pollenStore += this.load[ i ];

						} else {

							this._telemetry.deliveredNectar += this.loadSugar[ i ];
							this.rawNectarSugar += this.loadSugar[ i ];
							this.rawNectarWater += this.loadWater[ i ];

						}
						const advertised = this._advertisePatch( i, flowers );
						if ( this.load[ i ] > 0 ) this._telemetry.tripsCompleted ++;
						this.load[ i ] = 0;
						this.loadSugar[ i ] = 0;
						this.loadWater[ i ] = 0;
						this.targetFlower[ i ] = NO_TARGET;
						this.targetPatch[ i ] = NO_TARGET;
						this._setState(
							i,
							advertised ? BEE_STATE.DANCE : BEE_STATE.REST,
							advertised ?
								this._duration( i, 0.8, 1.4 ) :
								this._duration( i, 1.1, 3.2 ),
						);

					}
					break;

				}

				case BEE_STATE.REST: {

					this._placeInsideHive( i, hive );
					this.energy[ i ] = Math.min( 1, this.energy[ i ] + dt * 0.06 );
					if ( this.stateTime[ i ] <= 0 ) {

						if ( canDepart && this.energy[ i ] >= 0.35 && this._startTrip( i, flowers, demand, hive ) ) {

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
				currentState === BEE_STATE.HIVE_EXIT ||
				currentState === BEE_STATE.SCOUT_SEARCH ||
				currentState === BEE_STATE.PATCH_SEARCH ||
				currentState === BEE_STATE.OUTBOUND ||
				currentState === BEE_STATE.APPROACH ||
				currentState === BEE_STATE.RETURN ||
				currentState === BEE_STATE.HIVE_APPROACH ||
				currentState === BEE_STATE.HIVE_ENTRY ||
				currentState === BEE_STATE.TAKEOFF ||
				currentState === BEE_STATE.TOUCHDOWN ||
				currentState === BEE_STATE.DEPART
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
		this._refreshColonyTelemetry();

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
