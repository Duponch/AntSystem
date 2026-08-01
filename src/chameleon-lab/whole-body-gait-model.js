/**
 * Allocation-free whole-body pose generator for the hybrid chameleon lab.
 *
 * The foot trajectory remains authoritative: this layer only prepares a
 * coherent anatomical pose before the contact IK closes the last centimetres.
 * Diagonal couplets therefore move the shoulder and hip first, flex the elbow
 * or knee during swing, transfer weight to the opposite side, and counter-rotate
 * the trunk while the head is stabilised.
 */

export const WHOLE_BODY_POSE_SIZE = 24;

export const WHOLE_BODY_POSE = Object.freeze( {
	STRIDE_0: 0,
	STRIDE_1: 1,
	STRIDE_2: 2,
	STRIDE_3: 3,
	LIFT_0: 4,
	LIFT_1: 5,
	LIFT_2: 6,
	LIFT_3: 7,
	FLEX_0: 8,
	FLEX_1: 9,
	FLEX_2: 10,
	FLEX_3: 11,
	PELVIS_YAW: 12,
	PELVIS_ROLL: 13,
	PELVIS_BOB: 14,
	CHEST_YAW: 15,
	CHEST_ROLL: 16,
	CHEST_PITCH: 17,
	NECK_YAW: 18,
	NECK_PITCH: 19,
	HEAD_YAW: 20,
	HEAD_PITCH: 21,
	SUPPORT_SHIFT: 22,
	MOTION_WEIGHT: 23,
} );

const PAIR_BY_FOOT = new Int8Array( [ 0, 1, 1, 0 ] );
const SIDE_BY_FOOT = new Int8Array( [ 1, -1, 1, -1 ] );
const EMPTY_INPUT = Object.freeze( {} );

function clamp( value, minimum, maximum ) {

	return value < minimum ? minimum : value > maximum ? maximum : value;

}

function smootherstep01( value ) {

	const t = clamp( value, 0, 1 );
	return t * t * t * ( t * ( t * 6 - 15 ) + 10 );

}

function rangedSmootherstep( value, start, end ) {

	return smootherstep01( ( value - start ) / ( end - start ) );

}

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function pairProgress( gaitView ) {

	const pair = gaitView?.activePair ?? -1;
	if ( pair !== 0 && pair !== 1 ) return 0.5;
	const phase = gaitView.footPhase;
	const firstFoot = pair === 0 ? 0 : 1;
	const secondFoot = pair === 0 ? 3 : 2;
	return clamp( Math.max(
		finiteOr( phase?.[ firstFoot ], 0 ),
		finiteOr( phase?.[ secondFoot ], 0 ),
	), 0, 1 );

}

function strokeAdvance( progress ) {

	// A limb first folds upwards, travels forwards only once clear, then keeps
	// its reach while the palm is lowered onto the new support.
	return rangedSmootherstep( progress, 0.10, 0.86 );

}

function strokeLift( progress ) {

	return Math.min(
		rangedSmootherstep( progress, 0, 0.18 ),
		rangedSmootherstep( 1 - progress, 0, 0.26 ),
	);

}

