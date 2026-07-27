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

// Le registre final est un arbre de croissance bake. Les validations d'authoring
// peuvent être aussi exhaustives que nécessaire, mais le jeu ne lit que 96 fiches
// immuables : aucune recherche de placement n'arrive dans la boucle de frame.
const GOLD = 2.399963229728653;
export const NEST_LAYOUT_VERSION = 'natural-growth-tree-v2';
export const NEST_ROLE = Object.freeze( {
	TRANSIT: 0,
	CHAMBER: 1,
	FUNCTIONAL: 2,
} );
export const MAX_NEST_DEPTH_DRIFT_WORLD = 0;
export const ENTRANCE_PORTAL_OFFSET_WORLD = 11;
export const ENTRANCE_PORTAL_ANGLE_RAD = 230 * Math.PI / 180;
export const ENTRANCE_CONNECTOR_BULGE_WORLD = 3;
// Trois raccords courts réduisent leur sinuosité pour préserver leurs cols physiques.
const CORRIDOR_CURVATURE_SCALE_OVERRIDE = new Map( [ [ 3, 0 ], [ 14, 0.72 ], [ 25, 0.55 ] ] );
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
// MORPHOLOGIE ET REGISTRE DE CROISSANCE
// ---------------------------------------------------------------------------
// Les quatre premières fiches garantissent immédiatement les fonctions vitales.
// Les suivantes ne sont plus regroupées en « étages de quatre » : chacune est
// une pousse indépendante d'un arbre continu, comme dans le registre historique
// 2efd1f6, mais validée contre les volumes physiques modernes.
const FOUNDING_TYPES = [ ROOM.GARDE, ROOM.GRENIER, ROOM.CRECHE, ROOM.ROYALE ];

// budget de loges : loi d'échelle des nids réels (le volume creusé croît comme
// la racine carrée de la population, exposant mesuré ~0,5 sur plusieurs espèces)
export function nestBudget( W, scale = 1 ) {

	const K = Math.round( 24 * Math.sqrt( Math.max( 1, W ) / 869 ) * scale );
	return Math.min( K_MAX, Math.max( LAYERS, K ) );

}

// quantification : la croissance active un préfixe immuable par paquets de 4,
// mais ces quatre nouvelles loges appartiennent à des rameaux différents.
export const quantK = ( K ) => Math.max( LAYERS, Math.round( K / LAYERS ) * LAYERS );

function organicHash( value ) {

	let hash = ( value ^ 0x9e3779b9 ) >>> 0;
	hash = Math.imul( hash ^ ( hash >>> 16 ), 0x21f0aaad ) >>> 0;
	hash = Math.imul( hash ^ ( hash >>> 15 ), 0x735a2d97 ) >>> 0;
	return ( ( hash ^ ( hash >>> 15 ) ) >>> 0 ) / 0x100000000;

}

function naturalLevel( depthFraction ) {

	if ( depthFraction < 0.27 ) return 0;
	if ( depthFraction < 0.51 ) return 1;
	if ( depthFraction < 0.75 ) return 2;
	return 3;

}

function morphologyOf( k, depthMax, record ) {

	if ( ! record ) throw new RangeError( `Missing natural registry record ${ k }` );
	const role = record.role;
	const h0 = organicHash( k * 401 + 17 );
	const h1 = organicHash( k * 613 + 29 );
	const h2 = organicHash( k * 887 + 43 );
	let base, rh;
	if ( role === NEST_ROLE.TRANSIT ) {

		base = 1.55 + 0.48 * h0;
		rh = 0.58 + 0.22 * h2;

	} else if ( role === NEST_ROLE.FUNCTIONAL ) {

		const functionalRadius = [ 2.9, 3.55, 3.35, 4.15 ];
		base = functionalRadius[ k ] ?? 3.45;
		rh = 0.88 + 0.24 * h2;

	} else {

		base = 2.45 + 1.15 * h0;
		rh = 0.74 + 0.30 * h2;

	}
	const rwx = base * ( 0.82 + 0.32 * h1 );
	const rwz = base * ( 0.82 + 0.32 * organicHash( k * 977 + 61 ) );
	const unclampedDepth = - depthMax * record.depthFraction;
	const depth = Math.min( unclampedDepth, - ( rh * 2 + 0.68 ) );
	const level = naturalLevel( Math.abs( depth ) / depthMax );
	return { role, rwx, rwz, rh, depth, level };

}

