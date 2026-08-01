# Stratégie de tests

La qualité repose sur plusieurs oracles complémentaires. Aucun test isolé ne démontre qu’une fourmi ne pourra jamais se bloquer ; chaque couche réduit une classe de risques identifiable.

## 1. Contrats purs Node

Commande :

```powershell
npm test
```

La suite couvre notamment :

- `COL-ECO` : couches autoritatives du grenier, de la reine et du couvain ;
- `COL-START` : placement, rôles, délais et mode historique ;
- `NAV-SURFACE` : repères transportés, projection sur la surface propre, supports, pistes, portails, planchers, mutations atomiques et résolution physique du volume ;
- `NAV-ENTRANCE` : continuité de l’anneau, trou raycastable, rayon partagé, lèvre physique continue, placement périphérique et raccord borné ;
- `BEE-SIM` : cycle de butinage complet, déterminisme, météo, démographie agrégée, cohortes et recyclage stables, continuité de phase par clip, ciblage borné, vues SoA, layout/GLB/VAT bornés, draws fixes et boucle chaude sans allocation ;
- `BUTTERFLY-SIM` : cycle œuf→larve→chrysalide→adulte→œuf, immatures invisibles, activité adulte, météo indépendante du vieillissement, ciblage de quatre fleurs, SoA fixe, asset/clip/VAT, draw unique, chargement paresseux, perception bornée du caméléon et fuite continue ;
- `CHAMELEON-SIM` : prédation complète, rig et langue, graphe global borné de terrain/rochers/souches/troncs/branches/arbres, transitions, clearance, corridors locaux continus, exploration déterministe sans A* de routine, repères de support et réglages UI ;
- laboratoire physique du caméléon : route isolée, contrats de mesh/rig `3.6.0`
  et d’anatomie `2.2.0`, géométrie source exacte,
  `original_tail_vertices = 7206`, aucun poids de queue sur le corps, collet
  rigide `tail_01`, dynamique à partir de `tail_02` avec feather géodésique
  `0,18`, axes proximaux contenus dans le volume fermé, corps dynamique Rapier
  unique, collider composé, quatre appuis bornés, pilotage arcade sans crabe,
  vitesse cible de sprint `≥ 2,3×`, destination cliquée routée par le graphe
  d’accès statique du décor, saut dont hauteur et portée croissent avec la
  charge, idle corps entier, verrou statique par sommeil, repère osseux de queue
  à torsion minimale, démarche et IK résolues à `120 Hz`, membres passifs à
  faible tonus, reset, plafond de rattrapage et valeurs finies ;
- `UNDERGROUND-VISUAL` : palette volumique configurable, plongée bornée au bloc, excavation visuelle indépendante, pools périodiques déterministes, suppression de la poussière, chargement unique des GLB, masque SDF propre et budgets fixes ;
- `OBS` : intentions, arrêts attendus, détection d’immobilité, pause à vitesse nulle, distances monde, reset temporel, sélection faune bornée, menace, support, camouflage et volumes du seul individu suivi ;
- réseau de corridors : déterminisme, routage, budget résiduel multi-arêtes, invariance au découpage temporel, continuité, profondeur, limites, croissance append-only et complexité structurelle ;
- bake parallèle : partition équilibrée, fusion bit-identique, transfert unique des buffers, fallback synchrone et terminaison des workers ;
- transactions : FIFO, rejet avant publication, commit unique, pause minimale et équivalence binaire du candidat Worker ;
- `NEST-LAYOUT-001` à `NEST-LAYOUT-004` : registre complet et append-only, lecture du parent bake, entrée périphérique, détours contenus entre collerettes et séparation exhaustive avec au moins 0,4 unité de terre entre chambres/tunnels étrangers pour la matrice profondeurs 19/20/22/24 × largeurs 5,5/6/12 ;
- `NEST-NATURAL-001` à `NEST-NATURAL-006` : bake versionné de 96 fiches, déterminisme et préfixes K24/K96, arbre binaire enraciné avec bifurcations/feuilles/profondeur, variété des longueurs sans gabarit répété de quatre unités, proportion et tailles distinctes des vestibules et chambres en conservant les quatre fonctions fondatrices, puis gel profond et empreinte SHA-256 du registre relu ;
- `NEST-ORGANIC-001` à `NEST-ORGANIC-005` : couverture angulaire, rotations dans les deux sens et rareté des angles droits, puis trois lobes bornés, sinuosité visible mais limitée, rayons lisses sans perte de clearance et cohérence des profondeurs.

