/**
 * Renderer-independent procedural locomotion for the chameleon.
 *
 * The gait consumes four surface contacts prepared by the world collider. It
 * deliberately does not raycast and does not depend on Three.js: the renderer
 * may therefore keep all geometry/BVH concerns outside of the fixed-step hot
 * path. Every mutable buffer is allocated in the constructor and keeps a
 * stable identity for the lifetime of the gait.
 *
 * Foot order:
 *   0 front-left, 1 front-right, 2 hind-left, 3 hind-right.
 *
 * update(dt, input) expects:
 * {
 *   contactPositions: packed xyz Float32Array(12),
 *   contactNormals:   packed xyz Float32Array(12),
 *   speed?: number,
 *   velocityX?: number, velocityY?: number, velocityZ?: number,
 *   forwardX?: number, forwardY?: number, forwardZ?: number
 * }
 *
 * contactPositions/contactNormals are landing candidates projected onto the
 * real world surface by the caller. Stance feet remain locked in world space;
 * candidates are copied only when their diagonal pair starts a swing.
 */

export const CHAMELEON_FOOT_COUNT = 4;
export const CHAMELEON_FOOT_COMPONENTS = CHAMELEON_FOOT_COUNT * 3;
export const TWO_BONE_IK_RESULT_SIZE = 12;

export const CHAMELEON_FOOT = Object.freeze( {
	FRONT_LEFT: 0,
	FRONT_RIGHT: 1,
	HIND_LEFT: 2,
	HIND_RIGHT: 3,
} );

const EPSILON = 1e-8;
const PAIR_A_0 = CHAMELEON_FOOT.FRONT_LEFT;
const PAIR_A_1 = CHAMELEON_FOOT.HIND_RIGHT;
const PAIR_B_0 = CHAMELEON_FOOT.FRONT_RIGHT;
const PAIR_B_1 = CHAMELEON_FOOT.HIND_LEFT;
const FRONT_SWING_CLEARANCE = 1.40;
const HIND_SWING_CLEARANCE = 1.14;

function clamp( value, minimum, maximum ) {

	return value <= minimum ? minimum : value >= maximum ? maximum : value;

}

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function smootherstep01( value ) {

	const t = clamp( finiteOr( value, 0 ), 0, 1 );
	return t * t * t * ( t * ( t * 6 - 15 ) + 10 );

}

/**
 * C2 longitudinal stroke used by a swinging claw.
 *
 * The first part of the swing is deliberately reserved for toe-off: the limb
 * folds and clears the support before it starts travelling forwards. The last
 * part is similarly reserved for a quiet, almost vertical placement. Besides
 * looking more deliberate, this prevents a claw from scraping convex terrain
 * while the root is moving.
 */
export function swingAdvanceEnvelope( phase ) {

	const p = clamp( finiteOr( phase, 0 ), 0, 1 );
	return smootherstep01( ( p - 0.10 ) / 0.76 );

}

/**
 * C2 swing clearance with a quick toe-off and a deliberately softer landing.
 * Unlike the former quartic arch, the foot spends the useful middle portion
 * of the stride at full clearance instead of grazing the surface.
 */
export function swingClearanceEnvelope( phase ) {

	const p = clamp( finiteOr( phase, 0 ), 0, 1 );
	return Math.min(
		smootherstep01( p / 0.18 ),
		smootherstep01( ( 1 - p ) / 0.26 ),
	);

}

function normalizePackedVector( target, offset, fallbackX, fallbackY, fallbackZ ) {

	let x = target[ offset ];
	let y = target[ offset + 1 ];
	let z = target[ offset + 2 ];
	let inverseLength = 1 / Math.hypot( x, y, z );
	if ( ! Number.isFinite( inverseLength ) ) {

		x = fallbackX;
		y = fallbackY;
		z = fallbackZ;
		inverseLength = 1 / ( Math.hypot( x, y, z ) || 1 );

	}
	target[ offset ] = x * inverseLength;
	target[ offset + 1 ] = y * inverseLength;
	target[ offset + 2 ] = z * inverseLength;

}

