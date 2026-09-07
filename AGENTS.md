# silex-forge — agent context

## Mission

**forge.gosilex.com** = team HTML artifact host (decks, talks, guides).

| Host | Job |
|---|---|
| `forge.gosilex.com` | Internal artifacts + keyed share links |
| `demo.gosilex.com` | Client demos (funnel) — other repo |
| `share.gosilex.com` | Product ACL target (silex-share) — not this runtime |
| Vercel | **Forbidden** for this flow |

## Access (why private nav used to see everything)

**Before 2026-07-17**: Access was **not** wired → the site was public.

**Now**:

| Zone | Behavior |
|---|---|
| `/` + `/api/catalogue` | Public shell; list = Worker (public vs all if JWT) |
| `/a/<slug>/*` | Worker visibility (private/shared/public) · HTML **and** og.jpg |
| `/s/*` | Bypass + KV key |
| `/login` | Access Allow team (JWT cookie) |

Bypass host `/` and `/a` **only AFTER** Functions deploy. Before that: Access Allow on the host. Reverse order = leak. `forge-provision.sh` enforces it — its Bypass stage is unreachable until two live probes pass: `GET /` carries `x-forge-acl: vis-v4` (a forge engine is answering, not a static deploy) **and** `GET /a/<slug>/` answers `302` to `/login` (it really fails closed — a `200` there is the leak). There is no override.

Both probes are load-bearing and neither may be loosened: the header value must equal `vis-v4` exactly, and the artifact probe must **not** follow the redirect (`/login` is a public shell and would itself carry the header, so a `-L` turns the fail-closed proof into a tautology). A header-less `302` on `/a/<slug>/` is the normal answer of a correctly enforcing forge — the liveness signal comes from `/`, never from an artifact URL.

## Visibility (model v4)

Content URL: `/a/<slug>/`. Catalogue `GET /` = shell; **list = `GET /api/catalogue`** (Worker).

| KV `vis:<slug>` | Anon catalogue | Access catalogue | Open |
|---|---|---|---|
| **private** (default) | no | yes | JWT / `/login` |
| **shared** | no | yes | `/s/<slug>/<key>/` anon; `/a/` if JWT |
| **public** | yes | yes | `/a/<slug>/` without login (HTML **and** `og.jpg`) |

Fail-closed: no `vis:` = private. `manifest.json` is **not** served to clients.

Trust boundary: publishers are trusted team members. Artifact HTML can execute JavaScript on the Forge origin; prefer self-contained output and never include untrusted third-party scripts.

### Access Zero Trust (after Functions deploy)

1. Functions fail-closed in prod
2. **Then** Bypass `/`, `/a/*`, `/s/*`, `/api/*`; **Allow team** on `/login` (JWT cookie read by Functions)
3. `pages.dev`: 403 on every path (middleware)

### Toolbar UX (team, on `/a/<slug>/`)

**Private** | **Shared** | **Public** → `POST /api/visibility`. Shared mints KV `share:<slug>`.

Optional shortlink via Pages env `SHLINK_API_KEY` + `SHLINK_API_URL` (no defaults; silent fail OK).

## Commands

```bash
S=plugins/silex-forge/scripts/publish.sh

"$S" my-deck --title "…" --type deck # source = hub SSOT
"$S" my-deck ./deck.html --title "…" --type deck
"$S" my-deck ./deck.html --share --title "…" # + share link
"$S" --share my-deck # mint share only
"$S" --unshare my-deck
"$S" --list
"$S" --remove my-deck
"$S" --rebuild-index
"$S" --rebuild-index --force-og

"$S" my-deck ./deck.html --dry-run # build + validate, no deploy, no KV
"$S" --rebuild-index --dry-run
```

Deploy: `publish.sh` → `wrangler pages deploy` (token in `~/.config/silex/forge.env`). HTML **not in git**.

`--dry-run` works on every command, anywhere in argv. It runs the whole chain
— engine materialize, build from hub, og, share-bar inject, `wrangler.toml`
patch — against a **sandboxed copy of the hub** (`$WORK/hub-root`, with
`FORGE_CONFIG` redirected so the Python helpers follow), then prints the deploy
plan instead of deploying. `publish.sh --dry-run` passes `--dry-run` to
`gen-og-images.sh`, which does not POST. The online preflight still runs: it
is a gate, not a preview. Nothing is written to the real hub, no KV entry is
touched, no shortlink is minted.

