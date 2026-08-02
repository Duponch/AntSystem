import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import {
	SURFACE_ROUTE_DEBUG_COLORS,
	SURFACE_ROUTE_KIND,
	SurfaceRouteDebugView,
} from '../src/chameleon-lab/surface-route-debug-view.js';

function assertVertexColor( view, vertex, expectedHex ) {

	const expected = new THREE.Color( expectedHex );
	const offset = vertex * 3;
	assert.ok( Math.abs( view.colors[ offset ] - expected.r ) < 1e-6 );
	assert.ok( Math.abs( view.colors[ offset + 1 ] - expected.g ) < 1e-6 );
	assert.ok( Math.abs( view.colors[ offset + 2 ] - expected.b ) < 1e-6 );

}

function route() {

	return {
		count: 4,
		positions: new Float32Array( [
			0, 0, 0,
			1, 0, 0,
			1, 1, 0,
			2, 1, 0,
		] ),
		normals: new Float32Array( [
			0, 1, 0,
			0, 1, 0,
			0, 0, 1,
			0, 0, 1,
		] ),
		kinds: new Uint8Array( [
			SURFACE_ROUTE_KIND.TERRAIN,
			SURFACE_ROUTE_KIND.TERRAIN,
			SURFACE_ROUTE_KIND.TRANSITION,
			SURFACE_ROUTE_KIND.SUPPORT,
		] ),
	};

}

test( 'CHAMELEON-LAB-ROUTE-DEBUG-001 uses one fixed-buffer line object for route and destination', () => {

	const scene = new THREE.Scene();
	const view = new SurfaceRouteDebugView( {
		scene,
		visible: true,
		maximumWaypoints: 8,
	} );
	const positions = view.positions;
	const colors = view.colors;
	const positionAttribute = view.positionAttribute;
	const colorAttribute = view.colorAttribute;
	try {

		assert.equal( scene.children.length, 1 );
		assert.equal( scene.children[ 0 ], view.lines );
		assert.equal( view.lines.isLineSegments, true );
		assert.equal( view.lines.children.length, 0 );
		assert.equal( view.material.depthTest, false );
		assert.equal( view.material.depthWrite, false );
		assert.equal( view.material.toneMapped, false );
		assert.equal( view.lines.castShadow, false );
		assert.equal( view.lines.receiveShadow, false );

		view.setRoute( route() );
		assert.equal( view.routeCount, 4 );
		assert.equal( view.routeSegmentCount, 3 );
		assert.equal( view.geometry.drawRange.count, 12,
			'three route segments plus three destination-axis segments must share one draw' );
		assert.equal( view.positions, positions );
		assert.equal( view.colors, colors );
		assert.equal( view.positionAttribute, positionAttribute );
		assert.equal( view.colorAttribute, colorAttribute );
		assert.equal( view.geometry.getAttribute( 'position' ).array, positions );
		assert.equal( view.geometry.getAttribute( 'color' ).array, colors );

		// Segment zero is active; future segments retain their surface type.
		assertVertexColor( view, 0, SURFACE_ROUTE_DEBUG_COLORS.active );
		assertVertexColor( view, 2, SURFACE_ROUTE_DEBUG_COLORS.transition );
		assertVertexColor( view, 4, SURFACE_ROUTE_DEBUG_COLORS.support );
		for ( let vertex = 6; vertex < 12; vertex ++ )
			assertVertexColor( view, vertex, SURFACE_ROUTE_DEBUG_COLORS.destination );

		// The destination cross and normal stem are not degenerate.
		for ( let segment = 3; segment < 6; segment ++ ) {

			const first = segment * 6;
			const dx = positions[ first + 3 ] - positions[ first ];
			const dy = positions[ first + 4 ] - positions[ first + 1 ];
			const dz = positions[ first + 5 ] - positions[ first + 2 ];
			assert.ok( Math.hypot( dx, dy, dz ) > 0.05 );

		}

		view.setProgress( 2 );
		assert.equal( view.progressIndex, 2 );
		assertVertexColor( view, 0, SURFACE_ROUTE_DEBUG_COLORS.completed );
		assertVertexColor( view, 2, SURFACE_ROUTE_DEBUG_COLORS.completed );
		assertVertexColor( view, 4, SURFACE_ROUTE_DEBUG_COLORS.active );
		assert.equal( view.positions, positions );
		assert.equal( view.colors, colors );

		view.clear();
		assert.equal( view.geometry.drawRange.count, 0 );
		assert.equal( view.routeCount, 0 );
		view.setVisible( false );
		assert.equal( scene.children.length, 0 );
		view.setVisible( true );
		assert.equal( scene.children[ 0 ], view.lines );

	} finally {

		view.dispose();

	}
	assert.equal( scene.children.length, 0 );

} );

test( 'CHAMELEON-LAB-ROUTE-DEBUG-002 clamps input without replacing storage and disposes once', () => {

	const scene = new THREE.Scene();
	const view = new SurfaceRouteDebugView( { scene, maximumWaypoints: 3 } );
	const positions = view.positions;
	const colors = view.colors;
	let geometryDisposals = 0;
	let materialDisposals = 0;
	view.geometry.addEventListener( 'dispose', () => geometryDisposals ++ );
	view.material.addEventListener( 'dispose', () => materialDisposals ++ );

	view.setRoute( route() );
	assert.equal( view.routeCount, 3 );
	assert.equal( view.geometry.drawRange.count, 10,
		'two clamped route segments and the destination marker stay in one draw' );
	view.setRoute( route() );
	view.setProgress( 999 );
	assert.equal( view.progressIndex, 2 );
	assert.equal( view.positions, positions );
	assert.equal( view.colors, colors );

	view.dispose();
	view.dispose();
	assert.equal( geometryDisposals, 1 );
	assert.equal( materialDisposals, 1 );
	assert.equal( scene.children.length, 0 );

} );