function copyPackedContact( destination, destinationOffset, source, sourceOffset ) {

	destination[ destinationOffset ] = finiteOr( source?.[ sourceOffset ], 0 );
	destination[ destinationOffset + 1 ] = finiteOr( source?.[ sourceOffset + 1 ], 0 );
	destination[ destinationOffset + 2 ] = finiteOr( source?.[ sourceOffset + 2 ], 0 );

}

/**
 * Analytic two-bone IK with a pole and optional bend limits.
 *
 * No object is returned or created. `out` is provided by the caller:
 *   [0..2] hip/root, [3..5] knee, [6..8] reachable foot,
 *   [9] bend angle (0 = straight), [10] requested distance,
 *   [11] solved distance.
 *
 * A reachable target is reproduced exactly. An unreachable or bend-limited
 * target is clamped to the nearest valid point on the root-target ray.
 */
export function solveTwoBoneIK(
	rootX,
	rootY,
	rootZ,
	targetX,
	targetY,
	targetZ,
	poleX,
	poleY,
	poleZ,
	upperLength,
	lowerLength,
	out,
	offset = 0,
	minBend = 0,
	maxBend = Math.PI - 1e-5,
) {

	if ( ! out || out.length < offset + TWO_BONE_IK_RESULT_SIZE ) {

		throw new RangeError( 'the caller-provided IK result buffer is too small' );

	}

	const upper = Math.max( 1e-6, finiteOr( upperLength, 1 ) );
	const lower = Math.max( 1e-6, finiteOr( lowerLength, 1 ) );
	const minimumBend = clamp( finiteOr( minBend, 0 ), 0, Math.PI - 1e-5 );
	const maximumBend = clamp(
		finiteOr( maxBend, Math.PI - 1e-5 ),
		minimumBend,
		Math.PI - 1e-5,
	);

	let directionX = finiteOr( targetX, rootX ) - rootX;
	let directionY = finiteOr( targetY, rootY ) - rootY;
	let directionZ = finiteOr( targetZ, rootZ ) - rootZ;
	const requestedDistance = Math.hypot( directionX, directionY, directionZ );

	if ( requestedDistance > EPSILON ) {

		const inverseDistance = 1 / requestedDistance;
		directionX *= inverseDistance;
		directionY *= inverseDistance;
		directionZ *= inverseDistance;

	} else {

		directionX = finiteOr( poleX, rootX + 1 ) - rootX;
		directionY = finiteOr( poleY, rootY ) - rootY;
		directionZ = finiteOr( poleZ, rootZ ) - rootZ;
		const inversePoleLength = 1 / Math.hypot( directionX, directionY, directionZ );
		if ( Number.isFinite( inversePoleLength ) ) {

			directionX *= inversePoleLength;
			directionY *= inversePoleLength;
			directionZ *= inversePoleLength;

		} else {

			directionX = 1;
			directionY = 0;
			directionZ = 0;

		}

	}

	const minimumDistance = Math.max( Math.abs( upper - lower ) + 1e-6, 1e-6 );
	const maximumDistance = Math.max( minimumDistance, upper + lower - 1e-6 );
	let solvedDistance = clamp( requestedDistance, minimumDistance, maximumDistance );

	let bendCosine = clamp(
		( solvedDistance * solvedDistance - upper * upper - lower * lower ) /
			( 2 * upper * lower ),
		- 1,
		1,
	);
	let bendAngle = Math.acos( bendCosine );
	const limitedBend = clamp( bendAngle, minimumBend, maximumBend );
	if ( Math.abs( limitedBend - bendAngle ) > 1e-12 ) {

		bendAngle = limitedBend;
		solvedDistance = Math.sqrt( Math.max(
			minimumDistance * minimumDistance,
			upper * upper + lower * lower + 2 * upper * lower * Math.cos( bendAngle ),
		) );

	} else {

		bendAngle = limitedBend;

	}

	let bendX = finiteOr( poleX, rootX ) - rootX;
	let bendY = finiteOr( poleY, rootY + 1 ) - rootY;
	let bendZ = finiteOr( poleZ, rootZ ) - rootZ;
	const poleAlongDirection = (
		bendX * directionX +
		bendY * directionY +
		bendZ * directionZ
	);
	bendX -= directionX * poleAlongDirection;
	bendY -= directionY * poleAlongDirection;
	bendZ -= directionZ * poleAlongDirection;
	let inverseBendLength = 1 / Math.hypot( bendX, bendY, bendZ );

	if ( ! Number.isFinite( inverseBendLength ) ) {

		// Pick the cardinal axis least parallel to the target direction, then
		// project it onto the bend plane. This is deterministic at singularities.
		if ( Math.abs( directionX ) <= Math.abs( directionY ) &&
			Math.abs( directionX ) <= Math.abs( directionZ ) ) {

			bendX = 1;
			bendY = 0;
			bendZ = 0;

		} else if ( Math.abs( directionY ) <= Math.abs( directionZ ) ) {

			bendX = 0;
			bendY = 1;
			bendZ = 0;

		} else {

			bendX = 0;
			bendY = 0;
			bendZ = 1;

		}
		const axisAlongDirection = (
			bendX * directionX +
			bendY * directionY +
			bendZ * directionZ
		);
		bendX -= directionX * axisAlongDirection;
		bendY -= directionY * axisAlongDirection;
		bendZ -= directionZ * axisAlongDirection;
		inverseBendLength = 1 / ( Math.hypot( bendX, bendY, bendZ ) || 1 );

	}
	bendX *= inverseBendLength;
	bendY *= inverseBendLength;
	bendZ *= inverseBendLength;

	const kneeAlong = (
		upper * upper - lower * lower + solvedDistance * solvedDistance
	) / ( 2 * solvedDistance );
	const kneeHeight = Math.sqrt( Math.max(
		0,
		upper * upper - kneeAlong * kneeAlong,
	) );
	const solvedFootX = rootX + directionX * solvedDistance;
	const solvedFootY = rootY + directionY * solvedDistance;
	const solvedFootZ = rootZ + directionZ * solvedDistance;

	out[ offset ] = rootX;
	out[ offset + 1 ] = rootY;
	out[ offset + 2 ] = rootZ;
	out[ offset + 3 ] = rootX + directionX * kneeAlong + bendX * kneeHeight;
	out[ offset + 4 ] = rootY + directionY * kneeAlong + bendY * kneeHeight;
	out[ offset + 5 ] = rootZ + directionZ * kneeAlong + bendZ * kneeHeight;
	out[ offset + 6 ] = solvedFootX;
	out[ offset + 7 ] = solvedFootY;
	out[ offset + 8 ] = solvedFootZ;
	out[ offset + 9 ] = bendAngle;
	out[ offset + 10 ] = requestedDistance;
	out[ offset + 11 ] = solvedDistance;
	return out;

}

