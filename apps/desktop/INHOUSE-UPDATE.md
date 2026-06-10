# In-house (devBox) Desktop App — packaging & auto-update

Scope: the internal-network fork build of the Multica desktop app that talks to
the devBox backend (`http://10.37.16.72:18081`). This is **not** the upstream
public release. See HAP-52 / HAP-40.

## 1. Build the in-house app

Base ref: `feat/ccrcode @ 1e2b409cf` (contains GitLab front+back + ccrcode).

```bash
# In an isolated worktree at the base ref:
git worktree add --detach <path> 1e2b409cf
cd <path>

# Inject the devBox-pointing env (NOT tracked in git):
#   apps/desktop/.env.production
#   VITE_API_URL=http://10.37.16.72:18081
#   VITE_WS_URL=ws://10.37.16.72:18081/ws
#   VITE_APP_URL=http://10.37.16.72:3000
#   VITE_APP_NAME=Multica In-house

pnpm install --frozen-lockfile

# Unsigned ad-hoc build, arm64, no notarization, no publish:
cd apps/desktop
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package -- --mac --arm64 --publish never
```

`package.mjs` auto-skips notarization when `APPLE_TEAM_ID` is unset.
`CSC_IDENTITY_AUTO_DISCOVERY=false` forces an ad-hoc signature instead of
requiring a Developer ID cert. `bundle-cli.mjs` compiles `server/cmd/multica`
into the app at build time, so the bundled daemon binary is the GitLab build
(`--type git_repo`).

Artifacts land in `apps/desktop/dist/`:
- `multica-desktop-<version>-mac-arm64.dmg`
- `multica-desktop-<version>-mac-arm64.zip` (required by Squirrel.Mac feeds)
- `latest-mac.yml` (update metadata)
- `*.blockmap`

## 2. Install on the target Mac (unsigned → Gatekeeper)

The build is **not** signed with a Developer ID and **not** notarized, so
Gatekeeper will block the first launch. To allow it:

1. Mount the `.dmg`, drag `Multica.app` to `/Applications`.
2. First launch will be blocked. Either:
   - Right-click the app → **Open** → **Open** in the dialog, or
   - `xattr -dr com.apple.quarantine /Applications/Multica.app` then launch.
3. Verify: settings page shows **GitLab** connection, project resources are
   `git_repo`, and the app reaches the devBox backend.

> Do not overwrite an existing `/Applications/Multica.app` without confirming
> with the user first.

## 3. Auto-update — current status & options

### macOS signing is a hard blocker for *silent* auto-update

Squirrel.Mac (used by electron-updater on macOS) **requires the app to be
code-signed with an Apple Developer ID Application certificate**. An unsigned /
ad-hoc build **cannot** silently self-update on macOS — the downloaded update
fails signature validation and is rejected.

Evidence:
- Electron / electron-builder docs: *"Your application must be signed for
  automatic updates on macOS. This is a requirement of Squirrel.Mac."*
- The build machine currently has only an **"Apple Development"** identity (a
  development cert), **not** a **"Developer ID Application"** cert. Apple
  Development certs cannot be notarized or used for distribution, and do not
  satisfy Squirrel.Mac.

So with the current identity, the in-house macOS app **cannot do true silent
auto-update**, regardless of the feed configuration.

### Feed configuration (done)

`electron-builder.yml` `publish:` is changed from the upstream GitHub feed to a
**generic feed on devBox**:

```yaml
publish:
  provider: generic
  url: http://10.37.16.72:18082/desktop/
  channel: latest
```

This is correct independent of signing: it stops the in-house app from polling
the *upstream* `multica-ai/multica` release feed (which would otherwise try to
replace the devBox build with an unrelated public release).

### Hosting the feed on devBox (port 18082)

Ports 3000 / 18081 (multica) and 8080 / 18080 (verity-log-serv) are in use;
**18082** serves the feed. It is an `nginx:alpine` container
`multica-desktop-feed` (`--restart unless-stopped`) whose web root is the devBox
directory `~/.multica/desktop-feed/`:

```
~/.multica/desktop-feed/
├── index.html              # feed-root landing page (regenerated from the yml)
└── desktop/                # the single latest release lives here
    ├── latest-mac.yml      # electron-updater + web /download both read this
    ├── multica-desktop-<ver>-mac-arm64.dmg
    ├── multica-desktop-<ver>-mac-arm64.zip          # Squirrel.Mac artifact
    ├── multica-desktop-<ver>-mac-arm64.zip.blockmap
    └── multica-desktop-<ver>-mac-arm64.dmg.blockmap
```

- `http://10.37.16.72:18082/` → `index.html` (download landing page).
- `http://10.37.16.72:18082/desktop/latest-mac.yml` → update metadata.

This is **single-latest**: each release wipes `desktop/` and uploads only the
new version. No multi-version retention. Don't put artifacts at the root — they
live under `desktop/` so the feed URL (`.../desktop/`) and the web
`DESKTOP_FEED_URL` agree.

### Channel risk — resolved, no mismatch (HAP-55)

The `latest-arm64` channel pin in `src/main/updater.ts` is a **Windows-only**
concern, not a macOS one. Both the client and the publish side gate it on the
Windows platform:

