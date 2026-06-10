#!/usr/bin/env bash
# HAP-55 — one-command in-house desktop release to the devBox feed.
#
# Pipeline (single `latest`, no multi-version retention):
#   1. build + package the macOS arm64 app (generic publish → latest-mac.yml)
#   2. parse version + artifact filenames OUT OF latest-mac.yml (never hardcoded)
#   3. wipe the feed's desktop/ dir, then scp the new dmg/zip/blockmap/yml in
#   4. regenerate the feed-root index.html from the yml (version/filenames from yml)
#
# The web /download page (HAP-54) and the Electron auto-updater both read this
# same `latest-mac.yml`, so there is exactly one source of truth.
#
# Signing: in-house builds are UNSIGNED (ad-hoc). Per HAP-52, macOS silent
# auto-update (Squirrel.Mac) needs a Developer ID cert, which this build lacks —
# so on macOS the feed enables a *manual* "check for updates" + re-download, not
# hands-off self-update. The feed/index/web wiring is correct regardless.
#
# SAFETY GATE: pushing artifacts to the feed mutates the shared internal
# release. The script will NOT touch devBox unless you pass `--deploy` (or set
# DEPLOY=1). Without it, the script builds, generates index.html locally, and
# prints exactly what it WOULD push, then stops. Restarting the web frontend
# container / rebuilding the web image is a SEPARATE deploy gate documented in
# apps/desktop/INHOUSE-UPDATE.md — this script never does that.
#
# Usage:
#   bash apps/desktop/scripts/publish-inhouse.sh             # build + dry plan
#   bash apps/desktop/scripts/publish-inhouse.sh --deploy    # build + push to devBox
#   SKIP_BUILD=1 bash .../publish-inhouse.sh                 # reuse existing dist/
#   GEN_INDEX_ONLY=<latest-mac.yml> bash .../publish-inhouse.sh   # only render index.html (testing)
#
# Env overrides:
#   DEVBOX_SSH        SSH host/alias for devBox          (default: devBox)
#   FEED_ROOT         remote feed root dir on devBox      (default: ~/.multica/desktop-feed)
#   FEED_SUBDIR       remote products subdir under root   (default: desktop)
#   FEED_BASE_URL     public base URL of the feed         (default: http://10.37.16.72:18082)
#   DEPLOY=1          same as --deploy
#   SKIP_BUILD=1      skip build+package, reuse dist/
set -euo pipefail

# ---- config -----------------------------------------------------------------
DEVBOX_SSH="${DEVBOX_SSH:-devBox}"
FEED_ROOT="${FEED_ROOT:-~/.multica/desktop-feed}"
FEED_SUBDIR="${FEED_SUBDIR:-desktop}"
FEED_BASE_URL="${FEED_BASE_URL:-http://10.37.16.72:18082}"

DEPLOY="${DEPLOY:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
GEN_INDEX_ONLY="${GEN_INDEX_ONLY:-}"
for arg in "$@"; do
  case "$arg" in
    --deploy) DEPLOY=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ROOT="$(cd "$HERE/.." && pwd)"
