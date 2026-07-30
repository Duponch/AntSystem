import {
	CHAMELEON_TAIL_JOINT_COUNT,
	CHAMELEON_TAIL_PROBE_BONE_INDICES,
	CHAMELEON_TAIL_CORRECTION_BONE_INDICES,
} from './chameleon-rig.js';
import { createChameleonSurfaceHit } from './chameleon-surface-collider.js';

export const CHAMELEON_TAIL_PROBE_COUNT = 3;
export const CHAMELEON_TAIL_CONSTRAINT_CAPACITY = 15;

export {
	CHAMELEON_TAIL_PROBE_BONE_INDICES, CHAMELEON_TAIL_CORRECTION_BONE_INDICES,
};
const EPSILON = 1e-8;
const TARGET_CONSTRAINT_PASSES = 12;
const TARGET_CONSTRAINT_TOLERANCE = 1e-6;

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

function writeIdentityQuaternions( target ) {

	target.fill( 0 );
	for ( let index = 0; index < CHAMELEON_TAIL_JOINT_COUNT; index ++ ) {

		target[ index * 4 + 3 ] = 1;

	}

}

function nlerpPackedQuaternion( current, target, offset, blend ) {

	let tx = target[ offset ];
	let ty = target[ offset + 1 ];
	let tz = target[ offset + 2 ];
	let tw = target[ offset + 3 ];
	const dot = current[ offset ] * tx
		+ current[ offset + 1 ] * ty
		+ current[ offset + 2 ] * tz
		+ current[ offset + 3 ] * tw;
	if ( dot < 0 ) { tx = - tx; ty = - ty; tz = - tz; tw = - tw; }
	let x = current[ offset ] + ( tx - current[ offset ] ) * blend;
	let y = current[ offset + 1 ] + ( ty - current[ offset + 1 ] ) * blend;
	let z = current[ offset + 2 ] + ( tz - current[ offset + 2 ] ) * blend;
	let w = current[ offset + 3 ] + ( tw - current[ offset + 3 ] ) * blend;
	const inverseLength = 1 / ( Math.hypot( x, y, z, w ) || 1 );
	x *= inverseLength; y *= inverseLength; z *= inverseLength; w *= inverseLength;
	current[ offset ] = x;
	current[ offset + 1 ] = y;
	current[ offset + 2 ] = z;
	current[ offset + 3 ] = w;

}

/**
 * Bounded three-probe tail contact overlay. Surface queries are performed only
 * on cadence refreshes; interpolation and buffer publication remain query-free.
 */
export class ChameleonTailContactSolver {

	constructor( {
		frequency = 30,
		response = 14,
		maximumAngle = 0.55,
	} = {} ) {

		this.frequency = Math.max( 1, Math.min( 60, finiteOr( frequency, 30 ) ) );
		this.response = Math.max( 0.1, finiteOr( response, 14 ) );
		this.maximumAngle = Math.max( 0, Math.min( Math.PI / 3,
			finiteOr( maximumAngle, 0.55 ) ) );
		this.probePositions = new Float32Array( CHAMELEON_TAIL_PROBE_COUNT * 3 );
		this.projectedPositions = new Float32Array( CHAMELEON_TAIL_PROBE_COUNT * 3 );
		this.appliedPositions = new Float32Array( CHAMELEON_TAIL_PROBE_COUNT * 3 );
		this.constraintNormals = new Float32Array( CHAMELEON_TAIL_CONSTRAINT_CAPACITY * 3 );
		this.constraintPlaneConstants = new Float32Array( CHAMELEON_TAIL_CONSTRAINT_CAPACITY );
		this.constraintProbeIndices = new Uint8Array( CHAMELEON_TAIL_CONSTRAINT_CAPACITY );
		this.projectedNormals = new Float32Array( CHAMELEON_TAIL_PROBE_COUNT * 3 );
		this.penetrationDepths = new Float32Array( CHAMELEON_TAIL_PROBE_COUNT );
		this.contactWeights = new Float32Array( CHAMELEON_TAIL_PROBE_COUNT );
		this.triangleHints = new Int32Array( CHAMELEON_TAIL_PROBE_COUNT );
		this.targetDeltas = new Float32Array( CHAMELEON_TAIL_JOINT_COUNT * 4 );
		this.targetWeights = new Float32Array( CHAMELEON_TAIL_JOINT_COUNT );
		this.smoothedDeltas = new Float32Array( CHAMELEON_TAIL_JOINT_COUNT * 4 );
		this.smoothedWeights = new Float32Array( CHAMELEON_TAIL_JOINT_COUNT );
		writeIdentityQuaternions( this.targetDeltas );
		writeIdentityQuaternions( this.smoothedDeltas );
		this.triangleHints.fill( - 1 );
		this._hit = createChameleonSurfaceHit();
		this._query = Object.seal( {
			supportId: - 1,
			componentId: - 1,
			includeGround: true,
			nearestGround: true,
			groundOnly: false,
			clearance: 0.08,
			maxDistance: 0.5,
			triangleId: - 1,
		} );
		this._accumulator = Infinity;
		this._supportId = - 2;
		this._componentId = - 2;
		this._snapNext = true;
		this._radius = 0.08;
		this._constraintCount = 0;
		this._telemetry = Object.seal( {
			frames: 0,
			refreshes: 0,
			queries: 0,
			lastFrameQueries: 0,
			penetratingProbes: 0,
		} );
		this._view = Object.seal( {
			active: false,
			refreshed: false,
			componentId: - 1,
			probeCount: CHAMELEON_TAIL_PROBE_COUNT,
			probePositions: this.probePositions,
			projectedPositions: this.projectedPositions,
			appliedPositions: this.appliedPositions,
			constraintNormals: this.constraintNormals,
			constraintPlaneConstants: this.constraintPlaneConstants,
			constraintProbeIndices: this.constraintProbeIndices,
			constraintCount: 0,
			constraintOverflow: false,
			projectedNormals: this.projectedNormals,
			penetrationDepths: this.penetrationDepths,
			contactWeights: this.contactWeights,
			triangleHints: this.triangleHints,
			tailDeltas: this.smoothedDeltas,
			tailWeights: this.smoothedWeights,
			constraintsSatisfied: true,
			maxResidual: 0,
			requiresFreeze: false,
		} );

	}

