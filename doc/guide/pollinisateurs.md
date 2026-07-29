---
title: Abeilles et pollinisateurs
order: 58
summary: Comprendre l’exploration, le recrutement, les vols, la production de miel, la démographie et les réglages de la colonie d’abeilles.
contracts: BEE-SIM
---

# Abeilles et pollinisateurs

## Ce que vous observez

À la surface, une ruche est fixée à un arbre et des fleurs sont réparties en parcelles. Les abeilles visibles ne suivent plus un simple aller-retour identique : certaines explorent, d’autres exploitent les zones découvertes, plusieurs fleurs peuvent être visitées pendant un même voyage, puis la charge est réellement rapportée à l’intérieur.

Les papillons utilisent le même champ floral mais suivent leur propre cycle, décrit dans [Papillons](./papillons.md).

**Abeilles visibles** règle des représentantes graphiques, pas l’effectif réel. Par défaut, 48 slots représentent collectivement environ 32 000 ouvrières. Celles qui déchargent, dansent, se reposent ou attendent dans la ruche sont cachées : voir moins de 48 abeilles n’est pas une disparition anormale.

## Pourquoi une abeille part ici plutôt qu’ailleurs

La colonie combine trois informations :

1. ses besoins en nectar et pollen ;
2. la préférence individuelle de la butineuse ;
3. ce que les retours précédents ont appris sur les parcelles.

Une **éclaireuse** prend un trajet indirect, inspecte une zone et peut découvrir une ressource. Une rentrée profitable renforce une petite mémoire collective, représentée par une danse dans la ruche.

Une **recrutée** peut utiliser cette information pour rejoindre une parcelle connue. Les sources peu rentables, épuisées ou anciennes perdent progressivement leur influence. Lorsque la colonie connaît peu de bonnes sources, la proportion effective de voyages exploratoires augmente.

Il est donc normal que deux abeilles quittant la ruche au même moment ne prennent ni la même route ni la même décision.

## Cycle visible d’une butineuse

```text
attente dans la ruche
  → sortie par la bouche
  → orientation, exploration ou vol recruté
  → inspection de la parcelle
  → ralentissement et pose sur une fleur
  → récolte
  → autre fleur éventuelle
  → retour et entrée par la bouche
  → déchargement, danse éventuelle et repos
```

### Sortir et rentrer

La ruche possède un point intérieur, sa bouche et un point extérieur. Une abeille traverse ces trois points dans l’ordre, sans saut :

- sortie : intérieur → bouche → extérieur ;
- entrée : extérieur → bouche → intérieur.

Elle reste visible pendant la traversée et n’est cachée qu’une fois arrivée à l’intérieur. Une disparition exactement au fond de la bouche est donc normale ; une disparition devant la ruche ne le serait pas.

### Vol

Le vol combine accélération, freinage, virages lissés, variation de vitesse et flottements rapides et lents. Le corps suit la vitesse réelle : il vole globalement couché, avec une inclinaison lors des montées et un roulis dans les virages.

Ces mouvements expliquent les petits détours autour d’une parcelle. Une abeille ne doit toutefois jamais changer instantanément de position.

### Se poser et butiner

Près d’une fleur, l’abeille ralentit avant de rejoindre le point de contact préparé dans Blender. La pose, l’animation `Forage_Bee` et le décollage s’enchaînent sans téléportation.

Le butinage dure 10 secondes en moyenne par défaut, avec une variation déterministe de 0,7× à 1,5×. Après la récolte, l’abeille peut visiter une autre fleur de la parcelle si sa charge et son énergie le permettent. Sinon elle rentre.

## De la fleur au miel

Une visite retire réellement du nectar ou du pollen du stock de la fleur.

- Le **pollen** rejoint les réserves de la ruche et nourrit le couvain larvaire.
- Le **nectar brut** contient du sucre et beaucoup d’eau.
- Dans la ruche, une transformation agrégée transfère progressivement le sucre vers le stock de **miel** et évapore l’excès d’eau.
- Les adultes consomment d’abord le miel, puis le nectar brut si le miel manque.

La vitesse de cette transformation dépend de **Maturation miel (s)**. Il s’agit d’une abstraction des transferts entre butineuses et receveuses, de la manipulation du nectar et de la ventilation.

Les réserves ne sont pas décoratives. Quand sucre ou pollen manquent, la demande de collecte augmente et la nutrition baisse. Une mauvaise nutrition réduit ensuite la ponte. Sans fleurs, aucune nouvelle ressource ne peut être créée : la colonie vit sur ses stocks puis les épuise.

## Vie de la colonie

La colonie commence avec environ :

- 32 000 ouvrières adultes ;
- 3 600 œufs ;
- 6 500 larves ;
- 12 500 nymphes.

