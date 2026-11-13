---
title: Axis of decomposition — business authority; adapters decide nothing
status: accepted
date: 2026-11-12
deciders: mickael
axial: true
supersedes: 0001-axis-of-decomposition
tags: [architecture, decomposition, engine, authorization]
---

# Axis of decomposition — business authority

Contract: [Forge core contract](../../forge-core-contract.md) · Vocabulary: [GLOSSARY](../../../GLOSSARY.md) · Supersedes: [ADR 0001](0001-axis-of-decomposition.md)

## Context

ADR 0001 made the pipeline stage the primary axis of one bash publisher that rebuilds and redeploys a whole Pages snapshot. Its revisit trigger names "a Worker-side publish API, which would make plane the primary axis".

The accepted convergence plan ([`docs/forge-convergence-plan.md`](../../forge-convergence-plan.md) §2.1–§2.5) replaces that publisher by one Worker engine per instance: R2 keeps immutable bytes, D1 decides what is active, visible and authorized, and HTTP, remote MCP, local stdio and the web UI are adapters of the same engine. The plan charges F03 with re-examining 0001 and recording the decision before the new axis is implemented, without losing centralized authorization.

The engine varies along five dimensions:

| Axis | Instances | 12-month growth |
|---|---|---|
| **A — business authority** | Catalogue & Policy · Publication · Revision Store · Delivery | 0 |
| **B — transport** (adapters) | HTTP read · HTTP manage · remote MCP · local stdio · web UI | +1–2 |
| **C — instance** | Unkillable · Roxabi | 0–1 |
| **D — URL grammar** | slug subtree · tree page · share by path, query, page or card · pinned revision · alias | 0–1 |
| **E — policy action** | create · stage · publish · restore · unpublish · visibility · share · rotate · revoke · reveal · import · alias · roles | +1–2 |

## Decision

**Primary axis: A — business authority.** Each module is the only place that decides its facts. Other modules and every adapter compose it through its interface. Reason category: *authority* — a fact with two deciders drifts (visibility re-decided in an MCP tool and again in a web handler); a fact with one decider cannot.

| Module | Sole authority over | Interface (summary) |
|---|---|---|
| **Catalogue & Policy** | verified identities and their assurance, principals, roles and scopes, page identity, routes and aliases, visibility, share grants, resource ownership, read decisions, the mutation guard | `authenticate` · `resolveRead` · policy commands · guard and statement builders |
| **Publication** | which sealed revision of an artefact is active (compare-and-set), publication sessions, idempotency, unpublish, restore | `begin` · `upload` · `status` · `commit` · `abort` · `remove` · `restore` |
| **Revision Store** | immutable bytes and their integrity | `putOnce` · `inspect` · `seal` · `read` · `collect` |
| **Delivery** | turning an authorized read plan into an HTTP response | `serve` |

Adapters (HTTP read Worker, HTTP manage Worker, remote MCP, local stdio client, web UI) parse transport input, call module interfaces and render results. **They decide nothing**: no authorization, visibility, grant, role, route or active-revision decision is computed in an adapter.

Mapping from the plan's §2.1 names: *Accès* and *Catalogue* → Catalogue & Policy; *Lecture* → decision in Catalogue & Policy, response in Delivery; *Publication* → Publication, bytes in Revision Store; *Interfaces externes* → adapters.

### Invariants carried over from ADR 0001

1. Authorization is decided in exactly one module (0001: `functions/_lib/access.ts`; now Catalogue & Policy).
2. Every write to policy or active state runs the one guard inside the same D1 transaction as its effects, except the explicitly bounded F11 operator bootstrap. Verified manage-identity self-registration is a separate, role-free exception for new principals only (contract §9.1); it cannot change or reactivate an existing principal. A per-action difference is a parameter of that guard, never a second guard (0001: `EXPECTED_REMOVALS` as a parameter of `preflight_cf_mutations`).
3. Active state changes at exactly one commit point, Publication's transaction (0001: the single `wrangler pages deploy` with re-asserted sentinels).
4. Three strikes: a concern found in three or more adapters or actions moves into its owning module.

### Rules that follow from the axis

- Decisions read the D1 primary and fail closed. No KV, cache, isolate memory or read replica is an authority for a role, grant, visibility or active revision.
- Instances differ by configuration and data, never by code branches on brand, instance or host name.
- A slug or a tree path is a route to a page, never the page's identity.
- Reading management policy requires an active manage principal with a current authority epoch and an administrator or in-scope publisher role, checked by Catalogue & Policy inside the same primary batch. An adapter cannot authorize that read.
- Read and management run on distinct origins. The read path never holds a key that can mint or reveal shares.

