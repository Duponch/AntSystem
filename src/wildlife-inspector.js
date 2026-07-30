import * as THREE from 'three/webgpu';

import { gfx } from './config.js';

const NO_SELECTION = 'none';
const CHAMELEON_SELECTION = 'chameleon';
const BUTTERFLY_SELECTION = 'butterfly';
const HUD_REFRESH_SECONDS = 0.2;
const LOCAL_CONE_DIRECTION = new THREE.Vector3( 0, - 1, 0 );

const CHAMELEON_INTENTIONS = Object.freeze( {
	REST_SCAN: 'Observe les alentours',
	PATROL_LOG: 'Explore librement la carte',
	TRACK_PREY: 'Suit un papillon',
	AIM_AND_BRACE: 'Se cale avant l’attaque',
	STRIKE_EXTEND: 'Projette sa langue',
	CONTACT: 'Accroche sa proie',
	RETRACT_WITH_PREY: 'Ramène sa proie à la bouche',
	BITE_AND_SWALLOW: 'Avale le papillon',
	COOLDOWN: 'Récupère après l’attaque',
} );

const BUTTERFLY_INTENTIONS = Object.freeze( {
	CAPTURED: 'Capturé par la langue',
	DEVELOPING: 'Poursuit son cycle de vie',
	FLEE_CHAMELEON: 'Fuit le caméléon',
	FLY_TO_FLOWER: 'Cherche ou rejoint une fleur',
	FEED_AT_FLOWER: 'Butine une fleur',
	REST: 'Se repose',
} );

function finiteComponent( value ) {

	return Number.isFinite( value ) ? value : 0;

}

function escapeHtml( value ) {

	return String( value )
		.replaceAll( '&', '&amp;' )
		.replaceAll( '<', '&lt;' )
		.replaceAll( '>', '&gt;' )
		.replaceAll( '"', '&quot;' )
		.replaceAll( "'", '&#039;' );

}

function fixed( value, decimals = 1 ) {

	return finiteComponent( value ).toFixed( decimals ).replace( '.', ',' );

}

/**
 * Writes the closest logical butterfly hit by a world-space ray.
 *
 * This intentionally operates on the simulation SoA instead of raycasting the
 * VAT mesh: it is deterministic, bounded by MAX_BUTTERFLIES (64), and runs only
 * in response to a click. `output` is mutated so callers can reuse it.
 */
export function writeButterflyRayHit(
	views,
	count,
	origin,
	direction,
	output,
	{
		baseRadius = 0.24,
		angularRadius = 0.009,
		maxDistance = Infinity,
	} = {},
) {

	if ( ! output || typeof output !== 'object' ) throw new TypeError( 'output is required' );
	output.index = - 1;
	output.distance = Infinity;
	output.distanceToRay = Infinity;
	if ( ! views || ! origin || ! direction ) return output;

	const dx = finiteComponent( direction.x );
	const dy = finiteComponent( direction.y );
	const dz = finiteComponent( direction.z );
	const directionLength = Math.hypot( dx, dy, dz );
	if ( directionLength <= 1e-8 ) return output;
	const invDirectionLength = 1 / directionLength;
	const nx = dx * invDirectionLength;
	const ny = dy * invDirectionLength;
	const nz = dz * invDirectionLength;
	const ox = finiteComponent( origin.x );
	const oy = finiteComponent( origin.y );
	const oz = finiteComponent( origin.z );
	const activeCount = Math.max( 0, Math.min(
		Number.isFinite( count ) ? Math.floor( count ) : 0,
		views.x?.length || 0,
	) );

	for ( let index = 0; index < activeCount; index ++ ) {

		if ( views.visible && views.visible[ index ] !== 1 ) continue;
		const px = views.x[ index ] - ox;
		const py = views.y[ index ] - oy;
		const pz = views.z[ index ] - oz;
		const alongRay = px * nx + py * ny + pz * nz;
		if ( alongRay <= 0 || alongRay >= output.distance || alongRay > maxDistance ) continue;
		const pointDistanceSq = px * px + py * py + pz * pz;
		const rayDistanceSq = Math.max( 0, pointDistanceSq - alongRay * alongRay );
		const pickRadius = Math.max( 0.001, baseRadius + alongRay * angularRadius );
		if ( rayDistanceSq > pickRadius * pickRadius ) continue;

		output.index = index;
		output.distance = alongRay;
		output.distanceToRay = Math.sqrt( rayDistanceSq );

	}
	return output;

}

