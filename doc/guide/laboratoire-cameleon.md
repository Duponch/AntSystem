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
douze os suivent sa courbure source. Les trois premiers forment un pont rigide
au-dessus de la croupe ; la simulation passive commence sur le quatrième et
laisse le reste traîner, se balancer et se poser sur le décor sans tirer le bas
du dos. Le laboratoire ne fait pas avancer la colonie.

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

- `ZQSD`, `WASD` ou les flèches : se déplacer par rapport à la caméra ;
- `Shift` : accélérer ;
- `Espace` : sauter ; maintenir donne un saut haut, relâcher tôt un saut court ;
- clic droit maintenu : tourner la caméra ;
- molette : rapprocher ou éloigner la caméra ;
- clic gauche maintenu sur le caméléon : saisir son corps et le secouer ;
- relâcher le clic gauche : lancer le corps avec l’élan du pointeur ;
- `C` : activer ou suspendre l’exploration autonome ;
- `F` : basculer entre locomotion stabilisée et **Physique libre** ;
- `H` : afficher ou masquer le corps physique et les quatre appuis ;
- `R` : remettre l’animal dans sa pose de départ.

Le déplacement suit le support courant. Sur un mur ou un plan incliné, avancer
ne signifie donc pas revenir horizontalement vers le sol. Le cap est transporté
continûment le long des courbes : une branche cylindrique ou un raccord sol/mur
ne peut plus transformer « avancer » en dérive latérale. Même si les appuis
découvrent le mur pendant le sous-pas courant, la commande déjà émise est
transportée vers ce nouveau support au lieu d’être rabattue de côté.

Le saut suit lui aussi le support : depuis un mur ou un cylindre, il sépare
d’abord le corps de la surface puis le projette vers le haut. Les anciennes
prises sont oubliées au décollage. Une surface réellement touchée pendant la
chute peut ensuite être reprise sans téléportation.

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
le runtime ne tire plus uniquement les orteils vers la surface. Le cou et la
tête conservent de petits mouvements de regard au repos, sans provoquer de pas
ni de vibration des appuis. Quand le bassin ou le thorax oscillent, le repère de
marche reste celui du corps entier et non l’axe local incliné d’un os de colonne.

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

### Contact entre deux surfaces

Placez le caméléon près d’un angle entre le sol et un mur rugueux, puis avancez
obliquement. Les pieds peuvent viser des surfaces différentes ; le corps doit
changer progressivement d’orientation, sans vrille ni saut de position.

### Troncs et rochers

Essayez les perchoirs horizontal, diagonal et vertical, puis le plan rocheux
incliné. Les pieds alternent entre phase d’appui et phase de transfert. Les
cibles restent bornées autour du corps et les articulations restent proches de
leur pose anatomique, même lorsqu’un support disparaît.

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
  direction et changer de cap si aucune progression réelle n’est mesurée ;
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
- **Hauteur du pas** règle le dégagement pendant le transfert ;
- **Amplitude épaules / hanches** règle la part du pas produite par les
  articulations proximales ;
- **Levée des membres** et **Flexion coudes / genoux** règlent séparément le
  geste de franchissement ;
- **Mouvement du corps** dose les oscillations du bassin et du thorax ainsi que
  la compensation du cou et de la tête.

### Suspension et saut

- **Suspension anatomique** dose l’assiette et l’amorti transmis au tronc ;
- **Hauteur de saut** règle la hauteur balistique visée ;
- **Contrôle aérien** règle l’autorité latérale sans modifier directement la
  vitesse verticale ;
- **Tolérance au bord** autorise encore brièvement le saut après la perte d’un
  rebord ;
- **Mémoire du saut** conserve une pression effectuée juste avant l’atterrissage ;
- **Gravité de chute** règle la vitesse de descente ;
- **Frein au relâchement** détermine à quel point un relâchement précoce réduit
  la hauteur.

### Queue passive

- **Souplesse** règle la conservation de la courbure et l’ampleur du balancement ;
- **Amortissement** dissipe l’énergie secondaire ;
- **Collision** agrandit ou réduit le rayon de contact des treize nœuds ;
- **Gravité queue** dose son poids sans modifier la gravité du corps.

Le collet de la queue suit rigidement le bassin jusqu’après la croupe :
`tail_01`, `tail_02` et `tail_03` restent solidaires du bas du dos, puis la
partie passive commence sur `tail_04`. Les neuf segments dynamiques conservent
leur longueur, répondent à l’inertie et sont projetés hors du sol, des murs, des
rochers et des troncs. Ce raccord empêche une forte courbure de la queue de
creuser ou couper la silhouette des fesses. La queue n’est pas préhensile dans
ce prototype. Quand elle est réellement au repos, elle passe en sommeil : sa
pose reste alors parfaitement fixe, sans tremblement subpixel, jusqu’à un
nouveau mouvement du corps ou une impulsion.

### Appuis

- **Appuis pieds / griffes** active les quatre recherches de support ;
- **Force de maintien** borne l’effort transmis au corps ;
- **Rigidité d’appui** règle la rapidité du rappel ;
- **Portée capteurs** règle la distance maximale de recherche d’un support.

### Affichage et coût

- **Proxies / contacts** révèle le corps Rapier unique et les quatre appuis ;
- **Squelette à travers la peau** affiche dans un seul tracé les hanches,
  épaules, coudes, genoux, paumes, doigts, cou, mâchoire et chaîne de queue ;
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
- **Intégrité** : `OK` tant qu’aucune pose non finie n’a été détectée.

Le nombre d’appuis varie pendant la marche. Il peut être nul après `Espace`,
sur le verre, pendant une saisie, un lancer ou en mode **Physique libre**.

## Ce qui est normal

- un pied lâche, avance puis reprend un support pendant son pas ;
- le corps amortit progressivement sa dérive lorsque deux appuis ou plus sont
  disponibles ;
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
- le corps change instantanément de position sans `R` ;
- un pied reste pris dans le vide ou sur le verre ;
- le corps traverse durablement le sol, un mur, un rocher ou un tronc ;
- la queue est remplacée par une forme tubulaire, s’allonge, se détache du
  bassin, creuse la croupe, traverse durablement un obstacle ou oscille sans
  perdre d’énergie ;
- **Intégrité** affiche un nombre au lieu de `OK` ;
- la route normale de la colonie charge le laboratoire ou son moteur Rapier.

Le laboratoire valide la mécanique du prototype. Le camouflage, l’exploration
écologique, la peur des papillons et la prédation restent décrits dans le
[guide du caméléon principal](./cameleons.md).