### Legacy tree until F15

Until F15 removes them, `plugins/silex-forge/scripts/` and `functions/` keep 0001's stage-composition rules as written: guard in preflight, one deploy, sentinels re-asserted, share bar resolved once, authorization in `functions/_lib/access.ts`. They are bound by this ADR through this section, not by a second axial ADR. Engine code never imports legacy modules and legacy code never imports engine modules.

### Code location

`domains/<module>/` for the four modules (`catalogue`, `publication`, `store`, `delivery`), `adapters/<transport>/` for adapters, `migrations/` for D1. These paths match the axial review gate in [`.dev/stack.yml`](../../../.dev/stack.yml). A directory is created by the lot that first ships code in it. F03 creates `domains/catalogue/` and `migrations/` only.

## Anti-pattern signal

A reviewer flags any of these:

- An adapter that reads `role_grants`, `share_grants`, `pages.visibility`, `routes` or `artifacts.active_revision_id`, or issues a D1 write, instead of calling the owning module.
- A D1 batch that writes a policy or active-state table without the guard (other than the bounded operator bootstrap), a self-registration batch that grants a role or modifies an existing principal, or a second guard written for one action.
- A refusal derived from a zero-row update, `changes()`, an `ON CONFLICT … WHERE` that silently skips, or a read followed by a separate write. Self-registration may use `ON CONFLICT (issuer, subject) DO NOTHING`, but its instance verdict comes from the same batch’s explicit instance read, never from affected-row counts.
- An authorization input taken from KV, a cache, isolate memory, `withSession()` or a stale JWT claim beyond its own expiry.
- `if` on an instance, brand or host literal; a grammar enabled by code instead of configuration.
- Page identity keyed by slug or path outside routing (for example R2 keys, grants or roles keyed by slug).
- The same visibility, grant or ownership rule implemented twice for two transports or two grammars (target-axis trap).

## Enforcement

- Behavioural tests on real D1 bindings own the policy (contract §14): each guard verdict, each read grammar, conflict with zero side effects, laundering denial, instance mismatch.
- The contract fixes the authority guard SQL and its named CHECK constraints. `executeGuarded` also rejects structurally invalid batches before any D1 call: a role or principal mutation must be the only guard in its batch, so two removals cannot each count the other administrator. Multi-page publication remains allowed. Principal self-registration and operator bootstrap are the only unguarded exceptions.
- `R-axial-adr-review` (dev-core) path-hits `domains/` and `adapters/` through `AXIAL_RE` and reviews diffs against this ADR.
- Legacy enforcement listed in 0001 (`tests/publish-*.sh`, `tests/*.test.ts`) stays in force for the legacy tree until F15.

## Expected debt

- Policy partly lives in SQL (guard verdicts, read joins). It is reviewed as SQL; tests are the safety net.
- The guard is a wide statement (17 parameters). Callers use one builder, never hand-written SQL.
- A page read crosses Catalogue & Policy, Delivery and Revision Store: more indirection than one handler.
- Keeping share-revealing keys off the read path means two Workers per instance (read, manage) and two deploy configurations.
- The legacy tree keeps 0001's rules until F15, so two architectures coexist during migration.
- Ownership across artefacts follows the owner's active revision; a resource mounted by another artefact is not pinned by a revision of the page that uses it.

## Considered options

| Option | Why rejected |
|---|---|
| Keep 0001 (pipeline stages) | A stage is a step of one batch publisher. Per-request decisions and transactional commits have no stage pipeline to own. 0001's own trigger fired. |
| Transport axis (the "plane" 0001 predicted) | One handler set per transport re-implements authorization per transport: the target-axis trap 0001 rejected. The plan forbids a second business engine in a plugin. |
| One engine per brand | The plan forbids it: one engine, two instances, configuration only. |
| Per-command modules | Axis A of 0001: guards and policy duplicated per command. |

## Approval and provenance

Owner approval: the accepted plan fixes the module responsibilities (§2.1), the D1/R2 authorities (§2.2), one engine with adapters (§2.4) and the security model (§2.5), and asks F03 to record the revision of 0001. The owner then asked for the new engine to be built as designed; this ADR records that design. It introduces no new owner choice. Technical choices made while writing the F03 contract are marked as contract decisions in that document, and the decisions still open for the owner are listed there (§17).

## Revisit trigger

- A module needs to write tables owned by another module.
- A third instance needs a trust model the configuration cannot express.
- Hostile per-artefact isolation (separate content origins per revision or artefact) becomes required.
- Three sibling fixes of one concern across adapters.
- Otherwise every six months.
