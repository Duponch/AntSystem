# BEE-SIM — Abeilles et pollinisateurs

## Objet du contrat

`BEE-SIM` décrit deux niveaux complémentaires : une colonie d’*Apis mellifera* suivie par démographie agrégée et une population bornée de représentantes butineuses visibles à la surface. Chaque représentante peut s’orienter autour de la ruche, choisir une ressource, rejoindre une fleur, récolter du nectar ou du pollen, rentrer, décharger puis se reposer. Le noyau est déterministe, indépendant de Three.js et directement consommable par un rendu instancié.

Ce système est une abstraction biologique lisible, pas une seconde simulation complète de colonie. Il ne partage ni population, ni ressources, ni décisions avec les fourmis. Une visite de fleur modifie le stock local utilisé par les abeilles, mais ne produit actuellement aucun effet de pollinisation, de reproduction végétale ou de nourriture pour la fourmilière.

## Frontières d’architecture

La chaîne est divisée en cinq couches :

1. `pollinator-layout.js` construit un champ de fleurs déterministe en parcelles, hors du centre de jeu, des arbres et des obstacles ;
2. `bee-simulation.js` avance la démographie agrégée, les intentions, positions, réserves et métriques sans importer Three.js ;
3. `pollinator-assets.js` prépare une géométrie de fleur fusionnée, la ruche et les animations VAT de l’abeille ;
4. `bees.js` relie le noyau aux instances GPU, à la ruche attachée à un arbre et aux réglages de l’interface ;
5. `pollinators.js` fournit une façade stable et charge les ressources à la demande lorsque le système est activé.

La même façade héberge aussi le sous-système optionnel de papillons, dont le cycle et le budget sont définis séparément par [`BUTTERFLY-SIM`](./papillons.md). Les papillons partagent le champ floral et la météo, mais ni la démographie ni les décisions des abeilles.

Lorsque **Activer** est vrai au lancement, `main.js` charge les trois ressources d’abeilles en parallèle avec le décor puis crée le système après l’initialisation du monde. Si **Papillons** est également actif, sa VAT est préparée en parallèle par une promesse distincte et unique. Si le réglage parent persisté vaut faux, aucun GLB de pollinisateur n’est demandé et aucune texture VAT n’est allouée. La façade reste disponible ; une réactivation déclenche un unique chargement asynchrone partagé. Le système avance avec le temps simulé puis se masque avec les autres éléments de surface lorsque la caméra entre sous terre. Un reset recrée le noyau avec la même graine, les mêmes cohortes initiales et les stocks floraux initiaux.

La ruche choisit son arbre hôte de manière stable : placement portant le tag `hive-host`, sinon premier modèle `Tree_02`, sinon plus grand arbre disponible. Les nœuds `Beehive_AttachPoint` et `Beehive_FlightPoint` de `Bee.glb` définissent respectivement l’accroche et le point de départ réel des vols. Une modification du décor ou de l’échelle des arbres invalide cette ancre sans recréer la population.

## Abstraction biologique

Le noyau conserve onze états explicites :

| État | Interprétation | Position visible |
|---|---|---|
| `IN_HIVE` | attente dans la ruche et récupération d’énergie | cachée |
| `ORIENTATION` | un ou deux premiers vols locaux pour acquérir des repères | autour de l’entrée |
| `OUTBOUND` | vol principal vers une fleur assignée | entre ruche et parcelle |
| `APPROACH` | descente lente et précise vers la fleur | près de la cible |
| `TOUCHDOWN` | pose amortie par une courbe de Hermite C1 | contact progressif avec la fleur |
| `FORAGE` | récolte sur la fleur | posée sur la cible |
| `TAKEOFF` | retrait fluide depuis la fleur, vitesse initiale nulle | juste au-dessus de la cible |
| `DEPART` | raccord C1 entre le décollage et le vol principal | sortie de la fleur ou de la ruche |
| `RETURN` | retour direct vers l’entrée | entre parcelle et ruche |
| `UNLOAD` | déchargement de nectar ou pollen | brièvement à l’entrée |
| `REST` | récupération après un trajet | cachée |

