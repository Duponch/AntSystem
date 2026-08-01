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
la géométrie source préservée. Son contrat `mesh_contract_version = 3.3.0`
verrouille notamment :

- `exact_source_geometry = true` ;
- `source_vertex_count = 25002` ;
- `source_polygon_count = 50000` ;
- `original_tail_vertices = 7206` ;
- `tail_deformation_mode = "surface-geodesic-bspline-12"` ;
- `tail_physics_dofs = 0`.

Chaque os de membre publie aussi sa longueur de repos exacte. Chaque paume
publie trois points de contact, leur centre et la normale extérieure de la
semelle dans le repère du rig. Le runtime ne déduit donc plus le pied depuis le
milieu approximatif de deux os : talon, paume et doigts utilisent la même
surface de contact, avec la convention physique correcte « semelle vers le
support, normale du support vers l’animal ». Les matrices inverses sont testées
à la pose de repos afin que l’ajout du rig ne déplace aucun sommet.

Les 7 206 sommets de la queue sont ceux de la queue originale enroulée. Ils ne
sont ni supprimés, ni remplacés par une queue tubulaire. Douze os suivent
exactement sa ligne centrale courbe ; leurs poids sont calculés par distance
géodésique sur la surface et mélangés par B-spline cubique. Le champ
`tail_physics_dofs = 0` signifie qu’aucun corps Rapier supplémentaire n’est
exporté dans le GLB : les douze degrés de liberté passifs existent dans le
solveur XPBD borné du runtime. Les 43 os d’authoring ne correspondent donc pas à
43 corps Rapier.

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

Le déplacement clavier est échantillonné dans le pas physique. La pente de la
caméra est supprimée avant de construire les axes avant/droite ; l’intention est
ensuite reprojetée dans le plan du support. Un même lacet de caméra produit donc
la même direction sur un sol, et regarder presque verticalement ne peut ni
inverser ni annuler la commande. Sur un mur, une commande face au mur devient
une direction de montée. Les changements d’orientation et d’accélération sont
bornés et tous les objets de sortie sont réutilisés.

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

La démarche procédurale alterne les couples diagonaux sans phase aérienne. Le
cycle est volontairement lent et à fort facteur d’appui. Avant la fermeture des
contacts, une pose corps entier anime les ceintures scapulaires et pelviennes,
les segments supérieurs, les coudes ou genoux, le bassin, le thorax, le cou et
la tête. Le bassin participe davantage au pas ; le thorax contre-oscille et la
tête compense pour conserver un regard stable.

À chaque rendu interpolé, le rig restaure sa pose de référence, applique cette
pré-pose lissée puis résout chaque patte par une chaîne analytique à ceinture
mobile : ceinture, segment supérieur, segment inférieur, paume et deux groupes
de doigts zygodactyles. Les longueurs, directions de repos, pivots et centres de
semelle viennent du GLB. L’épaule ou la hanche effectue une excursion ample ; le
coude ou genou adapte réellement son angle ; la paume entière reste tangente au
support et n’est jamais étirée pour masquer une erreur proximale. Toutes les
rotations restent bornées autour de la pose de repos. Une cible inaccessible ne
peut donc ni accumuler une torsion, ni faire vibrer frénétiquement un poignet ou
une cheville.

Les normales propres à chaque pied orientent les paumes. Le corps utilise leur
cadre agrégé, ce qui permet de tester un angle sol/mur ou un tronc sans imposer
que les quatre pieds soient coplanaires. Longueur et hauteur du pas, amplitude
des épaules/hanches, levée des membres, flexion et mouvement du corps sont des
paramètres indépendants exposés dans l’interface.

## Queue passive à géométrie originale

La queue emploie une tige XPBD de taille constante : treize nœuds pour douze
segments, dont la racine est cinématique et suit le bassin. Il n’existe aucun
moteur, pose cible ou couple musculaire dans ce prototype : gravité, inertie,
amortissement, contraintes de longueur et de courbure déterminent seuls son
mouvement secondaire. Le résultat interpolé oriente les douze os de la queue,
sans réécrire les sommets ni leur topologie.