export function buildWildlifeHudView( kind, data ) {

	if ( kind === CHAMELEON_SELECTION ) {

		const stateName = data?.stateName || 'INCONNU';
		const intention = CHAMELEON_INTENTIONS[ stateName ] || 'Analyse son environnement';
		const targetIndex = Number.isInteger( data?.targetIndex ) ? data.targetIndex : - 1;
		const capturedIndex = Number.isInteger( data?.capturedIndex ) ? data.capturedIndex : - 1;
		const threat = capturedIndex >= 0
			? `Papillon #${ capturedIndex } capturé`
			: targetIndex >= 0
				? `Papillon #${ targetIndex } suivi`
				: 'Aucune proie verrouillée';
		const supportName = data?.supportModel || data?.supportKind || 'sol';
		const support = `${ supportName } · segment ${ Math.max( 0, Math.round( data?.supportSegment || 0 ) ) }`;
		const camouflage = data?.camouflaged
			? `Actif \u00b7 peau adapt\u00e9e au d\u00e9cor \u00b7 relief encore perceptible \u00b7 non d\u00e9tect\u00e9 par les papillons${ data.camouflageRemaining > 0 ? ` \u00b7 ${ fixed( data.camouflageRemaining ) } s` : '' }`
			: 'Inactif \u00b7 visible des papillons';
		const navigation = `Locale \u00b7 ${ fixed( data?.routePosition ) }/${ fixed( data?.routeLength ) } u \u00b7 ${ Math.round( data?.explorationDecisions || 0 ) } choix`;
		const physicalContactDetails = [];
		if ( typeof data?.physicalContacts === 'boolean' ) {

			physicalContactDetails.push( data.physicalContacts ? 'Actifs' : 'Désactivés' );

		} else if ( Number.isFinite( data?.physicalContacts ) ) {

			physicalContactDetails.push( `${ Math.max( 0, Math.round( data.physicalContacts ) ) } contacts` );

		}
		if ( Number.isFinite( data?.groundedFeet ) ) {

			physicalContactDetails.push( `${ Math.max( 0, Math.round( data.groundedFeet ) ) }/4 appuis` );

		}
		if ( Number.isFinite( data?.surfaceTriangleCount ) ) {

			physicalContactDetails.push( `${ Math.max( 0, Math.round( data.surfaceTriangleCount ) ) } triangles` );

		}
		if ( Number.isFinite( data?.contactFrequency ) ) {

			physicalContactDetails.push( `${ fixed( data.contactFrequency, 0 ) } Hz` );

		}
		if ( Number.isFinite( data?.gaitSteps ) ) {

			physicalContactDetails.push( `${ Math.max( 0, Math.round( data.gaitSteps ) ) } pas` );

		}
		if ( Number.isFinite( data?.networkRebuildFailures )
			&& data.networkRebuildFailures > 0 ) {

			physicalContactDetails.push(
				`réseau : route précédente conservée après ${ Math.round( data.networkRebuildFailures ) } rejet(s)`,
			);

		}
		if ( data?.contactFrozen ) {

			const recovery = data.contactRecovery === 'attack-hold'
				? 'attaque poursuivie, position verrouillée'
				: data.contactRecovery === 'visual-pose-restore'
					? 'dernière pose visuelle sûre conservée'
					: 'correction locale en cours';
			physicalContactDetails.push( `sécurité : ${ recovery }` );

		}
		if ( Number.isFinite( data?.bodyResidual ) || Number.isFinite( data?.tailResidual ) ) {

			physicalContactDetails.push(
				`marges corps ${ fixed( data?.bodyResidual, 3 ) } / queue ${ fixed( data?.tailResidual, 3 ) }`,
			);

		}
		const physicalContacts = physicalContactDetails.length > 0
			? physicalContactDetails.join( ' \u00b7 ' )
			: 'T\u00e9l\u00e9m\u00e9trie non disponible';
		return {
			tone: data?.camouflaged ? 'camouflage' : targetIndex >= 0 ? 'danger' : 'neutral',
			html: `<div class="wildlife-head">
				<div class="wildlife-title">Caméléon</div>
				<div class="wildlife-badge">${ escapeHtml( data?.locomotionState || 'perché' ) }</div>
			</div>
			<div class="wildlife-intention">${ escapeHtml( intention ) }</div>
			<div class="wildlife-grid">
				<div class="wildlife-label">État</div><div>${ escapeHtml( stateName ) }</div>
				<div class="wildlife-label">Menace</div><div>${ escapeHtml( threat ) }</div>
				<div class="wildlife-label">Support</div><div>${ escapeHtml( support ) }</div>
				<div class="wildlife-label">Navigation</div><div>${ escapeHtml( navigation ) }</div>
				<div class="wildlife-label">Contacts physiques</div><div>${ escapeHtml( physicalContacts ) }</div>
				<div class="wildlife-label">Camouflage</div><div>${ escapeHtml( camouflage ) }</div>
				<div class="wildlife-label">Attaque</div><div>${ fixed( data?.attackDistance ) } u · détection ${ fixed( data?.detectionDistance ) } u</div>
			</div>`,
		};

	}

	if ( kind === BUTTERFLY_SELECTION ) {

		const intentionCode = data?.intention || 'REST';
		const intention = BUTTERFLY_INTENTIONS[ intentionCode ] || intentionCode;
		const threat = data?.threatVisible
			? `Caméléon vu à ${ fixed( data?.threatDistance ) } u`
			: data?.fearRemaining > 0
				? `Fuite mémorisée · ${ fixed( data.fearRemaining ) } s`
				: data?.predatorCamouflaged
					? 'Caméléon camouflé · non perçu'
					: 'Aucune menace perçue';
		const support = data?.captured
			? 'Langue du caméléon'
			: data?.targetFlower >= 0
				? `Fleur #${ Math.round( data.targetFlower ) }`
				: data?.behavior === 'FLY'
					? 'Vol libre'
					: 'Repos dans l’habitat';
		return {
			tone: data?.captured || data?.threatVisible ? 'danger' : 'neutral',
			html: `<div class="wildlife-head">
				<div class="wildlife-title">Papillon #${ Math.max( 0, Math.round( data?.index || 0 ) ) }</div>
				<div class="wildlife-badge">${ escapeHtml( data?.stage || 'ADULT' ) }</div>
			</div>
			<div class="wildlife-intention">${ escapeHtml( intention ) }</div>
			<div class="wildlife-grid">
				<div class="wildlife-label">État</div><div>${ escapeHtml( data?.behavior || 'INCONNU' ) }</div>
				<div class="wildlife-label">Menace</div><div>${ escapeHtml( threat ) }</div>
				<div class="wildlife-label">Support</div><div>${ escapeHtml( support ) }</div>
				<div class="wildlife-label">Vision</div><div>${ fixed( data?.visionDistance ) } u · ${ fixed( data?.visionFovDegrees, 0 ) }°</div>
				<div class="wildlife-label">Camouflage</div><div>${ data?.predatorCamouflaged ? 'Prédateur invisible' : 'Prédateur détectable' }</div>
			</div>`,
		};

	}

	return null;

}