## Hub drift guard

Every deploy is a **full** snapshot of the Pages project built from the
**local** hub, and that hub must be a directory **shared between everyone who
publishes to this forge** — by whatever sync mechanism the operator chose (see
`docs/artifacts-config.md` § Sharing the artifacts directory; the repo assumes
none). A local copy that is behind therefore publishes a snapshot that
**deletes** the artifacts other people added — the live site has no other
source of truth. A local lockfile can give **no** cross-machine exclusion, and
no sync tool provides one either. This KV guard is the only protection.

`preflight_before_live` fingerprints the hub (`lib/snapshot.py`, sha256 per slug
over sorted relative path + bytes, so digests compare across machines), reads
the `snapshot:live` KV record written after the last successful deploy, and
refuses when the deploy would remove a recorded slug — or when it cannot tell
what is live. It sits in the preflight, not in `deploy_pages`, because
`cmd_remove` clears KV and `rm -rf`s the hub artifact **before** the deploy — a
guard further down would abort after the destruction it exists to prevent.

|Situation|Behaviour|
|---|---|
|Unexpected removal (proven) on a verifiable record|**refuses** — exit 3 — unless `--allow-removals`|
|Unexpected removal (proven) on an `unverified` / `untrusted` record|**refuses** — exit 3 — unless **both** `--allow-removals` **and** `--allow-unverified`|
|`cmd_remove`'s own slug|passes (`EXPECTED_REMOVALS`)|
|No record AND the Pages project has **confirmed** no live deployment (fresh forge)|proceeds — verdict `bootstrap`, nothing live to lose|
|No record / unreadable KV / unparseable record / compare failure / `snapshot.py` missing, while a live deployment exists or the live lookup itself failed|**refuses** — exit 4, verdict `unverified` — unless `--allow-unverified`|
|`snapshot:live` read **denied or failed** (`KV_GET_STATUS` = `denied` / `error`, wrangler fallback included)|**refuses** — exit 4, `unverified`, reason names the KV read — unless `--allow-unverified`|
|Record anchored on another deployment id (rollback, dashboard deploy)|**refuses** — exit 4, verdict `untrusted` — removals still named; unless `--allow-unverified`|
|The live deployment id changed between the guard and the upload (a teammate deployed mid-run)|**refuses** in `deploy_pages`, before `wrangler`, naming both ids — no flag lifts it; re-run|
|The guard itself never observed live (its lookup failed, or it was skipped for an unresolved artifacts root)|**refuses** in `deploy_pages` (`hub drift unverified`) — unless `--allow-unverified`; never claims a teammate deployed|
|The live deployment id cannot be re-resolved at the upload|**refuses** in `deploy_pages` (`hub drift unverified`) — unless `--allow-unverified`|
|`--dry-run`|exit 4 downgrades to a warning ("would refuse …") because a dry run deploys nothing; exit 3 stays fatal|

This fail-closed rule exists because of a real loss on 2026-09-06. The guard's
first run found no `snapshot:live` key yet, took verdict `bootstrap`, and
skipped the check. A hub copy missing one artifact then deployed a full
snapshot that deleted it live, and `snapshot_record` baselined the 30-slug
state so later runs saw a clean "match". An unverifiable state therefore
refuses and needs an explicit operator override.

`snapshot.py compare` exit codes: `0` safe · `3` proven removals · `4` cannot
verify · `1` usage/internal. Precedence: exit 3 outranks exit 4 outranks 0.
The guard distinguishes "the project has no deployment" from "the live lookup
failed" (`--live-unknown`): conflating them would re-open the hole offline.

**A proven removal on an unverifiable record takes both flags.** Because exit 3
outranks exit 4, `--allow-removals` alone used to wave through a record that no
longer describes the live site — strictly more dangerous than the zero-removal
case, and it took the weaker flag. The guard keeps the compare payload instead
of discarding it and reads `verifiable`: when that is false, the override
requires `--allow-removals` **and** `--allow-unverified`. The zero-removal
`unverified` / `untrusted` refusal is unchanged.