	invalidateHints( forceRefresh = true ) {

		this.triangleHints.fill( - 1 );
		this._query.triangleId = - 1;
		this._supportId = - 2;
		this._componentId = - 2;
		if ( forceRefresh ) {

			this._accumulator = Infinity;
			this._snapNext = true;

		}
		return this;

	}

	reset() {

		this.probePositions.fill( 0 );
		this.projectedPositions.fill( 0 );
		this.appliedPositions.fill( 0 );
		this.constraintNormals.fill( 0 );
		this.constraintPlaneConstants.fill( 0 );
		this._constraintCount = 0;
		this.projectedNormals.fill( 0 );
		this.penetrationDepths.fill( 0 );
		this.contactWeights.fill( 0 );
		this.targetWeights.fill( 0 );
		this.smoothedWeights.fill( 0 );
		writeIdentityQuaternions( this.targetDeltas );
		writeIdentityQuaternions( this.smoothedDeltas );
		this.invalidateHints( true );
		this._snapNext = true;
		this._telemetry.frames = 0;
		this._telemetry.refreshes = 0;
		this._telemetry.queries = 0;
		this._telemetry.lastFrameQueries = 0;
		this._telemetry.penetratingProbes = 0;
		this._view.active = false;
		this._view.refreshed = false;
		this._view.constraintCount = 0;
		this._view.constraintOverflow = false;
		this._view.constraintsSatisfied = true;
		this._view.maxResidual = 0;
		this._view.requiresFreeze = false;
		return this;

	}

	_clearTargets() {

		this.targetWeights.fill( 0 );
		writeIdentityQuaternions( this.targetDeltas );
		this.penetrationDepths.fill( 0 );
		this.contactWeights.fill( 0 );
		this.constraintNormals.fill( 0 );
		this.constraintPlaneConstants.fill( 0 );
		this._constraintCount = 0;
		this._view.constraintCount = 0;
		this._view.constraintOverflow = false;

	}

	_appendConstraint( probe, nx, ny, nz, planeConstant ) {

		if ( ! Number.isFinite( nx + ny + nz + planeConstant ) ) return false;
		if ( this._constraintCount >= CHAMELEON_TAIL_CONSTRAINT_CAPACITY ) {

			this._view.constraintOverflow = true;
			return false;

		}
		const inverseLength = 1 / ( Math.hypot( nx, ny, nz ) || 1 );
		const offset = this._constraintCount * 3;
		this.constraintNormals[ offset ] = nx * inverseLength;
		this.constraintNormals[ offset + 1 ] = ny * inverseLength;
		this.constraintNormals[ offset + 2 ] = nz * inverseLength;
		this.constraintPlaneConstants[ this._constraintCount ] = planeConstant * inverseLength;
		this.constraintProbeIndices[ this._constraintCount ] = probe;
		this._constraintCount ++;
		return true;

	}

