# Laboratoire du caméléon physique

## Portée

Le laboratoire accessible avec `?test` ou `?test=chameleon` est un banc d’essai
isolé pour une locomotion physique hybride. Il sert à éprouver les collisions
du corps, quatre appuis de surface, l’IK bornée des membres, le pilotage à la
troisième personne et la manipulation à la souris.

Il ne remplace pas encore le caméléon de la simulation principale décrit dans
[CHAMELEON-SIM](./cameleons.md). Il n’exécute ni la colonie, ni les abeilles, ni
les papillons, ni la prédation. Ses paramètres et son horloge ne modifient donc
jamais une partie normale.

## Décision d’architecture

Le prototype n’est plus un active ragdoll permanent. Une chaîne de nombreux
corps, articulations sphériques et moteurs concurrents créait trop de degrés de
liberté : les erreurs de contact se propageaient et le caméléon pouvait se
replier ou s’entortiller sur lui-même.

Le runtime utilise désormais :

- **un seul corps dynamique Rapier** pour la masse, la gravité, les collisions,
  les forces, la saisie et le lancer ;
- un collider composé d’une capsule de torse et d’un volume de tête ;
- **quatre appuis analytiques bornés**, un par pied ;
- une démarche procédurale et une IK visuelle limitée autour de la pose de
  repos ;
- un contrôleur de racine amorti de manière critique et borné en force et en
  couple.

Il n’existe donc pas de chaîne physique à 33 corps, pas d’auto-collisions entre
des dizaines de capsules et pas de rotules libres à stabiliser. Cette réduction
est le mécanisme principal de stabilité et de performance.

## Chargement et isolation

`src/bootstrap.js` choisit exactement un graphe d’application :

- sans paramètre `test`, avec `?test=colony`, `?test=warden` ou une valeur
  inconnue, il importe dynamiquement `src/main.js` ;
- avec `?test`, `?test=` ou `?test=chameleon`, il importe dynamiquement
  `src/chameleon-lab/main.js`.

Rapier, le GLB physique et le décor du laboratoire ne sont donc ni importés, ni
initialisés, ni mis à jour dans le jeu normal. Cette frontière protège le coût
CPU, la mémoire et le temps de démarrage de la colonie.

## Chaîne d’exécution

Le laboratoire associe onze couches :

1. `environment.js` crée les meshes WebGPU et leurs colliders Rapier fixes ;
2. `hybrid-chameleon.js` charge le GLB, crée le corps unique, les quatre appuis
   et coordonne le rig visuel ;
3. `anatomical-limb-solver.js` résout les ceintures, les deux segments et la
   surface complète de chaque main ou pied à partir du contrat exact du GLB ;
4. `whole-body-gait-model.js` prépare une pose anatomique corps entier à partir
   des phases d’appui et de transfert ;
5. `hybrid-controller-model.js` fournit les calculs purs de cadre de support,
   gains amortis, limites articulaires et forces bornées ;
6. `passive-limb-ragdoll.js` relâche les quatre membres pendant la saisie ou le
   mode libre, sans ajouter de corps Rapier ;
7. `passive-tail-physics.js` simule la ligne centrale passive de la queue et
   `passive-tail-visual-rig.js` la reporte sur les os du mesh original ;
8. `physics-world.js` avance Rapier à pas fixe et conserve deux poses pour
   l’interpolation visuelle ;
9. `third-person-controller.js` et `platformer-control-model.js` transforment
   AZERTY/QWERTY en intention troisième personne tangente au support, sans
   dépendre de l’inclinaison de la caméra ;
10. `platformer-jump-model.js` possède la machine d’états du saut, son impulsion
    calculée depuis la hauteur, la tolérance au bord, le buffer, la coupure au
    relâchement et l’amorti d’atterrissage ;
11. `grab-controller.js` applique la saisie et le lancer, tandis que
    `rig-debug-view.js` peut afficher le squelette complet à travers la peau.

