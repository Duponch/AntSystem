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

## Quand un papillon voit le caméléon

Un adulte possède une zone de vision réglable. Si un caméléon en mouvement ou en observation entre dans sa distance et son angle de vue, le papillon abandonne sa fleur et fuit continuellement dans la direction opposée. Il anticipe légèrement le mouvement du prédateur : sa trajectoire peut donc être oblique plutôt qu’une ligne parfaitement droite.

Pendant une longue pause de camouflage planifiée, le caméléon devient **camouflé** après être resté immobile assez longtemps. Le joueur le reconnaît à une teinte de signal configurable, rouge par défaut. Cette couleur ne participe pas à la perception : les papillons lisent uniquement l’état logique de camouflage, ne voient plus le prédateur et cessent immédiatement de l’éviter. Ils peuvent alors traverser sa zone d’attaque. Ce risque est volontaire et explique pourquoi une attaque reste possible malgré la fuite.

Sélectionnez un adulte puis activez **Zone du sélectionné** pour afficher uniquement son volume de perception, sans ajouter une géométrie de debug à toute la population. L’inspecteur indique aussi s’il voit une menace, sa distance et son intention courante.

## Quand un caméléon attaque

Le caméléon ne vise que les adultes visibles. Un papillon touché reste accroché
au bout de la langue et suit sa rétraction sans saut de position. Il ne
disparaît qu’à l’entrée effective dans la bouche. Le slot de sa lignée
recommence alors au stade œuf : la baisse momentanée du nombre de papillons
visibles est donc une conséquence du cycle, pas un despawn graphique.

Pendant cette très courte capture, le vol et le vieillissement du papillon
sont suspendus afin que deux systèmes ne déplacent pas la même proie. Si
l’attaque est annulée avant consommation, il est relâché proprement et reprend
son cycle adulte.

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
- **Distance de vue**, **Angle de vue**, **Accélération de fuite** et **Analyse menace** règlent la perception du caméléon ;
- **Zone du sélectionné** dessine la vision du seul papillon inspecté ;
- **Teinte** colore le modèle tout en conservant son atlas et son éclairage ;
- **Projeter les ombres** et **Recevoir les ombres** règlent indépendamment sa contribution aux ombres de la scène.

Le modèle animé n’est chargé que lorsque Pollinisateurs et Papillons sont tous deux actifs. Une partie lancée avec les papillons désactivés évite donc ce coût ; une activation ultérieure les charge une seule fois en arrière-plan.

## Ce que la simulation ne représente pas encore

Les stades immatures sont des états logiques : aucune chenille ne rampe, aucune chrysalide ne s’accroche et aucun œuf n’est placé sur une plante. Accouplement, espèces, plantes hôtes et migration ne sont pas modélisés. Le caméléon est le seul prédateur. Les adultes l’évitent quand ils le perçoivent, mais ils n’évitent pas encore physiquement les branches, les autres insectes ou les obstacles du décor.

Le système cherche surtout à rendre un cycle simple, compréhensible, reproductible et peu coûteux. Les durées accélérées et les décisions ne doivent pas être interprétées comme une prédiction scientifique d’une espèce réelle.
