import test from 'node:test';
import assert from 'node:assert/strict';

import {
	stableRootForce,
	supportFrameFromContacts,
} from '../src/chameleon-lab/hybrid-controller-model.js';

test( 'CHAMELEON-LAB-CONTROLLER-ALLOC-001 support output is stable and numerically identical', () => {

	const positions = new Float32Array( [
		-0.4, 0.1, -0.3,
		0.6, 0.2, -0.2,
		-0.3, 0.4, 0.5,
		0.7, 0.3, 0.6,
	] );
	const normals = new Float32Array( [
		0.1, 0.98, 0.02,
		0.08, 0.99, -0.03,
		-0.04, 0.97, 0.12,
		0.02, 0.96, 0.08,
	] );
	const active = new Uint8Array( [ 1, 0, 1, 1 ] );
	const immutable = supportFrameFromContacts( positions, normals, active );
	assert.ok( Object.isFrozen( immutable ) );
	assert.ok( Object.isFrozen( immutable.centroid ) );
	assert.ok( Object.isFrozen( immutable.normal ) );

	const output = {
		count: -1,
		centroid: { x: NaN, y: NaN, z: NaN },
		normal: { x: NaN, y: NaN, z: NaN },
	};
	const centroidIdentity = output.centroid;
	const normalIdentity = output.normal;
	for ( let iteration = 0; iteration < 512; iteration ++ ) {

		const returned = supportFrameFromContacts( positions, normals, active, output );
		assert.strictEqual( returned, output );
		assert.strictEqual( returned.centroid, centroidIdentity );
		assert.strictEqual( returned.normal, normalIdentity );
		assert.deepEqual( returned, immutable );

	}
	assert.equal( Object.isFrozen( output ), false );
	assert.equal( Object.isFrozen( output.centroid ), false );
	assert.equal( Object.isFrozen( output.normal ), false );

	active.fill( 0 );
	const emptyImmutable = supportFrameFromContacts( positions, normals, active );
	assert.strictEqual( supportFrameFromContacts( positions, normals, active, output ), output );
	assert.deepEqual( output, emptyImmutable );
	assert.deepEqual( output, {
		count: 0,
		centroid: { x: 0, y: 0, z: 0 },
		normal: { x: 0, y: 1, z: 0 },
	} );
	assert.throws(
		() => supportFrameFromContacts( positions, normals, active, {} ),
		/output\.centroid/u,
	);

} );

test( 'CHAMELEON-LAB-CONTROLLER-ALLOC-002 force output is stable and exactly matches immutable API', () => {

	const output = { x: NaN, y: NaN, z: NaN };
	for ( let iteration = 0; iteration < 512; iteration ++ ) {

		const options = {
			error: {
				x: Math.sin( iteration * 0.19 ) * 2.5,
				y: Math.cos( iteration * 0.11 ) * 1.75,
				z: Math.sin( iteration * 0.07 + 0.3 ),
			},
			velocity: {
				x: Math.cos( iteration * 0.13 ) * 0.8,
				y: Math.sin( iteration * 0.17 ) * 0.6,
				z: Math.cos( iteration * 0.05 ) * 0.9,
			},
			mass: 0.25 + ( iteration % 9 ) * 0.17,
			frequency: ( iteration % 13 ) * 0.7,
			dampingRatio: ( iteration % 7 ) * 0.31,
			maximumAcceleration: ( iteration % 11 ) * 3.2,
		};
		const immutable = stableRootForce( options );
		assert.ok( Object.isFrozen( immutable ) );
		const returned = stableRootForce( options, output );
		assert.strictEqual( returned, output );
		assert.deepEqual( returned, immutable );

	}
	assert.equal( Object.isFrozen( output ), false );
	assert.throws(
		() => stableRootForce( {
			error: { x: 0, y: 0, z: 0 },
			velocity: { x: 0, y: 0, z: 0 },
			mass: 1,
			frequency: 1,
		}, 1 ),
		/force output/u,
	);

} );
