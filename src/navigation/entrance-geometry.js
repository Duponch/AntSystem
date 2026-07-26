import * as THREE from 'three/webgpu';

import { WORLD, TEXEL } from '../config.js';
import { SDF_RADIUS_SCALE } from './corridor-network.js';

function worldPoint( point ) {

	return new THREE.Vector3(
		point.x * TEXEL - WORLD / 2,
		point.depth,
		point.y * TEXEL - WORLD / 2,
	);

}

function worldDirection( metric ) {

	return new THREE.Vector3( metric.x, metric.z, metric.y ).normalize();

}

// Collision continue 2D entre le déplacement du pivot d'une fourmi et la lèvre
// circulaire. Les unités sont libres mais doivent être identiques pour les
// positions, le rayon de bouche et le rayon du corps.
export function resolveEntranceLipStep(
	start, delta, center, mouthRadius, bodyRadius, entryAuthorized = false,
) {

	// Une fourmi autorisée à entrer engage ses pattes dans la gorge et rejoint
	// encore son contact de piste exact ; les passantes gardent la marge du corps.
	const safeRadius = Math.max( 0, mouthRadius )
		+ ( entryAuthorized ? 0 : Math.max( 0, bodyRadius ) );
	const epsilon = 1e-5;
	const sx = start.x - center.x;
	const sy = start.y - center.y;
	const dx = delta.x;
	const dy = delta.y;
	const startDistance = Math.hypot( sx, sy );
	const targetDistance = Math.hypot( sx + dx, sy + dy );
	const startedInside = startDistance < safeRadius - epsilon;
	const collisionRadius = startedInside
		? Math.max( startDistance, epsilon )
		: safeRadius;
	const resolvedRadius = collisionRadius + epsilon;
	const a = dx * dx + dy * dy;

	if ( safeRadius <= epsilon || a <= epsilon * epsilon ) return {
		x: start.x + dx,
		y: start.y + dy,
		collided: false,
		egressing: startedInside,
	};

	const radialDot = sx * dx + sy * dy;
	let impactT = Infinity;
	if ( startedInside ) {

		// Émergence depuis la gorge : le pivot reste sur son support et dépense son
		// budget normalement. Il peut augmenter son rayon, jamais le diminuer.
		if ( targetDistance < startDistance - epsilon ) impactT = 0;

	} else if ( startDistance <= collisionRadius + epsilon ) {

		if ( radialDot < - epsilon ) impactT = 0;

	} else {

		const c = sx * sx + sy * sy - collisionRadius * collisionRadius;
		const discriminant = radialDot * radialDot - a * c;
		if ( discriminant >= 0 ) {

			const candidate = ( - radialDot - Math.sqrt( Math.max( 0, discriminant ) ) ) / a;
			if ( candidate >= 0 && candidate <= 1 ) {

				const ix = sx + dx * candidate;
				const iy = sy + dy * candidate;
				// Une tangence exacte ne pénètre pas et conserve tout le mouvement.
				if ( ix * dx + iy * dy < - epsilon ) impactT = candidate;

			}

		}

	}

	if ( ! Number.isFinite( impactT ) ) return {
		x: start.x + dx,
		y: start.y + dy,
		collided: false,
		egressing: startedInside,
	};

	const impactX = sx + dx * impactT;
	const impactY = sy + dy * impactT;
	const impactLength = Math.hypot( impactX, impactY );
	let nx, ny;
	if ( impactLength > epsilon ) {

		nx = impactX / impactLength;
		ny = impactY / impactLength;

	} else {

		const movementLength = Math.sqrt( a );
		nx = movementLength > epsilon ? - dx / movementLength : 1;
		ny = movementLength > epsilon ? - dy / movementLength : 0;

	}
	const remainX = dx * ( 1 - impactT );
	const remainY = dy * ( 1 - impactT );
	const inward = Math.min( remainX * nx + remainY * ny, 0 );
	const slideX = remainX - nx * inward;
	const slideY = remainY - ny * inward;
	const x = center.x + nx * resolvedRadius + slideX;
	const y = center.y + ny * resolvedRadius + slideY;
	return { x, y, collided: true, egressing: startedInside, impactT };

}
export function entranceMouth( layout ) {

	const corridor = layout?.navigation?.corridors?.[ 1 ];
	if ( ! corridor ) throw new Error( 'Entrance geometry requires corridor 1' );
	const center = worldPoint( ( corridor.axisPoints ?? corridor.points )[ 0 ] );

	return {
		x: center.x,
		y: 0,
		z: center.z,
		radius: corridor.radius * SDF_RADIUS_SCALE * TEXEL,
	};

}

