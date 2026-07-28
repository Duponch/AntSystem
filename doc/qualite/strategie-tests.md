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
- `BEE-SIM` : cycle de butinage complet, déterminisme, météo, démographie agrégée, cohortes et recyclage stables, continuité de phase par clip, ciblage borné, vues SoA, layout/GLB/VAT bornés, draws fixes et boucle chaude sans allocation ;
- `BUTTERFLY-SIM` : cycle œuf→larve→chrysalide→adulte→œuf, immatures invisibles, activité adulte, météo indépendante du vieillissement, ciblage de quatre fleurs, SoA fixe, asset/clip/VAT, draw unique, chargement paresseux et réglages UI ;
- `UNDERGROUND-VISUAL` : palette volumique configurable, plongée bornée au bloc, excavation visuelle indépendante, pools périodiques déterministes, suppression de la poussière, chargement unique des GLB, masque SDF propre et budgets fixes ;
- `OBS` : intentions, arrêts attendus, détection d’immobilité, pause à vitesse nulle, distances monde et reset temporel ;
- réseau de corridors : déterminisme, routage, budget résiduel multi-arêtes, invariance au découpage temporel, continuité, profondeur, limites, croissance append-only et complexité structurelle ;
- bake parallèle : partition équilibrée, fusion bit-identique, transfert unique des buffers, fallback synchrone et terminaison des workers ;
- transactions : FIFO, rejet avant publication, commit unique, pause minimale et équivalence binaire du candidat Worker ;
- `NEST-LAYOUT-001` à `NEST-LAYOUT-004` : registre complet et append-only, lecture du parent bake, entrée périphérique, détours contenus entre collerettes et séparation exhaustive avec au moins 0,4 unité de terre entre chambres/tunnels étrangers pour la matrice profondeurs 19/20/22/24 × largeurs 5,5/6/12 ;
- `NEST-NATURAL-001` à `NEST-NATURAL-006` : bake versionné de 96 fiches, déterminisme et préfixes K24/K96, arbre binaire enraciné avec bifurcations/feuilles/profondeur, variété des longueurs sans gabarit répété de quatre unités, proportion et tailles distinctes des vestibules et chambres en conservant les quatre fonctions fondatrices, puis gel profond et empreinte SHA-256 du registre relu ;
- `NEST-ORGANIC-001` à `NEST-ORGANIC-005` : couverture angulaire, rotations dans les deux sens et rareté des angles droits, puis trois lobes bornés, sinuosité visible mais limitée, rayons lisses sans perte de clearance et cohérence des profondeurs.

`COLONY-TROUGH-001/002` et `COLONY-BROOD-001` empêchent le rendu et les échanges de dériver vers une nappe superposée. `NAV-SURFACE-001` à `006` couvrent les repères, tables directes, contact SDF, portails et chambres. `NAV-SURFACE-007` borne le stretch ; `NAV-SURFACE-008` ajoute la campagne exhaustive K96 × 12 sur les supports, tangentes CPU/GPU, progression et contact. `NAV-SURFACE-PERF-001` protège la clé spatiale 48 bits. `NAV-SURFACE-PAR-001` à `004` protègent la partition et la fusion exactes ainsi que les chemins de fallback et d’erreur. `NAV-NEST-TXN-001` à `004` et `NAV-NEST-PAUSE-001/002` protègent la file de mutations, la publication atomique et la courte barrière GPU. `NAV-ENTRANCE-005` aligne toute la bouche sur `y = 0`; `NAV-ENTRANCE-006` à `009` couvrent grand pas, tangence, confinement extérieur et émergence. `NAV-VOLUME-001/002` protègent l’intervalle `[19, 24]` et la migration des paramètres : la borne basse est la première configuration exhaustive des 96 loges qui conserve 0,4 unité de terre pour toutes les largeurs 5,5..12 ; la borne haute maintient trois voxels verticaux dans le tunnel le plus fin. `NEST-NATURAL-001` à `006` empêchent le retour des séries de quatre ou la confusion entre vestibule et chambre ; `NEST-ORGANIC-001` à `005` empêchent qu’une simplification graphique désynchronise la surface physique. `NAV-VOLUME-GPU-001` à `004` protègent adressage, demi-précision et filtrage de la sonde. `OBS-PAUSE-001` et `OBS-DIST-001` protègent la sémantique de l’inspecteur.

