#!/usr/bin/env bash
# Single entrypoint for secret scanning: lefthook pre-push AND
# .github/workflows/secret-scan.yml both run this script. One implementation,
# two consumers — the flags, the scope and the pin live here, nowhere else.
#
# Binary: repo-pinned under .cache/trufflehog/<ver>/, verified by sha256,
# NEVER the PATH. A stub or a stale binary on PATH must not decide whether the
# gate runs (an empty file in ~/.local/bin passes `command -v` and then dies
# with "Exec format error" — that is how this gate would fail open in practice).
# Pin SSoT: config/trufflehog.version
#
# Two passes, deliberately asymmetric flags:
#   1. CREDENTIAL — generic detectors, --only-verified, NO exclude list.
#      Verification calls the provider, so a fake token in a fixture is not a
#      finding and a live one is. Excluding tests/ here would be a blind spot.
#   2. INFRA-ID   — scripts/trufflehog-detectors.yaml, NO --only-verified
#      (its findings are unverifiable by construction), tests/ excluded.
# Both pass --fail explicitly: without it the CLI exits 0 while reporting
# findings, which is a green gate with detected secrets.
#
# This does NOT replace the `Secret / infra ID scan` step in ci.yml: that one
# greps the whole tree on every run, so an already-committed infra id keeps
# failing. Complementary, not redundant.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PIN="${ROOT}/config/trufflehog.version"
EXCLUDE_SRC="${ROOT}/scripts/trufflehog-exclude-paths.txt"
DETECTORS_SRC="${ROOT}/scripts/trufflehog-detectors.yaml"

SCAN_PATH="${1:-.}"

excl=$(mktemp)
tmp=""
trap 'rm -f "$excl"; rm -rf "${tmp:-}"' EXIT

pin_get() {
  local key="$1" line
  [ -f "$PIN" ] || {
    echo >&2 "ERROR: pin file missing: ${PIN}"
    return 1
  }
  line="$(grep -E "^${key}=" "$PIN" | head -1 || true)"
  [ -n "$line" ] || {
    echo >&2 "ERROR: ${key} absent from ${PIN}"
    return 1
  }
  printf '%s\n' "${line#*=}"
}

THOG_VERSION="$(pin_get version)"

thog_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}:${arch}" in
    Linux:x86_64) printf '%s\n' linux_amd64 ;;
    Linux:aarch64 | Linux:arm64) printf '%s\n' linux_arm64 ;;
    Darwin:x86_64) printf '%s\n' darwin_amd64 ;;
    Darwin:arm64) printf '%s\n' darwin_arm64 ;;
    *)
      echo >&2 "ERROR: no trufflehog pin for ${os}/${arch}"
      return 1
      ;;
  esac
}

file_sha256() {
  local f="$1" out
  if command -v sha256sum > /dev/null 2>&1; then
    out="$(sha256sum -- "$f")" || return 1
  elif command -v shasum > /dev/null 2>&1; then
    out="$(shasum -a 256 -- "$f")" || return 1
  else
    echo >&2 "ERROR: need sha256sum or shasum -a 256"
    return 1
  fi
  printf '%s' "${out%% *}" | tr 'A-F' 'a-f'
}

ensure_pinned_trufflehog() {
  local target archive want bin_want dir url got
  target="$(thog_target)" || exit 1
  want="$(pin_get "sha256_${target}")" || exit 1
  bin_want="$(pin_get "sha256_bin_${target}")" || exit 1
  dir="${ROOT}/.cache/trufflehog/${THOG_VERSION}/${target}"
  THOG="${dir}/trufflehog"

  if [ -s "$THOG" ]; then
    got="$(file_sha256 "$THOG")"
    [ "$got" = "$bin_want" ] && return 0
    echo >&2 "trufflehog: cached binary hash mismatch — re-fetching"
  fi

  archive="trufflehog_${THOG_VERSION}_${target}.tar.gz"
  url="https://github.com/trufflesecurity/trufflehog/releases/download/v${THOG_VERSION}/${archive}"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/thog-pin.XXXXXX")"
  echo "trufflehog: fetching pinned v${THOG_VERSION} (${target})"
  if command -v curl > /dev/null 2>&1; then
    curl -fsSL --retry 3 -o "${tmp}/${archive}" "$url"
  elif command -v wget > /dev/null 2>&1; then
    wget -q -O "${tmp}/${archive}" "$url"
  else
    echo >&2 "ERROR: need curl or wget to fetch pinned trufflehog"
    exit 1
  fi

  got="$(file_sha256 "${tmp}/${archive}")"
  if [ "$got" != "$want" ]; then
    echo >&2 "ERROR: archive checksum mismatch (${target})"
    echo >&2 "  want ${want}"
    echo >&2 "  got  ${got}"
    exit 1
  fi

  tar -xzf "${tmp}/${archive}" -C "$tmp" trufflehog
  mkdir -p "$dir"
  mv -f "${tmp}/trufflehog" "$THOG"
  chmod +x "$THOG"
  got="$(file_sha256 "$THOG")"
  if [ "$got" != "$bin_want" ]; then
    echo >&2 "ERROR: extracted binary hash mismatch (${target})"
    echo >&2 "  want ${bin_want}"
    echo >&2 "  got  ${got}"
    exit 1
  fi
}

ensure_pinned_trufflehog

if [ -f "$EXCLUDE_SRC" ]; then
  grep -vE '^[[:space:]]*(#|$)' "$EXCLUDE_SRC" > "$excl" || true
else
  echo >&2 "ERROR: exclude list missing: ${EXCLUDE_SRC}"
  exit 1
fi
[ -f "$DETECTORS_SRC" ] || {
  echo >&2 "ERROR: detector config missing: ${DETECTORS_SRC}"
  exit 1
}

echo "secret-scan: credential pass (verified only, no exclude) — ${SCAN_PATH}"
"$THOG" filesystem "$SCAN_PATH" \
  --only-verified \
  --fail \
  --no-update

echo "secret-scan: infra-id pass (custom detectors, tests/ excluded) — ${SCAN_PATH}"
"$THOG" filesystem "$SCAN_PATH" \
  --config="$DETECTORS_SRC" \
  --exclude-paths="$excl" \
  --fail \
  --no-update

echo "secret-scan: clean"