function createHud( documentRef ) {

	if ( ! documentRef?.createElement ) return { hud: null, style: null, ownsStyle: false };
	let style = documentRef.getElementById?.( 'wildlife-inspector-style' ) || null;
	let ownsStyle = false;
	if ( ! style ) {

		style = documentRef.createElement( 'style' );
		ownsStyle = true;
		style.id = 'wildlife-inspector-style';
		style.textContent = `
			#wildlife-inspector {
				position:fixed; left:14px; top:14px; z-index:21;
				width:min(350px, calc(100vw - 28px)); box-sizing:border-box;
				padding:12px 14px; border:1px solid rgba(143, 204, 116, .42);
				border-radius:10px; background:rgba(9, 15, 10, .91);
				box-shadow:0 12px 35px rgba(0, 0, 0, .36); backdrop-filter:blur(8px);
				color:#e8eee3; font:12px/1.45 system-ui, sans-serif;
				pointer-events:none; display:none; user-select:none;
			}
			#wildlife-inspector[data-tone="danger"] { border-color:rgba(255, 109, 87, .75); }
			#wildlife-inspector[data-tone="camouflage"] { border-color:rgba(88, 220, 205, .86); box-shadow:0 12px 36px rgba(24, 116, 108, .28); }
			.wildlife-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:7px; }
			.wildlife-title { color:#f2d369; font-weight:760; letter-spacing:.025em; text-transform:uppercase; }
			.wildlife-badge { padding:2px 7px; border-radius:999px; color:#bcd6a7; background:rgba(135,173,105,.16); font-size:10px; text-transform:uppercase; }
			.wildlife-intention { color:#fff; font-size:15px; font-weight:700; margin-bottom:8px; }
			.wildlife-grid { display:grid; grid-template-columns:max-content 1fr; gap:3px 10px; padding-top:8px; border-top:1px solid rgba(255,255,255,.08); }
			.wildlife-label { color:#788573; }
			@media (max-width:620px) { #wildlife-inspector { top:8px; left:8px; width:calc(100vw - 16px); } }
		`;
		documentRef.head?.appendChild( style );

	}
	const hud = documentRef.createElement( 'section' );
	hud.id = 'wildlife-inspector';
	hud.setAttribute?.( 'aria-live', 'polite' );
	const root = documentRef.getElementById?.( 'app' ) || documentRef.body;
	root?.appendChild( hud );
	return { hud, style, ownsStyle };

}

