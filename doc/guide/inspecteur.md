---
title: Inspecteur des animaux
order: 60
summary: Lire l’intention, le mouvement, le support et la perception d’une fourmi, d’un papillon ou du caméléon.
contracts: OBS, BUTTERFLY-SIM, CHAMELEON-SIM
---

# Inspecteur des animaux

Cliquez sur une fourmi, un papillon visible ou le caméléon pour suivre **un
individu précis**. Le panneau traduit son état interne ; il n’influence jamais
ses décisions. Une seule fiche est active à la fois. `Échap` ou un clic dans
le décor vide la sélection.

La recherche n’est exécutée qu’au clic : le caméléon utilise son maillage
unique et les papillons un test analytique sur leurs 64 slots fixes. La boucle
normale ne raycaste donc pas toute la population. Le texte du panneau est
rafraîchi à 5 Hz, assez vite pour expliquer l’action sans reconstruire le DOM
à chaque image.

## Fourmi sélectionnée

- **Caste et état réel** : la caste, puis un contexte lisible — pause globale,
  activation, repos, cycle royal, transport, navigation souterraine,
  exploration ou état terminal.
- **Intention** : l’action actuelle, par exemple chercher, rapporter,
  ravitailler, attaquer, récupérer ou suivre le cycle de ponte.
- **Objectif** : nourriture, entrée, grenier, mangeoire royale, couvain ou
  sortie.
- **Mouvement réel** : vitesse mesurée et durée passée presque au même endroit.
- **Route souterraine** : nœud sûr, corridor actif et progression dans ce
  corridor.
- **Distance de route** : distance cumulée déjà convertie en unités monde `u`,
  et non en cellules de grille.
- **Explication** : la cause concrète de l’action ou de l’attente.

### Comprendre « État réel »

- **Simulation en pause** : le jeu est suspendu ; aucune fourmi n’est alors
  considérée comme bloquée et ce temps n’allonge pas son immobilité.
- **Activation initiale** : elle attend encore sa reprise échelonnée au
  lancement.
- **Repos** : elle effectue une pause biologique prévue.
- **Cycle royal** : la reine attend, mange, récupère ou prépare une ponte ;
  l’intention donne l’étape exacte.
- **Transport** : elle porte une ressource, même si elle se trouve déjà sous
  terre.
- **Navigation souterraine** : elle circule sans charge dans une chambre ou un
  corridor.
- **Exploration** : elle agit à la surface sans charge ; chercher, rentrer ou
  combattre reste précisé par l’intention.
- **Cadavre** ou **Dévorée** : état terminal, aucun redémarrage n’est attendu.

L’état réel donne le contexte ; l’**intention** explique l’action précise. Par
exemple, deux fourmis en « Navigation souterraine » peuvent viser
respectivement le grenier et le couvain.

La case **Pause** et une vitesse réglée à `×0` suspendent toutes deux le
diagnostic. Ce temps ne transforme jamais un arrêt volontaire de l’utilisateur
en immobilité suspecte.

### Interpréter un arrêt

Un arrêt affiché comme **normal** a une cause connue : pause globale,
activation initiale, repos programmé, attente d’un stock, mort ou dévoration.
Le temps passé en pause globale est retiré du chronomètre d’immobilité. Hors
pause globale, la fourmi doit reprendre lorsque sa condition disparaît, sauf
état terminal.

Un arrêt bref sans explication peut être un changement de direction ou de
zone. Si une fourmi vivante et active reste immobile au-delà de la tolérance
sans cause reconnue, le panneau indique **« à vérifier »**. Cela signale une
anomalie possible, pas une preuve automatique : regardez aussi son objectif,
son corridor et l’état du grenier.

Changer de fourmi remet le chronomètre d’immobilité à zéro afin de ne jamais
mélanger deux individus.

## Papillon sélectionné

La fiche indique son index logique, son stade, son intention courante — repos,
vol, visite d’une fleur ou fuite — et son support visible. Lorsqu’il fuit, elle
affiche la menace caméléon, sa distance et la mémoire de peur restante. Elle
précise également la distance et l’angle de vision configurés et si le
prédateur est actuellement camouflé, donc imperceptible.

Activez **Graphismes → 🦋 Papillons → Perception du caméléon → Zone du
sélectionné** pour voir uniquement le volume de perception de ce papillon. Un
champ supérieur à 180° est représenté par la portée panoramique et sa zone
aveugle arrière ; le debug ne crée jamais un volume pour chacun des 64 slots.

## Caméléon sélectionné

La fiche distingue son état de chasse et son état de locomotion : exploration,
perchoir, camouflage ou attaque. Elle affiche la cible suivie ou le papillon
capturé, les distances de détection et d’attaque, la classe de surface courante
— terrain, rocher ou souche, tronc ou branche, arbre vertical ou transition —,
le support nommé, le corridor local et sa progression. Pendant une pause
planifiée, le temps de camouflage restant est également visible.

Activez **Graphismes → 🦎 Caméléon → Zone attaque (sélection)** pour afficher
une sphère centrée sur la bouche et limitée à la portée réelle de la langue.
Cette géométrie n’existe qu’en un exemplaire et reste cachée lorsque le
caméléon n’est pas sélectionné ou que la caméra passe sous terre.

## Méthode de diagnostic rapide

1. Vérifiez l’**état** puis l’**intention** de l’animal.
2. Pour une fourmi, lisez l’objectif, la raison de l’arrêt et la progression du
   corridor.
3. Pour un papillon, comparez menace, camouflage, distance et angle de vision.
4. Pour le caméléon, comparez surface, support, corridor, progression, cible et portée d’attaque.
5. Activez seulement la zone de debug de l’individu suivi pour confirmer la
   géométrie sans alourdir la scène.
