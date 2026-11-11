# Convergence Forge — état d'exécution

Plan : [forge-convergence-plan.md](forge-convergence-plan.md). Dernière mise à jour : 2026-11-11. Ce suivi ne constitue pas une autorisation de mutation de production.

## Autorisations et invariants

- Autorisation opérateur obtenue pour commits, pushes, PR et merges des lots du plan, uniquement après revue indépendante du SHA final et CI verte.
- Renommage, passage privé, migration/bascule de production, suppression de ressources et retrait de credentials : confirmations distinctes encore requises.
- Périmètre Roxabi confirmé : préserver les pages de l'ancien déploiement arbre, leurs ressources nécessaires et les publications actuelles, avec URLs et droits conservés.
- Amendement F02 confirmé : nouveau canon public avec ascendance Silex ; ancien dépôt gardé à son URL et figé jusqu'à archivage final. Création du dépôt encore soumise au SHA exact et au runbook revu.
- Checkouts principaux et changements utilisateur préservés. Le document initial reste dans son worktree ; une copie est incluse dans F01 pour son versionnement.
- Toute écriture de code/documentation se fait en worktree dédié. Les inventaires de corpus et preuves privées restent hors Git ; aucune valeur de partage n'est publiée.

## F01 — observations réalisées en lecture seule

### État courant réellement observé

| Instance | Fichiers du manifeste de déploiement | HTML du manifeste | Pages du snapshot KV | Catalogue authentifié |
|---|---:|---:|---:|---:|
| Unkillable | 684 | 201 | 159 | 159 entrées |
| Roxabi | 16 | 5 | 828 | 0 entrée |

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
- **Correction de F02 validée :** créer le nouveau canon avec l'ascendance publique approuvée, laisser l'ancien moteur à son URL figée. L'indisponibilité de postes ne bloque plus F03, mais le confinement serveur de leurs anciens droits reste une gate obligatoire de bascule.

Les preuves machine détaillées restent privées, hors Git. Vérification ciblée du CLI : **9 tests Python réussis** ; exécution réelle `--local-only` sur le hub Unkillable : code 0, 1 052 fichiers, 159 slugs, 198 candidats HTML, rapport mode 0600. Ce mode reste explicitement incomplet pour le live. Une erreur de détection de pagination des projets sans `id` a été corrigée ; aucune page distante n'est sautée pour rendre le test vert. F01 attend encore sa PR, la revue indépendante du SHA final et la CI requise.

Référence scellée des preuves privées : index `F01-evidence-sha256.txt`, SHA-256 `aa89f76ec569e126129112a048be5d5c86424a2460c6417b21869c898ecfd74d`. Les fichiers de preuve et l'index sont en mode 0600, dans un répertoire privé hors worktree ; aucun contenu de corpus ni secret de partage dans cette PR.

## Lots et traçabilité

### Vague A

| Lot | État | Worktree / branche | PR / SHA / preuves ou blocage |
|---|---|---|---|
| F01 | Vérification locale réussie ; livraison en cours | `~/.omp/wt/silex-forge/docs-F01-inventory` ; `docs/F01-inventory` | Base `3c3c442` ; 9 tests verts + smoke CLI réel ; inventaires/reconstruction et périmètre établis ; PR/revue/CI à obtenir |
| F02 | Non démarré | Convention du plan | Attend livraison F01 ; amendement nouveau canon approuvé, création non encore autorisée au SHA exact |
| F03 | Non démarré | Convention du plan | Attend F01/F02 et preuve d'isolement du nouveau canon par rapport au dépôt legacy figé |
| F06 | Non démarré | Convention du plan | Attend F02 |

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
