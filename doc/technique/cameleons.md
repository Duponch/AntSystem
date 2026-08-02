# CHAMELEON-SIM — Caméléon physique, navigation et prédation

## Portée

Le jeu principal utilise désormais le prototype physique validé dans `?test`.
Le contrat écologique reste inchangé : le caméléon est un prédateur de surface
qui consomme uniquement des papillons adultes et ne modifie ni la navigation,
ni les ressources, ni le coût GPU de la colonie de fourmis.

La locomotion, en revanche, n’est plus un déplacement cinématique corrigé après
coup. La position autoritative est celle d’un corps Rapier ; les appuis, la pose
du squelette, la queue passive et le matériau de camouflage dérivent de vrais
contacts avec la scène.

## Architecture du runtime principal

| Module | Responsabilité |
|---|---|
| `chameleon-physical-system.js` | orchestration du corps hybride, destinations autonomes, corridor A* événementiel, cycle écologique, prédation et camouflage |
| `chameleon-main-surfaces.js` | adaptation du registre de décor en colliders Rapier, surfaces grippables, profils de matériau et graphe de navigation partagé |
| `chameleons.js` | façade de compatibilité consommée par `pollinators.js`, le HUD et l’évitement des papillons |
| `chameleon-lab/hybrid-chameleon.js` | corps Rapier unique, griffes, démarche, IK, suspension, regard et queue XPBD |
| `chameleon-lab/physics-world.js` | monde Rapier à pas fixe et registre borné des corps/colliders |
| `chameleon-lab/surface-navigation-graph.js` | graphe de surfaces partagé, A*, portails et watchdog de progression |
| `chameleon-lab/support-cohort-model.js` | validation d’un groupe anatomique de prises et rejet des suspensions entre surfaces incompatibles |
| `chameleon-lab/surface-appearance.js` | profil compact de terre, roche, bois ou végétation associé à chaque collider |
| `chameleon-lab/surface-camouflage.js` | vote des griffes, hystérésis de support et matériau opaque adaptatif |
| `chameleon-procedural-gait.js` | alternance diagonale et trajectoires de transfert sans allocation chaude |
| `chameleon-head-look-model.js` | observation idle et regard pondéré vers la proie |
| `chameleon-simulation.js` | décisions de chasse et transaction de capture/consommation |
| `butterfly-simulation.js` | peur, capture atomique et remise dans le cycle de vie |
| `wildlife-inspector.js` | sélection, télémétrie et debug du seul animal suivi |

L’ancienne pile `chameleon-surface-collider` → `chameleon-surface-graph` →
`chameleon-rig` → `chameleon-body-contact`/`chameleon-tail-contact` n’est plus
l’autorité de locomotion du jeu principal. Ses réglages de sondes sont tolérés
dans le JSON d’une sauvegarde ancienne mais ignorés par la fusion des clés
connues ; ils ne sont plus exposés dans l’UI. Les invariants utiles restent
couverts jusqu’à suppression complète de la compatibilité.

## Contrat de façade

`createChameleons` conserve une façade stable afin que la migration physique ne
se propage pas aux autres espèces. Elle fournit au minimum :

- activation et visibilité ;
- application indépendante de `castShadow` et `receiveShadow` ;
- mise à jour logique au temps de simulation et synchronisation visuelle ;
- vue compacte de menace pour les papillons ;
- picking, snapshot d’inspection et volumes de debug ;
- destruction complète du monde physique et des géométries auxiliaires.

La transaction de prédation reste fondée sur les quatre callbacks stables
`tryCapture(index)`, `setCapturedPosition(index, x, y, z)`, `consume(index)` et
`releaseCapture(index)`. Les deux requêtes en lecture `hasLineOfSight(...)` et
`isTongueSegmentClear(...)` ajoutent l'occlusion du vrai décor sans transférer
à la physique la propriété du cycle de vie du papillon.

## Monde physique issu de la vraie scène

`chameleon-main-surfaces.js` parcourt les placements déjà créés par
l’environnement. Terrain, rochers, souches, troncs couchés, branches et arbres
verticaux obtiennent une représentation de collision immuable et un profil de
préhension. Le même transform monde — translation, rotation et échelle de
catégorie — alimente rendu, collider et navigation.

