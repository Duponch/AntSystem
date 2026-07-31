// Twelve tail bones require thirteen samples: one sample at each bone origin
// plus the physical tip used to orient tail_12 without extrapolation.
export const PASSIVE_TAIL_NODE_COUNT = 13;
export const PASSIVE_TAIL_SEGMENT_COUNT = PASSIVE_TAIL_NODE_COUNT - 1;
export const PASSIVE_TAIL_BONE_COUNT = PASSIVE_TAIL_SEGMENT_COUNT;
export const PASSIVE_TAIL_BEND_CONSTRAINT_COUNT = PASSIVE_TAIL_NODE_COUNT - 2;

const COMPONENT_COUNT = PASSIVE_TAIL_NODE_COUNT * 3;
const EPSILON = 1e-9;

function finiteNumber( name, value ) {

	if ( ! Number.isFinite( value ) ) throw new RangeError( name + ' must be finite' );
	return value;

}

function positiveNumber( name, value ) {

	value = finiteNumber( name, value );
	if ( value <= 0 ) throw new RangeError( name + ' must be greater than zero' );
	return value;

}

function nonNegativeNumber( name, value ) {

	return Math.max( 0, finiteNumber( name, value ) );

}

function vectorComponent( name, value, key, fallback = 0 ) {

	return finiteNumber( name + '.' + key, value?.[ key ] ?? fallback );

}

function fillPositiveArray( name, target, source, fallback ) {

	if ( source === undefined ) source = fallback;
	if ( typeof source === 'number' ) {

		target.fill( positiveNumber( name, source ) );
		return;

	}
	if ( ! source || source.length < target.length )
		throw new TypeError( name + ' must contain ' + target.length + ' positive values' );
	for ( let index = 0; index < target.length; index ++ )
		target[ index ] = positiveNumber( name + '[' + index + ']', source[ index ] );

}

function finiteBuffer( buffer ) {

	for ( let index = 0; index < buffer.length; index ++ )
		if ( ! Number.isFinite( buffer[ index ] ) ) return false;
	return true;

}

/**
 * Constant-size passive XPBD rod for twelve tail bones and their terminal tip.
 * Node zero is kinematic and follows the body root. No target pose, motor,
 * muscular force, or muscular torque exists in this layer.
 */
export class PassiveTailPhysics {

