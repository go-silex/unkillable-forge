# Convergence Forge — plan d'exécution

Date : 2026-11-11. Statut : plan d'exécution accepté ; amendement F02 validé par l'opérateur après inventaire. Ce document ne déclenche aucune mutation de production sans sa confirmation spécifique.

## 1. Décisions acquises et périmètre

| Sujet | Cible demandée |
|---|---|
| Canon | `go-silex/unkillable-forge`, public, utilisé par Unkillable |
| Instance Roxabi | `Roxabi/roxabi-forge`, privé, dérivé du canon avec un remote `upstream` |
| Données | R2 devient la source de vérité des fichiers publiés ; les hubs restent des copies de travail/export |
| Publication | Via MCP, sans droit d'administration Cloudflare sur les postes ; Claude Code, Codex et OMP prioritaires |
| Méthode | Tout changement dans un worktree dédié, une branche et une PR ; revue indépendante, CI verte et merge épinglé |

**Un seul produit, deux déploiements isolés**, pas un SaaS multi-tenant. Les domaines actuels et leurs comptes Cloudflare restent séparés. Aucun transfert de zone, regroupement de données, accès croisé entre instances ou remplacement de Shlink n'est inclus.

« Public / privé » qualifie ici les **dépôts GitHub**, pas toutes les pages hébergées. Chaque instance conserve ses pages privées, partagées et publiques ; les deux buckets R2 restent privés.

L'open redirect est déjà corrigé : [Roxabi PR #13](https://github.com/Roxabi/roxabi-forge/pull/13), release `roxabi-forge/v1.1.5`, vérifiée en production. Ce n'est pas un lot restant.

**Amendement adopté pendant F01 :** le canon est créé dans un **nouveau dépôt public** à partir de l'histoire publique Silex approuvée. L'ancien dépôt garde son URL et son moteur figé jusqu'au retrait des anciens writers ; il n'est pas renommé. Motif : des versions installées 1.7.3/1.3.0 ignorent le pin local, et certains postes restent inaccessibles. Le corpus Roxabi approuvé inclut l'arbre du précédent déploiement et les publications actuelles, pas seulement les 16 fichiers actuellement déployés. Voir [le suivi d'exécution](forge-convergence-status.md).

**Amendement de gate F01 accepté par l'opérateur :** après fermeture du code, revue indépendante et CI verte du SHA final incluant cet amendement, F01 peut être accepté comme **énumération complète avec incertitude de sécurité identifiée**, sans attester la préservation des droits historiques. `UNRESOLVED_HISTORICAL_OWNERSHIP` reste bloquant avant toute importation du corpus historique, validation de fidélité F10 ou mutation de migration en production ; F11/F12 restent donc bloqués transitivement. F02, sous G0, puis le développement strictement hors production peuvent avancer suivant les autres dépendances inchangées. Aucun critère final de corpus, URL, grant ou accès aux assets n'est réduit.

La fermeture de ce gate exige un graphe historique vérifié ou un rapprochement probant page/parcours/ressource des droits attendus, validé par l'opérateur. L'assistant porte l'investigation et conserve les preuves privées. Une politique de droits nouvellement approuvée serait une décision distincte, pas une reconstruction présumée équivalente.

### 1.1 Vocabulaire

| Terme | Sens dans ce plan |
|---|---|
| Instance | Un déploiement avec ses identités, son catalogue et ses droits propres |
| Artefact | Ensemble publié : une ou plusieurs pages et leurs fichiers associés |
| Page | Document navigable, avec une URL et une visibilité propres |
| Révision | Version immuable d'un artefact, conservée pour comparaison/restauration |
| Publication | Promotion explicite d'une révision ; distincte du déploiement du moteur |

### 1.2 Constats qui modifient le plan initial

- Les deux dépôts sont actuellement publics et indépendants ; Roxabi n'a pas encore de remote `upstream`. Un fork GitHub public n'est donc ni nécessaire ni la cible.
- Le checkout principal Silex est sale et en retard sur `origin/main` : ses changements ne sont ni déplacés, ni stashed, ni écrasés. Ce plan est lui-même préparé dans un worktree depuis `3c3c442`.
- **Arborescence locale ≠ contenu publié.** Le dernier déploiement Roxabi a construit deux artefacts par slug. Le code explique pourquoi : `--rebuild-index` appelle le builder slug, même avec `layout: tree` ; seul `--tree` sélectionne explicitement le builder arbre. Le garde-fou compare le hub à `snapshot:live`, pas les fichiers réellement déployés. Cela ne prouve pas une perte, mais impose de réconcilier live, hub et snapshots avant toute écriture.
- Une façade MCP autour de `publish.sh` serait possible, mais conserverait le snapshot global et ses risques. Elle est écartée comme cible ; MCP n'impose pas techniquement R2, c'est la séparation publication/déploiement qui motive ce choix.
- Une URL présignée R2 n'est **pas** à usage unique : elle est réutilisable jusqu'à expiration. Le flux retenu utilise une écriture authentifiée, bornée et immuable via le Worker, pas une promesse d'usage unique non tenue.

## 2. Cible technique

### 2.1 Modules et responsabilités

Les chemins exacts sont arrêtés au lot F03 dans le dépôt existant ; les noms ci-dessous désignent des modules, pas de nouveaux services à multiplier.

| Module | Interface utile | Implémentation / responsabilité |
|---|---|---|
| Accès | `authorize(actor, action, resource)` | Identité Access/OAuth vérifiée, rôle, ACL de page, grants de partage ; refus par défaut |
| Publication | `begin`, `putFile`, `commit`, `status`, `restore` | Staging R2, manifeste vérifié, promotion conditionnelle, conflits et reprise |
| Lecture | `resolve(host, path, identity)` | URLs canoniques, pages, fichiers associés, onglets, contenu R2 et contrôle de lecture |
| Catalogue | `list`, `get`, `setVisibility`, `share`, `revoke` | Métadonnées, visibilité, partage, recherche et actions UI ; mêmes règles que MCP |
| Interfaces externes | HTTP, MCP distant, MCP local, interface web | Adapters vers les mêmes modules ; aucun second moteur métier dans un plugin |

**Runtime proposé :** Worker TypeScript/Hono, R2 privé, D1 pour les métadonnées transactionnelles. MCP distant en Streamable HTTP, handler sans état par défaut. Ni Durable Object, ni broker, ni microservice supplémentaire sans besoin démontré.

