---
title: Caméléon et prédation
order: 61
summary: Comprendre la marche sur tronc, la détection des papillons et chaque phase d’une attaque.
contracts: CHAMELEON-SIM
---

# Caméléon et prédation

Le caméléon vit à la surface sur un **tronc couché**. Il ne parcourt pas toute
la carte : il se repose, avance lentement sur le relief du bois et surveille
les papillons adultes qui passent à proximité. Cette limitation est à la fois
naturelle, lisible et très peu coûteuse.

## Ce qu’il fait quand il semble immobile

Un arrêt n’est pas forcément un blocage :

- `REST_SCAN` : il observe avant de repartir ;
- `TRACK_PREY` : il suit un papillon et cherche le meilleur point sur le tronc ;
- `AIM_AND_BRACE` : il fixe la proie, stabilise ses pattes et prépare la langue ;
- `COOLDOWN` : il récupère après une attaque.

En l’absence de papillon accessible, `PATROL_LOG` le fait marcher d’une
extrémité à l’autre. Il inverse sa direction sans quitter le support.

## Déroulement d’une attaque

1. Le caméléon ne considère que les papillons adultes, visibles et libres.
2. Il rejoint sur le tronc le point le plus proche de la proie.
3. Si le papillon entre dans la **distance d’attaque**, le caméléon le suit
   encore des yeux pendant la visée.
4. Au départ de la langue, le point visé est figé : la langue ne triche pas en
   corrigeant sa trajectoire en plein vol.
5. La capture exige un contact réel entre la langue et le papillon.
6. En cas de contact, le papillon reste collé au bout de la langue pendant une
   rétraction continue.
7. Le papillon ne disparaît que lorsqu’il entre effectivement dans la bouche.

Une langue qui rate sa cible revient donc normalement, sans téléporter ni
supprimer le papillon.

## Réglages

Ouvrez **Graphismes → 🦎 Caméléon** :

- **Activer le caméléon** charge et anime l’animal ;
- **Taille** règle son échelle visuelle sur le tronc ;
- **Vitesse de marche** règle sa patrouille lorsqu’il explore le tronc ;
- **Vitesse de poursuite** règle son approche lorsqu’un papillon est repéré ;
- **Réactivité orientation** règle la vitesse à laquelle son corps se tourne ;
- **Distance de détection** définit quand il commence à suivre une proie ;
- **Distance d’attaque** définit la portée maximale depuis la bouche ;
- **Préparation attaque** rend la visée plus prudente ou plus vive ;
- **Rétraction langue** règle la durée du retour continu de la langue ;
- **Repos après attaque** règle l’attente minimale entre deux attaques ;
- **Projeter les ombres** et **Recevoir les ombres** sont indépendants.

Les ombres de l’abeille, du papillon et de la ruche possèdent également leurs
propres commandes de projection et de réception. Désactiver une réception
d’ombre ne désactive pas la lumière du matériau ; désactiver une projection
retire seulement l’objet de la passe qui écrit les ombres.

## Pourquoi le mouvement reste léger

Il n’existe ni navmesh général, ni physique de corde, ni recherche illimitée.
Le dessus du tronc est échantillonné une seule fois en 32 points. Le caméléon
se déplace ensuite sur cette petite piste, et inspecte au maximum 64 papillons
à une cadence de 8 à 10 fois par seconde. La langue suit une trajectoire
analytique et un seul squelette glTF est animé.

Quand la caméra descend sous terre, le caméléon et sa logique de surface sont
masqués avec les autres animaux extérieurs.