export class ChameleonProceduralGait {

	constructor( {
		fixedStep = 1 / 120,
		maxSubsteps = 16,
		stepDistance = 0.2,
		stepHeight = 0.09,
		minSwingDuration = 0.09,
		maxSwingDuration = 0.34,
		swingDuty = 0.72,
		stopSpeed = 0.01,
		minTargetError = 0.015,
		bodyClearance = 0.12,
	} = {} ) {

		if ( ! Number.isInteger( maxSubsteps ) || maxSubsteps <= 0 ) {

			throw new RangeError( 'maxSubsteps must be a positive integer' );

		}
		this.fixedStep = Math.max( 1 / 1000, finiteOr( fixedStep, 1 / 120 ) );
		this.maxSubsteps = maxSubsteps;
		this.stepDistance = Math.max( 0.001, finiteOr( stepDistance, 0.2 ) );
		this.stepHeight = Math.max( 0, finiteOr( stepHeight, 0.09 ) );
		this.minSwingDuration = Math.max( this.fixedStep, finiteOr( minSwingDuration, 0.09 ) );
		this.maxSwingDuration = Math.max(
			this.minSwingDuration,
			finiteOr( maxSwingDuration, 0.34 ),
		);
		this.swingDuty = Math.max( 0.05, finiteOr( swingDuty, 0.72 ) );
		this.stopSpeed = Math.max( 0, finiteOr( stopSpeed, 0.01 ) );
		this.minTargetError = Math.max( 0, finiteOr( minTargetError, 0.015 ) );
		this.bodyClearance = Math.max( 0, finiteOr( bodyClearance, 0.12 ) );

		this.footPositions = new Float32Array( CHAMELEON_FOOT_COMPONENTS );
		this.footNormals = new Float32Array( CHAMELEON_FOOT_COMPONENTS );
		this.footStartPositions = new Float32Array( CHAMELEON_FOOT_COMPONENTS );
		this.footStartNormals = new Float32Array( CHAMELEON_FOOT_COMPONENTS );
		this.footTargetPositions = new Float32Array( CHAMELEON_FOOT_COMPONENTS );
		this.footTargetNormals = new Float32Array( CHAMELEON_FOOT_COMPONENTS );
		this.footPhase = new Float32Array( CHAMELEON_FOOT_COUNT );
		this.footSwinging = new Uint8Array( CHAMELEON_FOOT_COUNT );
		this.bodyPosition = new Float32Array( 3 );
		this.bodyForward = new Float32Array( [ 1, 0, 0 ] );
		this.bodyUp = new Float32Array( [ 0, 1, 0 ] );
		this.bodyRight = new Float32Array( [ 0, 0, 1 ] );

		this._accumulator = 0;
		this._distanceSinceStep = 0;
		this._swingDuration = this.minSwingDuration;
		this._activePair = - 1;
		this._nextPair = 0;
		this._settlingAfterDrive = false;
		this._settlementPairsRemaining = 0;
		this._initialized = false;

		this._telemetry = Object.seal( {
			updateCalls: 0,
			integrationSteps: 0,
			stepsStarted: 0,
			stepsCompleted: 0,
			droppedTime: 0,
			distanceDriven: 0,
		} );
		this._view = Object.seal( {
			footPositions: this.footPositions,
			footNormals: this.footNormals,
			footStartPositions: this.footStartPositions,
			footTargetPositions: this.footTargetPositions,
			footPhase: this.footPhase,
			footSwinging: this.footSwinging,
			bodyPosition: this.bodyPosition,
			bodyForward: this.bodyForward,
			bodyUp: this.bodyUp,
			bodyRight: this.bodyRight,
			activePair: - 1,
			nextPair: 0,
			distanceSinceStep: 0,
		} );

	}