	constructor( options = {} ) {

		this.nodeCount = PASSIVE_TAIL_NODE_COUNT;
		this.segmentCount = PASSIVE_TAIL_SEGMENT_COUNT;
		this.fixedDt = positiveNumber( 'fixedDt', options.fixedDt ?? 1 / 120 );
		this.maxSubsteps = options.maxSubsteps ?? 8;
		if ( ! Number.isInteger( this.maxSubsteps ) || this.maxSubsteps < 1 )
			throw new RangeError( 'maxSubsteps must be a positive integer' );
		this.solverIterations = options.solverIterations ?? 8;
		if ( ! Number.isInteger( this.solverIterations )
			|| this.solverIterations < 1 || this.solverIterations > 32 )
			throw new RangeError( 'solverIterations must be an integer from 1 to 32' );

		this.stretchCompliance = nonNegativeNumber(
			'stretchCompliance', options.stretchCompliance ?? options.compliance ?? 0,
		);
		this.bendCompliance = nonNegativeNumber(
			'bendCompliance', options.bendCompliance ?? 2e-5,
		);
		this.damping = nonNegativeNumber( 'damping', options.damping ?? 1.35 );
		this.collisionFriction = Math.min( 1, nonNegativeNumber(
			'collisionFriction', options.collisionFriction ?? 0.18,
		) );
		this.maxSpeed = positiveNumber( 'maxSpeed', options.maxSpeed ?? 12 );
		this.projectPoint = options.projectPoint ?? null;
		if ( this.projectPoint !== null && typeof this.projectPoint !== 'function' )
			throw new TypeError( 'projectPoint must be a function or null' );

		this.gravityX = vectorComponent( 'gravity', options.gravity, 'x', 0 );
		this.gravityY = vectorComponent( 'gravity', options.gravity, 'y', -9.81 );
		this.gravityZ = vectorComponent( 'gravity', options.gravity, 'z', 0 );
		this.rootX = vectorComponent( 'rootPosition', options.rootPosition, 'x', 0 );
		this.rootY = vectorComponent( 'rootPosition', options.rootPosition, 'y', 0 );
		this.rootZ = vectorComponent( 'rootPosition', options.rootPosition, 'z', 0 );

		this.positions = new Float32Array( COMPONENT_COUNT );
		this.previousPositions = new Float32Array( COMPONENT_COUNT );
		this.renderPreviousPositions = new Float32Array( COMPONENT_COUNT );
		this.interpolatedPositions = new Float32Array( COMPONENT_COUNT );
		this.restOffsets = new Float32Array( COMPONENT_COUNT );
		this.segmentLengths = new Float32Array( PASSIVE_TAIL_SEGMENT_COUNT );
		this.bendLengths = new Float32Array( PASSIVE_TAIL_BEND_CONSTRAINT_COUNT );
		this.radii = new Float32Array( PASSIVE_TAIL_NODE_COUNT );
		this.inverseMasses = new Float32Array( PASSIVE_TAIL_NODE_COUNT );
		this.segmentLambdas = new Float64Array( PASSIVE_TAIL_SEGMENT_COUNT );
		this.bendLambdas = new Float64Array( PASSIVE_TAIL_BEND_CONSTRAINT_COUNT );
		this.inverseMasses.fill( 1 );
		this.inverseMasses[ 0 ] = 0;
		fillPositiveArray( 'radii', this.radii, options.radii ?? options.radius, 0.014 );
		this._initializeRestShape( options );

		this._collisionPoint = Object.seal( { x: 0, y: 0, z: 0 } );
		this._projectedPoint = Object.seal( { x: 0, y: 0, z: 0 } );
		this._projectedNormal = Object.seal( { x: 0, y: 1, z: 0 } );
		this._accumulator = 0;
		this._totalSteps = 0;
		this._invalidCorrections = 0;
		this._rejectedProjections = 0;
		this._advanceResult = Object.seal( {
			steps: 0,
			alpha: 0,
			droppedSeconds: 0,
		} );
		this.stats = Object.seal( {
			totalSteps: 0,
			invalidCorrections: 0,
			rejectedProjections: 0,
		} );
		this.view = Object.seal( {
			nodeCount: PASSIVE_TAIL_NODE_COUNT,
			segmentCount: PASSIVE_TAIL_SEGMENT_COUNT,
			positions: this.positions,
			previousPositions: this.renderPreviousPositions,
			interpolatedPositions: this.interpolatedPositions,
			segmentLengths: this.segmentLengths,
			bendLengths: this.bendLengths,
			radii: this.radii,
		} );
		this.reset( { x: this.rootX, y: this.rootY, z: this.rootZ } );

	}

	_initializeRestShape( options ) {

		const initial = options.initialPositions;
		if ( initial !== undefined ) {

			if ( ! initial || initial.length < COMPONENT_COUNT )
				throw new TypeError( 'initialPositions must contain ' + COMPONENT_COUNT + ' values' );
			const originX = finiteNumber( 'initialPositions[0]', initial[ 0 ] );
			const originY = finiteNumber( 'initialPositions[1]', initial[ 1 ] );
			const originZ = finiteNumber( 'initialPositions[2]', initial[ 2 ] );
			for ( let node = 0; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

				const offset = node * 3;
				this.restOffsets[ offset ] = finiteNumber(
					'initialPositions.x', initial[ offset ],
				) - originX;
				this.restOffsets[ offset + 1 ] = finiteNumber(
					'initialPositions.y', initial[ offset + 1 ],
				) - originY;
				this.restOffsets[ offset + 2 ] = finiteNumber(
					'initialPositions.z', initial[ offset + 2 ],
				) - originZ;

			}

		} else {

			const directionX = vectorComponent(
				'direction', options.direction ?? { x: 1, y: 0, z: 0 }, 'x',
			);
			const directionY = vectorComponent(
				'direction', options.direction ?? { x: 1, y: 0, z: 0 }, 'y',
			);
			const directionZ = vectorComponent(
				'direction', options.direction ?? { x: 1, y: 0, z: 0 }, 'z',
			);
			const directionLength = Math.hypot( directionX, directionY, directionZ );
			if ( directionLength <= EPSILON ) throw new RangeError( 'direction must be non-zero' );
			fillPositiveArray(
				'segmentLengths', this.segmentLengths,
				options.segmentLengths ?? options.segmentLength, 0.075,
			);
			let distance = 0;
			for ( let node = 1; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

				distance += this.segmentLengths[ node - 1 ];
				const offset = node * 3;
				this.restOffsets[ offset ] = directionX / directionLength * distance;
				this.restOffsets[ offset + 1 ] = directionY / directionLength * distance;
				this.restOffsets[ offset + 2 ] = directionZ / directionLength * distance;

			}

		}

		for ( let segment = 0; segment < PASSIVE_TAIL_SEGMENT_COUNT; segment ++ ) {

			const first = segment * 3;
			const second = first + 3;
			this.segmentLengths[ segment ] = positiveNumber( 'segment length', Math.hypot(
				this.restOffsets[ second ] - this.restOffsets[ first ],
				this.restOffsets[ second + 1 ] - this.restOffsets[ first + 1 ],
				this.restOffsets[ second + 2 ] - this.restOffsets[ first + 2 ],
			) );

		}
		for ( let bend = 0; bend < PASSIVE_TAIL_BEND_CONSTRAINT_COUNT; bend ++ ) {

			const first = bend * 3;
			const second = first + 6;
			this.bendLengths[ bend ] = positiveNumber( 'bend length', Math.hypot(
				this.restOffsets[ second ] - this.restOffsets[ first ],
				this.restOffsets[ second + 1 ] - this.restOffsets[ first + 1 ],
				this.restOffsets[ second + 2 ] - this.restOffsets[ first + 2 ],
			) );

		}

	}

