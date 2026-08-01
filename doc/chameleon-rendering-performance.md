# Caméléon — intégrité de peau et stratégie de rendu

## Diagnostic des « micro-trous »

Le modèle physique conserve exactement la géométrie source : 25 002 sommets,
50 000 triangles, une seule composante fermée et aucune arête de bord. Le rendu
low-poly oblige toutefois l’exporteur glTF à dupliquer les sommets par coin de
triangle afin de conserver les normales plates. Ces duplications ne sont pas
des fissures : pour une même position, leurs indices d’os et leurs poids sont
strictement identiques. Elles produisent donc la même position après skinning.

Les défauts visibles pendant une articulation très forte ont deux causes
différentes :

- une inversion ou une auto-intersection de triangles sous linear-blend
  skinning (LBS), qui doit être empêchée principalement par les limites
  anatomiques du solveur runtime ;
- une ancienne rupture de gradient à la jonction corps/queue. Le premier anneau
  de la queue suivait presque entièrement `tail_01`, alors que l’anneau voisin
  suivait le bassin, le rachis et les hanches. La flexion étirait fortement les
  triangles entre ces deux anneaux.

Le contrat mesh/rig `3.6.0` corrige la seconde cause sans toucher à la forme
originale :

- les positions, triangles et 7 206 sommets de queue restent bit-à-bit
  identiques ;
- aucun sommet du corps ne reçoit de poids `tail_*` et le garde sacré voisin est
  ramené progressivement vers le bassin ;
- seul `tail_01` forme le collet rigide ; `tail_02` est la racine dynamique ;
- les poids dynamiques commencent à `0,055` de la distance géodésique puis
  apparaissent avec un feather lisse sur `0,18`. Ce gradient de mouvement reste
  distinct du mélange protecteur avec le bassin sur les 28 % proximaux ;
- chaque sommet reste limité à quatre influences et garde au moins un os de la
  chaîne de queue ;
- le matériau exporté est explicitement double face, afin qu’un bref retournement
  de triangle ne ressemble pas à une perforation noire ;
- l’aperçu Blender utilise le même modèle LBS que glTF/Three.js. Le mode
  « preserve volume » de Blender est volontairement désactivé car son skinning
  dual-quaternion n’est pas exporté et donnait une fausse impression de parité.

`CHAMELEON-PHYSICAL-ASSET-003` reconstruit la topologie soudée depuis le GLB,
vérifie les 75 000 arêtes fermées, l’absence de triangle dégénéré et l’identité
des données de skinning de tous les coins dupliqués.

## LOD pour une population de caméléons

Le contact exact et le VAT ne répondent pas au même besoin. Un caméléon proche,
sélectionné ou manipulé doit conserver son IK unique ; un sujet lointain ne doit
pas payer ce coût.

| Niveau | Usage | Géométrie et animation | Physique |
|---|---|---|---|
| LOD 0 | sélection, saisie, gros plan | mesh exact 50 k triangles, IK et queue XPBD à pleine fréquence | corps racine + contacts complets |
| LOD 1 | distance moyenne | mesh décimé 12–18 k triangles, même squelette, pose calculée à fréquence réduite puis interpolée | corps racine, contacts regroupés |
| LOD 2 | arrière-plan | mesh 2–4 k triangles, skinning instancié WebGPU ou poses/VAT de marche et repos | racine seule, projection de hauteur amortie |
| Imposteur | quelques pixels | sprite orienté ou silhouette très basse définition | aucune requête de membre |

La sélection se fait par taille projetée à l’écran, avec deux seuils différents
pour monter et descendre de niveau afin d’éviter les oscillations. Un sujet
sélectionné, attaquant, agrippé ou franchissant deux surfaces reste en LOD 0.
Les ombres ont leur propre LOD : capsule ou silhouette simplifiée à moyenne
distance, puis suppression avant l’imposteur.

Pour LOD 1 et 2, les matrices d’os sont regroupées dans un buffer partagé et les
individus utilisent un rendu instancié. Three.js fournit déjà les briques de
référence [WebGPU skinning instancing](https://threejs.org/examples/webgpu_skinning_instancing.html)
et [WebGPU instance mesh](https://threejs.org/examples/webgpu_instance_mesh.html).
Un VAT est pertinent pour les cycles lointains, mais pas pour les appuis proches :
une texture de poses ne peut pas épouser deux surfaces propres à chaque animal.

## Règles de budget

- aucune allocation par frame dans l’IK, la queue ou le choix de LOD ;
- aucune réécriture de vertex buffer : seules les matrices/poses compactes sont
  mises à jour ;
- la queue publie ses os une seule fois de la racine vers la pointe, puis propage
  la hiérarchie une fois ; aucune mise à jour récursive des descendants par os ;
- cadence des contacts proportionnelle à la visibilité, jamais au FPS écran ;
- frustum culling et occlusion avant toute mise à jour anatomique ;
- mesure séparée des coûts CPU solveur, upload de poses, GPU skinning et ombres.

Cette architecture garde la qualité anatomique sur le sujet observé et rend le
coût des autres caméléons essentiellement proportionnel au nombre réellement
visible et à leur taille à l’écran.
