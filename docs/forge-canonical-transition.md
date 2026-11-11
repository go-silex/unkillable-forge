# Canonical repository transition (F02)

**Status: preparation only; G0 not granted and transition not executed.** The
operator authorized preparation of an isolated identifier-clean history only.
No GitHub creation, ref push, merge, settings change, publication or Cloudflare
operation follows from that approval. `go-silex/unkillable-forge` is the intended
new public canonical repository, not a claimed existing repository.
`go-silex/silex-forge` remains the legacy public URL, frozen and not archived
until F15. Existing 1.7.3/1.3.0 clients that cannot be updated clone old `main`;
separate repositories are the isolation boundary. Legacy engine and publisher
remain frozen; canonical development may proceed in F03 after F02. Plugin
identity and distribution do not change until F08; no automatic release under
the old plugin name is authorized.

G1b remains open: no F10, import, migration, production deployment, data
transfer, credential/app retirement or scope withdrawal. Never rewrite legacy
or Roxabi history, force-push, retarget shared remotes, archive, or rename a
repository. The single original bootstrap PR is not replaced by a development
PR for sanitized history. This runbook's commands after §2 require explicit G0;
the provenance PR additionally needs the normal explicit merge authorization.

## 1. Inputs, review and authorization

| Input | Required decision or evidence |
|---|---|
| `OLD=go-silex/silex-forge`, `NEW=go-silex/unkillable-forge` | Freshly verify authenticated account, organizational ownership and visibility. A prior lookup did not resolve the new name and planned clone paths were absent; neither establishes global or current availability. A 404 may mean insufficient access. |
| `APPROVED_PR` and `BOOTSTRAP_SHA` | Original old-repository bootstrap PR and its full, independently reviewed, CI-green head SHA. Record its reviewed base as `BASE_SHA`, the PR URL, head repository, review, checks and full public `BOOTSTRAP_REF=refs/pull/$APPROVED_PR/head`. Never embed this runbook's own prospective commit SHA. |
| `SEED_SHA`, `SEED_REF` | Full SHA of the independently reviewed **clean rewritten** history and a new, explicitly approved public ref such as `refs/heads/canonical-seed/F02`. The two SHAs differ. `SEED_REF` must not exist before creation and is an immutable generated source artifact, not a development branch. Destination is only `refs/heads/main` on `NEW`. |
| `WORK`, `CANON_CLONE` | Absolute, distinct, new paths outside existing worktrees. `WORK` is private, mode 700, with sufficient space; all artifacts inside are mode 600 as appropriate. Do not use dirty main checkouts or the F01 worktree. |
| `RULES` | Private mode-600 replacement rules containing only the two previously identified historical values and their reviewed replacements; never put raw values, rules, secret values or raw account identifiers in Git, logs, public PRs or this runbook. |
| G0 | Explicit operator approval **after** independent private audit and green bootstrap CI, of this runbook, exact `BOOTSTRAP_SHA`, `BASE_SHA`, `BOOTSTRAP_REF`, `SEED_SHA`, `SEED_REF`, destination ref, expected merge parents/tree, signature/extended-header loss, maintenance window and settings. G0 explicitly authorizes **public seed-ref publication before its own CI**, solely to run that CI; exact-seed CI is mandatory before canonical creation. Any changed SHA, ref, scope or unexplained baseline requires fresh approval. G0 is not blanket Cloudflare approval. |
| G1b | Separate future decision; remains open. |

Record GitHub actor, organization, PR and source identity, and all operator
approvals privately. The public boundary is only the reviewed public Silex
ancestry. Never import private Roxabi history. Preserve MIT license and notices;
inspect every reachable object and public-release provenance, not just tip.
Unknown provenance, secret or data exposure blocks publication.

## 2. Authorized isolated preparation, before G0

