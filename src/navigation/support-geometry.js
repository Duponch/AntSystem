// Shared support geometry for navigation compilation and the rendered clean SDF.
//
// Every angular track is projected once on the clean cavity boundary, then
// resampled by arc length. Ants only interpolate shared texture samples: no
// raycast, SDF solve or per-ant path allocation happens during a frame.

export const CORRIDOR_SURFACE_TRACKS = 12;
export const SDF_SEGS_PER_CORRIDOR = 16;
export const MAX_SDF_SEGS_PER_CORRIDOR = SDF_SEGS_PER_CORRIDOR;
export const CHAMBER_LOBES = 3;

const EPS = 1e-9;
const TAU = Math.PI * 2;
const HASH_CELL_WORLD = 2;
const HASH_PADDING_WORLD = 0.03;
const DENSE_FACTOR = 6;
const HASH_COORD_MIN = - 32768;
const HASH_COORD_MAX = 32767;
const HASH_COORD_STRIDE = 65536;
const HASH_PLANE_STRIDE = HASH_COORD_STRIDE * HASH_COORD_STRIDE;

const uncheckedSpatialHashCellKey = ( x, y, z ) =>
	( x - HASH_COORD_MIN ) * HASH_PLANE_STRIDE
	+ ( y - HASH_COORD_MIN ) * HASH_COORD_STRIDE
	+ z - HASH_COORD_MIN;

// Encode three signed 16-bit cell coordinates in one exact 48-bit Number.
// Unlike a template string this allocates nothing in the projection hot path.
export function spatialHashCellKey( x, y, z ) {

	if ( ! Number.isInteger( x ) || ! Number.isInteger( y ) || ! Number.isInteger( z )
		|| x < HASH_COORD_MIN || x > HASH_COORD_MAX
		|| y < HASH_COORD_MIN || y > HASH_COORD_MAX
		|| z < HASH_COORD_MIN || z > HASH_COORD_MAX )
		throw new RangeError( 'Spatial hash coordinates must be signed 16-bit integers' );
	return uncheckedSpatialHashCellKey( x, y, z );

}

const clamp01 = ( value ) => Math.max( 0, Math.min( 1, value ) );
const vector = ( x = 0, y = 0, z = 0 ) => ( { x, y, z } );
const add = ( a, b ) => vector( a.x + b.x, a.y + b.y, a.z + b.z );
const sub = ( a, b ) => vector( a.x - b.x, a.y - b.y, a.z - b.z );
const scale = ( value, amount ) => vector( value.x * amount, value.y * amount, value.z * amount );
const dot = ( a, b ) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = ( a, b ) => vector(
	a.y * b.z - a.z * b.y,
	a.z * b.x - a.x * b.z,
	a.x * b.y - a.y * b.x,
);
const magnitude = ( value ) => Math.hypot( value.x, value.y, value.z );
const normalize = ( value, fallback = vector( 0, 0, 1 ) ) => {

	const length = magnitude( value );
	return length > EPS ? scale( value, 1 / length ) : { ...fallback };

};
const smoothStep = ( edge0, edge1, value ) => {

	const t = clamp01( ( value - edge0 ) / Math.max( edge1 - edge0, EPS ) );
	return t * t * ( 3 - 2 * t );

};
const lerp = ( a, b, t ) => a + ( b - a ) * t;
const lerpVector = ( a, b, t ) => vector(
	lerp( a.x, b.x, t ), lerp( a.y, b.y, t ), lerp( a.z, b.z, t ) );

export function chamberPrimitive( unit ) {

	if ( ! unit || ! Number.isFinite( unit.depth ) || ! Number.isFinite( unit.rh )
		|| ! Number.isFinite( unit.rwx ) || ! Number.isFinite( unit.rwz ) )
		throw new Error( 'A chamber needs finite depth and half-axes' );
	if ( unit.rh <= 0 || unit.rwx <= 0 || unit.rwz <= 0 )
		throw new Error( 'A chamber needs positive half-height and half-axes' );
	// A real chamber is a low vault over a usable floor, not an ellipsoid that
	// touches its floor at a single point. The ellipsoid is clipped by a plane;
	// its ceiling stays at depth + 2 * rh while most of its footprint is flat.
	return {
		centerDepth: unit.depth + unit.rh * 0.5,
		floorDepth: unit.depth,
		radiusX: unit.rwx,
		radiusY: unit.rh * 1.5,
		radiusZ: unit.rwz,
		offsetX: 0,
		offsetZ: 0,
	};

}

