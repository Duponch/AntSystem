---
title: Laboratoire du caméléon physique
order: 62
summary: Piloter et éprouver un caméléon hybride stable sur des sols, murs, rochers et troncs.
contracts: CHAMELEON-SIM
---

# Laboratoire du caméléon physique

Le laboratoire est une scène séparée du jeu principal. Il permet de piloter un
caméléon dont le centre du corps est simulé par Rapier, tandis que ses quatre
pattes suivent des appuis de surface par animation procédurale et IK bornée.
Cette architecture hybride privilégie la stabilité : les articulations
visuelles ne sont pas une chaîne de corps rigides libre de s’entortiller.

Le modèle visible reprend la géométrie originale, y compris les **7 206 sommets
de la queue d’origine**. Elle n’est ni remplacée par un tube, ni reconstruite :
douze os suivent sa courbure source. Seul `tail_01` forme un court collet rigide
au-dessus de la croupe ; la simulation passive commence dès `tail_02`. Une
transition de peau progressive sur 18 % de la distance géodésique évite une
charnière visible et laisse le reste traîner, se balancer et se poser sur le
décor sans tirer le bas du dos. Le laboratoire ne fait pas avancer la colonie.

Le caméléon n’est plus un volume vert uniforme. Sa peau utilise une palette
facettée : verts végétaux sur le corps, ventre plus clair, crête chaude, pattes
et queue nuancées. Les yeux pyramidaux possèdent une tourelle jaune, un iris
ambre, une pupille sombre et un reflet. Cet aspect est peint directement sur
les facettes du modèle ; il conserve donc exactement la même silhouette, le
même squelette et le même coût de rendu. Le shader toon commun à l’ensemble du
jeu sera traité séparément plus tard.

La peau peut aussi reprendre automatiquement la couleur et les motifs de la
surface tenue : terre mouchetée, pierre facettée ou stries d’écorce. Ce
camouflage reste un vrai matériau opaque. Le caméléon conserve son volume, ses
ombres et son éclairage ; il ne montre jamais une image de la caméra à travers
son corps.

## Ouvrir le laboratoire

Démarrez le serveur puis ouvrez :

```text
http://localhost:5173/?test
```

`?test=chameleon` ouvre la même scène. Le bouton **Retour à la colonie** recharge
le jeu normal. Un navigateur compatible WebGPU est requis.

Blender n’a pas besoin d’être ouvert pour utiliser ou tester le laboratoire.
La scène Blender n’est nécessaire que pour une modification volontaire de
l’asset ; sa reconstruction reproductible peut également être lancée en mode
sans interface.

## Commandes

- `Z`/`W` ou flèche haut : avancer ; `S` ou flèche bas : reculer ;
- `Q`/`A`, `D` ou les flèches gauche/droite : tourner. Ces commandes arcade ne
  déplacent jamais le caméléon en crabe : le corps répond immédiatement et un
  appui d’environ une demi-seconde réalise déjà un quasi demi-tour physique sur
  un petit arc stable. En avançant simultanément, il décrit une courbe nette
  dans le sens demandé, en marche comme en sprint, sans dérapage latéral ;
- `Shift` : sprinter avec une vitesse cible au moins `2,3×` supérieure à celle
  de la marche ;
- `Espace` : charger le saut en s’accroupissant, puis relâcher pour bondir. La
  charge augmente à la fois la hauteur et la portée ;
- clic gauche bref sur une surface grippable : choisir une destination ;
- clic droit maintenu : tourner la caméra ;
- molette : rapprocher ou éloigner la caméra ;
- clic gauche maintenu sur le caméléon : saisir son corps et le secouer ;
- relâcher le clic gauche : lancer le corps avec l’élan du pointeur ;
- `C` : activer ou suspendre l’exploration autonome ;
- `F` : basculer entre locomotion stabilisée et **Physique libre** ;
- `H` : afficher ou masquer le corps physique et les quatre appuis ;
- `R` : remettre l’animal dans sa pose de départ.

Le déplacement suit le support courant et l’avant réel du corps, indépendamment
de l’angle de la caméra. `Q`/`A` et `D` font pivoter cet avant avec un très léger
pas vers l’avant pour garder un geste vivant, jamais vers le côté ; les commandes
avant/arrière assurent la translation principale. Sur un mur ou un plan
incliné, avancer ne signifie donc pas revenir horizontalement vers le sol. Le
cap est transporté continûment le long des courbes : une branche cylindrique, un
lancer ou un raccord sol/mur ne peut plus transformer « avancer » en dérive
latérale.

