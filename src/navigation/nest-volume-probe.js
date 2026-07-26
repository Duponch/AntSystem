// GPU readback probe for the clean signed-distance channel of the rendered nest.
//
// This module is deliberately dormant during normal play. It reads the eight
// half-float texels involved in one trilinear sample only when an explicit
// diagnostic (Warden or a developer console) calls runNestVolumeGpuProbe().

import { sampleCorridorSurface, SDF_RADIUS_SCALE } from './corridor-network.js';
import {
	chamberPrimitive,
	corridorCapsuleSegments,
	corridorContactWorld,
	createNestSurfaceOracle,
} from './support-geometry.js';

export const NEST_VOLUME_GPU_PROBE_ID = 'NAV-VOLUME-GPU-001';

const EPS = 1e-9;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;
const FNV64_SEED_A = 0xcbf29ce484222325n;
const FNV64_SEED_B = 0x84222325cbf29ce4n;

const clamp = ( value, low, high ) => Math.max( low, Math.min( high, value ) );
const length3 = ( value ) => Math.hypot( value.x, value.y, value.z );
const normalize3 = ( value ) => {

	const length = length3( value );
	if ( ! Number.isFinite( length ) || length <= EPS )
		throw new Error( 'Volume probe support must be a finite non-zero vector' );
	return { x: value.x / length, y: value.y / length, z: value.z / length };

};

function finiteSignatureNumber( value, label ) {

	if ( ! Number.isFinite( value ) )
		throw new Error( `Nest-volume signature ${ label } must be finite` );
	return Object.is( value, - 0 ) ? '0' : value.toPrecision( 17 );

}

function hashSignatureTokens( tokens, seed ) {

	let hash = seed;
	for ( const token of tokens ) {

		const text = String( token );
		for ( let index = 0; index < text.length; index ++ ) {

			const code = text.charCodeAt( index );
			hash ^= BigInt( code & 0xff );
			hash = ( hash * FNV64_PRIME ) & FNV64_MASK;
			hash ^= BigInt( code >>> 8 );
			hash = ( hash * FNV64_PRIME ) & FNV64_MASK;

		}
		// A separator makes ["1", "23"] distinct from ["12", "3"].
		hash ^= 0xffn;
		hash = ( hash * FNV64_PRIME ) & FNV64_MASK;

	}
	return hash.toString( 16 ).padStart( 16, '0' );

}

/**
 * Fingerprint the exact clean primitives and bounds consumed by kBake.
 * This runs only on explicit nest rebuilds/probes, never in a frame hot path.
 */
