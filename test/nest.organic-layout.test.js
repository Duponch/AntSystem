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

	test( 'NEST-ORGANIC-001 branch directions and turns reject geometric motifs', () => {

		for ( const count of [ 24, K_MAX ] ) {

			const nest = buildNest( count, DEPTH, WIDTH, false );
			const headings = [];
			const turns = [];
			for ( let child = 1; child < count; child ++ ) {

				const parent = nest.parents[ child ];
				const from = nest.units[ parent ];
				const to = nest.units[ child ];
				const heading = Math.atan2( to.y - from.y, to.x - from.x );
				headings.push( heading );

				const grandParent = nest.parents[ parent ];
				if ( grandParent < 0 ) continue;
				const previous = nest.units[ grandParent ];
				const incoming = Math.atan2( from.y - previous.y, from.x - previous.x );
				turns.push( wrapAngle( heading - incoming ) );

			}

			const headingBins = new Array( 18 ).fill( 0 );
			for ( const heading of headings ) {

				const bin = Math.min( 17, Math.floor(
					( wrapAngle( heading ) + Math.PI ) / ( Math.PI * 2 ) * headingBins.length ) );
				headingBins[ bin ] ++;

			}
			const coveredDirections = headingBins.filter( ( total ) => total > 0 ).length;
			const clockwise = turns.filter( ( turn ) => turn < - 0.08 ).length;
			const counterClockwise = turns.filter( ( turn ) => turn > 0.08 ).length;
			const nearRightAngles = turns.filter( ( turn ) =>
				Math.abs( Math.abs( turn ) - Math.PI / 2 ) < Math.PI / 15 ).length;
			const minimumDirections = count === 24 ? 12 : 16;

			assert.ok( coveredDirections >= minimumDirections,
				'K' + count + ' covers only ' + coveredDirections + '/18 macroscopic directions' );
			assert.ok( Math.max( ...headingBins ) / headings.length <= 0.2,
				'K' + count + ' retained a dominant geometric axis' );
			assert.ok( clockwise >= Math.floor( turns.length * 0.3 )
				&& counterClockwise >= Math.floor( turns.length * 0.3 ),
				'K' + count + ' turn handedness is biased (' + clockwise + '/' + counterClockwise + ')' );
			assert.ok( nearRightAngles / turns.length <= 0.25,
				'K' + count + ' has ' + nearRightAngles + '/' + turns.length + ' near-right-angle turns' );
			const absoluteTurns = turns.map( Math.abs );
			assert.ok( Math.min( ...absoluteTurns ) <= 20 * Math.PI / 180,
				'K' + count + ' lacks gently curving branches' );
			assert.ok( Math.max( ...absoluteTurns ) >= 120 * Math.PI / 180,
				'K' + count + ' lacks strongly meandering branches' );

		}

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