// A chamber is compiled from three clipped ellipsoids contained by the
// conservative chamberPrimitive() envelope. This changes the physical clean
// SDF (and therefore the shared ant contacts), while keeping collision proofs
// cheap: the historical envelope remains a safe broad phase.
export function chamberPrimitives( unit ) {

	const envelope = chamberPrimitive( unit );
	const seed = Number.isInteger( unit.k ) ? unit.k : 0;
	const yaw = Number.isFinite( unit.chamberYaw )
		? unit.chamberYaw
		: ( seed * 2.399963229728653 ) % ( Math.PI * 2 );
	const balance = Number.isFinite( unit.chamberBalance )
		? unit.chamberBalance
		: 0.5;
	const cos = Math.cos( yaw ), sin = Math.sin( yaw );
	const along = 0.25 + balance * 0.08;
	const across = 0.20 + ( 1 - balance ) * 0.07;
	const make = ( offsetX, offsetZ, radiusX, radiusY, radiusZ, depthOffset = 0 ) => ( {
		centerDepth: envelope.centerDepth + depthOffset,
		floorDepth: envelope.floorDepth,
		offsetX,
		offsetZ,
		radiusX,
		radiusY,
		radiusZ,
	} );

	return [
		make(
			- cos * envelope.radiusX * 0.05,
			- sin * envelope.radiusZ * 0.05,
			envelope.radiusX * 0.78,
			envelope.radiusY * 0.84,
			envelope.radiusZ * 0.76,
		),
		make(
			cos * envelope.radiusX * along,
			sin * envelope.radiusZ * along,
			envelope.radiusX * ( 0.62 - Math.abs( cos ) * along * 0.05 ),
			envelope.radiusY * ( 0.68 + balance * 0.10 ),
			envelope.radiusZ * ( 0.50 - Math.abs( sin ) * along * 0.05 ),
			unit.rh * 0.035,
		),
		make(
			- sin * envelope.radiusX * across,
			cos * envelope.radiusZ * across,
			envelope.radiusX * ( 0.49 - Math.abs( sin ) * across * 0.04 ),
			envelope.radiusY * ( 0.66 + ( 1 - balance ) * 0.11 ),
			envelope.radiusZ * ( 0.61 - Math.abs( cos ) * across * 0.05 ),
			- unit.rh * 0.025,
		),
	];

}

export function corridorSdfSegmentCount( corridorOrId ) {

	return SDF_SEGS_PER_CORRIDOR;

}

export function corridorCapsuleSegments(
	corridor, count = corridorSdfSegmentCount( corridor )
) {

	if ( Array.isArray( corridor?.capsulePoints ) && corridor.capsulePoints.length >= 2 )
		return corridor.capsulePoints.slice( 0, count + 1 ).map(
			( point, index, points ) => index < points.length - 1 ? [ point, points[ index + 1 ] ] : null,
		).filter( Boolean );

	const points = corridor?.axisPoints ?? corridor?.points;
	if ( ! Array.isArray( points ) || points.length < 2 ) return [];
	const segmentCount = Math.min( count, points.length - 1 );
	const indexAt = ( step ) => Math.round(
		( 0.5 - 0.5 * Math.cos( Math.PI * step / segmentCount ) ) * ( points.length - 1 ) );
	return Array.from( { length: segmentCount }, ( _, index ) => [
		points[ indexAt( index ) ],
		points[ indexAt( index + 1 ) ],
	] );

}

