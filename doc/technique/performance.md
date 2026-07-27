# Coûts et performance

## O(1) par fourmi

« O(1) par fourmi » signifie que le coût d’un pas individuel ne dépend ni du nombre de nœuds parcourus, ni de la longueur totale de la route, ni du nombre de congénères :

- état de route de taille constante ;
- une lecture de prochain saut dans une table partagée ;
- sélection déterministe d’une des 12 pistes ;
- deux échantillons voisins dans la texture contact et deux dans la texture support ;
- un nombre fixe d’interpolations et de projections vectorielles ;
- aucun A* par fourmi, aucune liste de waypoints copiée, aucune recherche spatiale de nœud ;
- aucun SDF, raycast ou solveur de contact exécuté par fourmi.
- à la surface, un test analytique segment-cercle constant empêche de traverser la bouche ; il n’ajoute ni texture ni recherche spatiale.

Le coût total d’une frame reste O(N) pour N fourmis actives. Le parallélisme GPU réduit le temps mural ; il ne rend pas gratuit l’ajout d’agents.

## Stockage partagé

| Donnée | Croissance |
|---|---|
| Tables de routage | O(nœuds × objectifs) |
| Axe et repères de corridors | O(corridors × échantillons) |
| Texture contact direct | O(corridors × 12 pistes × échantillons) |
| Texture support | O(corridors × 12 pistes × échantillons) |
| État de navigation des fourmis | O(N), taille constante par fourmi |
| Projection CPU et construction SDF | Coût rare, payé lors d’une mutation de géométrie |

Chaque texel comporte quatre flottants. La texture contact stocke la position et la longueur totale de piste ; la texture support stocke la normale intérieure et `axisT`. Aucune de ces tables ne grossit avec la population.

La compilation CPU peut projeter des échantillons denses, calculer les longueurs d’arc et mesurer les bornes géométriques. Ce travail n’est pas payé à chaque tick.

## Bake CPU parallèle et exact

La projection de chaque corridor est indépendante. Au chargement comme lors d’une croissance ou reconstruction, `buildCorridorNetworkAsync` répartit les corridors de façon déterministe sur au plus quatre workers, sans couper un corridor entre deux threads. Chaque worker appelle le même compilateur pur ; la fusion replace ensuite chaque bloc à l’offset de son identifiant.

Le contrat est l’égalité bit à bit avec le bake synchrone, pas une durée absolue. Les buffers de positions, supports et longueurs sont transférés une fois, les workers sont terminés dans tous les chemins, et un défaut d’infrastructure déclenche le compilateur synchrone exact. Une erreur déterministe de géométrie reste une erreur visible.

Les mutations sont préparées dans une file FIFO sans suspendre les fourmis. Après compilation et validation, un hook met brièvement le temps simulé en pause pour la barrière GPU et la publication atomique, puis restaure l’état de pause précédent. Le mode, le nombre de workers et la durée diagnostique restent exposés ; ils ne constituent pas un seuil portable.

## Hash spatial du SDF

Le solveur analytique limite les primitives évaluées avec une grille de cellules de 2 unités monde. Une cellule est encodée par trois coordonnées signées de 16 bits dans une clé numérique exacte de 48 bits. Cette représentation évite les chaînes temporaires dans la boucle de projection tout en conservant les mêmes listes de primitives et les mêmes résultats Float32. `NAV-SURFACE-PERF-001` protège le domaine et l’absence de collision de cette clé.

## Budget du volume souterrain

Le volume SDF fixe mesure `128 × 68 × 128` en RGBA demi-précision, soit environ 8,5 Mio. Il inclut 3 unités sous la géométrie la plus profonde du registre et une marge haute de 1,7 unité. Les quatre tranches verticales ajoutées par rapport à la grille 64 garantissent trois voxels dans le tunnel minimal. L’intervalle `[19, 24]` combine faisabilité exhaustive du layout à 19 et résolution minimale à 24.

La faisabilité est payée lors de la construction et de la validation, jamais par fourmi : le bake `natural-growth-tree-v2` contient 96 fiches, dont le préfixe K24 est actif par défaut. L’arbre binaire, les largeurs 5,5..12, l’entrée périphérique et les détours locaux bornés sont évalués avant publication. La marge contractuelle entre structures non adjacentes est de 0,4 unité monde.

La forme organique conserve le budget partagé existant : trois lobes par nœud, seize capsules par corridor et 144 échantillons sur chacune des 12 pistes sont préparés lors du bake. Le nombre d’échantillons avait remplacé les 128 antérieurs (+12,5 % sur deux tables partagées de capacité fixe) afin de conserver la précision sur les galeries plus longues ; le nombre de capsules reste uniformément seize sur tout le registre. Les parents et détours sont lus directement dans le registre ; la matrice de collisions est un oracle de test, jamais un traitement de frame. Chaque fourmi conserve les mêmes quatre lectures interpolées et le même état compact : la topologie naturelle n’ajoute donc pas de coût individuel et le pas par fourmi reste O(1).

Accepter 200 unités avec la même grille réduirait fortement la résolution verticale et casserait ce contrat. Une telle échelle nécessite une architecture en briques, clipmap ou volume clairsemé. Augmenter simplement la profondeur logique sans changer le stockage n’est pas une optimisation acceptable.

## Budget de la vue souterraine stylisée

