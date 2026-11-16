# Convergence Forge — état d'exécution

Plan : [forge-convergence-plan.md](forge-convergence-plan.md). Dernière mise à jour : 2026-11-16. Ce suivi ne constitue pas une autorisation de mutation de production.

## Autorisations et invariants

- Autorisation opérateur obtenue pour commits, pushes et PR des lots du plan. Chaque merge reste conditionné à la revue indépendante du SHA final, à sa CI verte et au head correspondant.
- Renommage, passage privé, migration/bascule de production, suppression de ressources et retrait de credentials : confirmations distinctes encore requises.
- Périmètre Roxabi confirmé : préserver les pages de l'ancien déploiement arbre, leurs ressources nécessaires et les publications actuelles, avec URLs et droits conservés.
- Décision F02 actuelle : nouveau moteur isolé d'abord, migration ensuite ; aucun gel legacy ni drainage des anciens runs GitHub n'est un préalable au nouveau canon. Les réglages legacy partiellement désactivés restent en l'état, sans extension ni réactivation implicite ; aucune modification supplémentaire des anciens dépôts ou de la production n'est autorisée.
- Checkouts principaux et changements utilisateur préservés. Le document initial reste dans son worktree ; une copie est incluse dans F01 pour son versionnement.
- Toute écriture de code/documentation se fait en worktree dédié. Les inventaires de corpus et preuves privées restent hors Git ; aucune valeur de partage n'est publiée.
- La fenêtre à froid retenue concerne F13 complet puis F14, après leurs prérequis et autorisations ; l'état final et la dernière mutation devront être vérifiés alors. Elle n'introduit aucun gel avant le nouveau moteur et ne vaut pas autorisation de mutation GitHub/Cloudflare.
- Arbitrage explicite du 2026-11-13 : F04 peut démarrer après F03 mergé, uniquement pour Publication/Revision Store, `0002_*` et les preuves D1/R2 locales, en worktree et PR draft dédiés. `authenticateManage` reste le seul point d'entrée d'identité ; aucun code du spike ou contournement d'authentification. F06 accepté et mergé demeure requis avant adapter HTTP/configuration du manage Worker, acceptation, revue finale et merge F04. Les autres dépendances et les preuves réelles des trois clients restent inchangées ; cet arbitrage n'autorise aucune ressource Cloudflare ni mutation de production.

## Recadrage opérateur du 2026-11-16 — livraison puis bascule

