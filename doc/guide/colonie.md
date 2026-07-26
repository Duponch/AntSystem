---
title: Colonie et castes
order: 10
summary: Qui fait quoi, et comment les rôles se complètent.
contracts: COL-ECO
---

# Colonie et castes

La colonie fonctionne comme une chaîne logistique : la surface fournit la nourriture, le grenier la stocke, les nourrices la distribuent et la reine transforme cette sécurité alimentaire en nouvelles fourmis.

## Les cinq castes

| Caste | Rôle observable | Trajets habituels |
|---|---|---|
| **Reine** | Maintient la reproduction. Elle mange, récupère de l’énergie et déclenche la **ponte** lorsque les conditions sont réunies. | Elle reste dans la chambre royale et rejoint sa mangeoire proche. |
| **Ouvrière** | Cherche, ramasse et rapporte la nourriture. | Nid → surface → ressource → entrée → grenier. |
| **Nourrice** | Assure la logistique interne. | Grenier → mangeoire royale ou couvain → grenier. |
| **Soldate** | Protège les fourrageuses et répond aux prédateurs. | Sortie → patrouille de surface → zone d’alarme ou prédateur. |
| **Éclaireuse** | Découvre des zones encore peu marquées. | Longues explorations de surface, avec davantage d’errance. |

La caste ne signifie pas qu’une fourmi répète un trajet fixe. Son besoin d’énergie, une charge trouvée, une alarme ou un stock vide peuvent changer sa priorité.

## Une décision, puis une route

La simulation sépare deux questions :

1. **Que veut faire la fourmi ?** Chercher, rapporter, manger, ravitailler, défendre ou attendre.
2. **Comment y aller ?** Sur la surface elle suit des signaux locaux ; sous terre elle emprunte le réseau de chambres et de corridors vers un objectif précis.

Cette séparation explique pourquoi deux fourmis de même caste peuvent partir dans des directions différentes sans que l’une soit défaillante.

## Ce que la colonie n’est pas

Il n’existe pas de chef qui attribue chaque tâche une par une. Les comportements émergent de règles partagées, des besoins individuels et de l’état des stocks. Les résultats de l’exploration sont donc variables, alors qu’un redémarrage avec les mêmes paramètres conserve les règles et le placement initial déterministe.