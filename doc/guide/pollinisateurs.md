---
title: Abeilles et pollinisateurs
order: 58
summary: Comprendre la colonie agrégée, les vols, les visites de fleurs, la météo et les limites du modèle d’abeilles.
contracts: BEE-SIM
---

# Abeilles et pollinisateurs

## Ce que vous voyez

Le système de pollinisateurs vit uniquement à la surface. Une ruche est suspendue à un arbre, les fleurs forment plusieurs parcelles autour de la carte et des ouvrières butineuses font des allers-retours entre les deux. Entrer sous terre masque cet ensemble avec le reste du décor de surface.

Le nombre **Abeilles visibles** règle des représentantes graphiques, pas la population réelle calculée dans la ruche. Par défaut, 48 slots représentent collectivement 32 000 ouvrières adultes. Une partie de ces représentantes se trouve dans la ruche et n’est volontairement pas dessinée : il est normal de voir moins de 48 abeilles à l’écran.

## Le cycle d’une abeille

Une abeille suit ce cycle :

```text
ruche → orientation → fleur → récolte → retour → déchargement → repos
```

- **Dans la ruche**, elle attend des conditions favorables et récupère de l’énergie.
- **En orientation**, une nouvelle butineuse décrit un court vol autour de l’entrée avant de partir loin.
- **À l’aller**, elle rejoint une fleur précise.
- **En approche**, elle ralentit et descend sur la cible.
- **En récolte**, elle prélève du nectar ou du pollen. Elle peut ensuite visiter une autre fleur.
- **Au retour**, elle rejoint directement l’entrée.
- **Au déchargement**, elle livre sa charge.
- **Au repos**, elle récupère avant un autre trajet.

Les états d’orientation, d’aller, d’approche et de retour utilisent le même cycle de vol : changer d’étape ne redémarre pas brusquement le battement des ailes. La phase ne repart qu’au véritable passage entre l’animation de vol et celle de récolte.

L’attente dans la ruche et le repos sont cachés. Une abeille peut donc disparaître à l’entrée puis ressortir plus tard sans qu’il s’agisse d’un bug. Un retour trop long possède aussi une sécurité : l’abeille termine à la ruche au lieu de rester définitivement bloquée.

## Vie de la colonie

La partie visible repose sur une colonie agrégée. Au lancement, elle contient 32 000 ouvrières adultes, 3 600 œufs, 6 500 larves et 12 500 nymphes. La reine est présente et pond jusqu’à environ 1 200 œufs par jour biologique lorsque la nutrition, la saison et la population ouvrière sont favorables.

Le développement suit une chaîne simple :

```text
œuf (3 jours) → larve (6 jours) → nymphe (12 jours) → adulte
```

Une ponte fraîche atteint donc l’âge adulte après environ 21 jours biologiques. Le couvain déjà présent au lancement contient des âges mélangés : des émergences peuvent se produire plus tôt. Une petite perte est appliquée à chaque stade, puis les adultes subissent une mortalité continue.

Les milliers d’individus restent des compteurs et des cohortes, sans modèle 3D. Lorsqu’une représentante visible vieillit, son slot est recyclé à la ruche pour représenter une ouvrière d’une génération suivante. Le nombre de modèles affichables reste ainsi fixe et performant, tandis que la population agrégée continue d’évoluer.

## Pourquoi cette fleur ?

À chaque trajet, l’abeille choisit d’abord du nectar ou du pollen selon deux influences : le besoin global fixé pour la ruche et sa préférence individuelle. Cette préférence augmente une probabilité ; elle ne crée pas deux castes rigides.

Elle compare ensuite un petit nombre de fleurs. Une fleur bien approvisionnée, de bonne qualité, proche et située dans une parcelle déjà connue a davantage de chances d’être retenue. Les fleurs perdent une petite partie de leur stock lors des visites puis se régénèrent progressivement.

Les parcelles, leurs fleurs et leurs variations sont recréées avec une graine fixe. Après un reset, la même configuration donne donc le même terrain de butinage et les mêmes décisions si les réglages restent identiques.

## Effet de la météo

La température, la pluie et le vent contrôlent surtout les départs :

- sous environ 10 °C, les sorties deviennent très difficiles ;
- entre 10 et 16 °C, l’activité augmente progressivement ;
- la pluie réduit directement la condition de vol ;
- le vent commence à pénaliser les départs vers 3 m/s et devient très contraignant vers 7 m/s.

Ces facteurs se combinent. Une pluie moyenne avec du vent peut donc garder les abeilles dans la ruche, même si chaque réglage pris séparément semble acceptable. Une abeille déjà dehors poursuit normalement son trajet ; le vent ne la déporte pas physiquement.

**Lumière du jour** règle directement la condition lumineuse : `0` empêche les nouveaux départs et `1` représente le plein jour. Ce curseur reste indépendant de l’heure visuelle du ciel. Température, pluie, vent et lumière changent l’activité extérieure, mais ne suspendent ni la ponte, ni le développement du couvain, ni le vieillissement.

## Réglages

Ouvrez **Graphismes → 🌼 Pollinisateurs** :

- **Activer** affiche et avance le système. S’il est sauvegardé désactivé, les modèles et animations ne sont pas chargés au prochain lancement ; le réactiver déclenche leur chargement en arrière-plan ;
- **Abeilles visibles** contrôle le nombre de représentantes, sans modifier les 32 000 ouvrières agrégées ; **Taille abeilles** et **Vitesse de vol** règlent leur lecture à l’écran ;
- **Durée des cycles** multiplie les temps d’attente, de récolte et de repos : une valeur élevée ralentit le cycle ;
- **Lumière du jour**, **Température**, **Pluie** et **Vent** changent la possibilité de partir ;
- **Fleurs**, **Taille fleurs** et **Variation fleurs** reconstruisent le champ lorsque le curseur est relâché ;
- **Mouvement fleurs** règle leur balancement sans reconstruire le décor ;
- les quatre teintes modifient pétales, tiges, abeilles et ailes en direct ;
- **Taille ruche** redimensionne la ruche et recalcule son point de départ.

Les limites visibles du panneau sont sûres : au maximum 128 abeilles et 256 fleurs. Les fleurs partagent un seul rendu instancié, comme les abeilles en vol ; augmenter leur nombre n’ajoute pas un draw par objet.

## Ce que le système ne simule pas encore

La reine, les œufs, les larves, les nymphes, les émergences et la mortalité adulte sont suivis uniquement comme quantités agrégées. Ils n’ont ni modèle 3D ni comportement individuel. Le système ne simule pas les mâles, les nourrices, les tâches internes, les rayons de cire, l’essaimage, les maladies ou la danse de recrutement. Les abeilles ne nourrissent pas les fourmis et les fourmis n’attaquent pas la ruche.

Une visite florale est une animation de récolte avec un stock nectar/pollen. Elle ne féconde pas encore la plante, ne crée pas de graine et ne modifie pas le paysage. Les abeilles ne s’évitent pas entre elles et ne calculent pas de chemin autour des branches : leur vol est un trajet continu vers la cible, enrichi d’un léger arc visuel.

Le système vise donc une scène de butinage cohérente, déterministe et performante. Il ne faut pas interpréter ses compteurs, ses âges accélérés ou ses seuils comme une prédiction scientifique d’une ruche réelle.