Les slots visibles sont des représentantes de la population adulte agrégée, pas des abeilles suivies une à une dans toute la ruche. À leur première génération, elles commencent à la ruche à un âge abstrait de 18 à 26 jours et effectuent une ou deux orientations avant leur premier trajet productif. Lorsqu’une représentante atteint son âge de retrait, le même slot préalloué est recyclé à l’entrée comme une génération suivante : âge, expérience, énergie, charge, préférence et mémoire sont réinitialisés, sans créer ni détruire d’objet de rendu.

Les durées de comportement sont exprimées en secondes de jeu ; le séjour sur une fleur vaut 10 s par défaut, avec une variation déterministe de 0,7× à 1,5×. Ce temps de butinage est indépendant des attentes et trajets. L’âge biologique avance par défaut de `0,0125` jour par seconde simulée. Ces valeurs produisent une cadence lisible, mais ne constituent pas une prédiction démographique calibrée d’une ruche réelle.

### Démographie agrégée

Le runtime démarre avec 32 000 ouvrières adultes, 3 600 œufs, 6 500 larves et 12 500 nymphes. La reine est présente et peut pondre jusqu’à 1 200 œufs par jour biologique. La ponte est modulée séparément par la nutrition, la saison, un multiplicateur de ponte et la proportion d’ouvrières par rapport au seuil de pleine capacité. L’intégration actuelle maintient reine, nutrition, saison et multiplicateur respectivement à `true`, `1`, `1` et `1`.

Le couvain traverse trois files de cohortes à délai fixe :

```text
œuf 3 jours → larve 6 jours → nymphe 12 jours → ouvrière adulte
```

Une ponte fraîche produit donc une adulte après environ 21 jours biologiques. Les stocks initiaux sont répartis uniformément dans chaque file et représentent un couvain déjà mélangé en âge ; certaines nymphes initiales peuvent ainsi émerger bien avant 21 jours. Les transitions appliquent par défaut 96 % de survie des œufs, 94 % des larves et 98 % des nymphes. La population adulte subit parallèlement une mortalité continue de 2 % par jour biologique.

Ces quantités sont des masses agrégées, potentiellement fractionnaires. Elles ne créent aucun individu, squelette ou draw supplémentaire. Les cohortes avancent par quanta fixes de `0,25` jour dans 12, 24 et 48 cases préallouées. Leur coût dépend uniquement de cette résolution, jamais des 32 000 ouvrières représentées.

### Départ et météo

Le droit de partir dépend d’un score continu :

```text
condition =
  lumière(0,08 → 0,32)
  × température(10 → 16 °C)
  × (1 − pluie)
  × vent(3 → 7 m/s)
```

Chaque terme est lissé entre 0 et 1. Un départ est autorisé lorsque le produit atteint `0,16` et que l’énergie vaut au moins `0,35`. Une abeille déjà dehors ne se téléporte pas si les conditions se dégradent : elle termine son état courant ou rentre lorsqu’une cible devient invalide ou que son énergie devient trop faible.

Le réglage **Lumière du jour** alimente directement `context.daylight` à chaque frame, comme la température, la pluie et le vent. Une valeur de `0` empêche tout nouveau départ ; `1` représente le plein jour. Ce contrôle reste manuel et n’est pas automatiquement synchronisé avec l’heure visuelle du ciel. Le vent limite les départs mais ne déforme pas physiquement les trajectoires.

La météo et la lumière contrôlent l’activité de butinage, jamais le vieillissement biologique : couvain, ponte et mortalité continuent d’avancer sous la pluie, dans l’obscurité ou par vent fort tant que le sous-système reste activé.

### Nectar, pollen et choix d’une fleur

La ressource est choisie à chaque nouveau trajet. La demande globale nectar/pollen est combinée avec une préférence individuelle : cette préférence oriente la décision sans devenir une caste rigide. Dans l’intégration actuelle, la demande reste fixe à `0,62` pour le nectar et `0,38` pour le pollen.

Une abeille ne parcourt jamais toutes les fleurs. Elle échantillonne exactement quatre candidates et leur attribue un score combinant :