Prepare a new private single-ref, no-tags clone of the exact public bootstrap
head, never `--mirror`, `--all`, a shared checkout or a private-history remote.
Before preparation validate `BOOTSTRAP_SHA` as a full 40-character lowercase
hexadecimal commit, numeric `APPROVED_PR`, and
`BOOTSTRAP_REF=refs/pull/$APPROVED_PR/head`. The operator supplies absolute
paths and private `RULES`; `SEED_SHA` is derived only after filtering.
Use a fresh anonymous Git environment and a private non-repository working
directory with a discovery ceiling to prevent inherited credentials, headers,
local/global/system config and URL rewrites. Before fetching, require the
advertised `BOOTSTRAP_REF` to resolve **exactly** to `BOOTSTRAP_SHA`, both
columns and only one line. Repeat this proof immediately before the merge.

```bash
umask 077
mkdir -m 700 "$WORK" "$WORK/home" "$WORK/cwd"
HOME_CLEAN=$(cd "$WORK/home" && pwd -P)
CWD_CLEAN=$(cd "$WORK/cwd" && pwd -P)
(
  cd "$CWD_CLEAN" || exit 1
  env -i PATH="$PATH" HOME="$HOME_CLEAN" GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 \
    GIT_CEILING_DIRECTORIES="$CWD_CLEAN" \
    git ls-remote "https://github.com/$OLD.git" "$BOOTSTRAP_REF"
) > "$WORK/bootstrap-ref"
[ "$(wc -l < "$WORK/bootstrap-ref")" -eq 1 ] || exit 1
[ "$(cut -f1 "$WORK/bootstrap-ref")" = "$BOOTSTRAP_SHA" ] || exit 1
[ "$(cut -f2 "$WORK/bootstrap-ref")" = "$BOOTSTRAP_REF" ] || exit 1
```

Before any later public mutation, validate the derived `SEED_SHA` as a full
40-character lowercase hexadecimal commit distinct from `BOOTSTRAP_SHA`, and
`SEED_REF` as a valid, explicitly G0-approved `refs/heads/` ref.
For preparation, fetch only the approved bootstrap ref into a **fresh isolated**
bare repository in the same clean environment, confirm the fetched ref equals
`BOOTSTRAP_SHA`, create a local `main` there, then clone only that ref with
`--no-local --no-tags --single-branch --branch main` into a fresh private clone:

```bash
env -i PATH="$PATH" HOME="$HOME_CLEAN" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git init --bare "$WORK/original.git"
env -i PATH="$PATH" HOME="$HOME_CLEAN" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git -C "$WORK/original.git" fetch --no-tags "https://github.com/$OLD.git" "$BOOTSTRAP_REF:refs/heads/main"
[ "$(git -C "$WORK/original.git" rev-parse 'refs/heads/main^{commit}')" = "$BOOTSTRAP_SHA" ] || exit 1
env -i PATH="$PATH" HOME="$HOME_CLEAN" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git clone --no-local --no-tags --single-branch --branch main "$WORK/original.git" "$WORK/filter-clone"
```

The fresh bare repo's own config is used; no shared Git config or remote is
modified. Inspect its ref list before cloning and stop on unexpected refs.
Before filtering, verify private `RULES` is mode 600 and has SHA-256 digest
`f23c7c10038857ed9cd9a562ee99e20b5b3ae91cd9fc3f70ff6892d85dee0f4f`
without exposing its contents. Verify the installed `git-filter-repo`
fingerprint is `a40bce548d2c`; run it on this fresh clone, never `--force`:

```bash
git -C "$WORK/filter-clone" filter-repo --replace-text "$RULES" --preserve-commit-hashes --preserve-commit-encoding --replace-refs delete-no-add --prune-empty never --prune-degenerate never
```

`--preserve-commit-hashes` preserves textual commit references in messages,
not rewritten commit IDs. Never use `--refs`, `--partial` or sensitive-data
options that widen ref scope or retain mixed histories.

Only blob replacement is authorized: the independent prototype found the
two values in one historical blob and no occurrences in non-blob content.
Do not use message replacement; compare all messages, metadata and trees for
the final source independently and stop on any change beyond the exact two
authorized blob substitutions and documented signature/extended-header loss.
The prototype is evidence for the procedure, not the final seed.

