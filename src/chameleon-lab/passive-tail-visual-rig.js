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
		if ( this.staticBoneCount < 1 || this.staticBoneCount >= this.bones.length )
			throw new Error( 'Hybrid chameleon static tail collar metadata is invalid.' );
		// The skin guard protects the rump vertices, but it must not create a hard
		// motion seam. Physics releases one bone earlier and the first three visual
		// rotations progressively blend from the authored collar into the rod.
		this.physicsKinematicBoneCount = Math.max( 1, this.staticBoneCount - 1 );
		this.transitionWeights = new Float32Array( this.bones.length );
		for ( let index = this.physicsKinematicBoneCount; index < this.bones.length; index ++ )
			this.transitionWeights[ index ] = index === this.physicsKinematicBoneCount
				? 0.28 : index === this.physicsKinematicBoneCount + 1
					? 0.58 : index === this.physicsKinematicBoneCount + 2 ? 0.82 : 1;
		this.restQuaternions = this.bones.map( ( bone ) => bone.quaternion.clone() );
		this.restWorldPositions = new Float32Array( PASSIVE_TAIL_NODE_COUNT * 3 );
		this.rebasedPositions = new Float32Array( PASSIVE_TAIL_NODE_COUNT * 3 );
		this._bonePosition = new THREE.Vector3();
		this._nextPosition = new THREE.Vector3();
		this._physicsRoot = new THREE.Vector3();
		this._visualRoot = new THREE.Vector3();
		this._physicsDirection = new THREE.Vector3();
		this._visualDirection = new THREE.Vector3();
		this._relative = new THREE.Vector3();
		this._currentDirection = new THREE.Vector3();
		this._desiredDirection = new THREE.Vector3();
		this._worldQuaternion = new THREE.Quaternion();
		this._parentWorldQuaternion = new THREE.Quaternion();
		this._deltaQuaternion = new THREE.Quaternion();
		this._candidateQuaternion = new THREE.Quaternion();
		this._rebaseQuaternion = new THREE.Quaternion();
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
		const collarIndex = this.physicsKinematicBoneCount - 1;
		const collar = this.bones[ collarIndex ];
		collar.updateWorldMatrix( true, true );
		collar.getWorldPosition( this._bonePosition );
		collar.getWorldQuaternion( this._worldQuaternion );
		this._visualRoot.copy( LOCAL_BONE_AXIS )
			.multiplyScalar( this.segmentLengths[ collarIndex ] )
			.applyQuaternion( this._worldQuaternion )
			.add( this._bonePosition );
		const rootOffset = this.physicsKinematicBoneCount * 3;
		const previousOffset = rootOffset - 3;
		this._physicsRoot.fromArray( positions, rootOffset );
		this._physicsDirection.set(
			positions[ rootOffset ] - positions[ previousOffset ],
			positions[ rootOffset + 1 ] - positions[ previousOffset + 1 ],
			positions[ rootOffset + 2 ] - positions[ previousOffset + 2 ],
		);
		this._visualDirection.subVectors( this._visualRoot, this._bonePosition );
		if ( this._physicsDirection.lengthSq() > 1e-10
			&& this._visualDirection.lengthSq() > 1e-10 )
			this._rebaseQuaternion.setFromUnitVectors(
				this._physicsDirection.normalize(), this._visualDirection.normalize(),
			);
		else this._rebaseQuaternion.identity();
		for ( let node = this.physicsKinematicBoneCount; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

			const offset = node * 3;
			this._relative.fromArray( positions, offset ).sub( this._physicsRoot )
				.applyQuaternion( this._rebaseQuaternion ).add( this._visualRoot );
			this.rebasedPositions[ offset ] = this._relative.x;
			this.rebasedPositions[ offset + 1 ] = this._relative.y;
			this.rebasedPositions[ offset + 2 ] = this._relative.z;

		}

		for ( let index = this.physicsKinematicBoneCount; index < this.bones.length; index ++ ) {

			const bone = this.bones[ index ];
			bone.updateWorldMatrix( true, true );
			bone.getWorldPosition( this._bonePosition );
			bone.getWorldQuaternion( this._worldQuaternion );
			this._currentDirection.copy( LOCAL_BONE_AXIS )
				.applyQuaternion( this._worldQuaternion ).normalize();
			const offset = index * 3;
			this._desiredDirection.set(
				this.rebasedPositions[ offset + 3 ] - this.rebasedPositions[ offset ],
				this.rebasedPositions[ offset + 4 ] - this.rebasedPositions[ offset + 1 ],
				this.rebasedPositions[ offset + 5 ] - this.rebasedPositions[ offset + 2 ],
			);
			if ( this._desiredDirection.lengthSq() < 1e-10 ) continue;
			this._desiredDirection.normalize();
			this._deltaQuaternion.setFromUnitVectors(
				this._currentDirection,
				this._desiredDirection,
			);
			this._candidateQuaternion.copy( this._deltaQuaternion )
				.multiply( this._worldQuaternion );
			bone.parent.getWorldQuaternion( this._parentWorldQuaternion ).invert();
			this._candidateQuaternion.premultiply( this._parentWorldQuaternion ).normalize();
			bone.quaternion.slerpQuaternions(
				this.restQuaternions[ index ],
				this._candidateQuaternion,
				this.transitionWeights[ index ],
			).normalize();

		}
		this.model.updateMatrixWorld( true );
		return this;

	}

}

export function createPassiveTailVisualRig( model ) {

	return new PassiveTailVisualRig( model );

}
