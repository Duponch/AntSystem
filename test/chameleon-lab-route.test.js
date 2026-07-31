import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
	APP_ENTRY_CHAMELEON_LAB,
	APP_ENTRY_MAIN,
	selectAppEntry,
} from '../src/app-entry.js';

const readSource = ( relativePath ) => readFile( new URL( relativePath, import.meta.url ), 'utf8' );

test( 'CHAMELEON-LAB-ROUTE-001 a bare or explicit chameleon test query selects the isolated lab', () => {

	for ( const search of [
		'?test',
		'?test=',
		'?test=chameleon',
		'?quality=high&test',
		'?test=chameleon&debug=1',
	] ) {

		assert.equal( selectAppEntry( search ), APP_ENTRY_CHAMELEON_LAB, search );

	}

} );

test( 'CHAMELEON-LAB-ROUTE-002 legacy and unknown test values keep the main application', () => {

	for ( const search of [
		'',
		'?test=colony',
		'?test=warden',
		'?test=unknown',
		'?testing=chameleon',
		'?test=CHAMELEON',
	] ) {

		assert.equal( selectAppEntry( search ), APP_ENTRY_MAIN, search );

	}

} );

test( 'CHAMELEON-LAB-ROUTE-003 bootstrap dynamically imports exactly one application graph', async () => {

	const [ html, bootstrap ] = await Promise.all( [
		readSource( '../index.html' ),
		readSource( '../src/bootstrap.js' ),
	] );

	assert.match( html, /<script\s+type="module"\s+src="\/src\/bootstrap\.js"><\/script>/u );
	assert.doesNotMatch( html, /src="\/src\/main\.js"/u );
	assert.match( bootstrap, /import\(\s*'\.\/chameleon-lab\/main\.js'\s*\)/u );
	assert.match( bootstrap, /import\(\s*'\.\/main\.js'\s*\)/u );
	assert.doesNotMatch(
		bootstrap,
		/import\s+(?:[^('"]|\n)*?from\s*['"]\.\/(?:chameleon-lab\/main|main)\.js['"]/u,
	);

} );
