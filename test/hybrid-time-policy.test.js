import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as authority from '../src/simulation-authority.js';

const FRAME_DT_240_HZ = 1 / 240;
const MAX_WALL_DT = 1 / 30;
const MAX_GPU_SUBSTEPS = 8;
const EPSILON = 1e-12;

function plan( overrides = {} ) {

	assert.equal(
		typeof authority.planGpuSimulationFrame,
		'function',
		'simulation-authority.js must export planGpuSimulationFrame(options)',
	);
	return authority.planGpuSimulationFrame( {
		wallDt: FRAME_DT_240_HZ,
		speed: 1,
		maxSubsteps: MAX_GPU_SUBSTEPS,
		maxStepDt: MAX_WALL_DT,
		... overrides,
	} );

}

function assertClose( actual, expected, message ) {

	assert.ok(
		Number.isFinite( actual ) && Math.abs( actual - expected ) <= EPSILON,
		`${ message }: expected ${ expected }, received ${ actual }`,
	);

}

function assertConservedWithoutBacklog( result ) {

	assertClose(
		result.consumedDt + result.droppedDt,
		result.requestedDt,
		'consumed plus explicitly dropped time must equal requested time',
	);
	assert.equal(
		result.backlogDt ?? 0,
		0,
		'the fluid policy must never accumulate catch-up debt',
	);

}

function extractBraceBlock( source, markerPattern, label ) {

	const match = markerPattern.exec( source );
	assert.ok( match, `${ label } marker not found` );
	const open = source.indexOf( '{', match.index + match[ 0 ].length );
	assert.ok( open >= 0, `${ label } opening brace not found` );

	let depth = 0;
	for ( let index = open; index < source.length; index ++ ) {

		if ( source[ index ] === '{' ) depth ++;
		else if ( source[ index ] === '}' ) {

			depth --;
			if ( depth === 0 ) return source.slice( open + 1, index );

		}

	}
	assert.fail( `${ label } closing brace not found` );

}

test( 'HYBRID-TIME-001 pause schedules no GPU simulation pass', () => {

	const result = plan( { speed: 0 } );

	assert.equal( result.stepCount, 0 );
	assert.equal( result.stepDt, 0 );
	assert.equal( result.requestedDt, 0 );
	assert.equal( result.consumedDt, 0 );
	assert.equal( result.droppedDt, 0 );
	assertConservedWithoutBacklog( result );

} );

test( 'HYBRID-TIME-002 realtime speeds use exactly one fresh pass per rendered frame', () => {

	for ( const speed of [ 0.25, 0.5, 1 ] ) {

		const expected = FRAME_DT_240_HZ * speed;
		const result = plan( { speed } );

		assert.equal( result.stepCount, 1, `speed x${ speed }` );
		assertClose( result.stepDt, expected, `step dt at x${ speed }` );
		assertClose( result.requestedDt, expected, `requested dt at x${ speed }` );
		assertClose( result.consumedDt, expected, `consumed dt at x${ speed }` );
		assert.equal( result.droppedDt, 0, `speed x${ speed } must not drop normal frame time` );
		assertConservedWithoutBacklog( result );

	}

} );

test( 'HYBRID-TIME-003 long wall frames are clamped explicitly instead of creating hidden debt', () => {

	const wallDt = 0.25;
	const result = plan( { wallDt, speed: 1 } );

	if ( result.clampedWallDt !== undefined )
		assertClose( result.clampedWallDt, MAX_WALL_DT, 'clamped wall dt' );
	assert.equal( result.stepCount, 1 );
	assertClose( result.stepDt, MAX_WALL_DT, 'clamped realtime step' );
	assertClose( result.requestedDt, wallDt, 'raw requested time remains observable' );
	assertClose( result.consumedDt, MAX_WALL_DT, 'consumed clamped time' );
	assertClose( result.droppedDt, wallDt - MAX_WALL_DT, 'explicitly dropped wall time' );
	assertConservedWithoutBacklog( result );

} );

test( 'HYBRID-TIME-004 accelerated planning conserves time within a bounded GPU budget', () => {

	for ( const speed of [ 1.01, 2, 4, 15, 22, 100 ] ) {

		const result = plan( { speed } );

		assert.ok(
			result.stepCount >= 1 && result.stepCount <= MAX_GPU_SUBSTEPS,
			`x${ speed } scheduled ${ result.stepCount } passes`,
		);
		assert.ok(
			result.stepDt > 0 && result.stepDt <= MAX_WALL_DT + EPSILON,
			`x${ speed } step dt ${ result.stepDt } exceeds ${ MAX_WALL_DT }`,
		);
		assertClose(
			result.consumedDt,
			result.stepCount * result.stepDt,
			`uniform substeps at x${ speed }`,
		);
		assertConservedWithoutBacklog( result );

	}

} );

test( 'HYBRID-TIME-005 common accelerated speeds retain useful precision at 240 Hz', () => {

	for ( const [ speed, expectedSteps ] of [ [ 4, 1 ], [ 15, 2 ], [ 22, 3 ] ] ) {

		const result = plan( { speed } );
		assert.equal( result.stepCount, expectedSteps, `speed x${ speed }` );
		assert.equal( result.droppedDt, 0, `speed x${ speed }` );
		assertConservedWithoutBacklog( result );

	}

} );

test( 'HYBRID-TIME-006 x100 has fixed cost and reports the approximation explicitly', () => {

	const result = plan( { speed: 100 } );

	assert.equal( result.stepCount, MAX_GPU_SUBSTEPS );
	assertClose( result.stepDt, MAX_WALL_DT, 'saturated substep dt' );
	assert.ok( result.droppedDt > 0, 'x100 must expose time outside the bounded GPU budget' );
	assertConservedWithoutBacklog( result );

} );

test( 'HYBRID-TIME-RUNTIME-001 fluid mode is the default non-blocking grouped render path', async () => {

	const [ config, main, ants, simulation ] = await Promise.all( [
		readFile( new URL( '../src/config.js', import.meta.url ), 'utf8' ),
		readFile( new URL( '../src/main.js', import.meta.url ), 'utf8' ),
		readFile( new URL( '../src/ants.js', import.meta.url ), 'utf8' ),
		readFile( new URL( '../src/simulation.js', import.meta.url ), 'utf8' ),
	] );

	assert.match( config, /\btimingMode\s*:\s*['"]fluid['"]/u );
	assert.match( config, /\bmaxGpuSubsteps\s*:\s*8\b/u );
	assert.match( main, /\bplanGpuSimulationFrame\s*\(/u );

	const fluidPath = extractBraceBlock(
		main,
		/if\s*\(\s*params\.timingMode\s*===\s*['"]fluid['"]\s*\)/u,
		'fluid timing branch',
	);
	assert.doesNotMatch( fluidPath, /\bsyncAuthoritative\s*\(/u );
	assert.doesNotMatch( fluidPath, /\breadStatsAuthoritative\s*\(/u );
	assert.match( fluidPath, /\bants\.stepSimulation\s*\([^,]+,\s*true\s*\)/u );

	const antRender = extractBraceBlock(
		ants,
		/function\s+renderFrame\s*\([^)]*\)/u,
		'ant grouped render',
	);
	assert.match(
		antRender,
		/renderer\.compute\(\s*poseReady\s*\?\s*RENDER_PASSES\s*:\s*PASSES\s*\)/u,
	);

	assert.match( simulation, /this\.kStepWithSpiders\s*=\s*this\.kStep\.map/u );
	assert.match( simulation, /else\s+this\.renderer\.compute\(\s*passes\s*\)/u );
} );