export function nestVolumeLayoutSignature( {
	layout,
	bounds,
	dimensions,
	texel,
	world,
	grid,
	chamberCount = layout?.K,
	tunnelRadiusScale = SDF_RADIUS_SCALE,
} ) {

	assertBounds( bounds );
	assertDimensions( dimensions );
	if ( ! layout || ! Array.isArray( layout.units ) )
		throw new Error( 'Nest-volume signature requires layout units' );
	if ( ! Array.isArray( layout.navigation?.corridors ) )
		throw new Error( 'Nest-volume signature requires navigation corridors' );
	if ( ! Number.isInteger( chamberCount ) || chamberCount < 0
		|| chamberCount > layout.units.length )
		throw new Error( 'Nest-volume signature chamber count is invalid' );

	const tokens = [ 'nest-volume-clean-v1' ];
	const number = ( value, label ) => tokens.push( finiteSignatureNumber( value, label ) );
	for ( const [ label, value ] of [
		[ 'texel', texel ], [ 'world', world ], [ 'grid', grid ],
		[ 'dimension.x', dimensions.x ], [ 'dimension.y', dimensions.y ],
		[ 'dimension.z', dimensions.z ],
		[ 'bounds.min.x', bounds.min.x ], [ 'bounds.min.y', bounds.min.y ],
		[ 'bounds.min.z', bounds.min.z ], [ 'bounds.size.x', bounds.size.x ],
		[ 'bounds.size.y', bounds.size.y ], [ 'bounds.size.z', bounds.size.z ],
		[ 'chamberCount', chamberCount ], [ 'tunnelRadiusScale', tunnelRadiusScale ],
	] ) number( value, label );

	for ( let index = 0; index < chamberCount; index ++ ) {

		const unit = layout.units[ index ];
		const primitive = chamberPrimitive( unit );
		tokens.push( 'chamber', index );
		for ( const [ label, value ] of [
			[ 'x', unit.x ], [ 'z', unit.y ],
			[ 'centerDepth', primitive.centerDepth ],
			[ 'floorDepth', primitive.floorDepth ],
			[ 'radiusX', primitive.radiusX ], [ 'radiusY', primitive.radiusY ],
			[ 'radiusZ', primitive.radiusZ ],
		] ) number( value, `chamber ${ index } ${ label }` );

	}

	let segmentCount = 0;
	for ( let edge = 0; edge < layout.navigation.corridors.length; edge ++ ) {

		const corridor = layout.navigation.corridors[ edge ];
		if ( ! corridor ) {

			tokens.push( 'empty-corridor', edge );
			continue;

		}
		const width = corridor.tunnelW ?? corridor.radius
			?? layout.navigation.tunnelW ?? layout.tunnelW ?? 7;
		const radius = Math.max( 0.6, width * texel * tunnelRadiusScale );
		const segments = corridorCapsuleSegments( corridor );
		tokens.push( 'corridor', edge, segments.length );
		number( radius, `corridor ${ edge } radius` );
		for ( const [ start, end ] of segments ) {

			tokens.push( 'segment', segmentCount ++ );
			for ( const [ label, value ] of [
				[ 'ax', start.x ], [ 'ay', start.depth ], [ 'az', start.y ],
				[ 'bx', end.x ], [ 'by', end.depth ], [ 'bz', end.y ],
			] ) number( value, `corridor ${ edge } ${ label }` );

		}

	}

	const a = hashSignatureTokens( tokens, FNV64_SEED_A );
	const b = hashSignatureTokens( tokens, FNV64_SEED_B );
	return `nv1-${ a }${ b }-c${ chamberCount }-s${ segmentCount }`;

}

export function assessNestVolumeBakeFreshness( bake, current ) {

	const checks = {
		baked: Number.isInteger( bake?.bakeRevision ) && bake.bakeRevision > 0,
		layoutRevision: Number.isInteger( bake?.layoutRevision )
			&& bake.layoutRevision === current?.layoutRevision,
		layoutSignature: typeof bake?.layoutSignature === 'string'
			&& bake.layoutSignature.length > 0
			&& bake.layoutSignature === current?.layoutSignature,
	};
	return {
		pass: Object.values( checks ).every( Boolean ),
		checks,
		bakeRevision: bake?.bakeRevision ?? null,
		bakedLayoutRevision: bake?.layoutRevision ?? null,
		currentLayoutRevision: current?.layoutRevision ?? null,
		bakedLayoutSignature: bake?.layoutSignature ?? null,
		currentLayoutSignature: current?.layoutSignature ?? null,
	};

}

function assertDimensions( dimensions ) {

	for ( const axis of [ 'x', 'y', 'z' ] )
		if ( ! Number.isInteger( dimensions?.[ axis ] ) || dimensions[ axis ] < 2 )
			throw new Error( `Volume probe dimension ${ axis } must be an integer >= 2` );

}

function assertBounds( bounds ) {

	for ( const axis of [ 'x', 'y', 'z' ] ) {

		if ( ! Number.isFinite( bounds?.min?.[ axis ] )
			|| ! Number.isFinite( bounds?.size?.[ axis ] )
			|| bounds.size[ axis ] <= 0 )
			throw new Error( `Volume probe bounds ${ axis } must be finite and positive` );

	}

}

