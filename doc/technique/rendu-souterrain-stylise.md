# UNDERGROUND-VISUAL — Rendu souterrain stylisé

## Objet du contrat

La vue souterraine transforme la terre autour de la caméra en une excavation lisible sans transformer cette excavation en géométrie de jeu. Elle doit simultanément :

- montrer une matière organique et volumique à l’échelle du monde, sans bandes horizontales franches ;
- conserver les vraies chambres et galeries issues du volume SDF du nid ;
- ne modifier ni la navigation, ni les collisions, ni le registre de croissance ;
- rester bornée indépendamment de la population et de la topologie active ;
- basculer atomiquement avec la couche de rendu de la caméra.

Le bake `camera-excavation-v2` de `src/underground-visual.js` contient uniquement des données d’authoring déterministes. Il n’importe pas Three.js et ne connaît ni les fourmis ni les nœuds du nid. `src/underground.js` le construit au démarrage puis le régénère seulement si l’épaisseur du sol change, toujours avec les mêmes capacités bornées.

## Deux géométries volontairement séparées

Le nid physique reste défini par le volume de `nestvolume.js`. Son SDF commande les chambres, les tunnels, le raymarch des parois et le scanner. Il est reconstruit seulement lorsque la forme du nid change.

Le raymarch ferme aussi explicitement les axes exceptionnellement longs par un fond visuel de terre à distance bornée. Un rayon presque aligné avec un tunnel ne peut donc jamais révéler le fond de scène noir ou perdre sa précision de profondeur. Lorsqu'un rayon passe du vide à la matière, trois bissections affinent le contact, puis une largeur de transition dérivée de `fwidth` lisse la lèvre à l'échelle du pixel : le contour et la profondeur restent stables sans augmenter le nombre de pas dans le reste de l'image.

L’excavation de caméra est un second champ, éphémère et purement visuel. Sa forme principale est une sphère de rayon réglable, perturbée par un relief borné. Avec la convention « négatif dans le vide », le champ rendu est l’union :

```text
dRendu(p) = min(dNid(p), dExcavationCamera(p))
```

Cette union ouvre une fenêtre autour de la caméra et la raccorde naturellement aux cavités réelles. L’excavation est intersectée avec le demi-espace souterrain `y ≤ -0,004` afin que son relief ne perce jamais la surface. Elle n’est jamais écrite dans la texture du nid, renvoyée à la simulation ou consultée par une fourmi. Déplacer la caméra déplace donc la fenêtre sans creuser, sans persistance et sans invalider les tables de navigation.

Le scanner demeure indépendant de cette union : il échantillonne le canal propre du volume physique. Il peut ainsi afficher le réseau réel sans dessiner la bulle de caméra comme une fausse chambre.

## Entrée et sortie du bloc

La plongée est un état binaire dérivé uniquement du bloc de terre :

```text
y < 0
y >= -groundThickness
abs(x) <= WORLD / 2
abs(z) <= WORLD / 2
```

Le mouvement cinématique ou OrbitControls est résolu avant ce test. La position de la caméra, l’union SDF et la couche visible appartiennent donc à la même frame. Le masque de couche reste binaire ; sur le front entrant, seul le rayon visuel de l’excavation s’ouvre brièvement via `digBlend`, de 0,42 à 1 à raison de 1,9 par seconde.

Au front de plongée, `main.js` masque ou restaure d’un seul bloc le terrain de surface, son socle, l’entrée, les accessoires, la nourriture, le ciel et ses lumières. Le brouillard de surface est retiré pendant la plongée puis restauré à la sortie. Le sous-sol fournit sa propre atténuation avec la distance et sa lampe frontale.

## Matière organique 3D

La matière conserve cinq ancres de palette — terre sombre, terre brune, argile, ocre et minéral clair — mais elles ne sont plus dessinées comme cinq bandes superposées. La profondeur monde n’est qu’une tendance générale. Deux champs de bruit 3D déforment cette tendance et distribuent les couleurs en amas irréguliers dans les trois axes ; une fusion large mélange les familles minérales avant que le grain fin n’ajoute le détail local. Les mêmes coordonnées monde donnent la même couleur quelle que soit la caméra.

Les cinq couleurs sont des uniformes modifiables en direct. **Chaos des couleurs** règle l’amplitude des déformations, **Taille des amas** leur échelle monde, **Fusion des couleurs** la largeur des transitions, **Grain minéral** le microcontraste et **Contraste** l’écart final autour de la luminance moyenne. Aucun de ces réglages ne reconstruit le volume physique, la navigation ou le bake des objets.

Le relief reste un réglage distinct : il modifie uniquement la coque de l’excavation visuelle. Le détail fin de la terre s’atténue avec la distance afin d’éviter le moiré.

## Pools périodiques et instanciés

