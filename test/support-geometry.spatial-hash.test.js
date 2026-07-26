import assert from 'node:assert/strict';
import test from 'node:test';

import { spatialHashCellKey } from '../src/navigation/support-geometry.js';

test( 'NAV-SURFACE-PERF-001 packed spatial hash keys are exact and collision-free', () => {

	const minimum = - 32768;
	const maximum = 32767;
	const values = [
		minimum, minimum + 1, - 1024, - 1, 0, 1, 1024, maximum - 1, maximum,
	];
	const keys = new Set();

	for ( const x of values ) for ( const y of values ) for ( const z of values ) {

		const key = spatialHashCellKey( x, y, z );
		assert.ok( Number.isSafeInteger( key ) );
		assert.equal( keys.has( key ), false, `collision at ${ x },${ y },${ z }` );
		keys.add( key );

	}

	assert.equal( spatialHashCellKey( minimum, minimum, minimum ), 0 );
	assert.equal(
		spatialHashCellKey( maximum, maximum, maximum ),
		2 ** 48 - 1,
	);
	assert.equal( keys.size, values.length ** 3 );

	for ( const coordinates of [
		[ minimum - 1, 0, 0 ],
		[ maximum + 1, 0, 0 ],
		[ 0, minimum - 1, 0 ],
		[ 0, maximum + 1, 0 ],
		[ 0, 0, minimum - 1 ],
		[ 0, 0, maximum + 1 ],
		[ 0.5, 0, 0 ],
		[ Infinity, 0, 0 ],
	] ) assert.throws(
		() => spatialHashCellKey( ...coordinates ),
		RangeError,
	);

} );
