// Constantes de la simulation, paramètres réglables et persistance.
// Les réglages sauvegardés (localStorage) sont fusionnés au chargement ;
// la taille de la carte ne s'applique qu'au rechargement de la page.

const STORAGE_KEY = 'antsystem-settings-v1';

function loadSaved() {

	try {

		return JSON.parse( localStorage.getItem( STORAGE_KEY ) ) || null;

	} catch {

		return null;

	}

}

const saved = loadSaved();

export const GRID = 1024;              // résolution de la grille (texels)
export const WORLD = ( saved && saved.gfx && saved.gfx.mapSize ) || 160; // unités monde (au rechargement)
export const TEXEL = WORLD / GRID;
export const MAX_ANTS = 65536;
export const MAX_SPIDERS = 1024;       // prédateurs simultanés (VAT instancié)
export const MAX_BROOD = 4096;         // œufs/larves/nymphes simultanés (kernel couvain)
export const FIXED = 1024;             // échelle virgule fixe des dépôts u32

// Castes (dérivées d'un hash stable par fourmi — zéro stockage GPU).
// L'index 0 est TOUJOURS la reine quand la colonie est active.
export const CASTE = { WORKER: 0, SOLDIER: 1, NURSE: 2, SCOUT: 3, QUEEN: 4 };

export const NEST = {
	x: GRID / 2,
	y: GRID / 2,
	radius: 20,                        // texels
};

// Paramètres de simulation (défauts calibrés en jeu)
export const params = {
	// Colonie
	antCount: 869,                     // clin d'œil à la vidéo
	simSpeed: 1,
	paused: false,

	// Comportement — config « D » validée au banc d'essai :
	// 51 % de taux de retour à 300 s (contre 9 % pour l'ancien réglage)
	moveSpeed: 15,
	steerStrength: 8,
	wanderStrength: 1.0,
	sensorAngleDeg: 30,
	sensorDist: 12,

	// Phéromones : sémantique de fraîcheur (atomicMax) → évaporation lente
	// sans saturation ; la diffusion reste douce (elle érode les pistes fines)
	depositRate: 12,
	fade: 0.025,                       // k du fondu exp(-k·temps_depuis_source)
	evaporation: 0.012,                // décroissance linéaire par seconde
	diffusion: 0.25,

	// Outils — le pinceau ne s'active qu'en « mode pinceau » (les murs ne
	// sont visibles que dans ce mode ou dans l'éditeur)
	brushMode: false,
	tool: 'nourriture',                // 'nourriture' | 'mur' | 'gomme'
	brushRadius: 10,                   // texels
	foodAmount: 1,                     // unités par bille : 1 = prise → disparue

	// Prédateurs et défense
	spiderCount: 1,                    // araignées (0 = désactivé, jusqu'à MAX_SPIDERS)
	spiderAggro: 0.5,                  // agressivité (détection, vitesse, cadence)
	soldierRatio: 0.12,                // part de soldates (chargent au lieu de fuir)
	fleeRadius: 35,                    // rayon de peur des fourmis (texels)

	// Colonie vivante : castes, énergie, reine, couvain (tout GPU)
	colony: true,                      // maître : false = comportement historique (livraison instantanée, pas de souterrain)
	nurseRatio: 0.14,                  // part de nourrices (restent sous terre, navette nourriture)
	scoutRatio: 0.10,                  // part d'éclaireuses (errance forte, suivent peu les pistes)
	scoutWander: 2.2,                  // multiplicateur d'errance des éclaireuses
	scoutTrailFollow: 0.35,            // poids des pistes existantes pour une éclaireuse (× normal)
	scoutSpeedMult: 1.1,               // vitesse éclaireuse (× vitesse normale)
	soldierSpeedMult: 0.85,            // vitesse soldate (plus grosse, plus lente)
	energyLife: 600,                   // s d'autonomie d'une fourmi (énergie pleine → 0 = mort de faim)
	eatThreshold: 0.45,                // sous ce niveau, une fourmi mange si elle trouve à manger
	hungryHome: 0.25,                  // sous ce niveau, elle rentre au nid manger au grenier
	queenEnergyLife: 300,              // s d'autonomie de la reine (elle doit être nourrie)
	queenMealValue: 0.4,               // énergie rendue par unité de nourriture mangée par la reine
	queenLayInterval: 10,              // s entre deux pontes (si assez d'énergie)
	queenLayCost: 0.1,                 // énergie dépensée par ponte
	queenLayMin: 0.5,                  // énergie minimale pour pondre
	eggDuration: 25,                   // s œuf → larve
	larvaMeals: 2,                     // unités de nourriture pour qu'une larve devienne nymphe
	larvaMealEvery: 20,                // s entre deux repas de larve
	larvaStarveTime: 90,               // s sans repas → la larve meurt
	pupaDuration: 20,                  // s nymphe → éclosion (nouvelle fourmi)
	maxPopulation: 3000,               // plafond de population (éclosions bloquées au-delà)
	granaryStart: 80,                  // stock de départ du grenier (survie le temps du 1er fourragement)
	foodRegen: 3,                      // gisements régénérés par minute (0 = économie fermée → famine)

	// Prédation (calibrée sur la biologie : morsure → envenimation graduée →
	// paralysie croissante → mort après quelques morsures → dévoration)
	spiderSpeed: 8,                    // vitesse de pointe de l'araignée (unités monde/s)
	spiderWalkAnim: 1.4,               // calibrage anim araignée (rapport foulée/vitesse)
	spiderFOV: 120,                    // champ de vision (degrés, cône vers l'avant)
	spiderVision: 45,                  // portée de détection (unités monde)
	bodyRadius: 1.1,                   // rayon du CORPS de l'araignée (hitbox de morsure — « sur » la fourmi)
	antRadius: 0.45,                   // rayon du corps de la fourmi (hitbox)
	bitesToKill: 2,                    // morsures cumulées avant la mort (2-3)
	biteInterval: 0.55,                // s entre deux morsures d'une même araignée
	paralysisFactor: 0.35,             // vitesse d'une fourmi après 1 morsure (× vitesse normale)
	venomRecovery: 0.25,               // dissipation du venin /s (guérison si l'araignée décroche)
	eatDuration: 3.0,                  // s de dévoration (araignée immobile) avant disparition du cadavre
	alarmFleeThreshold: 0.45,          // pression d'alarme locale qui fait fuir l'araignée (0..1)
	alarmWait: 6.0,                    // s d'attente à distance avant de retenter

	// ------------------------------------------------------------------
	// PHYSIQUE (mode physique : vraies vitesses, vraies forces, vrais impacts)
	// `physics: false` = chemin historique EXACT (déplacement cinématique
	// `pos += dir·v·dt`, phase de marche globale, cadavre plaqué sur le dos) :
	// c'est le témoin de comparaison des performances.
	// ------------------------------------------------------------------
	physics: true,
	// gravité de JEU, PAS la gravité physique. À l'échelle fourmi (1 unité monde
	// ≈ 1 cm) g vaut ~930 u/s² : une chute de 0,25 u durerait 1,5 frame, donc
	// serait strictement invisible. 45 u/s² donne une chute lisible en ~6 frames.
	// NE PAS « corriger » vers la valeur physique exacte.
	gravity: 45,
	antAccel: 14,                      // /s : raideur du contrôle musculaire (inertie)
	groundDrag: 3.2,                   // /s : friction du sol sur une fourmi qui glisse
	airDrag: 0.5,                      // /s : traînée en vol (insecte = très léger)
	restitution: 0.32,                 // rebond au contact du sol
	wallBounce: 0.45,                  // restitution sur un mur (impact réel)
	biteKnockback: 7,                   // u/s : SECOUSSE latérale encaissée à chaque morsure
	bitePop: 1.6,                       // u/s : composante verticale du coup
	landShock: 15,                      // u/s : onde de choc quand une araignée retombe de son bond
	deathPop: 2.7,                      // u/s : impulsion verticale à la mort (culbute)
	deathFling: 2.5,                      // u/s : projection horizontale à la mort
	chargeImpulse: 3.5,                 // u/s : recul de la soldate qui percute l'araignée
	spiderKnockback: 2.6,               // u/s : recul de l'araignée sous les morsures

	// Affichage
	trailIntensity: 1.0,
	shadows: true,
	// calibrage animation : rapport entre fréquence de foulée et vitesse
	walkAnim: 1.0,
	cinematic: false,
};