`COLONY-TROUGH-001/002` et `COLONY-BROOD-001` empêchent le rendu et les échanges de dériver vers une nappe superposée. `NAV-SURFACE-001` à `006` couvrent les repères, tables directes, contact SDF, portails et chambres. `NAV-SURFACE-007` borne le stretch ; `NAV-SURFACE-008` ajoute la campagne exhaustive K96 × 12 sur les supports, tangentes CPU/GPU, progression et contact. `NAV-SURFACE-PERF-001` protège la clé spatiale 48 bits. `NAV-SURFACE-PAR-001` à `004` protègent la partition et la fusion exactes ainsi que les chemins de fallback et d’erreur. `NAV-NEST-TXN-001` à `004` et `NAV-NEST-PAUSE-001/002` protègent la file de mutations, la publication atomique et la courte barrière GPU. `NAV-ENTRANCE-005` aligne toute la bouche sur `y = 0`; `NAV-ENTRANCE-006` à `009` couvrent grand pas, tangence, confinement extérieur et émergence. `NAV-VOLUME-001/002` protègent l’intervalle `[19, 24]` et la migration des paramètres : la borne basse est la première configuration exhaustive des 96 loges qui conserve 0,4 unité de terre pour toutes les largeurs 5,5..12 ; la borne haute maintient trois voxels verticaux dans le tunnel le plus fin. `NEST-NATURAL-001` à `006` empêchent le retour des séries de quatre ou la confusion entre vestibule et chambre ; `NEST-ORGANIC-001` à `005` empêchent qu’une simplification graphique désynchronise la surface physique. `NAV-VOLUME-GPU-001` à `004` protègent adressage, demi-précision et filtrage de la sonde. `OBS-PAUSE-001` et `OBS-DIST-001` protègent la sémantique de l’inspecteur.

`UNDERGROUND-VISUAL-001` à `006`, puis `008` à `011` protègent les contrats stables et coûteux à casser : cinq ancres de palette, test du bloc physique, bake indépendant du nid, racines superficielles, périodicité, absence de poussière, catalogue GLB exact (`Rock.glb`, `Bone.glb`, `FishBone.glb`), candidats déterministes et tailles bornées. `VISUAL-005/006` utilisent exactement le prédicat de production `isEmbeddedInExcavationShell`, sans oracle parallèle. `UNDERGROUND-VISUAL-PERF-001` exige six draws de base et le plafond exact de 180 728 triangles ; le scanner optionnel reste un draw supplémentaire. `UNDERGROUND-TRANSITION-001` à `006` couvrent la couche caméra, les contrôles UI et la migration bornée. `UNDERGROUND-RENDER-001` à `005` inspectent l’union SDF, les invalidations, les racines atomiques, les coordonnées monde fixes des objets sans reprojection caméra, leur masque `sampleSDFClean(positionWorld)` et le chargement unique des GLB hors de la boucle de mise à jour.

`BEE-SIM-001` à `007` protègent les vues préallouées, la reproductibilité octet par octet, l’accessibilité de chacun des huit états, la livraison de nectar/pollen, l’interdiction de départ dans l’obscurité ou par météo dangereuse, les cibles fleur/parcelle directes, le budget fixe de quatre candidates, les instantanés de diagnostic et l’absence d’allocation ou de hasard ambiant dans la boucle chaude. `BEE-SIM-008` à `013` couvrent la chaîne démographique 3 + 6 + 12 jours, l’indépendance entre météo et vieillissement, la stabilité des buffers et télémétries, le coût indépendant de la population agrégée, le recyclage déterministe des représentantes et l’initialisation uniforme du couvain. `BEE-SIM-014` garantit que les états partageant `FLIGHT` conservent leur phase et qu’une vraie transition `FLIGHT` ↔ `FORAGE` la réinitialise. `POLLINATOR-001` à `009` couvrent le layout déterministe et son fallback borné, l’arbre hôte, les nœuds, clips, atlas distincts corps/yeux/ailes et couleurs de sommets des GLB, la texture VAT sous 12 Mio, les capacités/draws fixes, le masquage sous terre, les exclusions sensibles aux échelles du décor et l’absence de chargement/VAT au démarrage lorsque le système est désactivé. L’orientation visuelle du modèle, les atlas, les teintes et la composition des fleurs restent soumis à une inspection WebGPU ciblée plutôt qu’à un test de pixels.

