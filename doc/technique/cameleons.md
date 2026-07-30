# CHAMELEON-SIM — Caméléon, support et prédation

## Portée

`CHAMELEON-SIM` ajoute un unique prédateur de surface. Le système reste séparé
de la colonie de fourmis : il consomme uniquement des papillons adultes et
n’altère ni les ressources, ni les décisions, ni le coût de navigation des
fourmis.

L’abstraction s’appuie sur la séquence naturelle documentée chez les
caméléons : fixation, stabilisation, projection balistique, adhérence,
rétraction et prise par les mâchoires. Les durées sont comprimées pour rester
observables dans le jeu. Les ordres de grandeur de projection et de rétraction
proviennent notamment des mesures de
[Wainwright et al. (1991)](https://fishlab.ucdavis.edu/wp-content/uploads/sites/397/2020/06/Wainwright-et-al-1991c.pdf).
La portée paramétrable est cohérente avec la comparaison multi-espèces
d’[Anderson (2016)](https://pmc.ncbi.nlm.nih.gov/articles/PMC4698635/).

## Architecture

| Module | Responsabilité |
|---|---|
| `chameleon-simulation.js` | noyau déterministe, machine d’états, collision et capture |
| `chameleon-surface-collider.js` | bake exact des triangles marchables en monde, adjacence et BVH borné |
| `chameleon-surface-graph.js` | graphe global, transitions, routage local et corridors compacts projetés sur le collider |
| `chameleon-procedural-gait.js` | appuis verrouillés, marche diagonale à pas fixe, swing C1 et plan d’appui |
| `chameleon-rig.js` | contrat des 42 articulations et IK analytique post-`AnimationMixer` |
| `chameleon-body-contact.js` | trois sondes de corps, contraintes unilatérales et validation de la pose appliquée |
| `chameleon-tail-contact.js` | trois sondes de queue, corrections articulaires bornées et validation sans requête |
| `chameleon-assets.js` | chargement singleton et validation du GLB |
| `chameleon-camouflage.js` | variantes perceptives, pigments du viewport, motifs cutanés, transition et ombre résiduelle |
| `chameleons.js` | intégration collider→corridor→marche→rig, camouflage, langue et ombres |
| `butterfly-simulation.js` | évitement perceptif, verrouillage puis consommation atomique d’un adulte |
| `wildlife-inspector.js` | sélection ponctuelle, HUD et volumes de debug du seul animal suivi |
| `pollinators.js` | ordre d’update et chargement paresseux des systèmes liés |

Le noyau ne dépend ni de Three.js ni du renderer. Ses entrées de proies sont
des vues SoA de capacité fixe :

```text
count, x[], y[], z[], visible[], captured[],
headingX[], headingY[], headingZ[]
```

Trois callbacks stables forment la transaction de prédation :
`tryCapture(index)`, `setCapturedPosition(index, x, y, z)` et
`consume(index)`.

## Géométrie marchable et graphe global

Le premier ancrage conserve la priorité historique :

1. placement `Log_01` ou `Log_02` portant le tag `chameleon-host` ;
2. premier `Log_01` ;
3. premier `Log_02` ;
4. autre entrée de catalogue commençant par `Log_`.

Cet ancrage définit seulement le départ et le centre du rayon autorisé. Le
collider bake ensuite les triangles de **toutes les instances appartenant aux
15 classes de modèles marchables**.
Chaque triangle passe en monde avec la transformation réellement décrite par
le registre : translation `x/y/z`, rotation de lacet `yaw` et échelle scalaire
du placement multipliée par l’échelle courante de sa catégorie. Le bake
n’invente donc ni matrice générale, ni échelle non uniforme.

Le bake produit des tableaux typés immuables : sommets monde, normales,
identifiant de support, adjacence entre triangles et **BVH exact borné**.
`projectPoint` teste d’abord le triangle retenu par la projection précédente,
puis son anneau adjacent. Cette meilleure distance resserre immédiatement la
borne et élague davantage de nœuds. Le BVH exact poursuit ensuite la
vérification globale : le hint accélère la requête sans modifier le point, la
normale ou le support élus. La pile BVH, les marques de hint et les sorties sont
préallouées. Les formes réellement rendues des troncs, branches, rochers,
souches et arbres restent l’autorité de contact.

Les requêtes restent filtrables par **support et composante** : une projection
locale ne peut donc pas accrocher un objet voisin ou un îlot déconnecté. Les
requêtes interactives conservent leur rayon fini. Pendant le bake seulement,
`maxDistance: Infinity` est une valeur explicite et intentionnelle : elle permet
de retrouver un support éloigné du point guide sans supprimer ces deux filtres
topologiques. Elle n’est jamais convertie silencieusement en rayon par défaut.

Pour chaque support, le bake part d'un point guide uniquement pour identifier
la composante triangulaire atteignable. Les îlots déconnectés du même mesh sont
explicitement exclus. La composante atteignable est ensuite partitionnée en
**patches topologiques** déterministes : chaque patch contient au plus 96
triangles et garde, pour chacun, un parent face-adjacent jusqu'à son triangle
graine. Il ne subsiste aucun rail synthétique ni trajet centre-à-centre dans le
volume de l'objet.

Une arête entre deux patches mémorise le vrai bord partagé. À la compilation
d'un corridor, elle est développée en triangle graine -> parents -> milieux des
bords partagés -> portail -> parents -> triangle graine. Chaque sous-segment
reste donc dans un triangle réel. Les identifiants globaux de composante et de
triangle accompagnent tous les échantillons et sont revalidés sur le collider
avant publication.

La descente vers le terrain utilise un nœud portail distinct du centroïde du
premier patch. Ce portail est choisi sur la partie basse et périphérique de la
composante, au contact géométrique du sol. Le raccord à 90 degrés est une
discontinuité topologique explicite : une branche se termine sur le support et
une autre commence sur le sol. Une diagonale support-sol n'est jamais acceptée.
Si le portail, le support, la composante ou un échantillon exact manque, le bake
ou la compilation échoue en mode fermé au lieu de publier un raccourci.

Le résultat alimente le graphe creux CSR d’au plus **8 192 nœuds**.
`offsets`, `edgeTo` et `edgeWeight` décrivent les arêtes bidirectionnelles.
Les nœuds, transitions et échantillons d’un corridor sont projetés sur les
triangles exacts pendant sa compilation. Les segments invalides ou qui
quittent la surface marchable sont rejetés avant publication.

Le bake des triangles, de l’adjacence, de l’index et la projection des
corridors restent hors de la boucle chaude. Ils ne sont invalidés qu’après une
révision du décor ou la modification d’un réglage géométrique. À état
inchangé, le test de cache est O(1).

### Exploration locale, pas de circuit global

Le graphe global n’est jamais copié dans la simulation individuelle. À
l’arrivée au bout du corridor courant, `ChameleonSurfaceRouter.exploreNext`
choisit une courte continuation parmi les arêtes voisines. Le score conserve
l’inertie, favorise les zones peu visitées via un tableau `Uint16`, ajoute une
légère curiosité pour les supports et départage les égalités de façon
déterministe. Le rayon d’exploration est mesuré depuis l’hôte ; sa valeur par
défaut atteint les coins de la carte.

Cette succession de décisions locales permet d’explorer progressivement tout
le graphe sans imposer une destination lointaine, une ronde pré-écrite ou un
A* récurrent. `planChameleonRoute` et `routeTo` gardent un A* explicite pour le
diagnostic et une destination imposée, mais ne participent pas à
l’exploration ordinaire.

Chaque décision compile uniquement un corridor SoA actif d’au plus **384
échantillons**, déjà projeté sur la géométrie exacte. Tous les angles
obligatoires du chemin sont conservés ; si nécessaire, seule la densité des
subdivisions diminue. La fin d’un corridor est exactement le début du suivant,
donc un changement de branche, une montée ou une descente ne téléporte jamais
le caméléon.

Le plafond est appliqué au chemin **développé**, pas seulement au nombre de
nœuds A*. Les points obligatoires (centroïdes de triangles et portails de bord)
ne sont jamais supprimés. `planChameleonRoute` renvoie une erreur explicite
`CHAMELEON_CORRIDOR_BUDGET` si les 384 places ne suffisent pas. Le routeur
stateful raccourcit alors proprement le trajet au dernier nœud de graphe dont le
développement tient dans le budget ; `requestedTargetNode`, `targetNode` et
`truncated` rendent cette décision observable.

### Contacts, marche et orientation

Quatre candidats d’appui — avant gauche, avant droit, arrière gauche et arrière
droit — sont projetés sur les triangles du collider à la fréquence configurable
de contact, **60 Hz par défaut**. Lorsqu’une patte est en stance, son appui reste
**verrouillé en espace monde** : le corps avance sans faire glisser le pied. Les
diagonales avant-gauche/arrière-droit puis avant-droit/arrière-gauche alternent.
Un pied en swing suit une interpolation quintique à vitesse continue et une
levée quartique ; sa trajectoire est donc C1 au décollage comme au contact.

Au binding du rig, les sommets skinnés dont le poids du pied atteint `0,05`
servent à mesurer une fois la profondeur de chaque semelle dans l’espace du
modèle. Les quatre profondeurs et les positions de repos des semelles sont
stockées dans des tableaux typés fixes. En l’absence exceptionnelle de sommet
exploitable, le repli déterministe vaut un quart de la longueur du segment
inférieur.

La marche est intégrée à pas fixe, indépendamment du découpage des images. Le
plan moyen des quatre contacts sert au repère interne du gait et au placement
des pattes. Il ne translate pas une seconde fois le corps.

Le `bodyRoot` conserve la position `x/y/z` du corridor exact. Son orientation
combine les positions et normales des supports échantillonnés devant et
derrière le centre : le relief oriente donc le corps sans additionner la
hauteur issue des quatre pieds. Un embranchement, une arête ou un changement de
support ne produit ni double dégagement, ni saut de position.

Après chaque `AnimationMixer.update`, la pose rendue reçoit un solveur
analytique à deux os sur chaque chaîne `upper→lower→foot`. `footTargets`
désigne le **contact physique de la semelle** ; le solveur le convertit en
position du pivot osseux avec la profondeur mesurée et l’échelle courante. La
plante du pied est alignée sur la normale locale. Ce correctif est pondéré par
**Influence IK** et s’atténue pendant l’attaque afin de préserver l’animation
artistique de la mâchoire, de la langue et du corps.

### Corps, queue et publication transactionnelle

Trois sondes du corps génèrent des demi-espaces de non-pénétration sur le
triangle exact et son éventail convexe local. Leur correction commune est
bornée, puis la position réellement rendue est revalidée sans nouvelle requête
BVH. Si l’animation traverse un plan entre deux cadences, les mêmes contraintes
sont d’abord résolues contre les sondes courantes, sans requête. Un changement
de topologie déclenche au maximum trois projections exactes de secours. Si cette
correction tardive translate le corps après le premier IK, un passage jambes-only
réancre immédiatement les quatre semelles sur leurs contacts monde, sans recomposer
la queue ni relire le BVH.

Chaque sonde est en outre strictement liée à son support courant. Lorsqu’un
identifiant de support exact existe, le sol est exclu de cette requête : une face
latérale ou inférieure d’un tronc ne peut donc jamais être remplacée par un plan
de sol simplement plus proche. Les sondes non liées conservent le choix terrain
pour les vrais raccords support-sol.
Trois autres sondes réparties sur les neuf articulations de la queue produisent
des corrections unilatérales. Le solveur travaille par blocs articulaires :
`tail.01–02 → tail.03`, `tail.03–05 → tail.06` puis
`tail.06–08 → tail.09`. Les blocs distaux conservent ainsi les contacts
proximaux. Les rotations totales restent bornées depuis la pose Blender, la
pénétration est corrigée immédiatement et seule la libération est lissée. Comme
pour le corps, un identifiant de support exact exclut le plan de sol de la
requête afin de préserver les faces latérales et inférieures.

Après application procédurale, la queue est revalidée. Une contrainte primaire
devenue active entre deux refreshs est recalculée une seule fois contre la pose
courante, puis seule la queue est réappliquée : les jambes ne subissent jamais
un second IK. En cas d’échec cinématique réel, le runtime restaure dans un
buffer de 36 flottants la dernière pose locale sûre. Si elle échoue encore, la
pose complète sûre est restaurée. Cette récupération reste strictement visuelle :
elle n’inverse jamais la progression et ne choisit jamais une autre branche.

Le remplacement d’une route est transactionnel **dans le pas logique**. Le
routeur exécute `begin`, construit le corridor et valide le handoff complet sur
le collider exact ; `accept` est appelé dans ce même pas si l’installation
réussit, sinon `reject` restaure nœud courant, historique et compteurs. Un rebake
du graphe suit le même contrat synchrone. Si une révision de l’éditeur dépasse
un budget ou contient une géométrie invalide, le graphe, le collider, le routeur,
le corridor et leurs métadonnées précédents restent publiés ensemble. La
signature fautive est mémorisée afin de ne pas retenter le même bake à chaque
pas ; une nouvelle révision ou configuration réarme automatiquement la tentative.
La caméra, la visibilité et la cadence de rendu ne peuvent donc jamais suspendre
la progression, même à vitesse élevée ou pendant une longue plongée sous terre.

Le contact du squelette reste une couche visuelle corrective. Un rejet restaure
uniquement la dernière position et la dernière pose locale sûres ; il ne modifie
jamais `simulation`, la direction, le routeur, les compteurs ou le cycle de vie.
Si aucune pose sûre n’existe encore après une construction ou un reset, le modèle
reste masqué pour cette image plutôt que d’afficher une interpénétration. L’image
suivante retente la pose courante pendant que le pas logique continue normalement.
Les changements de branche proviennent donc exclusivement des validations exactes
et déterministes du corridor dans le fixed-step, jamais de la cadence de rendu.

## Machine d’états

| État | Rôle |
|---|---|
| `REST_SCAN` | pause vigilante et première recherche |
| `PATROL_LOG` | marche bornée sur le corridor de surface actif |
| `TRACK_PREY` | projection de la proie sur la piste et approche |
| `AIM_AND_BRACE` | suivi encore annulable et stabilisation du corps |
| `STRIKE_EXTEND` | point figé, extension balistique |
| `CONTACT` | adhérence courte au vrai point de collision |
| `RETRACT_WITH_PREY` | retour continu de la langue et de la proie |
| `BITE_AND_SWALLOW` | fermeture de la mâchoire et consommation |
| `COOLDOWN` | récupération avant une nouvelle recherche |

La recherche de cible fonctionne à 8–10 Hz. Elle parcourt au plus
`MAX_BUTTERFLIES = 64` entrées, utilise des distances au carré et ignore les
stades immatures, les slots invisibles et les proies déjà capturées.

## Arrêts et camouflage perceptif

Des pauses de camouflage sont planifiées de façon déterministe entre deux
attaques. Leur intervalle et leur durée sont configurables. Durant une pause,
les vitesses de patrouille et de poursuite sont mises à zéro sans déplacer le
caméléon.

Pour les papillons, le camouflage est défini par le comportement observable :
il faut qu’une **pause de camouflage planifiée** soit active, que le caméléon
soit resté pratiquement immobile pendant au moins `0,08 s` et qu’il ne soit pas
dans une phase révélatrice de projection, contact, rétraction ou déglutition.
Un repos ordinaire reste donc visible. La vue de menace stable expose alors
`camouflaged = true`. L’évitement des papillons traite immédiatement cet état
comme l’absence du prédateur ; aucune lecture de matériau ou de pixel n’entre
dans la décision. Le temps d’immobilité appartient à un verrou dédié, et non au
temps de l’état courant : l’acquisition puis la visée ne créent donc aucun
clignotement perceptif. Le verrou est remis à zéro dès `STRIKE_EXTEND`.

Le rendu reste strictement séparé de cette autorité logique. Chaque matériau
naturel du GLB possède une variante perceptive précréée. Toutes ces variantes —
corps, yeux, bouche et autres parties visibles — partagent **la même instance**
de `viewportSharedTexture()`. Une seule copie du viewport alimente donc toute
la silhouette pendant une transition ou une pause camouflée.

Deux ondes sinusoïdales bon marché, calculées depuis `positionGeometry`,
produisent des taches larges et stables en espace objet. Elles modulent la force
de l’adaptation et décalent légèrement l’UV échantillonné via **Diffusion des
couleurs**. Le motif ne dépend ni du temps ni de la position monde : il ne glisse
donc pas sur la peau et ne suit pas la caméra.

Le facteur de correspondance locale est borné ainsi :

```text
pigment = mix(luminance(décor), couleurDécor, 0,78) × motif
localMatch = transition × (adaptationDécor + variationMotif)
localMatch *= 1 - angleRasant² × lisibilitéContours
0 ≤ localMatch ≤ 0,86
```

Le plafond strict de `0,86` garantit qu’au moins 14 % de la réponse diffuse
naturelle subsiste, même avec les réglages maximaux. Aux angles rasants, le
facteur diminue encore afin de préserver un contour doux. Le pigment est injecté
par `backdropNode` et `backdropAlphaNode` dans le pipeline éclairé ; les
normales, la rugosité, les reflets et le relief PBR du modèle restent donc
visibles. Le camouflage ne peut jamais devenir une copie pixel à pixel.

Le matériau perceptif est techniquement placé dans la liste transparente pour
être ordonné après le décor opaque, mais il produit une alpha de `1` et conserve
`depthTest = true`, `depthWrite = true`, une opacité de `1` et
`forceSinglePass = true`. La silhouette garde ainsi sa profondeur sans
déclencher la double passe des matériaux transparents à double face.

L’ombre projetée utilise un masque de dithering stable dans la géométrie. Elle
s’atténue avec la transition, mais **Ombre résiduelle** conserve toujours une
partie configurable de sa couverture et le runtime impose un minimum de 10 %.
L’entrée et la sortie restent des transitions exponentielles monotones pilotées
par le temps de rendu, donc indépendantes du multiplicateur de simulation et
invariantes au découpage des frames.

La variante perceptive est préchauffée une fois avec `renderer.compileAsync`.
Le swap a lieu seulement quand la transition dépasse un epsilon ; au retour
sous cet epsilon, les matériaux naturels sont restaurés. Hors transition et hors
camouflage, aucun node de viewport n’est rendu et aucune copie de framebuffer
n’est demandée.

Pendant l’effet, la capture couleur partagée impose une interruption/reprise de
la passe WebGPU. Ce n’est ni un second rendu de la scène, ni un draw, ni un
dispatch compute supplémentaire : le coût est constant, dépend surtout de la
résolution et reste nul une fois le camouflage et sa transition terminés.

Pour un papillon, seul le booléen logique `camouflaged` rend néanmoins le
prédateur imperceptible : aucun matériau, échantillon ou pixel n’entre dans sa
décision.
Un papillon adulte vérifie la menace à une cadence configurable, **10 Hz par
défaut**. La distance, le champ de vision et l’accélération de fuite sont
paramétrables. Les scans sont déphasés entre slots, utilisent la vue compacte
du caméléon et restent bornés aux 64 emplacements fixes. Une menace visible
interrompt l’activité et produit une fuite continue, orientée à l’opposé
d’une courte prédiction de mouvement du prédateur ; aucun saut de position
n’est autorisé.

## Projection et contact

Pendant la visée, le point courant suit encore le papillon. À la libération,
une prédiction courte et bornée peut utiliser sa direction de vol, puis la
cible de frappe est immuable.

À chaque sous-pas, le segment parcouru par le bout de langue est testé contre
la sphère de la proie élargie par le rayon de langue. Ce balayage évite qu’une
extension de quelques millisecondes traverse un papillon entre deux images.

Une capture conserve l’offset constaté au contact :

```text
offset = butterflyPosition - tongueTip
butterflyPosition(t) = tongueTip(t) + offset
```

Le papillon n’est consommé qu’à l’entrée de la bouche. Un raté suit sa propre
rétraction et ne touche jamais au cycle de la proie.

## Animation Blender et rendu

`public/Chameleon.glb` contient le caméléon riggé, ses couleurs de sommets et
deux actions exactes :

- `Walk_Chameleon_Imported` ;
- `Attack_Chameleon_Imported`.

L’attaque anime le corps entier : pieds en prise, bassin, torse, queue, cou,
tête, yeux, mâchoire et déglutition. Les repères `mouth_socket` et
`capture_socket` documentent les deux extrémités fonctionnelles de la langue.

Le GLB a été exporté depuis la scène Blender de référence après ajout des os
`jaw`, `tongue_base`, `tongue_mid`, `tongue_tip`, `mouth_socket` et
`capture_socket`. Il conserve 42 os et deux clips contractuels :
`Walk_Chameleon_Imported` (2,7083 s) et `Attack_Chameleon_Imported`
(1,8333 s). L’attaque ouvre réellement la bouche, projette la langue, marque le
contact, ramène la proie et referme la mâchoire ; le corps entier accompagne
ces phases au lieu de jouer une simple translation de langue.

`GLTFLoader` retire de façon déterministe les points de certains noms destinés
aux bindings d’animation : le suffixe `.L` devient `L` et `tail.01` devient
`tail01`. Le binding conserve les noms Blender comme contrat public, accepte
leur alias runtime sans point, puis valide le type, les 42 articulations et
leurs relations. Cette normalisation ne masque donc ni un os absent ni une
hiérarchie invalide.

Un seul animal ne justifie pas une VAT ou un compute shader : un
`AnimationMixer` sur ce petit squelette coûte moins cher et permet de conserver
les sockets animés. La longueur exacte de langue reste analytique afin de
coïncider avec le point de collision réel. Le matériau PBR est éclairé et les
drapeaux `castShadow` et `receiveShadow` sont appliqués indépendamment à
chaque maillage du GLB et à la langue procédurale.

## Réglages et bornes

Le dossier **Graphismes → 🦎 Caméléon** expose :

| Réglage | Défaut | Bornes UI |
|---|---:|---:|
| Taille | 1× | 0,4–2,5× |
| Vitesse de mouvement | 1,15 | 0,05–4 |
| Vitesse de poursuite | 1,45 | 0,05–5 |
| Vitesse animation marche | 1× | 0,1–4× |
| Réactivité orientation | 6 | 1–15 |
| Collisions exactes | oui | booléen |
| Pattes procédurales | oui | booléen |
| Solveur de contact | 60 Hz | 15–120 Hz |
| Hauteur des pas | 0,16 | 0–0,5 |
| Influence IK | 1 | 0–1 |
| Explorer la carte | oui | booléen |
| Rayon d’exploration | `ceil(WORLD × √2)` | 2–diagonale monde |
| Camouflage automatique | oui | booléen |
| Adaptation au décor | 0,68 | 0–0,86 |
| Lisibilité des contours | 0,35 | 0–0,8 |
| Motifs cutanés | 0,18 | 0–0,4 |
| Échelle des motifs | 3 | 0,5–12 |
| Diffusion des couleurs | 0,004 | 0–0,015 |
| Ombre résiduelle | 0,28 | 0,1–0,6 |
| Temps d’adaptation | 2,2 s | 0,1–6 s |
| Retour naturel | 0,8 s | 0,1–4 s |
| Intervalle camouflage | 14 s | 1–60 s |
| Camouflage min / max | 7 / 13 s | 0,5–30 / 0,5–60 s |
| Dégagement support | 0,006 | 0–0,25 |
| Distance de détection | 4,8 | 1–12 |
| Distance d’attaque | 3,2 | 0,5–8 |
| Zone attaque du sélectionné | non | booléen |
| Préparation attaque | 0,55 s | 0,2–3 s |
| Rétraction langue | 0,28 s | 0,15–0,6 s |
| Repos après attaque | 1,1 s | 0,3–6 s |
| Projeter / recevoir les ombres | oui / oui | booléens indépendants |

Les réglages de comportement mettent à jour le noyau existant sans recharger
le GLB. **Vitesse animation marche** ne multiplie que la phase visuelle du
clip de marche ; la durée et les collisions de l’attaque restent pilotées par
la machine logique. **Collisions exactes** sélectionne l’autorité des triangles,
**Pattes procédurales** active le correctif post-animation, et **Influence IK**
en pondère l’effet. La fréquence cadence la projection des quatre pieds et le
pas fixe du gait ; l’IK post-`AnimationMixer` s’applique ensuite à chaque pose
rendue, sans nouvelle requête géométrique. Le rayon borne les choix locaux sans
rebake ; seules la révision du décor et les options géométriques invalident le
graphe global.

La distance de détection interne est toujours au moins égale à la distance
d’attaque. Le réglage de portée modifie donc la décision, mais ne change ni le
plafond de 64 proies inspectées ni la cadence de scan.

## Sélection et diagnostic

Le clic compare uniquement le raycast du maillage unique du caméléon et le
test analytique borné des papillons visibles. Il n’exécute donc aucun raycast
de population pendant la boucle normale. L’inspecteur affiche l’état, la
cible ou la capture, la classe de surface, le support et le segment courants,
la progression dans le corridor local, le camouflage et la télémétrie des
contacts physiques disponible.

Si **Zone attaque (sélection)** est active, une sphère de debug suit la bouche
du caméléon sélectionné. Pour un papillon sélectionné, son volume de vision
n’est créé qu’une fois et n’est affiché que si **Zone du sélectionné** est
active. Le HUD est rafraîchi à 5 Hz ; ces géométries ne sont jamais dupliquées
pour toute la population.

## Budget

- graphe CSR global plafonné à 8 192 nœuds, rebaké uniquement après révision
  du décor ou changement d’une option géométrique ;
- triangles monde de toutes les instances des 15 classes marchables, adjacence
  et BVH exact calculés une fois ; translations, lacets et échelles scalaires
  réelles conservés ;
- corridor actif plafonné à 384 échantillons et seul trajet lu à chaque pas ;
- choix d’exploration borné aux voisins lors d’une arrivée, avec compteurs de
  visite fixes ; aucun circuit global ni A* dans la routine ;
- projection des transitions et corridors sur les triangles limitée au bake ;
- projection de bake illimitée uniquement sur demande explicite, toujours
  filtrée par support et composante ;
- un seul squelette et un nombre de draws constant ;
- au plus 640 tests de distance par seconde à 64 papillons et 10 Hz ;
- buffers, vue de menace et télémétrie stables ;
- quatre requêtes BVH cadencées et buffers stables, aucun raycast de frame ;
- marche diagonale à pas fixe et quatre IK analytiques à deux os appliqués à la
  pose rendue, sans moteur physique généraliste ni allocation chaude ;
- trois sondes de corps et trois de queue à cadence bornée ; validation de pose,
  récupération locale de queue et rollback de corridor sans requête BVH ni
  allocation dans la boucle chaude ;
- volumes de debug et recherche de sélection actifs pour le seul individu suivi ;
- sous-pas bornés pour les frappes courtes ;
- aucun lien avec `antCount` et aucun coût proportionnel au nombre de fourmis ;
- hors effet : matériaux naturels, **0 copie framebuffer** et aucun coût de
  camouflage perceptif ;
- effet actif : une seule copie du viewport partagée par tout l’animal, un
  échantillon décalé et deux ondes en espace objet par fragment ;
- variantes précréées et préchauffées, sans compilation pendant la transition ;
- **0 draw supplémentaire**, **0 dispatch compute** et aucune passe de scène
  additionnelle ; `forceSinglePass` interdit la double passe transparente ;
- chargement du GLB évité lorsque le caméléon est désactivé.

## Preuves de non-régression

- `CHAMELEON-SIM-001` : identités stables de la vue et de la télémétrie ;
- `CHAMELEON-SIM-002` : déterminisme à entrées identiques ;
- `CHAMELEON-SIM-003` : maintien et inversion sur une piste irrégulière ;
- `CHAMELEON-SIM-004` : aucune frappe hors portée ;
- `CHAMELEON-SIM-005` : séquence d’attaque complète et ordonnée ;
- `CHAMELEON-SIM-006` : suivi pendant la visée puis point figé ;
- `CHAMELEON-SIM-007` : contact balayé réel, raté sans capture ;
- `CHAMELEON-SIM-008` : offset conservé et rétraction continue ;
- `CHAMELEON-SIM-009` : rejet de capture atomique ;
- `CHAMELEON-SIM-010` : sélection déterministe du tronc ;
- `CHAMELEON-SIM-011` : piste SoA issue du relief ;
- `CHAMELEON-SIM-012` : décor édité et échelles pris en compte ;
- `CHAMELEON-SIM-013` : recherche 8–10 Hz strictement bornée ;
- `CHAMELEON-SIM-014` : buffers et boucle chaude stables ;
- `CHAMELEON-SIM-015` : contrat exact du GLB, du rig, des sockets et des clips ;
- `CHAMELEON-SIM-016` : attaque complète du corps, de la mâchoire et de la langue ;
- `CHAMELEON-SIM-017` : chargement singleton et clonage sûr du squelette ;
- `CHAMELEON-SIM-018` : un mixer et une langue procédurale de coût fixe ;
- `CHAMELEON-SIM-019` : reconstruction du relief uniquement sur révision ;
- `CHAMELEON-SIM-020` : visibilité et ombres indépendantes ;
- `CHAMELEON-SIM-021` : capture SoA stable et gel de la proie ;
- `CHAMELEON-SIM-022` : suivi continu de la langue et relâchement ;
- `CHAMELEON-SIM-023` : consommation dans la bouche et retour au stade œuf ;
- `CHAMELEON-SIM-024` : rejets sûrs des proies invalides ;
- `CHAMELEON-SIM-025` : réglages UI et deux drapeaux d’ombre indépendants ;
- `CHAMELEON-SIM-026` : cycle paresseux du prédateur dans la façade ;
- `CHAMELEON-SIM-027` : pont de rendu stable, flush après la prédation ;
- `CHAMELEON-SIM-028` : rotation progressive vers une proie latérale, sans snap ;
- `CHAMELEON-SIM-029` : la bouche logique suit la normale du support baké ;
- `CHAMELEON-SIM-030` : vitesses de déplacement et d’animation indépendantes ;
- `CHAMELEON-SIM-031` : remplacement continu d’un corridor terminé, sans recul,
  déplacement ni rupture de cap ;
- `CHAMELEON-SIM-032` : exploration locale réactive sans circuit et camouflage
  uniquement pendant une pause explicitement planifiée ;
- `CHAMELEON-SIM-033` : verrou de camouflage continu pendant acquisition et
  visée, puis révélation immédiate au lancement de la langue ;
- `CHAMELEON-SIM-034` : transition perceptive bornée, monotone et invariante au
  découpage du temps de rendu ;
- `CHAMELEON-SIM-035` : variantes perceptives de tout l’animal, profondeur et
  simple passe conservées, puis retour aux matériaux naturels à coût nul ;
- `CHAMELEON-SIM-036` : une seule capture viewport partagée et légèrement
  décalée, adaptation diffuse éclairée par `backdropNode`, ombre dither,
  préchauffage et absence de mip/blur ;
- `CHAMELEON-SIM-037` : plafond de correspondance à 0,86, contribution naturelle
  d’au moins 14 %, contours plus lisibles aux angles rasants, profil borné et
  motif déterministe en espace objet ;
- `CHAMELEON-SURFACE-001` : toutes les instances reconnues sont bakées au-delà
  des anciens plafonds de 8 supports et 512 échantillons ;
- `CHAMELEON-SURFACE-002` : corridors continus terrain→rocher→tronc→arbre,
  repères SoA normalisés et plafond actif de 384 échantillons ;
- `CHAMELEON-SURFACE-003` : nœuds et arêtes de terrain conservent la clearance
  sur la fixture de rochers adversariale ;
- `CHAMELEON-SURFACE-004` : cache de bake gouverné uniquement par révision et
  configuration géométrique ;
- `CHAMELEON-SURFACE-004B` : un bake invalide conserve byte pour byte le dernier
  cache publié ;
- `CHAMELEON-SURFACE-005` : exploration locale déterministe, continue, avec
  inertie et préférence pour les branches peu visitées ;
- `test/chameleon-surface-collider.test.js` : transformations monde, triangles,
  adjacence, hint précédent, anneau voisin, vérification BVH exacte, requêtes
  bornées, portée `Infinity` explicite et filtrée, et identités de buffers du
  collider ;
- `CHAMELEON-SURFACE-006` : couverture complète d'un support courbe par patches,
  corridor exact et transitions uniquement entre triangles face-adjacents ;
- `CHAMELEON-SURFACE-007` : exclusion des îlots déconnectés et conservation des
  identifiants globaux de composante ;
- `CHAMELEON-SURFACE-008` : développement d'un support replié en U par ses vrais
  bords partagés, sans corde traversant le volume, jusqu'au portail exact ;
- `CHAMELEON-SURFACE-009` : rejet fermé d'un support manquant, d'une composante
  modifiée et d'une route stationnaire sans tangente ;
- `CHAMELEON-SURFACE-010` : raccord support-sol à angle droit local, explicite et
  entièrement résolu ;
- `CHAMELEON-SURFACE-011` : erreur de budget sur le compilateur stateless et
  troncature sûre du routeur stateful sans suppression d'un point obligatoire ;
- `CHAMELEON-SURFACE-012` : le vrai `Tree_07.fbx` bake un portail local exact
  quelle que soit l’orientation du placement ;
- `test/chameleon-surface-patches.test.js` (`CHAMELEON-SURFACE-006` à `009`) :
  flood de composante, portails de bord, déterminisme sous budget et chaîne de
  parents bornée pour chaque triangle atteignable ;
- `test/chameleon-procedural-gait.test.js` : stance verrouillée, diagonales,
  swing C1, plan d’appui, pas fixe et IK analytique ;
- `test/chameleon-rig.test.js` : hiérarchie exacte, chaînes, métriques et
  alias GLTFLoader déterministes, calibration des semelles depuis le skin,
  cibles IK au contact réel, sauvegarde locale de queue, correctif
  post-`AnimationMixer` et atténuation pendant l’attaque ;
- `CHAMELEON-BODY-CONTACT-001` à `009` et
  `CHAMELEON-TAIL-CONTACT-001` à `006` : marges exactes, éventails convexes,
  budgets de requêtes et validation inter-images ;
- `test/chameleon-physical-locomotion.test.js` : intégration runtime
  collider→corridor→marche→rig, récupération locale de queue, indépendance de la
  cadence de rendu et conservation transactionnelle de l’ancienne route lors
  d’un rebake invalide (`CHAMELEON-PHYSICS-000E`) ;
- `BUTTERFLY-FEAR-001` à `006` : perception, camouflage, FOV, fuite continue,
  cadence bornée, déterminisme et boucle chaude stable ;
- `WILDLIFE-INSPECTOR-001` à `003` : sélection bornée, arbitrage au clic,
  intentions, supports, menace et volumes du seul individu sélectionné.
