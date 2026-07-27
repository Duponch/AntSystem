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

Le rendu `UNDERGROUND-VISUAL` ajoute cinq draws de base : un raymarch pour la terre excavée, un `InstancedMesh` pour 3 375 mottes, un pour 384 roches, un pour les 225 segments de racines courants (cap contractuel 1 152), puis un `Points` pour 128 poussières. Les trois meshes géologiques sont alloués une fois ; leurs données X/Z sont repliées périodiquement sur une tuile de 26 unités, tandis que la poussière reste un nuage local fixe. Le bake conserve les mêmes capacités lorsqu’il est régénéré après un changement d’épaisseur du sol.

Le plafond conservateur exact totalise 98 232 triangles (`12 + 3 375 × 20 + 384 × 20 + 1 152 × 20`) : 12 pour la `BoxGeometry` porteuse, puis les icosaèdres et le cap des racines. Les draws fixes mottes et roches utilisent chacun un `MeshLambertNodeMaterial` dont le `maskNode` lit le canal SDF propre à `positionWorld` : chaque fragment de chacun de ces deux draws paie une lecture de texture, sans passe supplémentaire, et la matière disparaît dans le vide réel. Le scanner additif ajoute un sixième draw optionnel hors des cinq draws de base et hors de ce budget géologique. Les lumières souterraines n’émettent pas d’ombres et le fog de surface est désactivé sous terre.

Le cache des matrices d’instances est invalidé par le mouvement, le rayon, le relief ou l’épaisseur ; seule cette dernière régénère le bake géologique borné. Aucun de ces réglages ne reconstruit le volume du nid ni les tables par fourmi. Le rayon UI est limité à 10 et la bande roche à 0,65 afin que l’excavation maximale reste dans la demi-tuile de 13 unités. `UNDERGROUND-VISUAL-PERF-001` instancie les trois géométries réelles, recompte leurs triangles, ajoute les 12 triangles de la porteuse et exige exactement 98 232 pour cinq draws de base. Il n’instrumente pas les commandes soumises au GPU et ne borne pas le coût de fragment du raymarch.

## Ce qui est testé

Les tests de complexité vérifient la forme constante de l’état, l’absence de chemin privé, les dimensions des deux tables de surface, leur croissance linéaire avec corridors/pistes/échantillons et l’absence de grossissement après des milliers de pas.

Les tests `NAV-SURFACE` contrôlent la surface propre, les supports, les portails, les planchers, la borne de stretch et la continuité exhaustive K96 × 12. `NAV-SURFACE-PERF-001` contrôle la clé spatiale. `NAV-SURFACE-PAR-001` à `004` comparent les buffers parallèles et synchrones octet par octet, puis exercent indisponibilité, erreurs d’infrastructure, erreurs déterministes et terminaison des workers. Le Warden exerce également la capacité maximale et exige des poses finies, des pivots sur leur support et une orientation cohérente. Ses kernels et buffers de diagnostic ne sont dispatchés que pendant une campagne Warden : leur coût en jeu normal est nul.

Les tests `UNDERGROUND-VISUAL-001` à `007` vérifient les horizons, la détection du bloc, le déterminisme, la profondeur des racines, la coque de révélation, la densité périodique et l’absence de popping au rayon maximal. `VISUAL-005/006` appellent le même `isEmbeddedInExcavationShell` que le runtime CPU, pas une approximation de test. `UNDERGROUND-TRANSITION-001` à `005` contrôlent l’exposition du socle, l’ordre caméra→plongée, la bascule de couche et les bornes UI ; `UNDERGROUND-TRANSITION-006` couvre la migration des quatre réglages persistés. `UNDERGROUND-RENDER-001` à `004` inspectent le raymarch, les invalidations relief/épaisseur, les plantes racinaires atomiques et le `maskNode` SDF propre des deux matériaux mottes/roches.

Cette campagne n’impose pas encore de budget p95 de temps GPU.

## Mesurer sans dérive

Une affirmation de performance publiable doit préciser au minimum : commit, navigateur, GPU et pilote, population, paramètres, durée de chauffe, nombre d’échantillons et p50/p95 par passe. Les résultats sans ce contexte restent diagnostiques et ne doivent pas devenir un seuil de CI.

## Limites actuelles

- Pas d’évitement local ou de réservation de portail entre fourmis.
- Pas de seuil bloquant de performance GPU dans `npm test`.
- Le volume SDF et les pistes sont reconstruits lors des changements de forme ; cette opération n’est pas un coût de frame normal.
- La profondeur monolithique est limitée à 24 unités ; une profondeur beaucoup plus grande exige des briques ou une clipmap.
- Le modèle CPU conserve la distance résiduelle à travers plusieurs arêtes et est invariant au découpage temporel ; les transitions GPU entrée/sortie consomment également le résidu mesuré, mais un très grand `dt` artificiel reste à couvrir par une campagne GPU dédiée.