`BUTTERFLY-SIM-001` à `009` protègent les buffers et télémétries stables, la reproductibilité, le cycle complet, le vieillissement indépendant des conditions de vol, les trois comportements adultes, les cibles et directions indexées, la capacité fixe, le diagnostic et l’absence d’allocation de collection dans la boucle chaude. `BUTTERFLY-SIM-010` à `014` figent `Butterfly.glb`, `Flight_Butterfly`, les 1 105 sommets, 528 triangles, 13 joints, 81 images à 16 fps et 716 040 octets de VAT, puis l’unique draw instancié, l’orientation et le matériau éclairé, le chargement paresseux singleton, le masque de surface et le raccordement UI/config. `BUTTERFLY-FEAR-001` à `006` couvrent l’interruption par une menace visible, l’effacement immédiat de la peur face au camouflage, le champ de vision configurable, l’anticipation d’un prédateur mobile sans téléportation, la cadence de scan bornée et déterministe, puis la stabilité des buffers et du mapping de sélection. L’allure de la teinte et du battement reste contrôlée par inspection WebGPU plutôt que par comparaison de pixels.

`CHAMELEON-SIM-001` à `037` continuent de protéger la machine d’états, le ciblage 8–10 Hz, le contact balayé, la capture transactionnelle, le rig, les ombres et les réglages. Les preuves `029` à `033` ajoutent la bouche alignée sur la normale du support, l’indépendance déplacement/animation, le remplacement continu d’un corridor sans rupture de cap, l’exploration réactive sans circuit, le camouflage limité aux pauses planifiées et son verrou continu jusqu’à la frappe. `CHAMELEON-SIM-034` à `037` figent la transition perceptive monotone invariante au découpage temporel, les variantes précréées couvrant tout l’animal, le retour aux matériaux naturels à coût nul, l’unique `viewportSharedTexture` légèrement décalée, l’adaptation diffuse éclairée, la profondeur, la simple passe, l’ombre résiduelle dither et le préchauffage. `037` interdit explicitement la cape d’invisibilité : correspondance plafonnée à 0,86, au moins 14 % de réponse naturelle, contour plus lisible aux angles rasants, paramètres bornés et motif déterministe en espace objet. Les oracles interdisent les mipmaps, le blur, les draws ou les dispatchs compute supplémentaires ; l’équilibre artistique reste validé par inspection WebGPU plutôt que par comparaison de pixels. Dans `test/chameleon-surface-graph.test.js`, `CHAMELEON-SURFACE-001` couvre toutes les instances reconnues au-delà des anciens plafonds ; `002` vérifie les corridors terrain→rocher→tronc→arbre, les repères SoA et le plafond actif de 384 échantillons ; `003` exerce une fixture de rochers adversariale pour interdire les nœuds ou arêtes sans clearance ; `004` protège le cache par révision et configuration ; `005` prouve une exploration locale déterministe, continue, avec inertie et préférence pour les branches peu visitées. Le graphe CSR reste plafonné à 8 192 nœuds et les routes A* explicites ne servent qu’au diagnostic ou à une destination imposée. Les quatre contacts de pieds restent une approximation analytique : aucun test ne prétend valider un solveur IK complet qui n’existe pas.

`CHAMELEON-LAB-CAMOUFLAGE-001` à `007` protègent séparément le prototype physique :
profils et repères de support immuables, vote borné des quatre pattes, hystérésis
en faveur du support courant, transition invariante au découpage temporel,
variante `MeshStandardNodeMaterial` opaque et retour au matériau GLB naturel.
Ils exigent aussi un profil visuel strictement identique sur chaque collider
agrippable, interdisent dans tout le graphe adaptatif toute capture viewport,
passe compute ou requête de rayon, puis vérifient le cycle runtime et son UI.
La qualité des pigments, la continuité de la petite texture-array mipmappée et la conservation du
relief restent contrôlées par inspection WebGPU, pas par comparaison de pixels.

