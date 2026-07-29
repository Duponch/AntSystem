# BEE-SIM — Abeilles et pollinisateurs

## Objet du contrat

`BEE-SIM` combine deux niveaux de simulation :

- une colonie d’*Apis mellifera* agrégée, avec reine, couvain, ouvrières, réserves et consommation ;
- un nombre borné de butineuses visibles qui représentent cette population, explorent, recrutent, récoltent puis rentrent réellement dans la ruche.

Le noyau `bee-simulation.js` est déterministe, indépendant de Three.js et sans allocation dans sa boucle chaude. Il cherche une abstraction biologique crédible et lisible, pas une prédiction quantitative d’une ruche réelle.

Les abeilles restent indépendantes de la fourmilière. Elles partagent le champ floral avec les papillons, mais ni leur population ni leurs décisions. Une visite consomme du nectar ou du pollen ; elle ne féconde pas encore la plante et ne crée pas de graines.

## Architecture

La chaîne est divisée en cinq couches :

1. `pollinator-layout.js` génère des parcelles de fleurs déterministes en évitant le centre, les arbres, les obstacles et les limites du monde ;
2. `bee-simulation.js` gère états, stratégies, mémoire sociale, mouvement, énergie, ressources et démographie dans des tableaux typés ;
3. `pollinator-assets.js` prépare la fleur fusionnée, la ruche et la VAT multi-clips de l’abeille ;
4. `bees.js` relie la simulation aux instances GPU, aux points d’entrée de la ruche, au contact Blender des fleurs et aux réglages ;
5. `pollinators.js` expose une façade commune et charge les assets à la demande.

Le temps logique et le rendu restent séparés. `stepSimulation(dt)` peut avancer plusieurs pas sans toucher aux matrices GPU ; `renderFrame()` ne téléverse les instances qu’une fois par image affichée.

Si **Activer** est persisté à faux, les GLB et la VAT ne sont pas chargés au démarrage. Une activation ultérieure déclenche une promesse de chargement unique. La vue souterraine masque les pollinisateurs de surface sans arrêter leur temps logique.

## Graphe comportemental

Le noyau conserve dix-sept états explicites :

| État | Rôle | Visibilité |
|---|---|---|
| `IN_HIVE` | attente, récupération et décision de départ | cachée, au point intérieur |
| `HIVE_EXIT` | intérieur → bouche → point extérieur | visible pendant toute la traversée |
| `ORIENTATION` | premiers vols locaux d’apprentissage | visible autour de la ruche |
| `SCOUT_SEARCH` | détour exploratoire d’une éclaireuse vers une zone candidate | visible |
| `OUTBOUND` | trajet informé d’une recrutée vers une source annoncée | visible |
| `PATCH_SEARCH` | inspection orbitale et recherche locale dans une parcelle | visible |
| `APPROACH` | ralentissement vers le contact exact d’une fleur | visible |
| `TOUCHDOWN` | raccord de pose Hermite C1 | visible, clip de butinage |
| `FORAGE` | prélèvement de nectar ou pollen | visible, posée |
| `TAKEOFF` | retrait depuis la fleur à vitesse initiale nulle | visible |
| `DEPART` | raccord vers le vol principal | visible |
| `RETURN` | retour vers le point extérieur de la ruche | visible |
| `HIVE_APPROACH` | point extérieur → bouche | visible |
| `HIVE_ENTRY` | bouche → point intérieur | visible jusqu’à l’intérieur |
| `UNLOAD` | transfert de la charge aux réserves | cachée |
| `DANCE` | publication d’une source profitable dans la mémoire collective | cachée |
| `REST` | récupération avant un nouveau départ | cachée |

Le cycle productif courant est donc :

```text
ruche
  → sortie physique
  → orientation ou recherche/recrutement
  → inspection de parcelle
  → approche → pose → butinage
  → [autre fleur de la parcelle] ou retour
  → approche de la ruche → entrée physique
  → déchargement → danse éventuelle → repos
```

Les états cachés sont toujours positionnés au point intérieur de la ruche. Une abeille n’est masquée qu’après avoir atteint ce point ; à la sortie, elle redevient visible avant de franchir la bouche.