function roomTypeOf( k, level, role ) {

	if ( k < FOUNDING_TYPES.length ) return FOUNDING_TYPES[ k ];
	if ( role === NEST_ROLE.TRANSIT ) return ROOM.TUNNEL;
	const rooms = LEVEL[ level ].rooms;
	return rooms[ Math.floor( organicHash( k * 1093 + 79 ) * rooms.length ) % rooms.length ];

}

function naturalChamberYaw( k, record ) {

	// Une lentille est orientée selon l'axe principal de ses VRAIS corridors
	// incidents. Les directions sont moyennées modulo PI : l'entrée et la sortie
	// d'une même branche renforcent le même axe au lieu de s'annuler.
	const neighbours = [];
	if ( record.parent >= 0 ) neighbours.push( NATURAL_REGISTRY[ record.parent ] );
	for ( let child = k + 1; child < NATURAL_REGISTRY.length; child ++ )
		if ( NATURAL_REGISTRY[ child ].parent === k ) neighbours.push( NATURAL_REGISTRY[ child ] );
	if ( neighbours.length === 0 ) return GOLD * ( k + 1 );
	let doubledX = 0, doubledY = 0;
	for ( const neighbour of neighbours ) {

		const angle = Math.atan2( neighbour.z - record.z, neighbour.x - record.x );
		doubledX += Math.cos( angle * 2 );
		doubledY += Math.sin( angle * 2 );

	}
	return Math.atan2( doubledY, doubledX ) * 0.5
		+ ( organicHash( k * 1237 + 97 ) - 0.5 ) * 0.10;

}
// La fiche pure : placement, parent et détour proviennent du bake versionné ;
// les dimensions restent dérivées de k pour garder une donnée compacte.
export function nestUnit( k, depthMax ) {

	if ( ! Number.isInteger( k ) || k < 0 || k >= K_MAX )
		throw new RangeError( `Invalid chamber index ${ k }` );
	const record = NATURAL_REGISTRY[ k ];
	const morphology = morphologyOf( k, depthMax, record );
	const chamberYaw = naturalChamberYaw( k, record );
	return {
		k, q: k, level: morphology.level, layer: morphology.level,
		role: record.role,
		R: ( ( morphology.rwx + morphology.rwz ) * 0.5 ) / TEXEL,
		rwx: morphology.rwx, rwz: morphology.rwz, rh: morphology.rh,
		chamberYaw,
		chamberBalance: 0.18 + 0.64 * organicHash( k * 1291 + 101 ),
		organicRoute: record.route,
		x: NEST.x + record.x / TEXEL,
		y: NEST.y + record.z / TEXEL,
		depth: morphology.depth,
		type: roomTypeOf( k, morphology.level, record.role ),
	};

}