// Radius is evaluated once per shared capsule, never per ant. The base radius
// remains the guaranteed clearance; low-frequency positive bulges make the
// tunnel wall physical and non-cylindrical without narrowing the passage.
export function corridorCapsuleRadii(
	corridor,
	texel,
	tunnelRadiusScale = 0.85,
	count = corridorCapsuleSegments( corridor ).length,
) {

	if ( ! Number.isInteger( count ) || count < 1 ) return [];
	const width = corridor?.tunnelW ?? corridor?.radius;
	if ( ! Number.isFinite( width ) || width <= 0 )
		throw new Error( 'Corridor radius profile requires a positive width' );
	const base = Math.max( 0.6, width * texel * tunnelRadiusScale );
	const edge = Number.isInteger( corridor?.id ) ? corridor.id : 0;
	if ( edge === 1 || count === 1 ) return new Float32Array( count ).fill( base );
	const phase = edge * 2.399963229728653 + 0.731;
	const bulge = Math.min( 0.095, base * 0.145 );
	const radii = new Float32Array( count );
	for ( let index = 0; index < count; index ++ ) {

		const t = index / ( count - 1 );
		const weightF = t * Math.max( 0, ( corridor.wallWeights?.length ?? 1 ) - 1 );
		const weightI = Math.floor( weightF );
		const wallWeight = Array.isArray( corridor.wallWeights )
			? lerp(
				corridor.wallWeights[ weightI ],
				corridor.wallWeights[ Math.min( corridor.wallWeights.length - 1, weightI + 1 ) ],
				weightF - weightI,
			) : 1;
		// Radius noise is disabled inside chamber collars. Otherwise an enlarged
		// capsule adjacent to a portal can dig below the chamber's flat floor.
		const envelope = Math.sin( Math.PI * t ) ** 2
			* smoothStep( 0.05, 0.45, wallWeight );
		const wave = 0.55
			+ 0.30 * Math.sin( Math.PI * 2 * t + phase )
			+ 0.15 * Math.sin( Math.PI * 4 * t - phase * 0.41 );
		radii[ index ] = base + bulge * envelope * Math.max( 0.08, wave );

	}
	radii[ 0 ] = base;
	radii[ count - 1 ] = base;
	return radii;

}

const pointWorld = ( point, texel ) => vector( point.x * texel, point.depth, point.y * texel );
const directionWorld = ( metric ) => normalize( vector( metric.x, metric.z, metric.y ) );
const directionMetric = ( world ) => normalize( vector( world.x, world.z, world.y ) );

function sdCapsule( point, start, end, radius ) {

	const pa = sub( point, start );
	const ba = sub( end, start );
	const denominator = Math.max( dot( ba, ba ), EPS );
	const h = clamp01( dot( pa, ba ) / denominator );
	return magnitude( sub( pa, scale( ba, h ) ) ) - radius;

}

function sdEllipsoid( point, center, radii ) {

	const q = sub( point, center );
	const q0 = vector( q.x / radii.x, q.y / radii.y, q.z / radii.z );
	const q1 = vector(
		q.x / ( radii.x * radii.x ),
		q.y / ( radii.y * radii.y ),
		q.z / ( radii.z * radii.z ),
	);
	const k0 = magnitude( q0 );
	const k1 = Math.max( magnitude( q1 ), EPS );
	return k0 * ( k0 - 1 ) / k1;

}

function primitiveBounds( a, b, radius ) {

	return {
		min: vector(
			Math.min( a.x, b.x ) - radius,
			Math.min( a.y, b.y ) - radius,
			Math.min( a.z, b.z ) - radius,
		),
		max: vector(
			Math.max( a.x, b.x ) + radius,
			Math.max( a.y, b.y ) + radius,
			Math.max( a.z, b.z ) + radius,
		),
	};

}

function buildCleanPrimitives( nest, corridors, texel, tunnelRadiusScale ) {

	const primitives = [];
	const activeChambers = Math.min(
		nest.units?.length ?? 0,
		Number.isInteger( nest.K ) ? nest.K : Math.max( 0, corridors.length - 2 ),
	);

	for ( let index = 0; index < activeChambers; index ++ ) {

		const unit = nest.units[ index ];
		for ( const chamber of chamberPrimitives( unit ) ) {

			const center = vector(
				unit.x * texel + chamber.offsetX,
				chamber.centerDepth,
				unit.y * texel + chamber.offsetZ,
			);
			const radii = vector( chamber.radiusX, chamber.radiusY, chamber.radiusZ );
			primitives.push( {
				bounds: {
					min: vector( center.x - radii.x, chamber.floorDepth, center.z - radii.z ),
					max: add( center, radii ),
				},
				distance: ( point ) => Math.max(
					sdEllipsoid( point, center, radii ), chamber.floorDepth - point.y ),
			} );

		}

	}
	for ( const corridor of corridors ) {

		if ( ! corridor ) continue;
		const segments = corridorCapsuleSegments( corridor );
		const radii = corridorCapsuleRadii(
			corridor, texel, tunnelRadiusScale, segments.length );
		for ( let index = 0; index < segments.length; index ++ ) {

			const [ start, end ] = segments[ index ];
			const radius = radii[ index ];
			const a = pointWorld( start, texel );
			const b = pointWorld( end, texel );
			primitives.push( {
				bounds: primitiveBounds( a, b, radius ),
				distance: ( point ) => sdCapsule( point, a, b, radius ),
			} );

		}

	}
	return primitives;

}

