/**
 * Deterministic, renderer-agnostic chameleon behaviour kernel.
 *
 * The simulation owns one chameleon and consumes butterfly-like fixed-capacity
 * SoA views. Its update hot path does not create arrays, objects or closures.
 */

export const CHAMELEON_STATE = Object.freeze( {
	REST_SCAN: 0,
	PATROL_LOG: 1,
	TRACK_PREY: 2,
	AIM_AND_BRACE: 3,
	STRIKE_EXTEND: 4,
	CONTACT: 5,
	RETRACT_WITH_PREY: 6,
	BITE_AND_SWALLOW: 7,
	COOLDOWN: 8,
} );

export const CHAMELEON_STATE_NAMES = Object.freeze( [
	'REST_SCAN',
	'PATROL_LOG',
	'TRACK_PREY',
	'AIM_AND_BRACE',
	'STRIKE_EXTEND',
	'CONTACT',
	'RETRACT_WITH_PREY',
	'BITE_AND_SWALLOW',
	'COOLDOWN',
] );

export const CHAMELEON_MIN_SCAN_HZ = 8;
export const CHAMELEON_MAX_SCAN_HZ = 10;
export const CHAMELEON_CAMOUFLAGE_SETTLE_SECONDS = 0.08;

export function advanceChameleonCamouflageDwell(
	previousDwell, dt, active, stationary, revealing,
) {

	const elapsed = Number.isFinite( previousDwell ) && previousDwell > 0 ? previousDwell : 0;
	const step = Number.isFinite( dt ) && dt > 0 ? dt : 0;
	return active && stationary && ! revealing ? elapsed + step : 0;

}

const NO_TARGET = - 1;
const EPSILON = 1e-8;
const EMPTY_PREY_CONTEXT = Object.freeze( {
	count: 0,
} );

function clamp( value, minimum, maximum ) {

	return value <= minimum ? minimum : value >= maximum ? maximum : value;

}

function clamp01( value ) {

	return value <= 0 ? 0 : value >= 1 ? 1 : value;

}

function smoothstep01( value ) {

	const x = clamp01( value );
	return x * x * ( 3 - 2 * x );

}

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function assertFiniteNumber( name, value ) {

	if ( ! Number.isFinite( value ) ) {

		throw new TypeError( `${ name } must be a finite number` );

	}

}

/**
 * Context accepted by update(dt, prey):
 * {
 *   count, capacity?, x, y, z,          // direct SoA views
 *   active?, visible?, captured?,       // optional indexed masks
 *   headingX?, headingY?, headingZ?,    // optional prediction direction
 *   speed?,                             // optional indexed prey speed
 *   tryCapture?(index),
 *   setCapturedPosition?(index, x, y, z),
 *   consume?(index)
 * }
 *
 * The same shape may be supplied as context.prey.
 */
export class ChameleonSimulation {

