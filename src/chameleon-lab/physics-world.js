import RAPIER from '@dimforge/rapier3d-compat';

export const DEFAULT_PHYSICS_FIXED_DT = 1 / 120;
export const DEFAULT_PHYSICS_MAX_SUBSTEPS = 4;

const EPSILON = 1e-12;
let rapierInitialization = null;
let rapierInitialized = false;

function finiteNumber( name, value ) {

	if ( ! Number.isFinite( value ) ) throw new RangeError( `${ name } must be finite` );
	return value;

}

function positiveNumber( name, value ) {

	value = finiteNumber( name, value );
	if ( value <= 0 ) throw new RangeError( `${ name } must be greater than zero` );
	return value;

}

function vector3( source, fallback = 0 ) {

	const value = source || {};
	return {
		x: finiteNumber( 'x', value.x ?? fallback ),
		y: finiteNumber( 'y', value.y ?? fallback ),
		z: finiteNumber( 'z', value.z ?? fallback ),
	};

}

function positionFrom( options ) {

	return vector3( options.position || options.translation || options, 0 );

}

function rotationFrom( options ) {

	const source = options.rotation || {};
	let x = finiteNumber( 'rotation.x', source.x ?? 0 );
	let y = finiteNumber( 'rotation.y', source.y ?? 0 );
	let z = finiteNumber( 'rotation.z', source.z ?? 0 );
	let w = finiteNumber( 'rotation.w', source.w ?? 1 );
	const length = Math.hypot( x, y, z, w );
	if ( length <= EPSILON ) throw new RangeError( 'rotation must be a non-zero quaternion' );
	x /= length; y /= length; z /= length; w /= length;
	return { x, y, z, w };

}

function createSnapshot() {

	return Object.seal( {
		x: 0, y: 0, z: 0,
		qx: 0, qy: 0, qz: 0, qw: 1,
	} );

}

function copySnapshot( target, source ) {

	target.x = source.x; target.y = source.y; target.z = source.z;
	target.qx = source.qx; target.qy = source.qy;
	target.qz = source.qz; target.qw = source.qw;
	return target;

}

function snapshotIsFinite( snapshot ) {

	return Number.isFinite(
		snapshot.x + snapshot.y + snapshot.z
		+ snapshot.qx + snapshot.qy + snapshot.qz + snapshot.qw,
	);

}

function readBodySnapshot( body, target ) {

	const translation = body.translation();
	const rotation = body.rotation();
	target.x = translation.x; target.y = translation.y; target.z = translation.z;
	target.qx = rotation.x; target.qy = rotation.y;
	target.qz = rotation.z; target.qw = rotation.w;
	return snapshotIsFinite( target );

}

function restoreBodySnapshot( body, snapshot ) {

	body.setTranslation( { x: snapshot.x, y: snapshot.y, z: snapshot.z }, true );
	body.setRotation( {
		x: snapshot.qx, y: snapshot.qy, z: snapshot.qz, w: snapshot.qw,
	}, true );
	body.setLinvel( { x: 0, y: 0, z: 0 }, true );
	body.setAngvel( { x: 0, y: 0, z: 0 }, true );

}

function interpolateSnapshot( previous, current, alpha, target ) {

	const t = Math.max( 0, Math.min( 1, finiteNumber( 'alpha', alpha ) ) );
	target.x = previous.x + ( current.x - previous.x ) * t;
	target.y = previous.y + ( current.y - previous.y ) * t;
	target.z = previous.z + ( current.z - previous.z ) * t;

	let qx = current.qx; let qy = current.qy;
	let qz = current.qz; let qw = current.qw;
	const dot = previous.qx * qx + previous.qy * qy
		+ previous.qz * qz + previous.qw * qw;
	if ( dot < 0 ) { qx = - qx; qy = - qy; qz = - qz; qw = - qw; }
	target.qx = previous.qx + ( qx - previous.qx ) * t;
	target.qy = previous.qy + ( qy - previous.qy ) * t;
	target.qz = previous.qz + ( qz - previous.qz ) * t;
	target.qw = previous.qw + ( qw - previous.qw ) * t;
	const inverseLength = 1 / ( Math.hypot(
		target.qx, target.qy, target.qz, target.qw,
	) || 1 );
	target.qx *= inverseLength; target.qy *= inverseLength;
	target.qz *= inverseLength; target.qw *= inverseLength;
	return target;

}