The isolated clone is disposable, not a shared worktree. Preserve the
filter-repo old/new commit map and original public-source proof privately.
Create a fresh clean export of the rewritten `main`:

```bash
env -i PATH="$PATH" HOME="$HOME_CLEAN" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git clone --no-local --no-tags --single-branch --branch main "$WORK/filter-clone" "$WORK/clean-export"
```

Derive `SEED_SHA` from the rewritten export's `main`, then validate its format
and inequality to `BOOTSTRAP_SHA`; do not reuse a prototype SHA.

Inspect the fresh export's refs, reflogs,
replace refs, notes, alternates, shallow dependencies and reachable/unreachable
objects to prove no old unsanitized objects or other refs leaked into the export.
Stop if this cannot be shown;
never rely solely on the filtered working clone's visible refs. No cleanup may
modify the old repository or other history.

Independently verify and privately review: all reachable commit/tree/blob/tag
objects for the two exact values and generic secret/identifier patterns;
synthetic fixtures only if their provenance is verified; no raw findings in
public logs. Compare old/new commit map, commit count, parent topology, author
and committer identities and dates, message bytes/encoding, licenses and tip
tree. Rewritten `SEED_SHA` must differ from `BOOTSTRAP_SHA` but the **tip tree
must equal** the original bootstrap tree. Fast-export/import drops commit
signatures and extended headers; original signatures do not certify new commit
IDs. Record these losses explicitly, not as fully identical history.
Verify no private Roxabi objects, extra refs, tags, releases, real artifact HTML or credentials
entered the export. Any content beyond the two authorized historical value
replacements, metadata/topology change or unexplained audit finding stops G0.
Obtain independent source/security/provenance review of the exact resulting
`SEED_SHA`. No ref has been published by this preparation.

This does not purge the existing public legacy repository, its tags, PRs or
other copies: cleanup qualifies the new canonical ancestry only.

## 3. Fresh baseline and G0

Before requesting G0, read the current PR, exact head/base, reviews and all
required CI checks; review the default-off release and MergeOnGreen job gates
and the existing CI `workflow_dispatch` trigger in the reviewed source. The
release job requires `vars.FORGE_RELEASES_ENABLED == 'true'`; the **entire**
MergeOnGreen writer job requires `vars.FORGE_AUTOMERGE_ENABLED == 'true'` before
minting an App token. Capture GitHub settings, all inherited and repository
rulesets, workflow definitions and runs, organization/repository variables,
secret **names/access only**, apps, deploy keys, integrations, collaborators,
schedules, dispatches and other writers. Schedule an admin maintenance window.
Do not record secret values. Stop if any writer cannot be accounted for.

Preserve existing `PR_Main`: PR, strict `check`/`test`, resolved threads, no
non-fast-forward/deletion and no bypass. A classic branch protection 404 does
not imply unprotected `main`. Previously observed old Actions were enabled,
default token read-only, but release had `contents: write`; MergeOnGreen could
mint an App token from inherited `CI_APP_CLIENT_ID` / `CI_APP_PRIVATE_KEY`, and
its merge call lacked an expected-head SHA. Its Actions dependencies were
commit-SHA pinned. Re-read; these observations are not a current inventory.

Privately baseline timestamp, actor, repo identity/default branch, main SHA,
all refs, tag object and peeled commit IDs, every release's complete metadata
and paginated assets, and asset hashes if assets exist. Record relevant manifest
paths and SHA-256 hashes, including explicit absence, for old main and reviewed
bootstrap. Compare structured results, with all pages; API errors or inaccessible
pages stop the operation. Previous 24 tags and 21 non-immutable releases with
no assets were only observations, not current assertions. Record rules, Actions,
variables and writers. Keep private evidence out of Git. Compare snapshots at
each phase boundary: only the approved bootstrap main and generated seed ref,
plus explicitly authorized settings, may change. No other tag/release drift.

Obtain G0 only after all preflight and private clean review evidence exists.
Immediately before each operation re-read source, policy, gates, runs, refs,
releases and settings; stop on drift or incomplete authority.

## 4. Bootstrap old and freeze main, tags and seed ref

