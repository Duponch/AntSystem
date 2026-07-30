import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

import {
	CHAMELEON_LEG_COUNT,
	CHAMELEON_LEG_NAMES,
	CHAMELEON_REQUIRED_JOINT_NAMES,
	CHAMELEON_TAIL_CORRECTION_BONE_INDICES,
	CHAMELEON_TAIL_JOINT_COUNT,
	createChameleonRigBinding,
} from '../src/chameleon-rig.js';

const GLB_MAGIC = 0x46546C67;
const GLB_JSON_CHUNK = 0x4E4F534A;

async function readSource( relativeUrl ) {

	return readFile( new URL( relativeUrl, import.meta.url ), 'utf8' );

}

async function parseGlbScene( relativeUrl ) {

	const bytes = await readFile( new URL( relativeUrl, import.meta.url ) );
	const arrayBuffer = bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength );
	return new Promise( ( resolve, reject ) => {

		new GLTFLoader().parse( arrayBuffer, '', ( gltf ) => resolve( gltf.scene ), reject );

	} );

}

async function readGlbJson( relativeUrl ) {

	const bytes = await readFile( new URL( relativeUrl, import.meta.url ) );
	assert.equal( bytes.readUInt32LE( 0 ), GLB_MAGIC );
	let offset = 12;
	while ( offset < bytes.length ) {

		const length = bytes.readUInt32LE( offset );
		const type = bytes.readUInt32LE( offset + 4 );
		offset += 8;
		if ( type === GLB_JSON_CHUNK ) {

			return JSON.parse(
				bytes.toString( 'utf8', offset, offset + length ).replace( /[\0\s]+$/u, '' ),
			);

		}
		offset += length;

	}
	throw new Error( 'GLB JSON chunk absent' );

}

function parentNames( json ) {

	const parents = new Map();
	for ( let index = 0; index < json.nodes.length; index ++ ) {

		for ( const child of json.nodes[ index ].children || [] ) {

			parents.set( child, json.nodes[ index ].name );

		}

	}
	return parents;

}

function bone( name, x = 0, y = 0, z = 0 ) {

	const result = new THREE.Bone();
	result.name = name;
	result.position.set( x, y, z );
	return result;

}

function createSyntheticRig() {

	const model = new THREE.Group();
	const rig = new THREE.Group();
	rig.name = 'ChameleonImportedRig';
	model.add( rig );

	const root = bone( 'root' );
	const pelvis = bone( 'pelvis', 0, 0.4, 0 );
	const chest = bone( 'chest', - 0.8, 0, 0 );
	const neck = bone( 'neck', - 0.55, 0, 0 );
	const head = bone( 'head', - 0.35, 0, 0 );
	const eyeL = bone( 'eye.L' );
	const eyeR = bone( 'eye.R' );
	const jaw = bone( 'jaw' );
	const tongueBase = bone( 'tongue_base' );
	const tongueMid = bone( 'tongue_mid', - 0.2, 0, 0 );
	const tongueTip = bone( 'tongue_tip', - 0.2, 0, 0 );
	const captureSocket = bone( 'capture_socket', - 0.1, 0, 0 );
	const mouthSocket = bone( 'mouth_socket' );
	rig.add( root );
	root.add( pelvis );
	pelvis.add( chest );
	chest.add( neck );
	neck.add( head );
	head.add( eyeL, eyeR, jaw, tongueBase, mouthSocket );
	tongueBase.add( tongueMid );
	tongueMid.add( tongueTip );
	tongueTip.add( captureSocket );

	const joints = [
		root, pelvis, chest, neck, head, eyeL, eyeR, jaw,
		tongueBase, tongueMid, tongueTip, captureSocket, mouthSocket,
	];
	const legSpecs = [
		[ 'front.L', chest, - 0.3, 0.42 ],
		[ 'front.R', chest, - 0.3, - 0.42 ],
		[ 'hind.L', pelvis, 0.3, 0.42 ],
		[ 'hind.R', pelvis, 0.3, - 0.42 ],
	];
	for ( const [ name, parent, x, z ] of legSpecs ) {

		const [ region, side ] = name.split( '.' );
		const upper = bone( `upper_${ region }.${ side }`, x, 0, z );
		const lower = bone( `lower_${ region }.${ side }`, 0, - 0.65, 0 );
		const foot = bone( `foot_${ region }.${ side }`, 0, - 0.58, 0 );
		const target = bone( `foot_ik_${ region }.${ side }`, x, - 1.23, z );
		const pole = bone( `pole_${ region }.${ side }`, x - 0.65, - 0.3, z );
		parent.add( upper );
		upper.add( lower );
		lower.add( foot );
		rig.add( target, pole );
		joints.push( upper, lower, foot, target, pole );

	}

	let tailParent = pelvis;
	for ( let index = 1; index <= CHAMELEON_TAIL_JOINT_COUNT; index ++ ) {

		const tail = bone( `tail.${ String( index ).padStart( 2, '0' ) }`, 0.25, 0, 0 );
		tailParent.add( tail );
		tailParent = tail;
		joints.push( tail );

	}
	assert.equal( joints.length, 42 );
	model.updateMatrixWorld( true );
	const skeleton = new THREE.Skeleton( joints );
	const skinnedMesh = new THREE.SkinnedMesh();
	skinnedMesh.name = 'SyntheticChameleonMesh';
	skinnedMesh.bind( skeleton );
	rig.add( skinnedMesh );
	model.updateMatrixWorld( true );
	return { model, joints, jaw, tongueBones: [ tongueBase, tongueMid, tongueTip ] };

}