	constructor( {
		preyCapacity = 64,
		scanFrequency = 9,
		attackDistance = 3.2,
		detectionDistance = attackDistance * 1.55,
		maxTongueLength = attackDistance * 1.08,
		patrolSpeed = 0.62,
		trackingSpeed = 0.95,
		turnSpeed = 6,
		restScanDuration = 0.55,
		aimDuration = 0.55,
		predictionTime = 0.035,
		predictionSpeed = 4.2,
		extendDuration = 0.055,
		missRetractDuration = 0.085,
		contactDuration = 0.028,
		retractDuration = 0.28,
		biteDuration = 0.24,
		cooldownDuration = 1.1,
		preyRadius = 0.14,
		tongueRadius = 0.045,
		mouthConsumeRadius = 0.055,
		mouthForward = 0.28,
		mouthHeight = 0.13,
		maxIntegrationStep = 1 / 120,
		maxIntegrationSteps = 256,
		holdAtTrackEnd = false,
		externalLocomotion = false,
	} = {} ) {

		if ( ! Number.isInteger( preyCapacity ) || preyCapacity <= 0 ) {

			throw new RangeError( 'preyCapacity must be a positive integer' );

		}
		if ( ! Number.isInteger( maxIntegrationSteps ) || maxIntegrationSteps <= 0 ) {

			throw new RangeError( 'maxIntegrationSteps must be a positive integer' );

		}

		this.preyCapacity = preyCapacity;
		this.scanFrequency = clamp(
			finiteOr( scanFrequency, 9 ),
			CHAMELEON_MIN_SCAN_HZ,
			CHAMELEON_MAX_SCAN_HZ,
		);
		this.scanInterval = 1 / this.scanFrequency;
		this.attackDistance = Math.max( 0.01, finiteOr( attackDistance, 3.2 ) );
		this.detectionDistance = Math.max(
			this.attackDistance,
			finiteOr( detectionDistance, this.attackDistance * 1.55 ),
		);
		this.maxTongueLength = Math.max(
			this.attackDistance,
			finiteOr( maxTongueLength, this.attackDistance * 1.08 ),
		);
		this.patrolSpeed = Math.max( 0, finiteOr( patrolSpeed, 0.62 ) );
		this.trackingSpeed = Math.max( 0, finiteOr( trackingSpeed, 0.95 ) );
		this.turnSpeed = Math.max( 0.1, finiteOr( turnSpeed, 6 ) );
		this.restScanDuration = Math.max( 0, finiteOr( restScanDuration, 0.55 ) );
		this.aimDuration = Math.max( 0.001, finiteOr( aimDuration, 0.55 ) );
		this.predictionTime = Math.max( 0, finiteOr( predictionTime, 0.035 ) );
		this.predictionSpeed = Math.max( 0, finiteOr( predictionSpeed, 4.2 ) );
		this.extendDuration = Math.max( 0.001, finiteOr( extendDuration, 0.055 ) );
		this.missRetractDuration = Math.max( 0.001, finiteOr( missRetractDuration, 0.085 ) );
		this.contactDuration = Math.max( 0, finiteOr( contactDuration, 0.028 ) );
		this.retractDuration = Math.max( 0.001, finiteOr( retractDuration, 0.28 ) );
		this.biteDuration = Math.max( 0.001, finiteOr( biteDuration, 0.24 ) );
		this.cooldownDuration = Math.max( 0, finiteOr( cooldownDuration, 1.1 ) );
		this.preyRadius = Math.max( 0, finiteOr( preyRadius, 0.14 ) );
		this.tongueRadius = Math.max( 0, finiteOr( tongueRadius, 0.045 ) );
		this.mouthConsumeRadius = Math.max( 0.001, finiteOr( mouthConsumeRadius, 0.055 ) );
		this.mouthForward = finiteOr( mouthForward, 0.28 );
		this.mouthHeight = finiteOr( mouthHeight, 0.13 );
		this.maxIntegrationStep = Math.max( 1 / 1000, finiteOr( maxIntegrationStep, 1 / 120 ) );
		this.maxIntegrationSteps = maxIntegrationSteps;
		this.holdAtTrackEnd = !! holdAtTrackEnd;
		this.externalLocomotion = !! externalLocomotion;

		this.time = 0;
		this.state = CHAMELEON_STATE.REST_SCAN;
		this.stateTime = 0;
		this.targetIndex = NO_TARGET;
		this.capturedIndex = NO_TARGET;
		this.patrolDirection = 1;
		this.trackPosition = 0;
		this.trackLength = 0;
		this.routeCompleted = 0;
		this._trackSegment = 0;

		this.x = 0;
		this.y = 0;
		this.z = 0;
		this.headingX = 1;
		this.headingY = 0;
		this.headingZ = 0;
		this.upX = 0;
		this.upY = 1;
		this.upZ = 0;
		this.mouthX = 0;
		this.mouthY = 0;
		this.mouthZ = 0;
		this.tongueTipX = 0;
		this.tongueTipY = 0;
		this.tongueTipZ = 0;
		this.tongueVisible = 0;
		this.tongueExtension = 0;
		this._tongueOccluded = 0;
		this.attackClipPhase = 0;

		this.aimX = 0;
		this.aimY = 0;
		this.aimZ = 0;
		this.strikeX = 0;
		this.strikeY = 0;
		this.strikeZ = 0;
		this._contactTipX = 0;
		this._contactTipY = 0;
		this._contactTipZ = 0;
		this._captureOffsetX = 0;
		this._captureOffsetY = 0;
		this._captureOffsetZ = 0;
		this._projectedTrackPosition = 0;
		this._projectedDistanceSq = Infinity;
		this._scanCountdown = 0;
		this._captureContext = null;
		this._externalPoseInitialized = false;
		this._externalPoseDirty = false;
		this._externalPendingDistance = 0;

		this._trackX = null;
		this._trackY = null;
		this._trackZ = null;
		this._trackNormalX = null;
		this._trackNormalY = null;
		this._trackNormalZ = null;
		this._trackCumulative = null;
		this._trackCount = 0;

		this._telemetry = Object.seal( {
			time: 0,
			state: this.state,
			targetIndex: NO_TARGET,
			scans: 0,
			targetChecks: 0,
			targetsAcquired: 0,
			targetsLost: 0,
			attacksReleased: 0,
			contacts: 0,
			captures: 0,
			captureRejected: 0,
			misses: 0,
			consumed: 0,
			consumeRejected: 0,
			stateTransitions: 0,
			trackReversals: 0,
			distanceTravelled: 0,
			lastStepDistance: 0,
			maxStepDistance: 0,
			updateCalls: 0,
			integrationSteps: 0,
			droppedTime: 0,
		} );

		this._view = Object.seal( {
			x: 0,
			y: 0,
			z: 0,
			headingX: 1,
			headingY: 0,
			headingZ: 0,
			upX: 0,
			upY: 1,
			upZ: 0,
			state: this.state,
			stateName: CHAMELEON_STATE_NAMES[ this.state ],
			stateTime: 0,
			targetIndex: NO_TARGET,
			capturedIndex: NO_TARGET,
			mouthX: 0,
			mouthY: 0,
			mouthZ: 0,
			tongueTipX: 0,
			tongueTipY: 0,
			tongueTipZ: 0,
			tongueVisible: 0,
			tongueExtension: 0,
			attackClipPhase: 0,
			aimX: 0,
			aimY: 0,
			aimZ: 0,
			strikeX: 0,
			strikeY: 0,
			strikeZ: 0,
			trackPosition: 0,
			trackLength: 0,
			routeCompleted: 0,
		} );

		this.setTrack( - 1, 0, 0, 1, 0, 0 );

	}

	setAttackDistance( attackDistance, detectionDistance = this.detectionDistance ) {

		assertFiniteNumber( 'attackDistance', attackDistance );
		assertFiniteNumber( 'detectionDistance', detectionDistance );
		this.attackDistance = Math.max( 0.01, attackDistance );
		this.detectionDistance = Math.max( this.attackDistance, detectionDistance );
		this.maxTongueLength = Math.max( this.maxTongueLength, this.attackDistance );
		return this.attackDistance;

	}

	setTrack( startX, startY, startZ, endX, endY, endZ ) {

		const x = new Float32Array( 2 );
		const y = new Float32Array( 2 );
		const z = new Float32Array( 2 );
		x[ 0 ] = startX;
		y[ 0 ] = startY;
		z[ 0 ] = startZ;
		x[ 1 ] = endX;
		y[ 1 ] = endY;
		z[ 1 ] = endZ;
		return this.setTrackSamples( x, y, z, 2 );

	}