**The guard is re-asserted at the upload.** The check runs in the preflight, but
`wrangler pages deploy` happens minutes later — engine git clone,
`build_from_hub`, OG rendering for every slug on `--rebuild-index`. So
`snapshot_guard` publishes `SNAPSHOT_GUARD_PASSED` (`true`/`false`) and
`SNAPSHOT_GUARD_LIVE_ID` (the live deployment id) plus `SNAPSHOT_GUARD_LIVE_UNKNOWN`
on every proceed path, and `deploy_pages` re-asserts them immediately before
`wrangler pages deploy`: an unset or `false` sentinel is an internal error (no
code path may reach the upload unguarded), an id that has moved is a refusal
naming both ids, and a re-resolution that itself fails refuses unless
`--allow-unverified`. The id is empty in two different situations and the
`LIVE_UNKNOWN` sentinel is what separates them: a **confirmed-empty** deployment
list is a real observation, so live gaining an id since then IS a teammate's
deploy and refuses unconditionally, whereas a guard that **never saw** live has
nothing to compare against — that refuses as `unverified` (overridable) and
never accuses anyone of deploying. A teammate who publishes inside that
window now makes this run refuse instead of deleting their artifact — the loser
re-runs. `acquire_publish_lock` cannot cover this: it is per-slug, so two
people publishing different slugs never contend at all, and `flock` is a
kernel-local advisory lock on an inode in **each machine's own copy** of the
shared directory — no sync mechanism propagates lock state. There is no
cross-machine serialization anywhere; the KV record plus this re-assert are the
entire enforcement.

**The re-assert is detection, not exclusion — the residual race is accepted.**
It shrinks the window from "the whole build" to "the upload itself": a deploy
landing between the re-read and the end of `wrangler pages deploy` is still
overwritten. Closing that completely needs a lock Cloudflare does not offer
(Pages Direct Upload has no compare-and-swap on the deployment id), so the
honest posture is a narrow window plus a record that makes the next run see
the drift. A re-resolution that itself fails refuses rather than proceeding:
unlike the KV-read deadlock, that state is transient — the preflight already
reached the API, so the remedy is to re-run, not to override.

**A KV read failure is named, not dressed up as a stale hub.**
`preflight_mutations` runs with `require_kv=False` on purpose — a token whose
KV REST read is denied is admitted because the write paths fall back to
wrangler OAuth — so such a token does reach the guard. `kv_get_key` therefore
has the same wrangler fallback as the put/delete paths and classifies the read
in `KV_GET_STATUS` (`ok` · `miss` · `denied` · `error`). A `miss` is a genuine
404: empty record, the verdict decides as before. `denied` and `error` refuse
as `unverified` with the cause named — *"KV record read denied — the API token
lacks Workers KV read, or wrangler OAuth is unavailable"* and *"KV record read
failed"*. `--allow-unverified` is still required; the operator is told the real
cause instead of being sent to refresh a hub that is fine.

