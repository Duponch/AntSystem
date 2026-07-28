import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
	advanceSpiderPollClock,
	spiderRandomNext,
	spiderRandomSeed,
} from '../src/spiders.js';

function sequence( seed, stream, count ) {

	let state = spiderRandomSeed( seed, stream );
	const values = [];
	for ( let i = 0; i < count; i ++ ) {

		state = spiderRandomNext( state );
		values.push( state );

	}
	return values;

}

test( 'SPIDER-TIME-001 seeded random streams are reproducible and isolated per spider', () => {

	const first = sequence( 71, 3, 32 );
	assert.deepEqual( first, sequence( 71, 3, 32 ) );
	assert.notDeepEqual( first, sequence( 72, 3, 32 ) );
	assert.notDeepEqual( first, sequence( 71, 4, 32 ) );
	assert.ok( first.every( ( value ) => Number.isInteger( value ) && value > 0 ) );

} );

test( 'SPIDER-TIME-002 polling deadlines preserve residual time across dt partitions', () => {

	const single = { interval: 0.3, residual: 0 };
	const partitioned = { interval: 0.3, residual: 0 };
	const singleDue = advanceSpiderPollClock( single, 1.05 );
	let partitionedDue = 0;
	for ( const dt of [ 0.07, 0.11, 0.02, 0.29, 0.31, 0.25 ] )
		partitionedDue += advanceSpiderPollClock( partitioned, dt );

	assert.equal( singleDue, 3 );
	assert.equal( partitionedDue, singleDue );
	assert.ok( Math.abs( single.residual - 0.15 ) < 1e-12 );
	assert.ok( Math.abs( partitioned.residual - single.residual ) < 1e-12 );
	assert.throws(
		() => advanceSpiderPollClock( { interval: 0.3, residual: 0 }, - 0.01 ),
		/dt must be/u,
	);

} );

test( 'SPIDER-TIME-003 logical ticks and per-frame uploads are separate APIs', async () => {

	const source = await readFile( new URL( '../src/spiders.js', import.meta.url ), 'utf8' );
	assert.doesNotMatch( source, /Math\.random/u );
	const stepStart = source.indexOf( '\n\tfunction stepSimulation( simDt ) {' );
	const diagnosticsStart = source.indexOf( '\n\tfunction serviceDiagnostics() {' );
	const renderStart = source.indexOf( '\n\tfunction renderFrame() {' );
	const updateStart = source.indexOf( '\n\tfunction update( simDt ) {' );
	assert.ok( stepStart >= 0 && diagnosticsStart > stepStart && renderStart > diagnosticsStart && updateStart > renderStart );

	const stepBody = source.slice( stepStart, diagnosticsStart );
	const diagnosticsBody = source.slice( diagnosticsStart, renderStart );
	const renderBody = source.slice( renderStart, updateStart );
	const updateBody = source.slice( updateStart, source.indexOf( '\n\treturn {', updateStart ) );
	assert.match( stepBody, /updateSpider\( sp, simDt \)/u );
	assert.match( stepBody, /buildSectors\( logicalCount \)/u );
	assert.doesNotMatch( stepBody, /needsUpdate/u );
	assert.match( diagnosticsBody, /serviceScheduledReadback\(\)/u );
	assert.doesNotMatch( renderBody, /serviceScheduledReadback\(\)/u );
	assert.match( renderBody, /aPose\.needsUpdate = true/u );
	assert.match( updateBody, /stepSimulation\( simDt \);[\s\S]*return renderFrame\(\);/u );
	assert.match( source.slice( source.indexOf( '\n\treturn {', updateStart ) ), /serviceDiagnostics,/u );

} );
