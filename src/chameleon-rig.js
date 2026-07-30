import * as THREE from 'three/webgpu';

export const CHAMELEON_LEG_COUNT = 4;
export const CHAMELEON_BODY_CORRECTION_COUNT = 2;
export const CHAMELEON_TAIL_JOINT_COUNT = 9;
export const CHAMELEON_TAIL_PROBE_BONE_INDICES = Object.freeze( [ 2, 5, 8 ] );
export const CHAMELEON_TAIL_CORRECTION_BONE_INDICES = Object.freeze( [ 1, 4, 7 ] );
const CHAMELEON_TAIL_BLOCK_START_BONE_INDICES = Object.freeze( [ 0, 2, 5 ] );
const CHAMELEON_TAIL_CONTACT_SWEEPS = 6;
const CHAMELEON_TAIL_CONTACT_TOLERANCE = 1e-5;

export const CHAMELEON_LEG_NAMES = Object.freeze( [
	'front.L',
	'front.R',
	'hind.L',
	'hind.R',
] );

export const CHAMELEON_REQUIRED_JOINT_NAMES = Object.freeze( [
	'root',
	'pelvis',
	'chest',
	'neck',
	'head',
	'eye.L',
	'eye.R',
	'jaw',
	'tongue_base',
	'tongue_mid',
	'tongue_tip',
	'capture_socket',
	'mouth_socket',
	'upper_front.L',
	'lower_front.L',
	'foot_front.L',
	'upper_front.R',
	'lower_front.R',
	'foot_front.R',
	'upper_hind.L',
	'lower_hind.L',
	'foot_hind.L',
	'upper_hind.R',
	'lower_hind.R',
	'foot_hind.R',
	'tail.01',
	'tail.02',
	'tail.03',
	'tail.04',
	'tail.05',
	'tail.06',
	'tail.07',
	'tail.08',
	'tail.09',
	'foot_ik_front.L',
	'pole_front.L',
	'foot_ik_front.R',
	'pole_front.R',
	'foot_ik_hind.L',
	'pole_hind.L',
	'foot_ik_hind.R',
	'pole_hind.R',
] );

const LEG_SPECS = Object.freeze( [
	Object.freeze( {
		name: 'front.L',
		region: 'front',
		side: 'L',
		parent: 'chest',
		upper: 'upper_front.L',
		lower: 'lower_front.L',
		foot: 'foot_front.L',
		target: 'foot_ik_front.L',
		pole: 'pole_front.L',
	} ),
	Object.freeze( {
		name: 'front.R',
		region: 'front',
		side: 'R',
		parent: 'chest',
		upper: 'upper_front.R',
		lower: 'lower_front.R',
		foot: 'foot_front.R',
		target: 'foot_ik_front.R',
		pole: 'pole_front.R',
	} ),
	Object.freeze( {
		name: 'hind.L',
		region: 'hind',
		side: 'L',
		parent: 'pelvis',
		upper: 'upper_hind.L',
		lower: 'lower_hind.L',
		foot: 'foot_hind.L',
		target: 'foot_ik_hind.L',
		pole: 'pole_hind.L',
	} ),
	Object.freeze( {
		name: 'hind.R',
		region: 'hind',
		side: 'R',
		parent: 'pelvis',
		upper: 'upper_hind.R',
		lower: 'lower_hind.R',
		foot: 'foot_hind.R',
		target: 'foot_ik_hind.R',
		pole: 'pole_hind.R',
	} ),
] );

const EPSILON = 1e-7;
const IK_EPSILON = 1e-4;
const FOOT_SKIN_WEIGHT_THRESHOLD = 0.05;

function fail( message ) {

	throw new Error( `Chameleon rig: ${ message }` );

}

function clamp01( value ) {

	return value <= 0 ? 0 : value >= 1 ? 1 : value;

}

function finiteQuaternion( values, offset ) {

	return Number.isFinite( values[ offset ] )
		&& Number.isFinite( values[ offset + 1 ] )
		&& Number.isFinite( values[ offset + 2 ] )
		&& Number.isFinite( values[ offset + 3 ] );

}

function runtimeJointName( name ) {

	// GLTFLoader sanitises dots for animation bindings (`eye.L` -> `eyeL`).
	// Keep authored Blender names as the public contract while accepting the
	// deterministic runtime form on loaded and cloned scenes.
	return name.replaceAll( '.', '' );

}

function requireNamedBone( model, name, skeleton = null ) {

	const runtimeName = runtimeJointName( name );
	const bone = model.getObjectByName( name )
		|| model.getObjectByName( runtimeName )
		|| skeleton?.bones?.find( ( candidate ) =>
			candidate.name === name || candidate.name === runtimeName )
		|| null;
	if ( ! bone ) fail( `joint ${ name } absent` );
	if ( ! bone.isBone ) fail( `${ name } n'est pas un joint` );
	return bone;

}

function findCompatibleSkeleton( model ) {

	let compatible = null;
	model.traverse( ( object ) => {

		if ( compatible || ! object.isSkinnedMesh || ! object.skeleton ) return;
		const bones = object.skeleton.bones;
		if ( bones.length !== CHAMELEON_REQUIRED_JOINT_NAMES.length ) return;
		let valid = true;
		for ( let i = 0; i < CHAMELEON_REQUIRED_JOINT_NAMES.length; i ++ ) {

			const expected = CHAMELEON_REQUIRED_JOINT_NAMES[ i ];
			const runtimeExpected = runtimeJointName( expected );
			let found = false;
			for ( let j = 0; j < bones.length; j ++ ) {

				if ( bones[ j ].name === expected || bones[ j ].name === runtimeExpected ) {

					found = true;
					break;

				}

			}
			if ( ! found ) {

				valid = false;
				break;

			}

		}
		if ( valid ) compatible = object.skeleton;

	} );
	return compatible;

}

function attributeComponent( attribute, index, component ) {

	if ( component === 0 ) return attribute.getX( index );
	if ( component === 1 ) return attribute.getY( index );
	if ( component === 2 ) return attribute.getZ( index );
	return attribute.getW( index );

}

function measureFootSoleDepths( model, legs, inverseModelMatrix, restFoot, lowerLengths, output ) {

	const minimumY = new Float64Array( CHAMELEON_LEG_COUNT );
	const sampleCount = new Uint32Array( CHAMELEON_LEG_COUNT );
	const boneIndices = new Int32Array( CHAMELEON_LEG_COUNT );
	const influences = new Float64Array( CHAMELEON_LEG_COUNT );
	const vertex = new THREE.Vector3();
	minimumY.fill( Infinity );
	model.updateMatrixWorld( true );
	model.traverse( ( object ) => {

		if ( ! object.isSkinnedMesh || ! object.skeleton
			|| typeof object.applyBoneTransform !== 'function' ) return;
		const position = object.geometry?.getAttribute?.( 'position' );
		const skinIndex = object.geometry?.getAttribute?.( 'skinIndex' );
		const skinWeight = object.geometry?.getAttribute?.( 'skinWeight' );
		if ( ! position || ! skinIndex || ! skinWeight ) return;
		object.skeleton.update();
		let relevant = false;
		for ( let leg = 0; leg < CHAMELEON_LEG_COUNT; leg ++ ) {

			boneIndices[ leg ] = object.skeleton.bones.indexOf( legs[ leg ].foot );
			if ( boneIndices[ leg ] >= 0 ) relevant = true;

		}
		if ( ! relevant ) return;
		for ( let index = 0; index < position.count; index ++ ) {

			influences.fill( 0 );
			for ( let component = 0; component < 4; component ++ ) {

				const vertexBone = attributeComponent( skinIndex, index, component );
				const weight = attributeComponent( skinWeight, index, component );
				if ( weight <= 0 ) continue;
				for ( let leg = 0; leg < CHAMELEON_LEG_COUNT; leg ++ ) {

					if ( vertexBone === boneIndices[ leg ] ) influences[ leg ] += weight;

				}

			}
			let owned = false;
			for ( let leg = 0; leg < CHAMELEON_LEG_COUNT; leg ++ ) {

				if ( influences[ leg ] >= FOOT_SKIN_WEIGHT_THRESHOLD ) {

					owned = true;
					break;

				}

			}
			if ( ! owned ) continue;
			vertex.fromBufferAttribute( position, index );
			object.applyBoneTransform( index, vertex );
			vertex.applyMatrix4( object.matrixWorld ).applyMatrix4( inverseModelMatrix );
			for ( let leg = 0; leg < CHAMELEON_LEG_COUNT; leg ++ ) {

				if ( influences[ leg ] < FOOT_SKIN_WEIGHT_THRESHOLD ) continue;
				minimumY[ leg ] = Math.min( minimumY[ leg ], vertex.y );
				sampleCount[ leg ] ++;

			}

		}

	} );
	for ( let leg = 0; leg < CHAMELEON_LEG_COUNT; leg ++ ) {

		const measured = restFoot[ leg * 3 + 1 ] - minimumY[ leg ];
		output[ leg ] = sampleCount[ leg ] > 0
			&& Number.isFinite( measured ) && measured > EPSILON
			? measured
			: Math.max( 0.01, lowerLengths[ leg ] * 0.25 );

	}
	return output;

}
function readQuaternion( target, source, offset ) {

	target.set(
		source[ offset ],
		source[ offset + 1 ],
		source[ offset + 2 ],
		source[ offset + 3 ],
	).normalize();
	return target;

}

