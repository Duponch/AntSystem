/**
 * Constant-cost anatomical limb solver for the physical chameleon lab.
 *
 * The asset contract is deliberately encoded here instead of inferred every
 * frame: every deform bone points along local +Y, the animal looks towards
 * model -X, model +Y is dorsal/up and model +Z is its right side.  In the
 * exported rest pose, `.L` consequently lies towards -Z and `.R` towards +Z.
 *
 * A limb is solved as a mobile girdle followed by an analytic two-bone chain.
 * The palm is a complete oriented contact patch (wrist, palm end and both digit
 * pads), not a single point target.  All buffers are allocated by constructors;
 * `solve()` and `update()` allocate nothing and have a fixed operation count.
 */

const EPSILON = 1e-9;
const PI = Math.PI;

export const CHAMELEON_RIG_AXES = Object.freeze( {
	restBoneAxis: Object.freeze( [ 0, 1, 0 ] ),
	forward: Object.freeze( [ -1, 0, 0 ] ),
	up: Object.freeze( [ 0, 1, 0 ] ),
	right: Object.freeze( [ 0, 0, 1 ] ),
	leftSideSign: -1,
	rightSideSign: 1,
} );

function frozenPreset( preset ) {

	return Object.freeze( {
		...preset,
		lengths: Object.freeze( preset.lengths ),
		restGirdle: Object.freeze( preset.restGirdle ),
	} );

}

// Mean of the mirrored .L/.R values published by ChameleonPhysical.glb 3.1.
// Order: girdle, upper arm/thigh, forearm/shin, palm/sole, inner and outer digit.
export const CHAMELEON_LIMB_PRESETS = Object.freeze( {
	front: frozenPreset( {
		kind: 'front',
		lengths: [
			0.0908294991,
			0.1172604114,
			0.1752854735,
			0.0304663079,
			0.0951505489,
			0.0386974979,
		],
		// Components in [ forward, up, outward ] body space.
		restGirdle: [ -0.275239, -0.385334, 0.880764 ],
		girdleSwingLimit: 1.08,
		minimumFlexion: 0.16,
		maximumFlexion: 2.62,
		palmYaw: 0.08,
		toeSplay: 0.43,
		preferredReach: 0.248,
	} ),
	hind: frozenPreset( {
		kind: 'hind',
		lengths: [
			0.0935414433,
			0.0951315053,
			0.1411559656,
			0.0927361995,
			0.0985908285,
			0.0399224274,
		],
		restGirdle: [ -0.320713, 0.267261, 0.908688 ],
		girdleSwingLimit: 1.12,
		minimumFlexion: 0.18,
		maximumFlexion: 2.66,
		palmYaw: -0.06,
		toeSplay: 0.46,
		preferredReach: 0.202,
	} ),
} );

export const ANATOMICAL_POSITION = Object.freeze( {
	SOCKET: 0,
	SHOULDER: 3,
	ELBOW: 6,
	WRIST: 9,
	PALM_CENTER: 12,
	PALM_END: 15,
	DIGIT_INNER: 18,
	DIGIT_OUTER: 21,
	SIZE: 24,
} );

export const ANATOMICAL_FRAME = Object.freeze( {
	GIRDLE: 0,
	UPPER: 4,
	LOWER: 8,
	PALM: 12,
	SIZE: 16,
} );

export const ANATOMICAL_METRIC = Object.freeze( {
	REACH_RESIDUAL: 0,
	FLEXION: 1,
	GIRDLE_SWING: 2,
	CONTACT_PLANE_ERROR: 3,
	CONTACT_NORMAL_OFFSET: 4,
	EXTENSION_RATIO: 5,
	POLE_CONTINUITY: 6,
	CLAMPED: 7,
	SIZE: 8,
} );

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function component( value, lane, fallback = 0 ) {

	if ( value == null ) return fallback;
	const direct = value[ lane ];
	if ( Number.isFinite( direct ) ) return direct;
	if ( lane === 0 && Number.isFinite( value.x ) ) return value.x;
	if ( lane === 1 && Number.isFinite( value.y ) ) return value.y;
	if ( lane === 2 && Number.isFinite( value.z ) ) return value.z;
	return fallback;

}

function clamp( value, minimum, maximum ) {

	return value < minimum ? minimum : value > maximum ? maximum : value;

}

function normalize3( target, offset = 0, fallbackX = 0, fallbackY = 1, fallbackZ = 0 ) {

	let x = target[ offset ];
	let y = target[ offset + 1 ];
	let z = target[ offset + 2 ];
	let inverseLength = 1 / Math.hypot( x, y, z );
	if ( ! Number.isFinite( inverseLength ) || inverseLength > 1 / EPSILON ) {

		x = fallbackX;
		y = fallbackY;
		z = fallbackZ;
		inverseLength = 1 / ( Math.hypot( x, y, z ) || 1 );

	}
	target[ offset ] = x * inverseLength;
	target[ offset + 1 ] = y * inverseLength;
	target[ offset + 2 ] = z * inverseLength;
	return target;

}