Les colliders statiques sont construits une fois après le chargement du décor.
Ils portent des métadonnées stables : identifiant du placement, classe de
support, rugosité/préhension et apparence de camouflage. Aucun maillage n’est
reparcouru pendant une image normale. Une édition du décor, une mise à
l’échelle des arbres/obstacles/rochers ou une reconstruction de l’entrée
programme une reconstruction différée et transactionnelle : l’ancien monde
reste valide pendant l’édition, puis il est détruit et remplacé hors de la
boucle physique chaude.

Les surfaces réellement accessibles forment un graphe partagé. Les arêtes
relient des voisins sur un même support ou un vrai raccord entre supports. Les
portails conservent leurs normales source et destination, leur propriétaire et
le dégagement requis par le corps. Une diagonale traversant le vide, l’intérieur
d’un rocher ou une face non grippable est rejetée en mode fermé.

Un index spatial XZ immuable référence les nœuds de ce même bake. Une poursuite
ne parcourt donc pas tout le graphe : elle demande un petit nombre de supports
proches de la proie dans des tableaux réutilisés, puis essaie A* dans cet ordre.

## Un corps hybride, pas un ragdoll explosif

`createHybridChameleon` crée :

- un corps dynamique Rapier avec CCD et sommeil ;
- une capsule de torse et une sphère de tête ;
- exactement quatre canaux d’appui ;
- quatre chaînes anatomiques épaules/hanches → coudes/genoux → paumes → doigts ;
- une démarche corps entier et une suspension à angles bornés ;
- une chaîne XPBD de 13 nœuds pour la queue originale ;
- des buffers de pose fixes pour interpoler le rendu.

La masse, la gravité, les impacts et les impulsions appartiennent au corps
Rapier. Les articulations visibles ne sont pas 33 corps rigides libres : cette
architecture évite les explosions de contraintes et reste assez légère pour
plusieurs animaux. La démarche et l’IK sont résolues au pas fixe ; le rendu
interpole deux poses finies sans changer la simulation.

Chaque griffe suit les états `reaching`, `swing` ou `holding`. Une prise valide
doit être à portée anatomique, appartenir à une surface grippable et rester
compatible avec la cohorte des autres prises. `SupportCohortModel` interdit
notamment :

- deux prises au mur et deux prises sur un sol physiquement éloigné ;
- deux faces opposées d’un même collider sans couture atteignable ;
- une capture à distance après un saut ou une saisie ;
- une prise dorsale qui laisserait le corps suspendu à l’envers.

Un impact réel élit d’abord un propriétaire. Le réflexe de redressement tourne
ensuite le ventre vers cette surface et les griffes l’acquièrent. Une hystérésis
`surfaceCommitTime` empêche d’alterner entre deux voisins dans un angle. Une fois
immobile avec une cohorte suffisante, le corps et les ancres peuvent dormir ;
une commande, un impact ou une cible les réveille explicitement.

## Démarche, regard et queue

La marche alterne les diagonales avant-gauche/arrière-droite et
avant-droite/arrière-gauche. Une trajectoire C1 lève la griffe, conserve un
dégagement central puis la repose. Le geste proximal provient réellement de
l’épaule ou de la hanche ; l’IK ferme seulement l’erreur terminale au niveau de
la paume et des doigts.

Le mouvement du bassin, du thorax, du cou et de la tête est composé au-dessus
de cette base. Au repos, une enveloppe déterministe ajoute respiration,
transfert de poids et points d’observation sans déplacer les appuis. Pendant la
chasse, `ChameleonHeadLookModel` augmente progressivement le poids de la proie ;
la bouche et la langue héritent donc de l’orientation réelle du crâne.

La queue conserve les 7 206 sommets de la géométrie source. `tail_01` protège
le collet sacré ; la liberté commence à `tail_02` avec une transition
géodésique. Les longueurs, la courbure, les contacts et la torsion minimale sont
résolus sur 13 nœuds XPBD. Friction statique, amortissement et sommeil empêchent
les rotations en hélice et le tremblement subpixel.

## Exploration par « clic virtuel »

L’exploration autonome réutilise exactement le pipeline d’une destination
cliquée du laboratoire :

