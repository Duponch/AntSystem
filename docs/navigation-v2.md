# Navigation souterraine V2

## Portée et statut

La navigation V2 remplace le déplacement souterrain fondé sur une projection 2D/heightfield par une coordonnée intrinsèque sur un réseau de corridors 3D. Son objectif est de rendre structurellement impossibles plusieurs défauts historiques : coupe d’un virage, choix du mauvais étage à un croisement superposé, projection contre une paroi et recherche du « nœud le plus proche » ambiguë.

Ce document décrit l’implémentation présente. Les tests réduisent fortement le risque de régression, mais ne constituent pas une preuve mathématique qu’aucun défaut ne pourra jamais apparaître.

## Architecture

Le pipeline de données est le suivant :

1. `buildNest()` produit le registre déterministe des chambres, son arbre parent/enfant, les objectifs et les courbes procédurales des tunnels.
2. `buildCorridorNetwork()` compile chaque arête en un corridor 3D partagé, rééchantillonné à abscisse curviligne quasi uniforme.
3. Les mêmes corridors alimentent les textures GPU de navigation et les capsules du SDF visuel du nid.
4. Chaque fourmi conserve seulement son nœud courant, son objectif et une coordonnée `(corridor, t)` ; sa position 3D est évaluée depuis les tables partagées.

### Réseau intrinsèque 3D

Le fichier `src/navigation/corridor-network.js` est la référence CPU de la navigation :

- une arête relie exactement un nœud parent à un nœud enfant ;
- l’identifiant du corridor est l’identifiant du nœud enfant ;
- chaque corridor contient 64 échantillons en production ;
- `x` et `y` sont exprimés en texels de grille, `depth` en unités monde ;
- la longueur 3D est exprimée en texels, la profondeur étant convertie par `depth / TEXEL` ;
- les deux extrémités sont recopiées exactement depuis les nœuds, sans approximation.

Le réseau actuel est un arbre enraciné : les croisements qui se superposent en projection X/Y ne créent donc aucune connexion implicite. Un puits parfaitement vertical reste une arête 3D valide.

### Source commune navigation/SDF

`layout.navigation.corridors` est la source géométrique commune :

- `corridorTexture` contient les points 3D ;
- `corridorMetaTexture` contient `(from, to, longueur, largeur de voie sûre)` ;
- `navNodeTexture` contient les hubs de chambres ;
- `src/nestvolume.js` dérive de ces mêmes points les capsules du SDF rendu.

Le SDF utilise actuellement huit capsules par corridor, dérivées des 64 points de navigation. Il s’agit donc d’une approximation visuelle de la même courbe, pas de 64 capsules exactes. Un noyau conservateur est réuni au champ bruité afin que le bruit puisse agrandir ou bosseler la cavité sans rogner volontairement son cœur navigable.

## État et déplacement d’une fourmi

L’état de route est de taille constante, sans liste de points copiée par fourmi :

- `antState` contient notamment le drapeau souterrain, l’objectif et le nœud courant ;
- sous terre, `antDyn = (corridorId, t, profondeur, distanceCumulée)` ;
- `corridorId = 0` désigne le patch sûr d’un nœud ou d’une chambre ;
- `t ∈ [0, 1]` est la progression normalisée sur le corridor actif.

À chaque tick, le kernel :

1. lit le prochain nœud dans la table `nextHop` ;
2. rejoint sans téléportation le hub de la chambre si nécessaire ;
3. sélectionne l’unique corridor adjacent vers ce prochain nœud ;
4. avance la distance scalaire, donc `t`, de manière monotone ;
5. réévalue position, profondeur et cap depuis la courbe ;
6. publie exactement le nœud terminal au portail.

Il n’y a sous terre ni A* par fourmi, ni recherche de nœud proche, ni projection sur une grille, ni rebond contre les murs. La pose rendue lit directement `antDyn.z`, et non une hauteur choisie dans une heightmap.

### Routage partagé

