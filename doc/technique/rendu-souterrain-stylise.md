# UNDERGROUND-VISUAL — Rendu souterrain stylisé

## Objet du contrat

La vue souterraine transforme la terre autour de la caméra en une excavation lisible, sans transformer cette excavation en géométrie de jeu. Elle doit simultanément :

- montrer une matière stratifiée à l’échelle du monde ;
- conserver les vraies chambres et galeries issues du volume SDF du nid ;
- ne modifier ni la navigation, ni les collisions, ni le registre de croissance ;
- rester bornée indépendamment de la population et de la topologie active ;
- basculer atomiquement avec la couche de rendu de la caméra.

Le bake `camera-excavation-v1` de `src/underground-visual.js` contient uniquement des données d’authoring déterministes. Il n’importe pas Three.js et ne connaît ni les fourmis ni les nœuds du nid. `src/underground.js` le construit au démarrage puis le régénère seulement si l’épaisseur du sol change, toujours avec les mêmes capacités bornées.

## Deux géométries volontairement séparées

Le nid physique reste défini par le volume de `nestvolume.js`. Son SDF commande les chambres, les tunnels, le raymarch des parois et le scanner. Il est reconstruit seulement lorsque la forme du nid change.

L’excavation de caméra est un second champ, éphémère et purement visuel. Sa forme principale est une sphère de rayon réglable, perturbée par un relief borné. Avec la convention « négatif dans le vide », le champ rendu est l’union :

```text
dRendu(p) = min(dNid(p), dExcavationCamera(p))
```

Cette union ouvre une fenêtre autour de la caméra et la raccorde naturellement aux cavités réelles. L’excavation est aussi intersectée avec le demi-espace souterrain `y ≤ -0,004` (`uSurfaceCap = -0.004`) afin que son relief ne perce jamais la surface. Elle n’est jamais écrite dans la texture du nid, renvoyée à la simulation ou consultée par une fourmi. Déplacer la caméra déplace donc la fenêtre sans creuser, sans persistance et sans invalider les tables de navigation.

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

Au front de plongée, `main.js` masque ou restaure d’un seul bloc le terrain de surface, son socle, l’entrée, les accessoires, la nourriture, le ciel et ses lumières. L’herbe, les araignées et les cônes de débogage sont remasqués après leurs propres mises à jour, car celles-ci peuvent réécrire `visible`. Corps instanciés, sélection, nourriture portée et halo utilisent la même garde de couche ; la reine et les maillages de couvain sont explicitement réservés à la vue souterraine.

Le brouillard de surface est retiré pendant la plongée puis restauré à la sortie. Le sous-sol fournit sa propre atténuation avec la distance et sa lampe frontale : il ne dépend ni de la skybox ni de l’éclairage lunaire, tous deux désactivés.

## Matière et strates monde

Les horizons utilisent la profondeur monde normalisée par l’épaisseur du bloc, jamais la coordonnée écran :

| Horizon | Fraction de profondeur | Rôle visuel |
|---|---:|---|
| Humus | 0–0,08 | croûte sombre immédiatement sous la surface |
| Terre végétale | 0,08–0,28 | couche vivante où dominent les racines |
| Argile | 0,28–0,52 | matière plus dense et chaude |
| Ocre | 0,52–0,78 | transition minérale très lisible |
| Roche-mère | 0,78–1 | fond compact et désaturé |

Un bruit de basse fréquence décale légèrement les frontières sans les transformer en bandes caméra. Le contraste règle l’écart entre les couleurs ; le relief règle l’irrégularité de l’excavation. Le détail fin s’atténue avec la distance afin d’éviter le moiré.

## Pools périodiques et instanciés

Le décor est généré déterministement depuis une graine stable. Ses tableaux gardent une taille fixe ; seule une modification de l’épaisseur du bloc régénère leur contenu :

- **3 375 mottes** instanciées donnent le volume granuleux de la terre ;
- **384 roches** instanciées, plus rares et de tailles variées, traversent les horizons ;
- **225 segments de racines dans le bake courant, pour un cap contractuel de 1 152** forment des chaînes et ramifications raccordées ; leurs extrémités restent entre la surface et 8,5 unités de profondeur ;
- **128 particules de poussière** occupent la cavité autour de la caméra.