function spatialSdf( primitives ) {

	const buckets = new Map();
	const cell = HASH_CELL_WORLD;

	for ( const primitive of primitives ) {

		const minX = Math.floor( ( primitive.bounds.min.x - HASH_PADDING_WORLD ) / cell );
		const minY = Math.floor( ( primitive.bounds.min.y - HASH_PADDING_WORLD ) / cell );
		const minZ = Math.floor( ( primitive.bounds.min.z - HASH_PADDING_WORLD ) / cell );
		const maxX = Math.floor( ( primitive.bounds.max.x + HASH_PADDING_WORLD ) / cell );
		const maxY = Math.floor( ( primitive.bounds.max.y + HASH_PADDING_WORLD ) / cell );
		const maxZ = Math.floor( ( primitive.bounds.max.z + HASH_PADDING_WORLD ) / cell );
		// Bounds are checked once while baking; queries use the allocation-free
		// unchecked encoder below.
		spatialHashCellKey( minX, minY, minZ );
		spatialHashCellKey( maxX, maxY, maxZ );

		for ( let x = minX; x <= maxX; x ++ )
			for ( let y = minY; y <= maxY; y ++ )
				for ( let z = minZ; z <= maxZ; z ++ ) {

					const id = uncheckedSpatialHashCellKey( x, y, z );
					let list = buckets.get( id );
					if ( ! list ) buckets.set( id, list = [] );
					list.push( primitive );

				}

	}

	const sdf = ( point ) => {

		const x = Math.floor( point.x / cell );
		const y = Math.floor( point.y / cell );
		const z = Math.floor( point.z / cell );
		if ( x < HASH_COORD_MIN || x > HASH_COORD_MAX
			|| y < HASH_COORD_MIN || y > HASH_COORD_MAX
			|| z < HASH_COORD_MIN || z > HASH_COORD_MAX )
			return HASH_PADDING_WORLD;
		const list = buckets.get( uncheckedSpatialHashCellKey( x, y, z ) );
		// Positive distances must retain a gradient too. Clamping empty/outside
		// cells to HASH_PADDING_WORLD made closest-point fairing stall at 0.03u.
		// The exact fallback is rare and runs only in the shared offline bake.
		const candidates = list ?? primitives;
		let distance = Infinity;
		for ( const primitive of candidates )
			distance = Math.min( distance, primitive.distance( point ) );
		return distance;
	};
	sdf.primitiveCount = primitives.length;
	return sdf;

}

export function createNestSurfaceOracle( nest, corridors, texel, tunnelRadiusScale = 0.85 ) {

	return spatialSdf( buildCleanPrimitives( nest, corridors, texel, tunnelRadiusScale ) );

}

function axisBasis( corridor, t, track, tracks, endpointFade ) {

	const path = corridor.axisPoints;
	const f = clamp01( t ) * ( path.length - 1 );
	const i0 = Math.min( path.length - 2, Math.floor( f ) );
	const i1 = i0 + 1;
	const local = f - i0;
	const a = path[ i0 ], b = path[ i1 ];
	const center = {
		x: lerp( a.x, b.x, local ),
		y: lerp( a.y, b.y, local ),
		depth: lerp( a.depth, b.depth, local ),
	};
	const frame0 = corridor.frames[ i0 ];
	const frame1 = corridor.frames[ i1 ];
	const tangent = normalize( lerpVector( frame0.tangent, frame1.tangent, local ) );
	const normalRaw = lerpVector( frame0.normal, frame1.normal, local );
	const normal = normalize(
		sub( normalRaw, scale( tangent, dot( normalRaw, tangent ) ) ), frame0.normal );
	const binormal = normalize( cross( tangent, normal ), frame0.binormal );
	const angle = track / tracks * TAU;
	const radial = normalize( add(
		scale( normal, Math.cos( angle ) ),
		scale( binormal, Math.sin( angle ) ),
	), normal );
	const compiledWeight = Array.isArray( corridor.wallWeights )
		? lerp( corridor.wallWeights[ i0 ], corridor.wallWeights[ i1 ], local )
		: null;
	const startWeight = corridor.id === 1 ? 1 : smoothStep( 0, endpointFade, t );
	const endWeight = smoothStep( 0, endpointFade, 1 - t );
	const wallWeight = compiledWeight ?? startWeight * endWeight;
	// Interpolation ANGULAIRE dans le plan de section. Un lerp/slerp vectoriel
	// devient singulier pour la piste plafond, exactement antipodale au plancher :
	// une variation infinitesimale faisait alors basculer le rayon du bas vers le
	// haut. Ici le demi-tour suit toujours le sens positif et reste continu.
	const floor = normalize( sub(
		vector( 0, 0, - 1 ), scale( tangent, dot( vector( 0, 0, - 1 ), tangent ) ) ), normal );
	const floorAngle = Math.atan2( dot( floor, binormal ), dot( floor, normal ) );
	// Branche angulaire fixe par piste. Le plafond vaut toujours +PI (jamais
	// alternativement +PI/-PI quand le plancher traverse zero), ce qui supprime
	// le basculement discontinu entre les deux cotes du tube.
	const targetAngle = angle > Math.PI ? angle - TAU : angle;
	const blendedAngle = floorAngle + ( targetAngle - floorAngle ) * wallWeight;
	const outward = normalize( add(
		scale( normal, Math.cos( blendedAngle ) ),
		scale( binormal, Math.sin( blendedAngle ) ),
	), radial );
	return { center, tangent, outward, wallWeight };

}

