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
| `chameleon-assets.js` | chargement singleton et validation du GLB |
| `chameleons.js` | squelette, transitions d’animation, langue et ombres |
| `butterfly-simulation.js` | verrouillage puis consommation atomique d’un adulte |
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

## Support réel du tronc

La priorité d’ancrage est :

1. placement `Log_01` ou `Log_02` portant le tag `chameleon-host` ;
2. premier `Log_01` ;
3. premier `Log_02` ;
4. autre entrée de catalogue commençant par `Log_`.

La géométrie normalisée du tronc est lue lors de la création ou d’une révision
du décor. Le système relève le sommet de sa bande centrale sur 32 abscisses,
lisse deux fois les hauteurs, transforme les points et les normales dans le
monde puis calcule les longueurs cumulées. La boucle courante ne fait donc
aucun raycast et n’alloue aucun chemin.

Le noyau avance par longueur d’arc sur cette table. Il interpole la position,
la tangente et le repère de support, borne strictement le paramètre aux deux
extrémités et inverse la patrouille à la limite.

## Machine d’états

| État | Rôle |
|---|---|
| `REST_SCAN` | pause vigilante et première recherche |
| `PATROL_LOG` | marche bornée sur le tronc |
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
| Vitesse de marche | 0,62 | 0,05–2 |
| Vitesse de poursuite | 0,95 | 0,05–3 |
| Réactivité orientation | 6 | 1–15 |
| Distance de détection | 4,8 | 1–12 |
| Distance d’attaque | 3,2 | 0,5–8 |
| Préparation attaque | 0,55 s | 0,2–3 s |
| Rétraction langue | 0,28 s | 0,15–0,6 s |
| Repos après attaque | 1,1 s | 0,3–6 s |
| Projeter / recevoir les ombres | oui / oui | booléens indépendants |

Les setters mettent à jour le noyau existant ; ils ne rechargent ni le GLB ni
la piste du tronc.

La distance de détection interne est toujours au moins égale à la distance
d’attaque. Le réglage de portée modifie donc la décision, mais ne change ni le
plafond de 64 proies inspectées ni la cadence de scan.

## Budget

- une piste de 32 points, reconstruite uniquement après édition ou changement
  d’échelle du décor ;
- un seul squelette et un nombre de draws constant ;
- au plus 640 tests de distance par seconde à 64 papillons et 10 Hz ;
- buffers, vue et télémétrie stables ;
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
- `CHAMELEON-SIM-028` : rotation progressive vers une proie latérale, sans snap.
