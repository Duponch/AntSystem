# BUTTERFLY-SIM — Cycle de vie et rendu des papillons

## Objet du contrat

`BUTTERFLY-SIM` ajoute une population bornée de papillons à la surface. Chaque slot représente une lignée qui traverse continuellement le cycle :

```text
ŒUF → LARVE → CHRYSALIDE → ADULTE → ŒUF
```

Les trois stades immatures sont calculés mais volontairement abstraits et invisibles. Seul l’adulte possède une position rendue et alterne entre `FLY`, `FEED` et `REST`. Il choisit une fleur, vole vers elle, s’y nourrit, puis se repose avant une nouvelle sortie.

Les durées sont accélérées pour rendre un cycle complet observable pendant une partie. Elles constituent une abstraction ludique, pas un modèle biologique prédictif. Les papillons ne partagent ni population, ni reproduction, ni réserves avec les abeilles ou les fourmis.

## Frontières d’architecture

La fonctionnalité est divisée en quatre couches :

1. `butterfly-simulation.js` avance le cycle de vie et l’activité adulte sans dépendre de Three.js ;
2. `pollinator-assets.js` transforme `Butterfly.glb` en animation de sommets VAT ;
3. `butterflies.js` écrit les adultes visibles dans un unique rendu instancié ;
4. `pollinators.js` partage les fleurs et les conditions météo des abeilles, puis charge le papillon à la demande.

Le champ floral est celui de `BEE-SIM`. Les papillons lisent les mêmes positions, parcelles, qualités et stocks de nectar que les abeilles. Une visite prélève une faible quantité du stock partagé. Aucun champ de fleurs, maillage ou recherche spatiale supplémentaire n’est créé pour eux.

Le sous-système n’est chargé que si **Pollinisateurs** et **Papillons** sont tous deux actifs. Une activation tardive réutilise une unique promesse de chargement. Passer sous terre masque le rendu avec les autres éléments de surface ; le cycle reste une simulation de surface indépendante de la fourmilière.

## Cycle de vie

Chaque slot conserve son stade, le temps restant dans ce stade, l’âge cumulé de la lignée et son numéro de génération. Les durées nominales par défaut, exprimées en secondes simulées, sont volontairement courtes :

| Stade | Durée minimale | Plage déterministe ajoutée | Visible |
|---|---:|---:|---|
| Œuf | 5 s | 0 à 1,5 s | non |
| Larve | 8 s | 0 à 2 s | non |
| Chrysalide | 6 s | 0 à 1,5 s | non |
| Adulte | 32 s | 0 à 10 s | oui |

La dispersion et le décalage initial empêchent toute la population de changer de stade au même instant. À la fin du stade adulte, le slot recommence à l’œuf et incrémente sa génération. Il n’est ni détruit ni remplacé par un nouvel objet JavaScript ou GPU.

Le réglage **Vitesse du cycle** multiplie le vieillissement. La météo et la lumière ne modifient jamais cette horloge : un œuf éclot, une larve devient chrysalide et un adulte termine son cycle même dans l’obscurité, sous la pluie, par vent fort ou à basse température. Ces conditions gouvernent seulement l’activité extérieure de l’adulte.

Le noyau borne à huit le nombre de transitions de stade rattrapées dans un seul appel à `update()`. Cette protection concerne uniquement un très grand pas de temps artificiel ; la télémétrie compte tout écrêtage éventuel.

## Activité de l’adulte

Un adulte visible possède trois comportements :

| État | Interprétation |
|---|---|
| `REST` | attente locale ; aucune nouvelle sortie si les conditions sont défavorables |
| `FLY` | déplacement continu vers une fleur directement indexée |
| `FEED` | courte visite posée sur la fleur et prélèvement de nectar |

La condition de vol combine lumière du jour, température, pluie et vent issus des réglages d’abeilles. Une mauvaise condition garde un adulte au repos ; un papillon déjà en vol interrompt sa sortie et redescend progressivement, sans téléportation ni suspension de son vieillissement.

À chaque départ, le papillon échantillonne exactement quatre fleurs. Le score privilégie une cible active, pourvue de nectar, de bonne qualité et appartenant à la dernière parcelle visitée, avec une faible pénalité de distance. Le nombre de candidates ne dépend donc ni du nombre total de fleurs ni du nombre de papillons.

Un délai de vol borné ramène au repos un trajet qui ne pourrait pas aboutir. Les positions, directions normalisées, cibles et intentions restent accessibles dans les vues SoA et dans l’enregistrement de diagnostic d’un slot.

## Déterminisme et stockage SoA

`ButterflySimulation` préalloue une structure de tableaux de capacité `MAX_BUTTERFLIES = 64` :

- `Uint8Array` pour le stade, le comportement et la visibilité ;
- `Int32Array` pour la fleur et la parcelle ciblées ;
- `Uint32Array` pour la génération et l’état pseudo-aléatoire ;
- `Float32Array` pour position, direction, âges et phase d’animation.

Le nombre choisi dans l’UI indique le nombre de **lignées simulées**, pas un minimum d’adultes visibles. Lorsqu’une lignée est œuf, larve ou chrysalide, son slot reste actif dans le noyau mais n’est pas envoyé au rendu. Il est donc normal que le nombre de papillons à l’écran varie et soit inférieur au réglage.

