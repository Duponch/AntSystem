# Stratégie de tests

La qualité repose sur plusieurs oracles complémentaires. Aucun test isolé ne démontre qu’une fourmi ne pourra jamais se bloquer ; chaque couche réduit une classe de risques identifiable.

## 1. Contrats purs Node

Commande :

```powershell
npm test
```

La suite couvre notamment :

- `COL-ECO` : couches autoritatives du grenier, de la reine et du couvain ;
- `COL-START` : placement, rôles, délais et mode historique ;
- `NAV-SURFACE` : repères transportés, projection sur la surface propre, supports, pistes, portails, planchers, mutations atomiques et résolution physique du volume ;
- `NAV-ENTRANCE` : continuité de l’anneau, trou raycastable, rayon partagé, lèvre physique continue, placement périphérique et raccord borné ;
- `OBS` : intentions, arrêts attendus, détection d’immobilité, pause à vitesse nulle, distances monde et reset temporel ;
- réseau de corridors : déterminisme, routage, budget résiduel multi-arêtes, invariance au découpage temporel, continuité, profondeur, limites, croissance append-only et complexité structurelle ;
- bake parallèle : partition équilibrée, fusion bit-identique, transfert unique des buffers, fallback synchrone et terminaison des workers ;
- transactions : FIFO, rejet avant publication, commit unique, pause minimale et équivalence binaire du candidat Worker ;
- `NEST-LAYOUT-001` à `NEST-LAYOUT-004` : registre complet et append-only, lecture du parent bake, entrée périphérique, détours contenus entre collerettes et séparation exhaustive avec au moins 0,4 unité de terre entre chambres/tunnels étrangers pour la matrice profondeurs 19/20/22/24 × largeurs 5,5/6/12 ;
- `NEST-NATURAL-001` à `NEST-NATURAL-006` : bake versionné de 96 fiches, déterminisme et préfixes K24/K96, arbre binaire enraciné avec bifurcations/feuilles/profondeur, variété des longueurs sans gabarit répété de quatre unités, proportion et tailles distinctes des vestibules et chambres en conservant les quatre fonctions fondatrices, puis gel profond et empreinte SHA-256 du registre relu ;
- `NEST-ORGANIC-001` à `NEST-ORGANIC-005` : couverture angulaire, rotations dans les deux sens et rareté des angles droits, puis trois lobes bornés, sinuosité visible mais limitée, rayons lisses sans perte de clearance et cohérence des profondeurs.

`COLONY-TROUGH-001/002` et `COLONY-BROOD-001` empêchent le rendu et les échanges de dériver vers une nappe superposée. `NAV-SURFACE-001` à `006` couvrent les repères, tables directes, contact SDF, portails et chambres. `NAV-SURFACE-007` borne le stretch ; `NAV-SURFACE-008` ajoute la campagne exhaustive K96 × 12 sur les supports, tangentes CPU/GPU, progression et contact. `NAV-SURFACE-PERF-001` protège la clé spatiale 48 bits. `NAV-SURFACE-PAR-001` à `004` protègent la partition et la fusion exactes ainsi que les chemins de fallback et d’erreur. `NAV-NEST-TXN-001` à `004` et `NAV-NEST-PAUSE-001/002` protègent la file de mutations, la publication atomique et la courte barrière GPU. `NAV-ENTRANCE-005` aligne toute la bouche sur `y = 0`; `NAV-ENTRANCE-006` à `009` couvrent grand pas, tangence, confinement extérieur et émergence. `NAV-VOLUME-001/002` protègent l’intervalle `[19, 24]` et la migration des paramètres : la borne basse est la première configuration exhaustive des 96 loges qui conserve 0,4 unité de terre pour toutes les largeurs 5,5..12 ; la borne haute maintient trois voxels verticaux dans le tunnel le plus fin. `NEST-NATURAL-001` à `006` empêchent le retour des séries de quatre ou la confusion entre vestibule et chambre ; `NEST-ORGANIC-001` à `005` empêchent qu’une simplification graphique désynchronise la surface physique. `NAV-VOLUME-GPU-001` à `004` protègent adressage, demi-précision et filtrage de la sonde. `OBS-PAUSE-001` et `OBS-DIST-001` protègent la sémantique de l’inspecteur.

La documentation ne fige volontairement pas le nombre total de tests. Le nom, le contenu et le hash des fichiers de preuve contractuels sont suivis par `docs-sync`.

