import * as THREE from 'three/webgpu';
import { LAB_SURFACE_NODE_KIND } from './surface-navigation-graph.js';

// One semantic enum is shared by the bake, follower and overlay. An artistic
// refactor cannot silently recolor terrain as a transition or vice versa.
export const SURFACE_ROUTE_KIND = LAB_SURFACE_NODE_KIND;

export const SURFACE_ROUTE_DEBUG_COLORS = Object.freeze( {
	terrain: 0x55ddf2,
	support: 0x7be495,
	transition: 0xffd166,
	completed: 0x607486,
	active: 0xfff3a3,
	destination: 0xff5bc8,
} );

const DESTINATION_SEGMENTS = 3;
const COMPONENTS_PER_VERTEX = 3;
const VERTICES_PER_SEGMENT = 2;

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

/**
 * Fixed-storage route overlay for the physical laboratory.
 *
 * Route data is copied only when a click publishes a new corridor. Progress
 * changes rewrite the color attribute without replacing any typed array. There
 * is deliberately no frame callback or animation update method.
 */
export class SurfaceRouteDebugView {

	constructor( {
		scene,
		visible = false,
		maximumWaypoints = 32,
		surfaceOffset = 0.035,
		destinationSize = 0.16,
		opacity = 0.94,
		renderOrder = 19_990,
	} = {} ) {

		if ( ! scene?.isObject3D ) throw new TypeError( 'scene must be an Object3D' );
		this.scene = scene;
		this.maximumWaypoints = Math.max( 2, Math.min( 256,
			Math.trunc( finiteOr( maximumWaypoints, 32 ) ) ) );
		this.surfaceOffset = Math.max( 0, finiteOr( surfaceOffset, 0.035 ) );
		this.destinationSize = Math.max( 0.01, finiteOr( destinationSize, 0.16 ) );
		this.maximumRouteSegments = this.maximumWaypoints - 1;
		this.maximumSegments = this.maximumRouteSegments + DESTINATION_SEGMENTS;
		this.maximumVertices = this.maximumSegments * VERTICES_PER_SEGMENT;

		this.routePositions = new Float32Array( this.maximumWaypoints * COMPONENTS_PER_VERTEX );
		this.routeNormals = new Float32Array( this.maximumWaypoints * COMPONENTS_PER_VERTEX );
		this.routeKinds = new Uint8Array( this.maximumWaypoints );
		this.positions = new Float32Array( this.maximumVertices * COMPONENTS_PER_VERTEX );
		this.colors = new Float32Array( this.maximumVertices * COMPONENTS_PER_VERTEX );

		this.geometry = new THREE.BufferGeometry();
		this.positionAttribute = new THREE.BufferAttribute( this.positions, COMPONENTS_PER_VERTEX );
		this.positionAttribute.setUsage( THREE.DynamicDrawUsage );
		this.colorAttribute = new THREE.BufferAttribute( this.colors, COMPONENTS_PER_VERTEX );
		this.colorAttribute.setUsage( THREE.DynamicDrawUsage );
		this.geometry.setAttribute( 'position', this.positionAttribute );
		this.geometry.setAttribute( 'color', this.colorAttribute );
		this.geometry.setDrawRange( 0, 0 );

		this.material = new THREE.LineBasicMaterial( {
			vertexColors: true,
			depthTest: false,
			depthWrite: false,
			transparent: true,
			opacity: THREE.MathUtils.clamp( finiteOr( opacity, 0.94 ), 0, 1 ),
			toneMapped: false,
			fog: false,
		} );
		this.lines = new THREE.LineSegments( this.geometry, this.material );
		this.lines.name = 'ChameleonSurfaceRouteDebugView';
		this.lines.frustumCulled = false;
		this.lines.renderOrder = renderOrder;
		this.lines.matrixAutoUpdate = false;
		this.lines.matrixWorldAutoUpdate = false;
		this.lines.matrix.identity();
		this.lines.matrixWorld.identity();
		this.lines.castShadow = false;
		this.lines.receiveShadow = false;

		this._terrainColor = new THREE.Color( SURFACE_ROUTE_DEBUG_COLORS.terrain );
		this._supportColor = new THREE.Color( SURFACE_ROUTE_DEBUG_COLORS.support );
		this._transitionColor = new THREE.Color( SURFACE_ROUTE_DEBUG_COLORS.transition );
		this._completedColor = new THREE.Color( SURFACE_ROUTE_DEBUG_COLORS.completed );
		this._activeColor = new THREE.Color( SURFACE_ROUTE_DEBUG_COLORS.active );
		this._destinationColor = new THREE.Color( SURFACE_ROUTE_DEBUG_COLORS.destination );

		this.routeCount = 0;
		this.routeSegmentCount = 0;
		this.progressIndex = 0;
		this.enabled = false;
		this.disposed = false;
		this.setVisible( visible );

	}

