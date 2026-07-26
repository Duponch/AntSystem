import assert from 'node:assert/strict';
import test from 'node:test';

import { MIN_NEST_DEPTH } from '../src/config.js';
import { nestUnit } from '../src/nest.js';
import { chamberPrimitive } from '../src/navigation/support-geometry.js';

function length3( value ) {

	return Math.hypot( value.x, value.y, value.z );

}

function sdEllipsoid( point, center, radii ) {

	const q = {
		x: point.x - center.x,
		y: point.y - center.y,
		z: point.z - center.z,
	};
	const q0 = {
		x: q.x / radii.x,
		y: q.y / radii.y,
		z: q.z / radii.z,
	};
	const q1 = {
		x: q.x / ( radii.x * radii.x ),
		y: q.y / ( radii.y * radii.y ),
		z: q.z / ( radii.z * radii.z ),
	};
	const k0 = length3( q0 );
	const k1 = Math.max( length3( q1 ), 1e-12 );
	return k0 * ( k0 - 1 ) / k1;

}

function sdFlatFloorChamber( point, primitive ) {

	return Math.max(
		sdEllipsoid(
			point,
			{ x: 0, y: primitive.centerDepth, z: 0 },
			{
				x: primitive.radiusX,
				y: primitive.radiusY,
				z: primitive.radiusZ,
			},
		),
		primitive.floorDepth - point.y,
	);

}

test( 'NAV-SURFACE-005 chamber depth defines a broad flat floor under a vaulted ceiling', () => {

	for ( let index = 0; index < 24; index ++ ) {

		const unit = nestUnit( index, MIN_NEST_DEPTH );
		const primitive = chamberPrimitive( unit );
		const ceiling = primitive.centerDepth + primitive.radiusY;

		assert.equal( primitive.floorDepth, unit.depth );
		assert.ok( Math.abs( primitive.centerDepth - ( unit.depth + unit.rh * 0.5 ) ) < 1e-12 );
		assert.ok( Math.abs( primitive.radiusY - unit.rh * 1.5 ) < 1e-12 );
		assert.ok( ceiling <= - 0.65 + 1e-12, `chamber ${ index } ceiling breaches the surface` );

		// At the clipped floor, many horizontal positions lie on SDF=0. The
		// chamber therefore has a usable floor instead of a single tangent point.
		for ( const [ xFraction, zFraction ] of [
			[ 0, 0 ], [ 0.5, 0 ], [ - 0.5, 0 ], [ 0, 0.5 ], [ 0, - 0.5 ],
		] ) {

			const point = {
				x: primitive.radiusX * xFraction,
				y: primitive.floorDepth,
				z: primitive.radiusZ * zFraction,
			};
			assert.ok( Math.abs( sdFlatFloorChamber( point, primitive ) ) < 1e-12 );

		}

		const epsilon = 1e-4;
		assert.ok( sdFlatFloorChamber( {
			x: 0, y: primitive.floorDepth + epsilon, z: 0,
		}, primitive ) < 0, 'air immediately above the floor must be inside the cavity' );
		assert.ok( sdFlatFloorChamber( {
			x: 0, y: primitive.floorDepth - epsilon, z: 0,
		}, primitive ) > 0, 'earth immediately below the floor must remain solid' );
		assert.ok( Math.abs( sdFlatFloorChamber( {
			x: 0, y: ceiling, z: 0,
		}, primitive ) ) < 1e-12 );

	}

} );

test( 'NAV-SURFACE-006 invalid chamber geometry is rejected before the GPU bake', () => {

	assert.throws(
		() => chamberPrimitive( { depth: - 2, rh: 0, rwx: 1, rwz: 1 } ),
		/positive half-height and half-axes/,
	);
	assert.throws(
		() => chamberPrimitive( { depth: Number.NaN, rh: 1, rwx: 1, rwz: 1 } ),
		/finite depth and half-axes/,
	);
	assert.throws(
		() => chamberPrimitive( { depth: - 2, rh: 1, rwx: 0, rwz: 1 } ),
		/positive half-height and half-axes/,
	);
	assert.throws(
		() => chamberPrimitive( { depth: - 2, rh: 1, rwx: 1, rwz: Number.NaN } ),
		/finite depth and half-axes/,
	);

} );