`WILDLIFE-INSPECTOR-001` à `003` prouvent que le picking logique ignore les slots invisibles, choisit le plus proche, n’exécute le raycast qu’au clic et arbitre papillon/caméléon. Ils vérifient aussi que le HUD explique intention, menace, support et camouflage, et que les volumes de portée et de vision appartiennent au seul animal sélectionné.

Le TDD n’est pas requis pour chaque retouche artistique sans incidence sur la simulation. Couleurs par défaut, équilibre visuel des amas et absence perceptuelle de bandes sont validés par inspection WebGPU ; les tests automatisés restent réservés aux invariants de ressources, de géométrie, de transition et de performance qui préviennent une régression fonctionnelle ou structurelle.

La documentation ne fige volontairement pas le nombre total de tests. Le nom, le contenu et le hash des fichiers de preuve contractuels sont suivis par `docs-sync`.

## 2. Build WebGPU/TSL

```powershell
npm run build
```

Le build détecte les imports, la syntaxe et une partie des erreurs d’assemblage. Il ne compile pas nécessairement toutes les branches TSL sur un GPU réel.

## 3. Tests fonctionnels GPU de colonie

Démarrer Vite puis ouvrir `?test=colony`, ou lancer `await __antsys.tests.run()` dans la console. Ces scénarios exercent sur GPU réel :

- T1 : démarrage naturel `COL-START` ;
- T2 et T3 : ponte, développement et croissance `COL-ECO` ;
- T4 : confinement souterrain ;
- T5 : livraison au grenier ;
- T6 : famine ;
- T7 : pinceau et réseau creusé ;
- T8 : mode historique ;
- T9 : échantillonnage des prédateurs limité aux vivantes de surface ;
- T10 : bascule colonie ON→OFF→ON et demandes rapides sérialisées, sans population hybride.

Les assertions biologiques stochastiques utilisent des bornes. Elles ne remplacent pas les invariants géométriques exacts.

## 4. Warden

Démarrer Vite puis ouvrir, par exemple :

```text
http://localhost:5173/?test=warden&wdur=120
```

Ou lancer `await __antsys.warden.run({ seconds: 120 })`. Le Warden avance la simulation manuellement à 60 Hz et échoue dès qu’une anomalie structurelle est comptée.

Ses oracles couvrent :

- dépassement de la distance cinématique 3D et warp XZ ;
- divergence de corridor ou de nappe ;
- toupie, blocage, sortie du volume, retour surface indésirable et mort corrélée ;
- `posesNonFinies` : position, quaternion, métadonnées ou repère attendu non finis ;
- `pivotsHorsSupport` : erreur latérale, hauteur du pivot ou échelle incompatible avec le contact ;
- `orientationsHorsRepere` : quaternion non unitaire ou axes haut/avant incompatibles avec la normale et la tangente attendues ;
- `NAV-VOLUME-GPU-001` : lecture réelle de contacts corridors/chambres dans le canal SDF RGBA16F téléversé.

La passe de contrôle lit le buffer produit par `kPose`, puis reconstruit le contact attendu depuis l’état intrinsèque et les deux textures précalculées. Elle vérifie donc le câblage et la transformation finale ; l’oracle SDF Node reste indépendant pour la géométrie de paroi. La sonde volumique lit huit texels par point et reproduit leur interpolation trilinéaire afin de vérifier zéro à la surface, air négatif et terre positive.

Les transitions surface/sous-sol ne sont pas exemptées de la borne cinématique : le contact exact et le budget résiduel font partie du déplacement mesuré. `NAV-ENTRANCE-RUNTIME-001` force déterministement une sortie et une entrée en 0,5 seconde. Le champ global `report.pass` exige les unités Warden, tous les scénarios, cette couverture aller-retour et la sonde volumique.

Les scénarios couvrent notamment profondeur extrême, tunnels étroits/larges, famine, capacité maximale et croissance append-only en trajet. Les kernels, buffers et readbacks Warden ne sont pas utilisés pendant le jeu normal.

