import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildCorridorNetwork,
	CORRIDOR_SAMPLES,
	CORRIDOR_SURFACE_TRACKS,
	sampleCorridorSurface,
} from '../src/navigation/corridor-network.js';
import {
	corridorContactWorld,
	createCorridorSurfaceOracle,
} from '../src/navigation/support-geometry.js';
import { MIN_NEST_DEPTH, TEXEL } from '../src/config.js';
import { buildNest, K_MAX } from '../src/nest.js';
import { makeIrregularNest, makeNest } from './helpers/corridor-fixtures.js';

const EPS = 2e-5;
const SDF_KNOT_EPS_WORLD = 2e-5;
const SDF_INTERPOLATION_EPS_WORLD = 0.02;
const MAX_SURFACE_STRETCH = 1.10;

function dot( a, b ) {

	return a.x * b.x + a.y * b.y + a.z * b.z;

}

function length3( v ) {

	return Math.hypot( v.x, v.y, v.z );

}

function angleOfTrack( track ) {

	return track / CORRIDOR_SURFACE_TRACKS * Math.PI * 2;

}

function assertFiniteVector( value, label ) {

	for ( const component of [ 'x', 'y', 'z' ] )
		assert.ok( Number.isFinite( value[ component ] ), `${ label }.${ component } must be finite` );

}

function metricDistance( a, b, texel ) {

	return Math.hypot(
		a.x - b.x,
		a.y - b.y,
		( a.depth - b.depth ) / texel,
	);

}

let sharedIrregularFixture = null;

function irregularFixture() {

	if ( ! sharedIrregularFixture ) {

		const nest = makeIrregularNest();
		sharedIrregularFixture = {
			nest,
			network: buildCorridorNetwork( nest, { samples: CORRIDOR_SAMPLES } ),
		};

	}
	return sharedIrregularFixture;

}

test( 'NAV-SURFACE-001 transported corridor frames stay orthonormal without flips', () => {

	const network = irregularFixture().network;

	for ( const corridor of network.corridors ) {

		if ( ! corridor ) continue;
		let previous = null;

		for ( const frame of corridor.frames ) {

			assert.ok( Math.abs( length3( frame.tangent ) - 1 ) < EPS );
			assert.ok( Math.abs( length3( frame.normal ) - 1 ) < EPS );
			assert.ok( Math.abs( length3( frame.binormal ) - 1 ) < EPS );
			assert.ok( Math.abs( dot( frame.tangent, frame.normal ) ) < EPS );
			assert.ok( Math.abs( dot( frame.tangent, frame.binormal ) ) < EPS );
			assert.ok( Math.abs( dot( frame.normal, frame.binormal ) ) < EPS );
			if ( previous ) assert.ok(
				dot( previous, frame.normal ) > - 0.05,
				'frame flipped by 180 degrees',
			);
			previous = frame.normal;

		}

	}

} );