Le rendu `UNDERGROUND-VISUAL` ajoute **six draws de base** : un raymarch pour la terre excavée, un `InstancedMesh` pour 3 375 mottes, un pour les segments de racines, puis trois pour les modèles enfouis `Rock.glb`, `Bone.glb` et `FishBone.glb`. La poussière et son ancien draw `Points` ont été supprimés.

Les trois GLB sont chargés une seule fois, aplatis, centrés et normalisés. Leurs géométries sont conservées dans trois pools instanciés fixes : 256 rochers de 166 triangles, 64 os de 304 triangles et 48 arêtes de 588 triangles. Le runtime ne présente simultanément que 18 rochers, 8 os et 7 arêtes rencontrés par l’excavation ; les pools complets définissent le plafond conservateur. Toutes les transformations proviennent de coordonnées monde périodiques fixes. Fréquence, dimension, variation, couleur et exposition ne font que sélectionner ces transformations ou modifier les propriétés des matériaux, sans recharger les modèles et sans translation vers la caméra. Le dépôt contient `Bone.glb`, pas `Bong.glb`.

Le plafond conservateur exact totalise **180 728 triangles** :

```text
12 + 3 375 × 20 + 1 152 × 20 + 256 × 166 + 64 × 304 + 48 × 588
```

Il inclut la `BoxGeometry` porteuse, toutes les mottes, le cap contractuel des racines et la capacité maximale des trois pools GLB. Le scanner additif ajoute un septième draw optionnel hors de ce budget. La baisse des fréquences réduit le nombre d’instances dessinées, mais le plafond et les allocations restent fixes.

Les mottes utilisent un matériau Lambert et les trois objets un `MeshStandardNodeMaterial` PBR rugueux. Leur `maskNode` lit le canal SDF propre à `positionWorld` et les retire du vide réel sans passe supplémentaire. Une ambiante faible et une clé directionnelle caméra-relative préservent leurs couleurs et leur modelé sans shadow map ni draw supplémentaire. La palette de la terre utilise quelques bruits 3D bornés ; ses cinq couleurs, chaos, taille d’amas, fusion, grain et contraste sont des uniformes live. Le cache des matrices n’est invalidé que par le mouvement ou un réglage qui affecte la disposition.

Aucune capacité, aucun draw et aucune table de cette vue ne dépend du nombre de fourmis ou de chambres. Le coût du décor reste donc constant vis-à-vis de la simulation ; le coût de fragment du raymarch dépend toujours de la résolution et du GPU. `UNDERGROUND-VISUAL-PERF-001` vérifie les six draws et le plafond exact, mais n’impose pas de durée GPU portable.

## Ce qui est testé

Les tests de complexité vérifient la forme constante de l’état, l’absence de chemin privé, les dimensions des deux tables de surface, leur croissance linéaire avec corridors/pistes/échantillons et l’absence de grossissement après des milliers de pas.

Les tests `NAV-SURFACE` contrôlent la surface propre, les supports, les portails, les planchers, la borne de stretch et la continuité exhaustive K96 × 12. `NAV-SURFACE-PERF-001` contrôle la clé spatiale. `NAV-SURFACE-PAR-001` à `004` comparent les buffers parallèles et synchrones octet par octet, puis exercent indisponibilité, erreurs d’infrastructure, erreurs déterministes et terminaison des workers. Le Warden exerce également la capacité maximale et exige des poses finies, des pivots sur leur support et une orientation cohérente. Ses kernels et buffers de diagnostic ne sont dispatchés que pendant une campagne Warden : leur coût en jeu normal est nul.

Les tests `UNDERGROUND-VISUAL-001` à `006`, puis `008` à `011` ciblent les contrats utiles : ancres de palette, détection du bloc, déterminisme, racines, périodicité, suppression de la poussière, validité des trois GLB, monotonie des fréquences et bornes de dimensions. `UNDERGROUND-VISUAL-PERF-001` exige six draws et 180 728 triangles au plafond. Les tests de transition protègent la bascule de couche, les contrôles UI et la migration ; `UNDERGROUND-RENDER-001` à `005` inspectent l’union SDF, les invalidations, les racines, le masque physique des objets et leur chargement unique. Le rendu artistique — équilibre de palette, absence perceptuelle de bandes et qualité des amas — est validé visuellement dans WebGPU plutôt que figé par des assertions de pixels fragiles.

Cette campagne n’impose pas encore de budget p95 de temps GPU.

## Mesurer sans dérive

Une affirmation de performance publiable doit préciser au minimum : commit, navigateur, GPU et pilote, population, paramètres, durée de chauffe, nombre d’échantillons et p50/p95 par passe. Les résultats sans ce contexte restent diagnostiques et ne doivent pas devenir un seuil de CI.

## Limites actuelles

- Pas d’évitement local ou de réservation de portail entre fourmis.
- Pas de seuil bloquant de performance GPU dans `npm test`.
- Le volume SDF et les pistes sont reconstruits lors des changements de forme ; cette opération n’est pas un coût de frame normal.
- La profondeur monolithique est limitée à 24 unités ; une profondeur beaucoup plus grande exige des briques ou une clipmap.
- Le modèle CPU conserve la distance résiduelle à travers plusieurs arêtes et est invariant au découpage temporel ; les transitions GPU entrée/sortie consomment également le résidu mesuré, mais un très grand `dt` artificiel reste à couvrir par une campagne GPU dédiée.
