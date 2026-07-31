function makeRange( {
	parent,
	label,
	object,
	property,
	min,
	max,
	step,
	format = ( value ) => Number( value ).toFixed( 2 ),
	onInput = null,
} ) {

	const row = document.createElement( 'label' );
	row.className = 'chameleon-lab-control';
	const text = document.createElement( 'span' );
	text.textContent = label;
	const input = document.createElement( 'input' );
	input.type = 'range';
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

function fieldset( parent, title ) {

	const root = document.createElement( 'fieldset' );
	const legend = document.createElement( 'legend' );
	legend.textContent = title;
	root.append( legend );
	parent.append( root );
	return root;

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
} ) {

	const shell = document.createElement( 'div' );
	shell.className = 'chameleon-lab-shell';
	const panel = document.createElement( 'aside' );
	panel.className = 'chameleon-lab-panel';
	const title = document.createElement( 'h1' );
	title.textContent = 'Laboratoire physique · Caméléon';
	const subtitle = document.createElement( 'p' );
	subtitle.className = 'subtitle';
	subtitle.textContent = 'Active ragdoll articulé, contacts multi-surfaces et prises zygodactyles simulées sans téléportation.';
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
		label: 'Ragdoll passif (F)',
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

	const muscles = fieldset( panel, 'Corps actif' );
	makeRange( {
		parent: muscles,
		label: 'Tonus musculaire',
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
		label: 'Cadence',
		object: ragdoll.settings,
		property: 'gaitFrequency',
		min: 0.25,
		max: 3,
		step: 0.05,
		format: ( value ) => `${ value.toFixed( 2 ) } Hz`,
	} );

	const grip = fieldset( panel, 'Préhension' );
	makeToggle( {
		parent: grip,
		label: 'Prises pieds / griffes',
		object: ragdoll.settings,
		property: 'gripEnabled',
	} );
	makeToggle( {
		parent: grip,
		label: 'Queue préhensile',
		object: ragdoll.settings,
		property: 'tailGrip',
	} );
	makeRange( {
		parent: grip,
		label: 'Force de prise',
		object: ragdoll.settings,
		property: 'gripStrength',
		min: 3,
		max: 80,
		step: 1,
		format: ( value ) => `${ value.toFixed( 0 ) } N`,
	} );
	makeRange( {
		parent: grip,
		label: 'Rigidité prise',
		object: ragdoll.settings,
		property: 'gripStiffness',
		min: 30,
		max: 360,
		step: 5,
		format: ( value ) => value.toFixed( 0 ),
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

	const display = fieldset( panel, 'Affichage & coût' );
	const debugToggle = makeToggle( {
		parent: display,
		label: 'Proxies / contacts (H)',
		object: state,
		property: 'debug',
		onInput: ( value ) => ragdoll.setDebugVisible( value ),
	} );
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
	help.innerHTML = '<kbd>Z</kbd><kbd>Q</kbd><kbd>S</kbd><kbd>D</kbd> / <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> déplacer · <kbd>Shift</kbd> accélérer · <kbd>Espace</kbd> lâcher/sauter · clic gauche saisir, secouer et lancer · clic droit caméra · molette zoom · <kbd>C</kbd> autonome · <kbd>F</kbd> ragdoll passif · <kbd>H</kbd> debug · <kbd>R</kbd> reset';
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
		fpsValue.textContent = `${ lastFps } fps`;
		stepValue.textContent = `${ physics.stats.p95StepMs.toFixed( 2 ) } ms`;
		contactsValue.textContent = `${ ragdoll.contactCount } / 5`;
		stateValue.textContent = state.fullRagdoll
			? 'passif'
			: state.autonomous ? 'autonome' : 'joueur';
		const position = ragdoll.pelvis.body.translation();
		heightValue.textContent = `${ position.y.toFixed( 2 ) } m`;
		validityValue.textContent = physics.stats.invalidBodies === 0 ? 'OK' : `${ physics.stats.invalidBodies } NaN`;
		shell.dataset.pelvis = `${ position.x },${ position.y },${ position.z }`;
		shell.dataset.physicsSteps = String( physics.stats.totalSteps );
		shell.dataset.contacts = [ ...ragdoll.feet, ragdoll.tailGrip ]
			.map( ( contact ) => `${ contact.part.name }:${ contact.state }:${ contact.load.toFixed( 2 ) }:${ contact.anchor ? 1 : 0 }` )
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
