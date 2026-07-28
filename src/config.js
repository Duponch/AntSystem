// Constantes de la simulation, paramètres réglables et persistance.
// Les réglages sauvegardés (localStorage) sont fusionnés au chargement ;
// la taille de la carte ne s'applique qu'au rechargement de la page.

const STORAGE_KEY = 'antsystem-settings-v1';

function loadSaved() {

	try {
	if ( typeof localStorage === 'undefined' ) return null;


		return JSON.parse( localStorage.getItem( STORAGE_KEY ) ) || null;

	} catch {

		return null;

	}

}

const saved = loadSaved();

export const GRID = 1024;              // résolution de la grille (texels)
export const WORLD = ( saved && saved.gfx && saved.gfx.mapSize ) || 160; // unités monde (au rechargement)
export const TEXEL = WORLD / GRID;
export const MIN_NEST_DEPTH = 19;
// 64 tranches verticales gardent au moins trois voxels dans le diametre du
// tunnel minimal jusqu'a 24 u. Au-dela, un volume monolithique ne peut plus
// representer une galerie continue sans augmenter fortement son cout.
export const MAX_NEST_DEPTH = 24;
export const MAX_ANTS = 65536;
export const MAX_SPIDERS = 1024;       // prédateurs simultanés (VAT instancié)
export const MAX_BEES = 128;            // représentantes visibles, pool VAT fixe
export const MAX_FLOWERS = 256;         // champ instancié fixe, un seul draw
export const MAX_BUTTERFLIES = 64;      // slots de cycle de vie, un draw VAT adulte
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
	timingMode: 'fluid',                 // fluid = GPU/rAF, strict = pas fixes + replay
	maxGpuSubsteps: 8,                   // plafond de travail accelere par image
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

	// ------------------------------------------------------------------
	// LE NID : dimensions adaptatives. Le volume creuse suit la population
	// (loi d'echelle des nids reels, exposant ~0,5), et la profondeur est
	// assumee realiste : un vrai nid est bien plus profond que large.
	// ------------------------------------------------------------------
	nestScale: 1.0,                    // multiplie le nombre de loges (x la loi biologique)
	nestDepth: 19,                     // profondeur totale, bornee par geometrie et resolution
	nestTunnelW: 6,                    // demi-largeur des tunnels (texels) : >= 3 corps de fourmi
	nestGrow: true,                    // le nid pousse avec la colonie

	// Vie souterraine : ce qui empeche les fourmis de s'empiler et de tourner
	// sur elles-memes dans les chambres
	troughReach: 9,                    // texels : rayon d'echange autour d'une mangeoire
	seatScatter: 7,                    // texels : rayon du siege personnel autour d'une mangeoire
	laneOffset: 2.4,                   // texels : ecart des voies de circulation en tunnel
	lazyFrac: 0.28,                    // part de fourmis durablement inactives (mesure : ~45 % au total)
	speedSpread: 0.5,                  // dispersion des vitesses individuelles (0 = toutes pareilles)

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
	// --- BOND (salticide) : la parabole est resolue pour retomber sur la proie ---
	spiderJumpRange: 7,                 // portee max du bond (u) ; 0 = plus de bond
	spiderJumpHeight: 0.55,             // hauteur du sommet de la parabole (u)
	spiderJumpCooldown: 3.2,            // s entre deux bonds

	// --- CHOIX DE CIBLE : ce qui empeche l'araignee de tourner sur elle-meme ---
	spiderRetarget: 0.5,                // s entre deux re-evaluations de la proie
	spiderTurnBias: 1.0,                // cout d'une proie hors de l'axe (0 = la plus proche gagne toujours)
	spiderClusterBias: 0.6,             // cout d'une proie eloignee de la cible engagee (favorise les amas)
	spiderCommit: 0.35,                 // marge d'amelioration exigee pour abandonner la cible engagee

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
	beeTint: '#ffffff',                // conserve l'atlas, permet une légère direction artistique
	beeWingColor: '#dceeff',
	flowerPetalColor: '#fff4c2',
	flowerStemColor: '#5f8d35',
	entranceColor: '#6a472f',          // paroi de la bouche souterraine
	foodColor: '#ff9d3a',

	// Pollinisateurs de surface : capacités fixes, simulation indépendante des
	// fourmis. Les nombres changent seulement les instanceCount, jamais les pools.
	pollinators: true,
	beeCount: 48,
	beeScale: 1,
	beeSpeed: 8,
	beeForageDuration: 10,
	beeDaylight: 1,
	beeTemperature: 22,
	beeRain: 0,
	beeWind: 1,
	beeCastShadow: true,
	beeReceiveShadow: true,
	flowerCount: 128,
	flowerSize: 1.45,
	flowerVariation: 0.35,
	flowerWind: 0.32,
	hiveScale: 0.72,
	hiveCastShadow: true,
	hiveReceiveShadow: true,
	butterflies: true,
	butterflyCount: 18,
	butterflyScale: 1,
	butterflySpeed: 4.8,
	butterflyLifeSpeed: 1,
	butterflyPredatorVisionDistance: 8,
	butterflyPredatorVisionAngle: 250,
	butterflyFleeSpeedMultiplier: 1.75,
	butterflyThreatScanFrequency: 10,
	butterflyDebugVision: false,
	butterflyTint: '#ffffff',
	butterflyCastShadow: true,
	butterflyReceiveShadow: true,
	chameleonEnabled: true,
	chameleonScale: 1,
	chameleonPatrolSpeed: 1.15,
	chameleonTrackingSpeed: 1.45,
	chameleonAnimationSpeed: 1,
	chameleonTurnSpeed: 6,
	chameleonRoamingEnabled: true,
	chameleonRoamingRadius: Math.ceil( WORLD * Math.SQRT2 ),
	chameleonCamouflageEnabled: true,
	chameleonCamouflageColor: '#ef2b2b',
	chameleonCamouflageInterval: 14,
	chameleonCamouflageMinDuration: 7,
	chameleonCamouflageMaxDuration: 13,
	chameleonSupportClearance: 0.006,
	chameleonAttackDistance: 3.2,
	chameleonDetectionDistance: 4.8,
	chameleonAimDuration: 0.55,
	chameleonTongueRetractDuration: 0.28,
	chameleonAttackCooldown: 1.1,
	chameleonCastShadow: true,
	chameleonReceiveShadow: true,
	chameleonDebugAttackRange: false,
	chameleonTongueColor: '#d96a79',

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

	// Fourmilière souterraine
	scannerView: true,                 // hologramme fil-de-fer du nid, quand la caméra est dans le bloc de terre
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

	// Vue souterraine (nid volumetrique, caméra dans le bloc de terre)
	// Excavation visuelle de la camera : geometrie bornee, independante du nid.
	undergroundRadius: 9,               // rayon de la bulle creusee visuellement (unites monde)
	undergroundRelief: 1,               // amplitude du relief des mottes
	undergroundContrast: 1,             // contraste de la palette geologique
	undergroundColorHumus: '#302017',
	undergroundColorTopsoil: '#57331f',
	undergroundColorClay: '#774326',
	undergroundColorOchre: '#a86632',
	undergroundColorBedrock: '#a38b6c',
	undergroundChaos: 1.15,             // deformation 3D des zones colorimetriques
	undergroundPatchSize: 7.5,          // taille monde des amas de terre
	undergroundBlend: 0.21,             // largeur du melange entre familles minerales
	undergroundGrain: 0.34,             // contraste du grain fin

	// Objets enfouis : pools instancies fixes, independants des fourmis.
	undergroundRockFrequency: 0.85,
	undergroundRockSize: 0.9,
	undergroundRockVariation: 0.65,
	undergroundRockColor: '#746b62',
	undergroundBoneFrequency: 0.7,
	undergroundBoneSize: 0.95,
	undergroundBoneVariation: 0.5,
	undergroundBoneColor: '#c8b58c',
	undergroundFishBoneFrequency: 0.55,
	undergroundFishBoneSize: 1.15,
	undergroundFishBoneVariation: 0.45,
	undergroundFishBoneColor: '#bea77e',
	undergroundArtifactExposure: 0.72,

	nestLight: 1.0,                    // lampe frontale : lisibilite des galeries
	nestAO: 1.0,                       // occlusion ambiante derivee du champ
	nestBlend: 0.85,                   // fusion des cavites (organicite)
	nestNoise: 0.42,                   // deformation des parois
	nestGhost: 0.75,                   // galeries devinees a travers la tranche

	// Scanner holographique (style Deep Rock Galactic) : bonus affiché quand la
	// caméra est dans le bloc de terre — fil-de-fer du nid complet, sans coupe
	nestScan: 1.0,                     // maître : 0 = coupé (branche sautée, coût nul)
	nestScanColor: '#3fe0c8',          // turquoise scanner
	nestScanPulse: 1.0,                // vitesse de l'impulsion (0 = statique)
	scanAntColor: '#ffa030',           // fourmis souterraines émissives (scanner)
	scanBroodColor: '#7ec8ff',         // couvain émissif (scanner)
	scanFoodColor: '#b6ff4a',          // stocks de nourriture émissifs (scanner)

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

		// Le mode temporel est volontairement limité à la session : une ancienne
		// sauvegarde stricte ne doit jamais dégrader silencieusement le jeu suivant.
		if ( k !== 'timingMode' && k in params && typeof v === typeof params[ k ] ) params[ k ] = v;

	}

	for ( const [ k, v ] of Object.entries( saved.gfx || {} ) ) {

		if ( k in gfx && typeof v === typeof gfx[ k ] ) gfx[ k ] = v;

	}

	// Preserve intentional player tuning while migrating the three former
	// chameleon defaults. Old saves contain every gfx key but predate the
	// independent animation-speed setting, which is our unambiguous version flag.
	const legacyChameleonSettings = saved.gfx || {};
	if ( ! Object.hasOwn( legacyChameleonSettings, 'chameleonAnimationSpeed' ) ) {

		if ( Math.abs( gfx.chameleonPatrolSpeed - 0.62 ) < 1e-9 )
			gfx.chameleonPatrolSpeed = 1.15;
		if ( Math.abs( gfx.chameleonTrackingSpeed - 0.95 ) < 1e-9 )
			gfx.chameleonTrackingSpeed = 1.45;
		if ( Math.abs( gfx.chameleonRoamingRadius - 52 ) < 1e-9 )
			gfx.chameleonRoamingRadius = Math.ceil( WORLD * Math.SQRT2 );
		if ( Math.abs( gfx.chameleonCamouflageInterval - 10 ) < 1e-9 )
			gfx.chameleonCamouflageInterval = 14;
		if ( Math.abs( gfx.chameleonCamouflageMinDuration - 2.5 ) < 1e-9 )
			gfx.chameleonCamouflageMinDuration = 7;
		if ( Math.abs( gfx.chameleonCamouflageMaxDuration - 6 ) < 1e-9 )
			gfx.chameleonCamouflageMaxDuration = 13;

	}

	params.paused = false;
	params.cinematic = false;
	params.brushMode = false;

	// migration : une bille = UNE unité, littéralement prise du sol
	// (les anciennes sauvegardes portaient 12-30 unités par bille)
	params.foodAmount = 1;

}

