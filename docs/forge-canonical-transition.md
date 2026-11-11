# Canonical repository transition (F02)

**Status: planned, not executed.** The intended public canonical repository is
`go-silex/unkillable-forge`; `go-silex/silex-forge` remains the public legacy
URL, frozen but not archived until F15. The names are not a rename or redirect:
older 1.7.3/1.3.0 clients whose installations cannot be updated clone the old
`main`, so repository separation is the isolation gate. Legacy engine and
publisher stay frozen; canonical development may proceed in F03 after F02.
Plugin identity and distribution stay unchanged until F08. Do not make a
release under the old plugin name from the new repository.

This is an operator procedure, **not authority to run it**. G1b is open: no
imports, F10 or production work. No deployment, data migration/import, credential
or app retirement, scope withdrawal, old repository archive or rename is in F02.
Do not alter a shared checkout or its remotes. The F01 worktree and dirty main
checkouts are outside this procedure.

## Inputs and authority

| Input | Required evidence / decision |
|---|---|
| `OLD=go-silex/silex-forge`, `NEW=go-silex/unkillable-forge` | Freshly verify organization ownership, authenticated operator and visibility; 404 can mean lack of access, not availability. The earlier repo lookup could not resolve the new name and planned clone paths were absent; neither guarantees current/global availability. |
| `APPROVED_SOURCE_SHA` | Full commit SHA of the independently reviewed, CI-green F02 PR head, obtained **after** this runbook is committed and reviewed. Record PR URL, head repository, full source ref, base SHA, exact head SHA, review and required check evidence. No self-referential SHA is assumed here. |
| `SOURCE_REF` | Exactly `refs/pull/$APPROVED_PR/head` on the public old repository, approved by G0 and verified before and after merge to resolve to `APPROVED_SOURCE_SHA`. This retained PR ref avoids automatic head-branch deletion. If unavailable, stop; do not substitute a ref without fresh G0. Export its history and only destination `refs/heads/main`. |
| `APPROVED_PR`, `APPROVED_BASE_SHA` | Old bootstrap PR number and its reviewed base SHA. Head, source repository, base and exact SHA must still match the reviewed record immediately before merge. |
| `WORK` and `CANON_CLONE` | New, distinct, non-existing paths outside all existing worktrees. Private operator-controlled storage with sufficient space; `WORK` contains sensitive inventories, not a Git-tracked directory. |
| G0 | Operator explicitly approves this runbook, the exact source SHA and source/destination refs, and authority for the described old GitHub changes, empty new public repository, its settings and seed. Review/CI alone is not G0. Any changed SHA, refs, scope or unexpected baseline requires renewed approval. |
| G1b | Separate future decision; remains open. F02 is not authorization to import, deploy, or change distribution. |

The only allowed ancestry is the reviewed **public Silex** history reachable
from the approved public source. Inspect its commit history, tree, license and
public-release provenance, including reachable objects and inherited files,
for secrets, account identifiers and actual artifact HTML before approval. MIT
license and notices must remain intact. Never import private Roxabi history or
assume a public tip makes every ancestor safe. If the provenance or public
boundary cannot be proven, stop; do not sanitize or substitute another history
without a new review and G0.

## 1. Fresh preflight and private baseline

Before G0, read current repository and organization settings with an account
that can inspect them, PR details, effective rules (including inherited rules),
Actions policies and workflow definitions, variables and secret **names and
access**, app installations and grants, deploy keys, collaborators, external
integrations, scheduled/dispatch workflows and other writers. Do not print or
record secret values. Verify all expected writers can be quiesced and schedule
an admin maintenance window; admins can still change rules and release metadata.
Read the current `PR_Main` definition and effective `main` rules: preserve the
existing PR, strict `check`/`test`, thread-resolution, no non-fast-forward or
branch-deletion protections and no bypass. A classic branch-protection 404 is
not proof that `main` is unprotected. Check GitHub plan/API capability for the
new rulesets and their effective enforcement; stop if unavailable.