Un clic de destination active l’exploration dirigée. Le décor du laboratoire
possède un graphe partagé de toutes ses surfaces préhensiles : terrain contournant
les obstacles, faces des murs, troncs, bouchons et rochers. A* choisit au clic un
corridor de surface, puis le caméléon le suit physiquement sans recherche à
chaque image. À une jonction, il ne passe au jalon suivant qu’après avoir
réellement pris la nouvelle surface. S’il tourne sans se rapprocher du corridor,
une nouvelle route est calculée automatiquement ; le même échec n’est jamais
rejoué indéfiniment. Les arêtes sont contournées avec la clearance du corps et
non coupées en diagonale. Une commande clavier reprend immédiatement la priorité
et efface le tracé. Le verre lisse n’est pas une destination valide.

Le chemin reste visible : cyan sur le terrain, vert sur un support, ambre aux
transitions, jaune pâle sur le segment actif, bleu-gris une fois parcouru et
magenta à la destination. Cette vue
sert à distinguer une erreur de planification d’un échec d’adhérence physique.

Le saut suit lui aussi le support. La charge comprime le corps ; le décollage
l’étend, sépare d’abord le corps de la surface puis fait croître la hauteur et la
portée avec la charge. Les membres se replient ensuite en l’air avec une
compliance musculaire légère, sans poursuivre un cycle de marche. Les anciennes
prises sont oubliées au décollage ; seule une surface dont un impact Rapier a
d’abord établi le contact peut être reprise sans capture à distance. Saisir le
corps ou activer **Physique libre** annule une précharge en cours : relâcher
ensuite `Espace` ne rejoue pas un ancien saut.

## Deux modes distincts

### Locomotion stabilisée

Un seul corps Rapier porte la masse, la gravité, les collisions et les
impulsions. Jusqu’à quatre appuis sont recherchés sur les surfaces autorisées.
Leur cadre moyen stabilise progressivement le corps. Une animation procédurale
prépare d’abord une vraie enjambée depuis l’épaule ou la hanche, plie le coude
ou le genou et anime bassin, thorax, cou et tête ; une IK à angles limités ferme
ensuite précisément le contact du pied. Les appuis peuvent avoir des normales
différentes, par exemple dans un angle entre le sol et un mur.

Le squelette de référence reprend la flexion visible du modèle : épaules,
hanches, coudes et genoux sont placés dans les volumes anatomiques correspondants
et non sur une hypothétique patte droite. Les axes exportés des bras et jambes
sont aussi vérifiés à l’intérieur du volume fermé de la peau ; le tracé de debug
montre ces mêmes axes, sans inventer de raccord entre deux articulations. Le
talon, la paume et les deux groupes de doigts forment maintenant une seule
semelle exportée avec le modèle. Une main ou un pied doit donc reposer à plat :
le runtime ne tire plus uniquement les orteils vers la surface. Au repos, cou,
tête, thorax et bassin participent à un idle corps entier : respiration,
fixations irrégulières et transfert de poids très faible restent visibles sans
provoquer de pas ni de vibration des appuis. Ce mouvement discret de la croupe
donne aussi un peu de vie à la queue passive. Le repère de marche reste celui du
corps entier et non l’axe local incliné d’un os de colonne.
La démarche corps entier et l’IK sont calculées au pas fixe de 120 Hz. Le rendu
interpole seulement deux poses déjà résolues : changer la fréquence d’écran ou
rendre plusieurs fois la même image ne modifie donc ni le cycle ni les os.

Lorsque le caméléon est réellement immobile et posé sur plusieurs griffes, le
corps Rapier passe en sommeil et les appuis entrent dans un verrou statique sans
jitter. Une commande libère explicitement ce verrou ; un impact réveille Rapier
et le début d’une saisie demande le même réveil. Ces deux interactions externes
font aussi partie de la vérification manuelle du laboratoire.

Sur une branche cylindrique, les normales des griffes peuvent pointer dans des
directions très différentes sans s’annuler. Le corps conserve le côté cohérent
du support, puis utilise l’axe et le rayon de la branche pour construire son
repère radial. Après l’arrêt, la démarche termine au plus le couple diagonal
déjà engagé puis peut corriger l’autre : chacune des deux paires diagonales
dispose d’un seul passage, jamais davantage. Une petite branche rugueuse doit
donc finir par acquérir le même verrou statique et le même sommeil qu’un sol
plat, sans balancement continu.