Sept itérations résolvent les longueurs, la flexion et les collisions à 120 Hz.
Chaque nœud possède un rayon décroissant de la base à la pointe. Une projection
bornée contre les colliders fixes du laboratoire empêche la traversée du sol,
des murs, rochers et troncs ; le sol utilise une surface unilatérale afin de ne
jamais éjecter une queue posée vers le dessous d’une dalle épaisse. La souplesse,
l’amortissement, la gravité propre et l’échelle des rayons de collision sont
réglables. Une fenêtre de repos déterministe met la tige en sommeil lorsque sa
racine et tous ses nœuds restent sous les seuils de déplacement et de vitesse.
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
XPBD passive de cinq nœuds : la gravité, l’inertie, les ligaments, les limites de
flexion et les collisions remplacent temporairement le tonus musculaire. La
transition de retour vers l’IK anatomique dure 280 ms et reste bornée. Il ne
s’agit toujours pas d’un ragdoll Rapier à des dizaines de corps : cette couche
locale n’ajoute ni collision inter-corps instable, ni coût à la locomotion
normale.

Le clic gauche lance un rayon uniquement au début de la saisie. Le point touché
est ensuite relié au pointeur par un ressort amorti appliqué au corps unique. La
vitesse du pointeur est convertie en impulsion bornée au relâchement. Tout le
modèle suit ainsi une autorité physique cohérente, sans rupture entre segments.
Au relâchement, le contrôleur interroge d’abord la paire de collision réellement
touchée par le torse ou la tête. Si le support accepte les griffes, les quatre
semelles sont projetées sur ce même mur, rocher ou cylindre, puis le corps
s’aligne progressivement : un lancer peut donc se terminer par un accrochage
sans téléportation. La recherche plus coûteuse des colliders dynamiques n’est
effectuée que durant cette courte récupération.

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
complet. Les quatre ragdolls de membres ne sont calculés que pour l’animal saisi
ou explicitement passé en physique libre. La stratégie LOD/VAT prévue pour une
population est détaillée dans [Caméléon — intégrité de peau et stratégie de
rendu](../chameleon-rendering-performance.md).

Le contrôleur plateforme et la machine de saut ajoutent uniquement des
opérations scalaires/vectorielles constantes par sous-pas, sans raycast ni
allocation. L’overlay de rig est retiré de la scène lorsqu’il est masqué : son
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
- `test/chameleon-lab-passive-tail.test.js` protège les treize nœuds fixes, les
  longueurs, la gravité, l’inertie, l’amortissement, les collisions, le reset et
  la récupération des valeurs non finies, ainsi que le sommeil bit-identique et
  tous ses motifs de réveil ;
- `test/chameleon-lab-anatomical-limb.test.js` protège longueurs exactes,
  ceinture mobile, flexions, paumes complètes, continuité du pôle et suspension ;
- `test/chameleon-lab-passive-limbs.test.js` protège le mode musculaire relâché,
  les ligaments, les contacts et la récupération ;
- `test/chameleon-lab-active-ragdoll.test.js` : les identifiants historiques
  `CHAMELEON-LAB-RAGDOLL-001` à `015` protègent le corps Rapier unique, les
  quatre appuis, les forces et angles bornés, le mode libre, les valeurs finies,
  les excursions proximales sans jitter distal, les semelles zygodactyles à
  plat, la queue sans pénétration, les membres passifs et l’accrochage après
  lancer sur mur ou cylindre, la suppression des prises périmées au décollage
  et la reprise d’un support réel après impact ;
- `test/chameleon-physical-asset.test.js` protège le mesh source exact, le skin,
  les 7 206 sommets originaux, la ligne centrale courbe, les douze os et leurs
  poids géodésiques bornés.

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