test( 'NAV-SURFACE-002 direct contact/support tables produce finite orthonormal poses on all 12 tracks', () => {

	const network = irregularFixture().network;

	assert.equal( network.samples, CORRIDOR_SAMPLES );
	assert.equal( network.surfaceTracks, CORRIDOR_SURFACE_TRACKS );
	assert.equal( CORRIDOR_SURFACE_TRACKS, 12 );

	for ( let edgeId = 1; edgeId < network.corridors.length; edgeId ++ ) {

		const corridor = network.corridors[ edgeId ];
		assert.equal(
			corridor.surfaceTracks.length,
			CORRIDOR_SURFACE_TRACKS * CORRIDOR_SAMPLES * 4,
		);
		assert.equal(
			corridor.surfaceSupports.length,
			CORRIDOR_SURFACE_TRACKS * CORRIDOR_SAMPLES * 4,
		);
		assert.equal( corridor.surfaceLengths.length, CORRIDOR_SURFACE_TRACKS );

		for ( let track = 0; track < CORRIDOR_SURFACE_TRACKS; track ++ ) {

			const angle = angleOfTrack( track );
			let previousAxisT = - Infinity;

			for ( let index = 0; index < CORRIDOR_SAMPLES; index ++ ) {

				const t = index / ( CORRIDOR_SAMPLES - 1 );
				const sample = sampleCorridorSurface( network, edgeId, t, angle, 1 );
				const base = ( track * CORRIDOR_SAMPLES + index ) * 4;

				for ( const key of [
					'x', 'y', 'depth', 'centerX', 'centerY', 'centerDepth',
					'contactRadius', 'trackLength', 'axisT',
				] ) assert.ok(
					Number.isFinite( sample[ key ] ),
					`edge ${ edgeId }, track ${ track }, sample ${ index }: ${ key }`,
				);
				assertFiniteVector( sample.support, 'support' );
				assertFiniteVector( sample.tangent3, 'tangent' );
				assert.ok( Math.abs( sample.x - corridor.surfaceTracks[ base ] ) < EPS );
				assert.ok( Math.abs( sample.y - corridor.surfaceTracks[ base + 1 ] ) < EPS );
				assert.ok( Math.abs( sample.depth - corridor.surfaceTracks[ base + 2 ] ) < EPS );
				assert.ok( Math.abs( length3( sample.support ) - 1 ) < EPS );
				assert.ok( Math.abs( length3( sample.tangent3 ) - 1 ) < EPS );
				assert.ok( Math.abs( dot( sample.support, sample.tangent3 ) ) < 2e-4 );
				assert.ok( sample.axisT >= previousAxisT - EPS, 'axis progress must be monotonic' );
				assert.ok( sample.axisT >= - EPS && sample.axisT <= 1 + EPS );
				assert.ok( sample.trackLength > 0 );
				assert.ok( Math.abs(
					sample.trackLength - corridor.surfaceLengths[ track ],
				) < EPS );
				previousAxisT = sample.axisT;

				if ( index % 31 === 0 || index === CORRIDOR_SAMPLES - 1 ) {

					const reverse = sampleCorridorSurface( network, edgeId, t, angle, - 1 );
					assert.ok( metricDistance( sample, reverse, network.texel ) < EPS );
					assert.ok( dot( sample.support, reverse.support ) > 1 - EPS );
					assert.ok( dot( sample.tangent3, reverse.tangent3 ) < - 1 + 2e-4 );

				}

			}

		}

	}

} );

test( 'NAV-SURFACE-003 knots and dense interpolation remain on the clean rendered surface', () => {

	const { nest, network } = irregularFixture();
	const fractions = [ 0.25, 0.5, 0.75 ];
	let worstInterpolation = { distance: - Infinity };

	for ( let edgeId = 1; edgeId < network.corridors.length; edgeId ++ ) {

		const corridor = network.corridors[ edgeId ];
		const sdf = createCorridorSurfaceOracle( nest, corridor, network.texel );

		for ( let track = 0; track < CORRIDOR_SURFACE_TRACKS; track ++ ) {

			const angle = angleOfTrack( track );

			for ( let index = 0; index < CORRIDOR_SAMPLES; index ++ ) {

				const sample = sampleCorridorSurface(
					network, edgeId, index / ( CORRIDOR_SAMPLES - 1 ), angle, 1 );
				const distance = Math.abs( sdf(
					corridorContactWorld( sample, network.texel ) ) );
				assert.ok(
					distance <= SDF_KNOT_EPS_WORLD,
					`edge ${ edgeId }, track ${ track }, knot ${ index }: |SDF|=${ distance }`,
				);

			}

			for ( let segment = 0; segment < CORRIDOR_SAMPLES - 1; segment ++ ) {

				for ( const fraction of fractions ) {

					const t = ( segment + fraction ) / ( CORRIDOR_SAMPLES - 1 );
					const sample = sampleCorridorSurface( network, edgeId, t, angle, 1 );
					const distance = Math.abs( sdf(
						corridorContactWorld( sample, network.texel ) ) );
					if ( distance > worstInterpolation.distance )
						worstInterpolation = { distance, edgeId, track, segment, fraction };

				}

			}

		}

	}
	assert.ok(
		worstInterpolation.distance <= SDF_INTERPOLATION_EPS_WORLD,
		`edge ${ worstInterpolation.edgeId }, track ${ worstInterpolation.track }, ` +
		`segment ${ worstInterpolation.segment } + ${ worstInterpolation.fraction }:` +
		` |SDF|=${ worstInterpolation.distance }`,
	);

} );

