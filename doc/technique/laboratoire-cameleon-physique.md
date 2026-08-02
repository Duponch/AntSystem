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

Le laboratoire associe seize couches :

1. `surface-appearance.js` définit les pigments procéduraux partagés et le
   repère local immuable de chaque support ;
2. `environment.js` crée les meshes WebGPU et leurs colliders Rapier fixes ;
3. `surface-navigation-graph.js` échantillonne une fois toutes les surfaces
   préhensiles et publie leur graphe CSR immuable ;
4. `third-person-controller.js` localise départ et arrivée, exécute A* à la
   demande et suit un corridor compact ;
5. `surface-route-debug-view.js` dessine ce corridor avec un unique tracé borné ;
6. `surface-camouflage.js` élit le support tenu et pilote la variante de peau
   adaptative opaque ;
7. `hybrid-chameleon.js` charge le GLB, crée le corps unique, les quatre appuis,
   filtre leur cohorte cohérente avec `support-cohort-model.js` et coordonne le
   rig visuel ;
8. `anatomical-limb-solver.js` résout les ceintures, les deux segments et la
   surface complète de chaque main ou pied à partir du contrat exact du GLB ;
9. `whole-body-gait-model.js` prépare une pose anatomique corps entier à partir
   des phases d’appui et de transfert ;
10. `hybrid-controller-model.js` fournit les calculs purs de cadre de support,
   gains amortis, limites articulaires et forces bornées ;
11. `passive-limb-ragdoll.js` relâche les quatre membres pendant la saisie ou le
   mode libre, sans ajouter de corps Rapier ;
12. `passive-tail-physics.js` simule la ligne centrale passive de la queue et
   `passive-tail-visual-rig.js` la reporte sur les os du mesh original ;
13. `physics-world.js` avance Rapier à pas fixe et conserve deux poses pour
   l’interpolation visuelle ;
14. `input.js` et `platformer-control-model.js` transforment
   AZERTY/QWERTY en accélérateur et direction arcade, sélectionnent au clic une
   destination physique et transportent le cap tangent le long des supports ;
15. `platformer-jump-model.js` possède la charge du saut, ses cibles de hauteur
    et de portée, la tolérance au bord, le buffer et les enveloppes anatomiques
    de décollage, vol et atterrissage ;
16. `grab-controller.js` applique la saisie et le lancer, tandis que
    `rig-debug-view.js` peut afficher le squelette complet à travers la peau.

Le mouvement global ne réécrit jamais directement la position du modèle : la
pose interpolée du corps Rapier pilote la racine visuelle. L’IK n’agit que sur
les os des pattes et ne crée aucune énergie dans le solveur physique.

## Contrat de l’asset et queue originale

`public/assets/ChameleonPhysical.glb` exporte un unique mesh skinné à partir de
la géométrie source préservée. Ses contrats `mesh_contract_version = 3.6.0` et
`rig_version = 3.6.0` verrouillent notamment :

- `exact_source_geometry = true` ;
- `source_vertex_count = 25002` ;
- `source_polygon_count = 50000` ;
- `original_tail_vertices = 7206` ;
- `tail_deformation_mode = "surface-geodesic-bspline-12"` ;
- `tail_static_collar_bone = "tail_01"` ;
- `tail_dynamic_root_bone = "tail_02"` ;
- `tail_dynamic_weight_start_geodesic_fraction = 0.055` ;
- `tail_dynamic_weight_feather_fraction = 0.18` ;
- `tail_physics_dofs = 0`.

Le contrat anatomique `2.2.0` recale les pivots sur la pose source réellement
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
sommets du corps dans le repère du bassin et seul `tail_01` forme le court collet
rigide. `tail_02` est déjà la racine dynamique. Les poids dynamiques commencent
à `0,055` de la distance géodésique, puis apparaissent avec un feather lisse sur
`0,18` ; la ligne centrale courbe conserve son mélange B-spline cubique. Cette
transition de skinning rapproche la flexion de la croupe sans créer de charnière
ni tirer les sommets du bas du dos. Le champ `tail_physics_dofs = 0` signifie
qu’aucun corps Rapier supplémentaire n’est exporté dans le GLB : le solveur
XPBD borné du runtime représente les douze segments, dont un cinématique et onze
passifs. Les 43 os d’authoring ne correspondent donc pas à 43 corps Rapier.

### Contrat visuel facetté

Le même mesh porte maintenant une palette anatomique dans l’attribut glTF
`COLOR_0`. Le flux est un `RGBA8` normalisé, opaque et compact ; il ne crée ni
primitive, ni matériau, ni draw call supplémentaire. Ses couleurs distinguent
le dos, le ventre, la crête, les membres, les paumes et la queue. Des motifs
spatiaux de grande taille évitent l’ancien vert uniforme sans produire de bruit
« confetti » d’un triangle à l’autre.

Les deux tourelles oculaires restent intégrées à la géométrie originale. Leurs
facettes reçoivent successivement une couronne jaune, un iris ambre en six
secteurs, une pupille sombre et un petit reflet peint. Aucun mesh d’œil ou
texture UV n’est ajouté. Le matériau PBR conserve sa rugosité, ses normales
facettées, la lumière et les ombres ; son facteur de base est blanc afin de ne
pas multiplier la palette par l’ancien vert.

