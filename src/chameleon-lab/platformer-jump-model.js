const DEFAULT_UP = Object.freeze( { x: 0, y: 1, z: 0 } );
const DEFAULT_GRAVITY = Object.freeze( { x: 0, y: - 9.81, z: 0 } );
const ZERO = Object.freeze( { x: 0, y: 0, z: 0 } );
const EPSILON = 1e-10;

export const JUMP_PHASE = Object.freeze( {
	GROUNDED: 'grounded',
	LANDING: 'landing',
	PRELOAD: 'preload',
	TAKEOFF: 'takeoff',
	RISING: 'rising',
	APEX: 'apex',
	FALLING: 'falling',
} );

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function setVector( target, source, fallback ) {

	target.x = finiteOr( source?.x, fallback.x );
	target.y = finiteOr( source?.y, fallback.y );
	target.z = finiteOr( source?.z, fallback.z );
	return target;

}

function normalize( vector, fallback = DEFAULT_UP ) {

	const squared = vector.x * vector.x + vector.y * vector.y + vector.z * vector.z;
	if ( squared <= EPSILON ) return setVector( vector, fallback, DEFAULT_UP );
	const inverseLength = 1 / Math.sqrt( squared );
	vector.x *= inverseLength;
	vector.y *= inverseLength;
	vector.z *= inverseLength;
	return vector;

}

function dot( a, b ) {

	return a.x * b.x + a.y * b.y + a.z * b.z;

}

function clampLength( vector, maximum ) {

	const squared = vector.x * vector.x + vector.y * vector.y + vector.z * vector.z;
	if ( squared <= maximum * maximum || squared <= EPSILON ) return vector;
	const scale = maximum / Math.sqrt( squared );
	vector.x *= scale;
	vector.y *= scale;
	vector.z *= scale;
	return vector;

}

function saturate( value ) {

	return Math.max( 0, Math.min( 1, finiteOr( value, 0 ) ) );

}

function smoothstep01( value ) {

	value = saturate( value );
	return value * value * ( 3 - 2 * value );

}

function projectOnPlane( target, vector, normal ) {

	const projection = dot( vector, normal );
	target.x = vector.x - normal.x * projection;
	target.y = vector.y - normal.y * projection;
	target.z = vector.z - normal.z * projection;
	return target;

}

export function jumpTakeoffSpeed( jumpHeight, gravityMagnitude, riseGravityScale = 1 ) {

	jumpHeight = Math.max( 0, finiteOr( jumpHeight, 0 ) );
	gravityMagnitude = Math.max( 0, finiteOr( gravityMagnitude, 0 ) );
	riseGravityScale = Math.max( 0, finiteOr( riseGravityScale, 1 ) );
	return Math.sqrt( 2 * jumpHeight * gravityMagnitude * riseGravityScale );

}

/**
 * Calculates a support-aware take-off impulse. On a floor it is vertical; on a
 * wall it keeps a strong upward component while pushing the body off the wall.
 */