Old Actions were observed enabled, default token read-only, but the release job
has `contents: write`; MergeOnGreen can mint an App token from inherited
`CI_APP_CLIENT_ID` / `CI_APP_PRIVATE_KEY`; its merge call does not pin the
expected PR head SHA. Its Actions dependencies are commit-SHA pinned.
Treat these as time-sensitive observations, not a complete writer inventory.
Explicit repository variables override organization variables; verify their
actual values on **both** repositories rather than assuming no inherited values
or secrets. The release job must require `vars.FORGE_RELEASES_ENABLED == 'true'`;
the entire MergeOnGreen writer job must require
`vars.FORGE_AUTOMERGE_ENABLED == 'true'` **before token minting**. Verify those
conditions in the reviewed source and actual CI. Both gates remain false until
F08 or a separately reviewed, SHA-bound automation design authorizes a change.

Create a private baseline outside Git (`umask 077`; directory mode 700; files
mode 600). Record timestamp, operator, repository identity, default branch,
current main SHA, all refs, each tag object SHA and peeled commit, all releases
including draft/prerelease state, body, timestamps and asset metadata, workflow
and run inventories, settings, rulesets and writers. Capture all pages and each
release's assets; download and hash assets if any exist. Compare structured
fields rather than ordering. Record hashes of relevant manifest files from
`main` and the approved source with paths and SHA-256; if a manifest is absent,
record that explicitly. Prior observation was 24 tags and 21 non-immutable
releases with no assets; re-count, do not use those numbers as an assertion.
Never commit these inventories, secrets, raw account IDs or artifact HTML.

Useful read-only collection examples, after assigning and validating `OLD` and
`WORK` as above (API errors or incomplete pagination are fatal):

```bash
umask 077
mkdir -m 700 "$WORK"
gh api "repos/$OLD" > "$WORK/old-repo.json"
gh api --paginate --slurp "repos/$OLD/rulesets?includes_parents=true&per_page=100" > "$WORK/old-rulesets.json"
gh api --paginate --slurp "repos/$OLD/releases?per_page=100" > "$WORK/old-releases.json"
gh api --paginate --slurp "repos/$OLD/actions/runs?per_page=100" > "$WORK/old-runs.json"
git ls-remote "https://github.com/$OLD.git" > "$WORK/old-refs.txt"
```

Release listings include asset metadata; additionally fetch every release's
assets endpoint with pagination and compare it to the list, including empty
lists. Inventory all runs, not just a single recent page. Retain the baseline
securely for the maintenance window; re-read and compare at each boundary below.
For expected changes (bootstrap main and documented settings), record exact
before/after evidence and compare all **other** fields; any unexplained drift is
a stop, not something to normalize away.

## 2. G0, quiesce and bootstrap merge on old

1. Obtain G0 with the table inputs and maintenance window. Re-read the source
   ref, PR head/base/reviews/required checks, old settings, rules, writers,
   tags and releases. Stop if any differ from reviewed/approved evidence.
2. Set repository-level `FORGE_RELEASES_ENABLED=false` and
   `FORGE_AUTOMERGE_ENABLED=false` on old; read them back and verify effective
   values. Disable the old MergeOnGreen workflow **before** the merge; inspect
   all outstanding runs, including runs created under prior workflow revisions.
   Drain every write-capable run in `queued`, `requested`, `waiting`, `pending`
   or `in_progress`, including release and App-token writers. Disabling a
   workflow or Actions does **not** cancel already-started runs. Do not cancel
   without separate authorization; wait for completion or stop. Continue to
   monitor for new runs and unaccounted writers. A disabled workflow is not a
   substitute for draining it.
3. Ensure the reviewed source's gates and CI checks are green, then merge only
   `APPROVED_PR` at exactly `APPROVED_SOURCE_SHA` through existing `PR_Main`,
   without bypassing checks, threads or hooks. The only approved method is
   `gh pr merge "$APPROVED_PR" --repo "$OLD" --match-head-commit "$APPROVED_SOURCE_SHA" --merge`.
   If unavailable, stop; no alternative merge method is authorized. Read the
   resulting merge commit and PR through the API: verify exactly two parents,
   in order `APPROVED_BASE_SHA` and `APPROVED_SOURCE_SHA`, its tree equals the
   approved head tree, and the PR identifies that merge commit. Record this
   resulting frozen-main SHA. Stop if old main does not equal it.