Le mouvement global ne réécrit jamais directement la position du modèle : la
pose interpolée du corps Rapier pilote la racine visuelle. L’IK n’agit que sur
les os des pattes et ne crée aucune énergie dans le solveur physique.

## Contrat de l’asset et queue originale

`public/assets/ChameleonPhysical.glb` exporte un unique mesh skinné à partir de
la géométrie source préservée. Son contrat `mesh_contract_version = 3.5.0`
verrouille notamment :

- `exact_source_geometry = true` ;
- `source_vertex_count = 25002` ;
- `source_polygon_count = 50000` ;
- `original_tail_vertices = 7206` ;
- `tail_deformation_mode = "surface-geodesic-bspline-12"` ;
- `tail_physics_dofs = 0`.

Le contrat anatomique `2.1.0` recale les pivots sur la pose source réellement
fléchie : thorax/épaule/coude/poignet à l’avant, bassin/hanche/genou/cheville à
l’arrière, puis cou et crâne. Il publie aussi le plan de flexion au repos de
chaque membre. L’IK peut ainsi reproduire le rig exporté avant d’ajouter un pas,
au lieu de supposer une patte droite puis de la forcer vers le support.

Les axes proximaux ne sont plus validés uniquement par leurs coordonnées ou par
une vue de profil. Des sondes réparties sur chaque axe
épaule→coude→poignet et hanche→genou→cheville doivent rester dans le volume fermé
du mesh source, selon un vote de rayons non coplanaires. Le squelette de debug
trace ces mêmes axes exportés : une ligne située hors d’une patte révèle donc
une vraie régression anatomique et non un raccord graphique approximatif.

Chaque os de membre publie aussi sa longueur de repos exacte. Chaque paume
publie trois points de contact, leur centre et la normale extérieure de la
semelle dans le repère du rig. Le runtime ne déduit donc plus le pied depuis le
milieu approximatif de deux os : talon, paume et doigts utilisent la même
surface de contact, avec la convention physique correcte « semelle vers le
support, normale du support vers l’animal ». Les matrices inverses sont testées
à la pose de repos afin que l’ajout du rig ne déplace aucun sommet.

Les 7 206 sommets de la queue sont ceux de la queue originale enroulée. Ils ne
sont ni supprimés, ni remplacés par une queue tubulaire. Aucun sommet du corps
n’est pondéré par un os `tail_*`. À la couture, un garde sacré conserve les
sommets dans le repère du bassin ; `tail_01`, `tail_02` et `tail_03` forment un
pont rigide au-dessus de la croupe. La pondération dynamique ne commence
qu’après ce pont, sur `tail_04`, puis suit la ligne centrale courbe par distance
géodésique et mélange B-spline cubique. La queue peut ainsi fléchir sans tirer
les sommets du bas du dos ni créer une coupure de silhouette. Le champ
`tail_physics_dofs = 0` signifie qu’aucun corps Rapier supplémentaire n’est
exporté dans le GLB : le solveur XPBD borné du runtime représente les douze
segments, dont trois cinématiques et neuf passifs. Les 43 os d’authoring ne
correspondent donc pas à 43 corps Rapier.

La reconstruction est déterministe et s’exécute sans interface Blender :

```powershell
blender --background blender/chameleon_physics_rig.blend --python scripts/rebuild-chameleon-hybrid-asset.py
```

Blender et son MCP n’ont donc pas besoin d’être ouverts pour lancer, tester ou
reconstruire l’asset. L’interface Blender reste utile uniquement pour une
modification artistique ou anatomique volontaire de la scène source.

## Corps physique unique

Le corps dynamique utilise CCD, peut dormir et reçoit quelques itérations de
solveur supplémentaires. Une capsule représente le tronc et une sphère la tête
dans un collider composé. Tous les contacts du décor, les impulsions de saut et
les forces de saisie s’appliquent à ce même corps.

Le contrôleur n’écrit pas sa pose. À partir d’au moins deux appuis valides, il
calcule un centroïde et une normale moyenne, puis applique :

