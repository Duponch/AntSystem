# Matrice contrats/tests

| Contrat | Exigences principales | Preuves automatiques | Validation runtime |
|---|---|---|---|
| `COL-ECO` | Castes, ponte, développement, stocks, famine et menaces suivent la même chaîne causale ; grenier, reine et couvain conservent leur couche déclarée | `COLONY-TROUGH-001/002`, `COLONY-BROOD-001`, scénarios T2, T3, T5, T6 et T9 | Campagne colonie GPU : ponte, éclosion, livraison, famine et prédateurs |
| `COL-START` | Colonie établie entièrement souterraine ; rôles cohérents ; éclosion au couvain ; mode surface explicite | `COL-START-001` à `COL-START-004` | T1 : démarrage naturel ; T10 : ON→OFF→ON et toggles sérialisés |
| `NAV-SURFACE` | Bake `natural-growth-tree-v2` de 96 fiches ; arbre binaire append-only, K24 par défaut, vestibules et chambres distincts ; 12 pistes × 144 échantillons précalculés ; géométrie CPU/GPU commune ; contact SDF direct ; supports/tangentes continus ; bake parallèle bit-identique ; mutations FIFO atomiques ; layout et volume résolus sur `[19, 24]` | `NAV-SURFACE-001` à `008`, `NEST-NATURAL-001` à `006`, `NEST-ORGANIC-001` à `005`, `NAV-SURFACE-PERF-001`, `NAV-SURFACE-PAR-001` à `004`, `NAV-NEST-TXN-001` à `004`, `NAV-NEST-PAUSE-001/002`, `NAV-VOLUME-001/002`, `NAV-VOLUME-GPU-001` à `004` | Warden : cinématique, pose/support, sonde du volume réel et scénarios structurels |
| `NAV-ENTRANCE` | Entrée périphérique ; trou physique à `y = 0` ; lèvre continue pour tout `dt` ; raccord borné ; transition conservant piste et résidu | `NAV-ENTRANCE-001` à `NAV-ENTRANCE-009` et validation exhaustive `NEST-LAYOUT` | `NAV-ENTRANCE-RUNTIME-001` force sortie+entrée ; `report.pass` exige l’aller-retour |
| `BEE-SIM` | Huit états de butinage, lumière/météo, nectar/pollen, mémoire de parcelle, reine et démographie agrégées, cohortes fixes, renouvellement des représentantes, continuité de phase par clip, SoA stable et sélection bornée à quatre fleurs | `BEE-SIM-001` à `014`, `POLLINATOR-001` à `009` | Inspection WebGPU : ruche attachée, vols, atterrissage, fondus VAT, atlas distincts, couleurs et champ instancié |
| `BUTTERFLY-SIM` | Cycle œuf→larve→chrysalide→adulte, immatures invisibles, activité adulte météo-dépendante, fleurs partagées, SoA de 64 slots, perception bornée du caméléon à 10 Hz par défaut, camouflage imperceptible et fuite continue sans téléportation | `BUTTERFLY-SIM-001` à `014`, `BUTTERFLY-FEAR-001` à `006` | Inspection WebGPU : orientation, visite florale, fuite, volume de vision du seul sélectionné, disparition/réapparition et masquage sous terre |
| `CHAMELEON-SIM` | Chasse transactionnelle ; graphe CSR global d’au plus 8 192 nœuds couvrant terrain, rochers, souches, troncs, branches, arbres verticaux et transitions ; exploration locale déterministe sans A* de routine ; corridor actif d’au plus 384 échantillons ; repère tangente/normale et quatre contacts approximatifs sans IK complet ; camouflage immobile, sélection et portée de debug | `CHAMELEON-SIM-001` à `033`, `CHAMELEON-SURFACE-001` à `005`, `WILDLIFE-INSPECTOR-001` à `003` | Inspection WebGPU : continuité terrain→rocher→tronc→arbre, orientation, exploration variée, pauses de camouflage, fuite des papillons, contact et rétraction de langue |
| `UNDERGROUND-VISUAL` | Excavation indépendante du nid ; palette 3D chaotique sans bandes franches ; poussière supprimée ; pools périodiques fixes ; `Rock.glb`, `Bone.glb` et `FishBone.glb` chargés une fois et masqués par le SDF propre ; six draws et 180 728 triangles au plafond ; profondeur, couche caméra et scanner cohérents | `UNDERGROUND-VISUAL-001` à `006`, puis `008` à `011`, `UNDERGROUND-VISUAL-PERF-001`, `UNDERGROUND-TRANSITION-001` à `006`, `UNDERGROUND-RENDER-001` à `005` | Inspection WebGPU : bascule surface/sous-sol, qualité des amas et mélanges, absence perceptuelle de bandes, matière absente des cavités réelles, fog absent et scanner optionnel |
| `OBS` | Intention réelle ; arrêts attendus ; immobilité suspecte ; pause vitesse×0 ; distances monde ; sélection exclusive fourmi/papillon/caméléon ; menace, support et camouflage lisibles ; debug limité au seul individu suivi | `OBS-START-001`, `OBS-PAUSE-001`, `OBS-DIST-001`, `WILDLIFE-INSPECTOR-001` à `003` | Inspection d’un identifiant, arbitrage au clic, volumes sélectionnés et traces Warden |

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
| Cycle de butinage, déterminisme, météo, démographie agrégée, cohortes et recyclage stables, continuité de phase par clip, ciblage borné, SoA, GLB/VAT, draws fixes et absence d’allocation chaude | `test/bee-simulation.test.js`, `test/pollinator-integration.test.js` |
| Cycle complet des papillons, déterminisme, météo indépendante du vieillissement, ciblage borné, SoA, asset/clip, VAT, chargement paresseux, UI, draw unique et évitement perceptif du caméléon | `test/butterfly-simulation.test.js`, `test/butterfly-integration.test.js`, `test/butterfly-predator-avoidance.test.js` |
| Prédation, animation, graphe global de surfaces, clearance, corridors continus, exploration locale déterministe et absence de travail géométrique dans la boucle chaude | `test/chameleon-simulation.test.js`, `test/chameleon-track.test.js`, `test/chameleon-integration.test.js`, `test/chameleon-predation.test.js`, `test/chameleon-final-integration.test.js`, `test/chameleon-facing.test.js`, `test/chameleon-surface-graph.test.js` |
| Sélection faune bornée, arbitrage du plus proche, HUD et volumes de debug du seul animal suivi | `test/wildlife-inspector.test.js` |
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