function surfaceMetadata( shape, options ) {

	const source = options.userData;
	const metadata = source && typeof source === 'object'
		? { ... source }
		: {};
	if ( metadata.surface === undefined ) metadata.surface = options.surface ?? shape;
	if ( metadata.shape === undefined ) metadata.shape = shape;
	return Object.freeze( metadata );

}

function applyColliderOptions( descriptor, options ) {

	if ( options.friction !== undefined )
		descriptor.setFriction( Math.max( 0, finiteNumber( 'friction', options.friction ) ) );
	if ( options.restitution !== undefined )
		descriptor.setRestitution( Math.max( 0, finiteNumber( 'restitution', options.restitution ) ) );
	if ( options.density !== undefined )
		descriptor.setDensity( positiveNumber( 'density', options.density ) );
	if ( options.sensor !== undefined ) descriptor.setSensor( !! options.sensor );
	return descriptor;

}

function monotonicNow() {

	return globalThis.performance?.now?.() ?? Date.now();

}

/**
 * Explicitly initialises the compatibility WASM module. The promise is shared
 * across laboratory worlds but no work starts until this function (or the
 * async factory below) is called.
 */
export async function initializePhysicsWorld() {

	if ( ! rapierInitialization ) {

		rapierInitialization = Promise.resolve( RAPIER.init() ).catch( ( error ) => {

			rapierInitialization = null;
			throw error;

		} );

	}
	await rapierInitialization;
	rapierInitialized = true;
	return RAPIER;

}

class FixedStepPhysicsWorld {

	constructor( {
		gravity = { x: 0, y: - 9.81, z: 0 },
		fixedDt = DEFAULT_PHYSICS_FIXED_DT,
		maxSubsteps = DEFAULT_PHYSICS_MAX_SUBSTEPS,
		metricsWindow = 128,
		emaWeight = 0.1,
		now = monotonicNow,
	} = {} ) {

		if ( ! rapierInitialized ) throw new Error( 'initializePhysicsWorld() must complete before constructing a physics world' );
		this.RAPIER = RAPIER;
		this.fixedDt = positiveNumber( 'fixedDt', fixedDt );
		if ( ! Number.isInteger( maxSubsteps ) || maxSubsteps < 1 )
			throw new RangeError( 'maxSubsteps must be a positive integer' );
		this.maxSubsteps = maxSubsteps;
		if ( ! Number.isInteger( metricsWindow ) || metricsWindow < 8 )
			throw new RangeError( 'metricsWindow must be an integer of at least 8' );
		this._emaWeight = Math.max( 0.001, Math.min(
			1,
			finiteNumber( 'emaWeight', emaWeight ),
		) );
		if ( typeof now !== 'function' ) throw new TypeError( 'now must be a function' );
		this._now = now;
		this.world = new RAPIER.World( vector3( gravity, 0 ) );
		this.world.timestep = this.fixedDt;
		this._accumulator = 0;
		this._disposed = false;
		this._records = new Map();
		this._metricRing = new Float64Array( metricsWindow );
		this._metricScratch = new Float64Array( metricsWindow );
		this._metricCursor = 0;
		this._metricCount = 0;
		this._stepResult = Object.seal( {
			steps: 0,
			alpha: 0,
			droppedSeconds: 0,
		} );
		this.stats = Object.seal( {
			lastStepMs: 0,
			lastFrameMs: 0,
			emaStepMs: 0,
			p95StepMs: 0,
			maxStepMs: 0,
			totalSteps: 0,
			lastSubsteps: 0,
			alpha: 0,
			droppedSeconds: 0,
			totalDroppedSeconds: 0,
			invalidBodies: 0,
			registeredBodies: 0,
			metricSamples: 0,
		} );

	}