- une force PD amortie de façon critique vers une racine suggérée par les
  appuis ;
- la compensation bornée de la gravité le long de la normale ;
- une force tangentielle bornée vers la vitesse commandée ;
- un couple borné alignant progressivement le corps avec le support.

Une prise, un saut, un manque d’appuis ou le mode **Physique libre** désactive
ce rappel. Rapier reste alors l’unique autorité du mouvement global.

## Pilotage troisième personne et saut physique

Le déplacement clavier est échantillonné dans le pas physique. Un repère tangent
persistant est transporté par rotation minimale d’une normale de support à la
suivante (repère de Bishop), puis reçoit seulement le changement de lacet de la
caméra. Cette continuité supprime la singularité de l’ancienne double projection
sur un mur et la dérive accumulée autour d’un cylindre. Regarder presque
verticalement ne peut ni inverser ni annuler la commande : « avancer » reste
avant dans le repère de la surface, même pendant une transition sol/mur/branche.
La normale qui a servi à construire la commande accompagne celle-ci jusqu’au
contrôleur physique. Si les contacts découvrent une nouvelle normale pendant le
même sous-pas, l’intention est transportée vers ce nouveau plan au lieu d’être
simplement reprojetée : une couture abrupte ne peut donc pas créer une impulsion
latérale d’une image.
Les changements d’orientation et d’accélération sont bornés et tous les objets
de sortie sont réutilisés.

`Espace` ne déclenche plus une impulsion constante arbitraire. La vitesse de
décollage est dérivée de la hauteur demandée et de la gravité courante. La
normale du support sépare d’abord le corps du sol, du mur ou du cylindre, tandis
qu’une composante monde verticale conserve un saut lisible. Maintenir la touche
réduit la gravité de montée ; la relâcher tôt applique une coupure progressive.
La descente, le contrôle aérien, la tolérance au bord et la mémorisation d’une
pression juste avant l’atterrissage ont des bornes indépendantes.

La transition de prise est explicite. Au décollage, les propriétaires des
quatre anciens contacts sont supprimés : ils ne peuvent pas réapparaître dans
le vide. Après l’impact, la paire de collision réelle ou des semelles assez
proches amorcent un nouveau polygone de support. Une composante latérale rapide
oriente la recherche dans le sens opposé à la vitesse, ce qui permet à un saut
ou un lancer de reprendre un mur ou un cylindre sans reprendre par erreur le
sol précédent. L’atterrissage publie enfin une enveloppe d’amorti visuelle qui
comprime brièvement le bassin sans déplacer le corps physique.

## Quatre appuis et IK bornée

Chaque pied possède une cible et une normale dans des tableaux de taille fixe.
La recherche teste un ensemble borné de directions et n’accepte que les
colliders marqués `clawEligible`. Un mur de verre non éligible reste donc un
support de collision, mais jamais une prise.

La démarche procédurale alterne les couples diagonaux sans phase aérienne. Un
pas ne démarre qu’après la distance d’enjambée configurée : la remise en place
d’arrêt ne peut plus se déclencher pendant la marche. La trajectoire verticale
utilise une enveloppe quintique `C2` asymétrique : décollage rapide, plateau de
dégagement haut, puis pose plus douce. Les doigts ne raclent donc plus le sol
pendant la majeure partie du transfert. Avant la fermeture des
contacts, une pose corps entier anime les ceintures scapulaires et pelviennes,
les segments supérieurs, les coudes ou genoux, le bassin, le thorax, le cou et
la tête. Le bassin participe davantage au pas ; le thorax contre-oscille et la
tête compense pour conserver un regard stable.

