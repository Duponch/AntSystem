# Architecture de la colonie et de la navigation

## Chaîne de données

1. `buildNest()` lit le bake versionné `natural-growth-tree-v2` : 96 fiches immuables décrivent positions, parents, rôles et détours de corridor.
2. `buildCorridorNetworkAsync()` construit le graphe puis délègue la projection des 12 pistes de chaque corridor à une file de deux à quatre Workers exacts.
3. `buildNestLayoutAsync()` publie atomiquement routes, axes, contacts et supports après validation complète du candidat.
4. Le SDF du nid, la gorge d’entrée, le trou du sol et le masquage de l’herbe dérivent des mêmes primitives géométriques propres.
5. Le kernel avance une coordonnée intrinsèque compacte et interpole le contact précalculé ; la passe de pose relit le même support pour orienter le corps.
6. L’inspecteur et le Warden lisent la télémétrie sans devenir des sources de décision.

Le réseau compilé est la référence commune. Une représentation visuelle peut être voxelisée ou moins détaillée, mais elle ne doit inventer une autre bouche, une autre paroi contractuelle ou une autre courbe de navigation.

La macro-topologie est un arbre de croissance binaire, enraciné et append-only. Chaque fiche référence au plus un parent strictement antérieur ; chaque nœud reçoit au plus deux enfants. Les quatre premières fiches forment le tronc fondateur et assurent les fonctions garde, grenier, crèche et chambre royale. Les suivantes prolongent le tronc, créent des bifurcations et des rameaux terminaux à des longueurs et profondeurs variées. Une partie démarre normalement avec le préfixe K24 ; le registre K96 réserve la croissance sans déplacer ni reconnecter le préfixe déjà actif.

Ce modèle remplace l’ancien découpage en séries de quatre niveaux, dont la répétition produisait des rangées et des échelles visuellement géométriques. L’indice `q` est désormais propre à chaque fiche et ne désigne plus un groupe. Les petits nœuds de transit sont des vestibules sans fonction biologique ; les chambres, plus larges, portent les usages de la colonie. Le registre statique relu est la source d’autorité : chaque évolution modifie explicitement ses fiches, puis doit satisfaire les oracles de topologie, de collision et de surface avant publication.

La macro-géométrie est partagée par les différentes couches. Chaque nœud volumique devient trois lobes tronqués contenus dans une enveloppe conservatrice ; chaque corridor devient seize capsules, avec axe sinueux et rayon variable sans réduction de clearance. Les 144 échantillons de chacune des 12 pistes sont compilés une fois et partagés. Le CPU de contact et le GPU de rendu consomment ces mêmes primitives. Cette topologie n’ajoute ni chemin privé ni état géométrique par fourmi : l’échantillonnage individuel reste O(1).

## Textures de surface

Pour chaque corridor, piste et échantillon :

- la texture contact contient `(xGrid, yGrid, depthWorld, longueurPisteGrid)` ;
- la texture support contient `(normale intérieure métrique xyz, axisT)`.

Les 12 pistes sont partagées par toute la population. Une fourmi ne stocke que son état intrinsèque ; son identifiant suffit à retrouver sa piste. Deux texels voisins de chaque texture sont interpolés, avec un nombre de lectures indépendant du nombre de corridors, de nœuds et de fourmis.

La position n’est jamais reprojetée sur le SDF en jeu. Le SDF analytique n’intervient que pendant la compilation CPU et dans les oracles de test ; le volume voxelisé sert au rendu.

## État d’une fourmi

`antState` est un entier compact contenant notamment l’état vital, le drapeau souterrain, l’objectif, le nœud et l’étage. `antDyn` est polymorphe :

- à la surface : vitesse planaire, hauteur et vitesse verticale ;
- sous terre : `(corridorId, progression de piste, profondeur de contact, distance cumulée)`.

`corridorId = 0` signifie que la fourmi traverse le patch sûr d’un nœud ou rejoint son hub. Une valeur positive sélectionne une arête explicite. La position et l’attitude ne sont jamais retrouvées par une recherche spatiale du nœud le plus proche.

L’indice de piste est déterministe à partir de l’identifiant. Il ne change ni l’objectif, ni le nœud, ni le potentiel de route. `axisT`, stocké avec le support, conserve la correspondance avec l’axe du corridor.

## Routage partagé

Le nid actuel est un arbre enraciné. Les prochains sauts vers le grenier, la reine, le couvain ou la sortie sont précalculés dans une table partagée. Une fourmi effectue une lecture indexée pour obtenir le prochain nœud ; elle ne stocke pas de liste de chemin.