	_readRoutePoint( route, index ) {

		const source = index * COMPONENTS_PER_VERTEX;
		const x = Number( route.positions?.[ source ] );
		const y = Number( route.positions?.[ source + 1 ] );
		const z = Number( route.positions?.[ source + 2 ] );
		if ( ! Number.isFinite( x ) || ! Number.isFinite( y ) || ! Number.isFinite( z ) )
			return false;

		let nx = Number( route.normals?.[ source ] ?? 0 );
		let ny = Number( route.normals?.[ source + 1 ] ?? 1 );
		let nz = Number( route.normals?.[ source + 2 ] ?? 0 );
		let length = Math.hypot( nx, ny, nz );
		if ( ! Number.isFinite( length ) || length <= 1e-8 ) {

			nx = 0; ny = 1; nz = 0; length = 1;

		}
		nx /= length; ny /= length; nz /= length;
		this.routePositions[ source ] = x + nx * this.surfaceOffset;
		this.routePositions[ source + 1 ] = y + ny * this.surfaceOffset;
		this.routePositions[ source + 2 ] = z + nz * this.surfaceOffset;
		this.routeNormals[ source ] = nx;
		this.routeNormals[ source + 1 ] = ny;
		this.routeNormals[ source + 2 ] = nz;
		const kind = Math.trunc( Number( route.kinds?.[ index ] ) );
		this.routeKinds[ index ] = kind === SURFACE_ROUTE_KIND.SUPPORT
			|| kind === SURFACE_ROUTE_KIND.TRANSITION ? kind : SURFACE_ROUTE_KIND.TERRAIN;
		return true;

	}

	_writeVertex( vertex, x, y, z ) {

		const offset = vertex * COMPONENTS_PER_VERTEX;
		this.positions[ offset ] = x;
		this.positions[ offset + 1 ] = y;
		this.positions[ offset + 2 ] = z;

	}

	_writeRouteSegments() {

		for ( let segment = 0; segment < this.routeSegmentCount; segment ++ ) {

			const from = segment * COMPONENTS_PER_VERTEX;
			const to = ( segment + 1 ) * COMPONENTS_PER_VERTEX;
			const vertex = segment * VERTICES_PER_SEGMENT;
			this._writeVertex( vertex,
				this.routePositions[ from ],
				this.routePositions[ from + 1 ],
				this.routePositions[ from + 2 ] );
			this._writeVertex( vertex + 1,
				this.routePositions[ to ],
				this.routePositions[ to + 1 ],
				this.routePositions[ to + 2 ] );

		}

	}

	_writeDestinationMarker() {

		if ( this.routeCount <= 0 ) return;
		const routeOffset = ( this.routeCount - 1 ) * COMPONENTS_PER_VERTEX;
		const cx = this.routePositions[ routeOffset ];
		const cy = this.routePositions[ routeOffset + 1 ];
		const cz = this.routePositions[ routeOffset + 2 ];
		const nx = this.routeNormals[ routeOffset ];
		const ny = this.routeNormals[ routeOffset + 1 ];
		const nz = this.routeNormals[ routeOffset + 2 ];

		let tx;
		let ty;
		let tz;
		if ( Math.abs( ny ) < 0.9 ) {

			tx = - nz; ty = 0; tz = nx;

		} else {

			tx = 1; ty = 0; tz = 0;

		}
		const tangentLength = Math.hypot( tx, ty, tz ) || 1;
		tx /= tangentLength; ty /= tangentLength; tz /= tangentLength;
		const bx = ny * tz - nz * ty;
		const by = nz * tx - nx * tz;
		const bz = nx * ty - ny * tx;
		const size = this.destinationSize;
		const firstVertex = this.routeSegmentCount * VERTICES_PER_SEGMENT;

		this._writeVertex( firstVertex,
			cx - tx * size, cy - ty * size, cz - tz * size );
		this._writeVertex( firstVertex + 1,
			cx + tx * size, cy + ty * size, cz + tz * size );
		this._writeVertex( firstVertex + 2,
			cx - bx * size, cy - by * size, cz - bz * size );
		this._writeVertex( firstVertex + 3,
			cx + bx * size, cy + by * size, cz + bz * size );
		this._writeVertex( firstVertex + 4, cx, cy, cz );
		this._writeVertex( firstVertex + 5,
			cx + nx * size * 0.85,
			cy + ny * size * 0.85,
			cz + nz * size * 0.85 );

	}