- L'opérateur demande d'arrêter la campagne de capacité et de terminer le nouveau système pour le déployer puis basculer. Les quatre cycles synthétiques/20 020 appels ne sont plus un verrou F04. Aucun second essai joint n'est autorisé ou lancé par ce recadrage ; le cas interrompu et ses octets restent conservés, sans reset, abort ni suppression implicite.
- F04 livré : [PR10](https://github.com/go-silex/unkillable-forge/pull/10), head final `607c4297a10c1e82ad011c51413a49362bccb445`, merge `2999c69e7cfd441b433d9536e0265212209e4833`. Les deux revues indépendantes du SHA final sont CLEAR ; [CI43838686150](https://github.com/go-silex/unkillable-forge/actions/runs/43838686150) : cinq jobs requis exécutés réussis, release skipped non comptée ; [secret scan43838686175](https://github.com/go-silex/unkillable-forge/actions/runs/43838686175) réussi. Les deux commits finaux ne modifient que trois documents ; runtime `10e4022a74340170556fb2c1104bf70bbaee643f` inchangé. Les checkpoints plus bas restent historiques.
- Le staging isolé a réellement exécuté création puis mise à jour avec un asset32Mio : états committed, versions1→2, mêmes pages/URL, upload puis matérialisation serveur. Neuf jeux D1 primaires par cycle concordent avec les manifestes ; quatre GET R2 physiques et quatre LIST couvrent les deux manifestes et les deux objets32Mio, tailles/SHA recalculés. Preuves privées `C1-C2.c3-semantic.json` SHA `c252a8011045ea6af19691dcb30d233283b63cfba33ac0e47c91233e2a91323d` et `C1-C2.physical-r2.json` SHA `e6f988ad8843f49a29950ac2828afa3484907efac2dacde23ac43f9f9baf9cb3`. Aucune valeur de credential ni octet d'artefact dans cette documentation.
- Le cas joint est interrompu avant commit :3711fichiers stockés/6289en attente, cause de terminaison inconnue. Sa capacité complète, son historique exact d'appels, l'écho indépendant des versions R2 et un pic mémoire restent non prouvés. Les métriques natives du smoke sont des agrégats/quantiles, pas des maxima ni une preuve individuelle. R16 reste INCONCLUSIVE/non attribué ; aucun diagnostic n'est supprimé ou déclaré universellement bénin.
- **6/16 lots livrés.** F07 est mergé après trois revues indépendantes du SHA final et cinq jobs CI réellement réussis ; F05 termine la lecture/gestion web dans son worktree dédié. F08 reste dépendant de l'acceptation F05 et livrera la publication métier réelle des trois clients ; le MCP métier mergé seul ne prouve pas ce parcours. Aucune bascule n'est faite avant les fonctions et contrôles ciblés d'accès/liens, la sauvegarde/rollback et l'autorisation spécifique. Aucune production, URL, clé, donnée, accès aux assets ou shortlink n'a été modifié par ces livraisons moteur.

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

Les loaders incluent des `fetch` root-relative et des références d'hôte absolues : le pinning reste à prouver sur le corpus réel en F05. Le plus gros fichier régulier local Roxabi dépasse 400 Mo ; il ne fait pas partie automatiquement du corpus historique approuvé. Le maximum observé des fichiers locaux directs rapprochés est de 7 997 944 octets ; les tailles finales de tous les fichiers transformés/reconstruits ne sont pas établies. Ce nombre n'est donc pas un majorant prouvé de l'union sélectionnée.

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

## F03 — livré ; Catalogue & Policy

- Contrat, glossaire et ADR axial 0002 précèdent le code. Configuration read/manage isolée, identité cryptographique, schéma D1 primaire, guards/epochs/rôles, grants scellés, ownership de révision et décisions slug/tree sont implémentés ; aucun runtime de publication ni déploiement n'est prétendu livré.
- Les premières exécutions ont identifié le mauvais point d'augmentation des types du plugin, l'absence de reset D1 entre tests et des fixtures sans montage/ownership ; corrections sans desserrer les contraintes. Après correction de la fixture restore, les six tests ciblés ont réussi ; cette vague n'était pas une exécution intégrale.
- La [PR #9](https://github.com/go-silex/unkillable-forge/pull/9) est livrée : head final `dda21e21e4e25f9608baf9f04e4b295669bb84a9`, deux revues indépendantes CLEAR, [CI réelle 43437954771](https://github.com/go-silex/unkillable-forge/actions/runs/43437954771) avec cinq jobs réussis, deux typages et 24 fichiers / 183 tests ; [secret scan 43437954770](https://github.com/go-silex/unkillable-forge/actions/runs/43437954770) réussi. Merge commit `48b1d11a44b817a642e095087457d7f24e94a088`, parents `9722984354d4597d765b2d645240e6b2f98f3068` et `dda21e21e4e25f9608baf9f04e4b295669bb84a9`. Les revues de `2b578d39710f9e1e84203763c82d8fde0cc5dcb6` étaient NOT CLEAR : priorité locale pinned, fournisseur durable des ownership edges, admission transactionnelle et cibles de redirection. Les corrections lient les edges au fournisseur et au même acteur manage opaque, vérifient instance/expiration, mintent le token pinned uniquement après autorisation et refusent les cibles d'alias dangereuses.
- L'échec `npm ci` de la CI `43363678228` était causé par le peer transitif `@cloudflare/workers-types@5.20261113.1` absent du lock. Le lock régénéré avec npm10.9.9 a passé la [CI réelle 43429369393](https://github.com/go-silex/unkillable-forge/actions/runs/43429369393) au SHA `66d8ddbaa29893ef735985c7ab6a0bfed80a142b` : cinq jobs réussis, secret scan réussi ; le log test confirme deux tsc et 24 fichiers /181 tests réussis. Aucun script npm bloqué sur le poste n'a été approuvé ou contourné.
- Les revues de `66d8ddb` puis de `cc9328b` ont identifié deux manifestations d'une même règle : une preuve pinned inutilisable doit compter comme absente, y compris quand elle correspond au chemin mais que sa base team n'est plus valable. Le prédicat central exige désormais correspondance complète ET base valable maintenant ; sinon aucun grant ni accès à une ancienne révision n'en provient. Typage moteur et neuf tests `revisions` réussissent, avec contrepreuves pour les tokens encore valides. Ces preuves intermédiaires restent distinctes de la CI du SHA final ci-dessus.
- Les notes non bloquantes restent suivies avant leurs consommateurs F04/F05/F10 : immutabilité/admission des edges à l'activation, validation des chemins, attribution des builders, viewer/fraîcheur de lecture, encodage des suffixes d'alias et couverture last-admin. Elles ne sont ni déclarées corrigées ni retirées du périmètre final.
- Silex observé réellement, sans suivre de redirection : les trois formes root d'un partage rendent les mêmes octets ; enfant partagé explicite `.html` servi sans inférence `.html` ; canonisation du root public en 308 vers le slash ; trois anciennes formes d'alias anonymes en 404. Les formes plus profondes restent distinguées des observations réalisées, conformément au [contrat](forge-core-contract.md#13-empirical-parity-observations).
- Roxabi relu sur le namespace du binding `SHARES` du déploiement canonique, pas celui de la config divergente : 61 valeurs de visibilité, dont 59 publiques, et 16 fichiers réellement déployés dont cinq HTML ; aucun identifiant public ne rejoint un fichier déployé. Un chemin public sans fichier rend deux 404 HTML identiques pour `.html`/extensionless et un 302 login avec slash. Ce n'est pas une observation de canonisation d'un contenu présent.
- **Amendement de preuve explicitement approuvé par l'opérateur :** la gate supplémentaire OR-1 du contrat est remplacée, pour F03 seulement, par la source Roxabi épinglée, la règle Pages et des vecteurs réels D1/Request/outcomes, présents et manquants, sans canonisation avant autorisation. La parité HTTP de production reste non attestée ; l'écart 404 HTML, la fidélité historique F10/F13 et G1b restent ouverts. Aucun critère de chemin/droit ni aucune dépendance de migration n'est retiré.

## F06 — historique de préparation avant le cycle réel

Le source du spike de la [PR draft #8](https://github.com/go-silex/unkillable-forge/pull/8) est figé à la référence préparée `143cb7e3703b23b90b0d466bc594ccd8d81ebf99`. Sa revue indépendante est **CLEAR pour ce source préparé seulement** : N1/N2/N3 puis l'acceptation du mauvais token correctement distinguée d'un résultat inconclusif. Profil de contrôle dédié, sans cache de grant partagé avec un harness. Le candidat intègre ensuite le merge F03 approuvé `48b1d11a44b817a642e095087457d7f24e94a088`, sans modifier les neuf inputs du spike ; son propre SHA exige une revue indépendante et sa CI. Aucun de ces points ne livre F06 en l'absence de preuve réelle.

La [CI manuelle 43431632665](https://github.com/go-silex/unkillable-forge/actions/runs/43431632665), exacte `143cb7e`, a exécuté cinq jobs réussis, release skipped ; elle ne teste pas le spike imbriqué. La preuve composite lie au commit huit inputs inchangés du smoke SDK/flux synthétique 4 587 649 octets/bundle Wrangler4.161.0 et la sonde modifiée, exercée sur sept verdicts synthétiques avec empreintes avant/après. [Runbook exact](https://github.com/go-silex/unkillable-forge/blob/143cb7e3703b23b90b0d466bc594ccd8d81ebf99/docs/forge-mcp-auth-spike.md).

Preuve locale supplémentaire fournie par le parent, SHA-256 `442fdff939a5f475e7f46fb3b1dd67517d6ac31d902691b241b592791492c16f` : Miniflare/workerd réellement exécuté refuse mauvais host 404, Origin 403, JWT absent 401, JWT invalide 403 et mauvaise audience 403 ; flux de 4 587 649 octets et SHA vérifié indépendamment, MCP initialize/list/tool et identité privée absente du résultat. JWKS et assertions sont synthétiques. L'empreinte du bundle est observée à l'exécution, pas une provenance de build rétroactive. Ceci ne prouve ni TLS ou Access réels, révocation, CPU cloud, ni matrice de trois clients ; F06 reste non livré.

Zone Gosilex établie avec le grant opérateur existant rafraîchi ; DNS/Access et collisions exactes/wildcards restent à vérifier avec permissions suffisantes. Diagnostic actuel : le parent de cette session utilise un exécutable OMP18.18.8, tandis que le relay partagé et le CLI installé indiquent18.20.0 ; le protocole causal et l'effet d'un restart ne sont pas prouvés. Aucun restart global, fermeture Chrome ou changement de configuration exécuté. Aucun Worker/app/domaine F06, configuration client réelle, consentement ou révocation/suppression créé ou autorisé. F06 reste non livré.

## F06 — livré ; authentification et transport éprouvés

- La [PR #8](https://github.com/go-silex/unkillable-forge/pull/8) est mergée : source final `2ee517bfb004edcde8434a004a80dd9d1f1112e1`, revues architecture et adversariale indépendantes CLEAR sur ce SHA, merge `2df4ce0372b2a8147aaef610abe357892a72c1a5`. La [CI finale 43590600521](https://github.com/go-silex/unkillable-forge/actions/runs/43590600521) a réellement exécuté les cinq jobs de vérification avec succès ; release skipped sous garde-fou. [Secret scan 43590600498](https://github.com/go-silex/unkillable-forge/actions/runs/43590600498) et titre de PR réussis. La CI racine ne teste pas le spike imbriqué : ses preuves réelles sont distinctes.
- Claude Code 2.1.322, Codex 0.163.0 et OMP 18.20.0 ont chacun exercé cinq cas natifs : fichier, répertoire, renouvellement, refus après révocation et nouveau consentement. Les octets synthétiques ont été transférés par l'adapter hors contexte du modèle. Le contrôle distant de 16 MiB reste un contrôle de transport ; **aucune publication métier R2 n'est prouvée par F06**. Les limites et versions de protocole effectivement observées figurent dans le [rapport](forge-mcp-auth-report.md).
- Le cycle Cloudflare propre au spike est clos : deux Workers et deux applications retirés, domaines et DNS propres absents, politiques non réutilisables devenues non interrogeables. Les deux packs TLS propres sont observés `deleted`, sans cause attribuée et sans DELETE SSL exécuté. Les six packs de référence restent présents. Les HEAD TLS avant/après sur le domaine principal et la Forge répondent 200 avec empreintes inchangées ; ce contrôle ne prouve pas les ACL ni les shortlinks.
- F06 satisfait désormais la dépendance HTTP/configuration et acceptation de F04. Les nouvelles ressources ou opérations Cloudflare F04 nécessitent leur propre autorisation ; le cycle F06 terminé n'est pas réutilisable. Aucun accès legacy ni Shlink n'a été modifié par ce cycle.


## F04 — Publication et Revision Store locaux ; non livré

- Domaine implémenté dans le worktree dédié : transferts R2 immuables avec checksum natif et création conditionnelle, reprise et matérialisation des fichiers inchangés avant scellement ; activation sans copie ni renommage des fichiers.
- Sessions, manifestes, reçus idempotents et activation CAS sur D1 primaire ; restore/unpublish, réadmission des ownerships et refus des providers étrangers sous un subtree. Les lectures de statut relisent l'autorité courante sans confondre conflit de contenu et perte du travail en staging.
- La fermeture authentifiée de sa propre session réduit uniquement cette capacité ; elle ne publie rien et ne change aucun droit. Le discard permanent bloque restauration et nouveau pinning avant suppression des octets. La maintenance doit rebalayer les discards, y compris déjà balayés : un PUT natif tardif peut laisser des octets après une première purge.
- Historique des preuves locales : premier passage 186/189 tests et TSC refusé ; après correction des trois causes, TSC réussi et 197/198 tests. Le dernier refus venait d'une fixture essayant de créer via le publisher un ownership désormais interdit ; le cas de défense en profondeur conserve ses assertions, avec injection explicite de cet état historique/corrompu. Les gates natives et la CI doivent être prouvées sur le SHA proposé ; cette trace historique ne les remplace pas.
- Le domaine préparé `a8c2c18679f5c75d62b4a1602d4f16d06a4a6d7a` avait ses deux typages, 31 fichiers / 234 tests et sa CI réelle verts ; cette preuve historique ne valide pas à elle seule l'interface HTTP ajoutée depuis. F03 et F06 sont satisfaits. Aucune ressource Cloudflare F04, migration ou modification des accès de production et des shortlinks n'est autorisée ou revendiquée.

### API manage et vérification native — candidat local

- [Interface HTTP](forge-manage-http.md) séparée du legacy, commandes JSON et upload streamé, Host/Origin avant auto-enregistrement et authentification avant lecture du corps. Les six durées Publication et quatre bornes transport sont obligatoires, sans valeur de production par défaut ; le profil Wrangler reste strictement local.
- Le vrai essai réseau a révélé un défaut que le stub de `fetch` ne voyait pas : workerd refuse `redirect: "error"` avant tout appel JWKS. Le mode `manual` conserve le refus des réponses non réussies et des redirections. Deux régressions natives vérifient une identité signée autorisant un effet gardé, puis le refus d'une redirection vers le même JWK sur un host non fiable.
- Historique du candidat local `6de673e523c6211c9781d544f97058b1d3ce1c5b`, après correction et retrait du diagnostic temporaire : **TSC réussi, 32/32 tests dans quatre fichiers, exit0**. Le vrai socket HTTP local a réussi : ancienne révision conservée après déconnexion, reprise, version1→2, document et asset exacts avec SHA-256 natif pour les deux révisions. Les compteurs runtime observés du socket sont nuls dans leur couverture déclarée, pas une détection universelle ; des diagnostics natifs EOF/`INTERNAL_ASYNC` restent visibles dans certains tests d'échec HTTP. Ces preuves liées aux inputs de ce candidat ne valident pas les corrections suivantes.
- **Amendement de capacité explicitement approuvé le 2026-11-14 :** témoin réel32Mio pour F04, tous les fichiers plus gros restant à tester et à supporter par upload découpé si nécessaire avant leur migration. Aucun fichier exclu ni plafond définitif32Mio ; les autres dimensions de capacité ne sont pas levées. Aucune opération Cloudflare n'est autorisée par cet accord.
- **F04 non livré.** Les revues indépendantes du candidat `6de673e` ont relevé du fanout D1/R2 et des défauts de classification d'erreur, d'état et de preuves de replay ; corrections en cours avant nouveau SHA. Capacité réelle, nouvelle revue du SHA final et CI requise restent dues ; F05/F07 ne démarrent pas.

### Corrections de revue — contrôle intégré du 2026-11-14, non accepté

- Catalogue fournit les selectors et le précontrôle lié à l'artefact cible ; Publication consomme ces interfaces, persiste versions natives/taille du manifeste, batch ses métadonnées et renvoie un petit reçu par fichier. L'ADR0002 porte un amendement daté ; le contrat explicite I-CV et l'inférence de liaison de version, pas une équivalence version/SHA-256. Ces changements ne sont pas encore un SHA livré.
- Premier contrôle réel sur le worktree, environnement sans credentials Cloudflare : **33 fichiers,271 tests,264 réussis et7 échecs** ; typecheck en échec avec5 diagnostics Store. Deux scénarios Store ont atteint leur deadline, dont le retry d'un objet déjà présent. Le cas de producteur fautif/abort utilise des cibles absentes et préserve un autre objet : son blocage ne doit pas être attribué au retry préexistant. Code et attentes/fixtures ont ensuite été corrigés chez leurs propriétaires, sans relance inchangée.
- Après ces changements : **TSC réussi,271/272 tests réussis dans32/33 fichiers**. Le retry préexistant ne bloque plus ; il reste une deadline dans le scénario indépendant producteur fautif/abort. Une sonde temporaire à marqueurs entoure ses points d'attente pour localiser le défaut avant toute autre correction. Les73 hashes de sources/config/tests capturés avant et après ce contrôle concordent ; cela lie la preuve à ce snapshot local, pas au futur SHA final.
- Les essais natifs locaux de concurrence, révocation en vol, erreur d'intégrité, oracle de portée et pagination/cardinalité ont été exercés ; le cas cardinalité comprend1 005 vrais fichiers et leur matérialisation. Les réussites partielles ne valident ni l'ensemble corrigé, ni les quotas, mémoire, CPU ou limites Cloudflare.
- Une enveloppe distante synthétique est préparée mais **non autorisée**. Les métriques de mémoire partagée ne sont pas un pic par upload ; aucune valeur de pic n'est inventée. F04 demeure bloquant pour F05/F07, avec correction, preuve socket liée aux inputs exacts, SHA final revu, CI et capacité distante encore dus.

### Correction d'ownership et preuve réseau — local seulement

- Le probe a atteint le rejet du PUT après abort puis bloqué sur le callback d'annulation. Le Store laissait des sorties avant acquisition du reader sans annuler le corps ; le correctif couvre dérivation de clé, pré-head et transfert, sans attendre une annulation bloquée. Le probe ne distingue pas l'instant exact où l'abort a gagné. Les tests utilisent maintenant HWM0 pour prouver un vrai début de lecture, et une barrière à deux writers avant EOF. Probe temporaire retiré.
- Après les deux seuls fichiers modifiés depuis le précédent snapshot : **TSC réussi ;36/36 tests ciblés réussis** (Store et HTTP publication). Les73 hashes avant/après concordent. Le précédent contrôle complet avait271/272 réussites ; ces résultats ne sont pas additionnés en prétendue nouvelle suite complète. Les diagnostics natifs de pipe/connexion/uncaught restent visibles dans les scénarios de faute, sans filtre ni qualification générale « bénigne ».
- Le vrai socket HTTP local a ensuite réussi : deux migrations, JWKS natif appelé une fois, ancien snapshot conservé après déconnexion, reprise et version1→2, quatre objets document/asset vérifiés en octets et SHA natif. Le reçu capture les21 sources exactes fournies à esbuild, le bundle, les migrations et le profil ; les compteurs d'erreur observés sont nuls dans leur couverture déclarée. Il ne prouve ni consommation des5 octets partiels par workerd avant coupure, ni Access/TLS ou capacité Cloudflare.
- **Toujours4/16 livrés.** F04 reste non accepté, non poussé dans cet état corrigé : revue du prochain SHA, CI requise et témoin distant restent dus. Le précontrôle Cloudflare est exclusivement en lecture seule ; aucun provisionnement, déploiement, bascule ou retrait de ressource/credential n'est autorisé.




## Lots et traçabilité

Six lots sur seize livrés : F01, F02, F03, F04, F06 et F07.

### Vague A

| Lot | État | Worktree / branche | PR / SHA / preuves ou blocage |
|---|---|---|---|
| F01 | **Livré**, sous l'amendement de gate accepté | `~/.omp/wt/silex-forge/docs-F01-inventory` ; `docs/F01-inventory` | [PR #69](https://github.com/go-silex/silex-forge/pull/69), head revu `7ecc82b80d4ac7796aa2f128fd71405be44a585d`, merge `8440d7009ed771fcab2c64642048e96afa9b3a8c` ; [CI verte](https://github.com/go-silex/silex-forge/actions/runs/43094058384) et [secret scan vert](https://github.com/go-silex/silex-forge/actions/runs/43094058552) ; G1b ouvert |
| F02 | **Livré** | Source legacy conservée ; `unkillable-forge/docs-F02-provenance`, `docs/F02-provenance` ; `projects-meta/chore-F02-forge-canonical-registry` | [PR canonique #7](https://github.com/go-silex/unkillable-forge/pull/7), head `a1319834301e1bf2322f3e95b540dc7f64286e1c`, merge `9722984354d4597d765b2d645240e6b2f98f3068` ; [CI cinq jobs réussis](https://github.com/go-silex/unkillable-forge/actions/runs/43298098734) ; [registre #46](https://github.com/Roxabi/projects-meta/pull/46), head `77b073dc850fac7cfb06c05ebd4e903d9d425afa`, merge `6ab276eee0f21e7c940bead561236a09d53db212`, hooks natifs réussis |
| F03 | **Livré** | `~/.omp/wt/unkillable-forge/feat-F03-core-contract`, `feat/F03-core-contract`, base `9722984354d4597d765b2d645240e6b2f98f3068` | [PR #9](https://github.com/go-silex/unkillable-forge/pull/9), source `dda21e21e4e25f9608baf9f04e4b295669bb84a9`, deux revues indépendantes CLEAR ; merge `48b1d11a44b817a642e095087457d7f24e94a088` ; [CI cinq jobs réussis](https://github.com/go-silex/unkillable-forge/actions/runs/43437954771), 24 fichiers/183 tests, [secret scan réussi](https://github.com/go-silex/unkillable-forge/actions/runs/43437954770) ; aucune application de migration en production ; suivis F04/F05/F10 ouverts |
| F06 | **Livré** | `~/.omp/wt/unkillable-forge/spike-F06-mcp-auth`, `spike/F06-mcp-auth`, base initiale `9722984354d4597d765b2d645240e6b2f98f3068` | [PR #8](https://github.com/go-silex/unkillable-forge/pull/8), source final revu `2ee517bfb004edcde8434a004a80dd9d1f1112e1`, deux revues indépendantes CLEAR, merge `2df4ce0372b2a8147aaef610abe357892a72c1a5` ; [CI finale cinq jobs réussis](https://github.com/go-silex/unkillable-forge/actions/runs/43590600521) et [secret scan réussi](https://github.com/go-silex/unkillable-forge/actions/runs/43590600498) ; quinze cas natifs distincts de la CI ; cycle propre retiré ; transport/auth seulement, pas de publication métier R2 |

### Vague B

| Lot | État | Dépendances bloquantes |
|---|---|---|
| F04 | **Livré** ; `~/.omp/wt/unkillable-forge/feat-F04-publication`, `feat/F04-publication` | [PR #10](https://github.com/go-silex/unkillable-forge/pull/10), head `607c4297a10c1e82ad011c51413a49362bccb445`, merge `2999c69e7cfd441b433d9536e0265212209e4833`. F03/F06 satisfaits ; deux revues CLEAR et CI43838686150/secrets43838686175 réussies. Création+mise à jour32Mio et preuves D1/R2 acquises ; campagne jointe retirée du gate, jamais déclarée réussie. Aucune bascule de production |
| F05 | Corrections intégrées et navigateur natif réussi, **non livré** ; [PRdraft12](https://github.com/go-silex/unkillable-forge/pull/12), `~/.omp/wt/unkillable-forge/feat-F05-serving`, `feat/F05-serving`, ascendance24b2 préservée | Après revues c741/de73 et vrais RED, contrôles ciblés lecteur/gestion et deux projets TypeScript réussis ; derniers6cas de rendu/headers réussis et témoin Chrome sans script créé, CSS sémantiquement conservé et café € UTF8. Le parcours natif complet prouve shell public GET/HEAD/SHA/MIME, accès équipe/anonyme, corpus local, pins, partage/assets, sibling privé, révocation et public/privé ; le chemin slug ajoute les refus GET/HEAD/Range/conditionnel. Corpus rawR2 de2348281octets concordant avec source/checkpoint/checksum/version. SHA final, revues indépendantes, vraie CI et merge encore dus ; aucune parité privée, migration exhaustive ni production revendiquée |
| F07 | **Livré** ; `~/.omp/wt/unkillable-forge/feat-F07-remote-mcp`, `feat/F07-remote-mcp`, base2999c69 | [PR #11](https://github.com/go-silex/unkillable-forge/pull/11), head `d575e6da3c69f4ebcffbd1ca1720a049051b7d2f`, merge `24b2ac7909677706268247d69240cb4d44906912`. Trois revues finales CLEAR, [cinq jobs CI réussis](https://github.com/go-silex/unkillable-forge/actions/runs/43864982838) et [secret scan réussi](https://github.com/go-silex/unkillable-forge/actions/runs/43864983020). Après RED7/7, la correction complète des memberships scellés/tombstones et la fermeture du peer manquant passent installation propre,26 tests natifs et deux projets TS. Ni déploiement ni publication métier depuis les trois clients revendiqués |
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

### Corrections après revue de0a80726 — 2026-11-14, F04 toujours non accepté

- [CI réelle43625865873](https://github.com/go-silex/unkillable-forge/actions/runs/43625865873) : cinq checks requis réussis,309 Vitest et205 Python sur l'arbre exact0a80726 ; merge CI `7d3ddcddf21b4a480de038e8569f55c535388e12`, arbre commun `a6f50d92a41ac9ee6952df34d05e63320053f6ae`. Le passage ready contourne zéro check et n'autorise aucun merge/déploiement ; auto-merge/releases restent désarmés.
- Les correctifs postérieurs à ce SHA ont leurs propres RED→GREEN locaux : restauration arbre/sous-arbre avec refus de dérive puis remède explicite unpublish→restore ; replay HTTP d'un administrateur révoqué403 ; dépassement connu arrêté immédiatement ; rotation JWKS et contrôles natifs de concurrence/cooldown ; audit64 transferts constant128 événements pour1 ou32 pages. R6 a reproduit deux faux timeouts puis prouvé l'identité de l'erreur native et la réconciliation du vrai gagnant sealed ; R7 refuse keep d'un tombstone dès begin. R12 réutilise la projection Catalogue au lieu d'une politique pages copiée. Dernier checkpoint avant optimisation :7 cas domaine et27 cas HTTP réussis, reçu privé `F04-R6-R7-R12-native-GREEN-after-0a80726.json`, SHA256 `62d06a2de10ae2624a06b63c1ee8f29fe4e31e7e1781e11aa676c5d89a5f7e15`. Pas une nouvelle suite complète.
- Checkpoint historique, **superseded ci-dessous** : namespace D1 calibré sur56 271 mounts,842 routes subtree et136 271 ressources, N10 000. Scan SUM56 271 lignes, point PK1 ; guard arbre8 441 700 lectures, huit pages répètent huit fois le travail (~6s). EXPLAIN identifie rescan ressources×routes et scan mounts par document. Le design accepté garde chaque autorisation/CAS/audit et sépare O1 déduplication et O2 ranges BINARY. À ce checkpoint O1 était en vérification et O2 pas encore appliqué ; leurs résultats ultérieurs sont ci-dessous, pas une capacité cloud inférée.
- Checkpoint historique, **superseded ci-dessous** : premier dispositif de diagnostic échoue avant sa faute ; suivant capture deux `Network connection lost` dans `r2:bucket`, pas une fonction/promise source. Son loopback Inspector fragmenté refuse l'attachement ; client-disconnected non attribué. Le troisième dispositif est alors seulement préparé. Les trois résultats finaux restent INCONCLUSIVE, sans suppression ni innocence universelle revendiquée.
- **Toujours4/16 livrés.** Les preuves locales ne valent ni capacité Cloudflare, ni publication MCP métier depuis les trois clients, ni migration de données. Revue indépendante et CI du SHA final restent requises. Aucun grant F04 de ressources/déploiement/observabilité/nettoyage ; production Unkillable, ses accès/liens, les shortlinks et Roxabi restent inchangés. F05/F07 non démarrés.

### Local O1/O2 checkpoints and remaining final-source gates

**Historical checkpoint, superseded below:** normal guard-only commits `52822a33b66aceb440f8d1b9799c4c19edbf759e` (dedupe) and `e217b7a4b00f9a19ffc3e3c944c26868fa9837b6` (indexed ranges) were then local and other corrections uncommitted. They were subsequently included in normal commits `968189f`, `d0a3c54` and `02ec355`, pushed without bypass and covered by actual CI. None is an accepted F04 delivery SHA.

Native metadata-only probes now cover all ten shapes, including P=1,000/N=10,000 update and restore over a seeded namespace of 66,271 mounts/1,842 subtree routes/166,271 resources/1,851 pages. Both extended batches read 37,688 rows total, add exactly 1,000 audit events and retain no assertions. Actual guard EXPLAIN uses indexed revision/path and mount/path ranges. These are not full publication, remote D1/R2, CPU or memory proofs. All 70 Catalogue tests and all 17 Publication behavior tests pass after O2, including four deterministic pin/restore-vs-GC orderings.

The local runtime diagnostic experiment stops with three inconclusive captures: the final Inspector barrier cannot attach the loopback target, so its prepared three-fault loop did not run. Two observed network errors in the native R2 target do not identify every CI diagnostic's cause. No logs are suppressed or classified harmless; the two throwaway test files are privately hash-archived and removed before final checks. F04 is still **NOT DELIVERED**, with final-SHA independent review, actual required CI and separately authorized real Cloudflare witness outstanding. No F04 Cloudflare grant; F05/F07 stay blocked; production access, URLs, assets and shortlinks are unchanged.

### Vérification finale locale des correctifs, avant nouveau candidat

- La suite complète nettoyée exécute 40 fichiers/353 tests : 351 passent, deux anciennes attentes `conflict` contredisent désormais le refus `forbidden` d'un acteur fraîchement révoqué. Le typecheck signale séparément le passage d'un tableau readonly au `batch` natif mutable dans l'adaptateur de test. Aucun correctif supplémentaire du moteur n'est nécessaire pour ces trois écarts.
- Après correction des seuls trois fichiers de test, les deux projets TypeScript passent et les 64 tests des trois fichiers concernés passent. Le cas d'époque modifiée avec autorité conservée reste `conflict`. Les assertions de reçu, lecture et octets restent intactes. Le manifeste de 81 inputs sélectionnés est stable pendant cette vérification ; il ne désigne pas tous les fichiers du dépôt.
- Cela ne constitue pas une nouvelle exécution complète des353 tests, ni une CI du futur SHA, ni une acceptation F04. Le client privé et le générateur de témoin sont en préparation ; aucune exécution Cloudflare ni autorisation de ressources, de télémétrie ou de nettoyage n'en découle.

### Projections Publication et préparation hors ligne du témoin

- Le checkpoint correctif local `968189f8168567f11c553a781a4d75fd005f39c7` est suivi d'un ajustement de lecture : le transfert ne charge que page ID/disposition/époque, sans metadata inutile ; status ne charge plus les edges inutilisés. TSC deux projets et71 tests natifs/7 fichiers passent après cet ajustement. Les diagnostics natifs négatifs restent conservés, sans qualification d'innocuité.
- Le générateur privé produit réellement un témoin2 fichiers/1 page/1 edge et un témoin10000 fichiers/1000 pages/20000 edges, chacun avec un document de33554432 octets. Tous les fichiers, tailles, SHA, modes privés et liens HTML→edges sont vérifiés indépendamment. La commande jointe fait4284171 octets. C'est une preuve hors ligne du générateur, pas encore une admission/publication de cette forme par le moteur.
- Le raccord retenu pour le futur témoin est l'entry manage inchangée, sans wrapper ni endpoint maintenance. Les exercices locaux F04 de concurrence/reprise/révocation/GC restent obligatoires ; l'orchestration de maintenance demeure F10/F11. Le témoin Cloudflare32Mio doit couvrir upload et matérialisation serveur, avec inspection D1/R2 indépendante. Aucun grant n'est présent ; standard mémoire, capacité jointe, revue du prochain SHA et CI effective restent ouverts.

### Secondes revues02ec et correction causale native — 2026-11-15

- Candidat exact `02ec355da6ab1b2c5549aa99406eb7e1bb670772`, [CI43652840063](https://github.com/go-silex/unkillable-forge/actions/runs/43652840063) : cinq jobs requis success,40 fichiers/353 Vitest et205 Python ; [TruffleHog43652839992](https://github.com/go-silex/unkillable-forge/actions/runs/43652839992) success. Le push normal a réellement exécuté ses hooks. Release skipped n'est pas une preuve. Head et mergeCI `c4bad8e5f6766cc9d52f5d09e95143c9654b58ce` ont le même arbre observé `5300ce9127757fb1d2037d64f7832b970098c824`.
- Les deux revues indépendantes exactes02ec sont NOT_CLEAR/NOT_READY. B1 est reproduit réellement : quatre restores sealed/abandoned admin/scoped activent à tort une révision jamais committée et ses documents sans nouvelle page ; drop non-live ouvre aussi une session invalide. La correction respecte restore « active again » : preuve COMMIT Publication permanente exacte et événement atomique, jamais seal/origin comme substitut ; refus sans effets ni suppression des octets. Existence/discard précèdent drift/Store. F10/F11 doivent importer/preserver une activation historique prouvée, sans faux receipt.
- Vérification après correction : TSC deux projets PASS ;11 restores et trois deadlines natifs PASS,31 HTTP-publication PASS. Le run de quatre fichiers passe48 cas et échoue six fixtures S1 sur un double bootstrap avant la course. Correction du seul appel doublon, puis6/6 courses natives PASS avec sources sélectionnées stables ; pas de nouveau run complet prétendu. Le cas R2 réel1005 fichiers/reuse/restore, l'audit128/128, les vecteurs D1 rows_written1/32pages, seal2P/commitP et la croissance rows_read N128/512 passent aussi dans le premier run.
- Les courses scoped à deux pages couvrent revoke, disable, assign, retirement et visibility de la page non sélectionnée, avant et après Store. Disable en vol est `unauthenticated` avant epoch ; un nouveau handle ultérieur conserve sa précédence session409. Le collecteur refuse vraiment une base active/ouverte : pas de corruption SQL fabriquée pour prétendre une course impossible. Status lit désormais uniquement les champs consommés, sans metadata inutilisée ; le vrai gagnant seal est aussi testé avec la cause exacte de son timeout Store, séparément de la branche conflict.
- Les scripts privés du témoin ne valent pas une preuve native : syntaxe/refus sans arguments PASS, générateur joint hors ligne vérifié ; harnais10k/1k/20k et largeur/UTF-8 à relier/exécuter au nouveau SHA. Aucun cycle cloud exécuté, aucun grant F04. R16 reste INCONCLUSIVE ;11/22/16/38 sont des occurrences textuelles du logCI02ec, pas des événements uniques ou inoffensifs. Mémoire H1 non décidée : métriques d'isolat à l'invocation ≠ pic par requête.

**Toujours4/16 livrés.** Ce checkpoint correctif ne ferme pas F04 ; le prochain SHA demande sa propre liaison, revue indépendante et vraie CI. Capacité locale jointe et32Mio upload/matérialisation cloud, inspection D1/R2/CPU/mémoire restent des gates séparées. Aucun merge, bascule, droit Cloudflare F04, retrait de credential, changement production/Roxabi, accès/clé/URL/asset ou shortlink.

### Politique committed-only et preuves baseline — 2026-11-15

- Décision humaine `pinned_share_revision_policy=committed_only` : toute création ou rotation d'un pin exige une activation Publication durable pour le triplet exact instance/artefact/révision. Le guard Catalogue décide atomiquement, sans contrôle rétroactif en lecture ni révocation automatique. `importShare` reste `follow_active` seulement ; F10 devra préserver les droits et prouver toute activation historique équivalente sans fausse session native ; F11 préservera les faits.
- RED natif avant correctif sur les sources runtime `96fe5e2` : deux projets TypeScript passent ; huit fichiers, 113 tests, dont 13 refus attendus résolus à tort et 100 succès. Les 82 inputs sélectionnés sont identiques avant/après. Cela établit le bypass avant correction, pas un GREEN du futur SHA.
- Baseline exacte `96fe5e2` : Native MAX réussit 10 000 fichiers, 1 000 pages, 20 000 edges, deux révisions CV1→2 et 10 000 décisions de lecture en 471 861 ms (client all→base all). Native WIDTH est une preuve d'admission seulement : 8 Mio UTF-8 exacts, 250 métadonnées de 8 192 unités acceptées ; 8 193, UTF-8 malformé et dépassement de budget octets refusés. Reçu privé `F04-native96-MAX-and-WIDTH-GREEN.json`, SHA-256 `2f6df463a78774ab525a2c6767695be65348123817d5fadfa56636bd8eef4ae7`.
- CI réelle baseline `96fe5e2` : cinq jobs et secret scan verts, 367 Vitest/205 Python, arbre `77f985e`, merge CI `042f1c4` ; revue du code de ce seul baseline claire, pas acceptation de livraison. Aucun résultat n'est attribué au futur SHA corrigé, qui exige sa propre revue et CI.
- Décision humaine `f04_memory_evidence_standard=operational_limits_no_peak_claim` : le témoin cloud 32 Mio et joint exige des opérations réussies, le contrôle des dépassements mémoire et les métriques natives disponibles, sans revendiquer de pic ou marge par requête. Ni plafond permanent à 32 Mio ni abandon des cardinalités, concurrence ou fichiers plus gros à supporter avant migration. Aucun grant F04 Cloudflare, écriture ni télémétrie n'est accordé ; les opérateurs cloud restent incomplets.

**Toujours 4/16 livrés ; F04 non livré.** Aucun merge, bascule, changement de droits, clé, URL, asset ou shortlink n'est autorisé par ce checkpoint.

### Revue du correctif Q1 et CI réelle — 2026-11-15

- Runtime `e38a7b2a17f326c043b74dfd2aa629ee98cd5653` : GREEN natif 113/113 sur les mêmes tests que le RED 13/100, avec 82 inputs stables ; [CI43701028804](https://github.com/go-silex/unkillable-forge/actions/runs/43701028804) cinq jobs requis verts, 41 fichiers/384 Vitest et 205 Python ; [secret scan43701028744](https://github.com/go-silex/unkillable-forge/actions/runs/43701028744) vert. Le merge CI `5c8e88cd0b4caf5be290611773f3500fccc1ca5f` et le head ont le même arbre observé `fffee568a733d5f7eaf51cb5ba8f58c4b00827c3`.
- Les deux revues indépendantes de ce SHA ne trouvent aucun défaut bloquant dans le runtime Q1, mais E1/D-1 signale trois cellules normatives perdues en §6 du contrat. Le présent correctif documentaire rétablit `actor authority · policy epoch` pour share, rotate/revoke et import, corrige le renvoi ADR vers §7 et précise le glossaire. Aucun code, test, schéma, ordre de refus ou droit existant ne change.
- R16 reste INCONCLUSIVE. Le log CI `e38a7b2` contient 12 occurrences `fixed-length`, 24 `Network connection lost`, 16 `client disconnected` et 40 `Uncaught` : ce sont des occurrences textuelles, pas une attribution causale, un nombre d'événements ou une preuve d'innocuité. Les résultats et comptes antérieurs restent historiques.
- La correction documentaire demande un nouveau SHA, sa liaison, sa revue et sa CI propres. Les preuves jointes/largeur du SHA final et les cycles Cloudflare restent à établir ; les préparations privées ne sont pas des résultats. H1 est décidé selon le standard indiqué ci-dessus, mais aucun grant Cloudflare F04, déploiement, bootstrap, télémétrie ou bascule n'est accordé.

**Toujours 4/16 livrés ; F04 non livré.** Aucun changement de production, accès, clé de partage, URL, asset ou shortlink.
