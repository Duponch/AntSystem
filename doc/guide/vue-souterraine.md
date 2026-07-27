---
title: Vue souterraine
order: 55
summary: Entrer dans la terre, lire les strates et distinguer excavation visuelle et scanner.
contracts: UNDERGROUND-VISUAL
---

# Vue souterraine

## Entrer sous terre

Descendez la caméra sous le niveau du sol tout en restant à l’intérieur de la carte. La bascule se produit dès que la caméra entre dans le bloc de terre : le paysage de surface disparaît et la matière souterraine le remplace dans la même image. Être sous `y = 0` à côté de la carte ou plus bas que le fond du bloc ne déclenche pas cette vue.

Le paysage de surface bascule sans fondu. L’excavation, elle, s’ouvre brièvement de 42 % à son rayon complet pour éviter une apparition sèche. La caméra est mise à jour avant le test de plongée, de sorte que le décor affiché correspond toujours à sa position de la frame courante.

## Ce que montre la profondeur

- Près de la surface, l’humus sombre et la terre végétale contiennent l’essentiel des racines.
- Plus bas apparaissent l’argile puis une couche ocre. Les mottes reprennent la couleur de leur strate, tandis que les roches restent réparties dans toute l’épaisseur.
- Au fond, la roche-mère devient dominante. Les racines ne descendent pas jusque-là.
- Une poussière légère reste concentrée autour de la caméra pour donner l’échelle de la cavité.

Les limites entre couches sont légèrement irrégulières : elles suivent la profondeur du monde, pas l’écran ni l’orientation de la caméra.

## Une excavation uniquement visuelle

La bulle autour de la caméra ouvre la matière pour rendre les strates lisibles. Elle ne creuse pas le nid, ne crée aucun tunnel et ne modifie ni les collisions ni les trajets des fourmis. Déplacer la caméra déplace simplement cette fenêtre visuelle ; rien n’est enregistré dans la simulation.

Les vraies galeries restent définies par le volume physique du nid. Elles se composent avec l’excavation locale, mais conservent leur forme et leur fonctionnement propres.

## Scanner indépendant

La case **📡 Vue scanner** ajoute l’hologramme du nid lorsque la caméra est sous terre et que la colonie existe. Le scanner révèle le réseau, les fourmis souterraines, le couvain et les stocks avec leurs couleurs dédiées.

Désactiver le scanner ne quitte pas la vue souterraine : les strates, racines, roches et poussières restent visibles. Inversement, le scanner ne peut pas forcer la plongée lorsque la caméra est hors du bloc de terre.

## Réglages utiles

Dans **👑 Fourmilière & castes → 🔍 Sous-sol & matière** :

- **Rayon d’excavation** règle la fenêtre entre 6 et 10 unités ; la borne haute évite l’apparition brutale du décor périodique ;
- **Relief de la terre** accentue ou atténue les irrégularités de la coque ;
- **Contraste des strates** sépare davantage ou rapproche les couleurs géologiques ;
- **Poussière** règle la densité visible des particules ;
- **Lampe frontale**, **Occlusion**, **Galeries en transparence**, **Fusion des cavités** et **Irrégularité des parois** règlent la lecture du nid.

Au chargement d’une ancienne sauvegarde, ces quatre valeurs sont automatiquement ramenées dans leurs bornes sûres : rayon 6–10, relief 0–1,8, contraste 0,6–1,4 et poussière 0–1. Le dossier **📡 Scanner** règle séparément l’intensité, l’impulsion et les couleurs de l’hologramme.