function surfaceGradientRaw( sdf, point ) {

	const epsilon = 0.0015;
	return vector(
		( sdf( add( point, vector( epsilon, 0, 0 ) ) )
			- sdf( add( point, vector( - epsilon, 0, 0 ) ) ) ) / ( 2 * epsilon ),
		( sdf( add( point, vector( 0, epsilon, 0 ) ) )
			- sdf( add( point, vector( 0, - epsilon, 0 ) ) ) ) / ( 2 * epsilon ),
		( sdf( add( point, vector( 0, 0, epsilon ) ) )
			- sdf( add( point, vector( 0, 0, - epsilon ) ) ) ) / ( 2 * epsilon ),
	);

}

function closestSurfacePoint( sdf, seed ) {

	let point = { ...seed };
	for ( let iteration = 0; iteration < 8; iteration ++ ) {

		const distance = sdf( point );
		if ( Math.abs( distance ) <= 2e-8 ) break;
		const gradient = surfaceGradientRaw( sdf, point );
		const denominator = dot( gradient, gradient );
		if ( denominator <= EPS ) break;
		let correction = scale( gradient, - distance / denominator );
		const correctionLength = magnitude( correction );
		if ( correctionLength > 0.08 ) correction = scale( correction, 0.08 / correctionLength );
		point = add( point, correction );

	}
	return point;

}

function projectedWorld( point, texel ) {

	return vector( point.x * texel, point.depth, point.y * texel );

}

function withWorldContact( point, contact, texel ) {

	return {
		...point,
		x: contact.x / texel,
		y: contact.z / texel,
		depth: contact.y,
	};

}

// Laplacian fairing is done once while compiling the shared table. Every moved
// knot is projected back onto the authoritative SDF, so smoothing cannot make
// an ant float. It removes envelope-switch loops at chamber/capsule joins.
function metricSegmentDirection( before, after, texel ) {

	return normalize( vector(
		after.x - before.x,
		after.y - before.y,
		( after.depth - before.depth ) / texel,
	) );

}

function resampleProjectedPolyline( points, texel, sdf ) {

	const cumulative = cumulativeLengths( points, texel );
	const total = cumulative[ cumulative.length - 1 ];
	const resampled = points.slice();
	let segment = 0;
	for ( let index = 1; index < points.length - 1; index ++ ) {

		const target = total * index / ( points.length - 1 );
		while ( segment + 1 < cumulative.length - 1
			&& cumulative[ segment + 1 ] < target ) segment ++;
		const span = cumulative[ segment + 1 ] - cumulative[ segment ];
		const local = span > EPS ? ( target - cumulative[ segment ] ) / span : 0;
		const before = projectedWorld( points[ segment ], texel );
		const after = projectedWorld( points[ segment + 1 ], texel );
		const seed = lerpVector( before, after, local );
		resampled[ index ] = withWorldContact( {
			...points[ segment ],
			axisT: lerp( points[ segment ].axisT, points[ segment + 1 ].axisT, local ),
		}, closestSurfacePoint( sdf, seed ), texel );

	}
	return resampled;

}

