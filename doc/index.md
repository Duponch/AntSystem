# Documentation AntSystem

Cette arborescence décrit le comportement actuellement attendu de la colonie et les contrats qui protègent son déplacement. Elle complète le README général sans promettre qu’aucun défaut ne pourra jamais apparaître.

## Parcours de lecture

- Fonctionnel : [colonie, castes et cycle de vie](./fonctionnel/colonie.md), [démarrage naturel](./fonctionnel/demarrage-naturel.md), [intentions et arrêts](./fonctionnel/intentions-et-arrets.md).
- Technique : [architecture](./technique/architecture.md), [navigation et contact 3D](./technique/navigation-contact-3d.md), [abeilles et pollinisateurs](./technique/pollinisateurs.md), [papillons](./technique/papillons.md), [rendu souterrain stylisé](./technique/rendu-souterrain-stylise.md), [coûts et performance](./technique/performance.md).
- Qualité : [stratégie de tests](./qualite/strategie-tests.md) et [matrice contrats/tests](./qualite/matrice-contrats.md).
- Guide intégré à l’interface : [colonie](./guide/colonie.md), [démarrage](./guide/demarrage-naturel.md), [cycle de vie et ressources](./guide/cycle-vie-ressources.md), [attentes et menaces](./guide/attentes-menaces-limites.md), [navigation](./guide/navigation-3d.md), [vue souterraine](./guide/vue-souterraine.md), [abeilles et pollinisateurs](./guide/pollinisateurs.md), [papillons](./guide/papillons.md), [inspecteur](./guide/inspecteur.md).

## Contrats stables

| ID | Garantie couverte | Référence canonique |
|---|---|---|
| `COL-ECO` | Castes, reproduction, ressources, attentes et menaces cohérentes | [Colonie](./fonctionnel/colonie.md#col-eco) |
| `COL-START` | Placement cohérent et activation échelonnée au démarrage ou à l’éclosion | [Démarrage naturel](./fonctionnel/demarrage-naturel.md#col-start) |
| `NAV-SURFACE` | Contact direct, support continu et profondeur compatible avec le volume 3D | [Navigation/contact 3D](./technique/navigation-contact-3d.md#nav-surface) |
| `NAV-ENTRANCE` | Bouche physique et transition surface/tunnel partageant la même géométrie | [Navigation/contact 3D](./technique/navigation-contact-3d.md#nav-entrance) |
| `BEE-SIM` | Butinage déterministe, démographie agrégée, météo, ressources et coût borné | [Abeilles et pollinisateurs](./technique/pollinisateurs.md#bee-sim--abeilles-et-pollinisateurs) |
| `BUTTERFLY-SIM` | Cycle accéléré déterministe, activité adulte, fleurs partagées et rendu VAT borné | [Papillons](./technique/papillons.md#butterfly-sim--cycle-de-vie-et-rendu-des-papillons) |
| `UNDERGROUND-VISUAL` | Excavation visuelle, matière 3D chaotique et objets enfouis bornés, indépendants du nid physique | [Rendu souterrain stylisé](./technique/rendu-souterrain-stylise.md#underground-visual--rendu-souterrain-stylisé) |
| `OBS` | Intentions lisibles et distinction entre arrêt attendu et immobilité suspecte | [Intentions et arrêts](./fonctionnel/intentions-et-arrets.md#obs) |

Ces identifiants sont des contrats de comportement, pas des numéros de version. Un changement qui les affecte doit mettre à jour le code, les tests et leur document canonique dans la même modification.

Pour une retouche artistique pure sans incidence sur la simulation ni sur un invariant de ressources, la validation peut rester visuelle. Les tests automatisés sont exigés lorsque le changement touche un contrat fonctionnel, une borne géométrique, une transition ou un budget de performance.

## Vérification

```powershell
npm run docs:check
npm test
npm run build
```

`npm run check` enchaîne ces trois contrôles. `npm run docs:sync` ne corrige pas la documentation : il régénère seulement [le manifeste](./manifest.json) après relecture intentionnelle des changements.

Le manifeste contient des SHA-256 normalisés de tous les Markdown de `doc/`, du générateur, ainsi que des sources, tests Node et campagnes runtime associés aux huit contrats. `docs:check` échoue si un élément dérive, si un des neuf guides disparaît, si son frontmatter devient incohérent, si un lien local casse ou si une preuve nommée est retirée.
