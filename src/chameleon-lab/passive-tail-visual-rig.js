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
		this.restWorldPositions = new Float32Array( PASSIVE_TAIL_NODE_COUNT * 3 );
		this._bonePosition = new THREE.Vector3();
		this._nextPosition = new THREE.Vector3();
		this._currentDirection = new THREE.Vector3();
		this._desiredDirection = new THREE.Vector3();
		this._worldQuaternion = new THREE.Quaternion();
		this._parentWorldQuaternion = new THREE.Quaternion();
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
		for ( let index = 0; index < this.bones.length; index ++ ) {

			const bone = this.bones[ index ];
			bone.updateWorldMatrix( true, true );
			bone.getWorldPosition( this._bonePosition );
			bone.getWorldQuaternion( this._worldQuaternion );
			this._currentDirection.copy( LOCAL_BONE_AXIS )
				.applyQuaternion( this._worldQuaternion ).normalize();
			const offset = index * 3;
			this._desiredDirection.set(
				positions[ offset + 3 ] - positions[ offset ],
				positions[ offset + 4 ] - positions[ offset + 1 ],
				positions[ offset + 5 ] - positions[ offset + 2 ],
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
			bone.quaternion.copy(
				this._candidateQuaternion.premultiply( this._parentWorldQuaternion ),
			).normalize();

		}
		this.model.updateMatrixWorld( true );
		return this;

	}

}

export function createPassiveTailVisualRig( model ) {

	return new PassiveTailVisualRig( model );

}