4. Drain again after merge, including CI-triggered and previously queued runs;
   verify no write-capable run in any listed nonterminal state remains. Stop on
   ambiguous status, inaccessible pages, unexpected writer or drift.

For step 1, with `WORK` already created, verify the retained ref anonymously
before merging (no system/global configuration, credentials, or URL rewrite):

```bash
mkdir -m 700 "$WORK/premerge-home"
env -i PATH="$PATH" HOME="$WORK/premerge-home" GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  git ls-remote "https://github.com/$OLD.git" "$SOURCE_REF" > "$WORK/premerge-ref"
[ "$(wc -l < "$WORK/premerge-ref")" -eq 1 ] || exit 1
[ "$(cut -f1 "$WORK/premerge-ref")" = "$APPROVED_SOURCE_SHA" ] || exit 1
```

For step 2, resolve `MERGE_WORKFLOW_ID` from the paginated old workflow
listing and confirm its name/path matches MergeOnGreen; it must be a numeric ID.
These are mutations, authorized only by G0:

```bash
case "$MERGE_WORKFLOW_ID" in *[!0-9]*|'') exit 1 ;; esac
gh variable set FORGE_RELEASES_ENABLED --repo "$OLD" --body false
gh variable set FORGE_AUTOMERGE_ENABLED --repo "$OLD" --body false
gh api --method PUT "repos/$OLD/actions/workflows/$MERGE_WORKFLOW_ID/disable"
gh variable get FORGE_RELEASES_ENABLED --repo "$OLD"
gh variable get FORGE_AUTOMERGE_ENABLED --repo "$OLD"
gh api "repos/$OLD/actions/workflows/$MERGE_WORKFLOW_ID"
```

Require both outputs `false` and workflow state `disabled_manually`, then drain.
For step 3, retrieve the merge commit and PR and inspect both parents and tree,
not just the returned merge status:

```bash
gh api "repos/$OLD/pulls/$APPROVED_PR" > "$WORK/merged-pr.json"
FROZEN_MAIN_SHA=$(gh api "repos/$OLD/commits/main" --jq .sha)
gh api "repos/$OLD/commits/$FROZEN_MAIN_SHA" > "$WORK/frozen-commit.json"
gh api "repos/$OLD/commits/$APPROVED_SOURCE_SHA" > "$WORK/source-commit.json"
jq -e --arg base "$APPROVED_BASE_SHA" --arg head "$APPROVED_SOURCE_SHA" \
  '.parents | length == 2 and .[0].sha == $base and .[1].sha == $head' "$WORK/frozen-commit.json"
[ "$(jq -r .commit.tree.sha "$WORK/frozen-commit.json")" = "$(jq -r .commit.tree.sha "$WORK/source-commit.json")" ] || exit 1
[ "$(jq -r .merge_commit_sha "$WORK/merged-pr.json")" = "$FROZEN_MAIN_SHA" ] || exit 1
```

## 3. Freeze old without replacing PR_Main

After bootstrap and the second drain, an authorized admin adds **separate,
active, no-bypass** repository rulesets: (a) target `refs/heads/main`, restrict
updates and deletion; (b) target **all tags**, restrict creation, update and
deletion. No bypass actors, including admins; ensure inherited rules also apply.
Use GitHub's ruleset UI/API and inspect the saved conditions, enforcement,
`bypass_actors`, and effective branch rules. Do not replace or weaken `PR_Main`.
The `update` rule must not allow fetch-and-merge. Confirm tag scope covers all
names, not only existing tags. Disable old repository Actions only **after**
the drain, re-read permissions, then recheck runs and writer inventory. If any
unaccounted run or writer can still write, stop. Do not assume disabling Actions
cancels runs or prevents other integrations from writing.

After drain, create these exact additive payloads (do not modify `PR_Main`);
save returned ruleset IDs privately and read each one back. `~ALL` targets all
tag names. Stop on any API error or non-active/non-matching response.

