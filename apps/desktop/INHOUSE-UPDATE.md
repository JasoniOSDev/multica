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

### Hosting the feed on devBox (port 18082, free)

Ports 3000 / 18081 (multica) and 8080 / 18080 (verity-log-serv) are in use;
**18082 is free**. Host the artifacts under `/desktop/` on a static server:

```bash
# On devBox, e.g. a tiny static server (systemd unit recommended for persistence):
mkdir -p /srv/multica-desktop/desktop
# copy build outputs into it:
#   multica-desktop-<ver>-mac-arm64.zip
#   multica-desktop-<ver>-mac-arm64.dmg
#   multica-desktop-<ver>-mac-arm64.zip.blockmap
#   latest-mac.yml
# serve /srv/multica-desktop on 10.37.16.72:18082
```

electron-updater will fetch `http://10.37.16.72:18082/desktop/latest-mac.yml`
and the referenced `.zip`.

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
