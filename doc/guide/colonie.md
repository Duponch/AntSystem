---
title: Colonie et castes
order: 10
summary: Qui fait quoi, et comment les rôles se complètent.
contracts: COL-ECO, TIME-SCALE
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

## Comprendre la vitesse ×

L’horloge **Fluide GPU** est le chemin GPU-first du jeu : elle privilégie la qualité visible et les performances. Jusqu’à `×1`, la simulation avance une seule fois par image : une fourmi en mouvement reçoit donc une pose fraîche même sur un écran 240 Hz. Au-dessus de `×1`, le moteur peut exécuter jusqu’à huit petits sous-pas par image, chacun limité à `1/30 s`.

Ce mode est le défaut de chaque session et le choix **Fluide / Strict** n’est pas sauvegardé. Un rechargement revient donc toujours en fluide, sauf si la page a été ouverte explicitement avec `?timing=strict`. Le plafond de sous-pas GPU, lui, reste enregistré comme les autres réglages.

`×0` est une vraie pause : aucun âge, trajet, stock ou délai biologique n’avance. Les espèces partagent toujours le même temps effectivement consommé et le même ordre causal, mais le mode fluide ne promet pas que deux FPS différents produiront exactement les mêmes décisions aléatoires.

`×100` reste une demande, pas la promesse d’un calcul cent fois plus rapide. Si le plafond GPU est atteint, le surplus n’est pas mis en attente : l’overlay indique le temps non simulé et une vitesse effective plus faible. Revenir à `×1` rend ainsi immédiatement toute la fluidité, sans rattrapage caché.

Le réglage **Horloge → Strict / replay exact** réactive des ticks fixes à 120 Hz et des lectures GPU synchronisées. Entrer dans ce mode réinitialise transactionnellement la simulation : les pas sont suspendus, les lectures déjà engagées sont attendues, puis le monde repart d’un état propre. Une même graine et les mêmes actions donnent alors le même état au même tick ; tout retard est conservé jusqu’à son calcul. Ce profil sert surtout aux tests, aux comparaisons reproductibles et aux replays, car il peut être sensiblement plus coûteux.

Les réactions de la colonie et des araignées utilisent en mode fluide le dernier relevé GPU disponible. Ces diagnostics sont lancés après l’image visible et peuvent donc décrire l’image précédente. Une lecture occupée est simplement regroupée avec la suivante au lieu de figer une image ; un reset ou une modification structurelle reste, lui, appliqué atomiquement.
