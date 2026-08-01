import * as THREE from 'three/webgpu';

import { parallelTransportTangent } from './platformer-control-model.js';

const MOVEMENT_KEYS = new Set( [
	'KeyW', 'KeyZ', 'ArrowUp',
	'KeyS', 'ArrowDown',
	'KeyA', 'KeyQ', 'ArrowLeft',
	'KeyD', 'ArrowRight',
] );
const MAX_ROUTE_WAYPOINTS = 12;

function isEditableTarget( target ) {

	const tagName = target?.tagName?.toLowerCase?.();
	return target?.isContentEditable === true
		|| tagName === 'input'
		|| tagName === 'select'
		|| tagName === 'textarea'
		|| tagName === 'button';

}

export function movementAxesFromKeys( keys, target = { x: 0, y: 0 } ) {

	const forward = Number( keys.has( 'KeyW' ) || keys.has( 'KeyZ' ) || keys.has( 'ArrowUp' ) );
	const backward = Number( keys.has( 'KeyS' ) || keys.has( 'ArrowDown' ) );
	const left = Number( keys.has( 'KeyA' ) || keys.has( 'KeyQ' ) || keys.has( 'ArrowLeft' ) );
	const right = Number( keys.has( 'KeyD' ) || keys.has( 'ArrowRight' ) );
	// Steering and throttle are independent arcade channels. Normalizing W+D
	// would weaken both the turn and forward motion precisely when responsiveness
	// matters most.
	target.x = right - left;
	target.y = forward - backward;
	return target;

}

export function cameraRelativeMovement( axes, cameraForward, supportNormal, target = new THREE.Vector3() ) {

	const normal = supportNormal.lengthSq() > 1e-7
		? supportNormal.clone().normalize()
		: new THREE.Vector3( 0, 1, 0 );
	const forward = cameraForward.clone().projectOnPlane( normal );
	if ( forward.lengthSq() < 1e-5 ) {

		forward.set( 0, 0, -1 ).projectOnPlane( normal );
		if ( forward.lengthSq() < 1e-5 ) forward.set( 1, 0, 0 ).projectOnPlane( normal );

	}
	forward.normalize();
	const right = forward.clone().cross( normal ).normalize();
	return target.copy( forward ).multiplyScalar( axes.y )
		.addScaledVector( right, axes.x )
		.normalize()
		.multiplyScalar( Math.min( 1, Math.hypot( axes.x, axes.y ) ) );

}

function expSmoothing( lambda, dt ) {

	return 1 - Math.exp( -lambda * Math.min( dt, 0.1 ) );

}

export class LabInputController {

	constructor( element = window ) {

		this.element = element;
		this.blurElement = typeof window === 'undefined' ? element : window;
		this.keys = new Set();
		this.axesState = Object.seal( { x: 0, y: 0 } );
		this.jumpQueued = false;
		this.jumpPressed = false;
		this.jumpHeld = false;
		this.jumpReleased = false;
		this.jumpState = Object.seal( {
			jumpPressed: false,
			jumpHeld: false,
			jumpReleased: false,
		} );
		this.toggleAutoQueued = false;
		this.toggleDebugQueued = false;
		this.resetQueued = false;
		this.toggleRagdollQueued = false;
		this._onKeyDown = ( event ) => {

			if ( isEditableTarget( event.target ) ) return;
			if ( MOVEMENT_KEYS.has( event.code ) || event.code === 'Space' ) event.preventDefault();
			const wasDown = this.keys.has( event.code );
			this.keys.add( event.code );
			if ( event.code === 'Space' ) this.jumpHeld = true;
			if ( event.repeat || wasDown ) return;
			if ( event.code === 'Space' ) {

				this.jumpQueued = true;
				this.jumpPressed = true;

			}
			if ( event.code === 'KeyC' ) this.toggleAutoQueued = true;
			if ( event.code === 'KeyH' ) this.toggleDebugQueued = true;
			if ( event.code === 'KeyR' ) this.resetQueued = true;
			if ( event.code === 'KeyF' ) this.toggleRagdollQueued = true;

		};
		this._onKeyUp = ( event ) => {

			if ( event.code === 'Space' && this.jumpHeld ) {

				this.jumpHeld = false;
				this.jumpReleased = true;

			}
			this.keys.delete( event.code );

		};
		this._onBlur = () => {

			if ( this.jumpHeld ) this.jumpReleased = true;
			this.jumpHeld = false;
			this.keys.clear();

		};
		element.addEventListener( 'keydown', this._onKeyDown, { passive: false } );
		element.addEventListener( 'keyup', this._onKeyUp );
		this.blurElement.addEventListener( 'blur', this._onBlur );

	}

