import { createChameleonSurfaceHit } from './chameleon-surface-collider.js';

export const CHAMELEON_BODY_PROBE_COUNT = 3;
// A probe contributes one exact closest-point constraint plus the hit face and
// its three edge neighbours. Three probes therefore need 15 fixed slots.
export const CHAMELEON_BODY_CONSTRAINT_CAPACITY = 15;

const EPSILON = 1e-8;
const RESIDUAL_TOLERANCE = 1e-5;

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function clampVector3( target, maximumLength ) {

	const length = Math.hypot( target[ 0 ], target[ 1 ], target[ 2 ] );
	if ( length > maximumLength && length > EPSILON ) {

		const scale = maximumLength / length;
		target[ 0 ] *= scale;
		target[ 1 ] *= scale;
		target[ 2 ] *= scale;

	}
	return target;

}

/**
 * Three-probe body projection. The gait support centre is a bounded anchor;
 * pelvis/belly/chest constraints are conservative and query-free between the
 * three BVH samples. Intrusion is corrected immediately, release is smoothed.
 */
export class ChameleonBodyContactSolver {

	constructor( { frequency = 30, response = 12 } = {} ) {

		this.frequency = Math.max( 1, Math.min( 60, finiteOr( frequency, 30 ) ) );
		this.response = Math.max( 0.1, finiteOr( response, 12 ) );
		this.probePositions = new Float32Array( CHAMELEON_BODY_PROBE_COUNT * 3 );
		this.projectedPositions = new Float32Array( CHAMELEON_BODY_PROBE_COUNT * 3 );
		this.appliedPositions = new Float32Array( CHAMELEON_BODY_PROBE_COUNT * 3 );
		this.constraintNormals = new Float32Array( CHAMELEON_BODY_CONSTRAINT_CAPACITY * 3 );
		this.constraintDepths = new Float32Array( CHAMELEON_BODY_CONSTRAINT_CAPACITY );
		this.constraintPlaneConstants = new Float32Array( CHAMELEON_BODY_CONSTRAINT_CAPACITY );
		this.constraintProbeIndices = new Uint8Array( CHAMELEON_BODY_CONSTRAINT_CAPACITY );
		this.triangleHints = new Int32Array( CHAMELEON_BODY_PROBE_COUNT );
		this.offset = new Float32Array( 3 );
		this.targetOffset = new Float32Array( 3 );
		this._anchor = new Float32Array( 3 );
		this.triangleHints.fill( - 1 );
		this._hit = createChameleonSurfaceHit();
		this._query = Object.seal( {
			supportId: - 1,
			componentId: - 1,
			includeGround: true,
			nearestGround: true,
			groundOnly: false,
			clearance: 0.1,
			maxDistance: 0.8,
			triangleId: - 1,
		} );
		this._supportIds = new Int32Array( CHAMELEON_BODY_PROBE_COUNT ).fill( - 2 );
		this._componentIds = new Int32Array( CHAMELEON_BODY_PROBE_COUNT ).fill( - 2 );
		this._constraintCount = 0;
		this._maximumOffset = 0.25;
		this._radius = 0.1;
		this._accumulator = Infinity;
		this._snapNext = true;
		this._view = Object.seal( {
			active: false,
			refreshed: false,
			componentId: - 1,
			offset: this.offset,
			targetOffset: this.targetOffset,
			probePositions: this.probePositions,
			projectedPositions: this.projectedPositions,
			appliedPositions: this.appliedPositions,
			constraintNormals: this.constraintNormals,
			constraintDepths: this.constraintDepths,
			constraintPlaneConstants: this.constraintPlaneConstants,
			constraintProbeIndices: this.constraintProbeIndices,
			triangleHints: this.triangleHints,
			constraintCount: 0,
			constraintOverflow: false,
			queries: 0,
			maxResidual: 0,
			constraintsSatisfied: true,
			budgetExceeded: false,
			requiresFreeze: false,
		} );

	}

	invalidateHints( forceRefresh = true ) {

		this.triangleHints.fill( - 1 );
		this._supportIds.fill( - 2 );
		this._componentIds.fill( - 2 );
		if ( forceRefresh ) {

			this._accumulator = Infinity;
			this._snapNext = true;

		}
		return this;

	}