## Exploration, fidélité et recrutement

Chaque départ choisit d’abord une ressource selon les réserves de la colonie et la préférence individuelle du slot.

Deux stratégies complémentaires sont ensuite assignées :

- une **éclaireuse** échantillonne un nombre fixe de fleurs, prend un waypoint indirect, puis inspecte la zone autour de la source ; cette trajectoire représente une recherche exploratoire bornée ;
- une **recrutée** consulte la mémoire collective et privilégie une source annoncée correspondant à la ressource recherchée.

La proportion d’éclaireuses augmente légèrement lorsque la mémoire collective devient pauvre. Elle n’est donc pas une caste permanente : un slot visible peut changer de stratégie entre deux voyages.

La mémoire de danse est un tableau fixe de 16 entrées par défaut, limité à 64. Une entrée conserve :

- l’identifiant de parcelle et une fleur représentative ;
- la ressource concernée ;
- une position ;
- une qualité observée, une force de recrutement et un âge.

Une rentrée profitable renforce ou remplace une entrée, puis passe par `DANCE`. La force décroît exponentiellement ; une source inactive, épuisée ou trop ancienne disparaît. Une recrutée compare seulement ces `K` entrées fixes, jamais toutes les abeilles entre elles.

Le noyau connaît l’index de la fleur candidate dès le départ afin de garantir une charge constante. L’« exploration » est donc une abstraction comportementale avec détour, inspection et découverte de parcelle, pas une perception volumétrique exhaustive.

## Visites multi-fleurs

Après chaque butinage, le stock de la fleur est diminué sans pouvoir devenir négatif. Une abeille peut rester dans la même parcelle si :

- sa charge est inférieure à 82 % de sa capacité ;
- son énergie dépasse 22 % ;
- le tirage déterministe de poursuite réussit ;
- quatre candidates au maximum fournissent une autre fleur valide.

La fleur précédente est pénalisée pour éviter un aller-retour immédiat. Sinon, l’abeille décolle vers la ruche. Les stocks se régénèrent toutes les 0,5 seconde logique : `0,12` unité de nectar par seconde, et 62 % de ce débit pour le pollen, jusqu’au plafond initial.

## Vol inertiel et contacts

Le déplacement libre n’est plus une interpolation linéaire à vitesse constante. Pour chaque représentante, le noyau conserve vitesse, cap, vitesse courante, roulis et deux phases de mouvement.

À chaque pas :

- le cap converge à vitesse bornée vers la direction désirée ;
- l’accélération et le freinage sont bornés ;
- la vitesse de croisière varie lentement ;
- deux oscillations latérales et une oscillation verticale produisent un flottement à plusieurs échelles ;
- le roulis suit le sens du virage ;
- l’approche freine selon la distance restante.

`beeFlightAcceleration` et `beeFlightFlutter` pilotent respectivement l’inertie et l’amplitude de ces écarts. Cette logique utilise seulement quelques opérations scalaires par abeille, sans bruit 3D, raycast ni objet temporaire.

Les raccords visibles de pose et de décollage sont des courbes de Hermite C1. La pose finale vient de la matrice relative `BeeForageRig` / `Flower_Forage_Root` mesurée dans Blender. En rendu :

- le corps en vol s’aligne sur la vitesse réelle, avec inclinaison de montée et roulis ;
- le corps reste globalement horizontal, au lieu de voler « debout » ;
- `TOUCHDOWN` et `FORAGE` utilisent `Forage_Bee` et la pose Blender ;
- les autres états visibles utilisent `Flight_Bee` ;
- le fondu VAT entre clips dure 0,18 seconde.

Le noyau ne calcule pas encore d’évitement géométrique des branches, accessoires ou autres abeilles.

## Entrée et sortie physiques de la ruche

`Bee.glb` fournit deux ancres :

- `Beehive_AttachPoint`, utilisée pour accrocher la ruche à l’arbre hôte ;
- `Beehive_FlightPoint`, placée sur la bouche.

À partir de la direction attache → bouche et de l’échelle de la ruche, `bees.js` calcule trois points monde : intérieur, entrée et extérieur. La sortie suit intérieur → entrée → extérieur ; le retour suit extérieur → entrée → intérieur. Les points sont recalculés après déplacement ou redimensionnement de l’arbre et de la ruche.