## 5. Inspection ciblée

L’inspecteur `OBS` permet de suivre une fourmi précise, sa destination, son corridor, sa progression, sa vitesse mesurée et la raison d’un arrêt. Le même panneau accepte désormais un papillon ou le caméléon : il expose intention, menace, camouflage, classe de surface, support et corridor local sans devenir une source de décision. Les sphères et volumes de vision ne sont affichés que pour l’individu sélectionné. L’inspecteur sert à expliquer un échec mais ne remplace pas l’oracle automatisé.

La validation WebGPU ciblée doit encore confirmer visuellement la pose et l’absence de popping aux raccords terrain/rocher/tronc/arbre, le passage autour des obstacles, l’alignement du corps sur les normales et les quatre contacts approximatifs, la variété de l’exploration locale, la fuite continue et le centrage de la portée de langue sur la bouche. Les tests Node protègent les invariants numériques et de budget, pas la qualité artistique de la pose.

### Laboratoire physique du caméléon

Ouvrir `?test` ou `?test=chameleon` dans un navigateur WebGPU. La campagne manuelle minimale vérifie :

- pilotage arcade AZERTY/QWERTY dans le repère anatomique : `Q`/`A` et `D`
  tournent sans déplacement en crabe, sur sol comme sur plan incliné, et le
  réglage de sprint impose une vitesse cible au moins `2,3×` supérieure à celle
  de marche ;
- clic de destination limité aux surfaces grippables : parcours physique des
  jalons du graphe d’accès statique livré, sans coupe aérienne ni téléportation
  sur les raccords configurés, puis reprise immédiate par une entrée clavier ;
- adaptation progressive des quatre appuis à deux normales dans un angle sol/mur ;
- maintien de la seule commande avant pendant la séquence complète sol → mur →
  sommet → face opposée, sans prise de sous-face ni capture par un rayon dont
  l’origine se trouve déjà dans le collider ;
- marche sur les troncs rugueux, puis glissement attendu sur le verre ;
- passage locomotion stabilisée ↔ **Physique libre** sans téléportation, vrille ni articulation qui s’entortille ;
- saisie, secousse, lancer du corps unique et récupération progressive ;
- enjambées lisibles initiées aux épaules/hanches, flexion des coudes/genoux,
  idle corps entier avec transfert de poids discret, regard cou/tête vivant,
  légère vie secondaire de la queue, semelles complètes à plat et absence de
  jitter distal ;
- saut chargé : hauteur et portée croissantes, accroupissement avant départ,
  extension, repli aérien et compliance musculaire lisibles ;
- conservation exacte des 7 206 sommets de la queue originale, sans tube de
  remplacement, avec `tail_01` seul collet rigide, liberté graduelle à partir de
  `tail_02`, feather de skin géodésique `0,18`, raccord visuel continu au bassin,
  inertie, amortissement, contacts continus, repère osseux à torsion minimale
  sans accumulation de roulis, silhouette sans tressage et sommeil sans
  micro-mouvement ;
- verrou statique des griffes par sommeil Rapier après stabilisation, puis réveil
  immédiat sur commande, impact ou saisie ;
- arrêt sur une branche de petit rayon : au moins deux griffes conservées,
  normale radiale cohérente malgré des contacts opposés, au plus une remise en
  place par paire diagonale, puis verrou statique sans balancement perpétuel ;
- enregistrement tardif d’une branche avec le même verrou radial, métadonnées
  non finies ramenées sans contamination aux dimensions physiques du collider,
  puis transfert continu d’au moins deux griffes du flanc au bouchon d’un
  cylindre fini ;
- membres souples mais conservant un faible tonus pendant la saisie ou le mode
  libre, sans pénétration du torse ni entrecroisement de segments, puis
  récupération bornée de la pose sans déchirure visuelle ;
- lancer sur mur et cylindre rugueux : accrochage à la surface réellement
  touchée, rotation continue du corps et absence de téléportation ;
- absence de capture avant le premier manifold, aucune griffe dorsale,
  redressement ventral et propriétaire unique dans un coin multi-surfaces ;
- caméra sans traversée persistante du décor ;
- debug cohérent : un corps Rapier et au plus quatre appuis ;
- intégrité `OK`, coût complet du sous-pas p95 stable et absence de chargement Rapier sur la route normale.