	get axes() {

		return movementAxesFromKeys( this.keys, this.axesState );

	}

	get sprint() {

		return this.keys.has( 'ShiftLeft' ) || this.keys.has( 'ShiftRight' );

	}

	consume( property ) {

		const value = this[ property ];
		this[ property ] = false;
		// jumpQueued is the backwards-compatible name of the same physical edge.
		// Whichever API consumes it first owns it; it must never fire twice.
		if ( property === 'jumpQueued' ) this.jumpPressed = false;
		if ( property === 'jumpPressed' ) this.jumpQueued = false;
		return value;

	}

	/**
	 * Consumes edge transitions exactly once while keeping the held level live.
	 * The property names intentionally match PlatformerJumpModel.update().
	 */
	consumeJumpState( target = this.jumpState ) {

		if ( ! target || typeof target !== 'object' )
			throw new TypeError( 'jump state target must be an object' );
		target.jumpPressed = this.jumpPressed;
		target.jumpHeld = this.jumpHeld;
		target.jumpReleased = this.jumpReleased;
		this.jumpPressed = false;
		this.jumpQueued = false;
		this.jumpReleased = false;
		return target;

	}

	dispose() {

		this.element.removeEventListener( 'keydown', this._onKeyDown );
		this.element.removeEventListener( 'keyup', this._onKeyUp );
		this.blurElement.removeEventListener( 'blur', this._onBlur );

	}

}

export class ThirdPersonCamera {

	constructor( {
		camera,
		domElement,
		physics,
		targetProvider,
	} ) {

		this.camera = camera;
		this.domElement = domElement;
		this.physics = physics;
		this.targetProvider = targetProvider;
		this.yaw = 1.12;
		this.pitch = 0.32;
		this.distance = 4.7;
		this.minDistance = 1.6;
		this.maxDistance = 10;
		this.sensitivity = 0.0045;
		this.target = new THREE.Vector3();
		this.smoothedTarget = new THREE.Vector3();
		this.smoothedPosition = new THREE.Vector3();
		this.initialized = false;
		this.rotating = false;
		this.lastPointer = new THREE.Vector2();
		this._onContextMenu = ( event ) => event.preventDefault();
		this._onPointerDown = ( event ) => {

			if ( event.button !== 2 ) return;
			this.rotating = true;
			this.lastPointer.set( event.clientX, event.clientY );
			this.domElement.setPointerCapture?.( event.pointerId );

		};
		this._onPointerMove = ( event ) => {

			if ( ! this.rotating ) return;
			const dx = event.clientX - this.lastPointer.x;
			const dy = event.clientY - this.lastPointer.y;
			this.lastPointer.set( event.clientX, event.clientY );
			this.yaw -= dx * this.sensitivity;
			this.pitch = THREE.MathUtils.clamp( this.pitch + dy * this.sensitivity, -0.18, 1.22 );

		};
		this._stopRotation = ( event ) => {

			this.rotating = false;
			if ( this.domElement.hasPointerCapture?.( event.pointerId ) )
				this.domElement.releasePointerCapture?.( event.pointerId );

		};
		this._onPointerUp = ( event ) => {

			if ( event.button !== 2 ) return;
			this._stopRotation( event );

		};
		this._onPointerCancel = ( event ) => this._stopRotation( event );
		this._onLostPointerCapture = () => {

			this.rotating = false;

		};
		this._onWheel = ( event ) => {

			event.preventDefault();
			this.distance = THREE.MathUtils.clamp(
				this.distance * Math.exp( event.deltaY * 0.0012 ),
				this.minDistance,
				this.maxDistance,
			);

		};
		domElement.addEventListener( 'contextmenu', this._onContextMenu );
		domElement.addEventListener( 'pointerdown', this._onPointerDown );
		domElement.addEventListener( 'pointermove', this._onPointerMove );
		domElement.addEventListener( 'pointerup', this._onPointerUp );
		domElement.addEventListener( 'pointercancel', this._onPointerCancel );
		domElement.addEventListener( 'lostpointercapture', this._onLostPointerCapture );
		domElement.addEventListener( 'wheel', this._onWheel, { passive: false } );

	}