Les positions horizontales des mottes, roches et plantes racinaires appartiennent à une tuile de 26 unités. Les mottes et roches sont repliées individuellement vers la copie la plus proche ; chaque plante est sélectionnée puis décalée comme une unité atomique de neuf segments, ce qui préserve ses raccords aux frontières périodiques. Le cache des matrices est invalidé par un déplacement suffisant, un changement de rayon ou de relief ; un changement d’épaisseur régénère d’abord le bake géologique borné. Une translation exacte d’une tuile reproduit la même géologie. La poussière est un nuage local fixe qui suit la caméra, pas une quatrième tuile périodique.

Mottes et roches utilisent chacune un icosaèdre `detail 0` de 20 triangles et un `THREE.MeshLambertNodeMaterial` ; les racines emploient des segments pentagonaux low-poly avec un matériau Lambert classique. Les deux matériaux de matière partagent `matterVisibility = sampleSDFClean(positionWorld) >= 0` via leur `maskNode`. Le test de profondeur découpe l’excavation de caméra et ce masque retire en plus chaque fragment situé dans le vide physique du nid : aucune motte ni roche ne flotte dans une vraie galerie. Cette garantie coûte une lecture du volume par fragment sur chacun des deux draws fixes mottes/roches, sans passe ni draw supplémentaire. Le prédicat CPU `isEmbeddedInExcavationShell` sélectionne exactement la bande d’ancrage en production et dans `UNDERGROUND-VISUAL-005/006`. Les trois ensembles restent trois `THREE.InstancedMesh` et la poussière un unique `THREE.Points`. La bande externe des roches est limitée à 0,65 unité ; avec un rayon UI maximal de 10, le relief maximal et la plus grande roche tiennent dans la demi-tuile de 13 unités sans popping.

## Profondeur, composition et scanner

Le point touché par le raymarch écrit une profondeur réelle. Les fourmis souterraines, le couvain, les stocks et les éléments instanciés peuvent ainsi être occultés par la terre et apparaître dans les cavités sans tri transparent global.

Un raymarch opaque unique couvre tous les rayons de la vue souterraine ; aucune sphère de fond séparée n’est dessinée. La strate et le grain sont évalués au point monde touché. Les horizons restent ainsi ancrés dans la profondeur réelle, sans faux fond lié à l’écran ni bruit échantillonné à hauteur constante.

Une lumière ambiante chaude et une lumière ponctuelle proche de la caméra éclairent les détails sans ombres ; elles ne sont visibles qu’en plongée. Le scanner est une passe additive tardive, sans test ni écriture de profondeur. Il traverse le terrain et ne s’active que si les trois conditions sont vraies : caméra dans le bloc, option scanner active et colonie présente. Le désactiver supprime uniquement l’hologramme ; l’excavation, les strates et le décor géologique restent actifs.

## Budget fixe

La déclaration de budget vérifiée par `UNDERGROUND-VISUAL-PERF-001` fixe le socle stylisé à cinq draws de base :

| Draw | Instances ou primitives |
|---|---:|
| Terre / excavation | 1 `BoxGeometry`, 12 triangles |
| Mottes | 3 375 |
| Roches | 384 |
| Racines | 225 segments courants ; cap 1 152 |
| Poussière | 128 particules |

Le plafond conservateur exact vaut **98 232 triangles** : `12 + 3 375 × 20 + 384 × 20 + 1 152 × 20`. Il inclut les 12 triangles de la `BoxGeometry` porteuse et le cap contractuel des racines ; le bake courant de 225 segments en dessine moins. Les capacités, les cinq draws de base et les tableaux CPU ne dépendent ni du nombre de fourmis, ni du nombre de chambres, ni du rayon du nid.

Le scanner optionnel ajoute un draw distinct, soit au plus six avec les cinq draws de base ; il reste hors du budget géologique de 98 232 triangles. `UNDERGROUND-VISUAL-PERF-001` instancie les `BoxGeometry`, `IcosahedronGeometry` et `CylinderGeometry` réelles, recompte leurs triangles et vérifie ce total exact. Il ne mesure pas un temps GPU universel, qui reste à qualifier par instrumentation, GPU, pilote, résolution et réglages.