À chaque rendu interpolé, le rig restaure sa pose de référence, applique cette
pré-pose lissée puis résout chaque patte par une chaîne analytique à ceinture
mobile : ceinture, segment supérieur, segment inférieur, paume et deux groupes
de doigts zygodactyles. Les longueurs, directions de repos, pivots, plans de
flexion et centres de semelle viennent du GLB. À vitesse nulle, l’attraction de
la ceinture vers le pied et le biais d’abduction valent exactement zéro : la
pose fléchie exportée est donc la référence réelle. L’épaule ou la hanche effectue une excursion ample ; le
coude ou genou adapte réellement son angle ; la paume entière reste tangente au
support et n’est jamais étirée pour masquer une erreur proximale. Toutes les
rotations restent bornées autour de la pose de repos. Une cible inaccessible ne
peut donc ni accumuler une torsion, ni faire vibrer frénétiquement un poignet ou
une cheville.

Le repère avant/haut/côté n’est jamais déduit des axes locaux de `spine_02` ou
du bassin, car ces axes suivent la chaîne exportée et ne coïncident pas avec ceux
de l’animal. Le runtime retire l’orientation de repos du parent, puis transporte
uniquement son delta anatomique courant. La suspension compare par ailleurs la
même grandeur des deux côtés — attache de ceinture vers centre de semelle — et
une correction de racine bornée conserve au moins 84 % de la flexion de repos
visée lorsqu’un support aplati oblige les quatre pieds à changer de hauteur.

Les normales propres à chaque pied orientent les paumes. Le corps utilise leur
cadre agrégé, ce qui permet de tester un angle sol/mur ou un tronc sans imposer
que les quatre pieds soient coplanaires. Longueur et hauteur du pas, amplitude
des épaules/hanches, levée des membres, flexion et mouvement du corps sont des
paramètres indépendants exposés dans l’interface.

## Queue passive à géométrie originale

La queue emploie une tige XPBD de taille constante : treize nœuds pour douze
segments. Les trois premiers nœuds imposent deux segments cinématiques
`tail_01` et `tail_02`. La liberté physique commence sur `tail_03`, mais sa
compliance augmente graduellement sur les contraintes proximales
`0,04 → 0,12 → 0,35 → 0,70 → 1`. Le garde de skinning à trois os reste inchangé
et protège toujours la croupe. Le mouvement de la queue ne peut donc pas
entraîner visuellement les fesses. Il n’existe aucun moteur, pose cible ou
couple musculaire dans ce prototype : gravité, inertie, amortissement,
contraintes de longueur et de courbure déterminent seuls son mouvement
secondaire.

Le solveur physique reste ancré au corps rigide, tandis que le bassin reçoit
encore sa pose procédurale au rendu. Pour éviter que ces deux repères ne
cisaillent la couture, le rig rebase la ligne dynamique au bout de `tail_02`,
puis mélange les rotations physiques de `tail_03`, `tail_04` et `tail_05` avec
des poids `0,28`, `0,58` et `0,82`; `tail_06..12` suivent à 100 %. Il ne réécrit
ni les sommets ni leur topologie : la frontière rigide/libre devient un gradient
continu au lieu d’une charnière visible.

Sept itérations résolvent les longueurs, la flexion et les collisions à 120 Hz.
Chaque nœud possède un rayon décroissant de la base à la pointe. Une projection
bornée contre les colliders fixes du laboratoire empêche la traversée du sol,
des murs, rochers et troncs ; le sol utilise une surface unilatérale afin de ne
jamais éjecter une queue posée vers le dessous d’une dalle épaisse. La scène
n’est interrogée qu’une fois par nœud dynamique éveillé et par pas fixe ; le
plan de contact obtenu est réutilisé pendant les itérations XPBD restantes. Le
coût des collisions externes ne dépend donc pas du nombre d’itérations. La
souplesse, l’amortissement, la gravité propre et l’échelle des rayons de
collision sont réglables. Une friction statique annule la dérive tangentielle
sous `0,055 m/s`; la projection dure qui réinjectait de l’énergie après le solve
est désactivée dès qu’un projecteur de collisions est présent. Une fenêtre de
repos déterministe met la tige en
sommeil lorsque sa racine et tous ses nœuds restent sous les seuils de
déplacement et de vitesse.
Pendant ce sommeil, les buffers sont conservés bit pour bit et les contraintes
ainsi que les collisions sont court-circuitées : une queue immobile ne produit
plus aucun micro-mouvement. Une impulsion, un déplacement du bassin ou une
modification du cône racine la réveille immédiatement.

