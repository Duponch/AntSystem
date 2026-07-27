// LE NID — registre organique déterministe, en NAPPES SUPERPOSÉES.
//
// Deux problèmes fondamentaux étaient à régler d'un coup.
//
// 1. LA SUPERPOSITION. L'ancienne carte du nid était un heightfield : UNE
//    hauteur de plancher par colonne (x, y). Ça interdit physiquement qu'une
//    chambre soit au-dessus d'une autre — alors que c'est exactement ce que
//    montre une coupe de nid réel. La carte porte maintenant QUATRE planchers
//    par colonne (une par canal RGBA), un par NIVEAU de profondeur. Une colonne
//    peut donc traverser le solarium, un grenier, la crèche et la chambre
//    royale, empilés.
//
//    La topologie reste un graphe d'arêtes, mais chaque arête est désormais une
//    courbe 3D munie de pistes de contact. La nappe identifie l'étage logique ;
//    la position et l'orientation physiques viennent de la surface compilée. Deux
//    chambres superposées en (x, y) restent donc distinctes par leur profondeur.
//
// 2. LA CROISSANCE. Le nid doit grandir avec la colonie sans jamais déplacer ce
//    qui existe — sinon un coup de curseur téléporte toutes les fourmis dans la
//    terre pleine. D'où l'INVARIANT MAÎTRE de ce fichier :
//
//        nestUnit(k) ne dépend QUE de k. Jamais du nombre de loges actives,
//        jamais de la population, jamais d'un générateur aléatoire à état.
//
//    La population ne fait qu'activer un PRÉFIXE [0, K) du registre. Ajouter des
//    loges est donc un ajout pur : on creuse les nouvelles, on ne retouche rien.
//    Corollaire gratuit : les positions du grenier, de la crèche et de la
//    chambre royale (loges 1, 2, 3) sont figées à vie, donc les stocks de
//    nourriture atomiques ne sont jamais orphelins.
//
// Module PUR : aucune dépendance à three, testable en node.

import {
	GRID, TEXEL, NEST, params, MIN_NEST_DEPTH, MAX_NEST_DEPTH,
} from './config.js';

// nombre de nappes = nombre de niveaux de chambres (une par canal RGBA)
export const LAYERS = 4;
export const K_MAX = 96;                 // loges candidates (registre complet)
// Rayon visuel = largeur * TEXEL * 0,85. 5,5 garantit l'enveloppe de la
// plus grosse caste (soldate) + 5 cm de marge, même voie latérale incluse.
export const MIN_TUNNEL_WIDTH = 5.5;
export const DEPTH_SIZE = 640;           // côté de la carte de profondeur (texels)

// angle d'or : deux loges consécutives ne sont jamais alignées, la couverture
// angulaire reste bonne pour N'IMPORTE QUEL préfixe
const GOLD = 2.399963229728653;
const SERIES_CORE_WORLD = 3;
const LEVEL_DEPTH_SPREAD_WORLD = [ 2, 1.8, 3, 4 ];
export const MAX_NEST_DEPTH_DRIFT_WORLD = Math.max( ... LEVEL_DEPTH_SPREAD_WORLD );
const SERIES_PITCH_WORLD = 7.2;
const BRANCH_ORBIT_WORLD = 10.2;
const LAYOUT_ROTATION = 3.427;
const BRANCH_TARGET_WORLD = 12.5;
const BRANCH_MAX_WORLD = 22;
const ORGANIC_LAYOUT_PROBE_DEPTH = 19;
const ORGANIC_FIELD_MARGIN_WORLD = 2;
const ORGANIC_CHAMBER_MARGIN_WORLD = 0.5;
const ORGANIC_PLACEMENT_ATTEMPTS = 256;
export const ENTRANCE_PORTAL_OFFSET_WORLD = 11;
export const ENTRANCE_PORTAL_ANGLE_RAD = 230 * Math.PI / 180;
export const ENTRANCE_CONNECTOR_BULGE_WORLD = 3;
// Rare detours discovered by the exhaustive capsule oracle live here. The
// organic registry starts without exceptions; entries are justified only by a
// named failing geometry contract, never by visual hand-tuning.
const CORRIDOR_CURVATURE_SCALE_OVERRIDE = new Map();
const CORRIDOR_BULGE_OVERRIDE_WORLD = new Map();
const SERIES_CENTER_OVERRIDE_WORLD = new Map( [
	[ 5, { x: 3, y: 0 } ],
	[ 17, { x: 2, y: 0 } ],
	[ 22, { x: 0, y: 3 } ],
] );
// These six rising roots intersect the entrance or a foreign branch in the
// exhaustive W12 oracle; they retain a level-0 parent in every valid preset.
const ROOT_SHALLOW_ONLY_SERIES = new Set( [ 3, 7, 11, 12, 19, 22 ] );
// Unit 87 remains on its own branch: the alternative cross-series descent
// violates the exhaustive K96 tangent oracle even after safe route fairing.
const SAME_SERIES_ONLY_UNITS = new Set( [ 87 ] );

// ---------------------------------------------------------------------------
// NIVEAUX — profondeur, taille des chambres, vocation.
// Fractions de la profondeur totale. La hiérarchie vient de la biologie :
// le couvain et la reine occupent le fond (température stable, hors d'atteinte
// des prédateurs et du gel), les réserves l'étage intermédiaire, et les salles
// de service la proximité de la surface.
// ---------------------------------------------------------------------------
export const ROOM = {
	TUNNEL: 0, GARDE: 1, SOLARIUM: 2, GRENIER: 3, ETABLE: 4,
	CRECHE: 5, NURSERIE: 6, DORTOIR: 7, COMPOST: 8, COUVEUSE: 9, ROYALE: 10,
};

// Les chambres RÉTRÉCISSENT et se RESSERRENT avec la profondeur — signature
// mesurée sur les moulages de nids réels. C'est aussi ce qui fait que les
// étages profonds passent SOUS les étages hauts : la superposition est une
// conséquence de la biologie, pas un effet cherché.
// Une chambre de nid n'est PAS une sphere : c'est une LENTILLE, bien plus large
// que haute — une fourmi a besoin de surface au sol, pas de volume. Rapport
// mesure sur les moulages : hauteur ~ 0,25 x largeur. C'est ce qui donne la
// silhouette aplatie caracteristique des coupes de nid.
const LEVEL = [
	// zf = fraction de la profondeur · rw = demi-largeur de chambre (unites monde)
	// rh = demi-HAUTEUR · spread = rayon du disque ou se repartissent les loges
	{ zf: 0.10, rw: 4.20, rh: 1.24, spread: 17.0, rooms: [ ROOM.GARDE, ROOM.SOLARIUM, ROOM.SOLARIUM, ROOM.GARDE ] },
	{ zf: 0.40, rw: 3.80, rh: 1.17, spread: 16.0, rooms: [ ROOM.GRENIER, ROOM.ETABLE, ROOM.GRENIER ] },
	{ zf: 0.71, rw: 3.30, rh: 1.06, spread: 14.5, rooms: [ ROOM.CRECHE, ROOM.NURSERIE, ROOM.COMPOST ] },
	{ zf: 1.00, rw: 2.90, rh: 0.98, spread: 12.5, rooms: [ ROOM.ROYALE, ROOM.COUVEUSE, ROOM.DORTOIR ] },
];

// profondeur nominale d'une nappe (unites monde, negative) — le rendu s'en sert
// pour plaquer les sommets SANS cavite au niveau de leur propre etage au lieu
// de la surface : sinon deux sommets voisins, l'un dans une chambre profonde et
// l'autre dans la terre pleine, engendrent un triangle vertical de toute la
// hauteur du nid — les "rideaux" parasites.
export const layerDepth = ( l, depthMax ) => - depthMax * LEVEL[ Math.min( l, LEVEL.length - 1 ) ].zf;

// van der Corput : une suite stratifiée pour n'importe quel préfixe. Contrairement
// à un hash, tout préfixe [0, K) reste bien réparti — indispensable puisque K
// grandit.
function vdc( n, b ) {

	let r = 0, d = 1 / b;
	while ( n > 0 ) { r += ( n % b ) * d; n = Math.floor( n / b ); d /= b; }
	return r;

}

