// LE NID — registre de loges déterministe, en NAPPES SUPERPOSÉES.
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
//    La navigation 2D, elle, ne change pas : une fourmi suit son graphe arête
//    par arête et sa nappe ne sert qu'à savoir à quelle HAUTEUR la dessiner.
//    Deux chambres qui se recouvrent en (x, y) ne peuvent pas se gêner
//    puisqu'elles ne sont jamais au même niveau.
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

import { GRID, TEXEL, NEST, params } from './config.js';

// nombre de nappes = nombre de niveaux de chambres (une par canal RGBA)
export const LAYERS = 4;
export const K_MAX = 96;                 // loges candidates (registre complet)
export const DEPTH_SIZE = 384;           // côté de la carte de profondeur (texels)

// angle d'or : deux loges consécutives ne sont jamais alignées, la couverture
// angulaire reste bonne pour N'IMPORTE QUEL préfixe
const GOLD = 2.399963229728653;

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
const LEVEL = [
	// zf = fraction de la profondeur · rw = rayon de chambre (unités monde)
	// spread = rayon du disque où se répartissent les loges (unités monde)
	{ zf: 0.05, rw: 3.60, spread: 15.0, rooms: [ ROOM.GARDE, ROOM.SOLARIUM, ROOM.SOLARIUM, ROOM.GARDE ] },
	{ zf: 0.26, rw: 3.20, spread: 12.5, rooms: [ ROOM.GRENIER, ROOM.ETABLE, ROOM.GRENIER ] },
	{ zf: 0.58, rw: 2.90, spread: 10.0, rooms: [ ROOM.CRECHE, ROOM.NURSERIE, ROOM.COMPOST ] },
	{ zf: 1.00, rw: 2.60, spread: 7.5, rooms: [ ROOM.ROYALE, ROOM.COUVEUSE, ROOM.DORTOIR ] },
];

// rayon de l'hélice de la série centrale (unités monde). Un puits PARFAITEMENT
// vertical est impossible dans une carte de hauteurs — et les vrais nids n'en
// ont pas non plus : leurs descentes sont hélicoïdales.
const HELIX_R = 4.5;
const HELIX_TURN = 1.9;                  // radians gagnés par niveau

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
export function nestUnit( k, depthMax ) {

	const { q, s } = EMISSION[ k ];
	const L = LEVEL[ s ];

	// rayon de chambre : varié mais déterministe
	const R = ( L.rw * ( 0.80 + 0.40 * vdc( k + 1, 5 ) ) ) / TEXEL;

	// La série 0 descend en HÉLICE autour de l'axe du nid ; les suivantes
	// s'écartent en spirale d'or. Dans les deux cas l'angle tourne d'un niveau
	// à l'autre : aucune rampe n'est verticale, donc toutes sont représentables
	// dans une carte de hauteurs — et ça donne l'escalier en colimaçon des
	// vrais nids.
	const r = q === 0 ? HELIX_R / TEXEL
		: ( L.spread / TEXEL ) * ( 0.34 + 0.66 * vdc( q, 3 ) );
	const th = GOLD * q + HELIX_TURN * s + 0.5 * ( vdc( k + 1, 2 ) - 0.5 );

	// profondeur : le niveau donne la strate, un léger décalage par loge évite
	// que tout un étage soit rigoureusement plan
	const depth = - depthMax * L.zf * ( 0.94 + 0.12 * vdc( k + 1, 7 ) );

	return {
		k, q, level: s, layer: s,
		R,
		x: NEST.x + Math.cos( th ) * r,
		y: NEST.y + Math.sin( th ) * r,
		depth,
		type: L.rooms[ q % L.rooms.length ],
	};

}

