export const SUPPORT_COHORT_FOOT_COUNT = 4;
export const SUPPORT_COHORT_FULL_MASK = ( 1 << SUPPORT_COHORT_FOOT_COUNT ) - 1;

function finiteNonNegative( name, value ) {

	if ( ! Number.isFinite( value ) || value < 0 )
		throw new RangeError( `${ name } must be a finite non-negative number` );
	return value;

}

function finiteUnitRange( name, value ) {

	if ( ! Number.isFinite( value ) || value < -1 || value > 1 )
		throw new RangeError( `${ name } must be inside [-1, 1]` );
	return value;

}

function requirePackedVectors( name, values ) {

	if ( ! values || values.length < SUPPORT_COHORT_FOOT_COUNT * 3 )
		throw new TypeError( `four packed ${ name } vectors are required` );

}

function requirePerFootValues( name, values ) {

	if ( ! values || values.length < SUPPORT_COHORT_FOOT_COUNT )
		throw new TypeError( `four ${ name } values are required` );

}

function fourBitMask( value ) {

	return Number.isInteger( value ) ? value & SUPPORT_COHORT_FULL_MASK : 0;

}

function activeMaskFrom( active ) {

	if ( Number.isInteger( active ) ) return fourBitMask( active );
	if ( ! active || active.length < SUPPORT_COHORT_FOOT_COUNT )
		throw new TypeError( 'four active-contact flags or a four-bit mask are required' );
	let mask = 0;
	for ( let foot = 0; foot < SUPPORT_COHORT_FOOT_COUNT; foot ++ )
		if ( active[ foot ] ) mask |= 1 << foot;
	return mask;

}

function popcount4( mask ) {

	mask &= SUPPORT_COHORT_FULL_MASK;
	mask = mask - ( ( mask >> 1 ) & 0x5 );
	return ( mask & 0x3 ) + ( ( mask >> 2 ) & 0x3 );

}

function connectedMask( mask, links ) {

	if ( mask === 0 ) return false;
	let reached = mask & -mask;
	let previous = 0;
	while ( reached !== previous ) {

		previous = reached;
		let frontier = reached;
		for ( let foot = 0; foot < SUPPORT_COHORT_FOOT_COUNT; foot ++ ) {

			const bit = 1 << foot;
			if ( frontier & bit ) reached |= links[ foot ] & mask;

		}

	}
	return ( reached & mask ) === mask;

}

/**
 * Selects one locally connected, anatomically reachable support cohort.
 *
 * Collider identity alone is deliberately insufficient: opposite faces or
 * disconnected islands may share one handle. `buildCompatibility()` links
 * contacts only when they describe the same locally oriented surface, a
 * continuous branch, or a short seam transfer. Consequently a true floor/wall
 * corner remains connected while two remote groups cannot suspend the body at
 * their empty midpoint.
 *
 * The class owns all scratch storage. Both methods are allocation-free after
 * construction and selection always examines exactly fifteen masks.
 */
export class SupportCohortModel {

	constructor( {
		reachSlack = 0.018,
		enterSeamDistance = 0.29,
		exitSeamDistance = 0.39,
		sameSurfaceNormalDot = 0.7,
	} = {} ) {

		this.reachSlack = finiteNonNegative( 'reachSlack', reachSlack );
		this.enterSeamDistance = finiteNonNegative(
			'enterSeamDistance', enterSeamDistance,
		);
		this.exitSeamDistance = finiteNonNegative(
			'exitSeamDistance', exitSeamDistance,
		);
		if ( this.exitSeamDistance < this.enterSeamDistance )
			throw new RangeError( 'exitSeamDistance must be >= enterSeamDistance' );
		this.sameSurfaceNormalDot = finiteUnitRange(
			'sameSurfaceNormalDot', sameSurfaceNormalDot,
		);
		this.compatibility = new Uint8Array( SUPPORT_COHORT_FOOT_COUNT );
		this.view = Object.seal( {
			mask: 0,
			count: 0,
			validMask: 0,
			rejectedReachMask: 0,
			previousOverlap: 0,
			compatibility: this.compatibility,
		} );

	}

