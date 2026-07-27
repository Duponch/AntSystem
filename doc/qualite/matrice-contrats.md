# Matrice contrats/tests

| Contrat | Exigences principales | Preuves automatiques | Validation runtime |
|---|---|---|---|
| `COL-ECO` | Castes, ponte, développement, stocks, famine et menaces suivent la même chaîne causale ; grenier, reine et couvain conservent leur couche déclarée | `COLONY-TROUGH-001/002`, `COLONY-BROOD-001`, scénarios T2, T3, T5, T6 et T9 | Campagne colonie GPU : ponte, éclosion, livraison, famine et prédateurs |
| `COL-START` | Colonie établie entièrement souterraine ; rôles cohérents ; éclosion au couvain ; mode surface explicite | `COL-START-001` à `COL-START-004` | T1 : démarrage naturel ; T10 : ON→OFF→ON et toggles sérialisés |
| `NAV-SURFACE` | Bake `natural-growth-tree-v2` de 96 fiches ; arbre binaire append-only, K24 par défaut, vestibules et chambres distincts ; 12 pistes × 144 échantillons précalculés ; géométrie CPU/GPU commune ; contact SDF direct ; supports/tangentes continus ; bake parallèle bit-identique ; mutations FIFO atomiques ; layout et volume résolus sur `[19, 24]` | `NAV-SURFACE-001` à `008`, `NEST-NATURAL-001` à `006`, `NEST-ORGANIC-001` à `005`, `NAV-SURFACE-PERF-001`, `NAV-SURFACE-PAR-001` à `004`, `NAV-NEST-TXN-001` à `004`, `NAV-NEST-PAUSE-001/002`, `NAV-VOLUME-001/002`, `NAV-VOLUME-GPU-001` à `004` | Warden : cinématique, pose/support, sonde du volume réel et scénarios structurels |
| `NAV-ENTRANCE` | Entrée périphérique ; trou physique à `y = 0` ; lèvre continue pour tout `dt` ; raccord borné ; transition conservant piste et résidu | `NAV-ENTRANCE-001` à `NAV-ENTRANCE-009` et validation exhaustive `NEST-LAYOUT` | `NAV-ENTRANCE-RUNTIME-001` force sortie+entrée ; `report.pass` exige l’aller-retour |
| `UNDERGROUND-VISUAL` | Excavation indépendante du nid ; palette 3D chaotique sans bandes franches ; poussière supprimée ; pools périodiques fixes ; `Rock.glb`, `Bone.glb` et `FishBone.glb` chargés une fois et masqués par le SDF propre ; six draws et 180 728 triangles au plafond ; profondeur, couche caméra et scanner cohérents | `UNDERGROUND-VISUAL-001` à `006`, puis `008` à `011`, `UNDERGROUND-VISUAL-PERF-001`, `UNDERGROUND-TRANSITION-001` à `006`, `UNDERGROUND-RENDER-001` à `005` | Inspection WebGPU : bascule surface/sous-sol, qualité des amas et mélanges, absence perceptuelle de bandes, matière absente des cavités réelles, fog absent et scanner optionnel |
| `OBS` | Intention réelle ; arrêts attendus ; immobilité suspecte ; pause vitesse×0 ; distances monde ; suivi temporel isolé | `OBS-START-001`, `OBS-PAUSE-001`, `OBS-DIST-001` et tests observer | Inspection d’un identifiant et traces Warden |

Le rendu artistique pur n’est pas figé par un test de pixels : les oracles Node protègent uniquement les invariants qui affectent ressources, géométrie, transitions ou performances. Palette et composition sont approuvées par inspection visuelle.

## Invariants transverses

| Domaine | Fichiers de tests Node |
|---|---|
| Déterminisme, extrémités, clearance, validation | `test/corridor-network.invariants.test.js` |
| Distance, sens inverse, résidu multi-arêtes, invariance au découpage temporel et grands pas | `test/corridor-network.routes.test.js` |
| Partition, fusion bit-identique et fallback worker | `test/corridor-surface-parallel.test.js` |
| Portails, progression, absence de warp | `test/corridor-network.continuity.test.js` |
| Formes irrégulières, étages superposés, profondeur, append-only | `test/corridor-network.regression.test.js` |
| Bake naturel versionné, préfixes K24/K96, arbre binaire profond, diversité des corridors, absence de séries de quatre, vestibules/chambres | `test/nest.natural-topology.test.js` |
| Registre append-only, parent bake, détours et matrice exhaustive de séparation | `test/nest.organic-registry.test.js` |
| Nœuds multilobés, sinuosité, rayons variables et profondeur cohérente | `test/nest.organic-layout.test.js` |
| Profondeur bornée et résolution verticale minimale | `test/nest.depth-resolution.test.js` |
| Contact propre, support, convergence, stretch et continuité K96 × 12 | `test/corridor-network.surface-contact.test.js`, `test/chamber-surface.test.js` |
| Clé spatiale numérique exacte et bornée | `test/support-geometry.spatial-hash.test.js` |
| Taille constante de l’état et deux textures partagées | `test/corridor-network.complexity.test.js` |
| Frontières d’échantillon et puits vertical | `test/corridor-network.sample-boundary.test.js`, `test/corridor-network.vertical-shaft.test.js` |
| Mutations FIFO, rollback, pause de commit et équivalence Worker | `test/nest-mutation-transaction.test.js`, `test/nest-layout-async.integration.test.js`, `test/nest-mutation-ui.test.js` |
| Adressage 3D, RGBA16F, interpolation et signes du volume | `test/nest-volume-probe.test.js`, puis sonde Warden réelle |
| Strates, bake périodique sans popping, plantes racinaires atomiques, migration des réglages, masque SDF propre, invalidations de cache, budgets et transition de couche | `test/underground-visual.test.js`, `test/underground-transition-source.test.js` |
| Couches autoritatives grenier/reine/couvain | `test/colony-layout.test.js` |
| Lèvre continue, grands pas et émergence | `test/entrance-geometry.test.js`, `test/warden-verdict.test.js` |

## Contrat de stockage NAV-SURFACE

Pour `C` capacités de corridors, `S` échantillons et 12 pistes :

- contact direct : `C × S × 12 × 4` flottants ;
- support : `C × S × 12 × 4` flottants ;
- état individuel : taille constante, sans copie de piste.

Chaque pas d’une fourmi lit deux texels voisins de chaque table. La projection SDF est interdite dans le kernel de déplacement et dans la passe de pose. Le hash spatial et les workers n’existent que pendant le bake partagé : ils ne changent pas ce coût individuel.

Le volume rendu reste `128 × 68 × 128`, avec 3 unités de marge basse et 1,7 unité de marge haute. `NAV-VOLUME-001` protège la première profondeur géométriquement faisable, 19 ; `NAV-VOLUME-002` exige au moins trois voxels verticaux dans le diamètre minimal à 24. La campagne Warden complète l’oracle analytique en lisant réellement le canal G demi-précision de ce volume sur trois corridors et deux chambres.

## Critère de livraison

Une modification d’un des six contrats est livrable lorsque :

- les tests Node associés passent ;
- le build passe ;
- le document canonique et tous les guides UI associés décrivent le comportement réel ;
- le manifeste est synchronisé ;
- les tests GPU pertinents ont été exécutés pour tout changement de kernel, texture, pose, SDF, cycle biologique ou transition surface/sous-sol.

Toute modification de la simulation doit mettre à jour dans la même livraison les tests qui prouvent le comportement et la documentation technique et fonctionnelle qui l’explique. Un changement uniquement documentaire doit également exécuter `docs:sync`, car le hash du document fait partie du manifeste.
