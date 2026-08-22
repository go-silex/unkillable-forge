# Reference implementation of expected kv_wrangler env hygiene (for contract testing).
kv_wrangler_dry() {
  local wb="$1"
  shift
  local ns="${FORGE_SHARES_KV_ID:-test-ns}"
  env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
    CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-acct}" \
    "$wb" "$@" --remote --namespace-id="$ns"
}
