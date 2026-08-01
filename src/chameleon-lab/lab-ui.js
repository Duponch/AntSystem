function makeRange( {
	parent,
	label,
	object,
	property,
	min,
	max,
	step,
	format = ( value ) => Number( value ).toFixed( 2 ),
	help = '',
	onInput = null,
} ) {

	const row = document.createElement( 'label' );
	row.className = 'chameleon-lab-control';
	const text = document.createElement( 'span' );
	text.textContent = label;
	const input = document.createElement( 'input' );
	input.type = 'range';
	input.setAttribute( 'aria-label', help ? `${ label } — ${ help }` : label );
	if ( help ) input.title = help;
	input.min = min;
	input.max = max;
	input.step = step;
	input.value = object[ property ];
	const output = document.createElement( 'output' );
	const refresh = () => {

		object[ property ] = Number( input.value );
		output.textContent = format( object[ property ] );
		onInput?.( object[ property ] );

	};
	input.addEventListener( 'input', refresh );
	refresh();
	row.append( text, input, output );
	if ( help ) {

		const hint = document.createElement( 'small' );
		hint.className = 'chameleon-lab-control-help';
		hint.textContent = help;
		row.append( hint );

	}
	parent.append( row );
	return input;

}

function makeToggle( {
	parent,
	label,
	object,
	property,
	onInput = null,
} ) {

	const row = document.createElement( 'label' );
	row.className = 'chameleon-lab-toggle';
	const text = document.createElement( 'span' );
	text.textContent = label;
	const input = document.createElement( 'input' );
	input.type = 'checkbox';
	input.checked = object[ property ];
	input.addEventListener( 'change', () => {

		object[ property ] = input.checked;
		onInput?.( input.checked );

	} );
	row.append( text, input );
	parent.append( row );
	return input;

}

function fieldset( parent, title, help = '' ) {

	const root = document.createElement( 'fieldset' );
	const legend = document.createElement( 'legend' );
	legend.textContent = title;
	root.append( legend );
	if ( help ) {

		const hint = document.createElement( 'p' );
		hint.className = 'chameleon-lab-field-help';
		hint.textContent = help;
		root.append( hint );

	}
	parent.append( root );
	return root;

}

export const CHAMELEON_LAB_MOVEMENT_DEFAULTS = Object.freeze( {
	jumpHeight: 0.72,
	airControl: 1,
	coyoteTime: 0.12,
	jumpBufferTime: 0.14,
	fallGravityScale: 1.42,
	jumpCutGravityScale: 2.05,
} );

export const CHAMELEON_LAB_DISPLAY_DEFAULTS = Object.freeze( {
	rigDebug: false,
} );

const JUMP_PHASE_LABELS = Object.freeze( {
	grounded: 'au sol',
	landing: 'amorti',
	preload: 'charge',
	takeoff: 'impulsion',
	rising: 'montée',
	apex: 'apogée',
	falling: 'chute',
} );

/**
 * Completes old or partially restored lab state without replacing valid
 * serialized values. The flat numeric shape remains JSON-safe.
 */
export function ensureLabMovementSettings( state ) {

	if ( ! state || typeof state !== 'object' )
		throw new TypeError( 'state must be an object' );
	for ( const property of Object.keys( CHAMELEON_LAB_MOVEMENT_DEFAULTS ) ) {

		if ( Number.isFinite( state[ property ] ) ) continue;
		state[ property ] = CHAMELEON_LAB_MOVEMENT_DEFAULTS[ property ];

	}
	return state;

}

export function ensureLabDisplaySettings( state ) {

	if ( ! state || typeof state !== 'object' )
		throw new TypeError( 'state must be an object' );
	for ( const [ property, fallback ] of Object.entries( CHAMELEON_LAB_DISPLAY_DEFAULTS ) )
		if ( typeof state[ property ] !== 'boolean' ) state[ property ] = fallback;
	return state;

}

function button( parent, text, onClick ) {

	const element = document.createElement( 'button' );
	element.type = 'button';
	element.className = 'chameleon-lab-button';
	element.textContent = text;
	element.addEventListener( 'click', onClick );
	parent.append( element );
	return element;

}

