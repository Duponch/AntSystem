import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import {
	isContinuousChameleonCorridorHandoff,
	scaleChameleonStepHeight,
	writeChameleonBodyQuaternion,
} from '../src/chameleons.js';

import {
	buildChameleonSurfaceCollider,
	createChameleonSurfaceHit,
} from '../src/chameleon-surface-collider.js';
import {
	CHAMELEON_FOOT,
	CHAMELEON_FOOT_COUNT,
	ChameleonProceduralGait,
} from '../src/chameleon-procedural-gait.js';

function attribute( values, itemSize = 3 ) {

	return {
		array: new Float32Array( values ),
		itemSize,
		count: values.length / itemSize,
		getX( index ) { return this.array[ index * itemSize ]; },
		getY( index ) { return this.array[ index * itemSize + 1 ]; },
		getZ( index ) { return this.array[ index * itemSize + 2 ]; },
	};

}

function slopedSurfaceRegistry() {

	const positions = attribute( [
		- 4, - 1, - 2,
		4, 1, - 2,
		4, 1, 2,
		- 4, - 1, 2,
	] );
	const indices = attribute( [ 0, 2, 1, 0, 3, 2 ], 1 );
	const geometry = {
		index: indices,
		drawRange: { start: 0, count: Infinity },
		getAttribute: ( name ) => name === 'position' ? positions : null,
		getIndex: () => indices,
	};
	return [ {
		model: 'Log_01',
		category: 'obstacles',
		mesh: { geometry },
		placements: [ { x: 3, y: 2, z: - 5, yaw: 0.41, scale: 2.5 } ],
	} ];

}

function createContactKernel( collider, clearance = 0.018 ) {

	const hit = createChameleonSurfaceHit();
	const query = {
		supportId: 0,
		maxDistance: 8,
		includeGround: false,
		clearance,
	};
	const positions = new Float32Array( CHAMELEON_FOOT_COUNT * 3 );
	const normals = new Float32Array( CHAMELEON_FOOT_COUNT * 3 );
	const triangleIds = new Int32Array( CHAMELEON_FOOT_COUNT );

	function project( sourcePositions ) {

		for ( let foot = 0; foot < CHAMELEON_FOOT_COUNT; foot ++ ) {

			const offset = foot * 3;
			collider.projectPoint(
				sourcePositions[ offset ],
				sourcePositions[ offset + 1 ],
				sourcePositions[ offset + 2 ],
				hit,
				query,
			);
			assert.equal( hit.hit, true );
			assert.equal( hit.supportId, 0 );
			positions[ offset ] = hit.x;
			positions[ offset + 1 ] = hit.y;
			positions[ offset + 2 ] = hit.z;
			normals[ offset ] = hit.nx;
			normals[ offset + 1 ] = hit.ny;
			normals[ offset + 2 ] = hit.nz;
			triangleIds[ foot ] = hit.triangleId;

		}
		return { positions, normals, triangleIds };

	}

	return { hit, query, positions, normals, triangleIds, project };

}

function packedFoot( array, foot ) {

	const offset = foot * 3;
	return [ array[ offset ], array[ offset + 1 ], array[ offset + 2 ] ];

}