	_assertAlive() {

		if ( this._disposed || ! this.world ) throw new Error( 'physics world is disposed' );

	}

	_refreshP95() {

		const count = this._metricCount;
		if ( count <= 0 ) {

			this.stats.p95StepMs = 0;
			return;

		}
		for ( let index = 0; index < count; index ++ )
			this._metricScratch[ index ] = this._metricRing[ index ];
		for ( let index = 1; index < count; index ++ ) {

			const value = this._metricScratch[ index ];
			let write = index;
			while ( write > 0 && this._metricScratch[ write - 1 ] > value ) {

				this._metricScratch[ write ] = this._metricScratch[ write - 1 ];
				write --;

			}
			this._metricScratch[ write ] = value;

		}
		const percentileIndex = Math.max( 0, Math.ceil( count * 0.95 ) - 1 );
		this.stats.p95StepMs = this._metricScratch[ percentileIndex ];

	}

	_recordStepMetric( elapsedMs ) {

		const value = Math.max( 0, Number.isFinite( elapsedMs ) ? elapsedMs : 0 );
		this._metricRing[ this._metricCursor ] = value;
		this._metricCursor = ( this._metricCursor + 1 ) % this._metricRing.length;
		this._metricCount = Math.min( this._metricCount + 1, this._metricRing.length );
		this.stats.lastStepMs = value;
		this.stats.emaStepMs = this.stats.metricSamples === 0
			? value
			: this.stats.emaStepMs + ( value - this.stats.emaStepMs ) * this._emaWeight;
		this.stats.maxStepMs = Math.max( this.stats.maxStepMs, value );
		this.stats.metricSamples ++;
		if ( this.stats.metricSamples === 1 || this.stats.metricSamples % 16 === 0 )
			this._refreshP95();

	}

	_captureBeforeStep() {

		for ( const record of this._records.values() ) {

			if ( ! record.trackMotion || ! record.body.isValid() ) continue;
			if ( ! readBodySnapshot( record.body, record.previous ) ) {

				restoreBodySnapshot( record.body, record.current );
				copySnapshot( record.previous, record.current );
				this.stats.invalidBodies ++;

			}

		}

	}

	_captureAfterStep() {

		for ( const record of this._records.values() ) {

			if ( ! record.trackMotion || ! record.body.isValid() ) continue;
			if ( ! readBodySnapshot( record.body, record.current ) ) {

				restoreBodySnapshot( record.body, record.previous );
				copySnapshot( record.current, record.previous );
				this.stats.invalidBodies ++;

			}

		}

	}

	registerBody( body, {
		collider = null,
		trackMotion = null,
		userData = body?.userData,
	} = {} ) {

		this._assertAlive();
		if ( ! body || ! Number.isFinite( body.handle )
			|| typeof body.translation !== 'function'
			|| typeof body.rotation !== 'function' ) {

			throw new TypeError( 'registerBody requires a Rapier rigid body' );

		}
		const existing = this._records.get( body.handle );
		if ( existing ) return existing;
		const previous = createSnapshot();
		const current = createSnapshot();
		const initial = createSnapshot();
		const interpolated = createSnapshot();
		if ( ! readBodySnapshot( body, current ) )
			throw new RangeError( 'registered body has a non-finite transform' );
		copySnapshot( previous, current );
		copySnapshot( initial, current );
		copySnapshot( interpolated, current );
		const moving = trackMotion === null
			? !! ( body.isDynamic?.() || body.isKinematic?.() )
			: !! trackMotion;
		const record = Object.seal( {
			body,
			collider,
			handle: body.handle,
			userData,
			trackMotion: moving,
			initial,
			previous,
			current,
			interpolated,
		} );
		this._records.set( body.handle, record );
		this.stats.registeredBodies = this._records.size;
		return record;

	}

