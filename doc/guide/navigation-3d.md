---
title: Déplacements et trajets
order: 50
summary: Comment une intention devient un trajet continu sur une vraie surface.
contracts: NAV-SURFACE, NAV-ENTRANCE
---

# Déplacements et trajets

## À la surface

Les fourmis n’utilisent pas un itinéraire mondial prédéfini. Elles combinent exploration, phéromones, présence de nourriture, besoin de rentrer et signal d’alarme. Une ouvrière chargée privilégie le retour ; une fourmi affamée vise l’entrée ; une éclaireuse accepte davantage d’errance ; une soldate se rapproche du danger.

## Sous terre

Le réseau connaît les chambres, les jonctions et les corridors qui les relient. L’objectif — grenier, reine, couvain ou sortie — détermine le prochain corridor à emprunter. La fourmi n’emporte pas une longue liste de points : elle conserve un état de route compact et consulte des tables partagées.

Dans un tunnel, elle avance sur une piste stable de la paroi. Cette piste peut passer sur le sol, un mur ou le plafond : son corps s’oriente selon la surface au lieu de léviter sur l’axe du tunnel. Aux jonctions, elle traverse une zone sûre avant de prendre le corridor suivant. Si une frame suffit pour franchir une jonction, la distance restante est utilisée sur la suite du trajet au lieu d’être perdue ou transformée en saut.

Les 12 pistes de chaque tunnel sont calculées lors de la construction du nid et enregistrent directement les positions et normales de contact. En jeu, une fourmi ne cherche donc jamais la paroi : elle interpole sa piste à coût constant, quel que soit le nombre de fourmis.

## Comment le nid grandit naturellement

Le nid est un arbre souterrain : un tronc fondateur descend depuis l’entrée, puis des ramifications se divisent progressivement en rameaux et en extrémités. Une jonction produit au plus deux nouvelles branches. Les tunnels mélangent trajets courts et longs, directions et profondeurs, afin que la structure globale ressemble à une croissance dans la terre plutôt qu’à un plan de salles alignées.

La partie commence normalement avec 24 unités actives. Le registre en prévoit 96 : quand la colonie grandit, elle active la suite sans déplacer les salles ni changer les tunnels déjà présents. Les quatre premières unités assurent la garde, le grenier, la crèche et la chambre royale.

Toutes les unités ne sont pas de grandes salles. Les vestibules sont de petits élargissements servant uniquement au passage et aux bifurcations ; les chambres sont plus larges et peuvent recevoir une fonction de la colonie. Cette alternance rend le réseau lisible et évite une grosse forme ovale à chaque virage. L’ancien système créait des groupes répétés de quatre salles et donnait au nid une allure géométrique ; ce gabarit n’est plus utilisé.

Les chambres et vestibules combinent trois lobes asymétriques. Les tunnels serpentent et leur largeur évolue doucement. Ces variations sont déterministes : une même configuration recrée le même nid, ce qui rend les comportements reproductibles et testables.

Cette irrégularité est physique : le volume creusé, le rendu et les pistes empruntées par les fourmis proviennent des mêmes formes. Elle reste bornée par des règles strictes — extrémités exactes, largeur minimale jamais réduite et au moins 0,4 unité de terre entre structures étrangères. Avant publication, le registre complet est vérifié dans toutes les profondeurs et largeurs autorisées. Une croissance ajoute des unités sans déplacer les anciennes.

## Pourquoi la profondeur est limitée

La profondeur nominale se règle entre 19 et 24 unités. Le volume rendu suit le point réel le plus profond du registre. La limite basse laisse assez de terre entre toutes les chambres et galeries d’une fourmilière complète. La limite haute conserve assez de précision pour que les tunnels les plus fins restent continus. Une ancienne sauvegarde hors de cet intervalle est automatiquement adaptée.

Une fourmilière beaucoup plus profonde demanderait une autre technologie de rendu du sous-sol, avec des zones chargées séparément. Augmenter simplement le nombre dégraderait les galeries.

## Une entrée unique et continue

Le trou visible du sol, la gorge souterraine et la trajectoire utilisent la même bouche. L’entrée est réservée à la périphérie, à l’écart des chambres et tunnels que la colonie pourra creuser plus tard. Son raccord peut effectuer de petits détours déterministes pour préserver la terre autour des autres structures.

Une fourmi rejoint un point de l’anneau placé exactement au niveau du sol, `y = 0`, descend sans recentrage artificiel, puis poursuit son trajet dans le réseau. La portion de déplacement restante après le contact est conservée dans les deux sens : elle ne gagne ni ne perd de distance lors du changement surface/sous-sol.

Une fourmi qui ne descend pas ne peut pas traverser le trou. Même lors d’une frame très longue, elle s’arrête au premier contact de la lèvre et poursuit éventuellement en glissant autour ; une fourmi qui remonte peut, elle, sortir progressivement. Ce garde-fou est un calcul direct à coût constant, pas une recherche de collision coûteuse.

Lorsqu’une extension ou une reconstruction du nid est demandée, sa géométrie est préparée en arrière-plan. Les fourmis continuent de vivre pendant ce calcul ; la nouvelle version remplace l’ancienne d’un seul bloc seulement lorsqu’elle est complète et valide.

## Pourquoi les trajectoires se ressemblent

Plusieurs fourmis ayant le même objectif partagent naturellement les mêmes corridors et zones de service. Elles peuvent utiliser des pistes angulaires différentes autour du tunnel, mais leur progression longitudinale reste cohérente. La simulation ne réserve pas un portail à chaque individu et ne calcule pas de collision microscopique entre toutes les fourmis : de petits recouvrements visuels restent possibles sans constituer un blocage.
