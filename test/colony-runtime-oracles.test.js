import assert from 'node:assert/strict';
import test from 'node:test';

import { undergroundConfinementIssue } from '../src/tests.js';
import {
	planHatchActivation,
	validateHatchActivationResult,
} from '../src/colony.js';

test( 'COL-HATCH-001 partial async activation keeps the unaccepted hatchlings pending', () => {

	const accepted = validateHatchActivationResult( 7, 3 );
	assert.equal( accepted, 3 );
	assert.deepEqual(
		planHatchActivation( {
			hatched: 7,
			activatedHatch: accepted,
			antCount: 13,
			maxPopulation: 20,
		} ),
		{ activateCount: 4, pendingHatch: 4 },
	);

} );

test( 'COL-HATCH-002 activation hooks must report an exact bounded integer', () => {

	for ( const invalid of [ undefined, NaN, - 1, 2.5, 5 ] ) {

		assert.throws(
			() => validateHatchActivationResult( 4, invalid ),
			RangeError,
		);

	}

} );

function nodeState( node ) {

	return 8 | ( node << 7 );

}

test( 'COL-CONFINEMENT-001 a legitimate adaptive-nest chamber may exceed 130 texels', () => {

	const layout = {
		navigation: {
			texel: 0.15625,
			nodes: [
				{ x: 512, y: 512, depth: 0, radius: 5 },
				{ x: 660, y: 560, depth: - 12, radius: 8 },
			],
			corridors: [],
		},
	};
	assert.ok( Math.hypot( 660 - 512, 560 - 512 ) > 130 );
	assert.equal(
		undergroundConfinementIssue(
			layout, 7, nodeState( 1 ),
			new Float32Array( [ 660, 560, 0, 0 ] ),
			new Float32Array( [ 0, 0, - 12, 0 ] ),
		),
		null,
	);

} );

test( 'COL-CONFINEMENT-002 the intrinsic oracle rejects a teleport outside its encoded node', () => {

	const layout = {
		navigation: {
			texel: 0.15625,
			nodes: [ { x: 660, y: 560, depth: - 12, radius: 8 } ],
			corridors: [],
		},
	};
	assert.match(
		undergroundConfinementIssue(
			layout, 7, nodeState( 0 ),
			new Float32Array( [ 680, 560, 0, 0 ] ),
			new Float32Array( [ 0, 0, - 12, 0 ] ),
		),
		/hors patch/,
	);

} );
test( 'COL-CONFINEMENT-003 the queen may use the full physical royal chamber', () => {

	const texel = 0.15625;
	const unit = {
		x: 540, y: 480, depth: - 19, rwx: 3.15, rwz: 3.24, rh: 1.1,
	};
	const layout = {
		units: [ unit ],
		navigation: {
			texel,
			nodes: [
				{ x: 0, y: 0, depth: 0, radius: 5 },
				{ x: 0, y: 0, depth: - 2, radius: 5 },
				{ x: unit.x, y: unit.y, depth: unit.depth, radius: 8 },
			],
			corridors: [],
		},
	};
	const queenX = unit.x + 15;
	assert.ok( queenX - unit.x > layout.navigation.nodes[ 2 ].radius * 0.5 + 0.1 );
	assert.equal(
		undergroundConfinementIssue(
			layout, 0, nodeState( 2 ),
			new Float32Array( [ queenX, unit.y, 0, 0 ] ),
			new Float32Array( [ 0, 0, unit.depth, 0 ] ),
		),
		null,
	);

} );