- stock disponible pour la ressource choisie ;
- qualité de la fleur ;
- fidélité à la dernière parcelle visitée ;
- faible pénalité de distance.

La meilleure candidate valide devient `targetFlower` et son groupe devient `targetPatch`. Après une récolte, l’abeille peut visiter une autre fleur si sa charge reste sous 82 %, son énergie au-dessus de 22 % et le tirage déterministe l’autorise. Sinon elle rentre. Les fleurs disposent de stocks de nectar et de pollen séparés ; ils se régénèrent toutes les 0,5 seconde environ, avec un renouvellement du pollen plus lent que celui du nectar.

Cette mémoire de parcelle représente la fidélité locale d’une butineuse. Il n’existe actuellement ni recrutement social, ni danse frétillante, ni transmission d’une destination entre individus.

## SoA déterministe

`BeeSimulation` préalloue tous ses tableaux à la capacité maximale. Les états discrets utilisent des `Uint8Array`, `Uint32Array` ou `Int32Array`; positions, directions et grandeurs continues utilisent des `Float32Array`. Les âges de retrait et générations permettent de recycler les représentantes sans modifier ces capacités.

Les trois files démographiques utilisent des `Float64Array` de taille fixe. Les vues retournées par `getViews()` et `getDemographyViews()`, l’objet retourné par `getTelemetry()` et sa section `demography` conservent la même identité pendant toute la vie du noyau.

Chaque abeille possède son propre état de générateur pseudo-aléatoire, dérivé de la graine globale et de son index. Le noyau n’appelle jamais `Math.random`. À graine, paramètres, contexte et pas de temps identiques, trajectoires, états, stocks et télémétrie sont identiques octet par octet.

La boucle chaude ne crée ni tableau, ni objet, ni collection. La télémétrie réutilise des buffers stables et expose notamment états, abeilles en vol, en récolte ou à la ruche, trajets commencés/terminés, visites, retours annulés, ressources livrées et distance cumulée. Sa section démographique expose présence de la reine, rythme de ponte, œufs, larves, nymphes, adultes, émergences, décès et ouvrières représentées par slot. `writeDebugRecord(index, objet)` et `snapshot(index)` fournissent à la demande l’intention, l’âge de retrait, la génération et le poids représenté d’un slot sans imposer d’allocation au rendu normal.

## Fleurs déterministes

Le champ est réparti par défaut en neuf parcelles irrégulières autour du centre. Une graine fixe produit positions, rotations, tailles et identifiants de parcelle reproductibles. La génération utilise une boucle de rejet bornée seulement lors de la construction ou après un changement de réglage. Elle évite :

- un disque central de 13 unités ;
- les arbres, avec une marge dérivée de leur taille ;
- les obstacles, avec une marge dérivée de leur empreinte ;
- les bords du monde.

Les rayons d’exclusion tiennent compte de l’échelle courante des catégories arbres et obstacles. La révision du décor est surveillée : ajout, déplacement, suppression ou redimensionnement invalide le champ, qui est reconstruit avec les nouvelles marges. Si un décor édité trop dense épuise le budget de rejet, les dernières fleurs sont placées sur un anneau de repli déterministe. Les capacités et la taille des tableaux restent ainsi cohérentes.

## VAT, atlas et instanciation

`BeeRigged.glb` est chargé une seule fois. `loadVATMulti()` échantillonne `Flight_Bee` et `Forage_Bee` à 16 images par seconde, concatène leurs positions de sommets dans une texture RGBA16F et normalise l’envergure du modèle à 0,72 unité. Les UV, les atlas de couleur par sous-maillage et les bornes des différentes parties du modèle sont conservés. `colorMaps` maintient l’alignement corps/yeux/trompe/ailes ; `colorMap` reste le premier atlas disponible pour la compatibilité et les fallbacks.

Toutes les abeilles extérieures partagent ensuite :

- une géométrie indexée ;
- une texture VAT multi-clips ;
- les atlas distincts du corps, des yeux et des ailes ;
- un matériau TSL ;
- quatre attributs d’instance dynamiques : pose, quaternion, animation et fondu.

