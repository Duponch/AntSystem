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
- les triangles réels de toutes les instances appartenant aux 15 classes de
  modèles marchables servent de support ;
- seule la partie réellement reliée au point d'accès de chaque support est
  retenue : un îlot de triangles déconnecté ne devient jamais un raccourci ;
- chaque surface accessible est découpée en petits patches déterministes, puis
  reliée uniquement par ses vrais bords partagés ;
- translation, orientation horizontale et taille scalaire propres à chaque
  tronc, branche, rocher, souche ou arbre sont conservées ;
- un portail physique, choisi au contact bas et périphérique du support, relie
  séparément celui-ci au terrain ;
- les courts corridors suivent ces triangles et portails avant d’être utilisés.

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

Seul le court corridor en cours est lu pendant le jeu. Il a déjà été projeté
sur les triangles exacts du décor. Sa fin est exactement le début du corridor
suivant : descendre d’un tronc, traverser le sol, gravir un rocher ou monter
dans un arbre ne doit donc jamais produire de téléportation. Le trajet longe les
bords réellement partagés entre triangles ; il ne coupe pas à travers un tronc,
un rocher ou un pli du maillage.

Si un trajet développé dépasse la limite de 384 points, aucun angle ou portail
obligatoire n'est supprimé. Le caméléon s'arrête au dernier nœud de graphe dont
le corridor complet tient dans le budget, puis poursuit lors de la décision
suivante. Une géométrie invalide est rejetée au lieu de produire un saut. Si une
édition du décor rend tout le nouveau graphe invalide, le jeu conserve l’ancien
graphe et l’ancienne route ; il ne retente le bake qu’après un nouveau changement,
sans bloquer la simulation entre-temps.

Les quatre pattes possèdent chacune un vrai point d’appui sur la surface,
recalculé à fréquence fixe — 60 Hz par défaut. Pendant l’appui, le pied reste
fixé dans le monde au lieu de glisser avec le corps. Le caméléon avance par
diagonales alternées ; la patte levée suit une courbe douce avant de se reposer
sur son prochain contact.

Le contact correspond bien à la **semelle visible**, pas au pivot de l’os. Au
chargement, le jeu mesure une fois l’épaisseur de chaque pied depuis les
sommets réellement attachés à son os dans le GLB. L’IK place ensuite cette
semelle sur la surface, même si les quatre pieds du modèle n’ont pas la même
épaisseur.

Le centre du caméléon reste sur son corridor exact. Son inclinaison vient de
deux supports pris devant et derrière le corps ; le plan moyen des quatre pieds
sert uniquement à la marche et n’ajoute pas une seconde hauteur.

Après l’animation de marche, un IK analytique ajuste les deux os de chaque
patte et oriente le pied selon la normale locale pour la pose affichée. Son
influence diminue pendant une attaque afin que la pose expressive de la langue
et du corps reste intacte. Les projections restent cadencées séparément du
rendu et n’utilisent aucun raycast. Le découpage en patches, la recherche des
portails et la validation des corridors sont effectués lors du bake : ils
n'ajoutent pas de parcours de maillage à chaque image.

Le corps et la queue possèdent aussi des points de contrôle qui empêchent leur
pénétration dans le support. Entre deux lectures de géométrie, les plans déjà en
cache sont résolus à nouveau contre la pose animée, sans requête supplémentaire.
Si le corps doit être décalé à ce stade, les quatre pattes sont aussitôt recalées
sur leurs appuis : leurs semelles ne glissent pas et ne traversent pas le support.
La queue répartit une correction sur plusieurs articulations sans déplacer ses
contacts précédents. Si cela ne suffit pas, sa dernière pose locale sûre est
Si une pose animée dépasse exceptionnellement les contraintes, seule l’image du
caméléon revient à sa dernière pose visuelle sûre ; sa position logique, son trajet
et son cycle de vie ne sont jamais rembobinés. Tant qu’aucune pose sûre n’existe
après un chargement, le modèle est brièvement masqué plutôt que montré dans le sol.
Le corridor et sa continuité sont validés puis publiés dans le même pas de
simulation : le rendu ne bloque donc jamais son temps logique, même sous terre ou
à vitesse élevée, et ne peut pas changer ses décisions écologiques.

## Ce qu’il fait quand il semble immobile

Un arrêt n’est pas forcément un blocage :

- `REST_SCAN` : il observe avant de repartir ;
- `TRACK_PREY` : il suit un papillon et cherche un point d’approche ;
- `AIM_AND_BRACE` : il fixe la proie, stabilise son corps et prépare la langue ;
- `COOLDOWN` : il récupère après une attaque ;
- **camouflage** : il interrompt volontairement son déplacement pendant une
  durée comprise entre les bornes configurées.

Pendant `REST_SCAN`, l’immobilité du trajet ne signifie pas que l’animal est
figé : respiration discrète, cou et tête choisissent des points d’observation,
les maintiennent puis font de petites corrections. En marche, ce regard autonome
reste présent avec une amplitude réduite.

Lorsque **Camouflage automatique** est actif, les pauses sont planifiées de
façon déterministe. Un caméléon immobile et hors d’une phase révélatrice de
l’attaque devient alors imperceptible pour les papillons.