function regularizeProjectedContacts( points, texel, sdf ) {

	const minimumTurnDot = Math.cos( 30 * Math.PI / 180 );
	let current = points;
	let didFair = false;
	for ( let pass = 0; pass < 12; pass ++ ) {

		const flagged = new Uint8Array( current.length );
		let needsFairing = false;
		for ( let index = 1; index < current.length - 1; index ++ ) {

			const before = metricSegmentDirection( current[ index - 1 ], current[ index ], texel );
			const after = metricSegmentDirection( current[ index ], current[ index + 1 ], texel );
			if ( dot( before, after ) >= minimumTurnDot ) continue;
			needsFairing = true;
			for ( let neighbour = Math.max( 1, index - 2 );
				neighbour <= Math.min( current.length - 2, index + 2 ); neighbour ++ )
				flagged[ neighbour ] = 1;

		}
		if ( ! needsFairing ) break;
		didFair = true;
		const next = current.slice();
		for ( let index = 1; index < current.length - 1; index ++ ) {

			if ( ! flagged[ index ] ) continue;
			const before = projectedWorld( current[ index - 1 ], texel );
			const contact = projectedWorld( current[ index ], texel );
			const after = projectedWorld( current[ index + 1 ], texel );
			const target = scale( add( add( before, scale( contact, 2 ) ), after ), 0.25 );
			next[ index ] = withWorldContact( current[ index ],
				closestSurfacePoint( sdf, target ), texel );

		}
		current = next;

	}
	if ( didFair ) for ( let pass = 0; pass < 40; pass ++ )
		current = resampleProjectedPolyline( current, texel, sdf );
	return current.map( ( point ) => ( {
		...point,
		support: directionMetric( scale(
			normalize( surfaceGradientRaw( sdf, projectedWorld( point, texel ) ) ), - 1 ) ),
	} ) );

}

function regularizeProjectedSupports( points, texel ) {

	const minimumSupportDot = Math.cos( 18 * Math.PI / 180 );
	let supports = points.map( ( point ) => point.support );
	for ( let pass = 0; pass < 12; pass ++ ) {

		const flagged = new Uint8Array( supports.length );
		let needsFairing = false;
		for ( let index = 1; index < supports.length; index ++ ) {

			if ( dot( supports[ index - 1 ], supports[ index ] ) >= minimumSupportDot ) continue;
			needsFairing = true;
			for ( let neighbour = Math.max( 1, index - 2 );
				neighbour <= Math.min( supports.length - 2, index + 1 ); neighbour ++ )
				flagged[ neighbour ] = 1;

		}
		if ( ! needsFairing ) break;
		const next = supports.slice();
		for ( let index = 1; index < supports.length - 1; index ++ ) {

			if ( ! flagged[ index ] ) continue;
			// A crease has no unique mathematical normal. Blend the two valid side
			// normals here; the runtime already projects its forward vector onto
			// this baked support, so orthogonalising again would recreate the kink.
			next[ index ] = normalize( add(
				add( supports[ index - 1 ], scale( supports[ index ], 2 ) ),
				supports[ index + 1 ],
			), supports[ index ] );

		}
		supports = next;

	}
	return points.map( ( point, index ) => ( { ...point, support: supports[ index ] } ) );

}

function projectSurface( sdf, center, outward, initialRadius ) {

	const ray = directionWorld( outward );
	const inside = sdf( center );
	if ( ! Number.isFinite( inside ) || inside >= - 1e-6 )
		throw new Error( `Corridor axis left its clean cavity (${ inside })` );

	let low = 0;
	let high = Math.max( initialRadius, 0.05 );
	let atHigh = sdf( add( center, scale( ray, high ) ) );
	const boundaryTolerance = 1e-6;

	if ( Math.abs( atHigh ) <= boundaryTolerance ) low = high;
	else if ( atHigh < 0 ) {

		low = high;
		for ( let expansion = 0; expansion < 4096 && atHigh < - boundaryTolerance; expansion ++ ) {

			const advance = Math.max( 0.0001,
				Math.min( initialRadius * 0.12, - atHigh * 0.8 ) );
			high += advance;
			atHigh = sdf( add( center, scale( ray, high ) ) );

		}

	}
	if ( atHigh < - boundaryTolerance )
		throw new Error( `Surface projection could not leave cavity within ${ high.toFixed( 2 ) } world units` );

	if ( high > low ) for ( let iteration = 0; iteration < 26; iteration ++ ) {

		const middle = ( low + high ) * 0.5;
		if ( sdf( add( center, scale( ray, middle ) ) ) < 0 ) low = middle;
		else high = middle;

	}
	const radius = ( low + high ) * 0.5;
	const contact = add( center, scale( ray, radius ) );
	const gradient = normalize( surfaceGradientRaw( sdf, contact ) );
	return { contact, radius, support: directionMetric( scale( gradient, - 1 ) ) };

}