Les propriétés d’une branche restent prises en compte lorsqu’elles sont
enregistrées après la création du caméléon. Si son axe ou sa force de prise sont
invalides, le laboratoire revient aux dimensions physiques du collider et à des
valeurs sûres : le support ne devient ni non fini, ni inutilisable. Arrivé au
bout du cylindre, le caméléon transfère progressivement ses griffes du flanc au
bouchon réel, fait pivoter son repère vers l’axe et continue sans bond de pose.

### Physique libre

La touche `F` suspend la recherche d’appuis et la stabilisation du corps. Le
corps unique tombe, glisse, rebondit et peut être lancé sous l’action de Rapier.
Les quatre membres deviennent souples, tout en conservant une faible tension
musculaire : ils ploient et suivent l’inertie sans pendre comme des chaînes
mortes. Des volumes de protection autour du torse et de la tête empêchent leur
enfoncement dans le corps ; les segments des membres se repoussent aussi pour ne
pas s’entrecroiser. Ils récupèrent progressivement leur pose lorsque la
locomotion est réactivée. Ce mode sert à vérifier la gravité et les collisions.
Ce n’est pas un ragdoll Rapier à 33 corps : le calcul passif local reste borné.

## Exercices de validation

### Pilotage, destination et saut

Sur le sol puis sur un tronc, maintenez `Q`/`A` ou `D` sans avancer : le corps
doit engager franchement son demi-tour, sans glisser de côté ni tourner comme
une toupie. Comparez ensuite marche et sprint, puis cliquez
sur une surface rugueuse derrière un mur ou sur un tronc : le trait doit
contourner ou escalader les obstacles et le caméléon doit parcourir physiquement
ses transitions jusqu’à la cible, sans coupe aérienne.
Enfin, chargez `Espace` brièvement puis à fond : le second saut doit être plus
haut et plus long, avec accroupissement, extension et repli aérien visibles.

### Contact entre deux surfaces

Placez le caméléon près d’un angle entre le sol et un mur rugueux, puis avancez
obliquement. Les pieds peuvent viser des surfaces différentes ; le corps doit
changer progressivement d’orientation, sans vrille ni saut de position.

### Troncs et rochers

Essayez les perchoirs horizontal, diagonal et vertical, puis le plan rocheux
incliné. Les pieds alternent entre phase d’appui et phase de transfert. Les
cibles restent bornées autour du corps et les articulations restent proches de
leur pose anatomique, même lorsqu’un support disparaît.

Sur l’extrémité d’un perchoir cylindrique, au moins deux griffes doivent rester
en prise pendant le passage du flanc au bouchon. Le corps continue au-delà de
l’extrémité sans téléportation et sa normale tourne continûment de la direction
radiale vers la direction axiale.

Maintenez ensuite uniquement la commande avant face à un mur rugueux. Le
caméléon doit monter, franchir le sommet et redescendre sur la face opposée sans
demander de saut ni de correction latérale. Les griffes passent progressivement
d’une normale à la suivante ; une normale opposée ou une sonde née à l’intérieur
du volume ne doit ni attirer le corps sous l’arête, ni inverser son repère.

### Verre lisse

Le mur bleu translucide est un contre-exemple volontaire. Il n’autorise pas les
griffes et offre peu de friction : le caméléon doit y glisser ou tomber. Ce
comportement distingue la préhension d’une adhésion de gecko.

### Gravité, saisie et récupération

Passez en **Physique libre**, saisissez le corps au clic gauche, secouez
l’animal puis relâchez-le. Le modèle entier doit suivre le même corps Rapier,
sans séparation des membres ni explosion d’articulations. Les pattes doivent
rester souples avec une tension légère, sans traverser le torse, la tête ou une
autre patte. Réactivez ensuite la locomotion stabilisée : les appuis et
l’orientation doivent revenir progressivement, sans téléportation.

Lancez aussi l’animal contre un mur rugueux, un tronc ou un cylindre. S’il entre
réellement en collision avec une surface autorisée, ses semelles doivent la
reprendre et le corps doit pivoter vers elle. Le verre lisse reste volontairement
impossible à agripper.

## Réglages

### Pilotage

- **Exploration autonome** laisse le caméléon choisir périodiquement une
  direction et changer de cap si aucune progression réelle n’est mesurée. Son
  cap suit les surfaces : il peut passer du mur au sommet puis redescendre de
  l’autre côté sans toujours chercher le haut du monde ;
- **Physique libre** suspend les appuis et la stabilisation ;
- **Vitesse** règle la vitesse monde visée ;
- **Animation** règle la fréquence visuelle du cycle des membres sans modifier
  directement la vitesse monde ;
- **Force motrice** règle la force disponible pour atteindre la vitesse visée.

