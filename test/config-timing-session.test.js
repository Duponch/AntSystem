import assert from 'node:assert/strict';
import test from 'node:test';

const STORAGE_KEY = 'antsystem-settings-v1';
let importSequence = 0;

function restoreGlobal( key, hadOwnProperty, previousValue ) {

	if ( hadOwnProperty ) globalThis[ key ] = previousValue;
	else delete globalThis[ key ];

}

async function withConfigEnvironment( { saved = null, search = '' }, callback ) {

	const hadStorage = Object.hasOwn( globalThis, 'localStorage' );
	const previousStorage = globalThis.localStorage;
	const hadLocation = Object.hasOwn( globalThis, 'location' );
	const previousLocation = globalThis.location;
	let storedValue = saved === null ? null : JSON.stringify( saved );
	const storage = {
		get value() {

			return storedValue;

		},
		getItem( key ) {

			return key === STORAGE_KEY ? storedValue : null;

		},
		setItem( key, value ) {

			if ( key === STORAGE_KEY ) storedValue = String( value );

		},
		removeItem( key ) {

			if ( key === STORAGE_KEY ) storedValue = null;

		},
	};

	globalThis.localStorage = storage;
	globalThis.location = { search };

	try {

		importSequence ++;
		const config = await import( `../src/config.js?timing-session-${ importSequence }` );
		return await callback( config, storage );

	} finally {

		restoreGlobal( 'localStorage', hadStorage, previousStorage );
		restoreGlobal( 'location', hadLocation, previousLocation );

	}

}

test( 'CONFIG-TIMING-001 persisted strict mode never survives a new session', async () => {

	await withConfigEnvironment( {
		saved: { params: { timingMode: 'strict', maxGpuSubsteps: 13 } },
	}, ( { params } ) => {

		assert.equal( params.timingMode, 'fluid' );
		assert.equal( params.maxGpuSubsteps, 13, 'the GPU budget remains persistent' );

	} );

} );

test( 'CONFIG-TIMING-002 only an explicit strict URL starts a strict session', async () => {

	await withConfigEnvironment( {
		saved: { params: { timingMode: 'fluid', maxGpuSubsteps: 7 } },
		search: '?timing=strict',
	}, ( { params } ) => {

		assert.equal( params.timingMode, 'strict' );
		assert.equal( params.maxGpuSubsteps, 7 );

	} );

	await withConfigEnvironment( {
		saved: { params: { timingMode: 'strict' } },
		search: '?timing=unexpected',
	}, ( { params } ) => {

		assert.equal( params.timingMode, 'fluid' );

	} );

} );

test( 'CONFIG-TIMING-003 saving excludes session timing but keeps the GPU budget', async () => {

	await withConfigEnvironment( { search: '?timing=strict' }, ( config, storage ) => {

		config.params.maxGpuSubsteps = 11;
		config.saveSettings();

		const saved = JSON.parse( storage.value );
		assert.equal( Object.hasOwn( saved.params, 'timingMode' ), false );
		assert.equal( saved.params.maxGpuSubsteps, 11 );
		assert.equal( config.params.timingMode, 'strict', 'saving does not mutate the active session' );

	} );

} );