	reset() {

		this.offset.fill( 0 );
		this.targetOffset.fill( 0 );
		this._anchor.fill( 0 );
		this.constraintDepths.fill( 0 );
		this.constraintNormals.fill( 0 );
		this._constraintCount = 0;
		this.invalidateHints( true );
		this._view.active = false;
		this._view.refreshed = false;
		this._view.queries = 0;
		this._view.constraintCount = 0;
		this._view.constraintOverflow = false;
		this._view.maxResidual = 0;
		this._view.constraintsSatisfied = true;
		this._view.budgetExceeded = false;
		this._view.requiresFreeze = false;
		return this;

	}

	_appendConstraint( probe, nx, ny, nz, rhs, planeConstant ) {

		if ( ! Number.isFinite( nx + ny + nz + rhs + planeConstant ) ) return false;
		if ( this._constraintCount >= CHAMELEON_BODY_CONSTRAINT_CAPACITY ) {

			this._view.constraintOverflow = true;
			return false;

		}
		const inverseLength = 1 / ( Math.hypot( nx, ny, nz ) || 1 );
		const offset = this._constraintCount * 3;
		this.constraintNormals[ offset ] = nx * inverseLength;
		this.constraintNormals[ offset + 1 ] = ny * inverseLength;
		this.constraintNormals[ offset + 2 ] = nz * inverseLength;
		this.constraintDepths[ this._constraintCount ] = rhs * inverseLength;
		this.constraintPlaneConstants[ this._constraintCount ] = planeConstant * inverseLength;
		this.constraintProbeIndices[ this._constraintCount ] = probe;
		this._constraintCount ++;
		return true;

	}

	_appendTriangleFanConstraints(
		collider, triangle, componentId, probe,
		canonicalX, canonicalY, canonicalZ, x, y, z, radius, envelope,
	) {

		if ( triangle < 0 || ! collider.edgeNeighbours ) return;
		for ( let ordinal = 0; ordinal < 3; ordinal ++ ) {

			const candidate = collider.edgeNeighbours[ triangle * 3 + ordinal ];
			if ( candidate < 0 || candidate >= collider.triangleCount
				|| ( componentId >= 0 && collider.componentId[ candidate ] !== componentId )
				|| collider._testTriangle( candidate, x, y, z ) > envelope * envelope ) continue;
			const nx = collider.faceNormalX[ candidate ];
			const ny = collider.faceNormalY[ candidate ];
			const nz = collider.faceNormalZ[ candidate ];
			const planeConstant = collider.ax[ candidate ] * nx
				+ collider.ay[ candidate ] * ny + collider.az[ candidate ] * nz;
			const rhs = radius + planeConstant
				- canonicalX * nx - canonicalY * ny - canonicalZ * nz;
			this._appendConstraint( probe, nx, ny, nz, rhs, planeConstant );

		}

	}

	_solveConstraints( target ) {

		// Convex fans can combine up to fifteen non-orthogonal half-spaces. Two
		// sweeps left sub-millimetre residuals that were physically solvable but
		// still triggered a rollback. A bounded early-out converges those corners
		// without another BVH query, allocation, or population-dependent work.
		for ( let pass = 0; pass < 12; pass ++ ) {

			let maximumCorrection = 0;
			for ( let index = 0; index < this._constraintCount; index ++ ) {

				const offset = index * 3;
				const nx = this.constraintNormals[ offset ];
				const ny = this.constraintNormals[ offset + 1 ];
				const nz = this.constraintNormals[ offset + 2 ];
				const applied = target[ 0 ] * nx + target[ 1 ] * ny + target[ 2 ] * nz;
				const correction = this.constraintDepths[ index ] - applied;
				if ( correction <= EPSILON ) continue;
				target[ 0 ] += nx * correction;
				target[ 1 ] += ny * correction;
				target[ 2 ] += nz * correction;
				maximumCorrection = Math.max( maximumCorrection, correction );

			}
			if ( maximumCorrection <= RESIDUAL_TOLERANCE ) break;

		}

	}

