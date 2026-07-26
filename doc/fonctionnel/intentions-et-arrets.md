# Intentions et arrêts

<a id="obs"></a>
## OBS — Une observation explique sans piloter

L’inspecteur de fourmi transforme la télémétrie brute en une intention, une destination, une raison et un état de mouvement compréhensibles. Il ne modifie ni la route, ni la vitesse, ni les décisions de la simulation.

## État réel contextualisé

Le champ **État réel** n’affiche plus seulement la valeur brute « exploration/transport ». Il choisit le contexte le plus utile selon une priorité stable : état terminal, pause globale, activation, repos, reine, transport, souterrain, puis surface.

| Libellé | Condition et signification |
|---|---|
| **Simulation en pause** | Le temps global est suspendu par l’utilisateur. L’immobilité et l’absence de reprise sont normales jusqu’à la relance. |
| **Activation initiale** | Fourmi vivante dont le délai `COL-START` n’est pas terminé. Son intention indique quand elle reprendra. |
| **Repos** | Fourmi vivante non reine pendant une pause biologique programmée. |
| **Cycle royal** | Reine vivante après son activation. L’intention précise si elle attend, mange, récupère ou suit son cycle de ponte. |
| **Transport** | Fourmi vivante qui porte une ressource, y compris pendant son trajet souterrain. |
| **Navigation souterraine** | Fourmi vivante non reine, sans charge, actuellement dans le réseau du nid. Le corridor, le nœud et l’objectif détaillent sa route. |
| **Exploration** | Fourmi vivante non reine, sans charge, actuellement à la surface. Son intention peut être chercher, rentrer, patrouiller ou attaquer. |
| **Cadavre** / **Dévorée** | États terminaux. Aucun mouvement ni reprise n’est attendu. |

Ce libellé décrit le contexte global, pas l’action exacte. Il doit toujours être lu avec **Intention**, **Objectif**, **Mouvement réel** et **Explication**.

## Intentions exposées

| Contexte | Exemples d’intention |
|---|---|
| Surface | Chercher de la nourriture, rapporter une charge, rentrer manger, patrouiller ou attaquer. |
| Sous terre | Rejoindre le grenier, ravitailler la reine ou le couvain, remonter à la surface. |
| Reine | Attendre un ravitaillement, se nourrir, récupérer ou suivre le cycle de ponte. |
| État terminal | Morte ou dévorée ; aucun déplacement n’est attendu. |

Sous terre, l’inspecteur affiche le corridor et sa progression lorsqu’une arête est active, ou le nœud sûr traversé entre deux corridors. La destination affichée vient de l’objectif réel de la fourmi.

La distance de route est accumulée dans la grille GPU mais convertie avec `TEXEL` avant affichage : la valeur `u` montrée par l’inspecteur est toujours une unité monde.

## Arrêts attendus

Un arrêt est explicitement normal dans les cas suivants :

- simulation globalement en pause, soit par la case **Pause**, soit par une vitesse réglée à `×0` ; ces intervalles sont exclus du chronomètre d’immobilité ;
- repos biologique programmé, avec temps restant ;
- attente au grenier vide pour une nourrice ou une fourmi affamée arrivée à destination ;
- mort ou disparition ;
- attente d’activation définie par `COL-START`.

Les attentes de stock et de repos n’annulent pas la route. Dès que leur condition disparaît, la fourmi reprend à partir du même état intrinsèque.

## Immobilité suspecte

Le suivi temporel tolère le bruit de position et ne cumule l’immobilité que pour la même fourmi sélectionnée. Un mouvement significatif remet la durée à zéro ; un changement de sélection ou un timestamp non monotone ne peut pas transmettre l’historique d’un autre individu.

Par défaut, l’interface qualifie de suspect un arrêt actif inexpliqué après environ deux secondes. Ce seuil d’observation rapide est distinct de la fenêtre de huit secondes du Warden, qui recherche un blocage structurel pendant une campagne GPU.

Les classifications d’intention sont couvertes par `test/ant-observer.intent.test.js`; l’accumulation et le reset temporels par `test/ant-observer.motion.test.js`.
