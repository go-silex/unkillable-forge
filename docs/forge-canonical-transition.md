# F02: direct canonical seed

**Proposal only: G0 is not granted.** The operator confirms no traffic or
modifications currently in progress. This is not permission to publish, cancel
runs, create a repository, change GitHub settings or operate Cloudflare. No
further personal-token/app-owner census is a prerequisite; inspect the known
workflows and state at the boundaries below.

The intended new public, ordinary, non-fork repository is
`go-silex/unkillable-forge`. The legacy `go-silex/silex-forge` URL and its
`main` stay unchanged and frozen, unarchived until F15. Existing 1.7.3/1.3.0
clients that cannot be updated clone old `main`; repository separation protects
them. Canonical development may start in F03 after F02 delivery; plugin identity
and distribution remain unchanged until F08. No new release under the legacy
plugin name is authorized.

There is **no old bootstrap merge**, generated old seed branch, temporary old
Actions CI, history rewrite of old refs, second development PR, force push,
shared-remote retargeting, production deployment, import, migration, credential
retirement or Cloudflare action. G1b stays open. R2/D1, three real MCP clients,
legacy links, keys, rights, assets, recovery and future-write rollback criteria
remain unchanged. Do not publish private Roxabi history. This preparation does
not purge the existing public legacy history or its copies.

## 1. Inputs and private preparation

| Input | Required evidence |
|---|---|
| `OLD=go-silex/silex-forge`, `NEW=go-silex/unkillable-forge` | Authenticated actor, organization ownership and public visibility freshly verified. A prior lookup did not resolve `NEW` and clone paths were absent; neither proves current availability. A 404 may be insufficient access. |
| `SOURCE_SHA`, `SOURCE_REF`, `SOURCE_PR` | Exact full original PR head SHA, public `refs/pull/$SOURCE_PR/head` and PR number. Independently review final source and obtain real green source-tree CI before publication. While awaiting G0 the source PR must be draft, without the `reviewed` label, and not mergeable. Re-read exact head/ref before G0. PR70 is the source, never an instruction to merge it. |
| `SEED_SHA` | Derived from an independently reviewed private clean rewrite of exactly `SOURCE_SHA`; not a prototype SHA. Preserve the commit map, tree-equality and source/security/provenance review privately. |
| `WORK`, `CANON_CLONE`, `RULES` | Distinct absolute paths outside shared worktrees; new private `WORK` mode 700 and private replacement rules mode 600. No secrets, raw identifiers or real artifact HTML in Git or public evidence. |
| G0 | Explicit operator approval of this procedure, actor, target, quiet window, exact source/ref, exact seed and `refs/heads/main` destination, public exposure, signature loss, old freeze, empty new repository and settings. Exact-seed CI on the actual new repo is required before F02 acceptance. G0 is not granted by review or this document. |

Prepare a private single-ref, no-tags clone of the public source. Validate full
40-character lowercase `SOURCE_SHA`, numeric `SOURCE_PR` and exact `SOURCE_REF`.
Use a fresh anonymous environment and non-repository cwd, with Git discovery
bounded there, so no checkout config, URL rewrites, extra headers or stored
credentials are inherited. Require exactly one advertised line with exact ref
and SHA; repeat before G0. For example, with fresh absolute `WORK`:

```bash
umask 077
mkdir -m 700 "$WORK" "$WORK/home" "$WORK/cwd"
CLEAN_HOME=$(cd "$WORK/home" && pwd -P)
CLEAN_CWD=$(cd "$WORK/cwd" && pwd -P)
(
  cd "$CLEAN_CWD" || exit 1
  env -i PATH="$PATH" HOME="$CLEAN_HOME" GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 \
    GIT_CEILING_DIRECTORIES="$CLEAN_CWD" \
    git ls-remote "https://github.com/$OLD.git" "$SOURCE_REF"
) > "$WORK/source-ref"
[ "$(wc -l < "$WORK/source-ref")" -eq 1 ] || exit 1
[ "$(cut -f1 "$WORK/source-ref")" = "$SOURCE_SHA" ] || exit 1
[ "$(cut -f2 "$WORK/source-ref")" = "$SOURCE_REF" ] || exit 1
```

