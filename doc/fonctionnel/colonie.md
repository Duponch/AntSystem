# Colonie, castes et cycle de vie

<a id="col-eco"></a>
## COL-ECO — Écosystème cohérent et observable

La simulation distingue le fourragement de surface, la vie souterraine et le cycle démographique. Les comportements sont produits par des règles partagées et des états GPU ; leurs résultats globaux restent stochastiques, mais leur chaîne causale doit rester explicable.

## Castes

| Caste | Fonction principale | Comportements visibles |
|---|---|---|
| Reine | Maintenir la reproduction | Reste dans la chambre royale, se nourrit, récupère de l’énergie et pond quand les seuils le permettent. |
| Ouvrière | Collecter et transporter | Explore la surface, ramasse une ressource, rejoint la bouche du nid et la dépose au grenier. |
| Soldate | Défendre la colonie | Patrouille, répond à l’alarme et attaque les prédateurs à portée. |
| Nourrice | Assurer la logistique interne | Démarre près du couvain, prend au grenier et ravitaille la reine ou le couvain. |
| Éclaireuse | Étendre l’exploration | Accorde davantage de poids à l’errance et moins aux pistes déjà établies. |

La caste est déterministe pour un identifiant et les ratios actifs. Elle ne nécessite pas de chemin privé ni de machine de navigation allouée par fourmi.

## Cycle de vie

1. Une reine suffisamment nourrie et ayant attendu son intervalle de ponte crée un œuf.
2. L’œuf progresse vers le stade larvaire.
3. La larve consomme des unités livrées à la mangeoire du couvain ; sans repas pendant trop longtemps, elle peut mourir.
4. Une larve suffisamment nourrie devient nymphe.
5. La nymphe arrivée à maturité libère un emplacement de fourmi si la capacité de population le permet.
6. La nouvelle fourmi apparaît au couvain, attend une courte maturation, puis rejoint sa mission.

Le couvain est un pool borné. La population et les durées sont des paramètres : la documentation décrit la chaîne causale, pas un débit d’éclosion garanti.

## Nourriture et énergie

- Le grenier reçoit les livraisons de surface.
- Les mangeoires de la reine et du couvain sont alimentées depuis ce stock.
- Les fourmis dépensent de l’énergie ; une fourmi affamée privilégie le retour pour manger.
- La reine ne peut maintenir la ponte sans ravitaillement.
- Une famine est donc un état fonctionnel observable, pas automatiquement un défaut de navigation.

## Ancres physiques des ressources

Le grenier, la mangeoire royale et le couvain possèdent chacun une position, une cellule d’échange, une nappe et une profondeur autoritatives. Un étage superposé ne peut donc ni déplacer visuellement un tas de nourriture, ni autoriser une livraison depuis la mauvaise cavité. Une croissance ou reconstruction du nid rafraîchit les trois ancres dans une seule publication.

Le transport des œufs entre reine et couvain reste une abstraction logistique ; leur hauteur visuelle suit explicitement l’ancre royale puis celle du couvain, jamais la cavité arbitrairement la plus profonde de la colonne.

## Menaces et attentes

Les araignées n’échantillonnent que les fourmis vivantes de surface. Une alarme peut détourner une mission, faire fuir une ouvrière ou attirer une soldate. Sous terre, plusieurs individus peuvent partager le même grenier, couvain, siège ou portail sans qu’un évitement corps-à-corps complet soit calculé.

Une attente expliquée par l’activation, le repos, un stock vide ou un état terminal est normale. Une immobilité active, durable et sans raison reconnue appartient au contrat `OBS` et doit être signalée.

## Démarrage et observation

Le placement initial est défini par le contrat [`COL-START`](./demarrage-naturel.md#col-start). Les raisons d’un déplacement ou d’un arrêt sont définies par [`OBS`](./intentions-et-arrets.md#obs).

Les preuves runtime T2, T3, T5, T6 et T9 couvrent respectivement la ponte, la croissance, la livraison, la famine et la sélection des proies de surface. Les tests Warden gardent leur propre fenêtre longue pour détecter les anomalies structurelles.

## Modes temporels

Toutes les durées fonctionnelles — déplacement, repos, faim, ponte, développement du couvain, butinage, métamorphose et prédation — consomment le même temps simulé effectif. En mode fluide par défaut, ce temps suit l’image à `×1`, puis est découpé au-dessus de `×1` en un à huit sous-pas bornés à `1/30 s`. Un surplus hors budget n’est pas différé : il est comptabilisé comme non simulé et réduit explicitement la vitesse effective. Les pontes utilisent toujours un ordinal et la graine de partie pour placer les œufs, et les éclosions au-delà du plafond restent en attente.

En mode fluide, les lectures GPU sont opportunistes et coalescées : la colonie réagit au dernier snapshot disponible sans bloquer les images. La publication des œufs, l’initialisation de nouveaux slots et la croissance restent sérialisées ; reset, toggle et mutation du nid forment toujours une transaction atomique.

Le mode strict est l’oracle reproductible. Il utilise des ticks de `1/120 s`, attend des statistiques fraîches aux frontières exactes et conserve toute dette de calcul. À graine et actions identiques, deux exécutions strictes arrêtées au même tick ont le même état ; cette identité bit à bit n’est pas une promesse du mode fluide.