1. le scheduler choisit un nœud atteignable dans le rayon autorisé ;
2. un score favorise les troncs, rochers, souches, arbres, les zones peu
   visitées et une continuité raisonnable du cap ;
3. A* construit un corridor sur le graphe partagé ;
4. le contrôleur physique poursuit uniquement le prochain jalon ;
5. un portail n’est validé qu’après acquisition de la nouvelle surface ;
6. arrivée, cible écologique ou stagnation déclenchent un nouvel événement de
   planification.

Il n’existe donc ni circuit, ni route hardcodée, ni A* par frame. Le chemin est
mis en cache jusqu’à consommation ou invalidation. Le watchdog observe progrès,
écart au corridor et alignement de support ; il recalcule avec un coût croissant
pour le portail fautif au lieu de rejouer la même boucle.

`chameleonDebugRoute` rend le corridor, le segment actif, les transitions et la
destination. Le debug n’entre jamais dans la décision.

## Machine écologique et prédation

La machine conserve les phases suivantes :

| État | Rôle |
|---|---|
| `REST_SCAN` | observation et possibilité d’une pause camouflée |
| `EXPLORE` | suivi du corridor autonome courant |
| `TRACK_PREY` | interruption du but autonome et approche de la proie |
| `AIM_AND_BRACE` | stabilisation des prises et regard vers la cible |
| `STRIKE_EXTEND` | extension vers un point figé |
| `CONTACT` | capture au vrai croisement balayé |
| `RETRACT_WITH_PREY` | retour continu de la langue et de la proie |
| `BITE_AND_SWALLOW` | consommation à la bouche |
| `COOLDOWN` | récupération puis reprise d’exploration |

La recherche parcourt au plus `MAX_BUTTERFLIES = 64` slots à cadence bornée.
Le bout de langue utilise un test segment–sphère balayé : une frappe rapide ne
peut pas traverser une proie entre deux sous-pas. Une capture conserve l’offset
de contact et ne consomme le papillon qu’à la bouche. Chaque segment parcouru
par la langue est aussi raycasté contre les colliders de la scène : au premier
obstacle, elle s'arrête au dernier point libre et se rétracte comme après un tir
raté. Une proie masquée perd la cible avant la préparation de la frappe.

## Camouflage opaque lié aux appuis

Le nouveau camouflage ne lit plus `viewportSharedTexture()`. Chaque collider
porte un profil `surfaceAppearance` compact — trois pigments, type de motif,
échelle, graine, contraste et rugosité. Le matériau TSL mélange ce profil avec
la palette naturelle du GLB tout en conservant normales, lumière, profondeur et
ombres.

Le support dominant est élu parmi les quatre griffes `holding`, pondérées par
leur charge. Le vote est O(4²), sans `Map` ni allocation. Trois temporisations
stabilisent le résultat :

- `camouflageSurfaceCommitSeconds` valide un nouveau support ;
- `camouflageSurfaceTransitionSeconds` fond entre deux apparences ;
- `camouflageSupportHoldSeconds` maintient brièvement le dernier profil pendant
  le transfert d’une patte.

Le matériau reste opaque et ne requiert ni capture du framebuffer, ni passe de
scène, ni compute shader. Le facteur `camouflageEyeRetention` protège les
détails oculaires. La logique de peur lit seulement le verrou écologique
`camouflaged`, jamais le matériau.

## Asset et échelle

`public/assets/ChameleonPhysical.glb` est l’unique asset du runtime. Son contrat
de mesh est `3.6.0` et son contrat anatomique `2.2.0` :

- un seul mesh fermé de 25 002 sommets source et 50 000 triangles ;
- un seul skin et 43 os ;
- 7 206 sommets originaux de queue ;
- paumes et doigts zygodactyles avec patches de contact exportés ;
- palette facettée `COLOR_0` RGBA8 et yeux intégrés ;
- un seul matériau PBR, le traitement toon global restant différé.

L’échelle runtime est strictement `1`. Modifier seulement le mesh invaliderait
les capsules Rapier, les longueurs de membres, les rayons XPBD, la portée des
griffes et la clearance A*. `config.js` force donc `chameleonScale = 1` après la
lecture de `localStorage`, et l’UI ne propose plus ce réglage.

## Réglages et migration