Fetch just that ref anonymously to a fresh bare repository, compare the fetched
SHA, and clone only its local `main` into a fresh private clone:

```bash
env -i PATH="$PATH" HOME="$CLEAN_HOME" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git init --bare "$WORK/original.git"
env -i PATH="$PATH" HOME="$CLEAN_HOME" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git -C "$WORK/original.git" fetch --no-tags "https://github.com/$OLD.git" "$SOURCE_REF:refs/heads/main"
[ "$(git -C "$WORK/original.git" rev-parse 'refs/heads/main^{commit}')" = "$SOURCE_SHA" ] || exit 1
env -i PATH="$PATH" HOME="$CLEAN_HOME" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git clone --no-local --no-tags --single-branch --branch main "$WORK/original.git" "$WORK/filter-clone"
```

Verify the private rules SHA-256 is
`f23c7c10038857ed9cd9a562ee99e20b5b3ae91cd9fc3f70ff6892d85dee0f4f`
without displaying its contents, and installed `git-filter-repo` fingerprint
is `a40bce548d2c`. Run the one-time native filter only on that fresh clone:

```bash
git -C "$WORK/filter-clone" filter-repo --replace-text "$RULES" --preserve-commit-hashes --preserve-commit-encoding --replace-refs delete-no-add --prune-empty never --prune-degenerate never
```

Never use `--force`, `--mirror`, `--all`, `--refs`, `--partial` or message
replacement. Independently compare mapped old/new commits: bijection and ordered
parents, authors, committers, dates/timezones, message bytes/encoding, paths,
modes and licenses. Only two specified historical identifier substitutions in
one blob are authorized; all other changes stop the procedure. Rewritten commit
IDs differ; signatures and extended headers dropped by rewriting cannot certify
new IDs. The private prototype observed 50 removed historical `gpgsig` headers;
recheck and record the actual final-source count and any other header loss.
`tree(SEED_SHA)` must equal `tree(SOURCE_SHA)`. A prototype is not final proof.

Create a **fresh** `--no-local --no-tags --single-branch` export from rewritten
`main`; derive `SEED_SHA` from that export. Audit all reachable objects for both
exact private identifiers and generic secrets/identifiers, and prove no old
unsanitized unreachable objects, other refs, tags, notes, replace refs, alternates,
shallow dependencies, private ancestry or real artifact HTML leaked into it.
No raw matches in public logs. Independently review this exact export, source
mapping, licenses and all-reachable-object audit before requesting G0. Fail
closed on unknowns; an ordinary CI secret scan is not this history audit.

## 2. Bounded baseline and G0

Record privately: actor, old/new identity, source PR head/ref and green source
checks; old main SHA; all heads and tags (tag objects and peeled commits),
manifest hashes, all release metadata and paginated assets/hashes; current
`PR_Main`, effective inherited rules, Actions permissions and known nonterminal
workflows. Require old `main` to equal
`8440d7009ed771fcab2c64642048e96afa9b3a8c` **before baselining and again before
mutation**; any other SHA is a stop, never a new baseline. Strictly compare old
main, tags, manifests and releases at each boundary. Inventory other heads and
GitHub-managed pull refs diagnostically: Dependabot's weekly updates may create
non-main branches and PRs independently of Actions. Do not treat them as
published engine changes or copy them; do not adopt unexpected non-bot or
operator head changes as authorized pushes. Keep source branch and `SOURCE_REF`
bound to the exact reviewed SHA. The only planned old differences are explicit
settings and additive freeze rules. Re-read old `delete_branch_on_merge`; require
`false` or stop for renewed approval; never change it implicitly. Preserve
existing `PR_Main` (PR, strict `check`/`test`,
resolved threads, no non-fast-forward/deletion, no bypass); classic branch
protection 404 does not mean `main` is unprotected.

Also require OLD native auto-merge disabled. The draft source PR must remain
without `reviewed`, not mergeable, while awaiting G0. For subsequent source CI,
the operator may emit `ready_for_review` and immediately return it to draft
while checks are pending; prove all five jobs on that exact event/head. Never
leave it ready between stages. Do not disable Dependabot, delete its branches,
or change old main/config. Existing old no-update freeze, disabled Actions
writers and native auto-merge off prevent silent bot merge.

