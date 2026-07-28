---
title: Caméléon et prédation
order: 61
summary: Comprendre son exploration globale des surfaces, son camouflage, la peur des papillons et chaque phase d’une attaque.
contracts: CHAMELEON-SIM
---

# Caméléon et prédation

Le caméléon peut parcourir progressivement toute la surface reconnue de la
carte : terrain, rochers et souches, troncs couchés, branches et arbres
verticaux. Il passe d’un support à l’autre par des raccords continus et épouse
leur relief sans saut de position.

Il ne suit ni une ronde pré-écrite ni une destination lointaine. À la fin de
chaque court trajet, il choisit localement où continuer. Cette exploration
réactive donne un déplacement varié tout en gardant un coût prévisible.

## Comment il explore la carte

Le décor est transformé à l’avance en un graphe global de surfaces :

- le terrain praticable contourne les empreintes des obstacles ;
- les troncs et branches suivent leur relief supérieur ;
- les rochers et souches disposent de passages sur leur contour ;
- les arbres verticaux peuvent être montés ou descendus ;
- des transitions courbes relient chaque objet à une zone de terrain libre.

Le premier tronc hôte détermine seulement le point de départ et le centre du
**Rayon d’exploration**. La valeur par défaut couvre les coins de la carte. Ce
rayon peut être réduit depuis l’UI sans reconstruire le décor.

À l’arrivée au bout de son corridor courant, le caméléon compare seulement les
quelques continuations voisines. Il conserve de l’inertie, préfère légèrement
les zones peu visitées et manifeste une curiosité pour les nouveaux supports.
À situation identique, le choix reste déterministe. Il découvre ainsi le monde
par petites décisions successives, sans calculer un A* à chaque déplacement.

Désactiver **Explorer la carte** suspend cette locomotion spontanée : l’animal
reste sur son support courant au lieu de recommencer une ronde locale. Sa
machine de chasse et ses autres réglages restent distincts.

## Comment il épouse le décor

Seul le court corridor en cours est lu pendant le jeu. Sa position, sa tangente
et sa normale sont interpolées à chaque pas. Sa fin est exactement le début du
corridor suivant : descendre d’un tronc, traverser le sol, gravir un rocher ou
monter dans un arbre ne doit donc jamais produire de téléportation.

Le corps combine un point avant et un point arrière pour anticiper une pente ou
un changement de courbure. Quatre contacts approximatifs, deux à l’avant et
deux à l’arrière, stabilisent la pose. Il ne s’agit pas d’un IK complet pour
chaque patte ; ce compromis conserve une adhérence visuelle cohérente sans
raycast ni solveur coûteux à chaque image.

## Ce qu’il fait quand il semble immobile

Un arrêt n’est pas forcément un blocage :

- `REST_SCAN` : il observe avant de repartir ;
- `TRACK_PREY` : il suit un papillon et cherche un point d’approche ;
- `AIM_AND_BRACE` : il fixe la proie, stabilise son corps et prépare la langue ;
- `COOLDOWN` : il récupère après une attaque ;
- **camouflage** : il interrompt volontairement son déplacement pendant une
  durée comprise entre les bornes configurées.

Lorsque **Camouflage automatique** est actif, les pauses sont planifiées de
façon déterministe. Un caméléon immobile et hors d’une phase révélatrice de
l’attaque devient alors imperceptible pour les papillons.

Le joueur voit une **couleur de signal**, rouge par défaut et configurable dans
**Signal camouflage**. Cette teinte sert uniquement à rendre l’état lisible :
la vision des papillons ne lit ni la couleur ni le matériau, seulement le
booléen logique de camouflage. La couleur d’origine est restaurée à la reprise.

## Pourquoi les papillons le fuient parfois

Chaque papillon adulte possède une distance et un angle de perception. À la
cadence configurée — 10 analyses par seconde par défaut — il vérifie si un
caméléon détectable se trouve dans ce volume. S’il le voit, il abandonne son
activité et infléchit continûment son vol à l’opposé d’une courte prédiction du
prédateur.