export function buildGroundWithEntrance( layout, size = WORLD, segments = 64 ) {

	const mouth = entranceMouth( layout );
	const half = size * 0.5;
	const shape = new THREE.Shape();
	shape.moveTo( - half, - half );
	shape.lineTo( - half, half );
	shape.lineTo( half, half );
	shape.lineTo( half, - half );
	shape.closePath();

	// ShapeGeometry vit d'abord dans XY. Après rotateX(-π/2), Y devient -Z.
	const hole = new THREE.Path();
	for ( let i = 0; i <= segments; i ++ ) {

		const angle = i / segments * Math.PI * 2;
		const x = mouth.x + Math.cos( angle ) * mouth.radius;
		const y = - mouth.z + Math.sin( angle ) * mouth.radius;
		if ( i === 0 ) hole.moveTo( x, y );
		else hole.lineTo( x, y );

	}
	hole.closePath();
	shape.holes.push( hole );

	const geometry = new THREE.ShapeGeometry( shape, 1 );
	geometry.rotateX( - Math.PI / 2 );
	geometry.computeVertexNormals();
	return geometry;

}

export function buildEntranceTubeGeometry( layout, sides = 48 ) {

	const corridor = layout?.navigation?.corridors?.[ 1 ];
	const points = corridor?.axisPoints ?? corridor?.points;
	if ( ! corridor?.frames || corridor.frames.length !== points?.length )
		throw new Error( 'Entrance tube requires transported corridor frames' );

	const ringCount = points.length;
	const radius = corridor.radius * SDF_RADIUS_SCALE * TEXEL;
	const positions = new Float32Array( ringCount * sides * 3 );
	const uvs = new Float32Array( ringCount * sides * 2 );
	const indices = [];
	const radial = new THREE.Vector3();

	for ( let ring = 0; ring < ringCount; ring ++ ) {

		const center = worldPoint( points[ ring ] );
		const normal = worldDirection( corridor.frames[ ring ].normal );
		const binormal = worldDirection( corridor.frames[ ring ].binormal );

		for ( let side = 0; side < sides; side ++ ) {

			const angle = side / sides * Math.PI * 2;
			radial.copy( normal ).multiplyScalar( Math.cos( angle ) )
				.addScaledVector( binormal, Math.sin( angle ) );
			const vertex = center.clone().addScaledVector( radial, radius );
			const index = ring * sides + side;
			positions[ index * 3 ] = vertex.x;
			positions[ index * 3 + 1 ] = vertex.y;
			positions[ index * 3 + 2 ] = vertex.z;
			uvs[ index * 2 ] = side / sides;
			uvs[ index * 2 + 1 ] = ring / ( ringCount - 1 );

		}

	}

	for ( let ring = 0; ring < ringCount - 1; ring ++ ) {

		for ( let side = 0; side < sides; side ++ ) {

			const nextSide = ( side + 1 ) % sides;
			const a = ring * sides + side;
			const b = ring * sides + nextSide;
			const c = ( ring + 1 ) * sides + side;
			const d = ( ring + 1 ) * sides + nextSide;
			indices.push( a, c, b, b, c, d );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
	geometry.setIndex( indices );
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	return geometry;

}

export function buildOpenTopBoxGeometry( width = WORLD, height = 1, depth = WORLD ) {

	const source = new THREE.BoxGeometry( width, height, depth );
	const positions = source.getAttribute( 'position' );
	const sourceIndex = source.getIndex();
	const kept = [];

	for ( let i = 0; i < sourceIndex.count; i += 3 ) {

		const a = sourceIndex.getX( i );
		const b = sourceIndex.getX( i + 1 );
		const c = sourceIndex.getX( i + 2 );
		const top = positions.getY( a ) > height * 0.49
			&& positions.getY( b ) > height * 0.49
			&& positions.getY( c ) > height * 0.49;
		if ( ! top ) kept.push( a, b, c );

	}

	source.setIndex( kept );
	source.clearGroups();
	source.computeVertexNormals();
	return source;

}