// Les anciennes sauvegardes pouvaient demander jusqu'a 200 u, alors que le
// volume 128x64x128 ne conservait meme plus un voxel dans le diametre d'un
// tunnel. La migration garde toutes les sauvegardes chargeables et physiques.
params.nestDepth = Math.min( MAX_NEST_DEPTH, Math.max( MIN_NEST_DEPTH, params.nestDepth ) );

// Les versions précédentes autorisaient une excavation jusqu'à 14 u. Les
// valeurs persistées sont migrées avant toute création de géométrie : une
// ancienne sauvegarde ne peut donc pas violer la demi-tuile périodique ni les
// bornes de qualité validées par les tests.
const clampSetting = ( value, low, high ) => Number.isFinite( value )
	? Math.min( high, Math.max( low, value ) )
	: low;
// Le mode fluide est toujours le point de départ. Seule la surcharge d'URL
// appliquée plus bas peut ouvrir explicitement une session stricte.
params.timingMode = 'fluid';
params.maxGpuSubsteps = Math.round( clampSetting( params.maxGpuSubsteps, 1, 16 ) );

gfx.undergroundRadius = clampSetting( gfx.undergroundRadius, 6, 10 );
gfx.undergroundRelief = clampSetting( gfx.undergroundRelief, 0, 1.8 );
gfx.undergroundContrast = clampSetting( gfx.undergroundContrast, 0.6, 1.4 );
gfx.undergroundChaos = clampSetting( gfx.undergroundChaos, 0.45, 2.2 );
gfx.undergroundPatchSize = clampSetting( gfx.undergroundPatchSize, 3, 18 );
gfx.undergroundBlend = clampSetting( gfx.undergroundBlend, 0.1, 0.38 );
gfx.undergroundGrain = clampSetting( gfx.undergroundGrain, 0, 0.8 );
for ( const prefix of [ 'Rock', 'Bone', 'FishBone' ] ) {

	gfx[ `underground${prefix}Frequency` ] = clampSetting(
		gfx[ `underground${prefix}Frequency` ], 0, 1 );
	gfx[ `underground${prefix}Size` ] = clampSetting(
		gfx[ `underground${prefix}Size` ], 0.1, 2.5 );
	gfx[ `underground${prefix}Variation` ] = clampSetting(
		gfx[ `underground${prefix}Variation` ], 0, 1 );

}
gfx.undergroundArtifactExposure = clampSetting( gfx.undergroundArtifactExposure, 0, 1.2 );
gfx.beeCount = Math.round( clampSetting( gfx.beeCount, 0, MAX_BEES ) );
gfx.beeScale = clampSetting( gfx.beeScale, 0.25, 3 );
gfx.beeSpeed = clampSetting( gfx.beeSpeed, 1, 20 );
gfx.beeForageDuration = clampSetting( gfx.beeForageDuration, 2, 40 );
gfx.beeDaylight = clampSetting( gfx.beeDaylight, 0, 1 );
gfx.beeTemperature = clampSetting( gfx.beeTemperature, - 5, 45 );
gfx.beeRain = clampSetting( gfx.beeRain, 0, 1 );
gfx.beeWind = clampSetting( gfx.beeWind, 0, 12 );
gfx.flowerCount = Math.round( clampSetting( gfx.flowerCount, 0, MAX_FLOWERS ) );
gfx.flowerSize = clampSetting( gfx.flowerSize, 0.2, 4 );
gfx.flowerVariation = clampSetting( gfx.flowerVariation, 0, 1 );
gfx.flowerWind = clampSetting( gfx.flowerWind, 0, 2 );
gfx.hiveScale = clampSetting( gfx.hiveScale, 0.25, 2 );
gfx.butterflyCount = Math.round( clampSetting( gfx.butterflyCount, 0, MAX_BUTTERFLIES ) );
gfx.butterflyScale = clampSetting( gfx.butterflyScale, 0.25, 3 );
gfx.butterflySpeed = clampSetting( gfx.butterflySpeed, 1, 12 );
gfx.butterflyLifeSpeed = clampSetting( gfx.butterflyLifeSpeed, 0.1, 8 );
gfx.butterflyPredatorVisionDistance = clampSetting( gfx.butterflyPredatorVisionDistance, 1, 30 );
gfx.butterflyPredatorVisionAngle = clampSetting( gfx.butterflyPredatorVisionAngle, 30, 360 );
gfx.butterflyFleeSpeedMultiplier = clampSetting( gfx.butterflyFleeSpeedMultiplier, 1, 4 );
gfx.butterflyThreatScanFrequency = clampSetting( gfx.butterflyThreatScanFrequency, 1, 30 );
gfx.chameleonScale = clampSetting( gfx.chameleonScale, 0.4, 2.5 );
gfx.chameleonPatrolSpeed = clampSetting( gfx.chameleonPatrolSpeed, 0.05, 4 );
gfx.chameleonTrackingSpeed = clampSetting( gfx.chameleonTrackingSpeed, 0.05, 5 );
gfx.chameleonAnimationSpeed = clampSetting( gfx.chameleonAnimationSpeed, 0.1, 4 );
gfx.chameleonTurnSpeed = clampSetting( gfx.chameleonTurnSpeed, 1, 15 );
gfx.chameleonRoamingRadius = clampSetting(
	gfx.chameleonRoamingRadius, 2, Math.ceil( WORLD * Math.SQRT2 ),
);
gfx.chameleonCamouflageInterval = clampSetting( gfx.chameleonCamouflageInterval, 1, 60 );
gfx.chameleonCamouflageMinDuration = clampSetting( gfx.chameleonCamouflageMinDuration, 0.5, 30 );
gfx.chameleonCamouflageMaxDuration = Math.max(
	gfx.chameleonCamouflageMinDuration,
	clampSetting( gfx.chameleonCamouflageMaxDuration, 0.5, 60 ),
);
gfx.chameleonSupportClearance = clampSetting( gfx.chameleonSupportClearance, 0, 0.25 );
gfx.chameleonAttackDistance = clampSetting( gfx.chameleonAttackDistance, 0.5, 8 );
gfx.chameleonDetectionDistance = Math.max(
	gfx.chameleonAttackDistance,
	clampSetting( gfx.chameleonDetectionDistance, 1, 12 ),
);
gfx.chameleonAimDuration = clampSetting( gfx.chameleonAimDuration, 0.2, 3 );
gfx.chameleonTongueRetractDuration = clampSetting( gfx.chameleonTongueRetractDuration, 0.15, 0.6 );
gfx.chameleonAttackCooldown = clampSetting( gfx.chameleonAttackCooldown, 0.3, 6 );

// Surcharges d'URL, APRÈS la fusion des réglages sauvegardés : `?physics=0`
// et `?physics=1` donnent deux onglets comparables sans toucher au panneau
// (l'A/B honnête exige DEUX pages rechargées — l'HMR ne recompile pas un
// kernel déjà instancié). `?perf=1` active les chronos GPU par passe.
{

	const q = new URLSearchParams( typeof location === 'undefined' ? '' : location.search );
	if ( q.has( 'physics' ) ) params.physics = q.get( 'physics' ) !== '0';
	if ( q.has( 'perf' ) ) gfx.perfHud = q.get( 'perf' ) !== '0';
	if ( q.has( 'timing' ) ) params.timingMode = q.get( 'timing' ) === 'strict' ? 'strict' : 'fluid';


}

export function saveSettings() {

	if ( typeof localStorage !== 'undefined' ) {

		const persistentParams = { ...params };
		delete persistentParams.timingMode;
		localStorage.setItem( STORAGE_KEY, JSON.stringify( { params: persistentParams, gfx } ) );

	}

}

export function clearSettings() {

	if ( typeof localStorage !== 'undefined' ) localStorage.removeItem( STORAGE_KEY );

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
