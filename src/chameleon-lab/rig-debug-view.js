import * as THREE from 'three/webgpu';

const DEFAULT_ROOT_COLOR = 0xff5bc8;
const DEFAULT_TIP_COLOR = 0x55f7ff;

function collectBoneEdges( root ) {

	const parents = [];
	const children = [];
	const leaves = [];
	let boneCount = 0;
	root.traverse( ( object ) => {

		if ( object.isBone !== true ) return;
		boneCount ++;
		if ( object.parent?.isBone === true ) {

			parents.push( object.parent );
			children.push( object );

		}
		const hasBoneChild = object.children.some( ( child ) => child.isBone === true );
		const restLength = Number( object.userData?.rest_length );
		if ( ! hasBoneChild && Number.isFinite( restLength ) && restLength > 1e-5 )
			leaves.push( object );

	} );
	return { parents, children, leaves, boneCount };

}

/**
 * Allocation-free, see-through rig overlay for the physical laboratory.
 *
 * Bone matrices are sampled directly into one dynamic line buffer immediately
 * before rendering. Disabled overlays are removed from the scene entirely, so
 * they have no traversal, upload or draw-call cost.
 */
export class RigDebugView {

	constructor( {
		scene,
		root,
		visible = false,
		rootColor = DEFAULT_ROOT_COLOR,
		tipColor = DEFAULT_TIP_COLOR,
		opacity = 0.96,
		renderOrder = 20_000,
	} = {} ) {

		if ( ! scene?.isObject3D ) throw new TypeError( 'scene must be an Object3D' );
		if ( ! root?.isObject3D ) throw new TypeError( 'root must be an Object3D' );
		const edges = collectBoneEdges( root );
		if ( edges.children.length === 0 )
			throw new Error( 'rig debug view requires at least one parented bone' );

		this.scene = scene;
		this.root = root;
		this.edgeParents = edges.parents;
		this.edgeChildren = edges.children;
		this.leafBones = edges.leaves;
		this.edgeCount = edges.children.length;
		this.segmentCount = this.edgeCount + edges.leaves.length;
		this.positions = new Float32Array( this.segmentCount * 6 );
		this.colors = new Float32Array( this.segmentCount * 6 );
		this.rootColor = new THREE.Color();
		this.tipColor = new THREE.Color();
		this.geometry = new THREE.BufferGeometry();
		this.positionAttribute = new THREE.BufferAttribute( this.positions, 3 );
		this.positionAttribute.setUsage( THREE.DynamicDrawUsage );
		this.colorAttribute = new THREE.BufferAttribute( this.colors, 3 );
		this.geometry.setAttribute( 'position', this.positionAttribute );
		this.geometry.setAttribute( 'color', this.colorAttribute );
		this.material = new THREE.LineBasicMaterial( {
			vertexColors: true,
			depthTest: false,
			depthWrite: false,
			transparent: true,
			opacity: THREE.MathUtils.clamp( Number( opacity ) || 0, 0, 1 ),
			toneMapped: false,
		} );
		this.lines = new THREE.LineSegments( this.geometry, this.material );
		this.lines.name = 'ChameleonRigDebugView';
		this.lines.frustumCulled = false;
		this.lines.renderOrder = renderOrder;
		this.lines.matrixAutoUpdate = false;
		this.lines.matrixWorldAutoUpdate = false;
		this.lines.matrix.identity();
		this.lines.matrixWorld.identity();
		this.enabled = false;
		this.disposed = false;
		this.view = Object.seal( {
			visible: false,
			boneCount: edges.boneCount,
			segmentCount: this.segmentCount,
			updates: 0,
			positions: this.positions,
			colors: this.colors,
			lines: this.lines,
		} );
		this._onBeforeRender = () => this.update( false );
		this.lines.onBeforeRender = this._onBeforeRender;
		this.setColors( rootColor, tipColor );
		this.setVisible( visible );

	}

	setColors( rootColor, tipColor ) {

		this.rootColor.set( rootColor );
		this.tipColor.set( tipColor );
		for ( let segment = 0; segment < this.segmentCount; segment ++ ) {

			const offset = segment * 6;
			this.colors[ offset ] = this.rootColor.r;
			this.colors[ offset + 1 ] = this.rootColor.g;
			this.colors[ offset + 2 ] = this.rootColor.b;
			this.colors[ offset + 3 ] = this.tipColor.r;
			this.colors[ offset + 4 ] = this.tipColor.g;
			this.colors[ offset + 5 ] = this.tipColor.b;

		}
		this.colorAttribute.needsUpdate = true;
		return this;

	}

	setOpacity( opacity ) {

		if ( ! Number.isFinite( opacity ) ) throw new RangeError( 'opacity must be finite' );
		this.material.opacity = THREE.MathUtils.clamp( opacity, 0, 1 );
		return this;

	}

	setVisible( visible ) {

		if ( this.disposed ) return this;
		visible = Boolean( visible );
		if ( visible === this.enabled ) return this;
		this.enabled = visible;
		this.view.visible = visible;
		if ( visible ) {

			this.scene.add( this.lines );
			this.update( true );

		} else this.lines.removeFromParent();
		return this;

	}

	/**
	 * Public refresh for headless inspection. Rendering calls this automatically
	 * with updateMatrices=false after the scene graph has updated.
	 */
	update( updateMatrices = true ) {

		if ( ! this.enabled || this.disposed ) return this.view;
		if ( updateMatrices ) this.root.updateWorldMatrix( true, true );
		for ( let segment = 0; segment < this.edgeCount; segment ++ ) {

			const parentMatrix = this.edgeParents[ segment ].matrixWorld.elements;
			const childMatrix = this.edgeChildren[ segment ].matrixWorld.elements;
			const offset = segment * 6;
			this.positions[ offset ] = parentMatrix[ 12 ];
			this.positions[ offset + 1 ] = parentMatrix[ 13 ];
			this.positions[ offset + 2 ] = parentMatrix[ 14 ];
			this.positions[ offset + 3 ] = childMatrix[ 12 ];
			this.positions[ offset + 4 ] = childMatrix[ 13 ];
			this.positions[ offset + 5 ] = childMatrix[ 14 ];

		}
		for ( let leaf = 0; leaf < this.leafBones.length; leaf ++ ) {

			const bone = this.leafBones[ leaf ];
			const matrix = bone.matrixWorld.elements;
			const length = Number( bone.userData.rest_length );
			const offset = ( this.edgeCount + leaf ) * 6;
			this.positions[ offset ] = matrix[ 12 ];
			this.positions[ offset + 1 ] = matrix[ 13 ];
			this.positions[ offset + 2 ] = matrix[ 14 ];
			// Blender bones are exported along local +Y. Transforming that axis
			// explicitly reveals terminal digits, jaw and the original tail tip.
			this.positions[ offset + 3 ] = matrix[ 12 ] + matrix[ 4 ] * length;
			this.positions[ offset + 4 ] = matrix[ 13 ] + matrix[ 5 ] * length;
			this.positions[ offset + 5 ] = matrix[ 14 ] + matrix[ 6 ] * length;

		}
		this.positionAttribute.needsUpdate = true;
		this.view.updates ++;
		return this.view;

	}

	getView() {

		return this.view;

	}

	dispose() {

		if ( this.disposed ) return;
		this.lines.removeFromParent();
		this.lines.onBeforeRender = null;
		this.geometry.dispose();
		this.material.dispose();
		this.enabled = false;
		this.view.visible = false;
		this.disposed = true;

	}

}

export function createRigDebugView( options ) {

	return new RigDebugView( options );

}
