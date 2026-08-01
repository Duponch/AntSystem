export const PASSIVE_LIMB_COUNT = 4;
export const PASSIVE_LIMB_NODE_COUNT = 5;
export const PASSIVE_LIMB_SEGMENT_COUNT = PASSIVE_LIMB_NODE_COUNT - 1;
export const PASSIVE_LIMB_COMPONENT_COUNT =
	PASSIVE_LIMB_COUNT * PASSIVE_LIMB_NODE_COUNT * 3;

const EPSILON = 1e-9;

function finite( name, value ) {

	if ( ! Number.isFinite( value ) ) throw new RangeError( `${ name } must be finite` );
	return value;

}

function positive( name, value ) {

	value = finite( name, value );
	if ( value <= 0 ) throw new RangeError( `${ name } must be greater than zero` );
	return value;

}

function clamp( value, minimum, maximum ) {

	return value < minimum ? minimum : value > maximum ? maximum : value;

}

function componentOffset( limb, node ) {

	return ( limb * PASSIVE_LIMB_NODE_COUNT + node ) * 3;

}

function segmentOffset( limb, segment ) {

	return limb * PASSIVE_LIMB_SEGMENT_COUNT + segment;

}

function bendOffset( limb, bend ) {

	return limb * ( PASSIVE_LIMB_NODE_COUNT - 2 ) + bend;

}

function allFinite( values ) {

	for ( let index = 0; index < values.length; index ++ )
		if ( ! Number.isFinite( values[ index ] ) ) return false;
	return true;

}

/**
 * Tiny allocation-free XPBD ragdoll used only while the selected animal is
 * held or put in free-physics mode. Each limb is a five-point chain:
 * girdle, upper joint, lower joint, palm and sole/digit centre.
 *
 * Distance and bend-range constraints are the passive ligaments. An optional
 * low-gain rest-pose motor models residual muscle tone without replacing the
 * physical pose, while fixed-buffer capsule constraints prevent interpenetration.
 */
export class PassiveLimbRagdoll {