## Réglages exposés

Dans **Fourmilière & castes → Sous-sol & matière** :

| Réglage | Valeur initiale | Intervalle UI | Effet |
|---|---:|---:|---|
| Rayon d’excavation | 9 u | 6–10 | taille de la fenêtre visuelle autour de la caméra |
| Relief de la terre | 1 | 0–1,8 | amplitude des irrégularités de la coque |
| Contraste des strates | 1 | 0,6–1,4 | séparation colorimétrique des horizons |
| Poussière | 0,72 | 0–1 | densité visible du pool fixe |
| Lampe frontale | 1 | 0–3 | éclairage des vraies parois |
| Occlusion | 1 | 0–1 | lecture des recoins et volumes |
| Galeries en transparence | réglage `nestGhost` | 0–1,5 | révélation locale des cavités derrière la matière |

La fusion et l’irrégularité des parois appartiennent au volume physique et demandent un rebuild. Les quatre réglages propres à l’excavation ne modifient que le rendu borné. Après chargement des valeurs persistées et avant toute création géométrique, une migration les borne aux intervalles du tableau : rayon 6–10, relief 0–1,8, contraste 0,6–1,4 et poussière 0–1. Le dossier **Scanner** possède séparément intensité, impulsion et couleurs.

## Limites connues

- Le masque de couche bascule sans fondu au plan `y = 0`, mais l’excavation s’ouvre brièvement de `digBlend = 0,42` à 1 ; il ne s’agit pas d’un fondu croisé avec la surface.
- L’excavation ne constitue ni un outil d’édition ni une preuve de navigabilité.
- La périodicité de 26 unités peut laisser reconnaître un motif avec une caméra très stable ou une vue très large ; le rayon maximal de 10 évite toutefois le popping aux frontières de tuile.
- Les racines s’arrêtent à 8,5 unités et ne modélisent ni croissance, ni collision, ni interaction biologique.
- Les roches et la poussière sont décoratives ; elles ne bloquent aucune fourmi.
- Les capacités fixes privilégient une densité stable. Les augmenter exige de réévaluer explicitement draws, triangles, mémoire et remplissage GPU.
- Tout nouveau objet réservé à la surface doit rejoindre le masque atomique de transition ou posséder sa propre garde de couche.
- Les tests purs prouvent déterminisme, bornes et câblage source ; ils ne remplacent pas une inspection WebGPU réelle de la profondeur, du fog et du coût de fragment du raymarch.

## Preuves

- `UNDERGROUND-VISUAL-001` : cinq horizons ordonnés et contrastés ;
- `UNDERGROUND-VISUAL-002` : plongée déterminée uniquement par le bloc physique ;
- `UNDERGROUND-VISUAL-003` : bake déterministe, borné et indépendant du nid ;
- `UNDERGROUND-VISUAL-004` : racines superficielles et matière répartie sur tous les horizons ;
- `UNDERGROUND-VISUAL-005` : ancrage dans la coque via le prédicat CPU exact de production ;
- `UNDERGROUND-VISUAL-006` : densité périodique stable évaluée avec ce même prédicat ;
- `UNDERGROUND-VISUAL-007` : excavation maximale, relief et bande roche tiennent dans la demi-tuile sans popping ;
- `UNDERGROUND-VISUAL-PERF-001` : cinq draws de base et 98 232 triangles recalculés depuis les géométries réelles.

Les tests de transition complètent ces preuves en contrôlant l’exposition du socle, l’ordre caméra→plongée, la bascule atomique, la garde commune corps/sélection/grain/halo, le masque souterrain de la reine et du couvain, puis la migration bornée des quatre réglages persistés avec `UNDERGROUND-TRANSITION-006`. `UNDERGROUND-RENDER-001` à `004` inspectent en plus l’union et la profondeur, les invalidations du cache et du bake, les plantes racinaires atomiques, ainsi que les deux `MeshLambertNodeMaterial` masqués par le SDF propre.