	getBodyRecord( bodyOrRecord ) {

		if ( bodyOrRecord?.body && bodyOrRecord.previous ) return bodyOrRecord;
		const handle = typeof bodyOrRecord === 'number' ? bodyOrRecord : bodyOrRecord?.handle;
		return this._records.get( handle ) || null;

	}

	getInterpolatedTransform( bodyOrRecord, alpha = this._stepResult.alpha, out = null ) {

		const record = this.getBodyRecord( bodyOrRecord );
		if ( ! record ) throw new RangeError( 'body is not registered' );
		return interpolateSnapshot(
			record.previous,
			record.current,
			alpha,
			out || record.interpolated,
		);

	}

	step( frameDt, beforeSubstep = null, afterSubstep = null ) {

		this._assertAlive();
		frameDt = finiteNumber( 'frameDt', frameDt );
		if ( frameDt < 0 ) throw new RangeError( 'frameDt must be non-negative' );
		if ( beforeSubstep !== null && typeof beforeSubstep !== 'function' )
			throw new TypeError( 'beforeSubstep must be a function' );
		if ( afterSubstep !== null && typeof afterSubstep !== 'function' )
			throw new TypeError( 'afterSubstep must be a function' );

		const frameStart = this._now();
		const maximumAccumulated = this.fixedDt * this.maxSubsteps;
		const room = Math.max( 0, maximumAccumulated - this._accumulator );
		const accepted = Math.min( frameDt, room );
		const dropped = Math.max( 0, frameDt - accepted );
		this._accumulator += accepted;
		let steps = 0;
		while ( steps < this.maxSubsteps
			&& this._accumulator + this.fixedDt * 1e-9 >= this.fixedDt ) {

			const started = this._now();
			this._captureBeforeStep();
			beforeSubstep?.( this.fixedDt, this );
			this.world.step();
			this._captureAfterStep();
			this._accumulator -= this.fixedDt;
			if ( this._accumulator < EPSILON ) this._accumulator = 0;
			steps ++;
			afterSubstep?.( this.fixedDt, this );
			this._recordStepMetric( this._now() - started );

		}
		const alpha = Math.max( 0, Math.min( 1, this._accumulator / this.fixedDt ) );
		this._stepResult.steps = steps;
		this._stepResult.alpha = alpha;
		this._stepResult.droppedSeconds = dropped;
		this.stats.lastFrameMs = Math.max( 0, this._now() - frameStart );
		this.stats.totalSteps += steps;
		this.stats.lastSubsteps = steps;
		this.stats.alpha = alpha;
		this.stats.droppedSeconds = dropped;
		this.stats.totalDroppedSeconds += dropped;
		return this._stepResult;

	}

	setGravity( gravity ) {

		this._assertAlive();
		const next = vector3( gravity, 0 );
		this.world.gravity.x = next.x;
		this.world.gravity.y = next.y;
		this.world.gravity.z = next.z;
		return this.world.gravity;

	}

	addFixedCuboid( options = {} ) {

		this._assertAlive();
		const position = positionFrom( options );
		const rotation = rotationFrom( options );
		const half = options.halfExtents || {};
		const hx = positiveNumber( 'halfExtents.x', half.x ?? options.hx ?? 0.5 );
		const hy = positiveNumber( 'halfExtents.y', half.y ?? options.hy ?? 0.5 );
		const hz = positiveNumber( 'halfExtents.z', half.z ?? options.hz ?? 0.5 );
		const userData = surfaceMetadata( 'cuboid', options );
		const body = this.world.createRigidBody(
			RAPIER.RigidBodyDesc.fixed()
				.setTranslation( position.x, position.y, position.z )
				.setRotation( rotation )
				.setUserData( userData ),
		);
		const collider = this.world.createCollider(
			applyColliderOptions( RAPIER.ColliderDesc.cuboid( hx, hy, hz ), options ),
			body,
		);
		return this.registerBody( body, { collider, trackMotion: false, userData } );

	}

