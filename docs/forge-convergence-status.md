# Convergence Forge — état d'exécution

Plan : [forge-convergence-plan.md](forge-convergence-plan.md). Dernière mise à jour : 2026-11-13. Ce suivi ne constitue pas une autorisation de mutation de production.

## Autorisations et invariants

- Autorisation opérateur obtenue pour commits, pushes et PR des lots du plan. Chaque merge reste conditionné à la revue indépendante du SHA final, à sa CI verte et au head correspondant.
- Renommage, passage privé, migration/bascule de production, suppression de ressources et retrait de credentials : confirmations distinctes encore requises.
- Périmètre Roxabi confirmé : préserver les pages de l'ancien déploiement arbre, leurs ressources nécessaires et les publications actuelles, avec URLs et droits conservés.
- Décision F02 actuelle : nouveau moteur isolé d'abord, migration ensuite ; aucun gel legacy ni drainage des anciens runs GitHub n'est un préalable au nouveau canon. Les réglages legacy partiellement désactivés restent en l'état, sans extension ni réactivation implicite ; aucune modification supplémentaire des anciens dépôts ou de la production n'est autorisée.
- Checkouts principaux et changements utilisateur préservés. Le document initial reste dans son worktree ; une copie est incluse dans F01 pour son versionnement.
- Toute écriture de code/documentation se fait en worktree dédié. Les inventaires de corpus et preuves privées restent hors Git ; aucune valeur de partage n'est publiée.
- La fenêtre à froid retenue concerne F13 complet puis F14, après leurs prérequis et autorisations ; l'état final et la dernière mutation devront être vérifiés alors. Elle n'introduit aucun gel avant le nouveau moteur et ne vaut pas autorisation de mutation GitHub/Cloudflare.

## F01 — observations réalisées en lecture seule

### Relevés initial puis réseau du collecteur

| Instance | Relevé | Fichiers du déploiement | HTML | Pages du snapshot KV | Catalogue authentifié |
|---|---|---:|---:|---:|---|
| Unkillable | Initial F01 | 684 | 201 | 159 | 159 entrées |
| Unkillable | CLI réel après corrections | 687 | 202 | 160 | Non relu |
| Roxabi | Initial F01 | 16 | 5 | 828 | 0 entrée |
| Roxabi | API après vérification du binding | 16 | 5 | 828 | Non relu |

Les colonnes mesurent des ensembles différents. Le snapshot est un registre d'empreintes du hub, pas une preuve de présence en production. Un catalogue vide n'est pas assimilé à un site vide.

Source : GET Cloudflare du projet correspondant exactement au domaine configuré, `canonical_deployment`, puis GET `/accounts/{account}/pages/projects/{project}/deployments/{canonical_id}/files`. Ce dernier retourne effectivement `result.files` (chemin → empreinte opaque). L'affirmation historique « pas de manifeste par fichier via l'API Pages » est invalidée par cette réponse observée ; le format de l'empreinte n'est pas présumé.

### Historique et métadonnées

| Observation | Unkillable | Roxabi |
|---|---:|---:|
| Déploiements de production listés et manifestes lus | 548 / 548 | 183 / 183 |
| Clés KV listées et valeurs lues | 177 / 177 | 63 / 63 |
| Clés `vis:` | 100 | 61 |
| Clés `share:` | 76 | 1 |
| Clés `vis:` portant `metadata.v` | 0 | 61 |

Les valeurs `vis:` restent l'autorité de visibilité de l'ancien système ; l'absence de `metadata.v` n'est ni une absence de page ni une autorisation. Les secrets `share:` ne sont pas persistés dans les rapports : présence, longueur et digest seulement. Ces lectures ne sont pas un snapshot transactionnel et seront reconsolidées sous gel avant migration.

### Écart de déploiement Roxabi — gate supplémentaire

| Ensemble | Fichiers |
|---|---:|
| Déploiement du 2026-09-23 à 18:59 UTC | 16 264 |
| Déploiement du 2026-11-11 à 16:22 UTC (1.1.5) | 16 |
| Chemins retirés entre les deux | 16 255 |
| Parmi les chemins retirés : HTML | 828 |