Pour le joueur, le camouflage est **perceptif**, jamais une transparence
parfaite. La peau prélève les grandes couleurs et valeurs du décor proche,
puis les applique comme des pigments tout en conservant les normales, la
rugosité, les reflets et une part minimale de sa couleur naturelle. Des motifs
stables brisent les aplats, les angles rasants révèlent davantage le contour et
une ombre de contact subsiste. Le caméléon se fond donc dans son support, mais
reste discernable lorsqu’on sait où regarder.

Cette apparence ne décide jamais de la perception. La vision des papillons ne
lit ni une couleur ni un pixel : elle utilise seulement le booléen logique de
camouflage. À la reprise, le rendu naturel revient progressivement.

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
   visée. Le cou et la tête s’orientent réellement vers elle ;
4. Au départ de la langue, le point visé est figé : la trajectoire n’est pas
   corrigée artificiellement en plein vol.
5. La capture exige un contact réel entre la langue et le papillon.
6. En cas de contact, le papillon reste collé au bout de la langue pendant une
   rétraction continue.
7. Le papillon ne disparaît que lorsqu’il entre effectivement dans la bouche.

La bouche et la langue héritent de l’orientation finale du crâne. La langue ne
part donc plus vers une cible latérale tandis que la tête regarde encore droit
devant.

Une langue qui rate sa cible revient donc normalement, sans téléporter ni
supprimer le papillon.

## Sélection et zones de debug

Cliquez sur le caméléon ou sur un papillon pour ouvrir sa fiche. La sélection
du caméléon montre son intention, sa classe de surface, son support, son
corridor local, sa progression, sa cible, son camouflage et ses contacts
physiques. La sélection d’un papillon montre son activité et la menace perçue
ainsi que les paramètres
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
- **Collisions exactes** active les contacts issus des triangles réels ;
- **Pattes procédurales** active l’ajustement des quatre chaînes de pattes ;
- **Solveur de contact (Hz)** cadence la projection des pieds et le pas fixe de
  la marche ; l’IK visuel reste appliqué à chaque image ;
- **Hauteur des pas** règle la levée des pattes pendant leur transfert ;
- **Influence IK** dose la correction physique appliquée après l’animation ;
- **Explorer la carte** active ou suspend l’exploration spontanée ;
- **Rayon d’exploration** borne les choix locaux autour de l’hôte ;
- **Camouflage automatique** active ou coupe les pauses perceptives ;
- **Intervalle camouflage**, **Camouflage min** et **Camouflage max** règlent
  les pauses volontaires — 14 s d’intervalle et 7 à 13 s par défaut ;
- **Adaptation au décor** règle la proximité entre les pigments et les couleurs
  voisines, sans jamais autoriser une copie exacte ;
- **Lisibilité des contours** révèle davantage la silhouette aux angles rasants ;
- **Motifs cutanés** et **Échelle des motifs** règlent la force et la taille des
  taches stables sur la peau ;
- **Diffusion des couleurs** décale légèrement l’échantillon du décor afin
  d’éviter l’effet d’écran transparent ;
- **Ombre résiduelle** conserve une ombre de contact pendant le camouflage ;
- **Temps d’adaptation** et **Retour naturel** règlent les transitions visuelles ;
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

Les triangles, leurs voisinages et leur BVH sont préparés une seule fois pour
toutes les instances des 15 classes marchables. Le graphe global immuable est
plafonné à **8 192 nœuds** et n’est rebâti qu’après une révision du décor ou
d’un réglage géométrique. Le caméléon ne lit qu’un corridor actif d’au plus
**384 échantillons** et ne compare que ses voisins lorsqu’il doit continuer.

Chaque projection teste d’abord le triangle précédent et son anneau voisin,
puis laisse le BVH exact vérifier le meilleur contact global. Ce raccourci
réduit le parcours sans changer le résultat. Les quatre pieds réutilisent des
buffers fixes à la cadence configurée. La marche diagonale et l’IK à deux os
sont analytiques : aucun moteur physique généraliste, aucune allocation chaude
et aucun raycast par image ne sont ajoutés.

La pose du corps, les corrections de queue et le remplacement d’un corridor
réutilisent eux aussi des buffers fixes. Le graphe, le collider, le routeur et
le corridor précédents restent disponibles jusqu’à validation exacte du nouveau
corridor dans le pas logique. Les corrections du squelette restent purement
visuelles et ne peuvent ni arrêter ni rembobiner cette progression.

La perception reste bornée à 64 papillons, la langue suit une trajectoire
analytique et un seul squelette glTF est animé. Le coût ne dépend jamais du
nombre de fourmis.

Les variantes naturelle et perceptive sont créées puis préchauffées une seule
fois. Hors transition et hors camouflage, la variante naturelle ne copie aucun
framebuffer. Quand l’effet est actif, toute la silhouette partage une seule
copie du viewport. Les motifs reposent sur deux ondes peu coûteuses en espace
objet ; aucun draw, dispatch compute ou rendu supplémentaire de la scène n’est
ajouté.

Quand la caméra descend sous terre, le caméléon, les papillons et leurs volumes
de debug sont masqués avec les autres animaux extérieurs.
