const DEFAULT_UP = Object.freeze( { x: 0, y: 1, z: 0 } );
const DEFAULT_FORWARD = Object.freeze( { x: 0, y: 0, z: - 1 } );
const EPSILON = 1e-10;

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function setVector( target, source, fallback = DEFAULT_FORWARD ) {

	target.x = finiteOr( source?.x, fallback.x );
	target.y = finiteOr( source?.y, fallback.y );
	target.z = finiteOr( source?.z, fallback.z );
	return target;

}

function lengthSquared( vector ) {

	return vector.x * vector.x + vector.y * vector.y + vector.z * vector.z;

}

function normalize( vector, fallback = DEFAULT_FORWARD ) {

	const squared = lengthSquared( vector );
	if ( squared <= EPSILON ) return setVector( vector, fallback );
	const inverseLength = 1 / Math.sqrt( squared );
	vector.x *= inverseLength;
	vector.y *= inverseLength;
	vector.z *= inverseLength;
	return vector;

}

function projectOnPlane( target, vector, normal ) {

	const dot = vector.x * normal.x + vector.y * normal.y + vector.z * normal.z;
	target.x = vector.x - normal.x * dot;
	target.y = vector.y - normal.y * dot;
	target.z = vector.z - normal.z * dot;
	return target;

}

function cross( target, a, b ) {

	const x = a.y * b.z - a.z * b.y;
	const y = a.z * b.x - a.x * b.z;
	const z = a.x * b.y - a.y * b.x;
	target.x = x;
	target.y = y;
	target.z = z;
	return target;

}

function orthogonal( target, normal ) {

	if ( Math.abs( normal.y ) < 0.85 ) {

		target.x = normal.z;
		target.y = 0;
		target.z = - normal.x;

	} else {

		target.x = 0;
		target.y = normal.z;
		target.z = - normal.y;

	}
	return normalize( target );

}

function clampAxes( axes, target ) {

	let x = finiteOr( axes?.x, 0 );
	let y = finiteOr( axes?.y, 0 );
	const magnitude = Math.hypot( x, y );
	if ( magnitude > 1 ) {

		x /= magnitude;
		y /= magnitude;

	}
	target.x = x;
	target.y = y;
	return Math.min( 1, magnitude );

}

/**
 * Physical KeyboardEvent.code mapping. It deliberately accepts both WASD and
 * ZQSD, so changing the browser/OS keyboard layout cannot alter locomotion.
 */
export function platformerAxesFromKeys( keys, target = { x: 0, y: 0 } ) {

	const forward = Number( keys?.has?.( 'KeyW' ) || keys?.has?.( 'KeyZ' ) || keys?.has?.( 'ArrowUp' ) );
	const backward = Number( keys?.has?.( 'KeyS' ) || keys?.has?.( 'ArrowDown' ) );
	const left = Number( keys?.has?.( 'KeyA' ) || keys?.has?.( 'KeyQ' ) || keys?.has?.( 'ArrowLeft' ) );
	const right = Number( keys?.has?.( 'KeyD' ) || keys?.has?.( 'ArrowRight' ) );
	let x = right - left;
	let y = forward - backward;
	const magnitude = Math.hypot( x, y );
	if ( magnitude > 1 ) {

		x /= magnitude;
		y /= magnitude;

	}
	target.x = x;
	target.y = y;
	if ( magnitude === 0 ) {

		target.x = 0;
		target.y = 0;

	}
	return target;

}

/**
 * Converts stick/keyboard axes into a classic third-person direction.
 * Camera pitch is removed first, then the intent is projected onto the current
 * support. This makes the same yaw produce the same command at any camera pitch.
 */
