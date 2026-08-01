/**
 * Deterministic, allocation-free cervical look controller shared by the
 * chameleon laboratory and the ecosystem renderer.
 *
 * Angles use the chameleon's anatomical/model frame: yaw is positive towards
 * model +Z and pitch is positive upwards.  The renderer remains responsible
 * for converting those scalar lanes to bone rotations (the current physical
 * rig applies the opposite sign around model +Z for an upward pitch).
 */

export const CHAMELEON_HEAD_LOOK_SIZE = 5;

export const CHAMELEON_HEAD_LOOK = Object.freeze( {
	NECK_YAW: 0,
	NECK_PITCH: 1,
	HEAD_YAW: 2,
	HEAD_PITCH: 3,
	TARGET_WEIGHT: 4,
} );

const EMPTY_INPUT = Object.freeze( {} );

function clamp( value, minimum, maximum ) {

	return value < minimum ? minimum : value > maximum ? maximum : value;

}

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function unitFromUint32( value ) {

	return ( value >>> 0 ) / 0x100000000;

}

export class ChameleonHeadLookModel {

	constructor( {
		seed = 0x7f4a7c15,
		responseFrequency = 5.2,
		weightResponseFrequency = 4.5,
		neckShare = 0.62,
		neckYawLimit = 0.72,
		headYawLimit = 0.55,
		neckPitchDownLimit = 0.34,
		neckPitchUpLimit = 0.30,
		headPitchDownLimit = 0.26,
		headPitchUpLimit = 0.23,
		idleYawLimit = 0.48,
		idlePitchDownLimit = 0.12,
		idlePitchUpLimit = 0.18,
		neckYawSpeed = 2.4,
		neckPitchSpeed = 1.8,
		headYawSpeed = 2.8,
		headPitchSpeed = 2,
	} = {} ) {

		this.seed = Number.isInteger( seed ) ? seed >>> 0 : 0x7f4a7c15;
		this.initialSeed = this.seed || 0x7f4a7c15;
		this.responseFrequency = Math.max( 0.1, finiteOr( responseFrequency, 5.2 ) );
		this.weightResponseFrequency = Math.max(
			0.1, finiteOr( weightResponseFrequency, 4.5 ),
		);
		this.neckShare = clamp( finiteOr( neckShare, 0.62 ), 0, 1 );
		this.neckYawMinimum = -Math.max( 0, finiteOr( neckYawLimit, 0.72 ) );
		this.neckYawMaximum = -this.neckYawMinimum;
		this.headYawMinimum = -Math.max( 0, finiteOr( headYawLimit, 0.55 ) );
		this.headYawMaximum = -this.headYawMinimum;
		this.neckPitchMinimum = -Math.max( 0, finiteOr( neckPitchDownLimit, 0.34 ) );
		this.neckPitchMaximum = Math.max( 0, finiteOr( neckPitchUpLimit, 0.30 ) );
		this.headPitchMinimum = -Math.max( 0, finiteOr( headPitchDownLimit, 0.26 ) );
		this.headPitchMaximum = Math.max( 0, finiteOr( headPitchUpLimit, 0.23 ) );
		this.idleYawLimit = Math.max( 0, finiteOr( idleYawLimit, 0.48 ) );
		this.idlePitchMinimum = -Math.max( 0, finiteOr( idlePitchDownLimit, 0.12 ) );
		this.idlePitchMaximum = Math.max( 0, finiteOr( idlePitchUpLimit, 0.18 ) );

		this.previous = new Float32Array( CHAMELEON_HEAD_LOOK_SIZE );
		this.current = new Float32Array( CHAMELEON_HEAD_LOOK_SIZE );
		this.velocity = new Float32Array( CHAMELEON_HEAD_LOOK_SIZE );
		this.target = new Float32Array( CHAMELEON_HEAD_LOOK_SIZE );
		this.render = new Float32Array( CHAMELEON_HEAD_LOOK_SIZE );
		this.maximumSpeed = new Float32Array( [
			Math.max( 0.05, finiteOr( neckYawSpeed, 2.4 ) ),
			Math.max( 0.05, finiteOr( neckPitchSpeed, 1.8 ) ),
			Math.max( 0.05, finiteOr( headYawSpeed, 2.8 ) ),
			Math.max( 0.05, finiteOr( headPitchSpeed, 2 ) ),
			6,
		] );
		this.minimum = new Float32Array( [
			this.neckYawMinimum,
			this.neckPitchMinimum,
			this.headYawMinimum,
			this.headPitchMinimum,
			0,
		] );
		this.maximum = new Float32Array( [
			this.neckYawMaximum,
			this.neckPitchMaximum,
			this.headYawMaximum,
			this.headPitchMaximum,
			1,
		] );

		this.externalYaw = 0;
		this.externalPitch = 0;
		this.externalWeight = 0;
		this.idleWeight = 1;
		this.idleYaw = 0;
		this.idlePitch = 0;
		this.microYaw = 0;
		this.microPitch = 0;
		this.fixationRemaining = 0;
		this.microRemaining = 0;
		this.fixationIndex = 0;
		this.microIndex = 0;
		this._view = Object.seal( {
			previous: this.previous,
			current: this.current,
			target: this.target,
			render: this.render,
			fixationIndex: 0,
			microIndex: 0,
			fixationRemaining: 0,
			microRemaining: 0,
			externalWeight: 0,
		} );
		this.reset();

	}

