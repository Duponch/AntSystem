// Éditeur de décor : sélection au clic (raycast sur les InstancedMesh),
// déplacement au glisser, rotation/échelle/suppression via le panneau,
// placement de nouveaux objets du catalogue. Les empreintes murales sont
// re-tamponnées après chaque édition (débouncé). Les changements se
// sauvegardent avec « Sauvegarder les réglages » (document JSON du décor).
// Tout est événementiel : zéro coût par frame, éditeur actif ou non.

import * as THREE from 'three/webgpu';
import { CATALOG } from './graphics/props.js';

export function createEditor( { scene, camera, renderer, controls, props, sim, ground, onSelect } ) {

	let enabled = false;
	let selected = null;              // { entry, index }
	let placing = null;               // nom de modèle en attente de placement
	let dragging = false;
	let stampsDirty = false;
	let stampTimer = null;

	const raycaster = new THREE.Raycaster();
	const ndc = new THREE.Vector2();

	// marqueur de sélection : anneau bleu au sol
	const marker = new THREE.Mesh(
		new THREE.RingGeometry( 0.85, 1, 48 ).rotateX( - Math.PI / 2 ),
		new THREE.MeshBasicNodeMaterial( {
			color: 0x7ec8ff, transparent: true, opacity: 0.85,
			depthWrite: false, fog: false,
		} ),
	);
	marker.position.y = 0.06;
	marker.renderOrder = 3;
	marker.visible = false;
	scene.add( marker );

	function setRay( event ) {

		const rect = renderer.domElement.getBoundingClientRect();
		ndc.set(
			( ( event.clientX - rect.left ) / rect.width ) * 2 - 1,
			- ( ( event.clientY - rect.top ) / rect.height ) * 2 + 1,
		);
		raycaster.setFromCamera( ndc, camera );

	}

	function groundPoint( event ) {

		setRay( event );
		const hit = raycaster.intersectObject( ground, false )[ 0 ];
		return hit ? hit.point : null;

	}

	function pick( event ) {

		setRay( event );
		const meshes = props.registry.map( ( e ) => e.mesh );
		const hit = raycaster.intersectObjects( meshes, false )[ 0 ];
		if ( ! hit || hit.instanceId === undefined ) return null;

		const entry = props.registry.find( ( e ) => e.mesh === hit.object );
		return entry ? { entry, index: hit.instanceId } : null;

	}

	function refreshMarker() {

		if ( ! selected ) {

			marker.visible = false;
			return;

		}

		const p = selected.entry.placements[ selected.index ];
		marker.position.set( p.x, 0.06, p.z );
		const footprint = Math.max( 1.2, p.scale * ( selected.entry.fit === 'height' ? 0.25 : 0.6 ) );
		marker.scale.setScalar( footprint );
		marker.visible = true;

	}

	let onSelectFn = onSelect || null;

	function select( sel ) {

		selected = sel;
		refreshMarker();
		if ( onSelectFn ) onSelectFn( sel );

	}

	function queueStamps() {

		stampsDirty = true;
		clearTimeout( stampTimer );
		stampTimer = setTimeout( () => {

			if ( stampsDirty ) {

				stampsDirty = false;
				sim.setObstacles( props.computeWallStamps() );

			}

		}, 350 );

	}

	// ------------------------------------------------------------------
	// Interactions (clic gauche : sélection / placement / glisser)
	// ------------------------------------------------------------------
	const dom = renderer.domElement;

	dom.addEventListener( 'pointerdown', async ( e ) => {

		if ( ! enabled || e.button !== 0 ) return;

		if ( placing ) {

			const p = groundPoint( e );

			if ( p ) {

				const info = CATALOG[ placing ];
				const ref = await props.addPlacement( placing, {
					x: p.x, z: p.z,
					yaw: Math.random() * Math.PI * 2,
					scale: info.defaultScale,
				} );
				select( ref );
				queueStamps();

			}

			placing = null;
			return;

		}

		const sel = pick( e );
		select( sel );
		dragging = !! sel;

	} );

	dom.addEventListener( 'pointermove', ( e ) => {

		if ( ! enabled || ! dragging || ! selected || ( e.buttons & 1 ) === 0 ) return;

		const p = groundPoint( e );
		if ( ! p ) return;

		props.updatePlacement( selected.entry, selected.index, { x: p.x, z: p.z } );
		refreshMarker();
		queueStamps();

	} );

	window.addEventListener( 'pointerup', () => {

		dragging = false;

	} );

	// ------------------------------------------------------------------
	return {
		get enabled() {

			return enabled;

		},
		get selected() {

			return selected;

		},
		setEnabled( on ) {

			enabled = on;
			if ( ! on ) {

				select( null );
				placing = null;

			}

		},
		bindOnSelect( fn ) {

			onSelectFn = fn;

		},
		startPlacing( model ) {

			placing = model;
			select( null );

		},
		applyToSelection( patch ) {

			if ( ! selected ) return;
			props.updatePlacement( selected.entry, selected.index, patch );
			refreshMarker();
			queueStamps();

		},
		deleteSelection() {

			if ( ! selected ) return;
			props.removePlacement( selected.entry, selected.index );
			select( null );
			queueStamps();

		},
	};

}