Le mécanisme est identifié dans les sources : `--rebuild-index` appelle le builder slug-first, tandis que `layout:tree` fait empreinter le hub entier au garde-fou. Le déploiement de sécurité a corrigé la redirection mais sa vérification n'a pas couvert la préservation de cet arbre. Cela établit une réduction du contenu déployé, pas une destruction démontrée des copies locales ou historiques.

**Ajustement adopté :** le corpus à préserver inclut l'arbre précédent et les publications actuelles. Les 828 chemins HTML retirés ont été rapprochés de leurs sources et sont reconstructibles à l'identique de l'upload historique. Aucune restauration ni re-publication automatique ; un éventuel correctif de récupération conserve la correction 1.1.5 et requiert sa propre PR et l'autorisation de production.

### Vérifications HTTP réalisées

- GET authentifiés des deux catalogues : 200, identité équipe reconnue.
- GET et SHA-256 des réponses 200 accessibles des chemins courants ; redirections `.html` suivies vers leur URL canonique, sans page de login.
- Les réponses 404 sur fichiers internes et les redirections sont enregistrées distinctement, pas converties en fichiers manquants ou en succès vide.
- Aucun publish, reanchor, rendu OG, setup, mutation KV/Access/DNS/Shlink ou déploiement exécuté par F01.

### Inventaire local et reconstruction vérifiés

| Instance | Fichiers réguliers | Octets réguliers | HTML | Liens symboliques |
|---|---:|---:|---:|---:|
| Unkillable | 1 052 | 250 918 807 | 198 | 0 |
| Roxabi | 26 633 | 10 857 231 074 | 843 | 228 |

L'énumération et le SHA-256 des fichiers réguliers sont complets, sans entrée illisible. Les symlinks ne sont pas suivis dans cet inventaire : Roxabi comprend deux liens hors racine et un lien pendant. Les candidats historiques font l'objet d'un rapprochement distinct, avec lecture bornée du seul HTML externe explicitement conservé ; aucune exploration de son répertoire cible.

Le hash d'upload a été lu dans les bundles Wrangler installés, puis calibré contre huit fichiers live identiques : BLAKE3 de `base64(octets) + extension`, tronqué aux 32 premiers caractères hexadécimaux. Ce calcul ne devient pas une dépendance ni une hypothèse implicite du CLI générique.

| Reconstruction du déploiement Roxabi précédent | Fichiers identiques à son manifeste |
|---|---:|
| Octets locaux directs | 15 592 |
| HTML après injection historique pure de la barre de partage | 334 |
| Miniatures régénérées avec les paramètres historiques + HTML externe transformé | 336 |
| Total reproductible | 16 262 / 16 264 |

Les **828 HTML retirés sont tous couverts**. Les deux éléments restants sont `manifest.json` et `asset-owners.json`, métadonnées générées à reconstruire selon le nouveau modèle ; ils ne sont pas déclarés identiques. Aucune exécution de JavaScript d'artefact ni écriture des sources n'a été nécessaire.

Les loaders incluent des `fetch` root-relative et des références d'hôte absolues : le pinning reste à prouver sur le corpus réel en F05. Le plus gros fichier régulier local Roxabi dépasse 400 Mo ; il ne fait pas partie automatiquement du corpus historique approuvé. Les candidats historiques effectivement comparés ne dépassent pas 7 997 944 octets.

### Shortlinks et parc de publishers

- Shlink : 189 liens listés ; 80 pointent vers les deux domaines Forge Unkillable actuels/historiques. Listing complet obtenu via GET backend authentifié par SSH, avec le credential déjà configuré dans l'UI ; aucun secret de destination persisté. Le chemin HTTP public via urllib a répondu 403 : ce listing ne prouve pas le fonctionnement de l'API publique.
- Poste courant : Claude Code 2.1.322, Codex 0.163.0, OMP 18.18.8. Les versions installées de plugins diffèrent entre harnesses ; la présence dans un registre n'est pas une preuve de chargement.
- D'anciens publishers Silex 1.7.3/1.3.0 clonent toujours `main` et ignorent le pin local prévu initialement. Des postes/utilisateurs restent non observables ; les comptes VPS inspectés en root n'ont pas de config/credentials Forge, ce qui ne permet pas de conclure pour leurs autres machines.
- **Correction F02 validée :** le nouveau canon utilise l'ascendance publique approuvée, tandis que les anciens consommateurs gardent leur URL et leur `main` legacy. Aucun gel du dépôt n'est déclaré ; le confinement serveur de leurs anciens droits reste une gate obligatoire de bascule.

