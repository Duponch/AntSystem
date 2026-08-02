---
title: Caméléon et prédation
order: 61
summary: Comprendre son corps physique, son exploration des surfaces, son camouflage et la chasse aux papillons.
contracts: CHAMELEON-SIM
---

# Caméléon et prédation

Le caméléon du jeu est le même animal physique que dans le laboratoire `?test`.
Il ne glisse plus sur une piste invisible : un corps soumis à Rapier porte sa
masse et ses collisions, quatre pattes cherchent de vrais appuis, le squelette
adapte la pose à ces contacts et la queue d’origine réagit passivement au décor.

Sa taille est volontairement fixe à **1×**. Le modèle, le corps physique, la
portée des griffes, les rayons de la queue et le dégagement de navigation ont
été calibrés ensemble. Une ancienne sauvegarde demandant une autre taille est
automatiquement ramenée à 1× afin de ne jamais désynchroniser peau et physique.

## Exploration autonome

Le caméléon n’a ni ronde pré-écrite ni circuit. Lorsqu’il doit explorer, il
choisit une destination sur une surface réellement accessible, exactement
comme si un joueur avait cliqué dans le laboratoire, puis suit le corridor
calculé jusqu’à elle. À l’arrivée, après une pause ou si la progression devient
insuffisante, il choisit une nouvelle destination.

Le choix favorise les supports intéressants et encore peu visités : troncs
couchés, rochers, souches, arbres et branches. Le terrain reste utilisable pour
relier ces zones. Le **Rayon d’exploration** borne cette curiosité autour du
point de départ ; **Explorer la carte** suspend uniquement les nouveaux choix
autonomes.

Le décor praticable est préparé une fois sous forme d’un graphe de surfaces.
Un trajet A* est donc calculé lors d’un nouveau but, pas à chaque image. Le
caméléon suit ensuite physiquement ce trajet. Aux raccords sol–mur, autour d’un
rocher ou au sommet d’un obstacle, les griffes doivent acquérir la nouvelle
surface avant que le corridor soit considéré comme franchi. Un watchdog annule
et recalcule un trajet qui ne progresse plus au lieu de laisser l’animal tourner
indéfiniment.

Activez **Diagnostic → Chemin de surface** pour afficher le corridor courant.
Le trait permet de distinguer immédiatement un problème de planification d’un
problème d’accroche.

## Corps, pattes et queue

La locomotion utilise une architecture hybride stable :

- un seul corps Rapier, avec deux volumes de collision pour le torse et la tête ;
- quatre appuis de griffes au maximum, toujours bornés par la portée réelle des
  membres ;
- une démarche diagonale procédurale, calculée au pas fixe ;
- un squelette anatomique et une IK limitée pour poser paumes, talons et doigts
  sans étirer les pattes ;
- une suspension douce du bassin, du thorax, du cou et de la tête ;
- une queue originale simulée par une chaîne XPBD courte, amortie et en contact
  avec le sol, les murs, les rochers et les troncs.

Une griffe en appui reste fixée dans le monde pendant que le corps avance. Une
patte en transfert se lève réellement depuis l’épaule ou la hanche, fléchit au
coude ou au genou, puis se repose. À l’arrêt, le corps peut dormir sur ses
prises : ce verrou supprime les micro-balancements sur une branche cylindrique
sans empêcher un réveil immédiat quand une commande, un impact ou une cible le
demande.

Le propriétaire de surface possède une hystérésis. Le caméléon ne peut donc pas
rester suspendu entre un mur et un sol trop éloignés, ni alterner entre deux
faces à chaque pas. Après une chute, seul un impact réel peut amorcer une prise ;
le ventre est réorienté vers le support avant l’engagement des griffes.

## Camouflage

Le cycle écologique conserve ses pauses d’affût. Quand **Camouflage
automatique** est actif, une pause planifiée et suffisamment stable rend le
prédateur imperceptible aux papillons. Une poursuite, une frappe ou la perte des
prises le révèle immédiatement du point de vue logique.

Visuellement, le camouflage n’est ni une transparence ni une copie de l’écran.
La peau reste opaque, éclairée, volumique et capable de projeter une ombre. Elle
reprend progressivement la palette, le contraste et le motif du support tenu
par les pattes : terre, pierre ou écorce. Le motif est ancré dans le repère du
support et ne suit pas la caméra. Les yeux gardent une part configurable de
leurs détails afin que l’animal reste perceptible pour un observateur attentif.

Le vote porte uniquement sur les griffes réellement verrouillées. Les réglages
**Validation support**, **Transition support** et **Mémoire support** empêchent
la peau de clignoter lorsqu’une patte se lève ou lorsqu’un bord sépare deux
matériaux.

## Pourquoi les papillons le fuient

Chaque papillon adulte possède une distance et un angle de perception. À une
cadence bornée, il vérifie si un caméléon détectable entre dans ce volume. S’il
le voit, il infléchit continûment son vol à l’opposé du prédateur.