- `src/main/updater.ts`: `if (process.platform === "win32" && process.arch === "arm64") autoUpdater.channel = "latest-arm64"`.
- `scripts/package.mjs` (`builderArgsForTarget`): `if (target.platform === "win" && target.arch === "arm64") builderArgs.push("-c.publish.channel=latest-arm64")`.

So a **macOS arm64** client never sets `channel = "latest-arm64"`; it uses the
default channel `latest` and requests `latest-mac.yml` — exactly the file the
feed produces. **There is no 404 risk and nothing to change.** (The Windows
arm64 split exists only because electron-builder's Windows metadata file is
`latest.yml`, not arch-suffixed, so x64 and arm64 would otherwise collide on one
GitHub Release — irrelevant to the mac-only in-house feed.)

### Decision required (HAP-52 escalation)

- **Option A — real silent auto-update**: obtain an Apple Developer Program
  membership + **Developer ID Application** certificate, sign (and ideally
  notarize) the in-house build, host the generic feed on devBox. Only this path
  gives macOS users hands-off updates.
- **Option B — manual / scripted update (no new cert)**: keep the unsigned
  build; distribute new `.dmg`/`.zip` via the devBox `/desktop/` path; users
  reinstall manually (drag-to-Applications, re-clear quarantine). The generic
  feed still lets a "check for updates" surface that a newer internal build
  exists, but installation stays manual on macOS.

Recommended default until a Developer ID cert is available: **Option B**.

## 4. Releasing a new version — `scripts/publish-inhouse.sh`

One command takes a fresh build to the feed and keeps a **single latest** (old
artifacts wiped). Run it on the build Mac (it needs `pnpm`, Go, and SSH access
to devBox via the `devBox` alias):

```bash
# Dry run — builds, generates index.html locally, prints what it WOULD push:
bash apps/desktop/scripts/publish-inhouse.sh

# Actually publish to the devBox feed:
bash apps/desktop/scripts/publish-inhouse.sh --deploy
```

What it does, in order:

1. `pnpm --filter @multica/desktop build`, then
   `CSC_IDENTITY_AUTO_DISCOVERY=false node scripts/package.mjs --mac --arm64
   --publish never` — produces `dist/latest-mac.yml` + dmg/zip/blockmaps
   (unsigned ad-hoc; see §3 on why mac stays manual-install).
2. Parses the **version and artifact filenames out of `latest-mac.yml`** — never
   hardcoded — and regenerates the feed-root `index.html` from them.
3. `--deploy` only: `ssh devBox` wipes `~/.multica/desktop-feed/desktop/`, then
   `scp`s the yml + dmg + zip + blockmaps into it and the `index.html` to the
   feed root, then verifies over HTTP.

Without `--deploy` it never touches devBox — the feed push is a **safety gate**.

Useful env overrides: `DEVBOX_SSH`, `FEED_ROOT`, `FEED_SUBDIR`, `FEED_BASE_URL`,
`SKIP_BUILD=1` (reuse an existing `dist/`). The `--publish never` flag means we
ship via `scp`, not electron-builder's uploader — but electron-builder still
emits `latest-mac.yml` into `dist/`, which is the file we ship.

After publishing, verify acceptance:

```bash
curl -s http://10.37.16.72:18082/desktop/latest-mac.yml | head     # version: <new>
curl -s http://10.37.16.72:18082/ | grep -o 'multica-desktop[^"]*' # dmg link is the new version
```

## 5. Web `/download` linkage — **DEPLOY GATE (needs confirmation)**

The web `/download` page (HAP-54) reads the same feed when the **web frontend
container** has `DESKTOP_FEED_URL` set; unset → it keeps the public GitHub
Releases behavior. To point the internal site at the feed:

```
DESKTOP_FEED_URL=http://10.37.16.72:18082/desktop/
```

> ⚠️ **Deploy gate — do NOT run without Leader/user confirmation.** Restarting
> the prod frontend container (or rebuilding the web image) is a production
> action. `publish-inhouse.sh` deliberately does **not** do this.

Two ways to apply it, depending on whether the env var alone is enough:

1. **Env only (no code/image change):** add `DESKTOP_FEED_URL=...` to the web
   container's environment in `~/.multica/server/docker-compose.devbox.full.yml`
   and recreate just that container:
   ```bash
   cd ~/.multica/server
   docker compose -f docker-compose.devbox.full.yml up -d frontend
   ```
   `DESKTOP_FEED_URL` is read at request time by `getDesktopFeedUrl()`
   (`apps/web/features/landing/utils/feed-release.ts`), so a restart with the env
   present is sufficient — no rebuild needed for the env to take effect.

2. **If the web image must be rebuilt** (e.g. it predates HAP-54): devBox cannot
   build the web image (Next.js `next/font/google` can't reach Google Fonts on
   the internal network — see root `CLAUDE.md`). Build on an internet-connected
   host and load it onto devBox:
   ```bash
   # On a networked machine, in the repo:
   docker buildx build --platform linux/amd64 -f Dockerfile.web -t multica-web:src .
   docker save multica-web:src | ssh devBox 'docker load'
   # then on devBox: recreate the frontend container with DESKTOP_FEED_URL set
   ```

Acceptance after this gate clears: `http://10.37.16.72:3000/download` shows the
latest version and its mac arm64 dmg/zip links resolve to
`http://10.37.16.72:18082/desktop/...`.
