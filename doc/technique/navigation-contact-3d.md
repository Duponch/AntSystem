# Navigation et contact 3D

## Réseau intrinsèque

Chaque tunnel est une courbe 3D reliant deux nœuds déclarés. La courbe procédurale est rééchantillonnée à longueur d’arc quasi uniforme ; ses extrémités sont recopiées exactement depuis les nœuds. La route choisit une arête et avance une progression normalisée, sans rechercher à chaque frame le nœud spatialement le plus proche.

La géométrie de route et la géométrie de contact sont liées mais distinctes. L’axe sert au routage, aux portails et au paramètre `axisT`. Les pistes de surface portent les positions réellement parcourues par les fourmis.

<a id="nav-surface"></a>
## NAV-SURFACE — Contact continu à 360 degrés

Chaque corridor possède exactement 12 pistes stables réparties autour de son volume. L’identifiant d’une fourmi sélectionne une piste de façon déterministe ; ce choix ne change ni son objectif, ni son corridor, ni le sens de son trajet.

### Compilation CPU

La compilation effectue le travail géométrique coûteux une seule fois lors de la construction ou de la mutation du nid :

1. un repère orthonormal transporté — tangente, normale et binormale — suit l’axe tortueux sans retournement soudain ;
2. chaque piste est projetée densément sur la surface propre du corridor ;
3. la piste projetée est reparamétrée par sa propre longueur d’arc pour obtenir des échantillons réguliers ;
4. le contact et son support sont inscrits dans deux tables partagées de capacité fixe.

Chaque corridor est une unité de compilation indépendante : son SDF propre contient sa chaîne de capsules et au plus ses deux chambres terminales. Le démarrage, la croissance et la reconstruction utilisent jusqu’à quatre Web Workers, répartissent les corridors en partitions équilibrées, puis fusionnent les résultats à leur identifiant d’origine. Un corridor entier reste sur le même worker et conserve le même ordre d’opérations flottantes que le bake synchrone ; les positions, supports, longueurs et bornes fusionnés doivent être bit-identiques. Si les workers sont absents ou subissent une erreur d’infrastructure, le même compilateur est exécuté en fallback synchrone. Une erreur déterministe du compilateur est remontée au lieu d’être masquée.

Les mutations sont sérialisées en FIFO. Un candidat est compilé et validé pendant que la simulation continue ; il n’est publié qu’atomiquement, après une courte barrière GPU. Tout échec antérieur à cette publication rejette le candidat et conserve intégralement le layout, les textures et les routes précédents. Après publication, l’application GPU et le reset ne possèdent pas de rollback ; leurs préconditions sont donc contrôlées avant le commit et leurs erreurs restent explicites.

Le SDF analytique est accéléré par une grille spatiale. Les trois coordonnées entières de cellule, bornées comme des entiers signés sur 16 bits, sont empaquetées dans un `Number` entier exact de 48 bits. Cette clé numérique évite l’allocation d’une chaîne à chaque requête pendant le bake ; elle ne change ni les primitives évaluées, ni leur ordre, ni les tables Float32 produites. Ce hash ne s’exécute jamais par fourmi.

La texture de contact encode directement :

```text
RGBA = (xGrid, yGrid, depthWorld, longueurPisteGrid)
```

La texture de support encode :

```text
RGBA = (normaleInterieureMetrique.x,
        normaleInterieureMetrique.y,
        normaleInterieureMetrique.z,
        axisT)
```

La normale métrique est exprimée dans le même espace isotrope que la navigation, où la profondeur monde est ramenée à l’échelle de la grille. `axisT` relie chaque échantillon de piste à sa position sur l’axe, notamment pour les portails et les diagnostics.

### Échantillonnage GPU

À chaque pas, le GPU :

1. calcule l’indice de piste à partir de l’identifiant ;
2. lit les deux échantillons voisins dans la texture de contact ;
3. lit les deux échantillons voisins dans la texture de support ;
4. interpole position, normale, longueur et `axisT` ;
5. projette la direction avant dans le plan tangent au support.

La position de contact est donc lue directement : elle n’est pas reconstruite depuis l’axe et un rayon approximatif. La simulation, la pose et le Warden emploient ce même contrat d’échantillonnage. Il n’existe aucun raycast, aucune résolution de SDF et aucune recherche de paroi par fourmi.