Une modification d’un des neuf contrats est livrable lorsque :

- les tests Node associés passent ;
- le build passe ;
- le document canonique et tous les guides UI associés décrivent le comportement réel ;
- le manifeste est synchronisé ;
- les tests GPU pertinents ont été exécutés pour tout changement de kernel, texture, pose, SDF, cycle biologique ou transition surface/sous-sol.

Toute modification de la simulation doit mettre à jour dans la même livraison les tests qui prouvent le comportement et la documentation technique et fonctionnelle qui l’explique. Un changement uniquement documentaire doit également exécuter `docs:sync`, car le hash du document fait partie du manifeste.

## Invariant transversal TIME-SCALE

| Garantie | Preuve automatisée |
|---|---|
| Mode fluide GPU-first au début de chaque session : non restauré/non sauvegardé, sauf override explicite `?timing=strict` ; à `0 < vitesse ≤ 1`, un pas frais par image et pose+LOD groupés | `test/config-timing-session.test.js`, `HYBRID-TIME-002`, `HYBRID-TIME-RUNTIME-001` |
| Accélération fluide bornée à huit sous-pas de `1/30 s` maximum ; `consommé + non simulé = demandé`, sans dette | `HYBRID-TIME-004` à `HYBRID-TIME-006` |
| Dispatch GPU proportionnel aux slots actifs pour comportement, pose, LOD et spawn ragdoll ; lecture centrale de grille réutilisée ; draw indirect ragdoll fusionné | `test/gpu-dispatch-budget.test.js` (`GPU-DISPATCH-001` à `003`) |
| Pause `×0` sans pas ni vieillissement ; long frame clampé et perte rendue explicite | `HYBRID-TIME-001`, `HYBRID-TIME-003`, `SIM-CLOCK-006` |
| Readbacks diagnostiques soumis après l’image visible, opportunistes, coalescés et potentiellement en retard d’une frame en fluide ; FIFO frais et barrières exactes en strict | `TIME-SCALE-RUNTIME-003`, `test/readback.test.js`, `test/simulation-synchronization.test.js` (`SIM-SYNC-001`, `SIM-STATS-001`) |
| Snapshot araignées autoritatif `uvec4` de 48 KiB, un seul mapping aux barrières coïncidentes et verrou toujours libéré | `test/spider-authority-readback.test.js` (`TIME-SCALE-RUNTIME-005`) |
| Victime d’araignée élue par `atomicMin`, plus petit slot déterministe et remise au sentinel à chaque intervalle | `test/spider-kill-election.test.js` (`SPIDER-AUTHORITY-002`) |
| Toggle « Colonie vivante » sérialisé, epoch invalidé, lecture en cours attendue et pas bloqués pendant la mutation | `test/time-scale-runtime.test.js` (`TIME-SCALE-RUNTIME-006`) |
| Transition `fluid → strict` : invalidation d’epoch, attente des lectures, blocage des pas et reset transactionnel complet avant reprise | `test/time-scale-runtime.test.js` (`TIME-SCALE-RUNTIME-003`), `test/simulation-synchronization.test.js` (`SIM-SYNC-001`, `SIM-STATS-001`) |
| Mode strict à 120 Hz : dette conservée et même état au même tick sous FPS, jitter et multiplicateurs différents | `test/simulation-clock.test.js`, `test/time-scale-ecosystem.test.js`, `test/spider-time.test.js` |

Cet invariant s’applique à tous les contrats biologiques. Le mode strict protège l’identité au tick ; le mode fluide protège le coût par image, l’ordre causal et l’honnêteté de la télémétrie. Une approximation fluide peut réduire la vitesse effective, mais ne peut ni cacher le temps non simulé ni déclencher un rattrapage ultérieur.
