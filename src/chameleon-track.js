/**
 * Precomputed support track for the single chameleon.
 *
 * Fallen logs are instanced meshes whose source geometry is normalised along
 * local Z.  Sampling their upper centre line once gives the animal a stable,
 * irregular support without a raycast in the render loop.
 */

export const CHAMELEON_TRACK_SAMPLES = 32;

function clamp( value, low, high ) {

	return Math.min( high, Math.max( low, value ) );

}

function categoryScaleFor( category, scales ) {

	if ( category === 'obstacles' ) return scales?.obstacles ?? 1;
	if ( category === 'trees' ) return scales?.trees ?? 1;
	return 1;

}

function taggedPlacement( registry ) {

	for ( const entry of registry || [] ) {

		if ( entry.model !== 'Log_01' && entry.model !== 'Log_02' ) continue;
		for ( let index = 0; index < entry.placements.length; index ++ ) {

			if ( entry.placements[ index ].tag === 'chameleon-host' ) {

				return { entry, index, placement: entry.placements[ index ] };

			}

		}

	}
	return null;

}

/**
 * Stable host priority: explicit tag, Log_01, Log_02, then any log-like entry.
 */
export function selectChameleonHost( registry ) {

	const tagged = taggedPlacement( registry );
	if ( tagged ) return tagged;

	for ( const model of [ 'Log_01', 'Log_02' ] ) {

		const entry = ( registry || [] ).find(
			( candidate ) => candidate.model === model && candidate.placements?.length > 0,
		);
		if ( entry ) return { entry, index: 0, placement: entry.placements[ 0 ] };

	}

	const fallback = ( registry || [] ).find(
		( entry ) => /^Log_/u.test( entry.model || '' ) && entry.placements?.length > 0,
	);
	return fallback ? { entry: fallback, index: 0, placement: fallback.placements[ 0 ] } : null;

}

function readBounds( attribute ) {

	let minX = Infinity;
	let maxX = - Infinity;
	let minY = Infinity;
	let maxY = - Infinity;
	let minZ = Infinity;
	let maxZ = - Infinity;

	for ( let index = 0; index < attribute.count; index ++ ) {

		const x = attribute.getX( index );
		const y = attribute.getY( index );
		const z = attribute.getZ( index );
		minX = Math.min( minX, x );
		maxX = Math.max( maxX, x );
		minY = Math.min( minY, y );
		maxY = Math.max( maxY, y );
		minZ = Math.min( minZ, z );
		maxZ = Math.max( maxZ, z );

	}
	return { minX, maxX, minY, maxY, minZ, maxZ };

}

function smoothHeights( heights, scratch ) {

	for ( let pass = 0; pass < 2; pass ++ ) {

		scratch[ 0 ] = heights[ 0 ];
		scratch[ heights.length - 1 ] = heights[ heights.length - 1 ];
		for ( let index = 1; index < heights.length - 1; index ++ ) {

			scratch[ index ] = (
				heights[ index - 1 ] +
				heights[ index ] * 2 +
				heights[ index + 1 ]
			) * 0.25;

		}
		heights.set( scratch );

	}

}

/**
 * Returns immutable-size SoA samples in world space. The function allocates
 * only when a prop revision or a graphics scale change requires a new track.
 */