test( 'NAV-SURFACE-004 every chamber portal converges exactly on its flat floor', () => {

	const network = irregularFixture().network;
	const EPS_PORTAL = 3e-5;

	for ( let edgeId = 1; edgeId < network.corridors.length; edgeId ++ ) {

		const corridor = network.corridors[ edgeId ];
		const endpoints = [ { t: 1, node: network.nodes[ corridor.to ] } ];
		if ( edgeId !== 1 ) endpoints.push( { t: 0, node: network.nodes[ corridor.from ] } );

		for ( const endpoint of endpoints ) {

			let reference = null;

			for ( let track = 0; track < CORRIDOR_SURFACE_TRACKS; track ++ ) {

				const sample = sampleCorridorSurface(
					network, edgeId, endpoint.t, angleOfTrack( track ), 1 );
				assert.ok( Math.abs( sample.contactRadius - corridor.contactRadius ) < EPS_PORTAL );
				assert.ok( metricDistance( sample, endpoint.node, network.texel ) < EPS_PORTAL );
				assert.ok( sample.support.z > 0.9999, 'portal support must point up from the floor' );
				if ( reference ) assert.ok(
					metricDistance( sample, reference, network.texel ) < EPS_PORTAL,
					'angular tracks must converge without an interior snap',
				);
				reference = sample;

			}

		}

	}

} );

test( 'NAV-SURFACE-007 arc-length resampling has a hard per-corridor stretch ceiling', () => {

	const network = irregularFixture().network;
	let worst = { value: 1, edge: 0 };

	for ( const corridor of network.corridors ) {

		if ( ! corridor ) continue;
		if ( corridor.maxSurfaceStretch > worst.value )
			worst = { value: corridor.maxSurfaceStretch, edge: corridor.id };

	}
	assert.ok(
		worst.value <= MAX_SURFACE_STRETCH,
		`edge ${ worst.edge }: maxSurfaceStretch=${ worst.value }`,
	);

} );

test( 'NAV-ENTRANCE-001 entrance tracks form the physical surface rim', () => {

	const network = irregularFixture().network;
	const mouth = network.corridors[ 1 ];
	const contacts = [];

	for ( let track = 0; track < CORRIDOR_SURFACE_TRACKS; track ++ ) {

		const sample = sampleCorridorSurface(
			network, 1, 0, angleOfTrack( track ), 1 );
		assert.ok( Math.abs( sample.contactRadius - mouth.contactRadius ) < EPS );
		contacts.push( sample );

	}

	for ( let track = 0; track < contacts.length; track ++ ) assert.ok(
		metricDistance(
			contacts[ track ], contacts[ ( track + 1 ) % contacts.length ], network.texel,
		) > mouth.contactRadius * 0.1,
		'mouth tracks must remain a ring instead of snapping to its centre',
	);

} );

test( 'NAV-ENTRANCE-004 an entrance too short for its throat and elbow is rejected', () => {

	const invalid = makeNest( {
		entry: { x: 0, y: 0, depth: - 0.1, layer: 0, r: 3 },
		shaft: { x: 2, y: 0, depth: - 2, layer: 0, r: 3 },
		units: [ {
			x: 18, y: 4, depth: - 4, layer: 0, R: 4,
			rwx: 1.2, rwz: 1.05, rh: 0.45,
		} ],
		parents: [ - 1 ],
		tunnelW: 6,
	} );

	assert.throws(
		() => buildCorridorNetwork( invalid, { samples: CORRIDOR_SAMPLES } ),
		/too short for its curvature-safe elbow/,
	);

} );


