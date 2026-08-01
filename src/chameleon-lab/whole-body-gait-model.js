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
const EPSILON = 1e-8;

function clamp( value, minimum, maximum ) {

	return value < minimum ? minimum : value > maximum ? maximum : value;

}

function smoothstep01( value ) {

	const t = clamp( value, 0, 1 );
	return t * t * ( 3 - 2 * t );

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
	return smoothstep01( Math.max(
		finiteOr( phase?.[ firstFoot ], 0 ),
		finiteOr( phase?.[ secondFoot ], 0 ),
	) );

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
	const diagonal = activePair === 0
		? -1 + progress * 2
		: activePair === 1 ? 1 - progress * 2 : 0;
	const swingEnvelope = activePair < 0 ? 0 : Math.sin( progress * Math.PI );
	const stride = clamp( finiteOr( strideAmplitude, 0.38 ), 0, 0.72 ) * moving;
	const lift = clamp( finiteOr( limbLift, 0.24 ), 0, 0.55 ) * moving;
	const flex = clamp( finiteOr( jointFlex, 0.46 ), 0, 0.9 ) * moving;
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

	for ( let foot = 0; foot < 4; foot ++ ) {

		const pairSign = PAIR_BY_FOOT[ foot ] === 0 ? diagonal : -diagonal;
		const isSwing = activePair === PAIR_BY_FOOT[ foot ];
		target[ WHOLE_BODY_POSE.STRIDE_0 + foot ] = pairSign * stride;
		target[ WHOLE_BODY_POSE.LIFT_0 + foot ] = isSwing
			? swingEnvelope * lift * SIDE_BY_FOOT[ foot ]
			: -0.025 * pairSign * SIDE_BY_FOOT[ foot ] * moving;
		target[ WHOLE_BODY_POSE.FLEX_0 + foot ] = isSwing
			? ( 0.22 + swingEnvelope * 0.78 ) * flex
			: ( 0.07 + Math.abs( pairSign ) * 0.08 ) * flex;

	}

	// Pelvis and thorax counter-rotate, creating a visible but restrained axial
	// wave.  The head receives the inverse movement to keep the gaze stable.
	target[ WHOLE_BODY_POSE.PELVIS_YAW ] = -diagonal * 0.13 * body;
	target[ WHOLE_BODY_POSE.PELVIS_ROLL ] = diagonal * 0.052 * body;
	target[ WHOLE_BODY_POSE.PELVIS_BOB ] = swingEnvelope * 0.014 * body + breathing * 0.35;
	target[ WHOLE_BODY_POSE.CHEST_YAW ] = diagonal * 0.055 * body;
	target[ WHOLE_BODY_POSE.CHEST_ROLL ] = -diagonal * 0.034 * body;
	target[ WHOLE_BODY_POSE.CHEST_PITCH ] = -swingEnvelope * 0.028 * body + breathing;
	target[ WHOLE_BODY_POSE.NECK_YAW ] = diagonal * 0.045 * body + idleNeckYaw;
	target[ WHOLE_BODY_POSE.NECK_PITCH ] = swingEnvelope * 0.018 * body + idleNeckPitch;
	target[ WHOLE_BODY_POSE.HEAD_YAW ] = diagonal * 0.025 * body + idleHeadYaw;
	target[ WHOLE_BODY_POSE.HEAD_PITCH ] = swingEnvelope * 0.012 * body + idleHeadPitch;
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
		writeWholeBodyTarget( input || {}, this.target );
		const omega = this.responseFrequency * Math.PI * 2;
		const damping = 2 * this.dampingRatio * omega;
		const stiffness = omega * omega;
		for ( let index = 0; index < WHOLE_BODY_POSE_SIZE; index ++ ) {

			const acceleration = ( this.target[ index ] - this.current[ index ] ) * stiffness
				- this.velocity[ index ] * damping;
			this.velocity[ index ] += acceleration * dt;
			this.current[ index ] += this.velocity[ index ] * dt;
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