export function buildChameleonTrack( host, {
	sampleCount = CHAMELEON_TRACK_SAMPLES,
	scales = null,
	clearance = 0.006,
	endMargin = 0.09,
} = {} ) {

	if ( ! host?.entry?.mesh?.geometry || ! host.placement ) {

		throw new TypeError( 'a log host with geometry and placement is required' );

	}
	const count = clamp( Math.round( sampleCount ), 8, 128 );
	const position = host.entry.mesh.geometry.getAttribute( 'position' );
	if ( ! position || position.count === 0 ) throw new Error( 'the host log has no positions' );

	const bounds = readBounds( position );
	const width = Math.max( 0.0001, bounds.maxX - bounds.minX );
	const length = Math.max( 0.0001, bounds.maxZ - bounds.minZ );
	const centreX = ( bounds.minX + bounds.maxX ) * 0.5;
	const centralHalfWidth = width * 0.3;
	const margin = clamp( endMargin, 0, 0.3 );
	const startZ = bounds.minZ + length * margin;
	const endZ = bounds.maxZ - length * margin;
	const stepZ = ( endZ - startZ ) / ( count - 1 );
	const binHalfWidth = Math.max( length / count, stepZ * 0.82 );
	const localHeight = new Float32Array( count );
	const scratch = new Float32Array( count );

	for ( let sample = 0; sample < count; sample ++ ) {

		const z = startZ + stepZ * sample;
		let top = - Infinity;
		let nearestDistance = Infinity;
		let nearestHeight = bounds.maxY;

		for ( let vertex = 0; vertex < position.count; vertex ++ ) {

			const vx = position.getX( vertex );
			const vz = position.getZ( vertex );
			if ( Math.abs( vx - centreX ) > centralHalfWidth ) continue;
			const distance = Math.abs( vz - z );
			if ( distance < nearestDistance ) {

				nearestDistance = distance;
				nearestHeight = position.getY( vertex );

			}
			if ( distance <= binHalfWidth ) top = Math.max( top, position.getY( vertex ) );

		}
		localHeight[ sample ] = Number.isFinite( top ) ? top : nearestHeight;

	}
	smoothHeights( localHeight, scratch );

	const x = new Float32Array( count );
	const y = new Float32Array( count );
	const z = new Float32Array( count );
	const normalX = new Float32Array( count );
	const normalY = new Float32Array( count );
	const normalZ = new Float32Array( count );
	const distance = new Float32Array( count );
	const placement = host.placement;
	const categoryScale = categoryScaleFor( host.entry.category, scales );
	const scale = Math.max( 0.0001, ( placement.scale || 1 ) * categoryScale );
	const yaw = placement.yaw || 0;
	const sin = Math.sin( yaw );
	const cos = Math.cos( yaw );
	const baseY = placement.y || 0;

	for ( let sample = 0; sample < count; sample ++ ) {

		const localZ = startZ + stepZ * sample;
		x[ sample ] = placement.x + ( centreX * cos + localZ * sin ) * scale;
		y[ sample ] = baseY + ( localHeight[ sample ] + clearance ) * scale;
		z[ sample ] = placement.z + ( - centreX * sin + localZ * cos ) * scale;

		if ( sample > 0 ) {

			distance[ sample ] = distance[ sample - 1 ] + Math.hypot(
				x[ sample ] - x[ sample - 1 ],
				y[ sample ] - y[ sample - 1 ],
				z[ sample ] - z[ sample - 1 ],
			);

		}

	}

	for ( let sample = 0; sample < count; sample ++ ) {

		const before = Math.max( 0, sample - 1 );
		const after = Math.min( count - 1, sample + 1 );
		let tx = x[ after ] - x[ before ];
		let ty = y[ after ] - y[ before ];
		let tz = z[ after ] - z[ before ];
		const tangentLength = Math.hypot( tx, ty, tz ) || 1;
		tx /= tangentLength;
		ty /= tangentLength;
		tz /= tangentLength;

		// Cross(tangent, local +X lateral) gives the upward support normal.
		const lateralX = cos;
		const lateralZ = - sin;
		let nx = ty * lateralZ;
		let ny = tz * lateralX - tx * lateralZ;
		let nz = - ty * lateralX;
		const normalLength = Math.hypot( nx, ny, nz ) || 1;
		nx /= normalLength;
		ny /= normalLength;
		nz /= normalLength;
		if ( ny < 0 ) {

			nx = - nx;
			ny = - ny;
			nz = - nz;

		}
		normalX[ sample ] = nx;
		normalY[ sample ] = ny;
		normalZ[ sample ] = nz;

	}

	return Object.freeze( {
		count,
		x,
		y,
		z,
		normalX,
		normalY,
		normalZ,
		distance,
		length: distance[ count - 1 ],
		model: host.entry.model,
		placementIndex: host.index,
		categoryScale,
	} );

}