test( 'NAV-SURFACE-008 K96 baked tracks have continuous GPU tangents and supports', () => {

	const nest = buildNest( K_MAX, MIN_NEST_DEPTH, 6, false );
	const network = buildCorridorNetwork( nest, { samples: CORRIDOR_SAMPLES } );
	const maxSupportTurn = 18.25 * Math.PI / 180;
	const maxRawTurn = 40 * Math.PI / 180;
	const maxGpuTurn = 31 * Math.PI / 180;
	const minAxisProgress = 0.05;
	const unit = ( value, label ) => {

		const size = length3( value );
		assert.ok( size > 1e-7, `${ label } is degenerate` );
		return { x: value.x / size, y: value.y / size, z: value.z / size };

	};
	const angle = ( a, b ) => Math.acos( Math.max( - 1, Math.min( 1, dot( a, b ) ) ) );
	const projectOnSupport = ( direction, support, label ) => unit( {
		x: direction.x - support.x * dot( direction, support ),
		y: direction.y - support.y * dot( direction, support ),
		z: direction.z - support.z * dot( direction, support ),
	}, label );
	let worstSdf = 0;

	for ( const corridor of network.corridors ) {

		if ( ! corridor ) continue;
		const sdf = createCorridorSurfaceOracle( nest, corridor, network.texel );

		for ( let track = 0; track < CORRIDOR_SURFACE_TRACKS; track ++ ) {

			const pointAt = ( index ) => {

				const base = ( track * CORRIDOR_SAMPLES + index ) * 4;
				return {
					x: corridor.surfaceTracks[ base ],
					y: corridor.surfaceTracks[ base + 1 ],
					depth: corridor.surfaceTracks[ base + 2 ],
				};

			};
			const supportAt = ( index ) => {

				const base = ( track * CORRIDOR_SAMPLES + index ) * 4;
				return {
					x: corridor.surfaceSupports[ base ],
					y: corridor.surfaceSupports[ base + 1 ],
					z: corridor.surfaceSupports[ base + 2 ],
				};

			};
			const axisTAt = ( index ) =>
				corridor.surfaceSupports[ ( track * CORRIDOR_SAMPLES + index ) * 4 + 3 ];
			const segments = [];
			let previousSupport = null;
			let previousAxisT = - Infinity;

			for ( let index = 0; index < CORRIDOR_SAMPLES; index ++ ) {

				const point = pointAt( index );
				const support = unit( supportAt( index ), 'support' );
				const axisT = axisTAt( index );
				assert.ok( axisT >= previousAxisT - EPS,
					`edge ${ corridor.id }, track ${ track }: axisT went backwards` );
				previousAxisT = axisT;
				if ( previousSupport ) assert.ok(
					angle( previousSupport, support ) <= maxSupportTurn,
					`edge ${ corridor.id }, track ${ track }, support ${ index }`,
				);
				previousSupport = support;
				const distance = Math.abs( sdf( corridorContactWorld( point, network.texel ) ) );
				worstSdf = Math.max( worstSdf, distance );
				assert.ok( distance <= SDF_KNOT_EPS_WORLD,
					`edge ${ corridor.id }, track ${ track }, knot ${ index }: |SDF|=${ distance }` );

				if ( index === 0 ) continue;
				const before = pointAt( index - 1 );
				const segment = unit( {
					x: point.x - before.x,
					y: point.y - before.y,
					z: ( point.depth - before.depth ) / network.texel,
				}, 'track segment' );
				segments.push( segment );

				const axisTMean = ( axisTAt( index - 1 ) + axisT ) * 0.5;
				const axisF = axisTMean * ( corridor.axisPoints.length - 1 );
				const axisIndex = Math.min( corridor.axisPoints.length - 2, Math.floor( axisF ) );
				const axisBefore = corridor.axisPoints[ axisIndex ];
				const axisAfter = corridor.axisPoints[ axisIndex + 1 ];
				const axisDirection = unit( {
					x: axisAfter.x - axisBefore.x,
					y: axisAfter.y - axisBefore.y,
					z: ( axisAfter.depth - axisBefore.depth ) / network.texel,
				}, 'axis segment' );
				assert.ok( dot( segment, axisDirection ) > minAxisProgress,
					`edge ${ corridor.id }, track ${ track }, segment ${ index } moved backwards` );

			}

			for ( let index = 1; index < segments.length; index ++ ) {

				assert.ok( angle( segments[ index - 1 ], segments[ index ] ) <= maxRawTurn,
					`edge ${ corridor.id }, track ${ track }, raw tangent ${ index + 1 }` );
				const support = unit( supportAt( index ), 'junction support' );
				const gpuBefore = projectOnSupport(
					segments[ index - 1 ], support, 'previous GPU tangent' );
				const gpuAfter = projectOnSupport(
					segments[ index ], support, 'next GPU tangent' );
				assert.ok( angle( gpuBefore, gpuAfter ) <= maxGpuTurn,
					`edge ${ corridor.id }, track ${ track }, GPU tangent ${ index + 1 }` );

			}

		}

	}

	const mouth = network.corridors[ 1 ];
	for ( let track = 0; track < CORRIDOR_SURFACE_TRACKS; track ++ ) {

		const base = track * CORRIDOR_SAMPLES * 4;
		const point = {
			x: mouth.surfaceTracks[ base ],
			y: mouth.surfaceTracks[ base + 1 ],
			depth: mouth.surfaceTracks[ base + 2 ],
		};
		const center = mouth.axisPoints[ 0 ];
		const radius = Math.hypot(
			( point.x - center.x ) * TEXEL,
			( point.y - center.y ) * TEXEL,
			point.depth - center.depth,
		);
		assert.ok( Math.abs( radius - mouth.contactRadius * TEXEL ) <= 3e-5,
			`mouth track ${ track }: radius ${ radius }` );

	}
	assert.ok( worstSdf <= SDF_KNOT_EPS_WORLD );

} );