Le shader interpole deux lignes VAT du clip courant et peut fondre le clip précédent pendant `0,18` seconde. Le corps échantillonne son atlas puis reçoit la teinte utilisateur, les yeux conservent leur atlas dédié, les ailes combinent leur propre atlas avec leur teinte et la trompe conserve une couleur fixe. Ce découpage reste dans le matériau instancié unique. Le rendu reprend directement les positions autoritatives de la simulation : aucune surélévation ou oscillation secondaire ne peut introduire un saut lors d’un changement d’état.

La phase d’animation est attachée au clip visuel, pas au nom de l’état comportemental. `ORIENTATION`, `OUTBOUND`, `APPROACH`, `TAKEOFF`, `DEPART` et `RETURN` partagent `FLIGHT`; `TOUCHDOWN`, `FORAGE` et `UNLOAD` utilisent `FORAGE`. Le clip de butinage démarre donc pendant la pose et continue sur la fleur sans redémarrage. Le quaternion du corps est lissé vers la direction de vitesse en vol — l’axe tête-abdomen reste presque horizontal — puis vers la pose de référence Blender pendant le butinage.

La pose sur la fleur n’est pas estimée au centre du modèle. `FLOWER_CONTACT_*` et `FORAGE_ATTITUDE` proviennent de la matrice relative mesurée entre `BeeForageRig` et `Flower_Forage_Root` dans `bestiaire_backup.blend`, puis convertie dans le repère normalisé de `Flower.glb`. La rotation aléatoire de chaque fleur est appliquée au point de contact et au quaternion. Ainsi la trompe, les pattes et le corps retrouvent la composition validée dans Blender.

Les fleurs partagent une géométrie unique normalisée à une unité de haut et fusionnée avec ses couleurs de sommets. Un seul `InstancedMesh` contient jusqu’à 256 fleurs. Le balancement est calculé dans le matériau TSL à partir du temps, de l’index d’instance et de la hauteur du sommet ; aucun squelette ni mise à jour individuelle n’est nécessaire.

## Budget et complexité

Les bornes actuelles sont `MAX_BEES = 128` et `MAX_FLOWERS = 256`.

| Travail | Complexité | Fréquence |
|---|---:|---|
| États et mouvement des abeilles | O(B) | chaque pas simulé |
| Choix de cible | 4 candidates, donc O(1) par décision | au départ et entre visites |
| Ponte, mortalité et télémétrie démographique | O(1) | chaque pas simulé |
| Transition des cohortes | 12 + 24 + 48 cases fixes ; O(1) par quantum | tous les 0,25 jour biologique |
| Écriture des attributs GPU | O(B) | chaque frame visible |
| Régénération des stocks | O(F) | environ 2 Hz |
| Reconstruction du champ | O(F) avec rejet borné | seulement après réglage/décor |

Le GPU utilise un draw pour toutes les abeilles extérieures et un draw pour toutes les fleurs, indépendamment de leur nombre actif. La ruche reste une scène GLB statique. Le coût visuel augmente donc linéairement avec le nombre de représentantes borné, jamais avec le produit abeilles × fleurs. Le coût démographique ne dépend ni du nombre d’adultes ni du nombre d’éléments de couvain : seuls les compteurs et les 84 cases de cohortes fixes sont mis à jour. Aucun pathfinding global, raycast, collision inter-abeilles ou recherche exhaustive de fleurs n’est exécuté.

Ce budget structurel ne remplace pas une mesure GPU. Aucun seuil p95 portable n’est encore imposé pour ce sous-système.

## Réglages exposés

Dans **Graphismes → 🌼 Pollinisateurs** :