	_maxResidual( target ) {

		let maximum = 0;
		for ( let index = 0; index < this._constraintCount; index ++ ) {

			const offset = index * 3;
			const applied = target[ 0 ] * this.constraintNormals[ offset ]
				+ target[ 1 ] * this.constraintNormals[ offset + 1 ]
				+ target[ 2 ] * this.constraintNormals[ offset + 2 ];
			maximum = Math.max( maximum, this.constraintDepths[ index ] - applied );

		}
		return maximum;

	}

	_refresh( input, radius, maximumOffset ) {

		const defaultSupportId = Number.isInteger( input.supportId ) ? input.supportId : - 1;
		const defaultComponentId = Number.isInteger( input.componentId ) ? input.componentId : - 1;
		const supportIds = input.supportIds;
		const componentIds = input.componentIds;
		this._query.clearance = radius;
		this._query.maxDistance = Math.max( 0.5, radius * 8 );
		input.binding.writeBodyProbeWorldPositions( this.probePositions );
		const canonicalX = finiteOr( input.canonicalX, 0 );
		const canonicalY = finiteOr( input.canonicalY, 0 );
		const canonicalZ = finiteOr( input.canonicalZ, 0 );
		this._anchor[ 0 ] = finiteOr( input.anchorX, canonicalX ) - canonicalX;
		this._anchor[ 1 ] = finiteOr( input.anchorY, canonicalY ) - canonicalY;
		this._anchor[ 2 ] = finiteOr( input.anchorZ, canonicalZ ) - canonicalZ;
		clampVector3( this._anchor, maximumOffset * 0.5 );
		this.targetOffset.set( this._anchor );
		this._maximumOffset = maximumOffset;
		this._radius = radius;
		this.constraintDepths.fill( 0 );
		this.constraintNormals.fill( 0 );
		this._constraintCount = 0;
		this._view.queries = 0;
		this._view.constraintOverflow = false;
		for ( let probe = 0; probe < CHAMELEON_BODY_PROBE_COUNT; probe ++ ) {

			const offset = probe * 3;
			const supportId = Number.isInteger( supportIds?.[ probe ] )
				? supportIds[ probe ] : defaultSupportId;
			const componentId = Number.isInteger( componentIds?.[ probe ] )
				? componentIds[ probe ] : defaultComponentId;
			if ( supportId !== this._supportIds[ probe ]
				|| componentId !== this._componentIds[ probe ] ) {

				this.triangleHints[ probe ] = - 1;
				this._supportIds[ probe ] = supportId;
				this._componentIds[ probe ] = componentId;
				this._snapNext = true;

			}
			this._query.supportId = supportId;
			this._query.componentId = componentId;
			const supportScoped = supportId >= 0;
			this._query.includeGround = ! supportScoped;
			this._query.nearestGround = ! supportScoped;
			const canonicalX = this.probePositions[ offset ] - this.offset[ 0 ];
			const canonicalY = this.probePositions[ offset + 1 ] - this.offset[ 1 ];
			const canonicalZ = this.probePositions[ offset + 2 ] - this.offset[ 2 ];
			const x = canonicalX + this._anchor[ 0 ];
			const y = canonicalY + this._anchor[ 1 ];
			const z = canonicalZ + this._anchor[ 2 ];
			this._query.triangleId = this.triangleHints[ probe ];
			input.collider.projectPoint( x, y, z, this._hit, this._query );
			this._view.queries ++;
			if ( ! this._hit.hit ) {

				this.triangleHints[ probe ] = - 1;
				this.projectedPositions[ offset ] = x;
				this.projectedPositions[ offset + 1 ] = y;
				this.projectedPositions[ offset + 2 ] = z;
				continue;

			}
			this.triangleHints[ probe ] = this._hit.isGround ? - 1 : this._hit.triangleId;
			let nx = this._hit.nx; let ny = this._hit.ny; let nz = this._hit.nz;
			const dx = x - this._hit.surfaceX;
			const dy = y - this._hit.surfaceY;
			const dz = z - this._hit.surfaceZ;
			const distance = Math.hypot( dx, dy, dz );
			const outward = dx * nx + dy * ny + dz * nz;
			let separation = outward;
			if ( distance > EPSILON && outward > EPSILON ) {

				const inverseDistance = 1 / distance;
				nx = dx * inverseDistance; ny = dy * inverseDistance; nz = dz * inverseDistance;
				separation = distance;

			}
			const depth = Math.max( 0, radius - separation );
			const planeConstant = this._hit.surfaceX * nx
				+ this._hit.surfaceY * ny + this._hit.surfaceZ * nz;
			const rhs = radius + planeConstant
				- canonicalX * nx - canonicalY * ny - canonicalZ * nz;
			this._appendConstraint(
				probe, nx, ny, nz, rhs, planeConstant,
			);
			this.projectedPositions[ offset ] = x + nx * depth;
			this.projectedPositions[ offset + 1 ] = y + ny * depth;
			this.projectedPositions[ offset + 2 ] = z + nz * depth;
			if ( depth > EPSILON && ! this._hit.isGround ) this._appendTriangleFanConstraints(
				input.collider, this._hit.triangleId, componentId, probe,
				canonicalX, canonicalY, canonicalZ, x, y, z, radius,
				radius * 1.5,
			);

		}
		this._solveConstraints( this.targetOffset );
		const requestedLength = Math.hypot(
			this.targetOffset[ 0 ], this.targetOffset[ 1 ], this.targetOffset[ 2 ],
		);
		clampVector3( this.targetOffset, maximumOffset );
		const residual = this._maxResidual( this.targetOffset );
		this._view.constraintCount = this._constraintCount;
		this._view.maxResidual = residual;
		this._view.constraintsSatisfied = residual <= RESIDUAL_TOLERANCE;
		this._view.budgetExceeded = requestedLength > maximumOffset + EPSILON;
		this._view.requiresFreeze = this._view.constraintOverflow
			|| ! this._view.constraintsSatisfied;
		if ( this._view.requiresFreeze ) this.targetOffset.set( this.offset );
		this._view.componentId = defaultComponentId;
		return true;

	}