`scripts/author-chameleon-physical-look.py` régénère ce flux de façon
déterministe en préservant byte pour byte les positions, indices, poids et
matrices de skinning. Le contrat `look_contract_version = 1.0.0` exige un mesh,
une primitive, un matériau et un seul draw. Le futur shader toon global du jeu
est volontairement hors de ce contrat : `COLOR_0` fournit seulement l’albédo
artistique commun qu’il pourra consommer plus tard.

La reconstruction est déterministe et s’exécute sans interface Blender :

```powershell
blender --background blender/chameleon_physics_rig.blend --python scripts/rebuild-chameleon-hybrid-asset.py
python scripts/author-chameleon-physical-look.py
```

Blender et son MCP n’ont donc pas besoin d’être ouverts pour lancer, tester ou
reconstruire l’asset. L’interface Blender reste utile uniquement pour une
modification artistique ou anatomique volontaire de la scène source.

## Camouflage opaque piloté par le support

Le laboratoire ajoute une couche de chromatophores sans transformer le
caméléon en écran transparent. Chaque collider agrippable publie un profil
d’apparence immuable : trois pigments, une famille de motif, son échelle, sa
graine, sa rugosité et les matrices qui ramènent le monde dans le repère du
support. Le sol, les pierres, les murs rugueux et l’écorce utilisent eux-mêmes
ce profil comme source de leur `colorNode`.

La peau évalue exactement le même graphe TSL dans le repère du support élu. Un
motif d’écorce reste axial autour d’un tronc ; les mottes du sol et les facettes
de pierre restent ancrées sur leur plan local. Seuls l’albédo et une partie de
la rugosité s’adaptent : skinning, normales, lumière, ombres, profondeur et
relief PBR restent ceux du vrai modèle. Un masque dérivé de `COLOR_0` préserve
la pupille et son reflet sans ajouter d’attribut ou de primitive.

Le support est choisi parmi les seules pattes en état `holding`. Le vote porte
sur quatre entrées fixes, favorise le propriétaire courant en cas d’égalité et
doit rester stable pendant un court délai avant validation. Deux jeux
d’uniformes conservent l’ancien et le nouveau repère ; leur fondu évite un flash
aux arêtes. En l’air, le dernier pigment est retenu brièvement puis la palette
naturelle revient progressivement.

Cette architecture ne réalise aucun raycast supplémentaire, aucun readback,
aucun dispatch compute et aucune copie du framebuffer. Les quatre motifs sont
précalculés une fois dans une `DataArrayTexture` RGBA8 périodique de
`64 × 64 × 4` couches, partagée par le décor et la peau. Ses mipmaps isolées
par couche suppriment scintillement lointain et contamination entre profils
pour environ 86 Kio. Le modèle reste une primitive et un draw. Lorsque le
camouflage est revenu à zéro, le matériau GLB naturel est restauré : le shader
adaptatif n’a alors aucun coût. Lorsqu’il est stable, il effectue un seul
échantillon cache-local par pixel visible du caméléon ; le second n’est évalué
que pendant le fondu entre deux supports. Le coût ne dépend ni de la résolution
complète de l’écran, ni du nombre de colliders.

## Corps physique unique

Le corps dynamique utilise CCD, peut dormir et reçoit quelques itérations de
solveur supplémentaires. Une capsule représente le tronc et une sphère la tête
dans un collider composé. Tous les contacts du décor, les impulsions de saut et
les forces de saisie s’appliquent à ce même corps.

Le contrôleur n’écrit pas sa pose. Dès qu’au moins un appui valide subsiste, il
conserve le repère anatomique ; avec plusieurs griffes, il calcule leur centroïde
et une normale moyenne filtrée, puis applique :

- une force PD amortie de façon critique vers une racine suggérée par les
  appuis, distribuée à coût constant sur les griffes en stance avec
  `addForceAtPoint` ;
- la compensation bornée du vecteur de gravité complet, y compris sur un mur
  ou sous un support ;
- une force tangentielle bornée vers la vitesse commandée ;
- un couple borné alignant progressivement le ventre avec le support et l’avant
  avec le cap anatomique publié par le contrôleur.

`Rigidité d’appui` et `Amortissement` pilotent réellement les gains de ce rappel.
Le moment créé par la distribution des forces autour du centre de masse Rapier
est mesuré puis compensé avant l’ajout du couple d’attitude. Un virage ne crée
donc pas de roulis parasite sur une poutre, tandis qu’une seule griffe peut
maintenir le repère pendant le passage d’une arête. Le nombre d’opérations reste
strictement borné à quatre appuis par pas.

L’agrégation des normales est cohérente avec le repère accepté au pas précédent,
et non une somme arithmétique aveugle. Une normale orthogonale peut prendre le
relais lors d’un passage d’arête ; une normale strictement opposée ne peut pas
annuler le vecteur ni retourner le ventre. Si les seules contributions restantes
s’annulent ou appartiennent à l’hémisphère opposé, le dernier repère normalisé
est conservé. Sur un collider cylindrique dominant marqué comme branche, le
repère de support est en plus reconstruit analytiquement depuis son axe et le
rayon centre-vers-corps. Les appuis répartis autour d’un petit périmètre ne font
donc plus basculer la normale moyenne d’un flanc à l’autre. Le coefficient de
prise du collider ne modifie pas la fréquence du solveur : il borne seulement
les plafonds de force et de couple déjà calculés, à coût constant.