function resolveChameleonModel( pollinators ) {

	const candidate = pollinators?.chameleon || pollinators?.model || null;
	return candidate?.model || candidate;

}

/**
 * Inspector shared by butterflies and the unique chameleon.
 *
 * All geometry, raycast arrays and math objects are allocated once. The only
 * population scan is the <=64 logical-butterfly loop inside `pick()`.
 */
export function createWildlifeInspector( {
	scene,
	pollinators,
	graphics = gfx,
	documentRef = globalThis.document,
} = {} ) {

	if ( ! scene?.add || ! scene?.remove ) throw new TypeError( 'scene is required' );
	if ( ! pollinators ) throw new TypeError( 'pollinators facade is required' );

	const debugGroup = new THREE.Group();
	debugGroup.name = 'SelectedWildlifeDebug';
	debugGroup.renderOrder = 1000;
	debugGroup.visible = false;

	const attackGeometry = new THREE.SphereGeometry( 1, 18, 12 );
	const attackMaterial = new THREE.MeshBasicMaterial( {
		color: 0xff5f45,
		wireframe: true,
		transparent: true,
		opacity: 0.48,
		depthWrite: false,
		depthTest: false,
	} );
	const attackVolume = new THREE.Mesh( attackGeometry, attackMaterial );
	attackVolume.name = 'SelectedChameleonAttackRange';
	attackVolume.frustumCulled = false;
	attackVolume.visible = false;

	const visionRangeGeometry = new THREE.SphereGeometry( 1, 18, 12 );
	const visionRangeMaterial = new THREE.MeshBasicMaterial( {
		color: 0x77d7ff,
		wireframe: true,
		transparent: true,
		opacity: 0.28,
		depthWrite: false,
		depthTest: false,
	} );
	const visionRange = new THREE.Mesh( visionRangeGeometry, visionRangeMaterial );
	visionRange.name = 'SelectedButterflyVisionRange';
	visionRange.frustumCulled = false;
	const visionConeGeometry = new THREE.ConeGeometry( 1, 1, 20, 1, true );
	const visionConeMaterial = new THREE.MeshBasicMaterial( {
		color: 0x77d7ff,
		wireframe: true,
		transparent: true,
		opacity: 0.5,
		depthWrite: false,
		depthTest: false,
	} );
	const visionCone = new THREE.Mesh( visionConeGeometry, visionConeMaterial );
	visionCone.name = 'SelectedButterflyVisionBoundary';
	visionCone.frustumCulled = false;
	const visionVolume = new THREE.Group();
	visionVolume.name = 'SelectedButterflyVision';
	visionVolume.visible = false;
	visionVolume.add( visionRange, visionCone );
	debugGroup.add( attackVolume, visionVolume );
	scene.add( debugGroup );

	const { hud, style, ownsStyle } = createHud( documentRef );
	const selection = Object.seal( { kind: NO_SELECTION, index: - 1 } );
	const raycaster = new THREE.Raycaster();
	const rayDirection = new THREE.Vector3();
	const rayIntersections = [];
	const butterflyHit = { index: - 1, distance: Infinity, distanceToRay: Infinity };
	const coneHeading = new THREE.Vector3();
	const coneCentre = new THREE.Vector3();
	let surfaceVisible = true;
	let hudCountdown = 0;
	let hudDirty = true;
	let lastHudHtml = '';
	let lastVisionWide = null;
	let disposed = false;

	function setHud( view ) {

		if ( ! hud ) return;
		if ( ! view || ! surfaceVisible ) {

			hud.style.display = 'none';
			return;

		}
		if ( view.html !== lastHudHtml ) {

			lastHudHtml = view.html;
			hud.innerHTML = view.html;
			hud.dataset.tone = view.tone;

		}
		hud.style.display = 'block';

	}

	function hideDebug() {

		attackVolume.visible = false;
		visionVolume.visible = false;

	}

	function clear() {

		if ( selection.kind === NO_SELECTION ) return;
		pollinators.clearButterflySelection?.();
		pollinators.selectChameleon?.( false );
		selection.kind = NO_SELECTION;
		selection.index = - 1;
		hideDebug();
		debugGroup.visible = false;
		hudDirty = true;
		lastHudHtml = '';
		setHud( null );

	}

	function chooseButterfly( index ) {

		pollinators.selectChameleon?.( false );
		pollinators.selectButterfly?.( index );
		selection.kind = BUTTERFLY_SELECTION;
		selection.index = index;
		hudDirty = true;
		hudCountdown = 0;
		return selection;

	}

	function chooseChameleon() {

		pollinators.clearButterflySelection?.();
		pollinators.selectChameleon?.( true );
		selection.kind = CHAMELEON_SELECTION;
		selection.index = 0;
		hudDirty = true;
		hudCountdown = 0;
		return selection;

	}

	function pick( rayOrigin, rayDirectionInput ) {

		if ( disposed || ! surfaceVisible || ! rayOrigin || ! rayDirectionInput ) return null;
		rayDirection.copy( rayDirectionInput );
		if ( rayDirection.lengthSq() <= 1e-12 ) return null;
		rayDirection.normalize();
		raycaster.set( rayOrigin, rayDirection );

		let chameleonDistance = Infinity;
		const chameleonModel = resolveChameleonModel( pollinators );
		if (
			graphics.chameleonEnabled !== false
			&& chameleonModel?.visible !== false
			&& chameleonModel?.isObject3D
		) {

			chameleonModel.updateWorldMatrix?.( true, true );
			rayIntersections.length = 0;
			raycaster.intersectObject( chameleonModel, true, rayIntersections );
			if ( rayIntersections.length > 0 ) chameleonDistance = rayIntersections[ 0 ].distance;

		}

		const simulation = pollinators.getButterflySimulation?.();
		if (
			graphics.pollinators !== false
			&& graphics.butterflies !== false
			&& simulation?.getViews
		) {

			const baseRadius = Math.max( 0.18, finiteComponent( graphics.butterflyScale ) * 0.22 );
			writeButterflyRayHit(
				simulation.getViews(),
				simulation.count,
				rayOrigin,
				rayDirection,
				butterflyHit,
				{ baseRadius, angularRadius: 0.009 },
			);

		} else {

			butterflyHit.index = - 1;
			butterflyHit.distance = Infinity;

		}

		if ( butterflyHit.index >= 0 && butterflyHit.distance < chameleonDistance ) {

			return chooseButterfly( butterflyHit.index );

		}
		if ( chameleonDistance < Infinity ) return chooseChameleon();
		clear();
		return null;

	}

	function updateChameleonDebug() {

		const view = pollinators.getChameleonDebugView?.();
		if ( ! view || view.visible === false ) {

			// A disabled or unloaded predator cannot remain selected as a ghost.
			// `clear()` also releases the facade selection and hides the HUD.
			clear();
			return null;

		}
		const radius = Math.max( 0, finiteComponent(
			view.attackDistance ?? graphics.chameleonAttackDistance,
		) );
		attackVolume.position.set(
			finiteComponent( view.mouthX ?? view.x ),
			finiteComponent( view.mouthY ?? view.y ),
			finiteComponent( view.mouthZ ?? view.z ),
		);
		attackVolume.scale.setScalar( radius );
		attackVolume.visible = surfaceVisible && !! graphics.chameleonDebugAttackRange && radius > 0;
		return view;

	}

	function updateButterflyDebug() {

		const simulation = pollinators.getButterflySimulation?.();
		if ( ! simulation?.getViews || selection.index < 0 || selection.index >= simulation.count ) {

			clear();
			return null;

		}
		const views = simulation.getViews();
		const index = selection.index;
		if ( views.visible && views.visible[ index ] !== 1 ) {

			visionVolume.visible = false;
			return null;

		}
		coneHeading.set(
			finiteComponent( views.headingX?.[ index ] ),
			finiteComponent( views.headingY?.[ index ] ),
			finiteComponent( views.headingZ?.[ index ] ),
		);
		if ( coneHeading.lengthSq() < 1e-8 ) coneHeading.set( 0, 0, 1 );
		else coneHeading.normalize();
		const distance = Math.max( 0.01, finiteComponent( graphics.butterflyPredatorVisionDistance ) );
		const fieldOfView = Math.min(
			360,
			Math.max( 1, finiteComponent( graphics.butterflyPredatorVisionAngle ) ),
		);
		const wideField = fieldOfView > 180;
		const representedAngle = wideField ? 360 - fieldOfView : fieldOfView;
		const halfAngle = THREE.MathUtils.degToRad(
			Math.min( 89.5, Math.max( 0.5, representedAngle * 0.5 ) ),
		);
		const radius = Math.tan( halfAngle ) * distance;
		if ( wideField ) coneHeading.multiplyScalar( - 1 );
		visionVolume.position.set(
			finiteComponent( views.x?.[ index ] ),
			finiteComponent( views.y?.[ index ] ),
			finiteComponent( views.z?.[ index ] ),
		);
		coneCentre.copy( coneHeading ).multiplyScalar( distance * 0.5 );
		visionCone.position.copy( coneCentre );
		visionCone.quaternion.setFromUnitVectors( LOCAL_CONE_DIRECTION, coneHeading );
		visionCone.scale.set( radius, distance, radius );
		if ( wideField !== lastVisionWide ) {

			visionCone.material.color.setHex( wideField ? 0xffb35a : 0x77d7ff );
			visionCone.name = wideField
				? 'SelectedButterflyBlindCone'
				: 'SelectedButterflyVisionBoundary';
			lastVisionWide = wideField;

		}
		visionCone.visible = representedAngle > 0.5;
		visionRange.visible = wideField;
		visionRange.scale.setScalar( distance );
		visionVolume.visible = surfaceVisible && !! graphics.butterflyDebugVision;
		return null;

	}

	function update( dt, visible = true ) {

		if ( disposed ) return null;
		if ( ! Number.isFinite( dt ) || dt < 0 ) throw new RangeError( 'dt must be finite and non-negative' );
		surfaceVisible = !! visible;
		debugGroup.visible = surfaceVisible && selection.kind !== NO_SELECTION;
		if ( selection.kind === NO_SELECTION ) {

			hideDebug();
			setHud( null );
			return null;

		}
		if ( ! surfaceVisible ) {

			hideDebug();
			setHud( null );
			hudDirty = true;
			return null;

		}

		let data = null;
		if ( selection.kind === CHAMELEON_SELECTION ) {

			visionVolume.visible = false;
			data = updateChameleonDebug();

		} else {

			attackVolume.visible = false;
			data = updateButterflyDebug();

		}

		hudCountdown -= Math.min( 1, dt );
		if ( hudDirty || hudCountdown <= 0 ) {

			if ( selection.kind === BUTTERFLY_SELECTION ) {

				data = pollinators.getButterflyDebugSnapshot?.() || data;

			}
			setHud( buildWildlifeHudView( selection.kind, data ) );
			hudCountdown = HUD_REFRESH_SECONDS;
			hudDirty = false;

		} else if ( hud ) {

			hud.style.display = surfaceVisible ? 'block' : 'none';

		}
		return data;

	}

	function dispose() {

		if ( disposed ) return;
		clear();
		disposed = true;
		scene.remove( debugGroup );
		attackGeometry.dispose();
		attackMaterial.dispose();
		visionRangeGeometry.dispose();
		visionRangeMaterial.dispose();
		visionConeGeometry.dispose();
		visionConeMaterial.dispose();
		hud?.remove?.();
		if ( ownsStyle ) style?.remove?.();

	}

	return {
		update,
		pick,
		clear,
		dispose,
		group: debugGroup,
		attackVolume,
		visionVolume,
		get selected() {

			return selection.kind === NO_SELECTION ? null : selection;

		},
	};

}
