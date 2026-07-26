# Démarrage naturel

<a id="col-start"></a>
## COL-START — Placement et activation cohérents

Une colonie vivante ne démarre pas sous la forme d’un disque artificiel de fourmis à la surface. Elle commence comme une colonie déjà installée dans ses chambres, puis son activité reprend progressivement.

### Colonie établie

- La reine est immédiatement active dans la chambre royale, sans objectif de déplacement.
- Les nourrices commencent au nœud du couvain avec le grenier comme première mission.
- Ouvrières, soldates et éclaireuses sont distribuées de façon déterministe dans les chambres actives et commencent avec la sortie comme objectif.
- Leur activation est échelonnée sur une fenêtre déterministe de 0,75 à 9 secondes. Pendant cette attente, leur route et leur pose restent valides mais leur vitesse attendue est nulle.

La distribution dépend de l’identifiant et du registre de chambres, jamais de l’ordre d’itération. Un reset à graine identique reproduit donc la même politique de placement.

### Éclosion

Une fourmi nouvellement éclose commence au couvain. Une nourrice reçoit le grenier comme mission ; les autres castes reçoivent la sortie. La maturation est bornée entre 1,5 et 6 secondes avant le départ.

### Mode historique explicite

Lorsque la colonie vivante est désactivée, le mode `surface-only` reste disponible : les fourmis commencent à la surface, sans nœud ni objectif souterrain. Ce mode est un témoin volontaire, pas un repli silencieux après une erreur.

Changer ce mode en cours de partie est une migration explicite : OFF réinitialise toute la population en surface ; ON relance le démarrage naturel dans les chambres. Les demandes rapides sont sérialisées et le dernier mode demandé gagne, sans resets GPU concurrents ni état hybride.

### Critères d’acceptation

- Aucun membre d’une colonie établie n’est initialisé hors du nid.
- Tout nœud initial appartient au réseau actif.
- La reine, les nourrices et les autres castes reçoivent un emplacement et une mission compatibles avec leur rôle.
- Une éclosion ne téléporte pas une fourmi existante et n’hérite pas de l’état terminal de l’ancien occupant du slot.
- Les délais sont bornés et n’ajoutent aucun état de taille variable par fourmi.

Le modèle pur est `src/colony-startup.js`; le kernel GPU en reproduit les invariants lors du reset et de l’activation d’un slot. Les preuves nommées `COL-START-001` à `COL-START-004` vivent dans `test/colony-startup.test.js`.