	buildCompatibility(
		contactPositions,
		contactNormals,
		colliderHandles,
		topologyFlags,
		active,
		previousMask = 0,
	) {

		requirePackedVectors( 'contact-position', contactPositions );
		requirePackedVectors( 'contact-normal', contactNormals );
		requirePerFootValues( 'collider-handle', colliderHandles );
		requirePerFootValues( 'topology flag', topologyFlags );
		const requested = activeMaskFrom( active );
		const previous = fourBitMask( previousMask );
		const links = this.compatibility;
		links.fill( 0 );
		for ( let foot = 0; foot < SUPPORT_COHORT_FOOT_COUNT; foot ++ )
			if ( requested & ( 1 << foot ) ) links[ foot ] = 1 << foot;

		for ( let first = 0; first < SUPPORT_COHORT_FOOT_COUNT; first ++ ) {

			const firstBit = 1 << first;
			if ( ( requested & firstBit ) === 0 ) continue;
			for ( let second = first + 1; second < SUPPORT_COHORT_FOOT_COUNT; second ++ ) {

				const secondBit = 1 << second;
				if ( ( requested & secondBit ) === 0 ) continue;
				const firstOffset = first * 3;
				const secondOffset = second * 3;
				if ( ! Number.isFinite( contactPositions[ firstOffset ] )
					|| ! Number.isFinite( contactPositions[ firstOffset + 1 ] )
					|| ! Number.isFinite( contactPositions[ firstOffset + 2 ] )
					|| ! Number.isFinite( contactPositions[ secondOffset ] )
					|| ! Number.isFinite( contactPositions[ secondOffset + 1 ] )
					|| ! Number.isFinite( contactPositions[ secondOffset + 2 ] )
					|| ! Number.isFinite( contactNormals[ firstOffset ] )
					|| ! Number.isFinite( contactNormals[ firstOffset + 1 ] )
					|| ! Number.isFinite( contactNormals[ firstOffset + 2 ] )
					|| ! Number.isFinite( contactNormals[ secondOffset ] )
					|| ! Number.isFinite( contactNormals[ secondOffset + 1 ] )
					|| ! Number.isFinite( contactNormals[ secondOffset + 2 ] ) ) continue;
				const firstHandle = colliderHandles[ first ];
				const secondHandle = colliderHandles[ second ];
				const sameHandle = Number.isFinite( firstHandle )
					&& firstHandle === secondHandle;
				const branch = sameHandle && topologyFlags[ first ] === 1
					&& topologyFlags[ second ] === 1;
				const facetedShell = sameHandle && topologyFlags[ first ] === 2
					&& topologyFlags[ second ] === 2;
				const normalDot = contactNormals[ firstOffset ] * contactNormals[ secondOffset ]
					+ contactNormals[ firstOffset + 1 ] * contactNormals[ secondOffset + 1 ]
					+ contactNormals[ firstOffset + 2 ] * contactNormals[ secondOffset + 2 ];
				const dx = contactPositions[ firstOffset ] - contactPositions[ secondOffset ];
				const dy = contactPositions[ firstOffset + 1 ] - contactPositions[ secondOffset + 1 ];
				const dz = contactPositions[ firstOffset + 2 ] - contactPositions[ secondOffset + 2 ];
				const retainedPair = ( previous & firstBit ) !== 0
					&& ( previous & secondBit ) !== 0;
				const seamDistance = retainedPair
					? this.exitSeamDistance : this.enterSeamDistance;
				const squaredDistance = dx * dx + dy * dy + dz * dz;
				const sameLocalSurface = sameHandle
					&& normalDot >= this.sameSurfaceNormalDot
					&& ( facetedShell || squaredDistance <= seamDistance * seamDistance );
				// Convex collider faces are one continuous climbable shell. An
				// orthogonal face hand-off may span the body length even though every
				// individual claw remains anatomically reachable. Opposite faces stay
				// disconnected (dot < -0.25), preventing a box from becoming a bridge.
				const sameColliderTransition = facetedShell && normalDot >= -0.25;
				const localSeam = squaredDistance <= seamDistance * seamDistance
					&& normalDot >= -0.25;
				if ( ! branch && ! sameLocalSurface
					&& ! sameColliderTransition && ! localSeam ) continue;
				links[ first ] |= secondBit;
				links[ second ] |= firstBit;

			}

		}
		return links;

	}

	select(
		reachDistances,
		maximumReaches,
		active,
		previousMask = 0,
		compatibility = this.compatibility,
	) {

		requirePerFootValues( 'reach-distance', reachDistances );
		requirePerFootValues( 'maximum-reach', maximumReaches );
		requirePerFootValues( 'compatibility mask', compatibility );
		const requestedMask = activeMaskFrom( active );
		const previous = fourBitMask( previousMask );
		let validMask = 0;
		let rejectedReachMask = 0;
		for ( let foot = 0; foot < SUPPORT_COHORT_FOOT_COUNT; foot ++ ) {

			const bit = 1 << foot;
			if ( ( requestedMask & bit ) === 0 ) continue;
			const distance = reachDistances[ foot ];
			const maximum = maximumReaches[ foot ];
			if ( ! Number.isFinite( distance ) || ! Number.isFinite( maximum )
				|| distance < 0 || maximum < 0
				|| distance > maximum + this.reachSlack ) {

				rejectedReachMask |= bit;
				continue;

			}
			validMask |= bit;

		}

		let bestMask = 0;
		let bestCount = 0;
		let bestExactPrevious = 0;
		let bestPreviousOverlap = 0;
		for ( let mask = 1; mask <= SUPPORT_COHORT_FULL_MASK; mask ++ ) {

			if ( ( mask & validMask ) !== mask || ! connectedMask( mask, compatibility ) )
				continue;
			const count = popcount4( mask );
			const exactPrevious = mask === previous && previous !== 0 ? 1 : 0;
			const previousOverlap = popcount4( mask & previous );
			const better = count > bestCount
				|| count === bestCount && exactPrevious > bestExactPrevious
				|| count === bestCount && exactPrevious === bestExactPrevious
					&& previousOverlap > bestPreviousOverlap
				|| count === bestCount && exactPrevious === bestExactPrevious
					&& previousOverlap === bestPreviousOverlap
					&& ( bestMask === 0 || mask < bestMask );
			if ( ! better ) continue;
			bestMask = mask;
			bestCount = count;
			bestExactPrevious = exactPrevious;
			bestPreviousOverlap = previousOverlap;

		}

		const view = this.view;
		view.mask = bestMask;
		view.count = bestCount;
		view.validMask = validMask;
		view.rejectedReachMask = rejectedReachMask;
		view.previousOverlap = bestPreviousOverlap;
		return view;

	}

	getView() {

		return this.view;

	}

}