Les preuves machine détaillées restent privées, hors Git. Vérification ciblée du CLI : **9 tests Python réussis** ; exécution réelle `--local-only` sur le hub Unkillable : code 0, 1 052 fichiers, 159 slugs, 198 candidats HTML, rapport mode 0600. Ce mode reste explicitement incomplet pour le live. Une erreur de détection de pagination des projets sans `id` a été corrigée ; aucune page distante n'est sautée pour rendre le test vert. F01 est livré ; les références finales figurent dans la table des lots.

Référence scellée des preuves privées : index `F01-evidence-sha256.txt`, SHA-256 `aa89f76ec569e126129112a048be5d5c86424a2460c6417b21869c898ecfd74d`. Les fichiers de preuve et l'index sont en mode 0600, dans un répertoire privé hors worktree ; aucun contenu de corpus ni secret de partage dans cette PR.

### Cookies et cohérence à préserver

| Source courante | Observation relue dans le code | Conséquence pour la bascule |
|---|---|---|
| Access des deux moteurs | `CF_Authorization` lu, non émis par le moteur ; JWT vérifié sur signature, issuer, audience, `exp`/`nbf` avec 30 s de tolérance | Ne pas présenter les cookies comme un export de droits ; les paramètres d'émission restent gérés par Access |
| Roxabi `forge_share` | Session, host-only, `HttpOnly; Secure; SameSite=Lax; Path=/` ; valeur vérifiée à nouveau contre `vis:shared` et la clé KV | Préserver le domaine et les clés ne dispense pas de refaire l'autorisation à chaque requête ; un ancien cookie ne doit pas réactiver un grant révoqué |
| Lectures KV | Aucune option `cacheTtl` dans les deux moteurs ; valeur exacte pour l'accès, metadata seulement pour le catalogue Roxabi | Le cache Worker par défaut est éventuellement cohérent ; ni 60 s ni le commentaire de list-lag ~10 s ne prouvent la fraîcheur REST |

Sources : Silex `functions/_lib/access.ts` (contrôles JWT, `visibility`), Roxabi `functions/s/[[path]].ts:41-42`, `functions/_middleware.ts:148-167`, `functions/_lib/access.ts:298-331`. Le cache JWKS d'isolate dure une heure et n'est pas une autorité de visibilité. La méthode de capture finale exige fermeture serveur des writers, drainage et preuve de la dernière mutation ; faute de cette preuve, F10/cutover restent bloqués et aucun délai fixe ne les valide.

Les chemins distants ont aussi été classés par provenance dans des manifestes privés dérivés : 17 287 chemins historiques Unkillable, 30 581 Roxabi. Candidats de préservation : 684 chemins courants Unkillable et l'union précédente + courante Roxabi, **16 271 chemins dont 833 HTML**. Les chemins d'histoires plus anciennes ne sont pas automatiquement restaurés ; les fichiers locaux seuls ne sont pas automatiquement publiés. Cette classification d'ensembles ne remplace ni la résolution page/asset/ACL du CLI corrigé ni le manifeste final sous gel.

### Revue et livraison F01

Les paragraphes de revue ci-dessous sont le journal des itérations. L'état final livré, son SHA revu et ses checks figurent dans la table des lots ; les demandes de nouvelle revue intermédiaires ne rouvrent pas F01.