Under `--dry-run` the fallback is deliberately **not** attempted: `kv_wrangler`
spawns `wrangler whoami` and `wrangler kv namespace list` before the read, and
`forge_wrangler` resolves to `npx --yes wrangler` when no global wrangler
exists — three npm-routed invocations, measured at ~8 s each, for one
rehearsed read. It does not hang (a logged-out `wrangler whoami` prints *"You
are not authenticated"* and never opens a browser — verified), it just buys
nothing: the fallback can only confirm what the message already states. So a
REST-denied read makes the dry run say what it actually knows — the read was
denied over REST, a real publish retries it through wrangler OAuth — and
decline to predict the verdict, instead of printing a `would refuse` a real
publish would not honour. Every other unverifiable reason keeps its
`would refuse …` line. The dry-run suite pins the boundary: zero wrangler
invocations, in either recording log.

**Recovery from a lost record: `publish.sh --reanchor-snapshot`.**
`snapshot_record` is best-effort, so one refused KV write after a successful
deploy leaves the record anchored on the *previous* deployment — `untrusted` on
every publish afterwards. Without a re-anchor the only exit was
`--allow-unverified`, which overwrites the baseline from a possibly-stale hub:
that is the 2026-09-06 loss, byte for byte. `--reanchor-snapshot` reads the
record, rewrites **only** `deployment_id` and `at` (`snapshot.py reanchor`,
`slugs` and `by` preserved verbatim) and writes it back to KV. It never builds
and never deploys, it honours `--dry-run` (prints the record it would write,
mutates nothing), and it dies rather than fabricate anything: no record to
re-anchor means the operator must publish, and a failed live lookup or a failed
KV write is fatal. It is deliberately **not** gated by the guard it repairs —
that refusal is the reason you are running it — which is sound only because it
touches no artifact, no build and no deploy.

The record is anchored on `latest_deployment.id`: the Pages API exposes no
per-file manifest, so the record is our own bookkeeping and would otherwise lie
after a rollback or a dashboard deploy. The same payload yields the live
deploy's engine commit (`deployment_trigger.metadata.commit_hash`).

`bootstrap` is the only verdict that lets an unrestricted full-snapshot deploy
through with no record, so "the project has no deployment" is a
**verified-empty** claim rather than an inference from one nullable field: when
`latest_deployment.id` is absent, `live_deployment()` confirms against the
deployments-list endpoint and keeps `error_kind="no_deployment"` only for a
list that is genuinely empty. A non-empty or unreadable list yields a different
`error_kind`, which `publish.sh` maps to `live_unknown=true` — unknown, not
empty — so the verdict is `unverified`, not `bootstrap`.

Pages Direct Upload already dedupes by content hash
(`blake3(base64(content) + extension)`, per project, server-side) — so a deploy
only uploads what changed. That only holds while the build is byte-stable:
`share-bar.js` is inlined into every artifact, so `inject-share-bar.py` and
`inject-og.py` MUST stay idempotent with strip as the exact inverse of inject,
and the share bar MUST NOT be written back into the hub. `share_bar_script()`
is the single resolution point (clone first) — two callers resolving it
differently flip the hash of the whole catalogue.

## Structure

```
# main = ENGINE only (CF upload)
plugins/silex-forge/ # publish + setup — NOT HTML craft
 forge.config.example.json
 scripts/publish.sh · build-site-from-hub.py · forge-doctor.sh
 scripts/forge-discover.sh · forge-provision.sh · gen-og-images.sh
functions/ # Access middleware, /api/*, /s/*
site/ # skeleton only (404, _headers, …) — NOT artifact HTML
# /s/* runtime # Function + KV

# not in git
# hub $artifacts/<slug>/{index.html,meta.json} = SSOT
# live = wrangler Direct Upload (no payload branch)

# craft (slides / onepager / cheatsheet) = silex-craft@silex-plugins
```

## Machine config (artifacts in silex-hub)

**SSOT HTML** = shared silex-hub vault (path **differs** per person)  
**Deploy** = `publish.sh` → build from hub → `wrangler pages deploy`  
**main** = engine only (no HTML)

| File | Role |
|---|---|
| `~/.config/silex/forge.config.json` | local: `hub_root`, `pages_project`, `public_host`, `vault_markers` — **not git** |
| `~/.config/silex/forge.env` | credentials + the Access/Shlink Pages vars: CF token · account · KV id · `CF_ACCESS_*` · `SHLINK_API_URL` (chmod 600, dir 700) — **not git**, and never `public_host` / `pages_project` |
| `.env.example` | schema reference for `forge.env` — **never `cp` it onto a real file** |
| plugin `forge.config.example.json` | defaults + fallback if no local config |

Config keys `pages_project` / `public_host` = SSOT in `forge.config.json`, with no environment override: `publish.sh` resolves both from the config and only exports `PUBLIC_HOST` internally, to push it into the deployed `wrangler.toml` `[vars]`. `forge.env` cannot set them; `.env.example` ships no host value. Point a run at another forge with `FORGE_CONFIG=<path>`.

### Set up a machine

```bash
wrangler login                                          # OAuth scopes: pages (write), workers_kv (write)
plugins/silex-forge/scripts/forge-discover.sh --write   # attach to an existing forge
plugins/silex-forge/scripts/forge-provision.sh          # OR stand one up on an empty account (interactive only)
plugins/silex-forge/scripts/forge-doctor.sh
plugins/silex-forge/scripts/publish.sh --rebuild-index  # hub → wrangler Pages
```

`--write` merges the discovered keys into `forge.env` (prints **key names only**) and persists the confirmed `pages_project` into an **existing** `forge.config.json` — it never creates that file. Never discoverable: `CLOUDFLARE_API_TOKEN` (API token permissions: Pages Edit · Workers KV Storage Edit · Account Settings Read · **Browser Run Write** — not the OAuth scopes above) and `hub_root` (local vault path). Both come from the operator via **`/forge-setup`**.

| `forge-discover.sh` exit | Meaning | Next |
|---|---|---|
| `0` | forge found (missing project keys are listed with a follow-up command — still `0`) | `--write`, then the token |
| `1` | **two classes.** Tooling/login: wrangler / npx missing, not logged in, Pages list or download failed, parser failure. **Or** a local prerequisite: `forge.config.json` unreadable / not a JSON object / in a read-only dir, or `chmod 600` on `forge.env` failed | Tooling → `wrangler login` (or install wrangler / relink the plugin). Prerequisite → fix or recreate `forge.config.json` (perms, valid JSON object) and `chmod 600` the env file; **not** `wrangler login`, and never a bare retry — `--json` does not touch those files, so it keeps exiting `0` while `--write` keeps exiting `1`. `forge.env` is already written when this fires, so the run is half-applied |
| `2` | named project absent, or the list was unreadable | other names listed → `--project NAME` · empty account → `forge-provision.sh` · list unparsed → **never provision and never `--project`** (the same output would be re-parsed): relink/reinstall the plugin (wrangler version mismatch), verify `wrangler pages project list` by hand, re-run |

Project-name defaults are two, on purpose: `forge-discover.sh` → `silex-forge` (the Silex forge), `forge-provision.sh` prompt → `[forge]` (never brand a client's project). `forge.config.json`'s `pages_project` overrides both.

| `forge-doctor.sh` exit | Meaning | Next |
|---|---|---|
| `0` | ready — **offline**: every value is present, none is proven to work. `--online` is the live check (a revoked token or a deleted Pages project still exits 0 offline); doctor's last line points there | `--online`, then publish |
| `1` | hub/config KO (or missing `lib/` / `python3`) | operator runs **`/forge-setup`** |
| `2` | hub OK, **deploy blocked** (token · account · KV id · Access vars · `forge.env` perms) | run the command doctor names per blocker |

`--json` (payload) and `--quiet` (one stderr line on any non-zero exit) follow the same codes, including a `load_config` crash: `--json` still emits a JSON document (`ok: false` + one `issues[]` line naming `lib/load_config.py`), `--quiet` still one stderr line, both exit `1`. A missing token is exit `2`, not a hub problem — and never a silent `0`. An empty `public_host` is a config **issue** (exit 1), never an exit-2 blocker.

`publish.sh` refuses to deploy while doctor reports `ok: false`: it dies naming `/forge-setup` instead of falling back to the example config. `--share <slug>` verifies the hub artifact exists before any clone or deploy.

## Plugin in this repo

| Plugin | Contents |
|---|---|
| **`silex-forge`** | `forge-publish` · `forge-setup` — **Cloudflare upload only** |

Craft HTML Halo / onepager / cheatsheet → **`silex-craft@silex-plugins`**.  
Generic slide engine + diagrams → external plugins (see **forge-setup**).  
**Rocky**: `rocky@rocky` (`go-silex/rocky`) — outside this repo.

Harness-specific plugin install and validation: README → Install the plugin.

Related plugins (Claude):

```
/plugin marketplace add go-silex/silex-plugins
/plugin install silex-craft@silex-plugins

/plugin marketplace add https://github.com/zarazhangrui/frontend-slides
/plugin install frontend-slides@frontend-slides

/plugin marketplace add https://github.com/cathrynlavery/diagram-design
/plugin install diagram-design@diagram-design

npx skills add alchaincyf/huashu-design

/plugin marketplace add go-silex/rocky
/plugin install rocky@rocky
```

### `silex-plugins`

| Plugin | Why |
|---|---|
| `silex-ops` | Vault, session, HPFO, onboarding |
| `silex-delivery` | ERP, digests, brain-factory, client cases |
| `silex-craft` | `silex-slides` · `silex-onepager` · `silex-cheatsheet` |

## Docs

- `docs/cloudflare-access.md` — Access + Bypass `/s` — **Silex team-prod instance**
- `docs/cloudflare-pages.md` — Pages deploy + env vars — **Silex team-prod instance**
- `docs/share-model.md` — share / key / shortlink
- `docs/artifacts-config.md` — hub SSOT + local forge config + `vault_markers` (client-owned account)
- `docs/public-release.md` — going public + history purge

A forge on someone else's Cloudflare account: `forge-provision.sh` + `"vault_markers": []` — see `docs/artifacts-config.md`, not the two Silex-instance docs above.

## OG thumbnails (landing)

Rendered **before** `wrangler pages deploy` by Cloudflare Browser Run REST
(`html` payload, JPEG out), invoked from `gen-og-images.sh` via `lib/og_render.py`.
Publisher machines need `python3` and the existing `CLOUDFLARE_API_TOKEN` with
**Browser Run Write** beside Pages Edit / Workers KV Edit / Account Settings
Read — not chrome/chromium/ffmpeg/jq. A token missing Browser Run Write makes
every render fail per slug; the publish still succeeds.

Storage is unchanged: `site/a/<slug>/og.jpg` in the Pages snapshot, a copy in
the hub SSOT, `og.src` hub-only proof (v2 digest = canonical HTML + subresources).

```bash
plugins/silex-forge/scripts/gen-og-images.sh
plugins/silex-forge/scripts/gen-og-images.sh --slug my-slug --force --quality 80
```

`--force` is a `gen-og-images.sh` flag. `publish.sh --force-og` passes it
through. `--rebuild-index` without `--force-og` still only re-renders `is_stale`
slugs. `--quality` is JPEG 1–100, default 80 — not ffmpeg `-q:v`. A dry run
does not POST.

Best-effort: missing token / Browser Run failure warns and publish continues.
A render that fails leaves the previous thumbnail in place, and the per-slug
warning now names the reason.

The page renders from an inline HTML string, so it has an opaque origin and no
base URL. Two consequences, both measured:

- A third-party embed that needs a real origin degrades — `lgu-recap`, whose
  remote tella.tv player is replaced by its own client-side error box.
- A path built at runtime cannot be rewritten. Inlining covers `src=`, `href=`
  and `url()`; a `fetch()` argument is computed while the page runs —
  `infographie-repos-showcase` reports *Failed to parse URL* on
  `tabs/<id>.html`. No inlining strategy closes this, and that card is already
  broken the same way on `main`. It is the only artifact of the 33 affected.

Rendering either faithfully would need to navigate the real URL, which sits
behind the visibility ACL.

Pin a slug whose card the inline payload cannot reproduce:

```bash
touch $hub/<artifacts_dir>/<slug>/og.keep
```

`gen-og-images.sh` never re-renders a pinned slug — `--force` does not
override it. Delete the file to un-pin. No `og.src` is written while pinned,
so un-pinning reads as stale and re-renders on the next run. A pin with no
existing thumbnail still renders: preserving a card that does not exist
would ship no card at all. The marker lives in the hub, so the decision
travels to every publisher; `build-site-from-hub.py` never copies it into
the deploy tree, like `og.src`. The run summary gains `, N pinned` only
when N > 0. The pin preserves an older capture; it does not fix the
rendering limits.

The v2 digest prefix cannot collide with a v1 proof, so after upgrading every
artifact reads as stale exactly once. Until a slug is re-rendered its previously
published card keeps shipping. Recommend `publish.sh --rebuild-index` once
after the upgrade (~33 renders, well inside the 10 browser-hours/month included
on Workers Paid). That is a recommendation, not a prerequisite — nothing
breaks if skipped.

A publisher still on the previous engine computes a v1 digest and will
re-render and re-persist a slug a v2 machine already proved, and vice versa.
Consequence is bounded churn (extra renders, different JPEG bytes uploaded),
never a deleted card. Everyone should pull.

Doctor no longer reports an OG toolchain at all.

## Agent rules

1. Never deploy forge on Vercel
2. Never put secrets in `site/`
3. Never list share keys in the catalogue
4. Publish = hub SSOT + `wrangler pages deploy`; CF token = `~/.config/silex/forge.env` — never in git / GH
5. **main** does not hold HTML (`site/a`, `registry/*.json`) — engine only
6. After a large publish: verify Access (302 without cookie) and share (200 without cookie on `/s/.../key/`)
7. **pages.dev** under Access (+ middleware 403 on every path) — never use it as an alternate share origin
8. Share secrets = **KV only** — never `share_key` in meta/registry/HTML
9. Missing forge config → tell the operator to run `/forge-setup` (do not invent hub_root; do not auto-invoke forge-setup)
10. Artifacts → hub `$artifacts_dir/<slug>/`; live CF ← Direct Upload (not git)
11. No Cloudflare account / Access AUD / KV namespace IDs in git — `.env.example` placeholders only
12. `plugins/silex-forge/scripts/` is **English-only** (CLI output, `die`/`info`/`warn`, doctor lines, comments, docstrings); French-by-design allowlist = `gen-index.py` (site UI), `hub-index.py` (vault note), `share-bar.js` (team toolbar) — enforced by `tests/python/test_lang_boundary.py`, so a French string outside the allowlist fails CI