function writeFootSoleWorld( binding, index, output = new THREE.Vector3() ) {

	const leg = binding.legs[ index ];
	const worldQuaternion = new THREE.Quaternion();
	const worldScale = new THREE.Vector3();
	const worldNormal = new THREE.Vector3();
	leg.foot.getWorldPosition( output );
	leg.foot.getWorldQuaternion( worldQuaternion );
	leg.foot.getWorldScale( worldScale );
	worldNormal.copy( leg.soleNormalAxis ).applyQuaternion( worldQuaternion ).normalize();
	const soleScale = Math.hypot(
		leg.soleNormalAxis.x * worldScale.x,
		leg.soleNormalAxis.y * worldScale.y,
		leg.soleNormalAxis.z * worldScale.z,
	) || 1;
	return output.addScaledVector( worldNormal, - binding.soleDepths[ index ] * soleScale );

}

test( 'CHAMELEON-RIG-001 shipped GLB has the exact 42-joint runtime hierarchy', async () => {

	const json = await readGlbJson( '../public/Chameleon.glb' );
	const skin = json.skins.find( ( candidate ) => candidate.joints.length === 42 );
	assert.ok( skin, 'the runtime skin must contain exactly 42 joints' );
	const jointNames = skin.joints.map( ( index ) => json.nodes[ index ].name );
	assert.deepEqual(
		new Set( jointNames ),
		new Set( CHAMELEON_REQUIRED_JOINT_NAMES ),
	);

	const byName = new Map( json.nodes.map( ( node, index ) => [ node.name, index ] ) );
	const parents = parentNames( json );
	for ( const name of CHAMELEON_LEG_NAMES ) {

		const [ region, side ] = name.split( '.' );
		assert.equal( parents.get( byName.get( `lower_${ region }.${ side }` ) ), `upper_${ region }.${ side }` );
		assert.equal( parents.get( byName.get( `foot_${ region }.${ side }` ) ), `lower_${ region }.${ side }` );
		assert.ok( jointNames.includes( `foot_ik_${ region }.${ side }` ) );
		assert.ok( jointNames.includes( `pole_${ region }.${ side }` ) );

	}
	for ( let index = 2; index <= CHAMELEON_TAIL_JOINT_COUNT; index ++ ) {

		const child = `tail.${ String( index ).padStart( 2, '0' ) }`;
		const parent = `tail.${ String( index - 1 ).padStart( 2, '0' ) }`;
		assert.equal( parents.get( byName.get( child ) ), parent );

	}

} );

test( 'CHAMELEON-RIG-002 binding discovers ordered chains, axes, rest poses and metrics', () => {

	const { model } = createSyntheticRig();
	const binding = createChameleonRigBinding( model );

	assert.equal( binding.legs.length, CHAMELEON_LEG_COUNT );
	assert.deepEqual( binding.legs.map( ( leg ) => leg.name ), CHAMELEON_LEG_NAMES );
	assert.equal( binding.tailBones.length, CHAMELEON_TAIL_JOINT_COUNT );
	assert.equal( binding.tongueBones.length, 3 );
	assert.equal( binding.restHip.length, CHAMELEON_LEG_COUNT * 3 );
	assert.equal( binding.restFoot.length, CHAMELEON_LEG_COUNT * 3 );
	assert.equal( binding.restSole.length, CHAMELEON_LEG_COUNT * 3 );
	assert.equal( binding.soleDepths.length, CHAMELEON_LEG_COUNT );
	assert.ok( Array.from( binding.soleDepths ).every( ( depth ) => depth > 0 ) );
	assert.equal( binding.restPole.length, CHAMELEON_LEG_COUNT * 3 );
	assert.equal( binding.upperLengths.length, CHAMELEON_LEG_COUNT );
	assert.equal( binding.lowerLengths.length, CHAMELEON_LEG_COUNT );
	for ( const leg of binding.legs ) {

		assert.ok( leg.upper.isBone && leg.lower.isBone && leg.foot.isBone );
		assert.ok( leg.target.isBone && leg.pole.isBone );
		assert.ok( Math.abs( leg.upperAxis.length() - 1 ) < 1e-6 );
		assert.ok( Math.abs( leg.lowerAxis.length() - 1 ) < 1e-6 );
		assert.ok( Math.abs( leg.soleNormalAxis.length() - 1 ) < 1e-6 );
		assert.equal( leg.metrics.upperLength, 0.65 );
		assert.equal( leg.metrics.lowerLength, 0.58 );
		assert.ok( Math.abs( leg.metrics.reach - 1.23 ) < 1e-12 );
		assert.ok( Math.abs( leg.upperRestQuaternion.length() - 1 ) < 1e-6 );
		assert.ok( Math.abs( leg.lowerRestQuaternion.length() - 1 ) < 1e-6 );
		assert.ok( Math.abs( leg.footRestQuaternion.length() - 1 ) < 1e-6 );

	}

} );