L’arbre hôte est choisi de façon stable : tag `hive-host`, sinon premier `Tree_02`, sinon plus grand arbre disponible.

## Économie de la colonie

### Récolte et déchargement

Le nectar transporté est séparé en sucre et eau. Au déchargement :

- le pollen alimente directement `pollenStore` ;
- le sucre et l’eau du nectar alimentent `rawNectarSugar` et `rawNectarWater`.

Les grandeurs sont des unités internes cohérentes, pas des grammes calibrés.

### Nectar brut vers miel

La maturation est agrégée et exponentielle. Sa constante est configurable par **Maturation miel (s)**. À chaque pas :

1. une fraction du nectar brut mûrit ;
2. son sucre rejoint le stock de miel ;
3. l’eau conservée est limitée à une teneur cible de 18 % ;
4. l’excès est compté comme eau évaporée.

La transformation conserve le sucre. Le modèle résume ainsi transfert de nectar, régurgitation/réingestion, activité des receveuses et ventilation sans créer des milliers d’ouvrières internes.

### Consommation, besoins et nutrition

Les adultes consomment d’abord le miel, puis le nectar brut si nécessaire. Les larves consomment le pollen. Les niveaux de sucre et de pollen produisent une nutrition interne ; une carence réduit la ponte de la reine.

La demande nectar/pollen d’un nouveau voyage prend le maximum entre :

- la demande externe courante (`0,62` nectar / `0,38` pollen dans l’intégration) ;
- le déficit calculé à partir des réserves.

Supprimer les fleurs empêche donc toute nouvelle récolte. La colonie ne crée ni nectar, ni pollen, ni miel à partir de rien ; elle finit par consommer ses réserves.

La télémétrie stable expose `rawNectar`, `honey`, `pollen`, `sugarInTransit`, `consumedSugar`, `evaporatedWater`, `knownPatches`, `scoutFraction` et les deux demandes.

## Démographie agrégée

L’intégration démarre avec 32 000 ouvrières, 3 600 œufs, 6 500 larves et 12 500 nymphes. La reine peut pondre jusqu’à 1 200 œufs par jour biologique, modulés par nutrition, saison, multiplicateur de ponte et effectif adulte.

```text
œuf 3 jours → larve 6 jours → nymphe 12 jours → adulte
```

Les cohortes utilisent 12, 24 et 48 cases de `0,25` jour. Les survies par transition valent 96 %, 94 % et 98 % ; les adultes subissent une mortalité continue de 2 % par jour biologique. L’âge avance par défaut de `0,0125` jour par seconde simulée.

Les 48 abeilles visibles par défaut sont des représentantes. Quand un slot atteint son âge de retrait, il est recyclé à l’intérieur avec nouvelle génération, énergie, préférence, orientation et mémoire individuelle. Aucun objet Three.js n’est créé ou détruit.

## Données, déterminisme et télémétrie

Positions, vitesses, caps, états, stratégies, charges, âges et transitions sont stockés en structure de tableaux (`Float32Array`, `Uint8Array`, `Int32Array`, etc.). Les vues de `getViews()`, `getColonyViews()`, `getDemographyViews()` ainsi que les objets de télémétrie gardent une identité stable.

Chaque slot possède son propre PRNG dérivé de la graine globale. Le noyau n’utilise pas `Math.random`. À graine, entrées et pas de temps identiques, les trajectoires et ressources sont reproductibles.

La boucle chaude ne construit ni tableau, ni objet, ni `Map`/`Set`, et n’appelle pas `map`, `filter`, `reduce`, `sort` ou `splice`.

## Rendu, matériaux et ombres

`BeeRigged.glb` est échantillonné à 16 images/s. Les clips `Flight_Bee` et `Forage_Bee` sont concaténés dans une VAT RGBA16F de 11 376 640 octets. Les 128 slots partagent une géométrie, une VAT, les atlas par partie et un matériau TSL.

Le champ de 256 fleurs maximum utilise un unique `InstancedMesh`. Son balancement est calculé en TSL à partir du temps, de l’instance et de la hauteur du sommet.

