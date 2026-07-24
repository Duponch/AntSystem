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

## Prédateurs & défense

- **Araignées** (dossier « 🕷 Prédateurs & défense », jusqu'à 1024) rendues en **VAT multi-clips** : les 4 animations du GLB rigué (Idle/Walk/Attack/Death) sont bakées dans une seule texture ; chaque instance mélange deux clips (transition douce) sans coût de skinning — **1024 araignées animées à ~7 ms/frame**. Chacune suit une machine à états (guet → déambulation → chasse → frappe → retraite → mort → réapparition).
- La menace passe par une **grille de secteurs 8×8** : chaque fourmi ne teste que les 2 araignées les plus proches de son secteur — coût constant côté GPU quel que soit le nombre de prédateurs.
- **Défense émergente** : une part réglable de la colonie forme des **soldates** (plus grosses) qui *chargent* l'araignée au lieu de fuir et la mordent ; leurs morsures s'accumulent (buffer GPU par araignée) jusqu'à la faire **reculer, puis mourir** (animation Death). Une **phéromone d'alarme** rouge, déposée par les paniquées, *repousse* les ouvrières et *attire* les soldates — le recrutement au combat émerge du même mécanisme à 3 capteurs que le fourragement.
- **Mort permanente** : une fourmi croquée est **projetée par le coup**, retombe, dérape et s'immobilise dans la pose où la physique la laisse (voir ⚙️ Physique) — elle ne réapparaît pas.

## ⚙️ Physique

Le dossier **⚙️ Physique** du panneau porte un interrupteur maître. Coupé, la
simulation reprend **exactement** le chemin historique (déplacement cinématique
`pos += direction × vitesse × dt`, cycle de marche piloté par une horloge
globale, cadavre plaqué sur le dos) : c'est le témoin de comparaison. Activé :

- **La vitesse est un état.** Le muscle ne place plus la fourmi, il tire sa
  vitesse vers la vitesse voulue — d'où l'inertie : les démarrages, les arrêts et
  les virages ont une durée. Les impacts s'ajoutent directement à cette vitesse
  et se dissipent par la friction du sol. Dès qu'une fourmi décolle, plus aucun
  contrôle : c'est un projectile balistique.
- **Vrais coups.** Chaque crochet de l'araignée projette réellement sa proie
  (recul + soulèvement) : elle décolle, tournoie, retombe, dérape et se relève.
  Une soldate qui percute le corps du prédateur encaisse le contre-coup ; les
  morsures accumulées repoussent physiquement l'araignée.
- **Cadavres non figés.** Ils volent, rebondissent, dérapent et s'immobilisent là
  où la physique les mène. Leur position reste celle de la simulation — donc
  l'araignée qui vient dévorer trouve vraiment le corps.
- **Pose de mort entomologique.** Chez l'insecte, l'extension des pattes est
  hydraulique et la flexion musculaire : à la mort la pression tombe et les
  fléchisseurs l'emportent seuls. Cette pose (pattes recroquevillées sous le
  corps, tête et gastre retombés) est bakée dans la VAT, et le quadrant de repos
  — sur les pattes, sur un flanc, sur le dos — est ATTEINT par la culbute au lieu
  d'être plaqué.
- **Fin du patinage.** La phase du cycle de marche avance avec la DISTANCE
  réellement parcourue, jamais avec le temps (allométrie de la fourmi : longueur
  de foulée ∝ v^0,42). Une fourmi bloquée contre un mur cesse de pédaler, une
  envenimée traîne vraiment la patte, une soldate a une foulée plus ample.
- **Le bond de l'araignée.** Le clip `Jump` du GLB, jamais utilisé jusqu'ici,
  sert enfin : la parabole est résolue pour retomber sur la proie, et en vol
  plus personne ne pilote — la proie peut esquiver, l'araignée peut manquer.
  L'araignée meurt en basculant sur le flanc et son cadavre garde l'orientation
  où la physique l'a laissé.

### Ragdoll XPBD sur GPU

Les cadavres proches de la caméra passent en **ragdoll articulé** : 15 particules
(tronc + genou et tarse par patte), 25 contraintes de distance à compliance,
8 sous-pas XPBD par frame. Les pattes retombent avec leur propre inertie, le
corps drape sur le relief, et deux cadavres ne se ressemblent jamais.

Trois décisions font tout le coût :

1. **Ragdoll en espace-pose.** Les particules vivent en coordonnées locales
   autour du pivot de la fourmi. La trajectoire reste possédée par le noyau de
   simulation : aucune dérive float32, et aucune désynchronisation avec la
   prédation.
2. **Pool + dispatch INDIRECT.** Un compute compacte les ragdolls réveillés et
   écrit lui-même le nombre de workgroups à lancer — le CPU n'apprend jamais
   combien il y en a, et zéro réveillé = zéro workgroup.
3. **Sommeil.** Un ragdoll immobile sort de la liste active et continue de
   s'afficher pour zéro coût de simulation.

Le rig de la fourmi est *rigide* (une seule influence par sommet) : un ragdoll
n'a donc besoin que d'**une** transformation par sommet — un quaternion et une
origine — au lieu des quatre matrices d'un skinning classique.

### Coût mesuré (RTX, `?perf=1`, chronos GPU par passe)

| Mesure | Coût |
|---|---|
| Mode physique ON vs OFF, 65 536 fourmis, positions gelées | **+0,006 ms** compute · **0,000 ms** rendu |
| Noyau de simulation (`kAnt` + `kGrid`), physique ON vs OFF | **0,000 ms** (le noyau est borné mémoire, l'arithmétique se cache dedans) |
| 192 ragdolls en train de tomber, tous à l'écran | +0,082 ms compute · +0,25 ms rendu |
| 192 ragdolls stabilisés et affichés | **+0,006 ms** (le dispatch indirect ne lance aucun workgroup) |

Pour comparer soi-même : `?physics=0` et `?physics=1` dans **deux onglets
rechargés** (l'HMR ne recompile pas un noyau déjà instancié — un test « ça n'a
rien changé » après hot-reload est un faux négatif). `?perf=1` affiche les
chronos GPU dans l'overlay.

## Structure

```
src/
  config.js         constantes, paramètres simulation + graphismes + physique
  simulation.js     kernels TSL : fourmis (dynamique, impacts, balistique),
                    grille, pinceau, obstacles, stats
  pose.js           passe kPose : la transformation complète d'un corps
                    (position, attitude quaternion, démarche) en un buffer
  ragdoll.js        ragdoll XPBD sur GPU : pool, dispatch indirect, sommeil
  vat.js            bake d'animations squelettiques en texture (1 ou N clips),
                    pose de mort entomologique, extraction du rig
  ants.js           rendu instancié VAT + LOD + cadavres + grain porté
  spiders.js        prédateurs : VAT multi-clips, FSM, bond balistique,
                    secteurs de menace
  environment.js    sol (visualisation du champ), nid
  graphics/sky.js   dôme, lune, étoiles, lumières, brouillard
  graphics/grass.js tapis d'herbe GPU (disque suivant la caméra)
  graphics/props.js arbres, obstacles, déco (pack FBX low-poly)
  editor.js         éditeur de décor (placer/déplacer/redimensionner)
  bench.js          banc d'essai statistique headless
  ui.js             panneau lil-gui, peinture au pointeur, overlay
  main.js           bootstrap WebGPU et boucle
```