export function writeWholeBodyTarget( {
	gaitView,
	speed = 0,
	strideAmplitude = 0.38,
	limbLift = 0.24,
	jointFlex = 0.46,
	bodyMotion = 1,
	attentionTime = 0,
	attentionSeed = 0.73,
}, target ) {

	if ( ! target || target.length < WHOLE_BODY_POSE_SIZE )
		throw new RangeError( 'whole-body target buffer is too short' );

	const activePair = gaitView?.activePair ?? -1;
	const moving = clamp( finiteOr( speed, 0 ) / 0.32, 0, 1 );
	const progress = pairProgress( gaitView );
	const advance = strokeAdvance( progress );
	let diagonal = activePair === 0
		? -1 + advance * 2
		: activePair === 1 ? 1 - advance * 2 : 0;
	// There is normally one fixed tick between two diagonal couplets. Preserve
	// the completed stroke during that tick instead of snapping every proximal
	// joint back to its neutral pose and immediately out again.
	if ( activePair < 0 && moving > 0 ) {

		const nextPair = gaitView?.nextPair;
		if ( nextPair === 1 ) diagonal = 1;
		else if ( nextPair === 0 ) diagonal = -1;

	}
	const liftEnvelope = activePair < 0 ? 0 : strokeLift( progress );
	const strokePulse = activePair < 0 ? 0 : 4 * advance * ( 1 - advance );
	const stride = clamp( finiteOr( strideAmplitude, 0.38 ), 0, 0.9 ) * moving;
	const lift = clamp( finiteOr( limbLift, 0.24 ), 0, 0.75 ) * moving;
	const flex = clamp( finiteOr( jointFlex, 0.46 ), 0, 1.15 ) * moving;
	const body = clamp( finiteOr( bodyMotion, 1 ), 0, 2 ) * moving;
	const idle = 1 - moving;
	const attention = finiteOr( attentionTime, 0 );
	const seed = finiteOr( attentionSeed, 0.73 );
	// Two deliberately incommensurate bands create slow observation arcs plus
	// tiny corrective glances without random state or per-frame allocations.
	const idleNeckYaw = idle * (
		Math.sin( attention * 0.43 + seed * 2.1 ) * 0.105
		+ Math.sin( attention * 0.91 + seed * 5.7 ) * 0.038
	);
	const idleNeckPitch = idle * (
		Math.sin( attention * 0.31 + seed * 3.4 ) * 0.034
		+ Math.sin( attention * 0.73 + seed ) * 0.012
	);
	const idleHeadYaw = idle * Math.sin( attention * 0.67 + seed * 7.3 ) * 0.055;
	const idleHeadPitch = idle * Math.sin( attention * 0.53 + seed * 4.6 ) * 0.022;
	const breathing = idle * Math.sin( attention * 1.37 + seed ) * 0.0045;
	const idleBodyScale = idle * clamp( finiteOr( bodyMotion, 1 ), 0, 2 );
	// Breathing is regular, but balance and observation are not. Two very slow
	// incommensurate bands add a restrained weight transfer without moving the
	// planted contact targets or turning the idle into a looping animation clip.
	const idleBodyYaw = idleBodyScale * (
		Math.sin( attention * 0.19 + seed * 4.1 ) * 0.010
		+ Math.sin( attention * 0.47 + seed * 1.7 ) * 0.0035
	);
	const idleBodyRoll = idleBodyScale * (
		Math.sin( attention * 0.23 + seed * 2.6 ) * 0.006
		+ Math.sin( attention * 0.71 + seed * 5.2 ) * 0.002
	);

	for ( let foot = 0; foot < 4; foot ++ ) {

		const pairSign = PAIR_BY_FOOT[ foot ] === 0 ? diagonal : -diagonal;
		const isSwing = activePair === PAIR_BY_FOOT[ foot ];
		const isFront = foot < 2;
		// The anterior limbs lead the stroke from the shoulder. Their larger
		// sweep/abduction is intentional: it reads as a broad breast-stroke arc,
		// while the rear limbs provide a slightly tighter propulsive step.
		const proximalSweep = isFront ? 1.16 : 1;
		const proximalLift = isFront ? 2 : 1.20;
		target[ WHOLE_BODY_POSE.STRIDE_0 + foot ] = pairSign * stride * proximalSweep;
		target[ WHOLE_BODY_POSE.LIFT_0 + foot ] = isSwing
			? liftEnvelope * lift * proximalLift * SIDE_BY_FOOT[ foot ]
			: -0.018 * strokePulse * SIDE_BY_FOOT[ foot ] * moving;
		target[ WHOLE_BODY_POSE.FLEX_0 + foot ] = isSwing
			? ( 0.08 + ( liftEnvelope * 0.96 + strokePulse * 0.08 )
				* ( isFront ? 1.16 : 1 ) ) * flex
			: ( 0.08 + strokePulse * 0.07 ) * flex;

	}

	// Pelvis and thorax counter-rotate, creating a visible but restrained axial
	// wave.  The head receives the inverse movement to keep the gaze stable.
	target[ WHOLE_BODY_POSE.PELVIS_YAW ] = -diagonal * 0.13 * body;
	target[ WHOLE_BODY_POSE.PELVIS_ROLL ] = diagonal * 0.052 * body;
	target[ WHOLE_BODY_POSE.PELVIS_BOB ] = strokePulse * 0.014 * body + breathing * 0.35;
	target[ WHOLE_BODY_POSE.CHEST_YAW ] = diagonal * 0.055 * body - idleBodyYaw * 0.58;
	target[ WHOLE_BODY_POSE.CHEST_ROLL ] = -diagonal * 0.034 * body - idleBodyRoll * 0.72;
	target[ WHOLE_BODY_POSE.CHEST_PITCH ] = -strokePulse * 0.028 * body + breathing;
	target[ WHOLE_BODY_POSE.NECK_YAW ] = diagonal * 0.045 * body + idleNeckYaw;
	target[ WHOLE_BODY_POSE.NECK_PITCH ] = strokePulse * 0.018 * body + idleNeckPitch;
	target[ WHOLE_BODY_POSE.HEAD_YAW ] = diagonal * 0.025 * body + idleHeadYaw;
	target[ WHOLE_BODY_POSE.HEAD_PITCH ] = strokePulse * 0.012 * body + idleHeadPitch;
	target[ WHOLE_BODY_POSE.SUPPORT_SHIFT ] = -diagonal * 0.012 * body;
	// Individual locomotor lanes are already attenuated by `moving`, while the
	// idle neck/head lanes are deliberately subtle.  Keeping a second 0.35
	// multiplier here made the cervical joints nearly static in the final rig.
	target[ WHOLE_BODY_POSE.MOTION_WEIGHT ] = 1;
	return target;

}