	reset( input ) {

		const positions = input?.contactPositions;
		const normals = input?.contactNormals;
		for ( let foot = 0; foot < CHAMELEON_FOOT_COUNT; foot ++ ) {

			const offset = foot * 3;
			copyPackedContact( this.footPositions, offset, positions, offset );
			if ( normals ) {

				copyPackedContact( this.footNormals, offset, normals, offset );

			} else {

				this.footNormals[ offset ] = 0;
				this.footNormals[ offset + 1 ] = 1;
				this.footNormals[ offset + 2 ] = 0;

			}
			normalizePackedVector( this.footNormals, offset, 0, 1, 0 );
			copyPackedContact( this.footStartPositions, offset, this.footPositions, offset );
			copyPackedContact( this.footTargetPositions, offset, this.footPositions, offset );
			copyPackedContact( this.footStartNormals, offset, this.footNormals, offset );
			copyPackedContact( this.footTargetNormals, offset, this.footNormals, offset );
			this.footPhase[ foot ] = 0;
			this.footSwinging[ foot ] = 0;

		}
		this._accumulator = 0;
		this._distanceSinceStep = 0;
		this._activePair = - 1;
		this._nextPair = 0;
		this._settlingAfterDrive = false;
		this._settlementPairsRemaining = 0;
		this._initialized = true;
		this._telemetry.updateCalls = 0;
		this._telemetry.integrationSteps = 0;
		this._telemetry.stepsStarted = 0;
		this._telemetry.stepsCompleted = 0;
		this._telemetry.droppedTime = 0;
		this._telemetry.distanceDriven = 0;
		this._deriveBodyPose( input );
		this._syncView();
		return this;

	}