export function supportAwareJumpImpulse( {
	mass,
	velocity,
	worldUp = DEFAULT_UP,
	supportNormal = worldUp,
	gravity = DEFAULT_GRAVITY,
	jumpHeight,
	riseGravityScale = 1,
	supportInfluence = 0.58,
	upInfluence = 0.82,
	forwardDirection = ZERO,
	forwardSpeed = 0,
	sprint = false,
	sprintMultiplier = 1,
	scratch = null,
}, target = { x: 0, y: 0, z: 0 }, launchDirection = { x: 0, y: 1, z: 0 } ) {

	mass = Math.max( 0, finiteOr( mass, 0 ) );
	const up = normalize( setVector( scratch?.up ?? { x: 0, y: 0, z: 0 }, worldUp, DEFAULT_UP ) );
	const support = normalize( setVector( scratch?.support ?? { x: 0, y: 0, z: 0 }, supportNormal, up ) );
	const lift = scratch?.lift ?? { x: 0, y: 1, z: 0 };
	lift.x = support.x * Math.max( 0, supportInfluence ) + up.x * Math.max( 0, upInfluence );
	lift.y = support.y * Math.max( 0, supportInfluence ) + up.y * Math.max( 0, upInfluence );
	lift.z = support.z * Math.max( 0, supportInfluence ) + up.z * Math.max( 0, upInfluence );
	// `worldUp` and an inverted support normal are collinear and opposed. A raw
	// weighted sum therefore used to point back into ceilings whenever the upward
	// bias was stronger than the separation bias. Preserve the authored blend on
	// floors, slopes and walls, but enforce a small positive support component for
	// every orientation before normalising it.
	const minimumSeparation = Math.max( 0.08, Math.max( 0, supportInfluence ) * 0.35 );
	const separation = dot( lift, support );
	if ( separation < minimumSeparation ) {

		const correction = minimumSeparation - separation;
		lift.x += support.x * correction;
		lift.y += support.y * correction;
		lift.z += support.z * correction;

	}
	normalize( lift, up );
	const forward = projectOnPlane(
		scratch?.forward ?? { x: 0, y: 0, z: 0 }, forwardDirection ?? ZERO, support,
	);
	const forwardLength = Math.hypot( forward.x, forward.y, forward.z );
	if ( forwardLength > EPSILON ) {

		forward.x /= forwardLength;
		forward.y /= forwardLength;
		forward.z /= forwardLength;

	} else forward.x = forward.y = forward.z = 0;
	const gravityMagnitude = Math.max( Math.abs( dot( gravity, up ) ), Math.hypot(
		finiteOr( gravity?.x, 0 ), finiteOr( gravity?.y, - 9.81 ), finiteOr( gravity?.z, 0 ),
	) * 0.25 );
	const targetSpeed = jumpTakeoffSpeed( jumpHeight, gravityMagnitude, riseGravityScale );
	const currentSpeed = dot( velocity ?? ZERO, lift );
	const deltaSpeed = Math.max( 0, targetSpeed - currentSpeed );
	const requestedForwardSpeed = Math.max( 0, finiteOr( forwardSpeed, 0 ) )
		* ( sprint ? Math.max( 1, finiteOr( sprintMultiplier, 1 ) ) : 1 );
	const currentForwardSpeed = dot( velocity ?? ZERO, forward );
	const deltaForwardSpeed = Math.max( 0, requestedForwardSpeed - currentForwardSpeed );
	target.x = ( lift.x * deltaSpeed + forward.x * deltaForwardSpeed ) * mass;
	target.y = ( lift.y * deltaSpeed + forward.y * deltaForwardSpeed ) * mass;
	target.z = ( lift.z * deltaSpeed + forward.z * deltaForwardSpeed ) * mass;
	launchDirection.x = target.x;
	launchDirection.y = target.y;
	launchDirection.z = target.z;
	normalize( launchDirection, lift );
	return target;

}

/**
 * Horizontal/tangential steering only: vertical jump momentum remains entirely
 * owned by physics. The result is an acceleration, not a frame-rate dependent
 * velocity delta.
 */
export function airControlAcceleration( {
	velocity,
	desiredDirection,
	worldUp = DEFAULT_UP,
	maximumSpeed,
	acceleration,
	braking = 0,
}, target = { x: 0, y: 0, z: 0 }, scratch = null ) {

	const up = normalize( setVector( scratch?.up ?? { x: 0, y: 0, z: 0 }, worldUp, DEFAULT_UP ) );
	const tangentVelocity = projectOnPlane(
		scratch?.tangentVelocity ?? { x: 0, y: 0, z: 0 }, velocity ?? ZERO, up,
	);
	const desired = projectOnPlane(
		scratch?.desired ?? { x: 0, y: 0, z: 0 }, desiredDirection ?? ZERO, up,
	);
	const desiredLength = Math.hypot( desired.x, desired.y, desired.z );
	const maximum = Math.max( 0, finiteOr( maximumSpeed, 0 ) );
	if ( desiredLength > EPSILON ) {

		const scale = Math.min( 1, desiredLength ) * maximum / desiredLength;
		desired.x *= scale;
		desired.y *= scale;
		desired.z *= scale;
		target.x = desired.x - tangentVelocity.x;
		target.y = desired.y - tangentVelocity.y;
		target.z = desired.z - tangentVelocity.z;
		return clampLength( target, Math.max( 0, finiteOr( acceleration, 0 ) ) );

	}
	target.x = - tangentVelocity.x;
	target.y = - tangentVelocity.y;
	target.z = - tangentVelocity.z;
	return clampLength( target, Math.max( 0, finiteOr( braking, 0 ) ) );

}

/**
 * Fixed-step jump state machine. It owns timing and force policy only; Rapier
 * remains the authority for collision and integration.
 */
export class PlatformerJumpModel {