G0 must name the exact source and seed SHAs, destination, scope and actor, and
approve publication plus the recorded rewrite/signature loss. Source CI and
private audit precede G0/publication; exact seed CI is performed on NEW before
F02 acceptance. Re-read actor, identity, source and baseline immediately before
mutations. Stop on unknown state or drift. No G0 has been executed.

## 3. Freeze legacy without touching its main

After G0, set both repository overrides to literal `false`, disable known
writer workflows and old Actions, then read back. A false variable or disabled
Actions does **not** cancel already queued/running jobs. Inventory all pages;
wait for `queued`, `requested`, `waiting`, `pending` and `in_progress` writers
and descendants to finish, or stop. Explicit G0 **may** separately authorize
containment cancellation of only old-main CI run `43095154240` and Secret scan
run `43095154264`, after re-reading and validating each run's repository,
workflow, `main` ref and head SHA against the approved baseline. Otherwise wait
or stop. Never cancel another run without new authority; drain descendants and
stop on unexpected state.

Resolve numeric `MERGE_WORKFLOW_ID` from the paginated old workflow listing by
verified MergeOnGreen name and path. Disable any other identified writer
workflow likewise and read each workflow's `disabled_manually` state.

```bash
gh variable set FORGE_RELEASES_ENABLED --repo "$OLD" --body false
gh variable set FORGE_AUTOMERGE_ENABLED --repo "$OLD" --body false
gh api --method PUT "repos/$OLD/actions/workflows/$MERGE_WORKFLOW_ID/disable"
gh api --method PUT "repos/$OLD/actions/permissions" -F enabled=false
gh variable get FORGE_RELEASES_ENABLED --repo "$OLD"
gh variable get FORGE_AUTOMERGE_ENABLED --repo "$OLD"
gh api "repos/$OLD/actions/permissions"
```

Verify both `false`, Actions `enabled=false`, known writer workflows disabled,
and no write-capable outstanding run. Add separate active **no-bypass** old-main
update/deletion and all-tags creation/update/deletion rulesets; do not replace
or weaken `PR_Main`. Confirm these names do not already exist before posting:

```bash
cat > "$WORK/freeze-main.json" <<'JSON'
{"name":"F02_Freeze_Main","target":"branch","enforcement":"active","bypass_actors":[],"conditions":{"ref_name":{"include":["refs/heads/main"],"exclude":[]}},"rules":[{"type":"update","parameters":{"update_allows_fetch_and_merge":false}},{"type":"deletion"}]}
JSON
cat > "$WORK/freeze-tags.json" <<'JSON'
{"name":"F02_Freeze_Tags","target":"tag","enforcement":"active","bypass_actors":[],"conditions":{"ref_name":{"include":["~ALL"],"exclude":[]}},"rules":[{"type":"creation"},{"type":"update","parameters":{"update_allows_fetch_and_merge":false}},{"type":"deletion"}]}
JSON
gh api --method POST "repos/$OLD/rulesets" --input "$WORK/freeze-main.json" > "$WORK/freeze-main-result.json"
gh api --method POST "repos/$OLD/rulesets" --input "$WORK/freeze-tags.json" > "$WORK/freeze-tags-result.json"
gh api "repos/$OLD/rulesets/$(jq -r .id "$WORK/freeze-main-result.json")"
gh api "repos/$OLD/rulesets/$(jq -r .id "$WORK/freeze-tags-result.json")"
gh api --paginate "repos/$OLD/rules/branches/main?per_page=100"
```

Read definitions and effective rules; require active scope, no bypass,
`update_allows_fetch_and_merge=false`, original `PR_Main` unchanged, native
auto-merge disabled, and old main/tags/manifests/releases identical to baseline.
Do not merge source PR
or change old engine. Admins can alter rules; tag rules do not stop release
metadata edits/deletion, and immutable releases are not an absolute historical
metadata freeze. Coordinate the window and compare evidence, not a claim of
absolute immutability.

## 4. Create new repository and seed exactly once

