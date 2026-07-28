import test from 'node:test';
import assert from 'node:assert/strict';

import {
	COLONY_INTERVAL_TICKS,
	SIMULATION_HZ,
	SPIDER_ANT_INTERVAL_TICKS,
	SPIDER_DAMAGE_INTERVAL_TICKS,
	authorityDueAt,
	computeNextAuthorityTick,
	nextMultipleAfter,
} from '../src/simulation-authority.js';

test( 'TIME-AUTH-001 authority boundaries use exact integer ticks', () => {

	assert.equal( SIMULATION_HZ, 120 );
	assert.equal( SPIDER_DAMAGE_INTERVAL_TICKS, 24n );
	assert.equal( SPIDER_ANT_INTERVAL_TICKS, 36n );
	assert.equal( COLONY_INTERVAL_TICKS, 120n );
	assert.equal( nextMultipleAfter( 0n, 24n ), 24n );
	assert.equal( nextMultipleAfter( 24n, 24n ), 48n );

} );

test( 'TIME-AUTH-002 disabled systems introduce no artificial boundary', () => {

	assert.equal( computeNextAuthorityTick( 0n ), null );
	assert.equal( computeNextAuthorityTick( 999n, { spiderCount: 0, colony: false } ), null );

} );

test( 'TIME-AUTH-003 the next boundary is the earliest enabled event', () => {

	assert.equal( computeNextAuthorityTick( 0n, { spiderCount: 1, colony: true } ), 24n );
	assert.equal( computeNextAuthorityTick( 24n, { spiderCount: 1, colony: true } ), 36n );
	assert.equal( computeNextAuthorityTick( 36n, { spiderCount: 1, colony: true } ), 48n );
	assert.equal( computeNextAuthorityTick( 96n, { spiderCount: 1, colony: true } ), 108n );
	assert.equal( computeNextAuthorityTick( 108n, { spiderCount: 1, colony: true } ), 120n );
	assert.equal( computeNextAuthorityTick( 0n, { spiderCount: 0, colony: true } ), 120n );

} );

test( 'TIME-AUTH-004 coincident events are reconciled at one boundary', () => {

	assert.deepEqual(
		authorityDueAt( 72n, { spiderCount: 4, colony: true } ),
		{ spiderAnt: true, spiderDamage: true, colony: false },
	);
	assert.deepEqual(
		authorityDueAt( 120n, { spiderCount: 4, colony: true } ),
		{ spiderAnt: false, spiderDamage: true, colony: true },
	);
	assert.deepEqual(
		authorityDueAt( 360n, { spiderCount: 4, colony: true } ),
		{ spiderAnt: true, spiderDamage: true, colony: true },
	);

} );

test( 'TIME-AUTH-005 invalid tick domains fail closed', () => {

	assert.throws( () => computeNextAuthorityTick( - 1n ), RangeError );
	assert.throws( () => computeNextAuthorityTick( 1.5 ), RangeError );
	assert.throws( () => nextMultipleAfter( 0n, 0n ), RangeError );

} );
