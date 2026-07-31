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

Le laboratoire associe cinq couches :

1. `environment.js` crée les meshes WebGPU et leurs colliders Rapier fixes ;
2. `hybrid-chameleon.js` charge le GLB, crée le corps unique, les quatre appuis
   et le rig visuel ;
3. `hybrid-controller-model.js` fournit les calculs purs de cadre de support,
   gains amortis, limites articulaires et forces bornées ;
4. `physics-world.js` avance Rapier à pas fixe et conserve deux poses pour
   l’interpolation visuelle ;
5. `third-person-controller.js` et `grab-controller.js` transforment les
   commandes du joueur en directions, forces et impulsions.

Le mouvement global ne réécrit jamais directement la position du modèle : la
pose interpolée du corps Rapier pilote la racine visuelle. L’IK n’agit que sur
les os des pattes et ne crée aucune énergie dans le solveur physique.

## Contrat de l’asset et queue originale

`public/assets/ChameleonPhysical.glb` exporte un unique mesh skinné à partir de
la géométrie source préservée. Son contrat `mesh_contract_version = 3.0.0`
verrouille notamment :

- `exact_source_geometry = true` ;
- `source_vertex_count = 25002` ;
- `source_polygon_count = 50000` ;
- `original_tail_vertices = 7206` ;
- `tail_deformation_mode = "rigid_pelvis"` ;
- `tail_physics_dofs = 0`.

Les 7 206 sommets de la queue sont ceux de la queue originale enroulée. Ils ne
sont ni supprimés, ni remplacés par une queue tubulaire. Ils reçoivent un poids
rigide de `1.0` vers le bassin : la silhouette reste exacte, mais la queue
n’ajoute aucun degré de liberté physique instable. Les 43 os d’authoring restent
dans le skin ; ils ne correspondent pas à 43 corps Rapier.

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

## Quatre appuis et IK bornée

Chaque pied possède une cible et une normale dans des tableaux de taille fixe.
La recherche teste un ensemble borné de directions et n’accepte que les
colliders marqués `clawEligible`. Un mur de verre non éligible reste donc un
support de collision, mais jamais une prise.

La démarche procédurale alterne appui et transfert. À chaque rendu interpolé, le
rig visuel résout chaque patte avec quatre itérations CCD. Toutes les rotations
sont ramenées autour de la pose de repos et bornées par rôle : ceinture,
segment supérieur, segment inférieur et paume. Une cible inaccessible ne peut
donc pas provoquer une rotation sans limite ni accumuler une torsion d’une
image à l’autre, car la pose de repos est restaurée avant chaque résolution.

Les normales propres à chaque pied orientent les paumes. Le corps utilise leur
cadre agrégé, ce qui permet de tester un angle sol/mur ou un tronc sans imposer
que les quatre pieds soient coplanaires.

## Physique libre, saisie et lancer

Le mode **Physique libre** suspend les nouveaux appuis et le contrôleur de
racine. Le corps unique reste soumis à la gravité, aux collisions et aux forces
de la souris. Le squelette visible conserve ses limites procédurales : ce mode
n’est pas un ragdoll articulé complet et ne prétend pas simuler indépendamment
chaque membre.

Le clic gauche lance un rayon uniquement au début de la saisie. Le point touché
est ensuite relié au pointeur par un ressort amorti appliqué au corps unique. La
vitesse du pointeur est convertie en impulsion bornée au relâchement. Tout le
modèle suit ainsi une autorité physique cohérente, sans rupture entre segments.

## Pas fixe, interpolation et budget

Rapier avance à `120 Hz`, soit `1/120 s`, avec au plus quatre sous-pas par image.
À durée acceptée identique, le résultat physique ne dépend pas d’un rendu à 60
ou 240 Hz. Le rendu interpole la pose précédente et la pose courante.

Une image exceptionnellement longue ne crée pas une dette sans limite : le
temps qui dépasse quatre sous-pas est compté dans `droppedSeconds`, puis
abandonné. Ce choix protège la fluidité du prototype et interdit une spirale de
rattrapage.

Le coût physique est constant : un corps, deux formes de collision et quatre
appuis. Les tableaux de contacts et de poses sont alloués au chargement puis
réutilisés. L’IK emploie quatre chaînes et un nombre fixe d’itérations ; son coût
ne croît ni avec le décor visible, ni avec la population de la colonie. Le
panneau expose le p95 du sous-pas complet.

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
- la queue originale est rigide avec le bassin et n’est pas encore préhensile ;
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
- [Cinématique des caméléons sur perchoirs](https://pubmed.ncbi.nlm.nih.gov/14668308/).

## Preuves et règle de modification

Les preuves automatiques actuelles sont :

- `test/chameleon-lab-route.test.js` : sélection de route et imports dynamiques
  exclusifs ;
- `test/chameleon-lab-physics-world.test.js` : initialisation, pas fixe,
  invariance 60/240 Hz, plafond de rattrapage, interpolation, reset et rejet des
  valeurs non finies ;
- `test/chameleon-lab-controller.test.js` : mappings AZERTY/QWERTY, projection
  caméra-support, exploration autonome bornée et détection d’immobilité ;
- `test/chameleon-lab-active-ragdoll.test.js` : les identifiants historiques
  `CHAMELEON-LAB-RAGDOLL-001` à `007` sont désormais l’autorité de
  non-régression de l’architecture hybride : corps Rapier unique, quatre
  appuis, forces et angles bornés, mode libre et valeurs finies ;
- `test/chameleon-physical-asset.test.js` : `CHAMELEON-PHYSICAL-ASSET-001` et
  `002` protègent le mesh source exact, le skin et les 7 206 sommets de la queue
  originale rigidement liés au bassin.

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