La ruche utilise un `MeshStandardNodeMaterial` éclairé, rugueux, non métallique et avec couleurs de sommets. Aucun terme émissif ne court-circuite l’éclairage. Tous ses maillages reçoivent séparément `castShadow` et `receiveShadow`; les mêmes réglages indépendants existent pour le draw VAT des abeilles.

Pour le sous-système abeilles seul, le budget de surface est de trois draws : fleurs, abeilles et unique primitive de ruche. Les ombres restent soumises au réglage global du moteur.

## Coûts et bornes

`MAX_BEES = 128`, `MAX_FLOWERS = 256`, mémoire sociale par défaut `K = 16`, maximum `64`.

| Travail | Complexité | Fréquence |
|---|---:|---|
| États, vol, énergie et télémétrie visible | O(B) | chaque pas logique |
| Décroissance de la mémoire sociale | O(K) borné | chaque pas logique |
| Consultation d’une danse | O(K) borné | au départ d’une recrutée |
| Choix direct d’une fleur | 4 candidates, O(1) | départ et visite suivante |
| Économie nectar/miel/pollen | O(1) | chaque pas logique |
| Ponte et mortalité | O(1) | chaque pas logique |
| Cohortes | 84 cases fixes | par quantum biologique |
| Régénération florale | O(F) | environ 2 Hz |
| Upload des abeilles visibles | O(B) | une fois par frame |
| Reconstruction florale | O(F), rejet borné | seulement après réglage/décor |

Le coût ne dépend ni des 32 000 adultes agrégés, ni d’un produit abeilles × fleurs. Il n’existe ni recherche globale de fleurs, ni collision inter-abeilles, ni squelette animé par individu.

## Réglages exposés

Dans **Graphismes → 🌼 Pollinisateurs** :

| Réglage | Défaut | UI | Effet |
|---|---:|---:|---|
| Activer | oui | booléen | simulation, rendu et chargement paresseux |
| Abeilles visibles | 48 | 0–128 | slots représentatifs |
| Taille abeilles | 1 | 0,4–2,5 | échelle des instances |
| Vitesse de vol | 8 | 2–16 | vitesse maximale principale |
| Part d’éclaireuses | 0,18 | 0–0,6 | propension de base à explorer |
| Accélération | 18 | 2–50 | accélération/freinage du vol |
| Flottement multi-échelle | 0,28 | 0–1,5 | amplitude des écarts organiques |
| Butinage sur fleur | 10 s | 2–40 s | durée centrale, variation 0,7× à 1,5× |
| Maturation miel | 90 s | 10–600 s | constante de maturation agrégée |
| Nectar initial | 48 | 0–1 000 | réserve brute appliquée au reset |
| Miel initial | 180 | 0–5 000 | réserve appliquée au reset |
| Pollen initial | 72 | 0–1 000 | réserve appliquée au reset |
| Lumière du jour | 1 | 0–1 | condition lumineuse des départs |
| Température | 22 °C | 5–38 °C | condition thermique des départs |
| Pluie | 0 | 0–1 | inhibition progressive |
| Vent | 1 m/s | 0–10 m/s | inhibition progressive |
| Fleurs | 128 | 0–256 | nombre d’instances |
| Taille fleurs | 1,45 | 0,4–3 | échelle moyenne |
| Variation fleurs | 0,35 | 0–1 | dispersion d’échelle |
| Mouvement fleurs | 0,32 | 0–1,5 | balancement TSL |
| Ombres abeilles | oui/oui | 2 booléens | projection et réception |
| Taille ruche | 0,72 | 0,35–1,5 | échelle et corridor d’entrée |
| Ombres ruche | oui/oui | 2 booléens | projection et réception |

Les couleurs des fleurs, abeilles et ailes restent modifiables en direct. Nombre, taille et variation des fleurs reconstruisent uniquement le layout et les stocks. Les trois réserves « initiales » ne modifient pas une partie en cours : elles sont lues au reset.

## Limites connues