	setTrackSamples( sourceX, sourceY, sourceZ, count ) {

		let x = sourceX;
		let y = sourceY;
		let z = sourceZ;
		let normalX = null;
		let normalY = null;
		let normalZ = null;
		let sampleCount = count;
		if ( sourceX && sourceX.x && sourceX.y && sourceX.z ) {

			x = sourceX.x;
			y = sourceX.y;
			z = sourceX.z;
			normalX = sourceX.normalX || null;
			normalY = sourceX.normalY || null;
			normalZ = sourceX.normalZ || null;
			sampleCount = sourceX.count;

		}
		if ( ! x || ! y || ! z ) throw new TypeError( 'track samples require x, y and z arrays' );
		const hasAnyNormals = !! ( normalX || normalY || normalZ );
		const hasNormals = !! ( normalX && normalY && normalZ );
		if ( hasAnyNormals && ! hasNormals ) {

			throw new TypeError( 'track normals require normalX, normalY and normalZ arrays' );

		}
		if ( sampleCount === undefined ) sampleCount = Math.min( x.length, y.length, z.length );
		if ( ! Number.isInteger( sampleCount ) || sampleCount < 2 ) {

			throw new RangeError( 'track sample count must be at least 2' );

		}
		if ( x.length < sampleCount || y.length < sampleCount || z.length < sampleCount ) {

			throw new RangeError( 'track sample arrays are shorter than count' );

		}
		if ( hasNormals && ( normalX.length < sampleCount
			|| normalY.length < sampleCount || normalZ.length < sampleCount ) ) {

			throw new RangeError( 'track normal arrays are shorter than count' );

		}

		const trackX = new Float32Array( sampleCount );
		const trackY = new Float32Array( sampleCount );
		const trackZ = new Float32Array( sampleCount );
		const trackNormalX = new Float32Array( sampleCount );
		const trackNormalY = new Float32Array( sampleCount );
		const trackNormalZ = new Float32Array( sampleCount );
		const cumulative = new Float32Array( sampleCount );
		for ( let i = 0; i < sampleCount; i ++ ) {

			assertFiniteNumber( `track x[${ i }]`, x[ i ] );
			assertFiniteNumber( `track y[${ i }]`, y[ i ] );
			assertFiniteNumber( `track z[${ i }]`, z[ i ] );
			trackX[ i ] = x[ i ];
			trackY[ i ] = y[ i ];
			trackZ[ i ] = z[ i ];
			let nx = 0;
			let ny = 1;
			let nz = 0;
			if ( hasNormals ) {

				assertFiniteNumber( `track normal x[${ i }]`, normalX[ i ] );
				assertFiniteNumber( `track normal y[${ i }]`, normalY[ i ] );
				assertFiniteNumber( `track normal z[${ i }]`, normalZ[ i ] );
				nx = normalX[ i ];
				ny = normalY[ i ];
				nz = normalZ[ i ];
				const normalLength = Math.hypot( nx, ny, nz );
				if ( normalLength > EPSILON ) {

					nx /= normalLength;
					ny /= normalLength;
					nz /= normalLength;

				} else { nx = 0; ny = 1; nz = 0; }

			}
			trackNormalX[ i ] = nx;
			trackNormalY[ i ] = ny;
			trackNormalZ[ i ] = nz;
			if ( i > 0 ) {

				const dx = trackX[ i ] - trackX[ i - 1 ];
				const dy = trackY[ i ] - trackY[ i - 1 ];
				const dz = trackZ[ i ] - trackZ[ i - 1 ];
				cumulative[ i ] = cumulative[ i - 1 ] + Math.hypot( dx, dy, dz );

			}

		}
		const length = cumulative[ sampleCount - 1 ];
		if ( length <= EPSILON ) throw new RangeError( 'track must contain a non-zero length segment' );

		this._trackX = trackX;
		this._trackY = trackY;
		this._trackZ = trackZ;
		this._trackNormalX = trackNormalX;
		this._trackNormalY = trackNormalY;
		this._trackNormalZ = trackNormalZ;
		this._trackCumulative = cumulative;
		this._trackCount = sampleCount;
		this.trackLength = length;
		this.routeCompleted = 0;
		this.trackPosition = clamp( this.trackPosition, 0, length );
		this._trackSegment = 0;
		this._sampleTrack( this.trackPosition, this.patrolDirection );
		this._updateMouth();
		this._resetTongueAtMouth();
		this._syncPublicState();
		return this.trackLength;

	}

	setHeading( x, y, z ) {

		assertFiniteNumber( 'heading x', x );
		assertFiniteNumber( 'heading y', y );
		assertFiniteNumber( 'heading z', z );
		const length = Math.hypot( x, y, z );
		if ( length <= EPSILON ) throw new RangeError( 'heading must have non-zero length' );
		this.headingX = x / length;
		this.headingY = y / length;
		this.headingZ = z / length;
		this._updateMouth();
		if ( ! this.tongueVisible ) this._resetTongueAtMouth();
		this._syncPublicState();
		return this._view;

	}

	/**
	 * Lets an external surface planner reject a target that has no physically
	 * reachable corridor. The index guard prevents a stale asynchronous route
	 * result from cancelling a newer prey choice.
	 */
	rejectTarget( index = this.targetIndex ) {

		if ( index !== this.targetIndex || index === NO_TARGET ) return false;
		this._loseTarget( CHAMELEON_STATE.PATROL_LOG );
		this._syncPublicState();
		return true;

	}

	/**
	 * Supplies the authoritative physical pose when externalLocomotion is enabled.
	 * The scalar API and implementation are allocation-free so it can be called
	 * once per frame for every simulated chameleon. The mouth coordinates are an
	 * exact animation/rig socket and are deliberately not reconstructed here.
	 */
	setExternalPose(
		x, y, z,
		headingX, headingY, headingZ,
		upX, upY, upZ,
		mouthX, mouthY, mouthZ,
		routeCompleted = this.routeCompleted,
	) {

		if ( ! this.externalLocomotion ) {

			throw new Error( 'setExternalPose requires externalLocomotion' );

		}
		assertFiniteNumber( 'external pose x', x );
		assertFiniteNumber( 'external pose y', y );
		assertFiniteNumber( 'external pose z', z );
		assertFiniteNumber( 'external heading x', headingX );
		assertFiniteNumber( 'external heading y', headingY );
		assertFiniteNumber( 'external heading z', headingZ );
		assertFiniteNumber( 'external up x', upX );
		assertFiniteNumber( 'external up y', upY );
		assertFiniteNumber( 'external up z', upZ );
		assertFiniteNumber( 'external mouth x', mouthX );
		assertFiniteNumber( 'external mouth y', mouthY );
		assertFiniteNumber( 'external mouth z', mouthZ );

		const headingLength = Math.hypot( headingX, headingY, headingZ );
		if ( headingLength <= EPSILON ) throw new RangeError( 'external heading must have non-zero length' );
		const upLength = Math.hypot( upX, upY, upZ );
		if ( upLength <= EPSILON ) throw new RangeError( 'external up must have non-zero length' );

		if ( this._externalPoseInitialized ) {

			this._externalPendingDistance += Math.hypot(
				x - this.x,
				y - this.y,
				z - this.z,
			);

		} else {

			this._externalPoseInitialized = true;

		}

		this.x = x;
		this.y = y;
		this.z = z;
		this.headingX = headingX / headingLength;
		this.headingY = headingY / headingLength;
		this.headingZ = headingZ / headingLength;
		this.upX = upX / upLength;
		this.upY = upY / upLength;
		this.upZ = upZ / upLength;
		this.mouthX = mouthX;
		this.mouthY = mouthY;
		this.mouthZ = mouthZ;
		this.routeCompleted = routeCompleted ? 1 : 0;
		this._externalPoseDirty = true;
		if ( ! this.tongueVisible ) this._resetTongueAtMouth();
		this._syncPublicState();
		return this._view;

	}