	setRoot( rootPosition ) {

		this.rootX = vectorComponent( 'rootPosition', rootPosition, 'x' );
		this.rootY = vectorComponent( 'rootPosition', rootPosition, 'y' );
		this.rootZ = vectorComponent( 'rootPosition', rootPosition, 'z' );
		return this;

	}

	reset( rootPosition = { x: this.rootX, y: this.rootY, z: this.rootZ } ) {

		this.setRoot( rootPosition );
		for ( let node = 0; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

			const offset = node * 3;
			this.positions[ offset ] = this.rootX + this.restOffsets[ offset ];
			this.positions[ offset + 1 ] = this.rootY + this.restOffsets[ offset + 1 ];
			this.positions[ offset + 2 ] = this.rootZ + this.restOffsets[ offset + 2 ];

		}
		this.previousPositions.set( this.positions );
		this.renderPreviousPositions.set( this.positions );
		this.interpolatedPositions.set( this.positions );
		this.segmentLambdas.fill( 0 );
		this.bendLambdas.fill( 0 );
		this._accumulator = 0;
		this._advanceResult.steps = 0;
		this._advanceResult.alpha = 0;
		this._advanceResult.droppedSeconds = 0;
		return this;

	}

	_pinRoot() {

		this.positions[ 0 ] = this.rootX;
		this.positions[ 1 ] = this.rootY;
		this.positions[ 2 ] = this.rootZ;
		this.previousPositions[ 0 ] = this.rootX;
		this.previousPositions[ 1 ] = this.rootY;
		this.previousPositions[ 2 ] = this.rootZ;

	}

	_solveDistance( firstNode, secondNode, restLength, lambdas, lambdaIndex, alpha ) {

		const first = firstNode * 3;
		const second = secondNode * 3;
		let dx = this.positions[ second ] - this.positions[ first ];
		let dy = this.positions[ second + 1 ] - this.positions[ first + 1 ];
		let dz = this.positions[ second + 2 ] - this.positions[ first + 2 ];
		let length = Math.hypot( dx, dy, dz );
		if ( length <= EPSILON ) {

			dx = this.restOffsets[ second ] - this.restOffsets[ first ];
			dy = this.restOffsets[ second + 1 ] - this.restOffsets[ first + 1 ];
			dz = this.restOffsets[ second + 2 ] - this.restOffsets[ first + 2 ];
			length = Math.hypot( dx, dy, dz );

		}
		const inverseLength = 1 / Math.max( length, EPSILON );
		const nx = dx * inverseLength;
		const ny = dy * inverseLength;
		const nz = dz * inverseLength;
		const firstWeight = this.inverseMasses[ firstNode ];
		const secondWeight = this.inverseMasses[ secondNode ];
		const denominator = firstWeight + secondWeight + alpha;
		if ( denominator <= EPSILON ) return;
		const constraint = length - restLength;
		const deltaLambda = ( -constraint - alpha * lambdas[ lambdaIndex ] ) / denominator;
		lambdas[ lambdaIndex ] += deltaLambda;
		this.positions[ first ] -= firstWeight * nx * deltaLambda;
		this.positions[ first + 1 ] -= firstWeight * ny * deltaLambda;
		this.positions[ first + 2 ] -= firstWeight * nz * deltaLambda;
		this.positions[ second ] += secondWeight * nx * deltaLambda;
		this.positions[ second + 1 ] += secondWeight * ny * deltaLambda;
		this.positions[ second + 2 ] += secondWeight * nz * deltaLambda;

	}