// ---------------------------------------------------------------------------
// ORDRE D'ÉMISSION. La série 0 descend TOUS les niveaux : dès la plus petite
// colonie, le nid possède sa salle de garde, son grenier, sa crèche et sa
// chambre royale. Les séries suivantes étoffent chaque étage.
// ---------------------------------------------------------------------------
const EMISSION = ( () => {

	const list = [];
	for ( let q = 0; list.length < K_MAX; q ++ ) {

		for ( let s = 0; s < LAYERS && list.length < K_MAX; s ++ ) list.push( { q, s } );

	}
	return list;

} )();

// budget de loges : loi d'échelle des nids réels (le volume creusé croît comme
// la racine carrée de la population, exposant mesuré ~0,5 sur plusieurs espèces)
export function nestBudget( W, scale = 1 ) {

	const K = Math.round( 24 * Math.sqrt( Math.max( 1, W ) / 869 ) * scale );
	return Math.min( K_MAX, Math.max( LAYERS, K ) );

}

// quantification : ~20 paliers sur toute la course du curseur, pas des milliers
export const quantK = ( K ) => Math.max( LAYERS, Math.round( K / LAYERS ) * LAYERS );

// ---------------------------------------------------------------------------
// LA fonction pure : tout ce qui définit la loge k
// ---------------------------------------------------------------------------
function organicHash( value ) {

	let hash = ( value ^ 0x9e3779b9 ) >>> 0;
	hash = Math.imul( hash ^ ( hash >>> 16 ), 0x21f0aaad ) >>> 0;
	hash = Math.imul( hash ^ ( hash >>> 15 ), 0x735a2d97 ) >>> 0;
	return ( ( hash ^ ( hash >>> 15 ) ) >>> 0 ) / 0x100000000;

}

function unitMorphology( k, depthMax ) {

	const { q, s } = EMISSION[ k ];
	const level = LEVEL[ s ];
	const growth = 0.78 + 0.44 * vdc( k + 1, 5 );
	const rwx = level.rw * growth * ( 0.85 + 0.30 * vdc( k + 1, 11 ) );
	const rwz = level.rw * growth * ( 0.85 + 0.30 * vdc( k + 2, 11 ) );
	const rh = level.rh * growth;
	const stratifiedDepth = - depthMax * level.zf
		- LEVEL_DEPTH_SPREAD_WORLD[ s ] * vdc( k + 1, 7 );
	const roofClearance = rh * 2 + 0.65 + 0.35 * vdc( k + 1, 41 );
	return {
		q, s, level, rwx, rwz, rh,
		depth: Math.min( stratifiedDepth, - roofClearance ),
	};

}

function organicBranchCandidate( q, attempt ) {

	const seriesRadius = Math.sqrt(
		SERIES_CORE_WORLD * SERIES_CORE_WORLD
		+ SERIES_PITCH_WORLD * SERIES_PITCH_WORLD * q );
	const seriesAngle = GOLD * q + LAYOUT_ROTATION;
	let centerX = Math.cos( seriesAngle ) * seriesRadius;
	let centerY = Math.sin( seriesAngle ) * seriesRadius;
	// Rejected candidates may slide inside a small local crown. This avoids
	// imposing a repeated ring lattice while keeping every accepted branch
	// spatially bounded and every registry prefix immutable after baking.
	if ( attempt > 0 ) {

		const tangentX = - Math.sin( seriesAngle );
		const tangentY = Math.cos( seriesAngle );
		const radial = ( organicHash( q * 911 + attempt * 43 ) - 0.5 ) * 8;
		const tangential = ( organicHash( q * 577 + attempt * 79 ) - 0.5 ) * 8;
		centerX += Math.cos( seriesAngle ) * radial + tangentX * tangential;
		centerY += Math.sin( seriesAngle ) * radial + tangentY * tangential;

	}
	const centerOverride = SERIES_CENTER_OVERRIDE_WORLD.get( q );
	if ( centerOverride ) {

		centerX += centerOverride.x;
		centerY += centerOverride.y;

	}
	let angle = GOLD * ( q + attempt * 3 + 1 ) + LAYOUT_ROTATION
		+ 0.8 * ( organicHash( q + attempt * 101 ) - 0.5 );
	const handedness = organicHash( q + attempt * 13 + 701 ) < 0.5 ? - 1 : 1;
	// Half the roots meander gently, half fold more tightly. Keeping a branch
	// inside a bounded local crown prevents a natural silhouette from becoming
	// an unbounded random walk or pushing the SDF outside its fixed field.
	const tight = organicHash( q + 301 ) < 0.5;
	const minimumTurn = ( tight ? 102 : 70 ) * Math.PI / 180;
	const turnSpan = ( tight ? 16 : 12 ) * Math.PI / 180;
	const points = [];
	for ( let level = 0; level < LAYERS; level ++ ) {

		if ( level > 0 ) angle += handedness * (
			minimumTurn + turnSpan * organicHash(
				q * 11 + attempt * 101 + level * 97 ) );
		points.push( {
			x: centerX + Math.cos( angle ) * BRANCH_ORBIT_WORLD,
			y: centerY + Math.sin( angle ) * BRANCH_ORBIT_WORLD,
		} );

	}
	return points;

}

let ORGANIC_PLACEMENT;
let ORGANIC_ROUTES;

// The pure registry entry: morphology and placement depend only on k. Growing
// the colony still activates an immutable prefix. The expensive rejection
// search is an offline authoring oracle; runtime consumes its reviewed bake.
export function nestUnit( k, depthMax ) {

	const morphology = unitMorphology( k, depthMax );
	const { q, s, level, rwx, rwz, rh, depth } = morphology;
	const placement = ORGANIC_PLACEMENT[ k ];
	const neighbour = ORGANIC_PLACEMENT[ s < LAYERS - 1 ? k + 1 : k - 1 ];
	const chamberYaw = Math.atan2(
		neighbour.y - placement.y, neighbour.x - placement.x )
		+ ( vdc( k + 1, 31 ) - 0.5 ) * 0.18;
	const chamberBalance = 0.18 + 0.64 * vdc( k + 1, 37 );
	return {
		k, q, level: s, layer: s,
		R: ( ( rwx + rwz ) * 0.5 ) / TEXEL,
		rwx, rwz, rh,
		chamberYaw, chamberBalance,
		organicRoute: ORGANIC_ROUTES[ k ] ?? null,
		x: NEST.x + placement.x / TEXEL,
		y: NEST.y + placement.y / TEXEL,
		depth,
		type: level.rooms[ q % level.rooms.length ],
	};

}
// PARENTAGE APPEND-ONLY. La serie fondatrice garantit les quatre fonctions
// biologiques initiales. Ensuite, une loge profonde choisit une loge ANTERIEURE
// de l'etage juste au-dessus, sans obligation d'appartenir a la meme serie.
// Certaines nouvelles salles hautes germent depuis l'etage 1 : le reseau ne
// forme plus une ligne de service portant des echelles identiques. Les autres
// rejoignent une racine haute ; aucun choix ne consulte un noeud futur.
export function parentOf( k, U ) {

	const child = U[ k ];
	if ( child.q === 0 ) return k === 0 ? - 1 : k - 1;

	// Organic growth is not a bundle of identical four-room ladders. Deep rooms
	// attach to a compatible older room one stratum above; selected shallow roots
	// may rise from stratum 1. The result remains an append-only rooted tree.
	const rootGrowsFromBelow = child.level === 0
		&& organicHash( k * 193 + child.q * 53 + 17 ) < 0.58
		&& ! ROOT_SHALLOW_ONLY_SERIES.has( child.q );
	const desiredLevel = child.level === 0
		? ( rootGrowsFromBelow ? 1 : 0 ) : child.level - 1;
	const allowCrossSeries = child.level === 0
		|| ( ! SAME_SERIES_ONLY_UNITS.has( k ) && organicHash( k * 193 + child.q * 53 + 901 ) < 0.7 );
	const targetDistance = child.level === 0 ? BRANCH_TARGET_WORLD : 13.5;
	const candidates = [];
	for ( let j = 0; j < k; j ++ ) {

		const previous = U[ j ];
		if ( child.level === 0 ) {

			if ( rootGrowsFromBelow ? previous.level > 1 : previous.level !== 0 ) continue;

		} else {

			if ( previous.level !== child.level - 1 ) continue;
			if ( ! allowCrossSeries && previous.q !== child.q ) continue;

		}
		const dx = ( previous.x - child.x ) * TEXEL;
		const dz = ( previous.y - child.y ) * TEXEL;
		const dy = Number.isFinite( previous.depth ) && Number.isFinite( child.depth )
			? previous.depth - child.depth : 0;
		const distanceWorld = Math.hypot( dx, dy, dz );
		if ( distanceWorld > BRANCH_MAX_WORLD ) continue;
		const shortfall = Math.max( 0, targetDistance - distanceWorld );
		const overshoot = Math.max( 0, distanceWorld - targetDistance );
		const levelPenalty = Math.abs( previous.level - desiredLevel ) * 1.8;
		const ageJitter = organicHash( k * 1009 + j * 313 ) * 0.22;
		candidates.push( {
			j,
			distanceDelta: Math.abs( distanceWorld - targetDistance ),
			score: shortfall * 1.7 + overshoot + levelPenalty + ageJitter,
		} );

	}

	candidates.sort( ( a, b ) =>
		a.score - b.score
		|| a.distanceDelta - b.distanceDelta
		|| a.j - b.j );
	if ( candidates.length === 0 )
		throw new Error( `No append-only branch parent within ${ BRANCH_MAX_WORLD } world units for chamber ${ k }` );
	return candidates[ 0 ].j;

}
const ROUTE_TUNNEL_RADIUS_WORLD = 12 * TEXEL * 0.85 + 0.095;
const ROUTE_SOIL_MARGIN_WORLD = 0.4;
const ROUTE_FIELD_LIMIT_WORLD = DEPTH_SIZE * TEXEL * 0.5
	- ORGANIC_FIELD_MARGIN_WORLD;