export function worldToVolumeSample( point, bounds, dimensions ) {

	assertBounds( bounds );
	assertDimensions( dimensions );
	const axes = {};

	for ( const axis of [ 'x', 'y', 'z' ] ) {

		const uv = ( point[ axis ] - bounds.min[ axis ] ) / bounds.size[ axis ];
		if ( ! Number.isFinite( uv ) ) throw new Error( `Volume probe point ${ axis } must be finite` );
		// texture3D(..., uvw) with linear filtering addresses texel centres at
		// (i + 0.5) / size, hence the -0.5 before floor/fract.
		const coordinate = uv * dimensions[ axis ] - 0.5;
		const rawLow = Math.floor( coordinate );
		axes[ axis ] = {
			uv,
			coordinate,
			low: clamp( rawLow, 0, dimensions[ axis ] - 1 ),
			high: clamp( rawLow + 1, 0, dimensions[ axis ] - 1 ),
			fraction: clamp( coordinate - rawLow, 0, 1 ),
		};

	}

	return axes;

}

export function volumeVoxelCenter( index, bounds, dimensions ) {

	assertBounds( bounds );
	assertDimensions( dimensions );
	const point = {};
	for ( const axis of [ 'x', 'y', 'z' ] ) {

		if ( ! Number.isInteger( index?.[ axis ] )
			|| index[ axis ] < 0 || index[ axis ] >= dimensions[ axis ] )
			throw new Error( `Volume probe voxel ${ axis } is outside the texture` );
		point[ axis ] = bounds.min[ axis ]
			+ ( index[ axis ] + 0.5 ) / dimensions[ axis ] * bounds.size[ axis ];

	}
	return point;

}

export function halfFloatToNumber( bits ) {

	const value = Number( bits ) & 0xffff;
	const sign = ( value & 0x8000 ) === 0 ? 1 : - 1;
	const exponent = ( value >>> 10 ) & 0x1f;
	const fraction = value & 0x03ff;
	if ( exponent === 0 ) return sign * fraction * 2 ** - 24;
	if ( exponent === 0x1f ) return fraction === 0 ? sign * Infinity : NaN;
	return sign * ( 1 + fraction / 1024 ) * 2 ** ( exponent - 15 );

}

export function trilinearVolumeSample( corners, fractions ) {

	const mix = ( a, b, t ) => a + ( b - a ) * t;
	const at = ( x, y, z ) => {

		const value = corners[ `${ x }${ y }${ z }` ];
		if ( ! Number.isFinite( value ) )
			throw new Error( `Missing finite trilinear corner ${ x }${ y }${ z }` );
		return value;

	};
	const x00 = mix( at( 0, 0, 0 ), at( 1, 0, 0 ), fractions.x );
	const x10 = mix( at( 0, 1, 0 ), at( 1, 1, 0 ), fractions.x );
	const x01 = mix( at( 0, 0, 1 ), at( 1, 0, 1 ), fractions.x );
	const x11 = mix( at( 0, 1, 1 ), at( 1, 1, 1 ), fractions.x );
	return mix(
		mix( x00, x10, fractions.y ),
		mix( x01, x11, fractions.y ),
		fractions.z,
	);

}

export function volumeProbeThresholds( bounds, dimensions ) {

	assertBounds( bounds );
	assertDimensions( dimensions );
	const voxel = {
		x: bounds.size.x / dimensions.x,
		y: bounds.size.y / dimensions.y,
		z: bounds.size.z / dimensions.z,
	};
	const diagonal = length3( voxel );
	const maximum = Math.max( voxel.x, voxel.y, voxel.z );
	return {
		voxel,
		diagonal,
		// A trilinearly reconstructed curved SDF can differ from the analytic
		// zero by O(voxel²/radius). This bound remains below half a voxel
		// diagonal and dwarfs the sub-millimetre rgba16float quantisation error.
		contactTolerance: diagonal * 0.45 + 0.002,
		sideOffset: clamp( maximum * 1.25, 0.25, 0.55 ),
		signMargin: Math.max( 0.025, maximum * 0.12 ),
	};

}

export function assessCleanSurfaceTriplet( values, thresholds ) {

	const finite = [ values.contact, values.air, values.earth ].every( Number.isFinite );
	const checks = {
		finite,
		contact: finite && Math.abs( values.contact ) <= thresholds.contactTolerance,
		air: finite && values.air <= - thresholds.signMargin,
		earth: finite && values.earth >= thresholds.signMargin,
		order: finite && values.air < values.contact && values.contact < values.earth,
	};
	return { pass: Object.values( checks ).every( Boolean ), checks };

}