After G0, set repository-level false overrides on old, irrespective of inherited
organization values. Resolve numeric `MERGE_WORKFLOW_ID` from the current
paginated workflow listing by verified name/path. Disable MergeOnGreen before
the merge and read it back. Drain **all** write-capable workflows and runs,
including runs from earlier revisions, in `queued`, `requested`, `waiting`,
`pending` and `in_progress`; check all pages. Disabling a workflow does not
cancel runs. Do not cancel without separate authority; wait or stop.

```bash
gh variable set FORGE_RELEASES_ENABLED --repo "$OLD" --body false
gh variable set FORGE_AUTOMERGE_ENABLED --repo "$OLD" --body false
gh api --method PUT "repos/$OLD/actions/workflows/$MERGE_WORKFLOW_ID/disable"
gh variable get FORGE_RELEASES_ENABLED --repo "$OLD"
gh variable get FORGE_AUTOMERGE_ENABLED --repo "$OLD"
gh api "repos/$OLD/actions/workflows/$MERGE_WORKFLOW_ID"
```

Require `false`, `false`, `disabled_manually`; verify effective settings and
account for inherited secrets and writers. Repeat §2 anonymous public proof on
`BOOTSTRAP_REF` and exact `BOOTSTRAP_SHA`, then merge only the original reviewed
head through existing rules, never force or use another merge method:

```bash
gh pr merge "$APPROVED_PR" --repo "$OLD" --match-head-commit "$BOOTSTRAP_SHA" --merge
```

Read PR and resulting `main` commit through the API: PR's merge commit must be
current main, with exactly two ordered parents `BASE_SHA`, `BOOTSTRAP_SHA`, and
its tree must equal the reviewed bootstrap tree. Record `FROZEN_MAIN_SHA`
(`MERGE_SHA`), distinct from `BOOTSTRAP_SHA`. Await and inspect the normal
post-merge main CI, drain all write-capable runs including prior YAML
`workflow_run` MergeOnGreen runs, and stop on CI failure, unaccounted writer,
nonterminal run, unexpected ref or baseline drift.

Add **separate** active no-bypass rulesets, leaving `PR_Main` unchanged: branch
update/deletion restrictions for both `refs/heads/main` and `SEED_REF`, and
tag creation/update/deletion restrictions for `~ALL`. Branch creation remains
allowed so the one absent generated seed ref can be created later. Admins can
change rules; coordinate the maintenance window. The following payloads use the
validated `SEED_REF`; check for existing ruleset names/partial prior execution
before posting and never blindly retry.

```bash
jq -n --arg seed "$SEED_REF" '{name:"F02_Freeze_Branches",target:"branch",enforcement:"active",bypass_actors:[],conditions:{ref_name:{include:["refs/heads/main",$seed],exclude:[]}},rules:[{type:"update",parameters:{update_allows_fetch_and_merge:false}},{type:"deletion"}]}' > "$WORK/freeze-branches.json"
cat > "$WORK/freeze-tags.json" <<'JSON'
{"name":"F02_Freeze_Tags","target":"tag","enforcement":"active","bypass_actors":[],"conditions":{"ref_name":{"include":["~ALL"],"exclude":[]}},"rules":[{"type":"creation"},{"type":"update","parameters":{"update_allows_fetch_and_merge":false}},{"type":"deletion"}]}
JSON
gh api --method POST "repos/$OLD/rulesets" --input "$WORK/freeze-branches.json" > "$WORK/branch-rule-result.json"
gh api --method POST "repos/$OLD/rulesets" --input "$WORK/freeze-tags.json" > "$WORK/tag-rule-result.json"
gh api "repos/$OLD/rulesets/$(jq -r .id "$WORK/branch-rule-result.json")"
gh api "repos/$OLD/rulesets/$(jq -r .id "$WORK/tag-rule-result.json")"
gh api --paginate "repos/$OLD/rules/branches/main?per_page=100"
```