	_publish( dt ) {

		const previousX = this.offset[ 0 ];
		const previousY = this.offset[ 1 ];
		const previousZ = this.offset[ 2 ];
		if ( this._snapNext ) {

			this.offset.set( this.targetOffset );
			this._snapNext = false;

		} else {

			const blend = 1 - Math.exp( - this.response * Math.min( 0.1, dt ) );
			this.offset[ 0 ] += ( this.targetOffset[ 0 ] - this.offset[ 0 ] ) * blend;
			this.offset[ 1 ] += ( this.targetOffset[ 1 ] - this.offset[ 1 ] ) * blend;
			this.offset[ 2 ] += ( this.targetOffset[ 2 ] - this.offset[ 2 ] ) * blend;

		}
		// Conservative envelope: a growing push bypasses smoothing; only release
		// toward the gait anchor is interpolated.
		this._solveConstraints( this.offset );
		clampVector3( this.offset, this._maximumOffset );
		const residual = this._maxResidual( this.offset );
		if ( residual > RESIDUAL_TOLERANCE ) {

			this.offset[ 0 ] = previousX;
			this.offset[ 1 ] = previousY;
			this.offset[ 2 ] = previousZ;
			this._view.maxResidual = residual;
			this._view.constraintsSatisfied = false;
			this._view.requiresFreeze = true;

		}

	}