Les projecteurs de surface sont résolus depuis le registre courant des colliders,
pas figés à la construction du caméléon : enregistrer une branche après sa
création active donc le même repère radial. L’axe déclaré, le rayon et
`gripStrengthScale` sont validés avant usage. Une donnée absente, non finie ou
dégénérée déclenche un repli déterministe vers l’axe transformé et les dimensions
du collider Rapier, avec une échelle de prise neutre. Ce fail-safe conserve une
normale unitaire et n’injecte jamais de `NaN` dans les forces ou les couples.

Le projecteur respecte aussi la longueur finie du cylindre. Sur le fût, la
normale est radiale ; au-delà de la demi-longueur utile, les contacts du bouchon
font converger le cadre vers l’axe sortant. La transition utilise les contacts
physiques réellement acquis et conserve le polygone de deux griffes : elle ne
prolonge pas artificiellement un cylindre infini au-delà de son extrémité.

Après convergence au repos sur plusieurs griffes, le contrôleur annule forces et
couples puis laisse Rapier endormir le corps. Les ancres restent alors
bit-identiques sous un verrou de prise statique, sans rappel PD ni jitter caché.
Toute intention de déplacement ou de rotation libère ce verrou ; un impact
réveille Rapier et une saisie réveille explicitement le même corps. Le
contrôleur borné reprend au pas fixe suivant.

La fin d’une commande ne peut pas entretenir ce verrou indéfiniment. Chacune des
deux paires diagonales possède un budget d’une correction. Si un pas est déjà en
cours, son atterrissage consomme le budget de cette paire, puis la paire opposée
peut se remettre en place une fois. Les projections de candidats qui bougent
légèrement sur un cylindre ne peuvent ensuite relancer aucune paire en boucle,
et le corps peut converger puis dormir sur une branche étroite.

Une prise, un saut, un manque d’appuis ou le mode **Physique libre** désactive
ce rappel. Rapier reste alors l’unique autorité du mouvement global.

## Pilotage troisième personne et saut physique

Le déplacement clavier est échantillonné dans le pas physique. L’axe vertical
`Z`/`W`–`S` est un accélérateur signé ; l’axe horizontal `Q`/`A`–`D` est une
direction arcade. Ce dernier fait pivoter l’avant anatomique autour de la normale
du support sans produire de translation latérale : un virage sur place ne peut
donc pas devenir un déplacement en crabe. Les deux canaux restent indépendants
en diagonale. `Shift` porte la vitesse cible à au moins `2,3×` la marche afin que
le sprint soit immédiatement distinct.

La commande de lacet vise `1,9π rad/s` même sans accélérateur et conserve un
léger crawl avant de `0,22` : une demi-seconde réalise ainsi un quasi demi-tour
physique sur un arc court, pas une rotation de toupie. La cible géométrique ne
peut toutefois précéder l’avant réel que de `0,14π` (`25,2°`) : elle ne peut plus
prendre une demi-rotation d’avance puis continuer à tirer le corps après le
relâchement de la touche. La translation du crawl est construite depuis l’avant
physique déjà atteint, et non depuis cette cible future.

Quand l’accélérateur et le virage sont combinés, le suivi tangent augmente de
manière bornée avec l’intensité du lacet. Il réoriente la vitesse existante dans
le repère réellement atteint par le corps, sans ajouter de force centripète
permanente ni de stockage au pas fixe. Le ratio de vitesse latérale reste ainsi
inférieur à `0,30` en marche et en sprint, sur sol horizontal comme sur une
pente de `18°`.

Le moteur d’attitude est scindé en deux canaux. Le premier redresse le ventre
vers le support sans composante autour de sa normale ; le second applique le
lacet autour de cette normale avec anticipation de la vitesse commandée. Leur
budget de couple n’est donc plus partagé : une correction de roulis ou de
tangage sur un mur, un tronc ou un rocher ne rend pas le virage plus lourd. Le
relâchement augmente uniquement l’amortissement du lacet et freine la vitesse
tangentielle résiduelle : après un appui long, le dépassement angulaire reste
inférieur à `12°`. L’inertie
principale est mise en cache à la création et les vecteurs du solveur sont
réutilisés au pas fixe : cette réactivité n’ajoute aucune allocation au chemin
chaud.

L’origine de la translation est l’avant anatomique `-X` transformé par le
quaternion courant du corps Rapier, jamais le lacet de la caméra. Ce vecteur est
projeté sur le support puis transporté par rotation minimale d’une normale à la
suivante (repère de Bishop). Cette continuité supprime la singularité de
l’ancienne double projection sur un mur et la dérive accumulée autour d’un
cylindre. Tourner la caméra, saisir puis lancer le corps ne peut ni inverser ni
annuler la commande : « avancer » reste toujours l’avant réel du caméléon.
La normale qui a servi à construire la commande accompagne celle-ci jusqu’au
contrôleur physique. Si les contacts découvrent une nouvelle normale pendant le
même sous-pas, l’intention est transportée vers ce nouveau plan au lieu d’être
simplement reprojetée : une couture abrupte ne peut donc pas créer une impulsion
latérale d’une image.
Les changements d’orientation et d’accélération sont bornés et tous les objets
de sortie sont réutilisés. L’amplitude de la commande est conservée jusqu’au
corps physique : une intention inférieure à un produit une progression mesurée
plus lente au lieu d’être renormalisée à pleine vitesse.