	getForward( target = new THREE.Vector3() ) {

		return this.camera.getWorldDirection( target );

	}

	_resolveCameraCollision( origin, desired ) {

		const offset = desired.clone().sub( origin );
		const distance = offset.length();
		if ( distance < 0.01 ) return desired;
		const direction = offset.multiplyScalar( 1 / distance );
		const ray = new this.physics.RAPIER.Ray(
			{ x: origin.x, y: origin.y, z: origin.z },
			{ x: direction.x, y: direction.y, z: direction.z },
		);
		const hit = this.physics.world.castRay(
			ray,
			distance,
			true,
			undefined,
			undefined,
			undefined,
			undefined,
			( collider ) => {

				const surface = this.physics.surfaceByCollider?.get( collider.handle );
				return surface !== undefined && surface.clawEligible !== false;

			},
		);
		if ( ! hit ) return desired;
		return origin.clone().addScaledVector( direction, Math.max( 0.45, hit.timeOfImpact - 0.35 ) );

	}

	update( dt ) {

		const source = this.targetProvider();
		this.target.copy( source ).add( new THREE.Vector3( 0, 0.22, 0 ) );
		const cosPitch = Math.cos( this.pitch );
		const offset = new THREE.Vector3(
			Math.sin( this.yaw ) * cosPitch,
			Math.sin( this.pitch ),
			Math.cos( this.yaw ) * cosPitch,
		).multiplyScalar( this.distance );
		const desired = this._resolveCameraCollision( this.target, this.target.clone().add( offset ) );

		if ( ! this.initialized ) {

			this.smoothedTarget.copy( this.target );
			this.smoothedPosition.copy( desired );
			this.initialized = true;

		} else {

			this.smoothedTarget.lerp( this.target, expSmoothing( 13, dt ) );
			this.smoothedPosition.lerp( desired, expSmoothing( 10, dt ) );

		}
		this.camera.position.copy( this.smoothedPosition );
		this.camera.lookAt( this.smoothedTarget );
		this.camera.updateMatrixWorld();

	}

	snap() {

		this.initialized = false;
		this.update( 1 );

	}

	dispose() {

		this.domElement.removeEventListener( 'contextmenu', this._onContextMenu );
		this.domElement.removeEventListener( 'pointerdown', this._onPointerDown );
		this.domElement.removeEventListener( 'pointermove', this._onPointerMove );
		this.domElement.removeEventListener( 'pointerup', this._onPointerUp );
		this.domElement.removeEventListener( 'pointercancel', this._onPointerCancel );
		this.domElement.removeEventListener( 'lostpointercapture', this._onLostPointerCapture );
		this.domElement.removeEventListener( 'wheel', this._onWheel );

	}

}

/**
 * One-shot environment picker used by click-to-travel. Physics is queried only
 * on a completed click (never from the animation/fixed-step hot path).
 */
export class SurfaceDestinationPicker {

	constructor( {
		camera,
		domElement,
		physics,
		onDestination = () => {},
		maximumDistance = 80,
		movementTolerance = 7,
	} ) {

		this.camera = camera;
		this.domElement = domElement;
		this.physics = physics;
		this.onDestination = onDestination;
		this.maximumDistance = maximumDistance;
		this.movementToleranceSquared = movementTolerance * movementTolerance;
		this.raycaster = new THREE.Raycaster();
		this.ndc = new THREE.Vector2();
		this.pointerStart = new THREE.Vector2();
		this.destination = new THREE.Vector3();
		this.normal = new THREE.Vector3( 0, 1, 0 );
		this._pointerId = null;
		this._cancelled = false;
		this._onPointerDown = ( event ) => {

			if ( event.button !== 0 ) return;
			this._pointerId = event.pointerId;
			this._cancelled = event.defaultPrevented === true;
			this.pointerStart.set( event.clientX, event.clientY );

		};
		this._onPointerMove = ( event ) => {

			if ( event.pointerId !== this._pointerId ) return;
			const dx = event.clientX - this.pointerStart.x;
			const dy = event.clientY - this.pointerStart.y;
			if ( dx * dx + dy * dy > this.movementToleranceSquared ) this._cancelled = true;

		};
		this._onPointerUp = ( event ) => {

			if ( event.button !== 0 || event.pointerId !== this._pointerId ) return;
			const cancelled = this._cancelled || event.defaultPrevented === true;
			this._pointerId = null;
			this._cancelled = false;
			if ( ! cancelled ) this.pick( event.clientX, event.clientY );

		};
		this._onPointerCancel = ( event ) => {

			if ( event.pointerId !== this._pointerId ) return;
			this._pointerId = null;
			this._cancelled = false;

		};
		domElement.addEventListener( 'pointerdown', this._onPointerDown );
		domElement.addEventListener( 'pointermove', this._onPointerMove );
		domElement.addEventListener( 'pointerup', this._onPointerUp );
		domElement.addEventListener( 'pointercancel', this._onPointerCancel );

	}