	update( dt, input ) {

		this._telemetry.updateCalls ++;
		if ( ! this._initialized ) this.reset( input );
		const elapsed = Number.isFinite( dt ) && dt > 0 ? dt : 0;
		if ( elapsed <= 0 ) {

			this._deriveBodyPose( input );
			this._syncView();
			return this._view;

		}

		this._accumulator += elapsed;
		const maximumAccumulated = this.fixedStep * this.maxSubsteps;
		if ( this._accumulator > maximumAccumulated ) {

			this._telemetry.droppedTime += this._accumulator - maximumAccumulated;
			this._accumulator = maximumAccumulated;

		}
		let steps = 0;
		while ( this._accumulator + EPSILON >= this.fixedStep && steps < this.maxSubsteps ) {

			this._step( this.fixedStep, input );
			this._accumulator -= this.fixedStep;
			if ( this._accumulator < EPSILON ) this._accumulator = 0;
			steps ++;

		}
		this._telemetry.integrationSteps += steps;
		this._deriveBodyPose( input );
		this._syncView();
		return this._view;

	}

	getView() {

		return this._view;

	}

	requestSettlement() {

		this._settlingAfterDrive = true;
		this._settlementPairsRemaining = 0b11;
		return this;

	}

	getViews() {

		return this._view;

	}

	getTelemetry() {

		return this._telemetry;

	}

	_step( dt, input ) {

		const velocityX = finiteOr( input?.velocityX, 0 );
		const velocityY = finiteOr( input?.velocityY, 0 );
		const velocityZ = finiteOr( input?.velocityZ, 0 );
		const suppliedSpeed = finiteOr( input?.speed, - 1 );
		const speed = suppliedSpeed >= 0 ?
			suppliedSpeed :
			Math.hypot( velocityX, velocityY, velocityZ );
		const moving = speed > this.stopSpeed;

		if ( moving ) {

			this._settlingAfterDrive = true;
			this._settlementPairsRemaining = 0b11;
			const drivenDistance = speed * dt;
			this._distanceSinceStep += drivenDistance;
			this._telemetry.distanceDriven += drivenDistance;

		}

		if ( this._activePair < 0 ) {

			if ( moving && this._distanceSinceStep + EPSILON >= this.stepDistance
				&& this._pairNeedsStep( this._nextPair, input ) ) {

				this._startPair( this._nextPair, speed, input );

			} else if ( ! moving && this._settlingAfterDrive ) {

				// A stop may occur while either diagonal pair is still far behind the
				// body. Correct each over-extension with at most one ordinary swing;
				// otherwise the IK would have to stretch or the animal would freeze
				// on tiptoe. The larger threshold prevents stationary micro-steps.
				const settlingThreshold = Math.max(
					this.minTargetError * 2,
					this.stepDistance * 0.24,
				);
				let pair = - 1;
				for ( let attempt = 0; attempt < 2; attempt ++ ) {

					const candidatePair = attempt === 0
						? this._nextPair : this._nextPair === 0 ? 1 : 0;
					const pairBit = 1 << candidatePair;
					if ( ( this._settlementPairsRemaining & pairBit ) === 0 ) continue;
					this._settlementPairsRemaining &= ~pairBit;
					if ( this._pairNeedsStepAtThreshold(
						candidatePair, input, settlingThreshold,
					) ) {

						pair = candidatePair;
						break;

					}

				}
				if ( pair >= 0 ) this._startPair( pair, this.stopSpeed + 1e-5, input );
				else this._settlingAfterDrive = false;

			}

		}

		if ( this._activePair >= 0 ) {

			const first = this._activePair === 0 ? PAIR_A_0 : PAIR_B_0;
			const second = this._activePair === 0 ? PAIR_A_1 : PAIR_B_1;
			const firstDone = this._advanceFoot( first, dt );
			const secondDone = this._advanceFoot( second, dt );
			if ( firstDone && secondDone ) {

				const completedPair = this._activePair;
				this._activePair = - 1;
				this._nextPair = this._nextPair === 0 ? 1 : 0;
				this._telemetry.stepsCompleted ++;
				// Each diagonal may finish or correct at most once after drive release.
				// Both pairs reach fresh supports without an endless A/B alternation.
				// Re-evaluating either pair again against moving candidates would let
				// root motion keep alternating targets forever; the two-bit budget ends
				// that feedback while leaving all four claws freshly planted.
				if ( ! moving ) {

					this._settlementPairsRemaining &= ~( 1 << completedPair );
					if ( this._settlementPairsRemaining === 0 )
						this._settlingAfterDrive = false;

				}

			}

		}

	}