Les croisements superposés en projection horizontale ne créent aucune connexion implicite. La profondeur fait partie de la métrique du corridor.

## Démarrage et cycle

La politique pure `COL-START` fixe le rôle du placement initial et les bornes de délai. Le kernel GPU en reproduit le contrat sans buffer supplémentaire. Le couvain utilise un pool borné distinct ; le CPU ne fait qu’activer les slots éclos lors de son poll basse fréquence.

Les règles de ponte, développement, ravitaillement, famine et menace appartiennent au contrat `COL-ECO`. Elles peuvent modifier l’intention ou provoquer une attente sans modifier les invariants géométriques de navigation.

## Ancres fonctionnelles et couvain

Grenier, mangeoire royale et couvain publient chacun un ancrage autoritatif `(x, y, depth, layer, cell)`. Le rendu et les échanges utilisent `depth` sur la nappe déclarée, jamais le canal le plus profond d’une colonne superposée. Chaque publication du layout rafraîchit ensemble les cellules d’échange, positions et profondeurs.

Les œufs sont transportés par une abstraction logistique entre la chambre royale et celle du couvain. Leur rendu choisit explicitement la profondeur de l’ancre reine ou couvain la plus proche ; une cavité d’une autre nappe ne peut plus les attirer verticalement.

## Volume physique borné

Le SDF rendu occupe une texture `128 × 68 × 128`. Verticalement, elle couvre la géométrie la plus profonde, 3 unités de marge basse et 1,7 unité au-dessus de la surface. La profondeur du nid est bornée à `[19, 24]` : 19 est la première valeur où les 96 loges et toutes les largeurs 5,5..12 gardent au moins 0,4 unité de terre après routage déterministe ; à 24, le tunnel minimal garde encore trois voxels sur son diamètre.

L’entrée est réservée à la périphérie du registre complet par un offset fixe de 11 unités et une direction déterministe. Les corrections nécessaires restent des détours locaux bornés, validés avec toutes les structures futures avant publication du layout.

Les paramètres d’anciennes sauvegardes sont clampés lors du chargement. Les appels directs au constructeur restent stricts et rejettent une valeur hors borne. Un monde profond de 200 unités exigerait un découpage en briques, une clipmap ou un volume clairsemé multi-résolution ; il ne relève pas du volume monolithique actuel.

## Mutations du nid

Le chargement, la croissance append-only et la reconstruction utilisent le même compilateur Worker exact. Les demandes sont sérialisées par une file FIFO. Une erreur de construction, compilation, validation ou barrière GPU rejette le candidat avant publication : l’ancien nid, ses textures et ses routes restent alors intacts, puis la file demeure utilisable. Une fois la publication commencée, `applyNest()`, la reconstruction du volume et le reset ne disposent pas d’un rollback transactionnel ; leurs préconditions doivent donc être validées en amont et toute erreur est remontée explicitement.

Pendant le bake, la simulation continue. Le hook `beforeCommit` ne la met en pause qu’après validation, le temps de synchroniser le GPU, publier le candidat, appliquer les textures et reconstruire ou réinitialiser ce qui dépend de la géométrie. L’état de pause antérieur est restauré même si la synchronisation échoue.

Une croissance conserve le préfixe occupé et les états des fourmis. Une reconstruction de profondeur ou largeur assume un reset explicite. Les variantes synchrones restent réservées aux oracles Node et au Warden ; elles refusent de courir pendant une transaction asynchrone.

## Frontières

L’architecture garantit une route, un contact et un repère déterministes, pas une simulation sans limite. Congestion, réservation de portail, obstacles souterrains dynamiques et cycles arbitraires ne font pas encore partie du contrat.

## TIME-SCALE — Architecture temporelle hybride

Le mode `fluid` est le chemin GPU-first et le mode de jeu par défaut. Il privilégie la régularité GPU et la fraîcheur visuelle : entre `×0` et `×1`, chaque image reçoit exactement un pas logique égal au temps mural multiplié par la vitesse, avec un `dt` borné à `1/30 s`. La pose des fourmis n’est pas envoyée séparément pendant ce pas ; après le dernier pas de l’image, pose et classement LOD sont encodés ensemble dans un unique submit. Une fourmi en mouvement dispose ainsi d’une pose fraîche à chaque `requestAnimationFrame`, y compris sur un écran 240 Hz.

Le profil temporel est un choix de session, jamais un réglage persistant. Le chargement ignore une ancienne valeur `timingMode`, initialise toujours `fluid`, puis applique éventuellement l’override explicite `?timing=strict`. `maxGpuSubsteps` reste en revanche sauvegardé et migré dans l’intervalle autorisé.