export const MAX_ROUTE_VERTICAL_DRIFT_WORLD = 10;
const ROUTE_VERTICAL_LIMIT_WORLD = MAX_ROUTE_VERTICAL_DRIFT_WORLD;

function routeSegmentDistance( firstStart, firstEnd, secondStart, secondEnd ) {

	const subtract = ( a, b ) => a.map( ( value, axis ) => value - b[ axis ] );
	const dot = ( a, b ) => a.reduce( ( sum, value, axis ) => sum + value * b[ axis ], 0 );
	const u = subtract( firstEnd, firstStart );
	const v = subtract( secondEnd, secondStart );
	const w = subtract( firstStart, secondStart );
	const a = dot( u, u ), b = dot( u, v ), c = dot( v, v );
	const d = dot( u, w ), e = dot( v, w );
	const denominator = a * c - b * b;
	let sNumerator, sDenominator = denominator;
	let tNumerator, tDenominator = denominator;
	if ( denominator < 1e-12 ) {

		sNumerator = 0;
		sDenominator = 1;
		tNumerator = e;
		tDenominator = c;

	} else {

		sNumerator = b * e - c * d;
		tNumerator = a * e - b * d;
		if ( sNumerator < 0 ) {

			sNumerator = 0;
			tNumerator = e;
			tDenominator = c;

		} else if ( sNumerator > sDenominator ) {

			sNumerator = sDenominator;
			tNumerator = e + b;
			tDenominator = c;

		}

	}
	if ( tNumerator < 0 ) {

		tNumerator = 0;
		if ( - d < 0 ) sNumerator = 0;
		else if ( - d > a ) sNumerator = sDenominator;
		else { sNumerator = - d; sDenominator = a; }

	} else if ( tNumerator > tDenominator ) {

		tNumerator = tDenominator;
		if ( - d + b < 0 ) sNumerator = 0;
		else if ( - d + b > a ) sNumerator = sDenominator;
		else { sNumerator = - d + b; sDenominator = a; }

	}
	const s = Math.abs( sNumerator ) < 1e-12 ? 0 : sNumerator / sDenominator;
	const t = Math.abs( tNumerator ) < 1e-12 ? 0 : tNumerator / tDenominator;
	return Math.hypot( ... w.map( ( value, axis ) =>
		value + s * u[ axis ] - t * v[ axis ] ) );

}

function conservativePointChamberDistance( point, chamber ) {

	const relative = point.map( ( value, axis ) => value - chamber.center[ axis ] );
	const absolute = relative.map( Math.abs );
	const normalizedSquared = absolute.reduce( ( sum, value, axis ) =>
		sum + ( value / chamber.radii[ axis ] ) ** 2, 0 );
	if ( normalizedSquared <= 1 ) return 0;
	const equation = ( lambda ) => absolute.reduce( ( sum, value, axis ) => {

		const radius = chamber.radii[ axis ];
		return sum + ( radius * value / ( lambda + radius * radius ) ) ** 2;

	}, 0 ) - 1;
	let low = 0, high = 1;
	while ( equation( high ) > 0 ) high *= 2;
	for ( let iteration = 0; iteration < 28; iteration ++ ) {

		const middle = ( low + high ) * 0.5;
		if ( equation( middle ) > 0 ) low = middle; else high = middle;

	}
	const lambda = ( low + high ) * 0.5;
	return Math.hypot( ... absolute.map( ( value, axis ) => {

		const radius = chamber.radii[ axis ];
		const surface = radius * radius * value / ( lambda + radius * radius );
		return value - surface;

	} ) );

}
function routeCandidateTable( seed ) {

	const routes = [ { lateralBulgeWorld: 0, verticalBulgeWorld: 0 } ];
	for ( let lateral = - 26; lateral <= 26; lateral += 2 ) {

		for ( const vertical of [ 0, - 2.5, 2.5, - 5, 5, - 7.5, 7.5, - 10 ] ) {

			if ( lateral === 0 && vertical === 0 ) continue;
			routes.push( { lateralBulgeWorld: lateral, verticalBulgeWorld: vertical } );

		}

	}
	return routes.sort( ( first, second ) => {

		const firstCost = Math.hypot(
			first.lateralBulgeWorld, first.verticalBulgeWorld * 1.4 );
		const secondCost = Math.hypot(
			second.lateralBulgeWorld, second.verticalBulgeWorld * 1.4 );
		return firstCost - secondCost
			|| organicHash( seed * 409 + first.lateralBulgeWorld * 17
				+ first.verticalBulgeWorld * 31 )
			- organicHash( seed * 409 + second.lateralBulgeWorld * 17
				+ second.verticalBulgeWorld * 31 );

	} );

}

function routeIsClear( path, child, parent, chambers, accepted ) {

	// The rendered capsule axis is one tunnel radius above the carved floor.
	// Collision planning must therefore validate that physical axis, not the
	// floor curve below it.
	const points = path.map( ( point ) => [
		point.x * TEXEL, point.depth + ROUTE_TUNNEL_RADIUS_WORLD, point.y * TEXEL,
	] );
	const requiredChamberDistance = ROUTE_TUNNEL_RADIUS_WORLD
		+ ROUTE_SOIL_MARGIN_WORLD;
	const requiredTunnelDistance = ROUTE_TUNNEL_RADIUS_WORLD * 2
		+ ROUTE_SOIL_MARGIN_WORLD;
	const centerWorldX = NEST.x * TEXEL, centerWorldZ = NEST.y * TEXEL;
	for ( const point of points ) {

		if ( Math.abs( point[ 0 ] - centerWorldX ) + ROUTE_TUNNEL_RADIUS_WORLD
			> ROUTE_FIELD_LIMIT_WORLD
			|| Math.abs( point[ 2 ] - centerWorldZ ) + ROUTE_TUNNEL_RADIUS_WORLD
			> ROUTE_FIELD_LIMIT_WORLD
			|| point[ 1 ] > - 0.45
			|| point[ 1 ] < - ( MAX_NEST_DEPTH
				+ MAX_NEST_DEPTH_DRIFT_WORLD + ROUTE_VERTICAL_LIMIT_WORLD ) ) return false;

	}
	for ( const chamber of chambers ) {

		if ( chamber.k === child || chamber.k === parent ) continue;
		for ( let index = 0; index < points.length - 1; index ++ ) {

			const start = points[ index ], end = points[ index + 1 ];
			const middle = start.map( ( value, axis ) => ( value + end[ axis ] ) * 0.5 );
			const halfSampleGap = Math.hypot( ... start.map(
				( value, axis ) => value - middle[ axis ] ) );
			const lowerBound = Math.min(
				conservativePointChamberDistance( start, chamber ),
				conservativePointChamberDistance( middle, chamber ),
				conservativePointChamberDistance( end, chamber ),
			) - halfSampleGap;
			if ( lowerBound < requiredChamberDistance ) return false;

		}

	}
	for ( const previous of accepted ) {

		if ( previous.child === parent || previous.parent === parent
			|| previous.child === child || previous.parent === child ) continue;
		for ( let first = 0; first < points.length - 1; first ++ ) {

			for ( let second = 0; second < previous.points.length - 1; second ++ )
				if ( routeSegmentDistance(
					points[ first ], points[ first + 1 ],
					previous.points[ second ], previous.points[ second + 1 ],
				) < requiredTunnelDistance ) return false;

		}

	}
	return true;

}