function quaternionFromBasis( xx, xy, xz, yx, yy, yz, zx, zy, zz, out, offset ) {

	// Matrix columns are the local X, Y and Z directions in world space.
	const m00 = xx; const m01 = yx; const m02 = zx;
	const m10 = xy; const m11 = yy; const m12 = zy;
	const m20 = xz; const m21 = yz; const m22 = zz;
	const trace = m00 + m11 + m22;
	let x; let y; let z; let w;
	if ( trace > 0 ) {

		const s = Math.sqrt( trace + 1 ) * 2;
		w = 0.25 * s;
		x = ( m21 - m12 ) / s;
		y = ( m02 - m20 ) / s;
		z = ( m10 - m01 ) / s;

	} else if ( m00 > m11 && m00 > m22 ) {

		const s = Math.sqrt( 1 + m00 - m11 - m22 ) * 2;
		w = ( m21 - m12 ) / s;
		x = 0.25 * s;
		y = ( m01 + m10 ) / s;
		z = ( m02 + m20 ) / s;

	} else if ( m11 > m22 ) {

		const s = Math.sqrt( 1 + m11 - m00 - m22 ) * 2;
		w = ( m02 - m20 ) / s;
		x = ( m01 + m10 ) / s;
		y = 0.25 * s;
		z = ( m12 + m21 ) / s;

	} else {

		const s = Math.sqrt( 1 + m22 - m00 - m11 ) * 2;
		w = ( m10 - m01 ) / s;
		x = ( m02 + m20 ) / s;
		y = ( m12 + m21 ) / s;
		z = 0.25 * s;

	}
	const inverseLength = 1 / ( Math.hypot( x, y, z, w ) || 1 );
	out[ offset ] = x * inverseLength;
	out[ offset + 1 ] = y * inverseLength;
	out[ offset + 2 ] = z * inverseLength;
	out[ offset + 3 ] = w * inverseLength;

}

function writeSegmentFrame( positions, startOffset, endOffset, up, out, offset ) {

	let yx = positions[ endOffset ] - positions[ startOffset ];
	let yy = positions[ endOffset + 1 ] - positions[ startOffset + 1 ];
	let yz = positions[ endOffset + 2 ] - positions[ startOffset + 2 ];
	let inverse = 1 / ( Math.hypot( yx, yy, yz ) || 1 );
	yx *= inverse; yy *= inverse; yz *= inverse;
	// X = Y x up; Z = X x Y.  This keeps local +Y on the bone and local
	// +Z on the contact normal whenever the two are perpendicular.
	let xx = yy * up[ 2 ] - yz * up[ 1 ];
	let xy = yz * up[ 0 ] - yx * up[ 2 ];
	let xz = yx * up[ 1 ] - yy * up[ 0 ];
	inverse = 1 / Math.hypot( xx, xy, xz );
	if ( ! Number.isFinite( inverse ) || inverse > 1 / EPSILON ) {

		const fallbackX = Math.abs( yy ) < 0.9 ? 0 : 1;
		const fallbackY = Math.abs( yy ) < 0.9 ? 1 : 0;
		xx = yy * 0 - yz * fallbackY;
		xy = yz * fallbackX - yx * 0;
		xz = yx * fallbackY - yy * fallbackX;
		inverse = 1 / ( Math.hypot( xx, xy, xz ) || 1 );

	}
	xx *= inverse; xy *= inverse; xz *= inverse;
	const zx = xy * yz - xz * yy;
	const zy = xz * yx - xx * yz;
	const zz = xx * yy - xy * yx;
	quaternionFromBasis( xx, xy, xz, yx, yy, yz, zx, zy, zz, out, offset );

}

function quaternionMultiply( ax, ay, az, aw, bx, by, bz, bw, out, offset ) {

	out[ offset ] = aw * bx + ax * bw + ay * bz - az * by;
	out[ offset + 1 ] = aw * by - ax * bz + ay * bw + az * bx;
	out[ offset + 2 ] = aw * bz + ax * by - ay * bx + az * bw;
	out[ offset + 3 ] = aw * bw - ax * bx - ay * by - az * bz;

}

/**
 * Clamp a relative quaternion to a swing cone and an asymmetric twist range.
 * Quaternion and axis inputs can be arrays or `{x,y,z,w}` objects.  `out` is
 * caller-owned, making the helper suitable for every-bone use in a hot path.
 */