Un clic gauche terminé sans glissement du pointeur lance une unique requête
Rapier depuis la caméra. Seul un collider `clawEligible` peut devenir
destination. Au chargement du laboratoire, le décor construit une seule fois un
manifold de navigation partagé : grille du terrain qui contourne les obstacles,
six faces distinctes des volumes, anneaux et bouchons des cylindres, et
échantillonnage triangulaire de repli pour les rochers. Des portails relient les
patches uniquement lorsque leurs surfaces sont physiquement voisines, que le
segment ne traverse aucun autre solide et qu’il quitte/approche les deux
demi-espaces extérieurs. Leur degré est borné à six par nœud. Une seule couture
de repli est autorisée pour un volume irrégulier qui intersecte réellement le
sol mais dont tous les échantillons tombent légèrement sous son plan. Le graphe
est ensuite figé en tableaux CSR typés (`offsets`, voisins, coûts, positions,
normales, colliders et patches) et n’est jamais modifié par un animal.

Le planificateur localise le support courant avec sa normale réelle et le point
cliqué avec la normale du rayon. Il refuse de fabriquer un départ global lorsque
le corps est en l’air ou saisi, puis exécute un A* CPU avec un unique espace de
travail préalloué et partageable séquentiellement entre les animaux. A* ne tourne
ni à l’image ni au sous-pas : seulement au clic et après un blocage confirmé. Le
corridor est simplifié uniquement sur un même patch lorsque le segment reste sur
la surface et ne coupe aucun obstacle, puis copié dans au plus 64 jalons fixes.
À l’arête convexe d’un volume, un jalon extérieur supplémentaire contourne
l’enveloppe de clearance au lieu d’en couper le coin par une corde.
Un portail sol/mur ou flanc/bouchon n’est consommé que lorsque le collider et la
normale attendus sont réellement devenus support du corps ; la proximité seule
ne peut donc plus faire viser la suite depuis le mauvais côté d’une couture.

Le watchdog mesure une diminution réelle de la distance au jalon actif. Tourner
autour d’une arête sans progresser déclenche ainsi une replanification,
effectuée hors de la boucle physique. Si A* republie exactement le corridor qui
vient d’échouer, ce corridor est marqué épuisé et n’est plus recalculé en boucle ;
la récupération tangentielle locale reste active. Une entrée clavier annule
immédiatement la destination, son tracé et reprend la priorité. Une saisie du
modèle reste distincte, car
elle capture le pointeur avant que le clic de décor soit validé. Le tracé de
debug réutilise un seul `LineSegments` : terrain cyan, support vert, transition
ambre, segment actif jaune pâle, partie parcourue bleu-gris et destination
magenta.

L’exploration autonome conserve elle aussi un cap tangent persistant. Quand la
normale passe d’un mur au dessus puis à la face opposée, ce cap suit la rotation
géodésique minimale au lieu de réinjecter artificiellement le haut du monde. Le
caméléon peut ainsi franchir une arête puis redescendre ; les changements
aléatoires, le watchdog d’immobilité et le rappel des limites tournent tous dans
le plan local du support, sans allocation dans la boucle chaude.

Le faisceau borné de recherche distingue les deux topologies autour d’une lèvre :
le rayon avant acquiert le mur qui s’oppose au mouvement, puis un rayon de retour
placé au-delà de l’arête acquiert le sommet ou la face suivante qui accompagne
le mouvement. Tout rayon dont l’origine est déjà à l’intérieur du collider visé
est rejeté avant le classement ; il ne peut donc sélectionner artificiellement
l’envers ou la sous-face du même volume. Le filtre d’hémisphère des normales
conserve simultanément l’ancien appui, la normale orthogonale de transition et
le nouveau côté, ce qui rend continu le parcours sol → mur → sommet → face
opposée avec la seule commande avant.

`Espace` démarre une précharge tant qu’un support ou la tolérance au bord reste
valide. Maintenir la touche augmente continûment deux cibles : hauteur
balistique et vitesse vers l’avant anatomique. Le relâchement, ou l’atteinte de
la charge maximale, déclenche le bond ; le sprint amplifie la portée sans changer
la hauteur chargée. La vitesse verticale reste dérivée de la hauteur demandée et
de la gravité courante. La normale du support sépare d’abord le corps du sol, du
mur, du cylindre ou même d’un plafond, tandis qu’une composante monde verticale
conserve un saut lisible hors du cas inversé. Même une frappe très brève conserve
une précharge visible ; une pression acceptée pendant la tolérance au bord ne
peut pas disparaître avant son unique départ. Descente, contrôle aérien,
tolérance au bord et mémorisation d’une pression avant l’atterrissage ont des
bornes indépendantes. Pendant une saisie ou en mode **Physique libre**, les
arêtes `Espace` restent consommées mais l’autorité du saut est désactivée et son
modèle réinitialisé ; la reprise ne peut donc pas rejouer une ancienne précharge.

La même charge publie une pose anatomique : accroupissement progressif avec
griffes plantées, extension au décollage, inclinaison avant, repli des membres en
l’air et compliance musculaire accrue. Ces enveloppes modulent le rig et l’IK
bornée sans ajouter de corps physique ni déplacer la racine. L’atterrissage
conserve son amorti bref du bassin, calculé depuis la descente la plus rapide
observée pendant le vol. Après libération des appuis, les canaux de pas
`STRIDE`, `LIFT` et `FLEX` restent nuls jusqu’à la reprise d’un support.