	_cacheTriangleFan( collider, triangle, componentId, probe, x, y, z, envelope ) {

		if ( triangle < 0 || ! collider.edgeNeighbours ) return;
		const envelopeSquared = envelope * envelope;
		for ( let ordinal = 0; ordinal < 3; ordinal ++ ) {

			const candidate = collider.edgeNeighbours[ triangle * 3 + ordinal ];
			if ( candidate < 0 || candidate >= collider.triangleCount
				|| ( componentId >= 0 && collider.componentId[ candidate ] !== componentId )
				|| collider._testTriangle( candidate, x, y, z ) > envelopeSquared ) continue;
			const nx = collider.faceNormalX[ candidate ];
			const ny = collider.faceNormalY[ candidate ];
			const nz = collider.faceNormalZ[ candidate ];
			const planeConstant = collider.ax[ candidate ] * nx
				+ collider.ay[ candidate ] * ny + collider.az[ candidate ] * nz;
			this._appendConstraint( probe, nx, ny, nz, planeConstant );

		}

	}
	_solveProbeConstraints( probe, offset, radius ) {

		let maximumResidual = 0;
		for ( let pass = 0; pass < TARGET_CONSTRAINT_PASSES; pass ++ ) {

			maximumResidual = 0;
			for ( let constraint = 0; constraint < this._constraintCount; constraint ++ ) {

				if ( this.constraintProbeIndices[ constraint ] !== probe ) continue;
				const normalOffset = constraint * 3;
				const nx = this.constraintNormals[ normalOffset ];
				const ny = this.constraintNormals[ normalOffset + 1 ];
				const nz = this.constraintNormals[ normalOffset + 2 ];
				const separation = this.projectedPositions[ offset ] * nx
					+ this.projectedPositions[ offset + 1 ] * ny
					+ this.projectedPositions[ offset + 2 ] * nz
					- this.constraintPlaneConstants[ constraint ];
				const residual = radius - separation;
				if ( residual <= 0 ) continue;
				maximumResidual = Math.max( maximumResidual, residual );
				this.projectedPositions[ offset ] += nx * residual;
				this.projectedPositions[ offset + 1 ] += ny * residual;
				this.projectedPositions[ offset + 2 ] += nz * residual;

			}
			if ( maximumResidual <= TARGET_CONSTRAINT_TOLERANCE ) break;

		}
		maximumResidual = 0;
		for ( let constraint = 0; constraint < this._constraintCount; constraint ++ ) {

			if ( this.constraintProbeIndices[ constraint ] !== probe ) continue;
			const normalOffset = constraint * 3;
			const separation = this.projectedPositions[ offset ]
					* this.constraintNormals[ normalOffset ]
				+ this.projectedPositions[ offset + 1 ]
					* this.constraintNormals[ normalOffset + 1 ]
				+ this.projectedPositions[ offset + 2 ]
					* this.constraintNormals[ normalOffset + 2 ]
				- this.constraintPlaneConstants[ constraint ];
			maximumResidual = Math.max( maximumResidual, radius - separation );

		}
		return Math.max( 0, maximumResidual );

	}
	_refresh( input, radius ) {

		this._radius = radius;
		this._view.constraintsSatisfied = true;
		this._view.maxResidual = 0;
		this._view.requiresFreeze = false;

		const collider = input.collider;
		const binding = input.binding;
		this._clearTargets();
		binding.writeTailProbeWorldPositions( this.probePositions );
		const supportId = Number.isInteger( input.supportId ) ? input.supportId : - 1;
		const componentId = Number.isInteger( input.componentId ) ? input.componentId : - 1;
		if ( supportId !== this._supportId || componentId !== this._componentId ) {

			this.triangleHints.fill( - 1 );
			this._supportId = supportId;
			this._componentId = componentId;

		}
		this._query.supportId = supportId;
		this._query.componentId = componentId;
		const supportScoped = supportId >= 0;
		this._query.includeGround = ! supportScoped;
		this._query.nearestGround = ! supportScoped;
		this._view.componentId = componentId;
		this._query.clearance = radius;
		this._query.maxDistance = Math.max( 0.3, radius * 6 );
		let penetrating = 0;
		let maximumTargetResidual = 0;
		for ( let probe = 0; probe < CHAMELEON_TAIL_PROBE_COUNT; probe ++ ) {

			const offset = probe * 3;
			const x = this.probePositions[ offset ];
			const y = this.probePositions[ offset + 1 ];
			const z = this.probePositions[ offset + 2 ];
			this._query.triangleId = this.triangleHints[ probe ];
			collider.projectPoint( x, y, z, this._hit, this._query );
			this._telemetry.queries ++;
			this._telemetry.lastFrameQueries ++;
			if ( ! this._hit.hit ) {

				this.triangleHints[ probe ] = - 1;
				this.projectedPositions[ offset ] = x;
				this.projectedPositions[ offset + 1 ] = y;
				this.projectedPositions[ offset + 2 ] = z;
				this.projectedNormals[ offset ] = 0;
				this.projectedNormals[ offset + 1 ] = 1;
				this.projectedNormals[ offset + 2 ] = 0;
				continue;

			}
			this.triangleHints[ probe ] = this._hit.isGround ? - 1 : this._hit.triangleId;
			let correctionNX = this._hit.nx;
			let correctionNY = this._hit.ny;
			let correctionNZ = this._hit.nz;
			const surfaceDX = x - this._hit.surfaceX;
			const surfaceDY = y - this._hit.surfaceY;
			const surfaceDZ = z - this._hit.surfaceZ;
			const surfaceDistance = Math.hypot( surfaceDX, surfaceDY, surfaceDZ );
			const outwardDot = surfaceDX * correctionNX
				+ surfaceDY * correctionNY
				+ surfaceDZ * correctionNZ;
			let separation = outwardDot;
			// At convex edges and vertices, the exact closest-point direction is
			// the sphere MTV. On the back side (or exactly on the surface), retain
			// the authored outward normal so the tail is never pushed into a mesh.
			if ( surfaceDistance > EPSILON && outwardDot > EPSILON ) {

				const inverseDistance = 1 / surfaceDistance;
				correctionNX = surfaceDX * inverseDistance;
				correctionNY = surfaceDY * inverseDistance;
				correctionNZ = surfaceDZ * inverseDistance;
				separation = surfaceDistance;

			}
			const primaryPlaneConstant = this._hit.surfaceX * correctionNX
				+ this._hit.surfaceY * correctionNY + this._hit.surfaceZ * correctionNZ;
			this._appendConstraint(
				probe, correctionNX, correctionNY, correctionNZ, primaryPlaneConstant,
			);
			this.projectedNormals[ offset ] = correctionNX;
			this.projectedNormals[ offset + 1 ] = correctionNY;
			this.projectedNormals[ offset + 2 ] = correctionNZ;
			let correction = Math.max( 0, radius - separation );
			this.projectedPositions[ offset ] = x + correctionNX * correction;
			this.projectedPositions[ offset + 1 ] = y + correctionNY * correction;
			this.projectedPositions[ offset + 2 ] = z + correctionNZ * correction;
			if ( correction > EPSILON && ! this._hit.isGround ) {

				// Adjacent planes only belong to the active contact fan. A merely
				// nearby face must not become an infinite inter-frame obstacle.
				this._cacheTriangleFan(
					collider, this._hit.triangleId, componentId, probe, x, y, z, radius * 1.5,
				);

			}
			maximumTargetResidual = Math.max(
				maximumTargetResidual,
				this._solveProbeConstraints( probe, offset, radius ),
			);
			const resolvedX = this.projectedPositions[ offset ] - x;
			const resolvedY = this.projectedPositions[ offset + 1 ] - y;
			const resolvedZ = this.projectedPositions[ offset + 2 ] - z;
			correction = Math.hypot( resolvedX, resolvedY, resolvedZ );
			if ( correction > EPSILON ) {

				const inverseCorrection = 1 / correction;
				this.projectedNormals[ offset ] = resolvedX * inverseCorrection;
				this.projectedNormals[ offset + 1 ] = resolvedY * inverseCorrection;
				this.projectedNormals[ offset + 2 ] = resolvedZ * inverseCorrection;

			}
			this.penetrationDepths[ probe ] = correction;
			if ( correction > EPSILON ) {

				penetrating ++;
				// Penetration correction is unilateral and immediate. Only contact release
				// is smoothed by _publish(), never the safety margin itself.
				this.contactWeights[ probe ] = 1;

			}
		}
		binding.writeTailContactDeltas(
			this.targetDeltas,
			this.targetWeights,
			this.probePositions,
			this.projectedPositions,
			this.contactWeights,
			this.maximumAngle,
			this.constraintNormals,
			this.constraintPlaneConstants,
			this.constraintProbeIndices,
			this._constraintCount,
			radius,
		);
		this._view.constraintCount = this._constraintCount;
		this._view.maxResidual = maximumTargetResidual;
		this._view.constraintsSatisfied = ! this._view.constraintOverflow
			&& maximumTargetResidual <= TARGET_CONSTRAINT_TOLERANCE;
		this._view.requiresFreeze = this._view.constraintOverflow
			|| ! this._view.constraintsSatisfied;
		this._telemetry.refreshes ++;
		this._telemetry.penetratingProbes = penetrating;
		return true;

	}