Un caméléon immobile et camouflé est traité comme absent. Un papillon peut donc
s’en approcher sans l’éviter ; lorsque le prédateur se révèle, il redevient
détectable. La fuite ne téléporte jamais le papillon et reste bornée par sa
vitesse configurée.

## Déroulement d’une attaque

1. Le caméléon ne considère que les papillons adultes, visibles et libres.
2. Il approche continûment la proie sur son corridor de surface.
3. Si elle entre dans la **Distance d’attaque**, il la suit encore pendant la
   visée.
4. Au départ de la langue, le point visé est figé : la trajectoire n’est pas
   corrigée artificiellement en plein vol.
5. La capture exige un contact réel entre la langue et le papillon.
6. En cas de contact, le papillon reste collé au bout de la langue pendant une
   rétraction continue.
7. Le papillon ne disparaît que lorsqu’il entre effectivement dans la bouche.

Une langue qui rate sa cible revient donc normalement, sans téléporter ni
supprimer le papillon.

## Sélection et zones de debug

Cliquez sur le caméléon ou sur un papillon pour ouvrir sa fiche. La sélection
du caméléon montre son intention, sa classe de surface, son support, son
corridor local, sa progression, sa cible et son état de camouflage. La
sélection d’un papillon montre son activité, la menace perçue et les paramètres
de sa vision.

- **Zone attaque (sélection)** affiche la portée depuis la bouche du seul
  caméléon sélectionné ;
- **Zone du sélectionné** affiche la distance et l’angle de vision du seul
  papillon sélectionné.

Ces options n’ajoutent pas de volumes de debug à toute la faune. Appuyez sur
`Échap` ou cliquez ailleurs pour quitter la sélection.

## Réglages

Ouvrez **Graphismes → 🦎 Caméléon** :

- **Activer le caméléon** charge et anime l’animal ;
- **Taille** règle son échelle visuelle ;
- **Vitesse de mouvement** règle l’exploration, avec `1,15` par défaut ;
- **Vitesse de poursuite** règle l’approche d’une proie, avec `1,45` par défaut ;
- **Vitesse animation marche** accélère ou ralentit seulement le cycle visuel
  des pas. Elle ne modifie ni la vitesse monde ni le timing de l’attaque ;
- **Réactivité orientation** règle la vitesse de rotation du corps ;
- **Explorer la carte** active ou suspend l’exploration spontanée ;
- **Rayon d’exploration** borne les choix locaux autour de l’hôte ;
- **Camouflage automatique** active ou coupe les pauses perceptives ;
- **Signal camouflage** choisit la couleur visible par le joueur ;
- **Intervalle camouflage**, **Camouflage min** et **Camouflage max** règlent
  les pauses volontaires — 14 s d’intervalle et 7 à 13 s par défaut ;
- **Dégagement support** affine la petite distance au-dessus des surfaces ;
- **Distance de détection** définit quand il commence à suivre une proie ;
- **Distance d’attaque** définit la portée maximale depuis la bouche ;
- **Préparation attaque**, **Rétraction langue** et **Repos après attaque**
  règlent les phases temporelles de la chasse ;
- **Projeter les ombres** et **Recevoir les ombres** sont indépendants.

Sous **Graphismes → 🦋 Papillons → Perception du caméléon**, vous pouvez régler
la **Distance de vue**, l’**Angle de vue**, l’**Accélération de fuite** et la
fréquence **Analyse menace (Hz)**.

## Pourquoi le mouvement reste léger

Le graphe global immuable est plafonné à **8 192 nœuds** et n’est rebâti
qu’après une révision du décor ou d’un réglage géométrique. Le caméléon ne lit
qu’un corridor actif d’au plus **384 échantillons** et ne compare que ses
voisins lorsqu’il doit continuer. Il n’y a ni géométrie, ni raycast, ni A* dans
la boucle normale de locomotion.

La perception reste bornée à 64 papillons, la langue suit une trajectoire
analytique et un seul squelette glTF est animé. Le coût ne dépend jamais du
nombre de fourmis.

Quand la caméra descend sous terre, le caméléon, les papillons et leurs volumes
de debug sont masqués avec les autres animaux extérieurs.