	pick( clientX, clientY ) {

		const rect = this.domElement.getBoundingClientRect();
		if ( rect.width <= 0 || rect.height <= 0 ) return false;
		this.ndc.set(
			( ( clientX - rect.left ) / rect.width ) * 2 - 1,
			- ( ( clientY - rect.top ) / rect.height ) * 2 + 1,
		);
		this.raycaster.setFromCamera( this.ndc, this.camera );
		const ray = this.raycaster.ray;
		const physicsRay = new this.physics.RAPIER.Ray(
			{ x: ray.origin.x, y: ray.origin.y, z: ray.origin.z },
			{ x: ray.direction.x, y: ray.direction.y, z: ray.direction.z },
		);
		const hit = this.physics.world.castRayAndGetNormal(
			physicsRay,
			this.maximumDistance,
			true,
			undefined,
			undefined,
			undefined,
			undefined,
			( collider ) => this.physics.surfaceByCollider
				?.get( collider.handle )?.clawEligible === true,
		);
		if ( ! hit ) return false;
		this.destination.copy( ray.origin ).addScaledVector( ray.direction, hit.timeOfImpact );
		this.normal.set( hit.normal.x, hit.normal.y, hit.normal.z );
		if ( this.normal.lengthSq() < 1e-8 ) this.normal.set( 0, 1, 0 );
		else this.normal.normalize();
		this.onDestination( this.destination, this.normal, hit.collider );
		return true;

	}

	dispose() {

		this.domElement.removeEventListener( 'pointerdown', this._onPointerDown );
		this.domElement.removeEventListener( 'pointermove', this._onPointerMove );
		this.domElement.removeEventListener( 'pointerup', this._onPointerUp );
		this.domElement.removeEventListener( 'pointercancel', this._onPointerCancel );

	}

}

/**
 * One-shot route builder. The environment owns a tiny static access graph and
 * this class only expands its source/target access chains when the user clicks.
 * Its returned typed-array view is reused, then copied by AutonomousExplorer.
 */
export class SurfaceRoutePlanner {

	constructor( navigation = null, maximumWaypoints = null ) {

		this.accessByCollider = navigation?.accessByCollider ?? new Map();
		this.maximumWaypoints = Math.max( 2, Math.min(
			32,
			Math.trunc( maximumWaypoints ?? navigation?.maximumWaypoints ?? MAX_ROUTE_WAYPOINTS ),
		) );
		this.positions = new Float32Array( this.maximumWaypoints * 3 );
		this.normals = new Float32Array( this.maximumWaypoints * 3 );
		this.count = 0;
		this.view = Object.seal( {
			positions: this.positions,
			normals: this.normals,
			count: 0,
		} );

	}

	_colliderHandle( collider ) {

		if ( Number.isFinite( collider ) ) return collider;
		return Number.isFinite( collider?.handle ) ? collider.handle : null;

	}

	_append( position, normal ) {

		if ( this.count >= this.maximumWaypoints || ! position ) return false;
		const x = Number( position.x ?? position[ 0 ] );
		const y = Number( position.y ?? position[ 1 ] );
		const z = Number( position.z ?? position[ 2 ] );
		if ( ! Number.isFinite( x ) || ! Number.isFinite( y ) || ! Number.isFinite( z ) )
			return false;
		if ( this.count > 0 ) {

			const previous = ( this.count - 1 ) * 3;
			const dx = this.positions[ previous ] - x;
			const dy = this.positions[ previous + 1 ] - y;
			const dz = this.positions[ previous + 2 ] - z;
			if ( dx * dx + dy * dy + dz * dz <= 0.025 * 0.025 ) return false;

		}
		const offset = this.count * 3;
		this.positions[ offset ] = x;
		this.positions[ offset + 1 ] = y;
		this.positions[ offset + 2 ] = z;
		let nx = Number( normal?.x ?? normal?.[ 0 ] ?? 0 );
		let ny = Number( normal?.y ?? normal?.[ 1 ] ?? 1 );
		let nz = Number( normal?.z ?? normal?.[ 2 ] ?? 0 );
		const normalLength = Math.hypot( nx, ny, nz );
		if ( normalLength <= 1e-8 ) {

			nx = 0; ny = 1; nz = 0;

		} else {

			nx /= normalLength; ny /= normalLength; nz /= normalLength;

		}
		this.normals[ offset ] = nx;
		this.normals[ offset + 1 ] = ny;
		this.normals[ offset + 2 ] = nz;
		this.count ++;
		return true;

	}

