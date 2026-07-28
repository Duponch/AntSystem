# CHAMELEON-SIM — Caméléon, support et prédation

## Portée

`CHAMELEON-SIM` ajoute un unique prédateur de surface. Le système reste séparé
de la colonie de fourmis : il consomme uniquement des papillons adultes et
n’altère ni les ressources, ni les décisions, ni le coût de navigation des
fourmis.

L’abstraction s’appuie sur la séquence naturelle documentée chez les
caméléons : fixation, stabilisation, projection balistique, adhérence,
rétraction et prise par les mâchoires. Les durées sont comprimées pour rester
observables dans le jeu. Les ordres de grandeur de projection et de rétraction
proviennent notamment des mesures de
[Wainwright et al. (1991)](https://fishlab.ucdavis.edu/wp-content/uploads/sites/397/2020/06/Wainwright-et-al-1991c.pdf).
La portée paramétrable est cohérente avec la comparaison multi-espèces
d’[Anderson (2016)](https://pmc.ncbi.nlm.nih.gov/articles/PMC4698635/).

## Architecture

| Module | Responsabilité |
|---|---|
| `chameleon-simulation.js` | noyau déterministe, machine d’états, collision et capture |
| `chameleon-track.js` | sélection du tronc et pré-calcul de son profil supérieur |
| `chameleon-surface-graph.js` | bake CSR global, surfaces, transitions, routage local et corridors actifs |
| `chameleon-assets.js` | chargement singleton et validation du GLB |
| `chameleons.js` | contrôleur de corridors, repère de surface, squelette, camouflage, langue et ombres |
| `butterfly-simulation.js` | évitement perceptif, verrouillage puis consommation atomique d’un adulte |
| `wildlife-inspector.js` | sélection ponctuelle, HUD et volumes de debug du seul animal suivi |
| `pollinators.js` | ordre d’update et chargement paresseux des systèmes liés |

Le noyau ne dépend ni de Three.js ni du renderer. Ses entrées de proies sont
des vues SoA de capacité fixe :

```text
count, x[], y[], z[], visible[], captured[],
headingX[], headingY[], headingZ[]
```

Trois callbacks stables forment la transaction de prédation :
`tryCapture(index)`, `setCapturedPosition(index, x, y, z)` et
`consume(index)`.

## Graphe global de surfaces

Le premier ancrage conserve la priorité historique :

1. placement `Log_01` ou `Log_02` portant le tag `chameleon-host` ;
2. premier `Log_01` ;
3. premier `Log_02` ;
4. autre entrée de catalogue commençant par `Log_`.

Cet ancrage définit seulement le départ et le centre du rayon autorisé. Le bake
`buildChameleonSurfaceGraph` couvre ensuite la **carte entière** et toutes les
instances reconnues, sans plafond de huit objets :

- **terrain** : grille monde dont les nœuds et segments sont rejetés lorsqu’ils
  traversent une empreinte d’obstacle ;
- **supports linéaires** : `Log_01`, `Log_02` et `Branch`, échantillonnés sur
  leur relief supérieur ;
- **rochers et souches** : `Stump_01`, `BigRock_03` et `Rock_01` à `Rock_05` ;
- **arbres verticaux** : `Tree_01`, `Tree_02`, `Tree_06`, `Tree_07` et
  `Tree_08`, suivis par une montée hélicoïdale dont la normale reste radiale ;
- **transitions** : courbes continues entre chaque surface et un portail de
  terrain dégagé de son empreinte.

Le résultat immuable est un graphe creux CSR d’au plus **8 192 nœuds**. Les
tableaux SoA stockent position, normale, type de surface et support ;
`offsets`, `edgeTo` et `edgeWeight` décrivent les arêtes bidirectionnelles. Les
empreintes réelles et des sondes intermédiaires protègent aussi les segments
de terrain : deux nœuds libres ne sont jamais reliés à travers un rocher.

`ChameleonSurfaceGraphBaker.update` est appelé sans risque depuis la boucle,
mais ne rebake qu’après une révision du décor ou la modification d’un réglage
géométrique. À état inchangé, le test de cache est O(1). Les parcours de
maillages, empreintes et sondes restent donc hors de la boucle chaude.

### Exploration locale, pas de circuit global

Le graphe global n’est jamais copié dans la simulation individuelle. À
l’arrivée au bout du corridor courant, `ChameleonSurfaceRouter.exploreNext`
choisit une courte continuation parmi les arêtes voisines. Le score conserve
l’inertie, favorise les zones peu visitées via un tableau `Uint16`, ajoute une
légère curiosité pour les supports et départage les égalités de façon
déterministe. Le rayon d’exploration est mesuré depuis l’hôte ; sa valeur par
défaut atteint les coins de la carte.

Cette succession de décisions locales permet d’explorer progressivement tout
le graphe sans imposer une destination lointaine, une ronde pré-écrite ou un
A* récurrent. `planChameleonRoute` et `routeTo` gardent un A* explicite pour le
diagnostic et une destination imposée, mais ne participent pas à
l’exploration ordinaire.

Chaque décision compile uniquement un corridor SoA actif d’au plus **384
échantillons**. Tous les angles obligatoires du chemin sont conservés ; si
nécessaire, seule la densité des subdivisions diminue. La fin d’un corridor
est exactement le début du suivant, donc un changement de branche, une montée
ou une descente ne téléporte jamais le caméléon.

### Contact et orientation

Le corps est orienté par la tangente et la normale interpolées du corridor.
Deux points de support, pris devant et derrière le centre selon la longueur du
caméléon, anticipent les courbures, les pentes et les changements de surface.
Leur moyenne définit l’axe haut ; leur différence définit l’axe avant.

Lorsqu’un corridor local se termine et que l’explorateur en choisit un nouveau,
la position et le cap courant sont conservés. Le quaternion du corps converge
ensuite vers le nouveau repère par interpolation bornée : un embranchement, une
arête de rocher ou le passage tronc→branche ne provoque donc ni demi-tour
instantané ni saut d’orientation.

Quatre contacts stables, deux à l’avant et deux à l’arrière, sont ensuite
déduits de ce repère et de la largeur du modèle. Ce sont des **cibles
approximatives de prise**, utiles au diagnostic et à la stabilité du corps :
le système ne résout pas un IK complet patte par patte. Cette approximation
assume le compromis explicite entre adhérence visuelle et coût constant.

## Machine d’états

| État | Rôle |
|---|---|
| `REST_SCAN` | pause vigilante et première recherche |
| `PATROL_LOG` | marche bornée sur le corridor de surface actif |
| `TRACK_PREY` | projection de la proie sur la piste et approche |
| `AIM_AND_BRACE` | suivi encore annulable et stabilisation du corps |
| `STRIKE_EXTEND` | point figé, extension balistique |
| `CONTACT` | adhérence courte au vrai point de collision |
| `RETRACT_WITH_PREY` | retour continu de la langue et de la proie |
| `BITE_AND_SWALLOW` | fermeture de la mâchoire et consommation |
| `COOLDOWN` | récupération avant une nouvelle recherche |

La recherche de cible fonctionne à 8–10 Hz. Elle parcourt au plus
`MAX_BUTTERFLIES = 64` entrées, utilise des distances au carré et ignore les
stades immatures, les slots invisibles et les proies déjà capturées.

## Arrêts et camouflage perceptif

Des pauses de camouflage sont planifiées de façon déterministe entre deux
attaques. Leur intervalle et leur durée sont configurables. Durant une pause,
les vitesses de patrouille et de poursuite sont mises à zéro sans déplacer le
caméléon.

Pour les papillons, le camouflage est défini par le comportement observable :
il faut qu’une **pause de camouflage planifiée** soit active, que le caméléon
soit resté pratiquement immobile pendant au moins `0,08 s` et qu’il ne soit pas
dans une phase révélatrice de projection, contact, rétraction ou déglutition.
Un repos ordinaire reste donc visible. La vue de menace stable expose alors
`camouflaged = true`. L’évitement des papillons traite immédiatement cet état
comme l’absence du prédateur ; aucune lecture de matériau ou de pixel n’entre
dans la décision. Le temps d’immobilité appartient à un verrou dédié, et non au
temps de l’état courant : l’acquisition puis la visée ne créent donc aucun
clignotement perceptif. Le verrou est remis à zéro dès `STRIKE_EXTEND`.

Pour le joueur, l’état applique une teinte de signal configurable — rouge par
défaut — et un léger renfort émissif, puis restaure exactement les couleurs du
matériau à la reprise. Ce signal visuel n’entre pas dans la décision : pour un
papillon, seul le booléen logique `camouflaged` rend le prédateur imperceptible.
Un papillon adulte vérifie la menace à une cadence configurable, **10 Hz par
défaut**. La distance, le champ de vision et l’accélération de fuite sont
paramétrables. Les scans sont déphasés entre slots, utilisent la vue compacte
du caméléon et restent bornés aux 64 emplacements fixes. Une menace visible
interrompt l’activité et produit une fuite continue, orientée à l’opposé
d’une courte prédiction de mouvement du prédateur ; aucun saut de position
n’est autorisé.

## Projection et contact

Pendant la visée, le point courant suit encore le papillon. À la libération,
une prédiction courte et bornée peut utiliser sa direction de vol, puis la
cible de frappe est immuable.

À chaque sous-pas, le segment parcouru par le bout de langue est testé contre
la sphère de la proie élargie par le rayon de langue. Ce balayage évite qu’une
extension de quelques millisecondes traverse un papillon entre deux images.

Une capture conserve l’offset constaté au contact :

```text
offset = butterflyPosition - tongueTip
butterflyPosition(t) = tongueTip(t) + offset
```

Le papillon n’est consommé qu’à l’entrée de la bouche. Un raté suit sa propre
rétraction et ne touche jamais au cycle de la proie.

## Animation Blender et rendu

`public/Chameleon.glb` contient le caméléon riggé, ses couleurs de sommets et
deux actions exactes :

- `Walk_Chameleon_Imported` ;
- `Attack_Chameleon_Imported`.

L’attaque anime le corps entier : pieds en prise, bassin, torse, queue, cou,
tête, yeux, mâchoire et déglutition. Les repères `mouth_socket` et
`capture_socket` documentent les deux extrémités fonctionnelles de la langue.

Le GLB a été exporté depuis la scène Blender de référence après ajout des os
`jaw`, `tongue_base`, `tongue_mid`, `tongue_tip`, `mouth_socket` et
`capture_socket`. Il conserve 42 os et deux clips contractuels :
`Walk_Chameleon_Imported` (2,7083 s) et `Attack_Chameleon_Imported`
(1,8333 s). L’attaque ouvre réellement la bouche, projette la langue, marque le
contact, ramène la proie et referme la mâchoire ; le corps entier accompagne
ces phases au lieu de jouer une simple translation de langue.

Un seul animal ne justifie pas une VAT ou un compute shader : un
`AnimationMixer` sur ce petit squelette coûte moins cher et permet de conserver
les sockets animés. La longueur exacte de langue reste analytique afin de
coïncider avec le point de collision réel. Le matériau PBR est éclairé et les
drapeaux `castShadow` et `receiveShadow` sont appliqués indépendamment à
chaque maillage du GLB et à la langue procédurale.

## Réglages et bornes

Le dossier **Graphismes → 🦎 Caméléon** expose :

| Réglage | Défaut | Bornes UI |
|---|---:|---:|
| Taille | 1× | 0,4–2,5× |
| Vitesse de mouvement | 1,15 | 0,05–4 |
| Vitesse de poursuite | 1,45 | 0,05–5 |
| Vitesse animation marche | 1× | 0,1–4× |
| Réactivité orientation | 6 | 1–15 |
| Explorer la carte | oui | booléen |
| Rayon d’exploration | `ceil(WORLD × √2)` | 2–diagonale monde |
| Camouflage automatique | oui | booléen |
| Signal camouflage | `#ef2b2b` | couleur |
| Intervalle camouflage | 14 s | 1–60 s |
| Camouflage min / max | 7 / 13 s | 0,5–30 / 0,5–60 s |
| Dégagement support | 0,006 | 0–0,25 |
| Distance de détection | 4,8 | 1–12 |
| Distance d’attaque | 3,2 | 0,5–8 |
| Zone attaque du sélectionné | non | booléen |
| Préparation attaque | 0,55 s | 0,2–3 s |
| Rétraction langue | 0,28 s | 0,15–0,6 s |
| Repos après attaque | 1,1 s | 0,3–6 s |
| Projeter / recevoir les ombres | oui / oui | booléens indépendants |

Les réglages de comportement mettent à jour le noyau existant sans recharger
le GLB. **Vitesse animation marche** ne multiplie que la phase visuelle du
clip de marche ; la durée et les collisions de l’attaque restent pilotées par
la machine logique. Le rayon borne les choix locaux sans rebake ; seules la
révision du décor et les options géométriques invalident le graphe global.

La distance de détection interne est toujours au moins égale à la distance
d’attaque. Le réglage de portée modifie donc la décision, mais ne change ni le
plafond de 64 proies inspectées ni la cadence de scan.

## Sélection et diagnostic

Le clic compare uniquement le raycast du maillage unique du caméléon et le
test analytique borné des papillons visibles. Il n’exécute donc aucun raycast
de population pendant la boucle normale. L’inspecteur affiche l’état, la
cible ou la capture, la classe de surface, le support et le segment courants,
la progression dans le corridor local et le camouflage.

Si **Zone attaque (sélection)** est active, une sphère de debug suit la bouche
du caméléon sélectionné. Pour un papillon sélectionné, son volume de vision
n’est créé qu’une fois et n’est affiché que si **Zone du sélectionné** est
active. Le HUD est rafraîchi à 5 Hz ; ces géométries ne sont jamais dupliquées
pour toute la population.

## Budget

- graphe CSR global plafonné à 8 192 nœuds, rebaké uniquement après révision
  du décor ou changement d’une option géométrique ;
- corridor actif plafonné à 384 échantillons et seul trajet lu à chaque pas ;
- choix d’exploration borné aux voisins lors d’une arrivée, avec compteurs de
  visite fixes ; aucun circuit global ni A* dans la routine ;
- extraction des empreintes, transitions et clearance limitée au bake ;
- un seul squelette et un nombre de draws constant ;
- au plus 640 tests de distance par seconde à 64 papillons et 10 Hz ;
- buffers, vue de menace et télémétrie stables ;
- quatre contacts de support analytiques, sans solveur IK ni raycast de frame ;
- volumes de debug et recherche de sélection actifs pour le seul individu suivi ;
- sous-pas bornés pour les frappes courtes ;
- aucun lien avec `antCount` et aucun coût proportionnel au nombre de fourmis ;
- chargement du GLB évité lorsque le caméléon est désactivé.

## Preuves de non-régression

- `CHAMELEON-SIM-001` : identités stables de la vue et de la télémétrie ;
- `CHAMELEON-SIM-002` : déterminisme à entrées identiques ;
- `CHAMELEON-SIM-003` : maintien et inversion sur une piste irrégulière ;
- `CHAMELEON-SIM-004` : aucune frappe hors portée ;
- `CHAMELEON-SIM-005` : séquence d’attaque complète et ordonnée ;
- `CHAMELEON-SIM-006` : suivi pendant la visée puis point figé ;
- `CHAMELEON-SIM-007` : contact balayé réel, raté sans capture ;
- `CHAMELEON-SIM-008` : offset conservé et rétraction continue ;
- `CHAMELEON-SIM-009` : rejet de capture atomique ;
- `CHAMELEON-SIM-010` : sélection déterministe du tronc ;
- `CHAMELEON-SIM-011` : piste SoA issue du relief ;
- `CHAMELEON-SIM-012` : décor édité et échelles pris en compte ;
- `CHAMELEON-SIM-013` : recherche 8–10 Hz strictement bornée ;
- `CHAMELEON-SIM-014` : buffers et boucle chaude stables ;
- `CHAMELEON-SIM-015` : contrat exact du GLB, du rig, des sockets et des clips ;
- `CHAMELEON-SIM-016` : attaque complète du corps, de la mâchoire et de la langue ;
- `CHAMELEON-SIM-017` : chargement singleton et clonage sûr du squelette ;
- `CHAMELEON-SIM-018` : un mixer et une langue procédurale de coût fixe ;
- `CHAMELEON-SIM-019` : reconstruction du relief uniquement sur révision ;
- `CHAMELEON-SIM-020` : visibilité et ombres indépendantes ;
- `CHAMELEON-SIM-021` : capture SoA stable et gel de la proie ;
- `CHAMELEON-SIM-022` : suivi continu de la langue et relâchement ;
- `CHAMELEON-SIM-023` : consommation dans la bouche et retour au stade œuf ;
- `CHAMELEON-SIM-024` : rejets sûrs des proies invalides ;
- `CHAMELEON-SIM-025` : réglages UI et deux drapeaux d’ombre indépendants ;
- `CHAMELEON-SIM-026` : cycle paresseux du prédateur dans la façade ;
- `CHAMELEON-SIM-027` : pont de rendu stable, flush après la prédation ;
- `CHAMELEON-SIM-028` : rotation progressive vers une proie latérale, sans snap ;
- `CHAMELEON-SIM-029` : la bouche logique suit la normale du support baké ;
- `CHAMELEON-SIM-030` : vitesses de déplacement et d’animation indépendantes ;
- `CHAMELEON-SIM-031` : remplacement continu d’un corridor terminé, sans recul,
  déplacement ni rupture de cap ;
- `CHAMELEON-SIM-032` : exploration locale réactive sans circuit et camouflage
  uniquement pendant une pause explicitement planifiée ;
- `CHAMELEON-SIM-033` : verrou de camouflage continu pendant acquisition et
  visée, puis révélation immédiate au lancement de la langue ;
- `CHAMELEON-SURFACE-001` : toutes les instances reconnues sont bakées au-delà
  des anciens plafonds de 8 supports et 512 échantillons ;
- `CHAMELEON-SURFACE-002` : corridors continus terrain→rocher→tronc→arbre,
  repères SoA normalisés et plafond actif de 384 échantillons ;
- `CHAMELEON-SURFACE-003` : nœuds et arêtes de terrain conservent la clearance
  sur la fixture de rochers adversariale ;
- `CHAMELEON-SURFACE-004` : cache de bake gouverné uniquement par révision et
  configuration géométrique ;
- `CHAMELEON-SURFACE-005` : exploration locale déterministe, continue, avec
  inertie et préférence pour les branches peu visitées ;
- `BUTTERFLY-FEAR-001` à `006` : perception, camouflage, FOV, fuite continue,
  cadence bornée, déterminisme et boucle chaude stable ;
- `WILDLIFE-INSPECTOR-001` à `003` : sélection bornée, arbitrage au clic,
  intentions, supports, menace et volumes du seul individu sélectionné.