	_consumeExternalPoseTelemetry() {

		const telemetry = this._telemetry;
		telemetry.lastStepDistance = 0;
		if ( ! this._externalPoseDirty ) return;
		const travelled = this._externalPendingDistance;
		this._externalPendingDistance = 0;
		this._externalPoseDirty = false;
		telemetry.distanceTravelled += travelled;
		telemetry.lastStepDistance = travelled;
		if ( travelled > telemetry.maxStepDistance ) telemetry.maxStepDistance = travelled;

	}

	setTrackPosition( distance, headingSign = this.patrolDirection ) {

		assertFiniteNumber( 'track position', distance );
		assertFiniteNumber( 'track heading sign', headingSign );
		this.trackPosition = clamp( distance, 0, this.trackLength );
		this._sampleTrack( this.trackPosition, headingSign );
		if ( this.trackPosition > EPSILON
			&& this.trackPosition < this.trackLength - EPSILON ) this.routeCompleted = 0;
		this._telemetry.lastStepDistance = 0;
		if ( ! this.tongueVisible ) this._resetTongueAtMouth();
		this._syncPublicState();
		return this._view;

	}

	getView() {

		return this._view;

	}

	getViews() {

		return this._view;

	}

	getTelemetry() {

		return this._telemetry;

	}

	_setState( state ) {

		if ( this.state === state ) return;
		this.state = state;
		this.stateTime = 0;
		this._telemetry.stateTransitions ++;

	}

	_resetTongueAtMouth() {

		this.tongueTipX = this.mouthX;
		this.tongueTipY = this.mouthY;
		this.tongueTipZ = this.mouthZ;
		this.tongueVisible = 0;
		this.tongueExtension = 0;
		this._tongueOccluded = 0;

	}

	_updateMouth() {

		// Match the renderer basis exactly: the support normal is made
		// orthogonal to the current heading before applying the authored
		// mouth height. This keeps sweep collision and the animated socket
		// coincident on logs, slopes and rounded descent transitions.
		const projection = this.upX * this.headingX
			+ this.upY * this.headingY + this.upZ * this.headingZ;
		let ux = this.upX - this.headingX * projection;
		let uy = this.upY - this.headingY * projection;
		let uz = this.upZ - this.headingZ * projection;
		const upLength = Math.hypot( ux, uy, uz );
		if ( upLength > EPSILON ) {

			ux /= upLength;
			uy /= upLength;
			uz /= upLength;

		} else { ux = 0; uy = 1; uz = 0; }
		this.mouthX = this.x + this.headingX * this.mouthForward + ux * this.mouthHeight;
		this.mouthY = this.y + this.headingY * this.mouthForward + uy * this.mouthHeight;
		this.mouthZ = this.z + this.headingZ * this.mouthForward + uz * this.mouthHeight;

	}

	_sampleTrack( distance, headingSign ) {

		let segment = this._trackSegment;
		const lastSegment = this._trackCount - 2;
		if ( segment > lastSegment ) segment = lastSegment;
		while ( segment > 0 && distance < this._trackCumulative[ segment ] ) segment --;
		while ( segment < lastSegment && distance > this._trackCumulative[ segment + 1 ] ) segment ++;
		while (
			segment < lastSegment
			&& this._trackCumulative[ segment + 1 ] - this._trackCumulative[ segment ] <= EPSILON
		) segment ++;

		const startDistance = this._trackCumulative[ segment ];
		const segmentLength = this._trackCumulative[ segment + 1 ] - startDistance;
		const alpha = segmentLength <= EPSILON ? 0 : clamp01( ( distance - startDistance ) / segmentLength );
		const dx = this._trackX[ segment + 1 ] - this._trackX[ segment ];
		const dy = this._trackY[ segment + 1 ] - this._trackY[ segment ];
		const dz = this._trackZ[ segment + 1 ] - this._trackZ[ segment ];
		const inverseLength = 1 / Math.max( EPSILON, Math.hypot( dx, dy, dz ) );

		this._trackSegment = segment;
		this.x = this._trackX[ segment ] + dx * alpha;
		this.y = this._trackY[ segment ] + dy * alpha;
		this.z = this._trackZ[ segment ] + dz * alpha;
		const sign = headingSign < 0 ? - 1 : 1;
		this.headingX = dx * inverseLength * sign;
		this.headingY = dy * inverseLength * sign;
		this.headingZ = dz * inverseLength * sign;
		let upX = this._trackNormalX[ segment ]
			+ ( this._trackNormalX[ segment + 1 ] - this._trackNormalX[ segment ] ) * alpha;
		let upY = this._trackNormalY[ segment ]
			+ ( this._trackNormalY[ segment + 1 ] - this._trackNormalY[ segment ] ) * alpha;
		let upZ = this._trackNormalZ[ segment ]
			+ ( this._trackNormalZ[ segment + 1 ] - this._trackNormalZ[ segment ] ) * alpha;
		const upLength = Math.hypot( upX, upY, upZ ) || 1;
		this.upX = upX / upLength;
		this.upY = upY / upLength;
		this.upZ = upZ / upLength;
		this._updateMouth();

	}

	_turnTowardTrack( dt ) {

		const segment = Math.min( this._trackCount - 2, Math.max( 0, this._trackSegment ) );
		const sign = this.patrolDirection < 0 ? - 1 : 1;
		let targetX = ( this._trackX[ segment + 1 ] - this._trackX[ segment ] ) * sign;
		let targetY = ( this._trackY[ segment + 1 ] - this._trackY[ segment ] ) * sign;
		let targetZ = ( this._trackZ[ segment + 1 ] - this._trackZ[ segment ] ) * sign;
		const targetLength = Math.hypot( targetX, targetY, targetZ ) || 1;
		targetX /= targetLength;
		targetY /= targetLength;
		targetZ /= targetLength;
		const blend = clamp01( this.turnSpeed * dt );
		let headingX = this.headingX + ( targetX - this.headingX ) * blend;
		let headingY = this.headingY + ( targetY - this.headingY ) * blend;
		let headingZ = this.headingZ + ( targetZ - this.headingZ ) * blend;
		const headingLength = Math.hypot( headingX, headingY, headingZ ) || 1;
		headingX /= headingLength;
		headingY /= headingLength;
		headingZ /= headingLength;
		this.headingX = headingX;
		this.headingY = headingY;
		this.headingZ = headingZ;
		this._updateMouth();
		return headingX * targetX + headingY * targetY + headingZ * targetZ;

	}

