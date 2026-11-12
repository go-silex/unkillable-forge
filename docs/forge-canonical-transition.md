# F02: canonical seed and engine-first transition

The operator's latest decision is **new engine first, migration later**. Repository identity isolation, not a freeze or drain of legacy GitHub, permits development in the new repository. No legacy ref, setting, run, publisher, Cloudflare resource, data or Shlink mutation is authorized by this runbook. Existing partial legacy GitHub disables remain as they are; do not implicitly restore or extend them. Old queued runs are not a gate for the independent repository. The legacy URL and `main` remain the existing consumers' target; no assertion of a server-side freeze is made.

## 1. Actual seed provenance

- Canonical repository: [go-silex/unkillable-forge](https://github.com/go-silex/unkillable-forge), created public, ordinary and non-fork. Only `main` was pushed at bootstrap, with no force, mirror or tags.
- Source: [legacy draft PR #70](https://github.com/go-silex/silex-forge/pull/70), head `bf8d145be4f1a4eec3260f1ad134c545071b9b7c`. Its final source was independently reviewed and had [source CI](https://github.com/go-silex/silex-forge/actions/runs/43127809027) and [secret scan](https://github.com/go-silex/silex-forge/actions/runs/43127808988). It was not merged into legacy `main`; closing it is not a bootstrap prerequisite and would require separate approval.
- Seed `8d0b2e5330153edf2925160132b9bead908444a0`; source and seed tree `85c0ecae6c78455600f3e353437c88438abb9cfb`. A private isolated copy replaced exactly two historical full identifiers in one blob; originals were not rewritten. Fifty historical `gpgsig` headers were lost in the copy, explicitly approved; signatures do not authenticate rewritten commits.
- The isolated audit covered 238 commits and 2,561 objects, including history, topology, metadata, licenses and reachable-object hygiene; proof SHA-256 `1e3abd932ef0ef52cc4e673d0384169076df238fdf96c7c759be16eb8268aeb3`. Private rules, raw identifiers, credentials and customer content must not be published.
- Before the seed push, Actions were off and `FORGE_RELEASES_ENABLED` and `FORGE_AUTOMERGE_ENABLED` were both false. The default token was read-only and unable to approve PRs. No production deployment or data import followed.

## 2. Isolated new-repository guards and CI

New `main` has active no-bypass `PR_Main` rules: pull request, merge commits only, resolved threads, strict `check` and `test` bound to GitHub Actions app `15368`, no non-fast-forward or deletion. Native auto-merge and the new MergeOnGreen workflow are disabled. Actions are enabled with `allowed_actions=all`; CI, PR title and secret scan workflows are active, and Dependabot can create dynamic branches and PRs independently. Both writer variables remain false and release is gated by its false flag. Never infer that a disabled variable cancels an already running job or permits minting an administrative App token.

The once-dispatched [seed CI run 43294205230](https://github.com/go-silex/unkillable-forge/actions/runs/43294205230) ran on exact seed `8d0b2e5330153edf2925160132b9bead908444a0`, workflow `416486792`, `workflow_dispatch`, `main`, actor `MickaelV0`, attempt 1. All five jobs `check`, `test`, `test-os / macos-bash32`, `test-bash32` and `test-py39` actually completed successfully; release was skipped. After the run the repository remained public, non-fork, merge-only and without native auto-merge; both writer flags remained false, MergeOnGreen was `disabled_manually`, and the default token remained read-only and unable to approve. Private evidence `engine-first-bootstrap-and-seed-ci-proof`, SHA-256 `a91d32e12623effba7a097fe1759fbe32a7491df15c15723204f5aa6ab799684`. Keep releases and writer paths disabled until separately authorized; do not infer an App-token mint from run-level success.

## 3. F02 delivery — pending

1. Preserve the detailed exact-seed CI and writer-guard evidence. Stop on a failed or unknown new-repo guard, CI or provenance; do not manufacture success.
2. Deliver this provenance reconciliation from the dedicated canonical clone and worktree `~/.omp/wt/unkillable-forge/docs-F02-provenance`, branch `docs/F02-provenance`. Obtain an independent review of the final exact SHA and its inputs, actual CI on that SHA, and a merge commit pinned to the reviewed head. No provenance PR, final head, review or merge is asserted here until it exists.
3. Deliver the repository registry update in its separate dedicated worktree and PR, independently reviewed and validated under that repository's workflow. Do not invent its PR or evidence.
4. F02 is complete only after both deliveries and their required evidence. F03 and F06 may start after F02 delivery; neither has started merely because the seed exists. Legacy run completion, new legacy freezes, and closure of PR #70 are not F02 gates.

Use a distinct worktree and PR for each subsequent lot. No retargeting legacy shared remotes, publishing under the old plugin name, production cutover, migration, or private Roxabi history import is implied by canonical development.

## 4. Future migration — separate authority

The complete F01–F16 plan and its dependencies remain in force. R2 is the target authority for bytes, D1 for revisions, routes and rights. Both instances remain isolated; Claude Code, Codex and OMP must use the new MCP path without publisher Cloudflare tokens. Development does not itself change either production instance.

Preserve `https://forge.unkillablecompanies.com/`, team login, public/private/shared access, existing paths and exact share keys, nested assets and redirects. Capture actual Shlink aliases **and destinations**, including historical domains, privately; do not regenerate aliases from slugs or expose secret destinations. Silex uses slug/subtree ACLs; do not conflate them with Roxabi page/fragment ownership. Fresh access decisions and revocations must fail closed on the new engine.

Roxabi historical recovery is suspended. `UNRESOLVED_HISTORICAL_OWNERSHIP` (G1b) remains a hard gate on historical import, F10 fidelity and consequently F11/F12; resolving it requires a verified historical graph or probative page/route/resource reconciliation and operator validation. It is not a code-development prerequisite. Do not claim historical rights, assets or production parity already proved.

Before the separately approved migration/cutover, close legacy production writers server-side, drain in-flight operations and prove the final mutation, then capture fresh consistent inventory, grants, exact shortlinks and backups; verify ACLs, restoration and rollback. This future protection is not an authorization to freeze anything now. F12 privacy/upstream operations, F13 then F14 production cutovers, F15 resource/credential retirement and F16 synchronization retain their individual approvals and acceptance criteria. F13 must be fully accepted before F14; a coordinated cold window is a future plan, not a current operation.
