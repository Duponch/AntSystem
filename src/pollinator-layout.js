const TAU = Math.PI * 2;

export function mulberry32( seed ) {

	return () => {

		seed |= 0;
		seed = ( seed + 0x6D2B79F5 ) | 0;
		let t = Math.imul( seed ^ ( seed >>> 15 ), 1 | seed );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

function insideExclusion( x, z, exclusions, margin ) {

	for ( const exclusion of exclusions ) {

		const radius = Math.max( 0, exclusion.radius || exclusion.r || 0 ) + margin;
		if ( Math.hypot( x - exclusion.x, z - exclusion.z ) < radius ) return true;

	}

	return false;

}

/**
 * Deterministic clustered flower field. Its bounded rejection loop executes
 * only when the decoration is built or a flower setting changes.
 */
export function buildFlowerLayout( {
	count,
	world,
	seed = 0xBEE2026,
	exclusions = [],
	patchCount = 9,
} ) {

	const safeCount = Math.max( 0, Math.floor( count ) );
	const safeWorld = Math.max( 24, world );
	const random = mulberry32( seed );
	const half = safeWorld * 0.5;
	const patchRadius = Math.max( 5, safeWorld * 0.075 );
	const innerRadius = Math.max( 14, safeWorld * 0.14 );
	const outerRadius = Math.max( innerRadius + 2, half - 7 );
	const patches = [];

	for ( let i = 0; i < Math.max( 1, patchCount ); i ++ ) {

		const angle = ( i + 0.18 + random() * 0.64 ) / Math.max( 1, patchCount ) * TAU;
		const radial = innerRadius + ( outerRadius - innerRadius ) * ( 0.2 + random() * 0.8 );
		patches.push( {
			x: Math.cos( angle ) * radial,
			z: Math.sin( angle ) * radial,
			stretch: 0.65 + random() * 0.9,
			yaw: random() * TAU,
		} );

	}

	const positions = new Float32Array( safeCount * 3 );
	const scales = new Float32Array( safeCount );
	const yaws = new Float32Array( safeCount );
	const patchIds = new Uint16Array( safeCount );
	let written = 0;
	let guard = 0;

	while ( written < safeCount && guard ++ < Math.max( 64, safeCount * 32 ) ) {

		const patchId = Math.floor( random() * patches.length );
		const patch = patches[ patchId ];
		const angle = random() * TAU;
		const radius = patchRadius * Math.sqrt( random() );
		const localX = Math.cos( angle ) * radius * patch.stretch;
		const localZ = Math.sin( angle ) * radius / patch.stretch;
		const cosYaw = Math.cos( patch.yaw );
		const sinYaw = Math.sin( patch.yaw );
		const x = patch.x + localX * cosYaw - localZ * sinYaw;
		const z = patch.z + localX * sinYaw + localZ * cosYaw;

		if ( Math.max( Math.abs( x ), Math.abs( z ) ) > half - 3 ) continue;
		if ( Math.hypot( x, z ) < innerRadius - 3 ) continue;
		if ( insideExclusion( x, z, exclusions, 1.15 ) ) continue;

		const offset = written * 3;
		positions[ offset ] = x;
		positions[ offset + 1 ] = 0;
		positions[ offset + 2 ] = z;
		scales[ written ] = 0.78 + random() * 0.44;
		yaws[ written ] = random() * TAU;
		patchIds[ written ] = patchId;
		written ++;

	}

	// A very dense edited scene can exhaust rejection. Fill the bounded tail on
	// an inner ring so capacities and typed-array identities remain unchanged.
	for ( let i = written; i < safeCount; i ++ ) {

		const angle = ( i / Math.max( 1, safeCount ) ) * TAU;
		const offset = i * 3;
		positions[ offset ] = Math.cos( angle ) * innerRadius;
		positions[ offset + 1 ] = 0;
		positions[ offset + 2 ] = Math.sin( angle ) * innerRadius;
		scales[ i ] = 0.9;
		yaws[ i ] = angle;
		patchIds[ i ] = i % patches.length;

	}

	return { count: safeCount, positions, scales, yaws, patchIds, patches };

}

export function flowerExclusionsFromProps( registry, categoryScales = {} ) {

	const exclusions = [ { x: 0, z: 0, radius: 13 } ];

	for ( const entry of registry || [] ) {

		if ( entry.category !== 'trees' && entry.category !== 'obstacles' ) continue;
		for ( const placement of entry.placements || [] ) {

			const categoryScale = Number.isFinite( categoryScales[ entry.category ] )
				? Math.max( 0, categoryScales[ entry.category ] )
				: 1;
			const scale = Math.max( 0, placement.scale || 0 ) * categoryScale;
			const radius = entry.category === 'trees'
				? Math.max( 1.5, scale * 0.075 )
				: Math.max( 1.5, scale * 0.48 );
			exclusions.push( { x: placement.x, z: placement.z, radius } );

		}

	}

	return exclusions;

}

/**
 * Stable host selection: explicit tag first, then a Tree_02 hero, then the
 * largest available tree for backwards-compatible saved decorations.
 */
export function selectHiveHost( registry ) {

	const trees = [];

	for ( const entry of registry || [] ) {

		if ( entry.category !== 'trees' ) continue;
		for ( let index = 0; index < entry.placements.length; index ++ ) {

			trees.push( { entry, index, placement: entry.placements[ index ] } );

		}

	}

	return trees.find( ( tree ) => tree.placement.tag === 'hive-host' )
		|| trees.find( ( tree ) => tree.entry.model === 'Tree_02' )
		|| trees.sort( ( a, b ) => ( b.placement.scale || 0 ) - ( a.placement.scale || 0 ) )[ 0 ]
		|| null;

}