La transition de prise est explicite. Au décollage, les propriétaires des
quatre anciens contacts sont supprimés : ils ne peuvent pas réapparaître dans
le vide. Seul un manifold Rapier réel du torse ou de la tête peut d’abord choisir
le collider propriétaire. Les semelles assez proches de ce collider déjà acquis
amorcent ensuite le nouveau polygone de support ; leur simple proximité ne peut
jamais capturer une surface distante. Une composante latérale rapide oriente la
sélection du manifold dans le sens opposé à la vitesse, ce qui permet à un saut
ou un lancer de reprendre un mur ou un cylindre sans reprendre par erreur le sol
précédent. L’atterrissage publie enfin une enveloppe d’amorti visuelle qui
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

À chaque tick fixe de `120 Hz`, le buffer de pose restaure la référence, applique
cette pré-pose lissée puis résout chaque patte par une chaîne analytique à
ceinture mobile : ceinture, segment supérieur, segment inférieur, paume et deux
groupes de doigts zygodactyles. Un servo critique conserve la vitesse angulaire
de chaque os et plafonne son accélération : une inversion de cycle ne peut donc
plus inverser un bras en un tick. Le buffer conserve ensuite les transformations
locales précédentes et courantes. Le rendu ne relance ni la démarche ni l’IK : il
interpole seulement ces deux snapshots immuables, de sorte qu’un rendu répété ne
peut pas avancer la pose et que 60 ou 240 images par seconde produisent les mêmes
os au même tick. Les longueurs, directions de repos, pivots, plans de flexion et
centres de semelle viennent du GLB. À vitesse nulle, l’attraction de la ceinture
vers le pied et le biais d’abduction valent exactement zéro : la pose fléchie
exportée est donc la référence réelle. L’épaule ou la hanche effectue une
excursion ample ; le coude ou genou adapte réellement son angle ; la paume
entière reste tangente au support et n’est jamais étirée pour masquer une erreur
proximale. Toutes les rotations restent bornées autour de la pose de repos. Une
cible inaccessible ne peut donc ni accumuler une torsion, ni faire vibrer
frénétiquement un poignet ou une cheville.

L’état d’arrêt possède un budget distinct du cycle de marche. Après relâchement,
chaque paire diagonale peut être corrigée au plus une fois ; si un pas était
commencé, son atterrissage consomme le budget de sa paire et laisse uniquement
celui de la diagonale opposée. Cette règle reste vraie même lorsque le point
projeté sous chaque griffe oscille sur une surface courbe.

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

## Regard hiérarchique et idle

`chameleon-head-look-model.js` est un contrôleur cervical pur, déterministe et
sans allocation. Il choisit au repos des fixations irrégulières maintenues entre
deux micro-corrections, puis les suit avec un ressort critique. Une cible externe
prend progressivement la priorité et sa disparition restitue l’observation idle
sans saut.

Le solveur calcule lacet et élévation dans le repère anatomique
avant/haut/côté du corps. Il répartit environ 62 % du mouvement sur le cou et le
reste sur le crâne, avec limites et vitesses distinctes. Le laboratoire expose
`setLookTarget()` et `clearLookTarget()` comme un `LookAt` monde ; la pose est
résolue au pas fixe avant la publication du buffer de rig. Au repos, respiration
du thorax, lacet/roulis très faibles du bassin, déplacement millimétrique de la
croupe et observations tête/cou forment un idle corps entier. Les quatre cibles
de pieds restent inchangées. Le collet cinématique transmet seulement une légère
vie secondaire à la queue ; il ne s’agit pas d’un battement volontaire. Une
marche réduit l’amplitude d’observation sans figer la tête.

Le même modèle est utilisé dans la simulation principale. Une proie devient la
cible du cou et du crâne pendant le suivi et l’attaque ; la matrice de la bouche
est recalculée après cette pose, de sorte que la langue part de la bouche
réellement orientée et non d’un crâne resté droit.

## Queue passive à géométrie originale

La queue emploie une tige XPBD de taille constante : treize nœuds pour douze
segments. Les deux premiers nœuds imposent le seul segment cinématique
`tail_01`; la liberté physique commence sur `tail_02`. Sa compliance augmente
graduellement sur les contraintes proximales `0,04 → 0,12 → 0,35 → 0,70 → 1`.
Le collet de skinning rigide se limite lui aussi à `tail_01`; le feather
géodésique exporté sur `0,18` rend ensuite l’entrée de `tail_02+` progressive et
protège la croupe. Il n’existe aucun moteur, pose cible ou couple musculaire dans
ce prototype : gravité, inertie, amortissement, contraintes de longueur et de
courbure déterminent seuls son mouvement secondaire.

Les deux ancres cinématiques sont lues sur les os réellement posés au tick fixe.
Le rig visuel applique ensuite directement la courbe collisionnée à
`tail_02..12`, sans rebase ni second mélange de rotations au rendu. Le skin
exporté reste l’unique autorité du raccord progressif : une correction purement
visuelle ne peut donc plus replacer la peau sous une surface après la résolution
des collisions. Les os sont publiés parent vers enfant en un parcours linéaire,
puis la hiérarchie reçoit une unique propagation finale : le coût ne devient pas
quadratique avec le nombre d’os de la queue.

L’orientation de chaque os utilise un repère à torsion minimale reconstruit depuis
la pose de repos. Une référence transverse est transportée par le plus court arc
le long des tangentes successives, puis le roulis original de chaque anneau est
réappliqué. Le report osseux conserve ainsi la spirale de l’asset sans intégrer
de rotation longitudinale d’une image à l’autre : son repère ne peut pas
accumuler une tresse au repos ou après une courbure prolongée. Le calcul réutilise
un scratch fixe ; l’absence d’artefact sur la silhouette de peau reste une preuve
visuelle runtime.