test( 'CHAMELEON-PHYSICS-000A continuous route rollover retains stance contacts while discontinuities reset', async () => {

	const corridor = {
		count: 2,
		x: Float32Array.of( 4, 5 ),
		y: Float32Array.of( 1, 1 ),
		z: Float32Array.of( - 2, - 2 ),
		effectiveSpacing: 0.3,
	};
	assert.equal( isContinuousChameleonCorridorHandoff( corridor, 4, 1, - 2 ), true );
	assert.equal( isContinuousChameleonCorridorHandoff( corridor, 3.7, 1, - 2 ), false );

	const positions = Float32Array.of(
		1, 0, 1,
		1, 0, - 1,
		- 1, 0, 1,
		- 1, 0, - 1,
	);
	const normals = Float32Array.from( { length: positions.length }, ( _, index ) => index % 3 === 1 ? 1 : 0 );
	const input = {
		contactPositions: positions,
		contactNormals: normals,
		speed: 0,
		velocityX: 0,
		velocityY: 0,
		velocityZ: 0,
		forwardX: 1,
		forwardY: 0,
		forwardZ: 0,
	};
	const gait = new ChameleonProceduralGait( { stepDistance: 10 } );
	const view = gait.reset( input ).getView();
	const stanceBefore = Array.from( view.footPositions );
	for ( let offset = 0; offset < positions.length; offset += 3 ) positions[ offset ] += 0.025;
	gait.update( 1 / 240, input );
	assert.deepEqual( Array.from( view.footPositions ), stanceBefore );

	const source = await readFile( new URL( '../src/chameleons.js', import.meta.url ), 'utf8' );
	const installStart = source.indexOf( '\n\tfunction installCorridor(' );
	const installEnd = source.indexOf( '\n\tfunction ', installStart + 2 );
	const install = source.slice( installStart, installEnd );
	assert.match( install, /keepWorldContacts[\s\S]*?isContinuousChameleonCorridorHandoff/u );
	assert.match( install, /if \( ! keepWorldContacts \) gaitReady = false/u );
	assert.match( source, /advanceExplorationRoute[\s\S]*?preserveGait:\s*true/u );
	assert.match( source, /rebuildTrack[\s\S]*?preserveGait:\s*false/u );

} );