	constructor( {
		jumpHeight = 0.72,
		minimumHeightRatio = 0.38,
		maximumChargeTime = 0.22,
		minimumPreloadTime = 0.045,
		minimumForwardSpeed = 0.68,
		maximumForwardSpeed = 2.25,
		sprintJumpMultiplier = 1.38,
		coyoteTime = 0.12,
		bufferTime = 0.14,
		detachTime = 0.16,
		landingDuration = 0.16,
		riseGravityScale = 0.92,
		apexGravityScale = 0.68,
		fallGravityScale = 1.42,
		cutGravityScale = 2.05,
		apexVelocity = 0.34,
		supportInfluence = 0.58,
		upInfluence = 0.82,
		airMaximumSpeed = 0.82,
		airAcceleration = 3.2,
		airBraking = 0.35,
		landingImpactSpeed = 2.8,
	} = {} ) {

		this.jumpHeight = jumpHeight;
		this.minimumHeightRatio = minimumHeightRatio;
		this.maximumChargeTime = maximumChargeTime;
		this.minimumPreloadTime = minimumPreloadTime;
		this.minimumForwardSpeed = minimumForwardSpeed;
		this.maximumForwardSpeed = maximumForwardSpeed;
		this.sprintJumpMultiplier = sprintJumpMultiplier;
		this.coyoteTime = coyoteTime;
		this.bufferTime = bufferTime;
		this.detachTime = detachTime;
		this.landingDuration = landingDuration;
		this.riseGravityScale = riseGravityScale;
		this.apexGravityScale = apexGravityScale;
		this.fallGravityScale = fallGravityScale;
		this.cutGravityScale = cutGravityScale;
		this.apexVelocity = apexVelocity;
		this.supportInfluence = supportInfluence;
		this.upInfluence = upInfluence;
		this.airMaximumSpeed = airMaximumSpeed;
		this.airAcceleration = airAcceleration;
		this.airBraking = airBraking;
		this.landingImpactSpeed = landingImpactSpeed;
		this.phase = JUMP_PHASE.GROUNDED;
		this.coyoteRemaining = coyoteTime;
		this.bufferRemaining = 0;
		this.detachRemaining = 0;
		this.landingRemaining = 0;
		this.airborneSeconds = 0;
		this.wasSupported = true;
		this.jumpHeld = false;
		this.charging = false;
		this.releaseRequested = false;
		this.chargeSeconds = 0;
		this.preloadSeconds = 0;
		this.launchCharge = 0;
		this.launchHeight = 0;
		this.launchForwardSpeed = 0;
		this.ballisticCommitted = false;
		this.minimumAirborneVerticalSpeed = 0;
		this.lastSupportNormal = { x: 0, y: 1, z: 0 };
		this.worldUp = { x: 0, y: 1, z: 0 };
		this.impulse = { x: 0, y: 0, z: 0 };
		this.launchDirection = { x: 0, y: 1, z: 0 };
		this.additionalGravity = { x: 0, y: 0, z: 0 };
		this.airAccelerationVector = { x: 0, y: 0, z: 0 };
		this._impulseScratch = {
			up: { x: 0, y: 1, z: 0 },
			support: { x: 0, y: 1, z: 0 },
			lift: { x: 0, y: 1, z: 0 },
			forward: { x: 0, y: 0, z: -1 },
		};
		this._impulseInput = {
			mass: 1,
			velocity: ZERO,
			worldUp: this.worldUp,
			supportNormal: this.lastSupportNormal,
			gravity: DEFAULT_GRAVITY,
			jumpHeight: this.jumpHeight,
			riseGravityScale: this.riseGravityScale,
			supportInfluence: this.supportInfluence,
			upInfluence: this.upInfluence,
			forwardDirection: ZERO,
			forwardSpeed: 0,
			sprint: false,
			sprintMultiplier: this.sprintJumpMultiplier,
			scratch: this._impulseScratch,
		};
		this._airScratch = {
			up: { x: 0, y: 1, z: 0 },
			tangentVelocity: { x: 0, y: 0, z: 0 },
			desired: { x: 0, y: 0, z: 0 },
		};
		this._airInput = {
			velocity: ZERO,
			desiredDirection: ZERO,
			worldUp: this.worldUp,
			maximumSpeed: this.airMaximumSpeed,
			acceleration: this.airAcceleration,
			braking: this.airBraking,
		};
		this.view = {
			phase: this.phase,
			jumped: false,
			impulse: this.impulse,
			launchDirection: this.launchDirection,
			gravityScale: 1,
			additionalGravity: this.additionalGravity,
			airAcceleration: this.airAccelerationVector,
			releaseSupport: false,
			charging: false,
			charge: 0,
			chargeSeconds: 0,
			targetJumpHeight: 0,
			targetForwardSpeed: 0,
			preloadCompression: 0,
			takeoffExtension: 0,
			airborneTuck: 0,
			forwardLean: 0,
			muscleCompliance: 0,
			landingCompression: 0,
			landingImpact: 0,
			coyoteRemaining: this.coyoteRemaining,
			bufferRemaining: 0,
			airborneSeconds: 0,
		};

	}

