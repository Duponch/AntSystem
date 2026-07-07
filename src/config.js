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
export const FIXED = 1024;             // échelle virgule fixe des dépôts u32

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

	// Prédation (calibrée sur la biologie : morsure → envenimation graduée →
	// paralysie croissante → mort après quelques morsures → dévoration)
	biteRadius: 0.85,                  // zone de crochets (unités monde) — petite : « sur » la fourmi, pas au bout de la patte
	bitesToKill: 2,                    // morsures cumulées avant la mort (2-3)
	biteInterval: 0.55,                // s entre deux morsures d'une même araignée
	paralysisFactor: 0.35,             // vitesse d'une fourmi après 1 morsure (× vitesse normale)
	venomRecovery: 0.25,               // dissipation du venin /s (guérison si l'araignée décroche)
	eatDuration: 3.0,                  // s de dévoration (araignée immobile) avant disparition du cadavre
	alarmFleeThreshold: 0.45,          // pression d'alarme locale qui fait fuir l'araignée (0..1)
	alarmWait: 6.0,                    // s d'attente à distance avant de retenter

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

	// Débogage
	debugCones: false,                 // cônes de vision des fourmis
	debugMouth: false,                 // marqueur jaune fluo de la bouche des araignées

	// Performances (LOD des fourmis)
	lodDist0: 16,                      // rayon plein détail (unités monde)
	lodDist1: 42,                      // distance d'animation — au-delà : silhouette figée
	lodBudget: 3000,                   // fourmis plein détail max (rétrogradées ensuite)

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