	resolveCachedPose( binding ) {

		if ( typeof binding?.writeBodyProbeWorldPositions !== 'function' ) {

			throw new TypeError( 'cached body contact resolution requires a rig binding' );

		}
		if ( ! this._view.active || this._constraintCount <= 0 ) return this._view;
		binding.writeBodyProbeWorldPositions( this.probePositions );
		for ( let index = 0; index < this._constraintCount; index ++ ) {

			const normalOffset = index * 3;
			const probeOffset = this.constraintProbeIndices[ index ] * 3;
			const canonicalX = this.probePositions[ probeOffset ] - this.offset[ 0 ];
			const canonicalY = this.probePositions[ probeOffset + 1 ] - this.offset[ 1 ];
			const canonicalZ = this.probePositions[ probeOffset + 2 ] - this.offset[ 2 ];
			this.constraintDepths[ index ] = this._radius
				+ this.constraintPlaneConstants[ index ]
				- canonicalX * this.constraintNormals[ normalOffset ]
				- canonicalY * this.constraintNormals[ normalOffset + 1 ]
				- canonicalZ * this.constraintNormals[ normalOffset + 2 ];

		}
		this.targetOffset.set( this._anchor );
		this._solveConstraints( this.targetOffset );
		const requestedLength = Math.hypot(
			this.targetOffset[ 0 ], this.targetOffset[ 1 ], this.targetOffset[ 2 ],
		);
		clampVector3( this.targetOffset, this._maximumOffset );
		const residual = this._maxResidual( this.targetOffset );
		this._view.maxResidual = residual;
		this._view.constraintsSatisfied = residual <= RESIDUAL_TOLERANCE;
		this._view.budgetExceeded = requestedLength > this._maximumOffset + EPSILON;
		this._view.requiresFreeze = this._view.constraintOverflow
			|| ! this._view.constraintsSatisfied;
		if ( ! this._view.requiresFreeze && ! this._view.budgetExceeded ) {

			this.offset.set( this.targetOffset );

		}
		return this._view;

	}
	validateAppliedPose( binding, tolerance = 1e-4 ) {

		if ( typeof binding?.writeBodyProbeWorldPositions !== 'function' ) {

			throw new TypeError( 'body validation requires a rig binding' );

		}
		if ( ! this._view.active || this._constraintCount <= 0 ) {

			this._view.maxResidual = 0;
			this._view.constraintsSatisfied = true;
			this._view.requiresFreeze = false;
			return this._view;

		}
		binding.writeBodyProbeWorldPositions( this.appliedPositions );
		let maximumResidual = 0;
		for ( let index = 0; index < this._constraintCount; index ++ ) {

			const normalOffset = index * 3;
			const probeOffset = this.constraintProbeIndices[ index ] * 3;
			const separation =
				this.appliedPositions[ probeOffset ] * this.constraintNormals[ normalOffset ]
				+ this.appliedPositions[ probeOffset + 1 ] * this.constraintNormals[ normalOffset + 1 ]
				+ this.appliedPositions[ probeOffset + 2 ] * this.constraintNormals[ normalOffset + 2 ]
				- this.constraintPlaneConstants[ index ];
			maximumResidual = Math.max( maximumResidual, this._radius - separation );

		}
		this._view.maxResidual = Math.max( 0, maximumResidual );
		this._view.constraintsSatisfied = maximumResidual <= Math.max( 0, tolerance );
		this._view.requiresFreeze = this._view.constraintOverflow
			|| ! this._view.constraintsSatisfied;
		return this._view;

	}

	update( dt, input ) {

		const elapsed = Number.isFinite( dt ) && dt > 0 ? dt : 0;
		const enabled = input?.enabled !== false && !! input?.collider
			&& typeof input.binding?.writeBodyProbeWorldPositions === 'function';
		this._view.active = enabled;
		this._view.refreshed = false;
		this._view.queries = 0;
		if ( ! enabled ) {

			this.targetOffset.fill( 0 );
			this.constraintDepths.fill( 0 );
			this._constraintCount = 0;
			this._accumulator = Infinity;
			this._view.constraintCount = 0;
			this._view.maxResidual = 0;
			this._view.budgetExceeded = false;
			this._view.constraintsSatisfied = true;
			this._view.requiresFreeze = false;
			this._view.constraintOverflow = false;
			this._publish( elapsed );
			return this._view;

		}
		const interval = 1 / this.frequency;
		this._accumulator = Number.isFinite( this._accumulator )
			? this._accumulator + elapsed
			: interval;
		if ( this._accumulator + EPSILON >= interval ) {

			this._accumulator %= interval;
			const radius = Math.max( 0.01, finiteOr( input.radius, 0.1 ) );
			const maximumOffset = Math.max( 0.005,
				finiteOr( input.maximumOffset, radius * 2.5 ) );
			this._view.refreshed = this._refresh( input, radius, maximumOffset );

		}
		this._publish( elapsed );
		return this._view;

	}

	getView() {

		return this._view;

	}

}