export class WholeBodyGaitModel {

	constructor( { responseFrequency = 8.5, dampingRatio = 1 } = {} ) {

		this.responseFrequency = Math.max( 0.1, finiteOr( responseFrequency, 8.5 ) );
		this.dampingRatio = Math.max( 0.2, finiteOr( dampingRatio, 1 ) );
		this.previous = new Float32Array( WHOLE_BODY_POSE_SIZE );
		this.current = new Float32Array( WHOLE_BODY_POSE_SIZE );
		this.velocity = new Float32Array( WHOLE_BODY_POSE_SIZE );
		this.target = new Float32Array( WHOLE_BODY_POSE_SIZE );
		this.render = new Float32Array( WHOLE_BODY_POSE_SIZE );
		// Exact spring coefficients are shared by all 24 scalar lanes and cached.
		// With the lab's fixed step, transcendental work therefore occurs once at
		// construction/reset scale, not once per limb or render frame.
		this._coefficientDt = -1;
		this._coefficientFrequency = -1;
		this._coefficientRatio = -1;
		this._critical = true;
		this._underDamped = false;
		this._omega = 0;
		this._decay = 0;
		this._sine = 0;
		this._cosine = 0;
		this._dampedOmega = 0;
		this._slowRoot = 0;
		this._fastRoot = 0;
		this._slowDecay = 0;
		this._fastDecay = 0;
		this._view = Object.seal( {
			previous: this.previous,
			current: this.current,
			target: this.target,
			render: this.render,
		} );

	}

	reset() {

		this.previous.fill( 0 );
		this.current.fill( 0 );
		this.velocity.fill( 0 );
		this.target.fill( 0 );
		this.render.fill( 0 );
		return this._view;

	}