Un caméléon immobile et logiquement camouflé est absent de cette perception :
les papillons peuvent alors s’approcher. Le rendu de la peau ne décide jamais
de l’IA ; aucun pixel ni aucune couleur n’est relu par le comportement.

## Déroulement d’une attaque

1. Seuls les papillons adultes, visibles, libres et réellement visibles depuis
   la tête — sans tronc, rocher ni terrain entre les deux — peuvent être ciblés.
2. Le caméléon interrompt son exploration et approche sur les surfaces.
3. Le cou et la tête regardent réellement la proie pendant la préparation.
4. Lorsque la proie est à portée, le point de frappe est figé et la langue est
   projetée depuis la bouche.
5. La capture exige le croisement réel de la langue et du papillon. Si le décor
   coupe la trajectoire, la langue s'arrête et se rétracte sans traverser.
6. Le papillon reste attaché au bout de la langue pendant la rétraction.
7. Il n’est consommé qu’à son arrivée dans la bouche ; un tir raté ou une
   transaction refusée revient sans supprimer ni laisser capturée la proie.

## Sélection et diagnostic

Cliquez sur le caméléon pour ouvrir sa fiche. Elle expose son intention, sa
cible, son état de camouflage, son support, son trajet et ses prises. Dans
**Graphismes → Caméléon → Diagnostic** :

- **Proxies / contacts** affiche le corps physique et les quatre griffes ;
- **Squelette à travers la peau** montre les articulations réellement posées ;
- **Chemin de surface** affiche le corridor vers la destination autonome ;
- **Zone attaque (sélection)** affiche la portée depuis la bouche.

Ces aides ne sont construites que pour l’animal concerné et peuvent rester
désactivées en jeu normal.

## Réglages principaux

Ouvrez **Graphismes → Caméléon**. La taille n’y figure plus : elle est fixe à
1× pour préserver le contrat physique.

### Locomotion physique

- **Vitesse exploration** et **Vitesse poursuite** règlent les vitesses monde ;
- **Multiplicateur sprint** réserve une accélération franche aux séquences qui
  en ont besoin ;
- **Vitesse animation** change la cadence visuelle des membres sans modifier
  directement le temps écologique ;
- **Force motrice**, **Réactivité du cap** et **Couple de rotation** règlent la
  réponse du corps, sans téléportation.

### Squelette et démarche

- **Stabilité du corps** et **Amortissement** règlent le moteur musculaire ;
- **Tonus musculaire** conserve une tension légère pendant les phases passives ;
- **Cadence**, **Longueur des pas** et **Hauteur des pas** règlent le transfert
  des griffes ;
- **Amplitude épaules / hanches**, **Levée des membres** et **Flexion coudes /
  genoux** règlent l’amplitude anatomique ;
- **Mouvement du corps** et **Suspension anatomique** dosent respiration,
  transfert de poids et amorti du tronc.

### Appuis et queue

- **Appuis pieds / griffes**, **Force de maintien**, **Rigidité d’appui**,
  **Amortissement d’appui** et **Portée capteurs** contrôlent la prise ;
- **Réflexe de redressement** aide le ventre à retrouver le support après un
  impact ;
- **Verrouillage surface** évite les changements de propriétaire erratiques ;
- **Dégagement support** règle la très faible marge entre la peau des
  mains/pieds et la surface, sans créer de lévitation ;
- la **Souplesse**, l’**Amortissement**, le **Rayon de collision** et la
  **Gravité de la queue** règlent sa chaîne passive sans changer sa géométrie.

### Camouflage et chasse

- **Correspondance support** dose la reprise de palette et de motif ;
- **Détails des yeux** protège pupille et reflet ;
- **Temps d’adaptation**, **Retour naturel**, **Validation support**,
  **Transition support** et **Mémoire support** règlent des fondus stables ;
- **Intervalle camouflage** et les durées minimum/maximum règlent les affûts ;
- **Distance de détection**, **Distance d’attaque**, **Préparation attaque**,
  **Rétraction langue** et **Repos après attaque** règlent la chasse ;
- **Projeter les ombres** et **Recevoir les ombres** restent indépendants.

## Ce qui est normal

- une patte se lève pendant que la diagonale opposée garde la prise ;
- le corps termine brièvement un transfert avant de dormir sur une branche ;
- la peau met quelques dixièmes de seconde à adopter un nouveau support ;
- la queue continue légèrement son mouvement après un virage puis s’amortit ;
- un trajet est recalculé après une vraie absence de progression.

## Ce qui indique un défaut

- une téléportation du corps, d’une griffe, de la langue ou de la proie ;
- un corps suspendu durablement entre deux surfaces éloignées ;
- des rotations en boucle au pied ou au sommet d’un obstacle ;
- une griffe dans le vide, une patte étirée ou une queue traversant le décor ;
- une peau qui suit la caméra, devient transparente ou alterne rapidement entre
  deux supports stables ;
- un coût qui augmente avec le nombre de fourmis.

Le laboratoire `?test` reste disponible pour isoler les mêmes contacts,
articulations, routes et matériaux hors de l’écosystème complet.
