# Laboratoire du caméléon physique

## Portée

Le laboratoire accessible avec `?test` ou `?test=chameleon` est un banc d’essai
isolé pour la locomotion physique du caméléon. Il sert à éprouver le rig, le
corps articulé, les prises sur plusieurs surfaces, le pilotage à la troisième
personne et la manipulation à la souris.

Il ne remplace pas encore le caméléon de la simulation principale décrit dans
[CHAMELEON-SIM](./cameleons.md). Il n’exécute ni la colonie, ni les abeilles, ni
les papillons, ni la prédation. Ses paramètres et son horloge ne modifient donc
jamais une partie normale.

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

Le laboratoire associe quatre couches indépendantes :

1. `environment.js` crée les meshes WebGPU et leurs colliders Rapier fixes ;
2. `active-ragdoll.js` charge le rig, crée les corps dynamiques, les
   articulations, les muscles et les prises ;
3. `physics-world.js` avance Rapier à pas fixe et conserve deux poses pour
   l’interpolation visuelle ;
4. `third-person-controller.js` et `grab-controller.js` transforment les
   commandes du joueur en directions, forces et impulsions physiques.

Le rendu ne réécrit jamais directement la position du squelette. Après chaque
pas, les transformations interpolées des proxies physiques pilotent les os du
GLB. Le déplacement, la chute, la traction à la souris et le lancer passent
donc tous par Rapier.

## Rig et corps articulé

L’asset `public/assets/ChameleonPhysical.glb` contient un corps et une queue
neutre séparés, un skin commun et une hiérarchie anatomique couvrant colonne,
tête, mâchoire, quatre membres avec doigts et douze sections de queue. Chaque
sommet possède au plus quatre influences normalisées.

Le solveur instancie 33 proxies dynamiques :

- 5 capsules pour le bassin, les deux segments de colonne, le cou et la tête ;
- 16 capsules pour les quatre chaînes de membres ;
- 12 capsules pour la queue.

Les proxies non adjacents d’un même animal se collisionnent entre eux afin que
les pattes, la tête et la queue ne traversent pas le torse. Rapier désactive en
revanche les contacts entre chaque paire directement reliée par une
articulation, ce qui évite les conflits au niveau des pivots. Hors queue,
Rapier les relie par des rotules sphériques libres ; des couples PD souples les
ramènent vers une limite anatomique sans transformer cette limite en butée
Rapier dure. La queue suit une politique différente et explicite : les sections
3, 5, 7, 9 et 11 sont des charnières Rapier limitées à ±0,38 radian, tandis que
les sept autres liaisons sont fixes. Elle conserve ainsi sa longueur tout en
laissant cinq degrés de flexion physiques. Cette représentation évite un
collider par triangle et maintient un coût borné.

Les muscles du corps utilisent un contrôle PD quaternion amorti, borné et
mis à l’échelle par l’inertie. Ceux de la queue pilotent ses charnières. Ils
cherchent la pose de repos et ajoutent un cycle diagonal aux membres pendant la marche. Ils restent des forces : un choc, une chute ou une
traction peut les écarter de la pose cible. Le mode **Ragdoll passif** désactive
ces moteurs de pose et les prises sans remplacer les corps. Les couples de
butée anatomique souple restent actifs : ils jouent le rôle d’une contrainte
articulaire et non celui d’un muscle cherchant la pose de repos.

## Contacts et surfaces

Chaque collider fixe publie des métadonnées :

- `kind` décrit la classe de surface ;
- `friction` règle le contact Rapier ;
- `clawEligible` autorise ou interdit une prise ;
- `gripStrengthScale` module sa résistance ;
- une branche peut aussi exposer son axe et son rayon.

Quatre pieds et l’extrémité de la queue sondent un petit ensemble borné de
directions. Lorsqu’un support rugueux est atteint, le contact mémorise une
ancre en coordonnées monde. Tant que cette ancre reste valide, aucune nouvelle
sonde n’est lancée pour ce membre ; la recherche reprend après sa libération.
Un ressort amorti maintient le bout du membre autour de l’ancre jusqu’au pas de
transfert suivant, à une surcharge, à une perte de portée ou à une libération
volontaire. La queue ne prend actuellement que les surfaces déclarées comme
branches.

Le plan de support moyen oriente la commande et permet de marcher sur un sol,
un plan incliné, un mur rugueux ou un tronc. La direction clavier, d’abord
calculée par rapport à la caméra, est projetée sur ce plan.

À l’arrêt, un contrôleur PD tangent au support maintient le bassin autour de
son dernier point stable. Il compense la dérive produite par les muscles et les
prises sans verrouiller la hauteur, sans écrire la pose et sans empêcher les
contacts Rapier de continuer à résoudre le poids. Ce maintien est suspendu
pendant un saut, une saisie ou un lancer, puis revient après un court délai.

Le mur de verre bleu est intentionnellement peu frictionnel et
`clawEligible: false`. Le caméléon doit y glisser. Les caméléons ne possèdent
pas les lamelles adhésives d’un gecko : la préhension réelle repose surtout sur
leurs pieds zygodactyles, leurs griffes, le serrage et la friction. Le ressort
d’ancrage est donc une abstraction de cette prise sur les matériaux rugueux,
pas une adhésion universelle.

## Pas fixe et interpolation

Rapier avance à `120 Hz`, soit `1/120 s`, avec au plus quatre sous-pas par image.
À durée acceptée identique, le résultat physique ne dépend pas d’un rendu à
60 ou 240 Hz. Le rendu interpole la pose précédente et la pose courante afin de
ne pas afficher les marches discrètes du solveur.