	_random() {

		// xorshift32: deterministic on every JS engine and no allocation/state
		// object in the fixed-step path.
		let value = this.seed || 0x7f4a7c15;
		value ^= value << 13;
		value ^= value >>> 17;
		value ^= value << 5;
		this.seed = value >>> 0;
		return unitFromUint32( this.seed );

	}

	_chooseFixation() {

		const previousYaw = this.idleYaw;
		let yaw = ( this._random() * 2 - 1 ) * this.idleYawLimit;
		// A new fixation must read as an intentional glance. Prevent tiny repeated
		// destinations while retaining the asymmetric sequence produced by the PRNG.
		if ( Math.abs( yaw - previousYaw ) < 0.105 ) {

			yaw += yaw >= previousYaw ? 0.145 : -0.145;
			yaw = clamp( yaw, -this.idleYawLimit, this.idleYawLimit );

		}
		const pitchUnit = this._random();
		// Slight upward bias mirrors observation from a support without producing
		// a regular pendulum motion.
		const pitch = pitchUnit < 0.42
			? this.idlePitchMinimum * ( 1 - pitchUnit / 0.42 )
			: this.idlePitchMaximum * ( ( pitchUnit - 0.42 ) / 0.58 );
		this.idleYaw = yaw;
		this.idlePitch = pitch;
		const dwellShape = this._random();
		this.fixationRemaining = 0.78 + Math.pow( dwellShape, 0.72 ) * 2.45;
		this.fixationIndex ++;

	}

	_chooseMicroCorrection() {

		const stillness = this._random();
		if ( stillness < 0.28 ) {

			this.microYaw = 0;
			this.microPitch = 0;

		} else {

			this.microYaw = ( this._random() * 2 - 1 ) * 0.038;
			this.microPitch = ( this._random() * 2 - 1 ) * 0.018;

		}
		this.microRemaining = 0.22 + this._random() * 0.48;
		this.microIndex ++;

	}

	_advanceIdleClock( dt ) {

		let remaining = dt;
		while ( remaining > 1e-10 ) {

			const untilEvent = Math.min( this.fixationRemaining, this.microRemaining );
			if ( untilEvent > remaining ) {

				this.fixationRemaining -= remaining;
				this.microRemaining -= remaining;
				break;

			}
			this.fixationRemaining -= untilEvent;
			this.microRemaining -= untilEvent;
			remaining -= untilEvent;
			if ( this.fixationRemaining <= 1e-10 ) this._chooseFixation();
			if ( this.microRemaining <= 1e-10 ) this._chooseMicroCorrection();

		}

	}

	_writeBoundedPair(
		total, share, neckIndex, headIndex,
		neckMinimum, neckMaximum, headMinimum, headMaximum,
	) {

		total = clamp( total, neckMinimum + headMinimum, neckMaximum + headMaximum );
		const minimum = Math.max( neckMinimum, total - headMaximum );
		const maximum = Math.min( neckMaximum, total - headMinimum );
		const neck = clamp( total * share, minimum, maximum );
		this.target[ neckIndex ] = neck;
		this.target[ headIndex ] = total - neck;

	}

	_integrateLane( index, dt, omega, decay ) {

		const target = this.target[ index ];
		const displacement = this.current[ index ] - target;
		const velocity = this.velocity[ index ];
		const junction = velocity + omega * displacement;
		let next = target + ( displacement + junction * dt ) * decay;
		let nextVelocity = ( velocity - omega * junction * dt ) * decay;
		const speedLimit = this.maximumSpeed[ index ];
		nextVelocity = clamp( nextVelocity, -speedLimit, speedLimit );
		const minimum = this.minimum[ index ];
		const maximum = this.maximum[ index ];
		if ( next <= minimum ) {

			next = minimum;
			if ( nextVelocity < 0 ) nextVelocity = 0;

		} else if ( next >= maximum ) {

			next = maximum;
			if ( nextVelocity > 0 ) nextVelocity = 0;

		}
		if ( ! Number.isFinite( next ) || ! Number.isFinite( nextVelocity ) ) {

			next = target;
			nextVelocity = 0;

		}
		this.current[ index ] = next;
		this.velocity[ index ] = nextVelocity;

	}