Les objectifs actuellement actifs sont : grenier, reine, couvain et sortie. `buildNest()` précalcule par BFS une table `nextHop[nœud, objectif]`, publiée dans `navTexture`. `buildCorridorNetwork()` calcule aussi les distances restantes de référence.

Un choix de route est donc une lecture de texture O(1). Ajouter des fourmis ne crée ni nouvelle recherche de chemin ni nouvelle copie de route.

### Tangentes et voies latérales

La tangente planaire est interpolée à partir des segments voisins puis renormalisée. Elle reste continue aux limites internes des échantillons et est inversée lorsque le corridor est parcouru en sens opposé.

Chaque fourmi reçoit une amplitude de voie déterministe issue de son identifiant. Le signe dépend du sens de circulation, ce qui sépare naturellement les deux flux. L’amplitude est :

- bornée par `safeLane`, calculée à partir du rayon du tunnel, du rayon de l’agent et d’une marge de sécurité ;
- indépendante de la progression de route ;
- fondue vers zéro par un `smoothstep` sur les 12 % proches de chaque extrémité.

Toutes les voies convergent ainsi vers le même portail exact. `maxLaneStretch` borne le surcroît de déplacement dû à la voie courbe ; il est mesuré lors de la compilation, majoré de 8 %, puis utilisé par le Warden comme borne cinématique.

## Coût et capacités

Le coût de navigation d’un tick est constant par fourmi active : état constant, une table de routage partagée et un nombre borné d’échantillons de corridor. Le coût total reste nécessairement O(N) pour N fourmis actives, mais il n’augmente pas avec la longueur de leur route ou la taille du nid. Le calcul est exécuté en parallèle sur le GPU et plafonné par `MAX_ANTS = 65 536`.

Le stockage partagé croît comme :

- O(nœuds × objectifs) pour les tables de routage ;
- O(nœuds × échantillons) pour les corridors ;
- O(1) par fourmi pour l’état de route.

Les capacités actuelles sont 128 nœuds GPU, 96 chambres candidates, 8 objectifs runtime et 64 échantillons par corridor.

## Mutations du nid et invariants de publication

### Croissance append-only

`layout.growTo()` compile d’abord un candidat complet et le valide avant toute mutation. Pour tout le préfixe déjà occupé, il exige l’égalité exacte des :

- nœuds et parents ;
- métadonnées de corridors ;
- échantillons `Float32` ;
- routes `nextHop`.

Ce n’est qu’après cette validation que les nouvelles chambres sont creusées et que les textures sont republiées. L’UI met la simulation en pause, attend une barrière GPU, publie le nouveau layout, reconstruit le volume SDF puis attend une seconde barrière. Les fourmis existantes ne sont pas réinitialisées.

### Reconstruction complète

Une modification qui déplace la géométrie déjà occupée, notamment la profondeur ou la largeur des tunnels, passe par une transaction distincte : pause, reconstruction et publication complètes, reconstruction du SDF, reset explicite de la simulation, puis reprise. Elle n’est pas traitée comme une croissance à chaud.

## Tests

### Suite déterministe CPU

Commande :

```powershell
npm test
```

La suite Node compte actuellement 35 tests et couvre :

| Groupe | Vérifications principales |
|---|---|
| Invariants | déterminisme, capacité, extrémités exactes, valeurs finies, tangentes unitaires, clearance positive, entrées invalides |
| Routage | arêtes adjacentes uniquement, distance conservée, sens inverse, grande distance bornée au but, distance nulle stable |
| Continuité | portail commun à toutes les voies, progression strictement monotone, absence de warp caché, invariance au découpage 60/120 Hz |
| Géométrie irrégulière | conservation de la courbure, échantillonnage quasi uniforme, profondeurs 10 à 200, croisements X/Y empilés |
| Non-régression | signature stable, croissance append-only identique octet par octet, clearance sur les voies extrêmes |
| Complexité | tables partagées linéaires, état par fourmi de forme constante, aucun grossissement après 5 000 pas |
| Cas limites | puits vertical, continuité aux frontières d’échantillons, borne `maxLaneStretch` sur 4 096 sous-pas par corridor |