### Stabilisation et démarche

- **Stabilité du corps** dose le rappel vers le cadre formé par les appuis ;
- **Amortissement** réduit les oscillations et dépassements ;
- **Tonus passif** règle la tension musculaire résiduelle pendant une saisie ou
  en **Physique libre**, sans rigidifier les pattes ;
- **Cadence** règle le rythme des pas diagonaux ;
- **Longueur du pas** détermine l’avancée de chaque cible ;
- **Hauteur du pas** règle le dégagement pendant le transfert : le pied monte
  rapidement, reste haut pendant l’enjambée puis se pose progressivement ;
- **Amplitude épaules / hanches** règle la part du pas produite par les
  articulations proximales ;
- **Levée des membres** et **Flexion coudes / genoux** règlent séparément le
  geste de franchissement ;
- **Mouvement du corps** dose les oscillations du bassin et du thorax ainsi que
  la compensation du cou et de la tête.

### Camouflage de surface

- **Peau adaptative** active ou coupe l’adaptation automatique au support tenu ;
- **Correspondance** règle la part exacte de pigment et de motif reprise. À
  100 %, seuls les détails protégés de l’œil conservent leur contraste naturel ;
- **Temps d’adaptation** règle la montée progressive du camouflage ;
- **Retour naturel** règle sa disparition après un saut, un lancer ou une perte
  de prise ;
- **Transition de support** règle le fondu entre deux matériaux à une arête ;
- **Détails des yeux** conserve plus ou moins la pupille et son reflet.

Le choix ne dépend que des pattes réellement en prise. Une griffe en transfert
ou proche d’une autre surface ne suffit pas à faire clignoter la peau. Le motif
est ancré dans le repère du support et ne suit ni la caméra, ni le brouillard.

### Suspension et saut

- **Suspension anatomique** dose l’assiette et l’amorti transmis au tronc ;
- **Hauteur de saut** règle le plafond balistique atteint à pleine charge ;
- **Contrôle aérien** règle l’autorité latérale sans modifier directement la
  vitesse verticale ;
- **Tolérance au bord** autorise encore brièvement le saut après la perte d’un
  rebord ;
- **Mémoire du saut** conserve une pression effectuée juste avant l’atterrissage ;
- **Gravité de chute** règle la vitesse de descente ;
- **Frein au relâchement** borne la coupure d’une montée interrompue.

### Queue passive

- **Souplesse** règle la conservation de la courbure et l’ampleur du balancement ;
- **Amortissement** dissipe l’énergie secondaire ;
- **Collision** agrandit ou réduit le rayon de contact des treize nœuds ;
- **Gravité queue** dose son poids sans modifier la gravité du corps.

Le collet de la queue suit rigidement le bassin sur le seul `tail_01`. La liberté
commence dès `tail_02`, tandis que les poids dynamiques apparaissent
progressivement sur 18 % de la distance géodésique : la jonction n’a donc pas de
charnière visible. Le garde de peau de la croupe reste protégé, puis les segments
dynamiques conservent leur longueur, répondent à l’inertie et sont projetés hors
du sol, des murs, des rochers et des troncs.
Une friction statique empêche une queue posée de tournoyer. La queue n’est pas
préhensile dans ce prototype. Quand elle est réellement au repos, elle passe en
sommeil : sa pose reste alors parfaitement fixe, sans tremblement subpixel,
jusqu’à un nouveau mouvement du corps ou une impulsion. Le repère de ses os
conserve la torsion de repos par transport parallèle à rotation minimale et
n’accumule pas de roulis longitudinal. Ce contrat porte sur le repère osseux ;
la silhouette finale de la peau reste à contrôler visuellement dans WebGPU.

### Appuis

- **Appuis pieds / griffes** active les quatre recherches de support ;
- **Force de maintien** borne l’effort transmis au corps ;
- **Rigidité d’appui** règle la rapidité du rappel ;
- **Amortissement d’appui** dissipe la vitesse aux griffes et évite le rebond ;
- **Portée capteurs** règle la distance maximale de recherche d’un support ;
- **Réflexe de redressement** dose la rotation automatique vers les pattes ;
- **Verrouillage de surface** règle la durée pendant laquelle un impact garde
  le même mur, rocher ou tronc comme propriétaire.

Après un saut ou un lancer, toucher une surface avec le dos ne colle jamais le
caméléon. Il choisit un seul impact réel, se retourne face ventrale vers lui,
puis engage au moins deux pattes. Dans un angle, il ne doit pas osciller entre
les surfaces voisines. Deux pattes sur un mur et deux autres sur un sol éloigné
ne forment jamais une prise valide : seules les griffes anatomiquement
atteignables et reliées par une même surface locale ou une vraie couture restent
verrouillées. Les faces opposées d’un même objet ne sont pas confondues.