// parent : le niveau du dessus DE LA MÊME SÉRIE ; pour une tête de série, la
// loge de niveau 0 déjà émise la plus proche. Ne regarde JAMAIS que j < k, ce
// qui rend la structure append-only.
export function parentOf( k, U ) {

	const c = U[ k ];

	if ( c.level > 0 ) {

		for ( let j = k - 1; j >= 0; j -- ) {

			if ( U[ j ].q === c.q && U[ j ].level === c.level - 1 ) return j;

		}

	}

	let best = - 1, bd = Infinity;
	for ( let j = 0; j < k; j ++ ) {

		if ( U[ j ].level !== 0 ) continue;
		const d = Math.hypot( U[ j ].x - c.x, U[ j ].y - c.y );
		if ( d < bd ) { bd = d; best = j; }

	}
	return best;                                  // -1 = pied du puits d'entrée

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
			const i = ( row + gx ) * 4 + layer;
			if ( field[ i ] === 0 || y < field[ i ] ) field[ i ] = y;

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
			const i = ( row + gx ) * 4 + layer;
			if ( field[ i ] === 0 || y < field[ i ] ) field[ i ] = y;

		}

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

	const ox = Math.round( NEST.x - DEPTH_SIZE / 2 );
	const oy = Math.round( NEST.y - DEPTH_SIZE / 2 );
	const field = carve ? new Float32Array( DEPTH_SIZE * DEPTH_SIZE * 4 ) : null;

	const U = [];
	for ( let k = 0; k < K_MAX; k ++ ) U.push( nestUnit( k, depthMax ) );
	const PAR = [];
	for ( let k = 0; k < K_MAX; k ++ ) PAR.push( parentOf( k, U ) );

	// pied du puits : juste sous l'entrée, à la profondeur du premier niveau
	const shaft = {
		x: NEST.x, y: NEST.y,
		depth: - depthMax * LEVEL[ 0 ].zf * 0.45,
		layer: 0,
	};
	const entry = { x: NEST.x, y: NEST.y, depth: - 0.35, layer: 0 };

	// --- creusage du préfixe actif ---
	if ( carve ) {

		carveTube( field, ox, oy, entry, shaft, tunnelW * 1.15, 0 );

		for ( let k = 0; k < K; k ++ ) {

			const c = U[ k ];
			const p = PAR[ k ] < 0 ? shaft : U[ PAR[ k ] ];
			carveTube( field, ox, oy, p, c, tunnelW, c.layer );
			carveDisc( field, ox, oy, c.x, c.y, c.R, c.depth, c.layer );

		}

	}

	// --- graphe de navigation ---
	const nodes = [
		{ x: entry.x, y: entry.y, r: 5, layer: 0, type: ROOM.TUNNEL, depth: entry.depth },
		{ x: shaft.x, y: shaft.y, r: 5, layer: 0, type: ROOM.TUNNEL, depth: shaft.depth },
	];
	for ( let k = 0; k < K; k ++ ) {

		const c = U[ k ];
		// rayon d'ARRIVÉE : franchement plus petit que la chambre, sinon la fourmi
		// valide le nœud avant d'y être et vise déjà le suivant — donc traverse la
		// paroi. Borné aussi par la largeur du tunnel.
		nodes.push( {
			x: c.x, y: c.y, r: Math.min( c.R * 0.5, tunnelW + 2 ),
			layer: c.layer, type: c.type, depth: c.depth,
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
		K, depthMax, units: U, parents: PAR,
		nodes, edges, nextHop, GOAL_NODE,
		troughs, field, depthAt,
		origin: { x: ox, y: oy },
		radiusTexels: radius,
		radiusWorld: radius * TEXEL,
		shaft, entry,
	};

}

// CROISSANCE : creuse les loges [Kold, Knew) DANS le champ existant. C'est tout
// l'intérêt du registre append-only — on n'efface et ne recalcule jamais rien.
export function growNest( nest, Knew, tunnelW ) {

	const { origin: { x: ox, y: oy }, field, units: U, parents: PAR } = nest;

	for ( let k = nest.K; k < Knew; k ++ ) {

		const c = U[ k ];
		const p = PAR[ k ] < 0 ? nest.shaft : U[ PAR[ k ] ];
		carveTube( field, ox, oy, p, c, tunnelW, c.layer );
		carveDisc( field, ox, oy, c.x, c.y, c.R, c.depth, c.layer );

	}

	return Knew;

}

// paramètres courants dérivés de l'UI
export function nestParams() {

	return {
		K: quantK( nestBudget( params.antCount, params.nestScale ) ),
		depthMax: params.nestDepth,
		tunnelW: params.nestTunnelW,
	};

}