Les mêmes sources sont déployées deux fois. Configuration d'instance : domaines, marque, références de bindings, audiences Access, membres/rôles et shortlinks. Aucune condition métier `if Roxabi` / `if Unkillable` dans le moteur.

Conserver npm/TypeScript/Vitest et les conventions du dépôt ; ni nouveau monorepo ni réécriture SPA pour ce chantier. L'[ADR 0001 existant](architecture/adr/0001-axis-of-decomposition.md) prévoit explicitement une révision lors de l'arrivée d'un publisher Worker : F03 le réexamine avec son propriétaire et consigne la décision avant d'implémenter le nouvel axe, sans perdre l'autorisation centralisée.

### 2.2 Source de vérité : bien distinguer fichiers et métadonnées

| Donnée | Autorité cible | Règle |
|---|---|---|
| HTML original, images, CSS, JS, fichiers associés | R2 privé | Objets immuables, clés par révision, empreinte et taille vérifiées |
| Révision active, pages, routes, propriétaires d'assets, ACL | D1 | Transaction de promotion ; lecture autoritative pour les droits |
| Grants de partage et révocations | D1 | Import des clés existantes sans changer les URLs ; aucun secret dans catalogue/logs |
| Miniatures et rendus dérivés | R2 + état D1 | Régénérables, liés à la révision ; original conservé |
| Hubs locaux, Drive, exports | Copies de travail / sauvegardes | Ne peuvent plus écraser implicitement l'état publié |

R2 est la source de vérité des **octets**, pas une base relationnelle improvisée. D1 est la source de vérité des **relations et droits**. Il n'existe pas de transaction distribuée R2+D1 : on écrit et vérifie les objets avant de rendre leur manifeste visible.

Tables minimales envisagées : artefacts/révisions, pages/routes, objets/références d'assets, sessions de publication, grants et événements de mutation. Le schéma final, les index et les contraintes d'unicité appartiennent à F03 ; pas de table par marque ou de couche générique multi-tenant.

KV reste la source de l'ancien système pendant la migration. Après bascule d'une instance, D1 devient la seule autorité opérationnelle ; pas de double écriture permanente KV/D1. Pour les nouveaux grants, conserver une empreinte du secret ; si le réaffichage d'un ancien lien exige le secret original, prévoir un stockage chiffré borné au lieu d'un retour au clair dans les métadonnées publiques.

#### Contrats legacy à conserver explicitement

| Contrat | Invariant de migration |
|---|---|
| Slugs | `/a/<slug>/` ; conserver les slugs existants, sans les déduire du titre |
| Pages arbre | Identité par chemin HTML relatif ; URL sans extension et variantes `.html`/`index.html` résolues vers la même page, sans traversée `..` |
| Partage | Conserver `/s/<id>/<clé>/` et `/s/<page>.html/<clé>` ainsi que les clés existantes ; aucune rotation implicite |
| Cookie de lecture | Accepter les anciens `forge_share=<page>\|<clé>` en revérifiant le grant courant ; ne jamais transformer ce cookie en droit de publication |
| Visibilité | `vis:<id>` fait foi, y compris ses métadonnées ; absent/inconnu = privé ; une clé `share:<id>` seule n'ouvre rien |

- Les fragments HTML et assets héritent de leurs pages propriétaires, pas d'un ACL de fichier inventé. Manifeste, registre et graphe de propriétaires restent internes ; leur version est liée aux objets de la révision.
- L'unfurl fonctionne sans cookie, avec des URLs OG liées au grant ; la clé n'est pas injectée dans le HTML original. Conserver les alias Shlink réellement existants, pas seulement recalculer un slug théorique.
- Les copyrights MIT Silex et Roxabi suivent les imports. Les filtres de corpus propres à une instance ne deviennent pas des exclusions globales du moteur public.

### 2.3 Publication sans snapshot global

1. `begin` reçoit les métadonnées, le manifeste des fichiers, la révision attendue et une clé d'idempotence. La session est liée à l'utilisateur, l'instance et l'artefact.
2. Le client streame uniquement les fichiers nécessaires vers des objets non accessibles aux lecteurs. « Staging » désigne leur absence de référence active : les clés de révision sont immuables dès l'upload, sans copie/rename R2 au commit. Les chemins, nombres, tailles, types et empreintes sont contrôlés ; aucun suivi aveugle de symlinks hors du dossier choisi.
3. `commit` revérifie l'autorisation, l'exhaustivité du manifeste et les objets. Une transaction D1 promeut la révision si les versions de contenu, d'ACL et d'habilitation attendues sont toujours courantes. Ces préconditions sont dans la transaction, pas uniquement dans une lecture effectuée avant elle ; un artefact multi-page n'est pas promu partiellement.
4. Le résultat donne l'URL canonique, la révision et le statut des enrichissements. Une publication privée reste privée ; mettre à jour un artefact ne le rend pas public implicitement.
5. Un timeout se résout avec `status` et la même clé d'idempotence. Un conflit retourne un conflit explicite, jamais un écrasement silencieux. Les objets orphelins sont collectés après expiration et vérification de l'absence de références.

**Garanties à démontrer :**

- Deux auteurs publiant depuis la même révision : un seul commit gagne ; le second voit le conflit et conserve son travail en staging.
- Upload partiel, objet manquant ou checksum invalide : l'ancienne révision reste visible. Un upload déjà vérifié ne peut plus être remplacé après commit.
- Un CAS D1 qui modifie zéro ligne n'est pas une exception SQL : les effets dépendants doivent eux aussi être conditionnés. Pas de révision active incohérente ni d'événement « publié » sur un CAS perdant.
- Révocation des droits entre `begin` et `commit` : commit refusé. Les capacités d'upload ne constituent pas un droit de publier.
- La promotion du manifeste est atomique ; ce n'est pas automatiquement un snapshot de toutes les requêtes d'un navigateur. F05 définit et vérifie le comportement des assets/onglets chargés pendant une publication ; aucune promesse d'atomicité multi-requêtes implicite.

Une suppression dépublie via une transition de métadonnées contrôlée ; elle ne détruit pas immédiatement les octets. Une restauration crée une nouvelle promotion d'une révision conservée, sans réactiver automatiquement d'anciens partages ou droits révoqués.