`UNDERGROUND-VISUAL-001` à `006`, puis `008` à `011` protègent les contrats stables et coûteux à casser : cinq ancres de palette, test du bloc physique, bake indépendant du nid, racines superficielles, périodicité, absence de poussière, catalogue GLB exact (`Rock.glb`, `Bone.glb`, `FishBone.glb`), candidats déterministes et tailles bornées. `VISUAL-005/006` utilisent exactement le prédicat de production `isEmbeddedInExcavationShell`, sans oracle parallèle. `UNDERGROUND-VISUAL-PERF-001` exige six draws de base et le plafond exact de 180 728 triangles ; le scanner optionnel reste un draw supplémentaire. `UNDERGROUND-TRANSITION-001` à `006` couvrent la couche caméra, les contrôles UI et la migration bornée. `UNDERGROUND-RENDER-001` à `005` inspectent l’union SDF, les invalidations, les racines atomiques, les coordonnées monde fixes des objets sans reprojection caméra, leur masque `sampleSDFClean(positionWorld)` et le chargement unique des GLB hors de la boucle de mise à jour.

`BEE-SIM-001` à `007` protègent les vues préallouées, la reproductibilité octet par octet, l’accessibilité de chacun des huit états, la livraison de nectar/pollen, l’interdiction de départ dans l’obscurité ou par météo dangereuse, les cibles fleur/parcelle directes, le budget fixe de quatre candidates, les instantanés de diagnostic et l’absence d’allocation ou de hasard ambiant dans la boucle chaude. `BEE-SIM-008` à `013` couvrent la chaîne démographique 3 + 6 + 12 jours, l’indépendance entre météo et vieillissement, la stabilité des buffers et télémétries, le coût indépendant de la population agrégée, le recyclage déterministe des représentantes et l’initialisation uniforme du couvain. `BEE-SIM-014` garantit que les états partageant `FLIGHT` conservent leur phase et qu’une vraie transition `FLIGHT` ↔ `FORAGE` la réinitialise. `POLLINATOR-001` à `009` couvrent le layout déterministe et son fallback borné, l’arbre hôte, les nœuds, clips, atlas distincts corps/yeux/ailes et couleurs de sommets des GLB, la texture VAT sous 12 Mio, les capacités/draws fixes, le masquage sous terre, les exclusions sensibles aux échelles du décor et l’absence de chargement/VAT au démarrage lorsque le système est désactivé. L’orientation visuelle du modèle, les atlas, les teintes et la composition des fleurs restent soumis à une inspection WebGPU ciblée plutôt qu’à un test de pixels.

`BUTTERFLY-SIM-001` à `009` protègent les buffers et télémétries stables, la reproductibilité, le cycle complet, le vieillissement indépendant des conditions de vol, les trois comportements adultes, les cibles et directions indexées, la capacité fixe, le diagnostic et l’absence d’allocation de collection dans la boucle chaude. `BUTTERFLY-SIM-010` à `014` figent `Butterfly.glb`, `Flight_Butterfly`, les 1 105 sommets, 528 triangles, 13 joints, 81 images à 16 fps et 716 040 octets de VAT, puis l’unique draw instancié, l’orientation et le matériau éclairé, le chargement paresseux singleton, le masque de surface et le raccordement UI/config. L’allure de la teinte et du battement reste contrôlée par inspection WebGPU plutôt que par comparaison de pixels.