	reset( supported = true, supportNormal = DEFAULT_UP ) {

		this.phase = supported ? JUMP_PHASE.GROUNDED : JUMP_PHASE.FALLING;
		this.coyoteRemaining = supported ? this.coyoteTime : 0;
		this.bufferRemaining = 0;
		this.detachRemaining = 0;
		this.landingRemaining = 0;
		this.airborneSeconds = 0;
		this.wasSupported = supported;
		this.jumpHeld = false;
		this.charging = false;
		this.releaseRequested = false;
		this.chargeSeconds = 0;
		this.preloadSeconds = 0;
		this.launchCharge = 0;
		this.launchHeight = 0;
		this.launchForwardSpeed = 0;
		this.ballisticCommitted = false;
		this.minimumAirborneVerticalSpeed = 0;
		setVector( this.lastSupportNormal, supportNormal, DEFAULT_UP );
		normalize( this.lastSupportNormal, DEFAULT_UP );
		this.impulse.x = this.impulse.y = this.impulse.z = 0;
		this.additionalGravity.x = this.additionalGravity.y = this.additionalGravity.z = 0;
		this.airAccelerationVector.x = this.airAccelerationVector.y = this.airAccelerationVector.z = 0;
		this.view.phase = this.phase;
		this.view.jumped = false;
		this.view.gravityScale = 1;
		this.view.releaseSupport = false;
		this.view.charging = false;
		this.view.charge = 0;
		this.view.chargeSeconds = 0;
		this.view.targetJumpHeight = 0;
		this.view.targetForwardSpeed = 0;
		this.view.preloadCompression = 0;
		this.view.takeoffExtension = 0;
		this.view.airborneTuck = 0;
		this.view.forwardLean = 0;
		this.view.muscleCompliance = 0;
		this.view.landingCompression = 0;
		this.view.landingImpact = 0;
		this.view.coyoteRemaining = this.coyoteRemaining;
		this.view.bufferRemaining = 0;
		this.view.airborneSeconds = 0;
		return this.view;

	}