function routeClearsChamber( points, chamber ) {

	const requiredDistance = ROUTE_TUNNEL_RADIUS_WORLD + ROUTE_SOIL_MARGIN_WORLD;
	for ( let index = 0; index < points.length - 1; index ++ ) {

		const start = points[ index ], end = points[ index + 1 ];
		const middle = start.map( ( value, axis ) => ( value + end[ axis ] ) * 0.5 );
		const halfSampleGap = Math.hypot( ... start.map(
			( value, axis ) => value - middle[ axis ] ) );
		const lowerBound = Math.min(
			conservativePointChamberDistance( start, chamber ),
			conservativePointChamberDistance( middle, chamber ),
			conservativePointChamberDistance( end, chamber ),
		) - halfSampleGap;
		if ( lowerBound < requiredDistance ) return false;

	}
	return true;

}

function organicUnitAt( k, point ) {

	const morphology = unitMorphology( k, ORGANIC_LAYOUT_PROBE_DEPTH );
	return {
		k, q: morphology.q, level: morphology.s, layer: morphology.s,
		x: NEST.x + point.x / TEXEL,
		y: NEST.y + point.y / TEXEL,
		depth: morphology.depth,
		rwx: morphology.rwx, rwz: morphology.rwz, rh: morphology.rh,
	};

}

function organicChamberOf( unit ) {

	return {
		k: unit.k,
		center: [ unit.x * TEXEL, unit.depth + unit.rh * 0.5, unit.y * TEXEL ],
		radii: [ unit.rwx, unit.rh * 1.5, unit.rwz ],
	};

}

function organicChambersAreSeparated( first, second ) {

	const verticalSeparation = Math.abs( first.depth + first.rh
		- second.depth - second.rh ) - first.rh - second.rh;
	if ( verticalSeparation >= ORGANIC_CHAMBER_MARGIN_WORLD ) return true;
	const horizontalSeparation = Math.hypot(
		( first.x - second.x ) * TEXEL,
		( first.y - second.y ) * TEXEL,
	) - Math.max( first.rwx, first.rwz )
		- Math.max( second.rwx, second.rwz );
	return horizontalSeparation >= ORGANIC_CHAMBER_MARGIN_WORLD;

}

function buildOrganicRegistry() {

	const placements = new Array( K_MAX );
	const routes = new Array( K_MAX ).fill( null );
	const units = [];
	const chambers = [];
	const acceptedRoutes = [];
	const halfFieldWorld = DEPTH_SIZE * TEXEL * 0.5
		- ORGANIC_FIELD_MARGIN_WORLD;
	for ( let q = 0; q < K_MAX / LAYERS; q ++ ) {

		const firstIndex = q * LAYERS;
		let acceptedSeries = null;
		for ( let attempt = 0; attempt < ORGANIC_PLACEMENT_ATTEMPTS; attempt ++ ) {

			const candidate = organicBranchCandidate( q, attempt );
			const proposedUnits = candidate.map( ( point, level ) =>
				organicUnitAt( firstIndex + level, point ) );
			let valid = proposedUnits.every( ( unit ) =>
				Math.abs( ( unit.x - NEST.x ) * TEXEL ) + unit.rwx <= halfFieldWorld
				&& Math.abs( ( unit.y - NEST.y ) * TEXEL ) + unit.rwz <= halfFieldWorld );
			for ( let index = 0; index < proposedUnits.length && valid; index ++ ) {

				for ( const previous of [ ... units, ... proposedUnits.slice( 0, index ) ] )
					if ( ! organicChambersAreSeparated( proposedUnits[ index ], previous ) ) {

						valid = false;
						break;

					}

			}
			const proposedChambers = proposedUnits.map( organicChamberOf );
			for ( const previousRoute of acceptedRoutes ) {

				for ( const chamber of proposedChambers ) {

					if ( previousRoute.child === chamber.k
						|| previousRoute.parent === chamber.k ) continue;
					if ( ! routeClearsChamber( previousRoute.points, chamber ) ) valid = false;

				}

			}
			if ( ! valid ) continue;
			const combinedUnits = [ ... units, ... proposedUnits ];
			const combinedChambers = [ ... chambers, ... proposedChambers ];
			const proposedRoutes = [];
			const proposedRouteParams = [];
			const firstRoute = q === 0 ? firstIndex + 1 : firstIndex;
			for ( let child = firstRoute;
				child < firstIndex + LAYERS && valid; child ++ ) {

				let parent;
				try { parent = parentOf( child, combinedUnits ); } catch { valid = false; break; }
				const start = combinedUnits[ parent ];
				const end = combinedUnits[ child ];
				let selected = null, selectedPath = null;
				for ( const route of routeCandidateTable( child + attempt * K_MAX ) ) {

					const path = tunnelPathWithRoute( start, end, child, 48, route );
					if ( ! routeIsClear( path, child, parent, combinedChambers,
						[ ... acceptedRoutes, ... proposedRoutes ] ) ) continue;
					selected = route;
					selectedPath = path;
					break;

				}
				if ( ! selected ) { valid = false; break; }
				const accepted = {
					child, parent,
					points: selectedPath.map( ( point ) => [
						point.x * TEXEL,
						point.depth + ROUTE_TUNNEL_RADIUS_WORLD,
						point.y * TEXEL,
					] ),
				};
				proposedRoutes.push( accepted );
				proposedRouteParams.push( [ child, selected ] );

			}
			if ( valid ) acceptedSeries = {
				candidate, proposedUnits, proposedChambers,
				proposedRoutes, proposedRouteParams,
			};
			if ( acceptedSeries ) break;

		}
		if ( ! acceptedSeries ) throw new Error(
			`No collision-free organic series and routes for ${ q }` );
		for ( let level = 0; level < LAYERS; level ++ )
			placements[ firstIndex + level ] = acceptedSeries.candidate[ level ];
		units.push( ... acceptedSeries.proposedUnits );
		chambers.push( ... acceptedSeries.proposedChambers );
		acceptedRoutes.push( ... acceptedSeries.proposedRoutes );
		for ( const [ child, route ] of acceptedSeries.proposedRouteParams )
			routes[ child ] = route;

	}
	return { placements, routes };

}

