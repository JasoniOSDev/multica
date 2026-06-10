#!/usr/bin/env bash
# HAP-52 / Phase 2 — empirically test whether a STABLE SELF-SIGNED codesigning
# cert lets Squirrel.Mac (electron-updater) complete "download -> quit ->
# auto-install" on macOS WITHOUT an Apple Developer ID.
#
# Hypothesis (from Leader): Squirrel.Mac validates the NEW app against the OLD
# app's *designated requirement* (DR). If both versions are signed with the
# same stable cert, the DR (certificate leaf = H"<hash>") matches and the
# install is accepted — no Developer ID, no Apple Developer Program needed.
#
# This script is fully automatic EXCEPT one step: macOS requires an
# interactive password approval to trust a self-signed cert for code signing
# (codesign refuses an untrusted identity). You will get ONE SecurityAgent
# dialog at the "add-trusted-cert" step — approve it. Everything else runs
# unattended and prints a PASS/FAIL verdict + ShipIt logs at the end.
#
# Run on the build/target Mac (arm64). Requires the already-built app:
#   apps/desktop/dist/mac-arm64/Multica.app  (from the HAP-52 in-house build)
set -uo pipefail

# ---- config ----------------------------------------------------------------
SRC_APP="${SRC_APP:-/Users/chenjiesheng/projects/multica-hap52-build/apps/desktop/dist/mac-arm64/Multica.app}"
WORK="${WORK:-/tmp/multica-selfsigned-update-test}"
PORT="${PORT:-18083}"            # localhost feed port for the test (not devBox)
OLD_VER="0.3.18"
NEW_VER="0.3.19"
BUNDLE_ID="ai.multica.desktop"
CERT_CN="Multica Inhouse Updater"
KCPW="testpw"
INSTALL_DIR="$HOME/MulticaUpdaterTest"   # writable, non-quarantined → no translocation
# ----------------------------------------------------------------------------

say() { printf '\n=== %s ===\n' "$*"; }
fail() { printf '\n[FATAL] %s\n' "$*" >&2; exit 1; }

[ -d "$SRC_APP" ] || fail "built app not found: $SRC_APP (run the HAP-52 package build first)"
command -v ditto >/dev/null || fail "ditto missing"

rm -rf "$WORK"; mkdir -p "$WORK/feed"; cd "$WORK"
KC="$WORK/test.keychain-db"

say "1. create stable self-signed codesigning cert + temp keychain"
security create-keychain -p "$KCPW" "$KC"
security set-keychain-settings "$KC"
security unlock-keychain -p "$KCPW" "$KC"
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes \
  -subj "/CN=$CERT_CN" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "basicConstraints=critical,CA:false" 2>/dev/null
# OpenSSL 3 default p12 cipher is unreadable by macOS security import → use legacy
openssl pkcs12 -export -legacy -inkey key.pem -in cert.pem -out id.p12 -passout pass:"$KCPW" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -name "$CERT_CN" 2>/dev/null
security import id.p12 -k "$KC" -P "$KCPW" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPW" "$KC" >/dev/null 2>&1
# add temp keychain to search list (remember original to restore on exit)
ORIG_KC=$(security list-keychains -d user | sed 's/[" ]//g')
security list-keychains -d user -s "$KC" $ORIG_KC >/dev/null 2>&1

cleanup() {
  say "cleanup"
  security list-keychains -d user -s $ORIG_KC >/dev/null 2>&1 || true
  security delete-keychain "$KC" 2>/dev/null || true
  security remove-trusted-cert "$WORK/cert.pem" 2>/dev/null || true   # may itself prompt; ok
  [ -n "${HTTP_PID:-}" ] && kill "$HTTP_PID" 2>/dev/null || true
  osascript -e 'tell application "Multica" to quit' 2>/dev/null || true
}
trap cleanup EXIT

say "2. TRUST the cert for code signing  >>> APPROVE THE PASSWORD DIALOG <<<"
security add-trusted-cert -r trustRoot -p codeSign "$WORK/cert.pem" \
  || fail "trust not granted — cannot sign with self-signed cert"
security find-identity -v -p codesigning "$KC" | grep -q "$CERT_CN" \
  || fail "identity still not valid for codesigning after trust"
SIGN=(codesign --keychain "$KC" -s "$CERT_CN" --force)

stage_app() { # $1=destdir $2=version
  local d="$1" v="$2"
  rm -rf "$d"; mkdir -p "$d"
  ditto "$SRC_APP" "$d/Multica.app"
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $v" "$d/Multica.app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $v"            "$d/Multica.app/Contents/Info.plist"
}