export function cameraRelativePlatformerDirection( axes, cameraForward, {
	worldUp = DEFAULT_UP,
	supportNormal = worldUp,
	fallbackFacing = DEFAULT_FORWARD,
	scratch = null,
} = {}, target = { x: 0, y: 0, z: 0 } ) {

	const axis = scratch?.axis ?? { x: 0, y: 0 };
	const magnitude = clampAxes( axes, axis );
	if ( magnitude <= EPSILON ) {

		target.x = 0;
		target.y = 0;
		target.z = 0;
		return target;

	}
	const up = normalize( setVector( scratch?.up ?? { x: 0, y: 0, z: 0 }, worldUp, DEFAULT_UP ), DEFAULT_UP );
	const normal = normalize( setVector( scratch?.normal ?? { x: 0, y: 0, z: 0 }, supportNormal, up ), up );
	const camera = setVector( scratch?.camera ?? { x: 0, y: 0, z: 0 }, cameraForward, fallbackFacing );
	const forward = projectOnPlane( scratch?.forward ?? { x: 0, y: 0, z: 0 }, camera, up );
	if ( lengthSquared( forward ) <= EPSILON )
		projectOnPlane( forward, fallbackFacing, up );
	if ( lengthSquared( forward ) <= EPSILON ) orthogonal( forward, up );
	else normalize( forward );
	const right = normalize( cross( scratch?.right ?? { x: 0, y: 0, z: 0 }, forward, up ) );
	const worldIntent = scratch?.intent ?? { x: 0, y: 0, z: 0 };
	worldIntent.x = forward.x * axis.y + right.x * axis.x;
	worldIntent.y = forward.y * axis.y + right.y * axis.x;
	worldIntent.z = forward.z * axis.y + right.z * axis.x;
	projectOnPlane( target, worldIntent, normal );
	if ( lengthSquared( target ) <= EPSILON ) {

		// Looking directly into a wall should mean climb, not stop or flip.
		projectOnPlane( target, up, normal );
		if ( axis.y < 0 ) {

			target.x *= - 1;
			target.y *= - 1;
			target.z *= - 1;

		}
		if ( lengthSquared( target ) <= EPSILON )
			projectOnPlane( target, fallbackFacing, normal );
		if ( lengthSquared( target ) <= EPSILON ) orthogonal( target, normal );

	}
	normalize( target );
	target.x *= magnitude;
	target.y *= magnitude;
	target.z *= magnitude;
	return target;

}

function signedAngle( from, to, normal, crossScratch ) {

	cross( crossScratch, from, to );
	const sine = crossScratch.x * normal.x + crossScratch.y * normal.y + crossScratch.z * normal.z;
	const cosine = Math.max( - 1, Math.min( 1,
		from.x * to.x + from.y * to.y + from.z * to.z,
	) );
	return Math.atan2( sine, cosine );

}

function rotateAroundAxis( target, vector, axis, angle ) {

	const cosine = Math.cos( angle );
	const sine = Math.sin( angle );
	const dot = vector.x * axis.x + vector.y * axis.y + vector.z * axis.z;
	const crossX = axis.y * vector.z - axis.z * vector.y;
	const crossY = axis.z * vector.x - axis.x * vector.z;
	const crossZ = axis.x * vector.y - axis.y * vector.x;
	target.x = vector.x * cosine + crossX * sine + axis.x * dot * ( 1 - cosine );
	target.y = vector.y * cosine + crossY * sine + axis.y * dot * ( 1 - cosine );
	target.z = vector.z * cosine + crossZ * sine + axis.z * dot * ( 1 - cosine );
	return normalize( target );

}

export function parallelTransportTangent( target, vector, fromNormal, toNormal, scratch ) {

	const axis = scratch.axis;
	const firstCross = scratch.firstCross;
	const secondCross = scratch.secondCross;
	cross( axis, fromNormal, toNormal );
	const axisLengthSquared = lengthSquared( axis );
	const cosine = Math.max( -1, Math.min( 1,
		fromNormal.x * toNormal.x + fromNormal.y * toNormal.y + fromNormal.z * toNormal.z,
	) );
	if ( axisLengthSquared > EPSILON && cosine > -1 + 1e-7 ) {

		cross( firstCross, axis, vector );
		cross( secondCross, axis, firstCross );
		const inverse = 1 / ( 1 + cosine );
		target.x = vector.x + firstCross.x + secondCross.x * inverse;
		target.y = vector.y + firstCross.y + secondCross.y * inverse;
		target.z = vector.z + firstCross.z + secondCross.z * inverse;

	} else setVector( target, vector );
	projectOnPlane( target, target, toNormal );
	if ( lengthSquared( target ) <= EPSILON ) orthogonal( target, toNormal );
	else normalize( target );
	return target;

}

function horizontalHeading( target, cameraForward, worldUp, fallback ) {

	projectOnPlane( target, cameraForward, worldUp );
	if ( lengthSquared( target ) <= 1e-7 ) setVector( target, fallback );
	projectOnPlane( target, target, worldUp );
	if ( lengthSquared( target ) <= EPSILON ) orthogonal( target, worldUp );
	else normalize( target );
	return target;

}

