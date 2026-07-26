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
// Rayon visuel = largeur * TEXEL * 0,85. 5,5 garantit l'enveloppe de la
// plus grosse caste (soldate) + 5 cm de marge, même voie latérale incluse.
export const MIN_TUNNEL_WIDTH = 5.5;
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

// pente maximale d'un tunnel (dz / distance horizontale). 0,42 ~ 23 degres :
// au-dela, une descente se lit comme une falaise et non comme un couloir.
const MAX_SLOPE = 0.50;

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

	// demi-axes de la lentille : varies mais deterministes, et ANISOTROPES
	// (une chambre reelle n'est jamais un disque parfait)
	const g = 0.78 + 0.44 * vdc( k + 1, 5 );
	const rwx = L.rw * g * ( 0.85 + 0.30 * vdc( k + 1, 11 ) );
	const rwz = L.rw * g * ( 0.85 + 0.30 * vdc( k + 2, 11 ) );
	const R = ( ( rwx + rwz ) * 0.5 ) / TEXEL;      // rayon equivalent, en texels

	// PLACEMENT ETALE. Les loges etaient auparavant empilees en colonnes quasi
	// verticales : leurs tunnels n'avaient alors aucune distance horizontale a
	// jouer, d'ou des rampes a 50 degres. Elles sont maintenant dispersees a
	// TOUS les niveaux, sur un disque a peine plus etroit en profondeur. Un
	// tunnel dispose ainsi d'une dizaine d'unites d'elan pour descendre de cinq,
	// ce qui donne des pentes douces — et un nid plus large que profond, comme
	// une vraie coupe.
	// L'angle est tire de k (et non de q) : la couverture angulaire reste bonne
	// pour n'importe quel prefixe du registre.
	const r = ( L.spread / TEXEL ) * ( 0.30 + 0.70 * vdc( k + 1, 3 ) );
	const th = GOLD * ( k + 1 ) + 0.7 * ( vdc( k + 1, 2 ) - 0.5 );

	// profondeur : le niveau donne la strate, un léger décalage par loge évite
	// que tout un étage soit rigoureusement plan
	const depth = - depthMax * L.zf * ( 0.94 + 0.12 * vdc( k + 1, 7 ) );

	return {
		k, q, level: s, layer: s,
		R,                                          // rayon equivalent (texels)
		rwx, rwz, rh: L.rh * g,                     // demi-axes de la lentille (monde)
		x: NEST.x + Math.cos( th ) * r,
		y: NEST.y + Math.sin( th ) * r,
		depth,
		type: L.rooms[ q % L.rooms.length ],
	};

}