/**
 * Binds the exact 42-joint exported chameleon skeleton to fixed, typed gait
 * buffers. Call applySolution immediately after AnimationMixer.update().
 *
 * The procedure only overlays pelvis, chest, tail and limb joints. Root, neck,
 * head, eyes, jaw, mouth sockets and the complete tongue chain remain authored.
 */
export function createChameleonRigBinding( model, {
	requireSkin = true,
} = {} ) {

	if ( ! model?.getObjectByName || ! model?.updateMatrixWorld ) {

		throw new TypeError( 'createChameleonRigBinding requires an Object3D root' );

	}

	const skeleton = findCompatibleSkeleton( model );
	if ( requireSkin && ! skeleton ) fail( 'skin exact de 42 joints absent' );
	const jointsByName = Object.create( null );
	for ( let i = 0; i < CHAMELEON_REQUIRED_JOINT_NAMES.length; i ++ ) {

		const name = CHAMELEON_REQUIRED_JOINT_NAMES[ i ];
		jointsByName[ name ] = requireNamedBone( model, name, skeleton );

	}
	Object.freeze( jointsByName );
	const orderedJoints = new Array( CHAMELEON_REQUIRED_JOINT_NAMES.length );
	for ( let index = 0; index < orderedJoints.length; index ++ ) {

		orderedJoints[ index ] = jointsByName[ CHAMELEON_REQUIRED_JOINT_NAMES[ index ] ];

	}
	Object.freeze( orderedJoints );

	const root = jointsByName.root;
	const pelvis = jointsByName.pelvis;
	const chest = jointsByName.chest;
	const neck = jointsByName.neck;
	const head = jointsByName.head;
	const jaw = jointsByName.jaw;
	const tongueBones = Object.freeze( [
		jointsByName.tongue_base,
		jointsByName.tongue_mid,
		jointsByName.tongue_tip,
	] );
	const bodyBones = Object.freeze( [ pelvis, chest ] );
	const tailBones = new Array( CHAMELEON_TAIL_JOINT_COUNT );
	for ( let i = 0; i < CHAMELEON_TAIL_JOINT_COUNT; i ++ ) {

		tailBones[ i ] = jointsByName[ `tail.${ String( i + 1 ).padStart( 2, '0' ) }` ];
		if ( i > 0 && tailBones[ i ].parent !== tailBones[ i - 1 ] ) {

			fail( `hierarchie de queue rompue a tail.${ String( i + 1 ).padStart( 2, '0' ) }` );

		}

	}
	Object.freeze( tailBones );

	if ( pelvis.parent !== root ) fail( 'pelvis doit etre enfant de root' );
	if ( chest.parent !== pelvis ) fail( 'chest doit etre enfant de pelvis' );
	if ( neck.parent !== chest ) fail( 'neck doit etre enfant de chest' );
	if ( head.parent !== neck ) fail( 'head doit etre enfant de neck' );
	if ( jaw.parent !== head ) fail( 'jaw doit etre enfant de head' );
	if ( tongueBones[ 0 ].parent !== head
		|| tongueBones[ 1 ].parent !== tongueBones[ 0 ]
		|| tongueBones[ 2 ].parent !== tongueBones[ 1 ] ) {

		fail( 'hierarchie de langue invalide' );

	}
	if ( tailBones[ 0 ].parent !== pelvis ) fail( 'tail.01 doit etre enfant de pelvis' );

	model.updateMatrixWorld( true );

	const bindUpWorld = new THREE.Vector3( 0, 1, 0 );
	const modelWorldQuaternion = new THREE.Quaternion();
	model.getWorldQuaternion( modelWorldQuaternion );
	bindUpWorld.applyQuaternion( modelWorldQuaternion ).normalize();

	const measureHip = new THREE.Vector3();
	const measureKnee = new THREE.Vector3();
	const measureFoot = new THREE.Vector3();
	const measureTarget = new THREE.Vector3();
	const measurePole = new THREE.Vector3();
	const measureQuaternion = new THREE.Quaternion();
	const bodyNormalAxes = new Array( CHAMELEON_BODY_CORRECTION_COUNT );
	for ( let index = 0; index < CHAMELEON_BODY_CORRECTION_COUNT; index ++ ) {

		bodyBones[ index ].getWorldQuaternion( measureQuaternion );
		bodyNormalAxes[ index ] = bindUpWorld.clone()
			.applyQuaternion( measureQuaternion.invert() )
			.normalize();

	}
	Object.freeze( bodyNormalAxes );
	const inverseModelMatrix = model.matrixWorld.clone().invert();
	const restHip = new Float32Array( CHAMELEON_LEG_COUNT * 3 );
	const restFoot = new Float32Array( CHAMELEON_LEG_COUNT * 3 );
	const restPole = new Float32Array( CHAMELEON_LEG_COUNT * 3 );
	const upperLengths = new Float32Array( CHAMELEON_LEG_COUNT );
	const lowerLengths = new Float32Array( CHAMELEON_LEG_COUNT );
	const legs = new Array( CHAMELEON_LEG_COUNT );

	for ( let i = 0; i < LEG_SPECS.length; i ++ ) {

		const spec = LEG_SPECS[ i ];
		const upper = jointsByName[ spec.upper ];
		const lower = jointsByName[ spec.lower ];
		const foot = jointsByName[ spec.foot ];
		const target = jointsByName[ spec.target ];
		const pole = jointsByName[ spec.pole ];
		if ( upper.parent !== jointsByName[ spec.parent ] ) {

			fail( `${ spec.upper } doit etre enfant de ${ spec.parent }` );

		}
		if ( lower.parent !== upper ) fail( `${ spec.lower } doit etre enfant de ${ spec.upper }` );
		if ( foot.parent !== lower ) fail( `${ spec.foot } doit etre enfant de ${ spec.lower }` );

		upper.getWorldPosition( measureHip );
		lower.getWorldPosition( measureKnee );
		foot.getWorldPosition( measureFoot );
		target.getWorldPosition( measureTarget );
		pole.getWorldPosition( measurePole );
		foot.getWorldQuaternion( measureQuaternion );

		const restHipModel = measureHip.clone().applyMatrix4( inverseModelMatrix );
		const restKneeModel = measureKnee.clone().applyMatrix4( inverseModelMatrix );
		const restFootModel = measureFoot.clone().applyMatrix4( inverseModelMatrix );
		const restTargetModel = measureTarget.clone().applyMatrix4( inverseModelMatrix );
		const restPoleModel = measurePole.clone().applyMatrix4( inverseModelMatrix );
		const upperLength = restHipModel.distanceTo( restKneeModel );
		const lowerLength = restKneeModel.distanceTo( restFootModel );
		if ( upperLength <= EPSILON || lowerLength <= EPSILON ) {

			fail( `longueur de membre invalide pour ${ spec.name }` );

		}
		const soleNormalAxis = bindUpWorld.clone().applyQuaternion(
			measureQuaternion.clone().invert(),
		).normalize();
		const restPoleDirection = measurePole.clone().sub( measureHip ).normalize();
		const restFootOffset = measureTarget.clone().sub( measureFoot );
		const bufferOffset = i * 3;
		restHip[ bufferOffset ] = restHipModel.x;
		restHip[ bufferOffset + 1 ] = restHipModel.y;
		restHip[ bufferOffset + 2 ] = restHipModel.z;
		restFoot[ bufferOffset ] = restFootModel.x;
		restFoot[ bufferOffset + 1 ] = restFootModel.y;
		restFoot[ bufferOffset + 2 ] = restFootModel.z;
		restPole[ bufferOffset ] = restPoleModel.x;
		restPole[ bufferOffset + 1 ] = restPoleModel.y;
		restPole[ bufferOffset + 2 ] = restPoleModel.z;
		upperLengths[ i ] = upperLength;
		lowerLengths[ i ] = lowerLength;

		legs[ i ] = Object.freeze( {
			index: i,
			name: spec.name,
			region: spec.region,
			side: spec.side,
			upper,
			lower,
			foot,
			target,
			pole,
			upperAxis: lower.position.clone().normalize(),
			lowerAxis: foot.position.clone().normalize(),
			soleNormalAxis,
			restPoleDirection,
			restFootOffset,
			restHipModel,
			restFootModel,
			restTargetModel,
			restPoleModel,
			upperRestQuaternion: upper.quaternion.clone(),
			lowerRestQuaternion: lower.quaternion.clone(),
			footRestQuaternion: foot.quaternion.clone(),
			targetRestQuaternion: target.quaternion.clone(),
			poleRestQuaternion: pole.quaternion.clone(),
			metrics: Object.freeze( {
				upperLength,
				lowerLength,
				reach: upperLength + lowerLength,
				minReach: Math.abs( upperLength - lowerLength ),
				bindUpperWorldLength: measureHip.distanceTo( measureKnee ),
				bindLowerWorldLength: measureKnee.distanceTo( measureFoot ),
				targetOffset: restFootOffset.length(),
			} ),
		} );

	}
	Object.freeze( legs );
	const soleDepths = new Float32Array( CHAMELEON_LEG_COUNT );
	measureFootSoleDepths( model, legs, inverseModelMatrix, restFoot, lowerLengths, soleDepths );
	const restSole = restFoot.slice();
	for ( let leg = 0; leg < CHAMELEON_LEG_COUNT; leg ++ ) {

		restSole[ leg * 3 + 1 ] -= soleDepths[ leg ];

	}

	const tailRestQuaternions = new Float32Array( CHAMELEON_TAIL_JOINT_COUNT * 4 );
	const tailAuthoredContactQuaternions = new Float32Array(
		CHAMELEON_TAIL_JOINT_COUNT * 4,
	);
	for ( let i = 0; i < CHAMELEON_TAIL_JOINT_COUNT; i ++ ) {

		const offset = i * 4;
		const quaternion = tailBones[ i ].quaternion;
		tailRestQuaternions[ offset ] = quaternion.x;
		tailRestQuaternions[ offset + 1 ] = quaternion.y;
		tailRestQuaternions[ offset + 2 ] = quaternion.z;
		tailRestQuaternions[ offset + 3 ] = quaternion.w;

	}

	// Every object below is allocated once with the binding. applySolution only
	// mutates these temporaries and the already existing joint transforms.
	const hipWorld = new THREE.Vector3();
	const kneeWorld = new THREE.Vector3();
	const footWorld = new THREE.Vector3();
	const targetWorld = new THREE.Vector3();
	const poleWorld = new THREE.Vector3();
	const direction = new THREE.Vector3();
	const bendDirection = new THREE.Vector3();
	const currentDirection = new THREE.Vector3();
	const desiredDirection = new THREE.Vector3();
	const desiredKnee = new THREE.Vector3();
	const currentNormal = new THREE.Vector3();
	const desiredNormal = new THREE.Vector3();
	const currentWorldQuaternion = new THREE.Quaternion();
	const parentWorldQuaternion = new THREE.Quaternion();
	const worldDeltaQuaternion = new THREE.Quaternion();
	const desiredWorldQuaternion = new THREE.Quaternion();
	const desiredLocalQuaternion = new THREE.Quaternion();
	const animatedLocalQuaternion = new THREE.Quaternion();
	const deltaLocalQuaternion = new THREE.Quaternion();
	const modelNormalMatrix = new THREE.Matrix3();
	const decompositionPosition = new THREE.Vector3();
	const decompositionScale = new THREE.Vector3();
	const bodyAncestorChain = new Array( 16 );
	const bodyModelWorldQuaternion = new THREE.Quaternion();
	const bodyBoneWorldQuaternion = new THREE.Quaternion();
	const bodyCorrectedWorldQuaternion = new THREE.Quaternion();
	const bodyInverseWorldQuaternion = new THREE.Quaternion();
	const pelvisWorldDeltaQuaternion = new THREE.Quaternion();
	const chestWorldDeltaQuaternion = new THREE.Quaternion();
	const bodyClampedWorldDeltaQuaternion = new THREE.Quaternion();
	const bodyCurrentNormal = new THREE.Vector3();
	const bodyDesiredNormal = new THREE.Vector3();
	const tailPivotWorld = new THREE.Vector3();
	const tailProbeWorld = new THREE.Vector3();
	const tailAuthoredQuaternion = new THREE.Quaternion();
	const tailTotalDeltaQuaternion = new THREE.Quaternion();
	const tailClampedTotalDeltaQuaternion = new THREE.Quaternion();
	const tailStepLocalQuaternion = new THREE.Quaternion();

	function readWorldPosition( object, target ) {

		return target.setFromMatrixPosition( object.matrixWorld );

	}

	function readWorldQuaternion( object, target ) {

		object.matrixWorld.decompose( decompositionPosition, target, decompositionScale );
		return target;
	}
	function readHierarchyWorldQuaternion( bone, target ) {

		readWorldQuaternion( model, target );
		let count = 0;
		let object = bone;
		while ( object && object !== model ) {

			if ( count >= bodyAncestorChain.length ) fail( 'hierarchie du corps trop profonde' );
			bodyAncestorChain[ count ++ ] = object;
			object = object.parent;

		}
		if ( object !== model ) fail( `${ bone.name } est detache du modele` );
		for ( let index = count - 1; index >= 0; index -- ) {

			target.multiply( bodyAncestorChain[ index ].quaternion );

		}
		return target.normalize();

	}

	function writePackedQuaternion( target, offset, quaternion ) {

		target[ offset ] = quaternion.x;
		target[ offset + 1 ] = quaternion.y;
		target[ offset + 2 ] = quaternion.z;
		target[ offset + 3 ] = quaternion.w;

	}

	function writeIdentityQuaternion( target, offset ) {

		target[ offset ] = 0;
		target[ offset + 1 ] = 0;
		target[ offset + 2 ] = 0;
		target[ offset + 3 ] = 1;

	}

	function makeClampedSurfaceDelta(
		normalAxis,
		currentWorld,
		nx,
		ny,
		nz,
		maximumAngle,
		out,
	) {

		bodyDesiredNormal.set( nx, ny, nz );
		if ( bodyDesiredNormal.lengthSq() <= EPSILON
			|| ! Number.isFinite( nx + ny + nz ) ) return out.identity();
		bodyDesiredNormal.normalize();
		bodyCurrentNormal.copy( normalAxis ).applyQuaternion( currentWorld ).normalize();
		out.setFromUnitVectors( bodyCurrentNormal, bodyDesiredNormal ).normalize();
		const angle = 2 * Math.acos( Math.min( 1, Math.abs( out.w ) ) );
		if ( angle > maximumAngle && angle > EPSILON ) {

			bodyClampedWorldDeltaQuaternion.identity().slerp( out, maximumAngle / angle );
			out.copy( bodyClampedWorldDeltaQuaternion ).normalize();

		}
		return out;

	}

	function writeLocalDeltaFromWorld( currentWorld, worldDelta, target, offset ) {

		bodyInverseWorldQuaternion.copy( currentWorld ).invert();
		deltaLocalQuaternion.copy( bodyInverseWorldQuaternion )
			.multiply( worldDelta )
			.multiply( currentWorld )
			.normalize();
		writePackedQuaternion( target, offset, deltaLocalQuaternion );

	}

	/**
	 * Converts hind/front world normals into weak pelvis/chest local deltas.
	 * It composes the current local hierarchy directly, avoiding a second full
	 * skeleton traversal before applySolution updates the corrected pose.
	 */
	function writeBodySurfaceDeltas(
		solution,
		hindNX,
		hindNY,
		hindNZ,
		frontNX,
		frontNY,
		frontNZ,
		maximumAngle = 0.18,
		weight = 1,
	) {

		if ( ! solution?.bodyDeltas
			|| solution.bodyDeltas.length < CHAMELEON_BODY_CORRECTION_COUNT * 4
			|| ! solution.bodyWeights
			|| solution.bodyWeights.length < CHAMELEON_BODY_CORRECTION_COUNT ) {

			throw new TypeError( 'invalid chameleon body correction buffers' );

		}
		writeIdentityQuaternion( solution.bodyDeltas, 0 );
		writeIdentityQuaternion( solution.bodyDeltas, 4 );
		solution.bodyWeights[ 0 ] = 0;
		solution.bodyWeights[ 1 ] = 0;
		const correctionWeight = clamp01( Number.isFinite( weight ) ? weight : 0 );
		if ( correctionWeight <= 0 ) return solution;
		const angleLimit = Math.max( 0, Math.min(
			Math.PI / 3,
			Number.isFinite( maximumAngle ) ? maximumAngle : 0.18,
		) );
		if ( angleLimit <= 0 ) return solution;

		model.updateWorldMatrix( true, false );
		readHierarchyWorldQuaternion( pelvis, bodyBoneWorldQuaternion );
		makeClampedSurfaceDelta(
			bodyNormalAxes[ 0 ],
			bodyBoneWorldQuaternion,
			hindNX, hindNY, hindNZ,
			angleLimit,
			pelvisWorldDeltaQuaternion,
		);
		writeLocalDeltaFromWorld(
			bodyBoneWorldQuaternion,
			pelvisWorldDeltaQuaternion,
			solution.bodyDeltas,
			0,
		);
		solution.bodyWeights[ 0 ] = correctionWeight;

		readHierarchyWorldQuaternion( chest, bodyBoneWorldQuaternion );
		bodyCorrectedWorldQuaternion.copy( pelvisWorldDeltaQuaternion )
			.multiply( bodyBoneWorldQuaternion )
			.normalize();
		makeClampedSurfaceDelta(
			bodyNormalAxes[ 1 ],
			bodyCorrectedWorldQuaternion,
			frontNX, frontNY, frontNZ,
			angleLimit,
			chestWorldDeltaQuaternion,
		);
		writeLocalDeltaFromWorld(
			bodyCorrectedWorldQuaternion,
			chestWorldDeltaQuaternion,
			solution.bodyDeltas,
			4,
		);
		solution.bodyWeights[ 1 ] = correctionWeight;
		return solution;

	}


	/**
	 * Samples the three authored tail landmarks (tail.03/.06/.09) after the
	 * AnimationMixer pose. Updating tail.09 with parents refreshes only this
	 * nine-joint chain; it never traverses the model children.
	 */
	function writeLocalPose( target ) {

		if ( ! target || target.length < orderedJoints.length * 10 ) {

			throw new TypeError( 'invalid chameleon local pose buffer' );

		}
		for ( let index = 0; index < orderedJoints.length; index ++ ) {

			const offset = index * 10;
			const joint = orderedJoints[ index ];
			target[ offset ] = joint.position.x;
			target[ offset + 1 ] = joint.position.y;
			target[ offset + 2 ] = joint.position.z;
			target[ offset + 3 ] = joint.quaternion.x;
			target[ offset + 4 ] = joint.quaternion.y;
			target[ offset + 5 ] = joint.quaternion.z;
			target[ offset + 6 ] = joint.quaternion.w;
			target[ offset + 7 ] = joint.scale.x;
			target[ offset + 8 ] = joint.scale.y;
			target[ offset + 9 ] = joint.scale.z;

		}
		return target;

	}

	function applyLocalPose( source ) {

		if ( ! source || source.length < orderedJoints.length * 10 ) {

			throw new TypeError( 'invalid chameleon local pose buffer' );

		}
		for ( let index = 0; index < orderedJoints.length; index ++ ) {

			const offset = index * 10;
			const joint = orderedJoints[ index ];
			joint.position.set( source[ offset ], source[ offset + 1 ], source[ offset + 2 ] );
			joint.quaternion.set(
				source[ offset + 3 ], source[ offset + 4 ],
				source[ offset + 5 ], source[ offset + 6 ],
			).normalize();
			joint.scale.set( source[ offset + 7 ], source[ offset + 8 ], source[ offset + 9 ] );

		}
		model.updateMatrixWorld( true );
		return source;

	}

	function writeLegHipWorldPositions( target ) {

		if ( ! target || target.length < CHAMELEON_LEG_COUNT * 3 ) {

			throw new TypeError( 'invalid chameleon leg hip buffer' );

		}
		for ( let leg = 0; leg < CHAMELEON_LEG_COUNT; leg ++ ) {

			const offset = leg * 3;
			legs[ leg ].upper.updateWorldMatrix( true, false );
			readWorldPosition( legs[ leg ].upper, hipWorld );
			target[ offset ] = hipWorld.x;
			target[ offset + 1 ] = hipWorld.y;
			target[ offset + 2 ] = hipWorld.z;

		}
		return target;

	}

	function writeBodyProbeWorldPositions( target ) {

		if ( ! target || target.length < 9 ) {

			throw new TypeError( 'invalid chameleon body probe buffer' );

		}
		chest.updateWorldMatrix( true, false );
		readWorldPosition( pelvis, tailProbeWorld );
		target[ 0 ] = tailProbeWorld.x;
		target[ 1 ] = tailProbeWorld.y;
		target[ 2 ] = tailProbeWorld.z;
		readWorldPosition( chest, tailProbeWorld );
		target[ 6 ] = tailProbeWorld.x;
		target[ 7 ] = tailProbeWorld.y;
		target[ 8 ] = tailProbeWorld.z;
		target[ 3 ] = ( target[ 0 ] + target[ 6 ] ) * 0.5;
		target[ 4 ] = ( target[ 1 ] + target[ 7 ] ) * 0.5;
		target[ 5 ] = ( target[ 2 ] + target[ 8 ] ) * 0.5;
		return target;

	}

	function writeTailProbeWorldPositions( target ) {

		if ( ! target || target.length < CHAMELEON_TAIL_PROBE_BONE_INDICES.length * 3 ) {

			throw new TypeError( 'invalid chameleon tail probe buffer' );

		}
		tailBones[ CHAMELEON_TAIL_JOINT_COUNT - 1 ].updateWorldMatrix( true, false );
		for ( let probe = 0; probe < CHAMELEON_TAIL_PROBE_BONE_INDICES.length; probe ++ ) {

			const offset = probe * 3;
			readWorldPosition(
				tailBones[ CHAMELEON_TAIL_PROBE_BONE_INDICES[ probe ] ],
				tailProbeWorld,
			);
			target[ offset ] = tailProbeWorld.x;
			target[ offset + 1 ] = tailProbeWorld.y;
			target[ offset + 2 ] = tailProbeWorld.z;

		}
		return target;

	}

	/**
	 * Converts the three bounded surface corrections into local rotations on
	 * tail.02/.05/.08. The fixed buffers are written in place and are later
	 * composed post-mixer by applySolution (including attack protection).
	 */
	function writeTailContactDeltas(
		deltas,
		weights,
		probePositions,
		targetPositions,
		contactWeights,
		maximumAngle = 0.55,
		constraintNormals = null,
		constraintPlaneConstants = null,
		constraintProbeIndices = null,
		constraintCount = 0,
		clearance = 0,
	) {

		if ( ! deltas || deltas.length < CHAMELEON_TAIL_JOINT_COUNT * 4
			|| ! weights || weights.length < CHAMELEON_TAIL_JOINT_COUNT
			|| ! probePositions || probePositions.length < CHAMELEON_TAIL_PROBE_BONE_INDICES.length * 3
			|| ! targetPositions || targetPositions.length < CHAMELEON_TAIL_PROBE_BONE_INDICES.length * 3
			|| ! contactWeights || contactWeights.length < CHAMELEON_TAIL_PROBE_BONE_INDICES.length ) {

			throw new TypeError( 'invalid chameleon tail contact buffers' );

		}
		const requestedConstraintCount = Number.isInteger( constraintCount )
			? Math.max( 0, constraintCount )
			: 0;
		if ( requestedConstraintCount > 0 && (
			! constraintNormals || constraintNormals.length < requestedConstraintCount * 3
			|| ! constraintPlaneConstants
			|| constraintPlaneConstants.length < requestedConstraintCount
			|| ! constraintProbeIndices
			|| constraintProbeIndices.length < requestedConstraintCount
		) ) {

			throw new TypeError( 'invalid chameleon tail constraint buffers' );

		}
		const contactClearance = Number.isFinite( clearance ) ? Math.max( 0, clearance ) : 0;
		const angleLimit = Math.max( 0, Math.min(
			Math.PI / 3,
			Number.isFinite( maximumAngle ) ? maximumAngle : 0.55,
		) );
		for ( let joint = 0; joint < CHAMELEON_TAIL_JOINT_COUNT; joint ++ ) {

			const offset = joint * 4;
			const bone = tailBones[ joint ];
			tailAuthoredContactQuaternions[ offset ] = bone.quaternion.x;
			tailAuthoredContactQuaternions[ offset + 1 ] = bone.quaternion.y;
			tailAuthoredContactQuaternions[ offset + 2 ] = bone.quaternion.z;
			tailAuthoredContactQuaternions[ offset + 3 ] = bone.quaternion.w;
			writeIdentityQuaternion( deltas, offset );
			weights[ joint ] = 0;

		}
		if ( angleLimit <= 0 ) return deltas;

		tailBones[ CHAMELEON_TAIL_JOINT_COUNT - 1 ].updateWorldMatrix( true, false );
		for ( let probe = 0; probe < CHAMELEON_TAIL_PROBE_BONE_INDICES.length; probe ++ ) {

			const vectorOffset = probe * 3;
			let hasProbeConstraint = false;
			for ( let constraint = 0; constraint < requestedConstraintCount; constraint ++ ) {

				if ( constraintProbeIndices[ constraint ] === probe ) {

					hasProbeConstraint = true;
					break;

				}

			}
			const fallbackWeight = clamp01( contactWeights[ probe ] );
			if ( ! hasProbeConstraint && fallbackWeight <= 0 ) continue;
			let fallbackPlaneConstant = 0;
			if ( ! hasProbeConstraint ) {

				desiredNormal.set(
					targetPositions[ vectorOffset ] - probePositions[ vectorOffset ],
					targetPositions[ vectorOffset + 1 ] - probePositions[ vectorOffset + 1 ],
					targetPositions[ vectorOffset + 2 ] - probePositions[ vectorOffset + 2 ],
				);
				const requestedClearance = desiredNormal.length();
				if ( requestedClearance <= EPSILON ) continue;
				desiredNormal.multiplyScalar( 1 / requestedClearance );
				fallbackPlaneConstant = targetPositions[ vectorOffset ] * desiredNormal.x
					+ targetPositions[ vectorOffset + 1 ] * desiredNormal.y
					+ targetPositions[ vectorOffset + 2 ] * desiredNormal.z;

			}

			const probeBone = tailBones[ CHAMELEON_TAIL_PROBE_BONE_INDICES[ probe ] ];
			const blockStart = CHAMELEON_TAIL_BLOCK_START_BONE_INDICES[ probe ];
			const blockEnd = CHAMELEON_TAIL_CORRECTION_BONE_INDICES[ probe ];
			let blockSatisfied = false;
			for ( let sweep = 0;
				sweep < CHAMELEON_TAIL_CONTACT_SWEEPS && ! blockSatisfied;
				sweep ++ ) {

				for ( let joint = blockEnd; joint >= blockStart; joint -- ) {

					readWorldPosition( probeBone, tailProbeWorld );
					let worstResidual = CHAMELEON_TAIL_CONTACT_TOLERANCE;
					let worstConstraint = - 1;
					if ( hasProbeConstraint ) {

						for ( let constraint = 0; constraint < requestedConstraintCount; constraint ++ ) {

							if ( constraintProbeIndices[ constraint ] !== probe ) continue;
							const normalOffset = constraint * 3;
							const nx = constraintNormals[ normalOffset ];
							const ny = constraintNormals[ normalOffset + 1 ];
							const nz = constraintNormals[ normalOffset + 2 ];
							const residual = constraintPlaneConstants[ constraint ]
								+ contactClearance
								- ( tailProbeWorld.x * nx + tailProbeWorld.y * ny
									+ tailProbeWorld.z * nz );
							if ( residual > worstResidual ) {

								worstResidual = residual;
								worstConstraint = constraint;

							}

						}

					} else {

						const residual = fallbackPlaneConstant - tailProbeWorld.dot( desiredNormal );
						if ( residual > worstResidual ) worstConstraint = - 2;

					}
					if ( worstConstraint === - 1 ) {

						blockSatisfied = true;
						break;

					}
					let requiredPlaneProjection = fallbackPlaneConstant;
					if ( worstConstraint >= 0 ) {

						const normalOffset = worstConstraint * 3;
						desiredNormal.set(
							constraintNormals[ normalOffset ],
							constraintNormals[ normalOffset + 1 ],
							constraintNormals[ normalOffset + 2 ],
						);
						requiredPlaneProjection = constraintPlaneConstants[ worstConstraint ]
							+ contactClearance;

					}
					const correctionBone = tailBones[ joint ];
					readWorldPosition( correctionBone, tailPivotWorld );
					currentDirection.copy( tailProbeWorld ).sub( tailPivotWorld );
					const leverLength = currentDirection.length();
					if ( leverLength <= EPSILON ) continue;
					const currentProjection = currentDirection.dot( desiredNormal );
					const desiredProjection = Math.max(
						- leverLength,
						Math.min(
							leverLength,
							requiredPlaneProjection - tailPivotWorld.dot( desiredNormal )
								+ CHAMELEON_TAIL_CONTACT_TOLERANCE,
						),
					);
					bendDirection.copy( currentDirection )
						.addScaledVector( desiredNormal, - currentProjection );
					if ( bendDirection.lengthSq() <= EPSILON ) {

						if ( Math.abs( desiredNormal.y ) < 0.9 ) {

							bendDirection.set( - desiredNormal.z, 0, desiredNormal.x );

						} else bendDirection.set( 0, desiredNormal.z, - desiredNormal.y );

					}
					bendDirection.normalize();
					desiredDirection.copy( bendDirection ).multiplyScalar( Math.sqrt( Math.max(
						0,
						leverLength * leverLength - desiredProjection * desiredProjection,
					) ) ).addScaledVector( desiredNormal, desiredProjection ).normalize();
					currentDirection.multiplyScalar( 1 / leverLength );
					worldDeltaQuaternion.setFromUnitVectors(
						currentDirection,
						desiredDirection,
					).normalize();

					readWorldQuaternion( correctionBone, currentWorldQuaternion );
					tailStepLocalQuaternion.copy( currentWorldQuaternion ).invert()
						.multiply( worldDeltaQuaternion )
						.multiply( currentWorldQuaternion )
						.normalize();
					correctionBone.quaternion.multiply( tailStepLocalQuaternion ).normalize();
					const quaternionOffset = joint * 4;
					readQuaternion(
						tailAuthoredQuaternion,
						tailAuthoredContactQuaternions,
						quaternionOffset,
					);
					tailTotalDeltaQuaternion.copy( tailAuthoredQuaternion ).invert()
						.multiply( correctionBone.quaternion )
						.normalize();
					if ( tailTotalDeltaQuaternion.w < 0 ) tailTotalDeltaQuaternion.set(
						- tailTotalDeltaQuaternion.x,
						- tailTotalDeltaQuaternion.y,
						- tailTotalDeltaQuaternion.z,
						- tailTotalDeltaQuaternion.w,
					);
					const totalAngle = 2 * Math.acos( Math.min( 1, tailTotalDeltaQuaternion.w ) );
					if ( totalAngle > angleLimit && totalAngle > EPSILON ) {

						tailClampedTotalDeltaQuaternion.identity().slerp(
							tailTotalDeltaQuaternion,
							angleLimit / totalAngle,
						);
						correctionBone.quaternion.copy( tailAuthoredQuaternion )
							.multiply( tailClampedTotalDeltaQuaternion )
							.normalize();

					}
					correctionBone.updateWorldMatrix( false, true );

				}

			}

		}
		for ( let joint = 0; joint < CHAMELEON_TAIL_JOINT_COUNT; joint ++ ) {

			const offset = joint * 4;
			const bone = tailBones[ joint ];
			readQuaternion( tailAuthoredQuaternion, tailAuthoredContactQuaternions, offset );
			tailTotalDeltaQuaternion.copy( tailAuthoredQuaternion ).invert()
				.multiply( bone.quaternion )
				.normalize();
			if ( tailTotalDeltaQuaternion.w < 0 ) tailTotalDeltaQuaternion.set(
				- tailTotalDeltaQuaternion.x,
				- tailTotalDeltaQuaternion.y,
				- tailTotalDeltaQuaternion.z,
				- tailTotalDeltaQuaternion.w,
			);
			writePackedQuaternion( deltas, offset, tailTotalDeltaQuaternion );
			const totalAngle = 2 * Math.acos( Math.min( 1, tailTotalDeltaQuaternion.w ) );
			weights[ joint ] = totalAngle > EPSILON ? 1 : 0;
			bone.quaternion.copy( tailAuthoredQuaternion );

		}
		tailBones[ CHAMELEON_TAIL_JOINT_COUNT - 1 ].updateWorldMatrix( true, false );
		return deltas;

	}
	function applyLocalDelta( bone, source, offset, weight ) {

		if ( weight <= 0 || ! finiteQuaternion( source, offset ) ) return;
		animatedLocalQuaternion.copy( bone.quaternion );
		readQuaternion( deltaLocalQuaternion, source, offset );
		desiredLocalQuaternion.copy( animatedLocalQuaternion ).multiply( deltaLocalQuaternion );
		bone.quaternion.slerpQuaternions(
			animatedLocalQuaternion,
			desiredLocalQuaternion,
			weight,
		).normalize();

	}

	function solveLeg( chain, solution, index, globalWeight ) {

		const legWeight = clamp01( globalWeight * clamp01( solution.legWeights[ index ] ) );
		if ( legWeight <= 0 ) return;
		const vectorOffset = index * 3;
		const targetValues = solution.footTargets;
		if ( ! Number.isFinite( targetValues[ vectorOffset ] )
			|| ! Number.isFinite( targetValues[ vectorOffset + 1 ] )
			|| ! Number.isFinite( targetValues[ vectorOffset + 2 ] ) ) return;
		const normalValues = solution.footNormals;
		const normalWeight = clamp01(
			legWeight * clamp01( solution.footNormalWeights[ index ] ),
		);
		targetWorld.set(
			targetValues[ vectorOffset ],
			targetValues[ vectorOffset + 1 ],
			targetValues[ vectorOffset + 2 ],
		);
		readWorldQuaternion( chain.foot, currentWorldQuaternion );
		currentNormal.copy( chain.soleNormalAxis )
			.applyQuaternion( currentWorldQuaternion )
			.normalize();
		desiredNormal.copy( currentNormal );
		if ( Number.isFinite( normalValues[ vectorOffset ] )
			&& Number.isFinite( normalValues[ vectorOffset + 1 ] )
			&& Number.isFinite( normalValues[ vectorOffset + 2 ] ) ) {

			desiredNormal.set(
				normalValues[ vectorOffset ],
				normalValues[ vectorOffset + 1 ],
				normalValues[ vectorOffset + 2 ],
			);
			if ( desiredNormal.lengthSq() <= EPSILON ) desiredNormal.copy( currentNormal );
			else desiredNormal.normalize();

		}
		const soleScale = Math.hypot(
			chain.soleNormalAxis.x * decompositionScale.x,
			chain.soleNormalAxis.y * decompositionScale.y,
			chain.soleNormalAxis.z * decompositionScale.z,
		) || 1;
		// `footTargets` are physical sole contacts. IK solves the bone origin.
		targetWorld.addScaledVector( desiredNormal, soleDepths[ index ] * soleScale );
		readWorldPosition( chain.upper, hipWorld );
		readWorldPosition( chain.lower, kneeWorld );
		readWorldPosition( chain.foot, footWorld );
		let upperLength = hipWorld.distanceTo( kneeWorld );
		let lowerLength = kneeWorld.distanceTo( footWorld );
		if ( upperLength <= EPSILON || lowerLength <= EPSILON ) return;

		direction.copy( targetWorld ).sub( hipWorld );
		let distance = direction.length();
		if ( distance <= EPSILON ) return;
		direction.multiplyScalar( 1 / distance );
		const maximumReach = Math.max( IK_EPSILON, upperLength + lowerLength - IK_EPSILON );
		const minimumReach = Math.abs( upperLength - lowerLength ) + IK_EPSILON;
		if ( distance > maximumReach ) {

			distance = maximumReach;
			targetWorld.copy( direction ).multiplyScalar( distance ).add( hipWorld );

		} else if ( distance < minimumReach ) {

			distance = minimumReach;
			targetWorld.copy( direction ).multiplyScalar( distance ).add( hipWorld );

		}

		const poleValues = solution.poleTargets;
		if ( Number.isFinite( poleValues[ vectorOffset ] )
			&& Number.isFinite( poleValues[ vectorOffset + 1 ] )
			&& Number.isFinite( poleValues[ vectorOffset + 2 ] ) ) {

			poleWorld.set(
				poleValues[ vectorOffset ],
				poleValues[ vectorOffset + 1 ],
				poleValues[ vectorOffset + 2 ],
			);

		} else {

			readWorldPosition( chain.pole, poleWorld );

		}

		bendDirection.copy( poleWorld ).sub( hipWorld );
		bendDirection.addScaledVector( direction, - bendDirection.dot( direction ) );
		if ( bendDirection.lengthSq() <= EPSILON ) {

			bendDirection.copy( kneeWorld ).sub( hipWorld );
			bendDirection.addScaledVector( direction, - bendDirection.dot( direction ) );

		}
		if ( bendDirection.lengthSq() <= EPSILON ) {

			if ( Math.abs( direction.y ) < 0.9 ) {

				bendDirection.set( - direction.z, 0, direction.x );

			} else {

				bendDirection.set( 0, direction.z, - direction.y );

			}

		}
		bendDirection.normalize();
		const along = (
			upperLength * upperLength
			- lowerLength * lowerLength
			+ distance * distance
		) / ( 2 * distance );
		const height = Math.sqrt( Math.max( 0, upperLength * upperLength - along * along ) );
		desiredKnee.copy( direction ).multiplyScalar( along )
			.addScaledVector( bendDirection, height )
			.add( hipWorld );

		currentDirection.copy( kneeWorld ).sub( hipWorld ).normalize();
		desiredDirection.copy( desiredKnee ).sub( hipWorld ).normalize();
		worldDeltaQuaternion.setFromUnitVectors( currentDirection, desiredDirection );
		readWorldQuaternion( chain.upper, currentWorldQuaternion );
		desiredWorldQuaternion.copy( worldDeltaQuaternion ).multiply( currentWorldQuaternion );
		readWorldQuaternion( chain.upper.parent, parentWorldQuaternion ).invert();
		desiredLocalQuaternion.copy( parentWorldQuaternion ).multiply( desiredWorldQuaternion );
		animatedLocalQuaternion.copy( chain.upper.quaternion );
		chain.upper.quaternion.slerpQuaternions(
			animatedLocalQuaternion,
			desiredLocalQuaternion,
			legWeight,
		).normalize();
		chain.upper.updateWorldMatrix( false, true );

		readWorldPosition( chain.lower, kneeWorld );
		readWorldPosition( chain.foot, footWorld );
		currentDirection.copy( footWorld ).sub( kneeWorld ).normalize();
		desiredDirection.copy( targetWorld ).sub( kneeWorld );
		if ( desiredDirection.lengthSq() > EPSILON ) {

			desiredDirection.normalize();
			worldDeltaQuaternion.setFromUnitVectors( currentDirection, desiredDirection );
			readWorldQuaternion( chain.lower, currentWorldQuaternion );
			desiredWorldQuaternion.copy( worldDeltaQuaternion ).multiply( currentWorldQuaternion );
			readWorldQuaternion( chain.lower.parent, parentWorldQuaternion ).invert();
			desiredLocalQuaternion.copy( parentWorldQuaternion ).multiply( desiredWorldQuaternion );
			animatedLocalQuaternion.copy( chain.lower.quaternion );
			chain.lower.quaternion.slerpQuaternions(
				animatedLocalQuaternion,
				desiredLocalQuaternion,
				legWeight,
			).normalize();
			chain.lower.updateWorldMatrix( false, true );

		}


		if ( normalWeight > 0
			&& Number.isFinite( normalValues[ vectorOffset ] )
			&& Number.isFinite( normalValues[ vectorOffset + 1 ] )
			&& Number.isFinite( normalValues[ vectorOffset + 2 ] ) ) {

			desiredNormal.set(
				normalValues[ vectorOffset ],
				normalValues[ vectorOffset + 1 ],
				normalValues[ vectorOffset + 2 ],
			);
			if ( desiredNormal.lengthSq() > EPSILON ) {

				desiredNormal.normalize();
				readWorldQuaternion( chain.foot, currentWorldQuaternion );
				currentNormal.copy( chain.soleNormalAxis )
					.applyQuaternion( currentWorldQuaternion )
					.normalize();
				worldDeltaQuaternion.setFromUnitVectors( currentNormal, desiredNormal );
				desiredWorldQuaternion.copy( worldDeltaQuaternion )
					.multiply( currentWorldQuaternion );
				readWorldQuaternion( chain.foot.parent, parentWorldQuaternion ).invert();
				desiredLocalQuaternion.copy( parentWorldQuaternion )
					.multiply( desiredWorldQuaternion );
				animatedLocalQuaternion.copy( chain.foot.quaternion );
				chain.foot.quaternion.slerpQuaternions(
					animatedLocalQuaternion,
					desiredLocalQuaternion,
					normalWeight,
				).normalize();
				chain.foot.updateWorldMatrix( false, true );

			}

		}

	}

	function createSolution() {

		model.updateMatrixWorld( true );
		const footTargets = new Float32Array( CHAMELEON_LEG_COUNT * 3 );
		const footNormals = new Float32Array( CHAMELEON_LEG_COUNT * 3 );
		const poleTargets = new Float32Array( CHAMELEON_LEG_COUNT * 3 );
		const legWeights = new Float32Array( CHAMELEON_LEG_COUNT );
		const footNormalWeights = new Float32Array( CHAMELEON_LEG_COUNT );
		const bodyDeltas = new Float32Array( CHAMELEON_BODY_CORRECTION_COUNT * 4 );
		const bodyWeights = new Float32Array( CHAMELEON_BODY_CORRECTION_COUNT );
		const tailDeltas = new Float32Array( CHAMELEON_TAIL_JOINT_COUNT * 4 );
		const tailWeights = new Float32Array( CHAMELEON_TAIL_JOINT_COUNT );

		for ( let i = 0; i < CHAMELEON_LEG_COUNT; i ++ ) {

			const vectorOffset = i * 3;
			legs[ i ].foot.getWorldPosition( footWorld );
			legs[ i ].pole.getWorldPosition( poleWorld );
			legs[ i ].foot.getWorldQuaternion( currentWorldQuaternion );
			currentNormal.copy( legs[ i ].soleNormalAxis )
				.applyQuaternion( currentWorldQuaternion )
				.normalize();
			legs[ i ].foot.getWorldScale( decompositionScale );
			const soleScale = Math.hypot(
				legs[ i ].soleNormalAxis.x * decompositionScale.x,
				legs[ i ].soleNormalAxis.y * decompositionScale.y,
				legs[ i ].soleNormalAxis.z * decompositionScale.z,
			) || 1;
			footWorld.addScaledVector( currentNormal, - soleDepths[ i ] * soleScale );
			footTargets[ vectorOffset ] = footWorld.x;
			footTargets[ vectorOffset + 1 ] = footWorld.y;
			footTargets[ vectorOffset + 2 ] = footWorld.z;
			footNormals[ vectorOffset ] = currentNormal.x;
			footNormals[ vectorOffset + 1 ] = currentNormal.y;
			footNormals[ vectorOffset + 2 ] = currentNormal.z;
			poleTargets[ vectorOffset ] = poleWorld.x;
			poleTargets[ vectorOffset + 1 ] = poleWorld.y;
			poleTargets[ vectorOffset + 2 ] = poleWorld.z;
			legWeights[ i ] = 1;
			footNormalWeights[ i ] = 1;

		}
		for ( let i = 0; i < CHAMELEON_BODY_CORRECTION_COUNT; i ++ ) {

			bodyDeltas[ i * 4 + 3 ] = 1;

		}
		for ( let i = 0; i < CHAMELEON_TAIL_JOINT_COUNT; i ++ ) {

			tailDeltas[ i * 4 + 3 ] = 1;

		}

		return Object.seal( {
			footTargets,
			footNormals,
			poleTargets,
			legWeights,
			footNormalWeights,
			bodyDeltas,
			bodyWeights,
			tailDeltas,
			tailWeights,
			attackProtection: 1,
		} );

	}

	function validateSolution( solution ) {

		if ( ! solution
			|| solution.footTargets?.length < CHAMELEON_LEG_COUNT * 3
			|| solution.footNormals?.length < CHAMELEON_LEG_COUNT * 3
			|| solution.poleTargets?.length < CHAMELEON_LEG_COUNT * 3
			|| solution.legWeights?.length < CHAMELEON_LEG_COUNT
			|| solution.footNormalWeights?.length < CHAMELEON_LEG_COUNT
			|| solution.bodyDeltas?.length < CHAMELEON_BODY_CORRECTION_COUNT * 4
			|| solution.bodyWeights?.length < CHAMELEON_BODY_CORRECTION_COUNT
			|| solution.tailDeltas?.length < CHAMELEON_TAIL_JOINT_COUNT * 4
			|| solution.tailWeights?.length < CHAMELEON_TAIL_JOINT_COUNT ) {

			throw new TypeError( 'invalid chameleon rig solution buffers' );

		}
		return solution;

	}

	function applyBodySolution( solution, proceduralWeight = 1, attackBlend = 0 ) {

		validateSolution( solution );
		const protection = Number.isFinite( solution.attackProtection )
			? clamp01( solution.attackProtection )
			: 1;
		const contactWeight = clamp01( proceduralWeight );
		const bodyWeight = contactWeight
			* ( 1 - clamp01( attackBlend ) * protection );
		if ( contactWeight <= 0 ) return 0;

		for ( let i = 0; i < CHAMELEON_BODY_CORRECTION_COUNT; i ++ ) {

			applyLocalDelta(
				bodyBones[ i ],
				solution.bodyDeltas,
				i * 4,
				bodyWeight * clamp01( solution.bodyWeights[ i ] ),
			);

		}
		return contactWeight;

	}

	function applyTailSolution( solution, proceduralWeight = 1 ) {

		validateSolution( solution );
		const contactWeight = clamp01( proceduralWeight );
		if ( contactWeight <= 0 ) return 0;
		for ( let i = 0; i < CHAMELEON_TAIL_JOINT_COUNT; i ++ ) {

			applyLocalDelta(
				tailBones[ i ],
				solution.tailDeltas,
				i * 4,
				contactWeight * clamp01( solution.tailWeights[ i ] ),
			);

		}
		model.updateMatrixWorld( true );
		return contactWeight;

	}

	function applyLegSolution( solution, proceduralWeight = 1 ) {

		validateSolution( solution );
		const contactWeight = clamp01( proceduralWeight );
		if ( contactWeight <= 0 ) return 0;
		// A cached body-plane solve may translate the model after the first IK pass.
		// Refresh matrices once, then re-anchor only the four legs to their immutable
		// world-space stance targets without composing the tail correction twice.
		model.updateMatrixWorld( true );
		for ( let i = 0; i < CHAMELEON_LEG_COUNT; i ++ ) {

			solveLeg( legs[ i ], solution, i, contactWeight );

		}
		return contactWeight;

	}

	function applyTailAndLegSolution( solution, proceduralWeight = 1 ) {

		const contactWeight = applyTailSolution( solution, proceduralWeight );
		if ( contactWeight <= 0 ) return 0;
		for ( let i = 0; i < CHAMELEON_LEG_COUNT; i ++ ) {

			solveLeg( legs[ i ], solution, i, contactWeight );

		}
		return contactWeight;

	}

	function applySolution( solution, proceduralWeight = 1, attackBlend = 0 ) {

		const contactWeight = applyBodySolution( solution, proceduralWeight, attackBlend );
		if ( contactWeight <= 0 ) return 0;
		return applyTailAndLegSolution( solution, contactWeight );

	}

	function createModelLocalSolution() {

		const solution = createSolution();
		solution.footTargets.set( restSole );
		solution.poleTargets.set( restPole );
		for ( let i = 0; i < CHAMELEON_LEG_COUNT; i ++ ) {

			const offset = i * 3;
			solution.footNormals[ offset ] = 0;
			solution.footNormals[ offset + 1 ] = 1;
			solution.footNormals[ offset + 2 ] = 0;

		}
		return solution;

	}

	const modelLocalWorldSolution = createSolution();

	/**
	 * Converts the four model-local contact targets into the private world-space
	 * scratch buffers. Both source and destination buffers keep stable identity.
	 */
	function writeWorldSolutionFromModelLocal(
		localSolution,
		worldSolution = modelLocalWorldSolution,
	) {

		if ( ! localSolution
			|| localSolution.footTargets?.length < CHAMELEON_LEG_COUNT * 3
			|| localSolution.footNormals?.length < CHAMELEON_LEG_COUNT * 3
			|| localSolution.poleTargets?.length < CHAMELEON_LEG_COUNT * 3 ) {

			throw new TypeError( 'invalid model-local chameleon rig solution buffers' );

		}
		model.updateWorldMatrix( true, false );
		modelNormalMatrix.getNormalMatrix( model.matrixWorld );
		for ( let i = 0; i < CHAMELEON_LEG_COUNT; i ++ ) {

			const offset = i * 3;
			targetWorld.set(
				localSolution.footTargets[ offset ],
				localSolution.footTargets[ offset + 1 ],
				localSolution.footTargets[ offset + 2 ],
			).applyMatrix4( model.matrixWorld );
			worldSolution.footTargets[ offset ] = targetWorld.x;
			worldSolution.footTargets[ offset + 1 ] = targetWorld.y;
			worldSolution.footTargets[ offset + 2 ] = targetWorld.z;

			desiredNormal.set(
				localSolution.footNormals[ offset ],
				localSolution.footNormals[ offset + 1 ],
				localSolution.footNormals[ offset + 2 ],
			).applyNormalMatrix( modelNormalMatrix );
			worldSolution.footNormals[ offset ] = desiredNormal.x;
			worldSolution.footNormals[ offset + 1 ] = desiredNormal.y;
			worldSolution.footNormals[ offset + 2 ] = desiredNormal.z;

			poleWorld.set(
				localSolution.poleTargets[ offset ],
				localSolution.poleTargets[ offset + 1 ],
				localSolution.poleTargets[ offset + 2 ],
			).applyMatrix4( model.matrixWorld );
			worldSolution.poleTargets[ offset ] = poleWorld.x;
			worldSolution.poleTargets[ offset + 1 ] = poleWorld.y;
			worldSolution.poleTargets[ offset + 2 ] = poleWorld.z;
			worldSolution.legWeights[ i ] = localSolution.legWeights[ i ];
			worldSolution.footNormalWeights[ i ] = localSolution.footNormalWeights[ i ];

		}
		worldSolution.bodyDeltas.set( localSolution.bodyDeltas );
		worldSolution.bodyWeights.set( localSolution.bodyWeights );
		worldSolution.tailDeltas.set( localSolution.tailDeltas );
		worldSolution.tailWeights.set( localSolution.tailWeights );
		worldSolution.attackProtection = localSolution.attackProtection;
		return worldSolution;

	}

	function applyModelLocalSolution( solution, proceduralWeight = 1, attackBlend = 0 ) {

		writeWorldSolutionFromModelLocal( solution, modelLocalWorldSolution );
		return applySolution( modelLocalWorldSolution, proceduralWeight, attackBlend );

	}

	function writeTailLocalPose( target ) {

		if ( ! target || target.length < CHAMELEON_TAIL_JOINT_COUNT * 4 ) {

			throw new TypeError( 'tail pose buffer too short' );

		}
		for ( let index = 0; index < CHAMELEON_TAIL_JOINT_COUNT; index ++ ) {

			const offset = index * 4;
			const quaternion = tailBones[ index ].quaternion;
			target[ offset ] = quaternion.x;
			target[ offset + 1 ] = quaternion.y;
			target[ offset + 2 ] = quaternion.z;
			target[ offset + 3 ] = quaternion.w;

		}
		return target;

	}

	function applyTailLocalPose( source ) {

		if ( ! source || source.length < CHAMELEON_TAIL_JOINT_COUNT * 4 ) {

			throw new TypeError( 'tail pose buffer too short' );

		}
		for ( let index = 0; index < CHAMELEON_TAIL_JOINT_COUNT; index ++ ) {

			const offset = index * 4;
			if ( ! finiteQuaternion( source, offset ) ) {

				throw new TypeError( 'non-finite tail pose' );

			}
			tailBones[ index ].quaternion.set(
				source[ offset ], source[ offset + 1 ], source[ offset + 2 ], source[ offset + 3 ],
			).normalize();

		}
		tailBones[ CHAMELEON_TAIL_JOINT_COUNT - 1 ].updateWorldMatrix( true, false );
		return source;

	}
	return Object.freeze( {
		model,
		skeleton,
		root,
		pelvis,
		chest,
		neck,
		head,
		jaw,
		tongueBones,
		bodyBones,
		bodyNormalAxes,
		CHAMELEON_TAIL_PROBE_BONE_INDICES,
		CHAMELEON_TAIL_CORRECTION_BONE_INDICES,
		tailBones,
		tailRestQuaternions,
		legs,
		// Fixed model-local buffers, ordered like CHAMELEON_LEG_NAMES.
		restHip,
		restFoot,
		restSole,
		soleDepths,
		restPole,
		upperLengths,
		lowerLengths,
		jointsByName,
		orderedJoints,
		createSolution,
		createModelLocalSolution,
		writeWorldSolutionFromModelLocal,
		writeBodySurfaceDeltas,
		applyBodySolution,
		applyTailSolution,
		applyLegSolution,
		applyTailAndLegSolution,
		applySolution,
		writeLocalPose,
		applyLocalPose,
		writeLegHipWorldPositions,
		writeBodyProbeWorldPositions,
		writeTailProbeWorldPositions,
		writeTailContactDeltas,
		writeTailLocalPose,
		applyTailLocalPose,
		applyModelLocalSolution,
	} );

}