	_moveTowardsTrackPosition( destination, speed, dt ) {

		const beforeX = this.x;
		const beforeY = this.y;
		const beforeZ = this.z;
		const delta = destination - this.trackPosition;
		const maximum = speed * dt;
		let movement = delta;
		if ( movement > maximum ) movement = maximum;
		else if ( movement < - maximum ) movement = - maximum;
		if ( Math.abs( movement ) <= EPSILON ) {

			this._telemetry.lastStepDistance = 0;
			return 0;

		}

		this.trackPosition = clamp( this.trackPosition + movement, 0, this.trackLength );
		if ( this.trackPosition > EPSILON && this.trackPosition < this.trackLength - EPSILON )
			this.routeCompleted = 0;
		this._sampleTrack( this.trackPosition, movement );
		const travelled = Math.hypot( this.x - beforeX, this.y - beforeY, this.z - beforeZ );
		this._telemetry.distanceTravelled += travelled;
		this._telemetry.lastStepDistance = travelled;
		if ( travelled > this._telemetry.maxStepDistance ) this._telemetry.maxStepDistance = travelled;
		return travelled;

	}

	_patrol( dt ) {

		let destination = this.patrolDirection > 0 ? this.trackLength : 0;
		this._moveTowardsTrackPosition( destination, this.patrolSpeed, dt );
		if (
			( this.patrolDirection > 0 && this.trackPosition >= this.trackLength - EPSILON )
			|| ( this.patrolDirection < 0 && this.trackPosition <= EPSILON )
		) {

			this.routeCompleted = 1;
			if ( ! this.holdAtTrackEnd ) {

				this.patrolDirection *= - 1;
				this._telemetry.trackReversals ++;

			}
			this._setState( CHAMELEON_STATE.REST_SCAN );

		}

	}

	_getPreyCount( prey ) {

		if ( ! prey || ! prey.x || ! prey.y || ! prey.z ) return 0;
		let count = Number.isInteger( prey.count ) ? prey.count : 0;
		if ( Number.isInteger( prey.capacity ) ) count = Math.min( count, prey.capacity );
		return Math.max(
			0,
			Math.min( count, this.preyCapacity, prey.x.length, prey.y.length, prey.z.length ),
		);

	}

	_isTargetAvailable( prey, index ) {

		if ( index < 0 || index >= this._getPreyCount( prey ) ) return false;
		if ( prey.active && ! prey.active[ index ] ) return false;
		if ( prey.visible && ! prey.visible[ index ] ) return false;
		if ( prey.captured && prey.captured[ index ] ) return false;
		return Number.isFinite( prey.x[ index ] )
			&& Number.isFinite( prey.y[ index ] )
			&& Number.isFinite( prey.z[ index ] );

	}

	_distanceSqToPrey( prey, index ) {

		const dx = prey.x[ index ] - this.mouthX;
		const dy = prey.y[ index ] - this.mouthY;
		const dz = prey.z[ index ] - this.mouthZ;
		return dx * dx + dy * dy + dz * dz;

	}

	_hasLineOfSight( prey, index ) {

		if ( typeof prey?.hasLineOfSight !== 'function' ) return true;
		return prey.hasLineOfSight(
			index,
			this.mouthX, this.mouthY, this.mouthZ,
			prey.x[ index ], prey.y[ index ], prey.z[ index ],
		) !== false;

	}

	_scanForTarget( prey ) {

		this._telemetry.scans ++;
		const count = this._getPreyCount( prey );
		const radiusSq = this.detectionDistance * this.detectionDistance;
		let bestIndex = NO_TARGET;
		let bestDistanceSq = radiusSq;
		for ( let i = 0; i < count; i ++ ) {

			this._telemetry.targetChecks ++;
			if ( ! this._isTargetAvailable( prey, i ) ) continue;
			const distanceSq = this._distanceSqToPrey( prey, i );
			if ( distanceSq <= bestDistanceSq && ! this._hasLineOfSight( prey, i ) ) continue;
			if ( distanceSq <= bestDistanceSq ) {

				if ( distanceSq < bestDistanceSq || bestIndex === NO_TARGET || i < bestIndex ) {

					bestDistanceSq = distanceSq;
					bestIndex = i;

				}

			}

		}
		if ( bestIndex !== NO_TARGET ) {

			this.targetIndex = bestIndex;
			this._telemetry.targetsAcquired ++;
			this._setState( CHAMELEON_STATE.TRACK_PREY );

		}

	}

	_maybeScan( dt, prey ) {

		this._scanCountdown -= dt;
		if ( this._scanCountdown > 0 ) return;
		this._scanCountdown += this.scanInterval;
		if ( this._scanCountdown <= 0 ) this._scanCountdown = this.scanInterval;
		this._scanForTarget( prey );

	}

	_loseTarget( nextState = CHAMELEON_STATE.REST_SCAN ) {

		if ( this.targetIndex !== NO_TARGET ) this._telemetry.targetsLost ++;
		this.targetIndex = NO_TARGET;
		this._scanCountdown = 0;
		this._setState( nextState );

	}

