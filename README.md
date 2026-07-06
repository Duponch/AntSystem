# 🐜 AntSystem

Simulation de colonie de fourmis **100 % GPU**, en [Three.js](https://threejs.org) r185 (WebGPURenderer + TSL), jouable directement dans le navigateur — sans moteur de jeu.

Inspirée de la vidéo [« J'ai simulé 869 fourmis pour mieux les comprendre »](https://www.youtube.com/watch?v=M9ydYnN9_uc), elle-même basée sur les travaux de [Sebastian Lague](https://github.com/SebLague/Ant-Simulation) (double carte de phéromones) et de [Pezzza's Work](https://github.com/johnBuffer/AntSimulator) (dépôt atténué par le temps de trajet).

## Lancer

```bash
npm install
npm run dev
```

Nécessite un navigateur avec **WebGPU** : Chrome / Edge 113+, Firefox 141+, Safari 26+.

## Jouer

| Action | Commande |
|---|---|
| Poser de la nourriture / des murs / effacer | Clic gauche (outil choisi dans le panneau, ou touches 1 / 2 / 3) |
| Orbiter | Clic droit |
| Zoomer | Molette |
| Pause | Espace |

Le panneau de droite règle en direct la taille de la colonie (jusqu'à 65 536 fourmis), la vitesse, le comportement (capteurs, pilotage, errance) et la dynamique des phéromones (dépôt, évaporation, diffusion).

## Comment ça marche

Tout l'état vit sur le GPU ; le CPU ne fait qu'orchestrer les passes de calcul (TSL compilé en WGSL) :

1. **Passe fourmis** (une invocation par fourmi) — chaque fourmi vit dans un storage buffer (position, angle, état, chrono). Trois capteurs en cône lisent le champ de phéromones :
   - *exploratrice* : suit la carte **nourriture**, dépose la carte **maison** ;
   - *porteuse* : suit la carte **maison**, dépose la carte **nourriture**.

   Le dépôt vaut `exp(-k · temps_depuis_la_source)` : les trajets courts déposent plus fort, donc **les chemins courts gagnent** — c'est de là qu'émergent les autoroutes. Les dépôts s'accumulent par `atomicAdd` dans un buffer u32 en virgule fixe (aucune perte entre milliers d'écritures concurrentes).

2. **Passe grille** (une invocation par texel, 1024²) — diffusion 3×3 + évaporation linéaire, injection des dépôts accumulés, marqueurs permanents (le nid sature la carte maison, la nourriture sature la carte nourriture), puis écriture dans une paire de textures `rgba16float` en ping-pong qui sert à la fois aux capteurs et à l'affichage.

   Le dépôt suit une **sémantique de fraîcheur** (à la Pezzza) : la valeur du champ est `exp(-k·temps_depuis_source)` du visiteur le plus récent (`atomicMax`), pas une accumulation — le gradient vers la source reste net sous n'importe quel trafic, sans saturation.

3. **Rendu** — la fourmi riguée et animée dans Blender (17 os, genoux articulés, cycle tripode) est bakée en **VAT** (Vertex Animation Texture) au chargement, puis décimée en 3 niveaux de détail (2000/452/93 triangles) par clustering, tous branchés sur la même texture d'animation. Chaque frame, un compute classe chaque fourmi (frustum + distance) dans des listes compactées et écrit les **draws indirects** : le GPU décide seul combien d'instances de chaque LOD se dessinent, sans readback CPU. Résultat mesuré : **65 536 fourmis en ~4 ms/frame**. Le sol affiche le champ de phéromones en émissif (bleu = maison, orange = nourriture).

## Banc d'essai

Le dossier **🧪 Banc d'essai** (ou l'URL `?bench=5x90`, ou `__antsys.bench.run(...)` en console) enchaîne N simulations headless à graines différentes et rapporte livraisons, ramassages et **taux de retour** (moyenne ± écart-type, courbes par points de contrôle en console). `__antsys.bench.compare([...])` confronte plusieurs jeux de paramètres. Les défauts actuels (config « D ») en sont issus : taux de retour ×5.5 par rapport au réglage précédent.

## Graphismes (nuit cozy low-poly)

- **Tapis d'herbe 100 % GPU** : un brin = 2 triangles, position/lacet/taille/vent dérivés de `instanceIndex` par `hash()` dans le vertex shader (zéro donnée par brin côté CPU). Les brins forment un **disque continu qui suit la caméra** (pavage toroïdal : positions stables dans le monde, recyclage silencieux sur le bord fondu), rayon réglable, densité dégressive selon la hauteur caméra. Chaque brin affiche **l'albédo et l'émissif du sol à sa racine** avec une normale verticale : il est indiscernable du sol, sauf en silhouette au ras du sol.
- **Ciel nocturne** : dôme en dégradé zénith/horizon, étoiles procédurales scintillantes, lune billboard TSL (disque + halo + cratères), brouillard exponentiel assorti à l'horizon.
- **Clair de lune** : directionnelle bleutée avec ombres (y compris sur l'herbe) + ambiante nuit — palette portée du projet Simulation.
- **Décor** : arbres low-poly en lisière, bûches/souche/rocher posés comme **obstacles physiques** (empreinte rasterisée dans la grille de murs — les fourmis les contournent), champignons, fougères. La fourmilière est un GLB dédié, et la nourriture rougeoie comme des lucioles posées dans l'herbe.
- Tout est réglable en direct dans le dossier **Graphismes** du panneau.

## Structure

```
src/
  config.js         constantes, paramètres simulation + graphismes
  simulation.js     kernels TSL : fourmis, grille, pinceau, obstacles, stats
  vat.js            bake du cycle de marche squelettique en texture
  ants.js           rendu instancié VAT + grain de nourriture porté
  environment.js    sol (visualisation du champ), nid
  graphics/sky.js   dôme, lune, étoiles, lumières, brouillard, lucioles
  graphics/grass.js tapis d'herbe GPU en chunks
  graphics/props.js arbres, obstacles, déco (pack FBX low-poly)
  ui.js             panneau lil-gui, peinture au pointeur, overlay
  main.js           bootstrap WebGPU et boucle
```
