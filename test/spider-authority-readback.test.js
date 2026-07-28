import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = ( relativePath ) => readFile( new URL( relativePath, import.meta.url ), 'utf8' );

function extractFunction( source, name ) {

	const signature = new RegExp( `(?:async\\s+)?function\\s+${ name }\\s*\\(`, 'u' );
	const match = signature.exec( source );
	assert.ok( match, `${ name } function not found` );

	let signatureDepth = 1;
	let signatureEnd = match.index + match[ 0 ].length;
	for ( ; signatureEnd < source.length && signatureDepth > 0; signatureEnd ++ ) {

		if ( source[ signatureEnd ] === '(' ) signatureDepth ++;
		else if ( source[ signatureEnd ] === ')' ) signatureDepth --;

	}
	assert.equal( signatureDepth, 0, `${ name } signature not closed` );

	const open = source.indexOf( '{', signatureEnd );
	assert.ok( open >= 0, `${ name } body not found` );

	let depth = 0;
	let quote = '';
	let escaped = false;
	let lineComment = false;
	let blockComment = false;

	for ( let index = open; index < source.length; index ++ ) {

		const char = source[ index ];
		const next = source[ index + 1 ];

		if ( lineComment ) {

			if ( char === '\n' ) lineComment = false;
			continue;

		}
		if ( blockComment ) {

			if ( char === '*' && next === '/' ) {

				blockComment = false;
				index ++;

			}
			continue;

		}
		if ( quote ) {

			if ( escaped ) escaped = false;
			else if ( char === '\\' ) escaped = true;
			else if ( char === quote ) quote = '';
			continue;

		}
		if ( char === '/' && next === '/' ) {

			lineComment = true;
			index ++;
			continue;

		}
		if ( char === '/' && next === '*' ) {

			blockComment = true;
			index ++;
			continue;

		}
		if ( char === '\'' || char === '"' || char === '`' ) {

			quote = char;
			continue;

		}
		if ( char === '{' ) depth ++;
		else if ( char === '}' && -- depth === 0 ) return source.slice( match.index, index + 1 );

	}

	assert.fail( `${ name } closing brace not found` );

}

const countMatches = ( source, pattern ) => [ ... source.matchAll( pattern ) ].length;

test( 'TIME-SCALE-RUNTIME-005 a combined spider boundary performs one GPU-to-CPU readback', async () => {

	const spiders = await readSource( '../src/spiders.js' );
	const sync = extractFunction( spiders, 'syncAuthoritative' );
	const snapshot = extractFunction( spiders, 'pollSnapshot' );

	assert.equal(
		countMatches( sync, /\bpollSnapshot\s*\(/gu ),
		1,
		'syncAuthoritative must reconcile ants and damage through one snapshot',
	);
	assert.doesNotMatch(
		sync,
		/\bpoll(?:Ants|Damage)\s*\(/u,
		'the authoritative boundary must not fall back to separate readbacks',
	);
	assert.match( sync, /\bpollSnapshot\s*\(\s*\{\s*ants\s*,\s*damage\s*\}/u );
	assert.equal(
		countMatches( snapshot, /\brenderer\s*\.\s*getArrayBufferAsync\s*\(/gu ),
		1,
		'pollSnapshot must map exactly one packed GPU buffer',
	);
	assert.match( snapshot, /\bacquireReadback\s*\(/u );
	assert.match( snapshot, /\bfinally\b[\s\S]*?\breleaseReadback\s*\(/u );

} );

test( 'SPIDER-AUTHORITY-003 damage capture and acknowledgement share one ordered compute group', async () => {

	const spiders = await readSource( '../src/spiders.js' );
	const snapshot = extractFunction( spiders, 'pollSnapshot' );

	assert.match(
		spiders,
		/const\s+kAuthoritySnapshotWithKillAck\s*=\s*\[\s*kAuthoritySnapshot\s*,\s*sim\.kClearSpiderKillAnt\s*,?\s*\]/u,
		'the stable group must capture before acknowledging the kill winner',
	);
	assert.equal(
		countMatches( snapshot, /\brenderer\s*\.\s*compute\s*\(/gu ),
		1,
		'damage polling must submit capture and acknowledgement with one renderer.compute call',
	);
	assert.match(
		snapshot,
		/renderer\.compute\(\s*damage\s*\?\s*kAuthoritySnapshotWithKillAck\s*:\s*kAuthoritySnapshot\s*\)/u,
	);

} );

test( 'SPIDER-AUTHORITY-004 external authority cannot drain a pending relaxed readback', async () => {

	const spiders = await readSource( '../src/spiders.js' );
	const service = extractFunction( spiders, 'serviceScheduledReadback' );

	assert.match(
		service,
		/manualPoll\s*\|\|\s*externalAuthorityScheduling\s*\|\|\s*scheduledReadbackInFlight/u,
		'external authority must disable the opportunistic service path',
	);
	assert.match(
		spiders,
		/setExternalAuthorityScheduling\s*\([^)]*\)\s*\{[\s\S]*?readbackEpoch\s*\+\+[\s\S]*?antPollPending\s*=\s*false[\s\S]*?damagePollPending\s*=\s*false/u,
		'enabling external authority must invalidate an in-flight relaxed result and clear pending requests',
	);

} );