Cette queue passive répond à une direction artistique précise. Une vraie queue
de caméléon est musculaire et préhensile ; le laboratoire ne prétend pas
reproduire cette fonction biologique tant qu’aucun contrôle volontaire de
préhension n’est demandé.

## Physique libre, saisie et lancer

Le mode **Physique libre** suspend les nouveaux appuis et le contrôleur de
racine. Le corps unique reste soumis à la gravité, aux collisions et aux forces
de la souris. Pendant une saisie ou ce mode, chaque membre devient une chaîne
XPBD passive de cinq nœuds. La gravité et l’inertie restent dominantes, mais un
faible tonus configurable attire souplement les articulations vers des cibles
anatomiques transportées avec le corps : le membre plie et balance sans devenir
une chaîne morte ni une figurine rigide.

Deux familles de contraintes empêchent les configurations impossibles : des
capsules analytiques protègent le torse et la tête, puis une auto-collision
segmentaire maintient les bras et jambes hors les uns des autres. Ces calculs
emploient des buffers de taille fixe. La projection sur le décor est limitée à
une interrogation par nœud libre et par pas, indépendamment du nombre
d’itérations XPBD. La transition de retour vers l’IK anatomique dure 280 ms et
reste bornée. Il ne s’agit toujours pas d’un ragdoll Rapier à des dizaines de
corps : cette couche locale n’ajoute ni collision inter-corps instable, ni coût
à la locomotion normale.

Le clic gauche lance un rayon uniquement au début de la saisie. Le point touché
est ensuite relié au pointeur par un ressort amorti appliqué au corps unique. La
vitesse du pointeur est convertie en impulsion bornée au relâchement. Tout le
modèle suit ainsi une autorité physique cohérente, sans rupture entre segments.
Au relâchement, aucune surface proche n’est capturée à distance. Le contrôleur
attend un vrai manifold Rapier du torse ou de la tête, compare tous les impacts
éligibles de façon déterministe, puis verrouille un seul propriétaire. Un
réflexe PD tourne d’abord la face ventrale vers sa normale ; aucune griffe ni
force d’aimantation n’est autorisée lorsque le dos ou le flanc fait face au
support. À partir de `bodyUp·normal = 0,48`, deux semelles au moins peuvent
prendre ce même collider. Le verrou persiste pendant le transitoire : un angle
sol/mur ou deux surfaces voisines ne peuvent plus voler alternativement les
appuis. L’ensemble reste continu, sans téléportation.

## Pas fixe, interpolation et budget

Rapier avance à `120 Hz`, soit `1/120 s`, avec au plus quatre sous-pas par image.
À durée acceptée identique, le résultat physique ne dépend pas d’un rendu à 60
ou 240 Hz. Le rendu interpole la pose précédente et la pose courante.

Une image exceptionnellement longue ne crée pas une dette sans limite : le
temps qui dépasse quatre sous-pas est compté dans `droppedSeconds`, puis
abandonné. Ce choix protège la fluidité du prototype et interdit une spirale de
rattrapage.

Le coût physique normal est constant : un corps, deux formes de collision,
quatre appuis et une queue de treize nœuds. Les tableaux de contacts, poses et
contraintes sont alloués au chargement puis réutilisés. L’IK emploie quatre
chaînes analytiques à taille fixe ; la queue emploie douze contraintes de
longueur, onze contraintes de flexion et sept itérations fixes avec élimination
large des colliders trop éloignés. Le coût ne croît ni avec la population de la
colonie, ni avec la durée de la session. Le panneau expose le p95 du sous-pas
complet. Le tonus passif, les capsules de corps, l’auto-collision segmentaire et
les projections de décor des quatre membres ne sont calculés que pour l’animal
saisi ou explicitement passé en physique libre ; leur coût est nul pendant la
locomotion stabilisée. La stratégie LOD/VAT prévue pour une
population est détaillée dans [Caméléon — intégrité de peau et stratégie de
rendu](../chameleon-rendering-performance.md).

