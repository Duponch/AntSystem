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

	// Outils
	tool: 'nourriture',                // 'nourriture' | 'mur' | 'gomme'
	brushRadius: 10,                   // texels
	foodAmount: 1,                     // unités par bille : 1 = prise → disparue

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
	grassShadows: false,

	// Couleurs
	groundColorA: '#2b3a21',           // mousse sombre (sol ET herbe)
	groundColorB: '#4a5c3a',           // mousse claire
	antColor: '#16120e',
	antAccentColor: '#4a5578',         // yeux / antennes
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

	// Débogage
	debugCones: false,                 // cônes de vision des fourmis

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
