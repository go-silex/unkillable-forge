# Manual engine packaging (historical)

**Superseded by [forge-release-ops.md](forge-release-ops.md).** F11 replaces hand packaging and ad-hoc Wrangler deploys with CI-built `engine/vX.Y.Z` artifacts, `scripts/forge-deploy.sh`, and post-deploy smoke.

Keep this file only as a pointer to the offline dry-run shape that `scripts/build-engine-release.sh` still mirrors (empty HOME, empty env file, `CI=1`, metrics off, retain every emitted module including read Data/Text siblings). Do not use these commands as a release or deploy authority.

```sh
umask 077
WORK=$(mktemp -d) && chmod 700 "$WORK"
mkdir "$WORK/home" "$WORK/manage" "$WORK/read"
: > "$WORK/empty.env"
W=node_modules/@cloudflare/vitest-plugin/node_modules/.bin/wrangler
env -i PATH="$PATH" HOME="$WORK/home" CI=1 WRANGLER_SEND_METRICS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  "$W" deploy --dry-run --config wrangler.manage.toml --env-file "$WORK/empty.env" --outdir "$WORK/manage"
env -i PATH="$PATH" HOME="$WORK/home" CI=1 WRANGLER_SEND_METRICS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  "$W" deploy --dry-run --config wrangler.read.toml --env-file "$WORK/empty.env" --outdir "$WORK/read"
```

Private instance Wrangler configs remain operator-owned outside Git. Never deploy the checked-in local-only profiles. Code-only rollback stays on the same current R2/D1 with a compatible Worker — never restore an old database or rights as rollback.