Read back both definitions, effective rules for both branches, scope,
`bypass_actors=[]`, active enforcement and update restriction including
`update_allows_fetch_and_merge=false`. Query effective branch rules for the
not-yet-existing seed ref (URL-encode its short branch name); this API supports
nonexistent branches. Verify `PR_Main` applies only to main, not seed: a
pre-existing PR/check requirement on seed creates a CI circular dependency.
Inspect classic protection and inherited rules too. The seed ref must be absent.
GitHub tag rules do not prevent admin rules changes or release metadata edits/deletions. Immutable
releases apply only to qualifying future releases, not an absolute metadata
freeze. Recompare tags, all release metadata/assets and manifests to baseline;
stop on unexplained differences.

## 5. Publish the generated seed ref and prove exact-seed CI

Old Actions remain enabled **only** for controlled CI (and optional SecretScan).
Disable other workflows that can run or write, not merely their gates. Both
repository gates remain false, MergeOnGreen truly disabled, all prior write-capable
runs drained, and default-branch workflow source verified as the reviewed gated
bootstrap. Inventory and stop other writers; do not assume inherited secrets
are absent. Re-read freeze, variables, repo identity, exact `SEED_SHA`, private
review and absence of `SEED_REF`. From the isolated, independently reviewed clean
export, push exactly the approved commit to the single approved new ref; no tags,
other refs or force. The server must reject update/deletion after creation:

```bash
git -C "$WORK/clean-export" push "https://github.com/$OLD.git" "$SEED_SHA:$SEED_REF"
```

If another actor creates the ref first, even at the same SHA, stop: absence
before push is not a reservation. Never force, delete, unfreeze or adopt it.

Re-read the ref through a credential-free fresh non-repository environment as
in §2, substituting `SEED_REF` and `SEED_SHA`; require exactly one advertised
line and exact ref and SHA. Verify the seed ref is covered by the active
no-bypass update/deletion rule, old main still equals `FROZEN_MAIN_SHA`, tag and
release baselines unchanged, and the only additional ref is `SEED_REF`.

Dispatch the **existing** CI workflow on the exact seed ref, using its verified
workflow filename `CI_WORKFLOW` and the short branch name obtained by removing
`refs/heads/`. This is not a new PR or a force push:

```bash
SEED_BRANCH=${SEED_REF#refs/heads/}
gh workflow run "$CI_WORKFLOW" --repo "$OLD" --ref "$SEED_BRANCH"
```

Identify the new `workflow_dispatch` run by repository, exact workflow, event,
ref, actor, attempt and time; fetch all jobs/pages for that attempt and verify
`head_sha == SEED_SHA`. The workflow executes from the selected seed tree, not
magically from main: prove seed/bootstrap tip trees and CI workflow match.
All five jobs `check`, `test`, `test-os / macos-bash32`, `test-bash32` and
`test-py39` must be `completed/success`; skipped, neutral, missing, cancelled,
pending or ambiguous is not green. Verify release `skipped` and no App-token
writer ran. Re-read seed ref after CI, requiring unchanged `SEED_SHA`, rules
and settings. Optional SecretScan uses depth-zero history and only verified
secret detection, potentially across all old refs; green does not prove either
identifier removed or clean ancestry. The private all-reachable-history audit
is mandatory. Any failure stops before canonical repository creation.

After exact-seed CI succeeds, drain all remaining write-capable and pending runs
in every status listed in §4, then disable old Actions and verify. Disabling
Actions does not cancel pre-existing runs; recheck and stop on ambiguity.

```bash
gh api --method PUT "repos/$OLD/actions/permissions" -F enabled=false
gh api "repos/$OLD/actions/permissions"
```

Require `enabled=false`, both gates false, no unaccounted writer/run; rebaseline
and compare old main, seed ref, rules, manifests, tag object/peeled commits, all
release metadata and assets. Only approved bootstrap main/settings and one
new seed ref may differ from the pre-G0 snapshot. No automatic cancellation,
unfreeze, deletion, ref repair or release edits on failure.

## 6. Create and seed new public repository