Sept itérations résolvent les longueurs et la flexion à 120 Hz, puis une passe
de collision bornée projette la courbe finale.
Chaque nœud reçoit depuis l’asset un rayon mesuré sur l’enveloppe réelle de la
peau par segment géodésique, avec une marge de 3 mm ; le profil peut donc
s’élargir à nouveau près de la pointe enroulée. Une projection bornée contre les
colliders fixes du laboratoire empêche la traversée du sol, des murs, rochers et
troncs ; le sol utilise une surface unilatérale afin de ne jamais éjecter une
queue posée vers le dessous d’une dalle épaisse. Les projections des nœuds et un
quart tournant des milieux de segments ferment les interstices entre les
échantillons ; seules les pénétrations profondes déclenchent jusqu’à deux passes
de réconciliation supplémentaires. Si un milieu de segment déplace ses
extrémités, seules ces extrémités sont immédiatement reprojetées, au plus deux
fois, afin que la dernière correction ne puisse pas les introduire dans un
collider adjacent. Le plan d’un nœud ne stabilise la friction et la vitesse que
pendant le tick où le collider fini a réellement confirmé le contact : sortir
tangentiellement du bord d’un rocher invalide donc aussi sa friction. Le nombre
de requêtes ne dépend pas du nombre d’itérations XPBD et le cas ordinaire
n’effectue aucune reprojection supplémentaire. La
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
modification du cône racine la réveille immédiatement ; l’idle discret de la
croupe peut donc lui redonner un mouvement secondaire très léger.

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

Après cette acquisition, quatre griffes ne sont pas autorisées à former un pont
virtuel entre des surfaces éloignées. Si plusieurs propriétaires sont proposés,
`SupportCohortModel` examine les quinze sous-ensembles non vides possibles. Il
rejette d’abord toute griffe hors de la portée réelle de son articulation, puis
construit entre les quatre contacts un graphe de continuité locale. Deux prises
ne sont reliées que sur une même surface voisine, à travers une couture courte,
sur deux faces adjacentes d’un volume convexe, ou autour d’une branche
explicitement identifiée. Des faces opposées ou deux îlots distants d’un même
collider restent séparés.

La cohorte retenue doit former une composante connexe. Une hystérésis emploie
une distance de sortie légèrement supérieure à la distance d’entrée ; après
trois sous-pas de rejet, la prise est libérée puis brièvement mise en cooldown.
Un vrai angle sol/mur proche et une transition face/sommet restent donc valides,
mais deux griffes au mur et deux au sol trop loin ne peuvent plus suspendre le
torse dans le vide. Le calcul examine toujours quinze masques et quatre contacts,
sans allocation ni nouvelle requête physique dans le chemin chaud.

## Pas fixe, interpolation et budget

Rapier, la démarche corps entier, l’IK anatomique et la queue avancent à
`120 Hz`, soit `1/120 s`, avec au plus quatre sous-pas par image. À durée acceptée
identique, le résultat physique et les transformations locales des os ne
dépendent pas d’un rendu à 60 ou 240 Hz. Le rendu interpole les poses précédente
et courante sans exécuter de nouvelle logique.

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
allocation. Le graphe de surfaces est partagé par tous les caméléons. Chaque
requête A* réutilise ses tableaux et chaque animal ne conserve ensuite qu’un
corridor borné ; le suivi physique est donc indépendant de la taille du graphe.
Un calcul GPU ou un flow field ajouterait ici synchronisation et lecture retour
pour des destinations rares et différentes. Un flow field partagé ne deviendra
pertinent que si une population entière reçoit simultanément la même cible.

L’overlay trace chaque os selon son véritable axe local `+Y` et sa
longueur exportée ; il n’invente plus de liaisons entre les origines de branches
hiérarchiques disjointes. Il est retiré de la scène lorsqu’il est masqué : son
coût est alors nul. Lorsqu’il est visible, un unique `LineSegments` met à jour
les 42 liaisons et les axes terminaux des doigts, de la mâchoire et de
`tail_12`, soit un seul draw call et environ 1,25 Kio de données dynamiques.
Le chemin de surface emploie lui aussi un seul draw call, des buffers fixes et ne
réécrit ses couleurs que lorsque le jalon actif change.

## Décor de validation

Le décor est volontairement synthétique et reproductible :

- sol et murs rugueux ;
- mur en verre lisse non préhensile ;
- plan rocheux incliné et tablette ;
- troncs horizontal, diagonal et vertical, avec des raccords physiques et des
  patches automatiquement reliés au manifold partagé ;
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
- `test/chameleon-lab-controller.test.js`, de
  `CHAMELEON-LAB-CONTROLLER-001` à `013`, protège les mappings AZERTY/QWERTY,
  l’exploration autonome géodésique et allocation-free, les limites monde et la
  détection d’immobilité. `CHAMELEON-LAB-CONTROLLER-011` à
  `CHAMELEON-LAB-CONTROLLER-013` couvrent en particulier la priorité de la
  destination, la continuité de son cap et l’unique raycast d’un clic valide
  avec rejet du verre ;