Chaque slot possède un générateur pseudo-aléatoire dérivé de la graine globale et de son index. La boucle chaude n’utilise jamais `Math.random`, ne construit aucune collection et réutilise les vues ainsi que la télémétrie. À graine, réglages, fleurs et pas de temps identiques, les transitions et trajectoires sont identiques.

Ajouter ou retirer des lignées ajuste seulement le préfixe actif des buffers fixes. Aucune capacité n’est redimensionnée.

## Asset, VAT et rendu

`Butterfly.glb` contient :

| Propriété | Valeur contractuelle |
|---|---:|
| Sommets | 1 105 |
| Triangles | 528 |
| Joints | 13 |
| Animation | `Flight_Butterfly` |
| Durée du clip | 5,0417 s |
| Échantillonnage VAT | 16 images/s, 81 images |

`loadVATMulti()` échantillonne les 1 105 sommets sur 81 lignes. La texture RGBA16F occupe exactement :

```text
1 105 × 81 × 4 canaux × 2 octets = 716 040 octets
```

Les UV et l’atlas de couleur sont conservés. Un seul `MeshStandardNodeMaterial` TSL interpole deux lignes VAT, applique la teinte utilisateur et éclaire les instances comme un objet de surface. Trois attributs dynamiques transportent position/échelle, quaternion et phase.

Tous les adultes visibles utilisent **un seul draw**, quel que soit leur nombre entre 0 et 64. Les stades immatures n’écrivent aucune instance. Le coût CPU d’une frame est O(P) pour P slots actifs, avec une recherche de cible constante à quatre candidates. Le coût ne dépend jamais du nombre de fourmis.

Le plafond de 64 slots est trop faible pour justifier un compute shader : son dispatch, ses buffers et sa synchronisation ajouteraient davantage de complexité que de travail utile. Le noyau SoA CPU et l’unique draw VAT sont le budget retenu.

## Réglages exposés

Dans **Graphismes → 🌼 Pollinisateurs → 🦋 Papillons** :

| Réglage | Défaut | Effet |
|---|---:|---|
| Activer | oui | charge, avance et affiche le sous-système avec le parent Pollinisateurs |
| Nombre | 18 | nombre de lignées simulées, de 0 à 64 ; les adultes seuls sont visibles |
| Échelle | 1 | taille des instances rendues |
| Vitesse de vol | 4,8 | vitesse des trajets adultes |
| Vitesse du cycle | 1 | multiplicateur du vieillissement des quatre stades |
| Teinte | blanc | multiplicateur appliqué à l’atlas d’origine |

Les changements de nombre, d’échelle, de vitesse et de teinte réutilisent les allocations existantes. Désactiver les papillons les masque et fige leur noyau ; si le réglage est persisté avant un rechargement, `Butterfly.glb` et sa VAT ne sont pas chargés.

## Limites connues

- Œufs, larves et chrysalides n’ont ni position d’hôte, ni plante nourricière, ni modèle 3D.
- La ponte est la transition abstraite adulte → œuf ; accouplement, sexe et choix d’un site de ponte ne sont pas simulés.
- Les adultes partagent le nectar floral des abeilles, mais ne pollinisent pas encore le paysage et ne modifient aucune économie.
- Le vol est un trajet vectoriel continu ; il n’évite pas les arbres, branches, insectes ou obstacles dynamiques.
- Il n’existe qu’un clip de vol. `FEED` et `REST` conservent le même clip, avec un mouvement spatial plus discret.
- Les durées et seuils sont conçus pour la lisibilité du jeu, pas pour représenter une espèce précise.

## Preuves automatiques

`test/butterfly-simulation.test.js` protège :

- `BUTTERFLY-SIM-001` : vues SoA préallouées et identités stables ;
- `BUTTERFLY-SIM-002` : résultat identique à graine et entrées identiques ;
- `BUTTERFLY-SIM-003` : cycle complet œuf → larve → chrysalide → adulte → œuf ;
- `BUTTERFLY-SIM-004` : météo et lumière arrêtent l’activité, jamais le vieillissement ;
- `BUTTERFLY-SIM-005` : états adultes `FLY`, `FEED` et `REST` atteignables et productifs ;
- `BUTTERFLY-SIM-006` : cibles indexées et directions valides ;
- `BUTTERFLY-SIM-007` : changements de nombre bornés sans remplacement des buffers ;
- `BUTTERFLY-SIM-008` : diagnostic explicite du stade et du comportement ;
- `BUTTERFLY-SIM-009` : absence de hasard ambiant et d’allocation de collection dans la boucle chaude.

`test/butterfly-integration.test.js` protège le contrat de l’asset, le budget VAT, l’unique draw instancié, la capacité fixe, le partage des fleurs, le masquage souterrain et le chargement conditionnel.

Toute modification du cycle, des décisions, de l’asset, des capacités, du chargement ou du rendu doit mettre à jour dans la même livraison les tests, ce document technique et le guide utilisateur. Une retouche artistique pure peut rester validée visuellement si elle ne change aucun invariant fonctionnel ou de performance.
