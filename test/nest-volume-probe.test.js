import assert from 'node:assert/strict';
import test from 'node:test';

import { DataUtils } from 'three';
import {
	assessCleanSurfaceTriplet,
	assessNestVolumeBakeFreshness,
	halfFloatToNumber,
	nestVolumeLayoutSignature,
	readFilteredVolumeChannel,
	trilinearVolumeSample,
	volumeProbeThresholds,
	volumeVoxelCenter,
	worldToVolumeSample,
} from '../src/navigation/nest-volume-probe.js';

const BOUNDS = {
	min: { x: - 4, y: - 2, z: 10 },
	size: { x: 8, y: 4, z: 12 },
};
const DIMENSIONS = { x: 4, y: 2, z: 3 };

test( 'NAV-VOLUME-GPU-001 world-to-voxel mapping matches texture3D centre addressing on every axis', () => {

	const first = volumeVoxelCenter( { x: 0, y: 0, z: 0 }, BOUNDS, DIMENSIONS );
	assert.deepEqual( first, { x: - 3, y: - 1, z: 12 } );
	const mapped = worldToVolumeSample( first, BOUNDS, DIMENSIONS );

	for ( const axis of [ 'x', 'y', 'z' ] ) {

		assert.equal( mapped[ axis ].coordinate, 0 );
		assert.equal( mapped[ axis ].low, 0 );
		assert.equal( mapped[ axis ].high, 1 );
		assert.equal( mapped[ axis ].fraction, 0 );

	}

	const last = volumeVoxelCenter( { x: 3, y: 1, z: 2 }, BOUNDS, DIMENSIONS );
	const lastMapped = worldToVolumeSample( last, BOUNDS, DIMENSIONS );
	assert.equal( lastMapped.x.coordinate, 3 );
	assert.equal( lastMapped.y.coordinate, 1 );
	assert.equal( lastMapped.z.coordinate, 2 );
	assert.equal( lastMapped.x.high, 3 );
	assert.equal( lastMapped.y.high, 1 );
	assert.equal( lastMapped.z.high, 2 );

	const edge = worldToVolumeSample( BOUNDS.min, BOUNDS, DIMENSIONS );
	assert.equal( edge.x.coordinate, - 0.5 );
	assert.equal( edge.x.low, 0 );
	assert.equal( edge.x.high, 0 );
	assert.equal( edge.x.fraction, 0.5 );

} );

test( 'NAV-VOLUME-GPU-002 rgba16float decoding and trilinear reconstruction preserve clean-channel signs', () => {

	assert.equal( halfFloatToNumber( 0x0000 ), 0 );
	assert.equal( halfFloatToNumber( 0x3c00 ), 1 );
	assert.equal( halfFloatToNumber( 0xc000 ), - 2 );
	assert.equal( halfFloatToNumber( 0x3800 ), 0.5 );
	assert.equal( halfFloatToNumber( 0xb800 ), - 0.5 );
	assert.equal( halfFloatToNumber( 0x7c00 ), Infinity );
	assert.ok( Number.isNaN( halfFloatToNumber( 0x7e00 ) ) );

	const corners = {};
	for ( const z of [ 0, 1 ] )
		for ( const y of [ 0, 1 ] )
			for ( const x of [ 0, 1 ] )
				corners[ `${ x }${ y }${ z }` ] = - 2 + x + 2 * y + 4 * z;
	assert.equal(
		trilinearVolumeSample( corners, { x: 0.25, y: 0.5, z: 0.75 } ),
		2.25,
	);

} );

test( 'NAV-VOLUME-GPU-003 half-float/voxel tolerances accept a surface bracket and reject inverted matter', () => {

	const thresholds = volumeProbeThresholds( BOUNDS, DIMENSIONS );
	assert.deepEqual( thresholds.voxel, { x: 2, y: 2, z: 4 } );
	assert.ok( thresholds.contactTolerance < thresholds.diagonal * 0.5 );
	assert.equal( thresholds.sideOffset, 0.55 );

	const valid = assessCleanSurfaceTriplet( {
		contact: thresholds.contactTolerance * 0.2,
		air: - thresholds.signMargin * 2,
		earth: thresholds.signMargin * 2,
	}, thresholds );
	assert.equal( valid.pass, true );

	const inverted = assessCleanSurfaceTriplet( {
		contact: 0,
		air: thresholds.signMargin * 2,
		earth: - thresholds.signMargin * 2,
	}, thresholds );
	assert.equal( inverted.pass, false );
	assert.equal( inverted.checks.air, false );
	assert.equal( inverted.checks.earth, false );
	assert.equal( inverted.checks.order, false );

} );