export function clampSwingTwist( quaternion, twistAxis, swingLimit, twistMinimum, twistMaximum, out, offset = 0 ) {

	if ( ! out || out.length < offset + 4 ) throw new RangeError( 'quaternion output buffer is too short' );
	let qx = component( quaternion, 0, 0 );
	let qy = component( quaternion, 1, 0 );
	let qz = component( quaternion, 2, 0 );
	let qw = component( quaternion, 3, 1 );
	let inverse = 1 / ( Math.hypot( qx, qy, qz, qw ) || 1 );
	qx *= inverse; qy *= inverse; qz *= inverse; qw *= inverse;
	let ax = component( twistAxis, 0, 0 );
	let ay = component( twistAxis, 1, 1 );
	let az = component( twistAxis, 2, 0 );
	inverse = 1 / ( Math.hypot( ax, ay, az ) || 1 );
	ax *= inverse; ay *= inverse; az *= inverse;
	const projected = qx * ax + qy * ay + qz * az;
	let tx = ax * projected;
	let ty = ay * projected;
	let tz = az * projected;
	let tw = qw;
	inverse = 1 / Math.hypot( tx, ty, tz, tw );
	if ( ! Number.isFinite( inverse ) || inverse > 1 / EPSILON ) {

		tx = 0; ty = 0; tz = 0; tw = 1;

	} else {

		tx *= inverse; ty *= inverse; tz *= inverse; tw *= inverse;

	}
	// swing = q * inverse( twist )
	const sx = -qw * tx + qx * tw - qy * tz + qz * ty;
	const sy = -qw * ty + qx * tz + qy * tw - qz * tx;
	const sz = -qw * tz - qx * ty + qy * tx + qz * tw;
	let sw = qw * tw + qx * tx + qy * ty + qz * tz;
	const signedSwing = sw < 0 ? -1 : 1;
	sw *= signedSwing;
	let swingAngle = 2 * Math.acos( clamp( sw, -1, 1 ) );
	const swingScale = swingAngle > EPSILON
		? Math.min( 1, Math.max( 0, finiteOr( swingLimit, PI ) ) / swingAngle )
		: 1;
	swingAngle *= swingScale;
	const swingVectorLength = Math.hypot( sx, sy, sz );
	const swingSin = Math.sin( swingAngle * 0.5 );
	const swingInverse = swingVectorLength > EPSILON ? swingSin / swingVectorLength * signedSwing : 0;
	const csx = sx * swingInverse;
	const csy = sy * swingInverse;
	const csz = sz * swingInverse;
	const csw = Math.cos( swingAngle * 0.5 );
	let twistAngle = 2 * Math.atan2( tx * ax + ty * ay + tz * az, tw );
	while ( twistAngle > PI ) twistAngle -= PI * 2;
	while ( twistAngle < -PI ) twistAngle += PI * 2;
	twistAngle = clamp(
		twistAngle,
		finiteOr( twistMinimum, -PI ),
		finiteOr( twistMaximum, PI ),
	);
	const twistSin = Math.sin( twistAngle * 0.5 );
	quaternionMultiply(
		csx, csy, csz, csw,
		ax * twistSin, ay * twistSin, az * twistSin, Math.cos( twistAngle * 0.5 ),
		out, offset,
	);
	inverse = 1 / ( Math.hypot(
		out[ offset ], out[ offset + 1 ], out[ offset + 2 ], out[ offset + 3 ],
	) || 1 );
	out[ offset ] *= inverse;
	out[ offset + 1 ] *= inverse;
	out[ offset + 2 ] *= inverse;
	out[ offset + 3 ] *= inverse;
	return out;

}

export class AnatomicalLimbSolver {

	constructor( {
		kind = 'front',
		side = 'L',
		poleResponse = 13,
		contactClearance = 0.004,
		lengths = null,
		contactOffset = null,
		restGirdle = null,
	} = {} ) {

		if ( ! CHAMELEON_LIMB_PRESETS[ kind ] ) throw new RangeError( `unknown limb kind "${ kind }"` );
		if ( side !== 'L' && side !== 'R' ) throw new RangeError( 'side must be L or R' );
		this.kind = kind;
		this.side = side;
		this.sideSign = side === 'L' ? -1 : 1;
		this.preset = CHAMELEON_LIMB_PRESETS[ kind ];
		this.lengths = new Float32Array( this.preset.lengths );
		if ( lengths != null ) {

			if ( lengths.length < 6 ) throw new RangeError( 'lengths must contain six values' );
			for ( let index = 0; index < 6; index ++ )
				this.lengths[ index ] = Math.max( EPSILON, finiteOr( lengths[ index ], this.lengths[ index ] ) );

		}
		this.contactOffset = new Float32Array( 3 );
		if ( contactOffset != null ) {

			this.contactOffset[ 0 ] = finiteOr( component( contactOffset, 0, 0 ), 0 );
			this.contactOffset[ 1 ] = finiteOr( component( contactOffset, 1, 0 ), 0 );
			this.contactOffset[ 2 ] = finiteOr( component( contactOffset, 2, 0 ), 0 );

		} else this.contactOffset[ 0 ] = this.lengths[ 3 ] * 0.5;
		this.restGirdle = new Float32Array( this.preset.restGirdle );
		if ( restGirdle != null ) {

			this.restGirdle[ 0 ] = component( restGirdle, 0, this.restGirdle[ 0 ] );
			this.restGirdle[ 1 ] = component( restGirdle, 1, this.restGirdle[ 1 ] );
			this.restGirdle[ 2 ] = component( restGirdle, 2, this.restGirdle[ 2 ] );
			normalize3( this.restGirdle );

		}
		this.poleResponse = Math.max( 0.1, finiteOr( poleResponse, 13 ) );
		this.contactClearance = Math.max( 0, finiteOr( contactClearance, 0.004 ) );
		this.positions = new Float32Array( ANATOMICAL_POSITION.SIZE );
		this.frames = new Float32Array( ANATOMICAL_FRAME.SIZE );
		this.metrics = new Float32Array( ANATOMICAL_METRIC.SIZE );
		this.contactNormal = new Float32Array( 3 );
		this.contactTangent = new Float32Array( 3 );
		this.contactBinormal = new Float32Array( 3 );
		this.poleDirection = new Float32Array( [ 0, 1, 0 ] );
		this._bodyForward = new Float32Array( 3 );
		this._bodyUp = new Float32Array( 3 );
		this._bodyRight = new Float32Array( 3 );
		this._restGirdle = new Float32Array( 3 );
		this._candidate = new Float32Array( 3 );
		this._poleCandidate = new Float32Array( 3 );
		this._poleInitialized = false;
		this._view = Object.seal( {
			positions: this.positions,
			frames: this.frames,
			metrics: this.metrics,
			contactNormal: this.contactNormal,
			contactTangent: this.contactTangent,
			contactBinormal: this.contactBinormal,
			poleDirection: this.poleDirection,
		} );

	}