Les tests `chameleon-lab-route`, `chameleon-lab-physics-world`,
`chameleon-lab-controller`, `chameleon-lab-navigation-route`, `chameleon-lab-input`,
`chameleon-lab-platformer-control`, `chameleon-lab-platformer-jump`,
`chameleon-lab-platformer-integration`, `chameleon-lab-whole-body-gait`,
`chameleon-lab-anatomical-limb`, `chameleon-lab-passive-limbs`,
`chameleon-lab-passive-tail`, `chameleon-lab-passive-tail-visual-rig`,
`chameleon-lab-active-ragdoll`,
`chameleon-lab-hybrid-controller-allocation` et
`chameleon-physical-asset` protègent la structure, les commandes et les bornes.
`CHAMELEON-LAB-CONTROLLER-011` à `013` protègent la priorité d’une destination,
la continuité du cap et l’unique raycast d’un clic valide avec rejet du verre.
`CHAMELEON-LAB-NAVIGATION-001` à `005` protègent les chaînes statiques des
perchoirs et du rocher incliné ainsi que leur stockage fixe, mais pas la
traversée physique de bout en bout. `PLATFORMER-CONTROL-015` interdit la
translation en crabe, `PLATFORMER-CONTROL-017` fixe le ratio de vitesse cible
du sprint, `PLATFORMER-CONTROL-018/019` maintiennent un cap de virage franc
pendant un appui continu comme après une impulsion brève, jusqu’à l’alignement
  du corps, et `PLATFORMER-CONTROL-020` borne l’avance de cette cible à `25,2°`
  sans réduire l’autorité du virage. `CHAMELEON-LAB-INPUT-007` empêche de rejouer une pression saut
consommée pendant une saisie ou le mode libre. `PLATFORMER-JUMP-001` à `021`
couvrent l’impulsion, la croissance monotone de la hauteur et de la portée,
coyote/buffer, la séparation d’un plafond, la précharge minimale visible, la
conservation d’un saut accepté et l’amorti fondé sur la descente maximale.
`CHAMELEON-LAB-PLATFORMER-INTEGRATION-007` et `008` protègent le clic
événementiel, la priorité du clavier et la réutilisation des enregistrements de
commande ;
`CHAMELEON-LAB-PLATFORMER-INTEGRATION-009` annule atomiquement l’autorité du saut
pendant une saisie ou en mode libre. `CHAMELEON-LAB-GAIT-005` protège l’idle
corps entier sans déplacer les pieds et `CHAMELEON-LAB-GAIT-009` supprime cette
enveloppe terrestre lorsque le corps est détaché. Dans
`test/chameleon-procedural-gait.test.js`, `CHAMELEON-GAIT-014` borne la remise
en place d’arrêt à une correction pour chacune des deux diagonales malgré des
candidats mouvants sur une surface courbe ; `CHAMELEON-GAIT-015` termine le
couple déjà en vol puis autorise exactement une correction de la diagonale
opposée, sans redémarrer de boucle.