	constructor( {
		fixedDt = 1 / 120,
		solverIterations = 8,
		damping = 2.8,
		stretchCompliance = 0,
		bendCompliance = 1e-7,
		collisionFriction = 0.38,
		maxSpeed = 9,
		gravity = { x: 0, y: -9.81, z: 0 },
		initialPositions,
		radii = null,
		minimumBend = 0.12,
		maximumBend = 2.55,
		muscleTone = 0,
		muscleTargets = null,
		bodyCapsules = null,
		selfCollision = false,
		selfCollisionMargin = 0.003,
	} = {} ) {

		this.fixedDt = positive( 'fixedDt', fixedDt );
		if ( ! Number.isInteger( solverIterations ) || solverIterations < 1 || solverIterations > 32 )
			throw new RangeError( 'solverIterations must be an integer from 1 to 32' );
		this.solverIterations = solverIterations;
		this.damping = Math.max( 0, finite( 'damping', damping ) );
		this.stretchCompliance = Math.max( 0, finite( 'stretchCompliance', stretchCompliance ) );
		this.bendCompliance = Math.max( 0, finite( 'bendCompliance', bendCompliance ) );
		this.collisionFriction = clamp( finite( 'collisionFriction', collisionFriction ), 0, 1 );
		this.maxSpeed = positive( 'maxSpeed', maxSpeed );
		this.gravityX = finite( 'gravity.x', gravity?.x ?? 0 );
		this.gravityY = finite( 'gravity.y', gravity?.y ?? -9.81 );
		this.gravityZ = finite( 'gravity.z', gravity?.z ?? 0 );
		this.minimumBend = clamp( finite( 'minimumBend', minimumBend ), 0, Math.PI - 1e-4 );
		this.maximumBend = clamp(
			finite( 'maximumBend', maximumBend ),
			this.minimumBend + 1e-4,
			Math.PI - 1e-4,
		);
		this.muscleTone = finite( 'muscleTone', muscleTone );
		if ( this.muscleTone < 0 || this.muscleTone > 1 )
			throw new RangeError( 'muscleTone must be between zero and one' );
		this.selfCollision = selfCollision === true;
		this.selfCollisionMargin = Math.max(
			0, finite( 'selfCollisionMargin', selfCollisionMargin ),
		);

		if ( ! initialPositions || initialPositions.length < PASSIVE_LIMB_COMPONENT_COUNT )
			throw new TypeError( `initialPositions must contain ${ PASSIVE_LIMB_COMPONENT_COUNT } values` );

		this.positions = new Float32Array( PASSIVE_LIMB_COMPONENT_COUNT );
		this.previousPositions = new Float32Array( PASSIVE_LIMB_COMPONENT_COUNT );
		this.renderPreviousPositions = new Float32Array( PASSIVE_LIMB_COMPONENT_COUNT );
		this.interpolatedPositions = new Float32Array( PASSIVE_LIMB_COMPONENT_COUNT );
		this.rootAnchors = new Float32Array( PASSIVE_LIMB_COUNT * 3 );
		this.segmentLengths = new Float32Array( PASSIVE_LIMB_COUNT * PASSIVE_LIMB_SEGMENT_COUNT );
		this.bendMinimumLengths = new Float32Array( PASSIVE_LIMB_COUNT * ( PASSIVE_LIMB_NODE_COUNT - 2 ) );
		this.bendMaximumLengths = new Float32Array( PASSIVE_LIMB_COUNT * ( PASSIVE_LIMB_NODE_COUNT - 2 ) );
		this.radii = new Float32Array( PASSIVE_LIMB_COUNT * PASSIVE_LIMB_NODE_COUNT );
		this.inverseMasses = new Float32Array( PASSIVE_LIMB_COUNT * PASSIVE_LIMB_NODE_COUNT );
		this.muscleTargets = new Float32Array( PASSIVE_LIMB_COMPONENT_COUNT );
		if ( bodyCapsules !== null && ( ! bodyCapsules || bodyCapsules.length % 7 !== 0 ) )
			throw new TypeError( 'bodyCapsules must contain packed endpoint A xyz, endpoint B xyz and radius values' );
		this.bodyCapsules = new Float32Array( bodyCapsules?.length ?? 0 );
		for ( let index = 0; index < this.bodyCapsules.length; index ++ )
			this.bodyCapsules[ index ] = finite( `bodyCapsules[${ index }]`, bodyCapsules[ index ] );
		for ( let index = 6; index < this.bodyCapsules.length; index += 7 )
			positive( `bodyCapsules[${ index }]`, this.bodyCapsules[ index ] );
		this.segmentLambdas = new Float64Array( this.segmentLengths.length );
		this.bendLambdas = new Float64Array( this.bendMinimumLengths.length );
		this._collisionActive = new Uint8Array(
			PASSIVE_LIMB_COUNT * PASSIVE_LIMB_NODE_COUNT,
		);
		this._collisionPlanes = new Float32Array( PASSIVE_LIMB_COMPONENT_COUNT * 2 );
		this._collisionPoint = Object.seal( { x: 0, y: 0, z: 0 } );
		this._projectedPoint = Object.seal( { x: 0, y: 0, z: 0 } );
		this._projectedNormal = Object.seal( { x: 0, y: 1, z: 0 } );
		this._steps = 0;
		this._invalidCorrections = 0;
		this._selfCollisionCorrections = 0;
		this._bodyCollisionCorrections = 0;
		this._externalProjectionQueries = 0;
		this.stats = Object.seal( {
			steps: 0,
			invalidCorrections: 0,
			selfCollisionCorrections: 0,
			bodyCollisionCorrections: 0,
			externalProjectionQueries: 0,
		} );

		for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

			for ( let node = 0; node < PASSIVE_LIMB_NODE_COUNT; node ++ ) {

				const scalar = limb * PASSIVE_LIMB_NODE_COUNT + node;
				this.inverseMasses[ scalar ] = node === 0 ? 0 : 0.72 + node * 0.12;
				this.radii[ scalar ] = radii?.[ scalar ] ?? ( node < 2 ? 0.035 : node < 4 ? 0.026 : 0.018 );
				positive( `radii[${ scalar }]`, this.radii[ scalar ] );

			}

		}
		this.resetPositions( initialPositions );
		this.setMuscleTargets( muscleTargets ?? initialPositions );
		this._deriveConstraints();
		this.view = Object.seal( {
			positions: this.positions,
			previousPositions: this.renderPreviousPositions,
			interpolatedPositions: this.interpolatedPositions,
			rootAnchors: this.rootAnchors,
			segmentLengths: this.segmentLengths,
			bendMinimumLengths: this.bendMinimumLengths,
			bendMaximumLengths: this.bendMaximumLengths,
			radii: this.radii,
			muscleTargets: this.muscleTargets,
			bodyCapsules: this.bodyCapsules,
		} );

	}

	_deriveConstraints() {

		for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

			for ( let segment = 0; segment < PASSIVE_LIMB_SEGMENT_COUNT; segment ++ ) {

				const first = componentOffset( limb, segment );
				const second = componentOffset( limb, segment + 1 );
				this.segmentLengths[ segmentOffset( limb, segment ) ] = positive(
					'segmentLength',
					Math.hypot(
						this.positions[ second ] - this.positions[ first ],
						this.positions[ second + 1 ] - this.positions[ first + 1 ],
						this.positions[ second + 2 ] - this.positions[ first + 2 ],
					),
				);

			}
			for ( let bend = 0; bend < PASSIVE_LIMB_NODE_COUNT - 2; bend ++ ) {

				const firstLength = this.segmentLengths[ segmentOffset( limb, bend ) ];
				const secondLength = this.segmentLengths[ segmentOffset( limb, bend + 1 ) ];
				const index = bendOffset( limb, bend );
				this.bendMinimumLengths[ index ] = Math.sqrt( Math.max(
					EPSILON,
					firstLength * firstLength + secondLength * secondLength
					+ 2 * firstLength * secondLength * Math.cos( this.maximumBend ),
				) );
				this.bendMaximumLengths[ index ] = Math.sqrt( Math.max(
					EPSILON,
					firstLength * firstLength + secondLength * secondLength
					+ 2 * firstLength * secondLength * Math.cos( this.minimumBend ),
				) );

			}

		}

	}

	resetPositions( positions ) {

		if ( ! positions || positions.length < PASSIVE_LIMB_COMPONENT_COUNT )
			throw new TypeError( `positions must contain ${ PASSIVE_LIMB_COMPONENT_COUNT } values` );
		for ( let index = 0; index < PASSIVE_LIMB_COMPONENT_COUNT; index ++ )
			this.positions[ index ] = finite( `positions[${ index }]`, positions[ index ] );
		this.previousPositions.set( this.positions );
		this.renderPreviousPositions.set( this.positions );
		this.interpolatedPositions.set( this.positions );
		if ( this.muscleTargets ) this.muscleTargets.set( this.positions );
		for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

			const source = componentOffset( limb, 0 );
			const target = limb * 3;
			this.rootAnchors[ target ] = this.positions[ source ];
			this.rootAnchors[ target + 1 ] = this.positions[ source + 1 ];
			this.rootAnchors[ target + 2 ] = this.positions[ source + 2 ];

		}
		this.segmentLambdas.fill( 0 );
		this.bendLambdas.fill( 0 );
		return this;

	}

	setRootAnchors( anchors ) {

		if ( ! anchors || anchors.length < PASSIVE_LIMB_COUNT * 3 )
			throw new TypeError( 'root anchors must contain twelve values' );
		for ( let index = 0; index < PASSIVE_LIMB_COUNT * 3; index ++ )
			this.rootAnchors[ index ] = finite( `rootAnchors[${ index }]`, anchors[ index ] );
		return this;

	}

	setMuscleTargets( targets ) {

		if ( ! targets || targets.length < PASSIVE_LIMB_COMPONENT_COUNT )
			throw new TypeError( `muscleTargets must contain ${ PASSIVE_LIMB_COMPONENT_COUNT } values` );
		for ( let index = 0; index < PASSIVE_LIMB_COMPONENT_COUNT; index ++ )
			this.muscleTargets[ index ] = finite( `muscleTargets[${ index }]`, targets[ index ] );
		return this;

	}

	setMuscleTone( muscleTone ) {

		muscleTone = finite( 'muscleTone', muscleTone );
		if ( muscleTone < 0 || muscleTone > 1 )
			throw new RangeError( 'muscleTone must be between zero and one' );
		this.muscleTone = muscleTone;
		return this;

	}

	setBodyCapsules( capsules ) {

		if ( ! capsules || capsules.length !== this.bodyCapsules.length )
			throw new TypeError( `bodyCapsules must contain ${ this.bodyCapsules.length } values` );
		for ( let index = 0; index < capsules.length; index ++ )
			this.bodyCapsules[ index ] = finite( `bodyCapsules[${ index }]`, capsules[ index ] );
		for ( let index = 6; index < capsules.length; index += 7 )
			positive( `bodyCapsules[${ index }]`, capsules[ index ] );
		return this;

	}

	_pinRoots() {

		for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

			const point = componentOffset( limb, 0 );
			const anchor = limb * 3;
			this.positions[ point ] = this.rootAnchors[ anchor ];
			this.positions[ point + 1 ] = this.rootAnchors[ anchor + 1 ];
			this.positions[ point + 2 ] = this.rootAnchors[ anchor + 2 ];
			this.previousPositions[ point ] = this.positions[ point ];
			this.previousPositions[ point + 1 ] = this.positions[ point + 1 ];
			this.previousPositions[ point + 2 ] = this.positions[ point + 2 ];

		}

	}

	_solveDistance( firstScalar, secondScalar, restLength, lambdaIndex, alpha, lambdas ) {

		const first = firstScalar * 3;
		const second = secondScalar * 3;
		let dx = this.positions[ second ] - this.positions[ first ];
		let dy = this.positions[ second + 1 ] - this.positions[ first + 1 ];
		let dz = this.positions[ second + 2 ] - this.positions[ first + 2 ];
		const length = Math.hypot( dx, dy, dz );
		if ( length <= EPSILON ) return;
		dx /= length;
		dy /= length;
		dz /= length;
		const firstWeight = this.inverseMasses[ firstScalar ];
		const secondWeight = this.inverseMasses[ secondScalar ];
		const denominator = firstWeight + secondWeight + alpha;
		if ( denominator <= EPSILON ) return;
		const deltaLambda = ( -( length - restLength ) - alpha * lambdas[ lambdaIndex ] ) / denominator;
		lambdas[ lambdaIndex ] += deltaLambda;
		this.positions[ first ] -= firstWeight * dx * deltaLambda;
		this.positions[ first + 1 ] -= firstWeight * dy * deltaLambda;
		this.positions[ first + 2 ] -= firstWeight * dz * deltaLambda;
		this.positions[ second ] += secondWeight * dx * deltaLambda;
		this.positions[ second + 1 ] += secondWeight * dy * deltaLambda;
		this.positions[ second + 2 ] += secondWeight * dz * deltaLambda;

	}

	_solveBendRange( limb, bend, alpha ) {

		const firstNode = bend;
		const secondNode = bend + 2;
		const firstScalar = limb * PASSIVE_LIMB_NODE_COUNT + firstNode;
		const secondScalar = limb * PASSIVE_LIMB_NODE_COUNT + secondNode;
		const first = firstScalar * 3;
		const second = secondScalar * 3;
		const distance = Math.hypot(
			this.positions[ second ] - this.positions[ first ],
			this.positions[ second + 1 ] - this.positions[ first + 1 ],
			this.positions[ second + 2 ] - this.positions[ first + 2 ],
		);
		const index = bendOffset( limb, bend );
		const target = distance < this.bendMinimumLengths[ index ]
			? this.bendMinimumLengths[ index ]
			: distance > this.bendMaximumLengths[ index ]
				? this.bendMaximumLengths[ index ] : distance;
		if ( Math.abs( target - distance ) <= 1e-7 ) return;
		this._solveDistance(
			firstScalar, secondScalar, target, index, alpha,
			this.bendLambdas,
		);

	}

	_solveMuscleTone( response ) {

		if ( response <= 0 ) return;
		for ( let scalar = 0; scalar < PASSIVE_LIMB_COUNT * PASSIVE_LIMB_NODE_COUNT; scalar ++ ) {

			if ( this.inverseMasses[ scalar ] <= 0 ) continue;
			const offset = scalar * 3;
			let dx = ( this.muscleTargets[ offset ] - this.positions[ offset ] ) * response;
			let dy = ( this.muscleTargets[ offset + 1 ] - this.positions[ offset + 1 ] ) * response;
			let dz = ( this.muscleTargets[ offset + 2 ] - this.positions[ offset + 2 ] ) * response;
			// The cap keeps an externally moved rest pose compliant instead of turning
			// the low-tone motor into a teleport or a rigid animation constraint.
			const correctionLength = Math.hypot( dx, dy, dz );
			const maximumCorrection = this.maxSpeed * this.fixedDt / this.solverIterations;
			if ( correctionLength > maximumCorrection && correctionLength > EPSILON ) {

				const scale = maximumCorrection / correctionLength;
				dx *= scale;
				dy *= scale;
				dz *= scale;

			}
			this.positions[ offset ] += dx;
			this.positions[ offset + 1 ] += dy;
			this.positions[ offset + 2 ] += dz;
			// Move the Verlet history by the same amount. Muscle tone restores the
			// pose without manufacturing high-frequency velocity.
			this.previousPositions[ offset ] += dx;
			this.previousPositions[ offset + 1 ] += dy;
			this.previousPositions[ offset + 2 ] += dz;

		}

	}

	_solveBodyCollisions() {

		if ( this.bodyCapsules.length === 0 ) return;
		// Point-versus-capsule constraints prevent joints and extremities from
		// entering the torso. The following segment pass closes the gaps between
		// joints, so a forearm cannot tunnel through the body even if both joints
		// happen to remain outside.
		for ( let scalar = 0; scalar < PASSIVE_LIMB_COUNT * PASSIVE_LIMB_NODE_COUNT; scalar ++ ) {

			const inverseMass = this.inverseMasses[ scalar ];
			// The socket and shoulder/hip are intentionally embedded in the trunk:
			// their short girdle bridge exits the body through the skin. Only the
			// articulated distal chain must be kept outside the protected torso.
			if ( inverseMass <= 0 || scalar % PASSIVE_LIMB_NODE_COUNT < 2 ) continue;
			const point = scalar * 3;
			for ( let capsule = 0; capsule < this.bodyCapsules.length; capsule += 7 ) {

				const ax = this.bodyCapsules[ capsule ];
				const ay = this.bodyCapsules[ capsule + 1 ];
				const az = this.bodyCapsules[ capsule + 2 ];
				const abx = this.bodyCapsules[ capsule + 3 ] - ax;
				const aby = this.bodyCapsules[ capsule + 4 ] - ay;
				const abz = this.bodyCapsules[ capsule + 5 ] - az;
				const denominator = abx * abx + aby * aby + abz * abz;
				const apx = this.positions[ point ] - ax;
				const apy = this.positions[ point + 1 ] - ay;
				const apz = this.positions[ point + 2 ] - az;
				const t = denominator > EPSILON
					? clamp( ( apx * abx + apy * aby + apz * abz ) / denominator, 0, 1 ) : 0;
				let dx = this.positions[ point ] - ( ax + abx * t );
				let dy = this.positions[ point + 1 ] - ( ay + aby * t );
				let dz = this.positions[ point + 2 ] - ( az + abz * t );
				let distance = Math.hypot( dx, dy, dz );
				const required = this.bodyCapsules[ capsule + 6 ] + this.radii[ scalar ];
				if ( distance >= required ) continue;
				if ( distance <= EPSILON ) {

					// A deterministic direction is essential when a point starts exactly
					// on the capsule axis; use its anatomical rest offset when possible.
					dx = this.muscleTargets[ point ] - ( ax + abx * t );
					dy = this.muscleTargets[ point + 1 ] - ( ay + aby * t );
					dz = this.muscleTargets[ point + 2 ] - ( az + abz * t );
					distance = Math.hypot( dx, dy, dz );
					if ( distance <= EPSILON ) {

						dx = ( scalar & 1 ) === 0 ? 1 : -1;
						dy = 0;
						dz = 0;
						distance = 1;

					}

				}
				const correction = ( required - distance ) / distance;
				this.positions[ point ] += dx * correction;
				this.positions[ point + 1 ] += dy * correction;
				this.positions[ point + 2 ] += dz * correction;
				this._bodyCollisionCorrections ++;

			}

		}

		for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

			for ( let segment = 1; segment < PASSIVE_LIMB_SEGMENT_COUNT; segment ++ ) {

				const firstScalar = limb * PASSIVE_LIMB_NODE_COUNT + segment;
				const secondScalar = firstScalar + 1;
				const first = firstScalar * 3;
				const second = secondScalar * 3;
				const ux = this.positions[ second ] - this.positions[ first ];
				const uy = this.positions[ second + 1 ] - this.positions[ first + 1 ];
				const uz = this.positions[ second + 2 ] - this.positions[ first + 2 ];
				const a = ux * ux + uy * uy + uz * uz;
				if ( a <= EPSILON ) continue;
				for ( let capsule = 0; capsule < this.bodyCapsules.length; capsule += 7 ) {

					const bx = this.bodyCapsules[ capsule ];
					const by = this.bodyCapsules[ capsule + 1 ];
					const bz = this.bodyCapsules[ capsule + 2 ];
					const vx = this.bodyCapsules[ capsule + 3 ] - bx;
					const vy = this.bodyCapsules[ capsule + 4 ] - by;
					const vz = this.bodyCapsules[ capsule + 5 ] - bz;
					const wx = this.positions[ first ] - bx;
					const wy = this.positions[ first + 1 ] - by;
					const wz = this.positions[ first + 2 ] - bz;
					const b = ux * vx + uy * vy + uz * vz;
					const c = vx * vx + vy * vy + vz * vz;
					const d = ux * wx + uy * wy + uz * wz;
					const e = vx * wx + vy * wy + vz * wz;
					const denominator = a * c - b * b;
					let s = denominator > EPSILON ? ( b * e - c * d ) / denominator : 0;
					s = clamp( s, 0, 1 );
					let t = c > EPSILON ? ( b * s + e ) / c : 0;
					if ( t < 0 ) {

						t = 0;
						s = clamp( -d / a, 0, 1 );

					} else if ( t > 1 ) {

						t = 1;
						s = clamp( ( b - d ) / a, 0, 1 );

					}
					let dx = this.positions[ first ] + ux * s - bx - vx * t;
					let dy = this.positions[ first + 1 ] + uy * s - by - vy * t;
					let dz = this.positions[ first + 2 ] + uz * s - bz - vz * t;
					let distance = Math.hypot( dx, dy, dz );
					const segmentRadius = Math.max( this.radii[ firstScalar ], this.radii[ secondScalar ] );
					const required = this.bodyCapsules[ capsule + 6 ] + segmentRadius;
					if ( distance >= required ) continue;
					if ( distance <= EPSILON ) {

						dx = uy * vz - uz * vy;
						dy = uz * vx - ux * vz;
						dz = ux * vy - uy * vx;
						distance = Math.hypot( dx, dy, dz );
						if ( distance <= EPSILON ) {

							dx = 0;
							dy = 1;
							dz = 0;
							distance = 1;

						}

					}
					dx /= distance;
					dy /= distance;
					dz /= distance;
					const firstFactor = 1 - s;
					const secondFactor = s;
					// The shoulder/hip is a protected socket. Collisions may bend the
					// upper limb at that pivot but must never pull the girdle apart.
					const firstWeight = segment === 1 ? 0 : this.inverseMasses[ firstScalar ];
					const secondWeight = this.inverseMasses[ secondScalar ];
					const weight = firstWeight * firstFactor * firstFactor
						+ secondWeight * secondFactor * secondFactor;
					if ( weight <= EPSILON ) continue;
					const lambda = ( required - distance ) / weight;
					this.positions[ first ] += dx * firstWeight * firstFactor * lambda;
					this.positions[ first + 1 ] += dy * firstWeight * firstFactor * lambda;
					this.positions[ first + 2 ] += dz * firstWeight * firstFactor * lambda;
					this.positions[ second ] += dx * secondWeight * secondFactor * lambda;
					this.positions[ second + 1 ] += dy * secondWeight * secondFactor * lambda;
					this.positions[ second + 2 ] += dz * secondWeight * secondFactor * lambda;
					this._bodyCollisionCorrections ++;

				}

			}

		}

	}

	_solveSelfCollisions() {

		if ( ! this.selfCollision ) return;
		for ( let firstLimb = 0; firstLimb < PASSIVE_LIMB_COUNT - 1; firstLimb ++ ) {

			for ( let secondLimb = firstLimb + 1; secondLimb < PASSIVE_LIMB_COUNT; secondLimb ++ ) {

				// Segment zero is the internal girdle bridge. It is allowed to cross the
				// torso and its mirrored counterpart; collision starts at the true limb.
				for ( let firstSegment = 1; firstSegment < PASSIVE_LIMB_SEGMENT_COUNT; firstSegment ++ ) {

					const firstScalar = firstLimb * PASSIVE_LIMB_NODE_COUNT + firstSegment;
					const secondScalar = firstScalar + 1;
					const first = firstScalar * 3;
					const second = secondScalar * 3;
					const ux = this.positions[ second ] - this.positions[ first ];
					const uy = this.positions[ second + 1 ] - this.positions[ first + 1 ];
					const uz = this.positions[ second + 2 ] - this.positions[ first + 2 ];
					const a = ux * ux + uy * uy + uz * uz;
					if ( a <= EPSILON ) continue;
					for ( let secondSegment = 1; secondSegment < PASSIVE_LIMB_SEGMENT_COUNT; secondSegment ++ ) {

						const thirdScalar = secondLimb * PASSIVE_LIMB_NODE_COUNT + secondSegment;
						const fourthScalar = thirdScalar + 1;
						const third = thirdScalar * 3;
						const fourth = fourthScalar * 3;
						const vx = this.positions[ fourth ] - this.positions[ third ];
						const vy = this.positions[ fourth + 1 ] - this.positions[ third + 1 ];
						const vz = this.positions[ fourth + 2 ] - this.positions[ third + 2 ];
						const wx = this.positions[ first ] - this.positions[ third ];
						const wy = this.positions[ first + 1 ] - this.positions[ third + 1 ];
						const wz = this.positions[ first + 2 ] - this.positions[ third + 2 ];
						const b = ux * vx + uy * vy + uz * vz;
						const c = vx * vx + vy * vy + vz * vz;
						if ( c <= EPSILON ) continue;
						const d = ux * wx + uy * wy + uz * wz;
						const e = vx * wx + vy * wy + vz * wz;
						const denominator = a * c - b * b;
						let s = denominator > EPSILON ? ( b * e - c * d ) / denominator : 0;
						s = clamp( s, 0, 1 );
						let t = ( b * s + e ) / c;
						if ( t < 0 ) {

							t = 0;
							s = clamp( -d / a, 0, 1 );

						} else if ( t > 1 ) {

							t = 1;
							s = clamp( ( b - d ) / a, 0, 1 );

						}
						let dx = this.positions[ first ] + ux * s
							- this.positions[ third ] - vx * t;
						let dy = this.positions[ first + 1 ] + uy * s
							- this.positions[ third + 1 ] - vy * t;
						let dz = this.positions[ first + 2 ] + uz * s
							- this.positions[ third + 2 ] - vz * t;
						let distance = Math.hypot( dx, dy, dz );
						const firstRadius = Math.max( this.radii[ firstScalar ], this.radii[ secondScalar ] );
						const secondRadius = Math.max( this.radii[ thirdScalar ], this.radii[ fourthScalar ] );
						const required = firstRadius + secondRadius + this.selfCollisionMargin;
						if ( distance >= required ) continue;
						if ( distance <= EPSILON ) {

							dx = uy * vz - uz * vy;
							dy = uz * vx - ux * vz;
							dz = ux * vy - uy * vx;
							distance = Math.hypot( dx, dy, dz );
							if ( distance <= EPSILON ) {

								const axis = ( firstLimb * 13 + secondLimb * 7
									+ firstSegment * 3 + secondSegment ) % 3;
								dx = axis === 0 ? 1 : 0;
								dy = axis === 1 ? 1 : 0;
								dz = axis === 2 ? 1 : 0;
								distance = 1;

							}

						}
						dx /= distance;
						dy /= distance;
						dz /= distance;
						const firstFactor = 1 - s;
						const secondFactor = s;
						const thirdFactor = 1 - t;
						const fourthFactor = t;
						const firstWeight = firstSegment === 1
							? 0 : this.inverseMasses[ firstScalar ];
						const secondWeight = this.inverseMasses[ secondScalar ];
						const thirdWeight = secondSegment === 1
							? 0 : this.inverseMasses[ thirdScalar ];
						const fourthWeight = this.inverseMasses[ fourthScalar ];
						const weight = firstWeight * firstFactor * firstFactor
							+ secondWeight * secondFactor * secondFactor
							+ thirdWeight * thirdFactor * thirdFactor
							+ fourthWeight * fourthFactor * fourthFactor;
						if ( weight <= EPSILON ) continue;
						const lambda = ( required - distance ) / weight;
						this.positions[ first ] += dx * firstWeight * firstFactor * lambda;
						this.positions[ first + 1 ] += dy * firstWeight * firstFactor * lambda;
						this.positions[ first + 2 ] += dz * firstWeight * firstFactor * lambda;
						this.positions[ second ] += dx * secondWeight * secondFactor * lambda;
						this.positions[ second + 1 ] += dy * secondWeight * secondFactor * lambda;
						this.positions[ second + 2 ] += dz * secondWeight * secondFactor * lambda;
						this.positions[ third ] -= dx * thirdWeight * thirdFactor * lambda;
						this.positions[ third + 1 ] -= dy * thirdWeight * thirdFactor * lambda;
						this.positions[ third + 2 ] -= dz * thirdWeight * thirdFactor * lambda;
						this.positions[ fourth ] -= dx * fourthWeight * fourthFactor * lambda;
						this.positions[ fourth + 1 ] -= dy * fourthWeight * fourthFactor * lambda;
						this.positions[ fourth + 2 ] -= dz * fourthWeight * fourthFactor * lambda;
						this._selfCollisionCorrections ++;

					}

				}

			}

		}

	}

	_projectCollisions( projectPoint ) {

		this._collisionActive.fill( 0 );
		if ( typeof projectPoint !== 'function' ) return;
		for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

			for ( let node = 1; node < PASSIVE_LIMB_NODE_COUNT; node ++ ) {

				this._externalProjectionQueries ++;

				const scalar = limb * PASSIVE_LIMB_NODE_COUNT + node;
				const offset = scalar * 3;
				const point = this._collisionPoint;
				point.x = this.positions[ offset ];
				point.y = this.positions[ offset + 1 ];
				point.z = this.positions[ offset + 2 ];
				const projected = this._projectedPoint;
				projected.x = point.x;
				projected.y = point.y;
				projected.z = point.z;
				const normal = this._projectedNormal;
				normal.x = 0;
				normal.y = 1;
				normal.z = 0;
				if ( projectPoint( point, this.radii[ scalar ], projected, normal, limb, node ) !== true ) continue;
				const normalLength = Math.hypot( normal.x, normal.y, normal.z );
				if ( ! Number.isFinite( projected.x + projected.y + projected.z + normalLength )
					|| normalLength <= EPSILON ) {

					this._invalidCorrections ++;
					this.stats.invalidCorrections = this._invalidCorrections;
					continue;

				}
				const correctionX = projected.x - point.x;
				const correctionY = projected.y - point.y;
				const correctionZ = projected.z - point.z;
				this.positions[ offset ] = projected.x;
				this.positions[ offset + 1 ] = projected.y;
				this.positions[ offset + 2 ] = projected.z;
				this.previousPositions[ offset ] += correctionX;
				this.previousPositions[ offset + 1 ] += correctionY;
				this.previousPositions[ offset + 2 ] += correctionZ;

				const nx = normal.x / normalLength;
				const ny = normal.y / normalLength;
				const nz = normal.z / normalLength;
				this._collisionActive[ scalar ] = 1;
				this._collisionPlanes[ offset ] = projected.x;
				this._collisionPlanes[ offset + 1 ] = projected.y;
				this._collisionPlanes[ offset + 2 ] = projected.z;
				const normalOffset = PASSIVE_LIMB_COMPONENT_COUNT + offset;
				this._collisionPlanes[ normalOffset ] = nx;
				this._collisionPlanes[ normalOffset + 1 ] = ny;
				this._collisionPlanes[ normalOffset + 2 ] = nz;
				const vx = this.positions[ offset ] - this.previousPositions[ offset ];
				const vy = this.positions[ offset + 1 ] - this.previousPositions[ offset + 1 ];
				const vz = this.positions[ offset + 2 ] - this.previousPositions[ offset + 2 ];
				const normalVelocity = vx * nx + vy * ny + vz * nz;
				const tangentX = vx - nx * normalVelocity;
				const tangentY = vy - ny * normalVelocity;
				const tangentZ = vz - nz * normalVelocity;
				this.previousPositions[ offset ] += tangentX * this.collisionFriction;
				this.previousPositions[ offset + 1 ] += tangentY * this.collisionFriction;
				this.previousPositions[ offset + 2 ] += tangentZ * this.collisionFriction;

			}

		}
		this.stats.externalProjectionQueries = this._externalProjectionQueries;

	}

	_projectCachedCollisions() {

		for ( let scalar = 0; scalar < PASSIVE_LIMB_COUNT * PASSIVE_LIMB_NODE_COUNT; scalar ++ ) {

			if ( this._collisionActive[ scalar ] === 0 ) continue;
			const offset = scalar * 3;
			const normalOffset = PASSIVE_LIMB_COMPONENT_COUNT + offset;
			const nx = this._collisionPlanes[ normalOffset ];
			const ny = this._collisionPlanes[ normalOffset + 1 ];
			const nz = this._collisionPlanes[ normalOffset + 2 ];
			const signedDistance =
				( this.positions[ offset ] - this._collisionPlanes[ offset ] ) * nx
				+ ( this.positions[ offset + 1 ] - this._collisionPlanes[ offset + 1 ] ) * ny
				+ ( this.positions[ offset + 2 ] - this._collisionPlanes[ offset + 2 ] ) * nz;
			if ( signedDistance >= 0 ) continue;
			const correctionX = -signedDistance * nx;
			const correctionY = -signedDistance * ny;
			const correctionZ = -signedDistance * nz;
			this.positions[ offset ] += correctionX;
			this.positions[ offset + 1 ] += correctionY;
			this.positions[ offset + 2 ] += correctionZ;
			this.previousPositions[ offset ] += correctionX;
			this.previousPositions[ offset + 1 ] += correctionY;
			this.previousPositions[ offset + 2 ] += correctionZ;

		}

	}

	_limitVelocity() {

		const maximum = this.maxSpeed * this.fixedDt;
		for ( let scalar = 0; scalar < PASSIVE_LIMB_COUNT * PASSIVE_LIMB_NODE_COUNT; scalar ++ ) {

			if ( this.inverseMasses[ scalar ] <= 0 ) continue;
			const offset = scalar * 3;
			const dx = this.positions[ offset ] - this.previousPositions[ offset ];
			const dy = this.positions[ offset + 1 ] - this.previousPositions[ offset + 1 ];
			const dz = this.positions[ offset + 2 ] - this.previousPositions[ offset + 2 ];
			const distance = Math.hypot( dx, dy, dz );
			if ( ! Number.isFinite( distance ) ) {

				this.positions[ offset ] = this.renderPreviousPositions[ offset ];
				this.positions[ offset + 1 ] = this.renderPreviousPositions[ offset + 1 ];
				this.positions[ offset + 2 ] = this.renderPreviousPositions[ offset + 2 ];
				this.previousPositions[ offset ] = this.positions[ offset ];
				this.previousPositions[ offset + 1 ] = this.positions[ offset + 1 ];
				this.previousPositions[ offset + 2 ] = this.positions[ offset + 2 ];
				this._invalidCorrections ++;
				this.stats.invalidCorrections = this._invalidCorrections;
				continue;

			}
			if ( distance <= maximum || distance <= EPSILON ) continue;
			const scale = maximum / distance;
			this.previousPositions[ offset ] = this.positions[ offset ] - dx * scale;
			this.previousPositions[ offset + 1 ] = this.positions[ offset + 1 ] - dy * scale;
			this.previousPositions[ offset + 2 ] = this.positions[ offset + 2 ] - dz * scale;

		}

	}

	stepFixed( rootAnchors = null, projectPoint = null ) {

		if ( rootAnchors ) this.setRootAnchors( rootAnchors );
		this.renderPreviousPositions.set( this.positions );
		const retention = Math.exp( -this.damping * this.fixedDt );
		const gravityScale = this.fixedDt * this.fixedDt;
		for ( let scalar = 0; scalar < PASSIVE_LIMB_COUNT * PASSIVE_LIMB_NODE_COUNT; scalar ++ ) {

			if ( this.inverseMasses[ scalar ] <= 0 ) continue;
			const offset = scalar * 3;
			const x = this.positions[ offset ];
			const y = this.positions[ offset + 1 ];
			const z = this.positions[ offset + 2 ];
			const vx = ( x - this.previousPositions[ offset ] ) * retention;
			const vy = ( y - this.previousPositions[ offset + 1 ] ) * retention;
			const vz = ( z - this.previousPositions[ offset + 2 ] ) * retention;
			this.previousPositions[ offset ] = x;
			this.previousPositions[ offset + 1 ] = y;
			this.previousPositions[ offset + 2 ] = z;
			this.positions[ offset ] = x + vx + this.gravityX * gravityScale;
			this.positions[ offset + 1 ] = y + vy + this.gravityY * gravityScale;
			this.positions[ offset + 2 ] = z + vz + this.gravityZ * gravityScale;

		}
		this._pinRoots();
		this.segmentLambdas.fill( 0 );
		this.bendLambdas.fill( 0 );
		const stretchAlpha = this.stretchCompliance / ( this.fixedDt * this.fixedDt );
		const bendAlpha = this.bendCompliance / ( this.fixedDt * this.fixedDt );
		const muscleResponse = this.muscleTone > 0
			? 1 - Math.exp( -this.muscleTone * 40 * this.fixedDt / this.solverIterations ) : 0;
		const collisionIteration = Math.min(
			this.solverIterations - 1, Math.floor( this.solverIterations * 0.35 ),
		);
		for ( let iteration = 0; iteration < this.solverIterations; iteration ++ ) {

			this._solveMuscleTone( muscleResponse );
			const reverse = ( iteration & 1 ) === 1;
			for ( let limbStep = 0; limbStep < PASSIVE_LIMB_COUNT; limbStep ++ ) {

				const limb = reverse ? PASSIVE_LIMB_COUNT - 1 - limbStep : limbStep;
				for ( let bendStep = 0; bendStep < PASSIVE_LIMB_NODE_COUNT - 2; bendStep ++ ) {

					const bend = reverse ? PASSIVE_LIMB_NODE_COUNT - 3 - bendStep : bendStep;
					this._solveBendRange( limb, bend, bendAlpha );

				}
				// Finish each limb with its ligament lengths. A final bend correction
				// used to leave the short girdle stretched by several centimetres while
				// the animal was held; this ordering keeps sockets anatomically attached.
				for ( let segmentStep = 0; segmentStep < PASSIVE_LIMB_SEGMENT_COUNT; segmentStep ++ ) {

					const segment = reverse ? PASSIVE_LIMB_SEGMENT_COUNT - 1 - segmentStep : segmentStep;
					const firstScalar = limb * PASSIVE_LIMB_NODE_COUNT + segment;
					const secondScalar = firstScalar + 1;
					const index = segmentOffset( limb, segment );
					this._solveDistance(
						firstScalar, secondScalar, this.segmentLengths[ index ], index,
						stretchAlpha, this.segmentLambdas,
					);

				}
			}
			this._solveBodyCollisions();
			this._solveSelfCollisions();
			this._pinRoots();
			if ( iteration === collisionIteration ) this._projectCollisions( projectPoint );
			else if ( iteration > collisionIteration ) this._projectCachedCollisions();

		}
		this._pinRoots();
		this._projectCachedCollisions();
		this._limitVelocity();
		this._steps ++;
		this.stats.steps = this._steps;
		this.stats.selfCollisionCorrections = this._selfCollisionCorrections;
		this.stats.bodyCollisionCorrections = this._bodyCollisionCorrections;
		return this.view;

	}

	interpolate( alpha = 1, output = this.interpolatedPositions ) {

		alpha = clamp( finite( 'alpha', alpha ), 0, 1 );
		if ( ! output || output.length < PASSIVE_LIMB_COMPONENT_COUNT )
			throw new TypeError( 'interpolation buffer is too short' );
		for ( let index = 0; index < PASSIVE_LIMB_COMPONENT_COUNT; index ++ )
			output[ index ] = this.renderPreviousPositions[ index ]
				+ ( this.positions[ index ] - this.renderPreviousPositions[ index ] ) * alpha;
		return output;

	}

	applyImpulse( limb, node, impulse ) {

		if ( ! Number.isInteger( limb ) || limb < 0 || limb >= PASSIVE_LIMB_COUNT )
			throw new RangeError( 'invalid limb index' );
		if ( ! Number.isInteger( node ) || node <= 0 || node >= PASSIVE_LIMB_NODE_COUNT )
			throw new RangeError( 'invalid passive node index' );
		const scalar = limb * PASSIVE_LIMB_NODE_COUNT + node;
		const offset = scalar * 3;
		const scale = this.fixedDt * this.inverseMasses[ scalar ];
		this.previousPositions[ offset ] -= finite( 'impulse.x', impulse?.x ?? 0 ) * scale;
		this.previousPositions[ offset + 1 ] -= finite( 'impulse.y', impulse?.y ?? 0 ) * scale;
		this.previousPositions[ offset + 2 ] -= finite( 'impulse.z', impulse?.z ?? 0 ) * scale;
		return this;

	}

	maxSegmentError() {

		let maximum = 0;
		for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

			for ( let segment = 0; segment < PASSIVE_LIMB_SEGMENT_COUNT; segment ++ ) {

				const first = componentOffset( limb, segment );
				const second = componentOffset( limb, segment + 1 );
				const length = Math.hypot(
					this.positions[ second ] - this.positions[ first ],
					this.positions[ second + 1 ] - this.positions[ first + 1 ],
					this.positions[ second + 2 ] - this.positions[ first + 2 ],
				);
				maximum = Math.max(
					maximum,
					Math.abs( length - this.segmentLengths[ segmentOffset( limb, segment ) ] ),
				);

			}

		}
		return maximum;

	}

	getView() {

		return this.view;

	}

	isFinite() {

		return allFinite( this.positions )
			&& allFinite( this.previousPositions )
			&& allFinite( this.renderPreviousPositions )
			&& allFinite( this.interpolatedPositions );

	}

}