Only after G0, the frozen old state, private review and actual exact-seed CI are
all proven, recheck name/ownership with an authorized organization account.
Create an **empty public ordinary non-fork**, no template, README, license,
source or push. Immediately disable Actions and set both **repository-level**
false overrides before the first push. Do not assume inherited organization
variables, app credentials or secrets are absent.

```bash
gh repo create "$NEW" --public
gh api --method PUT "repos/$NEW/actions/permissions" -F enabled=false
gh variable set FORGE_RELEASES_ENABLED --repo "$NEW" --body false
gh variable set FORGE_AUTOMERGE_ENABLED --repo "$NEW" --body false
gh api "repos/$NEW/actions/permissions"
gh variable get FORGE_RELEASES_ENABLED --repo "$NEW"
gh variable get FORGE_AUTOMERGE_ENABLED --repo "$NEW"
gh api "repos/$NEW" --jq '{full_name,private,fork,default_branch,owner:.owner.login}'
git ls-remote "https://github.com/$NEW.git"
```

Require `enabled=false`, both variables exactly `false`, intended owner/name,
`private=false`, `fork=false`, no refs or releases, no ambiguous read. If any
setting or proof fails, stop with the repo empty. Check all inherited policies,
secrets' names/access and writers; do not retire or change credentials.