Les identifiants `CHAMELEON-LAB-RAGDOLL-001` à `034` sont l’autorité de
non-régression de l’architecture hybride : un corps Rapier, quatre appuis, pose
corps entier et IK anatomique bornées, mode libre à membres passifs, queue XPBD
endormable, récupération d’impact et valeurs finies.
`CHAMELEON-LAB-RAGDOLL-021` couvre le verrou statique endormi et son réveil sur
intention ; le réveil par impact ou saisie d’un verrou déjà endormi reste dans la
campagne runtime ci-dessus. `CHAMELEON-LAB-RAGDOLL-022` couvre la pose du saut
chargé, `CHAMELEON-LAB-RAGDOLL-023` le transfert de griffes et la montée d’un
obstacle simple, `CHAMELEON-LAB-RAGDOLL-024` l’arrêt des canaux de marche et
d’idle terrestre après libération des appuis, `CHAMELEON-LAB-RAGDOLL-025` la
conservation physique de l’amplitude d’une commande inférieure à un, et
`CHAMELEON-LAB-RAGDOLL-026` un virage physique ample qui converge sans crabe ni
toupie, `CHAMELEON-LAB-RAGDOLL-027` sa réponse mesurée à `0,10`, `0,25` et
`0,50 s`, le quasi demi-tour physique à une demi-seconde et la dérive latérale
bornée sans perte d’appui, ainsi qu’un dépassement après relâchement inférieur à
`12°`. `CHAMELEON-LAB-RAGDOLL-028` impose les mêmes garanties sur une pente de
`18°`, puis `CHAMELEON-LAB-RAGDOLL-029` couvre `avant + virage` en marche et
sprint, sur plat et pente, avec un ratio latéral inférieur à `0,30`.
`CHAMELEON-LAB-RAGDOLL-030` exige qu’une petite branche rugueuse conserve au
moins deux griffes, converge vers le sommeil et reste sous les bornes de dérive
et de vitesse après déplacement. `CHAMELEON-LAB-RAGDOLL-031` impose avec la
seule commande avant le passage de la face proche d’un mur à son sommet puis à
sa face opposée ; il interdit la prise de la sous-face, vérifie la continuité des
appuis et complète les oracles unitaires d’agrégation des normales opposées et de
rejet des rayons démarrant dans un collider. `CHAMELEON-LAB-RAGDOLL-032`
reproduit la prise radiale et le sommeil lorsque la branche est enregistrée
après la construction du caméléon. `CHAMELEON-LAB-RAGDOLL-033` fournit des
métadonnées de branche non finies et exige le repli vers la géométrie Rapier,
une normale unitaire, deux griffes et un verrou endormi. Enfin,
`CHAMELEON-LAB-RAGDOLL-034` vérifie le transfert physique flanc→bouchon d’un
cylindre fini : au moins deux appuis, cadre tourné vers l’axe, progression au-delà
du bord et déplacement par sous-pas borné. Les preuves
spécialisées des membres verrouillent le faible tonus configurable, les capsules
du corps,
l’auto-collision segmentaire et une seule projection de scène par nœud libre et
par pas, indépendamment du nombre d’itérations XPBD. `RAGDOLL-020` verrouille
l’amplitude de la brasse avant, la continuité de vitesse et d’accélération
angulaires, l’idempotence du rendu
et l’identité des poses à 60/240 Hz lorsque la démarche et l’IK avancent au pas
fixe de 120 Hz. Les preuves d’asset verrouillent les contrats `3.6.0`/`2.2.0`, le
mesh source exact, `original_tail_vertices = 7206`, l’absence de poids `tail_*`
sur le corps, le collet cutané `tail_01`, la racine physique `tail_02`, le feather
géodésique `0,18`, l’application directe de la courbe collisionnée et les axes de
membres contenus dans le volume fermé. `CHAMELEON-LAB-TAIL-VISUAL-001` à `003`
verrouillent le transport parallèle sans accumulation de roulis, les repères
finis et le scratch fixe du rig visuel ; la silhouette de peau n’est pas un
oracle pixel. `CHAMELEON-LAB-PASSIVE-TAIL-021` et
`CHAMELEON-LAB-PASSIVE-TAIL-022` empêchent qu’un
plan de contact périmé freine la queue hors d’un support fini et qu’une correction
de milieu de segment laisse une extrémité dans un collider voisin. Le raccord
canonique sol–mur–sommet–face opposée et le transfert flanc–bouchon cylindrique
possèdent désormais leur preuve physique ; les autres transitions multi-surfaces
complexes et les destinations cliquées de bout en bout, la saisie
visuelle, la silhouette cutanée de la queue et la sensation du pilotage exigent
encore l’inspection runtime.

## Garde documentaire

```powershell
npm run docs:check
```

Le contrôle valide :

- les documents requis et les liens locaux ;
- les guides UI requis, leur frontmatter, leur ordre et leurs contrats ;
- les titres canoniques et les preuves nommées Node ou runtime ;
- l’appartenance de chaque source `src/navigation/*.js` à un contrat ;
- les hashes normalisés des documents, sources, tests et campagnes runtime.

Toute modification d’une source surveillée fait dériver le manifeste et impose une relecture explicite des tests et documents associés. `docs:sync` enregistre cette nouvelle version ; il ne prétend pas remplacer la validation sémantique humaine.

