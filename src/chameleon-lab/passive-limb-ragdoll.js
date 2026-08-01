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
 * It intentionally has no pose motor. Distance and bend-range constraints are
 * the passive ligaments; gravity, inertia and collisions produce the pose.
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
		this.segmentLambdas = new Float64Array( this.segmentLengths.length );
		this.bendLambdas = new Float64Array( this.bendMinimumLengths.length );
		this._collisionPoint = Object.seal( { x: 0, y: 0, z: 0 } );
		this._projectedPoint = Object.seal( { x: 0, y: 0, z: 0 } );
		this._projectedNormal = Object.seal( { x: 0, y: 1, z: 0 } );
		this._steps = 0;
		this._invalidCorrections = 0;
		this.stats = Object.seal( {
			steps: 0,
			invalidCorrections: 0,
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

	_projectCollisions( projectPoint ) {

		if ( typeof projectPoint !== 'function' ) return;
		for ( let limb = 0; limb < PASSIVE_LIMB_COUNT; limb ++ ) {

			for ( let node = 1; node < PASSIVE_LIMB_NODE_COUNT; node ++ ) {

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
		for ( let iteration = 0; iteration < this.solverIterations; iteration ++ ) {

			const reverse = ( iteration & 1 ) === 1;
			for ( let limbStep = 0; limbStep < PASSIVE_LIMB_COUNT; limbStep ++ ) {

				const limb = reverse ? PASSIVE_LIMB_COUNT - 1 - limbStep : limbStep;
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
				for ( let bendStep = 0; bendStep < PASSIVE_LIMB_NODE_COUNT - 2; bendStep ++ ) {

					const bend = reverse ? PASSIVE_LIMB_NODE_COUNT - 3 - bendStep : bendStep;
					this._solveBendRange( limb, bend, bendAlpha );

				}

			}
			this._pinRoots();
			this._projectCollisions( projectPoint );

		}
		this._pinRoots();
		this._limitVelocity();
		this._steps ++;
		this.stats.steps = this._steps;
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