	_colorForKind( kind ) {

		if ( kind === SURFACE_ROUTE_KIND.SUPPORT ) return this._supportColor;
		if ( kind === SURFACE_ROUTE_KIND.TRANSITION ) return this._transitionColor;
		return this._terrainColor;

	}

	_writeColor( vertex, color ) {

		const offset = vertex * COMPONENTS_PER_VERTEX;
		this.colors[ offset ] = color.r;
		this.colors[ offset + 1 ] = color.g;
		this.colors[ offset + 2 ] = color.b;

	}

	_refreshColors() {

		for ( let segment = 0; segment < this.routeSegmentCount; segment ++ ) {

			let color;
			if ( segment < this.progressIndex ) color = this._completedColor;
			else if ( segment === this.progressIndex ) color = this._activeColor;
			else color = this._colorForKind( this.routeKinds[ segment + 1 ] );
			const vertex = segment * VERTICES_PER_SEGMENT;
			this._writeColor( vertex, color );
			this._writeColor( vertex + 1, color );

		}
		const markerVertex = this.routeSegmentCount * VERTICES_PER_SEGMENT;
		for ( let index = 0; index < DESTINATION_SEGMENTS * VERTICES_PER_SEGMENT; index ++ )
			this._writeColor( markerVertex + index, this._destinationColor );
		this.colorAttribute.needsUpdate = true;

	}

	setRoute( route ) {

		if ( this.disposed ) return this;
		const requested = Math.max( 0, Math.min(
			this.maximumWaypoints,
			Math.trunc( Number( route?.count ) || 0 ),
		) );
		this.routeCount = 0;
		for ( let index = 0; index < requested; index ++ ) {

			if ( ! this._readRoutePoint( route, index ) ) break;
			this.routeCount ++;

		}
		if ( this.routeCount === 0 ) return this.clear();
		this.routeSegmentCount = Math.max( 0, this.routeCount - 1 );
		this._writeRouteSegments();
		this._writeDestinationMarker();
		this.positionAttribute.needsUpdate = true;
		this.geometry.setDrawRange(
			0,
			( this.routeSegmentCount + DESTINATION_SEGMENTS ) * VERTICES_PER_SEGMENT,
		);
		this.progressIndex = Math.max( 0, Math.min(
			this.routeSegmentCount,
			Math.trunc( Number( route?.progressIndex ) || 0 ),
		) );
		this._refreshColors();
		return this;

	}

	setProgress( index ) {

		if ( this.disposed || this.routeCount === 0 ) return this;
		const next = Math.max( 0, Math.min(
			this.routeSegmentCount,
			Math.trunc( finiteOr( Number( index ), 0 ) ),
		) );
		if ( next === this.progressIndex ) return this;
		this.progressIndex = next;
		this._refreshColors();
		return this;

	}

	clear() {

		if ( this.disposed ) return this;
		this.routeCount = 0;
		this.routeSegmentCount = 0;
		this.progressIndex = 0;
		this.geometry.setDrawRange( 0, 0 );
		return this;

	}

	setVisible( visible ) {

		if ( this.disposed ) return this;
		const next = !! visible;
		if ( next === this.enabled ) return this;
		this.enabled = next;
		if ( next ) this.scene.add( this.lines );
		else this.lines.removeFromParent();
		return this;

	}

	dispose() {

		if ( this.disposed ) return;
		this.clear();
		this.setVisible( false );
		this.disposed = true;
		this.geometry.dispose();
		this.material.dispose();

	}

}