	_pairNeedsStep( pair, input ) {

		return this._pairNeedsStepAtThreshold( pair, input, this.minTargetError );

	}

	_pairNeedsStepAtThreshold( pair, input, threshold ) {

		const positions = input?.contactPositions;
		if ( ! positions ) return false;
		const first = pair === 0 ? PAIR_A_0 : PAIR_B_0;
		const second = pair === 0 ? PAIR_A_1 : PAIR_B_1;
		const thresholdSquared = threshold * threshold;
		return this._footErrorSquared( first, positions ) > thresholdSquared ||
			this._footErrorSquared( second, positions ) > thresholdSquared;

	}

	_footErrorSquared( foot, positions ) {

		const offset = foot * 3;
		const dx = finiteOr( positions[ offset ], this.footPositions[ offset ] ) -
			this.footPositions[ offset ];
		const dy = finiteOr( positions[ offset + 1 ], this.footPositions[ offset + 1 ] ) -
			this.footPositions[ offset + 1 ];
		const dz = finiteOr( positions[ offset + 2 ], this.footPositions[ offset + 2 ] ) -
			this.footPositions[ offset + 2 ];
		return dx * dx + dy * dy + dz * dz;

	}

	_startPair( pair, speed, input ) {

		const first = pair === 0 ? PAIR_A_0 : PAIR_B_0;
		const second = pair === 0 ? PAIR_A_1 : PAIR_B_1;
		this._activePair = pair;
		this._distanceSinceStep = Math.max( 0, this._distanceSinceStep - this.stepDistance );
		this._swingDuration = clamp(
			this.stepDistance / Math.max( speed, this.stopSpeed + 1e-5 ) * this.swingDuty,
			this.minSwingDuration,
			this.maxSwingDuration,
		);
		this._startFoot( first, input );
		this._startFoot( second, input );
		this._telemetry.stepsStarted ++;

	}

	_startFoot( foot, input ) {

		const offset = foot * 3;
		const positions = input.contactPositions;
		const normals = input.contactNormals;
		for ( let component = 0; component < 3; component ++ ) {

			const index = offset + component;
			this.footStartPositions[ index ] = this.footPositions[ index ];
			this.footStartNormals[ index ] = this.footNormals[ index ];
			this.footTargetPositions[ index ] = finiteOr(
				positions?.[ index ],
				this.footPositions[ index ],
			);
			this.footTargetNormals[ index ] = finiteOr(
				normals?.[ index ],
				component === 1 ? 1 : 0,
			);

		}
		normalizePackedVector( this.footTargetNormals, offset, 0, 1, 0 );
		this.footPhase[ foot ] = 0;
		this.footSwinging[ foot ] = 1;

	}