	_projectCollisions( projectPoint ) {

		if ( typeof projectPoint !== 'function' ) return;
		const point = this._collisionPoint;
		const projected = this._projectedPoint;
		const normal = this._projectedNormal;
		for ( let node = 1; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

			const offset = node * 3;
			point.x = this.positions[ offset ];
			point.y = this.positions[ offset + 1 ];
			point.z = this.positions[ offset + 2 ];
			projected.x = point.x;
			projected.y = point.y;
			projected.z = point.z;
			normal.x = 0;
			normal.y = 1;
			normal.z = 0;
			if ( projectPoint( point, this.radii[ node ], projected, normal ) !== true ) continue;
			const values = projected.x + projected.y + projected.z
				+ normal.x + normal.y + normal.z;
			const normalLength = Math.hypot( normal.x, normal.y, normal.z );
			if ( ! Number.isFinite( values ) || normalLength <= EPSILON ) {

				this._rejectedProjections ++;
				continue;

			}
			const nx = normal.x / normalLength;
			const ny = normal.y / normalLength;
			const nz = normal.z / normalLength;
			const correctionX = projected.x - point.x;
			const correctionY = projected.y - point.y;
			const correctionZ = projected.z - point.z;
			this.positions[ offset ] = projected.x;
			this.positions[ offset + 1 ] = projected.y;
			this.positions[ offset + 2 ] = projected.z;
			this.previousPositions[ offset ] += correctionX;
			this.previousPositions[ offset + 1 ] += correctionY;
			this.previousPositions[ offset + 2 ] += correctionZ;

			let velocityX = this.positions[ offset ] - this.previousPositions[ offset ];
			let velocityY = this.positions[ offset + 1 ] - this.previousPositions[ offset + 1 ];
			let velocityZ = this.positions[ offset + 2 ] - this.previousPositions[ offset + 2 ];
			const normalVelocity = velocityX * nx + velocityY * ny + velocityZ * nz;
			if ( normalVelocity < 0 ) {

				this.previousPositions[ offset ] += nx * normalVelocity;
				this.previousPositions[ offset + 1 ] += ny * normalVelocity;
				this.previousPositions[ offset + 2 ] += nz * normalVelocity;
				velocityX -= nx * normalVelocity;
				velocityY -= ny * normalVelocity;
				velocityZ -= nz * normalVelocity;

			}
			const remainingNormalVelocity = velocityX * nx + velocityY * ny + velocityZ * nz;
			const tangentX = velocityX - nx * remainingNormalVelocity;
			const tangentY = velocityY - ny * remainingNormalVelocity;
			const tangentZ = velocityZ - nz * remainingNormalVelocity;
			this.previousPositions[ offset ] += tangentX * this.collisionFriction;
			this.previousPositions[ offset + 1 ] += tangentY * this.collisionFriction;
			this.previousPositions[ offset + 2 ] += tangentZ * this.collisionFriction;

		}

	}