// Paramètres graphiques
export const gfx = {
	// Carte (mapSize appliqué au rechargement)
	mapSize: 160,
	groundThickness: 3,

	// Herbe : disque continu de brins centré sur la caméra
	grass: true,
	grassDensity: 40,
	grassHeight: 0.55,
	grassWidth: 0.85,
	grassRadius: 45,
	grassWind: 1.0,
	grassChaos: 0.0,                   // irrégularité des brins (0 = uniforme, 1 = chaos)
	grassShadows: false,

	// Audio
	music: false,
	musicVolume: 0.45,

	// Couleurs
	groundColorA: '#2b3a21',           // mousse sombre (sol ET herbe)
	groundColorB: '#4a5c3a',           // mousse claire
	antColor: '#16120e',
	antAccentColor: '#4a5578',         // yeux / antennes
	soldierColor: '#5a2716',           // caste soldate
	nurseColor: '#a8935f',             // caste nourrice (pâle, sous terre)
	scoutColor: '#3d3324',             // caste éclaireuse (brun clair)
	queenColor: '#4a1f12',             // la reine (acajou sombre)
	eggColor: '#f2ecd8',               // œufs (blanc cassé)
	larvaColor: '#e3d3a6',             // larves (crème)
	pupaColor: '#8f6f45',              // nymphes (brun clair)
	spiderColor: '#39302a',            // corps de l'araignée (VAT sans matériau GLB)
	spiderAccent: '#17110c',           // pattes / détail
	anthillColor: '#7a5230',           // marron terre
	foodColor: '#ff9d3a',

	// Nourriture : vraies billes posées au sol (1 bille = 1 cellule de grille)
	foodBallSpacing: 4,                // texels entre billes
	foodBallRadius: 0.16,              // rayon VISUEL d'une bille (unités monde)
	foodGlow: 1.4,                     // brillance des billes
	haloSpread: 0.93,                  // halo au sol : portée (diffusion)
	haloStrength: 0.7,                 // halo au sol : intensité
	haloSize: 1.0,                     // halo lumineux (billboard) : taille
	haloIntensity: 1.0,                // halo lumineux : intensité

	// Pistes
	trailGamma: 1.7,                   // contraste des pistes (1 = faibles visibles)

	// Fourmilière souterraine (vue en fosse)
	undergroundView: false,            // découpe le sol autour du nid pour voir les chambres
	pitRadius: 18,                     // rayon de la fosse (unités monde)
	queenScale: 2.3,                   // gabarit de la reine (× fourmi normale)

	// Micro-dynamique du corps (démarche physique : le corps tangue et roule
	// en cadence avec le trépied au lieu de glisser en bloc). 0 = désactivé.
	bobAmp: 0.018,                     // rebond vertical (unités monde)
	swayAmp: 0.085,                    // roulis de la foulée (rad)
	pitchAmp: 0.045,                   // tangage de la foulée (rad)

	// Ragdoll GPU (XPBD) — pool borné : le coût est plafonné par construction
	rdBudget: 192,                     // ragdolls simultanés max (0 = jamais de ragdoll)
	rdDist: 26,                        // distance caméra max pour ragdoller (u)
	rdSubsteps: 8,                     // sous-pas XPBD par pas fixe

	// Débogage
	debugCones: false,                 // cônes de vision des fourmis
	debugSpider: false,                // hitbox (corps araignée + fourmis) et cône de vision de l'araignée
	perfHud: false,                    // chronos GPU par passe (nécessite un rechargement)

	// Performances (LOD des fourmis)
	lodDist0: 16,                      // rayon plein détail (unités monde)
	lodDist1: 42,                      // distance d'animation — au-delà : silhouette figée
	lodBudget: 3000,                   // fourmis plein détail max (rétrogradées ensuite)
	maxAntCorpses: 2000,               // cadavres de fourmis affichés max (les plus vieux disparaissent)
	maxSpiderCorpses: 60,              // cadavres d'araignées gardés max (les plus vieux disparaissent)

	// Échelles du décor
	scaleTrees: 1.0,
	scaleObstacles: 1.0,
	scaleMushrooms: 1.0,
	scalePlants: 1.0,
	scaleRocks: 1.0,

	// Ciel et nuit
	nightTime: 0.5,                    // 0 = lever de lune, 1 = coucher
	moonIntensity: 3.2,
	ambientIntensity: 2.2,
	fogDensity: 0.008,
	stars: 0.7,
	godrays: false,                    // rayons de lune (post-process)
	godrayIntensity: 0.9,
};