	resetPole( pole = null ) {

		this._poleInitialized = pole != null;
		this.poleDirection[ 0 ] = component( pole, 0, 0 );
		this.poleDirection[ 1 ] = component( pole, 1, 1 );
		this.poleDirection[ 2 ] = component( pole, 2, 0 );
		normalize3( this.poleDirection );
		return this._view;

	}

	solve( input = {} ) {

		const positions = this.positions;
		const normal = this.contactNormal;
		const tangent = this.contactTangent;
		const binormal = this.contactBinormal;
		const bodyForward = this._bodyForward;
		const bodyUp = this._bodyUp;
		const bodyRight = this._bodyRight;
		const socket = input.socket;
		positions[ 0 ] = component( socket, 0, 0 );
		positions[ 1 ] = component( socket, 1, 0 );
		positions[ 2 ] = component( socket, 2, 0 );

		bodyForward[ 0 ] = component( input.bodyForward, 0, -1 );
		bodyForward[ 1 ] = component( input.bodyForward, 1, 0 );
		bodyForward[ 2 ] = component( input.bodyForward, 2, 0 );
		normalize3( bodyForward, 0, -1, 0, 0 );
		bodyUp[ 0 ] = component( input.bodyUp, 0, 0 );
		bodyUp[ 1 ] = component( input.bodyUp, 1, 1 );
		bodyUp[ 2 ] = component( input.bodyUp, 2, 0 );
		// Gram-Schmidt prevents a scaled/interpolated body transform from
		// contaminating the anatomical basis.
		let projection = bodyUp[ 0 ] * bodyForward[ 0 ]
			+ bodyUp[ 1 ] * bodyForward[ 1 ] + bodyUp[ 2 ] * bodyForward[ 2 ];
		bodyUp[ 0 ] -= bodyForward[ 0 ] * projection;
		bodyUp[ 1 ] -= bodyForward[ 1 ] * projection;
		bodyUp[ 2 ] -= bodyForward[ 2 ] * projection;
		normalize3( bodyUp );
		// right = up x forward for the asset's (-X forward, +Y up, +Z right).
		bodyRight[ 0 ] = bodyUp[ 1 ] * bodyForward[ 2 ] - bodyUp[ 2 ] * bodyForward[ 1 ];
		bodyRight[ 1 ] = bodyUp[ 2 ] * bodyForward[ 0 ] - bodyUp[ 0 ] * bodyForward[ 2 ];
		bodyRight[ 2 ] = bodyUp[ 0 ] * bodyForward[ 1 ] - bodyUp[ 1 ] * bodyForward[ 0 ];
		normalize3( bodyRight, 0, 0, 0, 1 );

		normal[ 0 ] = component( input.contactNormal, 0, bodyUp[ 0 ] );
		normal[ 1 ] = component( input.contactNormal, 1, bodyUp[ 1 ] );
		normal[ 2 ] = component( input.contactNormal, 2, bodyUp[ 2 ] );
		normalize3( normal, 0, bodyUp[ 0 ], bodyUp[ 1 ], bodyUp[ 2 ] );
		tangent[ 0 ] = component( input.palmDirection, 0, bodyForward[ 0 ] );
		tangent[ 1 ] = component( input.palmDirection, 1, bodyForward[ 1 ] );
		tangent[ 2 ] = component( input.palmDirection, 2, bodyForward[ 2 ] );
		projection = tangent[ 0 ] * normal[ 0 ] + tangent[ 1 ] * normal[ 1 ] + tangent[ 2 ] * normal[ 2 ];
		tangent[ 0 ] -= normal[ 0 ] * projection;
		tangent[ 1 ] -= normal[ 1 ] * projection;
		tangent[ 2 ] -= normal[ 2 ] * projection;
		normalize3( tangent, 0, bodyForward[ 0 ], bodyForward[ 1 ], bodyForward[ 2 ] );
		binormal[ 0 ] = normal[ 1 ] * tangent[ 2 ] - normal[ 2 ] * tangent[ 1 ];
		binormal[ 1 ] = normal[ 2 ] * tangent[ 0 ] - normal[ 0 ] * tangent[ 2 ];
		binormal[ 2 ] = normal[ 0 ] * tangent[ 1 ] - normal[ 1 ] * tangent[ 0 ];
		normalize3( binormal, 0, bodyRight[ 0 ], bodyRight[ 1 ], bodyRight[ 2 ] );
		// Keep the surface binormal in the same hemisphere as body right.
		if ( binormal[ 0 ] * bodyRight[ 0 ] + binormal[ 1 ] * bodyRight[ 1 ]
			+ binormal[ 2 ] * bodyRight[ 2 ] < 0 ) {

			binormal[ 0 ] *= -1; binormal[ 1 ] *= -1; binormal[ 2 ] *= -1;

		}

		const lengths = this.lengths;
		const palmLength = lengths[ 3 ];
		const clearance = Math.max( 0, finiteOr( input.contactClearance, this.contactClearance ) );
		const contactX = component( input.contact, 0, 0 ) + normal[ 0 ] * clearance;
		const contactY = component( input.contact, 1, 0 ) + normal[ 1 ] * clearance;
		const contactZ = component( input.contact, 2, 0 ) + normal[ 2 ] * clearance;
		const palmYaw = finiteOr( input.palmYaw, this.preset.palmYaw ) * this.sideSign;
		const yawCos = Math.cos( palmYaw );
		const yawSin = Math.sin( palmYaw );
		const palmX = tangent[ 0 ] * yawCos + binormal[ 0 ] * yawSin;
		const palmY = tangent[ 1 ] * yawCos + binormal[ 1 ] * yawSin;
		const palmZ = tangent[ 2 ] * yawCos + binormal[ 2 ] * yawSin;
		// Rebuild the lateral axis after toe-in/toe-out.  Reusing `binormal`
		// directly would make it non-orthogonal to the yawed palm and subtly
		// stretch both digit chains.
		let palmBinormalX = normal[ 1 ] * palmZ - normal[ 2 ] * palmY;
		let palmBinormalY = normal[ 2 ] * palmX - normal[ 0 ] * palmZ;
		let palmBinormalZ = normal[ 0 ] * palmY - normal[ 1 ] * palmX;
		const palmBinormalInverse = 1 / ( Math.hypot(
			palmBinormalX, palmBinormalY, palmBinormalZ,
		) || 1 );
		palmBinormalX *= palmBinormalInverse;
		palmBinormalY *= palmBinormalInverse;
		palmBinormalZ *= palmBinormalInverse;
		const contactOffset = this.contactOffset;
		// contactOffset components are expressed in the palm frame:
		// +Y (palm), sole normal, then +Y × sole-normal. `palmBinormal`
		// above is normal × palm, hence the sign inversion on the third lane.
		const contactOffsetX = palmX * contactOffset[ 0 ] + normal[ 0 ] * contactOffset[ 1 ]
			- palmBinormalX * contactOffset[ 2 ];
		const contactOffsetY = palmY * contactOffset[ 0 ] + normal[ 1 ] * contactOffset[ 1 ]
			- palmBinormalY * contactOffset[ 2 ];
		const contactOffsetZ = palmZ * contactOffset[ 0 ] + normal[ 2 ] * contactOffset[ 1 ]
			- palmBinormalZ * contactOffset[ 2 ];
		const requestedWristX = contactX - contactOffsetX;
		const requestedWristY = contactY - contactOffsetY;
		const requestedWristZ = contactZ - contactOffsetZ;

		// Rest girdle direction transformed through the current body frame.
		const rest = this._restGirdle;
		const restComponents = this.restGirdle;
		rest[ 0 ] = bodyForward[ 0 ] * restComponents[ 0 ] + bodyUp[ 0 ] * restComponents[ 1 ]
			+ bodyRight[ 0 ] * restComponents[ 2 ] * this.sideSign;
		rest[ 1 ] = bodyForward[ 1 ] * restComponents[ 0 ] + bodyUp[ 1 ] * restComponents[ 1 ]
			+ bodyRight[ 1 ] * restComponents[ 2 ] * this.sideSign;
		rest[ 2 ] = bodyForward[ 2 ] * restComponents[ 0 ] + bodyUp[ 2 ] * restComponents[ 1 ]
			+ bodyRight[ 2 ] * restComponents[ 2 ] * this.sideSign;
		normalize3( rest );
		let reachX = requestedWristX - positions[ 0 ];
		let reachY = requestedWristY - positions[ 1 ];
		let reachZ = requestedWristZ - positions[ 2 ];
		let reachInverse = 1 / ( Math.hypot( reachX, reachY, reachZ ) || 1 );
		reachX *= reachInverse; reachY *= reachInverse; reachZ *= reachInverse;
		const stride = clamp( finiteOr( input.stride, 0 ), -1, 1 );
		const abduction = clamp( finiteOr( input.abduction, 0.55 ), 0, 1.4 );
		const girdle = this._candidate;
		girdle[ 0 ] = rest[ 0 ] * 0.46 + reachX * 0.42
			+ tangent[ 0 ] * stride * 0.48 + bodyRight[ 0 ] * this.sideSign * abduction * 0.24;
		girdle[ 1 ] = rest[ 1 ] * 0.46 + reachY * 0.42
			+ tangent[ 1 ] * stride * 0.48 + bodyRight[ 1 ] * this.sideSign * abduction * 0.24;
		girdle[ 2 ] = rest[ 2 ] * 0.46 + reachZ * 0.42
			+ tangent[ 2 ] * stride * 0.48 + bodyRight[ 2 ] * this.sideSign * abduction * 0.24;
		normalize3( girdle, 0, rest[ 0 ], rest[ 1 ], rest[ 2 ] );
		let restDot = clamp( girdle[ 0 ] * rest[ 0 ] + girdle[ 1 ] * rest[ 1 ] + girdle[ 2 ] * rest[ 2 ], -1, 1 );
		let girdleSwing = Math.acos( restDot );
		const girdleLimit = Math.max( 0, finiteOr( input.girdleSwingLimit, this.preset.girdleSwingLimit ) );
		if ( girdleSwing > girdleLimit && girdleSwing > EPSILON ) {

			const blend = girdleLimit / girdleSwing;
			girdle[ 0 ] = rest[ 0 ] * ( 1 - blend ) + girdle[ 0 ] * blend;
			girdle[ 1 ] = rest[ 1 ] * ( 1 - blend ) + girdle[ 1 ] * blend;
			girdle[ 2 ] = rest[ 2 ] * ( 1 - blend ) + girdle[ 2 ] * blend;
			normalize3( girdle, 0, rest[ 0 ], rest[ 1 ], rest[ 2 ] );
			restDot = clamp( girdle[ 0 ] * rest[ 0 ] + girdle[ 1 ] * rest[ 1 ] + girdle[ 2 ] * rest[ 2 ], -1, 1 );
			girdleSwing = Math.acos( restDot );

		}
		positions[ 3 ] = positions[ 0 ] + girdle[ 0 ] * lengths[ 0 ];
		positions[ 4 ] = positions[ 1 ] + girdle[ 1 ] * lengths[ 0 ];
		positions[ 5 ] = positions[ 2 ] + girdle[ 2 ] * lengths[ 0 ];

		let targetX = requestedWristX - positions[ 3 ];
		let targetY = requestedWristY - positions[ 4 ];
		let targetZ = requestedWristZ - positions[ 5 ];
		const requestedDistance = Math.hypot( targetX, targetY, targetZ );
		const targetInverse = 1 / ( requestedDistance || 1 );
		targetX *= targetInverse; targetY *= targetInverse; targetZ *= targetInverse;
		const upperLength = lengths[ 1 ];
		const lowerLength = lengths[ 2 ];
		const minimumFlexion = clamp(
			finiteOr( input.minimumFlexion, this.preset.minimumFlexion ), 0.01, PI - 0.01,
		);
		const maximumFlexion = clamp(
			finiteOr( input.maximumFlexion, this.preset.maximumFlexion ), minimumFlexion, PI - 0.01,
		);
		const minimumReach = Math.sqrt( upperLength * upperLength + lowerLength * lowerLength
			+ 2 * upperLength * lowerLength * Math.cos( maximumFlexion ) );
		const maximumReach = Math.sqrt( upperLength * upperLength + lowerLength * lowerLength
			+ 2 * upperLength * lowerLength * Math.cos( minimumFlexion ) );
		const solvedDistance = clamp( requestedDistance, minimumReach, maximumReach );
		positions[ 9 ] = positions[ 3 ] + targetX * solvedDistance;
		positions[ 10 ] = positions[ 4 ] + targetY * solvedDistance;
		positions[ 11 ] = positions[ 5 ] + targetZ * solvedDistance;

		// Pole vector: an outward-and-up anatomical preference, projected into
		// the current reach plane and temporally filtered without quaternion flips.
		const pole = this._poleCandidate;
		if ( input.poleVector != null ) {

			pole[ 0 ] = component( input.poleVector, 0, 0 );
			pole[ 1 ] = component( input.poleVector, 1, 1 );
			pole[ 2 ] = component( input.poleVector, 2, 0 );

		} else {

			pole[ 0 ] = bodyRight[ 0 ] * this.sideSign * 0.78 + normal[ 0 ] * 0.46;
			pole[ 1 ] = bodyRight[ 1 ] * this.sideSign * 0.78 + normal[ 1 ] * 0.46;
			pole[ 2 ] = bodyRight[ 2 ] * this.sideSign * 0.78 + normal[ 2 ] * 0.46;

		}
		projection = pole[ 0 ] * targetX + pole[ 1 ] * targetY + pole[ 2 ] * targetZ;
		pole[ 0 ] -= targetX * projection;
		pole[ 1 ] -= targetY * projection;
		pole[ 2 ] -= targetZ * projection;
		normalize3( pole, 0, normal[ 0 ], normal[ 1 ], normal[ 2 ] );
		let previousDot = 1;
		if ( ! this._poleInitialized ) {

			this.poleDirection.set( pole );
			this._poleInitialized = true;

		} else {

			previousDot = this.poleDirection[ 0 ] * pole[ 0 ]
				+ this.poleDirection[ 1 ] * pole[ 1 ] + this.poleDirection[ 2 ] * pole[ 2 ];
			// A requested vector crossing the singularity may never invert the knee.
			if ( previousDot < 0 ) {

				pole[ 0 ] *= -1; pole[ 1 ] *= -1; pole[ 2 ] *= -1;
				previousDot *= -1;

			}
			const dt = clamp( finiteOr( input.dt, 1 / 120 ), 0, 0.1 );
			const poleBlend = 1 - Math.exp( -this.poleResponse * dt );
			this.poleDirection[ 0 ] += ( pole[ 0 ] - this.poleDirection[ 0 ] ) * poleBlend;
			this.poleDirection[ 1 ] += ( pole[ 1 ] - this.poleDirection[ 1 ] ) * poleBlend;
			this.poleDirection[ 2 ] += ( pole[ 2 ] - this.poleDirection[ 2 ] ) * poleBlend;
			projection = this.poleDirection[ 0 ] * targetX + this.poleDirection[ 1 ] * targetY
				+ this.poleDirection[ 2 ] * targetZ;
			this.poleDirection[ 0 ] -= targetX * projection;
			this.poleDirection[ 1 ] -= targetY * projection;
			this.poleDirection[ 2 ] -= targetZ * projection;
			normalize3( this.poleDirection, 0, pole[ 0 ], pole[ 1 ], pole[ 2 ] );

		}
		const upperProjection = ( upperLength * upperLength - lowerLength * lowerLength
			+ solvedDistance * solvedDistance ) / ( 2 * solvedDistance );
		const elbowHeight = Math.sqrt( Math.max(
			0, upperLength * upperLength - upperProjection * upperProjection,
		) );
		positions[ 6 ] = positions[ 3 ] + targetX * upperProjection + this.poleDirection[ 0 ] * elbowHeight;
		positions[ 7 ] = positions[ 4 ] + targetY * upperProjection + this.poleDirection[ 1 ] * elbowHeight;
		positions[ 8 ] = positions[ 5 ] + targetZ * upperProjection + this.poleDirection[ 2 ] * elbowHeight;

		// The achieved palm remains a rigid, planar patch.  Digits splay around
		// the palm end rather than being stretched independently to hit geometry.
		positions[ 12 ] = positions[ 9 ] + contactOffsetX;
		positions[ 13 ] = positions[ 10 ] + contactOffsetY;
		positions[ 14 ] = positions[ 11 ] + contactOffsetZ;
		positions[ 15 ] = positions[ 9 ] + palmX * palmLength;
		positions[ 16 ] = positions[ 10 ] + palmY * palmLength;
		positions[ 17 ] = positions[ 11 ] + palmZ * palmLength;
		const toeSplay = clamp( finiteOr( input.toeSplay, this.preset.toeSplay ), 0.08, 0.85 );
		const toeCos = Math.cos( toeSplay );
		const toeSin = Math.sin( toeSplay );
		const innerSide = -this.sideSign;
		positions[ 18 ] = positions[ 15 ] + ( palmX * toeCos + palmBinormalX * toeSin * innerSide ) * lengths[ 4 ];
		positions[ 19 ] = positions[ 16 ] + ( palmY * toeCos + palmBinormalY * toeSin * innerSide ) * lengths[ 4 ];
		positions[ 20 ] = positions[ 17 ] + ( palmZ * toeCos + palmBinormalZ * toeSin * innerSide ) * lengths[ 4 ];
		positions[ 21 ] = positions[ 15 ] + ( palmX * toeCos - palmBinormalX * toeSin * innerSide ) * lengths[ 5 ];
		positions[ 22 ] = positions[ 16 ] + ( palmY * toeCos - palmBinormalY * toeSin * innerSide ) * lengths[ 5 ];
		positions[ 23 ] = positions[ 17 ] + ( palmZ * toeCos - palmBinormalZ * toeSin * innerSide ) * lengths[ 5 ];

		writeSegmentFrame( positions, 0, 3, normal, this.frames, 0 );
		writeSegmentFrame( positions, 3, 6, this.poleDirection, this.frames, 4 );
		writeSegmentFrame( positions, 6, 9, this.poleDirection, this.frames, 8 );
		writeSegmentFrame( positions, 9, 15, normal, this.frames, 12 );

		const upperX = positions[ 6 ] - positions[ 3 ];
		const upperY = positions[ 7 ] - positions[ 4 ];
		const upperZ = positions[ 8 ] - positions[ 5 ];
		const lowerX = positions[ 9 ] - positions[ 6 ];
		const lowerY = positions[ 10 ] - positions[ 7 ];
		const lowerZ = positions[ 11 ] - positions[ 8 ];
		const flexion = Math.acos( clamp(
			( upperX * lowerX + upperY * lowerY + upperZ * lowerZ ) / ( upperLength * lowerLength ),
			-1, 1,
		) );
		let planeError = 0;
		for ( let point = 9; point <= 21; point += 3 ) {

			const offsetFromRequestedPlane = ( positions[ point ] - contactX ) * normal[ 0 ]
				+ ( positions[ point + 1 ] - contactY ) * normal[ 1 ]
				+ ( positions[ point + 2 ] - contactZ ) * normal[ 2 ];
			planeError = Math.max( planeError, Math.abs( offsetFromRequestedPlane ) );

		}
		this.metrics[ ANATOMICAL_METRIC.REACH_RESIDUAL ] = requestedDistance - solvedDistance;
		this.metrics[ ANATOMICAL_METRIC.FLEXION ] = flexion;
		this.metrics[ ANATOMICAL_METRIC.GIRDLE_SWING ] = girdleSwing;
		this.metrics[ ANATOMICAL_METRIC.CONTACT_PLANE_ERROR ] = planeError;
		this.metrics[ ANATOMICAL_METRIC.CONTACT_NORMAL_OFFSET ] =
			( positions[ 12 ] - contactX ) * normal[ 0 ]
			+ ( positions[ 13 ] - contactY ) * normal[ 1 ]
			+ ( positions[ 14 ] - contactZ ) * normal[ 2 ];
		this.metrics[ ANATOMICAL_METRIC.EXTENSION_RATIO ] = solvedDistance / ( upperLength + lowerLength );
		this.metrics[ ANATOMICAL_METRIC.POLE_CONTINUITY ] = previousDot;
		this.metrics[ ANATOMICAL_METRIC.CLAMPED ] = Math.abs( requestedDistance - solvedDistance ) > 1e-7 ? 1 : 0;
		return this._view;

	}