	update( dt, {
		supported,
		supportNormal = DEFAULT_UP,
		worldUp = DEFAULT_UP,
		velocity = ZERO,
		gravity = DEFAULT_GRAVITY,
		mass = 1,
		jumpPressed = false,
		jumpHeld = false,
		jumpReleased = false,
		desiredDirection = null,
		bodyForward = null,
		sprint = false,
	} ) {

		dt = Math.max( 0, Math.min( 0.1, finiteOr( dt, 0 ) ) );
		this.impulse.x = this.impulse.y = this.impulse.z = 0;
		this.additionalGravity.x = this.additionalGravity.y = this.additionalGravity.z = 0;
		this.airAccelerationVector.x = this.airAccelerationVector.y = this.airAccelerationVector.z = 0;
		this.view.jumped = false;
		setVector( this.worldUp, worldUp, DEFAULT_UP );
		normalize( this.worldUp, DEFAULT_UP );
		if ( jumpPressed ) {

			this.bufferRemaining = Math.max( 0, this.bufferTime );
			this.releaseRequested = Boolean( jumpReleased );

		} else if ( ! this.charging ) {

			this.bufferRemaining = Math.max( 0, this.bufferRemaining - dt );
			if ( this.bufferRemaining <= 0 ) this.releaseRequested = false;

		}
		if ( jumpReleased && ( this.bufferRemaining > 0 || this.charging ) )
			this.releaseRequested = true;
		this.jumpHeld = Boolean( jumpHeld ) && ! jumpReleased;
		this.detachRemaining = Math.max( 0, this.detachRemaining - dt );
		const effectiveSupported = Boolean( supported ) && this.detachRemaining <= 0;
		const verticalSpeed = dot( velocity, this.worldUp );

		if ( effectiveSupported ) {

			setVector( this.lastSupportNormal, supportNormal, this.worldUp );
			normalize( this.lastSupportNormal, this.worldUp );
			this.coyoteRemaining = Math.max( 0, this.coyoteTime );
			this.airborneSeconds = 0;
			this.ballisticCommitted = false;
			if ( ! this.wasSupported ) {

				this.landingRemaining = Math.max( 0, this.landingDuration );
				const impactVerticalSpeed = Math.min(
					verticalSpeed, this.minimumAirborneVerticalSpeed,
				);
				this.view.landingImpact = Math.max( 0, Math.min( 1,
					- impactVerticalSpeed / Math.max( 0.01, this.landingImpactSpeed ),
				) );
				this.phase = JUMP_PHASE.LANDING;

			}
			this.minimumAirborneVerticalSpeed = 0;

		} else {

			this.coyoteRemaining = Math.max( 0, this.coyoteRemaining - dt );
			this.airborneSeconds += dt;
			this.minimumAirborneVerticalSpeed = Math.min(
				this.minimumAirborneVerticalSpeed, verticalSpeed,
			);

		}

		const canBeginCharge = ! this.charging
			&& this.bufferRemaining > 0 && this.coyoteRemaining > 0;
		if ( canBeginCharge ) {

			this.charging = true;
			this.chargeSeconds = 0;
			this.preloadSeconds = 0;
			this.bufferRemaining = 0;

		}
		if ( this.charging ) this.preloadSeconds += dt;
		if ( this.charging && this.jumpHeld )
			this.chargeSeconds = Math.min(
				Math.max( EPSILON, finiteOr( this.maximumChargeTime, 0.22 ) ),
				this.chargeSeconds + dt,
			);
		const maximumCharge = Math.max( EPSILON, finiteOr( this.maximumChargeTime, 0.22 ) );
		const minimumPreload = Math.max( 0, finiteOr( this.minimumPreloadTime, 0.045 ) );
		const rawCharge = saturate( this.chargeSeconds / maximumCharge );
		const charge = smoothstep01( rawCharge );
		// Once a press has been accepted inside coyote time it cannot silently
		// disappear. If the support grace expires during a hold, take off with the
		// charge accumulated so far after the short anatomical preload.
		const supportGraceExpired = this.charging && ! effectiveSupported
			&& this.coyoteRemaining <= 0;
		const shouldLaunch = this.charging
			&& this.preloadSeconds >= minimumPreload - EPSILON
			&& ( this.releaseRequested || supportGraceExpired
				|| this.chargeSeconds >= maximumCharge - EPSILON );
		if ( shouldLaunch ) {

			const minimumHeightRatio = saturate( this.minimumHeightRatio );
			this.launchCharge = charge;
			this.launchHeight = Math.max( 0, finiteOr( this.jumpHeight, 0 ) )
				* ( minimumHeightRatio + ( 1 - minimumHeightRatio ) * charge );
			this.launchForwardSpeed = Math.max( 0, finiteOr( this.minimumForwardSpeed, 0 ) )
				+ Math.max( 0, finiteOr( this.maximumForwardSpeed, 0 )
					- finiteOr( this.minimumForwardSpeed, 0 ) ) * charge;
			if ( sprint ) this.launchForwardSpeed *= Math.max(
				1, finiteOr( this.sprintJumpMultiplier, 1 ),
			);

			this._impulseInput.mass = mass;
			this._impulseInput.velocity = velocity;
			this._impulseInput.worldUp = this.worldUp;
			this._impulseInput.supportNormal = this.lastSupportNormal;
			this._impulseInput.gravity = gravity;
			this._impulseInput.jumpHeight = this.launchHeight;
			this._impulseInput.riseGravityScale = this.riseGravityScale;
			this._impulseInput.supportInfluence = this.supportInfluence;
			this._impulseInput.upInfluence = this.upInfluence;
			const desiredLengthSquared = finiteOr( desiredDirection?.x, 0 ) ** 2
				+ finiteOr( desiredDirection?.y, 0 ) ** 2
				+ finiteOr( desiredDirection?.z, 0 ) ** 2;
			this._impulseInput.forwardDirection = desiredLengthSquared > EPSILON
				? desiredDirection : ( bodyForward ?? desiredDirection ?? ZERO );
			this._impulseInput.forwardSpeed = this.launchForwardSpeed;
			this._impulseInput.sprint = false;
			this._impulseInput.sprintMultiplier = this.sprintJumpMultiplier;
			supportAwareJumpImpulse(
				this._impulseInput, this.impulse, this.launchDirection,
			);
			this.view.jumped = true;
			this.detachRemaining = Math.max( 0, this.detachTime );
			this.coyoteRemaining = 0;
			this.bufferRemaining = 0;
			this.landingRemaining = 0;
			this.view.landingImpact = 0;
			this.phase = JUMP_PHASE.TAKEOFF;
			this.charging = false;
			this.releaseRequested = false;
			this.preloadSeconds = 0;
			this.ballisticCommitted = true;
			this.wasSupported = false;

		} else if ( this.charging ) this.phase = JUMP_PHASE.PRELOAD;
		else if ( effectiveSupported ) {

			if ( this.landingRemaining > 0 ) {

				this.landingRemaining = Math.max( 0, this.landingRemaining - dt );
				this.phase = this.landingRemaining > 0 ? JUMP_PHASE.LANDING : JUMP_PHASE.GROUNDED;

			} else this.phase = JUMP_PHASE.GROUNDED;

		} else if ( this.detachRemaining > 0 ) this.phase = JUMP_PHASE.TAKEOFF;
		else if ( verticalSpeed > this.apexVelocity ) this.phase = JUMP_PHASE.RISING;
		else if ( verticalSpeed >= - this.apexVelocity ) this.phase = JUMP_PHASE.APEX;
		else this.phase = JUMP_PHASE.FALLING;

		let gravityScale = 1;
		if ( ! effectiveSupported ) {

			if ( verticalSpeed > this.apexVelocity )
				gravityScale = this.ballisticCommitted || this.jumpHeld
					? this.riseGravityScale : this.cutGravityScale;
			else if ( verticalSpeed >= - this.apexVelocity ) gravityScale = this.apexGravityScale;
			else gravityScale = this.fallGravityScale;
			this.additionalGravity.x = finiteOr( gravity?.x, 0 ) * ( gravityScale - 1 );
			this.additionalGravity.y = finiteOr( gravity?.y, - 9.81 ) * ( gravityScale - 1 );
			this.additionalGravity.z = finiteOr( gravity?.z, 0 ) * ( gravityScale - 1 );
			this._airInput.velocity = velocity;
			this._airInput.desiredDirection = desiredDirection;
			this._airInput.worldUp = this.worldUp;
			this._airInput.maximumSpeed = this.airMaximumSpeed;
			this._airInput.acceleration = this.airAcceleration;
			this._airInput.braking = this.airBraking;
			airControlAcceleration(
				this._airInput, this.airAccelerationVector, this._airScratch,
			);

		}

		const landingProgress = this.landingDuration > EPSILON
			? this.landingRemaining / this.landingDuration : 0;
		const preload = this.charging ? 0.18 + 0.82 * charge : 0;
		const takeoffExtension = this.detachTime > EPSILON && this.detachRemaining > 0
			? saturate( this.detachRemaining / this.detachTime ) : 0;
		let airborneTuck = 0;
		if ( this.phase === JUMP_PHASE.RISING ) airborneTuck = 0.16
			+ 0.26 * saturate( this.airborneSeconds / 0.18 );
		else if ( this.phase === JUMP_PHASE.APEX ) airborneTuck = 0.58;
		else if ( this.phase === JUMP_PHASE.FALLING ) airborneTuck = 0.36;
		this.view.phase = this.phase;
		this.view.gravityScale = gravityScale;
		this.view.releaseSupport = this.detachRemaining > 0;
		this.view.charging = this.charging;
		this.view.charge = this.charging ? charge : this.launchCharge;
		this.view.chargeSeconds = this.chargeSeconds;
		this.view.targetJumpHeight = this.launchHeight;
		this.view.targetForwardSpeed = this.launchForwardSpeed;
		this.view.preloadCompression = preload;
		this.view.takeoffExtension = takeoffExtension;
		this.view.airborneTuck = airborneTuck;
		this.view.forwardLean = this.charging
			? 0.12 + 0.28 * charge
			: ( this.detachRemaining > 0 ? 0.42 : airborneTuck * 0.42 );
		this.view.muscleCompliance = this.charging ? 0.04
			: ( this.detachRemaining > 0 ? 0.18
				: ( effectiveSupported ? 0 : 0.18 + airborneTuck * 0.25 ) );
		this.view.landingCompression = this.view.landingImpact * landingProgress * landingProgress;
		if ( this.phase === JUMP_PHASE.GROUNDED ) this.view.landingImpact = 0;
		this.view.coyoteRemaining = this.coyoteRemaining;
		this.view.bufferRemaining = this.bufferRemaining;
		this.view.airborneSeconds = this.airborneSeconds;
		this.wasSupported = effectiveSupported;
		return this.view;

	}

}