async function readHalfFloatTexel( renderer, texture, x, y, z, channel ) {

	const copy = renderer?.backend?.copyTextureToBuffer;
	if ( typeof copy !== 'function' )
		throw new Error( 'Volume GPU probe requires renderer.backend.copyTextureToBuffer' );
	const data = await copy.call( renderer.backend, texture, x, y, 1, 1, z );
	if ( ! ( data instanceof Uint16Array ) || data.length < channel + 1 )
		throw new Error( 'Volume GPU probe expected an rgba16float Uint16Array readback' );
	return halfFloatToNumber( data[ channel ] );

}

export async function readFilteredVolumeChannel( {
	renderer,
	texture,
	point,
	bounds,
	dimensions,
	channel = 1,
} ) {

	if ( ! Number.isInteger( channel ) || channel < 0 || channel > 3 )
		throw new Error( 'Volume probe channel must be in 0..3' );
	const mapped = worldToVolumeSample( point, bounds, dimensions );
	const corners = {};
	await Promise.all( [ 0, 1 ].flatMap( ( z ) =>
		[ 0, 1 ].flatMap( ( y ) =>
			[ 0, 1 ].map( async ( x ) => {

				const ix = x ? mapped.x.high : mapped.x.low;
				const iy = y ? mapped.y.high : mapped.y.low;
				const iz = z ? mapped.z.high : mapped.z.low;
				corners[ `${ x }${ y }${ z }` ] =
					await readHalfFloatTexel( renderer, texture, ix, iy, iz, channel );

			} ) ) ) );
	return trilinearVolumeSample( corners, {
		x: mapped.x.fraction,
		y: mapped.y.fraction,
		z: mapped.z.fraction,
	} );

}

function addScaled( point, direction, amount ) {

	return {
		x: point.x + direction.x * amount,
		y: point.y + direction.y * amount,
		z: point.z + direction.z * amount,
	};

}

function navigationPointToWorld( sample, texel, world, grid ) {

	return {
		x: ( sample.x / grid - 0.5 ) * world,
		y: sample.depth,
		z: ( sample.y / grid - 0.5 ) * world,
	};

}

function supportToWorld( support ) {

	// Navigation metric order is (grid x, grid z, world depth).
	return normalize3( { x: support.x, y: support.z, z: support.y } );

}

function analyticTripletIsStable( sdf, localContact, support, thresholds ) {

	const air = sdf( addScaled( localContact, support, thresholds.sideOffset ) );
	const earth = sdf( addScaled( localContact, support, - thresholds.sideOffset ) );
	// The accelerated CPU oracle deliberately saturates positive distances at
	// its 3 cm hash padding. It is used here only to reject intersections, not
	// to predict the magnitude that the unsaturated GPU field will contain.
	const analyticMargin = Math.min( 0.01, thresholds.signMargin * 0.25 );
	return Math.abs( sdf( localContact ) ) <= 0.025
		&& air < - analyticMargin
		&& earth > analyticMargin;

}

