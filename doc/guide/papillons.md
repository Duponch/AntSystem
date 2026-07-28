---
title: Papillons
order: 59
summary: Comprendre leur cycle accéléré, leurs visites de fleurs, leur nombre visible et les réglages associés.
contracts: BUTTERFLY-SIM
---

# Papillons

## Ce que vous voyez

Les papillons vivent à la surface et utilisent les mêmes fleurs que les abeilles. Un adulte se repose, choisit une fleur, vole vers elle, s’y nourrit puis repart plus tard. Descendre sous terre masque les papillons avec le reste du monde de surface.

Le réglage **Nombre** ne garantit pas autant de papillons visibles. Il indique le nombre de lignées suivies par la simulation. Seuls les adultes sont dessinés ; les œufs, larves et chrysalides continuent leur cycle en arrière-plan. Voir temporairement moins de papillons que la valeur choisie est donc normal.

## Leur cycle

Chaque lignée recommence continuellement :

```text
œuf → larve → chrysalide → adulte → nouvel œuf
```

- **Œuf** : premier stade abstrait et invisible.
- **Larve** : développement invisible ; la chenille et sa plante hôte ne sont pas encore représentées.
- **Chrysalide** : métamorphose invisible.
- **Adulte** : seul stade visible, capable de voler et de visiter une fleur.

Le cycle est volontairement très accéléré pour être observable pendant une partie. Les lignées ne changent pas toutes de stade au même instant : leurs durées contiennent une variation déterministe. Un papillon peut donc disparaître à la fin de sa vie adulte, puis son slot traverse les trois stades invisibles avant qu’un adulte d’une nouvelle génération réapparaisse. Ce n’est ni un despawn aléatoire ni un problème de rendu.

## Ce que fait un adulte

Un adulte alterne entre trois intentions :

```text
repos → vol → nourrissage → repos
```

Au départ, il compare toujours un petit échantillon de quatre fleurs. Il préfère une fleur active, avec du nectar, de bonne qualité et éventuellement dans une parcelle déjà visitée. Il vole ensuite directement vers sa cible, se nourrit brièvement et revient au repos.

Les papillons et les abeilles partagent le même champ et ses stocks. Une visite de papillon prélève donc une petite quantité de nectar disponible. Elle ne produit pas encore de graines, de nouvelles plantes ou de nourriture pour les fourmis.

## Lumière et météo

Les papillons reprennent les réglages **Lumière du jour**, **Température**, **Pluie** et **Vent** du panneau des pollinisateurs. Des conditions défavorables empêchent de nouveaux vols et gardent les adultes au repos.

Ces conditions ne mettent jamais le cycle de vie en pause. Œufs, larves, chrysalides et adultes continuent de vieillir la nuit ou pendant une pluie. La météo répond donc à la question « peut-il voler maintenant ? », pas « le temps biologique avance-t-il ? ».

## Réglages

Ouvrez **Graphismes → 🌼 Pollinisateurs → 🦋 Papillons** :

- **Activer** affiche et avance les papillons. Le parent **Pollinisateurs** doit également être actif ;
- **Nombre** choisit de 0 à 64 lignées simulées, pas 64 adultes garantis à l’écran ;
- **Échelle** modifie leur taille visuelle ;
- **Vitesse de vol** modifie la vitesse de déplacement des adultes ;
- **Vitesse du cycle** accélère ou ralentit les quatre stades : une valeur élevée fait tourner les générations plus vite ;
- **Teinte** colore le modèle tout en conservant son atlas et son éclairage.

Le modèle animé n’est chargé que lorsque Pollinisateurs et Papillons sont tous deux actifs. Une partie lancée avec les papillons désactivés évite donc ce coût ; une activation ultérieure les charge une seule fois en arrière-plan.

## Ce que la simulation ne représente pas encore

Les stades immatures sont des états logiques : aucune chenille ne rampe, aucune chrysalide ne s’accroche et aucun œuf n’est placé sur une plante. Accouplement, espèces, plantes hôtes, prédateurs et migration ne sont pas modélisés. Les adultes n’évitent pas physiquement les branches ou les autres insectes.

Le système cherche surtout à rendre un cycle simple, compréhensible, reproductible et peu coûteux. Les durées accélérées et les décisions ne doivent pas être interprétées comme une prédiction scientifique d’une espèce réelle.