function applyHeadingDelta( target, previousCamera, currentCamera, supportNormal, worldUp, scratch ) {

	const yawCross = scratch.yawCross;
	cross( yawCross, previousCamera, currentCamera );
	const sine = yawCross.x * worldUp.x + yawCross.y * worldUp.y + yawCross.z * worldUp.z;
	const cosine = Math.max( -1, Math.min( 1,
		previousCamera.x * currentCamera.x
		+ previousCamera.y * currentCamera.y + previousCamera.z * currentCamera.z,
	) );
	const supportCross = scratch.supportCross;
	cross( supportCross, supportNormal, target );
	const x = target.x * cosine + supportCross.x * sine;
	const y = target.y * cosine + supportCross.y * sine;
	const z = target.z * cosine + supportCross.z * sine;
	target.x = x;
	target.y = y;
	target.z = z;
	projectOnPlane( target, target, supportNormal );
	return normalize( target );

}

/**
 * Allocation-free fixed-step intent/orientation model.
 *
 * The locomotion frame belongs to the animal, not to the camera. `bodyForward`
 * is the preferred input and represents the anatomical forward axis transformed
 * by the current rigid-body attitude. The older `facing` input remains accepted
 * for callers which already keep a tangent facing of their own. Camera data is
 * deliberately ignored here; `cameraRelativePlatformerDirection()` remains
 * exported for legacy consumers which explicitly want that policy.
 */
export class PlatformerControlModel {

	constructor( {
		moveSpeed = 0.9,
		sprintMultiplier = 1.55,
		turnRate = Math.PI * 3.2,
		groundAcceleration = 11,
		groundBraking = 15,
		airAcceleration = 3.2,
		airBraking = 0.55,
	} = {} ) {

		this.moveSpeed = moveSpeed;
		this.sprintMultiplier = sprintMultiplier;
		this.turnRate = turnRate;
		this.groundAcceleration = groundAcceleration;
		this.groundBraking = groundBraking;
		this.airAcceleration = airAcceleration;
		this.airBraking = airBraking;
		this.direction = { x: 0, y: 0, z: 0 };
		this.facing = { x: 0, y: 0, z: - 1 };
		this.desiredVelocity = { x: 0, y: 0, z: 0 };
		this.acceleration = { x: 0, y: 0, z: 0 };
		this._axis = { x: 0, y: 0 };
		this._normal = { x: 0, y: 1, z: 0 };
		this._worldUp = { x: 0, y: 1, z: 0 };
		this._previousNormal = { x: 0, y: 1, z: 0 };
		this.surfaceForward = { x: 0, y: 0, z: -1 };
		this._cameraHeading = { x: 0, y: 0, z: -1 };
		this._cameraCandidate = { x: 0, y: 0, z: -1 };
		this._cameraHeadingValid = false;
		this._from = { x: 0, y: 0, z: - 1 };
		this._cross = { x: 0, y: 0, z: 0 };
		this._surfaceRight = { x: 1, y: 0, z: 0 };
		this._transportScratch = {
			axis: { x: 0, y: 0, z: 0 },
			firstCross: { x: 0, y: 0, z: 0 },
			secondCross: { x: 0, y: 0, z: 0 },
			yawCross: { x: 0, y: 0, z: 0 },
			supportCross: { x: 0, y: 0, z: 0 },
		};
		this._tangentVelocity = { x: 0, y: 0, z: 0 };
		this.view = {
			direction: this.direction,
			facing: this.facing,
			supportNormal: this._normal,
			desiredVelocity: this.desiredVelocity,
			acceleration: this.acceleration,
			magnitude: 0,
			targetSpeed: 0,
			turnDelta: 0,
			moving: false,
		};

	}

	reset( facing = DEFAULT_FORWARD, supportNormal = DEFAULT_UP ) {

		setVector( this._normal, supportNormal, DEFAULT_UP );
		normalize( this._normal, DEFAULT_UP );
		setVector( this._previousNormal, this._normal );
		projectOnPlane( this.facing, facing, this._normal );
		if ( lengthSquared( this.facing ) <= EPSILON ) orthogonal( this.facing, this._normal );
		else normalize( this.facing );
		setVector( this.surfaceForward, this.facing );
		projectOnPlane( this._cameraHeading, facing, DEFAULT_UP );
		if ( lengthSquared( this._cameraHeading ) <= EPSILON ) setVector( this._cameraHeading, DEFAULT_FORWARD );
		else normalize( this._cameraHeading );
		this._cameraHeadingValid = false;
		this.direction.x = this.direction.y = this.direction.z = 0;
		this.desiredVelocity.x = this.desiredVelocity.y = this.desiredVelocity.z = 0;
		this.acceleration.x = this.acceleration.y = this.acceleration.z = 0;
		this.view.magnitude = 0;
		this.view.targetSpeed = 0;
		this.view.turnDelta = 0;
		this.view.moving = false;
		return this.view;

	}