export function buildDeterministicVolumeProbeCases( {
	layout,
	bounds,
	dimensions,
	texel,
	world,
	grid,
	corridorCount = 3,
	chamberCount = 2,
} ) {

	const network = layout?.navigation;
	if ( ! network || ! Array.isArray( network.corridors ) )
		throw new Error( 'Volume GPU probe requires a compiled corridor network' );
	if ( ! Array.isArray( layout.units ) || layout.units.length === 0 )
		throw new Error( 'Volume GPU probe requires at least one chamber' );
	const thresholds = volumeProbeThresholds( bounds, dimensions );
	const sdf = createNestSurfaceOracle( layout, network.corridors, texel );
	const cases = [];
	const corridorIds = network.corridors
		.map( ( corridor, index ) => corridor ? index : - 1 )
		.filter( ( index ) => index >= 1 );
	const fractions = [ 0.37, 0.53, 0.69, 0.43, 0.61 ];
	const tracks = [ 1, 5, 9, 3, 7, 11 ];

	for ( let candidate = 0; candidate < corridorIds.length * tracks.length
		&& cases.filter( ( item ) => item.kind === 'corridor' ).length < corridorCount;
		candidate ++ ) {

		const edgeId = corridorIds[ candidate % corridorIds.length ];
		const track = tracks[ Math.floor( candidate / corridorIds.length ) % tracks.length ]
			% network.surfaceTracks;
		const t = fractions[ candidate % fractions.length ];
		const sample = sampleCorridorSurface(
			network, edgeId, t, track / network.surfaceTracks * Math.PI * 2, 1 );
		const localContact = corridorContactWorld( sample, texel );
		const support = supportToWorld( sample.support );
		if ( ! analyticTripletIsStable( sdf, localContact, support, thresholds ) ) continue;
		cases.push( {
			id: `corridor-${ edgeId }-track-${ track }`,
			kind: 'corridor',
			contact: navigationPointToWorld( sample, texel, world, grid ),
			support,
		} );

	}

	const chamberPatterns = [
		[ 0.32, 0.18 ], [ - 0.28, 0.24 ], [ 0.16, - 0.34 ],
		[ - 0.36, - 0.12 ], [ 0.08, 0.38 ],
	];
	for ( let candidate = 0; candidate < layout.units.length * chamberPatterns.length
		&& cases.filter( ( item ) => item.kind === 'chamber' ).length < chamberCount;
		candidate ++ ) {

		const chamberIndex = candidate % layout.units.length;
		const unit = layout.units[ chamberIndex ];
		const primitive = chamberPrimitive( unit );
		const pattern = chamberPatterns[
			Math.floor( candidate / layout.units.length ) % chamberPatterns.length ];
		const localContact = {
			x: unit.x * texel + primitive.radiusX * pattern[ 0 ],
			y: primitive.floorDepth,
			z: unit.y * texel + primitive.radiusZ * pattern[ 1 ],
		};
		const support = { x: 0, y: 1, z: 0 };
		if ( ! analyticTripletIsStable( sdf, localContact, support, thresholds ) ) continue;
		cases.push( {
			id: `chamber-${ chamberIndex }-floor-${ candidate }`,
			kind: 'chamber',
			contact: {
				x: localContact.x - world * 0.5,
				y: localContact.y,
				z: localContact.z - world * 0.5,
			},
			support,
		} );

	}

	return { cases, thresholds };

}

export async function runNestVolumeGpuProbe( {
	renderer,
	texture,
	layout,
	bounds,
	dimensions,
	texel,
	world,
	grid,
	corridorCount = 3,
	chamberCount = 2,
} ) {

	const built = buildDeterministicVolumeProbeCases( {
		layout, bounds, dimensions, texel, world, grid, corridorCount, chamberCount,
	} );
	const results = [];
	for ( const probeCase of built.cases ) {

		const airPoint = addScaled(
			probeCase.contact, probeCase.support, built.thresholds.sideOffset );
		const earthPoint = addScaled(
			probeCase.contact, probeCase.support, - built.thresholds.sideOffset );
		const values = {
			contact: await readFilteredVolumeChannel( {
				renderer, texture, point: probeCase.contact, bounds, dimensions, channel: 1,
			} ),
			air: await readFilteredVolumeChannel( {
				renderer, texture, point: airPoint, bounds, dimensions, channel: 1,
			} ),
			earth: await readFilteredVolumeChannel( {
				renderer, texture, point: earthPoint, bounds, dimensions, channel: 1,
			} ),
		};
		results.push( {
			...probeCase,
			values,
			... assessCleanSurfaceTriplet( values, built.thresholds ),
		} );

	}
	const counts = {
		corridor: results.filter( ( item ) => item.kind === 'corridor' ).length,
		chamber: results.filter( ( item ) => item.kind === 'chamber' ).length,
	};
	const coverage = counts.corridor >= corridorCount && counts.chamber >= chamberCount;
	return {
		id: NEST_VOLUME_GPU_PROBE_ID,
		pass: coverage && results.every( ( result ) => result.pass ),
		coverage,
		counts,
		required: { corridor: corridorCount, chamber: chamberCount },
		thresholds: built.thresholds,
		cases: results,
	};

}