- `test/chameleon-lab-surface-navigation-graph.test.js`, de
  `CHAMELEON-LAB-SURFACE-NAV-001` à `005`, protège la connexité du CSR
  immuable, les faces opposées d’un même collider, les portails orientés et
  bornés en degré, le contournement avec enveloppe de clearance et la
  réutilisation du stockage A* ;
- `test/chameleon-lab-navigation-route.test.js`, de
  `CHAMELEON-LAB-NAVIGATION-001` à `009`, protège le corridor borné, les
  transitions de support dans les deux sens, la progression réelle du watchdog
  et la confirmation du propriétaire à une couture. Les preuves `006` à
  `009` figent la face source, la fusion des jalons coïncidents, le refus de
  fabriquer une route sans support physique et l’arrêt d’une replanification
  identique ;
- `test/chameleon-lab-route-debug-view.test.js` protège le tracé unique, ses
  couleurs, son stockage fixe et son coût nul lorsqu’il est masqué ;
- `test/chameleon-lab-support-cohort.test.js` protège la sélection déterministe
  et sans allocation d’un ensemble de griffes anatomiquement cohérent, y compris
  le rejet du cas deux appuis mur / deux appuis sol éloignés ;
- `test/chameleon-lab-input.test.js`, de `CHAMELEON-LAB-INPUT-001` à `007`,
  protège les transitions de touche ; `CHAMELEON-LAB-INPUT-007` interdit de
  rejouer un saut consommé pendant une saisie ou le mode libre ;
- `test/chameleon-lab-platformer-control.test.js`, de
  `PLATFORMER-CONTROL-001` à `020`, protège la direction arcade,
  l’accélération bornée et la stabilité des allocations ;
  `PLATFORMER-CONTROL-015` interdit la translation en crabe,
  `PLATFORMER-CONTROL-017` fixe une vitesse cible de sprint au moins `2,3×`
  supérieure à celle de marche, `PLATFORMER-CONTROL-018/019` conservent la
  cible de virage jusqu’à ce que le corps physique l’ait réellement rejointe,
  et `PLATFORMER-CONTROL-020` borne l’avance de cible à `25,2°` tout en conservant
  l’autorité de la commande ;
- `test/chameleon-lab-platformer-jump.test.js`, de `PLATFORMER-JUMP-001` à
  `021`, protège la croissance monotone de la hauteur et de la portée avec la
  charge, coyote/buffer, les enveloppes de pose et la stabilité des allocations.
  `PLATFORMER-JUMP-018` à `PLATFORMER-JUMP-021` couvrent la séparation d’un
  plafond, la précharge visible d’une frappe brève, la conservation d’un saut
  coyote accepté et l’amorti fondé sur la descente aérienne maximale ;
- `test/chameleon-head-look-model.test.js` protège les fixations idle
  déterministes, les limites cou/crâne, la priorité d’une cible, la continuité,
  l’invariance temporelle et l’identité des buffers ;
- `test/chameleon-lab-rig-debug-view.test.js` protège le buffer unique, le coût
  nul lorsqu’il est masqué et la couverture des chaînes du cou, des quatre
  membres, des doigts et de la queue ;
- `test/chameleon-lab-platformer-integration.test.js`, de
  `CHAMELEON-LAB-PLATFORMER-INTEGRATION-001` à `010`, verrouille l’ordre causal
  des forces ; `CHAMELEON-LAB-PLATFORMER-INTEGRATION-007/008` couvrent le clic
  événementiel, la priorité immédiate du pilotage manuel et les enregistrements
  de commande scellés et réutilisés ;
  `CHAMELEON-LAB-PLATFORMER-INTEGRATION-009` impose l’annulation atomique de
  l’autorité du saut pendant une saisie ou en mode libre ;
  `CHAMELEON-LAB-PLATFORMER-INTEGRATION-010` protège la création, la
  progression, l’effacement et la libération du tracé de route ;
- `test/chameleon-lab-whole-body-gait.test.js`, de `CHAMELEON-LAB-GAIT-001` à
  `009`, protège les couples diagonaux, les excursions du bassin/thorax/tête, le
  lissage apériodique et l’absence d’allocation ; `CHAMELEON-LAB-GAIT-005`
  couvre précisément l’idle corps entier sans déplacement des pieds et
  `CHAMELEON-LAB-GAIT-009` supprime cette enveloppe terrestre lorsque le corps
  est détaché ;
- `test/chameleon-procedural-gait.test.js`, de `CHAMELEON-GAIT-001` à `015`,
  protège la machine de pas et son stockage fixe. `CHAMELEON-GAIT-014` impose
  au plus une correction pour chacune des deux diagonales après l’arrêt malgré
  le déplacement apparent des candidats sur un support courbe ;
  `CHAMELEON-GAIT-015` impose qu’un pas déjà engagé se termine, puis laisse à la
  diagonale opposée son unique correction sans permettre un nouveau cycle ;
- `test/chameleon-lab-passive-tail.test.js` protège les treize nœuds fixes, le
  collet sacré à un segment, les ancres explicites, le gradient de compliance,
  les longueurs, la gravité, l’inertie, l’amortissement, les projections de
  nœuds et de segments, le reset et la récupération des valeurs non finies,
  ainsi que le sommeil bit-identique, tous ses motifs de réveil et l’absence de
  vitesse Verlet cachée au sol. Il interdit aussi la friction fantôme après la
  sortie coplanaire d’un support fini et la pénétration d’un collider adjacent
  créée par une correction de milieu de segment ;
