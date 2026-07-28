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

		this.targetFlower.fill( NO_TARGET );
		this.lastPatch.fill( NO_TARGET );

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
			distanceTravelled: 0,
			lifecycleCatchupClamps: 0,
			stageCounts: this._stageCounts,
			behaviorCounts: this._behaviorCounts,
		};

		this._views = Object.freeze( {
			stage: this.stage,
			behavior: this.behavior,
			visible: this.visible,
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
			generation: this.generation,
		} );

		this.addButterflies( initialCount, DEFAULT_HABITAT, initialStage );

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

		for ( let i = 0; i < this.count; i ++ ) {

			const stage = this.stage[ i ];
			this._stageCounts[ stage ] ++;
			if ( stage !== BUTTERFLY_STAGE.ADULT ) continue;

			visibleAdults ++;
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

	}

	update( dt, context ) {

		if ( ! Number.isFinite( dt ) || dt < 0 ) throw new RangeError( 'dt must be a finite non-negative number' );
		const activeContext = context || DEFAULT_HABITAT;
		const daylight = clamp01( activeContext.daylight === undefined ? 1 : activeContext.daylight );
		const weather = activeContext.weather || DEFAULT_WEATHER;
		const habitat = activeContext.habitat || DEFAULT_HABITAT;
		const flowers = activeContext.flowers || EMPTY_FLOWERS;
		const flightCondition = this._flightCondition( daylight, weather );
		const canFly = flightCondition >= 0.22;
		const lifeDelta = dt * this.lifeSpeed;

		this.time += dt;
		this._telemetry.time = this.time;
		this._telemetry.flightCondition = flightCondition;

		for ( let i = 0; i < this.count; i ++ ) {

			this.age[ i ] += lifeDelta;
			if ( lifeDelta > 0 ) this._advanceLifecycle( i, lifeDelta, habitat );
			if ( this.stage[ i ] !== BUTTERFLY_STAGE.ADULT ) continue;

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
		return output;

	}

	snapshot( index ) {

		return this.writeDebugRecord( index, {} );

	}

}

export function createButterflySimulation( options ) {

	return new ButterflySimulation( options );

}