test( 'NAV-VOLUME-GPU-004 readback uses x/y/z texture axes and channel G before trilinear filtering', async () => {

	const calls = [];
	const backend = {
		async copyTextureToBuffer( texture, x, y, width, height, z ) {

			calls.push( { texture, x, y, width, height, z } );
			const data = new Uint16Array( 4 );
			data[ 0 ] = DataUtils.toHalfFloat( - 999 );
			data[ 1 ] = DataUtils.toHalfFloat( x + 2 * y + 4 * z );
			return data;

		},
	};
	const texture = {};
	const value = await readFilteredVolumeChannel( {
		renderer: { backend },
		texture,
		point: { x: 1.75, y: 1.75, z: 1.75 },
		bounds: {
			min: { x: 0, y: 0, z: 0 },
			size: { x: 4, y: 4, z: 4 },
		},
		dimensions: { x: 4, y: 4, z: 4 },
		channel: 1,
	} );

	assert.equal( value, 8.75 );
	assert.equal( calls.length, 8 );
	assert.ok( calls.every( ( call ) =>
		call.texture === texture && call.width === 1 && call.height === 1 ) );
	assert.deepEqual( [ ... new Set( calls.map( ( call ) => call.x ) ) ].sort(), [ 1, 2 ] );
	assert.deepEqual( [ ... new Set( calls.map( ( call ) => call.y ) ) ].sort(), [ 1, 2 ] );
	assert.deepEqual( [ ... new Set( calls.map( ( call ) => call.z ) ) ].sort(), [ 1, 2 ] );

} );

test( 'NAV-VOLUME-GPU-005 the bake signature changes with every rendered clean primitive or bound', () => {

	const input = {
		layout: {
			K: 1,
			tunnelW: 6,
			units: [ { x: 12, y: 18, depth: - 4, rh: 1.2, rwx: 2.4, rwz: 2.1 } ],
			navigation: {
				corridors: [ null, {
					radius: 6,
					capsulePoints: [
						{ x: 10, y: 16, depth: 0 },
						{ x: 11, y: 17, depth: - 2 },
						{ x: 12, y: 18, depth: - 4 },
					],
				} ],
			},
		},
		bounds: BOUNDS,
		dimensions: DIMENSIONS,
		texel: 0.15625,
		world: 160,
		grid: 1024,
		chamberCount: 1,
	};
	const signature = nestVolumeLayoutSignature( input );
	assert.match( signature, /^nv1-[0-9a-f]{32}-c1-s2$/ );
	assert.equal( nestVolumeLayoutSignature( structuredClone( input ) ), signature );

	const inactive = structuredClone( input );
	inactive.layout.units.push(
		{ x: 90, y: 90, depth: - 12, rh: 2, rwx: 3, rwz: 3 } );
	assert.equal( nestVolumeLayoutSignature( inactive ), signature,
		'an inactive registry suffix is not part of the rendered prefix' );

	const movedCapsule = structuredClone( input );
	movedCapsule.layout.navigation.corridors[ 1 ].capsulePoints[ 1 ].depth -= 0.01;
	assert.notEqual( nestVolumeLayoutSignature( movedCapsule ), signature );

	const movedChamber = structuredClone( input );
	movedChamber.layout.units[ 0 ].rwx += 0.01;
	assert.notEqual( nestVolumeLayoutSignature( movedChamber ), signature );

	const changedBounds = structuredClone( input );
	changedBounds.bounds.size.y += 0.01;
	assert.notEqual( nestVolumeLayoutSignature( changedBounds ), signature );

} );

test( 'NAV-VOLUME-GPU-006 publication revision and signature both invalidate stale bakes', () => {

	const bake = {
		bakeRevision: 7,
		layoutRevision: 3,
		layoutSignature: 'nv1-test',
	};
	const current = { layoutRevision: 3, layoutSignature: 'nv1-test' };
	assert.equal( assessNestVolumeBakeFreshness( bake, current ).pass, true );

	const republished = assessNestVolumeBakeFreshness(
		bake, { ... current, layoutRevision: 4 } );
	assert.equal( republished.pass, false );
	assert.equal( republished.checks.layoutRevision, false );

	const directlyMutated = assessNestVolumeBakeFreshness(
		bake, { ... current, layoutSignature: 'nv1-mutated' } );
	assert.equal( directlyMutated.pass, false );
	assert.equal( directlyMutated.checks.layoutSignature, false );

	const missing = assessNestVolumeBakeFreshness( null, current );
	assert.equal( missing.pass, false );
	assert.equal( missing.checks.baked, false );

} );