Au-dessus de `×1`, `planGpuSimulationFrame()` découpe le temps éligible en sous-pas qui ne dépassent jamais `1/30 s`. Le budget recommandé et utilisé par défaut est de un à huit sous-pas GPU par image. Si un ralentissement mural ou une forte accélération demanderait davantage de travail, le surplus est compté dans `droppedDt` : il n’est ni simulé ni transformé en dette à rattraper. L’overlay publie donc séparément vitesse demandée, vitesse effective et temps non simulé. Revenir à `×1` retrouve immédiatement le fast-path, sans rafale cachée de rattrapage.

Chaque sous-pas conserve l’ordre causal commun : fourmis et environnement GPU, couvain, araignées, puis pollinisateurs, papillons et caméléon. Les matrices d’instances, la pose finale, le LOD, le ragdoll, la caméra et les effets visuels restent limités à une fois par image. Ce mode conserve les règles, les durées consommées et les invariants de déplacement, mais ne promet pas une identité bit à bit entre deux découpages temporels différents.

En mode `fluid`, les observations GPU→CPU sont opportunistes. Les copies diagnostiques sont soumises après le rendu visible et peuvent donc refléter l’image précédente. Les échéances des araignées sont conservées en temps simulé, plusieurs échéances en attente sont coalescées et `tryAcquireReadback()` abandonne une tentative lorsque le verrou est occupé, sans arrêter la simulation. Les statistiques de colonie utilisent de la même manière le dernier snapshot disponible et une réconciliation asynchrone. Les mutations explicites — reset, toggle de colonie ou changement structurel — restent sérialisées et peuvent suspendre brièvement l’avancement pour publier un état atomique.

Le mode `strict` conserve l’ancienne autorité déterministe pour les tests, les diagnostics et les replays. Le monde avance alors exclusivement par ticks de `1/120 s`, avec au plus 64 ticks par image et une dette entière jamais supprimée. Dégâts des araignées, échantillon de proies et colonie deviennent des barrières exactes respectivement tous les 24, 36 et 120 ticks ; une lecture FIFO fraîche est attendue avant le tick suivant. Une erreur ferme la barrière et met la partie en pause.

Une transition `fluid → strict` ne réinterprète jamais l’état approximatif en cours comme point de départ reproductible. Elle invalide l’epoch d’autorité, attend les lectures engagées, bloque les nouveaux pas via la transaction de reset, puis réinitialise la simulation GPU, les araignées, la façade des pollinisateurs — abeilles, papillons et caméléon — et la colonie. Le mode strict commence ainsi depuis un état propre et publié atomiquement.

Pour les frontières araignées, un unique snapshot GPU `uvec4[3 072]` de **48 KiB** regroupe 1 024 lignes de fourmis et deux lignes pour chacune des 1 024 araignées. Lorsque les échéances proies et dégâts coïncident, un même kernel remplit ce snapshot et la barrière n’effectue qu’un seul mapping GPU→CPU. `floatBitsToUint` conserve exactement les coordonnées flottantes dans les mots du snapshot ; le CPU relit le même stockage avec des vues `Uint32Array` et `Float32Array`, sans conversion numérique ni perte de bits.

Pour chaque araignée, la victime d’un intervalle est élue dans un entier atomique par `atomicMin` sur l’indice de fourmi : le plus petit slot gagne, indépendamment de l’ordre d’exécution des invocations GPU. Le snapshot capture cet indice et sa position, puis le sentinel `MAX_ANTS` est rétabli avant l’intervalle suivant. Une victime d’un intervalle ne peut donc ni contaminer le suivant ni dépendre d’une écriture concurrente non atomique.

Les mutations autoritatives déclenchées par l’UI suivent la même discipline dans les deux modes. Le toggle « Colonie vivante » délègue à `enqueueAuthoritativeMutation` : la demande invalide immédiatement l’epoch courant, se sérialise derrière la transaction précédente, attend toute lecture GPU/CPU déjà engagée, puis effectue la migration et les resets associés. Tant que cette transaction est exposée par `resetPromise`, aucun nouveau pas logique ne démarre.

À graine, réglages, version et séquence d’entrées identiques, l’identité au même tick est une garantie du mode `strict`. Le mode `fluid` garantit plutôt un coût borné, une causalité commune et une télémétrie honnête : deux exécutions peuvent diverger numériquement si leur FPS ou leur quantité de temps explicitement non simulé diffèrent.