	setTarget( yaw, pitch, weight = 1 ) {

		this.externalYaw = finiteOr( yaw, 0 );
		this.externalPitch = finiteOr( pitch, 0 );
		this.externalWeight = clamp( finiteOr( weight, 0 ), 0, 1 );
		return this;

	}

	clearTarget() {

		this.externalWeight = 0;
		return this;

	}

	setIdleWeight( weight ) {

		this.idleWeight = clamp( finiteOr( weight, 1 ), 0, 1 );
		return this;

	}

	reset( seed = this.initialSeed ) {

		this.seed = Number.isInteger( seed ) && seed !== 0 ? seed >>> 0 : this.initialSeed;
		this.previous.fill( 0 );
		this.current.fill( 0 );
		this.velocity.fill( 0 );
		this.target.fill( 0 );
		this.render.fill( 0 );
		this.externalYaw = 0;
		this.externalPitch = 0;
		this.externalWeight = 0;
		this.idleWeight = 1;
		this.idleYaw = 0;
		this.idlePitch = 0;
		this.microYaw = 0;
		this.microPitch = 0;
		this.fixationRemaining = 0;
		this.microRemaining = 0;
		this.fixationIndex = 0;
		this.microIndex = 0;
		this._chooseFixation();
		this._chooseMicroCorrection();
		this._syncView();
		return this._view;

	}

	_syncView() {

		this._view.fixationIndex = this.fixationIndex;
		this._view.microIndex = this.microIndex;
		this._view.fixationRemaining = this.fixationRemaining;
		this._view.microRemaining = this.microRemaining;
		this._view.externalWeight = this.externalWeight;

	}

	updateFixed( dt, input = EMPTY_INPUT ) {

		if ( ! Number.isFinite( dt ) || dt < 0 )
			throw new RangeError( 'head look dt must be a finite non-negative number' );
		if ( input && input !== EMPTY_INPUT ) {

			const yaw = input.targetYaw === undefined ? this.externalYaw : input.targetYaw;
			const pitch = input.targetPitch === undefined ? this.externalPitch : input.targetPitch;
			const weight = input.targetWeight === undefined
				? this.externalWeight : input.targetWeight;
			this.setTarget( yaw, pitch, weight );
			if ( input.idleWeight !== undefined ) this.setIdleWeight( input.idleWeight );

		}
		this.previous.set( this.current );
		this._advanceIdleClock( dt );

		const externalWeight = this.externalWeight;
		const idleBlend = this.idleWeight * ( 1 - externalWeight );
		const idleYaw = clamp(
			this.idleYaw + this.microYaw,
			-this.idleYawLimit,
			this.idleYawLimit,
		);
		const idlePitch = clamp(
			this.idlePitch + this.microPitch,
			this.idlePitchMinimum,
			this.idlePitchMaximum,
		);
		const totalYaw = idleYaw * idleBlend + this.externalYaw * externalWeight;
		const totalPitch = idlePitch * idleBlend + this.externalPitch * externalWeight;
		this._writeBoundedPair(
			totalYaw, this.neckShare,
			CHAMELEON_HEAD_LOOK.NECK_YAW, CHAMELEON_HEAD_LOOK.HEAD_YAW,
			this.neckYawMinimum, this.neckYawMaximum,
			this.headYawMinimum, this.headYawMaximum,
		);
		this._writeBoundedPair(
			totalPitch, this.neckShare,
			CHAMELEON_HEAD_LOOK.NECK_PITCH, CHAMELEON_HEAD_LOOK.HEAD_PITCH,
			this.neckPitchMinimum, this.neckPitchMaximum,
			this.headPitchMinimum, this.headPitchMaximum,
		);
		this.target[ CHAMELEON_HEAD_LOOK.TARGET_WEIGHT ] = externalWeight;

		if ( dt > 0 ) {

			const angleOmega = this.responseFrequency * Math.PI * 2;
			const weightOmega = this.weightResponseFrequency * Math.PI * 2;
			const angleDecay = Math.exp( -angleOmega * dt );
			const weightDecay = Math.exp( -weightOmega * dt );
			for ( let index = 0; index < CHAMELEON_HEAD_LOOK.TARGET_WEIGHT; index ++ )
				this._integrateLane( index, dt, angleOmega, angleDecay );
			this._integrateLane(
				CHAMELEON_HEAD_LOOK.TARGET_WEIGHT, dt, weightOmega, weightDecay,
			);

		}
		this._syncView();
		return this._view;

	}

	interpolate( alpha = 1 ) {

		const blend = clamp( finiteOr( alpha, 1 ), 0, 1 );
		for ( let index = 0; index < CHAMELEON_HEAD_LOOK_SIZE; index ++ )
			this.render[ index ] = this.previous[ index ]
				+ ( this.current[ index ] - this.previous[ index ] ) * blend;
		return this.render;

	}

	getView() {

		return this._view;

	}

}
