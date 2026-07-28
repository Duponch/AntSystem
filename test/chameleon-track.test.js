import assert from 'node:assert/strict';
import test from 'node:test';

import {
	CHAMELEON_TRACK_SAMPLES,
	buildChameleonTrack,
	selectChameleonHost,
} from '../src/chameleon-track.js';

function attribute( vertices ) {

	return {
		count: vertices.length,
		getX: ( index ) => vertices[ index ][ 0 ],
		getY: ( index ) => vertices[ index ][ 1 ],
		getZ: ( index ) => vertices[ index ][ 2 ],
	};

}

function logEntry( model, placements, vertices ) {

	return {
		model,
		category: 'obstacles',
		placements,
		mesh: {
			geometry: {
				getAttribute: ( name ) => name === 'position' ? attribute( vertices ) : null,
			},
		},
	};

}

const LOG_VERTICES = [
	[ - 0.3, 0, - 0.5 ], [ 0, 0.45, - 0.5 ], [ 0.3, 0, - 0.5 ],
	[ - 0.3, 0, - 0.25 ], [ 0, 0.6, - 0.25 ], [ 0.3, 0, - 0.25 ],
	[ - 0.3, 0, 0 ], [ 0, 0.5, 0 ], [ 0.3, 0, 0 ],
	[ - 0.3, 0, 0.25 ], [ 0, 0.7, 0.25 ], [ 0.3, 0, 0.25 ],
	[ - 0.3, 0, 0.5 ], [ 0, 0.48, 0.5 ], [ 0.3, 0, 0.5 ],
];

test( 'CHAMELEON-SIM-010 host selection prioritises tag then Log_01 then Log_02', () => {

	const log1 = logEntry( 'Log_01', [ { x: 1, z: 2, scale: 3 } ], LOG_VERTICES );
	const log2 = logEntry( 'Log_02', [ { x: 4, z: 5, scale: 6 } ], LOG_VERTICES );
	assert.equal( selectChameleonHost( [ log2, log1 ] ).entry, log1 );

	log2.placements[ 0 ].tag = 'chameleon-host';
	const tagged = selectChameleonHost( [ log1, log2 ] );
	assert.equal( tagged.entry, log2 );
	assert.equal( tagged.placement, log2.placements[ 0 ] );
	assert.equal( selectChameleonHost( [] ), null );

} );

test( 'CHAMELEON-SIM-011 log relief is sampled once into fixed world-space SoA', () => {

	const entry = logEntry(
		'Log_01',
		[ { x: 10, z: - 4, yaw: Math.PI * 0.5, scale: 8 } ],
		LOG_VERTICES,
	);
	const track = buildChameleonTrack(
		{ entry, index: 0, placement: entry.placements[ 0 ] },
		{ scales: { obstacles: 0.5 } },
	);

	assert.equal( track.count, CHAMELEON_TRACK_SAMPLES );
	assert.ok( track.x instanceof Float32Array );
	assert.ok( track.y instanceof Float32Array );
	assert.ok( track.z instanceof Float32Array );
	assert.ok( track.normalY instanceof Float32Array );
	assert.ok( track.distance instanceof Float32Array );
	assert.equal( track.x.length, CHAMELEON_TRACK_SAMPLES );
	assert.ok( track.length > 3 );
	assert.ok( track.x[ 0 ] < track.x[ track.count - 1 ], 'yaw rotates local +Z into world +X' );
	assert.ok( Math.abs( track.z[ 0 ] + 4 ) < 0.0001 );

	for ( let index = 0; index < track.count; index ++ ) {

		assert.ok( Number.isFinite( track.x[ index ] ) );
		assert.ok( Number.isFinite( track.y[ index ] ) );
		assert.ok( track.normalY[ index ] > 0.25 );
		if ( index > 0 ) assert.ok( track.distance[ index ] > track.distance[ index - 1 ] );

	}
	const heightRange = Math.max( ...track.y ) - Math.min( ...track.y );
	assert.ok( heightRange > 0.1, 'the irregular top profile must survive smoothing' );

} );

test( 'CHAMELEON-SIM-012 track sampling follows edited placement and category scale', () => {

	const placement = { x: - 2, y: 1, z: 3, yaw: 0, scale: 10 };
	const entry = logEntry( 'Log_02', [ placement ], LOG_VERTICES );
	const host = { entry, index: 0, placement };
	const base = buildChameleonTrack( host, { sampleCount: 12 } );
	const scaled = buildChameleonTrack( host, {
		sampleCount: 12,
		scales: { obstacles: 1.5 },
	} );

	assert.equal( base.count, 12 );
	assert.equal( scaled.count, 12 );
	assert.ok( scaled.length > base.length * 1.49 );
	assert.ok( scaled.y[ 6 ] - 1 > ( base.y[ 6 ] - 1 ) * 1.49 );

} );