function projectTrackPoint( corridor, track, tracks, t, texel, endpointFade, radiusWorld, sdf ) {

	const basis = axisBasis( corridor, t, track, tracks, endpointFade );
	const projected = projectSurface(
		sdf, pointWorld( basis.center, texel ), basis.outward, radiusWorld );
	return {
		axisT: clamp01( t ),
		x: projected.contact.x / texel,
		y: projected.contact.z / texel,
		depth: projected.contact.y,
		support: projected.support,
	};

}

function metricDistance( a, b, texel ) {

	return Math.hypot( b.x - a.x, b.y - a.y, ( b.depth - a.depth ) / texel );

}

function cumulativeLengths( points, texel ) {

	const cumulative = new Float64Array( points.length );
	for ( let index = 1; index < points.length; index ++ )
		cumulative[ index ] = cumulative[ index - 1 ] + metricDistance( points[ index - 1 ], points[ index ], texel );
	return cumulative;

}

function inverseArcLength( points, cumulative, target ) {

	let low = 0, high = cumulative.length - 1;
	while ( low + 1 < high ) {

		const middle = ( low + high ) >> 1;
		if ( cumulative[ middle ] < target ) low = middle; else high = middle;

	}
	const span = cumulative[ high ] - cumulative[ low ];
	const local = span > EPS ? ( target - cumulative[ low ] ) / span : 0;
	return lerp( points[ low ].axisT, points[ high ].axisT, local );

}

export function compileCorridorSurfaceTracks( {
	nest,
	corridors,
	samples,
	texel,
	maxNodes,
	tracks = CORRIDOR_SURFACE_TRACKS,
	endpointFade = 0.12,
	tunnelRadiusScale = 0.85,
} ) {

	const positionData = new Float32Array( maxNodes * samples * tracks * 4 );
	const supportData = new Float32Array( maxNodes * samples * tracks * 4 );
	let networkMaxStretch = 1;

	for ( const corridor of corridors ) {

		if ( ! corridor ) continue;
		const positions = new Float32Array( samples * tracks * 4 );
		const supports = new Float32Array( samples * tracks * 4 );
		const lengths = new Float32Array( tracks );
		const radiusWorld = corridor.radius * texel * tunnelRadiusScale;
		const sdf = createCorridorSurfaceOracle(
			nest, corridor, texel, tunnelRadiusScale );
		let corridorMaxStretch = 1;

		for ( let track = 0; track < tracks; track ++ ) {

			const denseCount = Math.max( ( samples - 1 ) * DENSE_FACTOR + 1, 97 );
			const dense = Array.from( { length: denseCount }, ( _, index ) => {

				const axisT = index / ( denseCount - 1 );
				try {

					return projectTrackPoint( corridor, track, tracks, axisT,
						texel, endpointFade, radiusWorld, sdf );

				} catch ( error ) {

					throw new Error( `Surface track ${ corridor.id }:${ track } at ${ axisT.toFixed( 5 ) }: ${ error.message }` );

				}

			} );
			const denseArc = cumulativeLengths( dense, texel );
			const denseLength = denseArc[ denseArc.length - 1 ];
			if ( ! Number.isFinite( denseLength ) || denseLength <= EPS )
				throw new Error( `Surface track ${ corridor.id }:${ track } has zero length` );

			let projected = Array.from( { length: samples }, ( _, sample ) => {

				const target = denseLength * sample / ( samples - 1 );
				const axisT = sample === 0 ? 0 : sample === samples - 1 ? 1
					: inverseArcLength( dense, denseArc, target );
				return projectTrackPoint( corridor, track, tracks, axisT,
					texel, endpointFade, radiusWorld, sdf );

			} );
			projected = regularizeProjectedContacts( projected, texel, sdf );
			projected = regularizeProjectedSupports( projected, texel );
			const arc = cumulativeLengths( projected, texel );
			const length = arc[ arc.length - 1 ];
			const averageSegment = length / ( samples - 1 );
			lengths[ track ] = length;

			for ( let sample = 0; sample < samples; sample ++ ) {

				const point = projected[ sample ];
				const localBase = ( track * samples + sample ) * 4;
				positions[ localBase ] = point.x;
				positions[ localBase + 1 ] = point.y;
				positions[ localBase + 2 ] = point.depth;
				positions[ localBase + 3 ] = length;
				supports[ localBase ] = point.support.x;
				supports[ localBase + 1 ] = point.support.y;
				supports[ localBase + 2 ] = point.support.z;
				supports[ localBase + 3 ] = point.axisT;
				const globalBase = ( corridor.id * tracks * samples + track * samples + sample ) * 4;
				positionData.set( positions.subarray( localBase, localBase + 4 ), globalBase );
				supportData.set( supports.subarray( localBase, localBase + 4 ), globalBase );

				if ( sample > 0 ) {

					const segment = arc[ sample ] - arc[ sample - 1 ];
					corridorMaxStretch = Math.max( corridorMaxStretch,
						segment / Math.max( averageSegment, EPS ) );

				}

			}

		}
		corridor.surfaceTracks = positions;
		corridor.surfaceSupports = supports;
		corridor.surfaceLengths = lengths;
		corridor.surfaceTexel = texel;
		corridor.maxSurfaceStretch = corridorMaxStretch;
		networkMaxStretch = Math.max( networkMaxStretch, corridorMaxStretch );

	}
	return { positionData, supportData, maxSurfaceStretch: networkMaxStretch };

}