Fetch only `SEED_REF` from public old into a **new** isolated bare repo in a
fresh clean environment (`env -i`, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`,
`GIT_TERMINAL_PROMPT=0`, fresh HOME/cwd and ceiling as in §2). Fetch with
`--no-tags` into `refs/approved/source`; require its commit exactly `SEED_SHA`,
not merely an ancestor:

```bash
mkdir -m 700 "$WORK/seed-home" "$WORK/seed-cwd"
SEED_HOME=$(cd "$WORK/seed-home" && pwd -P)
SEED_CWD=$(cd "$WORK/seed-cwd" && pwd -P)
env -i PATH="$PATH" HOME="$SEED_HOME" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git init --bare "$WORK/public-seed.git"
env -i PATH="$PATH" HOME="$SEED_HOME" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git -C "$WORK/public-seed.git" fetch --no-tags "https://github.com/$OLD.git" "$SEED_REF:refs/approved/source"
[ "$(git -C "$WORK/public-seed.git" rev-parse 'refs/approved/source^{commit}')" = "$SEED_SHA" ] || exit 1
```

Independently verify public anonymous reachability,
license, reviewed clean ancestry, tip tree and complete old baseline. Run
source-dependent inspections from a detached worktree at the reviewed SHA, not
from a dirty checkout. After rechecking the empty destination and gates, push
only the approved seed SHA to `main`:

```bash
git -C "$WORK/public-seed.git" push "https://github.com/$NEW.git" "$SEED_SHA:refs/heads/main"
```

Never `--mirror`, `--all`, `gh repo create --source --push`, or retarget an
existing remote. No other refs, tags or releases are copied. Stop if a push's
result is uncertain; inspect rather than retry or force.

Verify the new public non-fork owner, `main == SEED_SHA`, no extra refs/tags or
releases, unchanged old baseline, clean ancestry/license and both false gates.
Create a distinct canonical clone at `CANON_CLONE`; verify origin, clean checkout
and main SHA. Shared old remotes stay untouched.

## 7. Protect new main and validate its provenance PR

After seed verification, configure merge-commit-only repository settings and an
active no-bypass `PR_Main` ruleset: PR required, strict `check`/`test`, resolved
threads, no non-fast-forward or branch deletion. Resolve `CHECK_APP_ID` and
`TEST_APP_ID` from reviewed actual CI check-run app identities and validate as
positive decimal integers. Preserve any stricter reviewed old rules; if the
payload below would weaken them, stop and review a revised payload. Human
independent review is mandatory even if GitHub approval count is zero.

```bash
case "$CHECK_APP_ID" in *[!0-9]*|''|0) exit 1 ;; esac
case "$TEST_APP_ID" in *[!0-9]*|''|0) exit 1 ;; esac
jq -n --argjson check "$CHECK_APP_ID" --argjson test "$TEST_APP_ID" '{name:"PR_Main",target:"branch",enforcement:"active",bypass_actors:[],conditions:{ref_name:{include:["refs/heads/main"],exclude:[]}},rules:[{type:"pull_request",parameters:{allowed_merge_methods:["merge"],dismiss_stale_reviews_on_push:false,require_code_owner_review:false,require_last_push_approval:false,required_approving_review_count:0,required_review_thread_resolution:true}},{type:"required_status_checks",parameters:{strict_required_status_checks_policy:true,required_status_checks:[{context:"check",integration_id:$check},{context:"test",integration_id:$test}]}},{type:"non_fast_forward"},{type:"deletion"}]}' > "$WORK/new-pr-main.json"
gh api --method PATCH "repos/$NEW" -F allow_merge_commit=true -F allow_squash_merge=false -F allow_rebase_merge=false
gh api --method POST "repos/$NEW/rulesets" --input "$WORK/new-pr-main.json" > "$WORK/new-rule-result.json"
gh api "repos/$NEW/rulesets/$(jq -r .id "$WORK/new-rule-result.json")"
gh api --paginate "repos/$NEW/rules/branches/main?per_page=100"
gh api "repos/$NEW" --jq '{allow_merge_commit,allow_squash_merge,allow_rebase_merge}'
```

Verify saved and effective rules, integration identities, merge settings,
inherited rules and both false overrides. Enable Actions **for CI only**, after
reviewing the source and all settings; use the reviewed organization-permitted
`CI_ALLOWED_ACTIONS` (`all`, `local_only`, or `selected`). If `selected`, first
configure and verify the selected-actions policy. Never enable release or
automerge in F02.

```bash
case "$CI_ALLOWED_ACTIONS" in all|local_only|selected) ;; *) exit 1 ;; esac
gh api --method PUT "repos/$NEW/actions/permissions" -F enabled=true -f allowed_actions="$CI_ALLOWED_ACTIONS"
gh api "repos/$NEW/actions/permissions"
gh variable get FORGE_RELEASES_ENABLED --repo "$NEW"
gh variable get FORGE_AUTOMERGE_ENABLED --repo "$NEW"
```

Create a dedicated new-canonical worktree/branch and provenance documentation
PR. Record actual original bootstrap and clean seed SHAs/refs, old frozen main,
tree equality, rewrite/signature caveat and public license/provenance evidence,
not private rules, raw identifiers or sensitive inventories. Independent review
must bind exact PR head; require real new-repo CI, resolved threads and skipped
writer jobs, then separately authorize a SHA-matched merge commit under the new
rules. Record that later merge SHA separately; it legitimately advances new main.
Update the operator's repository inventory via its own separately reviewed
workflow after creation. Recompare old baseline and both repos' settings. F02 is
complete only after these operations and proofs, not when this document is
prepared. No import, production action or plugin redistribution is authorized.

## Stop and recovery

Stop on any missing/changed SHA, unapproved ref, public-boundary uncertainty,
failed clean-history proof, CI failure/skipped required job, unexpected run,
writer, ref, tag/release drift, inability to enforce rules, unreadable API page,
name/owner ambiguity or failed setting. Preserve private evidence and report the
exact partial state. Do not automatically delete the new repository or generated
seed ref, rename anything, unfreeze old, cancel runs, disable rules or force
push. A created empty/partial new repo stays Actions-disabled and gates false;
if already enabled, coordinate separately authorized containment. Old remains
frozen once frozen. Recovery, deletion or restoring writes needs a new explicit
operator-approved plan that accounts for legacy clients and release drift.

## References

- [GitHub repository rulesets](https://docs.github.com/en/rest/repos/rules), [Actions permissions](https://docs.github.com/en/rest/actions/permissions), [workflow runs and statuses](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository)
- [GitHub CLI repository creation](https://cli.github.com/manual/gh_repo_create), [workflow dispatch](https://cli.github.com/manual/gh_workflow_run), [SHA-matched PR merge](https://cli.github.com/manual/gh_pr_merge), [variables](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables)
- [Git configuration files](https://git-scm.com/docs/git-config#FILES), [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