	_advanceFoot( foot, dt ) {

		if ( ! this.footSwinging[ foot ] ) return true;
		const offset = foot * 3;
		const phase = Math.min( 1, this.footPhase[ foot ] + dt / this._swingDuration );
		this.footPhase[ foot ] = phase;

		// Lift, travel and placement are separate C2 stages. The claw first rises
		// almost vertically, advances while fully clear, then descends almost
		// vertically. This creates a readable stride instead of a low diagonal
		// shuffle and remains exactly still at both contacts.
		const blend = swingAdvanceEnvelope( phase );
		const lift = swingClearanceEnvelope( phase ) * this.stepHeight
			* ( foot < 2 ? FRONT_SWING_CLEARANCE : HIND_SWING_CLEARANCE );

		let normalX = this.footStartNormals[ offset ] +
			( this.footTargetNormals[ offset ] - this.footStartNormals[ offset ] ) * blend;
		let normalY = this.footStartNormals[ offset + 1 ] +
			( this.footTargetNormals[ offset + 1 ] - this.footStartNormals[ offset + 1 ] ) * blend;
		let normalZ = this.footStartNormals[ offset + 2 ] +
			( this.footTargetNormals[ offset + 2 ] - this.footStartNormals[ offset + 2 ] ) * blend;
		const inverseNormalLength = 1 / Math.hypot( normalX, normalY, normalZ );
		if ( Number.isFinite( inverseNormalLength ) ) {

			normalX *= inverseNormalLength;
			normalY *= inverseNormalLength;
			normalZ *= inverseNormalLength;

		} else {

			normalX = 0;
			normalY = 1;
			normalZ = 0;

		}
		this.footPositions[ offset ] = this.footStartPositions[ offset ] +
			( this.footTargetPositions[ offset ] - this.footStartPositions[ offset ] ) * blend +
			normalX * lift;
		this.footPositions[ offset + 1 ] = this.footStartPositions[ offset + 1 ] +
			( this.footTargetPositions[ offset + 1 ] - this.footStartPositions[ offset + 1 ] ) * blend +
			normalY * lift;
		this.footPositions[ offset + 2 ] = this.footStartPositions[ offset + 2 ] +
			( this.footTargetPositions[ offset + 2 ] - this.footStartPositions[ offset + 2 ] ) * blend +
			normalZ * lift;
		this.footNormals[ offset ] = normalX;
		this.footNormals[ offset + 1 ] = normalY;
		this.footNormals[ offset + 2 ] = normalZ;

		if ( phase < 1 ) return false;
		this.footPositions[ offset ] = this.footTargetPositions[ offset ];
		this.footPositions[ offset + 1 ] = this.footTargetPositions[ offset + 1 ];
		this.footPositions[ offset + 2 ] = this.footTargetPositions[ offset + 2 ];
		this.footNormals[ offset ] = this.footTargetNormals[ offset ];
		this.footNormals[ offset + 1 ] = this.footTargetNormals[ offset + 1 ];
		this.footNormals[ offset + 2 ] = this.footTargetNormals[ offset + 2 ];
		this.footSwinging[ foot ] = 0;
		return true;

	}

