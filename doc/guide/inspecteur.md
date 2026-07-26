---
title: Inspecteur de fourmi
order: 60
summary: Lire l’intention, la route et la raison réelle d’un arrêt.
contracts: OBS
---

# Inspecteur de fourmi

Sélectionnez une fourmi pour suivre **un individu précis**. Le panneau traduit son état interne ; il n’influence jamais ses décisions.

## Les informations à lire

- **Caste et état réel** : la caste, puis un contexte lisible — pause globale, activation, repos, cycle royal, transport, navigation souterraine, exploration ou état terminal.
- **Intention** : l’action actuelle, par exemple chercher, rapporter, ravitailler, attaquer, récupérer ou suivre le cycle de ponte.
- **Objectif** : nourriture, entrée, grenier, mangeoire royale, couvain ou sortie.
- **Mouvement réel** : vitesse mesurée et durée passée presque au même endroit.
- **Route souterraine** : nœud sûr, corridor actif et progression dans ce corridor.
- **Distance de route** : distance cumulée déjà convertie en unités monde `u`, et non en cellules de grille.
- **Explication** : la cause concrète de l’action ou de l’attente.

## Comprendre « État réel »

- **Simulation en pause** : le jeu est suspendu ; aucune fourmi n’est alors considérée comme bloquée et ce temps n’allonge pas son immobilité.
- **Activation initiale** : elle attend encore sa reprise échelonnée au lancement.
- **Repos** : elle effectue une pause biologique prévue.
- **Cycle royal** : la reine attend, mange, récupère ou prépare une ponte ; l’intention donne l’étape exacte.
- **Transport** : elle porte une ressource, même si elle se trouve déjà sous terre.
- **Navigation souterraine** : elle circule sans charge dans une chambre ou un corridor.
- **Exploration** : elle agit à la surface sans charge ; chercher, rentrer ou combattre reste précisé par l’intention.
- **Cadavre** ou **Dévorée** : état terminal, aucun redémarrage n’est attendu.

L’état réel donne le contexte ; l’**intention** explique l’action précise. Par exemple, deux fourmis en « Navigation souterraine » peuvent viser respectivement le grenier et le couvain.

La case **Pause** et une vitesse réglée à `×0` suspendent toutes deux le diagnostic. Ce temps ne transforme jamais un arrêt volontaire de l’utilisateur en immobilité suspecte.

## Interpréter un arrêt

Un arrêt affiché comme **normal** a une cause connue : pause globale, activation initiale, repos programmé, attente d’un stock, mort ou dévoration. Le temps passé en pause globale est retiré du chronomètre d’immobilité. Hors pause globale, il doit reprendre lorsque sa condition disparaît, sauf état terminal.

Un arrêt bref sans explication peut être un changement de direction ou de zone. Si une fourmi vivante et active reste immobile au-delà de la tolérance sans cause reconnue, le panneau indique **« à vérifier »**. Cela signale une anomalie possible, pas une preuve automatique : regardez aussi son objectif, son corridor et l’état du grenier.

## Méthode de diagnostic rapide

1. Vérifiez l’**état réel**, puis l’**intention** et l’**objectif**.
2. Lisez la **raison** de l’arrêt.
3. Contrôlez si la progression de corridor ou la vitesse évolue.
4. Si l’immobilité devient suspecte, notez l’identifiant de la fourmi et le contexte pour reproduire le cas.

Changer de sélection remet le chronomètre d’immobilité à zéro afin de ne jamais mélanger deux individus.