```bash
cat > "$WORK/freeze-main.json" <<'JSON'
{"name":"F02_Freeze_Main","target":"branch","enforcement":"active",
 "bypass_actors":[],"conditions":{"ref_name":{"include":["refs/heads/main"],"exclude":[]}},
 "rules":[{"type":"update","parameters":{"update_allows_fetch_and_merge":false}},{"type":"deletion"}]}
JSON
cat > "$WORK/freeze-tags.json" <<'JSON'
{"name":"F02_Freeze_Tags","target":"tag","enforcement":"active",
 "bypass_actors":[],"conditions":{"ref_name":{"include":["~ALL"],"exclude":[]}},
 "rules":[{"type":"creation"},{"type":"update","parameters":{"update_allows_fetch_and_merge":false}},{"type":"deletion"}]}
JSON
gh api --method POST "repos/$OLD/rulesets" --input "$WORK/freeze-main.json" > "$WORK/freeze-main-result.json"
gh api --method POST "repos/$OLD/rulesets" --input "$WORK/freeze-tags.json" > "$WORK/freeze-tags-result.json"
gh api "repos/$OLD/rulesets/$(jq -r .id "$WORK/freeze-main-result.json")"
gh api "repos/$OLD/rulesets/$(jq -r .id "$WORK/freeze-tags-result.json")"
gh api --paginate "repos/$OLD/rules/branches/main?per_page=100"
gh api --method PUT "repos/$OLD/actions/permissions" -F enabled=false
gh api "repos/$OLD/actions/permissions"
```

Verify `enabled=false`; repeat the complete run inventory after disabling Actions.

Take and compare the post-freeze baseline to the pre-merge baseline: old main
is the recorded expected bootstrap result, manifest hashes match the intended
reviewed tree, every existing tag's object and peeled commit are unchanged and
no tag has appeared/disappeared; all release fields and asset inventories/hashes
are unchanged. Store both snapshots and differences privately. No tag ruleset
prevents an administrator changing rules or editing/deleting release metadata;
GitHub immutable releases only protect qualifying future releases and do not
provide an absolute metadata freeze. Maintain the admin window and detect drift
at each boundary. Stop if unable to establish or maintain this baseline.

## 4. Create empty canonical repository, then isolate seed

Only after G0 and old freeze verification: check name availability again with
the authorized organization account. A 404 alone is inconclusive; stop on an
ownership or permissions ambiguity. Create an **empty public non-fork** under the
approved organization (no README, license template, source, clone, or push):

```bash
gh repo create "$NEW" --public
```

Immediately disable Actions in the new repository settings, before any push.
Set **repository-level** `FORGE_RELEASES_ENABLED=false` and
`FORGE_AUTOMERGE_ENABLED=false`; read both back and confirm Actions disabled.
Inspect effective organization variables, secrets, app installations, settings
and writers rather than assuming they are absent. If Actions cannot be disabled
or the overrides cannot be proven before push, stop with the repo empty. Do not
retire or change any inherited credential.

```bash
gh api --method PUT "repos/$NEW/actions/permissions" -F enabled=false
gh variable set FORGE_RELEASES_ENABLED --repo "$NEW" --body false
gh variable set FORGE_AUTOMERGE_ENABLED --repo "$NEW" --body false
gh api "repos/$NEW/actions/permissions"
gh variable get FORGE_RELEASES_ENABLED --repo "$NEW"
gh variable get FORGE_AUTOMERGE_ENABLED --repo "$NEW"
gh api "repos/$NEW" --jq '{full_name,private,fork,default_branch,owner:.owner.login}'
git ls-remote "https://github.com/$NEW.git"
```

Require `enabled=false`, both variables exactly `false`, correct owner/name,
`private=false`, `fork=false` and no refs. Verify independently that the
repository is empty and no releases exist; stop if any query is ambiguous.

Construct a fresh isolated bare repository from the approved retained PR ref.
Require the fetched ref to equal the approved commit exactly, both before and
after the old merge. Use the public old repository, not a local clone or a
private remote. Do not use `--mirror` or retarget an existing remote:

