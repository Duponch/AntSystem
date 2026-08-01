import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import {
	PASSIVE_TAIL_BONE_COUNT,
	PASSIVE_TAIL_NODE_COUNT,
} from '../src/chameleon-lab/passive-tail-physics.js';
import { PassiveTailVisualRig } from '../src/chameleon-lab/passive-tail-visual-rig.js';

const SEGMENT_LENGTH = 0.1;

function createStraightTail() {

	const model = new THREE.Group();
	model.userData.tail_rest_segment_lengths = Array(
		PASSIVE_TAIL_BONE_COUNT,
	).fill( SEGMENT_LENGTH );
	model.userData.tail_static_collar_bones = 'tail_01';
	let parent = model;
	for ( let index = 0; index < PASSIVE_TAIL_BONE_COUNT; index ++ ) {

		const bone = new THREE.Bone();
		bone.name = `tail_${ String( index + 1 ).padStart( 2, '0' ) }`;
		if ( index > 0 ) bone.position.y = SEGMENT_LENGTH;
		parent.add( bone );
		parent = bone;

	}
	model.updateMatrixWorld( true );
	return { model, rig: new PassiveTailVisualRig( model ) };

}

function curvedCentreline() {

	const positions = new Float32Array( PASSIVE_TAIL_NODE_COUNT * 3 );
	positions[ 4 ] = SEGMENT_LENGTH;
	for ( let node = 2; node < PASSIVE_TAIL_NODE_COUNT; node ++ ) {

		const previous = ( node - 1 ) * 3;
		const offset = node * 3;
		const angle = ( node - 1 ) * 0.34;
		let x = Math.sin( angle ) * 0.42;
		let y = 0.84;
		let z = Math.cos( angle * 0.77 ) * 0.34;
		const inverseLength = SEGMENT_LENGTH / Math.hypot( x, y, z );
		x *= inverseLength;
		y *= inverseLength;
		z *= inverseLength;
		positions[ offset ] = positions[ previous ] + x;
		positions[ offset + 1 ] = positions[ previous + 1 ] + y;
		positions[ offset + 2 ] = positions[ previous + 2 ] + z;

	}
	return positions;

}

test( 'CHAMELEON-LAB-TAIL-VISUAL-001 rest-relative parallel transport cannot accumulate axial braid', () => {

	const { model, rig } = createStraightTail();
	const positions = curvedCentreline();
	rig.applyPositions( positions );
	const reference = rig.bones.map( ( bone ) => bone.quaternion.clone() );
	const axis = new THREE.Vector3( 0, 1, 0 );
	const injected = new THREE.Quaternion();
	for ( let repetition = 0; repetition < 240; repetition ++ ) {

		// Emulate arbitrary inherited longitudinal roll. The next mapping must be
		// a pure function of collar + centreline, never of this corrupted history.
		for ( let index = rig.physicsKinematicBoneCount; index < rig.bones.length; index ++ ) {

			injected.setFromAxisAngle( axis, ( ( index & 1 ) ? -1 : 1 ) * 0.37 );
			rig.bones[ index ].quaternion.multiply( injected );

		}
		model.updateMatrixWorld( true );
		assert.equal( rig.applyPositions( positions ), rig );
		for ( let index = rig.physicsKinematicBoneCount; index < rig.bones.length; index ++ )
			assert.ok(
				rig.bones[ index ].quaternion.angleTo( reference[ index ] ) < 2e-6,
				`tail ring ${ index } retained longitudinal roll`,
			);

	}

} );

test( 'CHAMELEON-LAB-TAIL-VISUAL-002 dynamic rings follow the curve with a finite orthonormal frame', () => {

	const { rig } = createStraightTail();
	const positions = curvedCentreline();
	rig.applyPositions( positions );
	const x = new THREE.Vector3();
	const y = new THREE.Vector3();
	const z = new THREE.Vector3();
	const quaternion = new THREE.Quaternion();
	const expected = new THREE.Vector3();
	for ( let index = rig.physicsKinematicBoneCount; index < rig.bones.length; index ++ ) {

		const offset = index * 3;
		rig.bones[ index ].getWorldQuaternion( quaternion );
		x.set( 1, 0, 0 ).applyQuaternion( quaternion );
		y.set( 0, 1, 0 ).applyQuaternion( quaternion );
		z.set( 0, 0, 1 ).applyQuaternion( quaternion );
		expected.set(
			positions[ offset + 3 ] - positions[ offset ],
			positions[ offset + 4 ] - positions[ offset + 1 ],
			positions[ offset + 5 ] - positions[ offset + 2 ],
		).normalize();
		assert.ok( y.dot( expected ) > 0.999999, `tail tangent ${ index } drifted` );
		assert.ok( Math.abs( x.dot( y ) ) < 2e-6 );
		assert.ok( Math.abs( y.dot( z ) ) < 2e-6 );
		assert.ok( Math.abs( z.dot( x ) ) < 2e-6 );
		assert.ok( Math.abs( x.length() - 1 ) < 2e-6 );
		assert.ok( Math.abs( y.length() - 1 ) < 2e-6 );
		assert.ok( Math.abs( z.length() - 1 ) < 2e-6 );

	}

} );

test( 'CHAMELEON-LAB-TAIL-VISUAL-003 render mapping keeps its fixed scratch hot path', async () => {

	const source = await readFile(
		new URL( '../src/chameleon-lab/passive-tail-visual-rig.js', import.meta.url ),
		'utf8',
	);
	const start = source.indexOf( '\n\tapplyPositions( positions ) {' );
	const end = source.indexOf( '\n\t}\n\n}\n', start );
	assert.ok( start >= 0 && end > start );
	const hotPath = source.slice( start, end );
	assert.doesNotMatch( hotPath, /\bnew\s+(?:THREE\.|Float32Array|Array|Map|Set)/u );
	assert.doesNotMatch( hotPath, /\.clone\s*\(/u );
	assert.match( hotPath, /_parallelTransportReference/u );

} );
