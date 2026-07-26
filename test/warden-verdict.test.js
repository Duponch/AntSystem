import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildVolumeGpuProofVerdict,
	buildWardenVerdict,
	isFreshNestVolumeProof,
	NEST_VOLUME_GPU_PROBE_ID,
	WARDEN_ENTRANCE_PROOF_ID,
	WARDEN_VOLUME_PROOF_CASES,
} from '../src/warden.js';

const pass = () => ( { pass: true } );
const fail = () => ( { pass: false } );
const gpuPass = () => ( { id: NEST_VOLUME_GPU_PROBE_ID, pass: true } );

test( 'NAV-ENTRANCE-RUNTIME-001 zero observed transitions fails the global Warden report', () => {

	const verdict = buildWardenVerdict(
		[ pass() ], [ pass() ], { allerRetourObserve: false }, gpuPass() );
	assert.equal( WARDEN_ENTRANCE_PROOF_ID, 'NAV-ENTRANCE-RUNTIME-001' );
	assert.equal( verdict.pass, false );
	assert.equal( verdict.score, '3/4' );
	assert.equal( verdict.checks[ WARDEN_ENTRANCE_PROOF_ID ], false );

} );

test( 'the global Warden verdict requires unit, scenario and round-trip coverage together', () => {

	const complete = buildWardenVerdict(
		[ pass(), pass() ], [ pass() ], { allerRetourObserve: true }, gpuPass() );
	assert.equal( complete.pass, true );
	assert.equal( complete.score, '5/5' );

	const unitFailure = buildWardenVerdict(
		[ pass(), fail() ], [ pass() ], { allerRetourObserve: true }, gpuPass() );
	assert.equal( unitFailure.pass, false );
	assert.equal( unitFailure.score, '4/5' );

	const scenarioFailure = buildWardenVerdict(
		[ pass() ], [ fail() ], { allerRetourObserve: true }, gpuPass() );
	assert.equal( scenarioFailure.pass, false );
	assert.equal( scenarioFailure.score, '3/4' );

	const empty = buildWardenVerdict( [], [], { allerRetourObserve: true }, gpuPass() );
	assert.equal( empty.pass, false );
	assert.equal( empty.score, '2/4' );

} );

test( 'NAV-VOLUME-GPU-001 a missing or failed rendered-volume probe fails Warden', () => {

	assert.equal( NEST_VOLUME_GPU_PROBE_ID, 'NAV-VOLUME-GPU-001' );
	const missing = buildWardenVerdict(
		[ pass() ], [ pass() ], { allerRetourObserve: true } );
	assert.equal( missing.pass, false );
	assert.equal( missing.score, '3/4' );
	assert.equal( missing.checks[ NEST_VOLUME_GPU_PROBE_ID ], false );

	const failed = buildWardenVerdict(
		[ pass() ], [ pass() ], { allerRetourObserve: true },
		{ id: NEST_VOLUME_GPU_PROBE_ID, pass: false } );
	assert.equal( failed.pass, false );
	assert.equal( failed.score, '3/4' );

} );

test( 'NAV-VOLUME-GPU-007 every geometry configuration needs one fresh signature-bound proof', () => {

	const freshProof = ( caseId, revision ) => ( {
		id: NEST_VOLUME_GPU_PROBE_ID,
		caseId,
		pass: true,
		fresh: true,
		stale: false,
		bakeRevision: revision,
		layoutRevision: revision + 10,
		layoutSignature: `nv1-${ caseId }`,
		freshness: { pass: true },
	} );
	const proofs = WARDEN_VOLUME_PROOF_CASES.map(
		( caseId, index ) => freshProof( caseId, index + 1 ) );
	const complete = buildVolumeGpuProofVerdict( proofs );
	assert.equal( complete.pass, true );
	assert.equal( complete.coverage, true );
	assert.deepEqual( complete.counts,
		{ passed: WARDEN_VOLUME_PROOF_CASES.length, total: WARDEN_VOLUME_PROOF_CASES.length } );
	assert.equal( proofs.every( isFreshNestVolumeProof ), true );

	const stale = proofs.map( ( proof ) => ( { ... proof } ) );
	stale[ 2 ] = {
		... stale[ 2 ], pass: false, fresh: false, stale: true,
		freshness: { pass: false },
	};
	const staleVerdict = buildVolumeGpuProofVerdict( stale );
	assert.equal( staleVerdict.pass, false );
	assert.equal( staleVerdict.coverage, true );
	assert.equal( staleVerdict.checks[ WARDEN_VOLUME_PROOF_CASES[ 2 ] ], false );

	const missing = buildVolumeGpuProofVerdict( proofs.slice( 1 ) );
	assert.equal( missing.pass, false );
	assert.equal( missing.coverage, false );

	const duplicate = buildVolumeGpuProofVerdict( [ ... proofs, proofs[ 0 ] ] );
	assert.equal( duplicate.pass, false );
	assert.equal( duplicate.coverage, false );

	const global = buildWardenVerdict(
		[ pass() ], [ pass() ], { allerRetourObserve: true }, staleVerdict );
	assert.equal( global.pass, false );
	assert.equal( global.checks[ NEST_VOLUME_GPU_PROBE_ID ], false );

} );