Le décor est généré déterministement depuis une graine stable. Ses tableaux gardent une taille fixe ; seule une modification de l’épaisseur du bloc régénère leur contenu :

- **3 375 mottes** instanciées donnent le volume granuleux de la terre ;
- **225 segments de racines dans le bake courant, pour un cap contractuel de 1 152** forment des chaînes et ramifications raccordées ; leurs extrémités restent entre la surface et 8,5 unités de profondeur ;
- **256 candidats Rock**, **64 candidats Bone** et **48 candidats FishBone** sont distribués dans toute l’épaisseur.

La poussière a été entièrement supprimée : il n’existe plus de pool `Points`, de réglage associé ni de coût de mise à jour.

Les trois modèles sont chargés une seule fois par `src/underground-assets.js`. Chaque scène GLB est aplatie, ses transformations sont appliquées à la géométrie, puis le maillage est centré et normalisé avant instanciation. Le dépôt contient `Bone.glb` — et non `Bong.glb` — aux côtés de `Rock.glb` et `FishBone.glb`. Une géométrie et un `InstancedMesh` fixes sont conservés pour chaque famille ; changer fréquence, dimension, variation, couleur ou exposition ne recharge pas le fichier.

Les positions horizontales des mottes, objets et plantes racinaires appartiennent à une tuile de 26 unités. Les instances sont repliées vers la copie la plus proche ; chaque plante est sélectionnée puis décalée comme une unité atomique de neuf segments, ce qui préserve ses raccords aux frontières périodiques. Le cache des matrices est invalidé par un déplacement suffisant ou un changement géométrique visible. Une translation exacte d’une tuile reproduit la même géologie.

Les mottes utilisent un matériau Lambert ; les trois objets GLB utilisent un `MeshStandardNodeMaterial` PBR rugueux, sans multiplication de teinte par instance et avec les normales produites par les modèles. Tous partagent `sampleSDFClean(positionWorld) >= 0` via leur `maskNode`. Le test de profondeur découpe l’excavation et ce masque retire chaque fragment situé dans le vide physique du nid. Chaque transformation d’objet est écrite directement depuis ses coordonnées monde périodiques : aucune translation radiale vers la caméra n’est autorisée. **Exposition** modifie seulement la bande de sélection autour de la coque, afin de privilégier les objets naturellement plus saillants ; elle ne modifie jamais leur position, rotation ou échelle.

## Profondeur, composition et scanner

Le point touché par le raymarch écrit une profondeur réelle. Les fourmis souterraines, le couvain, les stocks et les éléments instanciés peuvent ainsi être occultés par la terre et apparaître dans les cavités sans tri transparent global.

Un raymarch opaque unique couvre tous les rayons de la vue souterraine ; aucune sphère de fond séparée n’est dessinée. La palette et le grain sont évalués au point monde touché. Une faible lumière ambiante empêche les silhouettes noires. Une clé directionnelle ivoire, placée au-dessus et à gauche dans le repère de la caméra, révèle les normales quelle que soit l’orientation de la vue. Les objets n’emploient aucun émissif : leurs faces sombres, demi-teintes et reflets PBR restent donc lisibles sans filtre brun.

Le scanner est une passe additive tardive, sans test ni écriture de profondeur. Il traverse le terrain et ne s’active que si la caméra est dans le bloc, l’option scanner active et la colonie présente. Le désactiver supprime uniquement l’hologramme ; l’excavation, la matière et le décor géologique restent actifs.

## Budget fixe

La déclaration de budget vérifiée par `UNDERGROUND-VISUAL-PERF-001` fixe le socle stylisé à six draws de base :

| Draw | Instances ou primitives |
|---|---:|
| Terre / excavation | 1 `BoxGeometry`, 12 triangles |
| Mottes | 3 375 instances, 20 triangles chacune |
| Racines | 225 segments courants ; cap 1 152 à 20 triangles |
| Rochers | pool 256, au plus 18 présentés autour de la caméra ; 166 triangles chacun |
| Os | pool 64, au plus 8 présentés ; 304 triangles chacun |
| Arêtes | pool 48, au plus 7 présentées ; 588 triangles chacune |

Le plafond conservateur exact vaut **180 728 triangles** : `12 + 3 375 × 20 + 1 152 × 20 + 256 × 166 + 64 × 304 + 48 × 588`. Il inclut toutes les capacités maximales ; le rendu courant en dessine moins lorsque les fréquences sont réduites. Les capacités, les six draws de base et les tableaux CPU ne dépendent ni du nombre de fourmis, ni du nombre de chambres, ni du rayon du nid.

Le scanner optionnel ajoute un draw distinct, soit au plus sept avec les six draws de base ; il reste hors du budget géologique de 180 728 triangles. Le contrat recalcule le plafond depuis le catalogue et les géométries réelles. Il ne mesure pas un temps GPU universel, qui reste à qualifier par instrumentation, GPU, pilote, résolution et réglages.