L'idempotence est liée à l'acteur, l'instance et au digest de commande : même clé + mêmes paramètres = même reçu, paramètres différents = conflit. Le GC ferme d'abord la session en D1 pour empêcher un commit concurrent, puis respecte la marge d'upload en vol et revérifie toutes les références actives et retenues. Un PUT réussi suivi d'une réponse perdue se réconcilie sans réécrire l'objet.

La vérification d'intégrité doit être assurée par le flux d'upload ou une primitive de checksum documentée, pas par le seul hash annoncé par le client, ni par l'hypothèse qu'un ETag multipart serait un SHA-256. F04 mesure les limites réelles de body/mémoire/CPU sur le plus gros fichier approuvé par F01. Si un flux simple ne suffit pas, le même contrat reçoit un upload découpé avec finalisation vérifiée ; jamais un échec tardif découvert pendant la migration de production.

#### Lecture cohérente pendant une publication

- Le document à son URL historique résout un seul manifeste. Ses ressources sont épinglées vers un namespace de révision réservé, par exemple `/_revisions/<page>/<revision>/...`, **toujours derrière les ACL**, jamais vers un bucket public.
- Une transformation structurée traite base documentaire, `src`, `srcset`, styles/preloads et URLs CSS ; les liens de navigation et ancres restent canoniques. Une base préexistante est traitée explicitement, pas doublée silencieusement.
- Les loaders root-relative, `location.href` ou hosts hardcodés sont inventoriés en F01 et exercés en F05. Pas de correction de JavaScript arbitraire par regex, ni de fallback d'un asset manquant vers la dernière révision. Une adaptation de producteur est une PR dans son propre worktree.
- Une lecture épinglée reçoit une preuve courte, liée à sa page/révision et à son droit de lecture, sans pouvoir de publication ; ACL, révocation et expiration sont revérifiées à chaque requête. Deux onglets de révisions différentes ne partagent pas un cookie global « dernière révision ». Connaître une ancienne révision ne suffit pas à lire un contenu autrefois privé.
- Les grants historiques continuent à suivre la version active comme aujourd'hui ; épingler leurs ressources pendant un chargement ne transforme pas le lien partagé en archive figée. La garantie de snapshot couvre le graphe effectivement résolu, pas des dépendances externes ni du JavaScript dynamique non vérifié.

### 2.4 MCP et fichiers locaux

**Interface principale proposée pour les trois clients :** un adapter MCP local léger, distribué dans le même plugin public, exposant `forge_publish(path, ...)`. Il lit le fichier/dossier local et appelle le contrat distant ; le HTML ne traverse pas le contexte du modèle.

| Surface | Ce qu'elle fait | Ce qu'elle ne fait jamais |
|---|---|---|
| MCP local stdio | Lecture bornée du chemin fourni, OAuth utilisateur, upload streamé, résultat compact | Déployer un Worker, lire un token CF, cloner le moteur ou appliquer des ACL locales |
| MCP distant HTTPS | Catalogue, publication par session, état, visibilité, partage, restauration | Lire un `/home/...` présent sur le poste d'un utilisateur |
| HTTP d'upload | Transport des octets sous contrôle de la session | Publier implicitement ou accepter une URL externe arbitraire à télécharger |
| Plugin commun | Installer/configurer les adapters et expliquer la publication | Dupliquer le moteur pour chaque marque |
| Interface web | Lire, administrer ses publications et ouvrir les contrôles autorisés | Fournir des secrets d'administration aux artefacts HTML |

Le MCP local est un **adapter de fichiers**, pas un second système : les validations métier, la révision courante, les ACL et les conflits sont décidés côté serveur. Les appels de gestion peuvent être délégués au même MCP distant. Pas de copie des identifiants OAuth privés du harness vers un script : l'adapter possède son propre client OAuth et son stockage sécurisé.

Pour un utilisateur des deux instances : deux entrées explicites, par exemple `forge-unkillable` et `forge-roxabi`, mais **le même paquet** et le même protocole. Une cible explicite évite un défaut silencieux vers la mauvaise forge.

Managed OAuth de Cloudflare Access est le premier choix, pas un acquis. Le lot F06 prouve la découverte, PKCE, callbacks, `resource` RFC 8707, refresh, révocation et reconnexion dans les clients installés. L'origine vérifie le JWT Access et son audience ; un simple header entrant n'est pas une identité fiable.

La compatibilité de version MCP est testée, pas déduite du mot « HTTP » : la révision 2026-07-28 a modifié les sessions/streams. Versions SDK/protocole retenues et versions des trois clients sont consignées. Si Managed OAuth bloque réellement, un provider OAuth applicatif adossé à Access est une alternative à arbitrer **avant** de construire dessus ; aucun mode authless de secours.

### 2.5 Sécurité et séparation des origines

- Les domaines historiques continuent à servir les artefacts. Un **autre origin** par instance héberge les contrôles privilégiés, OAuth et MCP ; les noms exacts sont réservés au lot d'infrastructure, sans modifier les URLs déjà partagées.
- Aucun cookie/token de publication n'est accessible sur l'origine des artefacts. Cookies hôte-only, pas de cookie de domaine parent ; CORS et validation `Origin` stricts. Les mutations MCP/API ne reposent pas sur le cookie de lecture d'une page.
- Lecture équipe ≠ publication : rôles lecteur, publisher et administrateur. Le rôle publisher est attribué explicitement ; pas d'accès Cloudflare au compte. Un administrateur déploie le moteur par la voie CI/CD approuvée.
- Les contrôles de l'ancienne barre HTML deviennent des liens/actions vers l'origine de gestion. Les anciens endpoints de mutation sur l'origine des artefacts sont retirés à la bascule, pas laissés comme un contournement.
- R2 reste privé : ni `r2.dev` ni domaine public de bucket. Les URLs alternatives `workers.dev`/preview ne contournent pas les ACL. Autorisation avant tout GET/HEAD/Range/304 et toute miniature ; réponses contrôlées `no-store`, même publiques si leur visibilité est mutable. Seul un cache interne d'octets immuables, placé **après** une décision fraîche, est admissible.

Une révocation Access peut laisser un token valide jusqu'à sa prochaine réévaluation : F06 mesure ce délai. Une désactivation/révocation applicative D1 doit bloquer immédiatement les **nouvelles décisions serveur**, même avec un token OAuth non expiré. Les lectures de sécurité vont au primaire D1, sans cache KV/isolate/CDN ni réplica éventuellement en retard. Si D1 est indisponible, refus ; pas de fallback public.