	_appendAccess( descriptor, reverse = false ) {

		const access = descriptor?.access;
		if ( ! Array.isArray( access ) || access.length === 0 ) return;
		if ( reverse ) {

			for ( let index = access.length - 1; index >= 0; index -- )
				this._append( access[ index ].position, access[ index ].normal );

		} else for ( let index = 0; index < access.length; index ++ )
			this._append( access[ index ].position, access[ index ].normal );

	}

	plan( currentPosition, sourceCollider, destination, destinationNormal, targetCollider ) {

		this.count = 0;
		const sourceHandle = this._colliderHandle( sourceCollider );
		const targetHandle = this._colliderHandle( targetCollider );
		if ( sourceHandle !== null && sourceHandle !== targetHandle )
			this._appendAccess( this.accessByCollider.get( sourceHandle ), true );
		if ( targetHandle !== null && sourceHandle !== targetHandle )
			this._appendAccess( this.accessByCollider.get( targetHandle ), false );
		this._append( destination, destinationNormal );
		// A malformed or capacity-saturated graph must still keep the clicked point
		// as its final objective rather than silently stopping at an access portal.
		if ( this.count === 0 ) this._append( currentPosition, { x: 0, y: 1, z: 0 } );
		const finalOffset = ( this.count - 1 ) * 3;
		const dx = this.positions[ finalOffset ] - destination.x;
		const dy = this.positions[ finalOffset + 1 ] - destination.y;
		const dz = this.positions[ finalOffset + 2 ] - destination.z;
		if ( dx * dx + dy * dy + dz * dz > 0.025 * 0.025 ) {

			if ( this.count >= this.maximumWaypoints ) this.count --;
			this._append( destination, destinationNormal );

		}
		this.view.count = this.count;
		return this.view;

	}

}

export class AutonomousExplorer {

	constructor( seed = 0x43a91 ) {

		this.seed = seed >>> 0;
		this.timeToChange = 0;
		this.heading = new THREE.Vector3( -1, 0, 0 );
		this.phase = 0;
		this.lastPosition = new THREE.Vector3();
		this.hasProgressSample = false;
		this.progressSeconds = 0;
		this.progressDistance = 0;
		this.output = new THREE.Vector3();
		this._surfaceNormal = new THREE.Vector3( 0, 1, 0 );
		this._previousSurfaceNormal = new THREE.Vector3( 0, 1, 0 );
		this._surfaceHeading = new THREE.Vector3( -1, 0, 0 );
		this._boundaryCorrection = new THREE.Vector3();
		this.destination = new THREE.Vector3();
		this.destinationNormal = new THREE.Vector3( 0, 1, 0 );
		this.destinationActive = false;
		this.destinationCompleted = false;
		this.destinationArrivalRadius = 0.48;
		// Access portals represent a physical support hand-off, not a loose visual
		// hint. The radius stays just above the pelvis-to-ground clearance so branch
		// endpoints remain reachable, but below one forelimb span so a face/lip
		// waypoint cannot be skipped before the leading claws acquire it.
		this.routeWaypointRadius = 0.28;
		this.routePositions = new Float32Array( MAX_ROUTE_WAYPOINTS * 3 );
		this.routeNormals = new Float32Array( MAX_ROUTE_WAYPOINTS * 3 );
		this.routeCount = 0;
		this.routeIndex = 0;
		this.goalTurnRate = Math.PI * 1.65;
		this._toDestination = new THREE.Vector3();
		this._goalHeading = new THREE.Vector3( -1, 0, 0 );
		this._recoveryHeading = new THREE.Vector3( -1, 0, 0 );
		this._angleCross = new THREE.Vector3();
		this._goalProgressSeconds = 0;
		this._goalWindowDistance = Infinity;
		this._goalMotionDistance = 0;
		this._recoverySeconds = 0;
		this._recoverySign = 1;
		this._surfaceFrameValid = false;
		this._transportScratch = {
			axis: new THREE.Vector3(),
			firstCross: new THREE.Vector3(),
			secondCross: new THREE.Vector3(),
		};

	}