test( 'CHAMELEON-PHYSICS-000B vertical pursuit always produces a finite orthonormal body frame', () => {

	for ( const directionY of [ - 1, 1 ] ) {

		const forward = new THREE.Vector3( 0, directionY, 0 );
		const up = new THREE.Vector3( 0, 1, 0 );
		const localX = new THREE.Vector3();
		const localZ = new THREE.Vector3();
		const matrix = new THREE.Matrix4();
		const quaternion = new THREE.Quaternion();
		writeChameleonBodyQuaternion( forward, up, localX, localZ, matrix, quaternion );

		assert.ok( [ quaternion.x, quaternion.y, quaternion.z, quaternion.w ].every( Number.isFinite ) );
		assert.ok( Math.abs( quaternion.length() - 1 ) < 1e-7 );
		assert.ok( Math.abs( localX.length() - 1 ) < 1e-7 );
		assert.ok( Math.abs( up.length() - 1 ) < 1e-7 );
		assert.ok( Math.abs( localZ.length() - 1 ) < 1e-7 );
		assert.ok( Math.abs( localX.dot( up ) ) < 1e-7 );
		assert.ok( Math.abs( localX.dot( localZ ) ) < 1e-7 );
		assert.ok( Math.abs( up.dot( localZ ) ) < 1e-7 );

	}

} );
test( 'CHAMELEON-PHYSICS-000C handoff validation fails closed, while nearest ground and gait scale stay wired', async () => {

	for ( const scale of [ 0.4, 1, 2.5 ] ) {

		assert.ok( Math.abs( scaleChameleonStepHeight( 0.16, scale ) - 0.16 * scale ) < 1e-12 );

	}
	const source = await readFile( new URL( '../src/chameleons.js', import.meta.url ), 'utf8' );
	const handoffStart = source.indexOf( '\n\tfunction makeContinuousHandoff(' );
	const handoffEnd = source.indexOf( '\n\tfunction ', handoffStart + 2 );
	const handoff = source.slice( handoffStart, handoffEnd );
	assert.match( handoff, /surfaceCollider\.traceSegment\s*\(/u );
	assert.match( handoff, /! handoffTrace\.valid[\s\S]*?return null/u );
	assert.match( handoff, /endpointGap > endpointTolerance[\s\S]*?return null/u );
	assert.match( handoff, /handoffValidated:\s*true/u );
	const installStart = source.indexOf( '\n\tfunction installCorridor(' );
	const installEnd = source.indexOf( '\n\tfunction ', installStart + 2 );
	assert.match(
		source.slice( installStart, installEnd ),
		/next = makeContinuousHandoff[\s\S]*?if \( ! next \)[\s\S]*?return false/u,
	);
	assert.match( source.slice( installStart, installEnd ), /candidate\.count < 2[\s\S]*?return false/u );
	assert.match( source, /handoffTraceQuery[\s\S]*?nearestGround:\s*true/u );
	assert.match( source, /footProjectionQuery[\s\S]*?nearestGround:\s*true/u );
	assert.match( source, /gait\.stepHeight\s*=\s*scaleChameleonStepHeight/u );

} );

test( 'CHAMELEON-PHYSICS-000D renderer contact rejection cannot mutate logical time', async () => {

	const source = await readFile( new URL( '../src/chameleons.js', import.meta.url ), 'utf8' );
	const rollbackStart = source.indexOf( '\n\tfunction rollbackUnsafeContact(' );
	const rollbackEnd = source.indexOf( '\n\tfunction ', rollbackStart + 2 );
	const rollback = source.slice( rollbackStart, rollbackEnd );
	assert.doesNotMatch(
		rollback,
		/simulation\.|surfaceRouter|resumeCorridor|requestAlternate|restorePendingCorridor/u,
		'a renderer observation must never rewind or branch the deterministic kernel',
	);
	assert.match( rollback, /bodyRoot\.position\.copy\( lastSafeBodyPosition \)/u );
	assert.match( rollback, /rigBinding\.applyLocalPose\( safeLocalPose \)/u );
	assert.match( rollback, /group\.visible = false[\s\S]*?tongue\.visible = false/u );

	const stepStart = source.indexOf( '\n\tfunction stepSimulation(' );
	const stepEnd = source.indexOf( '\n\tfunction ', stepStart + 2 );
	const step = source.slice( stepStart, stepEnd );
	assert.doesNotMatch( step, /bodyContactFrozen|setTrackPosition/u );
	assert.match( step, /simulation\.update\( dt, prey \)/u );

	const renderStart = source.indexOf( '\n\tfunction renderFrame(' );
	const renderEnd = source.indexOf( '\n\tfunction ', renderStart + 2 );
	const render = source.slice( renderStart, renderEnd );
	assert.doesNotMatch( render, /rebuildTrack\(|applyVisualScale\(|simulation\.setTrack/u );

} );
test( 'CHAMELEON-PHYSICS-000E invalid network rebakes preserve the live route and back off', async () => {

	const source = await readFile( new URL( '../src/chameleons.js', import.meta.url ), 'utf8' );
	const rebuildStart = source.indexOf( '\n\tfunction rebuildTrack(' );
	const rebuildEnd = source.indexOf( '\n\tfunction advanceExplorationRoute(', rebuildStart + 2 );
	const rebuild = source.slice( rebuildStart, rebuildEnd );
	const backoff = rebuild.indexOf( 'failedNetworkSignatureMatches(' );
	const bake = rebuild.indexOf( 'surfaceGraphBaker.update(' );
	const explore = rebuild.indexOf( 'nextSurfaceRouter.exploreNext(' );
	const preparationCatch = rebuild.indexOf( '} catch ( error ) {', explore );
	const temporaryPublication = rebuild.indexOf( 'surfaceGraph = nextSurfaceGraph' );
	assert.ok( backoff >= 0 && backoff < bake );
	assert.ok( bake > backoff && explore > bake && preparationCatch > explore );
	assert.ok( temporaryPublication > preparationCatch );
	assert.match(
		rebuild.slice( preparationCatch, temporaryPublication ),
		/recordNetworkRebuildFailure\([\s\S]*?return false/u,
	);
	const failedInstall = rebuild.indexOf( 'if ( ! installed )' );
	const commit = rebuild.indexOf( 'propRevision = revision' );
	assert.ok( failedInstall > temporaryPublication && commit > failedInstall );
	const rollback = rebuild.slice( failedInstall, commit );
	for ( const restored of [
		'surfaceGraph = previousSurfaceGraph',
		'surfaceCollider = previousSurfaceCollider',
		'surfaceRouter = previousSurfaceRouter',
		'host = previousHost',
		'track = previousTrack',
		'clearPendingCorridorRollback()',
	] ) assert.match( rollback, new RegExp( restored.replace( /[()]/gu, '\\$&' ), 'u' ) );
	assert.match( source, /networkRebuildError = String\([\s\S]*?slice\( 0, 240 \)/u );
	assert.match( source, /debugView\.networkRebuildFailures = networkRebuildFailures/u );

} );
test( 'CHAMELEON-PHYSICS-001 exact collider contacts feed gait while stance feet stay locked in world space', () => {

	const collider = buildChameleonSurfaceCollider( slopedSurfaceRegistry(), {
		scales: { obstacles: 1.35 },
		groundY: 0,
		defaultMaxDistance: 8,
	} );
	const contacts = createContactKernel( collider );
	const initialCandidates = Float32Array.of(
		1.8, 7, - 5.35,
		1.8, 7, - 4.65,
		0.7, 7, - 5.35,
		0.7, 7, - 4.65,
	);
	contacts.project( initialCandidates );
	const initialPositions = contacts.positions.slice();

	const input = {
		contactPositions: contacts.positions,
		contactNormals: contacts.normals,
		speed: 1,
		velocityX: 1,
		velocityY: 0,
		velocityZ: 0,
		forwardX: 1,
		forwardY: 0,
		forwardZ: 0,
	};
	const gait = new ChameleonProceduralGait( {
		fixedStep: 0.01,
		maxSubsteps: 8,
		stepDistance: 0.015,
		stepHeight: 0.09,
		minSwingDuration: 0.2,
		maxSwingDuration: 0.2,
		minTargetError: 0.001,
	} );
	gait.reset( input );

	const shiftedCandidates = initialCandidates.slice();
	for ( let foot = 0; foot < CHAMELEON_FOOT_COUNT; foot ++ ) {

		shiftedCandidates[ foot * 3 ] += 0.72;

	}
	contacts.project( shiftedCandidates );
	const view = gait.update( 0.04, input );

	assert.equal( view.activePair, 0 );
	assert.equal( view.footSwinging[ CHAMELEON_FOOT.FRONT_LEFT ], 1 );
	assert.equal( view.footSwinging[ CHAMELEON_FOOT.HIND_RIGHT ], 1 );
	assert.equal( view.footSwinging[ CHAMELEON_FOOT.FRONT_RIGHT ], 0 );
	assert.equal( view.footSwinging[ CHAMELEON_FOOT.HIND_LEFT ], 0 );
	assert.deepEqual(
		packedFoot( view.footPositions, CHAMELEON_FOOT.FRONT_RIGHT ),
		packedFoot( initialPositions, CHAMELEON_FOOT.FRONT_RIGHT ),
		'a stance foot must ignore moving candidates and remain world-locked',
	);
	assert.deepEqual(
		packedFoot( view.footPositions, CHAMELEON_FOOT.HIND_LEFT ),
		packedFoot( initialPositions, CHAMELEON_FOOT.HIND_LEFT ),
		'the diagonal stance mate must remain world-locked too',
	);
	assert.deepEqual(
		packedFoot( view.footTargetPositions, CHAMELEON_FOOT.FRONT_LEFT ),
		packedFoot( contacts.positions, CHAMELEON_FOOT.FRONT_LEFT ),
		'a swing target must be the exact projected world contact',
	);
	assert.deepEqual(
		packedFoot( view.footTargetPositions, CHAMELEON_FOOT.HIND_RIGHT ),
		packedFoot( contacts.positions, CHAMELEON_FOOT.HIND_RIGHT ),
	);

	for ( let foot = 0; foot < CHAMELEON_FOOT_COUNT; foot ++ ) {

		const offset = foot * 3;
		const length = Math.hypot(
			contacts.normals[ offset ],
			contacts.normals[ offset + 1 ],
			contacts.normals[ offset + 2 ],
		);
		assert.ok( Math.abs( length - 1 ) < 1e-6 );
		assert.ok( contacts.triangleIds[ foot ] >= 0 );

	}

} );

test( 'CHAMELEON-PHYSICS-002 collider, contact and gait views retain stable buffer identities', () => {

	const collider = buildChameleonSurfaceCollider( slopedSurfaceRegistry(), {
		defaultMaxDistance: 8,
	} );
	const contacts = createContactKernel( collider );
	const candidates = Float32Array.of(
		1.6, 6, - 5.3,
		1.6, 6, - 4.7,
		0.6, 6, - 5.3,
		0.6, 6, - 4.7,
	);
	contacts.project( candidates );
	const input = {
		contactPositions: contacts.positions,
		contactNormals: contacts.normals,
		speed: 0.8,
		velocityX: 0.8,
		forwardX: 1,
		forwardY: 0,
		forwardZ: 0,
	};
	const gait = new ChameleonProceduralGait( {
		fixedStep: 1 / 120,
		stepDistance: 0.08,
	} );
	gait.reset( input );

	const colliderPositionBuffer = collider.ax;
	const colliderNormalBuffer = collider.normalAX;
	const colliderOrderBuffer = collider.bvh.triangleOrder;
	const colliderStack = collider._queryStack;
	const hit = contacts.hit;
	const contactPositions = contacts.positions;
	const contactNormals = contacts.normals;
	const view = gait.getView();
	const footPositions = view.footPositions;
	const footTargets = view.footTargetPositions;
	const bodyPosition = view.bodyPosition;

	for ( let tick = 0; tick < 600; tick ++ ) {

		for ( let foot = 0; foot < CHAMELEON_FOOT_COUNT; foot ++ ) {

			candidates[ foot * 3 ] += 0.0015;

		}
		assert.equal( contacts.project( candidates ).positions, contactPositions );
		assert.equal( contacts.hit, hit );
		assert.equal( gait.update( 1 / 240, input ), view );

	}
	assert.equal( collider.ax, colliderPositionBuffer );
	assert.equal( collider.normalAX, colliderNormalBuffer );
	assert.equal( collider.bvh.triangleOrder, colliderOrderBuffer );
	assert.equal( collider._queryStack, colliderStack );
	assert.equal( contacts.positions, contactPositions );
	assert.equal( contacts.normals, contactNormals );
	assert.equal( gait.getView().footPositions, footPositions );
	assert.equal( gait.getView().footTargetPositions, footTargets );
	assert.equal( gait.getView().bodyPosition, bodyPosition );
	assert.equal( gait.getTelemetry().updateCalls, 600 );

} );

test( 'CHAMELEON-PHYSICS-003 phased runtime validates the final pose and recovers transactionally', async () => {

	const [ chameleons, surfaceGraph, config, ui, inspector ] = await Promise.all( [
		readFile( new URL( '../src/chameleons.js', import.meta.url ), 'utf8' ),
		readFile( new URL( '../src/chameleon-surface-graph.js', import.meta.url ), 'utf8' ),
		readFile( new URL( '../src/config.js', import.meta.url ), 'utf8' ),
		readFile( new URL( '../src/ui.js', import.meta.url ), 'utf8' ),
		readFile( new URL( '../src/wildlife-inspector.js', import.meta.url ), 'utf8' ),
	] );

	for ( const contract of [
		'createChameleonSurfaceHit',
		'ChameleonProceduralGait',
		'createChameleonRigBinding',
		'ChameleonBodyContactSolver',
		'ChameleonTailContactSolver',
	] ) assert.match( chameleons, new RegExp( `\\b${ contract }\\b`, 'u' ) );
	assert.doesNotMatch(
		chameleons,
		/new\s+THREE\.Raycaster|intersectObjects?\s*\(|\.raycast\s*\(/u,
		'the fixed/render path must use the baked collider, not scene raycasts',
	);
	assert.match( surfaceGraph, /buildChameleonSurfaceCollider\s*\(\s*registry/u );
	assert.match( chameleons, /surfaceGraphBaker\.update\s*\(\s*props\.registry/u );
	assert.match( chameleons, /const centreSegment = sampleSupport[\s\S]*?normalSegment = centreSegment/u );
	assert.match( chameleons, /supportIds: bodyProbeSupportIds[\s\S]*?componentIds: bodyProbeComponentIds/u );
	assert.match( chameleons, /const kind = contactKinds\[ 2 \][\s\S]*?contactComponentIds\[ 2 \]/u );
	assert.match( chameleons, /nextSurfaceCollider\s*=\s*nextSurfaceGraph\.collider/u );
	assert.match( chameleons, /surfaceCollider\s*=\s*nextSurfaceCollider/u );
	assert.match( chameleons, /contactTriangleHints\s*=\s*new Int32Array\(\s*CHAMELEON_FOOT_COUNT\s*\)/u );
	assert.match( chameleons, /footProjectionQuery\.triangleId\s*=\s*contactTriangleHints\[\s*foot\s*\]/u );
	assert.match(
		chameleons,
		/contactTriangleHints\[\s*foot\s*\]\s*=\s*!\s*hit\.isGround\s*&&\s*hit\.triangleId\s*>=\s*0/u,
	);
	const invalidationStart = chameleons.indexOf( '\n\tfunction invalidateContactTriangleHints(' );
	const invalidationEnd = chameleons.indexOf( '\n\tfunction ', invalidationStart + 2 );
	assert.match( chameleons.slice( invalidationStart, invalidationEnd ), /contactTriangleHints\.fill\(\s*-\s*1\s*\)/u );
	assert.ok( ( chameleons.match( /invalidateContactTriangleHints\(\)/gu ) || [] ).length >= 6 );

	const renderStart = chameleons.indexOf( '\n\tfunction renderFrame(' );
	const renderEnd = chameleons.indexOf( '\n\tfunction update(', renderStart + 2 );
	const renderFrame = chameleons.slice( renderStart, renderEnd );
	const orderedCalls = [
		'orientBody(',
		'updateProceduralContacts(',
		'updateAnimation(',
		'prepareProceduralRig(',
		'applyProceduralBody(',
		'updateBodyContacts(',
		'updateTailContacts(',
		'applyProceduralTailAndLegs(',
		'validateOrRefreshBodyPose(',
		'validateOrRestoreTailPose(',
		'rollbackUnsafeContact(',
		'commitSafeContactPose(',
		'updateTongue(',
	];
	let previous = - 1;
	for ( const call of orderedCalls ) {

		const current = renderFrame.indexOf( call );
		assert.ok( current > previous, `${ call } is out of order` );
		previous = current;

	}
	assert.match( chameleons, /function applyProceduralBody[\s\S]*?rigBinding\.applyBodySolution\s*\(/u );
	assert.match( chameleons, /function applyProceduralTailAndLegs[\s\S]*?rigBinding\.applyTailAndLegSolution\s*\(/u );
	assert.ok(
		renderFrame.indexOf( 'rigBinding.writeTailLocalPose( preTailLocalPose )' )
			< renderFrame.indexOf( 'applyProceduralTailAndLegs(' ),
		'the pre-tail pose must be captured before procedural correction',
	);
	const tailRecoveryStart = chameleons.indexOf( '\n\tfunction validateOrRestoreTailPose(' );
	const tailRecoveryEnd = chameleons.indexOf( '\n\tfunction ', tailRecoveryStart + 2 );
	const tailRecovery = chameleons.slice( tailRecoveryStart, tailRecoveryEnd );
	const firstTailValidation = tailRecovery.indexOf( 'tailContacts.validateAppliedPose(' );
	const firstSafeTailWrite = tailRecovery.indexOf( 'writeTailLocalPose( safeTailLocalPose )' );
	const fallbackTailApply = tailRecovery.indexOf( 'applyTailLocalPose(' );
	assert.equal( ( tailRecovery.match( /tailContacts\.validateAppliedPose\(/gu ) || [] ).length, 3 );
	assert.ok( firstTailValidation >= 0 && firstSafeTailWrite > firstTailValidation );
	assert.ok( fallbackTailApply > firstSafeTailWrite );
	assert.match(
		tailRecovery,
		/hadFreshConstraints[\s\S]*?applyTailLocalPose\( preTailLocalPose \)[\s\S]*?tailContacts\.invalidateHints\( true \)[\s\S]*?tailContacts\.update\( 0, tailContactInput \)[\s\S]*?rigBinding\.applyTailSolution\( rigSolution, contactWeight \)[\s\S]*?tailContacts\.validateAppliedPose/u,
	);
	const bodyRefreshStart = chameleons.indexOf( '\n\tfunction validateOrRefreshBodyPose(' );
	const bodyRefreshEnd = chameleons.indexOf( '\n\tfunction ', bodyRefreshStart + 2 );
	assert.match(
		chameleons.slice( bodyRefreshStart, bodyRefreshEnd ),
		/bodyContactView\.refreshed[\s\S]*?bodyContacts\.invalidateHints\( true \)[\s\S]*?updateBodyContacts\( 0, view \)/u,
	);
	const bodyFailureStart = renderFrame.indexOf( 'const bodyContactFailed' );
	const lateLegReplay = renderFrame.indexOf( 'rigBinding.applyLegSolution(', bodyFailureStart );
	const tailValidation = renderFrame.indexOf( 'validateOrRestoreTailPose(', bodyFailureStart );
	assert.ok(
		lateLegReplay > bodyFailureStart && lateLegReplay < tailValidation,
		'late cached body translation must replay leg IK before final tail/contact validation',
	);
	const bodyFailureEnd = renderFrame.indexOf( 'else commitSafeContactPose', bodyFailureStart );
	const failureContract = renderFrame.slice( bodyFailureStart, bodyFailureEnd );
	assert.doesNotMatch( failureContract.slice( 0, failureContract.indexOf( 'const contactFailed' ) ), /tailContactView/u );
	assert.match( failureContract, /contactFailed = bodyContactFailed \|\| ! tailSafe/u );
	assert.match( failureContract, /rollbackUnsafeContact\( view \)/u );

	const rollbackStart = chameleons.indexOf( '\n\tfunction rollbackUnsafeContact(' );
	const rollbackEnd = chameleons.indexOf( '\n\tfunction ', rollbackStart + 2 );
	const rollback = chameleons.slice( rollbackStart, rollbackEnd );
	assert.match( rollback, /bodyContactFrozen = true/u );
	assert.match( rollback, /rigBinding\.applyLocalPose\(\s*safeLocalPose\s*\)/u );
	assert.match( rollback, /group\.visible = false[\s\S]*?tongue\.visible = false/u );
	assert.doesNotMatch(
		rollback,
		/simulation\.|surfaceRouter|resumeCorridor|requestAlternate|restorePendingCorridor/u,
	);
	assert.ok(
		renderFrame.indexOf( 'updateAnimation( renderDt, view )' )
			< renderFrame.indexOf( 'rollbackUnsafeContact( view )' ),
		'the fail-closed visual restore must happen after mixer evaluation',
	);
	const installStart = chameleons.indexOf( '\n\tfunction installCorridor(' );
	const installEnd = chameleons.indexOf( '\n\tfunction ', installStart + 2 );
	const install = chameleons.slice( installStart, installEnd );
	assert.ok( install.indexOf( 'pendingTrackRollback = track' ) < install.indexOf( 'track = next' ) );
	assert.match( chameleons, /pendingNetworkMetadataRollback = previousNetworkMetadata/u );
	const restoreStart = chameleons.indexOf( '\n\tfunction restorePendingCorridor(' );
	const restoreEnd = chameleons.indexOf( '\n\tfunction ', restoreStart + 2 );
	const restore = chameleons.slice( restoreStart, restoreEnd );
	const metadataGuard = restore.indexOf( 'if ( rollbackMetadata )' );
	for ( const rollbackState of [
		'surfaceGraph = rollbackGraph', 'surfaceCollider = rollbackCollider',
		'surfaceRouter = rollbackRouter', 'host = rollbackHost',
		'propRevision = rollbackMetadata.propRevision',
		'obstacleScale = rollbackMetadata.obstacleScale',
		'treeScale = rollbackMetadata.treeScale',
		'rockScale = rollbackMetadata.rockScale',
		'cachedSupportClearance = rollbackMetadata.supportClearance',
		'cachedGroundClearance = rollbackMetadata.groundClearance',
		'lastNetworkRevision = rollbackMetadata.networkRevision',
	] ) {

		assert.ok( restore.indexOf( rollbackState ) > metadataGuard );
		assert.ok( restore.indexOf( rollbackState ) < restore.indexOf( 'simulation.setTrackSamples( track )' ) );

	}
	const rebuildStart = chameleons.indexOf( '\n\tfunction rebuildTrack(' );
	const rebuildEnd = chameleons.indexOf( '\n\tfunction ', rebuildStart + 2 );
	const rebuild = chameleons.slice( rebuildStart, rebuildEnd );
	assert.match(
		rebuild,
		/pendingRouterProposal[\s\S]*?if \( ! force \) return false;[\s\S]*?restorePendingCorridor\(\)/u,
		'a rebake cannot replace the router or rollback owned by an unresolved proposal',
	);
	assert.ok( rebuild.indexOf( 'pendingRouterProposal' ) < rebuild.indexOf( 'surfaceGraphBaker.update(' ) );
	assert.ok( rebuild.indexOf( 'acceptPendingCorridorPublication()' ) > rebuild.indexOf( 'installCorridor(' ) );
	const advanceStart = chameleons.indexOf( '\n\tfunction advanceExplorationRoute(' );
	const advanceEnd = chameleons.indexOf( '\n\tfunction ', advanceStart + 2 );
	const advance = chameleons.slice( advanceStart, advanceEnd );
	assert.match(
		advance,
		/if \( installed \)[\s\S]*?pendingRouterProposal = proposalRouter[\s\S]*?acceptPendingCorridorPublication\(\)/u,
		'a validated route transaction must close inside the fixed-step, independently of rendering',
	);
	assert.match( advance, /preserveGait: true/u );
	assert.match( advance, /proposalRouter\.rebase\([\s\S]*?proposalRouter\.beginProposal\(\)/u );
	assert.match( advance, /proposalRouter\.rejectProposal\(\)[\s\S]*?resumeCorridorAwayFromFailure\(\)/u );
	assert.doesNotMatch( advance, /renderFrame|bodyContactFrozen|alternateCorridor/u );
	const resetStart = chameleons.indexOf( '\n\tfunction reset(' );
	const resetEnd = chameleons.indexOf( '\n\tfunction ', resetStart + 2 );
	assert.match( chameleons.slice( resetStart, resetEnd ), /clearPendingCorridorRollback\(\)/u );
	const commitStart = chameleons.indexOf( '\n\tfunction commitSafeContactPose(' );
	const commitEnd = chameleons.indexOf( '\n\tfunction ', commitStart + 2 );
	const commit = chameleons.slice( commitStart, commitEnd );
	assert.match( commit, /acceptPendingCorridorPublication\(\)/u );
	assert.match( commit, /rigBinding\.writeLocalPose\(\s*safeLocalPose\s*\)/u );
	const acceptStart = chameleons.indexOf( '\n\tfunction acceptPendingCorridorPublication(' );
	const acceptEnd = chameleons.indexOf( '\n\tfunction ', acceptStart + 2 );
	const acceptPublication = chameleons.slice( acceptStart, acceptEnd );
	assert.match( acceptPublication, /pendingRouterProposal\.acceptProposal\(\)/u );
	assert.match( acceptPublication, /clearPendingCorridorRollback\(\)/u );
	assert.match( restore, /pendingRouterProposal\.rejectProposal\(\)/u );
	const stepStart = chameleons.indexOf( '\n\tfunction stepSimulation(' );
	const stepEnd = chameleons.indexOf( '\n\tfunction ', stepStart + 2 );
	const step = chameleons.slice( stepStart, stepEnd );
	assert.match( step, /advanceExplorationRoute\([\s\S]*?simulation\.update\( dt, prey \)/u );
	assert.doesNotMatch( step, /bodyContactFrozen|simulation\.setTrackPosition/u );

	for ( const option of [
		'chameleonContactPhysics', 'chameleonFootIK', 'chameleonContactFrequency',
		'chameleonStepHeight', 'chameleonGaitStrength',
		'chameleonBodyContacts', 'chameleonBodyContactFrequency', 'chameleonBodyProbeRadius',
		'chameleonTailContacts', 'chameleonTailContactFrequency', 'chameleonTailProbeRadius',
	] ) {

		assert.match( config, new RegExp( `\\b${ option }\\s*:`, 'u' ), `missing ${ option } default` );
		assert.match(
			ui,
			new RegExp( `\\.add\\(\\s*gfx\\s*,\\s*['"]${ option }['"]`, 'u' ),
			`missing ${ option } UI control`,
		);

	}
	for ( const option of [
		'chameleonContactFrequency', 'chameleonStepHeight', 'chameleonGaitStrength',
		'chameleonBodyContactFrequency', 'chameleonBodyProbeRadius',
		'chameleonTailContactFrequency', 'chameleonTailProbeRadius',
	] ) assert.match( config, new RegExp( `clampSetting\\(\\s*gfx\\.${ option }`, 'u' ) );
	assert.match( chameleons, /contactFrozen:[\s\S]*?bodyResidual:[\s\S]*?tailResidual:[\s\S]*?contactRecovery:/u );
	assert.match( inspector, /contactFrozen[\s\S]*?bodyResidual[\s\S]*?tailResidual/u );

} );