Les octets déjà téléchargés, réponses en vol et caches d'aperçu détenus par Slack ou un autre tiers ne sont pas rappelables. La révocation porte sur les nouveaux accès serveur. `Referrer-Policy: no-referrer` et le filtrage des logs évitent de propager les secrets de partage.

**Limite conservée et explicite :** les auteurs de HTML sont de confiance. Une page arbitraire exécutée sur l'origine de lecture peut agir avec les droits de lecture de cette origine ; ce chantier ne prétend pas sandboxer le JavaScript de chaque artefact tout en gardant toutes les anciennes URLs. L'isolement de l'administration évite d'y ajouter des droits de publication. Une isolation hostile par artefact constituerait une décision produit distincte.

Le renderer OG reçoit un accès borné à une révision, jamais un cookie d'administrateur. Les appels réseau sortants de contenus rendus sont bornés ; pas d'import distant arbitraire ni d'accès à des endpoints privilégiés via le navigateur de rendu.

## 3. Dépôts, identité et héritage

### 3.1 Canon public

**Décision opérateur amendée après inventaire : créer un nouveau canon public**, sans renommer le dépôt Silex consommé par les clients legacy.

- Initialiser `go-silex/unkillable-forge`, dépôt ordinaire public, au SHA public Silex approuvé et avec son ascendance conservée. Copier uniquement les références approuvées, pas un push miroir de toutes les refs ; aucun historique privé Roxabi. Les imports génériques Roxabi sont des PR publiques sélectives et relues.
- Chaque import est relu pour les secrets, données d'instance, fixtures et licences. Aucun corpus HTML réel ni sauvegarde de KV dans le dépôt public.
- Le runbook F02 fait approuver le nom, le SHA source exact et les références copiées avant création. `go-silex/silex-forge` reste à son URL actuelle : `main`, manifests et releases sont figés ; pas de redirection ni d'auto-update vers le nouveau canon. Les contrôles GitHub du gel et les automatismes d'écriture sont vérifiés sans publish de production.
- Changer l'identité et la distribution du plugin seulement lorsque le nouveau parcours est prêt, avec migration des trois harnesses ; pas d'auto-update supposée entre deux noms de plugin. Les anciennes releases restent immuables jusqu'à clôture du rollback.
- Les nouveaux développements du moteur sont réalisés uniquement dans le canon. Une correction découverte chez Roxabi retourne en upstream par un patch générique relu, jamais par merge de l'historique privé vers le public.

**Confinement transitoire par dépôt avant F03 :** les anciens publishers Silex continuent à cloner l'ancien `main` figé ; le nouveau runtime est développé exclusivement dans le nouveau canon. Il n'est plus nécessaire de prétendre avoir épinglé tous les anciens postes pour commencer F03. Coût borné : deux dépôts publics temporairement, mais un seul moteur activement développé ; toute correction de sécurité legacy est arbitrée séparément. Cette séparation n'annule aucun credential existant : le confinement serveur vérifiable des anciens writers reste obligatoire avant F12–F14, et leur retrait final avant F15. Roxabi reste épinglé à ses tags legacy jusqu'à sa propre bascule.

### 3.2 Roxabi privé avec upstream

La cible est un **dépôt indépendant privé**, pas un fork GitHub d'un dépôt public. `origin` pointe vers Roxabi ; `upstream` vers Unkillable.

**Méthode conservatrice proposée :** garder le dépôt Roxabi existant et son histoire, puis effectuer une jonction d'histoires unique dans une PR de convergence. Elle contient un véritable merge à deux parents ; sa fusion conserve l'ascendance, **sans squash/rebase ni faux merge `ours`**. La révision upstream choisie devient ancêtre ; le moteur est aligné sur cette révision, seules les surcharges d'instance explicites subsistent. Les mises à jour suivantes sont des merges upstream ordinaires et vérifiables.

Cette méthode produit un dérivé synchronisable, sans supprimer/recréer le dépôt ni force-push. Ce n'est pas un reclone littéral à histoire effacée. Si un clone neuf strict est exigé, il faudra une décision séparée sur l'archivage/renommage de l'ancien dépôt et ses consommateurs ; ce n'est pas exécuté silencieusement.

| Zone | Règle après convergence |
|---|---|
| Moteur, tests, plugin commun | Identiques à une release upstream épinglée |
| Configuration Roxabi | Surcharges limitées, documentées, sans secrets committés |
| Remotes | `origin` écrivable vers Roxabi ; `upstream` utilisé en lecture |
| Synchronisation | Worktree `chore/Fxx-sync-upstream`, PR, diff limité à la liste de surcharges |
| Correctifs communs | Développés en upstream, puis intégrés downstream ; jamais deux corrections parallèles |

**Ordre impératif :** ne pas rendre Roxabi privé tant que des publications actives dépendent d'un clone HTTPS public du moteur. Préparer la nouvelle distribution, geler/révoquer l'ancien chemin d'écriture, puis changer la visibilité et intégrer upstream. La lecture Pages reste disponible pendant cette préparation. Vérifier aussi les droits collaborateurs, la CI et les protections accessibles avec le plan GitHub privé.

Rendre privé ne rend pas secret ce qui a déjà été publié ; les anciennes copies externes ne disparaissent pas.

## 4. Discipline worktree obligatoire

### 4.1 Règles

1. **Un lot, une branche, un worktree, une PR.** Un lot touchant plusieurs dépôts a un worktree/PR par dépôt. Aucun développement, résolution de conflit ou génération de fichiers dans les checkouts principaux.
2. Partir du `origin/main` frais du dépôt concerné. Une dépendance doit être mergée avant le démarrage du lot dépendant ; pas de chaîne de branches empilées implicite. Travail parallèle seulement sur des lots réellement indépendants, avec interfaces fixées.
3. Revue indépendante liée au SHA et aux inputs, tests ciblés puis checks CI réels, merge-commit épinglé au SHA revu. Les droits commit/push/merge/deploy restent ceux explicitement accordés pour chaque mandat ; l'autorisation du correctif #13 ne vaut pas autorisation de cette migration.
4. Déploiements et migrations de données depuis un worktree de release détaché, propre, au tag/SHA approuvé. Les credentials restent hors dépôt, les comptes sont explicites. Aucun flag d'override d'un garde-fou sans décision opérateur.
5. Après merge et preuve : enlever le worktree seulement s'il est propre et sans travail non intégré, avec `git worktree remove`, jamais `rm -rf`/`reset --hard`. Les captures privées et sauvegardes ne sont pas des fichiers de travail à supprimer.