// Lecture O(1) du parent bake. Un parent est toujours antérieur : activer un
// préfixe plus grand n'altère aucun corridor déjà utilisé par une fourmi.
export function parentOf( k ) {

	if ( ! Number.isInteger( k ) || k < 0 || k >= K_MAX )
		throw new RangeError( `Invalid chamber index ${ k }` );
	const parent = NATURAL_REGISTRY[ k ].parent;
	if ( parent < - 1 || parent >= k )
		throw new Error( `Invalid baked parent ${ parent } for chamber ${ k }` );
	return parent;

}
// Registre final revu hors ligne : [ x, z, profondeur, rôle, parent, détour X, détour Y ].
// Les détours ne changent ni le nombre d'échantillons ni le coût par fourmi.
const BAKED_NATURAL_DATA = Object.freeze( [
	[ 0, 0, 0.15, 2, -1, 0, 0 ],
	[ 13, 4, 0.38, 2, 0, 0, 0 ],
	[ 0.8, -2.6, 0.66, 2, 1, 0, 0 ],
	[ -2, 10, 0.94, 2, 2, -2.75, 0 ],
	[ -15.359085394894572, 2.6253354265682596, 0.26310169612038881, 1, 0, 0, 0 ],
	[ 7.8931319670432156, 15.408521412358128, 0.35012083290591833, 0, 1, 0, 0 ],
	[ 6.1862658830064321, -17.385306887458597, 0.720196293396689, 1, 2, 0, 0 ],
	[ 9.0708280157003554, 9.6124062363399236, 0.90178408125970644, 1, 3, -1.25, 0 ],
	[ 18.792794087440821, 1.06600765456735, 0.924400083585456, 0, 3, -0.75, 0 ],
	[ -31.943368990763773, 7.2337820021672128, 0.3407055510283783, 1, 4, 0, 0 ],
	[ 11.445530980136621, 26.236844773876751, 0.3103258719640653, 1, 5, -2, 0 ],
	[ 11.91910130965675, -31.977544119132219, 0.815382692777073, 1, 6, 0, 0.25 ],
	[ 14.611008676495745, 16.287787645953038, 0.93858278055810518, 1, 7, 0, 0 ],
	[ 29.93347860711949, -0.15229870249809108, 0.89083879877881711, 0, 8, 0, 0 ],
	[ -13, -12, 0.33821289044767616, 0, 4, 0, 0 ],
	[ -2.1139781246710729, 27.528963359763353, 0.44974300174936649, 0, 5, 0, 0 ],
	[ -1.8853716160170153, -28.329870591549192, 0.84254471355546268, 0, 6, 3, 0 ],
	[ 6.0574256294111413, 25.672302588412855, 0.85358240954183184, 1, 7, 0, 0 ],
	[ 31.41919266454839, -8.3133020144175767, 0.93277297091345324, 1, 8, 0, 0 ],
	[ -43.512970478733308, 7.8113482246759265, 0.42477648743107976, 1, 9, 0, 0 ],
	[ 11.313398289288168, 33.5588742342877, 0.28038645212088215, 1, 10, 0, 0 ],
	[ 16.394049552904356, -44.308973748917218, 0.87733902144155718, 1, 11, 0, 0 ],
	[ 25.247147020710617, 26.906883748246031, 0.96450056044158738, 1, 12, 0, 0 ],
	[ 37.716685628969742, -1.0310883480638693, 0.85403392046788973, 1, 13, 0, 0 ],
	[ -26.793118179520356, 2.8725566362984116, 0.54320627638407193, 1, 19, 0, -1 ],
	[ -8.15851698047678, 33.730409665892182, 0.4833605500933118, 0, 15, 0, 0 ],
	[ -30.158725242135873, -7.4692789356304186, 0.39345960133302582, 0, 14, 0, 0 ],
	[ -41.109079921153906, -15.37599286326245, 0.49527387950975887, 0, 26, 0, 0 ],
	[ 22.936544174683078, -35.500151068271592, 0.78722945608690931, 1, 11, 0, 0 ],
	[ -33.629566015572628, -13.249493553600235, 0.54772815598924052, 0, 27, 0, 0 ],
	[ -13.925837758331449, 29.861520327777026, 0.49587097951155151, 0, 15, 6.25, 2 ],
	[ -43.444048712446588, 1.1822556258581542, 0.50387714813969653, 0, 26, 0, 0 ],
	[ 6.17645503571044, 42.65578922668638, 0.44492301349703778, 0, 10, 6, 0 ],
	[ -28.413350237139909, -8.8684542553347434, 0.63604807323232726, 1, 27, 4, -2.5 ],
	[ 11.109095956932681, 23.519277926206328, 0.95382388216559921, 0, 12, 0, 0 ],
	[ -17.283091849802975, 36.558335546837128, 0.56294063359255786, 0, 25, 0, 0 ],
	[ 39.264396454402082, -12.143330375183661, 0.863982104235828, 1, 13, 0, 2.5 ],
	[ -42.834536572581783, -4.085682879704529, 0.27316958810941872, 1, 9, 0, 0 ],
	[ -27.173857292229759, 32.230794806081143, 0.50253366460244731, 0, 30, 0.25, 0 ],
	[ 13.543551441158174, 43.860204729005417, 0.27584552113656474, 1, 20, 0, 0 ],
	[ -26.721450226353667, 39.036788718720693, 0.59151532788345218, 1, 30, 0, 0 ],
	[ 17.670778385586949, 39.102526124275371, 0.30360570564397116, 0, 20, 0, 0 ],
	[ 3.609551613949324, 33.613626275393337, 0.58102130260576679, 1, 32, 0, 0 ],
	[ -14.580594813638342, 1.3532677437590328, 0.60872154314821436, 0, 24, 0, 0 ],
	[ 5.1799627159847459, 25.4367488361199, 0.51892914063919893, 0, 32, 0, 2.5 ],
	[ -13.591556140601844, -35.209163147479146, 0.959587542654154, 0, 16, 0, 0 ],
	[ -20.498982059899031, 27.55035995184349, 0.696228610154024, 0, 40, 2, 0 ],
	[ -16.571092185027211, -29.488995325693047, 0.84161846344303337, 0, 16, 0, 0 ],
	[ -21.34593966995428, 21.19372849473028, 0.51370343108412064, 1, 38, 0, 0 ],
	[ -18.108261145943544, -4.5075237899227059, 0.78622786823567059, 0, 33, 0, 0 ],
	[ 9.7820726887990581, 8.7913008536641861, 0.59941418867080654, 0, 44, 4, 0 ],
	[ -11.326010550435315, 26.022629699218996, 0.68110119201174579, 1, 25, 2, 0 ],
	[ 40.014481764742825, -20.751341953993855, 0.96164276573755259, 1, 18, -2, 0 ],
	[ -26.265748362307352, -1.4666538687068034, 0.72592526500482546, 1, 33, 0, 0 ],
	[ -24.36766759639271, -32.055849987425752, 0.83742680662426716, 0, 47, 0, 0 ],
	[ -26.663477353056308, -37.142188985088232, 0.89293666892959789, 0, 45, 0, 0 ],
	[ -22.886087036078852, -21.60997518232173, 0.93048521036673337, 0, 47, 0, 0 ],
	[ -19.415716014204751, -15.856755096976419, 0.81464153051192922, 0, 54, 0, 5 ],
	[ 10.475801882593778, 42.382184092121378, 0.82584146047066664, 0, 17, 0, 0 ],
	[ -20.55463879455327, 3.6665290721569095, 0.85047265468011668, 0, 53, -2, 0 ],
	[ 14.855566008208362, -36.261810373885048, 0.966290828824792, 0, 21, 0, 0 ],
	[ 24.831204133913221, -14.003158115369022, 0.91744405569628884, 1, 52, 0, 0 ],
	[ 17.510792532805738, -22.09935874791617, 0.83482380603511985, 0, 28, 0, 0 ],
	[ -13.927349381524843, 10.344396989831823, 0.5643682997969619, 0, 48, 0, 0 ],
	[ 15.852829116321391, 31.047866006489297, 0.28776978402617454, 0, 41, 2, 0 ],
	[ -2.6918186194021434, 3.6120726624113138, 0.63789233484048435, 1, 43, 0, 0 ],
	[ -25.294890627296045, 10.03967612823473, 0.60568908956099488, 0, 48, 0, 0 ],
	[ -12.873311041512078, -18.856693196401679, 0.81962665724664541, 0, 54, 4, 2.5 ],
	[ -14.517343126346864, 20.355965706320816, 0.7915461082314762, 0, 46, 0, 0 ],
	[ 12.873323485657512, -7.2693735883475323, 0.93309593732041718, 1, 62, 0, 0 ],
	[ 9.3046727535495073, 1.0130191711812255, 0.65369453114868947, 0, 50, 0, 0 ],
	[ -8.3006771140254649, 19.83536563184844, 0.63418556254596137, 0, 46, -1.25, 0 ],
	[ 3.0752410914333357, 12.110935641485591, 0.72588894977868079, 1, 65, 0, 0 ],
	[ -0.42212872561292336, 19.245952718604229, 0.75822553175574392, 0, 51, 2, 0 ],
	[ -33.101826486201709, 2.5787480409631378, 0.803455301992376, 0, 53, 0, 0 ],
	[ 15.030004829223325, 16.99242241794337, 0.25941017921099574, 0, 64, 6, 2.5 ],
	[ 8.7101614468670245, -20.354765165179991, 0.928293016995836, 0, 62, 0, 0 ],
	[ -31.964760493090282, -14.924655126689045, 0.95006679026551222, 1, 56, 0, 0 ],
	[ -2.7651753315703687, -4.3980076205917893, 0.91485085611870076, 1, 49, 0, 0 ],
	[ -40.21663381858373, 5.64022345333697, 0.80524232051372591, 1, 74, 0, 0 ],
	[ -32.368429988058864, 12.793701550418646, 0.76238777283445436, 1, 74, 0, 0 ],
	[ -6.4166932914271779, -11.548658655914309, 0.73267598105482812, 0, 49, 0, 0 ],
	[ -17.028447768527556, 10.334339633150574, 0.91108399078666358, 0, 59, 0, 0 ],
	[ -27.251259905765135, 19.177175502643809, 0.91896937038111559, 0, 59, 0, 0 ],
	[ -6.5711307439689293, 9.2812649347893554, 0.66960764027272446, 0, 63, 0, 0 ],
	[ -1.9084431220641369, 27.8963118778408, 0.78868286188791392, 1, 72, -2.25, 2.25 ],
	[ 0.2382294403029519, -11.371883459032681, 0.81181977101938974, 0, 67, -2, 0 ],
	[ -2.162595431765217, -22.764094463562071, 0.955855027762146, 0, 76, 2, -2.5 ],
	[ 7.0959260540241278, -7.6040054428090862, 0.758354955683344, 0, 70, 0, 0 ],
	[ -23.522892616620961, -11.565884752053572, 0.90442759694438424, 1, 56, 2, 0 ],
	[ 19.344080881478927, -8.8077151168607468, 0.9455605521079532, 1, 61, 1, 0 ],
	[ 7.1767184891933029, -31.496264830733111, 0.96390178606240839, 1, 76, -0.25, 0 ],
	[ -4.9011139041038518, -14.246032219129454, 0.96299320487849038, 1, 67, 0, 0 ],
	[ -36.310782789466273, -9.0429766457605911, 0.95880031005378, 0, 77, 0, 0 ],
	[ -13.226058966617956, -23.546717680412225, 0.95931678997218517, 0, 87, 0, 0 ],
	[ -1.0853761291666926, 38.589870514255246, 0.80493634556543625, 1, 85, 0, 0 ],
] );
export const BAKED_NATURAL_REGISTRY = Object.freeze( BAKED_NATURAL_DATA.map(
	( [ x, z, depthFraction, role, parent, lateralBulgeWorld, verticalBulgeWorld ], k ) => Object.freeze( {
		x, z, depthFraction, role, parent,
		route: k === 0 ? null : Object.freeze( { lateralBulgeWorld, verticalBulgeWorld } ),
	} ),
) );
if ( BAKED_NATURAL_REGISTRY.length !== K_MAX )
	throw new Error( 'Natural registry must contain exactly ' + K_MAX + ' records' );
const NATURAL_REGISTRY = BAKED_NATURAL_REGISTRY;
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
	const chordWorld = chord * TEXEL;
	const freeSpanScale = Math.max( 0.24, Math.min( 1, ( chordWorld - 6 ) / 8 ) );
	const amplitude = ( 0.64 + 0.48 * vdc( seed + 1, 7 ) )
		* curvatureScale * freeSpanScale / TEXEL;
	const collisionAvoidance = ( route.lateralBulgeWorld ?? 0 ) / TEXEL;
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