Only after G0, private/source review and verified legacy freeze: recheck target
availability and actor/owner. Create empty public ordinary non-fork NEW, without
a template, README, initial commit, tags or releases. Disable Actions and set
both repository overrides **before first push**; never assume inherited org
variables, secrets or App installation are absent.

```bash
gh repo create "$NEW" --public
gh api --method PUT "repos/$NEW/actions/permissions" -F enabled=false
gh variable set FORGE_RELEASES_ENABLED --repo "$NEW" --body false
gh variable set FORGE_AUTOMERGE_ENABLED --repo "$NEW" --body false
gh api "repos/$NEW" --jq '{full_name,owner:.owner.login,private,fork,default_branch}'
gh api "repos/$NEW/actions/permissions"
gh variable get FORGE_RELEASES_ENABLED --repo "$NEW"
gh variable get FORGE_AUTOMERGE_ENABLED --repo "$NEW"
gh api --paginate --slurp "repos/$NEW/branches?per_page=100"
gh api --paginate --slurp "repos/$NEW/tags?per_page=100"
(
  cd "$CLEAN_CWD" || exit 1
  env -i PATH="$PATH" HOME="$CLEAN_HOME" GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 \
    GIT_CEILING_DIRECTORIES="$CLEAN_CWD" git ls-remote "https://github.com/$NEW.git"
)
gh api --paginate --slurp "repos/$NEW/releases?per_page=100"
```

Confirm owner/name, public, non-fork, empty refs/releases, disabled Actions,
false overrides and intended default branch; a failed read is not emptiness.
Confirm no inherited path can mint the administrative App token while gated.
Stop empty if any check fails. From the independently reviewed clean export,
confirm `SEED_SHA` and push **only** that commit to destination `main`:

```bash
git -C "$WORK/clean-export" push "https://github.com/$NEW.git" "$SEED_SHA:refs/heads/main"
```

No mirror, force, tags, other refs or shared remote changes by the seed push.
Verify actor/owner, `main == SEED_SHA`, its tree equals `SOURCE_SHA` tree,
license, reviewed public boundary, false overrides and unchanged legacy
main/tags/manifests/releases. Other heads and PRs are diagnostic as above; do
not adopt unexpected non-bot or operator changes. If push outcome is uncertain,
stop and inspect; do not retry
blindly or delete anything.

## 5. Protect new main and prove actual seed CI

Configure NEW merge-commit-only settings and active, no-bypass `main` rules:
PR required, strict `check` and `test`, resolved threads, no non-fast-forward or
deletion. Validate positive numeric `CHECK_APP_ID` / `TEST_APP_ID` from actual
reviewed CI integration identities; preserve any stricter reviewed rules. The
following payload requires independent human review even when the GitHub
approval count is zero:

```bash
jq -n --argjson check "$CHECK_APP_ID" --argjson test "$TEST_APP_ID" '{name:"PR_Main",target:"branch",enforcement:"active",bypass_actors:[],conditions:{ref_name:{include:["refs/heads/main"],exclude:[]}},rules:[{type:"pull_request",parameters:{allowed_merge_methods:["merge"],dismiss_stale_reviews_on_push:false,require_code_owner_review:false,require_last_push_approval:false,required_approving_review_count:0,required_review_thread_resolution:true}},{type:"required_status_checks",parameters:{strict_required_status_checks_policy:true,required_status_checks:[{context:"check",integration_id:$check},{context:"test",integration_id:$test}]}},{type:"non_fast_forward"},{type:"deletion"}]}' > "$WORK/new-pr-main.json"
gh api --method PATCH "repos/$NEW" -F allow_merge_commit=true -F allow_squash_merge=false -F allow_rebase_merge=false -F allow_auto_merge=false
gh api --method POST "repos/$NEW/rulesets" --input "$WORK/new-pr-main.json" > "$WORK/new-rule-result.json"
gh api "repos/$NEW/rulesets/$(jq -r .id "$WORK/new-rule-result.json")"
gh api --paginate "repos/$NEW/rules/branches/main?per_page=100"
gh api "repos/$NEW" --jq '{allow_merge_commit,allow_squash_merge,allow_rebase_merge,allow_auto_merge}'
```