	update( dt, input ) {

		dt = clamp( finiteOr( dt, 0 ), 0, 1 / 20 );
		this.previous.set( this.current );
		writeWholeBodyTarget( input || EMPTY_INPUT, this.target );
		const ratio = this.dampingRatio;
		if ( dt !== this._coefficientDt
			|| this.responseFrequency !== this._coefficientFrequency
			|| ratio !== this._coefficientRatio ) {

			this._coefficientDt = dt;
			this._coefficientFrequency = this.responseFrequency;
			this._coefficientRatio = ratio;
			this._omega = this.responseFrequency * Math.PI * 2;
			this._critical = Math.abs( ratio - 1 ) < 1e-4;
			this._underDamped = ratio < 1 && ! this._critical;
			if ( this._critical ) {

				this._decay = Math.exp( -this._omega * dt );

			} else if ( this._underDamped ) {

				this._dampedOmega = this._omega * Math.sqrt(
					Math.max( 0, 1 - ratio * ratio ),
				);
				this._decay = Math.exp( -ratio * this._omega * dt );
				const angle = this._dampedOmega * dt;
				this._sine = Math.sin( angle );
				this._cosine = Math.cos( angle );

			} else {

				const root = Math.sqrt( Math.max( 0, ratio * ratio - 1 ) );
				this._slowRoot = -this._omega * ( ratio - root );
				this._fastRoot = -this._omega * ( ratio + root );
				this._slowDecay = Math.exp( this._slowRoot * dt );
				this._fastDecay = Math.exp( this._fastRoot * dt );

			}

		}
		const omega = this._omega;
		const critical = this._critical;
		const underDamped = this._underDamped;
		const decay = this._decay;
		const sine = this._sine;
		const cosine = this._cosine;
		const dampedOmega = this._dampedOmega;
		const slowRoot = this._slowRoot;
		const fastRoot = this._fastRoot;
		const slowDecay = this._slowDecay;
		const fastDecay = this._fastDecay;
		for ( let index = 0; index < WHOLE_BODY_POSE_SIZE; index ++ ) {

			const target = this.target[ index ];
			const displacement = this.current[ index ] - target;
			const velocity = this.velocity[ index ];
			let nextDisplacement;
			let nextVelocity;
			if ( critical ) {

				const junction = velocity + omega * displacement;
				nextDisplacement = ( displacement + junction * dt ) * decay;
				nextVelocity = ( velocity - omega * junction * dt ) * decay;

			} else if ( underDamped ) {

				const quadrature = ( velocity + ratio * omega * displacement ) /
					dampedOmega;
				const wave = displacement * cosine + quadrature * sine;
				const waveVelocity = -displacement * dampedOmega * sine
					+ quadrature * dampedOmega * cosine;
				nextDisplacement = decay * wave;
				nextVelocity = decay * ( waveVelocity - ratio * omega * wave );

			} else {

				const denominator = slowRoot - fastRoot;
				const slowWeight = ( velocity - fastRoot * displacement ) / denominator;
				const fastWeight = displacement - slowWeight;
				nextDisplacement = slowWeight * slowDecay + fastWeight * fastDecay;
				nextVelocity = slowRoot * slowWeight * slowDecay
					+ fastRoot * fastWeight * fastDecay;

			}
			this.current[ index ] = target + nextDisplacement;
			this.velocity[ index ] = nextVelocity;
			if ( ! Number.isFinite( this.current[ index ] ) || ! Number.isFinite( this.velocity[ index ] ) ) {

				this.current[ index ] = this.target[ index ];
				this.velocity[ index ] = 0;

			}

		}
		return this._view;

	}

	interpolate( alpha = 1 ) {

		const t = clamp( finiteOr( alpha, 1 ), 0, 1 );
		for ( let index = 0; index < WHOLE_BODY_POSE_SIZE; index ++ )
			this.render[ index ] = this.previous[ index ]
				+ ( this.current[ index ] - this.previous[ index ] ) * t;
		return this.render;

	}

	getView() {

		return this._view;

	}

}
