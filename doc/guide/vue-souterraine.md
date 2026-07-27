---
title: Vue souterraine
order: 55
summary: Entrer dans la terre, lire sa matière organique et distinguer excavation visuelle et scanner.
contracts: UNDERGROUND-VISUAL
---

# Vue souterraine

## Entrer sous terre

Descendez la caméra sous le niveau du sol tout en restant à l’intérieur de la carte. La bascule se produit dès que la caméra entre dans le bloc de terre : le paysage de surface disparaît et la matière souterraine le remplace dans la même image. Être sous `y = 0` à côté de la carte ou plus bas que le fond du bloc ne déclenche pas cette vue.

Le paysage de surface bascule sans fondu. L’excavation, elle, s’ouvre brièvement de 42 % à son rayon complet pour éviter une apparition sèche. La caméra est mise à jour avant le test de plongée, de sorte que le décor affiché correspond toujours à sa position de la frame courante.

## Une terre organique, pas des bandes

Les cinq couleurs de référence — terre sombre, terre brune, argile, ocre et minéral clair — se mélangent dans un volume 3D. La profondeur influence la palette, mais ne dessine plus de couches horizontales nettes : les teintes forment des amas chaotiques qui se prolongent dans toutes les directions. Le grain minéral ajoute le détail local.

Les racines restent concentrées près de la surface. Des rochers, os et arêtes de poisson sont répartis dans tout le volume. La poussière a été supprimée afin de conserver une image plus nette.

Tous ces éléments sont décoratifs. Ils ne créent pas d’obstacle, ne modifient pas les galeries et n’influencent pas le comportement des fourmis.

## Une excavation uniquement visuelle

La bulle autour de la caméra ouvre la matière pour rendre le sous-sol lisible. Elle ne creuse pas le nid, ne crée aucun tunnel et ne modifie ni les collisions ni les trajets des fourmis. Déplacer la caméra déplace simplement cette fenêtre visuelle ; rien n’est enregistré dans la simulation.

Les vraies galeries restent définies par le volume physique du nid. Elles se composent avec l’excavation locale, mais conservent leur forme et leur fonctionnement propres. La terre et les objets enfouis sont masqués dans leur vide : ils ne flottent pas à l’intérieur des chambres et tunnels.

## Scanner indépendant

La case **📡 Vue scanner** ajoute l’hologramme du nid lorsque la caméra est sous terre et que la colonie existe. Le scanner révèle le réseau, les fourmis souterraines, le couvain et les stocks avec leurs couleurs dédiées.

Désactiver le scanner ne quitte pas la vue souterraine : la matière, les racines et les objets enfouis restent visibles. Inversement, le scanner ne peut pas forcer la plongée lorsque la caméra est hors du bloc de terre.

## Régler la terre organique

Dans **👑 Fourmilière & castes → 🔍 Sous-sol & matière → 🎨 Terre organique** :

- les cinq sélecteurs de couleur définissent la palette de base ;
- **Chaos des couleurs** accentue ou calme les variations tridimensionnelles ;
- **Taille des amas** agrandit ou réduit les masses colorées ;
- **Fusion des couleurs** adoucit ou resserre leurs transitions ;
- **Grain minéral** règle le détail fin ;
- **Contraste** rapproche ou éloigne les teintes.

Ces réglages sont appliqués en direct. Ils ne reconstruisent ni la fourmilière ni la navigation.

## Régler les objets enfouis

Le dossier **🪨 Objets enfouis** possède un sous-dossier pour chaque famille : **Rochers**, **Os** et **Arêtes de poisson**. Pour chacune :

- **Fréquence** règle la part du pool visible ;
- **Dimension** règle la taille moyenne ;
- **Variation** diversifie les tailles autour de cette moyenne ;
- **Couleur** teinte le matériau.

**Exposition** choisit, parmi les objets fixes que l’excavation rencontre, ceux qui dépassent le mieux de la terre (0 = davantage enfouis, 1,2 = davantage saillants). Elle ne déplace jamais un objet. Les modèles occupent des coordonnées monde déterministes et la caméra ne fait que les révéler ; ils sont chargés une seule fois puis instanciés, sans coût lié au nombre de fourmis. Les matériaux PBR conservent les normales d’origine des modèles. Une lumière directionnelle oblique suit la caméra et un faible remplissage préserve les ombres : les couleurs restent lisibles sans filtre brun et les volumes gardent un relief comparable au décor de surface.

Le fichier de l’os est `Bone.glb`. Il n’existe pas de `Bong.glb` dans le dépôt.

## Autres réglages utiles

- **Rayon d’excavation** règle la fenêtre entre 6 et 10 unités ;
- **Relief de la terre** accentue ou atténue les irrégularités de la coque ;
- **Lampe frontale**, **Occlusion**, **Galeries en transparence**, **Fusion des cavités** et **Irrégularité des parois** règlent la lecture du nid.

Les valeurs persistées sont automatiquement ramenées dans leurs bornes sûres au chargement. Le dossier **📡 Scanner** règle séparément l’intensité, l’impulsion et les couleurs de l’hologramme.
