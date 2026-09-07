# Public release — remediation checklist

**`go-silex/silex-forge` is already public**, so every item below is
remediation of a live exposure, not preparation for a launch: anonymous
`git ls-remote` on the HTTPS clone URL succeeds today.

## HEAD (this commit)

- No HTML payloads in tree (`site/a`, `registry`, `manifest.json`)
- No Cloudflare account / KV / Access AUD in committed files
- Secrets only in `~/.config/silex/forge.env` and Pages dashboard

## Git history (required remediation)

Older commits may still contain:

- `site/a/**`, `site/manifest.json`, `registry/**` (internal catalogue)
- `site/s/**` — share-key URLs. The key *is* the URL, so a historical blob
  under `site/s/<slug>/<key>/` is a live capability, not just a leaked name
- `wrangler.toml` with real KV namespace ID and Access AUDs

**HEAD being clean is not enough.** `git filter-repo` rewrites every local
ref, then deletes the `origin` remote. The closing push therefore has to name
origin's real heads explicitly — captured *before* the rewrite with
`git ls-remote --heads origin` — plus `--tags`. Never `git push --all`.

`--all` is the silent failure mode that *creates* branches. Measured: a clone
that had fetched `refs/pull/*` into `refs/remotes/origin/pr/*` came out of the
rewrite carrying `refs/heads/pr/12`. This working checkout carries **52
remote-tracking refs, 46 of which are not branches on origin** (`pr/1`…`pr/46`,
`pr-merge/44`…`46`). `push --all` from here would publish ~46 junk branches on
the public repo. The script never prints `--all`: `--dry-run` in this same
checkout prints origin's five real heads
(`chore/dev-core-contract ci/trufflehog-secret-scan feat/og-render-cloudflare
feat/publish-dry-run main`) and the real run no longer refuses. That list is
correct in a fresh clone *and* in this contaminated one, because it comes from
the remote, not from local tracking refs.

Pushing `main` alone is the other silent failure: the other origin heads keep
the pre-purge blobs. `--all` is not the remedy for that either — it over-publishes.
The explicit list is. Tags are a third set: `--all` does not push them, origin
carries **35** `silex-forge/vX.Y.Z` release tags, and a tag on a leaky commit
keeps the blob alive until `git push --force origin --tags` (plain `--force`;
there is no per-tag lease).

A throwaway clone is still the right *place* to rewrite — filter-repo's own
recommendation, and the local object store is dirty afterwards — but it is no
longer what makes the push safe. Run:

```bash
scripts/purge-git-history.sh --dry-run   # print the plan and the exact push list
scripts/purge-git-history.sh             # the real run, prompts before rewriting

# The script prints these four lines with the origin URL and branch list it
# captured before rewriting. Do not substitute `push --all`.
git remote add origin git@github.com:go-silex/silex-forge.git
git fetch origin                          # --force-with-lease needs a tracking ref
git push --force-with-lease origin <heads from the script>
git push --force origin --tags            # a tag still pins the old history
```

`git filter-repo` removes the `origin` remote by design — it prints
`NOTICE: Removing 'origin' remote` — so a push straight after a rewrite dies
with exit 128, `fatal: 'origin' does not appear to be a git repository`.
Re-adding the remote alone is not enough either: `--force-with-lease` needs a
remote-tracking ref, and without `git fetch origin` the push exits 1. With no
origin configured the script prints the literal placeholders
`<your-origin-url>` and `<branch-list from: git ls-remote --heads origin>`.
`GIT_TERMINAL_PROMPT=0` wraps that `ls-remote` so an HTTPS credential prompt
cannot hang the script.

**That `git fetch origin` re-imports the purged objects into the local clone.**
Traced by blob sha through the whole sequence: after `git filter-repo` the blob
is absent from the local object store; after `git fetch origin` it is back —
present *and* reachable from a ref; after the two force-pushes it is still
present in the local object store, only no longer reachable from any ref. The
remote heads and tags are clean at that point, the operator's clone is not: the
objects sit there until `git gc` expires them. So a fresh clone is the end
state for everyone, the operator included, not just teammates.

`--dry-run` prints the dropped paths, the replacement rules and the closing
push, then exits without touching a commit. It never prints a resolved id —
each value shows as `len=<n> sha256=<12 hex prefix>` — so the output is safe
to paste into an issue. `--yes` skips the confirmation prompt; any other
argument exits 1; `--help` documents both.

Prerequisites:

