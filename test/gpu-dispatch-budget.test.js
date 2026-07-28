import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = async ( name ) => readFile( new URL( `../src/${ name }`, import.meta.url ), 'utf8' );

test( 'GPU-DISPATCH-001 ant pose and LOD classify only dispatch active slots', async () => {

	const ants = await source( 'ants.js' );
	const helperStart = ants.indexOf( '\n\tfunction setActiveDispatchCount' );
	const refreshStart = ants.indexOf( '\n\tfunction refreshPose', helperStart );
	assert.ok( helperStart >= 0 && refreshStart > helperStart );
	const helper = ants.slice( helperStart, refreshStart );

	assert.match( helper, /pose\.kPose\.count\s*=\s*count/u );
	assert.match( helper, /kClassify\.count\s*=\s*count/u );
	assert.match( ants, /setActiveDispatchCount\( params\.antCount \)/u );

	const setterStart = ants.indexOf( '\n\t\tsetCount( n ) {' );
	const shadowsStart = ants.indexOf( '\n\t\tsetShadows(', setterStart );
	assert.match( ants.slice( setterStart, shadowsStart ), /setActiveDispatchCount\( n \)/u );

} );

test( 'GPU-DISPATCH-002 both ping-pong ant kernels follow the active population', async () => {

	const simulation = await source( 'simulation.js' );
	assert.match( simulation, /this\._antDispatchCount\s*=\s*- 1/u );

	const stepStart = simulation.indexOf( '\n\tstep( dt ) {' );
	const passesStart = simulation.indexOf( '\n\t\tconst passes =', stepStart );
	assert.ok( stepStart >= 0 && passesStart > stepStart );
	const dispatchSetup = simulation.slice( stepStart, passesStart );

	assert.match( dispatchSetup, /MAX_ANTS[\s\S]*this\.u\.antCount\.value/u );
	assert.match( dispatchSetup, /this\.kAnt\[ 0 \]\.count\s*=\s*activeAnts/u );
	assert.match( dispatchSetup, /this\.kAnt\[ 1 \]\.count\s*=\s*activeAnts/u );

} );

test( 'GPU-DISPATCH-003 ragdoll uses two submissions and active ant spawn bounds', async () => {

	const ragdoll = await source( 'ragdoll.js' );
	const argsStart = ragdoll.indexOf( '\n\tconst kRdArgs =' );
	const solveStart = ragdoll.indexOf( '\n\tconst kRdSolve =', argsStart );
	assert.ok( argsStart >= 0 && solveStart > argsStart );
	assert.match( ragdoll.slice( argsStart, solveStart ), /drawNode\.element\([\s\S]*rdAlloc\.element/u );
	assert.doesNotMatch( ragdoll, /kRdDrawArgs|PASSES_B/u );

	const tickStart = ragdoll.indexOf( '\n\t\ttick() {' );
	const tick = ragdoll.slice( tickStart );
	assert.match( tick, /kRdSpawn\.count\s*=\s*activeAnts/u );
	assert.equal(
		[ ...tick.matchAll( /renderer\.compute\(/gu ) ].length,
		2,
		'one compact/cull pass plus one indirect XPBD solve',
	);

} );
