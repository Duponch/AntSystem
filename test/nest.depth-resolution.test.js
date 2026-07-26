import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	MAX_NEST_DEPTH,
	MIN_NEST_DEPTH,
	TEXEL,
} from '../src/config.js';
import { K_MAX, MIN_TUNNEL_WIDTH, buildNest } from '../src/nest.js';
import { VOL_Y } from '../src/nestvolume.js';

const BOTTOM_MARGIN = 3;
const TOP_MARGIN = 1.7;
const TUNNEL_RADIUS_SCALE = 0.85;

test( 'NAV-VOLUME-001 configured nest depths are explicit and physically bounded', () => {

	assert.doesNotThrow( () => buildNest( K_MAX, MIN_NEST_DEPTH, MIN_TUNNEL_WIDTH, false ) );
	assert.doesNotThrow( () => buildNest( K_MAX, MAX_NEST_DEPTH, MIN_TUNNEL_WIDTH, false ) );
	for ( const depth of [ NaN, MIN_NEST_DEPTH - 1, MAX_NEST_DEPTH + 1, 200 ] )
		assert.throws(
			() => buildNest( K_MAX, depth, MIN_TUNNEL_WIDTH, false ),
			/Nest depth must be between/,
		);

} );

test( 'NAV-VOLUME-002 the thinnest tunnel keeps at least three vertical voxels', () => {

	const nest = buildNest( K_MAX, MAX_NEST_DEPTH, MIN_TUNNEL_WIDTH, false );
	const deepestNode = Math.min( 0, ...nest.nodes.map( ( node ) => node.depth ) );
	const volumeDepth = Math.max( MAX_NEST_DEPTH, - deepestNode ) + BOTTOM_MARGIN;
	const voxelHeight = ( volumeDepth + TOP_MARGIN ) / VOL_Y;
	const minimumTunnelDiameter = 2 * MIN_TUNNEL_WIDTH * TEXEL * TUNNEL_RADIUS_SCALE;
	const voxelsAcross = minimumTunnelDiameter / voxelHeight;

	assert.ok(
		voxelsAcross >= 3,
		'minimum tunnel has only ' + voxelsAcross.toFixed( 3 ) + ' vertical voxels',
	);
	assert.ok( voxelsAcross < 3.25, 'test no longer exercises the resolution boundary' );

} );
