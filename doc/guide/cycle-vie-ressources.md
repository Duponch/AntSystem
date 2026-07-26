---
title: Cycle de vie et ressources
order: 30
summary: De la ponte à l’adulte, et le rôle vital de la nourriture.
contracts: COL-ECO
---

# Cycle de vie et ressources

## De la ponte à l’adulte

1. **Ponte** : la reine doit avoir attendu son intervalle de ponte et disposer de suffisamment d’énergie.
2. **Œuf** : il mûrit pendant une durée réglée par la simulation.
3. **Larve** : elle doit recevoir plusieurs repas du couvain. Une larve privée de nourriture trop longtemps peut mourir.
4. **Nymphe (cocon)** : après les repas requis, elle poursuit sa maturation sans nouveau repas.
5. **Adulte** : si une place est disponible dans la population, elle éclot au couvain, mature brièvement, puis rejoint sa mission.

Les œufs sont déplacés par une abstraction logistique entre la chambre royale et le couvain. Leur hauteur suit explicitement la nappe de l’une de ces deux chambres : une galerie superposée ne peut pas les attirer sur un étage arbitraire.
Le couvain possède une capacité finie. Une reine en bonne santé ne garantit donc pas un flot illimité d’adultes : la place disponible, la durée de chaque stade et la nourriture comptent aussi.

## Le circuit de la nourriture

```text
surface → ouvrière chargée → entrée → grenier
                                      ├→ fourmi affamée
                                      ├→ nourrice → reine
                                      └→ nourrice → couvain
```

Le **grenier** est le stock central. Les nourrices en prélèvent des unités pour la mangeoire royale et celle du couvain. Les autres fourmis y mangent lorsqu’elles rentrent affamées.

Cette dépendance produit des conséquences visibles :

- grenier vide → nourrices et affamées peuvent attendre ;
- reine mal ravitaillée → récupération, puis ralentissement de la ponte ;
- couvain mal ravitaillé → développement des larves ralenti ou mortalité ;
- collecte efficace → réserves, reine nourrie et davantage d’éclosions possibles.

Les durées et seuils sont paramétrables. Observez donc la chaîne causale plutôt qu’un nombre fixe de naissances par minute.