Une image exceptionnellement longue ne crée pas une dette sans limite : le
temps qui dépasse quatre sous-pas est compté dans `droppedSeconds`, puis
abandonné. Ce choix protège la fluidité du prototype et interdit une spirale de
rattrapage. Il ne faut donc pas utiliser ce laboratoire comme oracle de
l’horloge stricte de la simulation principale.

Les buffers de poses, les corps, les articulations, les proxies de debug et les
contacts sont créés au chargement puis réutilisés pendant la simulation. Une
réinitialisation recrée volontairement les articulations. Les sondes sont
suspendues pour les prises déjà ancrées. Le panneau affiche le p95 du coût
complet d’un sous-pas, sondes, muscles, validation et résolution Rapier inclus,
afin de détecter une dérive de performance.

## Caméra, pilotage et manipulation

La caméra suit le bassin avec amortissement et résout un rayon contre le décor
pour ne pas traverser un obstacle. Le clic droit change son lacet et son
inclinaison ; la molette règle sa distance.

Les touches AZERTY, QWERTY et les flèches produisent une commande tangentielle
au support. `Shift` demande le sprint. `Espace` libère brièvement les prises et
applique une impulsion suivant la normale de support.

Le clic gauche lance un rayon uniquement au début de la saisie. Le point
touché est ensuite relié au pointeur par un ressort amorti, appliqué au vrai
proxy. La vitesse du pointeur est conservée et convertie en impulsion bornée au
relâchement : secouer et lancer le caméléon teste donc bien sa gravité, ses
articulations et la récupération de ses muscles.

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

Le laboratoire est un active ragdoll avancé, mais pas un modèle biomécanique
exhaustif :

- les doigts visibles suivent le skin ; ils ne possèdent pas chacun un corps
  rigide et une contrainte de serrage ;
- les capsules approchent le volume de l’animal au lieu de reprendre chaque
  triangle du mesh ;
- les muscles sont des ressorts de pose et non une simulation de fibres ;
- les surfaces du banc sont fixes et analytiques ;
- aucune décision écologique, chasse ou animation de langue n’est exécutée.

Une chute sur le verre, un pied qui lâche pendant son cycle ou une posture
déformée après un lancer sont des conséquences physiques attendues. Une
téléportation hors réinitialisation, un proxy non fini, une prise sur le verre
ou une traversée durable d’un collider sont des régressions.

## Sources de conception

- [Rapier — articulations](https://rapier.rs/docs/user_guides/javascript/joints/) ;
- [Rapier — forces et impulsions](https://rapier.rs/docs/user_guides/javascript/rigid_body_forces_and_impulses/) ;
- [Rapier — paramètres d’intégration](https://rapier.rs/docs/user_guides/javascript/integration_parameters/) ;
- [Three.js — WebGPURenderer](https://threejs.org/manual/en/webgpurenderer) ;
- [Étude biomécanique sur la friction et la préhension des caméléons](https://pmc.ncbi.nlm.nih.gov/articles/PMC3866397/) ;
- [Cinématique des caméléons sur perchoirs](https://pubmed.ncbi.nlm.nih.gov/14668308/).

## Preuves et règle de modification

Les preuves automatiques actuelles sont :

- `test/chameleon-lab-route.test.js` : sélection de route et imports
  dynamiques exclusifs ;
- `test/chameleon-lab-physics-world.test.js` : initialisation, pas fixe,
  invariance 60/240 Hz, plafond de rattrapage, interpolation, reset et rejet des
  valeurs non finies ;
- `test/chameleon-lab-controller.test.js` : mappings AZERTY/QWERTY,
  projection caméra-support, exploration autonome bornée, détection
  d’immobilité et libération fiable de la rotation caméra ;
- `test/chameleon-lab-active-ragdoll.test.js` : `CHAMELEON-LAB-RAGDOLL-001` vérifie la
  politique fixe/charnière de la queue ; `CHAMELEON-LAB-RAGDOLL-002` les limites anatomiques
  et les gains inertiels ; `CHAMELEON-LAB-RAGDOLL-003` le maintien au repos proportionnel à
  la masse ; `CHAMELEON-LAB-RAGDOLL-004` la non-rétraction de la chaîne de queue et la
  coïncidence de ses ancres ; `CHAMELEON-LAB-RAGDOLL-005` son invariance entre rendus à 60 et
  240 Hz ; `CHAMELEON-LAB-RAGDOLL-006` charge le GLB et simule le corps complet
  de 33 proxies avec ses auto-collisions ; `CHAMELEON-LAB-RAGDOLL-007` rejette
  les sorties de rayon provenant de l’intérieur d’un collider ;
- `test/chameleon-physical-asset.test.js` : structure GLB, budget, skin,
  influences et hiérarchie anatomique.

Le build WebGPU protège l’assemblage des modules. Le test d’intégration Node
instancie désormais le GLB et les 33 proxies, vérifie les groupes
d’auto-collision, les ancres, les prises au sol et l’absence de valeurs non
finies pendant quatre secondes. Une inspection dans un navigateur WebGPU reste
indispensable pour les transitions multi-surfaces, la caméra, la saisie, le
lancer, les ombres, la qualité visuelle et le coût p95 réel.

Toute modification du laboratoire qui touche une commande, une articulation,
un contact, une borne temporelle, une ressource ou un budget doit mettre à jour
dans la même livraison :

1. le test automatisé correspondant ;
2. ce document technique ;
3. le [guide utilisateur](../guide/laboratoire-cameleon.md) si le comportement
   visible ou un réglage change ;
4. le manifeste via `npm run docs:sync`.

Une retouche purement artistique sans effet sur ces invariants peut rester
soumise à une validation visuelle, conformément à la
[stratégie de tests](../qualite/strategie-tests.md).
