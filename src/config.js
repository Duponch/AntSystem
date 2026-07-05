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
	simSpeed: 4,
	paused: false,

	// Comportement (unités : texels et radians par seconde)
	moveSpeed: 5,
	steerStrength: 6,
	wanderStrength: 1.6,
	sensorAngleDeg: 30,
	sensorDist: 14,

	// Phéromones (très persistantes : les pistes structurent la colonie)
	depositRate: 12,
	fade: 0.005,                       // k du fondu exp(-k·temps_depuis_source)
	evaporation: 0.01,                 // décroissance linéaire par seconde
	diffusion: 1.2,

	// Outils
	tool: 'nourriture',                // 'nourriture' | 'mur' | 'gomme'
	brushRadius: 8,                    // texels
	foodAmount: 12,                    // unités par cellule

	// Affichage
	trailIntensity: 1.0,
	shadows: true,
	// calibrage animation : rapport entre fréquence de foulée et vitesse
	walkAnim: 2.9,
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
	foodBallSpacing: 5,                // texels entre billes
	foodBallRadius: 0.16,              // rayon VISUEL d'une bille (unités monde)
	foodGlow: 1.4,                     // brillance des billes
	haloSpread: 0.93,                  // halo au sol : portée (diffusion)
	haloStrength: 0.7,                 // halo au sol : intensité
	haloSize: 1.0,                     // halo lumineux (billboard) : taille
	haloIntensity: 1.0,                // halo lumineux : intensité

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