	_publish( dt, solution ) {

		if ( this._snapNext ) {

			this.smoothedDeltas.set( this.targetDeltas );
			this.smoothedWeights.set( this.targetWeights );
			this._snapNext = false;

		} else {

			const blend = 1 - Math.exp( - this.response * Math.min( 0.1, dt ) );
			for ( let joint = 0; joint < CHAMELEON_TAIL_JOINT_COUNT; joint ++ ) {

				const quaternionOffset = joint * 4;
				const targetWeight = this.targetWeights[ joint ];
				const currentWeight = this.smoothedWeights[ joint ];
				if ( targetWeight > EPSILON ) {

					// Any active unilateral correction is authoritative immediately;
					// interpolation is reserved exclusively for contact release.
					this.smoothedDeltas[ quaternionOffset ] = this.targetDeltas[ quaternionOffset ];
					this.smoothedDeltas[ quaternionOffset + 1 ] = this.targetDeltas[ quaternionOffset + 1 ];
					this.smoothedDeltas[ quaternionOffset + 2 ] = this.targetDeltas[ quaternionOffset + 2 ];
					this.smoothedDeltas[ quaternionOffset + 3 ] = this.targetDeltas[ quaternionOffset + 3 ];
					this.smoothedWeights[ joint ] = targetWeight;

				} else {

					nlerpPackedQuaternion( this.smoothedDeltas, this.targetDeltas, quaternionOffset, blend );
					this.smoothedWeights[ joint ] += ( targetWeight - currentWeight ) * blend;

				}

			}

		}
		solution.tailDeltas.set( this.smoothedDeltas );
		solution.tailWeights.set( this.smoothedWeights );

	}