```bash
case "$APPROVED_SOURCE_SHA" in
  *[!0-9a-f]*|'') echo 'invalid SHA' >&2; exit 1 ;;
esac
[ "${#APPROVED_SOURCE_SHA}" -eq 40 ] || exit 1
[ "$SOURCE_REF" = "refs/pull/$APPROVED_PR/head" ] || exit 1
git check-ref-format "$SOURCE_REF" || exit 1
mkdir -m 700 "$WORK/anonymous-home"
env -i PATH="$PATH" HOME="$WORK/anonymous-home" GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  git init --bare "$WORK/seed.git"
env -i PATH="$PATH" HOME="$WORK/anonymous-home" GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  git -C "$WORK/seed.git" fetch --no-tags "https://github.com/$OLD.git" "$SOURCE_REF:refs/approved/source"
[ "$(git -C "$WORK/seed.git" rev-parse 'refs/approved/source^{commit}')" = "$APPROVED_SOURCE_SHA" ] || exit 1
```

For source-dependent inspection or execution, create a detached worktree at
`APPROVED_SOURCE_SHA` from this isolated repository, outside existing checkouts.
Never execute from a dirty main checkout.

The anonymous environment suppresses inherited credentials, system/global Git
config and URL rewriting; the empty bare repository has no configured remote.
Repeat the anonymous ref check before merge; if unavailable or changed, stop.
Inspect ancestry and license, and compare its tree to frozen old
`main`. Revalidate old refs, releases, freeze and the new empty repository and
gates immediately before the first push. Only then push the exact approved
commit to the one approved destination ref:

```bash
git -C "$WORK/seed.git" push "https://github.com/$NEW.git" "$APPROVED_SOURCE_SHA:refs/heads/main"
```

No other branches, refs, tags or releases are copied. Do not use
`gh repo create --source --push`: a bare source can mirror all refs. If the
push or post-push proof is uncertain, stop and inspect before attempting any
recovery; never force push.

## 5. Verify, clone and provenance PR

Re-read new repository identity: owner/name, public, `fork=false`, default
branch `main`, main exactly the approved SHA, and all advertised refs only the
approved `main` (apart from symbolic `HEAD`); no tags, other branches or
releases. Verify commit ancestry and tree, license, gates false, Actions disabled,
app/secret/variable exposure, rules and old baseline again. If GitHub creates
any unexpected ref or content, stop rather than deleting it. Create a distinct
canonical clone in `CANON_CLONE`; confirm `origin` is the new URL and its clean
`main` resolves to the approved SHA. Do not modify old clone remotes.

For the verification above, use the following and inspect **all** returned
refs and release pages (a network/authentication failure is not emptiness):

```bash
gh api "repos/$NEW" --jq '{full_name,private,fork,default_branch,owner:.owner.login}'
git ls-remote "https://github.com/$NEW.git"
gh api --paginate --slurp "repos/$NEW/releases?per_page=100"
gh api "repos/$NEW/actions/permissions"
gh variable get FORGE_RELEASES_ENABLED --repo "$NEW"
gh variable get FORGE_AUTOMERGE_ENABLED --repo "$NEW"
```

Only after these proofs, configure the new repository's merge-only policy and
active no-bypass `main` protection: PR required, strict required `check` and
`test`, resolved review threads, no non-fast-forward or deletion, with the
appropriate integration identities and merge method. Verify saved **effective**
settings, including inherited rules, and disable other merge methods. Confirm
both repository gate overrides remain false. Enable Actions for CI only after
reviewing the gated workflow source and settings, and ensure release and
MergeOnGreen jobs stay skipped; an inherited credential is not a safety gate.
If required checks cannot run or rules cannot be enforced, stop; do not weaken
protection. Never enable release or automerge here.

Use the following bootstrap only after the preceding verification. Resolve
`CHECK_APP_ID` and `TEST_APP_ID` from the actual CI check-run `app.id` values
and reviewed required-check policy; validate both as positive decimal integers.
Confirm the reviewed old `PR_Main` approval and review settings are no stricter
than this payload; otherwise carry those stricter settings into a newly reviewed
payload, not a silent weakening. Independent human review remains mandatory even
when GitHub's required approval count is zero.