## Réglages exposés

Dans **Fourmilière & castes → Sous-sol & matière** :

| Réglage | Valeur initiale | Intervalle UI | Effet |
|---|---:|---:|---|
| Rayon d’excavation | 9 u | 6–10 | taille de la fenêtre visuelle autour de la caméra |
| Relief de la terre | 1 | 0–1,8 | amplitude des irrégularités de la coque |
| 5 couleurs de terre | palette brune | sélecteurs de couleur | ancres de la palette volumique |
| Chaos des couleurs | 1,15 | 0,45–2,2 | déformation 3D des zones colorées |
| Taille des amas | 7,5 u | 3–18 | échelle monde des variations |
| Fusion des couleurs | 0,21 | 0,10–0,38 | douceur des mélanges |
| Grain minéral | 0,34 | 0–0,8 | détail colorimétrique fin |
| Contraste | 1 | 0,6–1,4 | écart final de la palette |
| Fréquence Rock/Bone/FishBone | 0,85 / 0,70 / 0,55 | 0–1 | part active de chaque pool |
| Dimension par famille | 0,90 / 0,95 / 1,15 | 0,1–2,5 | échelle moyenne des instances |
| Variation par famille | 0,65 / 0,50 / 0,45 | 0–1 | dispersion déterministe des tailles |
| Couleur par famille | roche / ivoire | sélecteurs de couleur | teinte du matériau instancié |
| Exposition | 0,72 | 0–1,2 | saillie des objets vers la cavité visible |
| Lampe frontale | 1 | 0–3 | éclairage des vraies parois |
| Occlusion | 1 | 0–1 | lecture des recoins et volumes |

La fusion et l’irrégularité des parois appartiennent au volume physique et demandent un rebuild. Les réglages de matière et d’objets enfouis restent purement visuels et sont appliqués en direct dans leurs bornes sûres. Le dossier **Scanner** possède séparément intensité, impulsion et couleurs.

## Limites connues

- Le masque de couche bascule sans fondu au plan `y = 0`, mais l’excavation s’ouvre brièvement de `digBlend = 0,42` à 1.
- L’excavation ne constitue ni un outil d’édition ni une preuve de navigabilité.
- La périodicité de 26 unités peut laisser reconnaître un motif avec une caméra très stable ou une vue très large ; le rayon maximal de 10 évite toutefois le popping aux frontières de tuile.
- Les racines s’arrêtent à 8,5 unités et ne modélisent ni croissance, ni collision, ni interaction biologique.
- Les rochers, os et arêtes sont décoratifs ; ils ne bloquent aucune fourmi.
- Les capacités fixes privilégient une densité stable. Les augmenter exige de réévaluer explicitement draws, triangles, mémoire et remplissage GPU.
- Tout nouvel objet réservé à la surface doit rejoindre le masque atomique de transition ou posséder sa propre garde de couche.
- Les tests purs ciblent les contrats à risque : déterminisme, bornes, chargement unique, masque SDF et budget. La composition artistique des couleurs, la lisibilité des amas et la qualité du rendu restent validées visuellement dans un navigateur WebGPU ; elles ne sont pas figées par des assertions fragiles.

## Preuves

- `UNDERGROUND-VISUAL-001` : cinq ancres de palette configurables ;
- `UNDERGROUND-VISUAL-002` : plongée déterminée uniquement par le bloc physique ;
- `UNDERGROUND-VISUAL-003` : bake déterministe, borné et sans poussière ;
- `UNDERGROUND-VISUAL-004` : racines superficielles et raccordées ;
- `UNDERGROUND-VISUAL-005/006` : matière périodique ancrée et dimensions maximales compatibles avec une tuile ;
- `UNDERGROUND-VISUAL-008` : poussière absente des données, du runtime et des réglages ;
- `UNDERGROUND-VISUAL-009` : catalogue GLB exact, borné et fichiers valides ;
- `UNDERGROUND-VISUAL-010` : candidats déterministes et fréquence monotone ;
- `UNDERGROUND-VISUAL-011` : dimensions finies et bornées ;
- `UNDERGROUND-VISUAL-PERF-001` : six draws de base et 180 728 triangles au plafond.

Les tests de transition complètent ces preuves en contrôlant l’exposition du socle, l’ordre caméra→plongée, la bascule atomique, la garde commune des éléments de jeu, puis la migration bornée des réglages persistés avec `UNDERGROUND-TRANSITION-006`. `UNDERGROUND-RENDER-001` à `005` inspectent l’union et la profondeur, les invalidations, les plantes racinaires atomiques, le masque SDF des objets et leur chargement unique hors de la boucle de mise à jour.