Le TDD n’est pas requis pour chaque retouche artistique sans incidence sur la simulation. Couleurs par défaut, équilibre visuel des amas et absence perceptuelle de bandes sont validés par inspection WebGPU ; les tests automatisés restent réservés aux invariants de ressources, de géométrie, de transition et de performance qui préviennent une régression fonctionnelle ou structurelle.

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
- les neuf guides UI, leur frontmatter, leur ordre et leurs contrats ;
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

## Temps simulé et multiplicateurs

Les deux profils temporels ont des objectifs et des oracles distincts. Le mode fluide GPU-first, recréé par défaut à chaque session, protège la cadence, la continuité visuelle et des invariants causaux ; le mode strict protège la reproductibilité exacte au tick pour les tests et les replays. Toute campagne de transition vers strict doit commencer par le reset autoritatif transactionnel, jamais par la réutilisation directe d’un état fluide.

### Mode fluide

- `test/hybrid-time-policy.test.js` couvre la pause, l’unique passe par frame à `×1` ou moins, les nombres de sous-pas à `×4`, `×15` et `×22`, le plafond à huit sous-pas pour `×100`, et la borne `1/30 s` de chaque pas.
- `test/config-timing-session.test.js` prouve qu’une sauvegarde stricte est ignorée, que seul `?timing=strict` force la session et que `maxGpuSubsteps`, contrairement au profil, reste persistant.
- L’oracle vérifie à `10⁻¹²` près `requestedDt = consumedDt + droppedDt`. Le surplus explicite est autorisé ; une perte cachée, une dette ou un rattrapage ultérieur sont des régressions.
- Les contrats source `HYBRID-TIME-RUNTIME-*` verrouillent la branche non bloquante, la simulation regroupée des fourmis et l’unique calcul final de pose/LOD par frame.
- Les campagnes WebGPU à `×1` mesurent une pose fraîche à chaque frame, l’absence de barrière CPU/GPU autoritative et la coalescence des readbacks diagnostiques soumis après le rendu. Ces relevés peuvent avoir une frame de retard ; les campagnes comparent donc les invariants, l’ordre causal et les compteurs agrégés, pas une identité bit à bit entre FPS.

### Mode strict

- `test/simulation-clock.test.js` protège l’accumulation entière à `120 Hz`, la pause, le budget, la dette récupérable et l’absence de dérive sous plusieurs FPS avec jitter.
- `test/time-scale-ecosystem.test.js` compare aux mêmes ticks les états complets des abeilles, papillons, fleurs et du caméléon à `×1`, `×4`, `×15`, `×22` et `×100`.
- `test/readback.test.js` protège le verrou FIFO des barrières autoritatives ; le cache opportuniste du mode fluide ne remplace jamais un snapshot strict.
- `test/simulation-synchronization.test.js` prouve la sentinelle GPU non destructive, la vraie barriere de queue et l'invalidation par epoch des readbacks post-reset.
- `TIME-SCALE-RUNTIME-003` verrouille le reset transactionnel lors de la transition `fluid → strict` et le rejet des statistiques d'une ancienne generation.
- `test/spider-time.test.js` sépare les ticks des araignées de leurs uploads de rendu et protège leur PRNG.
- `test/spider-authority-readback.test.js` prouve qu’une frontière combinée passe par un unique snapshot et exactement un mapping GPU→CPU sous le verrou FIFO.
- `test/spider-kill-election.test.js` protège l’élection atomique et déterministe de la victime, le sentinel d’intervalle et l’absence de retour au buffer de position non atomique.
- `TIME-SCALE-RUNTIME-006` dans `test/time-scale-runtime.test.js` verrouille le chemin UI du toggle « Colonie vivante » : file autoritative, invalidation d’epoch, attente de barrière et arrêt des ticks via `resetPromise`.

Les campagnes WebGPU strictes comparent les compteurs de ponte, d’éclosion, de nourriture, les slots actifs et les décisions des prédateurs aux mêmes ticks de frontière. Toute lecture qui participe à cette décision doit alors venir de la barrière exacte, jamais d’un readback diagnostique best-effort.