	_projectPreyToTrack( prey, index ) {

		const px = prey.x[ index ];
		const py = prey.y[ index ];
		const pz = prey.z[ index ];
		let bestDistanceSq = Infinity;
		let bestTrackPosition = this.trackPosition;
		for ( let i = 0; i < this._trackCount - 1; i ++ ) {

			const ax = this._trackX[ i ];
			const ay = this._trackY[ i ];
			const az = this._trackZ[ i ];
			const dx = this._trackX[ i + 1 ] - ax;
			const dy = this._trackY[ i + 1 ] - ay;
			const dz = this._trackZ[ i + 1 ] - az;
			const lengthSq = dx * dx + dy * dy + dz * dz;
			if ( lengthSq <= EPSILON ) continue;
			const t = clamp01( ( ( px - ax ) * dx + ( py - ay ) * dy + ( pz - az ) * dz ) / lengthSq );
			const qx = ax + dx * t;
			const qy = ay + dy * t;
			const qz = az + dz * t;
			const ex = px - qx;
			const ey = py - qy;
			const ez = pz - qz;
			const distanceSq = ex * ex + ey * ey + ez * ez;
			if ( distanceSq < bestDistanceSq ) {

				bestDistanceSq = distanceSq;
				bestTrackPosition = this._trackCumulative[ i ] + Math.sqrt( lengthSq ) * t;

			}

		}
		this._projectedTrackPosition = bestTrackPosition;
		this._projectedDistanceSq = bestDistanceSq;

	}

	_updateAimPoint( prey, index, dt = 0 ) {

		this.aimX = prey.x[ index ];
		this.aimY = prey.y[ index ];
		this.aimZ = prey.z[ index ];
		if ( this.externalLocomotion ) return;
		const dx = this.aimX - this.x;
		const dz = this.aimZ - this.z;
		const length = Math.hypot( dx, dz );
		if ( length > EPSILON ) {

			const blend = clamp01( this.turnSpeed * dt );
			let hx = this.headingX + ( dx / length - this.headingX ) * blend;
			let hy = this.headingY * ( 1 - blend );
			let hz = this.headingZ + ( dz / length - this.headingZ ) * blend;
			const headingLength = Math.hypot( hx, hy, hz );
			if ( headingLength > EPSILON ) {

				hx /= headingLength;
				hy /= headingLength;
				hz /= headingLength;
				this.headingX = hx;
				this.headingY = hy;
				this.headingZ = hz;
				this._updateMouth();

			}

		}

	}

	_releaseStrike( prey, index ) {

		let strikeX = prey.x[ index ];
		let strikeY = prey.y[ index ];
		let strikeZ = prey.z[ index ];
		if ( prey.headingX && prey.headingY && prey.headingZ ) {

			let hx = finiteOr( prey.headingX[ index ], 0 );
			let hy = finiteOr( prey.headingY[ index ], 0 );
			let hz = finiteOr( prey.headingZ[ index ], 0 );
			const headingLength = Math.hypot( hx, hy, hz );
			if ( headingLength > EPSILON ) {

				hx /= headingLength;
				hy /= headingLength;
				hz /= headingLength;
				let speed = this.predictionSpeed;
				if ( prey.speed ) speed = Math.max( 0, finiteOr( prey.speed[ index ], speed ) );
				const lead = speed * this.predictionTime;
				strikeX += hx * lead;
				strikeY += hy * lead;
				strikeZ += hz * lead;

			}

		}

		let dx = strikeX - this.mouthX;
		let dy = strikeY - this.mouthY;
		let dz = strikeZ - this.mouthZ;
		const distance = Math.hypot( dx, dy, dz );
		if ( distance > this.maxTongueLength ) {

			const scale = this.maxTongueLength / distance;
			dx *= scale;
			dy *= scale;
			dz *= scale;
			strikeX = this.mouthX + dx;
			strikeY = this.mouthY + dy;
			strikeZ = this.mouthZ + dz;

		}
		this.strikeX = strikeX;
		this.strikeY = strikeY;
		this.strikeZ = strikeZ;
		this.tongueTipX = this.mouthX;
		this.tongueTipY = this.mouthY;
		this.tongueTipZ = this.mouthZ;
		this.tongueVisible = 1;
		this.tongueExtension = 0;
		this._tongueOccluded = 0;
		this.attackClipPhase = 0.395;
		this._telemetry.attacksReleased ++;
		this._setState( CHAMELEON_STATE.STRIKE_EXTEND );

	}

	_sweepTongueAgainstTarget( prey, index, startX, startY, startZ, endX, endY, endZ ) {

		if ( ! this._isTargetAvailable( prey, index ) ) return - 1;
		const centerX = prey.x[ index ];
		const centerY = prey.y[ index ];
		const centerZ = prey.z[ index ];
		const dx = endX - startX;
		const dy = endY - startY;
		const dz = endZ - startZ;
		const mx = startX - centerX;
		const my = startY - centerY;
		const mz = startZ - centerZ;
		const radius = this.preyRadius + this.tongueRadius;
		const c = mx * mx + my * my + mz * mz - radius * radius;
		let hit = c <= 0 ? 0 : - 1;
		const a = dx * dx + dy * dy + dz * dz;
		if ( hit < 0 && a > EPSILON ) {

			const b = mx * dx + my * dy + mz * dz;
			const discriminant = b * b - a * c;
			if ( b <= 0 && discriminant >= 0 ) {

				const candidate = ( - b - Math.sqrt( discriminant ) ) / a;
				if ( candidate >= 0 && candidate <= 1 ) hit = candidate;

			}

		}
		// Check every travelled segment, not only a segment that already reaches
		// the prey. Otherwise a fast tongue could cross a wall one substep, then
		// start inside the prey sphere on the next one and bypass occlusion.
		const clearance = hit >= 0 ? hit : 1;
		if ( typeof prey?.isTongueSegmentClear === 'function'
			&& prey.isTongueSegmentClear(
				index,
				startX, startY, startZ,
				startX + dx * clearance,
				startY + dy * clearance,
				startZ + dz * clearance,
			) === false ) {

			this._tongueOccluded = 1;
			return - 1;

		}
		return hit;

	}

	_attemptContact( prey, startX, startY, startZ, endX, endY, endZ ) {

		if ( this._tongueOccluded ) return - 1;
		const index = this.targetIndex;
		const hit = this._sweepTongueAgainstTarget(
			prey,
			index,
			startX,
			startY,
			startZ,
			endX,
			endY,
			endZ,
		);
		if ( hit < 0 ) return this._tongueOccluded ? - 1 : 0;
		if ( typeof prey.tryCapture === 'function' && prey.tryCapture( index ) === false ) {

			this._telemetry.captureRejected ++;
			this.targetIndex = NO_TARGET;
			return 0;

		}

		this.tongueTipX = startX + ( endX - startX ) * hit;
		this.tongueTipY = startY + ( endY - startY ) * hit;
		this.tongueTipZ = startZ + ( endZ - startZ ) * hit;
		this._contactTipX = this.tongueTipX;
		this._contactTipY = this.tongueTipY;
		this._contactTipZ = this.tongueTipZ;
		this._captureOffsetX = prey.x[ index ] - this.tongueTipX;
		this._captureOffsetY = prey.y[ index ] - this.tongueTipY;
		this._captureOffsetZ = prey.z[ index ] - this.tongueTipZ;
		this.capturedIndex = index;
		this._captureContext = prey;
		this._telemetry.contacts ++;
		this._telemetry.captures ++;
		this.attackClipPhase = 0.43;
		this._placeCapturedPrey();
		this._setState( CHAMELEON_STATE.CONTACT );
		return 1;

	}