La normale pointe de la paroi vers l’intérieur du volume praticable. Le pivot du corps est décalé le long de cette normale : une fourmi peut marcher sur le sol, un mur ou le plafond sans léviter ni traverser la paroi.

### Portails et chambres

Aux extrémités qui donnent sur une chambre, les 12 pistes convergent continûment vers le même patch de plancher. La piste garde une longueur et une progression valides jusqu’au portail ; aucun recentrage intérieur ni saut latéral n’est permis.

Dans une chambre, `corridorId = 0`. La fourmi rejoint un siège déterministe ou le hub du prochain corridor sur le plancher physique. Lorsqu’elle repart, elle commence à l’extrémité exacte du corridor attendu.

Les changements de mode conservent aussi le budget de déplacement de la frame. À la sortie, la fourmi atteint d’abord le contact exact de sa piste, puis consomme le résidu radialement sur le sol. À l’entrée, le segment de surface est découpé au contact de la bouche ; seul le budget restant, diminué de l’erreur transversale mesurée, devient une progression dans la piste souterraine. Le résidu n’est donc ni perdu, ni ajouté, et aucun recentrage ne peut se faire passer pour un déplacement. Le modèle CPU de route protège de la même façon le résidu à travers plusieurs arêtes et reste invariant au découpage en pas de temps.

<a id="nav-entrance"></a>
## NAV-ENTRANCE — Entrée physique et continue

La bouche de surface est l’exception volontaire au portail convergent : chaque piste commence sur l’anneau réel de la gorge, dans le plan physique `y = 0`. Le nœud d’entrée, le centre de bouche, chaque sommet du premier anneau rendu et les 12 contacts de navigation partagent exactement cette hauteur. Cette pose sert à la fois de cible d’approche en surface et de premier contact souterrain.

Le portail n’est pas placé au centre du registre. Il se trouve à la périphérie de la chambre de garde, à un offset fixe de 11 unités monde dans une direction déterministe. Son emplacement est calculé contre le registre complet des 96 loges, et pas seulement contre le préfixe actuellement creusé : une future croissance ne peut donc pas faire apparaître une chambre ou un tunnel à travers l’entrée.

Le raccord vers la chambre de garde suit lui aussi une courbe déterministe. Les rares conflits géométriques sont résolus par des détours locaux bornés, sans recherche globale ni changement à l’exécution. La validation exhaustive du registre complet et de toutes les largeurs autorisées vérifie que ces détours préservent les marges de terre.

La même géométrie d’entrée détermine :

- le trou réellement découpé dans le maillage du sol ;
- le premier anneau de la gorge procédurale ;
- le volume propre du tunnel ;
- la zone sans herbe autour de l’ouverture ;
- les contacts de transition utilisés par la simulation.

Seule une candidate déclarée à la descente — porteuse, affamée ou nourrice égarée lorsque le mode colonie est actif — peut engager le collier compris entre `rayonBouche + rayonCorps` et `rayonBouche`. Cette autorisation ne contourne pas le contrat de piste : la candidate reste confinée au rayon exact de la bouche tant que son segment n’a pas croisé le contact de sa propre piste ; la transition paie ensuite la distance réellement parcourue avec le budget résiduel.

Toute autre fourmi ne peut pas couper à travers le vide. Son segment est testé continûment contre le disque `rayonBouche + rayonCorps` : même avec un grand pas de temps, le premier impact est conservé et seule la composante tangentielle résiduelle glisse sur la lèvre. Une fourmi en émergence dépense au contraire son résidu vers l’extérieur sans être repoussée sous terre. Ce contrôle analytique est O(1), sans raycast ni texture supplémentaire.

Le modèle décoratif `Anthill.glb` n’est donc plus nécessaire. Un rayon lancé au centre rencontre une ouverture physique, et la fourmi conserve sa piste lorsqu’elle descend ou remonte.

## Accord avec le volume rendu