Le contrôleur plateforme et la machine de saut ajoutent uniquement des
opérations scalaires/vectorielles constantes par sous-pas, sans raycast ni
allocation. L’overlay trace chaque os selon son véritable axe local `+Y` et sa
longueur exportée ; il n’invente plus de liaisons entre les origines de branches
hiérarchiques disjointes. Il est retiré de la scène lorsqu’il est masqué : son
coût est alors nul. Lorsqu’il est visible, un unique `LineSegments` met à jour
les 42 liaisons et les axes terminaux des doigts, de la mâchoire et de
`tail_12`, soit un seul draw call et environ 1,25 Kio de données dynamiques.

## Décor de validation

Le décor est volontairement synthétique et reproductible :

- sol et murs rugueux ;
- mur en verre lisse non préhensile ;
- plan rocheux incliné et tablette ;
- troncs horizontal, diagonal et vertical ;
- perchoir bas et rochers.

Ces primitives couvrent les transitions sol/mur, les supports étroits, les
normales divergentes et un matériau sur lequel la prise doit échouer. Elles ne
prétendent pas reproduire tous les maillages de la carte principale.

## Limites connues

Le laboratoire vise une locomotion stable et des contacts lisibles, pas un
modèle biomécanique exhaustif :

- les doigts suivent le skin et ne possèdent pas chacun un collider ;
- les quatre pieds sont des appuis analytiques, pas quatre corps dynamiques ;
- l’IK est visuelle et bornée, sans simulation de fibres musculaires ;
- la queue originale est passive et collisionnée, mais pas encore préhensile ;
- les surfaces du banc sont fixes et analytiques ;
- aucune décision écologique, chasse ou animation de langue n’est exécutée.

Une chute sur le verre, la perte temporaire d’un appui ou la rotation du corps
après un lancer sont attendues. Une téléportation hors réinitialisation, une
patte qui s’entortille, une valeur non finie, une prise sur le verre, une queue
tubulaire ou une traversée durable d’un collider sont des régressions.

## Sources de conception