DIST_DIR="$DESKTOP_ROOT/dist"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[error] %s\033[0m\n' "$*" >&2; exit 1; }

# ---- yml parsing (no yaml dep; latest-mac.yml is a flat electron-builder file)
# version: top-level `version:` line.
# artifacts: every `url:` under the `files:` list (.zip/.dmg + .blockmap aren't
#   listed under files, so we add the on-disk blockmaps separately).
yml_version() {
  sed -n 's/^version:[[:space:]]*//p' "$1" | head -1 | tr -d '\r"'"'"' '
}
yml_urls() {
  # matches both "  - url: x" and "    url: x"
  sed -n 's/^[[:space:]]*-\{0,1\}[[:space:]]*url:[[:space:]]*//p' "$1" | tr -d '\r' | sed "s/^['\"]//;s/['\"]$//"
}

# ---- index.html generation (version + filenames come straight from the yml) --
# $1 = path to latest-mac.yml ; $2 = output html path
generate_index() {
  local yml="$1" out="$2"
  local ver dmg zip
  ver="$(yml_version "$yml")"
  [ -n "$ver" ] || die "could not read version from $yml"
  while IFS= read -r f; do
    case "$f" in
      *.dmg) dmg="$f" ;;
      *.zip) zip="$f" ;;
    esac
  done < <(yml_urls "$yml")
  [ -n "${dmg:-}" ] || warn "no .dmg url found in $yml"

  local feed_dir_url="$FEED_BASE_URL/$FEED_SUBDIR"
  local dmg_link="${dmg:+$feed_dir_url/$dmg}"
  local zip_link="${zip:+$feed_dir_url/$zip}"

  {
    cat <<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Multica In-house Desktop — Download</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 -apple-system, system-ui, sans-serif; max-width: 640px;
         margin: 8vh auto; padding: 0 24px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .ver { color: #888; margin-bottom: 28px; }
  a.btn { display: inline-block; padding: 10px 18px; margin: 6px 8px 6px 0;
          border-radius: 8px; background: #5b5bd6; color: #fff;
          text-decoration: none; font-weight: 600; }
  a.btn.alt { background: transparent; color: #5b5bd6; border: 1px solid #5b5bd6; }
  code { background: rgba(127,127,127,.15); padding: 1px 5px; border-radius: 4px; }
  .note { margin-top: 28px; font-size: 13px; color: #888; }
</style>
</head>
<body>
  <h1>Multica In-house Desktop</h1>
  <div class="ver">Latest version: <strong>$ver</strong> · macOS (Apple Silicon)</div>
HTML
    if [ -n "$dmg_link" ]; then
      echo "  <a class=\"btn\" href=\"$dmg_link\">Download .dmg ($ver)</a>"
    fi
    if [ -n "$zip_link" ]; then
      echo "  <a class=\"btn alt\" href=\"$zip_link\">.zip (auto-update artifact)</a>"
    fi
    cat <<HTML
  <p class="note">
    Unsigned in-house build — first launch is blocked by Gatekeeper. Right-click
    the app &rarr; <strong>Open</strong>, or run
    <code>xattr -dr com.apple.quarantine /Applications/Multica.app</code>.
    Update metadata: <a href="$feed_dir_url/latest-mac.yml">latest-mac.yml</a>.
  </p>
</body>
</html>
HTML
  } > "$out"
  echo "$ver"
}

# ---- GEN_INDEX_ONLY fast path (for testing the renderer) --------------------
if [ -n "$GEN_INDEX_ONLY" ]; then
  [ -f "$GEN_INDEX_ONLY" ] || die "GEN_INDEX_ONLY: file not found: $GEN_INDEX_ONLY"
  OUT="${INDEX_OUT:-/tmp/multica-feed-index.html}"
  v="$(generate_index "$GEN_INDEX_ONLY" "$OUT")"
  say "Rendered index.html for version $v → $OUT"
  exit 0
fi

# ---- 1. build + package -----------------------------------------------------
if [ "$SKIP_BUILD" = "1" ]; then
  say "SKIP_BUILD=1 — reusing existing $DIST_DIR"
else
  [ -f "$DESKTOP_ROOT/.env.production" ] \
    || warn ".env.production missing — packaged app may not point at devBox (see INHOUSE-UPDATE.md §1)"
  say "Building + packaging macOS arm64 (unsigned ad-hoc, no publish upload)"
  ( cd "$DESKTOP_ROOT/../.." && pnpm --filter @multica/desktop build )
  # --publish never: electron-builder still emits latest-mac.yml into dist/;
  # we ship it ourselves via scp below (no electron-builder uploader).
  ( cd "$DESKTOP_ROOT" && CSC_IDENTITY_AUTO_DISCOVERY=false \
      node scripts/package.mjs --mac --arm64 --publish never )
fi

YML="$DIST_DIR/latest-mac.yml"
[ -f "$YML" ] || die "latest-mac.yml not found in $DIST_DIR — did packaging succeed?"

VERSION="$(yml_version "$YML")"
[ -n "$VERSION" ] || die "could not parse version from $YML"
say "Release version (from latest-mac.yml): $VERSION"

# Collect the files to ship: yml + every artifact named in it + their blockmaps.
SHIP_FILES=("$YML")
while IFS= read -r u; do
  [ -n "$u" ] || continue
  [ -f "$DIST_DIR/$u" ] || die "yml references $u but it's missing in $DIST_DIR"
  SHIP_FILES+=("$DIST_DIR/$u")
  [ -f "$DIST_DIR/$u.blockmap" ] && SHIP_FILES+=("$DIST_DIR/$u.blockmap")
done < <(yml_urls "$YML")

INDEX_HTML="$DIST_DIR/index.html"
generate_index "$YML" "$INDEX_HTML" >/dev/null
say "Generated feed-root index.html → $INDEX_HTML"

echo
echo "Will publish to ${DEVBOX_SSH}:${FEED_ROOT}/${FEED_SUBDIR}/ (single latest, old wiped):"
for f in "${SHIP_FILES[@]}"; do printf '    %s\n' "$(basename "$f")"; done
echo "  + feed-root index.html → ${DEVBOX_SSH}:${FEED_ROOT}/index.html"
echo "  Feed URL after publish: ${FEED_BASE_URL}/${FEED_SUBDIR}/latest-mac.yml"
echo "  Root page:              ${FEED_BASE_URL}/"

# ---- deploy gate ------------------------------------------------------------
if [ "$DEPLOY" != "1" ]; then
  say "DRY RUN — not touching devBox. Re-run with --deploy to publish."
  exit 0
fi

say "Publishing to ${DEVBOX_SSH} …"
# shellcheck disable=SC2086  # FEED_ROOT may contain ~ that must expand remotely
ssh "$DEVBOX_SSH" "mkdir -p ${FEED_ROOT}/${FEED_SUBDIR} && rm -f ${FEED_ROOT}/${FEED_SUBDIR}/*"
scp "${SHIP_FILES[@]}" "${DEVBOX_SSH}:${FEED_ROOT}/${FEED_SUBDIR}/"
scp "$INDEX_HTML" "${DEVBOX_SSH}:${FEED_ROOT}/index.html"

say "Verifying …"
ssh "$DEVBOX_SSH" "ls -la ${FEED_ROOT}/${FEED_SUBDIR}/"
if curl -fsS "${FEED_BASE_URL}/${FEED_SUBDIR}/latest-mac.yml" | grep -q "version: ${VERSION}"; then
  say "OK — feed serves version ${VERSION} at ${FEED_BASE_URL}/${FEED_SUBDIR}/latest-mac.yml"
else
  warn "Could not confirm version ${VERSION} over HTTP from this host (feed may be internal-only)."
fi

cat <<EOF

Next (SEPARATE deploy gate — needs Leader/user confirmation, NOT done here):
  Ensure the web frontend container has DESKTOP_FEED_URL=${FEED_BASE_URL}/${FEED_SUBDIR}/
  and restart it so /download reads this feed. See apps/desktop/INHOUSE-UPDATE.md §5.
EOF
