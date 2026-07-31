export const HYBRID_PHYSICS_BODY_COUNT = 1;
export const HYBRID_FOOT_COUNT = 4;

export const HYBRID_JOINT_LIMITS = Object.freeze( {
	girdle: 0.72,
	upper: 1.05,
	lower: 1.18,
	palm: 0.82,
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

export function supportFrameFromContacts( positions, normals, active = null ) {

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
	if ( count === 0 ) return Object.freeze( {
		count: 0,
		centroid: Object.freeze( { x: 0, y: 0, z: 0 } ),
		normal: Object.freeze( { x: 0, y: 1, z: 0 } ),
	} );
	const inverseCount = 1 / count;
	const normalLength = Math.hypot( nx, ny, nz ) || 1;
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
} ) {

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