const BAKED_ORGANIC_PLACEMENT = [[5.856733955190994,-6.110879171789633],[-6.4492788066616145,-10.399253686105144],[-12.846710094351831,1.3181312422636777],[-2.5821285474937636,9.351044271157939],[0.09809385665819903,2.058028759219209],[5.453397788156909,-9.738330874706088],[18.02312627274294,-6.817528678122741],[18.028448198495504,5.644461713077208],[-10.76428115529359,2.3702515316425092],[1.647398503672186,1.304964698927293],[5.740793586948065,13.308359026820554],[-5.848765988316284,19.891154190268296],[-1.2371594909352357,-23.550112275538872],[-14.218312920341441,-22.203602484429663],[-15.038980287055683,-8.906251469095615],[-2.274555990567113,-5.997799024240253],[16.170058890725134,-2.520090709172539],[26.43349879246538,5.128289927826391],[21.231707708174536,16.737764615392937],[8.960169376588919,14.480286174977916],[-13.633302594411608,14.190764142781685],[-1.851632344137914,11.417168904463875],[-1.250217191273208,-1.0123414666681727],[-13.364090805468674,-4.6777489893572115],[18.752380815346974,-19.043473069223317],[7.1953720284035665,-24.19260588434969],[-0.43708697718571266,-15.270252576361314],[6.0881288894363035,-4.77692312660616],[4.004159069455039,10.954783977161144],[12.563389141005038,20.4087099814303],[6.325409425473813,30.43186782974587],[-6.082326664379938,26.716613403338833],[-22.832947729582383,-7.019640145045168],[-28.424256999325266,-17.911767233752137],[-18.526516226926322,-26.390423703263792],[-8.505126728705621,-18.78341675181424],[30.10948583386453,5.092993676757407],[33.53144746448961,-6.940012063718029],[22.947366447846964,-13.265310545131058],[13.977773604707654,-4.600698602279367],[-22.262715609137608,29.13797839650603],[-7.499660579277924,22.151673489665693],[-19.884492494856513,10.204360637578647],[-26.366887553740582,25.15418252607766],[10.278981038612578,-32.65474017872328],[-2.1072877170739623,-37.50799634841949],[-8.81980266439334,-26.35125847177318],[0.1460780695910111,-17.74303688600244],[17.560456958143416,10.209381227172946],[25.99918602862926,19.60735299445504],[18.103718468840224,30.200882603163045],[7.150723559942762,25.634037503652877],[-23.766306151864445,3.677133267642513],[-39.46809393127661,-3.5444015770516533],[-26.213056081738273,-14.561630764976684],[-20.818816914879932,0.7296317701800614],[27.78791265271951,-9.945197222279191],[32.30614605492168,-20.89776597060341],[22.162456106858958,-28.785875190495048],[12.706609943249802,-21.84953056393244],[-14.804924967477039,36.19197235731729],[1.1431414189658646,31.897573051549934],[-7.187522159019789,18.134523176428818],[-18.542845175636913,29.218028377866112],[-9.694453524403682,-28.394044042959173],[-20.914639550590255,-33.52888206187811],[-28.868363519039764,-23.000087274303333],[-20.077218389161363,-13.471154999336662],[43.23861276664253,11.678510005151267],[41.56298758205861,-1.0587513049273811],[29.687508617850465,-2.625690450740695],[24.942170635468116,9.781629740961439],[-31.515167327147942,24.310876218517414],[-39.6501491557081,14.711535399668774],[-31.746990517618116,4.380787157943416],[-20.718286287048798,9.060930877647895],[18.221759186064002,-37.199847197762665],[21.095580420591318,-25.435603050634924],[10.753737592781377,-19.21243503370344],[1.7385855375945098,-27.108941441145056],[0.5536707285150868,32.44148832583063],[7.8022468434201535,42.2796523466983],[18.938275757950038,38.6025983105949],[18.74978654371832,26.183626626709614],[-23.692059848111132,-22.313132346556635],[-27.15752829998467,-6.745485893460813],[-41.83187706853663,-16.05194362673733],[-29.191406278454522,-25.814768476206044],[42.59125307544874,-5.825573037632136],[39.962030512268235,-18.516917228222393],[27.174183700336137,-18.524169023800535],[24.58870223102945,-5.726588149094582],[-28.651088047909813,37.383829978757184],[-24.67660912658306,21.59511322422133],[-10.519852176122297,31.55730959395292],[-23.97546504923556,40.650877235647535]];
const BAKED_ORGANIC_ROUTES = [null,[0,0],[0,0],[0,0],[0,0],[6,0],[0,0],[0,0],[0,0],[-4,0],[0,0],[0,0],[2,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[6,0],[0,0],[0,0],[0,0],[0,0],[2,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[4,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[6,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[2,0],[0,0],[0,0],[0,0],[0,0],[-2,0],[0,0],[0,0],[-2,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[4,0],[0,0],[-6,-2.5],[2,2.5],[0,0],[0,0],[0,0],[-4,0],[-4,-2.5],[0,0],[-2,-2.5],[0,0],[0,0]];
ORGANIC_PLACEMENT = BAKED_ORGANIC_PLACEMENT.map( ( [ x, y ] ) => ( { x, y } ) );
ORGANIC_ROUTES = BAKED_ORGANIC_ROUTES.map( ( route ) => route ? ( {
	lateralBulgeWorld: route[ 0 ], verticalBulgeWorld: route[ 1 ],
} ) : null );
// TRACE D'UN TUNNEL.
//
// La courbe est une BEZIER QUADRATIQUE, et ce choix n'est pas esthetique : les
// fourmis parcourent les aretes du nid par une Bezier a UN point de controle
// (nodeTexture, rangee 1). Creuser le volume le long d'une autre courbe — un
// arc de cercle, par exemple — desynchronise les deux : mesure faite, 1,21
// unite d'ecart pour un tunnel de 0,80 de rayon, soit des fourmis qui
// traversent visiblement la terre entre deux chambres. En creusant la Bezier
// elle-meme, l'accord est exact par construction.
//
// Le bombement est cherche par DICHOTOMIE SUR LA PENTE REELLE, jamais sur la
// longueur totale : une Bezier est au plus lent en son milieu, precisement la
// ou le profil de descente en S est au plus raide. Dimensionner sur la
// longueur laissait passer des portions a 40 degres au coeur du tunnel. La
// pente maximale decroit strictement avec le bombement, donc la dichotomie
// converge ; vingt-deux tours, une fois par tunnel et par reconstruction.
function tunnelPathWithRoute( a, b, seed, steps = 10, route = {} ) {

	if ( ! a || ! b ) throw new Error( 'tunnelPath expects two endpoints' );
	if ( ! Number.isInteger( steps ) || steps < 2 )
		throw new Error( 'tunnelPath steps must be an integer >= 2' );
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const chord = Math.hypot( dx, dy );
	const nx = chord > 1e-9 ? - dy / chord : 0;
	const ny = chord > 1e-9 ? dx / chord : 0;
	// Sinuosite organique a basse frequence, bornee et nulle aux portails. Elle
	// est partagee par le creusage, le SDF et les pistes : aucun bruit visuel ne
	// peut desynchroniser les pattes de la paroi physique.
	const curvatureScale = CORRIDOR_CURVATURE_SCALE_OVERRIDE.get( seed ) ?? 1;
	const amplitude = ( 0.64 + 0.48 * vdc( seed + 1, 7 ) ) * curvatureScale / TEXEL;
	const collisionAvoidance = ( ( CORRIDOR_BULGE_OVERRIDE_WORLD.get( seed ) ?? 0 )
		+ ( route.lateralBulgeWorld ?? 0 ) ) / TEXEL;
	const phase = GOLD * ( seed + 1 );
	const points = [];

	for ( let index = 0; index <= steps; index ++ ) {

		const t = index / steps;
		const envelope = Math.sin( Math.PI * t ) ** 2;
		const wiggle = amplitude * envelope * (
			0.58 * Math.sin( Math.PI * 2 * t + phase )
			+ 0.27 * Math.sin( Math.PI * 4 * t - phase * 0.37 )
			+ 0.15 * Math.sin( Math.PI * 6 * t + phase * 0.19 ) )
			+ collisionAvoidance * envelope;
		const eased = t * t * t * ( t * ( t * 6 - 15 ) + 10 );
		points.push( {
			x: a.x + dx * t + nx * wiggle,
			y: a.y + dy * t + ny * wiggle,
			depth: a.depth + ( b.depth - a.depth ) * eased
				+ ( route.verticalBulgeWorld ?? 0 ) * envelope,
		} );

	}
	points[ 0 ] = { x: a.x, y: a.y, depth: a.depth };
	points[ points.length - 1 ] = { x: b.x, y: b.y, depth: b.depth };
	return points;

}
export function tunnelPath( a, b, seed, steps = 10 ) {

	// Route exceptions belong to the baked child unit, not to the numeric seed.
	// Synthetic fixtures can reuse a seed without inheriting an unrelated nest
	// underpass, while every production consumer still reads the same geometry.
	return tunnelPathWithRoute( a, b, seed, steps, b?.organicRoute ?? {} );

}
// Raccord d'entrée commun au creusage, au SDF et à la navigation. La première
// portion descend à la verticale : le tube coupe donc le sol suivant une vraie
// bouche, avant de rejoindre progressivement le puits tortueux.
export function entrancePath( a, b, seed, steps = 10 ) {

	if ( Math.hypot( b.x - a.x, b.y - a.y ) <= 1e-6 ) {

		return Array.from( { length: steps + 1 }, ( _, i ) => ( {
			x: a.x,
			y: a.y,
			depth: a.depth + ( b.depth - a.depth ) * i / steps,
		} ) );

	}
	const delta = b.depth - a.depth;
	const fraction = Math.min( 0.45, 1.2 / Math.max( Math.abs( delta ), 1e-6 ) );
	const collar = { ...a, depth: a.depth + delta * fraction };
	const verticalSteps = Math.max( 2, Math.round( steps * 0.24 ) );
	const vertical = Array.from( { length: verticalSteps + 1 }, ( _, i ) => ( {
		x: a.x,
		y: a.y,
		depth: a.depth + ( collar.depth - a.depth ) * i / verticalSteps,
	} ) );
	const tail = tunnelPath( collar, b, seed, Math.max( 4, steps - verticalSteps ) );
	return [ ...vertical, ...tail.slice( 1 ) ];

}

// Peripheral entrance connector shared by carving and rendered navigation.
// Its fixed bulge clears the complete K96 registry without runtime search.
export function entranceConnectorPath( a, b, steps = 10 ) {

	const points = tunnelPath( a, b, 0, steps );
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const chord = Math.hypot( dx, dy );
	if ( chord <= 1e-9 ) return points;
	const nx = - dy / chord;
	const ny = dx / chord;
	const amplitude = ENTRANCE_CONNECTOR_BULGE_WORLD / TEXEL;

	for ( let index = 1; index < points.length - 1; index ++ ) {

		const t = index / ( points.length - 1 );
		const offset = amplitude * Math.sin( Math.PI * t ) ** 2;
		points[ index ].x += nx * offset;
		points[ index ].y += ny * offset;

	}
	return points;

}
// ---------------------------------------------------------------------------
// CREUSAGE
// ---------------------------------------------------------------------------
// `field` : DEPTH_SIZE² × 4 flottants — UN PLANCHER PAR NAPPE.
// 0 = pas de cavité sur cette nappe (les profondeurs sont toujours < 0).
//
// La lèvre du biseau est RELATIVE à la profondeur, jamais absolue : une lèvre
// fixe à −0,4 sur une chambre à −60 transformerait chaque chambre profonde en
// puits de mine de 60 unités de dénivelé sur 6 texels.
// ---------------------------------------------------------------------------
// ÉCRITURE DE CELLULE AVEC CANAUX-SLOTS. Les 4 canaux d'une colonne ne sont
// pas « les 4 niveaux » mais 4 PLACES pour des planchers superposés : quand
// deux structures à des profondeurs très différentes se croisent sur le même
// canal, garder systématiquement la plus profonde (l'ancien « min wins »)
// SECTIONNAIT la plus haute — falaise infranchissable, fourmis enfermées
// dans leur loge (mesuré : rampes coupées par des marches de 1,4 à 5 u).
//
// Règle d'écriture à la colonne (base = index du premier canal) :
//   • canal vide, ou valeurs à moins de MERGE_GAP (jonction, planchers qui se
//     rejoignent en douceur) → on écrit/merge sur le canal demandé ;
//   • sinon, conflit de hauteur → la cavité part sur un AUTRE canal libre de
//     la colonne (la continuité fait adopter le canal aux fourmis d'elle-même,
//     voir simulation.js — les canaux sont interchangeables) ;
//   • aucun canal libre → on garde le plus profond (rare, falaise assumée).
// MERGE_GAP est volontairement JUSTE SOUS la hauteur de marche des fourmis
// (0,75 u, simulation.js) : une jonction mergée reste franchissable.
const MERGE_GAP = 0.7;

function carveCell( field, base, y, layer ) {

	const cur = field[ base + layer ];

	if ( cur === 0 ) { field[ base + layer ] = y; return; }
	if ( Math.abs( cur - y ) <= MERGE_GAP ) { field[ base + layer ] = Math.min( cur, y ); return; }

	for ( let l = 0; l < 4; l ++ ) {

		if ( l === layer ) continue;
		const c2 = field[ base + l ];
		if ( c2 === 0 ) { field[ base + l ] = y; return; }
		if ( Math.abs( c2 - y ) <= MERGE_GAP ) { field[ base + l ] = Math.min( c2, y ); return; }

	}

	// aucun canal libre : plus profond gagne (comportement historique)
	if ( y < cur ) field[ base + layer ] = y;

}

function carveDisc( field, ox, oy, X, Y, R, depth, layer ) {

	const bevel = 3 + 0.06 * Math.abs( depth ) / TEXEL * TEXEL;
	const Rb = R + bevel, Rb2 = Rb * Rb;
	const lip = depth + Math.min( 1.0, 0.06 * Math.abs( depth ) );
	const x0 = Math.max( 0, Math.floor( X - ox - Rb ) );
	const x1 = Math.min( DEPTH_SIZE - 1, Math.ceil( X - ox + Rb ) );
	const y0 = Math.max( 0, Math.floor( Y - oy - Rb ) );
	const y1 = Math.min( DEPTH_SIZE - 1, Math.ceil( Y - oy + Rb ) );

	for ( let gy = y0; gy <= y1; gy ++ ) {

		const row = gy * DEPTH_SIZE;
		const dy = gy + oy - Y, dy2 = dy * dy;

		for ( let gx = x0; gx <= x1; gx ++ ) {

			const dx = gx + ox - X, d2 = dx * dx + dy2;
			if ( d2 > Rb2 ) continue;

			const d = Math.sqrt( d2 );
			const t = Math.max( 0, ( d - ( R - 1.5 ) ) / ( bevel + 1.5 ) );
			const y = depth + ( lip - depth ) * Math.min( 1, t ) ** 0.8;
			const i = ( row + gx ) * 4;
			carveCell( field, i, y, layer );

		}

	}

}

// tunnel = capsule (distance point-segment), creusée dans la nappe de l'ENFANT
// sur toute sa longueur — donc dès la chambre parente. Une fourmi qui vise le
// nœud enfant bascule de nappe alors qu'elle est encore dans la chambre du
// parent, et trouve son plancher exactement à la même hauteur : la transition
// est invisible.
function carveTube( field, ox, oy, a, b, w, layer ) {

	const ex = b.x - a.x, ey = b.y - a.y;
	const el2 = Math.max( ex * ex + ey * ey, 1e-6 );
	const pad = w + 6;
	const x0 = Math.max( 0, Math.floor( Math.min( a.x, b.x ) - ox - pad ) );
	const x1 = Math.min( DEPTH_SIZE - 1, Math.ceil( Math.max( a.x, b.x ) - ox + pad ) );
	const y0 = Math.max( 0, Math.floor( Math.min( a.y, b.y ) - oy - pad ) );
	const y1 = Math.min( DEPTH_SIZE - 1, Math.ceil( Math.max( a.y, b.y ) - oy + pad ) );

	for ( let gy = y0; gy <= y1; gy ++ ) {

		const row = gy * DEPTH_SIZE;

		for ( let gx = x0; gx <= x1; gx ++ ) {

			const px = gx + ox - a.x, py = gy + oy - a.y;
			const h = Math.max( 0, Math.min( 1, ( px * ex + py * ey ) / el2 ) );
			const qx = px - ex * h, qy = py - ey * h;
			const d = Math.hypot( qx, qy );
			const depth = a.depth + ( b.depth - a.depth ) * h;
			const bevel = 3;
			if ( d > w + bevel ) continue;

			const lip = depth + Math.min( 1.0, 0.06 * Math.abs( depth ) );
			const t = Math.max( 0, ( d - ( w - 1 ) ) / ( bevel + 1 ) );
			const y = depth + ( lip - depth ) * Math.min( 1, t ) ** 0.8;
			const i = ( row + gx ) * 4;
			carveCell( field, i, y, layer );

		}

	}

}

// creuse une polyligne : une capsule par segment
function carvePath( field, ox, oy, pts, w, layer ) {

	for ( let i = 0; i < pts.length - 1; i ++ ) {

		carveTube( field, ox, oy, pts[ i ], pts[ i + 1 ], w, layer );

	}

}

// ---------------------------------------------------------------------------
// CONSTRUCTION COMPLÈTE
// ---------------------------------------------------------------------------
// Graphe : 0 = entrée de surface, 1 = pied du puits, puis une loge par nœud.
export const NODE_ENTRY = 0, NODE_SHAFT = 1, NODE_CHAMBER0 = 2;

// objectifs (bits 4-7 d'antState, 16 valeurs) : 0 aucun, 1 grenier, 2 reine,
// 3 couvain, 4 sortie — inchangés pour ne rien casser ; 5+ réservés.
export const GOAL = { NONE: 0, GRANARY: 1, QUEEN: 2, BROOD: 3, EXIT: 4 };

// `carve = false` : on ne veut que le graphe (cas de la croissance, ou le
// creusage a deja ete fait de maniere incrementale dans le champ existant).
export function buildNest( K, depthMax, tunnelW, carve = true ) {
	if ( ! Number.isFinite( depthMax ) || depthMax < MIN_NEST_DEPTH || depthMax > MAX_NEST_DEPTH )
		throw new RangeError( `Nest depth must be between ${ MIN_NEST_DEPTH } and ${ MAX_NEST_DEPTH } world units` );
	tunnelW = Math.max( MIN_TUNNEL_WIDTH, tunnelW );

	const ox = Math.round( NEST.x - DEPTH_SIZE / 2 );
	const oy = Math.round( NEST.y - DEPTH_SIZE / 2 );
	const field = carve ? new Float32Array( DEPTH_SIZE * DEPTH_SIZE * 4 ) : null;

	const U = [];
	for ( let k = 0; k < K_MAX; k ++ ) U.push( nestUnit( k, depthMax ) );
	const PAR = [];
	for ( let k = 0; k < K_MAX; k ++ ) PAR.push( parentOf( k, U ) );

	// Portail peripherique deterministe : le puits descend verticalement jusqu'au
	// plancher de la salle de garde, hors de toutes les cavites du registre K96.
	const guardRoom = U[ 0 ];
	const shaft = {
		x: guardRoom.x + Math.cos( ENTRANCE_PORTAL_ANGLE_RAD )
			* ENTRANCE_PORTAL_OFFSET_WORLD / TEXEL,
		y: guardRoom.y + Math.sin( ENTRANCE_PORTAL_ANGLE_RAD )
			* ENTRANCE_PORTAL_OFFSET_WORLD / TEXEL,
		depth: guardRoom.depth,
		layer: 0,
	};
	const entry = { x: shaft.x, y: shaft.y, depth: 0, layer: 0 };

	// --- creusage du préfixe actif ---
	if ( carve ) {

		carvePath( field, ox, oy, entrancePath( entry, shaft, K_MAX + 0x51 ), tunnelW * 1.15, 0 );

		for ( let k = 0; k < K; k ++ ) {

			const c = U[ k ];
			const p = PAR[ k ] < 0 ? shaft : U[ PAR[ k ] ];
			const path = k === 0
				? entranceConnectorPath( p, c )
				: tunnelPath( p, c, k );
			carvePath( field, ox, oy, path, tunnelW, c.layer );
			carveDisc( field, ox, oy, c.x, c.y, c.R, c.depth, c.layer );

		}

	}

	// --- graphe de navigation ---
	const nodes = [
		{ x: entry.x, y: entry.y, r: 5, layer: 0, type: ROOM.TUNNEL, depth: entry.depth,
			cx: entry.x, cy: entry.y },
		{ x: shaft.x, y: shaft.y, r: 5, layer: 0, type: ROOM.TUNNEL, depth: shaft.depth,
			cx: shaft.x, cy: shaft.y },
	];
	for ( let k = 0; k < K; k ++ ) {

		const c = U[ k ];
		// rayon d'ARRIVÉE : franchement plus petit que la chambre, sinon la fourmi
		// valide le nœud avant d'y être et vise déjà le suivant — donc traverse la
		// paroi. Borné aussi par la largeur du tunnel.
		// POINT DE CONTROLE : le milieu de l'arc du tunnel qui mene ici. Une
		// fourmi qui vise ce noeud passe d'abord par lui, ce qui lui fait suivre
		// la COURBE du tunnel au lieu d'en couper la corde — et donc de racler la
		// terre pleine. Un point suffit : la sagitta de chaque demi-arc reste
		// sous la demi-largeur du tunnel.
		const par = PAR[ k ] < 0 ? shaft : U[ PAR[ k ] ];
		const path = k === 0
			? entranceConnectorPath( par, c )
			: tunnelPath( par, c, k );
		const mid = path[ Math.floor( path.length / 2 ) ];

		nodes.push( {
			x: c.x, y: c.y, r: Math.min( c.R * 0.5, tunnelW + 2 ),
			layer: c.layer, type: c.type, depth: c.depth,
			cx: mid.x, cy: mid.y,
		} );

	}

	const edges = [ [ NODE_ENTRY, NODE_SHAFT ] ];
	for ( let k = 0; k < K; k ++ ) {

		edges.push( [ PAR[ k ] < 0 ? NODE_SHAFT : NODE_CHAMBER0 + PAR[ k ], NODE_CHAMBER0 + k ] );

	}

	// --- chambres remarquables : indices FIGÉS du registre (série 0) ---
	const roomNode = ( type ) => {

		for ( let k = 0; k < K; k ++ ) if ( U[ k ].type === type ) return NODE_CHAMBER0 + k;
		return NODE_SHAFT;

	};
	const GOAL_NODE = [ - 1, roomNode( ROOM.GRENIER ), roomNode( ROOM.ROYALE ),
		roomNode( ROOM.CRECHE ), NODE_ENTRY ];
	while ( GOAL_NODE.length < 16 ) GOAL_NODE.push( - 1 );

	// --- next-hop par BFS depuis chaque objectif ---
	const adj = nodes.map( () => [] );
	for ( const [ a, b ] of edges ) { adj[ a ].push( b ); adj[ b ].push( a ); }
	const nextHop = new Int32Array( nodes.length * 16 );

	for ( let g = 1; g < 16; g ++ ) {

		const target = GOAL_NODE[ g ];
		if ( target < 0 ) { for ( let n = 0; n < nodes.length; n ++ ) nextHop[ n * 16 + g ] = n; continue; }

		const parent = new Int32Array( nodes.length ).fill( - 1 );
		const queue = [ target ];
		parent[ target ] = target;

		for ( let qi = 0; qi < queue.length; qi ++ ) {

			for ( const m of adj[ queue[ qi ] ] ) {

				if ( parent[ m ] === - 1 ) { parent[ m ] = queue[ qi ]; queue.push( m ); }

			}

		}

		for ( let n = 0; n < nodes.length; n ++ ) nextHop[ n * 16 + g ] = parent[ n ] === - 1 ? n : parent[ n ];

	}

	// --- mangeoires : LA cellule d'échange de chaque chambre remarquable ---
	const cellOf = ( n ) => Math.floor( nodes[ n ].y ) * GRID + Math.floor( nodes[ n ].x );
	const troughs = {
		granary: { ...nodes[ GOAL_NODE[ 1 ] ], cell: cellOf( GOAL_NODE[ 1 ] ) },
		queen: { ...nodes[ GOAL_NODE[ 2 ] ], cell: cellOf( GOAL_NODE[ 2 ] ) },
		brood: { ...nodes[ GOAL_NODE[ 3 ] ], cell: cellOf( GOAL_NODE[ 3 ] ) },
	};

	// profondeur (CPU) : nappe donnée, ou la plus haute cavité si layer < 0
	const depthAt = ( x, y, layer = - 1 ) => {

		const gx = Math.round( x - ox ), gy = Math.round( y - oy );
		if ( gx < 0 || gy < 0 || gx >= DEPTH_SIZE || gy >= DEPTH_SIZE ) return 0;
		const i = ( gy * DEPTH_SIZE + gx ) * 4;
		if ( layer >= 0 ) return field[ i + layer ];
		let best = 0;
		for ( let l = 0; l < LAYERS; l ++ ) if ( field[ i + l ] < best ) best = field[ i + l ];
		return best;

	};

	// rayon utile du nid (texels) — sert au cadrage, à la fosse et aux tests
	let radius = 0;
	for ( let k = 0; k < K; k ++ ) {

		radius = Math.max( radius, Math.hypot( U[ k ].x - NEST.x, U[ k ].y - NEST.y ) + U[ k ].R );

	}

	return {
		K, depthMax, tunnelW, units: U, parents: PAR,
		nodes, edges, nextHop, GOAL_NODE,
		troughs, field, depthAt,
		origin: { x: ox, y: oy },
		radiusTexels: radius,
		radiusWorld: radius * TEXEL,
		shaft, entry,
		peripheralEntrance: true,
	};

}

// CROISSANCE : creuse les loges [Kold, Knew) DANS le champ existant. C'est tout
// l'intérêt du registre append-only — on n'efface et ne recalcule jamais rien.
export function growNest( nest, Knew, tunnelW ) {
	tunnelW = nest.tunnelW;

	const { origin: { x: ox, y: oy }, field, units: U, parents: PAR } = nest;

	for ( let k = nest.K; k < Knew; k ++ ) {

		const c = U[ k ];
		const p = PAR[ k ] < 0 ? nest.shaft : U[ PAR[ k ] ];
		const path = k === 0
			? entranceConnectorPath( p, c )
			: tunnelPath( p, c, k );
		carvePath( field, ox, oy, path, tunnelW, c.layer );
		carveDisc( field, ox, oy, c.x, c.y, c.R, c.depth, c.layer );

	}

	return Knew;

}

// paramètres courants dérivés de l'UI
export function nestParams() {

	return {
		K: quantK( nestBudget( params.antCount, params.nestScale ) ),
		depthMax: params.nestDepth,
		tunnelW: Math.max( MIN_TUNNEL_WIDTH, params.nestTunnelW ),
	};

}

// ---------------------------------------------------------------------------
// CHAMP DE NAVIGATION (bake à chaque changement de nid). Pour chaque objectif
// (grenier, reine, couvain, sortie), la distance en texels de chaque colonne
// à l'objectif, calculée par BFS sur le graphe des colonnes PRATICABLES :
// une arête entre deux colonnes voisines n'existe que si leurs cavités sont
// à hauteur de marche (≤ ANT_STEP_H, la règle EXACTE du mouvement des
// fourmis, simulation.js). La fourmi ne « devine » plus sa route en ligne
// droite : elle descend le gradient du champ — poches-pièges et waypoints
// mal orientés disparaissent structurellement.
//
// La distance est PAR (cellule, canal) : une fourmi au-dessus d'une chambre
// sur une autre nappe ne lit PAS la distance de la chambre (sinon elle y
// tournerait en rond, incapable d'y descendre) mais celle de SA nappe — le
// BFS ayant déjà encodé les changements de nappe continus, suivre le gradient
// la fait transiter par les jonctions d'elle-même.
// Retour : 4 tableaux (un par objectif : grenier, reine, couvain, sortie),
// chacun DEPTH_SIZE² × 4 (un float par canal de colonne).
export const ANT_STEP_H = 0.75;    // hauteur de marche (u) — partagée avec la sim
export const NAV_UNREACH = 6e4;

export function bakeNavField( nest ) {

	const N = DEPTH_SIZE;
	const { field, nodes, GOAL_NODE } = nest;
	const out = [];
	const dist = new Int32Array( N * N * 4 );          // distance par (cellule, canal)
	const queue = new Int32Array( N * N * 4 );

	// objectifs : index de nœud ; la sortie vise le nœud d'entrée (0)
	const goalNodes = [ GOAL_NODE[ 1 ], GOAL_NODE[ 2 ], GOAL_NODE[ 3 ], 0 ];

	// voisinage 8-connexe ; un biais diagonal exige qu'au moins un
	// intermédiaire orthogonal soit franchissable (règle du coin, comme le
	// mouvement par sous-pas des fourmis)
	const DIRS = [ [ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ],
		[ 1, 1 ], [ 1, - 1 ], [ - 1, 1 ], [ - 1, - 1 ] ];

	for ( let g = 0; g < 4; g ++ ) {

		dist.fill( - 1 );
		let head = 0, tail = 0;
		const gn = nodes[ goalNodes[ g ] ];
		const sx = Math.round( gn.x - nest.origin.x ), sy = Math.round( gn.y - nest.origin.y );

		for ( let c = 0; c < 4; c ++ ) {

			const i = ( sy * N + sx ) * 4 + c;
			if ( sx >= 0 && sy >= 0 && sx < N && sy < N && field[ i ] < - 1e-4 ) {

				dist[ i ] = 0;
				queue[ tail ++ ] = i;

			}

		}

		while ( head < tail ) {

			const cur = queue[ head ++ ];
			const cx = ( ( cur >> 2 ) % N ), cy = Math.floor( ( cur >> 2 ) / N );
			const cc = cur & 3;
			const cd = field[ cur ];
			const nd = dist[ cur ] + 1;

			// CHANGEMENT DE CANAL DANS LA MÊME CELLULE : la fourmi adopte la
			// cavité la plus proche en hauteur (simulation.js) — le BFS doit
			// modéliser ces bascules, sinon des réseaux entiers reliés par une
			// jonction dans une même colonne (puits → tube d'un autre canal)
			// sont marqués inaccessibles
			for ( let c = 0; c < 4; c ++ ) {

				if ( c === cc ) continue;
				const ni = cur - cc + c;
				if ( field[ ni ] >= - 1e-4 || dist[ ni ] >= 0 ) continue;
				if ( Math.abs( field[ ni ] - cd ) > ANT_STEP_H ) continue;
				dist[ ni ] = nd;
				queue[ tail ++ ] = ni;

			}

			for ( const [ dx, dy ] of DIRS ) {

				const nx = cx + dx, ny = cy + dy;
				if ( nx < 0 || ny < 0 || nx >= N || ny >= N ) continue;

				// règle du coin pour les diagonales : un intermédiaire
				// orthogonal praticable à hauteur de marche est exigé
				if ( dx !== 0 && dy !== 0 ) {

					let okSide = false;

					for ( const [ ox, oy ] of [ [ dx, 0 ], [ 0, dy ] ] ) {

						const s0 = ( ( cy * N + cx + ox ) * 4 );
						const s1 = ( ( ( cy + oy ) * N + cx + ox ) * 4 );

						for ( let c0 = 0; c0 < 4 && ! okSide; c0 ++ ) {

							if ( field[ s0 + c0 ] < - 1e-4 && Math.abs( field[ s0 + c0 ] - cd ) <= ANT_STEP_H ) {

								for ( let c1 = 0; c1 < 4; c1 ++ ) {

									if ( field[ s1 + c1 ] < - 1e-4 && Math.abs( field[ s1 + c1 ] - field[ s0 + c0 ] ) <= ANT_STEP_H ) { okSide = true; break; }

								}

							}

						}

					}
					if ( ! okSide ) continue;

				}

				for ( let c = 0; c < 4; c ++ ) {

					const ni = ( ny * N + nx ) * 4 + c;
					if ( field[ ni ] >= - 1e-4 || dist[ ni ] >= 0 ) continue;
					if ( Math.abs( field[ ni ] - cd ) > ANT_STEP_H ) continue;
					dist[ ni ] = nd;
					queue[ tail ++ ] = ni;

				}

			}

		}

		// export tel quel : une distance par (cellule, canal)
		const outG = new Float32Array( N * N * 4 ).fill( NAV_UNREACH );

		for ( let i = 0; i < N * N * 4; i ++ ) {

			if ( dist[ i ] >= 0 ) outG[ i ] = dist[ i ];

		}
		out.push( outG );

	}

	return out;

}