// parent : le niveau du dessus DE LA MÊME SÉRIE ; pour une tête de série, la
// loge de niveau 0 déjà émise la plus proche. Ne regarde JAMAIS que j < k, ce
// qui rend la structure append-only.
// PARENT : la loge du niveau juste au-dessus dont la distance horizontale est
// la plus PROCHE DE L'IDEAL — pas la plus proche tout court. L'ideal est la
// distance qu'il faut pour descendre le denivele a MAX_SLOPE. Choisir le voisin
// le plus proche donnerait systematiquement les tunnels les plus raides ;
// choisir a la bonne distance donne des couloirs qui descendent en pente douce.
// Ne regarde JAMAIS que j < k : la structure reste append-only.
export function parentOf( k, U ) {

	const c = U[ k ];
	if ( c.level === 0 ) return - 1;              // -1 = rattache au puits d'entree

	const dz = Math.abs( c.depth );
	let best = - 1, bs = Infinity;

	for ( let j = 0; j < k; j ++ ) {

		if ( U[ j ].level !== c.level - 1 ) continue;
		const d = Math.hypot( U[ j ].x - c.x, U[ j ].y - c.y );
		const ideal = Math.abs( c.depth - U[ j ].depth ) / ( MAX_SLOPE * TEXEL );
		// on penalise surtout le TROP COURT (pente raide) ; trop long est benin
		const score = d < ideal ? ( ideal - d ) * 2 : ( d - ideal );
		if ( score < bs ) { bs = score; best = j; }

	}

	return best;

}

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
export function tunnelPath( a, b, seed, steps = 10 ) {

	const dx = b.x - a.x, dy = b.y - a.y;
	const chord = Math.hypot( dx, dy ) || 1e-3;
	const dz = b.depth - a.depth;
	const nx = - dy / chord, ny = dx / chord;
	const mx = ( a.x + b.x ) / 2, my = ( a.y + b.y ) / 2;

	// PROFIL DE DESCENTE, PARAMETRE PAR LA LONGUEUR D'ARC.
	// Le parametrer par t etait une impasse : la vitesse horizontale d'une
	// Bezier quadratique en son milieu vaut EXACTEMENT la corde, quel que soit
	// le bombement (B'(1/2) = B - A). Bomber n'y ralentit donc jamais la
	// descente — et c'est precisement la que le profil en S plongeait le plus.
	// La dichotomie ne pouvait pas converger : elle saturait son plafond en
	// laissant la moitie des tunnels a 40 degres. Repartie sur la longueur
	// reelle, la pente devient quasi constante et le bombement la reduit
	// effectivement.
	// L'assouplissement final ne pese plus que 1,125 au milieu (contre 1,25),
	// assez pour deboucher a plat dans les chambres sans creuser d'a-pic.
	const ease = ( u ) => 0.75 * u + 0.25 * u * u * ( 3 - 2 * u );

	const at = ( bulge, t ) => {

		const u = 1 - t;
		const px = mx + nx * bulge, py = my + ny * bulge;
		return {
			x: u * u * a.x + 2 * u * t * px + t * t * b.x,
			y: u * u * a.y + 2 * u * t * py + t * t * b.y,
		};

	};

	const NS = 48;

	const arcTable = ( bulge ) => {

		const q = [], cum = [ 0 ];
		for ( let i = 0; i <= NS; i ++ ) q.push( at( bulge, i / NS ) );
		for ( let i = 1; i <= NS; i ++ )
			cum.push( cum[ i - 1 ] + Math.hypot( q[ i ].x - q[ i - 1 ].x, q[ i ].y - q[ i - 1 ].y ) );
		return { cum, L: Math.max( cum[ NS ], 1e-6 ) };

	};

	const worstSlope = ( bulge ) => {

		const { cum, L } = arcTable( bulge );
		let w = 0;
		for ( let i = 1; i <= NS; i ++ ) {

			const h = ( cum[ i ] - cum[ i - 1 ] ) * TEXEL;
			const dd = Math.abs( dz ) * ( ease( cum[ i ] / L ) - ease( cum[ i - 1 ] / L ) );
			w = Math.max( w, dd / Math.max( h, 1e-6 ) );

		}
		return w;

	};

	let bulge = 0;

	if ( worstSlope( 0 ) > MAX_SLOPE ) {

		// Le bombement reste PLAFONNE. Sans plafond la dichotomie trouve toujours
		// une solution, au prix de tunnels qui s'echappent a deux fois le rayon du
		// nid (mesure : 42 unites pour un nid de 20).
		let lo = 0, hi = chord * 1.25;
		if ( worstSlope( hi ) <= MAX_SLOPE ) {

			for ( let i = 0; i < 22; i ++ ) {

				const m = ( lo + hi ) / 2;
				if ( worstSlope( m ) > MAX_SLOPE ) lo = m; else hi = m;

			}

		}
		bulge = hi;

	}

	// le cote du bombement alterne : deux tunnels partant du meme puits ne se
	// superposent pas, et le nid prend son allure de colimacon
	bulge *= vdc( seed + 1, 2 ) < 0.5 ? 1 : - 1;

	// sinuosite residuelle. Le facteur sin(pi t) l'ANNULE aux deux bouts : sans
	// lui le chemin arrivait jusqu'a huit texels a cote de sa chambre.
	const wig = 0.10 + 0.10 * vdc( seed + 1, 7 );
	const { cum, L } = arcTable( bulge );
	const pts = [];

	for ( let i = 0; i <= steps; i ++ ) {

		const t = i / steps;
		const q = at( bulge, t );

		// abscisse curviligne au parametre t, lue dans la table cumulative
		const f = t * NS, j = Math.min( NS - 1, Math.floor( f ) );
		const sigma = ( cum[ j ] + ( cum[ j + 1 ] - cum[ j ] ) * ( f - j ) ) / L;

		const w = Math.sin( t * Math.PI * 3 + seed ) * chord * wig * 0.12 * Math.sin( t * Math.PI );
		pts.push( { x: q.x + nx * w, y: q.y + ny * w, depth: a.depth + dz * ease( sigma ) } );

	}

	return pts;

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
	tunnelW = Math.max( MIN_TUNNEL_WIDTH, tunnelW );

	const ox = Math.round( NEST.x - DEPTH_SIZE / 2 );
	const oy = Math.round( NEST.y - DEPTH_SIZE / 2 );
	const field = carve ? new Float32Array( DEPTH_SIZE * DEPTH_SIZE * 4 ) : null;

	const U = [];
	for ( let k = 0; k < K_MAX; k ++ ) U.push( nestUnit( k, depthMax ) );
	const PAR = [];
	for ( let k = 0; k < K_MAX; k ++ ) PAR.push( parentOf( k, U ) );

	// pied du puits : juste sous l'entrée, à la profondeur du premier niveau
	const shaftAngle = HELIX_TURN * 0.5;
	const shaft = {
		x: NEST.x + Math.cos( shaftAngle ) * HELIX_R / TEXEL,
		y: NEST.y + Math.sin( shaftAngle ) * HELIX_R / TEXEL,
		depth: - depthMax * LEVEL[ 0 ].zf * 0.45,
		layer: 0,
	};
	const entry = { x: NEST.x, y: NEST.y, depth: - 0.04, layer: 0 };

	// --- creusage du préfixe actif ---
	if ( carve ) {

		carvePath( field, ox, oy, tunnelPath( entry, shaft, K_MAX + 0x51 ), tunnelW * 1.15, 0 );

		for ( let k = 0; k < K; k ++ ) {

			const c = U[ k ];
			const p = PAR[ k ] < 0 ? shaft : U[ PAR[ k ] ];
			carvePath( field, ox, oy, tunnelPath( p, c, k ), tunnelW, c.layer );
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
		const path = tunnelPath( par, c, k );
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
		carvePath( field, ox, oy, tunnelPath( p, c, k ), tunnelW, c.layer );
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
