import * as THREE from 'three/webgpu';

import {
	PASSIVE_TAIL_BONE_COUNT,
	PASSIVE_TAIL_NODE_COUNT,
} from './passive-tail-physics.js';

const LOCAL_BONE_AXIS = new THREE.Vector3( 0, 1, 0 );
const TAIL_BONE_NAMES = Object.freeze( Array.from(
	{ length: PASSIVE_TAIL_BONE_COUNT },
	( _, index ) => `tail_${ String( index + 1 ).padStart( 2, '0' ) }`,
) );

function tailMetadata( model ) {

	let metadata = null;
	model.traverse( ( object ) => {

		if ( metadata || ! Array.isArray( object.userData?.tail_rest_segment_lengths ) ) return;
		metadata = object.userData;

	} );
	if ( ! metadata ) throw new Error( 'Hybrid chameleon tail rest metadata is missing.' );
	if ( metadata.tail_rest_segment_lengths.length !== PASSIVE_TAIL_BONE_COUNT )
		throw new Error( 'Hybrid chameleon tail segment metadata is invalid.' );
	return metadata;

}

/**
 * Maps the constant-size XPBD centreline back to the exact original skinned
 * tail. Only bone rotations are written: the original vertices, topology,
 * rest spiral, bone lengths and root attachment stay untouched.
 */
export class PassiveTailVisualRig {

	constructor( model ) {

		this.model = model;
		this.metadata = tailMetadata( model );
		this.bones = TAIL_BONE_NAMES.map( ( name ) => {

			const bone = model.getObjectByName( name );
			if ( ! bone?.isBone ) throw new Error( `Hybrid chameleon is missing bone "${ name }".` );
			return bone;

		} );
		this.segmentLengths = Float32Array.from(
			this.metadata.tail_rest_segment_lengths,
		);
		this.staticBoneCount = typeof this.metadata.tail_static_collar_bones === 'string'
			? this.metadata.tail_static_collar_bones.split( ',' ).filter( Boolean ).length
			: 1;
		if ( this.staticBoneCount !== 1 )
			throw new Error(
				'Hybrid chameleon 3.6 tail contract requires tail_01 as the sole static collar bone.',
			);
		// Only tail_01 is rigidly attached to the pelvis. The exported skin weights
		// provide the graded sacral transition, while tail_02 already follows the
		// collision-tested rod. Keeping that transition in one authority avoids a
		// second render-only bend that could put the skin back through a surface.
		this.physicsKinematicBoneCount = this.staticBoneCount;
		// Rendering must remain a one-to-one view of the collision-tested rod. A
		// second visual blend changes the world-space curve *after* collision and
		// can bury the skin even when every physical sample is valid. Compliance is
		// therefore graded in the solver, not in the renderer.
		this.transitionWeights = new Float32Array( this.bones.length );
		this.transitionWeights.fill( 1, this.physicsKinematicBoneCount );
		this.restWorldPositions = new Float32Array( PASSIVE_TAIL_NODE_COUNT * 3 );
		this.worldPositions = new Float32Array( PASSIVE_TAIL_NODE_COUNT * 3 );
		this._bonePosition = new THREE.Vector3();
		this._nextPosition = new THREE.Vector3();
		this._currentDirection = new THREE.Vector3();
		this._desiredDirection = new THREE.Vector3();
		this._worldQuaternion = new THREE.Quaternion();
		this._worldScale = new THREE.Vector3();
		this._parentWorldPosition = new THREE.Vector3();
		this._parentWorldQuaternion = new THREE.Quaternion();
		this._parentWorldScale = new THREE.Vector3();
		this._deltaQuaternion = new THREE.Quaternion();
		this._candidateQuaternion = new THREE.Quaternion();
		this.captureRestWorldPositions( this.restWorldPositions );

	}