```bash
case "$CHECK_APP_ID" in *[!0-9]*|''|0) exit 1 ;; esac
case "$TEST_APP_ID" in *[!0-9]*|''|0) exit 1 ;; esac
jq -n --argjson check "$CHECK_APP_ID" --argjson test "$TEST_APP_ID" '{
  name:"PR_Main", target:"branch", enforcement:"active", bypass_actors:[],
  conditions:{ref_name:{include:["refs/heads/main"],exclude:[]}},
  rules:[
    {type:"pull_request",parameters:{allowed_merge_methods:["merge"],
      dismiss_stale_reviews_on_push:false,require_code_owner_review:false,
      require_last_push_approval:false,required_approving_review_count:0,
      required_review_thread_resolution:true}},
    {type:"required_status_checks",parameters:{strict_required_status_checks_policy:true,
      required_status_checks:[{context:"check",integration_id:$check},{context:"test",integration_id:$test}]}},
    {type:"non_fast_forward"},{type:"deletion"}
  ]}' > "$WORK/new-pr-main.json"
gh api --method PATCH "repos/$NEW" -F allow_merge_commit=true \
  -F allow_squash_merge=false -F allow_rebase_merge=false
gh api --method POST "repos/$NEW/rulesets" --input "$WORK/new-pr-main.json" > "$WORK/new-pr-main-result.json"
gh api "repos/$NEW/rulesets/$(jq -r .id "$WORK/new-pr-main-result.json")"
gh api --paginate "repos/$NEW/rules/branches/main?per_page=100"
gh api "repos/$NEW" --jq '{allow_merge_commit,allow_squash_merge,allow_rebase_merge}'
```

Verify the saved ruleset, effective rules, integration identities, and merge
settings match the reviewed policy. If check App identities cannot be resolved
before new CI, establish them from reviewed old CI evidence, then verify them
against new CI; stop on mismatch. Select the reviewed organization-permitted
`CI_ALLOWED_ACTIONS` (`all`, `local_only`, or `selected`); if `selected`,
preconfigure and verify the selected Actions policy before enabling. Enable
only CI after the preceding checks and confirm:

```bash
case "$CI_ALLOWED_ACTIONS" in all|local_only|selected) ;; *) exit 1 ;; esac
gh api --method PUT "repos/$NEW/actions/permissions" -F enabled=true -f allowed_actions="$CI_ALLOWED_ACTIONS"
gh api "repos/$NEW/actions/permissions"
gh variable get FORGE_RELEASES_ENABLED --repo "$NEW"
gh variable get FORGE_AUTOMERGE_ENABLED --repo "$NEW"
```

Both gate values must still be `false`; inspect actual job results before merge.

From the new clone, create a dedicated branch/worktree for an F02 provenance
documentation PR recording the actual source SHA, source ref, old frozen main,
tree equality and public-history/license proof without sensitive baseline data.
Review independently against its exact head, require real new-repo CI checks
and resolved threads, and merge only that reviewed head under the new rules and
explicit operator authorization. Check Actions job results and confirm both
writer gates stayed false. This later PR legitimately advances new `main`;
record its merge SHA separately from the seed SHA. Recompare the old baseline
and both settings at completion. No release, import, deployment or plugin
redistribution is authorized by this PR.

## Stop and recovery

Stop at any failed proof, unexpected ref/run/writer, unknown permission, changed
head/base/settings, baseline drift, unverified public ancestry, unavailable name,
or incomplete rules/CI. Preserve evidence and tell the operator the exact partial
state. Do not automatically delete the new repository, unfreeze old, rename a
repository, cancel runs, disable protections or push a replacement. An empty or
partially seeded new repo stays disabled with false gates; if already enabled,
stop writers and coordinate separately authorized containment. Old remains
frozen once frozen. Recovery or rollback requires a fresh, explicitly approved
plan based on current evidence; restoring old writes or deleting anything needs
separate authorization and must account for legacy clients and release drift.

## References

- [GitHub repository rulesets and effective rules](https://docs.github.com/en/rest/repos/rules)
- [GitHub Actions permissions](https://docs.github.com/en/rest/actions/permissions) and [workflow run status/pagination](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository)
- [GitHub CLI repository creation](https://cli.github.com/manual/gh_repo_create), [SHA-matched PR merge](https://cli.github.com/manual/gh_pr_merge), [configuration variables](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