- `test/chameleon-lab-passive-tail-visual-rig.test.js`, de
  `CHAMELEON-LAB-TAIL-VISUAL-001` à `003`, protège le repère à torsion minimale,
  le roulis de repos, l’orthonormalité finie et le scratch fixe du report visuel ;
- `test/chameleon-lab-anatomical-limb.test.js` protège longueurs exactes,
  ceinture mobile, flexions, paumes complètes, continuité du pôle et suspension ;
- `test/chameleon-lab-passive-limbs.test.js` protège le faible tonus
  configurable, les ligaments, les capsules corps, l’auto-collision des
  segments, l’unique projection externe par nœud et par pas, et la récupération ;
- `test/chameleon-lab-active-ragdoll.test.js` : les identifiants
  `CHAMELEON-LAB-RAGDOLL-001` à `034` protègent le corps Rapier unique, les
  quatre appuis, les forces et angles bornés, le mode libre, les valeurs finies,
  les excursions proximales sans jitter distal, les semelles zygodactyles à
  plat, la queue sans pénétration, les membres passifs et l’accrochage après
  lancer sur mur ou cylindre, la suppression des prises périmées au décollage
  et la reprise d’un support réel après impact, l’absence de capture à distance,
  le redressement ventral et le verrouillage d’un propriétaire dans un coin,
  ainsi que la flexion au repos, le repère anatomique du modèle et le mouvement
  doux du cou et de la tête. `CHAMELEON-LAB-RAGDOLL-020` mesure en plus
  l’amplitude de la brasse avant, borne les variations de vitesse angulaire,
  interdit tout avancement pendant une synchronisation de rendu seule et compare
  les poses à 60/240 Hz. `CHAMELEON-LAB-RAGDOLL-021` verrouille le sommeil
  statique et son réveil sur intention ; le réveil d’un corps déjà endormi par
  impact ou saisie reste un contrôle runtime. `CHAMELEON-LAB-RAGDOLL-022` relie
  la charge à l’accroupissement, l’extension et la compliance de la pose aérienne ;
  `CHAMELEON-LAB-RAGDOLL-023` prouve le transfert d’au moins deux griffes du sol
  vers un obstacle simple et sa montée ; `CHAMELEON-LAB-RAGDOLL-024` interdit
  aux canaux de marche et d’idle terrestre de continuer après la libération des
  appuis ; `CHAMELEON-LAB-RAGDOLL-025` préserve dans le mouvement physique
  l’amplitude d’une commande inférieure à un ; `CHAMELEON-LAB-RAGDOLL-026`
  valide un arc de virage physique décisif, court et convergent ;
  `CHAMELEON-LAB-RAGDOLL-027` mesure la réponse à `0,10`, `0,25` et `0,50 s`,
  exige le quasi demi-tour physique à une demi-seconde et borne le glissement
  latéral tout en conservant au moins deux appuis ;
  `CHAMELEON-LAB-RAGDOLL-028` impose les mêmes propriétés sur une pente de `18°` ;
  `CHAMELEON-LAB-RAGDOLL-029` combine avance et virage, en marche et en sprint,
  sur sol et pente, avec au moins deux appuis et un ratio latéral inférieur à
  `0,30` ; `CHAMELEON-LAB-RAGDOLL-030` conduit puis arrête le corps sur une
  branche de petit rayon et exige deux griffes, un verrou statique endormi, une
  dérive et des vitesses résiduelles bornées ; `CHAMELEON-LAB-RAGDOLL-031`
  maintient uniquement la commande avant et exige la succession mur proche,
  sommet puis face opposée, sans prise de sous-face ni perte totale d’appui ;
  `CHAMELEON-LAB-RAGDOLL-032` impose le même repère radial et le même sommeil à
  une branche enregistrée après la création du caméléon ;
  `CHAMELEON-LAB-RAGDOLL-033` injecte un axe et une force de prise non finis et
  vérifie le repli vers le collider, une normale unitaire, deux griffes et un
  verrou statique sain ; `CHAMELEON-LAB-RAGDOLL-034` conduit le corps du flanc
  au bouchon physique d’un cylindre fini et exige deux contacts, la rotation du
  cadre vers l’axe, une progression au-delà du bord et aucun saut de position ;
- `test/chameleon-lab-surface-camouflage.test.js`, de
  `CHAMELEON-LAB-CAMOUFLAGE-001` à `007`, protège les profils et repères
  immuables, le vote des quatre pattes, les délais et fondus, la concordance
  exacte entre support rendu et pigment copié, le matériau opaque, l’absence de
  capture écran/compute/raycast et le cycle complet runtime/UI ;
- `test/chameleon-physical-asset.test.js` protège les contrats de mesh/rig
  `3.6.0` et d’anatomie `2.2.0`, le mesh source exact, le skin, les 7 206 sommets
  originaux, l’absence de poids `tail_*` sur le corps, le collet `tail_01`, la
  racine dynamique `tail_02`, le feather géodésique `0,18`, les rayons de
  collision exportés et les axes de membres contenus dans le volume fermé.

Le build WebGPU protège l’assemblage des modules. Une inspection dans un
navigateur WebGPU reste indispensable pour l’exécution de bout en bout des
destinations cliquées, les transitions multi-surfaces complexes du décor, le
réveil sur impact ou saisie d’un verrou déjà endormi, la caméra, le lancer, les
ombres, la silhouette de la queue et le coût p95 réel.

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