	update( dt, {
		axes,
		cameraForward: _cameraForward = null,
		worldUp = DEFAULT_UP,
		supportNormal = worldUp,
		bodyForward = null,
		facing = null,
		velocity = null,
		supported = true,
		sprint = false,
	} ) {

		dt = Math.max( 0, Math.min( 0.1, finiteOr( dt, 0 ) ) );
		const magnitude = clampAxes( axes, this._axis );
		const normalizedWorldUp = normalize(
			setVector( this._worldUp, worldUp, DEFAULT_UP ), DEFAULT_UP,
		);
		setVector( this._normal, supported ? supportNormal : normalizedWorldUp, DEFAULT_UP );
		normalize( this._normal, DEFAULT_UP );
		const anatomicalForward = bodyForward ?? facing;
		if ( anatomicalForward ) {

			// A body-forward vector comes from the current physical attitude, so it
			// is already expressed in the destination frame. Project it directly;
			// near the singular case (nose into the support), preserve the previous
			// tangent by minimal-rotation transport instead of choosing a new axis.
			projectOnPlane( this.surfaceForward, anatomicalForward, this._normal );
			if ( lengthSquared( this.surfaceForward ) <= 1e-7 ) parallelTransportTangent(
				this.surfaceForward, this.facing,
				this._previousNormal, this._normal, this._transportScratch,
			);
			else normalize( this.surfaceForward );

		} else parallelTransportTangent(
			this.surfaceForward, this.facing,
			this._previousNormal, this._normal, this._transportScratch,
		);
		setVector( this._from, this.surfaceForward );
		setVector( this._previousNormal, this._normal );
		cross( this._surfaceRight, this.surfaceForward, this._normal );
		normalize( this._surfaceRight );
		this.direction.x = this.surfaceForward.x * this._axis.y + this._surfaceRight.x * this._axis.x;
		this.direction.y = this.surfaceForward.y * this._axis.y + this._surfaceRight.y * this._axis.x;
		this.direction.z = this.surfaceForward.z * this._axis.y + this._surfaceRight.z * this._axis.x;
		if ( magnitude > EPSILON ) normalize( this.direction );
		this.direction.x *= magnitude;
		this.direction.y *= magnitude;
		this.direction.z *= magnitude;
		let turnDelta = 0;
		if ( magnitude > EPSILON ) {

			const requestedTurn = signedAngle( this._from, this.direction, this._normal, this._cross );
			turnDelta = Math.max( - this.turnRate * dt, Math.min( this.turnRate * dt, requestedTurn ) );
			rotateAroundAxis( this.facing, this._from, this._normal, turnDelta );

		} else setVector( this.facing, this._from );

		const targetSpeed = this.moveSpeed * ( sprint ? this.sprintMultiplier : 1 ) * magnitude;
		this.desiredVelocity.x = this.direction.x * this.moveSpeed * ( sprint ? this.sprintMultiplier : 1 );
		this.desiredVelocity.y = this.direction.y * this.moveSpeed * ( sprint ? this.sprintMultiplier : 1 );
		this.desiredVelocity.z = this.direction.z * this.moveSpeed * ( sprint ? this.sprintMultiplier : 1 );
		this.acceleration.x = this.acceleration.y = this.acceleration.z = 0;
		if ( velocity ) {

			projectOnPlane( this._tangentVelocity, velocity, this._normal );
			const response = supported
				? ( magnitude > EPSILON ? this.groundAcceleration : this.groundBraking )
				: ( magnitude > EPSILON ? this.airAcceleration : this.airBraking );
			this.acceleration.x = this.desiredVelocity.x - this._tangentVelocity.x;
			this.acceleration.y = this.desiredVelocity.y - this._tangentVelocity.y;
			this.acceleration.z = this.desiredVelocity.z - this._tangentVelocity.z;
			this.acceleration.x *= response;
			this.acceleration.y *= response;
			this.acceleration.z *= response;
			const errorLength = Math.sqrt( lengthSquared( this.acceleration ) );
			if ( errorLength > response && errorLength > EPSILON ) {

				const scale = response / errorLength;
				this.acceleration.x *= scale;
				this.acceleration.y *= scale;
				this.acceleration.z *= scale;

			}

		}
		this.view.magnitude = magnitude;
		this.view.targetSpeed = targetSpeed;
		this.view.turnDelta = turnDelta;
		this.view.moving = magnitude > EPSILON;
		return this.view;

	}

}