Le compilateur de pistes et le bake volumique partagent les primitives propres du corridor. La projection CPU sert d’oracle analytique ; le volume GPU en est une représentation échantillonnée pour le rendu. Le relief organique peut enrichir les zones libres des cavités, mais il est neutralisé sous les contacts contractuels afin de ne jamais retirer la surface située sous les pattes.

L’oracle Node évalue la surface propre indépendamment du rendu voxelisé. Le Warden complète ce contrôle en vérifiant la transformation effectivement produite après la passe de pose.

Une sonde GPU explicite contrôle aussi le volume réellement téléversé : elle choisit déterministement trois contacts de corridors et deux planchers de chambres, lit les huit texels RGBA16F nécessaires autour de chaque point, reconstruit le filtrage trilinéaire du canal SDF propre, puis vérifie contact proche de zéro, air négatif et terre positive.

Chaque bake capture un `bakeRevision` croissant, le `layoutRevision` publié et une `layoutSignature` calculée sur les dimensions, les bornes, les chambres actives et chaque capsule de corridor réellement rendue. La sonde compare ces trois preuves avant et après le readback et rejette tout bake absent, périmé ou remplacé pendant la lecture. Le Warden exige exactement une preuve fraîche pour sept états : `initial-current`, `depth-min`, `depth-max`, `tunnel-min`, `tunnel-wide`, `growth` et `restored-current`. Ce readback et cette matrice sont strictement diagnostiques : ils ne s’exécutent jamais pendant une partie normale et n’ajoutent donc aucun coût par fourmi.

## Résolution physique et profondeur

Le volume souterrain est une grille monolithique fixe de `128 × 64 × 128` voxels. Sa borne basse suit le point de navigation le plus profond avec une marge de 3 unités monde ; sa borne haute dépasse la surface de 1,7 unité. La taille verticale d’un voxel dépend donc directement de la profondeur demandée.

La profondeur configurable est bornée entre 19 et 24 unités monde pour deux raisons différentes. La borne basse 19 est la première profondeur où le routage déterministe du registre complet de 96 loges reste constructible pour toutes les largeurs de tunnel de 5,5 à 12 : chambres étrangères et tunnels non adjacents conservent au moins 0,4 unité monde de terre, y compris après les détours locaux bornés. Une valeur plus faible ne garantit plus cette séparation exhaustive.

La borne haute 24 vient de la résolution. À cette profondeur, le diamètre du tunnel minimal, après le facteur physique de rayon, couvre encore au moins trois voxels verticaux. Cette densité est le minimum retenu pour préserver une galerie continue et une interpolation de paroi stable.

Les anciennes sauvegardes sont migrées sans devenir invalides : une valeur inférieure à 19 est ramenée à 19 et une valeur supérieure à 24 est ramenée à 24. En revanche, l’API de construction rejette explicitement une profondeur non finie ou hors intervalle afin qu’une erreur de programmation ne soit jamais masquée.

Une profondeur de 200 unités n’est pas compatible avec ce volume fixe : chaque tranche verticale deviendrait trop épaisse par rapport aux tunnels. La prendre en charge demanderait une autre représentation, par exemple des volumes en briques, une clipmap ou une structure clairsemée multi-résolution. Elle ne doit pas être acceptée en dégradant silencieusement la physique.

## Preuves