Les worktrees partagent les remotes, certaines configs Git et les objets : ce n'est pas un sandbox de compte Cloudflare. Ne pas modifier `git config user.*` par worktree. Les opérations sur remotes, renommage du clone principal ou visibilité GitHub sont sérialisées ; aucun déplacement de checkout avec worktrees actifs sans inventaire et réparation contrôlée.

### 4.2 Convention et commande de départ

Chemin : `~/.omp/wt/<repo>/<type>-<lot>-<slug>`. Branche : `<type>/<lot>-<slug>`. Les identifiants `Fxx` ci-dessous sont des lots de plan, pas des numéros GitHub inventés.

```bash
# Exemple pour un lot prêt, après merge de ses dépendances.
# REPO = chemin vérifié du clone canon ; WT = chemin dédié au lot.
git -C "$REPO" fetch origin
git -C "$REPO" worktree add -b feat/F04-publication \
  "$HOME/.omp/wt/unkillable-forge/feat-F04-publication" origin/main

# Pour une opération approuvée sur la release exacte, autre worktree :
git -C "$REPO" worktree add --detach \
  "$HOME/.omp/wt/unkillable-forge/ops-F14-cutover" "$APPROVED_COMMIT"
```

Les clones et worktrees existants gardent leurs chemins valides. Le nouveau canon a son clone distinct et ses worktrees dédiés ; ne pas déplacer les checkouts sales ni réutiliser leur `origin` pour changer silencieusement de dépôt.

Le plan initial a été préparé dans `~/.omp/wt/silex-forge/docs-forge-convergence-plan`, branche `docs/forge-convergence-plan`, base `3c3c442`. Sa version d'exécution et les amendements adoptés sont livrés par la PR F01 ; le suivi indique ses références effectives.

## 5. Lots, dépendances et livrables

`U` = dépôt Silex pour F01 et le runbook préparatoire F02, puis nouveau canon public Unkillable après sa création approuvée. `R` = dépôt Roxabi. Chaque ligne est une unité de travail livrable, pas un scaffold vide. Les nouveaux runtimes restent hors routage de production jusqu'aux bascules.

### Vague A — vérité terrain et contrats

| Lot / worktree | Dépendances | Changement / livrable | Validation bloquante |
|---|---|---|---|
| F01 `U/docs-F01-inventory` | Plan accepté | Inventaire strictement en lecture seule + manifestes privés par instance : déploiements, hubs, KV, shortlinks, cookies, routes, symlinks, tailles et corpus explicite ; incertitudes de droits identifiées | Tous les chemins connus sont classés par provenance ; divergence expliquée ; code revu et CI verte ; aucune mutation de production ; le gate historique G1b reste ouvert sans valoir conformité |
| F02 `U/chore-F02-canonical-name` | F01 | Runbook puis création approuvée du nouveau canon avec ascendance Silex ; ancien dépôt figé à son URL ; références de développement et distribution distinctes | SHA source/ref copiées approuvés, ancien main/manifests/releases inchangés après gel, nouveaux travaux isolés ; aucune obligation fictive d'avoir mis à jour les postes inaccessibles |
| F03 `U/feat-F03-core-contract` | F01, F02 | Contrat artefact/page/révision, schéma D1, configuration d'instance, ACL et résolution de routes réutilisées ; premières tranches de lecture métier exécutables | Parité des règles privé/public/partagé et des chemins ; identité/compte/cible explicitement isolés ; pas de moteur par marque |
| F06 `U/spike-F06-mcp-auth` | F02 | Preuve hors prod du client OAuth/MCP et du transport d'un vrai fichier vers un récepteur temporaire authentifié ; choix de versions et origines | Les trois clients authentifient, transfèrent la fixture dont on compare les octets, refreshent et échouent après révocation ; aucun token CF local ; ne dépend pas de l'API de publication F04 |

F03 et F06 sont parallélisables après F02. Le spike F06 livre une preuve de transport/authentification et une décision, pas une fausse publication métier. Son code jetable n'est ni promu en production ni conservé comme chemin alternatif. La preuve de publication complète sur les trois clients appartient à F08.

### Vague B — publication et lecture

| Lot / worktree | Dépendances | Changement / livrable | Validation bloquante |
|---|---|---|---|
| F04 `U/feat-F04-publication` | F03, F06 | Flux HTTP begin/upload/commit/status, R2 immuable, CAS D1, restauration et dépublication, intégré au mode d'authentification prouvé | Deux writers concurrents, upload interrompu, reprise après réponse perdue, manifestes faux et droits révoqués : aucun écrasement ni état partiel visible |
| F05 `U/feat-F05-serving` | F03, F04 | Lecture Worker/R2, catalogue web, canonisation des chemins slug et tree, assets/onglets, grants, barre de gestion sûre | URLs existantes, accès anonyme/équipe/clé, refus du sibling privé, liens relatifs et onglets ; vraie vérification navigateur sur corpus témoin |
| F07 `U/feat-F07-remote-mcp` | F04, F06 | MCP distant avec outils de lecture/publication/état/visibilité/partage ; schémas compacts et erreurs stables | Les mêmes mutations HTTP/MCP donnent les mêmes transitions ; droits serveur indépendants des annotations MCP ; Origin invalide refusé |
| F08 `U/feat-F08-client-publisher` | F04, F05, F06, F07 | Adapter local streamé, plugin public commun multi-host, configuration explicite des instances, migration des installations et catalogues | Claude Code/Codex/OMP publient un HTML de plusieurs Mo et un dossier sans corps au modèle ; octets, pages/assets servis et refus d'accès vérifiés, pas seulement un reçu |

Pas de « tester uniquement que le tool appelle une fonction » : les tests permanents couvrent les transitions, autorisations, octets servis et conflits observables. La configuration/wiring peut être vérifiée par un smoke jetable.

F08 comprend des PR consommateurs distinctes, en plus de la PR moteur : les 16 lots principaux ne signifient pas 16 worktrees au total.

