// Constantes de la simulation — grille de phéromones et monde 3D.

export const GRID = 1024;              // résolution de la grille (texels)
export const WORLD = 160;              // taille du sol en unités monde
export const TEXEL = WORLD / GRID;     // taille d'un texel en unités monde
export const MAX_ANTS = 65536;         // capacité GPU (buffers alloués une fois)
export const FIXED = 1024;             // échelle virgule fixe des dépôts u32

export const NEST = {
	x: GRID / 2,
	y: GRID / 2,
	radius: 20,                        // texels
};

// Paramètres réglables (valeurs par défaut issues de Pezzza's Work / Sebastian Lague)
export const params = {
	// Colonie
	antCount: 869,                     // clin d'œil à la vidéo
	simSpeed: 1,
	paused: false,

	// Comportement (unités : texels et radians par seconde)
	moveSpeed: 22,
	steerStrength: 6,
	wanderStrength: 1.6,
	sensorAngleDeg: 30,
	sensorDist: 12,

	// Phéromones (lentes à disparaître : les pistes structurent la colonie)
	depositRate: 12,                   // intensité déposée par seconde (avant fondu)
	fade: 0.03,                        // k du fondu exp(-k·temps_depuis_source)
	evaporation: 0.06,                 // décroissance linéaire par seconde
	diffusion: 1.2,                    // taux de flou par seconde

	// Outils
	tool: 'nourriture',                // 'nourriture' | 'mur' | 'gomme'
	brushRadius: 8,                    // texels
	foodAmount: 12,                    // unités par cellule

	// Affichage
	trailIntensity: 1.0,
	shadows: true,
	// calibrage animation : cycles de marche par texel parcouru
	// (l'animation reste proportionnelle à la vitesse de déplacement)
	walkAnim: 1.0,
};

// Paramètres graphiques (ambiance nocturne, herbe, décor)
export const gfx = {
	// Herbe GPU : disque continu de brins centré sur la caméra
	grass: true,
	grassDensity: 40,                  // brins par m²
	grassHeight: 0.55,                 // facteur hauteur (fourmis toujours visibles)
	grassWidth: 0.85,
	grassRadius: 45,                   // rayon du disque de brins (unités monde)
	grassWind: 0.45,
	grassShadows: false,               // ombres portées par les brins (coûteux)

	// Ciel et nuit
	moonIntensity: 3.2,
	ambientIntensity: 2.2,
	fogDensity: 0.008,
	stars: 0.7,                        // densité/intensité des étoiles
};

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