function stat( parent, label ) {

	const element = document.createElement( 'div' );
	element.className = 'chameleon-lab-stat';
	const caption = document.createElement( 'span' );
	caption.textContent = label;
	const value = document.createElement( 'strong' );
	value.textContent = '—';
	element.append( caption, value );
	parent.append( element );
	return value;

}

export function createLabUI( {
	ragdoll,
	physics,
	state,
	renderer,
	onReset,
	rigDebugView = null,
} ) {

	ensureLabMovementSettings( state );
	ensureLabDisplaySettings( state );

	const shell = document.createElement( 'div' );
	shell.className = 'chameleon-lab-shell';
	const panel = document.createElement( 'aside' );
	panel.className = 'chameleon-lab-panel';
	const title = document.createElement( 'h1' );
	title.textContent = 'Laboratoire physique · Caméléon hybride';
	const subtitle = document.createElement( 'p' );
	subtitle.className = 'subtitle';
	subtitle.textContent = 'Corps physique stable, appuis IK bornés et géométrie originale — queue comprise — sans téléportation.';
	panel.append( title, subtitle );

	const behavior = fieldset( panel, 'Pilotage' );
	const autonomousToggle = makeToggle( {
		parent: behavior,
		label: 'Exploration autonome (C)',
		object: state,
		property: 'autonomous',
	} );
	const ragdollToggle = makeToggle( {
		parent: behavior,
		label: 'Physique libre (F)',
		object: state,
		property: 'fullRagdoll',
	} );
	makeRange( {
		parent: behavior,
		label: 'Vitesse',
		object: ragdoll.settings,
		property: 'moveSpeed',
		min: 0.25,
		max: 3,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) } m/s`,
	} );
	makeRange( {
		parent: behavior,
		label: 'Animation',
		object: ragdoll.settings,
		property: 'animationSpeed',
		min: 0.1,
		max: 3,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) }×`,
	} );
	makeRange( {
		parent: behavior,
		label: 'Force motrice',
		object: ragdoll.settings,
		property: 'moveForce',
		min: 2,
		max: 35,
		step: 0.5,
		format: ( value ) => value.toFixed( 1 ),
	} );

	const platforming = fieldset(
		panel,
		'Suspension & saut',
		'Réglages physiques du corps et du saut. Ils agissent sur la simulation fixe, pas sur la caméra.',
	);
	makeRange( {
		parent: platforming,
		label: 'Suspension anatomique',
		object: ragdoll.settings,
		property: 'suspension',
		min: 0,
		max: 2,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) }×`,
		help: 'Amplitude de l’assiette et de l’amorti du tronc entre les quatre appuis.',
	} );
	makeRange( {
		parent: platforming,
		label: 'Hauteur de saut',
		object: state,
		property: 'jumpHeight',
		min: 0.1,
		max: 1.5,
		step: 0.02,
		format: ( value ) => `${ value.toFixed( 2 ) } m`,
		help: 'Hauteur balistique visée, indépendante de la fréquence d’image.',
	} );
	makeRange( {
		parent: platforming,
		label: 'Contrôle aérien',
		object: state,
		property: 'airControl',
		min: 0,
		max: 2,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) }×`,
		help: 'Autorité latérale en l’air : 0 conserve uniquement l’élan du décollage.',
	} );
	makeRange( {
		parent: platforming,
		label: 'Tolérance au bord',
		object: state,
		property: 'coyoteTime',
		min: 0,
		max: 0.3,
		step: 0.01,
		format: ( value ) => `${ value.toFixed( 2 ) } s`,
		help: 'Court délai pendant lequel le saut reste accepté après avoir quitté un rebord.',
	} );
	makeRange( {
		parent: platforming,
		label: 'Mémoire du saut',
		object: state,
		property: 'jumpBufferTime',
		min: 0,
		max: 0.3,
		step: 0.01,
		format: ( value ) => `${ value.toFixed( 2 ) } s`,
		help: 'Mémorise une pression juste avant l’atterrissage et saute dès le premier appui valide.',
	} );
	makeRange( {
		parent: platforming,
		label: 'Gravité de chute',
		object: state,
		property: 'fallGravityScale',
		min: 0.6,
		max: 3,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) }×`,
		help: 'Accélère ou adoucit uniquement la descente, sans modifier la hauteur de départ.',
	} );
	makeRange( {
		parent: platforming,
		label: 'Frein au relâchement',
		object: state,
		property: 'jumpCutGravityScale',
		min: 1,
		max: 4,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) }×`,
		help: 'Coupe progressivement un saut lorsque la touche Espace est relâchée tôt.',
	} );

	const muscles = fieldset( panel, 'Stabilisation' );
	makeRange( {
		parent: muscles,
		label: 'Stabilité du corps',
		object: ragdoll.settings,
		property: 'motorStrength',
		min: 0,
		max: 2.5,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) }×`,
	} );
	makeRange( {
		parent: muscles,
		label: 'Amortissement',
		object: ragdoll.settings,
		property: 'motorDamping',
		min: 0.2,
		max: 2.5,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) }×`,
	} );
	makeRange( {
		parent: muscles,
		label: 'Tonus passif',
		object: ragdoll.settings,
		property: 'limbMuscleTone',
		min: 0,
		max: 0.45,
		step: 0.01,
		format: ( value ) => value.toFixed( 2 ),
		help: 'Tension musculaire résiduelle pendant la saisie et le mode physique libre.',
	} );
	makeRange( {
		parent: muscles,
		label: 'Cadence',
		object: ragdoll.settings,
		property: 'gaitFrequency',
		min: 0.25,
		max: 3,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) } Hz`,
	} );
	makeRange( {
		parent: muscles,
		label: 'Longueur du pas',
		object: ragdoll.settings,
		property: 'stepLength',
		min: 0.08,
		max: 0.34,
		step: 0.005,
		format: ( value ) => `${ value.toFixed( 3 ) } m`,
	} );
	makeRange( {
		parent: muscles,
		label: 'Hauteur du pas',
		object: ragdoll.settings,
		property: 'stepHeight',
		min: 0.015,
		max: 0.20,
		step: 0.005,
		format: ( value ) => `${ value.toFixed( 3 ) } m`,
	} );
	makeRange( {
		parent: muscles,
		label: 'Amplitude épaules / hanches',
		object: ragdoll.settings,
		property: 'strideAmplitude',
		min: 0.1,
		max: 0.9,
		step: 0.01,
		format: ( value ) => `${ value.toFixed( 2 ) } rad`,
	} );
	makeRange( {
		parent: muscles,
		label: 'Levée des membres',
		object: ragdoll.settings,
		property: 'limbLift',
		min: 0,
		max: 0.75,
		step: 0.01,
		format: ( value ) => `${ value.toFixed( 2 ) } rad`,
	} );
	makeRange( {
		parent: muscles,
		label: 'Flexion coudes / genoux',
		object: ragdoll.settings,
		property: 'jointFlex',
		min: 0,
		max: 1.15,
		step: 0.01,
		format: ( value ) => `${ value.toFixed( 2 ) } rad`,
	} );
	makeRange( {
		parent: muscles,
		label: 'Mouvement du corps',
		object: ragdoll.settings,
		property: 'bodyMotion',
		min: 0,
		max: 2,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) }×`,
	} );

	const tail = fieldset( panel, 'Queue passive' );
	makeRange( {
		parent: tail,
		label: 'Souplesse',
		object: ragdoll.settings,
		property: 'tailFlexibility',
		min: 0,
		max: 1,
		step: 0.01,
		format: ( value ) => value.toFixed( 2 ),
	} );
	makeRange( {
		parent: tail,
		label: 'Amortissement',
		object: ragdoll.settings,
		property: 'tailDamping',
		min: 0,
		max: 8,
		step: 0.1,
		format: ( value ) => value.toFixed( 1 ),
	} );
	makeRange( {
		parent: tail,
		label: 'Collision',
		object: ragdoll.settings,
		property: 'tailCollisionScale',
		min: 0.5,
		max: 1.75,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) }×`,
	} );
	makeRange( {
		parent: tail,
		label: 'Gravité de la queue',
		object: ragdoll.settings,
		property: 'tailGravity',
		min: 0,
		max: 2,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) }×`,
	} );

	const grip = fieldset( panel, 'Appuis' );
	makeToggle( {
		parent: grip,
		label: 'Appuis pieds / griffes',
		object: ragdoll.settings,
		property: 'gripEnabled',
	} );

	makeRange( {
		parent: grip,
		label: 'Force de maintien',
		object: ragdoll.settings,
		property: 'gripStrength',
		min: 3,
		max: 80,
		step: 1,
		format: ( value ) => `${ value.toFixed( 0 ) } N`,
	} );
	makeRange( {
		parent: grip,
		label: 'Rigidité d’appui',
		object: ragdoll.settings,
		property: 'gripStiffness',
		min: 30,
		max: 360,
		step: 5,
		format: ( value ) => value.toFixed( 0 ),
	} );
	makeRange( {
		parent: grip,
		label: 'Amortissement d’appui',
		object: ragdoll.settings,
		property: 'gripDamping',
		min: 1,
		max: 24,
		step: 0.5,
		format: ( value ) => value.toFixed( 1 ),
	} );
	makeRange( {
		parent: grip,
		label: 'Portée capteurs',
		object: ragdoll.settings,
		property: 'gripReach',
		min: 0.08,
		max: 0.42,
		step: 0.01,
		format: ( value ) => `${ value.toFixed( 2 ) } m`,
	} );
	makeRange( {
		parent: grip,
		label: 'Réflexe de redressement',
		object: ragdoll.settings,
		property: 'rightingStrength',
		min: 0,
		max: 2,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) }×`,
	} );
	makeRange( {
		parent: grip,
		label: 'Verrouillage de surface',
		object: ragdoll.settings,
		property: 'surfaceCommitTime',
		min: 0.2,
		max: 2,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) } s`,
	} );

	const display = fieldset( panel, 'Affichage & coût' );
	const debugToggle = makeToggle( {
		parent: display,
		label: 'Proxies / contacts (H)',
		object: state,
		property: 'debug',
		onInput: ( value ) => ragdoll.setDebugVisible( value ),
	} );
	const rigDebugToggle = makeToggle( {
		parent: display,
		label: 'Squelette à travers la peau',
		object: state,
		property: 'rigDebug',
		onInput: ( value ) => rigDebugView?.setVisible( value ),
	} );
	rigDebugView?.setVisible( state.rigDebug );
	makeToggle( {
		parent: display,
		label: 'Ombres',
		object: state,
		property: 'shadows',
		onInput: ( value ) => {

			renderer.shadowMap.enabled = value;

		},
	} );
	makeRange( {
		parent: display,
		label: 'Gravité',
		object: state,
		property: 'gravity',
		min: 0,
		max: 15,
		step: 0.1,
		format: ( value ) => `${ value.toFixed( 1 ) } m/s²`,
		onInput: ( value ) => physics.setGravity( { x: 0, y: - value, z: 0 } ),
	} );

	const buttons = document.createElement( 'div' );
	buttons.className = 'chameleon-lab-buttons';
	button( buttons, 'Réinitialiser (R)', onReset );
	const home = document.createElement( 'a' );
	home.className = 'chameleon-lab-link';
	home.href = '/';
	home.textContent = 'Retour à la colonie';
	buttons.append( home );
	panel.append( buttons );

	const status = document.createElement( 'section' );
	status.className = 'chameleon-lab-status';
	const fpsValue = stat( status, 'Rendu' );
	const stepValue = stat( status, 'Sous-pas p95' );
	const contactsValue = stat( status, 'Prises' );
	const stateValue = stat( status, 'Mode' );
	const heightValue = stat( status, 'Altitude' );
	const validityValue = stat( status, 'Intégrité' );

	const help = document.createElement( 'div' );
	help.className = 'chameleon-lab-help';
	help.innerHTML = '<kbd>Z</kbd>/<kbd>W</kbd> avancer · <kbd>Q</kbd>/<kbd>A</kbd> et <kbd>D</kbd> tourner · <kbd>Shift</kbd> sprinter · <kbd>Espace</kbd> charger puis bondir · clic gauche décor : destination · clic maintenu sur le caméléon : saisir/lancer · clic droit caméra · molette zoom · <kbd>C</kbd> autonome · <kbd>F</kbd> physique libre · <kbd>H</kbd> debug · <kbd>R</kbd> reset';
	shell.append( panel, status, help );
	document.body.append( shell );

	let frameCount = 0;
	let frameSeconds = 0;
	let refreshSeconds = 0;
	let lastFps = 0;
	function update( dt ) {

		frameCount ++;
		frameSeconds += dt;
		refreshSeconds += dt;
		if ( frameSeconds >= 0.25 ) {

			lastFps = Math.round( frameCount / frameSeconds );
			frameCount = 0;
			frameSeconds = 0;

		}
		if ( refreshSeconds < 0.15 ) return;
		refreshSeconds = 0;
		autonomousToggle.checked = state.autonomous;
		ragdollToggle.checked = state.fullRagdoll;
		debugToggle.checked = state.debug;
		rigDebugToggle.checked = state.rigDebug;
		fpsValue.textContent = `${ lastFps } fps`;
		stepValue.textContent = `${ physics.stats.p95StepMs.toFixed( 2 ) } ms`;
		contactsValue.textContent = `${ ragdoll.contactCount } / ${ ragdoll.maxContactCount ?? 4 }${
			ragdoll.staticGripLocked ? ' · verrouillé' : '' }`;
		const locomotionMode = state.fullRagdoll
			? 'libre'
			: state.autonomous ? 'autonome' : 'joueur';
		const jumpLabel = JUMP_PHASE_LABELS[ state.jumpPhase ];
		stateValue.textContent = jumpLabel && state.jumpPhase !== 'grounded'
			? `${ locomotionMode } · ${ jumpLabel }`
			: locomotionMode;
		const position = ragdoll.pelvis.body.translation();
		heightValue.textContent = `${ position.y.toFixed( 2 ) } m`;
		validityValue.textContent = physics.stats.invalidBodies === 0 ? 'OK' : `${ physics.stats.invalidBodies } NaN`;
		shell.dataset.pelvis = `${ position.x },${ position.y },${ position.z }`;
		shell.dataset.forward = `${ ragdoll.forward.x },${ ragdoll.forward.y },${ ragdoll.forward.z }`;
		shell.dataset.supportNormal = `${ ragdoll.supportNormal.x },${ ragdoll.supportNormal.y },${ ragdoll.supportNormal.z }`;
		shell.dataset.physicsSteps = String( physics.stats.totalSteps );
		shell.dataset.contacts = ragdoll.feet
			.map( ( contact ) => `${ contact.part.name }:${ contact.state }:${ contact.load.toFixed( 2 ) }:${ contact.surface?.kind ?? 'none' }:${ contact._candidateSurface?.kind ?? 'none' }:${ contact.normal.x.toFixed( 2 ) },${ contact.normal.y.toFixed( 2 ) },${ contact.normal.z.toFixed( 2 ) }` )
			.join( '|' );
		const bounds = {
			minX: Infinity, minY: Infinity, minZ: Infinity,
			maxX: - Infinity, maxY: - Infinity, maxZ: - Infinity,
		};
		for ( const part of ragdoll.parts ) {

			const point = part.body.translation();
			bounds.minX = Math.min( bounds.minX, point.x );
			bounds.minY = Math.min( bounds.minY, point.y );
			bounds.minZ = Math.min( bounds.minZ, point.z );
			bounds.maxX = Math.max( bounds.maxX, point.x );
			bounds.maxY = Math.max( bounds.maxY, point.y );
			bounds.maxZ = Math.max( bounds.maxZ, point.z );

		}
		shell.dataset.proxyExtents = `${ bounds.maxX - bounds.minX },${ bounds.maxY - bounds.minY },${ bounds.maxZ - bounds.minZ }`;

	}

	return {
		root: shell,
		update,
		dispose() {

			shell.remove();

		},
	};

}