	_random() {

		this.seed = ( Math.imul( this.seed, 1664525 ) + 1013904223 ) >>> 0;
		return this.seed / 0x100000000;

	}

	resetProgress( position = null ) {

		this.hasProgressSample = position !== null;
		if ( position ) this.lastPosition.copy( position );
		this.progressSeconds = 0;
		this.progressDistance = 0;
		this._goalProgressSeconds = 0;
		this._goalWindowDistance = Infinity;
		this._goalMotionDistance = 0;
		this._recoverySeconds = 0;
		this.destinationCompleted = false;
		this._surfaceFrameValid = false;

	}

	setDestination( position, normal = null, currentPosition = null, routePlan = null ) {

		this.destination.copy( position );
		this.destinationNormal.copy( normal ?? this.destinationNormal );
		if ( this.destinationNormal.lengthSq() < 1e-8 ) this.destinationNormal.set( 0, 1, 0 );
		else this.destinationNormal.normalize();
		this.destinationActive = true;
		this.destinationCompleted = false;
		this.routeCount = 0;
		this.routeIndex = 0;
		const plannedCount = Math.max( 0, Math.min(
			MAX_ROUTE_WAYPOINTS,
			Math.trunc( routePlan?.count ?? 0 ),
		) );
		for ( let waypoint = 0; waypoint < plannedCount; waypoint ++ ) {

			const offset = waypoint * 3;
			const x = routePlan.positions?.[ offset ];
			const y = routePlan.positions?.[ offset + 1 ];
			const z = routePlan.positions?.[ offset + 2 ];
			if ( ! Number.isFinite( x ) || ! Number.isFinite( y ) || ! Number.isFinite( z ) )
				continue;
			const targetOffset = this.routeCount * 3;
			this.routePositions[ targetOffset ] = x;
			this.routePositions[ targetOffset + 1 ] = y;
			this.routePositions[ targetOffset + 2 ] = z;
			this.routeNormals[ targetOffset ] = routePlan.normals?.[ offset ] ?? 0;
			this.routeNormals[ targetOffset + 1 ] = routePlan.normals?.[ offset + 1 ] ?? 1;
			this.routeNormals[ targetOffset + 2 ] = routePlan.normals?.[ offset + 2 ] ?? 0;
			this.routeCount ++;

		}
		const lastOffset = ( this.routeCount - 1 ) * 3;
		const finalMissing = this.routeCount === 0 || Math.hypot(
			this.routePositions[ lastOffset ] - this.destination.x,
			this.routePositions[ lastOffset + 1 ] - this.destination.y,
			this.routePositions[ lastOffset + 2 ] - this.destination.z,
		) > 0.025;
		if ( finalMissing ) {

			if ( this.routeCount >= MAX_ROUTE_WAYPOINTS ) this.routeCount --;
			const offset = this.routeCount * 3;
			this.routePositions[ offset ] = this.destination.x;
			this.routePositions[ offset + 1 ] = this.destination.y;
			this.routePositions[ offset + 2 ] = this.destination.z;
			this.routeNormals[ offset ] = this.destinationNormal.x;
			this.routeNormals[ offset + 1 ] = this.destinationNormal.y;
			this.routeNormals[ offset + 2 ] = this.destinationNormal.z;
			this.routeCount ++;

		}
		this.resetProgress( currentPosition );
		return this.destination;

	}

	clearDestination() {

		this.destinationActive = false;
		this.destinationCompleted = false;
		this.routeCount = 0;
		this.routeIndex = 0;
		this._recoverySeconds = 0;
		this._goalProgressSeconds = 0;
		this._goalWindowDistance = Infinity;
		this._goalMotionDistance = 0;

	}

