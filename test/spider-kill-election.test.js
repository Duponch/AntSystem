import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = ( relativePath ) => readFile( new URL( relativePath, import.meta.url ), 'utf8' );

test( 'SPIDER-AUTHORITY-002 kill victim election is atomic, deterministic and interval-scoped', async () => {

	const [ simulation, spiders ] = await Promise.all( [
		readSource( '../src/simulation.js' ),
		readSource( '../src/spiders.js' ),
	] );

	assert.match(
		simulation,
		/this\.spiderKillAnt\s*=\s*instancedArray\(\s*MAX_SPIDERS\s*,\s*'uint'\s*\)\.toAtomic\(\)/u,
		'the elected ant index must live in an atomic uint buffer',
	);
	assert.match(
		simulation,
		/atomicMin\(\s*spiderKillAnt\.element\(\s*spiderId\s*\)\s*,\s*instanceIndex\s*\)/u,
		'the lowest ant slot must deterministically win concurrent kills',
	);

	const sentinelStores = simulation.match(
		/atomicStore\(\s*spiderKillAnt\.element\(\s*instanceIndex\s*\)\s*,\s*uint\(\s*MAX_ANTS\s*\)\s*\)/gu,
	) ?? [];
	assert.equal(
		sentinelStores.length,
		2,
		'the winner must be initialized on reset and cleared to MAX_ANTS after every authority interval',
	);
	assert.match( simulation, /this\.kClearSpiderDamage\s*=\s*Fn\([\s\S]*?atomicStore\(\s*spiderKillAnt[\s\S]*?MAX_ANTS/u );
	assert.match( simulation, /this\.kClearSpiderKillAnt\s*=\s*Fn\([\s\S]*?atomicStore\(\s*spiderKillAnt[\s\S]*?MAX_ANTS/u );
	assert.match(
		spiders,
		/const\s+kAuthoritySnapshotWithKillAck\s*=\s*\[\s*kAuthoritySnapshot\s*,\s*sim\.kClearSpiderKillAnt\s*,?\s*\]/u,
		'the interval winner must be cleared immediately after its snapshot in the same ordered compute group',
	);

	assert.doesNotMatch(
		`${ simulation }\n${ spiders }`,
		/\bspiderKillPos\b/u,
		'the former non-atomic kill-position buffer must not return',
	);

} );