Après un changement intentionnel d’un contrat :

1. mettre à jour source, tests et document canonique ;
2. exécuter `npm test` et les campagnes GPU concernées ;
3. relire tous les guides UI associés ;
4. lancer `npm run docs:sync` ;
5. terminer par `npm run check`.

## Temps simulé et multiplicateurs

Les deux profils temporels ont des objectifs et des oracles distincts. Le mode fluide GPU-first, recréé par défaut à chaque session, protège la cadence, la continuité visuelle et des invariants causaux ; le mode strict protège la reproductibilité exacte au tick pour les tests et les replays. Toute campagne de transition vers strict doit commencer par le reset autoritatif transactionnel, jamais par la réutilisation directe d’un état fluide.

### Mode fluide

- `test/hybrid-time-policy.test.js` couvre la pause, l’unique passe par frame à `×1` ou moins, les nombres de sous-pas à `×4`, `×15` et `×22`, le plafond à huit sous-pas pour `×100`, et la borne `1/30 s` de chaque pas.
- `test/config-timing-session.test.js` prouve qu’une sauvegarde stricte est ignorée, que seul `?timing=strict` force la session et que `maxGpuSubsteps`, contrairement au profil, reste persistant.
- L’oracle vérifie à `10⁻¹²` près `requestedDt = consumedDt + droppedDt`. Le surplus explicite est autorisé ; une perte cachée, une dette ou un rattrapage ultérieur sont des régressions.
- Les contrats source `HYBRID-TIME-RUNTIME-*` verrouillent la branche non bloquante, la simulation regroupée des fourmis et l’unique calcul final de pose/LOD par frame.
- `test/gpu-dispatch-budget.test.js` vérifie que comportement, pose, LOD et spawn ragdoll dispatchent seulement les slots actifs, que le texel central du filtre de grille est réutilisé et que les arguments de draw ragdoll sont publiés sans troisième soumission.
- Les campagnes WebGPU à `×1` mesurent une pose fraîche à chaque frame, l’absence de barrière CPU/GPU autoritative et la coalescence des readbacks diagnostiques soumis après le rendu. Ces relevés peuvent avoir une frame de retard ; les campagnes comparent donc les invariants, l’ordre causal et les compteurs agrégés, pas une identité bit à bit entre FPS.

### Mode strict

- `test/simulation-clock.test.js` protège l’accumulation entière à `120 Hz`, la pause, le budget, la dette récupérable et l’absence de dérive sous plusieurs FPS avec jitter.
- `test/time-scale-ecosystem.test.js` compare aux mêmes ticks les états complets des abeilles, papillons, fleurs et du caméléon à `×1`, `×4`, `×15`, `×22` et `×100`.
- `test/readback.test.js` protège le verrou FIFO des barrières autoritatives ; le cache opportuniste du mode fluide ne remplace jamais un snapshot strict.
- `test/simulation-synchronization.test.js` prouve la sentinelle GPU non destructive, la vraie barriere de queue et l'invalidation par epoch des readbacks post-reset.
- `TIME-SCALE-RUNTIME-003` verrouille le reset transactionnel lors de la transition `fluid → strict` et le rejet des statistiques d'une ancienne generation.
- `test/spider-time.test.js` sépare les ticks des araignées de leurs uploads de rendu et protège leur PRNG.
- `test/spider-authority-readback.test.js` prouve qu’une frontière combinée passe par un unique snapshot et exactement un mapping GPU→CPU sous le verrou FIFO.
- `test/spider-kill-election.test.js` protège l’élection atomique et déterministe de la victime, le sentinel d’intervalle et l’absence de retour au buffer de position non atomique.
- `TIME-SCALE-RUNTIME-006` dans `test/time-scale-runtime.test.js` verrouille le chemin UI du toggle « Colonie vivante » : file autoritative, invalidation d’epoch, attente de barrière et arrêt des ticks via `resetPromise`.

Les campagnes WebGPU strictes comparent les compteurs de ponte, d’éclosion, de nourriture, les slots actifs et les décisions des prédateurs aux mêmes ticks de frontière. Toute lecture qui participe à cette décision doit alors venir de la barrière exacte, jamais d’un readback diagnostique best-effort.