	_initializeSurfaceHeading() {

		this._surfaceHeading.copy( this.heading ).projectOnPlane( this._surfaceNormal );
		if ( this._surfaceHeading.lengthSq() < 1e-8 ) {

			// A horizontal exploration heading can point straight into a wall. World
			// up is useful only to choose that first tangent; it must not be added on
			// every wall tick, otherwise the far side of an edge can never be descended.
			this._surfaceHeading.set( 0, 1, 0 ).projectOnPlane( this._surfaceNormal );
			if ( this._surfaceHeading.lengthSq() < 1e-8 )
				this._surfaceHeading.set( 1, 0, 0 ).projectOnPlane( this._surfaceNormal );

		}
		this._surfaceHeading.normalize();
		this.heading.copy( this._surfaceHeading );
		this._previousSurfaceNormal.copy( this._surfaceNormal );
		this._surfaceFrameValid = true;

	}

	_updateSurfaceFrame( supportNormal ) {

		this._surfaceNormal.copy( supportNormal );
		if ( this._surfaceNormal.lengthSq() < 1e-8 ) this._surfaceNormal.set( 0, 1, 0 );
		else this._surfaceNormal.normalize();
		if ( ! this._surfaceFrameValid ) {

			this._initializeSurfaceHeading();
			return;

		}
		parallelTransportTangent(
			this._surfaceHeading,
			this.heading,
			this._previousSurfaceNormal,
			this._surfaceNormal,
			this._transportScratch,
		);
		if ( this._recoverySeconds > 0 ) parallelTransportTangent(
			this._recoveryHeading,
			this._recoveryHeading,
			this._previousSurfaceNormal,
			this._surfaceNormal,
			this._transportScratch,
		);
		this.heading.copy( this._surfaceHeading );
		this._previousSurfaceNormal.copy( this._surfaceNormal );

	}

	_rotateTangent( target, source, angle ) {

		const normal = this._surfaceNormal;
		const cosine = Math.cos( angle );
		const sine = Math.sin( angle );
		const dot = source.dot( normal );
		const x = source.x * cosine
			+ ( normal.y * source.z - normal.z * source.y ) * sine
			+ normal.x * dot * ( 1 - cosine );
		const y = source.y * cosine
			+ ( normal.z * source.x - normal.x * source.z ) * sine
			+ normal.y * dot * ( 1 - cosine );
		const z = source.z * cosine
			+ ( normal.x * source.y - normal.y * source.x ) * sine
			+ normal.z * dot * ( 1 - cosine );
		return target.set( x, y, z ).projectOnPlane( normal ).normalize();

	}

	_turnOnSurface( angle ) {

		this._rotateTangent( this.heading, this.heading, angle );
		this._surfaceHeading.copy( this.heading );

	}

	_turnTowards( desired, maximumAngle ) {

		this._angleCross.crossVectors( this.heading, desired );
		const sine = this._angleCross.dot( this._surfaceNormal );
		const cosine = THREE.MathUtils.clamp( this.heading.dot( desired ), -1, 1 );
		const angle = Math.atan2( sine, cosine );
		this._turnOnSurface( THREE.MathUtils.clamp( angle, -maximumAngle, maximumAngle ) );

	}

	_trackGoalProgress( dt, distance, position ) {

		if ( ! Number.isFinite( this._goalWindowDistance ) ) {

			this._goalWindowDistance = distance;
			this.lastPosition.copy( position );
			this.hasProgressSample = true;

		} else if ( this.hasProgressSample ) {

			this._goalMotionDistance += Math.min( 0.25, this.lastPosition.distanceTo( position ) );
			this.lastPosition.copy( position );

		}
		this._goalProgressSeconds += dt;
		if ( this._goalProgressSeconds < 1.45 ) return false;
		// Climbing a wall can temporarily increase Euclidean goal distance. It is
		// progress nonetheless, so recovery is reserved for a genuinely immobile
		// body instead of disrupting a successful edge traversal.
		const stuck = this._goalMotionDistance < 0.055;
		this._goalProgressSeconds = 0;
		this._goalWindowDistance = distance;
		this._goalMotionDistance = 0;
		return stuck;

	}