	_limitVelocitiesAndRecover() {

		const maximumDisplacement = this.maxSpeed * this.fixedDt;
		for ( let node = 1; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

			const offset = node * 3;
			if ( ! Number.isFinite( this.positions[ offset ] + this.positions[ offset + 1 ]
				+ this.positions[ offset + 2 ] ) ) {

				this.positions[ offset ] = this.renderPreviousPositions[ offset ];
				this.positions[ offset + 1 ] = this.renderPreviousPositions[ offset + 1 ];
				this.positions[ offset + 2 ] = this.renderPreviousPositions[ offset + 2 ];
				this.previousPositions[ offset ] = this.positions[ offset ];
				this.previousPositions[ offset + 1 ] = this.positions[ offset + 1 ];
				this.previousPositions[ offset + 2 ] = this.positions[ offset + 2 ];
				this._invalidCorrections ++;
				continue;

			}
			const dx = this.positions[ offset ] - this.previousPositions[ offset ];
			const dy = this.positions[ offset + 1 ] - this.previousPositions[ offset + 1 ];
			const dz = this.positions[ offset + 2 ] - this.previousPositions[ offset + 2 ];
			const displacement = Math.hypot( dx, dy, dz );
			if ( displacement <= maximumDisplacement || displacement <= EPSILON ) continue;
			const scale = maximumDisplacement / displacement;
			this.previousPositions[ offset ] = this.positions[ offset ] - dx * scale;
			this.previousPositions[ offset + 1 ] = this.positions[ offset + 1 ] - dy * scale;
			this.previousPositions[ offset + 2 ] = this.positions[ offset + 2 ] - dz * scale;

		}

	}

	stepFixed( rootPosition = null, projectPoint = this.projectPoint ) {

		if ( rootPosition !== null ) this.setRoot( rootPosition );
		if ( projectPoint !== null && typeof projectPoint !== 'function' )
			throw new TypeError( 'projectPoint must be a function or null' );
		this.renderPreviousPositions.set( this.positions );
		const velocityRetention = Math.exp( -this.damping * this.fixedDt );
		const gravityScale = this.fixedDt * this.fixedDt;
		for ( let node = 1; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

			const offset = node * 3;
			const x = this.positions[ offset ];
			const y = this.positions[ offset + 1 ];
			const z = this.positions[ offset + 2 ];
			const velocityX = ( x - this.previousPositions[ offset ] ) * velocityRetention;
			const velocityY = ( y - this.previousPositions[ offset + 1 ] ) * velocityRetention;
			const velocityZ = ( z - this.previousPositions[ offset + 2 ] ) * velocityRetention;
			this.previousPositions[ offset ] = x;
			this.previousPositions[ offset + 1 ] = y;
			this.previousPositions[ offset + 2 ] = z;
			this.positions[ offset ] = x + velocityX + this.gravityX * gravityScale;
			this.positions[ offset + 1 ] = y + velocityY + this.gravityY * gravityScale;
			this.positions[ offset + 2 ] = z + velocityZ + this.gravityZ * gravityScale;

		}
		this._pinRoot();
		this.segmentLambdas.fill( 0 );
		this.bendLambdas.fill( 0 );
		const stretchAlpha = this.stretchCompliance / ( this.fixedDt * this.fixedDt );
		const bendAlpha = this.bendCompliance / ( this.fixedDt * this.fixedDt );
		for ( let iteration = 0; iteration < this.solverIterations; iteration ++ ) {

			if ( iteration % 2 === 0 ) {

				for ( let segment = 0; segment < PASSIVE_TAIL_SEGMENT_COUNT; segment ++ )
					this._solveDistance(
						segment, segment + 1, this.segmentLengths[ segment ],
						this.segmentLambdas, segment, stretchAlpha,
					);
				for ( let bend = 0; bend < PASSIVE_TAIL_BEND_CONSTRAINT_COUNT; bend ++ )
					this._solveDistance(
						bend, bend + 2, this.bendLengths[ bend ],
						this.bendLambdas, bend, bendAlpha,
					);

			} else {

				for ( let bend = PASSIVE_TAIL_BEND_CONSTRAINT_COUNT - 1; bend >= 0; bend -- )
					this._solveDistance(
						bend, bend + 2, this.bendLengths[ bend ],
						this.bendLambdas, bend, bendAlpha,
					);
				for ( let segment = PASSIVE_TAIL_SEGMENT_COUNT - 1; segment >= 0; segment -- )
					this._solveDistance(
						segment, segment + 1, this.segmentLengths[ segment ],
						this.segmentLambdas, segment, stretchAlpha,
					);

			}
			this._pinRoot();
			this._projectCollisions( projectPoint );

		}
		this._pinRoot();
		this._limitVelocitiesAndRecover();
		this._totalSteps ++;
		this.stats.totalSteps = this._totalSteps;
		this.stats.invalidCorrections = this._invalidCorrections;
		this.stats.rejectedProjections = this._rejectedProjections;
		return this.view;

	}