## 2. Build WebGPU/TSL

```powershell
npm run build
```

Le build détecte les imports, la syntaxe et une partie des erreurs d’assemblage. Il ne compile pas nécessairement toutes les branches TSL sur un GPU réel.

## 3. Tests fonctionnels GPU de colonie

Démarrer Vite puis ouvrir `?test=colony`, ou lancer `await __antsys.tests.run()` dans la console. Ces scénarios exercent sur GPU réel :

- T1 : démarrage naturel `COL-START` ;
- T2 et T3 : ponte, développement et croissance `COL-ECO` ;
- T4 : confinement souterrain ;
- T5 : livraison au grenier ;
- T6 : famine ;
- T7 : pinceau et réseau creusé ;
- T8 : mode historique ;
- T9 : échantillonnage des prédateurs limité aux vivantes de surface ;
- T10 : bascule colonie ON→OFF→ON et demandes rapides sérialisées, sans population hybride.

Les assertions biologiques stochastiques utilisent des bornes. Elles ne remplacent pas les invariants géométriques exacts.

## 4. Warden

Démarrer Vite puis ouvrir, par exemple :

```text
http://localhost:5173/?test=warden&wdur=120
```

Ou lancer `await __antsys.warden.run({ seconds: 120 })`. Le Warden avance la simulation manuellement à 60 Hz et échoue dès qu’une anomalie structurelle est comptée.

Ses oracles couvrent :

- dépassement de la distance cinématique 3D et warp XZ ;
- divergence de corridor ou de nappe ;
- toupie, blocage, sortie du volume, retour surface indésirable et mort corrélée ;
- `posesNonFinies` : position, quaternion, métadonnées ou repère attendu non finis ;
- `pivotsHorsSupport` : erreur latérale, hauteur du pivot ou échelle incompatible avec le contact ;
- `orientationsHorsRepere` : quaternion non unitaire ou axes haut/avant incompatibles avec la normale et la tangente attendues ;
- `NAV-VOLUME-GPU-001` : lecture réelle de contacts corridors/chambres dans le canal SDF RGBA16F téléversé.

La passe de contrôle lit le buffer produit par `kPose`, puis reconstruit le contact attendu depuis l’état intrinsèque et les deux textures précalculées. Elle vérifie donc le câblage et la transformation finale ; l’oracle SDF Node reste indépendant pour la géométrie de paroi. La sonde volumique lit huit texels par point et reproduit leur interpolation trilinéaire afin de vérifier zéro à la surface, air négatif et terre positive.

Les transitions surface/sous-sol ne sont pas exemptées de la borne cinématique : le contact exact et le budget résiduel font partie du déplacement mesuré. `NAV-ENTRANCE-RUNTIME-001` force déterministement une sortie et une entrée en 0,5 seconde. Le champ global `report.pass` exige les unités Warden, tous les scénarios, cette couverture aller-retour et la sonde volumique.

Les scénarios couvrent notamment profondeur extrême, tunnels étroits/larges, famine, capacité maximale et croissance append-only en trajet. Les kernels, buffers et readbacks Warden ne sont pas utilisés pendant le jeu normal.

## 5. Inspection ciblée

L’inspecteur `OBS` permet de suivre un identifiant précis, sa destination, son corridor, sa progression, sa vitesse mesurée et la raison d’un arrêt. Il sert à expliquer un échec mais ne remplace pas l’oracle automatisé.

## Garde documentaire

```powershell
npm run docs:check
```

Le contrôle valide :

- les documents requis et les liens locaux ;
- les six guides UI, leur frontmatter, leur ordre et leurs contrats ;
- les titres canoniques et les preuves nommées Node ou runtime ;
- l’appartenance de chaque source `src/navigation/*.js` à un contrat ;
- les hashes normalisés des documents, sources, tests et campagnes runtime.

Toute modification d’une source surveillée fait dériver le manifeste et impose une relecture explicite des tests et documents associés. `docs:sync` enregistre cette nouvelle version ; il ne prétend pas remplacer la validation sémantique humaine.

Après un changement intentionnel d’un contrat :

1. mettre à jour source, tests et document canonique ;
2. exécuter `npm test` et les campagnes GPU concernées ;
3. relire tous les guides UI associés ;
4. lancer `npm run docs:sync` ;
5. terminer par `npm run check`.