| Réglage | Défaut | Intervalle UI | Effet |
|---|---:|---:|---|
| Activer | oui | booléen | avance et affiche le sous-système ; persisté à faux, évite aussi le chargement des GLB et le bake VAT au démarrage |
| Abeilles visibles | 48 | 0–128 | nombre de représentantes simulées et rendues ; celles dans la ruche restent cachées |
| Taille abeilles | 1 | 0,4–2,5 | échelle des instances |
| Vitesse de vol | 8 | 2–16 | vitesse du trajet principal |
| Butinage sur fleur | 10 s | 2–40 s | durée centrale du clip et de la récolte ; variation déterministe de 0,7× à 1,5× |
| Lumière du jour | 1 | 0–1 | condition lumineuse manuelle ; `0` interdit les nouveaux départs |
| Température | 22 °C | 5–38 °C | facteur de départ |
| Pluie | 0 | 0–1 | inhibition progressive des départs |
| Vent | 1 m/s | 0–10 m/s | inhibition progressive au-delà de 3 m/s |
| Fleurs | 128 | 0–256 | taille du champ reconstruit à la fin du réglage |
| Taille fleurs | 1,45 | 0,4–3 | échelle moyenne, avec reconstruction |
| Variation fleurs | 0,35 | 0–1 | dispersion des tailles, avec reconstruction |
| Mouvement fleurs | 0,32 | 0–1,5 | amplitude du balancement TSL |
| Teintes pétales/tiges | palette claire/verte | couleurs | uniformes du matériau des fleurs |
| Teintes abeilles/ailes | blanc/bleu clair | couleurs | uniformes conservant l’atlas |
| Ombres abeilles — projeter/recevoir | oui/oui | booléens indépendants | active séparément la passe de projection et la réception sur le draw VAT |
| Taille ruche | 0,72 | 0,35–1,5 | échelle de la ruche et de son point de vol |
| Ombres ruche — projeter/recevoir | oui/oui | booléens indépendants | applique les drapeaux à chaque maillage de la hiérarchie GLB |

Les valeurs persistées sont ramenées dans des bornes de sécurité légèrement plus larges dans `config.js`. Les couleurs, le mouvement des fleurs, la taille des abeilles et la météo sont appliqués en direct. Nombre, taille et variation des fleurs reconstruisent uniquement leurs matrices et stocks lorsque l’utilisateur relâche le contrôle.

## Limites connues

- La reine, le couvain en trois stades, les émergences et la mortalité adulte existent sous forme de compteurs agrégés uniquement. Aucun individu, rayon ou comportement de reine, d’œuf, de larve ou de nymphe n’est dessiné.
- Les mâles, nourrices, tâches internes, construction des rayons, essaimage et maladies ne sont pas modélisés.
- Les représentantes visibles sont recyclées entre générations et ne correspondent pas une pour une aux ouvrières agrégées ; aucun cadavre ou remplacement individuel n’est rendu.
- La ruche et les ressources d’abeilles n’alimentent pas l’économie de la fourmilière.
- La « pollinisation » est pour l’instant une visite et une récolte : elle ne féconde pas les plantes et ne produit pas de graines.
- Il n’existe ni danse frétillante, ni recrutement, ni connaissance collective des parcelles.
- La demande nectar/pollen reste fixe. Reine, nutrition, saison et multiplicateur de ponte ne disposent pas encore de contrôles dédiés dans l’UI.
- **Lumière du jour** agit bien sur les départs, mais reste un réglage manuel indépendant du cycle visuel du ciel.
- Les trajectoires sont continues ; pose, décollage et raccord au vol utilisent des courbes de Hermite C1 sans correction graphique ni téléportation. Elles n’évitent toutefois pas les branches, les accessoires, les autres abeilles ou des obstacles dynamiques.
- Le vent et la pluie modulent le départ ; ils ne poussent pas physiquement une abeille déjà en vol.
- L’inspecteur principal suit les fourmis. Les instantanés d’abeille existent dans l’API de débogage, mais pas encore dans une fiche UI dédiée.
- Désactiver **Activer** fige le sous-système et le cache. Si cette valeur est persistée puis le jeu relancé, les assets ne sont pas chargés ; une réactivation les charge une seule fois en arrière-plan. La plongée sous terre masque le système mais continue de l’avancer tant qu’il reste activé.
- La fidélité à une parcelle, les seuils météo et les cadences sont des choix de simulation inspirés de la littérature, pas des paramètres validés pour prédire une ruche réelle.

## Preuves automatiques

`test/bee-simulation.test.js` protège les invariants fonctionnels du noyau :

