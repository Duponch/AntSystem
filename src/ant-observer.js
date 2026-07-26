// Modèle CPU pur de l'observabilité d'une fourmi.
//
// Ce module ne pilote pas la simulation : il traduit sa télémétrie brute en
// intentions compréhensibles et mesure les immobilités. Il est volontairement
// sans dépendance Three/WebGPU afin de servir d'oracle aux tests Node.

export const ANT_CASTE = Object.freeze( {
	WORKER: 0,
	SOLDIER: 1,
	NURSE: 2,
	SCOUT: 3,
	QUEEN: 4,
} );

export const ANT_GOAL = Object.freeze( {
	NONE: 0,
	GRANARY: 1,
	QUEEN: 2,
	BROOD: 3,
	EXIT: 4,
} );

export const ANT_STATE = Object.freeze( {
	EXPLORING: 0,
	CARRYING: 1,
	DEAD: 2,
	DEVOURED: 3,
} );

export const CASTE_LABELS = Object.freeze( [
	'Ouvrière',
	'Soldate',
	'Nourrice',
	'Éclaireuse',
	'Reine',
] );

export const STATE_LABELS = Object.freeze( [
	'Exploration',
	'Transport',
	'Cadavre',
	'Dévorée',
] );

export const GOAL_LABELS = Object.freeze( [
	'Aucun',
	'Grenier',
	'Mangeoire royale',
	'Couvain',
	'Sortie',
] );

const ROUTE_INTENTS = Object.freeze( {
	[ ANT_GOAL.NONE ]: [ 'underground-idle', 'En attente d’une mission' ],
	[ ANT_GOAL.GRANARY ]: [ 'travel-to-granary', 'Rejoint le grenier' ],
	[ ANT_GOAL.QUEEN ]: [ 'travel-to-queen', 'Ravitaille la reine' ],
	[ ANT_GOAL.BROOD ]: [ 'travel-to-brood', 'Ravitaille le couvain' ],
	[ ANT_GOAL.EXIT ]: [ 'travel-to-exit', 'Remonte à la surface' ],
} );

function seconds( value ) {

	return `${ Math.max( 0, value || 0 ).toFixed( 1 ).replace( '.', ',' ) } s`;

}

function routeIntent( goal ) {

	return ROUTE_INTENTS[ goal ] || ROUTE_INTENTS[ ANT_GOAL.NONE ];

}