	_updateDestination( dt, position, target ) {

		let distance = 0;
		let arrivalRadius = this.destinationArrivalRadius;
		for ( let skipped = 0; skipped < MAX_ROUTE_WAYPOINTS; skipped ++ ) {

			const offset = Math.min( this.routeIndex, Math.max( 0, this.routeCount - 1 ) ) * 3;
			this._toDestination.set(
				this.routeCount > 0 ? this.routePositions[ offset ] : this.destination.x,
				this.routeCount > 0 ? this.routePositions[ offset + 1 ] : this.destination.y,
				this.routeCount > 0 ? this.routePositions[ offset + 2 ] : this.destination.z,
			).sub( position );
			distance = this._toDestination.length();
			const finalWaypoint = this.routeCount <= 1 || this.routeIndex >= this.routeCount - 1;
			arrivalRadius = finalWaypoint ? this.destinationArrivalRadius : this.routeWaypointRadius;
			if ( distance > arrivalRadius ) break;
			if ( finalWaypoint ) {

				this.destinationActive = false;
				this.destinationCompleted = true;
				this._recoverySeconds = 0;
				return target.set( 0, 0, 0 );

			}
			this.routeIndex ++;
			this._goalProgressSeconds = 0;
			this._goalWindowDistance = Infinity;
			this._goalMotionDistance = 0;
			this._recoverySeconds = 0;
			this.lastPosition.copy( position );
			this.hasProgressSample = true;

		}
		const depth = this._toDestination.dot( this._surfaceNormal );
		this._goalHeading.copy( this._toDestination ).projectOnPlane( this._surfaceNormal );
		if ( this._goalHeading.lengthSq() > 1e-8 ) {

			this._goalHeading.normalize();
			if ( depth < -0.08 ) {

				// The target is behind the current supporting face. Preserving most of
				// the transported heading commits to the obstacle edge instead of
				// oscillating between a wall, its top and the floor every fixed tick.
				const commitment = THREE.MathUtils.clamp( -depth / Math.max( distance, 1e-5 ), 0.38, 0.82 );
				this._goalHeading.lerp( this.heading, commitment ).normalize();

			}

		} else this._goalHeading.copy( this.heading );

		if ( this._trackGoalProgress( dt, distance, position ) ) {

			this._recoverySign *= -1;
			this._rotateTangent(
				this._recoveryHeading,
				this._goalHeading,
				this._recoverySign * 0.72,
			);
			this._recoverySeconds = 0.78;

		}
		if ( this._recoverySeconds > 0 ) {

			this._recoverySeconds = Math.max( 0, this._recoverySeconds - dt );
			this._turnTowards( this._recoveryHeading, this.goalTurnRate * dt );

		} else this._turnTowards( this._goalHeading, this.goalTurnRate * dt );

		const slowDistance = Math.max( 0, distance - arrivalRadius );
		const speed = THREE.MathUtils.clamp( slowDistance / 0.8, 0.28, 1 );
		return target.copy( this.heading ).multiplyScalar( speed );

	}

	_trackProgress( dt, position ) {

		if ( ! this.hasProgressSample ) {

			this.lastPosition.copy( position );
			this.hasProgressSample = true;
			return false;

		}
		this.progressDistance += Math.min( 0.25, this.lastPosition.distanceTo( position ) );
		this.lastPosition.copy( position );
		this.progressSeconds += dt;
		if ( this.progressSeconds < 1.75 ) return false;
		const stuck = this.progressDistance < 0.065;
		this.progressSeconds = 0;
		this.progressDistance = 0;
		return stuck;

	}

	update( dt, supportNormal, position, target = null ) {

		this._updateSurfaceFrame( supportNormal );
		target ??= this.output;
		if ( this.destinationActive )
			return this._updateDestination( dt, position, target );
		if ( this.destinationCompleted ) return target.set( 0, 0, 0 );
		this.timeToChange -= dt;
		this.phase += dt;
		if ( this._trackProgress( dt, position ) ) {

			const turnSign = this._random() < 0.5 ? -1 : 1;
			this._turnOnSurface( turnSign * ( 0.9 + this._random() * 0.8 ) );
			this.timeToChange = 2.2 + this._random() * 2.2;

		}
		if ( this.timeToChange <= 0 ) {

			this._turnOnSurface( ( this._random() - 0.5 ) * 1.35 );
			this.timeToChange = 8 + this._random() * 8;

		}
		target.copy( this.heading );
		const edge = 9.5;
		this._boundaryCorrection.set(
			Math.abs( position.x ) > edge ? -Math.sign( position.x ) * 1.5 : 0,
			0,
			Math.abs( position.z ) > edge ? -Math.sign( position.z ) * 1.5 : 0,
		).projectOnPlane( this._surfaceNormal );
		target.add( this._boundaryCorrection );
		if ( target.lengthSq() < 1e-8 ) target.copy( this.heading );
		return target.normalize().multiplyScalar( 0.72 );

	}

}