	advance( frameDt, rootPosition = null, projectPoint = this.projectPoint ) {

		frameDt = finiteNumber( 'frameDt', frameDt );
		if ( frameDt < 0 ) throw new RangeError( 'frameDt must be non-negative' );
		if ( rootPosition !== null ) this.setRoot( rootPosition );
		const maximumAccumulated = this.fixedDt * this.maxSubsteps;
		const accepted = Math.min(
			frameDt, Math.max( 0, maximumAccumulated - this._accumulator ),
		);
		const dropped = frameDt - accepted;
		this._accumulator += accepted;
		let steps = 0;
		while ( steps < this.maxSubsteps
			&& this._accumulator + this.fixedDt * 1e-9 >= this.fixedDt ) {

			this.stepFixed( null, projectPoint );
			this._accumulator -= this.fixedDt;
			if ( this._accumulator < EPSILON ) this._accumulator = 0;
			steps ++;

		}
		const alpha = Math.max( 0, Math.min( 1, this._accumulator / this.fixedDt ) );
		this.interpolate( alpha );
		this._advanceResult.steps = steps;
		this._advanceResult.alpha = alpha;
		this._advanceResult.droppedSeconds = dropped;
		return this._advanceResult;

	}

	applyImpulse( nodeIndex, impulse ) {

		if ( ! Number.isInteger( nodeIndex ) || nodeIndex <= 0
			|| nodeIndex >= PASSIVE_TAIL_NODE_COUNT )
			throw new RangeError( 'nodeIndex must identify a passive node' );
		const offset = nodeIndex * 3;
		const scale = this.fixedDt * this.inverseMasses[ nodeIndex ];
		this.previousPositions[ offset ] -= vectorComponent( 'impulse', impulse, 'x' ) * scale;
		this.previousPositions[ offset + 1 ] -= vectorComponent( 'impulse', impulse, 'y' ) * scale;
		this.previousPositions[ offset + 2 ] -= vectorComponent( 'impulse', impulse, 'z' ) * scale;
		return this;

	}

	interpolate( alpha, output = this.interpolatedPositions ) {

		alpha = Math.max( 0, Math.min( 1, finiteNumber( 'alpha', alpha ) ) );
		if ( ! output || output.length < COMPONENT_COUNT )
			throw new TypeError( 'output must contain ' + COMPONENT_COUNT + ' values' );
		for ( let index = 0; index < COMPONENT_COUNT; index ++ )
			output[ index ] = this.renderPreviousPositions[ index ]
				+ ( this.positions[ index ] - this.renderPreviousPositions[ index ] ) * alpha;
		return output;

	}

	getView() {

		return this.view;

	}

	kineticEnergy() {

		const inverseDt = 1 / this.fixedDt;
		let energy = 0;
		for ( let node = 1; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

			const offset = node * 3;
			const vx = ( this.positions[ offset ] - this.previousPositions[ offset ] ) * inverseDt;
			const vy = ( this.positions[ offset + 1 ] - this.previousPositions[ offset + 1 ] ) * inverseDt;
			const vz = ( this.positions[ offset + 2 ] - this.previousPositions[ offset + 2 ] ) * inverseDt;
			const mass = 1 / this.inverseMasses[ node ];
			energy += 0.5 * mass * ( vx * vx + vy * vy + vz * vz );

		}
		return energy;

	}

	maximumKineticEnergy() {

		return 0.5 * ( PASSIVE_TAIL_NODE_COUNT - 1 ) * this.maxSpeed * this.maxSpeed;

	}

	maxSegmentError() {

		let maximum = 0;
		for ( let segment = 0; segment < PASSIVE_TAIL_SEGMENT_COUNT; segment ++ ) {

			const first = segment * 3;
			const second = first + 3;
			const length = Math.hypot(
				this.positions[ second ] - this.positions[ first ],
				this.positions[ second + 1 ] - this.positions[ first + 1 ],
				this.positions[ second + 2 ] - this.positions[ first + 2 ],
			);
			maximum = Math.max(
				maximum, Math.abs( length - this.segmentLengths[ segment ] ),
			);

		}
		return maximum;

	}

	isFinite() {

		return finiteBuffer( this.positions )
			&& finiteBuffer( this.previousPositions )
			&& finiteBuffer( this.renderPreviousPositions )
			&& finiteBuffer( this.interpolatedPositions );

	}

}

export function createPassiveTailPhysics( options = {} ) {

	return new PassiveTailPhysics( options );

}
