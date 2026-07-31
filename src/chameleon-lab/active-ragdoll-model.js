export const TAIL_HINGE_LIMIT = 0.38;

export function tailJointPolicy( nameOrIndex ) {

	const index = typeof nameOrIndex === 'number'
		? nameOrIndex
		: Number.parseInt( String( nameOrIndex ).replace( /^tail_/, '' ), 10 );
	if ( ! Number.isInteger( index ) || index < 1 || index > 12 )
		throw new RangeError( 'tail index must be an integer from 1 to 12' );
	const hinge = index >= 3 && index % 2 === 1;
	return Object.freeze( {
		index,
		kind: hinge ? 'hinge' : 'fixed',
		axis: index % 4 === 1
			? Object.freeze( { x: 1, y: 0, z: 0 } )
			: Object.freeze( { x: 0, y: 0, z: 1 } ),
		limit: hinge ? TAIL_HINGE_LIMIT : 0,
	} );

}

export function anatomicalSwingLimit( boneName ) {

	if ( String( boneName ).startsWith( 'tail_' ) ) return TAIL_HINGE_LIMIT;
	if ( String( boneName ).startsWith( 'spine_' ) || boneName === 'neck' ) return 0.55;
	if ( boneName === 'head' ) return 0.72;
	if ( String( boneName ).includes( '_lower' ) ) return 1.2;
	if ( String( boneName ).includes( '_upper' ) ) return 1.02;
	return 0.9;

}

export function muscleControllerGains( {
	inertia,
	frequency,
	damping = 1,
	dragScale = 1,
	maxAngle = 0.85,
} ) {

	if ( ! Number.isFinite( inertia ) || inertia <= 0 )
		throw new RangeError( 'inertia must be finite and positive' );
	if ( ! Number.isFinite( frequency ) || frequency < 0 )
		throw new RangeError( 'frequency must be finite and non-negative' );
	const scale = Math.max( 0, Number.isFinite( dragScale ) ? dragScale : 0 );
	const dampingRatio = Math.max( 0, Number.isFinite( damping ) ? damping : 0 );
	return Object.freeze( {
		stiffness: inertia * frequency * frequency * scale,
		damping: inertia * frequency * 2 * dampingRatio * scale,
		maximum: inertia * frequency * frequency * Math.max( 0, maxAngle ) * scale,
	} );

}
export function idleHoldControllerGains( {
	mass,
	stiffness = 42,
	damping = 11,
	maxAcceleration = 28,
} ) {

	if ( ! Number.isFinite( mass ) || mass <= 0 )
		throw new RangeError( 'mass must be finite and positive' );
	return Object.freeze( {
		stiffness: mass * Math.max( 0, stiffness ),
		damping: mass * Math.max( 0, damping ),
		maximum: mass * Math.max( 0, maxAcceleration ),
	} );

}