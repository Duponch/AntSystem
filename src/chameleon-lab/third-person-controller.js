import * as THREE from 'three/webgpu';

const MOVEMENT_KEYS = new Set( [
	'KeyW', 'KeyZ', 'ArrowUp',
	'KeyS', 'ArrowDown',
	'KeyA', 'KeyQ', 'ArrowLeft',
	'KeyD', 'ArrowRight',
] );

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
	const x = right - left;
	const y = forward - backward;
	const length = Math.hypot( x, y );
	target.x = length > 1 ? x / length : x;
	target.y = length > 1 ? y / length : y;
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
			( collider ) => this.physics.surfaceByCollider?.has( collider.handle ) === true,
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

	update( dt, supportNormal, position, target = new THREE.Vector3() ) {

		this.timeToChange -= dt;
		this.phase += dt;
		if ( this._trackProgress( dt, position ) ) {

			const turnSign = this._random() < 0.5 ? -1 : 1;
			const angle = Math.atan2( this.heading.z, this.heading.x )
				+ turnSign * ( 0.9 + this._random() * 0.8 );
			this.heading.set( Math.cos( angle ), 0, Math.sin( angle ) );
			this.timeToChange = 1.2 + this._random() * 1.6;

		}
		if ( this.timeToChange <= 0 ) {

			const angle = this._random() * Math.PI * 2;
			this.heading.set( Math.cos( angle ), 0, Math.sin( angle ) );
			this.timeToChange = 3.5 + this._random() * 5.5;

		}
		if ( Math.abs( supportNormal.y ) < 0.72 ) {

			const sideways = this.heading.clone().projectOnPlane( supportNormal );
			const climb = new THREE.Vector3( 0, 1, 0 ).projectOnPlane( supportNormal );
			target.copy( sideways ).multiplyScalar( 0.65 )
				.addScaledVector( climb, 0.45 + Math.sin( this.phase * 0.47 ) * 0.22 );

		} else {

			target.copy( this.heading );

		}
		const edge = 9.5;
		if ( Math.abs( position.x ) > edge ) target.x -= Math.sign( position.x ) * 1.5;
		if ( Math.abs( position.z ) > edge ) target.z -= Math.sign( position.z ) * 1.5;
		return target.normalize().multiplyScalar( 0.72 );

	}

}