- Reine, couvain, receveuses, ventileuses et réserves sont agrégés, sans individus 3D dans la ruche.
- Les mâles, nourrices détaillées, rayons de cire, operculation visible, essaimage, maladies et génétique ne sont pas simulés.
- La danse est une mémoire de parcelles et un état caché, pas une chorégraphie visible ni une transmission individu par individu.
- L’exploration utilise une cible candidate interne pour rester bornée ; ce n’est pas une carte sensorielle continue.
- Les trajectoires sont continues et organiques, mais n’évitent pas encore les obstacles du décor et ne modélisent ni vent physique ni collisions entre abeilles.
- La pollinisation végétale, la production de graines et les échanges avec la fourmilière ne sont pas implémentés.
- Lumière du jour et météo sont des contrôles manuels, indépendants du ciel visuel.
- Les unités de ressource, consommations et cadences sont réglées pour une simulation lisible, pas calibrées comme mesures de terrain.

## Preuves automatiques

`test/bee-simulation.test.js` conserve `BEE-SIM-001` à `017` : stockage SoA stable, reproductibilité, cycle complet, météo, sélection bornée, debug, absence d’allocation chaude, cohortes, vieillissement, recyclage, phases VAT et continuité Hermite.

`test/bee-colony-ecology.test.js` ajoute :

- `BEE-ECO-001` : traversée continue de la bouche dans les deux sens, visibilité jusqu’à l’intérieur ;
- `BEE-ECO-002` : éclaireuses, mémoire bornée, danse et voyages recrutés ;
- `BEE-ECO-003` : aucune ressource inventée, stocks floraux jamais négatifs ;
- `BEE-ECO-004` : maturation avec conservation du sucre ;
- `BEE-ECO-005` : conservation du sucre entre fleur, transport, nectar brut, miel et consommation ;
- `BEE-ECO-006` : accélération, freinage et trajectoires non rectilignes sans saut ;
- `BEE-ECO-007` : mémoire fixe et travail de sélection indépendant du nombre de fleurs.

`test/pollinator-integration.test.js` protège layout, fallback borné, arbre hôte, contrats GLB, budget VAT, trois draws, masquage souterrain, chargement paresseux, pose Blender et ombres indépendantes.

## Fondements scientifiques

Les règles restent volontairement compactes, mais s’appuient sur les comportements suivants :

- la danse communique direction et distance d’une source, avec une allocation du nectar fortement guidée par l’offre : [Dance-communicated distances support nectar foraging as a supply-driven system](https://pmc.ncbi.nlm.nih.gov/articles/PMC9428537/) ;
- éclaireuses et recrutées emploient des stratégies distinctes, influencées par qualité et distance : [Honey bee foraging strategies and the social information they use](https://pmc.ncbi.nlm.nih.gov/articles/PMC11470012/) ;
- attente dans la ruche, exploration, recrutement, fidélité et abandon d’une source forment un système collectif : [Systems analysis of honey bee foraging](https://pmc.ncbi.nlm.nih.gov/articles/PMC3810709/) ;
- les butineuses peuvent se spécialiser par voyage tout en restant plastiques au cours de leur vie : [Division of labor in honey bees](https://pmc.ncbi.nlm.nih.gov/articles/PMC2810364/) ;
- le nectar est transféré à des receveuses puis concentré par manipulations et évaporation : [Nectar processing by honey bees](https://pmc.ncbi.nlm.nih.gov/articles/PMC9519551/) et [Honey maturation inside the hive](https://pmc.ncbi.nlm.nih.gov/articles/PMC9359632/) ;
- l’atterrissage repose sur une décélération progressive pilotée par le flux visuel : [Honeybees use optic flow to control landing](https://pmc.ncbi.nlm.nih.gov/articles/PMC3831993/) et [Landing dynamics of honeybees](https://pmc.ncbi.nlm.nih.gov/articles/PMC7540786/) ;
- la vitesse est adaptée à l’espace visuel et les obstacles déclenchent ralentissement puis déviation : [Flight speed control in honeybees](https://pmc.ncbi.nlm.nih.gov/articles/PMC3093387/) et [Honeybee collision-avoidance behaviour](https://pmc.ncbi.nlm.nih.gov/articles/PMC10973882/).

Le code transpose ces résultats en états, seuils et réservoirs déterministes. Il ne reproduit ni les protocoles expérimentaux ni leur calibration par espèce, saison et paysage.