Les réglages actifs sont regroupés selon le solveur qui les consomme :

| Groupe | Clés principales |
|---|---|
| locomotion | `chameleonPatrolSpeed`, `chameleonTrackingSpeed`, `chameleonSprintMultiplier`, `chameleonAnimationSpeed`, `chameleonMoveForce`, `chameleonTurnSpeed`, `chameleonTurnTorque` |
| moteur/pose | `chameleonMotorStrength`, `chameleonMotorDamping`, `chameleonLimbMuscleTone`, `chameleonGaitFrequency`, `chameleonStepLength`, `chameleonStepHeight`, `chameleonStrideAmplitude`, `chameleonLimbLift`, `chameleonJointFlex`, `chameleonBodyMotion`, `chameleonSuspension` |
| griffes | `chameleonGripEnabled`, `chameleonGripStrength`, `chameleonGripStiffness`, `chameleonGripDamping`, `chameleonGripReach`, `chameleonRightingStrength`, `chameleonSurfaceCommitTime`, `chameleonSupportClearance` |
| queue | `chameleonTailDamping`, `chameleonTailFlexibility`, `chameleonTailCollisionScale`, `chameleonTailGravity` |
| camouflage | `chameleonCamouflageStrength`, `chameleonCamouflageAdaptSeconds`, `chameleonCamouflageReleaseSeconds`, `chameleonCamouflageSurfaceCommitSeconds`, `chameleonCamouflageSurfaceTransitionSeconds`, `chameleonCamouflageSupportHoldSeconds`, `chameleonCamouflageEyeRetention` |
| diagnostic | `chameleonDebugContacts`, `chameleonDebugRig`, `chameleonDebugRoute`, `chameleonDebugAttackRange` |

Une sauvegarde qui ne contient pas `chameleonMotorStrength` est reconnue comme
pré-hybride. Les anciennes valeurs explicitement modifiées sont conservées ;
les anciens défauts de hauteur de pas et de transition de camouflage sont
convertis vers les valeurs physiques calibrées. Les clés de fréquence/rayon des
anciennes sondes restent tolérées à la lecture mais sont cachées et sans
autorité. Toutes les nouvelles valeurs sont bornées avant la création du monde.

## Budget de performance

- un monde Rapier paresseux, créé seulement si le caméléon est activé ;
- un corps dynamique et deux colliders par animal ;
- quatre griffes, 13 nœuds de queue et des buffers typés de taille fixe ;
- un graphe statique unique dans le runtime actuel, dont les buffers sont
  conçus pour être partagés lors de l’ajout futur de plusieurs caméléons ;
- A* uniquement à une destination, une stagnation ou une invalidation ;
- aucun raycast de population et aucun parcours de mesh par frame ;
- scans de proies bornés par `MAX_BUTTERFLIES`, jamais par `antCount` ;
- sommeil du corps et de la queue lorsque l’animal est stabilisé ;
- matériau de camouflage opaque, sans copie de viewport et sans passe
  supplémentaire ;
- géométries de debug créées/affichées uniquement sur demande.

Le GPU reste responsable du rendu, mais déporter la décision ou le solveur de
quelques corps vers un compute shader ajouterait synchronisations et complexité
sans gain. Les coûts CPU sont bornés par le nombre de caméléons et leurs quatre
appuis, jamais par les fourmis.

## Stratégie de validation

La migration conserve trois niveaux :

1. tests unitaires purs des modèles de contrôle, cohorte, A*, camouflage,
   démarche, IK et queue ;
2. tests d’intégration Rapier au pas fixe pour prise, sommeil, transition de
   surface, sphère, cylindre, mur et rejet de suspension distante ;
3. campagne WebGPU dans `?test`, puis dans la vraie carte avec les vrais assets,
   pour la silhouette, la pose, le chemin et la chasse complète.

Les familles `CHAMELEON-LAB-*` et `CHAMELEON-PHYSICAL-ASSET-*` protègent le
moteur physique commun. `CHAMELEON-SIM-*`, `BUTTERFLY-FEAR-*` et
`WILDLIFE-INSPECTOR-*` protègent la façade écologique. La stratégie détaillée et
les scénarios manuels sont dans [la stratégie de tests](../qualite/strategie-tests.md).
