# Contributing to silex-forge

Thanks for your interest in this project.

**silex-forge** is the **engine + plugin** for hosting team HTML artifacts on Cloudflare Pages (Claude, Grok, OMP, Codex).  
It is **not** the place for decks, talks, or client HTML — those live in **silex-hub** (outside git).

## What we accept

| In scope | Out of scope |
|---|---|
| `plugins/silex-forge/` (skills, scripts, hooks) | HTML under `site/a/` or `registry/` |
| `functions/` (Access, share, catalogue) | Secrets, tokens, KV IDs, Access AUDs |
| `site/` skeleton (`404`, `_headers`, …) | Cloudflare ops on production Gosilex account |
| Docs in `docs/`, `README`, this file | Craft HTML → [`silex-craft@silex-plugins`](https://github.com/go-silex/silex-plugins) |

## Before you start

1. Read [README.md](README.md) and [AGENTS.md](AGENTS.md)
2. If going public on a fork: [docs/public-release.md](docs/public-release.md)
3. Never commit `~/.config/silex/forge.env` or real infrastructure IDs

## Development setup

### Install the plugin

Harness-specific install commands: [README.md → Install the plugin](README.md#install-the-plugin).

### Machine config (for publish tests)

```bash
cp .env.example ~/.config/silex/forge.env
chmod 600 ~/.config/silex/forge.env
# fill from your ops vault — see forge-setup skill

plugins/silex-forge/scripts/forge-doctor.sh
```

You need a valid **silex-hub** path in `~/.config/silex/forge.config.json`. Do not invent paths — use `forge-setup`.

### Craft HTML (separate plugin)

```text
/plugin marketplace add go-silex/silex-plugins
/plugin install silex-craft@silex-plugins --scope user
```

## Plugin layout

```
.claude-plugin/marketplace.json    # Claude marketplace catalog
.grok-plugin/marketplace.json      # Grok marketplace catalog
.omp-plugin/marketplace.json       # OMP marketplace catalog
.agents/plugins/marketplace.json   # Codex repo marketplace
plugins/silex-forge/
  .claude-plugin/plugin.json       # Claude plugin manifest
  .grok-plugin/plugin.json         # Grok plugin manifest
  .omp-plugin/plugin.json          # OMP plugin manifest
  .codex-plugin/plugin.json        # Codex plugin manifest
  package.json                     # OMP package (link / omp-plugins)
  skills/forge-publish/SKILL.md
  skills/forge-setup/SKILL.md
  skills/forge-setup/agents/openai.yaml  # Codex: no implicit invocation
  scripts/publish.sh
  scripts/forge-doctor.sh
  scripts/lib/load_config.py
  forge.config.example.json
```

When changing behavior, update **skills** if user-facing workflows change.

## Making changes

1. **Fork** and create a branch: `feat/…`, `fix/…`, or `docs/…`
2. **Edit** engine code or docs (English for user-facing text)
3. **Run checks** locally:

   ```bash
   bash -n plugins/silex-forge/scripts/publish.sh
   python3 plugins/silex-forge/scripts/lib/load_config.py --doctor  # needs local hub config
   ```

4. **Update** [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]` or the target version
5. **Open a PR** — the template checklist must pass

### Version bumps

If you change the plugin surface (skills, scripts, manifests):

- Bump `version` in all version-bearing manifests:
  - `plugins/silex-forge/.claude-plugin/plugin.json`
  - `plugins/silex-forge/.grok-plugin/plugin.json`
  - `plugins/silex-forge/.omp-plugin/plugin.json`
  - `plugins/silex-forge/.codex-plugin/plugin.json`
  - `plugins/silex-forge/package.json`
  - `.claude-plugin/marketplace.json` (catalog + plugin entry)
  - `.grok-plugin/marketplace.json` (catalog + plugin entry)
  - `.omp-plugin/marketplace.json` (`metadata.version` + plugin entry)
- Keep `.omp-plugin/plugin.json` `$schema` on Agent Plugins 1.0.0 (OMP marketplace skills with `claude-plugins` off)
- Codex `.agents/plugins/marketplace.json` has no version field — version comes from `.codex-plugin/plugin.json`
- Add a CHANGELOG entry
- Maintainers tag `vX.Y.Z` on merge when appropriate

## Pull requests

- One logical change per PR when possible
- No drive-by refactors
- Link related issues if any
- **Do not** include HTML artifacts, `.env`, or `forge.config.json` with real paths/tokens
- CI must pass (shell syntax + Python smoke tests)

Reviewers may ask you to update skills, docs, or CHANGELOG.

## Security

See [SECURITY.md](SECURITY.md). Do not open public issues for vulnerabilities.

## Questions

- **Setup / publish on Gosilex infra** → internal team channel (not a public support obligation)
- **Engine bugs / plugin install** → GitHub Issues
- **Hosted `forge.gosilex.com` uptime** → Silex ops (see [SUPPORT.md](SUPPORT.md))

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