| Dépôt consommateur | Worktree / branche dédiés | Livraison bloquante avant F12 |
|---|---|---|
| `silex-plugins` | `~/.omp/wt/silex-plugins/chore-F08-forge-client` ; `chore/F08-forge-client` | Références actives et installation vers le plugin public commun |
| `Roxabi/roxabi-plugins` | `~/.omp/wt/roxabi-plugins/chore-F08-forge-client` ; `chore/F08-forge-client` | `external-registry.json`, projection `curated-marketplaces.json` et docs alignées, suivant leur convention de génération |
| Autre repo consommateur découvert en F01 | `~/.omp/wt/<repo>/chore-F08-forge-client` ; `chore/F08-forge-client` | Chaque référence active attribuée et migrée ; aucune dépendance cachée au moteur privé |

Une installation neuve depuis chaque catalogue actif doit fonctionner **sans droit GitHub sur le moteur Roxabi privé**. F12 reste bloqué jusqu'à cette preuve ; l'existence du nouveau paquet seul ne suffit pas.

### Vague C — parité et capacité d'exploitation

| Lot / worktree | Dépendances | Changement / livrable | Validation bloquante |
|---|---|---|---|
| F09 `U/feat-F09-previews-sharing` | F04, F05 | OG par révision, unfurl sans cookie, Shlink, état des enrichissements et conservation des images existantes | Aperçu d'un lien partagé sans login ; mauvaise clé refusée ; renderer sans privilèges ; panne Shlink/OG annoncée sans prétendre que la publication a échoué |
| F10 `U/feat-F10-import-export` | F04, F05 | Import dry-run/reprise, rapports d'empreintes, mapping de routes et grants, export restaurable, GC sûr | Import rejouable sans doublons ni rotation involontaire des clés ; restore en environnement isolé ; suppression d'orphelins sans toucher aux révisions référencées |
| F11 `U/chore-F11-release-ops` | F05, F07, F08, F09, F10 | CI/release moteur/client, migrations D1, staging isolé, runbooks, sauvegardes et rollback avec reprise des mutations de sécurité | SHA testé uniquement ; publisher incapable de déployer ; exercices sur les deux instances, dont sauvegarde → révocation → restauration avec lien toujours refusé |
| F12 `R/chore-F12-upstream` | F11 | Préparer la jonction de lignée sur une release upstream ; geler l'ancien writer, rendre Roxabi privé, ajouter upstream et merger la convergence sous contrôle | Ancêtre upstream vérifié ; moteur identique hors surcharges autorisées ; CI privée opérationnelle ; anciens publishers coupés ; lecture Pages conservée avant bascule |

F09 et F10 sont parallélisables après la tranche de lecture/publication ; la préparation CI peut avancer sans déclencher d'effet de production. Les opérations de compte et de visibilité de F12 nécessitent une autorisation explicite au moment du passage.

### Vague D — bascules et retrait de l'ancien système

| Lot / worktree | Dépendances | Changement / livrable | Validation bloquante |
|---|---|---|---|
| F13 `R/ops-F13-cutover` | F12 | Import final et bascule Roxabi ; après go lecture, ouvrir publication MCP sur R2 | Matrice complète d'accès/URLs, empreintes du corpus approuvé et journal de mutations ; rollback répété avant ouverture des writes |
| F14 `U/ops-F14-cutover` | F13 accepté | Même procédure pour Unkillable ; vieux host et shortlinks conservés | Claude Code/Codex/OMP utilisés réellement par des publishers ; anciens liens et nouveaux contenus lisibles avec les droits attendus |
| F15 `U/chore-F15-retire-pages` | F13, F14, clôture du rollback | Retirer publish.sh/clone-engine/snapshot guards, anciens plugins et autorisations d'écriture Pages ; migrer docs/skills/config ; archiver l'ancien dépôt Silex après confirmation | Même un ancien client reconnecté ne peut plus écrire en production ; nouvelle machine opérationnelle sans token CF ni hub synchronisé ; ancien dépôt sans développement actif |
| F16 `R/chore-F16-sync-upstream` | F15 | Intégration downstream du retrait ; exercice d'une mise à jour upstream ordinaire, inventaire final | Une correction générique upstream atteint les deux instances sans fork métier ; mêmes tests ; différences limitées aux surcharges |

F13/F14 possèdent **chacun une branche/worktree et une PR d'opération**, même si aucun script ne change : SHA de release, instance/compte cible, manifeste approuvé, critères go/no-go, approbation et références de preuves privées. L'exécution utilise en plus un worktree opérationnel détaché du SHA approuvé. Aucun secret, corpus ou identifiant sensible dans une PR publique. Un écart de runbook découvert sur place arrête l'opération : correction en PR, pas de patch en production.

## 6. Migration des données — procédure par instance

### 6.1 Inventaire et sélection

| Ensemble | Traitement |
|---|---|
| Publié actuellement | Import obligatoire, avec mapping URL → page/révision/ACL |
| Dans le hub mais non publié | Import privé seulement après sélection explicite ; aucune mise en ligne automatique |
| En prod mais absent du hub | Récupération depuis source sauvegardée/exports ou arrêt ; jamais une suppression par défaut |
| Symlinks et chemins externes | Résolution contrôlée, allowlist des racines, détection des doublons/cycles et secrets |
| Partages/shortlinks/miniatures | Snapshot cohérent, clés inchangées, liens testés sans journaliser leurs secrets |

Les 11 Go précédemment mesurés dans un hub Roxabi ne constituent pas la taille de la migration approuvée. Le lot F01 mesure le périmètre réellement publié et celui à ajouter, par instance.

### 6.2 Pré-copie et répétition hors prod

1. Sauvegarder le déploiement Pages de référence, son code/version, les artefacts sélectionnés et l'état KV/shortlinks/Access/DNS ; chiffrer les sauvegardes de secrets.
2. Importer le corpus dans des bindings de staging distincts : objets avec empreintes, métadonnées privées par défaut, routes et grants conservés. Le domaine public ne bouge pas.
3. Comparer contenu et comportements : bytes/hash pour les originaux, chemins d'assets, rendus dérivés justifiés, catalogue filtré et droits. Pas de « même nombre de fichiers » comme unique preuve.
4. Rejouer l'import et les scénarios d'échec ; exporter puis restaurer dans un autre environnement de test. Vérifier les octets après restauration.
5. Produire un rapport go/no-go et le manifeste exact de cutover. Les preuves privées ne traversent ni logs Actions publics ni fichiers committés.