	validateAppliedPose( binding, tolerance = null ) {

		if ( typeof binding?.writeTailProbeWorldPositions !== 'function' ) {

			throw new TypeError( 'tail validation requires a rig binding' );

		}
		if ( ! this._view.active || this._constraintCount <= 0 ) {

			this._view.constraintsSatisfied = ! this._view.constraintOverflow;
			this._view.maxResidual = 0;
			this._view.requiresFreeze = this._view.constraintOverflow;
			return this._view;

		}
		binding.writeTailProbeWorldPositions( this.appliedPositions );
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
		const allowed = Number.isFinite( tolerance )
			? Math.max( 0, tolerance )
			: 1e-4;
		this._view.maxResidual = Math.max( 0, maximumResidual );
		this._view.constraintsSatisfied = maximumResidual <= allowed;
		this._view.requiresFreeze = this._view.constraintOverflow
			|| ! this._view.constraintsSatisfied;
		return this._view;

	}
	update( dt, input ) {

		const elapsed = Number.isFinite( dt ) && dt > 0 ? dt : 0;
		const solution = input?.solution;
		if ( ! solution?.tailDeltas || ! solution?.tailWeights ) {

			throw new TypeError( 'tail contact update requires rig solution buffers' );

		}
		this._telemetry.frames ++;
		this._telemetry.lastFrameQueries = 0;
		this._view.refreshed = false;
		const enabled = input.enabled !== false && !! input.collider
			&& typeof input.binding?.writeTailProbeWorldPositions === 'function'
			&& typeof input.binding?.writeTailContactDeltas === 'function';
		if ( enabled ) {

			const interval = 1 / this.frequency;
			this._accumulator = Number.isFinite( this._accumulator )
				? this._accumulator + elapsed
				: interval;
			if ( this._accumulator + EPSILON >= interval ) {

				this._accumulator %= interval;
				const radius = Math.max( 0.005, finiteOr( input.radius, 0.08 ) );
				this._view.refreshed = this._refresh( input, radius );

			}

		} else {

			this._clearTargets();
			this._accumulator = Infinity;
			this._view.constraintsSatisfied = true;
			this._view.maxResidual = 0;
			this._view.requiresFreeze = false;

		}
		this._publish( elapsed, solution );
		this._view.active = enabled;
		return this._view;

	}

	getView() {

		return this._view;

	}

	getTelemetry() {

		return this._telemetry;

	}

}