- `NAV-SURFACE-001` vérifie les repères transportés orthonormaux sans retournement à 180°.
- `NAV-SURFACE-002` vérifie, sur les 12 pistes, des tables directes finies, des supports et tangentes unitaires et orthogonaux, une progression `axisT` monotone, la symétrie du sens inverse et la cohérence des longueurs. Il ne constitue pas l’oracle SDF.
- `NAV-SURFACE-003` est l’oracle SDF : chaque nœud de piste et les interpolations à 25 %, 50 % et 75 % de chaque segment restent dans les tolérances de la surface propre rendue.
- `NAV-SURFACE-004` vérifie la convergence continue au plancher exact des portails.
- `NAV-SURFACE-005` vérifie que `depth` désigne le plancher physique d’une cavité.
- `NAV-SURFACE-006` rejette une géométrie de chambre invalide avant le bake GPU.
- `NAV-SURFACE-007` impose une borne dure de stretch de rééchantillonnage par corridor.
- `NAV-SURFACE-008` parcourt K96 × 12 pistes et borne la rotation des supports, des tangentes brutes et des tangentes projetées comme le GPU ; il interdit aussi tout segment rétrograde et revalide le contact SDF et la bouche.
- `COL-CONFINEMENT-001` à `COL-CONFINEMENT-003` remplacent l’ancien rayon global par l’oracle topologique de T4 : une fourmi sur une arête doit coïncider avec sa piste compilée, une fourmi dans une chambre avec sa primitive physique, et l’entrée ou le vestibule avec le patch borné de leur nœud.
- `NAV-SURFACE-PERF-001` vérifie que la clé spatiale 48 bits est entière exacte, sans collision sur ses valeurs représentatives et qu’elle rejette toute coordonnée hors domaine.
- `NAV-SURFACE-PAR-001` à `NAV-SURFACE-PAR-004` vérifient la partition/fusion bit-identique, le fallback synchrone quand Worker est absent, le fallback réservé aux erreurs d’infrastructure, la propagation des erreurs déterministes et la terminaison des workers.
- `NAV-NEST-TXN-001` à `NAV-NEST-TXN-004` vérifient la FIFO, le rejet intact avant publication, le commit unique et l’équivalence binaire du candidat Worker pendant une vraie croissance ou reconstruction.
- `NAV-NEST-PAUSE-001/002` vérifient que le bake laisse la simulation active, puis que la seule barrière de commit restaure toujours l’état de pause, y compris après une erreur GPU.
- `NEST-LAYOUT-001` à `NEST-LAYOUT-004` vérifient un registre déterministe et append-only, des parents bornés, puis exhaustivement les 96 loges, les largeurs 5,5..12, l’entrée périphérique, les détours bornés et la marge de terre minimale de 0,4.
- `NAV-VOLUME-001` vérifie l’intervalle physique 19..24 et le rejet explicite de toute profondeur invalide, dont 200.
- `NAV-VOLUME-002` vérifie qu’à la profondeur maximale le tunnel minimal conserve au moins trois voxels verticaux, avec la marge haute de 1,7.
- `NAV-VOLUME-GPU-001` à `NAV-VOLUME-GPU-004` protègent l’adressage 3D, le décodage RGBA16F, l’interpolation et les signes ; `005` signe toutes les primitives et bornes du volume propre ; `006` invalide les révisions ou signatures périmées ; `007` impose les sept preuves Warden fraîches et distinctes. `NAV-VOLUME-GPU-001` désigne aussi la sonde Warden bloquante exécutée sur le volume réel.
- `NAV-ENTRANCE-001` vérifie que la paroi atteint l’anneau de surface sans recentrage.
- `NAV-ENTRANCE-002` vérifie le trou physique par raycast de test.
- `NAV-ENTRANCE-003` vérifie l’identité du rayon entre le sol et la gorge.
- `NAV-ENTRANCE-004` rejette une entrée trop courte pour contenir sa gorge et son coude continus.
- `NAV-ENTRANCE-005` fixe le nœud, la bouche, l’anneau rendu et les 12 contacts dans le même plan `y = 0`.
- `NAV-ENTRANCE-006` protège le premier impact et le glissement tangent pour un grand pas de temps ; `007` couvre tangence et départ sur la lèvre ; `008` interdit toute arrivée extérieure dans le disque protégé ; `009` garantit une émergence graduelle qui ne repart pas vers le centre ; `010` réserve le collier jusqu’à la bouche aux seules candidates autorisées à entrer.
- `NAV-ENTRANCE-RUNTIME-001` force en 0,5 seconde une sortie puis une entrée sur deux fourmis identifiées. Le verdict Warden exige cette couverture aller-retour en plus des unités et de tous les scénarios.

Les tests de route conservent le budget résiduel à travers plusieurs arêtes et prouvent l’invariance au partitionnement temporel. Le Warden exige en plus zéro `posesNonFinies`, zéro `pivotsHorsSupport`, zéro `orientationsHorsRepere`, les sept preuves volumiques fraîches et liées à leur signature, ainsi que l’aller-retour de bouche forcé. Les invariants de routage, continuité, profondeur, croissance append-only et complexité complètent ces contrats dans la suite `test/corridor-network.*.test.js`.