function trackIndex( angle, tracks ) {

	const wrapped = ( ( angle % TAU ) + TAU ) % TAU;
	return Math.min( tracks - 1, Math.floor( wrapped / TAU * tracks + 1e-9 ) );

}

export function sampleCompiledSurfaceTrack( corridor, samples, tracks, t, angle ) {

	if ( ! corridor.surfaceTracks || ! corridor.surfaceSupports ) return null;
	const track = trackIndex( angle, tracks );
	const f = clamp01( t ) * ( samples - 1 );
	const i0 = Math.min( samples - 2, Math.floor( f ) );
	const i1 = i0 + 1;
	const local = f - i0;
	const base = ( index ) => ( track * samples + index ) * 4;
	const read = ( data, index, component ) => data[ base( index ) + component ];
	const mix = ( data, component ) => lerp(
		read( data, i0, component ), read( data, i1, component ), local );
	const point = {
		x: mix( corridor.surfaceTracks, 0 ),
		y: mix( corridor.surfaceTracks, 1 ),
		depth: mix( corridor.surfaceTracks, 2 ),
	};
	const support = normalize( vector(
		mix( corridor.surfaceSupports, 0 ),
		mix( corridor.surfaceSupports, 1 ),
		mix( corridor.surfaceSupports, 2 ),
	) );
	const before = Math.max( 0, i0 - 1 );
	const after = Math.min( samples - 1, i1 + 1 );
	const texel = corridor.surfaceTexel;
	const tangent = normalize( vector(
		read( corridor.surfaceTracks, after, 0 ) - read( corridor.surfaceTracks, before, 0 ),
		read( corridor.surfaceTracks, after, 1 ) - read( corridor.surfaceTracks, before, 1 ),
		( read( corridor.surfaceTracks, after, 2 ) - read( corridor.surfaceTracks, before, 2 ) ) / texel,
	) );
	return {
		track,
		...point,
		support,
		tangent,
		axisT: mix( corridor.surfaceSupports, 3 ),
		length: mix( corridor.surfaceTracks, 3 ),
	};

}

export function createCorridorTubeOracle( corridor, texel, tunnelRadiusScale = 0.85 ) {

	return spatialSdf( buildCleanPrimitives(
		{ units: [], K: 0 }, [ corridor ], texel, tunnelRadiusScale ) );

}
export function createCorridorSurfaceOracle( nest, corridor, texel, tunnelRadiusScale = 0.85 ) {

	const units = [];
	for ( const node of new Set( [ corridor.from, corridor.to ] ) )
		if ( node >= 2 && nest.units?.[ node - 2 ] ) units.push( nest.units[ node - 2 ] );
	return spatialSdf( buildCleanPrimitives(
		{ units, K: units.length }, [ corridor ], texel, tunnelRadiusScale ) );

}
export function corridorContactWorld( sample, texel ) {

	return vector( sample.x * texel, sample.depth, sample.y * texel );

}