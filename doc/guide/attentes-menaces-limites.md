---
title: Attentes, amas et menaces
order: 40
summary: Ce qui est normal, ce qui mérite vérification et les limites du modèle.
contracts: COL-ECO, OBS
---

# Attentes, amas et menaces

## Pourquoi observe-t-on des amas ?

Un regroupement fixe dans une cavité peut être parfaitement normal :

- au démarrage, les activations sont volontairement décalées ;
- au grenier, plusieurs fourmis attendent la même ressource ou viennent manger ;
- près du couvain et de la reine, les nourrices partagent les mêmes points de service ;
- à une jonction, plusieurs missions empruntent temporairement la même zone sûre ;
- une pause biologique peut commencer à proximité d’autres fourmis.

La simulation privilégie un coût stable avec une grande population. Elle ne calcule donc pas une éviction corps-à-corps complète entre chaque paire de fourmis. Un amas ou un léger chevauchement n’est pas, à lui seul, un embouteillage mécanique.

## Attente normale ou blocage ?

| Observation | Interprétation |
|---|---|
| « Se prépare dans le nid » avec décompte | Activation initiale normale. |
| « Repos programmé » avec décompte | Pause temporaire normale. |
| « Attend au grenier » et stock nul | Dépendance logistique normale. |
| Cadavre ou dévorée | État terminal, aucun mouvement attendu. |
| Progression qui augmente, même lentement | La route est active. |
| Vivante, active, vitesse nulle longtemps, aucune raison | Cas à vérifier avec l’inspecteur. |

## Menaces de surface

Les araignées détectent et attaquent les fourmis à la surface ; elles ne mordent pas à travers le sol. Les fourmis exposées produisent une alarme locale. Les ouvrières et éclaireuses tendent à s’en éloigner, tandis que les soldates peuvent charger et mordre. Une pression d’alarme suffisante peut faire reculer un prédateur.

Une victime peut être blessée, mourir, puis être dévorée. Ces états sont visibles dans l’inspecteur et ne doivent pas être confondus avec une panne de navigation.

## Règles et limites à garder en tête

- Les déplacements souterrains suivent un réseau précis ; l’exploration de surface garde une part volontaire d’aléatoire.
- Les ressources, l’énergie, les temps biologiques et les prédateurs peuvent interrompre ou réorienter une mission.
- Le coût total augmente avec le nombre de fourmis, mais le travail de navigation d’une fourmi ne dépend pas du nombre de ses congénères.
- Il n’existe pas encore d’évitement local complet ni de réservation individuelle des passages.
- Une immobilité inexpliquée et durable est anormale ; une attente expliquée par une règle est un comportement de la simulation.