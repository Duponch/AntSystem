export const HYBRID_PHYSICS_BODY_COUNT = 1;
export const HYBRID_FOOT_COUNT = 4;

export const HYBRID_JOINT_LIMITS = Object.freeze( {
	// The exported rig was deliberately rebuilt with broad reptile-like ranges.
	// These are safety cones, not pose motors: the analytic solver still keeps
	// the shoulder/hip, elbow/knee and complete palm patch anatomically coherent.
	girdle: 1.16,
	upper: 1.42,
	lower: 1.54,
	// The original zygodactyl mesh stores its pads almost opposite the parent
	// rest frame. This is a safety cone just below π, not a flexion target.
	palm: Math.PI,
} );

function finite( name, value ) {

	if ( ! Number.isFinite( value ) ) throw new RangeError( `${ name } must be finite` );
	return value;

}

export function criticalDampingGains( {
	mass,
	frequency,
	dampingRatio = 1,
	maximumAcceleration = 30,
} ) {

	mass = finite( 'mass', mass );
	frequency = finite( 'frequency', frequency );
	dampingRatio = finite( 'dampingRatio', dampingRatio );
	maximumAcceleration = finite( 'maximumAcceleration', maximumAcceleration );
	if ( mass <= 0 ) throw new RangeError( 'mass must be positive' );
	if ( frequency < 0 ) throw new RangeError( 'frequency must be non-negative' );
	return Object.freeze( {
		stiffness: mass * frequency * frequency,
		damping: 2 * mass * frequency * Math.max( 0, dampingRatio ),
		maximum: mass * Math.max( 0, maximumAcceleration ),
	} );

}

export function clampJointAngle( angle, limit ) {

	angle = finite( 'angle', angle );
	limit = Math.max( 0, finite( 'limit', limit ) );
	return Math.max( -limit, Math.min( limit, angle ) );

}

function requireSupportOutput( output ) {

	if ( typeof output !== 'object' || output === null )
		throw new TypeError( 'support output must be an object' );
	if ( typeof output.centroid !== 'object' || output.centroid === null )
		throw new TypeError( 'support output.centroid must be an object' );
	if ( typeof output.normal !== 'object' || output.normal === null )
		throw new TypeError( 'support output.normal must be an object' );
	return output;

}

function writeSupportFrame( output, count, cx, cy, cz, nx, ny, nz ) {

	output.count = count;
	output.centroid.x = cx;
	output.centroid.y = cy;
	output.centroid.z = cz;
	output.normal.x = nx;
	output.normal.y = ny;
	output.normal.z = nz;
	return output;

}

export function supportFrameFromContacts( positions, normals, active = null, output = null ) {

	if ( ! positions || positions.length < HYBRID_FOOT_COUNT * 3 )
		throw new TypeError( 'four packed contact positions are required' );
	if ( ! normals || normals.length < HYBRID_FOOT_COUNT * 3 )
		throw new TypeError( 'four packed contact normals are required' );
	let count = 0;
	let cx = 0; let cy = 0; let cz = 0;
	let nx = 0; let ny = 0; let nz = 0;
	for ( let foot = 0; foot < HYBRID_FOOT_COUNT; foot ++ ) {

		if ( active && ! active[ foot ] ) continue;
		const offset = foot * 3;
		const values = positions[ offset ] + positions[ offset + 1 ] + positions[ offset + 2 ]
			+ normals[ offset ] + normals[ offset + 1 ] + normals[ offset + 2 ];
		if ( ! Number.isFinite( values ) ) continue;
		cx += positions[ offset ]; cy += positions[ offset + 1 ]; cz += positions[ offset + 2 ];
		nx += normals[ offset ]; ny += normals[ offset + 1 ]; nz += normals[ offset + 2 ];
		count ++;

	}
	if ( count === 0 ) {

		if ( output !== null && output !== undefined )
			return writeSupportFrame( requireSupportOutput( output ), 0, 0, 0, 0, 0, 1, 0 );
		return Object.freeze( {
			count: 0,
			centroid: Object.freeze( { x: 0, y: 0, z: 0 } ),
			normal: Object.freeze( { x: 0, y: 1, z: 0 } ),
		} );

	}
	const inverseCount = 1 / count;
	const normalLength = Math.hypot( nx, ny, nz ) || 1;
	if ( output !== null && output !== undefined ) return writeSupportFrame(
		requireSupportOutput( output ),
		count,
		cx * inverseCount,
		cy * inverseCount,
		cz * inverseCount,
		nx / normalLength,
		ny / normalLength,
		nz / normalLength,
	);
	return Object.freeze( {
		count,
		centroid: Object.freeze( {
			x: cx * inverseCount,
			y: cy * inverseCount,
			z: cz * inverseCount,
		} ),
		normal: Object.freeze( {
			x: nx / normalLength,
			y: ny / normalLength,
			z: nz / normalLength,
		} ),
	} );

}

export function stableRootForce( {
	error,
	velocity,
	mass,
	frequency,
	dampingRatio = 1,
	maximumAcceleration = 30,
}, output = null ) {

	if ( output !== null && output !== undefined ) {

		if ( typeof output !== 'object' ) throw new TypeError( 'force output must be an object' );
		mass = finite( 'mass', mass );
		frequency = finite( 'frequency', frequency );
		dampingRatio = finite( 'dampingRatio', dampingRatio );
		maximumAcceleration = finite( 'maximumAcceleration', maximumAcceleration );
		if ( mass <= 0 ) throw new RangeError( 'mass must be positive' );
		if ( frequency < 0 ) throw new RangeError( 'frequency must be non-negative' );
		const stiffness = mass * frequency * frequency;
		const damping = 2 * mass * frequency * Math.max( 0, dampingRatio );
		const maximum = mass * Math.max( 0, maximumAcceleration );
		const x = finite( 'error.x', error?.x ) * stiffness
			- finite( 'velocity.x', velocity?.x ) * damping;
		const y = finite( 'error.y', error?.y ) * stiffness
			- finite( 'velocity.y', velocity?.y ) * damping;
		const z = finite( 'error.z', error?.z ) * stiffness
			- finite( 'velocity.z', velocity?.z ) * damping;
		const length = Math.hypot( x, y, z );
		const scale = length > maximum && length > 0 ? maximum / length : 1;
		output.x = x * scale;
		output.y = y * scale;
		output.z = z * scale;
		return output;

	}

	const gains = criticalDampingGains( {
		mass,
		frequency,
		dampingRatio,
		maximumAcceleration,
	} );
	const x = finite( 'error.x', error?.x ) * gains.stiffness
		- finite( 'velocity.x', velocity?.x ) * gains.damping;
	const y = finite( 'error.y', error?.y ) * gains.stiffness
		- finite( 'velocity.y', velocity?.y ) * gains.damping;
	const z = finite( 'error.z', error?.z ) * gains.stiffness
		- finite( 'velocity.z', velocity?.z ) * gains.damping;
	const length = Math.hypot( x, y, z );
	const scale = length > gains.maximum && length > 0 ? gains.maximum / length : 1;
	return Object.freeze( { x: x * scale, y: y * scale, z: z * scale } );

}