La reine peut pondre jusqu’à 1 200 œufs par jour biologique lorsque nutrition, saison et population ouvrière sont favorables.

```text
œuf (3 jours) → larve (6 jours) → nymphe (12 jours) → adulte
```

Une ponte fraîche devient donc adulte après environ 21 jours biologiques. Le couvain initial contient déjà plusieurs âges, ce qui permet des émergences plus tôt. Des pertes existent à chaque stade et les adultes vieillissent aussi.

Ces milliers d’individus restent des compteurs. Quand une représentante visible atteint son âge de retrait, son slot est recyclé à l’intérieur de la ruche pour représenter une nouvelle génération, sans créer un nouveau modèle 3D.

## Pourquoi une abeille attend ou disparaît longtemps

Plusieurs situations sont normales :

- elle récupère son énergie dans la ruche ;
- la lumière, la température, la pluie ou le vent interdisent un départ ;
- aucune fleur n’a assez de la ressource recherchée ;
- elle décharge sa récolte ;
- elle met à jour la mémoire collective par une danse ;
- elle se repose avant un nouveau voyage.

À l’extérieur, elle peut ralentir pour inspecter une parcelle, approcher une fleur ou préparer son entrée. Une immobilité prolongée en plein vol ou un saut de position ne fait pas partie du comportement voulu.

## Météo

Les départs dépendent d’un score continu :

- la lumière devient favorable entre environ `0,08` et `0,32` ;
- l’activité augmente entre 10 et 16 °C ;
- la pluie réduit directement la condition ;
- le vent devient pénalisant entre environ 3 et 7 m/s.

Une abeille déjà dehors n’est pas téléportée si les conditions changent. Elle termine son étape ou rentre. Le vent ne déforme pas encore physiquement sa trajectoire.

**Lumière du jour** est un contrôle manuel et ne suit pas automatiquement l’heure visuelle du ciel. La météo modifie les sorties, pas l’écoulement du temps biologique.

## Réglages utiles

Dans **Graphismes → 🌼 Pollinisateurs** :

- **Abeilles visibles** : nombre de slots, de 0 à 128 ;
- **Taille abeilles** et **Vitesse de vol** : apparence et vitesse maximale ;
- **Part d’éclaireuses** : davantage d’exploration, de 0 à 0,6 ;
- **Accélération** : réactivité du démarrage, du freinage et des changements de vitesse ;
- **Flottement multi-échelle** : amplitude des mouvements organiques ;
- **Butinage sur fleur (s)** : durée centrale de chaque visite ;
- **Maturation miel (s)** : vitesse de conversion du nectar brut en miel ;
- **Nectar initial**, **Miel initial** et **Pollen initial** : réserves appliquées au prochain reset ;
- **Lumière du jour**, **Température**, **Pluie** et **Vent** : conditions de départ ;
- **Fleurs**, **Taille fleurs**, **Variation fleurs** et **Mouvement fleurs** : composition du champ ;
- les teintes : coloration en direct des fleurs, corps et ailes ;
- **Ombres abeilles** : projection et réception indépendantes ;
- **Taille ruche** : recalcule aussi son corridor d’entrée ;
- **Ombres ruche** : projection et réception indépendantes sur le matériau éclairé de la ruche.

La ruche n’utilise pas une couleur émissive : elle reçoit l’éclairage et son relief comme les objets de surface. Les ombres nécessitent aussi que le réglage global des ombres soit actif.

## Performances

La simulation ne compare jamais chaque abeille à chaque fleur.

- Une décision florale examine quatre candidates.
- La mémoire collective contient 16 entrées par défaut et reste strictement bornée.
- Reine, couvain, miel et pollen sont des compteurs agrégés.
- Les abeilles partagent un draw VAT ; les fleurs partagent un draw instancié ; la ruche utilise une primitive.
- Les données GPU sont envoyées une seule fois par frame, même si plusieurs pas logiques sont calculés.

Augmenter le nombre de fleurs ou d’ouvrières réelles ne crée donc ni squelette ni objet de rendu par individu.

## Limites actuelles

Le système ne simule pas encore :

- les individus internes de la ruche, les rayons de cire et l’operculation visible ;
- les mâles, l’essaimage, les maladies ou la génétique ;
- une danse visible à l’intérieur ;
- la pollinisation des plantes et la production de graines ;
- les collisions entre abeilles ou l’évitement géométrique des branches ;
- une poussée physique du vent ;
- des échanges de ressources avec les fourmis.

L’exploration, les réserves et les durées sont conçues pour une simulation cohérente et plaisante à observer. Elles ne doivent pas être lues comme des mesures scientifiques exactes d’une ruche réelle.
