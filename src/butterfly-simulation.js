/**
 * Deterministic, renderer-agnostic butterfly lifecycle and activity kernel.
 *
 * Every simulated representative owns one slot in fixed-size SoA buffers.
 * Immature stages continue ageing while hidden; only adults are renderable.
 */

export const BUTTERFLY_STAGE = Object.freeze( {
	EGG: 0,
	LARVA: 1,
	PUPA: 2,
	ADULT: 3,
} );

export const BUTTERFLY_STAGE_NAMES = Object.freeze( [
	'EGG',
	'LARVA',
	'PUPA',
	'ADULT',
] );

export const BUTTERFLY_BEHAVIOR = Object.freeze( {
	FLY: 0,
	FEED: 1,
	REST: 2,
} );

export const BUTTERFLY_BEHAVIOR_NAMES = Object.freeze( [
	'FLY',
	'FEED',
	'REST',
] );

// A fixed sampling budget keeps target selection O(1) per adult, regardless
// of the number of flowers in the scene.
export const BUTTERFLY_FLOWER_CANDIDATE_SAMPLES = 4;

const UINT32_SCALE = 1 / 4294967296;
const NO_TARGET = - 1;
const MAX_LIFECYCLE_TRANSITIONS_PER_UPDATE = 8;
const DEFAULT_PREDATOR_VIEW_DISTANCE = 6;
const DEFAULT_PREDATOR_VIEW_FOV_DEGREES = 280;
const DEFAULT_PREDATOR_SCAN_FREQUENCY = 12;
const DEFAULT_PREDATOR_PREDICTION_TIME = 0.28;
const DEFAULT_PREDATOR_SEPARATION_DISTANCE = 2.2;
const DEFAULT_PREDATOR_FEAR_MEMORY = 0.32;
const DEFAULT_PREDATOR_FLEE_SPEED_MULTIPLIER = 1.35;
const DEFAULT_PREDATOR_TURN_RATE = 9;
const DEFAULT_WEATHER = Object.freeze( {
	temperatureC: 22,
	rain: 0,
	windSpeed: 0,
} );
const DEFAULT_HABITAT = Object.freeze( {
	x: 0,
	y: 0,
	z: 0,
} );
const EMPTY_FLOWERS = Object.freeze( {
	count: 0,
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

function assertStage( stage ) {

	if ( ! Number.isInteger( stage ) || stage < BUTTERFLY_STAGE.EGG || stage > BUTTERFLY_STAGE.ADULT ) {

		throw new RangeError( 'stage must be a BUTTERFLY_STAGE value' );

	}

}

/**
 * Inputs accepted by update(dt, context):
 * {
 *   daylight: 0..1,
 *   weather: { temperatureC, rain: 0..1, windSpeed },
 *   habitat: { x, y, z },
 *   flowers: {
 *     count, x, y, z,              // required SoA position arrays
 *     active?, patch?, quality?,   // optional indexed arrays
 *     nectar?                      // optional mutable stock
 *   }
 * }
 */
export class ButterflySimulation {

	constructor( {
		capacity = 64,
		initialCount = 0,
		initialStage = BUTTERFLY_STAGE.ADULT,
		seed = 0xb077ef17,
		lifeSpeed = 1,
		flightSpeed = 4.8,
		arrivalRadius = 0.18,
		adultSpawnRadius = 16,
		feedingHeight = 0.16,
		nectarPerVisit = 0.08,
		eggDuration = 5,
		eggDurationSpread = 1.5,
		larvaDuration = 8,
		larvaDurationSpread = 2,
		pupaDuration = 6,
		pupaDurationSpread = 1.5,
		adultDuration = 32,
		adultDurationSpread = 10,
		restDuration = 0.7,
		restDurationSpread = 2.4,
		feedDuration = 0.8,
		feedDurationSpread = 1.2,
		flightTimeout = 16,
		flightTimeoutSpread = 8,
		predatorViewDistance = DEFAULT_PREDATOR_VIEW_DISTANCE,
		predatorViewFovDegrees = DEFAULT_PREDATOR_VIEW_FOV_DEGREES,
		predatorThreatScanFrequency = DEFAULT_PREDATOR_SCAN_FREQUENCY,
		predatorPredictionTime = DEFAULT_PREDATOR_PREDICTION_TIME,
		predatorSeparationDistance = DEFAULT_PREDATOR_SEPARATION_DISTANCE,
		predatorFearMemory = DEFAULT_PREDATOR_FEAR_MEMORY,
		predatorFleeSpeedMultiplier = DEFAULT_PREDATOR_FLEE_SPEED_MULTIPLIER,
		predatorTurnRate = DEFAULT_PREDATOR_TURN_RATE,
		staggerInitialLifecycle = true,
	} = {} ) {

		assertPositiveInteger( 'capacity', capacity );
		if ( ! Number.isInteger( initialCount ) || initialCount < 0 || initialCount > capacity ) {

			throw new RangeError( 'initialCount must be an integer within capacity' );

		}
		assertStage( initialStage );

		this.capacity = capacity;
		this.count = 0;
		this.seed = seed >>> 0;
		this.time = 0;
		this.lifeSpeed = Math.max( 0.0001, lifeSpeed );
		this.flightSpeed = Math.max( 0.01, flightSpeed );
		this.arrivalRadius = Math.max( 0.01, arrivalRadius );
		this.adultSpawnRadius = Math.max( 0, adultSpawnRadius );
		this.feedingHeight = Math.max( 0, feedingHeight );
		this.nectarPerVisit = Math.max( 0, nectarPerVisit );
		this.restDuration = Math.max( 0.01, restDuration );
		this.restDurationSpread = Math.max( 0, restDurationSpread );
		this.feedDuration = Math.max( 0.01, feedDuration );
		this.feedDurationSpread = Math.max( 0, feedDurationSpread );
		this.flightTimeout = Math.max( 0.01, flightTimeout );
		this.flightTimeoutSpread = Math.max( 0, flightTimeoutSpread );
		this.predatorViewDistance = DEFAULT_PREDATOR_VIEW_DISTANCE;
		this.predatorViewFovDegrees = DEFAULT_PREDATOR_VIEW_FOV_DEGREES;
		this.predatorViewCosHalfFov = - 1;
		this.predatorThreatScanFrequency = DEFAULT_PREDATOR_SCAN_FREQUENCY;
		this.predatorThreatScanInterval = 1 / DEFAULT_PREDATOR_SCAN_FREQUENCY;
		this.predatorPredictionTime = DEFAULT_PREDATOR_PREDICTION_TIME;
		this.predatorSeparationDistance = DEFAULT_PREDATOR_SEPARATION_DISTANCE;
		this.predatorFearMemory = DEFAULT_PREDATOR_FEAR_MEMORY;
		this.predatorFleeSpeedMultiplier = DEFAULT_PREDATOR_FLEE_SPEED_MULTIPLIER;
		this.predatorTurnRate = DEFAULT_PREDATOR_TURN_RATE;
		this.predatorCamouflaged = false;
		this.setPredatorPerception( {
			viewDistance: predatorViewDistance,
			viewFovDegrees: predatorViewFovDegrees,
			predictionTime: predatorPredictionTime,
			threatScanFrequency: predatorThreatScanFrequency,
			separationDistance: predatorSeparationDistance,
			fearMemory: predatorFearMemory,
			fleeSpeedMultiplier: predatorFleeSpeedMultiplier,
			turnRate: predatorTurnRate,
		} );
		this.staggerInitialLifecycle = !! staggerInitialLifecycle;

		this._stageDuration = new Float32Array( 4 );
		this._stageDurationSpread = new Float32Array( 4 );
		this._stageDuration[ BUTTERFLY_STAGE.EGG ] = Math.max( 0.01, eggDuration );
		this._stageDuration[ BUTTERFLY_STAGE.LARVA ] = Math.max( 0.01, larvaDuration );
		this._stageDuration[ BUTTERFLY_STAGE.PUPA ] = Math.max( 0.01, pupaDuration );
		this._stageDuration[ BUTTERFLY_STAGE.ADULT ] = Math.max( 0.01, adultDuration );
		this._stageDurationSpread[ BUTTERFLY_STAGE.EGG ] = Math.max( 0, eggDurationSpread );
		this._stageDurationSpread[ BUTTERFLY_STAGE.LARVA ] = Math.max( 0, larvaDurationSpread );
		this._stageDurationSpread[ BUTTERFLY_STAGE.PUPA ] = Math.max( 0, pupaDurationSpread );
		this._stageDurationSpread[ BUTTERFLY_STAGE.ADULT ] = Math.max( 0, adultDurationSpread );

		// Fixed-capacity structure-of-arrays, directly consumable by a renderer.
		this.stage = new Uint8Array( capacity );
		this.behavior = new Uint8Array( capacity );
		this.visible = new Uint8Array( capacity );
		this.captured = new Uint8Array( capacity );
		this.threatVisible = new Uint8Array( capacity );
		this.targetFlower = new Int32Array( capacity );
		this.lastPatch = new Int32Array( capacity );
		this.rngState = new Uint32Array( capacity );
		this.generation = new Uint32Array( capacity );

		this.x = new Float32Array( capacity );
		this.y = new Float32Array( capacity );
		this.z = new Float32Array( capacity );
		this.headingX = new Float32Array( capacity );
		this.headingY = new Float32Array( capacity );
		this.headingZ = new Float32Array( capacity );
		this.stageTime = new Float32Array( capacity );
		this.behaviorTime = new Float32Array( capacity );
		this.age = new Float32Array( capacity );
		this.animationTime = new Float32Array( capacity );
		this.fearTime = new Float32Array( capacity );
		this.threatDistance = new Float32Array( capacity );
		this.threatScanTime = new Float32Array( capacity );
		this.threatX = new Float32Array( capacity );
		this.threatY = new Float32Array( capacity );
		this.threatZ = new Float32Array( capacity );

		this.targetFlower.fill( NO_TARGET );
		this.lastPatch.fill( NO_TARGET );
		this.threatDistance.fill( Infinity );

		this._stageCounts = new Uint32Array( BUTTERFLY_STAGE_NAMES.length );
		this._behaviorCounts = new Uint32Array( BUTTERFLY_BEHAVIOR_NAMES.length );
		this._telemetry = {
			time: 0,
			count: 0,
			visibleAdults: 0,
			flying: 0,
			feeding: 0,
			resting: 0,
			flightCondition: 0,
			flightsStarted: 0,
			flowerVisits: 0,
			eggHatches: 0,
			larvaePupated: 0,
			adultsEmerged: 0,
			cyclesCompleted: 0,
			predated: 0,
			fleeing: 0,
			threatDetections: 0,
			threatScans: 0,
			fleeDistance: 0,
			distanceTravelled: 0,
			lifecycleCatchupClamps: 0,
			stageCounts: this._stageCounts,
			behaviorCounts: this._behaviorCounts,
		};

		this._views = Object.freeze( {
			stage: this.stage,
			behavior: this.behavior,
			visible: this.visible,
			captured: this.captured,
			threatVisible: this.threatVisible,
			targetFlower: this.targetFlower,
			x: this.x,
			y: this.y,
			z: this.z,
			headingX: this.headingX,
			headingY: this.headingY,
			headingZ: this.headingZ,
			stageTime: this.stageTime,
			behaviorTime: this.behaviorTime,
			age: this.age,
			animationTime: this.animationTime,
			fearTime: this.fearTime,
			threatDistance: this.threatDistance,
			generation: this.generation,
		} );

		this.addButterflies( initialCount, DEFAULT_HABITAT, initialStage );

	}

	setPredatorPerception( settings = {} ) {

		if ( ! settings || typeof settings !== 'object' ) {

			throw new TypeError( 'predator perception settings object is required' );

		}
		const viewDistance = settings.butterflyPredatorVisionDistance
			?? settings.visionDistance
			?? settings.viewDistance
			?? this.predatorViewDistance;
		const viewFovDegrees = settings.butterflyPredatorVisionAngle
			?? settings.visionAngle
			?? settings.viewFovDegrees
			?? this.predatorViewFovDegrees;
		const threatScanFrequency = settings.butterflyThreatScanFrequency
			?? settings.threatScanFrequency
			?? this.predatorThreatScanFrequency;
		const fleeSpeedMultiplier = settings.butterflyFleeSpeedMultiplier
			?? settings.fleeSpeedMultiplier
			?? this.predatorFleeSpeedMultiplier;
		const predictionTime = settings.predictionTime ?? this.predatorPredictionTime;
		const separationDistance = settings.separationDistance ?? this.predatorSeparationDistance;
		const fearMemory = settings.fearMemory ?? this.predatorFearMemory;
		const turnRate = settings.turnRate ?? this.predatorTurnRate;

		if ( ! Number.isFinite( viewDistance )
			|| ! Number.isFinite( viewFovDegrees )
			|| ! Number.isFinite( threatScanFrequency )
			|| ! Number.isFinite( fleeSpeedMultiplier )
			|| ! Number.isFinite( predictionTime )
			|| ! Number.isFinite( separationDistance )
			|| ! Number.isFinite( fearMemory )
			|| ! Number.isFinite( turnRate ) ) {

			throw new TypeError( 'predator perception values must be finite' );

		}
		this.predatorViewDistance = Math.max( 0.01, viewDistance );
		this.predatorViewFovDegrees = Math.min( 360, Math.max( 1, viewFovDegrees ) );
		this.predatorViewCosHalfFov = Math.cos( this.predatorViewFovDegrees * Math.PI / 360 );
		this.predatorThreatScanFrequency = Math.min( 60, Math.max( 1, threatScanFrequency ) );
		this.predatorThreatScanInterval = 1 / this.predatorThreatScanFrequency;
		this.predatorFleeSpeedMultiplier = Math.max( 0.1, fleeSpeedMultiplier );
		this.predatorPredictionTime = Math.max( 0, predictionTime );
		this.predatorSeparationDistance = Math.max( 0.01, separationDistance );
		this.predatorFearMemory = Math.max( 0, fearMemory );
		this.predatorTurnRate = Math.max( 0.1, turnRate );
		return this;

	}

	_clearThreat( index, resetScan = false ) {

		this.threatVisible[ index ] = 0;
		this.fearTime[ index ] = 0;
		this.threatDistance[ index ] = Infinity;
		if ( resetScan ) {

			this.threatScanTime[ index ] = ( index & 7 ) * this.predatorThreatScanInterval * 0.125;

		}

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

	_randomDuration( index, minimum, spread ) {

		return minimum + this._random( index ) * spread;

	}

	_setBehavior( index, behavior, duration ) {

		this.behavior[ index ] = behavior;
		this.behaviorTime[ index ] = duration;

	}

	_setStage( index, stage, habitat, stagger ) {

		this.stage[ index ] = stage;
		let duration = this._randomDuration(
			index,
			this._stageDuration[ stage ],
			this._stageDurationSpread[ stage ],
		);
		if ( stagger ) duration *= 0.1 + this._random( index ) * 0.9;
		this.stageTime[ index ] = duration;
		this.targetFlower[ index ] = NO_TARGET;
		this.captured[ index ] = 0;
		this._clearThreat( index, true );

		if ( stage === BUTTERFLY_STAGE.ADULT ) {

			this.visible[ index ] = 1;
			this.x[ index ] = habitat.x + ( this._random( index ) - 0.5 ) * this.adultSpawnRadius;
			this.y[ index ] = habitat.y + 0.65 + this._random( index ) * 0.55;
			this.z[ index ] = habitat.z + ( this._random( index ) - 0.5 ) * this.adultSpawnRadius;
			this._setBehavior(
				index,
				BUTTERFLY_BEHAVIOR.REST,
				this._randomDuration( index, this.restDuration, this.restDurationSpread ),
			);

		} else {

			this.visible[ index ] = 0;
			this.x[ index ] = habitat.x + ( this._random( index ) - 0.5 ) * 0.35;
			this.y[ index ] = habitat.y + 0.04;
			this.z[ index ] = habitat.z + ( this._random( index ) - 0.5 ) * 0.35;
			this.animationTime[ index ] = 0;
			this._setBehavior( index, BUTTERFLY_BEHAVIOR.REST, duration );

		}

	}

	addButterflies( amount, habitat = DEFAULT_HABITAT, stage = BUTTERFLY_STAGE.ADULT ) {

		if ( ! Number.isInteger( amount ) || amount < 0 || this.count + amount > this.capacity ) {

			throw new RangeError( 'amount must fit the remaining butterfly capacity' );

		}
		assertStage( stage );

		const end = this.count + amount;
		for ( let i = this.count; i < end; i ++ ) {

			this.rngState[ i ] = hash32( this.seed + Math.imul( i + 1, 0x9e3779b9 ) );
			this.generation[ i ] = 0;
			this.age[ i ] = 0;
			this.headingX[ i ] = 1;
			this.headingY[ i ] = 0;
			this.headingZ[ i ] = 0;
			this.lastPatch[ i ] = NO_TARGET;
			this.animationTime[ i ] = 0;
			this._setStage( i, stage, habitat, this.staggerInitialLifecycle );

		}

		this.count = end;
		this._refreshTelemetryCounts();
		return this.count;

	}

	setCount( count, habitat = DEFAULT_HABITAT, stage = BUTTERFLY_STAGE.ADULT ) {

		if ( ! Number.isInteger( count ) || count < 0 || count > this.capacity ) {

			throw new RangeError( 'count must be an integer within capacity' );

		}
		if ( count > this.count ) {

			this.addButterflies( count - this.count, habitat, stage );

		} else {

			this.count = count;
			this._refreshTelemetryCounts();

		}
		return this.count;

	}

	getViews() {

		return this._views;

	}

	getTelemetry() {

		return this._telemetry;

	}

	tryCapture( index ) {

		if ( ! Number.isInteger( index ) || index < 0 || index >= this.count ) return false;
		if ( this.stage[ index ] !== BUTTERFLY_STAGE.ADULT ) return false;
		if ( this.visible[ index ] !== 1 || this.captured[ index ] === 1 ) return false;
		this.captured[ index ] = 1;
		this.targetFlower[ index ] = NO_TARGET;
		this._clearThreat( index );
		return true;

	}

	setCapturedPosition( index, x, y, z ) {

		if ( ! Number.isInteger( index ) || index < 0 || index >= this.count ) return false;
		if ( this.captured[ index ] !== 1 ) return false;
		if ( ! Number.isFinite( x ) || ! Number.isFinite( y ) || ! Number.isFinite( z ) ) return false;
		this.x[ index ] = x;
		this.y[ index ] = y;
		this.z[ index ] = z;
		return true;

	}

	releaseCapture( index ) {

		if ( ! Number.isInteger( index ) || index < 0 || index >= this.count ) return false;
		if ( this.captured[ index ] !== 1 ) return false;
		this.captured[ index ] = 0;
		this._setBehavior(
			index,
			BUTTERFLY_BEHAVIOR.REST,
			this._randomDuration( index, this.restDuration, this.restDurationSpread ),
		);
		return true;

	}

	consumeCaptured( index, habitat = DEFAULT_HABITAT ) {

		if ( ! Number.isInteger( index ) || index < 0 || index >= this.count ) return false;
		if ( this.captured[ index ] !== 1 || this.stage[ index ] !== BUTTERFLY_STAGE.ADULT ) return false;
		this._telemetry.predated ++;
		this._telemetry.cyclesCompleted ++;
		this.generation[ index ] ++;
		this._setStage( index, BUTTERFLY_STAGE.EGG, habitat, false );
		this._refreshTelemetryCounts();
		return true;

	}

	_flightCondition( daylight, weather ) {

		const light = smoothstep( 0.12, 0.38, daylight );
		const temperatureC = weather.temperatureC === undefined ?
			DEFAULT_WEATHER.temperatureC :
			weather.temperatureC;
		const rain = weather.rain === undefined ? DEFAULT_WEATHER.rain : weather.rain;
		const windSpeed = weather.windSpeed === undefined ? DEFAULT_WEATHER.windSpeed : weather.windSpeed;
		const warmEnough = smoothstep( 11, 18, temperatureC );
		const notTooHot = 1 - smoothstep( 32, 40, temperatureC );
		const dry = 1 - clamp01( rain );
		const wind = 1 - smoothstep( 4, 9, windSpeed );
		return light * warmEnough * notTooHot * dry * wind;

	}

	_flowerAvailable( flowers, index ) {

		const count = Math.max( 0, flowers.count | 0 );
		if ( index < 0 || index >= count ) return false;
		if ( flowers.active && ! flowers.active[ index ] ) return false;
		if ( flowers.nectar && flowers.nectar[ index ] <= 0.0001 ) return false;
		return true;

	}

	_assignFlower( index, flowers ) {

		const count = Math.max( 0, flowers.count | 0 );
		if ( count === 0 ) {

			this.targetFlower[ index ] = NO_TARGET;
			return false;

		}
		if ( ! flowers.x || ! flowers.y || ! flowers.z ) {

			throw new TypeError( 'flowers.x, flowers.y and flowers.z are required when flower count is positive' );

		}

		let best = NO_TARGET;
		let bestScore = - Infinity;
		const previousPatch = this.lastPatch[ index ];

		for ( let sample = 0; sample < BUTTERFLY_FLOWER_CANDIDATE_SAMPLES; sample ++ ) {

			const candidate = Math.floor( this._random( index ) * count );
			if ( flowers.active && ! flowers.active[ candidate ] ) continue;
			const nectar = flowers.nectar ? Math.max( 0, flowers.nectar[ candidate ] ) : 1;
			if ( nectar <= 0.0001 ) continue;

			const dx = flowers.x[ candidate ] - this.x[ index ];
			const dy = flowers.y[ candidate ] - this.y[ index ];
			const dz = flowers.z[ candidate ] - this.z[ index ];
			const distance = Math.sqrt( dx * dx + dy * dy + dz * dz );
			const quality = flowers.quality ? Math.max( 0, flowers.quality[ candidate ] ) : 1;
			const patch = flowers.patch ? flowers.patch[ candidate ] | 0 : candidate;
			const familiarity = patch === previousPatch ? 0.18 : 0;
			const score = nectar * 0.35 + quality + familiarity - distance * 0.022;

			if ( score > bestScore ) {

				bestScore = score;
				best = candidate;

			}

		}

		this.targetFlower[ index ] = best;
		return best !== NO_TARGET;

	}

	_moveToward( index, targetX, targetY, targetZ, dt ) {

		const dx = targetX - this.x[ index ];
		const dy = targetY - this.y[ index ];
		const dz = targetZ - this.z[ index ];
		const distanceSquared = dx * dx + dy * dy + dz * dz;
		if ( distanceSquared <= 1e-12 ) return 0;

		const distance = Math.sqrt( distanceSquared );
		const inverse = 1 / distance;
		const step = Math.min( distance, this.flightSpeed * dt );
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
		return distance - step;

	}

	_startFlight( index, flowers ) {

		if ( ! this._assignFlower( index, flowers ) ) return false;
		this._setBehavior(
			index,
			BUTTERFLY_BEHAVIOR.FLY,
			this._randomDuration( index, this.flightTimeout, this.flightTimeoutSpread ),
		);
		this._telemetry.flightsStarted ++;
		return true;

	}

	_updatePredatorAvoidance( index, predator, dt ) {

		if ( ! predator || predator.active === false || predator.enabled === false || predator.visible === false
			|| predator.camouflaged === true || predator.isCamouflaged === true ) {

			this._clearThreat( index );
			return false;

		}

		this.fearTime[ index ] = Math.max( 0, this.fearTime[ index ] - dt );
		this.threatScanTime[ index ] -= dt;
		if ( this.threatScanTime[ index ] <= 0 ) {

			this.threatScanTime[ index ] = this.predatorThreatScanInterval;
			this._telemetry.threatScans ++;
			const predatorX = predator.x;
			const predatorY = predator.y;
			const predatorZ = predator.z;
			let seen = Number.isFinite( predatorX )
				&& Number.isFinite( predatorY )
				&& Number.isFinite( predatorZ );
			let toX = 0;
			let toY = 0;
			let toZ = 0;
			let distance = Infinity;
			if ( seen ) {

				toX = predatorX - this.x[ index ];
				toY = predatorY - this.y[ index ];
				toZ = predatorZ - this.z[ index ];
				const distanceSquared = toX * toX + toY * toY + toZ * toZ;
				seen = distanceSquared <= this.predatorViewDistance * this.predatorViewDistance;
				if ( seen ) {

					distance = Math.sqrt( distanceSquared );
					if ( distance > 0.000001 ) {

						const headingLength = Math.hypot(
							this.headingX[ index ],
							this.headingY[ index ],
							this.headingZ[ index ],
						);
						if ( headingLength > 0.000001 ) {

							const facing = (
								this.headingX[ index ] * toX
								+ this.headingY[ index ] * toY
								+ this.headingZ[ index ] * toZ
							) / ( headingLength * distance );
							seen = facing >= this.predatorViewCosHalfFov;

						}

					}

				}

			}

			const wasVisible = this.threatVisible[ index ] === 1;
			this.threatVisible[ index ] = seen ? 1 : 0;
			if ( seen ) {

				if ( ! wasVisible ) this._telemetry.threatDetections ++;
				this.fearTime[ index ] = this.predatorFearMemory + this.predatorThreatScanInterval;
				this.threatDistance[ index ] = distance;
				let velocityX = Number.isFinite( predator.velocityX ) ? predator.velocityX : 0;
				let velocityY = Number.isFinite( predator.velocityY ) ? predator.velocityY : 0;
				let velocityZ = Number.isFinite( predator.velocityZ ) ? predator.velocityZ : 0;
				if ( velocityX === 0 && velocityY === 0 && velocityZ === 0 ) {

					const speed = Number.isFinite( predator.speed ) ? predator.speed : 0;
					velocityX = Number.isFinite( predator.headingX ) ? predator.headingX * speed : 0;
					velocityY = Number.isFinite( predator.headingY ) ? predator.headingY * speed : 0;
					velocityZ = Number.isFinite( predator.headingZ ) ? predator.headingZ * speed : 0;

				}
				let predictionScale = this.predatorPredictionTime;
				const predictedDisplacement = Math.hypot( velocityX, velocityY, velocityZ ) * predictionScale;
				const maximumPrediction = this.predatorViewDistance * 0.5;
				if ( predictedDisplacement > maximumPrediction && predictedDisplacement > 0 ) {

					predictionScale *= maximumPrediction / predictedDisplacement;

				}
				this.threatX[ index ] = predatorX + velocityX * predictionScale;
				this.threatY[ index ] = predatorY + velocityY * predictionScale;
				this.threatZ[ index ] = predatorZ + velocityZ * predictionScale;

			}

		}

		if ( this.fearTime[ index ] <= 0 ) {

			this._clearThreat( index );
			return false;

		}

		let awayX = this.x[ index ] - this.threatX[ index ];
		let awayY = this.y[ index ] - this.threatY[ index ];
		let awayZ = this.z[ index ] - this.threatZ[ index ];
		let awayLength = Math.hypot( awayX, awayY, awayZ );
		if ( awayLength <= 0.000001 ) {

			awayX = ( index & 1 ) === 0 ? 1 : - 1;
			awayY = 0.35;
			awayZ = ( index & 2 ) === 0 ? - 0.65 : 0.65;
			awayLength = Math.hypot( awayX, awayY, awayZ );

		}
		awayX /= awayLength;
		awayY /= awayLength;
		awayZ /= awayLength;
		const urgency = clamp01( 1 - awayLength / this.predatorSeparationDistance );
		awayY += 0.12 + urgency * 0.28;
		const awayAdjustedLength = Math.hypot( awayX, awayY, awayZ ) || 1;
		awayX /= awayAdjustedLength;
		awayY /= awayAdjustedLength;
		awayZ /= awayAdjustedLength;

		const turnBlend = Math.min( 1, this.predatorTurnRate * ( 1 + urgency ) * dt );
		let headingX = this.headingX[ index ] + ( awayX - this.headingX[ index ] ) * turnBlend;
		let headingY = this.headingY[ index ] + ( awayY - this.headingY[ index ] ) * turnBlend;
		let headingZ = this.headingZ[ index ] + ( awayZ - this.headingZ[ index ] ) * turnBlend;
		const headingLength = Math.hypot( headingX, headingY, headingZ ) || 1;
		headingX /= headingLength;
		headingY /= headingLength;
		headingZ /= headingLength;

		const step = this.flightSpeed * this.predatorFleeSpeedMultiplier * ( 0.9 + urgency * 0.25 ) * dt;
		this.x[ index ] += headingX * step;
		this.y[ index ] += headingY * step;
		this.z[ index ] += headingZ * step;
		this.headingX[ index ] = headingX;
		this.headingY[ index ] = headingY;
		this.headingZ[ index ] = headingZ;
		this.threatDistance[ index ] = Math.hypot(
			this.x[ index ] - this.threatX[ index ],
			this.y[ index ] - this.threatY[ index ],
			this.z[ index ] - this.threatZ[ index ],
		);
		this.targetFlower[ index ] = NO_TARGET;
		this.behavior[ index ] = BUTTERFLY_BEHAVIOR.FLY;
		this.behaviorTime[ index ] = Math.max( this.behaviorTime[ index ], this.fearTime[ index ] );
		this._telemetry.fleeDistance += step;
		this._telemetry.distanceTravelled += step;
		return true;

	}

	_advanceLifecycle( index, lifeDelta, habitat ) {

		let remaining = this.stageTime[ index ] - lifeDelta;
		let transitions = 0;

		while ( remaining <= 0.0000001 && transitions < MAX_LIFECYCLE_TRANSITIONS_PER_UPDATE ) {

			const overshoot = Math.max( 0, - remaining );
			const previousStage = this.stage[ index ];
			let nextStage = previousStage + 1;
			if ( nextStage > BUTTERFLY_STAGE.ADULT ) nextStage = BUTTERFLY_STAGE.EGG;

			if ( previousStage === BUTTERFLY_STAGE.EGG ) {

				this._telemetry.eggHatches ++;

			} else if ( previousStage === BUTTERFLY_STAGE.LARVA ) {

				this._telemetry.larvaePupated ++;

			} else if ( previousStage === BUTTERFLY_STAGE.PUPA ) {

				this._telemetry.adultsEmerged ++;

			} else {

				this._telemetry.cyclesCompleted ++;
				this.generation[ index ] ++;

			}

			this._setStage( index, nextStage, habitat, false );
			remaining = this.stageTime[ index ] - overshoot;
			transitions ++;

		}

		if ( remaining <= 0 ) {

			remaining = 0.000001;
			this._telemetry.lifecycleCatchupClamps ++;

		}
		this.stageTime[ index ] = remaining;

	}

	_refreshTelemetryCounts() {

		this._stageCounts.fill( 0 );
		this._behaviorCounts.fill( 0 );
		let visibleAdults = 0;
		let flying = 0;
		let feeding = 0;
		let resting = 0;
		let fleeing = 0;

		for ( let i = 0; i < this.count; i ++ ) {

			const stage = this.stage[ i ];
			this._stageCounts[ stage ] ++;
			if ( stage !== BUTTERFLY_STAGE.ADULT ) continue;

			visibleAdults ++;
			if ( this.fearTime[ i ] > 0 ) fleeing ++;
			const behavior = this.behavior[ i ];
			this._behaviorCounts[ behavior ] ++;
			if ( behavior === BUTTERFLY_BEHAVIOR.FLY ) flying ++;
			else if ( behavior === BUTTERFLY_BEHAVIOR.FEED ) feeding ++;
			else resting ++;

		}

		this._telemetry.count = this.count;
		this._telemetry.visibleAdults = visibleAdults;
		this._telemetry.flying = flying;
		this._telemetry.feeding = feeding;
		this._telemetry.resting = resting;
		this._telemetry.fleeing = fleeing;

	}

	update( dt, context ) {

		if ( ! Number.isFinite( dt ) || dt < 0 ) throw new RangeError( 'dt must be a finite non-negative number' );
		const activeContext = context || DEFAULT_HABITAT;
		const daylight = clamp01( activeContext.daylight === undefined ? 1 : activeContext.daylight );
		const weather = activeContext.weather || DEFAULT_WEATHER;
		const habitat = activeContext.habitat || DEFAULT_HABITAT;
		const flowers = activeContext.flowers || EMPTY_FLOWERS;
		const predator = activeContext.predator || null;
		this.predatorCamouflaged = !! predator
			&& ( predator.camouflaged === true || predator.isCamouflaged === true );
		const predatorActive = !! predator
			&& predator.active !== false
			&& predator.enabled !== false
			&& predator.visible !== false
			&& ! this.predatorCamouflaged;
		const clearPredatorFear = ! predatorActive && this._telemetry.fleeing > 0;
		const flightCondition = this._flightCondition( daylight, weather );
		const canFly = flightCondition >= 0.22;
		const lifeDelta = dt * this.lifeSpeed;

		this.time += dt;
		this._telemetry.time = this.time;
		this._telemetry.flightCondition = flightCondition;

		for ( let i = 0; i < this.count; i ++ ) {

			if ( this.captured[ i ] === 1 ) {

				this.animationTime[ i ] += dt;
				continue;

			}
			this.age[ i ] += lifeDelta;
			if ( lifeDelta > 0 ) this._advanceLifecycle( i, lifeDelta, habitat );
			if ( this.stage[ i ] !== BUTTERFLY_STAGE.ADULT ) continue;

			if ( ( predatorActive || clearPredatorFear )
				&& this._updatePredatorAvoidance( i, predatorActive ? predator : null, dt ) ) {

				this.animationTime[ i ] += dt;
				continue;

			}
			this.behaviorTime[ i ] -= dt;
			if ( this.behavior[ i ] === BUTTERFLY_BEHAVIOR.FLY ) {

				this.animationTime[ i ] += dt;
				if ( ! canFly ) {

					this.targetFlower[ i ] = NO_TARGET;
					this._setBehavior(
						i,
						BUTTERFLY_BEHAVIOR.REST,
						this._randomDuration( i, this.restDuration, this.restDurationSpread ),
					);
					continue;

				}

				let target = this.targetFlower[ i ];
				if ( ! this._flowerAvailable( flowers, target ) ) {

					if ( ! this._startFlight( i, flowers ) ) {

						this._setBehavior(
							i,
							BUTTERFLY_BEHAVIOR.REST,
							this._randomDuration( i, this.restDuration, this.restDurationSpread ),
						);
						continue;

					}
					target = this.targetFlower[ i ];

				}

				const remaining = this._moveToward(
					i,
					flowers.x[ target ],
					flowers.y[ target ] + this.feedingHeight,
					flowers.z[ target ],
					dt,
				);
				if ( remaining <= this.arrivalRadius ) {

					this.x[ i ] = flowers.x[ target ];
					this.y[ i ] = flowers.y[ target ] + this.feedingHeight;
					this.z[ i ] = flowers.z[ target ];
					this._setBehavior(
						i,
						BUTTERFLY_BEHAVIOR.FEED,
						this._randomDuration( i, this.feedDuration, this.feedDurationSpread ),
					);

				} else if ( this.behaviorTime[ i ] <= 0 ) {

					this.targetFlower[ i ] = NO_TARGET;
					this._setBehavior(
						i,
						BUTTERFLY_BEHAVIOR.REST,
						this._randomDuration( i, this.restDuration, this.restDurationSpread ),
					);

				}

			} else if ( this.behavior[ i ] === BUTTERFLY_BEHAVIOR.FEED ) {

				this.animationTime[ i ] += dt * 0.55;
				let target = this.targetFlower[ i ];
				if ( ! this._flowerAvailable( flowers, target ) ) {

					this.targetFlower[ i ] = NO_TARGET;
					this.behaviorTime[ i ] = 0;
					target = NO_TARGET;

				} else {

					this.x[ i ] = flowers.x[ target ];
					this.y[ i ] = flowers.y[ target ] + this.feedingHeight;
					this.z[ i ] = flowers.z[ target ];

				}

				if ( this.behaviorTime[ i ] <= 0 ) {

					if ( target >= 0 && target < ( flowers.count | 0 ) ) {

						const patch = flowers.patch ? flowers.patch[ target ] | 0 : target;
						this.lastPatch[ i ] = patch;
						if ( flowers.nectar ) {

							flowers.nectar[ target ] = Math.max(
								0,
								flowers.nectar[ target ] - this.nectarPerVisit,
							);

						}
						this._telemetry.flowerVisits ++;

					}
					this.targetFlower[ i ] = NO_TARGET;
					if ( canFly && this._random( i ) < 0.72 && this._startFlight( i, flowers ) ) {

						// State set by _startFlight.

					} else {

						this._setBehavior(
							i,
							BUTTERFLY_BEHAVIOR.REST,
							this._randomDuration( i, this.restDuration, this.restDurationSpread ),
						);

					}

				}

			} else {

				this.animationTime[ i ] += dt * 0.18;
				if ( ! canFly ) {

					// A storm interrupts flight, then the adult settles instead of
					// remaining frozen in mid-air. The landing is bounded and uses no
					// scene query: terrain height is supplied by the stable habitat.
					const restingY = habitat.y + 0.12;
					if ( this.y[ i ] > restingY ) {

						const descent = Math.min( this.y[ i ] - restingY, this.flightSpeed * dt * 0.35 );
						this.y[ i ] -= descent;
						this.headingX[ i ] = 0;
						this.headingY[ i ] = - 1;
						this.headingZ[ i ] = 0;

					}
					this.behaviorTime[ i ] = Math.max( this.behaviorTime[ i ], 0.25 );

				} else if ( this.behaviorTime[ i ] <= 0 ) {

					if ( ! this._startFlight( i, flowers ) ) {

						this._setBehavior(
							i,
							BUTTERFLY_BEHAVIOR.REST,
							this._randomDuration( i, this.restDuration, this.restDurationSpread ),
						);

					}

				}

			}

		}

		this._refreshTelemetryCounts();
		return this._telemetry;

	}

	writeDebugRecord( index, output ) {

		if ( ! output || typeof output !== 'object' ) throw new TypeError( 'output object is required' );
		if ( ! Number.isInteger( index ) || index < 0 || index >= this.count ) {

			throw new RangeError( 'butterfly index is outside the active range' );

		}

		output.index = index;
		output.stage = BUTTERFLY_STAGE_NAMES[ this.stage[ index ] ];
		output.stageCode = this.stage[ index ];
		output.behavior = BUTTERFLY_BEHAVIOR_NAMES[ this.behavior[ index ] ];
		output.behaviorCode = this.behavior[ index ];
		output.visible = this.visible[ index ] === 1;
		output.captured = this.captured[ index ] === 1;
		output.threat = this.fearTime[ index ] > 0 ? 'CHAMELEON' : null;
		output.threatVisible = this.threatVisible[ index ] === 1;
		output.threatDistance = this.threatDistance[ index ];
		output.fearRemaining = this.fearTime[ index ];
		output.predatorCamouflaged = this.predatorCamouflaged;
		output.visionDistance = this.predatorViewDistance;
		output.visionFovDegrees = this.predatorViewFovDegrees;
		output.threatScanFrequency = this.predatorThreatScanFrequency;
		output.fleeSpeedMultiplier = this.predatorFleeSpeedMultiplier;
		output.positionX = this.x[ index ];
		output.positionY = this.y[ index ];
		output.positionZ = this.z[ index ];
		output.headingX = this.headingX[ index ];
		output.headingY = this.headingY[ index ];
		output.headingZ = this.headingZ[ index ];
		output.targetFlower = this.targetFlower[ index ];
		output.stageTime = this.stageTime[ index ];
		output.age = this.age[ index ];
		output.generation = this.generation[ index ];
		output.behaviorTime = this.behaviorTime[ index ];
		output.intention = output.captured
			? 'CAPTURED'
			: this.stage[ index ] !== BUTTERFLY_STAGE.ADULT
				? 'DEVELOPING'
				: this.fearTime[ index ] > 0
					? 'FLEE_CHAMELEON'
					: this.behavior[ index ] === BUTTERFLY_BEHAVIOR.FLY
						? 'FLY_TO_FLOWER'
						: this.behavior[ index ] === BUTTERFLY_BEHAVIOR.FEED
							? 'FEED_AT_FLOWER'
							: 'REST';
		return output;

	}

	snapshot( index ) {

		return this.writeDebugRecord( index, {} );

	}

}

export function createButterflySimulation( options ) {

	return new ButterflySimulation( options );

}