	_deriveBodyPose( input ) {

		let centreX = 0;
		let centreY = 0;
		let centreZ = 0;
		let upX = 0;
		let upY = 0;
		let upZ = 0;
		for ( let foot = 0; foot < CHAMELEON_FOOT_COUNT; foot ++ ) {

			const offset = foot * 3;
			// Swing targets are still real surface contacts. Using them prevents
			// body bobbing while preserving a four-contact support plane.
			const positions = this.footSwinging[ foot ] ?
				this.footTargetPositions :
				this.footPositions;
			const normals = this.footSwinging[ foot ] ?
				this.footTargetNormals :
				this.footNormals;
			centreX += positions[ offset ];
			centreY += positions[ offset + 1 ];
			centreZ += positions[ offset + 2 ];
			upX += normals[ offset ];
			upY += normals[ offset + 1 ];
			upZ += normals[ offset + 2 ];

		}
		centreX *= 0.25;
		centreY *= 0.25;
		centreZ *= 0.25;
		let inverseUpLength = 1 / Math.hypot( upX, upY, upZ );
		if ( ! Number.isFinite( inverseUpLength ) ) {

			upX = 0;
			upY = 1;
			upZ = 0;
			inverseUpLength = 1;

		}
		upX *= inverseUpLength;
		upY *= inverseUpLength;
		upZ *= inverseUpLength;

		let forwardX = finiteOr( input?.forwardX, this.bodyForward[ 0 ] );
		let forwardY = finiteOr( input?.forwardY, this.bodyForward[ 1 ] );
		let forwardZ = finiteOr( input?.forwardZ, this.bodyForward[ 2 ] );
		const forwardAlongUp = forwardX * upX + forwardY * upY + forwardZ * upZ;
		forwardX -= upX * forwardAlongUp;
		forwardY -= upY * forwardAlongUp;
		forwardZ -= upZ * forwardAlongUp;
		let inverseForwardLength = 1 / Math.hypot( forwardX, forwardY, forwardZ );
		if ( ! Number.isFinite( inverseForwardLength ) ) {

			const frontX = (
				this.footTargetPositions[ 0 ] + this.footTargetPositions[ 3 ]
			) * 0.5;
			const frontY = (
				this.footTargetPositions[ 1 ] + this.footTargetPositions[ 4 ]
			) * 0.5;
			const frontZ = (
				this.footTargetPositions[ 2 ] + this.footTargetPositions[ 5 ]
			) * 0.5;
			const backX = (
				this.footTargetPositions[ 6 ] + this.footTargetPositions[ 9 ]
			) * 0.5;
			const backY = (
				this.footTargetPositions[ 7 ] + this.footTargetPositions[ 10 ]
			) * 0.5;
			const backZ = (
				this.footTargetPositions[ 8 ] + this.footTargetPositions[ 11 ]
			) * 0.5;
			forwardX = frontX - backX;
			forwardY = frontY - backY;
			forwardZ = frontZ - backZ;
			const fallbackAlongUp = forwardX * upX + forwardY * upY + forwardZ * upZ;
			forwardX -= upX * fallbackAlongUp;
			forwardY -= upY * fallbackAlongUp;
			forwardZ -= upZ * fallbackAlongUp;
			inverseForwardLength = 1 / Math.hypot( forwardX, forwardY, forwardZ );
			if ( ! Number.isFinite( inverseForwardLength ) ) {

				forwardX = 1;
				forwardY = 0;
				forwardZ = 0;
				inverseForwardLength = 1;

			}

		}
		forwardX *= inverseForwardLength;
		forwardY *= inverseForwardLength;
		forwardZ *= inverseForwardLength;

		let rightX = forwardY * upZ - forwardZ * upY;
		let rightY = forwardZ * upX - forwardX * upZ;
		let rightZ = forwardX * upY - forwardY * upX;
		const inverseRightLength = 1 / ( Math.hypot( rightX, rightY, rightZ ) || 1 );
		rightX *= inverseRightLength;
		rightY *= inverseRightLength;
		rightZ *= inverseRightLength;
		// Re-orthogonalise forward after the right vector was normalised.
		forwardX = upY * rightZ - upZ * rightY;
		forwardY = upZ * rightX - upX * rightZ;
		forwardZ = upX * rightY - upY * rightX;

		this.bodyPosition[ 0 ] = centreX + upX * this.bodyClearance;
		this.bodyPosition[ 1 ] = centreY + upY * this.bodyClearance;
		this.bodyPosition[ 2 ] = centreZ + upZ * this.bodyClearance;
		this.bodyForward[ 0 ] = forwardX;
		this.bodyForward[ 1 ] = forwardY;
		this.bodyForward[ 2 ] = forwardZ;
		this.bodyUp[ 0 ] = upX;
		this.bodyUp[ 1 ] = upY;
		this.bodyUp[ 2 ] = upZ;
		this.bodyRight[ 0 ] = rightX;
		this.bodyRight[ 1 ] = rightY;
		this.bodyRight[ 2 ] = rightZ;

	}

	_syncView() {

		this._view.activePair = this._activePair;
		this._view.nextPair = this._nextPair;
		this._view.distanceSinceStep = this._distanceSinceStep;

	}

}

export function createChameleonProceduralGait( options ) {

	return new ChameleonProceduralGait( options );

}