// fusion des réglages sauvegardés (clés connues uniquement)
if ( saved ) {

	for ( const [ k, v ] of Object.entries( saved.params || {} ) ) {

		if ( k in params && typeof v === typeof params[ k ] ) params[ k ] = v;

	}

	for ( const [ k, v ] of Object.entries( saved.gfx || {} ) ) {

		if ( k in gfx && typeof v === typeof gfx[ k ] ) gfx[ k ] = v;

	}

	params.paused = false;
	params.cinematic = false;
	params.brushMode = false;

	// migration : une bille = UNE unité, littéralement prise du sol
	// (les anciennes sauvegardes portaient 12-30 unités par bille)
	params.foodAmount = 1;

}

// Surcharges d'URL, APRÈS la fusion des réglages sauvegardés : `?physics=0`
// et `?physics=1` donnent deux onglets comparables sans toucher au panneau
// (l'A/B honnête exige DEUX pages rechargées — l'HMR ne recompile pas un
// kernel déjà instancié). `?perf=1` active les chronos GPU par passe.
{

	const q = new URLSearchParams( location.search );
	if ( q.has( 'physics' ) ) params.physics = q.get( 'physics' ) !== '0';
	if ( q.has( 'perf' ) ) gfx.perfHud = q.get( 'perf' ) !== '0';

}

export function saveSettings() {

	localStorage.setItem( STORAGE_KEY, JSON.stringify( { params, gfx } ) );

}

export function clearSettings() {

	localStorage.removeItem( STORAGE_KEY );

}

export function hasSavedSettings() {

	return saved !== null;

}

export function worldToGrid( x, z ) {

	return {
		x: ( x / WORLD + 0.5 ) * GRID,
		y: ( z / WORLD + 0.5 ) * GRID,
	};

}

export function gridToWorld( gx, gy ) {

	return {
		x: ( gx / GRID - 0.5 ) * WORLD,
		z: ( gy / GRID - 0.5 ) * WORLD,
	};

}