### Affichage et coût

- **Proxies / contacts** révèle le corps Rapier unique et les quatre appuis ;
- **Squelette à travers la peau** affiche dans un seul tracé les hanches,
  épaules, coudes, genoux, paumes, doigts, cou, mâchoire et chaîne de queue ;
- **Chemin de surface au clic** affiche le corridor A* coloré et sa progression ;
- **Ombres** coupe ou active les ombres de la scène ;
- **Gravité** permet de comparer apesanteur, gravité terrestre et surcharge.

## Comprendre les indicateurs

- **Rendu** : images par seconde observées dans le laboratoire ;
- **Sous-pas p95** : 95 % des sous-pas physiques récents ont coûté au plus
  cette durée ;
- **Prises** : nombre d’appuis actifs parmi les quatre pieds ;
- **Mode** : joueur, autonome ou libre, complété pendant un saut par impulsion,
  montée, apogée, chute ou amorti ;
- **Altitude** : hauteur du corps physique ;
- **Intégrité** : `OK` tant qu’aucune pose non finie n’a été détectée ;
- **Camouflage** : profil du support élu et pourcentage de transition visuelle.

Le nombre d’appuis varie pendant la marche. Il peut être nul après `Espace`,
sur le verre, pendant une saisie, un lancer ou en mode **Physique libre**.

## Ce qui est normal

- un pied lâche, avance puis reprend un support pendant son pas ;
- la peau met un court instant à adopter un support, puis fond doucement vers
  le suivant à une arête ; elle revient au naturel lorsque les prises sont
  réellement perdues ;
- une fois le verrou statique acquis, le corps physique et les ancres des
  griffes restent exactement fixes tandis que l’idle du squelette anime très
  légèrement le bassin et le thorax ; ce mouvement peut redonner une faible vie
  secondaire à la queue ;
- sur une branche étroite, les appuis peuvent entourer le cylindre avec des
  normales divergentes ; chaque paire diagonale peut se remettre en place une
  fois, puis le corps se verrouille sans alterner indéfiniment les pas ;
- le corps amortit progressivement sa dérive ; une seule griffe peut préserver
  brièvement son orientation pendant qu’une autre franchit une arête ;
- l’animal glisse sur le verre ;
- tout le modèle suit le corps unique pendant un lancer ;
- la queue se déroule ou se replie passivement selon les contacts, traîne sur le
  sol et continue brièvement son mouvement lorsque le corps tourne ou s’arrête ;
- la caméra se rapproche lorsqu’un obstacle masque le caméléon ;
- `R` replace immédiatement le corps, car il s’agit d’une réinitialisation
  volontaire.

## Ce qui signale un défaut

- une patte s’entortille, dépasse durablement ses angles anatomiques ou traverse
  le tronc, la tête ou un autre membre ;
- `Q`/`A` ou `D` fait glisser le corps latéralement au lieu de le tourner ;
- le corps change instantanément de position sans `R` ;
- une destination sur le verre est acceptée ou un trajet coupe un vide entre
  deux surfaces non connectées ;
- maintenir avant au sommet d’un mur colle le corps sous la lèvre, inverse sa
  normale ou oblige à manœuvrer pour atteindre la face opposée ;
- le caméléon continue à osciller ou à relancer des pas après son arrêt sur une
  branche cylindrique rugueuse ;
- au bout d’une branche, les griffes quittent toutes le support, la normale
  saute brutalement ou le corps se téléporte au lieu de prendre le bouchon ;
- un pied reste pris dans le vide ou sur le verre ;
- le corps traverse durablement le sol, un mur, un rocher ou un tronc ;
- la queue est remplacée par une forme tubulaire, s’allonge, se détache du
  bassin, creuse la croupe, traverse durablement un obstacle ou oscille sans
  perdre d’énergie ;
- **Intégrité** affiche un nombre au lieu de `OK` ;
- le camouflage change avec la caméra, affiche le ciel ou le brouillard, devient
  transparent, ou oscille rapidement entre deux profils alors que les prises
  restent stables ;
- la route normale de la colonie charge le laboratoire ou son moteur Rapier.

Le laboratoire valide la mécanique et le matériau adaptatif du prototype.
L’exploration écologique, la peur des papillons et la prédation restent décrites
dans le [guide du caméléon principal](./cameleons.md).
