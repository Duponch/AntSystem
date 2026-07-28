import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = ( relativePath ) => readFile( new URL( relativePath, import.meta.url ), 'utf8' );

test( 'TIME-SCALE-RUNTIME-001 both timing modes advance the ecosystem with one shared logical dt', async () => {

	const main = await readSource( '../src/main.js' );
	assert.match( main, /new SimulationClock\(\s*\{[\s\S]*?fixedStep:\s*1\s*\/\s*SIMULATION_HZ/u );
	assert.match( main, /simulationClock\.advance\(\s*wallDt,\s*requestedSpeed,/u );
	assert.match( main, /planGpuSimulationFrame\(\s*\{/u );
	assert.doesNotMatch( main, /rawDt\s*\*\s*params\.simSpeed/u );

	const strictStart = main.indexOf( 'const clockFrame = simulationClock.advance' );
	const strictEnd = main.indexOf( '\n\t\t\tlogicalSteps = clockFrame.effectiveSteps', strictStart );
	assert.ok( strictStart >= 0 && strictEnd > strictStart, 'strict callback not found' );
	const strictBody = main.slice( strictStart, strictEnd );
	for ( const call of [
		'sim.step( fixedDt )',
		'colony.stepSimulation( fixedDt )',
		'ants.stepSimulation( fixedDt )',
		'spiders.stepSimulation( fixedDt )',
		'bees.stepSimulation( fixedDt )',
	] ) assert.match( strictBody, new RegExp( call.replace( /[().]/g, '\\$&' ) ) );

	const fluidStart = main.indexOf( "if ( params.timingMode === 'fluid' )" );
	const fluidEnd = main.indexOf( '\n\t\t} else {', fluidStart );
	assert.ok( fluidStart >= 0 && fluidEnd > fluidStart, 'fluid branch not found' );
	const fluidBody = main.slice( fluidStart, fluidEnd );
	for ( const call of [
		'sim.step( dt )',
		'colony.stepSimulation( dt )',
		'ants.stepSimulation( fluidPlan.consumedDt, true )',
		'spiders.stepSimulation( dt )',
		'bees.stepSimulation( dt )',
	] ) assert.match( fluidBody, new RegExp( call.replace( /[().]/g, '\\$&' ) ) );
	assert.doesNotMatch( fluidBody, /syncAuthoritative|readStatsAuthoritative/u );

} );

test( 'TIME-SCALE-RUNTIME-002 rendering cannot mutate or advance ecosystem logic', async () => {

	const [ main, pollinators, chameleons ] = await Promise.all( [
		readSource( '../src/main.js' ),
		readSource( '../src/pollinators.js' ),
		readSource( '../src/chameleons.js' ),
	] );
	assert.match( main, /ants\.renderFrame\( camera \)/u );
	assert.match( main, /spiders\.renderFrame\(\)/u );
	assert.match( main, /bees\.renderFrame\( rawDt, ! dived \)/u );

	const renderStart = pollinators.indexOf( '\n\tfunction renderFrame(' );
	const renderEnd = pollinators.indexOf( '\n\tfunction update(', renderStart );
	assert.ok( renderStart >= 0 && renderEnd > renderStart );
	assert.doesNotMatch( pollinators.slice( renderStart, renderEnd ), /\.update\(|stepSimulation/u );

	const chameleonRenderStart = chameleons.indexOf( '\n\tfunction renderFrame(' );
	const chameleonRenderEnd = chameleons.indexOf( '\n\tfunction update(', chameleonRenderStart );
	assert.ok( chameleonRenderStart >= 0 && chameleonRenderEnd > chameleonRenderStart );
	assert.doesNotMatch(
		chameleons.slice( chameleonRenderStart, chameleonRenderEnd ),
		/setCapturedPosition|simulation\.update/u,
	);

} );

test( 'TIME-SCALE-RUNTIME-003 strict authority is exact while fluid authority is opportunistic', async () => {

	const [ main, simulation, spiders, colony ] = await Promise.all( [
		readSource( '../src/main.js' ),
		readSource( '../src/simulation.js' ),
		readSource( '../src/spiders.js' ),
		readSource( '../src/colony.js' ),
	] );
	assert.match( main, /simulationClock\.tickExact === nextAuthorityTick/u );
	assert.match( main, /spiders\.syncAuthoritative/u );
	assert.match( main, /sim\.readStatsAuthoritative\(\)/u );
	assert.match( main, /colony\.reconcileStatsAtTick/u );
	assert.match( main, /scheduleRelaxedColonyReconciliation/u );
	assert.match( main, /colony\.onStats/u );
	assert.match( main, /sim\.readStats\(\)\.then/u );
	assert.match( main, /const statsEpoch = authorityEpoch;[\s\S]*?statsEpoch !== authorityEpoch/u );
	assert.match( main, /if \( strictTiming \) \{[\s\S]{0,240}resetAuthoritativeSimulation/u );
	assert.ok( main.indexOf( 'spiders.serviceDiagnostics()' ) > main.indexOf( 'else renderer.render( scene, camera )' ) );
	assert.match( simulation, /async readStatsAuthoritative\(\)[\s\S]*?withReadback/u );
	assert.match( simulation, /_statsEpoch[\s\S]*?epoch === this\._statsEpoch/u );
	assert.match( colony, /const epoch = diagnosticEpoch;[\s\S]*?epoch !== diagnosticEpoch/u );
	assert.match( spiders, /async function syncAuthoritative/u );
	assert.doesNotMatch( spiders, /Math\.random/u );
	assert.doesNotMatch( colony, /Math\.random/u );

} );

test( 'TIME-SCALE-RUNTIME-004 overload is explicit in strict and fluid modes', async () => {

	const [ main, ui, clock ] = await Promise.all( [
		readSource( '../src/main.js' ),
		readSource( '../src/ui.js' ),
		readSource( '../src/simulation-clock.js' ),
	] );
	assert.match( main, /backlog:\s*strictTiming\s*\?\s*simulationClock\.backlog\s*:\s*0/u );
	assert.match( main, /dropped:\s*strictTiming\s*\?\s*0\s*:\s*simulationDroppedAccum/u );
	assert.match( main, /effectiveMultiplier/u );
	assert.match( ui, /effectif · \$\{mode\}/u );
	assert.match( ui, /rattrapage/u );
	assert.match( ui, /plafond GPU/u );
	assert.match( clock, /this\._backlogUnits \+= wholeUnits/u );
	assert.match( clock, /discardBacklog\(\)/u );

} );

test( 'TIME-SCALE-RUNTIME-006 colony mode changes use the clock-blocking authority queue', async () => {

	const [ main, ui ] = await Promise.all( [
		readSource( '../src/main.js' ),
		readSource( '../src/ui.js' ),
	] );

	const toggleStart = ui.indexOf( "fLife.add( params, 'colony' )" );
	const toggleEnd = ui.indexOf( '\n\t// ------------------------------------------------------------------', toggleStart + 1 );
	assert.ok( toggleStart >= 0 && toggleEnd > toggleStart, 'colony toggle handler not found' );
	const toggle = ui.slice( toggleStart, toggleEnd );

	assert.match( ui, /export function createUI\(\s*\{[\s\S]*?\bonSetColonyEnabled\b/u );
	assert.match( toggle, /\bonSetColonyEnabled\s*\(\s*requested\s*\)/u );
	assert.doesNotMatch( toggle, /\bsim\.setColonyEnabled\s*\(/u );
	assert.doesNotMatch( toggle, /\bspiders\s*\?\s*\.\s*reset\s*\(|\bspiders\.reset\s*\(/u );
	assert.doesNotMatch( toggle, /\bcolony\.reset\s*\(/u );

	assert.match(
		main,
		/function enqueueAuthoritativeMutation\s*\([^)]*\)\s*\{[\s\S]*?\bresetPromise\s*=/u,
	);
	assert.match(
		main,
		/function setColonyEnabledAuthoritatively\s*\([^)]*\)\s*\{[\s\S]*?\benqueueAuthoritativeMutation\s*\(/u,
	);
	assert.match(
		main,
		/function setColonyEnabledAuthoritatively\s*\([^)]*\)\s*\{[\s\S]*?\bsim\.setColonyEnabled\s*\(/u,
	);
	assert.match(
		main,
		/function resetAuthoritativeSimulation\s*\(\s*\)\s*\{[\s\S]*?\benqueueAuthoritativeMutation\s*\(/u,
	);
	assert.match(
		main,
		/\bonSetColonyEnabled\s*:\s*setColonyEnabledAuthoritatively\b/u,
	);
	assert.match(
		main,
		/const authorityBlocked\s*=\s*!!\s*authorityPending[\s\S]{0,160}!!\s*resetPromise[\s\S]{0,160}if\s*\(\s*!\s*authorityBlocked\s*\)/u,
	);
	assert.match(
		main,
		/const requestedSpeed\s*=\s*running\s*&&\s*!\s*resetPromise/u,
	);

} );