Les tests de route utilisent `createRouteState()` et `stepRoute()` comme modèle CPU pur. Ils ne nécessitent ni navigateur ni GPU.

### Campagne fonctionnelle GPU : Warden

Démarrer Vite :

```powershell
npm run dev
```

Puis ouvrir l’URL affichée par Vite avec, par exemple :

```text
http://localhost:5173/?test=warden&wdur=120
```

La campagne peut aussi être lancée depuis la console du navigateur :

```js
await __antsys.warden.run({ seconds: 120 });
```

Le rapport final est disponible dans `window.__antwarden`. Le Warden exécute des pas manuels à 60 Hz et inspecte chaque fourmi active après chaque pas.

| Scénario | Population | Particularité |
|---|---:|---|
| référence | 869 | durée demandée |
| colonie dense | 2 048 | durée demandée |
| capacité maximale | 65 536 | jusqu’à 5 s |
| profondeur extrême | 869 | profondeur 200, jusqu’à 10 s |
| tunnels étroits | 869 | largeur minimale 5,5 |
| tunnels larges | 869 | largeur 10 |
| famine | 869 | grenier vide, durée jusqu’à 150 s |
| croissance append-only en trajet | 869 | ajout de quatre chambres à mi-parcours |

Le verdict d’un scénario est strict : les huit compteurs structurels doivent tous être nuls. Ils couvrent le dépassement de la borne cinématique 3D, le warp X/Z, la divergence entre pose et corridor, la toupie, le blocage, la sortie sous le volume, le retour indésirable en surface et la mort après toupie.

Précisions sur les seuils :

- divergence corridor/pose : plus de 0,002 unité monde ;
- toupie : plus d’un tour avec moins de 3 texels parcourus sur 8 s ;
- blocage : moins de 0,5 texel sur 8 s ;
- les repos biologiques et les fourmis déjà arrivées sont exclus des fenêtres de blocage.

Le Warden suit également 48 identifiants répartis dans la population et conserve leurs traces `(tick, nœud, objectif, corridor, progression, distance, position, profondeur)`. Ces traces et les gardes du cycle de vie sont diagnostiques ; le verdict structurel repose actuellement sur les huit compteurs nuls.

## Limites connues et extensions prioritaires

- Le réseau est actuellement un arbre statique avec quatre objectifs fonctionnels ; les cycles, raccourcis dynamiques et obstacles temporaires demanderaient une table pondérée ou une nouvelle compilation.
- Les voies évitent une superposition parfaite des flux, mais il n’existe pas encore d’évitement local, de congestion ou de réservation de portail entre fourmis.
- Le runtime GPU traite un corridor actif par tick. Les pas normaux sont très inférieurs à la longueur d’un corridor ; un test GPU spécifique reste souhaitable pour les `dt` artificiellement énormes.
- Les tests CPU et le Warden couvrent la cinématique, mais il manque encore un test différentiel automatique CPU ↔ GPU, texel par texel, sur les mêmes trajectoires.
- Le Warden vérifie l’adhérence à la courbe, pas l’inclusion complète du volume de l’agent dans le SDF rendu. Un oracle de clearance directement échantillonné dans le SDF fermerait cette dernière boucle.
- La géométrie SDF est réduite à huit capsules par corridor. Augmenter cette résolution ou générer un swept volume exact améliorerait les tunnels extrêmement tortueux, au prix du bake.
- La tangente utilisée pour le cap est planaire ; un pitch dérivé de la tangente 3D améliorerait la pose visuelle dans les puits très verticaux.
- La campagne à 65 536 fourmis vérifie les anomalies fonctionnelles, mais aucun budget de temps GPU n’est encore imposé comme test de performance bloquant.

Ces limites sont des axes de durcissement explicites, pas des mécanismes de repli vers l’ancien système 2.5D.