export function classifyAntObservation( observation ) {

	const o = observation || {};
	const state = Number.isFinite( o.state ) ? o.state : ANT_STATE.EXPLORING;
	const caste = o.isQueen ? ANT_CASTE.QUEEN : ( o.caste ?? ANT_CASTE.WORKER );
	const goal = o.goal ?? ANT_GOAL.NONE;
	let goalLabel = o.under ? ( GOAL_LABELS[ goal ] || `Objectif ${ goal }` ) : 'Nourriture';
	const stationarySeconds = Math.max( 0, o.stationarySeconds || 0 );
	const suspiciousAfter = Math.max( 0.25, o.suspiciousAfter ?? 2 );
	const movingSpeed = Math.max( 0.001, o.movingSpeed ?? 0.08 );
	const moving = ( o.measuredSpeed || 0 ) >= movingSpeed;

	let intentCode = 'surface-search';
	let intentLabel = caste === ANT_CASTE.SOLDIER ? 'Patrouille la surface' : 'Cherche de la nourriture';
	let reason = caste === ANT_CASTE.SCOUT
		? 'Explore en privilégiant les zones encore peu marquées.'
		: 'Suit les pistes de nourriture et conserve une part d’errance.';
	let stopExpected = false;

	if ( state >= ANT_STATE.DEAD ) {

		intentCode = state === ANT_STATE.DEVOURED ? 'devoured' : 'dead';
		intentLabel = state === ANT_STATE.DEVOURED ? 'Dévorée' : 'Morte';
		reason = 'Aucun déplacement n’est attendu dans cet état terminal.';
		goalLabel = '—';
		stopExpected = true;

	} else if ( o.resting && caste !== ANT_CASTE.QUEEN ) {

		intentCode = 'scheduled-rest';
		intentLabel = 'Repos programmé';
		reason = `Pause biologique planifiée ; reprise dans ${ seconds( o.restRemaining ) }.`;
		stopExpected = true;

	} else if ( caste === ANT_CASTE.QUEEN ) {

		if ( ( o.energy || 0 ) < 0.75 && ( o.queenStock || 0 ) <= 0 ) {

			intentCode = 'queen-await-food';
			intentLabel = 'Attend son ravitaillement';
			reason = 'Sa mangeoire est vide ; les nourrices doivent apporter une unité depuis le grenier.';
			goalLabel = 'Mangeoire royale';

		} else if ( ( o.energy || 0 ) < 0.75 ) {

			intentCode = 'queen-feeding';
			intentLabel = 'Se nourrit';
			reason = 'Elle rejoint sa mangeoire et consomme le stock pour restaurer son énergie.';
			goalLabel = 'Mangeoire royale';

		} else if ( ( o.energy || 0 ) <= ( o.layEnergyMin ?? 0.5 ) ) {

			intentCode = 'queen-recover-energy';
			intentLabel = 'Récupère avant de pondre';
			reason = 'Son énergie est sous le seuil requis pour une nouvelle ponte.';
			goalLabel = 'Ponte';

		} else {

			const remaining = Math.max( 0, ( o.layInterval || 0 ) - ( o.layTimer || 0 ) );
			intentCode = 'queen-laying-cycle';
			intentLabel = 'Cycle de ponte';
			reason = `Prochaine ponte possible dans ${ seconds( remaining ) }, si son énergie reste suffisante.`;
			goalLabel = 'Ponte';

		}

	} else if ( o.attacking ) {

		intentCode = 'attack';
		intentLabel = 'Attaque un prédateur';
		reason = 'Une soldate maintient le contact et mord tant que la cible reste à portée.';
		goalLabel = 'Prédateur proche';

	} else if ( o.under && o.atGoal && goal === ANT_GOAL.GRANARY
		&& ( o.granaryStock || 0 ) <= 0
		&& ( caste === ANT_CASTE.NURSE || o.hungry ) ) {

		intentCode = 'wait-granary-stock';
		intentLabel = 'Attend au grenier';
		reason = caste === ANT_CASTE.NURSE
			? 'Le grenier est vide : elle attend une livraison avant de ravitailler la reine ou le couvain.'
			: 'Le grenier est vide : elle attend de pouvoir manger.';
		stopExpected = true;

	} else if ( o.under ) {

		const route = routeIntent( goal );
		intentCode = route[ 0 ];
		intentLabel = route[ 1 ];
		reason = o.corridor > 0
			? `Suit le corridor ${ Math.round( o.corridor ) } vers ${ goalLabel.toLowerCase() }.`
			: `Traverse la zone sûre du nœud ${ Math.round( o.node || 0 ) } vers ${ goalLabel.toLowerCase() }.`;

	} else if ( o.carrying || state === ANT_STATE.CARRYING ) {

		intentCode = 'return-with-food';
		intentLabel = 'Rapporte de la nourriture';
		reason = 'Suit la phéromone de retour, puis descendra déposer sa charge au grenier.';
		goalLabel = 'Entrée → grenier';

	} else if ( o.hungry ) {

		intentCode = 'return-to-eat';
		intentLabel = 'Rentre manger';
		reason = 'Son énergie est sous le seuil de retour ; elle vise l’entrée puis le grenier.';
		goalLabel = 'Entrée → grenier';

	} else if ( caste === ANT_CASTE.NURSE ) {

		intentCode = 'nurse-return-home';
		intentLabel = 'Retourne au grenier';
		reason = 'Une nourrice reste affectée à la navette souterraine.';
		goalLabel = 'Entrée → grenier';

	}

	let motionCode = 'moving';
	let motionLabel = moving ? 'En déplacement' : 'Arrêt très bref';
	let tone = 'ok';

	if ( state >= ANT_STATE.DEAD ) {

		motionCode = 'dead';
		motionLabel = 'Immobile — état terminal';
		tone = 'neutral';

	} else if ( ! moving && stopExpected ) {

		motionCode = 'expected-stop';
		motionLabel = `Immobile ${ seconds( stationarySeconds ) } — normal`;
		tone = 'expected';

	} else if ( ! moving && stationarySeconds >= suspiciousAfter ) {

		motionCode = 'suspicious-stop';
		motionLabel = `Immobile ${ seconds( stationarySeconds ) } — à vérifier`;
		reason = `${ reason } Aucune cause d’arrêt n’explique cette immobilité.`;
		tone = 'danger';

	}

	return {
		intentCode,
		intentLabel,
		reason,
		stopExpected,
		motionCode,
		motionLabel,
		tone,
		goalLabel,
		casteLabel: CASTE_LABELS[ caste ] || `Caste ${ caste }`,
		stateLabel: STATE_LABELS[ state ] || `État ${ state }`,
	};

}

export function createAntMotionTracker( options = {} ) {

	const movingSpeed = Math.max( 0.001, options.movingSpeed ?? 0.08 );
	let antId = - 1;
	let lastTimeMs = 0;
	let stationarySinceMs = 0;
	let lastPosition = null;
	let latest = { moving: false, measuredSpeed: 0, stationarySeconds: 0 };

	function reset() {

		antId = - 1;
		lastTimeMs = 0;
		stationarySinceMs = 0;
		lastPosition = null;
		latest = { moving: false, measuredSpeed: 0, stationarySeconds: 0 };

	}

	function sample( { id, timeMs, position } ) {

		if ( id !== antId || lastPosition === null ) {

			antId = id;
			lastTimeMs = timeMs;
			stationarySinceMs = timeMs;
			lastPosition = { x: position.x, y: position.y, z: position.z };
			latest = { moving: false, measuredSpeed: 0, stationarySeconds: 0 };
			return { ...latest };

		}

		if ( ! Number.isFinite( timeMs ) || timeMs <= lastTimeMs ) return { ...latest };

		const dt = ( timeMs - lastTimeMs ) / 1000;
		const dx = position.x - lastPosition.x;
		const dy = position.y - lastPosition.y;
		const dz = position.z - lastPosition.z;
		const measuredSpeed = Math.hypot( dx, dy, dz ) / dt;
		const moving = measuredSpeed >= movingSpeed;

		if ( moving ) stationarySinceMs = timeMs;

		latest = {
			moving,
			measuredSpeed,
			stationarySeconds: moving ? 0 : Math.max( 0, ( timeMs - stationarySinceMs ) / 1000 ),
		};
		lastTimeMs = timeMs;
		lastPosition = { x: position.x, y: position.y, z: position.z };
		return { ...latest };

	}

	return {
		sample,
		reset,
		get latest() { return { ...latest }; },
	};

}