say "3. stage OLD ($OLD_VER) + NEW ($NEW_VER), bake feed URL into OLD, then sign both with the SAME cert"
stage_app "$WORK/old" "$OLD_VER"
stage_app "$WORK/new" "$NEW_VER"
# point OLD's updater at our localhost feed BEFORE signing (editing after signing would break the seal)
cat > "$WORK/old/Multica.app/Contents/Resources/app-update.yml" <<YML
provider: generic
url: http://127.0.0.1:$PORT/
channel: latest
updaterCacheDirName: '@multicadesktop-updater'
YML
# sign inside-out (deep) so Framework/Helpers/bundled multica CLI are all sealed under the cert
"${SIGN[@]}" --deep "$WORK/old/Multica.app"
"${SIGN[@]}" --deep "$WORK/new/Multica.app"

say "4. PRE-FLIGHT (the decisive Squirrel.Mac gate): does NEW satisfy OLD's designated requirement?"
OLD_DR=$(codesign -d -r- "$WORK/old/Multica.app" 2>&1 | sed -n 's/^designated => //p')
echo "OLD designated requirement: $OLD_DR"
codesign --verify --strict "$WORK/new/Multica.app" && echo "NEW signature seal: VALID" || echo "NEW signature seal: INVALID"
if codesign --verify -R="$OLD_DR" "$WORK/new/Multica.app" 2>/tmp/dr.err; then
  echo ">>> PRE-FLIGHT PASS: NEW satisfies OLD's DR → Squirrel.Mac should ACCEPT the update"
  PRECHECK=PASS
else
  echo ">>> PRE-FLIGHT FAIL: $(cat /tmp/dr.err)"
  echo ">>> Squirrel.Mac would REJECT → self-signed path does NOT work; only Developer ID (A) does"
  PRECHECK=FAIL
fi

say "5. build feed (zip NEW like electron-builder does) + latest-mac.yml"
cd "$WORK/new"; ditto -c -k --sequesterRsrc --keepParent Multica.app "$WORK/feed/Multica-$NEW_VER-mac.zip"; cd "$WORK"
ZIP="Multica-$NEW_VER-mac.zip"; F="$WORK/feed/$ZIP"
SHA=$(shasum -a 512 "$F" | awk '{print $1}' | xxd -r -p | base64)
SIZE=$(stat -f%z "$F")
cat > "$WORK/feed/latest-mac.yml" <<YML
version: $NEW_VER
files:
  - url: $ZIP
    sha512: $SHA
    size: $SIZE
path: $ZIP
sha512: $SHA
releaseDate: '2026-06-10T00:00:00.000Z'
YML
( cd "$WORK/feed" && python3 -m http.server "$PORT" >/dev/null 2>&1 ) &
HTTP_PID=$!
sleep 1; curl -fsS "http://127.0.0.1:$PORT/latest-mac.yml" >/dev/null && echo "feed up on :$PORT" || fail "feed not serving"

say "6. INSTALL old build to $INSTALL_DIR (writable, de-quarantined → no translocation) and launch"
rm -rf "$INSTALL_DIR"; mkdir -p "$INSTALL_DIR"
ditto "$WORK/old/Multica.app" "$INSTALL_DIR/Multica.app"
xattr -dr com.apple.quarantine "$INSTALL_DIR/Multica.app" 2>/dev/null || true
rm -rf "$HOME/Library/Caches/@multicadesktop-updater" "$HOME/Library/Caches/$BUNDLE_ID.ShipIt" 2>/dev/null || true
open -a "$INSTALL_DIR/Multica.app"
echo "launched v$OLD_VER; waiting 35s for electron-updater autoDownload..."
sleep 35

say "7. quit app → autoInstallOnAppQuit triggers Squirrel.Mac ShipIt swap"
osascript -e 'tell application "Multica" to quit' 2>/dev/null || true
echo "waiting 25s for ShipIt to swap + (electron-updater relaunches the app)..."
sleep 25
osascript -e 'tell application "Multica" to quit' 2>/dev/null || true   # quit the relaunched instance
sleep 3

say "8. VERDICT"
INSTALLED_VER=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INSTALL_DIR/Multica.app/Contents/Info.plist" 2>/dev/null)
echo "pre-flight DR check : $PRECHECK"
echo "installed version now: $INSTALLED_VER  (expected $NEW_VER if auto-install succeeded)"
if [ "$INSTALLED_VER" = "$NEW_VER" ]; then
  echo ">>> RESULT: SUCCESS — self-signed Squirrel.Mac auto-install WORKS (no Developer ID needed). Go B+."
else
  echo ">>> RESULT: NOT UPGRADED — auto-install did not complete. See ShipIt logs below for why."
fi
say "ShipIt logs"
for L in "$HOME/Library/Caches/$BUNDLE_ID.ShipIt/ShipIt_stderr.log" \
         "$HOME/Library/Caches/$BUNDLE_ID.ShipIt/ShipIt_stdout.log"; do
  echo "--- $L ---"; [ -f "$L" ] && tail -40 "$L" || echo "(absent)"
done
echo
echo "(cleanup runs on exit: removes temp keychain, trust cert, feed server, test install)"