If the reviewed `CI_ALLOWED_ACTIONS` is `selected`, first run the following
while Actions remains off, then configure and read back the approved selection
using GitHub's selected-actions policy endpoint. Stop if the selection cannot
be verified; only then proceed to enable Actions below:

```bash
gh api --method PUT "repos/$NEW/actions/permissions" -F enabled=false -f allowed_actions=selected
gh api "repos/$NEW/actions/permissions"
gh api "repos/$NEW/actions/permissions/selected-actions"
```
Verify effective inherited and repository rules, checks and merge settings.
Enable Actions for CI only using reviewed organization-permitted
`CI_ALLOWED_ACTIONS` (`all`, `local_only`, or `selected`). For `selected`, first
set the mode to `selected` while Actions remains disabled, configure and read
back its selected-actions policy, then enable. Both overrides remain false. Verify
that the actual seeded CI workflow supports `workflow_dispatch`, and dispatch
it on NEW `main`:

```bash
case "$CI_ALLOWED_ACTIONS" in all|local_only|selected) ;; *) exit 1 ;; esac
gh api --method PUT "repos/$NEW/actions/permissions" -F enabled=true -f allowed_actions="$CI_ALLOWED_ACTIONS"
gh api "repos/$NEW/actions/permissions"
gh variable get FORGE_RELEASES_ENABLED --repo "$NEW"
gh variable get FORGE_AUTOMERGE_ENABLED --repo "$NEW"
gh workflow run "$CI_WORKFLOW" --repo "$NEW" --ref main
```

Identify the run by exact repository, workflow, `workflow_dispatch`, `main`,
actor, attempt and `head_sha == SEED_SHA`; inspect every paginated job for that
attempt. All five jobs `check`, `test`, `test-os / macos-bash32`, `test-bash32`
and `test-py39` must actually execute and be `completed/success`; skipped,
neutral, missing or pending is not success. Release must be skipped. A
MergeOnGreen `workflow_run` entry may exist, but its writer job must be skipped
before the App-token mint step; no administrative App-token mint may execute.
Re-read main,
settings, gates and legacy baseline after CI. Failure stops before F02
acceptance or feature work; do not enable writers, delete or manufacture success.

## 6. Delivery and later production window

Create a distinct canonical clone and dedicated worktree/provenance PR recording
actual source/seed SHAs, frozen legacy main, clean-history/license evidence and
signature caveat without private rules or identifiers. Obtain independent
final-head review, actual NEW CI and explicit SHA-matched merge-commit approval.
Deliver the operator's repository registry update through its own dedicated
worktree/PR/review/CI. Recompare legacy main/tags/manifests/releases and both
repositories' settings. Only after provenance and registry deliveries may old
PR70 be closed **without merge**, and only with separate explicit approval; do
not delete its branch/history. F02 is complete only when these proofs and
deliveries exist. F03/F06 start afterward.

F13 must be completed, including read GO, controlled MCP smokes and opening/
acceptance, before F14 begins with its own approved worktree/PR. They may run in
one coordinated cold maintenance window, with no external user publication.
Existing legacy-writer closure, final snapshots, backups, ACL checks and rollback
remain mandatory; no extra dual-write, long traffic ramp or global two-account
transaction is implied. G1b/import and production authorizations remain separate.

## Stop and recovery

Stop on changed SHA/ref, unknown provenance, failed audit or CI, unaccounted
writer/run, unexpected main/tag/release drift, name/owner ambiguity, unreadable
settings or ineffective rules. Preserve private evidence and report exact partial
state. Never automatically cancel runs, delete repositories/refs, unfreeze old,
rename, force push or bypass rules. Empty/partially seeded NEW remains disabled
with both gates false; if already enabled, coordinate separately approved
containment. Recovery or restoring writes requires a new explicitly approved plan.

## References

- [GitHub repository rulesets](https://docs.github.com/en/rest/repos/rules), [Actions permissions](https://docs.github.com/en/rest/actions/permissions), [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)
- [GitHub CLI repo create](https://cli.github.com/manual/gh_repo_create), [workflow run](https://cli.github.com/manual/gh_workflow_run), [PR merge](https://cli.github.com/manual/gh_pr_merge), [variables](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables)
- [Git config files](https://git-scm.com/docs/git-config#FILES), [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