**KV n'offre pas de snapshot transactionnel.** Le gel inclut le drainage des mutations en vol. L'export couvre toutes les pages et tous les noms de clés connus, avec pagination complète, valeurs **et métadonnées `v`** ; on ne déduit jamais la visibilité de l'existence d'un partage. F01/F10 établissent les délais de propagation/cache applicables et la méthode de lecture de l'état final. Des collectes identiques trop rapprochées ne prouvent pas la fraîcheur : si la dernière visibilité/révocation ne peut être établie, la bascule est bloquée, pas déclarée sûre après un `sleep` arbitraire.

### 6.3 Gel, delta final et bascule

1. **Fermer les anciens writers** : publication CLI, changements de visibilité/partage via ancienne UI, automatismes. Révoquer/restreindre leurs credentials d'écriture ou appliquer une fermeture serveur vérifiable ; un message Slack seul n'est pas un gel. Capturer l'état final.
2. Appliquer le delta R2/D1 ; vérifier qu'il n'y a plus de mutation sur l'ancien état et que le manifeste est complet. Une session d'upload en vol n'est pas assimilée à un succès.
3. Router le domaine existant vers le Worker de release avec ACL déjà actives. Conserver le snapshot Pages figé. Ne pas activer un bypass Access avant preuve fail-closed.
4. Pendant cette phase, les mutations utilisateur restent fermées. Tester les pages existantes, les clés, les shortlinks, le domaine historique, les variantes de chemins et les hostnames alternatifs. Échec : revenir à Pages figé.
5. Ouvrir les mutations sur le nouveau système seulement après go lecture. Exécuter publication/modification/restauration depuis les trois clients ; aucune clé de partage n'est régénérée simplement à cause de la migration.

### 6.4 Retour arrière : deux situations différentes

| Moment | Retour arrière autorisé | Ce qui serait incorrect |
|---|---|---|
| Avant ouverture des nouveaux writes | Re-router vers le Pages figé, restaurer les règles d'accès connues ; données R2 conservées pour analyse | Réactiver des writers pendant une vérification incomplète |
| Après nouvelles publications, ACL ou révocations | Préférer un Worker précédent compatible lisant le même R2/D1 ; migrations de schéma expand/contract | Re-router aveuglément vers Pages : contenu perdu et anciens partages potentiellement réactivés |
| Retour nécessaire vers Pages après writes | Nouveau gel, export complet du nouvel état vers format legacy, restitution des ACL/grants/révocations et validation avant reprise | Ignorer une mutation parce qu'elle n'est « que de la visibilité » |
| Incident de données | Geler les écritures et lectures concernées ; restaurer R2/D1 au point cohérent, réconcilier les mutations de sécurité postérieures depuis une source non écrasée, puis rouvrir | Restaurer le journal D1 à T0 puis supposer qu'il contient encore les révocations faites à T1 |

Le rollback vers Pages après ouverture des writes est **bloqué par défaut** tant que l'export de retour et sa fidélité n'ont pas été éprouvés au lot F10. On ne vend pas une simple bascule DNS comme garantie de réversibilité des données.

**Reprise des décisions de sécurité :** F10/F11 définissent une sauvegarde du journal/état des ACL, grants, tombstones et habilitations hors de la base et du périmètre restaurés, avec un repère de complétude. Avant une restauration planifiée, exporter l'état courant et les mutations post-checkpoint vers cette source protégée. Un journal seulement présent dans D1, ou un export asynchrone sans preuve de fraîcheur, ne suffit pas. Si l'incident a détruit les événements nécessaires, les accès potentiellement concernés restent refusés jusqu'à reconstruction validée ; on n'autorise pas à partir d'un ancien snapshot « probablement correct ». L'exercice F11 inclut cette absence de preuve, en plus de la réconciliation réussie.

## 7. Critères d'acceptation transversaux

### Accès et partage

- Anonyme : ne voit que les pages publiques ; une page privée, un asset privé voisin et les manifests internes ne sont pas servis.
- Clé valide : accès à la page et aux ressources qu'elle possède, pas à un sibling. Mauvaise clé, clé révoquée ou page dépubliée : refus effectif, y compris avec un cookie de partage antérieur.
- Équipe lecteur : peut lire sans publier. Publisher : peut publier dans l'instance autorisée, pas administrer Cloudflare ni accéder à l'autre instance.
- Pages index/directory/extensionless, slash final, query et fragments : mêmes URLs utiles et canonisation maîtrisée. La régression open redirect reste couverte.
- Requête via preview/workers.dev/R2 public, mauvais Host/Origin/audience ou faux JWT : aucun contournement. Une page HTML hostile ne peut appeler l'administration avec les credentials du lecteur.

### Publication et fidélité

- Fichier autonome de plusieurs Mo, dossier avec CSS/images et page multi-onglets : publiés depuis les trois clients, sans corps HTML dans les arguments du modèle.
- Erreurs bornées et distinctes : non authentifié, interdit, conflit de révision, upload incomplet/expiré, empreinte invalide, limite dépassée.
- Avant commit, aucun état partiel visible ; après commit, les fichiers référencés existent. Reprise/idempotence démontrées sur perte de réponse, pas seulement sur appel répété séquentiel.
- Rendu et assets pendant une publication simultanée : garantie précisément documentée et testée ; pas de mélange de pages privées via un mapping global trop large.
- Une panne OG/Shlink est indiquée comme enrichissement incomplet ; le contenu publié reste accessible et la reprise ne crée pas de seconde publication.

### Exploitation et développement

- Une machine neuve sans `CLOUDFLARE_API_TOKEN`, Wrangler ni copie du hub peut publier via le client MCP après login.
- Révocation utilisateur, restauration de révision, dépublication et restauration de sauvegarde ont été exercées sur de vraies ressources de test.
- Logs sans bearer tokens, cookies ni secrets de partage ; chaque mutation porte acteur, ressource et révision pour attribution minimale.
- Moteur déployé uniquement par release approuvée ; un publish de contenu ne change ni code, ni bindings, ni schéma.
- Tous les lots ont worktree/PR/preuves ; downstream aligné sur upstream ; aucun ancien chemin d'écriture restant après clôture.