- `BEE-SIM-001` : vues SoA préallouées et identités stables ;
- `BEE-SIM-002` : trajectoires octet-identiques à graine et entrées identiques ;
- `BEE-SIM-003` : cycle complet atteignable et livraison productive ;
- `BEE-SIM-004` : obscurité et météo dangereuse interdisent les départs sans dérive hors ruche ;
- `BEE-SIM-005` : cibles fleur/parcelle indexées et budget fixe de quatre candidates ;
- `BEE-SIM-006` : instantané individuel lisible sans modifier le stockage chaud ;
- `BEE-SIM-007` : absence de hasard ambiant et de construction de collection dans `update()` et l’avancement des cohortes ;
- `BEE-SIM-008` : progression exacte des cohortes sur 3 + 6 + 12 jours ;
- `BEE-SIM-009` : météo et lumière modulent l’activité sans altérer le vieillissement ;
- `BEE-SIM-010` : buffers et objets de télémétrie démographiques stables ;
- `BEE-SIM-011` : travail démographique indépendant de la taille de colonie représentée ;
- `BEE-SIM-012` : recyclage déterministe des représentantes arrivées à leur âge de retrait ;
- `BEE-SIM-013` : répartition initiale uniforme et déterministe du couvain dans les cohortes ;
- `BEE-SIM-014` : phase conservée entre états partageant `FLIGHT`, remise à zéro seulement lors d’un changement de clip visible `FLIGHT` ↔ `FORAGE`.
- `BEE-SIM-015` : durée de butinage indépendante, configurable et variation déterministe bornée ;
- `BEE-SIM-016` : cycle pose–butinage–décollage–départ sans saut visible ;
- `BEE-SIM-017` : raccords Hermite avec positions et vitesses de bord cohérentes ;

`test/pollinator-integration.test.js` complète ce noyau avec `POLLINATOR-001` à `010` : layout et fallback bornés, priorité de l’arbre hôte, contrats réels des GLB (ancres, clips, atlas distincts et canal `COLOR_0` brun non uniforme), budget VAT maximal de 12 Mio, trois draws de surface, masquage souterrain, exclusions sensibles aux échelles du décor, démarrage paresseux, ancrage Blender exact, clips de pose et six drapeaux d’ombre indépendants.

Ces tests ne figent pas une image. L’orientation du modèle, les teintes, les fondus d’animation, l’accroche de la ruche, la lisibilité des fleurs et l’absence d’artefact WebGPU demandent une inspection visuelle ciblée.

## Sources biologiques et portée

Les publications suivantes justifient les grandes idées retenues, sans transformer le noyau en reproduction quantitative de leurs expériences :

- Capaldi et al., [*Ontogeny of orientation flight in the honeybee revealed by harmonic radar*](https://doi.org/10.1038/35000564), *Nature* 403 (2000) : vols d’orientation répétés et apprentissage progressif autour de la ruche ;
- Clarke et Robert, [*Predictive modelling of honey bee foraging activity using local weather conditions*](https://doi.org/10.1007/s13592-018-0565-3), *Apidologie* 49 (2018) : relation entre activité de sortie, température, lumière et conditions météorologiques ;
- Seeley, [*Social foraging by honeybees: how colonies allocate foragers among patches of flowers*](https://doi.org/10.1007/BF00295707), *Behavioral Ecology and Sociobiology* 19 (1986) : allocation des butineuses entre parcelles ;
- Cook et al., [*Task allocation and site fidelity jointly influence foraging regulation in honeybee colonies*](https://doi.org/10.1098/rsos.170344), *Royal Society Open Science* 4 (2017) : spécialisation de tâche et persistance envers un site ;
- Moreno et Arenas, [*Foraging task specialization in honey bees: the contribution of floral rewards to the learning performance of pollen and nectar foragers*](https://doi.org/10.1242/jeb.246979), *Journal of Experimental Biology* 227 (2024) : différences individuelles entre butineuses de nectar et de pollen.

Le code retient orientation, météo, demande, préférence, mémoire de parcelle et renouvellement démographique sous forme de règles compactes. Il n’implémente ni les protocoles expérimentaux, ni leur incertitude, ni une calibration par espèce, saison ou paysage.
