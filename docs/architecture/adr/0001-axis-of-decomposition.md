---
title: Axis of decomposition — pipeline stages, not publish commands
status: accepted
date: 2026-09-07
deciders: mickael
axial: true
tags: [architecture, decomposition, publish-pipeline]
---

# Axis of decomposition

## Context

silex-forge varies along four dimensions at once, and only one of them can own
the code structure:

| Axis | Instances today | 12-month growth |
|---|---|---|
| **A — publisher operations** (`cmd_*` in `publish.sh`) | `publish` · `share_only` · `unshare` · `remove` · `list` · `rebuild_index` · `reanchor_snapshot` (7) | +1–2 |
| **B — pipeline stages / cross-cutting concerns** | doctor gate · `acquire_publish_lock` · `preflight_cf_mutations` · `preflight_before_live` (+ `snapshot_guard`) · `build_from_hub` · `inject_og_for_slug` · `inject_share_bars` · `deploy_pages` (+ guard re-assert) · `snapshot_record` · `kv_*` mutations · shortlink (≈11) | +1–2 |
| **C — plane** | publisher CLI (bash + Python) · edge (Pages Functions + KV) · hub SSOT (silex-hub, outside git) | 0 (fixed) |
| **D — visibility states** | private · shared · public | 0–1 |

A×B is a 7×11 matrix. Every cell is a place where a guard, a KV write or an
idempotent injection can be re-implemented and drift.

## Decision

**The primary axis is B — the pipeline stage.** A command is a *composition of
stages*, never a self-contained implementation of them. Reason category:
**composition** — the stage primitives compose to express every operation,
while no set of operations composes into a stage.

Consequences, already load-bearing in the code:

- The hub drift guard lives in `preflight_before_live`, **not** in
  `deploy_pages`, because `cmd_remove` clears KV and `rm -rf`s the hub artifact
  *before* the deploy — a guard placed per-command would abort after the
  destruction it exists to prevent.
- A per-command exception is a **parameter of the shared stage**
  (`EXPECTED_REMOVALS`), never a second guard.
- `share_bar_script()` is the single resolution point: two callers resolving it
  differently flip the content hash of the whole catalogue and defeat Pages
  Direct Upload dedupe.
- `wrangler pages deploy` is invoked in exactly **one** place, and the guard
  sentinels (`SNAPSHOT_GUARD_PASSED`, `SNAPSHOT_GUARD_LIVE_ID`,
  `SNAPSHOT_GUARD_LIVE_UNKNOWN`) are re-asserted there, so no command can reach
  the upload unguarded.
- Authorization (can this request *see* this slug?) belongs to
  `functions/_lib/access.ts`. Mutation of visibility state
  (`POST /api/visibility`) is a command, not an ACL decision — it lives in
  the route on purpose.

This is not a preference: the 2026-09-06 artifact loss was a path that reached a
full-snapshot deploy without the guard. Duplication along axis A is how that
happens.

## Enforcement — the tests, not the greps, not an automatic agent

The `axial: true` marker makes this ADR discoverable, but the dev-core reviewer
it feeds (`R-axial-adr-review`) is gated on a **structural** path match:
`AXIAL_RE = /^(infrastructure|adapters|domains|stages)\//`. This repo has none
of those directories — its planes are `plugins/`, `functions/`, `site/`,
`scripts/` — so that agent stays `no-path-hit` regardless of this file. Do not
expect it to catch drift here.

What actually enforces the decision is the existing contract suite:

| Invariant | Test |
|---|---|
| Guard re-asserted at the upload; unset sentinel is an internal error | `tests/shell/` deploy_pages cases in `run-os-script-tests.sh` |
| Unexpected hub removal refuses (the 2026-09-06 shape) | `tests/python/test_snapshot.py` |
| Share-bar inject is idempotent; strip is the exact inverse | `tests/python/test_inject_share_bar.py` |
| Authorization lives in `_lib/access.ts` | `tests/access.test.ts` |

Grep smells, useful in review, **not** CI-grade. Each one has a hole:

```bash
S=plugins/silex-forge/scripts/publish.sh

# 1. one real deploy invocation — also matches comments / info strings
grep -n 'pages deploy' "$S"

# 2. REST KV writes stay in kv_* helpers — misses the wrangler fallback
#    (kv_wrangler), which AGENTS.md itself documents as the second path
grep -nE 'kv_curl|curl .*storage/kv' "$S"

# 3. sentinel mentioned — a count, not a location. Deleting the re-assert
#    in deploy_pages and adding a mention elsewhere still greps green.
#    The tests above are what actually pin the re-assert.
grep -n 'SNAPSHOT_GUARD_PASSED' "$S"

# 4. share-bar.js in shell — the injectors are Python
#    (inject-share-bar.py). Grep *.sh never sees them.
grep -rn 'share-bar\.js' plugins/silex-forge/scripts/
```

Drift class: `target-axis-trap` (a concern re-implemented per sibling command).
Three-strikes rule: a concern appearing in 3+ `cmd_*` bodies is promoted to a
stage.

## Expected debt

Accepted, and it does bite:

- `publish.sh` is one large file (~1 700 lines) that reads worse than seven
  small self-contained commands would. Stage-first composition is the reason.
- Stage state is threaded through **exported shell sentinels**, not arguments —
  bash offers no module boundary, so the discipline is enforced by tests
  (`tests/shell/*`) and review, not by the language. A dropped `export` is a
  silent hole; that is exactly why `deploy_pages` treats an unset sentinel as an
  internal error rather than a default-allow.
- A command needing only 2 of 11 stages still pays the pipeline's vocabulary.

## Revisit trigger

Any of: `publish.sh` past ~2 000 lines · a second publisher entrypoint appears
(e.g. a Worker-side publish API, which would make **plane** the primary axis) ·
more than 3 sibling fixes per week landing the same concern in several `cmd_*` ·
6-monthly review.