	getView() {

		return this._view;

	}

}

export const SUSPENSION_OUTPUT = Object.freeze( {
	OFFSET_X: 0,
	OFFSET_Y: 1,
	OFFSET_Z: 2,
	PITCH: 3,
	ROLL: 4,
	LOAD: 5,
	SIZE: 6,
} );

/**
 * Critically damped support suspension shared by the four limbs.  It turns
 * stance compression into body heave plus restrained pitch/roll, while swing
 * feet carry no load.  Buffers use the fixed order front.L, front.R, hind.L,
 * hind.R used by the laboratory.
 */
export class AnatomicalSuspensionModel {

	constructor( {
		responseFrequency = 5.5,
		dampingRatio = 1,
		maximumOffset = 0.075,
		maximumAngle = 0.16,
	} = {} ) {

		this.responseFrequency = Math.max( 0.1, finiteOr( responseFrequency, 5.5 ) );
		this.dampingRatio = Math.max( 0.2, finiteOr( dampingRatio, 1 ) );
		this.maximumOffset = Math.max( 0, finiteOr( maximumOffset, 0.075 ) );
		this.maximumAngle = Math.max( 0, finiteOr( maximumAngle, 0.16 ) );
		this.previous = new Float32Array( SUSPENSION_OUTPUT.SIZE );
		this.current = new Float32Array( SUSPENSION_OUTPUT.SIZE );
		this.velocity = new Float32Array( SUSPENSION_OUTPUT.SIZE );
		this.target = new Float32Array( SUSPENSION_OUTPUT.SIZE );
		this.render = new Float32Array( SUSPENSION_OUTPUT.SIZE );
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

	update( dt, input = {} ) {

		this.previous.set( this.current );
		this.target.fill( 0 );
		const sockets = input.socketPositions;
		const contacts = input.contactPositions;
		const normals = input.contactNormals;
		const active = input.active;
		const preferred = input.preferredReach;
		let count = 0;
		let pitch = 0;
		let roll = 0;
		let load = 0;
		for ( let limb = 0; limb < 4; limb ++ ) {

			if ( active && ! active[ limb ] ) continue;
			const offset = limb * 3;
			const dx = component( contacts, offset, 0 ) - component( sockets, offset, 0 );
			const dy = component( contacts, offset + 1, 0 ) - component( sockets, offset + 1, 0 );
			const dz = component( contacts, offset + 2, 0 ) - component( sockets, offset + 2, 0 );
			const distance = Math.hypot( dx, dy, dz );
			if ( ! Number.isFinite( distance ) ) continue;
			const desired = ArrayBuffer.isView( preferred ) || Array.isArray( preferred )
				? finiteOr( preferred[ limb ], limb < 2
					? CHAMELEON_LIMB_PRESETS.front.preferredReach
					: CHAMELEON_LIMB_PRESETS.hind.preferredReach )
				: finiteOr( preferred, limb < 2
					? CHAMELEON_LIMB_PRESETS.front.preferredReach
					: CHAMELEON_LIMB_PRESETS.hind.preferredReach );
			const compression = clamp( desired - distance, -0.08, 0.08 );
			let nx = component( normals, offset, 0 );
			let ny = component( normals, offset + 1, 1 );
			let nz = component( normals, offset + 2, 0 );
			const inverseNormal = 1 / ( Math.hypot( nx, ny, nz ) || 1 );
			nx *= inverseNormal; ny *= inverseNormal; nz *= inverseNormal;
			this.target[ 0 ] += nx * compression;
			this.target[ 1 ] += ny * compression;
			this.target[ 2 ] += nz * compression;
			const side = limb === 0 || limb === 2 ? -1 : 1;
			const longitudinal = limb < 2 ? 1 : -1;
			roll += compression * side;
			pitch += compression * longitudinal;
			load += Math.max( 0, compression );
			count ++;

		}
		if ( count > 0 ) {

			const inverseCount = 1 / count;
			this.target[ 0 ] *= inverseCount;
			this.target[ 1 ] *= inverseCount;
			this.target[ 2 ] *= inverseCount;
			const offsetLength = Math.hypot( this.target[ 0 ], this.target[ 1 ], this.target[ 2 ] );
			if ( offsetLength > this.maximumOffset ) {

				const scale = this.maximumOffset / offsetLength;
				this.target[ 0 ] *= scale;
				this.target[ 1 ] *= scale;
				this.target[ 2 ] *= scale;

			}
			this.target[ 3 ] = clamp( pitch * 2.1 * inverseCount, -this.maximumAngle, this.maximumAngle );
			this.target[ 4 ] = clamp( roll * 2.1 * inverseCount, -this.maximumAngle, this.maximumAngle );
			this.target[ 5 ] = load * inverseCount;

		}
		dt = clamp( finiteOr( dt, 0 ), 0, 1 / 20 );
		const omega = this.responseFrequency * PI * 2;
		const damping = 2 * this.dampingRatio * omega;
		const stiffness = omega * omega;
		for ( let lane = 0; lane < SUSPENSION_OUTPUT.SIZE; lane ++ ) {

			const acceleration = ( this.target[ lane ] - this.current[ lane ] ) * stiffness
				- this.velocity[ lane ] * damping;
			this.velocity[ lane ] += acceleration * dt;
			this.current[ lane ] += this.velocity[ lane ] * dt;
			if ( ! Number.isFinite( this.current[ lane ] ) || ! Number.isFinite( this.velocity[ lane ] ) ) {

				this.current[ lane ] = this.target[ lane ];
				this.velocity[ lane ] = 0;

			}

		}
		return this._view;

	}

	interpolate( alpha = 1 ) {

		const blend = clamp( finiteOr( alpha, 1 ), 0, 1 );
		for ( let lane = 0; lane < SUSPENSION_OUTPUT.SIZE; lane ++ )
			this.render[ lane ] = this.previous[ lane ]
				+ ( this.current[ lane ] - this.previous[ lane ] ) * blend;
		return this.render;

	}

	getView() {

		return this._view;

	}

}