	_placeCapturedPrey() {

		if ( this.capturedIndex === NO_TARGET || ! this._captureContext ) return;
		const preyX = this.tongueTipX + this._captureOffsetX;
		const preyY = this.tongueTipY + this._captureOffsetY;
		const preyZ = this.tongueTipZ + this._captureOffsetZ;
		if ( typeof this._captureContext.setCapturedPosition === 'function' ) {

			this._captureContext.setCapturedPosition( this.capturedIndex, preyX, preyY, preyZ );

		}

	}

	_consumeCapturedPrey() {

		if ( this.capturedIndex === NO_TARGET ) return;
		let accepted = true;
		if ( this._captureContext && typeof this._captureContext.consume === 'function' ) {

			accepted = this._captureContext.consume( this.capturedIndex ) !== false;

		}
		if ( accepted ) this._telemetry.consumed ++;
		else {

			this._telemetry.consumeRejected ++;
			this._captureContext?.releaseCapture?.( this.capturedIndex );

		}
		this.capturedIndex = NO_TARGET;
		this.targetIndex = NO_TARGET;
		this._captureContext = null;
		this._resetTongueAtMouth();
		this.attackClipPhase = 0.651;
		this._setState( CHAMELEON_STATE.BITE_AND_SWALLOW );

	}

	_updateTongueExtension() {

		const dx = this.tongueTipX - this.mouthX;
		const dy = this.tongueTipY - this.mouthY;
		const dz = this.tongueTipZ - this.mouthZ;
		this.tongueExtension = clamp01( Math.hypot( dx, dy, dz ) / this.maxTongueLength );

	}

	_integrate( dt, prey ) {

		this.stateTime += dt;
		if ( ! this.externalLocomotion ) this._telemetry.lastStepDistance = 0;

		switch ( this.state ) {

			case CHAMELEON_STATE.REST_SCAN: {
				this.attackClipPhase = 0;
				const trackAlignment = this.externalLocomotion ? 1 : this._turnTowardTrack( dt );
				this._maybeScan( dt, prey );
				if (
					this.state === CHAMELEON_STATE.REST_SCAN
					&& this.stateTime >= this.restScanDuration
					&& trackAlignment >= 0.995
				) {

					this.routeCompleted = 0;
					this._setState( CHAMELEON_STATE.PATROL_LOG );

				}
				break;
			}
				break;

			case CHAMELEON_STATE.PATROL_LOG:
				this.attackClipPhase = 0;
				if ( this.externalLocomotion ) {

					if ( this.routeCompleted ) this._setState( CHAMELEON_STATE.REST_SCAN );

				} else this._patrol( dt );
				this._maybeScan( dt, prey );
				break;

			case CHAMELEON_STATE.TRACK_PREY: {
				const index = this.targetIndex;
				if ( ! this._isTargetAvailable( prey, index ) ) {

					this._loseTarget();
					break;

				}
				if ( ! this._hasLineOfSight( prey, index ) ) {

					this._loseTarget( CHAMELEON_STATE.PATROL_LOG );
					break;

				}
				if ( this._distanceSqToPrey( prey, index ) > this.detectionDistance * this.detectionDistance ) {

					this._loseTarget( CHAMELEON_STATE.PATROL_LOG );
					break;

				}
				if ( ! this.externalLocomotion ) {

					this._projectPreyToTrack( prey, index );
					this._moveTowardsTrackPosition( this._projectedTrackPosition, this.trackingSpeed, dt );

				}
				if ( this._distanceSqToPrey( prey, index ) <= this.attackDistance * this.attackDistance ) {

					this._updateAimPoint( prey, index, dt );
					this.attackClipPhase = 0;
					this._setState( CHAMELEON_STATE.AIM_AND_BRACE );

				}
				break;
			}

			case CHAMELEON_STATE.AIM_AND_BRACE: {
				const index = this.targetIndex;
				if ( ! this._isTargetAvailable( prey, index ) ) {

					this._loseTarget();
					break;

				}
				if ( ! this._hasLineOfSight( prey, index ) ) {

					this._loseTarget( CHAMELEON_STATE.PATROL_LOG );
					break;

				}
				if ( this._distanceSqToPrey( prey, index ) > this.attackDistance * this.attackDistance ) {

					this._setState( CHAMELEON_STATE.TRACK_PREY );
					break;

				}
				this._updateAimPoint( prey, index, dt );
				this.attackClipPhase = 0.395 * clamp01( this.stateTime / this.aimDuration );
				if ( this.stateTime >= this.aimDuration ) this._releaseStrike( prey, index );
				break;
			}

			case CHAMELEON_STATE.STRIKE_EXTEND: {
				const previousX = this.tongueTipX;
				const previousY = this.tongueTipY;
				const previousZ = this.tongueTipZ;
				if ( this.stateTime <= this.extendDuration ) {

					const progress = smoothstep01( this.stateTime / this.extendDuration );
					const endX = this.mouthX + ( this.strikeX - this.mouthX ) * progress;
					const endY = this.mouthY + ( this.strikeY - this.mouthY ) * progress;
					const endZ = this.mouthZ + ( this.strikeZ - this.mouthZ ) * progress;
					const contact = this._attemptContact(
						prey, previousX, previousY, previousZ, endX, endY, endZ,
					);
					if ( contact === 0 ) {

						this.tongueTipX = endX;
						this.tongueTipY = endY;
						this.tongueTipZ = endZ;
						this._updateTongueExtension();
						this.attackClipPhase = 0.395 + progress * 0.035;


					} else if ( contact < 0 ) {

						// Stop at the last clear point and enter the ordinary miss
						// retraction. The visual tongue never continues through the
						// collider that invalidated the physical strike.
						this.strikeX = previousX;
						this.strikeY = previousY;
						this.strikeZ = previousZ;
						this.tongueTipX = previousX;
						this.tongueTipY = previousY;
						this.tongueTipZ = previousZ;
						this.stateTime = this.extendDuration;
						this._updateTongueExtension();

					}

				} else {

					const retract = smoothstep01(
						( this.stateTime - this.extendDuration ) / this.missRetractDuration,
					);
					this.tongueTipX = this.strikeX + ( this.mouthX - this.strikeX ) * retract;
					this.tongueTipY = this.strikeY + ( this.mouthY - this.strikeY ) * retract;
					this.tongueTipZ = this.strikeZ + ( this.mouthZ - this.strikeZ ) * retract;
					this._updateTongueExtension();
					this.attackClipPhase = 0.43 + retract * 0.57;
					if ( retract >= 1 ) {

						this._telemetry.misses ++;
						this.targetIndex = NO_TARGET;
						this._resetTongueAtMouth();
						this._setState( CHAMELEON_STATE.COOLDOWN );

					}

				}
				break;
			}

			case CHAMELEON_STATE.CONTACT:
				this.tongueTipX = this._contactTipX;
				this.tongueTipY = this._contactTipY;
				this.tongueTipZ = this._contactTipZ;
				this._updateTongueExtension();
				this._placeCapturedPrey();
				this.attackClipPhase = 0.43;
				if ( this.stateTime >= this.contactDuration ) {

					this._setState( CHAMELEON_STATE.RETRACT_WITH_PREY );

				}
				break;

			case CHAMELEON_STATE.RETRACT_WITH_PREY: {
				const progress = smoothstep01( this.stateTime / this.retractDuration );
				const finalTipX = this.mouthX - this._captureOffsetX;
				const finalTipY = this.mouthY - this._captureOffsetY;
				const finalTipZ = this.mouthZ - this._captureOffsetZ;
				this.tongueTipX = this._contactTipX + ( finalTipX - this._contactTipX ) * progress;
				this.tongueTipY = this._contactTipY + ( finalTipY - this._contactTipY ) * progress;
				this.tongueTipZ = this._contactTipZ + ( finalTipZ - this._contactTipZ ) * progress;
				this._updateTongueExtension();
				this._placeCapturedPrey();
				this.attackClipPhase = 0.43 + progress * 0.221;
				const preyX = this.tongueTipX + this._captureOffsetX;
				const preyY = this.tongueTipY + this._captureOffsetY;
				const preyZ = this.tongueTipZ + this._captureOffsetZ;
				const dx = preyX - this.mouthX;
				const dy = preyY - this.mouthY;
				const dz = preyZ - this.mouthZ;
				if (
					dx * dx + dy * dy + dz * dz <= this.mouthConsumeRadius * this.mouthConsumeRadius
					|| progress >= 1
				) this._consumeCapturedPrey();
				break;
			}

			case CHAMELEON_STATE.BITE_AND_SWALLOW:
				this.attackClipPhase = 0.651 + 0.349 * clamp01( this.stateTime / this.biteDuration );
				if ( this.stateTime >= this.biteDuration ) {

					this.attackClipPhase = 1;
					this._setState( CHAMELEON_STATE.COOLDOWN );

				}
				break;

			case CHAMELEON_STATE.COOLDOWN:
				this.attackClipPhase = 1;
				if ( this.stateTime >= this.cooldownDuration ) {

					this.attackClipPhase = 0;
					this._scanCountdown = 0;
					this._setState( CHAMELEON_STATE.REST_SCAN );

				}
				break;

		}

	}