## 8. Exploitation, documentation et suppressions

| Sujet | Livraison attendue |
|---|---|
| Releases | Versions moteur/client/protocole explicites ; compatibilité déclarée ; pas de clone Git du moteur à chaque publish |
| Données | Sauvegarde R2 + export D1 cohérent, preuve de restauration, rétention et seuils documentés avant GC |
| Santé | Publication/read/auth failures et révision active observables sans contenu privé ; limites de taille/quota mesurées au corpus F01 |
| Documentation | Installation par harness, publication, partage, droits, restauration, déploiement, synchronisation upstream et migration des anciens plugins |
| Suppressions finales | Snapshot global Pages, contournements de drift, env tokens CF des publishers, scripts/skills devenus inutiles ; ne pas effacer les dossiers de travail des utilisateurs |

Les docs opérationnelles sont mises à jour dans les mêmes lots que le comportement. Les références de `silex-plugins`, **`Roxabi/roxabi-plugins`**, du hub et des configurations installées sont migrées lors du déploiement client, **chacune depuis son propre worktree si versionnée**. Les archives historiques ne sont pas réécrites pour une recherche textuelle « zéro Silex ».

Conserver les déploiements et sauvegardes de rollback jusqu'à acceptation de la migration par les responsables des deux instances. Le retrait des ressources facturées et la révocation définitive des derniers credentials font l'objet d'un inventaire et d'une confirmation, pas d'un nettoyage aveugle.

## 9. Gates et décisions restant à prendre

Chaque gate exige ses preuves et, quand elle l'indique, l'autorisation opérateur explicite. Les travaux non bloqués continuent ; une préparation ou une hypothèse ne vaut pas validation.

| Gate | Recommandation / décision attendue | Bloque |
|---|---|---|
| G0 — nouveau canon | Runbook F02 revu, nom public, SHA source exact et références à copier confirmés ; gel de l'ancien dépôt sans renommage | Création du canon et démarrage F03/F06 |
| G1 — corpus | Manifeste approuvé par instance : ce qui est déjà publié et ce qu'on ajoute volontairement | Import final, absence de perte démontrable |
| G1b — propriété historique | `UNRESOLVED_HISTORICAL_OWNERSHIP` : graphe historique vérifié ou rapprochement probant page/parcours/ressource, validation opérateur | Toute importation du corpus historique, acceptation F10 et toute migration de production ; F11/F12 bloqués transitivement |
| G2 — OAuth et MCP | Managed OAuth + adapter local ; preuve sur les trois clients, sinon alternative OAuth arbitrée | Distribution client et politique d'accès |
| G3 — héritage privé | Conservation de l'histoire Roxabi par jonction contrôlée ; sinon décision de reclone/archivage | F12 |
| G4 — exploitation | Origines de gestion, rôles publishers, limites, rétention et capacité de restore confirmés | Staging final et cutover |
| G5 — production | Autorisation par instance du gel, de la visibilité GitHub, du routage et de l'ouverture des writes | F12–F15 |

## 10. Sources et niveau de preuve

### Sources internes

- [Silex main observé `3c3c442`](https://github.com/go-silex/silex-forge/commit/3c3c442451d3511ed53fea86e0fe0f1165f09db7) : base du worktree de plan.
- [Roxabi correctif et déploiement #13](https://github.com/Roxabi/roxabi-forge/pull/13) : fix 1.1.5, CI et preuve de navigation authentifiée.
- Règles opérateur : `ssot/operator.ssot.md` § Dev workflow ; `ssot/cloudflare.ssot.md` § Comptes ; `ssot/plugins.ssot.md` § installation multi-host. Le plan conserve leurs garde-fous.
- Traces de cette session : dépôts publics non-forks, origin Roxabi seul ; publish 1.1.5 construisant deux slugs. C'est une observation, pas une preuve que tous les autres fichiers sont obsolètes.
- Cause du déploiement slug : [dispatch `publish.sh`](https://github.com/Roxabi/roxabi-forge/blob/1f3fb1ca43f8fe64e625fa447b3a72351437e9fd/plugins/roxabi-forge/scripts/publish.sh#L1812-L1827), [sélection du builder](https://github.com/Roxabi/roxabi-forge/blob/1f3fb1ca43f8fe64e625fa447b3a72351437e9fd/plugins/roxabi-forge/scripts/build-site-from-hub.py#L118-L142) et [périmètre d'empreinte](https://github.com/Roxabi/roxabi-forge/blob/1f3fb1ca43f8fe64e625fa447b3a72351437e9fd/plugins/roxabi-forge/scripts/lib/snapshot.py#L166-L175), relus dans le worktree du correctif mergé. L'inventaire API live et historique effectué en F01 confirme la divergence ; les rapprochements et leurs limites figurent dans [le suivi](forge-convergence-status.md).

### Références primaires — stockage

- [R2 — cohérence](https://developers.cloudflare.com/r2/reference/consistency/) : forte par objet ; écritures conditionnelles ; le cache n'hérite pas automatiquement de cette garantie.
- [R2 — URLs présignées](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) : réutilisables jusqu'à expiration ; pas d'usage unique natif.
- [D1 — batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) : transactions SQL, pas de transaction avec R2.
- [KV — fonctionnement et cohérence](https://developers.cloudflare.com/kv/concepts/how-kv-works/) : cache Worker par défaut 60 secondes, propagation « 60 secondes ou davantage », absences également cachées et aucune garantie locale de lecture après écriture. Ce n'est pas une borne de fraîcheur de l'API REST d'export.

### Références primaires — protocoles et exploitation

- [Cloudflare — MCP distant](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/) : handler sans état, pas de Durable Object obligatoire.
- [Access — Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) : RFC 8707, identité via JWT Access, tokens opaques côté client.
- [MCP — transport 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) : compatibilité de version à exercer, validation Origin.
- [Git — worktree](https://git-scm.com/docs/git-worktree) : espaces de travail liés, objets/config partagés.
- [GitHub — visibilité](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility) : conséquences d'un passage public → privé.

Le choix Worker/R2/D1, les interfaces MCP et le séquencement sont des **propositions de conception**, pas des fonctionnalités déjà implémentées ou testées. Context7 était indisponible (quota) ; les docs primaires ci-dessus ont été consultées directement. Aucun nouveau runtime, migration ou OAuth de ce plan n'a encore été exécuté.
