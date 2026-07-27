import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TEXEL } from '../src/config.js';
import {
	K_MAX,
	buildNest,
	tunnelPath,
} from '../src/nest.js';
import {
	SDF_RADIUS_SCALE,
	buildCorridorNetwork,
} from '../src/navigation/corridor-network.js';
import {
	chamberPrimitive,
	chamberPrimitives,
	corridorCapsuleRadii,
	corridorCapsuleSegments,
} from '../src/navigation/support-geometry.js';

const DEPTH = 19;
const WIDTH = 6;
const EPS = 1e-6;

const quantize = ( value, step = 0.02 ) => Math.round( value / step );

function branchShapeSignature( units, series ) {

	const first = series * 4;
	const vectors = [];
	for ( let level = 1; level < 4; level ++ ) {

		const a = units[ first + level - 1 ];
		const b = units[ first + level ];
		const dx = ( b.x - a.x ) * TEXEL;
		const dz = ( b.y - a.y ) * TEXEL;
		vectors.push( [
			quantize( Math.hypot( dx, dz ), 0.1 ),
			quantize( Math.atan2( dz, dx ), 0.04 ),
		] );

	}
	const initialAngle = vectors[ 0 ][ 1 ];
	return vectors.map( ( [ length, angle ] ) =>
		`${ Math.round( length / 10 ) }:${ Math.round( ( angle - initialAngle ) / 5 ) }` ).join( '|' );

}

function wrapAngle( angle ) {

	return Math.atan2( Math.sin( angle ), Math.cos( angle ) );

}

function maximumLateralDeviationWorld( path ) {

	const first = path[ 0 ], last = path[ path.length - 1 ];
	const dx = last.x - first.x, dz = last.y - first.y;
	const length = Math.hypot( dx, dz );
	if ( length <= EPS ) return 0;
	let maximum = 0;
	for ( const point of path ) {

		const cross = Math.abs(
			( point.x - first.x ) * dz - ( point.y - first.y ) * dx ) / length;
		maximum = Math.max( maximum, cross * TEXEL );

	}
	return maximum;

}