- [git-filter-repo](https://github.com/newren/git-filter-repo) — checked only on
  the real run, so `--dry-run` works without it
- `python3`
- a populated `~/.config/silex/forge.env` (override the path with `FORGE_ENV`)

The script resolves `CLOUDFLARE_ACCOUNT_ID` and `FORGE_SHARES_KV_ID` from that
file at run time via `plugins/silex-forge/scripts/lib/load_config.py` — the same
resolution `publish.sh` uses, with `forge.config.json` as fallback — and
**refuses to run** when either is missing or is not 32 lowercase hex: exit 1,
naming the env file and `forge-discover.sh --write`. It no longer carries the
values itself. Until 2026-09-08 both IDs sat in this public script as plaintext
`literal:` rules, so the tool whose job is to erase them from history was
republishing them on HEAD — a standing AGENTS rule 11 violation, found by a
history scan on `main` and on every live branch.

On the current engine-only tree the rewrite removes **no files from HEAD**:
`site/a`, `site/index.html`, `site/manifest.json` and `registry` are already
absent, and the `site/s/*/*` glob stops one level below `site/s`, so the only
entry there — `site/s/.gitkeep` — survives. The whole effect is in the history.

## After purge — closing the live exposure

1. **`refs/pull/*/head` outlive the rewrite, and the exposure is live now.**
   GitHub keeps a ref per pull request outside `refs/heads`, and a force-push
   does not delete it: merged PRs #1 and #4–#10 are serving their pre-purge
   blobs to anonymous users at this moment. Evidence shape: anonymous
   `git ls-remote` on the HTTPS URL succeeds, and `raw.githubusercontent.com`
   returns HTTP 200 for a pre-purge blob. Rewriting history does not end this.
   Proven locally, not merely inferred from GitHub's HTTP surface: on a bare
   remote carrying `refs/pull/7/head`, the complete correct sequence — purge,
   `remote add`, `fetch`, explicit-heads force-push, `push --force --tags` —
   still left the secret on the remote, held by that one ref alone; deleting
   `refs/pull/7/head` cleared it. The caveat is a measured property of git,
   not a guess about GitHub. The only close is GitHub Support dropping
   `refs/pull/*/head`, or recreating the repository — open that request in
   parallel with the rewrite; nothing local substitutes for it.
2. **Four live branches still carry the pre-fix script at their tip** —
   `chore/dev-core-contract`, `ci/trufflehog-secret-scan`,
   `feat/og-render-cloudflare` and `feat/publish-dry-run`, i.e. open PRs #44,
   #45 and #46 — each with two plaintext `literal:` id rules in
   `scripts/purge-git-history.sh`. Once the bare-hex rule is on `main`, those
   PRs fail the `Secret / infra ID scan` until they are rebased onto the fixed
   script. That is the rule working as intended, not a false positive.
3. Fresh clone on a clean machine — for everyone, the operator who ran the purge
   included — then grep history for known KV/Access id patterns and client slug
   names
4. Set GitHub **License** field to MIT (matches [LICENSE](../LICENSE))
5. Enable [security policy](https://github.com/go-silex/silex-forge/security/policy) and issue templates
6. Verify the exposure is closed: repo visibility reads `public` as intended,
   and the pre-purge blob URLs — the `refs/pull/*` commits on
   `raw.githubusercontent.com` — no longer resolve anonymously once Support has
   dropped the refs. A 404 on those commits is the proof; a clean HEAD is not.
7. Confirm Pages env vars still set (deploy injects from `forge.env`)
8. Tag the release from the top CHANGELOG section (`silex-forge/vX.Y.Z`) — see [CHANGELOG.md](../CHANGELOG.md)

## Ops credentials (never in git)

| File | Contents |
|---|---|
| `~/.config/silex/forge.env` | token, account, KV, Access, optional `SHLINK_API_URL` |
| Pages secrets | `SHLINK_API_KEY`, `FORGE_SHARE_SECRET` |

`public_host` and `pages_project` are not credentials and never live here:
`~/.config/silex/forge.config.json` owns both, with no environment override —
`forge.env` cannot set them.

Build `forge.env` with `wrangler login` + `forge-discover.sh --write`, not by
copying [`.env.example`](../.env.example). The example is a schema reference
(key names and comments, no values); copying it over a working file wipes the
real credentials. On a fresh Cloudflare account, run
`plugins/silex-forge/scripts/forge-provision.sh` instead.