test( 'CHAMELEON-RIG-003 skin-owned detached decorative joints remain bindable', () => {

	const { model, joints } = createSyntheticRig();
	const eyeL = joints.find( ( joint ) => joint.name === 'eye.L' );
	const eyeR = joints.find( ( joint ) => joint.name === 'eye.R' );
	const skinnedMesh = model.getObjectByName( 'SyntheticChameleonMesh' );
	assert.ok( skinnedMesh.skeleton.bones.includes( eyeL ) );
	assert.ok( skinnedMesh.skeleton.bones.includes( eyeR ) );

	eyeL.removeFromParent();
	eyeR.removeFromParent();
	assert.equal( model.getObjectByName( 'eye.L' ), undefined );
	assert.equal( model.getObjectByName( 'eye.R' ), undefined );

	const binding = createChameleonRigBinding( model );
	assert.strictEqual( binding.jointsByName[ 'eye.L' ], eyeL );
	assert.strictEqual( binding.jointsByName[ 'eye.R' ], eyeR );
	assert.strictEqual( binding.skeleton, skinnedMesh.skeleton );
	assert.equal( binding.legs.length, CHAMELEON_LEG_COUNT );

} );

test( 'CHAMELEON-RIG-004 model-local contacts convert into stable world buffers', () => {

	const { model } = createSyntheticRig();
	model.position.set( 3, 4, - 2 );
	model.rotation.set( 0.1, - 0.4, 0.2 );
	model.scale.setScalar( 1.7 );
	model.updateMatrixWorld( true );
	const binding = createChameleonRigBinding( model );
	const localSolution = binding.createModelLocalSolution();
	const worldSolution = binding.writeWorldSolutionFromModelLocal( localSolution );
	const expected = new THREE.Vector3(
		localSolution.footTargets[ 0 ],
		localSolution.footTargets[ 1 ],
		localSolution.footTargets[ 2 ],
	).applyMatrix4( model.matrixWorld );

	assert.ok( Math.abs( worldSolution.footTargets[ 0 ] - expected.x ) < 1e-5 );
	assert.ok( Math.abs( worldSolution.footTargets[ 1 ] - expected.y ) < 1e-5 );
	assert.ok( Math.abs( worldSolution.footTargets[ 2 ] - expected.z ) < 1e-5 );
	assert.strictEqual(
		binding.writeWorldSolutionFromModelLocal( localSolution ),
		worldSolution,
	);
	assert.equal( binding.applyModelLocalSolution( localSolution, 0, 0 ), 0 );

} );

test( 'CHAMELEON-RIG-005 fixed solution buffers drive IK without touching attack anatomy', () => {

	const { model, jaw, tongueBones } = createSyntheticRig();
	const binding = createChameleonRigBinding( model );
	const solution = binding.createSolution();
	const frontLeft = binding.legs[ 0 ];
	const before = new THREE.Vector3();
	const after = new THREE.Vector3();
	const jawPose = new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 1, 0, 0 ), 0.31 );
	const tonguePose = new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 0, 0, 1 ), - 0.22 );
	jaw.quaternion.copy( jawPose );
	tongueBones[ 1 ].quaternion.copy( tonguePose );

	model.updateMatrixWorld( true );
	writeFootSoleWorld( binding, 0, before );
	solution.footTargets[ 0 ] = before.x - 0.18;
	solution.footTargets[ 1 ] = before.y + 0.12;
	solution.footTargets[ 2 ] = before.z + 0.08;
	const target = new THREE.Vector3(
		solution.footTargets[ 0 ],
		solution.footTargets[ 1 ],
		solution.footTargets[ 2 ],
	);
	const distanceBefore = before.distanceTo( target );
	const bufferIdentities = [
		solution.footTargets,
		solution.footNormals,
		solution.poleTargets,
		solution.bodyDeltas,
		solution.tailDeltas,
	];

	assert.equal( binding.applySolution( solution, 1, 0 ), 1 );
	model.updateMatrixWorld( true );
	writeFootSoleWorld( binding, 0, after );
	assert.ok( after.distanceTo( target ) < distanceBefore * 0.05 );
	assert.ok( jaw.quaternion.angleTo( jawPose ) < 1e-8 );
	assert.ok( tongueBones[ 1 ].quaternion.angleTo( tonguePose ) < 1e-8 );
	assert.deepEqual(
		[
			solution.footTargets,
			solution.footNormals,
			solution.poleTargets,
			solution.bodyDeltas,
			solution.tailDeltas,
		],
		bufferIdentities,
	);

} );

test( 'CHAMELEON-RIG-006 attack protection preserves the authored torso while feet and tail contacts remain authoritative', () => {

	const { model } = createSyntheticRig();
	const binding = createChameleonRigBinding( model );
	const solution = binding.createSolution();
	const frontLeft = binding.legs[ 0 ];
	const animatedUpperPose = new THREE.Quaternion().setFromAxisAngle(
		new THREE.Vector3( 0, 0, 1 ),
		0.27,
	);
	frontLeft.upper.quaternion.copy( animatedUpperPose );
	model.updateMatrixWorld( true );
	const footBefore = new THREE.Vector3();
	writeFootSoleWorld( binding, 0, footBefore );
	solution.footTargets[ 0 ] = footBefore.x - 0.22;
	solution.footTargets[ 1 ] = footBefore.y + 0.08;
	solution.footTargets[ 2 ] = footBefore.z + 0.04;
	const footTarget = new THREE.Vector3(
		solution.footTargets[ 0 ], solution.footTargets[ 1 ], solution.footTargets[ 2 ],
	);
	const distanceBefore = footBefore.distanceTo( footTarget );
	const tailBone = binding.tailBones[ 1 ];
	const tailBefore = tailBone.quaternion.clone();
	solution.tailDeltas[ 1 * 4 + 2 ] = Math.sin( 0.1 );
	solution.tailDeltas[ 1 * 4 + 3 ] = Math.cos( 0.1 );
	solution.tailWeights[ 1 ] = 1;
	solution.bodyWeights[ 0 ] = 1;
	solution.bodyDeltas[ 2 ] = Math.sin( 0.2 );
	solution.bodyDeltas[ 3 ] = Math.cos( 0.2 );

	assert.equal( binding.applySolution( solution, 1, 1 ), 1 );
	model.updateMatrixWorld( true );
	const footAfter = new THREE.Vector3();
	writeFootSoleWorld( binding, 0, footAfter );
	assert.ok( footAfter.distanceTo( footTarget ) < distanceBefore * 0.05 );
	assert.ok( tailBone.quaternion.angleTo( tailBefore ) > 0.1 );
	assert.ok( binding.pelvis.quaternion.angleTo( new THREE.Quaternion() ) < 1e-8 );

} );

