## Summary

<!-- What does this PR change and why? -->

## Type

- [ ] fix
- [ ] feat
- [ ] docs
- [ ] chore (release, CI, tooling)

## Checklist

- [ ] **No secrets** — no tokens, share keys, account/KV/AUD IDs, or real `forge.env` / `forge.config.json`
- [ ] **No HTML payloads** — no `site/a/**`, `site/index.html`, `registry/*.json`
- [ ] Docs/skills updated if user-facing behavior changed
- [ ] [CHANGELOG.md](CHANGELOG.md) updated (`[Unreleased]` or `## [X.Y.Z]`)
- [ ] Plugin version bumped in **all** version-bearing manifests if plugin surface changed (root `plugin.json`, 4 harness `plugin.json`, `package.json`, Claude/Grok/OMP catalogs — see CONTRIBUTING). Codex catalog has no version.
- [ ] `bash -n plugins/silex-forge/scripts/publish.sh` passes locally

## Test plan

<!-- How did you verify? e.g. forge-doctor, publish dry-run, manual Access check -->