[PR #69](https://github.com/go-silex/silex-forge/pull/69). Le SHA `70649f742e8aec34415ab6bbb838017ed64f3771` a passé les hooks et toute la CI, dont macOS/Bash 3.2/Python 3.9 et le scan secrets, mais sa revue a encore bloqué sur trois défauts P2 : exemption de redaction par nom de clé, métadonnées de pagination mal typées, diagnostic des alias de répertoire. Ils ont été corrigés avec la frontière droite des flags ; une régression de retour de fonction introduite pendant cette correction a également été corrigée. **22 tests ciblés réussis**. La nouvelle revue indépendante et la nouvelle CI du SHA final, amendement inclus, restent requises.

Exécution réelle finale du CLI local : code 0, 1 058 fichiers / 160 slugs / 199 HTML. Par rapport au smoke précédent : six chemins locaux supplémentaires, aucun retiré, aucun digest commun modifié. Ce delta n'est pas déclaré publié : le hub a évolué pendant les observations et le manifeste de bascule sera repris sous gel. Les rapports précédents restent conservés ; aucune donnée locale n'a été supprimée ou normalisée par F01.

### Vérification réseau après les dernières corrections

La revue de `7b8a7cc` a trouvé une fin de pagination vide traitée comme un curseur suivant et une résolution lexicale incorrecte de `..` après alias. La fin `cursor: ""` est maintenant traitée comme une fin ; la résolution de diagnostic utilise les règles de `Path.resolve`, sans scanner ni hasher les répertoires externes. **24 tests ciblés ont réussi**, incluant ces deux régressions.

- Unkillable : CLI réellement exécuté avec `--without-history`, `complete: true`, aucune issue ; toutes les valeurs KV demandées lues. Le mode local seul n'est plus l'unique preuve d'intégration.
- Roxabi : la commande normale refuse correctement une divergence de namespace entre config et env. Un GET du projet de production prouve que `SHARES` correspond à l'env et non à la config. Une sélection **explicite en mémoire** de ce binding vérifié a ensuite exercé le collecteur complet : `complete: true`, aucune issue, valeurs KV lues. Aucun fichier utilisateur modifié.
- Ce dernier point est un **contournement diagnostique**, pas une correction de configuration : la commande non modifiée reste bloquée. Il disparaîtra avec une configuration corrigée de façon approuvée ou le remplacement du publisher legacy. Les deux essais ont explicitement sauté l'historique, déjà collecté séparément ; ils ne prétendent pas refaire un snapshot transactionnel.

Rapports privés en mode 0600 : `unkillable-inventory-cli-api-proof.json`, SHA-256 `51808e94ea2d6208620e524f26668fa5f0dc2031658e3637f95595af8e1698e5` ; `roxabi-inventory-api-bound-namespace-proof.json`, SHA-256 `21c2f3fff9b055c8b7dc343e890b9a8976bd4fdc6a40180de9b6716967431182`. Nouvelle revue du SHA final et nouvelle CI encore requises.

La revue de `da5675e` a ensuite identifié la différence de `Path.resolve(strict=False)` sur Python 3.13+. Le diagnostic valide désormais le chemin du lien avec `os.stat(..., dir_fd=root_fd, follow_symlinks=True)` — métadonnées seulement — puis le place avec une résolution stricte. Les cycles et chemins utilisant un fichier comme répertoire ne sont plus déclarés internes. Les **25 tests ciblés réussissent sous Python 3.12, 3.13 et 3.14**. Un nouveau parcours local réel des 228 liens Roxabi donne 225 internes, deux externes et un cassé ; rapport privé mode 0600, aucune lecture réseau dans ce dernier essai. Les preuves API précédentes restent distinctes ; la nouvelle revue et la CI du SHA final sont toujours exigées.

### Rapprochement des droits — preuve encore ouverte

| Instance | Identifiants de grant sélectionnés | Publics | Partagés | Privés explicites | Valeur absente |
|---|---:|---:|---:|---:|---:|
| Unkillable | 159 slugs | 10 | 76 | 9 | 64 |
| Roxabi | 830 pages/slugs | 59 | 1 | 1 | 769 |

Une absence dérive vers privé dans la branche page ; elle ne suffit **pas** à classer un fragment Roxabi : `fragmentOwners` peut l'autoriser via ses propriétaires. Les 828 HTML de l'arbre sont rapprochés sans chemin orphelin, mais ces observations ne certifient pas les parcours fragment/asset. Aucun `asset-owners.json` historique retrouvé dans les checkouts/caches locaux accessibles, le hub, les versions Syncthing, la corbeille, `/tmp` ou les caches M1 lisibles. Le laptop est inaccessible et un cache utilisateur M1 reste refusé. La reconstruction de 1 475 clés ne correspond pas à l'empreinte historique : elle n'est **pas** une autorité ACL. La cause précise de cet écart n'est pas prouvée. Les trois HTML du shell sont séparés des pages ; cinq ids `vis:` Unkillable ne rejoignent aucun HTML sélectionné.

Preuves privées immuables : `F01-selected-page-rights.json`, SHA-256 `552569a6642d0a6938f48142527efd25d25e2e67b8c2cb9faf993870beda319f` ; `F01-selected-page-rights-reconciled.json`, SHA-256 `4fa1b5097f5d4513d0a3b38040a8e14fbb7fd1a6097daf5acf2d796d21ac115c`. Tous deux sont explicitement incomplets sur cette preuve de droits.

La voie d'oracle HTTP historique est également fermée : l'URL exacte de l'ancien déploiement, issue de l'API déjà collectée, répond 403 avec `x-forge-origin-policy: pages-dev-blocked` sur la racine, une page connue publique et une page connue privée. Les HEAD n'ont suivi aucune redirection ni fourni de credential ; le refus précède les ACL. Aucun autre host ni contournement essayé. Le `site/manifest.json` encore présent localement est vide et son empreinte ne correspond à aucun des deux déploiements comparés ; il n'est pas une sauvegarde de droits.

Une analyse hors ligne supplémentaire retire uniquement la borne de quatre propriétaires du générateur historique en mémoire, sans changer ses sources ni la production :

| Objet | Borne conditionnelle aux inputs actuels |
|---|---|
| HTML arbre sélectionnés | 335 documents et 493 fragments |
| Ensembles de propriétaires | 1 480 ; quatre dépassent la borne historique ; aucun ensemble de fragment ne la dépasse |
| Accès anonyme des ressources non HTML | Un seul cas indéterminé lié à l'ordre ; chemin conservé uniquement dans la preuve privée |

Ces bornes **ne ferment pas G1b** : les références brutes historiques ne sont pas prouvées identiques par la seule égalité du HTML final après injection ; le générateur peut aussi lire hors du payload déployé. Cinq ressources candidates ne figurent pas dans le manifeste historique et ne sont donc pas ajoutées au corpus. Pour les assets partagés, l'union des propriétaires n'est pas l'ACL effective : `pageReferences` intervient également ; présence/empreinte d'une clé ne valide pas un cookie. Une différence d'empreinte JSON ne démontre pas à elle seule une différence de permissions. Preuve privée `F01-owner-ambiguity-bounds.json`, mode 0600, SHA-256 `495aebc8860dfdc6293ccdba0b91278fac26f5b1398ef5b6a566bfc1b8875197`.

### Amendement validé — poursuite hors production

L'opérateur a choisi `allow_nonproduction_with_hard_import_gate` : F01 est livré comme énumération complète avec incertitude de sécurité identifiée. F02 puis le développement hors production restent soumis à leurs autres dépendances. **Aucune importation du corpus historique**, validation de fidélité F10 ou migration de production tant que `UNRESOLVED_HISTORICAL_OWNERSHIP` reste ouvert ; F11/F12 sont bloqués transitivement. Les autorisations distinctes de production restent requises. La récupération historique Roxabi est suspendue ; une nouvelle politique de droits ne sera pas présentée comme équivalence historique.

## F02 — livré ; canon, provenance et registre

La [PR source #70](https://github.com/go-silex/silex-forge/pull/70) reste ouverte et draft, sans merge dans l'ancien dépôt. Son head final `bf8d145be4f1a4eec3260f1ad134c545071b9b7c` a reçu une revue indépendante et une [CI réelle verte](https://github.com/go-silex/silex-forge/actions/runs/43127809027), ainsi qu'un [scan secrets vert](https://github.com/go-silex/silex-forge/actions/runs/43127808988). Sa fermeture n'est pas une condition du bootstrap ; elle exige une autorisation distincte.

Le nouveau dépôt public ordinaire non-fork [go-silex/unkillable-forge](https://github.com/go-silex/unkillable-forge) a été créé ; seul `main` a reçu le seed `8d0b2e5330153edf2925160132b9bead908444a0`, sans force, miroir ni tags. L'arbre source et seed est `85c0ecae6c78455600f3e353437c88438abb9cfb`. La copie a subi deux substitutions historiques exactes et la perte explicitement approuvée de 50 signatures ; les originaux restent inchangés. Audit isolé de 238 commits et 2 561 objets : preuve SHA-256 `1e3abd932ef0ef52cc4e673d0384169076df238fdf96c7c759be16eb8268aeb3`.

Avant push : Actions désactivées, deux variables writers à `false`, token par défaut en lecture et sans approbation. Nouveau `main` protégé par PR sans bypass, merge-only, threads résolus et checks stricts `check`/`test` liés à GitHub Actions ; auto-merge natif et nouveau MergeOnGreen désactivés. Actions activées avec `allowed_actions=all` : workflows CI, PR title et secret scan actifs ; Dependabot peut créer des branches et PR dynamiques indépendamment. Les deux flags writers restent `false` et release est conditionné à son flag. Le [run seed 43294205230](https://github.com/go-silex/unkillable-forge/actions/runs/43294205230), exact seed, attempt 1, a exécuté avec succès les cinq jobs `check`, `test`, `test-os / macos-bash32`, `test-bash32` et `test-py39` ; release est skippé. Après le run, dépôt public non-fork et merge-only, auto-merge natif désactivé, deux variables `false`, MergeOnGreen `disabled_manually` et token en lecture sans approbation. Preuve privée `engine-first-bootstrap-and-seed-ci-proof`, SHA-256 `a91d32e12623effba7a097fe1759fbe32a7491df15c15723204f5aa6ab799684`.

Les désactivations GitHub legacy partielles antérieures restent en l'état ; aucun gel de branche/tag n'a été ajouté. Les anciens runs en attente ne sont plus un préalable du dépôt indépendant, et aucune nouvelle annulation ni mutation legacy n'est autorisée. Le bootstrap n'a modifié ni Cloudflare, ni données, ni Shlink.

La provenance a été livrée par [PR canonique #7](https://github.com/go-silex/unkillable-forge/pull/7) : head final `a1319834301e1bf2322f3e95b540dc7f64286e1c`, revue indépendante CLEAR, [cinq jobs CI réussis](https://github.com/go-silex/unkillable-forge/actions/runs/43298098734), secret scan et titre réussis, merge commit `9722984354d4597d765b2d645240e6b2f98f3068` aux parents vérifiés. Le registre privé a été livré par [PR projects-meta #46](https://github.com/Roxabi/projects-meta/pull/46) : head revu `77b073dc850fac7cfb06c05ebd4e903d9d425afa`, merge `6ab276eee0f21e7c940bead561236a09d53db212`. Ses hooks natifs ont réussi sans bypass : context-lint, ssot-verify du workspace principal PASS66/WARN0/FAIL0 et cleanroom du snapshot committé. Ce dépôt a zéro CI par politique ; le contrôle supplémentaire antérieur du worktree garde cinq échecs sur des références kit inchangées et n'est pas présenté vert. **F02 est livré sur les deux PR ; F03 et F06 ont ensuite commencé dans leurs propres worktrees.**

**Sonde G1b exécutée après autorisation explicite :** [PR Roxabi #14](https://github.com/Roxabi/roxabi-forge/pull/14), SHA revu `54769f55dd7207dfd0573d2bfa3204ef63d7c31e`, [cinq jobs CI réussis](https://github.com/Roxabi/roxabi-forge/actions/runs/43122215546), exécution depuis son worktree détaché. Les cinq appels bornés ont répondu 200 : résultat **`available`**, aucun drift du projet. Preuve privée `probe-54769f5.json`, SHA-256 `b9f33be9931ba6d604baad39a2d0914f6ec5a0ab4d8a2fe27f72a1a2f6bd6cf9`. Aucun upload, déploiement, changement de droits ou import. La tentative ultérieure isolée s'est arrêtée avant upload sur le contrôle `cross_project` ; aucun octet récupéré ni cause de stockage inter-projets prouvée. **G1b reste ouvert** et la récupération historique est suspendue.

## F03 — implémenté ; intégration et livraison en cours

- Contrat, glossaire et ADR axial 0002 précèdent le code. Configuration read/manage isolée, identité cryptographique, schéma D1 primaire, guards/epochs/rôles, grants scellés, ownership de révision et décisions slug/tree sont implémentés ; aucun runtime de publication ni déploiement n'est prétendu livré.
- Les premières exécutions ont identifié le mauvais point d'augmentation des types du plugin, l'absence de reset D1 entre tests et des fixtures sans montage/ownership ; corrections sans desserrer les contraintes. Dernière vague : les deux typages réussissent ; 17 fichiers moteur réussissent et le cas restore échoue durant son setup, car son guard `create_page` omet la révision désormais requise. Après correction de cette seule fixture, les six tests restore réussissent. Ce n'est pas une nouvelle exécution intégrale après cette correction ; la CI complète et la revue finale restent requises.
- La [PR #9](https://github.com/go-silex/unkillable-forge/pull/9) est ouverte. Les revues de `2b578d39710f9e1e84203763c82d8fde0cc5dcb6` étaient NOT CLEAR : priorité locale pinned, fournisseur durable des ownership edges, admission transactionnelle et cibles de redirection. Les corrections lient les edges au fournisseur et au même acteur manage opaque, vérifient instance/expiration, mintent le token pinned uniquement après autorisation et refusent les cibles d'alias dangereuses. Elles attendent une revue indépendante du nouveau SHA ; aucun merge n'est prétendu effectué.
- La CI `43363678228` du précédent candidat a échoué avant les tests à `npm ci` : peer transitif `@cloudflare/workers-types@5.20261113.1` absent du lock. Le lock a été régénéré avec npm 10.9.9, sans changer le workflow ni contourner les peers ; l'installation native réussit, avec trois scripts non approuvés toujours bloqués. Seule la future CI du nouveau SHA validera le chemin Node 22/npm 10.
- Silex observé réellement, sans suivre de redirection : les trois formes root d'un partage rendent les mêmes octets ; enfant partagé explicite `.html` servi sans inférence `.html` ; canonisation du root public en 308 vers le slash ; trois anciennes formes d'alias anonymes en 404. Les formes plus profondes restent distinguées des observations réalisées, conformément au [contrat](forge-core-contract.md#13-empirical-parity-observations).
- Roxabi relu sur le namespace du binding `SHARES` du déploiement canonique, pas celui de la config divergente : 61 valeurs de visibilité, dont 59 publiques, et 16 fichiers réellement déployés dont cinq HTML ; aucun identifiant public ne rejoint un fichier déployé. Un chemin public sans fichier rend deux 404 HTML identiques pour `.html`/extensionless et un 302 login avec slash. Ce n'est pas une observation de canonisation d'un contenu présent.
- **Amendement de preuve explicitement approuvé par l'opérateur :** la gate supplémentaire OR-1 du contrat est remplacée, pour F03 seulement, par la source Roxabi épinglée, la règle Pages et des vecteurs réels D1/Request/outcomes, présents et manquants, sans canonisation avant autorisation. La parité HTTP de production reste non attestée ; l'écart 404 HTML, la fidélité historique F10/F13 et G1b restent ouverts. Aucun critère de chemin/droit ni aucune dépendance de migration n'est retiré. Revue du SHA final, CI réelle et merge correspondant restent requis.

## F06 — PR de préparation ; aucune matrice réelle validée

La [PR draft #8](https://github.com/go-silex/unkillable-forge/pull/8) est poussée au head `040b3e90e97acace8c5ec9d12762bd03fffde7bc`. La revue indépendante ferme N1/N2/N3 : contrôles positifs same-principal autour du mauvais token, statut du token caché et refresh non interactif distincts, erreurs PRM explicites. Son verdict reste **NOT CLEAR pour la sonde wrong-resource** : l'acceptation du mauvais token doit être distinguée d'un résultat inconclusif. Correction en cours ; aucun contournement par exécution partielle.

La [CI manuelle 43427178724](https://github.com/go-silex/unkillable-forge/actions/runs/43427178724), exacte `040b3e9`, a réellement exécuté cinq jobs réussis, release skipped. Elle ne teste pas le spike imbriqué. Le smoke natif SDK, le flux synthétique de 4 587 649 octets et cinq scénarios SDK/OAuth synthétiques réussissent ; bundle Wrangler 4.161.0 réussi, aucun binding ni déploiement. Neuf inputs runtime/config/lock sont liés au commit par empreintes SHA-256 avant/après la même invocation ; détails dans [le runbook F06](https://github.com/go-silex/unkillable-forge/blob/040b3e90e97acace8c5ec9d12762bd03fffde7bc/docs/forge-mcp-auth-spike.md). Aucun de ces tests ne prouve Access réel, runtime Worker ou matrice trois clients.

Zone Gosilex établie avec le grant opérateur existant rafraîchi ; DNS/Access et collisions exactes/wildcards restent à vérifier avec des permissions suffisantes. Le relay navigateur a refusé l'ouverture Cloudflare car incompatible avec la version OMP ; aucun restart ou changement de configuration globale exécuté. Aucun Worker/app/domaine F06, configuration client réelle, consentement ou révocation/suppression créé ou autorisé. Les profils de contrôle des sondes devront être distincts de ceux des harnesses pour ne pas confondre rotation de refresh token et révocation. F06 reste non livré.


## Lots et traçabilité

### Vague A

| Lot | État | Worktree / branche | PR / SHA / preuves ou blocage |
|---|---|---|---|
| F01 | **Livré**, sous l'amendement de gate accepté | `~/.omp/wt/silex-forge/docs-F01-inventory` ; `docs/F01-inventory` | [PR #69](https://github.com/go-silex/silex-forge/pull/69), head revu `7ecc82b80d4ac7796aa2f128fd71405be44a585d`, merge `8440d7009ed771fcab2c64642048e96afa9b3a8c` ; [CI verte](https://github.com/go-silex/silex-forge/actions/runs/43094058384) et [secret scan vert](https://github.com/go-silex/silex-forge/actions/runs/43094058552) ; G1b ouvert |
| F02 | **Livré** | Source legacy conservée ; `unkillable-forge/docs-F02-provenance`, `docs/F02-provenance` ; `projects-meta/chore-F02-forge-canonical-registry` | [PR canonique #7](https://github.com/go-silex/unkillable-forge/pull/7), head `a1319834301e1bf2322f3e95b540dc7f64286e1c`, merge `9722984354d4597d765b2d645240e6b2f98f3068` ; [CI cinq jobs réussis](https://github.com/go-silex/unkillable-forge/actions/runs/43298098734) ; [registre #46](https://github.com/Roxabi/projects-meta/pull/46), head `77b073dc850fac7cfb06c05ebd4e903d9d425afa`, merge `6ab276eee0f21e7c940bead561236a09d53db212`, hooks natifs réussis |
| F03 | Implémenté ; preuves ciblées locales réussies, **non livré** | `~/.omp/wt/unkillable-forge/feat-F03-core-contract`, `feat/F03-core-contract`, base `9722984354d4597d765b2d645240e6b2f98f3068` | [PR #9](https://github.com/go-silex/unkillable-forge/pull/9) ; deux typages réussis, 17 fichiers puis restore6/6 ; corrections des revues2b et du lock CI ; nouveau SHA à revoir indépendamment et à valider en CI |
| F06 | PR de préparation ; **non livré** | `~/.omp/wt/unkillable-forge/spike-F06-mcp-auth`, `spike/F06-mcp-auth`, même base | [PR #8](https://github.com/go-silex/unkillable-forge/pull/8), head `040b3e90e97acace8c5ec9d12762bd03fffde7bc`, [cinq jobs CI réussis](https://github.com/go-silex/unkillable-forge/actions/runs/43427178724), smoke/bundle liés aux inputs ; revue NOT CLEAR phase wrong-resource ; vrais clients et opérations isolées non autorisés/non exercés |

### Vague B

| Lot | État | Dépendances bloquantes |
|---|---|---|
| F04 | Non démarré | F03, F06 |
| F05 | Non démarré | F03, F04 |
| F07 | Non démarré | F04, F06 |
| F08 | Non démarré | F04, F05, F06, F07 ; worktrees consommateurs distincts |

### Vague C

| Lot | État | Dépendances bloquantes |
|---|---|---|
| F09 | Non démarré | F04, F05 |
| F10 | Non démarré | F04, F05 |
| F11 | Non démarré | F05, F07, F08, F09, F10 |
| F12 | Non démarré | F11 ; installation neuve via catalogues ; confirmation passage privé |

### Vague D

| Lot | État | Dépendances bloquantes |
|---|---|---|
| F13 | Non démarré | F12 ; PR d'opération et autorisation Roxabi |
| F14 | Non démarré | F13 accepté ; PR d'opération et autorisation Unkillable |
| F15 | Non démarré | F13/F14 ; clôture du rollback ; confirmations de retrait |
| F16 | Non démarré | F15 ; exercice de synchronisation upstream |