	_syncPublicState() {

		const view = this._view;
		view.x = this.x;
		view.y = this.y;
		view.z = this.z;
		view.headingX = this.headingX;
		view.headingY = this.headingY;
		view.headingZ = this.headingZ;
		view.upX = this.upX;
		view.upY = this.upY;
		view.upZ = this.upZ;
		view.state = this.state;
		view.stateName = CHAMELEON_STATE_NAMES[ this.state ];
		view.stateTime = this.stateTime;
		view.targetIndex = this.targetIndex;
		view.capturedIndex = this.capturedIndex;
		view.mouthX = this.mouthX;
		view.mouthY = this.mouthY;
		view.mouthZ = this.mouthZ;
		view.tongueTipX = this.tongueTipX;
		view.tongueTipY = this.tongueTipY;
		view.tongueTipZ = this.tongueTipZ;
		view.tongueVisible = this.tongueVisible;
		view.tongueExtension = this.tongueExtension;
		view.attackClipPhase = this.attackClipPhase;
		view.aimX = this.aimX;
		view.aimY = this.aimY;
		view.aimZ = this.aimZ;
		view.strikeX = this.strikeX;
		view.strikeY = this.strikeY;
		view.strikeZ = this.strikeZ;
		view.trackPosition = this.trackPosition;
		view.trackLength = this.trackLength;
		view.routeCompleted = this.routeCompleted;

		const telemetry = this._telemetry;
		telemetry.time = this.time;
		telemetry.state = this.state;
		telemetry.targetIndex = this.targetIndex;

	}

	update( dt, context = EMPTY_PREY_CONTEXT ) {

		if ( ! Number.isFinite( dt ) || dt < 0 ) throw new RangeError( 'dt must be a finite non-negative number' );
		const prey = context && context.prey ? context.prey : context;
		this._telemetry.updateCalls ++;
		if ( this.externalLocomotion ) this._consumeExternalPoseTelemetry();
		if ( dt <= 0 ) {

			this._syncPublicState();
			return this._view;

		}

		const requestedSteps = Math.max( 1, Math.ceil( dt / this.maxIntegrationStep ) );
		const steps = Math.min( requestedSteps, this.maxIntegrationSteps );
		const processedTime = Math.min( dt, steps * this.maxIntegrationStep );
		const step = processedTime / steps;
		if ( processedTime < dt ) this._telemetry.droppedTime += dt - processedTime;
		for ( let i = 0; i < steps; i ++ ) {

			this._integrate( step, prey || EMPTY_PREY_CONTEXT );

		}
		this.time += processedTime;
		this._telemetry.integrationSteps += steps;
		this._syncPublicState();
		return this._view;

	}

}

export function createChameleonSimulation( options ) {

	return new ChameleonSimulation( options );

}