	captureRestWorldPositions( target = this.restWorldPositions ) {

		if ( ! target || target.length < PASSIVE_TAIL_NODE_COUNT * 3 )
			throw new RangeError( 'tail rest position buffer is too short' );
		this.model.updateMatrixWorld( true );
		for ( let index = 0; index < this.bones.length; index ++ ) {

			this.bones[ index ].getWorldPosition( this._bonePosition );
			const offset = index * 3;
			target[ offset ] = this._bonePosition.x;
			target[ offset + 1 ] = this._bonePosition.y;
			target[ offset + 2 ] = this._bonePosition.z;

		}
		const last = this.bones[ this.bones.length - 1 ];
		last.getWorldPosition( this._bonePosition );
		last.getWorldQuaternion( this._worldQuaternion );
		this._nextPosition.copy( LOCAL_BONE_AXIS )
			.multiplyScalar( this.segmentLengths[ this.segmentLengths.length - 1 ] )
			.applyQuaternion( this._worldQuaternion )
			.add( this._bonePosition );
		const tipOffset = ( PASSIVE_TAIL_NODE_COUNT - 1 ) * 3;
		target[ tipOffset ] = this._nextPosition.x;
		target[ tipOffset + 1 ] = this._nextPosition.y;
		target[ tipOffset + 2 ] = this._nextPosition.z;
		return target;

	}

	applyPositions( positions ) {

		if ( ! positions || positions.length < PASSIVE_TAIL_NODE_COUNT * 3 )
			throw new RangeError( 'tail pose buffer is too short' );
		// Positions already live in world space and the two kinematic root samples
		// are captured from the actual skeleton every fixed step. Never rotate that
		// collision-safe curve a second time at render time.
		this.worldPositions.set( positions );
		const firstDynamicBone = this.bones[ this.physicsKinematicBoneCount ];
		// Refresh the shared ancestor path once. Dynamic tail bones are ordered from
		// parent to child, so each solved bone can then publish its own world matrix
		// for the following bone without recursively revisiting every descendant.
		firstDynamicBone.parent.updateWorldMatrix( true, false );

		for ( let index = this.physicsKinematicBoneCount; index < this.bones.length; index ++ ) {

			const bone = this.bones[ index ];
			bone.updateWorldMatrix( false, false );
			bone.matrixWorld.decompose(
				this._bonePosition, this._worldQuaternion, this._worldScale,
			);
			this._currentDirection.copy( LOCAL_BONE_AXIS )
				.applyQuaternion( this._worldQuaternion ).normalize();
			const offset = index * 3;
			// Aim from the *actual* hierarchical bone origin to the physical next
			// sample. Using only the physical segment direction lets small constraint
			// length errors accumulate down the fixed-length bone hierarchy. Positional
			// catch-up keeps every distal origin close to the collision-safe centreline;
			// the exported skin weights remain the sole graded visual transition.
			this._desiredDirection.set(
				this.worldPositions[ offset + 3 ] - this._bonePosition.x,
				this.worldPositions[ offset + 4 ] - this._bonePosition.y,
				this.worldPositions[ offset + 5 ] - this._bonePosition.z,
			);
			if ( this._desiredDirection.lengthSq() < 1e-10 ) continue;
			this._desiredDirection.normalize();
			this._deltaQuaternion.setFromUnitVectors(
				this._currentDirection,
				this._desiredDirection,
			);
			this._candidateQuaternion.copy( this._deltaQuaternion )
				.multiply( this._worldQuaternion );
			bone.parent.matrixWorld.decompose(
				this._parentWorldPosition, this._parentWorldQuaternion, this._parentWorldScale,
			);
			this._parentWorldQuaternion.invert();
			this._candidateQuaternion.premultiply( this._parentWorldQuaternion ).normalize();
			bone.quaternion.copy( this._candidateQuaternion ).normalize();
			// Make this solved transform authoritative before its child is visited.
			bone.updateWorldMatrix( false, false );

		}
		// Preserve the former public side effect for any non-bone attachments with
		// one linear propagation instead of one recursive subtree pass per tail bone.
		this.model.updateWorldMatrix( false, true );
		return this;

	}

}

export function createPassiveTailVisualRig( model ) {

	return new PassiveTailVisualRig( model );

}