	addFixedCylinder( options = {} ) {

		this._assertAlive();
		const position = positionFrom( options );
		const rotation = rotationFrom( options );
		const halfHeight = positiveNumber(
			'halfHeight',
			options.halfHeight ?? options.hy ?? 0.5,
		);
		const radius = positiveNumber( 'radius', options.radius ?? 0.5 );
		const userData = surfaceMetadata( 'cylinder', options );
		const body = this.world.createRigidBody(
			RAPIER.RigidBodyDesc.fixed()
				.setTranslation( position.x, position.y, position.z )
				.setRotation( rotation )
				.setUserData( userData ),
		);
		const collider = this.world.createCollider(
			applyColliderOptions(
				RAPIER.ColliderDesc.cylinder( halfHeight, radius ),
				options,
			),
			body,
		);
		return this.registerBody( body, { collider, trackMotion: false, userData } );

	}

	addDynamicBall( options = {} ) {

		this._assertAlive();
		const position = positionFrom( options );
		const rotation = rotationFrom( options );
		const radius = positiveNumber( 'radius', options.radius ?? 0.5 );
		const userData = surfaceMetadata( 'ball', options );
		let descriptor = RAPIER.RigidBodyDesc.dynamic()
			.setTranslation( position.x, position.y, position.z )
			.setRotation( rotation )
			.setCcdEnabled( options.ccd !== false )
			.setUserData( userData );
		if ( options.canSleep !== undefined ) descriptor = descriptor.setCanSleep( !! options.canSleep );
		if ( options.linearDamping !== undefined ) descriptor = descriptor.setLinearDamping(
			Math.max( 0, finiteNumber( 'linearDamping', options.linearDamping ) ),
		);
		if ( options.angularDamping !== undefined ) descriptor = descriptor.setAngularDamping(
			Math.max( 0, finiteNumber( 'angularDamping', options.angularDamping ) ),
		);
		const body = this.world.createRigidBody( descriptor );
		const collider = this.world.createCollider(
			applyColliderOptions( RAPIER.ColliderDesc.ball( radius ), options ),
			body,
		);
		return this.registerBody( body, { collider, trackMotion: true, userData } );

	}

	resetAccumulator() {

		this._assertAlive();
		this._accumulator = 0;
		this._stepResult.steps = 0;
		this._stepResult.alpha = 0;
		this._stepResult.droppedSeconds = 0;
		this.stats.lastSubsteps = 0;
		this.stats.alpha = 0;
		this.stats.droppedSeconds = 0;
		return this._stepResult;

	}

	reset( { restoreBodies = true, resetMetrics = true } = {} ) {

		this.resetAccumulator();
		if ( restoreBodies ) for ( const record of this._records.values() ) {

			if ( ! record.body.isValid() ) continue;
			restoreBodySnapshot( record.body, record.initial );
			copySnapshot( record.previous, record.initial );
			copySnapshot( record.current, record.initial );
			copySnapshot( record.interpolated, record.initial );

		}
		if ( restoreBodies ) this.world.propagateModifiedBodyPositionsToColliders();
		if ( resetMetrics ) {

			this._metricRing.fill( 0 );
			this._metricScratch.fill( 0 );
			this._metricCursor = 0;
			this._metricCount = 0;
			this.stats.lastStepMs = 0;
			this.stats.lastFrameMs = 0;
			this.stats.emaStepMs = 0;
			this.stats.p95StepMs = 0;
			this.stats.maxStepMs = 0;
			this.stats.totalSteps = 0;
			this.stats.totalDroppedSeconds = 0;
			this.stats.invalidBodies = 0;
			this.stats.metricSamples = 0;

		}
		return this;

	}

	dispose() {

		if ( this._disposed ) return;
		this._disposed = true;
		this._records.clear();
		this.stats.registeredBodies = 0;
		this.world?.free();
		this.world = null;

	}

}

/**
 * Async factory used by the laboratory. No global timer or simulation loop is
 * created: callers own render cadence and invoke `step(frameDt)` explicitly.
 */
export async function createPhysicsWorld( options = {} ) {

	await initializePhysicsWorld();
	return new FixedStepPhysicsWorld( options );

}

export { FixedStepPhysicsWorld };
