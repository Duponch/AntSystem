---
title: Laboratoire du caméléon physique
order: 62
summary: Piloter, saisir et éprouver un caméléon articulé sur des sols, murs, rochers et troncs.
contracts: CHAMELEON-SIM
---

# Laboratoire du caméléon physique

Le laboratoire est une scène séparée du jeu principal. Il permet de piloter un
caméléon dont le corps, les membres et la queue sont simulés physiquement, puis
de vérifier comment il réagit aux surfaces, à la gravité et aux manipulations.
Il ne fait pas avancer la colonie.

## Ouvrir le laboratoire

Démarrez le serveur puis ouvrez :

```text
http://localhost:5173/?test
```

`?test=chameleon` ouvre la même scène. Le bouton **Retour à la colonie** recharge
le jeu normal. Un navigateur compatible WebGPU est requis.

## Commandes

- `ZQSD`, `WASD` ou les flèches : se déplacer par rapport à la caméra ;
- `Shift` : accélérer ;
- `Espace` : libérer brièvement les prises et sauter ;
- clic droit maintenu : tourner la caméra ;
- molette : rapprocher ou éloigner la caméra ;
- clic gauche maintenu sur le caméléon : saisir un membre et le secouer ;
- relâcher le clic gauche : lancer le membre avec l’élan du pointeur ;
- `C` : activer ou suspendre l’exploration autonome ;
- `F` : basculer entre corps actif et ragdoll passif ;
- `H` : afficher ou masquer les proxies physiques et les contacts ;
- `R` : remettre l’animal dans sa pose de départ.

Le déplacement suit le support courant. Sur un mur ou un plan incliné, avancer
ne signifie donc pas revenir horizontalement vers le sol.

## Exercices de validation

### Contact entre deux surfaces

Placez le caméléon près d’un angle entre le sol et un mur rugueux. Avancez
obliquement. Plusieurs pieds peuvent prendre des supports dont les normales
sont différentes ; le corps doit s’adapter sans saut de position.

### Troncs et rochers

Essayez les perchoirs horizontal, diagonal et vertical, puis le plan rocheux
incliné. Les pieds alternent entre phase d’appui et phase de transfert. Une
prise posée reste fixe dans le monde jusqu’à son prochain pas ou jusqu’à ce
qu’elle soit trop sollicitée.

### Verre lisse

Le mur bleu translucide est un contre-exemple volontaire. Il n’autorise pas les
griffes et offre peu de friction : le caméléon doit y glisser ou tomber. Ce
comportement est normal et distingue la préhension d’une adhésion de gecko.

### Gravité et récupération

Passez en **Ragdoll passif**, saisissez un membre au clic gauche, secouez
l’animal puis relâchez-le. Son corps entier doit réagir à la gravité et aux
articulations. Les butées PD souples continuent uniquement de limiter les angles
extrêmes ; elles ne recherchent pas la pose de repos. Réactivez ensuite le corps
actif : les muscles doivent chercher progressivement la pose, sans
téléportation.

## Réglages

### Pilotage

- **Exploration autonome** laisse le caméléon choisir périodiquement une
  direction, favorise la montée sur les surfaces verticales et change de cap
  si aucune progression réelle n’est mesurée pendant 1,75 seconde ;
- **Ragdoll passif** coupe les moteurs qui recherchent la pose et les prises ;
  les butées articulaires PD souples restent actives pour limiter les angles ;
- **Vitesse** règle la vitesse monde visée ;
- **Animation** règle la fréquence visuelle du cycle des membres sans changer
  directement la vitesse monde ;
- **Force motrice** règle la force disponible pour atteindre la vitesse visée.

### Corps actif

- **Tonus musculaire** dose la force de retour vers la pose ;
- **Amortissement** réduit les oscillations ;
- **Cadence** règle le rythme des pas diagonaux.

### Préhension

- **Prises pieds / griffes** active les quatre ancres de pieds ;
- **Queue préhensile** autorise l’extrémité de la queue à prendre une branche ;
- **Force de prise** borne l’effort d’une ancre ;
- **Rigidité prise** règle la rapidité avec laquelle un pied rejoint son
  contact ;
- **Portée capteurs** règle la distance maximale de recherche d’un support.

Des valeurs extrêmes sont utiles pour provoquer une limite, mais elles ne sont
pas toutes des réglages biologiquement plausibles.

### Affichage et coût

- **Proxies / contacts** révèle le corps résolu par Rapier ;
- **Ombres** coupe ou active les ombres de la scène ;
- **Gravité** permet de comparer apesanteur, gravité terrestre et surcharge.

## Comprendre les indicateurs

- **Rendu** : images par seconde observées dans le laboratoire ;
- **Sous-pas p95** : 95 % des sous-pas complets récents (capteurs, muscles, validation et Rapier) ont coûté au plus cette durée ;
- **Prises** : nombre de contacts actifs parmi quatre pieds et la queue ;
- **Mode** : joueur, autonome ou passif ;
- **Altitude** : hauteur du bassin ;
- **Intégrité** : `OK` tant qu’aucune pose non finie n’a été détectée.

Le nombre de prises varie pendant une marche. Il peut être nul après `Espace`,
sur le verre, pendant un lancer ou en ragdoll passif.

## Ce qui est normal

- un pied lâche, avance puis reprend le support pendant son pas ;
- au repos, le corps amortit progressivement sa dérive tout en continuant à
  résoudre ses contacts physiques ;
- l’animal glisse sur le verre ;
- un lancer déforme temporairement la posture ;
- la queue ne prend que les branches ;
- la caméra se rapproche lorsqu’un obstacle masque le caméléon ;
- `R` replace immédiatement tout le corps, car il s’agit d’une
  réinitialisation volontaire.

## Ce qui signale un défaut

- un membre ou le bassin change instantanément de position sans `R` ;
- un pied reste pris dans le vide ou sur le verre ;
- le corps traverse durablement le sol, un mur, un rocher ou un tronc ;
- **Intégrité** affiche un nombre au lieu de `OK` ;
- le caméléon reste définitivement inerte en mode joueur avec un tonus et une
  gravité normaux ;
- la route normale de la colonie charge le laboratoire ou son moteur Rapier.

Le laboratoire valide la mécanique du prototype. Le camouflage, l’exploration
écologique, la peur des papillons et la prédation restent décrits dans le
[guide du caméléon principal](./cameleons.md).
