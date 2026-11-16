# F08 — validation des trois clients sur staging

**Proposition d’opération, non autorisation d’exécution et non bascule de production.** La PR de cette opération et le candidat applicatif doivent être revus et leurs checks requis réellement verts avant toute écriture Cloudflare, connexion OAuth ou exécution de client utilisant un modèle.

## Périmètre fixé

| Entrée | Valeur |
|---|---|
| Application approuvable | `4db8a1f0d28515c67875ff2bd0d662d730c7156b`, PR13 de `go-silex/unkillable-forge` |
| Opération | Branche/worktree `ops/F08-staging-clients` / `~/.omp/wt/unkillable-forge/ops-F08-staging-clients` |
| Compte et instance | GOSILEX / Tool@gosilex ; staging `forge-f04-witness-20261115-01`, jamais Roxabi |
| Administration | `https://forge-f04-witness-20261114.unkillablecompanies.com` |
| Lecture séparée | `https://forge-f04-read-20261115-01.unkillablecompanies.com` ; Worker de lecture proposé `forge-f08-read-20261116-01` |

Le plan applicable est celui du SHA applicatif ci-dessus, avec retrait de la restauration avancée du chemin critique. Les anciens reçus ne prouvent pas l’état Cloudflare actuel. Le profil opérateur privé existant est sous `$HOME/.omp/private/forge-convergence/F04/staging-F04-01/` ; ses identifiants et secrets ne sont pas copiés dans ce dépôt.

## 1. Autorisations et prérequis

- Obtenir un accord explicite pour cette opération exacte : lectures Cloudflare de contrôle, mise à jour du seul Worker d’administration staging, ajout du Worker de lecture et du seul raccordement de son hostname staging, accès staging limité à l’opérateur, réutilisation de la clé serveur de vérification existante sans rotation, publications synthétiques des trois clients et appels de modèle minimaux nécessaires.
- Cet accord ne couvre ni `forge.unkillablecompanies.com`, ni les ressources Roxabi, ni import historique, Shlink/Browser Run, renommage/visibilité GitHub, suppression de ressources, retrait de credentials legacy ou modification des vrais profils clients.
- Vérifier les revues du SHA applicatif et du SHA de la PR d’opération. Les huit consommateurs de payloads committés Node22/26 et les autres checks requis ne peuvent être remplacés par des producteurs ou des jobs ignorés. Une annulation CI reste à résoudre avant exécution.

## 2. Préflight en lecture seule

- Vérifier fraîchement identité du compte, noms/identifiants et propriété des ressources, bindings D1/R2, version actuellement déployée, origines, routes/DNS, applications/politiques Access et visibilité du bucket. Fixer explicitement le compte depuis le profil privé vérifié ; ne pas utiliser le compte CLI ou navigateur par défaut comme preuve.
- Comparer aux reçus F04 en conservant leur attribution historique. Refuser toute ressource ou route étrangère, collision de hostname, binding inattendu, compte différent ou impossibilité d’établir la propriété. Ne rien adopter, écraser ou élargir par défaut.
- Le Worker de lecture proposé ne peut être créé que si son absence est confirmée. Un Worker existant à ce nom ou un hostname déjà attaché à une autre cible impose arrêt et ajustement explicitement approuvé. L’accès staging de lecture doit rester limité à l’opérateur, pas de Bypass public improvisé.
- Relever la version antérieure et les réglages effectifs, sans extraire les valeurs de secrets. Vérifier les migrations nécessaires au SHA applicatif ; aucune modification de schéma non décrite dans cet accord n’est admise.

## 3. Déploiement isolé

- Créer un nouveau worktree **détaché au SHA applicatif fixé**, après approbation ; ne pas déployer depuis la branche mutable d’implémentation, la PR d’opération ou un checkout principal.
- Garder Wrangler pour ce projet existant. Dériver deux configurations privées explicitement relues : `adapters/http/manageWorker.ts` pour le Worker staging existant et `adapters/http/readWorker.ts` pour le Worker de lecture proposé. Les deux utilisent uniquement les D1/R2 de cette instance ; `FORGE_INSTANCE` conserve les origines séparées et les audiences appropriées.
- Maintenir les limites et protections staging existantes : CPU1000ms, workers.dev/previews désactivés, aucun cron, observability/Logpush/tails désactivés. Ne pas confier à un deploy non interactif une création de custom-domain susceptible d’écraser DNS ; raccorder le seul hostname approuvé séparément, après contrôle d’absence de cible étrangère.
- Réutiliser la clé serveur de vérification du profil privé pour le seul nouveau Worker de lecture, sans afficher sa valeur ni la mettre dans arguments/Git/contexte modèle. Aucun nouveau droit Cloudflare n’est donné aux clients publishers.
- Relire les versions réellement déployées, bindings, compte, limites, routes et protections Access. Arrêter avant publication si l’origine d’administration et celle des artefacts ne sont pas séparées ou si une protection attendue est inconnue.

## 4. Parcours natifs bornés

- Préparer uniquement des fixtures synthétiques de petite taille dans une nouvelle racine isolée, pas dans le hub, `~/.roxabi/forge` ou un snapshot publié. Les trois profils publishers ne peuvent sélectionner que cette racine et leur propre état privé.
- Installer le paquet exact et complet depuis le catalogue/source approuvé. Utiliser les commandes documentées `profile-check` et `config-proposal` pour Claude Code, Codex et OMP ; ne modifier aucun profil réel. Les processus clients/MCP sont lancés avec environnement nettoyé et HOME/état isolés, sans token, configuration d’administration ou credential CLI Cloudflare. Seule l’authentification modèle nécessaire au client peut être réutilisée localement sans exposer ses octets ; les originaux restent intacts.
- Réaliser OAuth sur l’origine staging approuvée puis une publication effective par chacun des trois clients via ses vrais appels MCP ; les outils disponibles doivent empêcher la lecture des octets des fixtures dans le contexte du modèle. Le publisher reçoit des chemins/métadonnées, transfère lui-même les fichiers et renvoie des reçus/URLs, jamais les corps de fichiers.
- Vérifier une mise à jour/reprise bornée, les octets et assets effectivement servis depuis l’origine de lecture, puis le refus sans autorisation et après révocation d’un **nouveau partage synthétique seulement**. Ne révoquer aucun principal, rôle ou accès préexistant. Vérifier la surface réelle dans le navigateur ; un GET opérateur ou un test de SDK ne remplace pas la preuve des trois clients.
- Conserver SHA, versions, clients/commandes, identifiants des seuls artefacts de test, empreintes, résultats et limites dans des reçus privés sans token ni clé brute. Aucun benchmark de capacité, rendu Browser Run ou appel Shlink n’est inclus.

## 5. Sortie et incident

Succès de cette opération signifie seulement : le candidat exact fonctionne sur ce staging avec les trois clients, sans administration Cloudflare dans leurs processus. Ce n’est ni une migration de catalogue en production, ni F08 entièrement livré, ni preuve de conservation de tous les droits historiques.

En cas d’échec : arrêter les publishers de test et conserver les reçus et données pour diagnostic. Ne restaurer aucune ancienne D1/R2, ne ressusciter aucun grant révoqué et ne supprimer aucune ressource. Un retour de code ne peut utiliser qu’une version dont la compatibilité avec les **données courantes** est établie et approuvée ; sinon laisser l’opération arrêtée, sans prétendre à un rollback réussi. Les seuls fichiers temporaires/authentifications copiés et créés pour ces essais peuvent être nettoyés sans toucher aux originaux ni aux credentials legacy.
