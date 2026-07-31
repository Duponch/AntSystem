import * as THREE from 'three/webgpu';

const ZERO = new THREE.Vector3();

function vectorRecord( value ) {

	return { x: value.x, y: value.y, z: value.z };

}

function rapierVector( value, target = new THREE.Vector3() ) {

	return target.set( value.x, value.y, value.z );

}

function rapierQuaternion( value, target = new THREE.Quaternion() ) {

	return target.set( value.x, value.y, value.z, value.w );

}

function clampLength( vector, maximum ) {

	const length = vector.length();
	if ( length > maximum ) vector.multiplyScalar( maximum / length );
	return vector;

}

function worldAnchor( body, local, target = new THREE.Vector3() ) {

	return target.copy( local )
		.applyQuaternion( rapierQuaternion( body.rotation() ) )
		.add( rapierVector( body.translation() ) );

}

function velocityAtPoint( body, point, target = new THREE.Vector3() ) {

	const center = rapierVector( body.translation(), new THREE.Vector3() );
	const angular = rapierVector( body.angvel(), new THREE.Vector3() );
	return rapierVector( body.linvel(), target )
		.add( angular.cross( point.clone().sub( center ) ) );

}

export class GrabController {

	constructor( {
		camera,
		domElement,
		physics,
		onGrabChange = () => {},
	} ) {

		this.camera = camera;
		this.domElement = domElement;
		this.physics = physics;
		this.onGrabChange = onGrabChange;
		this.raycaster = new THREE.Raycaster();
		this.ndc = new THREE.Vector2();
		this.dragPlane = new THREE.Plane();
		this.body = null;
		this.collider = null;
		this.localAnchor = new THREE.Vector3();
		this.target = new THREE.Vector3();
		this.previousTarget = new THREE.Vector3();
		this.targetVelocity = new THREE.Vector3();
		this.pointer = new THREE.Vector2();
		this.pointerId = null;
		this.stiffness = 92;
		this.damping = 11;
		this.maximumForce = 135;
		this.throwStrength = 0.42;
		this._lastMoveTime = 0;
		this._onPointerDown = ( event ) => this._pointerDown( event );
		this._onPointerMove = ( event ) => this._pointerMove( event );
		this._onPointerUp = ( event ) => this._pointerUp( event );
		this._onPointerCancel = ( event ) => this._release( event, false );
		domElement.addEventListener( 'pointerdown', this._onPointerDown );
		domElement.addEventListener( 'pointermove', this._onPointerMove );
		domElement.addEventListener( 'pointerup', this._onPointerUp );
		domElement.addEventListener( 'pointercancel', this._onPointerCancel );

	}

	_setPointer( event ) {

		const rect = this.domElement.getBoundingClientRect();
		this.pointer.set( event.clientX, event.clientY );
		this.ndc.set(
			( ( event.clientX - rect.left ) / rect.width ) * 2 - 1,
			- ( ( event.clientY - rect.top ) / rect.height ) * 2 + 1,
		);
		this.raycaster.setFromCamera( this.ndc, this.camera );

	}

	_pointerDown( event ) {

		if ( event.button !== 0 || this.body ) return;
		this._setPointer( event );
		const ray = this.raycaster.ray;
		const physicsRay = new this.physics.RAPIER.Ray(
			vectorRecord( ray.origin ),
			vectorRecord( ray.direction ),
		);
		const hit = this.physics.world.castRay(
			physicsRay,
			50,
			true,
			undefined,
			undefined,
			undefined,
			undefined,
			( collider ) => collider.parent()?.userData?.kind === 'chameleon-proxy',
		);
		if ( ! hit ) return;
		const body = hit.collider.parent();
		if ( ! body ) return;
		event.preventDefault();
		event.stopPropagation();
		this.body = body;
		body.enableCcd( true );
		this.collider = hit.collider;
		const point = ray.at( hit.timeOfImpact, new THREE.Vector3() );
		const position = rapierVector( body.translation(), new THREE.Vector3() );
		const inverseRotation = rapierQuaternion( body.rotation() ).invert();
		this.localAnchor.copy( point ).sub( position ).applyQuaternion( inverseRotation );
		this.target.copy( point );
		this.previousTarget.copy( point );
		this.targetVelocity.set( 0, 0, 0 );
		const cameraNormal = this.camera.getWorldDirection( new THREE.Vector3() ).normalize();
		this.dragPlane.setFromNormalAndCoplanarPoint( cameraNormal, point );
		this.pointerId = event.pointerId;
		this._lastMoveTime = performance.now();
		this.domElement.setPointerCapture?.( event.pointerId );
		this.onGrabChange( true, body.userData );

	}

	_pointerMove( event ) {

		if ( ! this.body || event.pointerId !== this.pointerId ) return;
		this._setPointer( event );
		const next = this.raycaster.ray.intersectPlane( this.dragPlane, new THREE.Vector3() );
		if ( ! next ) return;
		const now = performance.now();
		const dt = Math.max( 1 / 240, Math.min( 0.05, ( now - this._lastMoveTime ) / 1000 ) );
		this._lastMoveTime = now;
		const instantaneous = next.clone().sub( this.target ).multiplyScalar( 1 / dt );
		clampLength( instantaneous, 22 );
		this.targetVelocity.lerp( instantaneous, 0.58 );
		this.previousTarget.copy( this.target );
		this.target.copy( next );

	}

	_pointerUp( event ) {

		this._release( event, true );

	}

	_release( event, applyThrow ) {

		if ( ! this.body || ( event.pointerId !== undefined && event.pointerId !== this.pointerId ) ) return;
		const body = this.body;
		if ( applyThrow ) {

			const anchor = worldAnchor( body, this.localAnchor );
			const impulse = clampLength(
				this.targetVelocity.clone().multiplyScalar( body.mass() * this.throwStrength ),
				4.8,
			);
			body.applyImpulseAtPoint( vectorRecord( impulse ), vectorRecord( anchor ), true );

		}
		if ( this.pointerId !== null ) this.domElement.releasePointerCapture?.( this.pointerId );
		this.body = null;
		this.collider = null;
		this.pointerId = null;
		this.targetVelocity.set( 0, 0, 0 );
		this.onGrabChange( false, body.userData );

	}

	beforeStep( dt = 1 / 120 ) {

		if ( ! this.body ) return;
		const point = worldAnchor( this.body, this.localAnchor );
		const velocity = velocityAtPoint( this.body, point );
		const force = this.target.clone().sub( point ).multiplyScalar( this.stiffness )
			.addScaledVector( this.targetVelocity.clone().sub( velocity ), this.damping );
		if ( performance.now() - this._lastMoveTime > 32 ) {

			this.targetVelocity.multiplyScalar( Math.exp( -18 * dt ) );

		}
		clampLength( force, Math.min( this.maximumForce, 28 + this.body.mass() * 110 ) );
		this.body.addForceAtPoint( vectorRecord( force ), vectorRecord( point ), true );

	}

	cancel() {

		if ( ! this.body ) return;
		const body = this.body;
		if ( this.pointerId !== null ) this.domElement.releasePointerCapture?.( this.pointerId );
		this.body = null;
		this.collider = null;
		this.pointerId = null;
		this.targetVelocity.copy( ZERO );
		this.onGrabChange( false, body.userData );

	}

	dispose() {

		this.cancel();
		this.domElement.removeEventListener( 'pointerdown', this._onPointerDown );
		this.domElement.removeEventListener( 'pointermove', this._onPointerMove );
		this.domElement.removeEventListener( 'pointerup', this._onPointerUp );
		this.domElement.removeEventListener( 'pointercancel', this._onPointerCancel );

	}

}