describe( 'deterministic organic nest morphology', () => {

	test( 'NEST-ORGANIC-001 branch silhouettes are deterministic and non-repeating', () => {

		const first = buildNest( K_MAX, DEPTH, WIDTH, false );
		const repeated = buildNest( K_MAX, DEPTH, WIDTH, false );
		assert.deepEqual( repeated.units, first.units );
		assert.deepEqual( repeated.parents, first.parents );

		const signatures = new Set();
		const headings = new Set();
		const turns = [];
		let clockwise = 0, counterClockwise = 0, nearRightAngles = 0;
		for ( let series = 0; series < K_MAX / 4; series ++ ) {

			signatures.add( branchShapeSignature( first.units, series ) );
			const firstIndex = series * 4;
			const directions = [];
			for ( let level = 1; level < 4; level ++ ) {

				const a = first.units[ firstIndex + level - 1 ];
				const b = first.units[ firstIndex + level ];
				const heading = Math.atan2( b.y - a.y, b.x - a.x );
				directions.push( heading );
				headings.add( Math.floor(
					( wrapAngle( heading ) + Math.PI ) / ( Math.PI * 2 ) * 18 ) );

			}
			for ( let index = 1; index < directions.length; index ++ ) {

				const turn = wrapAngle( directions[ index ] - directions[ index - 1 ] );
				turns.push( turn );
				if ( turn < - 0.08 ) clockwise ++;
				if ( turn > 0.08 ) counterClockwise ++;
				if ( Math.abs( Math.abs( turn ) - Math.PI / 2 ) < Math.PI / 15 )
					nearRightAngles ++;

			}

		}
		assert.ok( signatures.size >= 14,
			`organic registry retained only ${ signatures.size } distinct branch silhouettes` );
		assert.ok( headings.size >= 12,
			`branch axes cover only ${ headings.size }/18 macroscopic directions` );
		assert.ok( clockwise >= 14 && counterClockwise >= 14,
			`turn handedness remained biased (${ clockwise } clockwise, ${ counterClockwise } counter-clockwise)` );
		assert.ok( nearRightAngles <= Math.floor( turns.length * 0.25 ),
			`${ nearRightAngles }/${ turns.length } turns still reproduce the right-angle motif` );
		const absoluteTurns = turns.map( Math.abs );
		assert.ok( Math.min( ... absoluteTurns ) <= 78 * Math.PI / 180 );
		assert.ok( Math.max( ... absoluteTurns ) >= 112 * Math.PI / 180 );

	} );

	test( 'NEST-ORGANIC-002 chambers use bounded asymmetric lobes', () => {

		const nest = buildNest( K_MAX, DEPTH, WIDTH, false );
		const morphology = new Set();
		for ( const unit of nest.units ) {

			const envelope = chamberPrimitive( unit );
			const lobes = chamberPrimitives( unit );
			assert.equal( lobes.length, 3 );
			for ( const lobe of lobes ) {

				assert.equal( lobe.floorDepth, envelope.floorDepth );
				assert.ok( Math.abs( lobe.offsetX ) + lobe.radiusX
					<= envelope.radiusX + EPS );
				assert.ok( Math.abs( lobe.offsetZ ) + lobe.radiusZ
					<= envelope.radiusZ + EPS );
				assert.ok( lobe.centerDepth + lobe.radiusY
					<= envelope.centerDepth + envelope.radiusY + EPS );

			}
			morphology.add( lobes.map( ( lobe ) => [
				quantize( lobe.offsetX ),
				quantize( lobe.offsetZ ),
				quantize( lobe.radiusX ),
				quantize( lobe.radiusZ ),
			].join( ':' ) ).join( '|' ) );

		}
		assert.ok( morphology.size >= 72,
			`only ${ morphology.size } chamber morphologies were generated` );

	} );

	test( 'NEST-ORGANIC-003 tunnel axes have visible bounded sinuosity', () => {

		const nest = buildNest( K_MAX, DEPTH, WIDTH, false );
		const deviations = [];
		for ( let k = 1; k < K_MAX; k ++ ) {

			const parent = nest.parents[ k ];
			const a = parent < 0 ? nest.shaft : nest.units[ parent ];
			const b = nest.units[ k ];
			deviations.push( maximumLateralDeviationWorld(
				tunnelPath( a, b, k, 48 ) ) );

		}
		deviations.sort( ( a, b ) => a - b );
		assert.ok( deviations[ Math.floor( deviations.length * 0.5 ) ] >= 0.42 );
		// The deterministic 3D router may select a larger lateral detour when a
		// direct organic arc would intersect another chamber or gallery. Such
		// exceptions stay rare and bounded at the scale of the whole nest.
		assert.ok( deviations.filter( ( deviation ) => deviation > 3 ).length <= 10 );
		assert.ok( deviations.at( - 1 ) <= 8 );

	} );

	test( 'NEST-ORGANIC-004 tunnel radius profiles are smooth, varied and clearance-safe', () => {

		const nest = buildNest( K_MAX, DEPTH, WIDTH, false );
		const network = buildCorridorNetwork( nest, { samples: 16, maxNodes: 128 } );
		let varied = 0;
		for ( const corridor of network.corridors.filter( Boolean ) ) {

			const segments = corridorCapsuleSegments( corridor );
			const radii = corridorCapsuleRadii(
				corridor, TEXEL, SDF_RADIUS_SCALE, segments.length );
			assert.equal( radii.length, segments.length );
			const base = corridor.radius * TEXEL * SDF_RADIUS_SCALE;
			assert.ok( radii.every( ( radius ) => radius >= base - EPS ) );
			for ( let index = 1; index < radii.length; index ++ )
				assert.ok( Math.abs( radii[ index ] - radii[ index - 1 ] ) <= 0.09 );
			if ( Math.max( ...radii ) - Math.min( ...radii ) >= 0.035 ) varied ++;

		}
		// Portal collars stay deliberately cylindrical; the majority of free spans
		// must still expose a measurable organic radius profile.
		assert.ok( varied >= Math.floor( network.corridors.filter( Boolean ).length * 0.6 ) );
	} );

	test( 'NEST-ORGANIC-005 biological strata do not collapse into flat rows', () => {

		const nest = buildNest( K_MAX, DEPTH, WIDTH, false );
		const minimumRanges = [ 1.1, 1.6, 2.7, 3.8 ];
		for ( let level = 0; level < 4; level ++ ) {

			const depths = nest.units
				.filter( ( unit ) => unit.level === level )
				.map( ( unit ) => unit.depth );
			const range = Math.max( ...depths ) - Math.min( ...depths );
			assert.ok( range >= minimumRanges[ level ],
				`level ${ level } retained a flat ${ range.toFixed( 3 )}u row` );

		}

	} );

} );