- [Rapier — forces et impulsions](https://rapier.rs/docs/user_guides/javascript/rigid_body_forces_and_impulses/) ;
- [Rapier — paramètres d’intégration](https://rapier.rs/docs/user_guides/javascript/integration_parameters/) ;
- [Three.js — WebGPURenderer](https://threejs.org/manual/en/webgpurenderer) ;
- [Étude biomécanique sur la friction et la préhension des caméléons](https://pmc.ncbi.nlm.nih.gov/articles/PMC3866397/) ;
- [Cinématique des caméléons sur perchoirs](https://pubmed.ncbi.nlm.nih.gov/14668308/) ;
- [Locomotion lente et facteur d’appui de *Chamaeleo calyptratus*](https://biomechanics.ucr.edu/Higham_Jayne_2004a.pdf) ;
- [Contribution des ceintures au pas du caméléon](https://zslpublications.onlinelibrary.wiley.com/doi/10.1111/j.1469-7998.1984.tb04286.x) ;
- [Rigidité régionale du tronc](https://doi.org/10.1098/rsos.221509) ;
- [Stabilisation vestibulaire de la tête](https://doi.org/10.1016/0306-4522(88)90346-6).

## Preuves et règle de modification

Les preuves automatiques actuelles sont :

- `test/chameleon-lab-route.test.js` : sélection de route et imports dynamiques
  exclusifs ;
- `test/chameleon-lab-physics-world.test.js` : initialisation, pas fixe,
  invariance 60/240 Hz, plafond de rattrapage, interpolation, reset et rejet des
  valeurs non finies ;
- `test/chameleon-lab-controller.test.js` : mappings AZERTY/QWERTY, projection
  caméra-support, exploration autonome bornée et détection d’immobilité ;
- `test/chameleon-lab-input.test.js`,
  `test/chameleon-lab-platformer-control.test.js` et
  `test/chameleon-lab-platformer-jump.test.js` protègent les transitions de
  touche, le pilotage tangentiel, l’accélération bornée, les phases du saut,
  coyote/buffer, hauteur variable, atterrissage et stabilité des allocations ;
- `test/chameleon-lab-rig-debug-view.test.js` protège le buffer unique, le coût
  nul lorsqu’il est masqué et la couverture des chaînes du cou, des quatre
  membres, des doigts et de la queue ;
- `test/chameleon-lab-platformer-integration.test.js` verrouille l’ordre causal
  des forces : le contrôleur hybride remet ses forces à zéro avant que le saut
  et le contrôle aérien n’appliquent les leurs ;
- `test/chameleon-lab-whole-body-gait.test.js` protège les couples diagonaux,
  les excursions du bassin/thorax/tête, le lissage apériodique et l’absence
  d’allocation dans le modèle de pose ;
- `test/chameleon-lab-passive-tail.test.js` protège les treize nœuds fixes, le
  pont sacré à deux segments, le gradient de compliance, les longueurs, la gravité, l’inertie,
  l’amortissement, la projection bornée des collisions, le reset et la
  récupération des valeurs non finies, ainsi que le sommeil bit-identique et
  tous ses motifs de réveil, ainsi que l’absence de vitesse Verlet cachée au sol ;
- `test/chameleon-lab-anatomical-limb.test.js` protège longueurs exactes,
  ceinture mobile, flexions, paumes complètes, continuité du pôle et suspension ;
- `test/chameleon-lab-passive-limbs.test.js` protège le faible tonus
  configurable, les ligaments, les capsules corps, l’auto-collision des
  segments, l’unique projection externe par nœud et par pas, et la récupération ;
- `test/chameleon-lab-active-ragdoll.test.js` : les identifiants historiques
  `CHAMELEON-LAB-RAGDOLL-001` à `019` protègent le corps Rapier unique, les
  quatre appuis, les forces et angles bornés, le mode libre, les valeurs finies,
  les excursions proximales sans jitter distal, les semelles zygodactyles à
  plat, la queue sans pénétration, les membres passifs et l’accrochage après
  lancer sur mur ou cylindre, la suppression des prises périmées au décollage
  et la reprise d’un support réel après impact, l’absence de capture à distance,
  le redressement ventral et le verrouillage d’un propriétaire dans un coin,
  ainsi que la flexion au repos,
  le repère anatomique du modèle et le mouvement doux du cou et de la tête ;
- `test/chameleon-physical-asset.test.js` protège les contrats de mesh `3.5.0`
  et d’anatomie `2.1.0`, le mesh source exact, le skin, les 7 206 sommets
  originaux, l’absence de poids `tail_*` sur le corps, le pont sacré rigide, la
  racine dynamique `tail_04`, les axes de membres contenus dans le volume fermé
  et les poids géodésiques bornés.

Le build WebGPU protège l’assemblage des modules. Une inspection dans un
navigateur WebGPU reste indispensable pour les transitions multi-surfaces, la
caméra, la saisie, le lancer, les ombres, la silhouette de la queue et le coût
p95 réel.

Toute modification du laboratoire qui touche une commande, un appui, une
limite IK, une borne temporelle, une ressource ou un budget doit mettre à jour
dans la même livraison :

1. le test automatisé correspondant ;
2. ce document technique ;
3. le [guide utilisateur](../guide/laboratoire-cameleon.md) si le comportement
   visible ou un réglage change ;
4. le manifeste via `npm run docs:sync`.

Une retouche purement artistique sans effet sur ces invariants peut rester
soumise à une validation visuelle, conformément à la
[stratégie de tests](../qualite/strategie-tests.md).