test( 'CHAMELEON-RIG-007 procedural application is a post-mixer allocation-free contract', async () => {

	const source = await readSource( '../src/chameleon-rig.js' );
	const applyStart = source.indexOf( '\n\tfunction applySolution(' );
	const applyEnd = source.indexOf( '\n\treturn Object.freeze( {', applyStart );
	assert.ok( applyStart >= 0 && applyEnd > applyStart );
	const hotPath = source.slice( applyStart, applyEnd );

	assert.doesNotMatch( hotPath, /\bnew\s+(?:THREE\.|Float32Array|Array|Map|Set)/u );
	assert.doesNotMatch( hotPath, /\.clone\(\)|\.map\(|\.filter\(|\.slice\(/u );
	assert.doesNotMatch( source, /Raycaster|intersectObject|intersectObjects/u );
	assert.match( source, /Call applySolution immediately after AnimationMixer\.update/u );
	assert.match( source, /function applyModelLocalSolution/u );
	assert.match( source, /restHip,[\s\S]*?restFoot,[\s\S]*?upperLengths,[\s\S]*?lowerLengths/u );
	assert.match( source, /attackBlend/u );
	assert.match( source, /jaw,[\s\S]*?tongueBones/u );

} );

test( 'CHAMELEON-RIG-008 sanitised GLTF runtime names bind all 42 cloned joints', () => {

	const { model, joints } = createSyntheticRig();
	for ( const joint of joints ) joint.name = joint.name.replaceAll( '.', '' );
	const runtimeModel = cloneSkeleton( model );
	const runtimeMesh = runtimeModel.getObjectByName( 'SyntheticChameleonMesh' );
	assert.ok( runtimeMesh?.skeleton );
	assert.equal( runtimeMesh.skeleton.bones.length, CHAMELEON_REQUIRED_JOINT_NAMES.length );

	const binding = createChameleonRigBinding( runtimeModel );
	assert.strictEqual( binding.skeleton, runtimeMesh.skeleton );
	for ( const authoredName of CHAMELEON_REQUIRED_JOINT_NAMES ) {

		const runtimeName = authoredName.replaceAll( '.', '' );
		const resolved = binding.jointsByName[ authoredName ];
		assert.ok( resolved?.isBone, `${ authoredName } was not resolved` );
		assert.equal( resolved.name, runtimeName );
		assert.ok(
			runtimeMesh.skeleton.bones.includes( resolved ),
			`${ authoredName } did not resolve from the cloned 42-joint skin`,
		);

	}
	assert.deepEqual( binding.legs.map( ( leg ) => leg.name ), CHAMELEON_LEG_NAMES );
	assert.equal( binding.tailBones.length, CHAMELEON_TAIL_JOINT_COUNT );
	assert.equal( binding.tongueBones.length, 3 );
	assert.equal( binding.createSolution().footTargets.length, CHAMELEON_LEG_COUNT * 3 );

} );

test( 'CHAMELEON-RIG-009 pelvis and chest follow independent hind/front planes in fixed buffers', () => {

	const { model } = createSyntheticRig();
	const binding = createChameleonRigBinding( model );
	const solution = binding.createSolution();
	solution.legWeights.fill( 0 );
	solution.footNormalWeights.fill( 0 );
	const bodyDeltaBuffer = solution.bodyDeltas;
	const bodyWeightBuffer = solution.bodyWeights;
	const worldQuaternion = new THREE.Quaternion();
	const actualHind = new THREE.Vector3();
	const actualFront = new THREE.Vector3();
	const desiredHind = new THREE.Vector3( 0, 1, 0 )
		.applyAxisAngle( new THREE.Vector3( 0, 0, 1 ), 0.08 );
	const desiredFront = new THREE.Vector3( 0, 1, 0 )
		.applyAxisAngle( new THREE.Vector3( 0, 0, 1 ), - 0.06 );

	assert.strictEqual(
		binding.writeBodySurfaceDeltas(
			solution,
			desiredHind.x, desiredHind.y, desiredHind.z,
			desiredFront.x, desiredFront.y, desiredFront.z,
			0.16,
			1,
		),
		solution,
	);
	assert.strictEqual( solution.bodyDeltas, bodyDeltaBuffer );
	assert.strictEqual( solution.bodyWeights, bodyWeightBuffer );
	assert.deepEqual( binding.bodyBones, [ binding.pelvis, binding.chest ] );
	assert.deepEqual( Array.from( solution.bodyWeights ), [ 1, 1 ] );
	assert.ok( Array.from( solution.bodyDeltas ).every( Number.isFinite ) );

	binding.applySolution( solution, 1, 0 );
	model.updateMatrixWorld( true );
	binding.pelvis.getWorldQuaternion( worldQuaternion );
	actualHind.copy( binding.bodyNormalAxes[ 0 ] ).applyQuaternion( worldQuaternion ).normalize();
	binding.chest.getWorldQuaternion( worldQuaternion );
	actualFront.copy( binding.bodyNormalAxes[ 1 ] ).applyQuaternion( worldQuaternion ).normalize();
	assert.ok( actualHind.angleTo( desiredHind ) < 1e-5 );
	assert.ok( actualFront.angleTo( desiredFront ) < 1e-5 );

} );

test( 'CHAMELEON-RIG-010 phased body/contact IK hot paths stay allocation-free with one full traversal', async () => {

	const [ source, integration ] = await Promise.all( [
		readSource( '../src/chameleon-rig.js' ),
		readSource( '../src/chameleons.js' ),
	] );
	const bodyStart = source.indexOf( '\n\tfunction writeBodySurfaceDeltas(' );
	const bodyEnd = source.indexOf( '\n\tfunction writeLocalPose(', bodyStart );
	const bodyHotPath = source.slice( bodyStart, bodyEnd );
	assert.doesNotMatch( bodyHotPath, /\bnew\s+(?:THREE\.|Float32Array|Array|Map|Set)/u );
	assert.doesNotMatch( bodyHotPath, /\.clone\(\)|\.map\(|\.filter\(|\.slice\(/u );
	assert.doesNotMatch( bodyHotPath, /updateMatrixWorld\(\s*true/u );

	const tailContactStart = source.indexOf( '\n\tfunction writeTailContactDeltas(' );
	const tailContactEnd = source.indexOf( '\n\tfunction applyLocalDelta(', tailContactStart );
	const tailContactHotPath = source.slice( tailContactStart, tailContactEnd );
	assert.doesNotMatch(
		tailContactHotPath,
		/\bnew\s+(?:THREE\.|Float32Array|Array|Map|Set)|\.clone\(\)|\.map\(|\.filter\(|\.slice\(/u,
	);

	const solveStart = source.indexOf( '\n\tfunction solveLeg(' );
	const solveEnd = source.indexOf( '\n\tfunction createSolution(', solveStart );
	const solveHotPath = source.slice( solveStart, solveEnd );
	assert.doesNotMatch( solveHotPath, /getWorldPosition|getWorldQuaternion|\.updateMatrix\s*\(/u );

	const tailApplyStart = source.indexOf( '\n\tfunction applyTailSolution(' );
	const tailApplyEnd = source.indexOf( '\n\tfunction applyLegSolution(', tailApplyStart );
	const tailApplyHotPath = source.slice( tailApplyStart, tailApplyEnd );
	assert.equal(
		( tailApplyHotPath.match( /model\.updateMatrixWorld\(\s*true\s*\)/gu ) || [] ).length,
		1,
	);
	assert.doesNotMatch( tailApplyHotPath, /\bnew\s+(?:THREE\.|Float32Array|Array|Map|Set)/u );
	const legApplyStart = tailApplyEnd;
	const legApplyEnd = source.indexOf( '\n\tfunction applyTailAndLegSolution(', legApplyStart );
	const legApplyHotPath = source.slice( legApplyStart, legApplyEnd );
	assert.equal(
		( legApplyHotPath.match( /model\.updateMatrixWorld\(\s*true\s*\)/gu ) || [] ).length,
		1,
	);
	assert.doesNotMatch( legApplyHotPath, /\bnew\s+(?:THREE\.|Float32Array|Array|Map|Set)/u );

	const prepareStart = integration.indexOf( '\n\tfunction prepareProceduralRig(' );
	const prepareEnd = integration.indexOf( '\n\tfunction applyProceduralBody(', prepareStart );
	const prepare = integration.slice( prepareStart, prepareEnd );
	const bodyOrder = prepare.indexOf( 'writeBodySurfaceDeltas(' );
	const footOrder = prepare.indexOf( 'rigSolution.footTargets.set(' );
	assert.ok( bodyOrder >= 0 && footOrder > bodyOrder );
	assert.match( integration, /function applyProceduralBody[\s\S]*?applyBodySolution\s*\(/u );
	assert.match( integration, /function applyProceduralTailAndLegs[\s\S]*?applyTailAndLegSolution\s*\(/u );
	assert.doesNotMatch( integration, /instance\.model\.updateMatrixWorld\(\s*true\s*\)/u );
	assert.match( integration, /instance\.model\.updateWorldMatrix\(\s*true,\s*false\s*\)/u );

	const { model } = createSyntheticRig();
	const binding = createChameleonRigBinding( model );
	const solution = binding.createSolution();
	let fullRootTraversals = 0;
	const updateMatrixWorld = model.updateMatrixWorld;
	model.updateMatrixWorld = function countedFullTraversal( force ) {

		fullRootTraversals ++;
		return updateMatrixWorld.call( this, force );

	};
	binding.writeBodySurfaceDeltas( solution, 0, 1, 0, 0.05, 0.9987, 0, 0.16, 0.36 );
	binding.applySolution( solution, 1, 0 );
	assert.equal( fullRootTraversals, 1 );

} );

test( 'CHAMELEON-RIG-011 safe snapshots restore all 42 joints position, rotation and scale in place', () => {

	const { model } = createSyntheticRig();
	const binding = createChameleonRigBinding( model );
	const snapshot = new Float32Array( binding.orderedJoints.length * 10 );
	for ( let index = 0; index < binding.orderedJoints.length; index ++ ) {

		const joint = binding.orderedJoints[ index ];
		joint.position.add( new THREE.Vector3( index * 0.001, - index * 0.0007, index * 0.0003 ) );
		joint.quaternion.setFromAxisAngle(
			new THREE.Vector3( 0.3, 0.8, 0.2 ).normalize(),
			index * 0.004,
		);
		joint.scale.set( 1 + index * 0.0002, 1 - index * 0.0001, 1 + index * 0.0003 );

	}
	assert.strictEqual( binding.writeLocalPose( snapshot ), snapshot );
	for ( const joint of binding.orderedJoints ) {

		joint.position.set( 99, - 99, 42 );
		joint.quaternion.identity();
		joint.scale.setScalar( 3 );

	}
	assert.strictEqual( binding.applyLocalPose( snapshot ), snapshot );
	for ( let index = 0; index < binding.orderedJoints.length; index ++ ) {

		const joint = binding.orderedJoints[ index ];
		const offset = index * 10;
		assert.ok( Math.abs( joint.position.x - snapshot[ offset ] ) < 1e-6 );
		assert.ok( Math.abs( joint.position.y - snapshot[ offset + 1 ] ) < 1e-6 );
		assert.ok( Math.abs( joint.position.z - snapshot[ offset + 2 ] ) < 1e-6 );
		assert.ok( Math.abs( joint.quaternion.x - snapshot[ offset + 3 ] ) < 1e-6 );
		assert.ok( Math.abs( joint.quaternion.y - snapshot[ offset + 4 ] ) < 1e-6 );
		assert.ok( Math.abs( joint.quaternion.z - snapshot[ offset + 5 ] ) < 1e-6 );
		assert.ok( Math.abs( joint.quaternion.w - snapshot[ offset + 6 ] ) < 1e-6 );
		assert.ok( Math.abs( joint.scale.x - snapshot[ offset + 7 ] ) < 1e-6 );
		assert.ok( Math.abs( joint.scale.y - snapshot[ offset + 8 ] ) < 1e-6 );
		assert.ok( Math.abs( joint.scale.z - snapshot[ offset + 9 ] ) < 1e-6 );

	}

} );

test( 'CHAMELEON-RIG-012 world-space IK remains accurate at minimum and maximum UI scales', () => {

	for ( const scale of [ 0.4, 2.5 ] ) {

		const { model } = createSyntheticRig();
		model.scale.setScalar( scale );
		model.updateMatrixWorld( true );
		const binding = createChameleonRigBinding( model );
		const solution = binding.createSolution();
		solution.legWeights.fill( 0 );
		solution.footNormalWeights.fill( 0 );
		solution.legWeights[ 0 ] = 1;
		solution.footNormalWeights[ 0 ] = 1;
		const foot = binding.legs[ 0 ].foot;
		const before = new THREE.Vector3();
		writeFootSoleWorld( binding, 0, before );
		const target = before.clone().add( new THREE.Vector3(
			- 0.08 * scale, 0.05 * scale, 0.035 * scale,
		) );
		solution.footTargets.set( [ target.x, target.y, target.z ], 0 );
		const beforeDistance = before.distanceTo( target );
		binding.applySolution( solution, 1, 0 );
		model.updateMatrixWorld( true );
		const after = new THREE.Vector3();
		writeFootSoleWorld( binding, 0, after );
		assert.ok( after.distanceTo( target ) < beforeDistance * 0.06, `scale ${ scale }` );

	}

} );

test( 'CHAMELEON-RIG-013 sequential tail contacts survive an already-applied body correction', () => {

	const { model } = createSyntheticRig();
	const binding = createChameleonRigBinding( model );
	const solution = binding.createSolution();
	solution.legWeights.fill( 0 );
	solution.footNormalWeights.fill( 0 );
	solution.bodyWeights[ 0 ] = 1;
	solution.bodyDeltas[ 2 ] = Math.sin( 0.075 );
	solution.bodyDeltas[ 3 ] = Math.cos( 0.075 );
	binding.applyBodySolution( solution, 1, 0 );
	model.updateMatrixWorld( true );
	const probesBefore = new Float32Array( 9 );
	const targets = new Float32Array( 9 );
	const probesAfter = new Float32Array( 9 );
	const contactWeights = new Float32Array( [ 1, 1, 1 ] );
	binding.writeTailProbeWorldPositions( probesBefore );
	targets.set( probesBefore );
	const clearances = [ 0.045, 0.02, 0.015 ];
	for ( let probe = 0; probe < 3; probe ++ ) targets[ probe * 3 + 1 ] += clearances[ probe ];
	binding.writeTailContactDeltas(
		solution.tailDeltas,
		solution.tailWeights,
		probesBefore,
		targets,
		contactWeights,
		0.4,
	);
	assert.ok(
		Array.from( solution.tailWeights ).some( ( weight ) => weight > 0 ),
		'at least one bounded joint must carry the unilateral correction',
	);
	binding.applyTailAndLegSolution( solution, 1 );
	binding.writeTailProbeWorldPositions( probesAfter );
	for ( let probe = 0; probe < 3; probe ++ ) {

		const offset = probe * 3;
		assert.ok(
			probesAfter[ offset + 1 ] >= targets[ offset + 1 ] - 1e-4,
			`tail probe ${ probe } missed its exact clearance plane`,
		);

	}

} );

test( 'CHAMELEON-RIG-014 a neutral solution preserves all four physical sole contacts', () => {

	const { model } = createSyntheticRig();
	const binding = createChameleonRigBinding( model );
	const solution = binding.createSolution();
	const before = new Float32Array( CHAMELEON_LEG_COUNT * 3 );
	const contact = new THREE.Vector3();
	for ( let index = 0; index < CHAMELEON_LEG_COUNT; index ++ ) {

		writeFootSoleWorld( binding, index, contact );
		contact.toArray( before, index * 3 );

	}
	binding.applySolution( solution, 1, 0 );
	model.updateMatrixWorld( true );
	for ( let index = 0; index < CHAMELEON_LEG_COUNT; index ++ ) {

		writeFootSoleWorld( binding, index, contact );
		const offset = index * 3;
		const drift = contact.distanceTo( new THREE.Vector3(
			before[ offset ], before[ offset + 1 ], before[ offset + 2 ],
		) );
		assert.ok( drift < 2e-4, `${ binding.legs[ index ].name }: ${ drift }` );

	}

} );

test( 'CHAMELEON-RIG-015 tail-only pose snapshots restore nine joints without touching the torso', () => {

	const { model } = createSyntheticRig();
	const binding = createChameleonRigBinding( model );
	const snapshot = new Float32Array( CHAMELEON_TAIL_JOINT_COUNT * 4 );
	const restored = new Float32Array( snapshot.length );
	const axis = new THREE.Vector3( 0.2, 0.9, - 0.3 ).normalize();
	const chestPose = new THREE.Quaternion().setFromAxisAngle( axis, 0.37 );
	binding.chest.quaternion.copy( chestPose );
	for ( let index = 0; index < binding.tailBones.length; index ++ ) {

		binding.tailBones[ index ].quaternion.setFromAxisAngle( axis, 0.03 * ( index + 1 ) );

	}
	assert.strictEqual( binding.writeTailLocalPose( snapshot ), snapshot );
	for ( const tailBone of binding.tailBones ) tailBone.quaternion.identity();
	assert.strictEqual( binding.applyTailLocalPose( snapshot ), snapshot );
	assert.ok( binding.chest.quaternion.angleTo( chestPose ) < 1e-8 );
	binding.writeTailLocalPose( restored );
	for ( let index = 0; index < snapshot.length; index ++ ) {

		assert.ok( Math.abs( snapshot[ index ] - restored[ index ] ) < 1e-6 );

	}

} );

test( 'CHAMELEON-RIG-016 shipped skin calibrates reachable sole contacts for all four feet', async () => {

	const model = await parseGlbScene( '../public/Chameleon.glb' );
	model.updateMatrixWorld( true );
	const bounds = new THREE.Box3().setFromObject( model );
	const size = new THREE.Vector3();
	bounds.getSize( size );
	const scale = 3.1 / size.x;
	model.scale.setScalar( scale );
	model.position.set(
		- ( bounds.min.x + bounds.max.x ) * 0.5 * scale,
		- bounds.min.y * scale,
		- ( bounds.min.z + bounds.max.z ) * 0.5 * scale,
	);
	model.updateMatrixWorld( true );
	const binding = createChameleonRigBinding( model );
	const expectedDepths = [ 0.45561, 0.65567, 0.17971, 0.42169 ];
	for ( let index = 0; index < CHAMELEON_LEG_COUNT; index ++ ) {

		assert.ok(
			Math.abs( binding.soleDepths[ index ] - expectedDepths[ index ] ) < 0.03,
			`${ binding.legs[ index ].name } sole depth`,
		);

	}

	const solution = binding.createSolution();
	solution.poleTargets.fill( NaN );
	solution.legWeights.fill( 1 );
	solution.footNormalWeights.fill( 1 );
	let centreContactWouldBeUnreachable = 0;
	const hip = new THREE.Vector3();
	const contact = new THREE.Vector3();
	const boneTarget = new THREE.Vector3();
	for ( let index = 0; index < CHAMELEON_LEG_COUNT; index ++ ) {

		const offset = index * 3;
		contact.set( solution.footTargets[ offset ], 0.024, solution.footTargets[ offset + 2 ] );
		solution.footTargets[ offset + 1 ] = contact.y;
		solution.footNormals[ offset ] = 0;
		solution.footNormals[ offset + 1 ] = 1;
		solution.footNormals[ offset + 2 ] = 0;
		binding.legs[ index ].upper.getWorldPosition( hip );
		const reach = ( binding.upperLengths[ index ] + binding.lowerLengths[ index ] ) * scale;
		if ( hip.distanceTo( contact ) > reach ) centreContactWouldBeUnreachable ++;
		boneTarget.copy( contact ).addScaledVector(
			new THREE.Vector3( 0, 1, 0 ),
			binding.soleDepths[ index ] * scale,
		);
		assert.ok( hip.distanceTo( boneTarget ) <= reach + 1e-5, binding.legs[ index ].name );

	}
	assert.ok( centreContactWouldBeUnreachable >= 3 );
	binding.applySolution( solution, 1, 0 );
	model.updateMatrixWorld( true );
	const actual = new THREE.Vector3();
	for ( let index = 0; index < CHAMELEON_LEG_COUNT; index ++ ) {

		const offset = index * 3;
		writeFootSoleWorld( binding, index, actual );
		contact.set(
			solution.footTargets[ offset ],
			solution.footTargets[ offset + 1 ],
			solution.footTargets[ offset + 2 ],
		);
		assert.ok( actual.distanceTo( contact ) < 2e-5, binding.legs[ index ].name );

	}

} );
test( 'CHAMELEON-RIG-017 shipped tail solves reachable half-spaces with bounded multi-joint blocks', async () => {

	const model = await parseGlbScene( '../public/Chameleon.glb' );
	model.updateMatrixWorld( true );
	const bounds = new THREE.Box3().setFromObject( model );
	const size = new THREE.Vector3();
	bounds.getSize( size );
	const scale = 3.1 / size.x;
	model.scale.setScalar( scale );
	model.position.set(
		- ( bounds.min.x + bounds.max.x ) * 0.5 * scale,
		- bounds.min.y * scale,
		- ( bounds.min.z + bounds.max.z ) * 0.5 * scale,
	);
	model.updateMatrixWorld( true );
	const binding = createChameleonRigBinding( model );
	const solution = binding.createSolution();
	solution.legWeights.fill( 0 );
	solution.footNormalWeights.fill( 0 );
	const probes = new Float32Array( 9 );
	const targets = new Float32Array( 9 );
	const after = new Float32Array( 9 );
	const contactWeights = new Float32Array( [ 1, 1, 1 ] );
	const constraintNormals = new Float32Array( [
		0, 1, 0,
		0, 1, 0,
		0, 1, 0,
	] );
	const constraintPlaneConstants = new Float32Array( 3 );
	const constraintProbeIndices = new Uint8Array( [ 0, 1, 2 ] );
	const clearances = [ 0.16, 0.22, 0.28 ];
	const radius = 0.075;
	binding.writeTailProbeWorldPositions( probes );
	targets.set( probes );
	for ( let probe = 0; probe < 3; probe ++ ) {

		const offset = probe * 3;
		targets[ offset + 1 ] += clearances[ probe ];
		constraintPlaneConstants[ probe ] = targets[ offset + 1 ] - radius;

	}
	binding.writeTailContactDeltas(
		solution.tailDeltas,
		solution.tailWeights,
		probes,
		targets,
		contactWeights,
		0.55,
		constraintNormals,
		constraintPlaneConstants,
		constraintProbeIndices,
		3,
		radius,
	);
	binding.applyTailSolution( solution, 1 );
	binding.writeTailProbeWorldPositions( after );
	for ( let probe = 0; probe < 3; probe ++ ) {

		const separation = after[ probe * 3 + 1 ] - constraintPlaneConstants[ probe ];
		assert.ok(
			separation >= radius - 1e-4,
			`tail probe ${ probe } retained residual ${ radius - separation }`,
		);

	}
	const legacyJoints = new Set( CHAMELEON_TAIL_CORRECTION_BONE_INDICES );
	assert.ok(
		Array.from( solution.tailWeights ).some(
			( weight, joint ) => weight > 0 && ! legacyJoints.has( joint ),
		),
		'the fixture must require one of the new block joints',
	);
	for ( let joint = 0; joint < CHAMELEON_TAIL_JOINT_COUNT; joint ++ ) {

		if ( solution.tailWeights[ joint ] <= 0 ) continue;
		const w = Math.min( 1, Math.abs( solution.tailDeltas[ joint * 4 + 3 ] ) );
		const angle = 2 * Math.acos( w );
		assert.ok( angle <= 0.55001, `tail joint ${ joint } exceeded its total angle` );

	}

} );
test( 'CHAMELEON-RIG-018 leg-only replay preserves stance contacts after a late body offset', () => {

	const { model } = createSyntheticRig();
	const binding = createChameleonRigBinding( model );
	const solution = binding.createSolution();
	const contact = new THREE.Vector3();
	const expected = new Float32Array( CHAMELEON_LEG_COUNT * 3 );
	for ( let index = 0; index < CHAMELEON_LEG_COUNT; index ++ ) {

		// Bend the synthetic fully extended rest legs to leave a measurable
		// correction budget for the subsequent body-plane translation.
		solution.footTargets[ index * 3 + 1 ] += 0.24;

	}
	binding.applyLegSolution( solution, 1 );
	model.updateMatrixWorld( true );
	for ( let index = 0; index < CHAMELEON_LEG_COUNT; index ++ ) {

		writeFootSoleWorld( binding, index, contact ).toArray( expected, index * 3 );

	}

	model.position.y += 0.08;
	model.updateMatrixWorld( true );
	writeFootSoleWorld( binding, 0, contact );
	assert.ok( Math.abs( contact.y - expected[ 1 ] ) > 0.07 );
	binding.applyLegSolution( solution, 1 );
	model.updateMatrixWorld( true );

	for ( let index = 0; index < CHAMELEON_LEG_COUNT; index ++ ) {

		writeFootSoleWorld( binding, index, contact );
		const offset = index * 3;
		const target = new THREE.Vector3(
			expected[ offset ], expected[ offset + 1 ], expected[ offset + 2 ],
		);
		assert.ok(
			contact.distanceTo( target ) < 2e-4,
			`${ binding.legs[ index ].name } stance drifted after late body solve`,
		);

	}

} );