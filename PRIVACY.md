# Privacy Policy

**Effective: 2026-10-04**

## TL;DR

We don't collect anything. The app runs entirely on your machine.

## What stays local

Everything you do with ws-scrcpy-web stays on your computer:

- **ADB connections** to Android devices -- USB or your local network only.
- **scrcpy stream data** (video, audio, touch/keyboard input) -- bounces between the device, the local server, and your browser. Never leaves the LAN.
- **Network device discovery** (mDNS + TCP port-5555 sweep) -- your machine talks to your local network only.
- **Web UI** -- served from `localhost`. No third-party scripts, no analytics, no tracking pixels.
- **UI preferences** -- theme choice (dark/light), per-device video/audio stream settings, file-browser icon size, and saved subnets for network scans -- persist **server-side in the app's local SQLite database** (`wsscrcpy.db`, in your data directory), written by the localhost server. They no longer use browser `localStorage` (which now holds only a one-time migration marker). No tracking or third-party cookies — see [Web UI storage](#web-ui-storage) for the two first-party cookies the app does set.

## What leaves your machine

Three categories of outbound traffic. All are opt-in or operationally necessary, and none of them include your data.

### 1. Update checks (Velopack)

The app checks GitHub for new releases. `<owner>` is the repository owner set in Settings → Updates (`bilbospocketses` by default), and `<channel>` is `stable` or `beta` on Windows, `linux-stable` or `linux-beta` on Linux. Each check makes these requests, all of them to GitHub:

1. **The release list**, read by the app itself:
   ```
   https://api.github.com/repos/<owner>/ws-scrcpy-web/releases?per_page=100&page=<n>
   ```
   One request per page, to the end of the list (two pages today), sent with `User-Agent: ws-scrcpy-web`. From the second check on, each page is asked for conditionally (`If-None-Match` with the ETag GitHub gave last time). Nothing about you or your install is in these requests.
2. **The update feed** of the release the list pointed to, read by Velopack (the update library), only when your channel has a release:
   ```
   https://github.com/<owner>/ws-scrcpy-web/releases/download/<tag>/releases.<channel>.json?localVersion=<installed version>&id=WsScrcpyWeb&stagingId=<random id>
   ```
   Velopack adds the three query parameters itself (velopack 1.2.161 `sources/http.rs:38-46`): `localVersion` is the version you are running, `id` is the app's package id (the same for every install), and `stagingId` is explained below. The request is sent with `User-Agent: ureq/3.4.2`, the default of the HTTP library inside Velopack, which sets none of its own. GitHub answers with a redirect to its own asset host, `release-assets.githubusercontent.com`.
3. **The update itself**, only when one is downloaded:
   - **Windows:** Velopack downloads the package from the same release folder (`.../releases/download/<tag>/<package>.nupkg`, no query parameters, `User-Agent: ureq/3.4.2`) — ahead of time if automatic updates are on, otherwise when you apply it.
   - **Linux:** when you apply, the app downloads `.../releases/download/v<version>/WsScrcpyWeb-linux-<channel>.AppImage` and that release's `SHA256SUMS`, with the `User-Agent: node` that the app's Node.js runtime sends by default.

**The `stagingId`.** Velopack sends it so that a feed can roll a release out to a fraction of installs at a time. Our feeds are static files on GitHub and do not use it, so it changes nothing about what you are offered. It is a random UUID (version 4) that Velopack generates; it is not derived from your hardware, your account, your IP address or anything else, and the app does not record or send it anywhere else, so nothing links it to you. Velopack keeps it in a file named `.betaId` in its packages folder and reuses it while that file exists (`locator.rs`, `get_or_create_staged_user_id`):

- **Windows:** the packages folder is `<install folder>\packages`, or `%LOCALAPPDATA%\WsScrcpyWeb\packages` when the account running the app cannot write to the install folder. Velopack creates the file on the first check and sends the same id on every later check from that install, until the file is deleted.
- **Linux:** the packages folder is `/var/tmp/velopack/WsScrcpyWeb/packages`. Velopack creates that folder only when it downloads a package itself, which the app never asks it to do on Linux (it fetches the AppImage directly), so the folder normally does not exist, the file cannot be written, and every check sends a newly generated id. If the folder does exist, the id is kept there like on Windows until it is deleted.

Releases up to v0.1.30-beta.166 read the feed through a different Velopack source, which sent none of these three parameters.

What GitHub receives from these requests is your IP address, the User-Agent strings above, and the query parameters in request 2.

**Setting the `VELOPACK_FEED_URL` environment variable changes the destination.** No release list is read, and Velopack reads its feed and downloads the Windows package from the location you set instead (`sources/mod.rs`, `AutoSource`): a local folder involves no network at all; any other `http(s)` server receives request 2 with the same three parameters and request 3 as above; a `github.com` URL goes back to the older GitHub source, which sends no parameters. The Linux download in request 3 is not covered by it: it comes from the owner's GitHub releases unless the `WS_SCRCPY_RELEASE_URL_BASE` environment variable is set, in which case the AppImage and its `SHA256SUMS` are fetched from `<that base>/v<version>/<asset>` instead, and that server receives those two requests (a test / mirror seam; the SHA-256 check still runs). You can:

- **Disable updates entirely** in Settings → Updates → "automatically download updates" off + skip the manual check button.
- **Switch channels** between stable and beta.
- **Override the feed URL** by setting the `VELOPACK_FEED_URL` environment variable -- useful for air-gapped deployments pointing at a local mirror.

### 2. Dependency version checks and installation

The dependency manager checks each standalone runtime dependency for a newer version on every start, and downloads one when it is missing or you update it. Outbound destinations:

- `https://nodejs.org/dist/` -- Node.js binaries, their version index, and each release's `SHASUMS256.txt`
  checksum list with its signature, `SHASUMS256.txt.sig`. Setting the `WS_SCRCPY_NODE_DIST_BASE`
  environment variable moves all of them to `<that base>/index.json` and `<that base>/v<version>/...`, and
  that server receives them instead of nodejs.org (a test / mirror seam).
- `https://dl.google.com/android/repository/` -- ADB platform-tools and their repository listing, which
  also supplies the size and checksum each download is checked against.
- `https://api.github.com/repos/Genymobile/scrcpy/releases/latest` and
  `https://github.com/Genymobile/scrcpy/releases/...` -- the scrcpy-server version lookup, binary, and the
  release's `SHA256SUMS.txt` checksum list with its signature, `SHA256SUMS.txt.asc`.

The signatures are checked against public keys built into the app; no key is fetched from anywhere.
- `https://github.com/<owner>/ws-scrcpy-web/releases/...` -- our own node-pty prebuilts.
- `https://api.github.com/repos/bilbospocketses/mkcert/releases/latest` -- the version lookup for our
  `mkcert` fork. Like the lookups above, it runs on every start of a host install, whether or not Local
  HTTPS is in use. The container image never makes it: Local HTTPS is host-only, so a container does not
  manage `mkcert` at all. Setting the `WS_SCRCPY_SKIP_BOOT_LATEST` environment variable to `1` (a test
  setting) skips these version lookups at start for every dependency that is already installed; a missing
  one is still looked up, and "check for updates" still makes all of them.
- `https://github.com/bilbospocketses/mkcert/releases/download/...`,
  `https://api.github.com/repos/bilbospocketses/mkcert/attestations/...` and
  `https://tuf-repo-cdn.sigstore.dev/` -- installing or updating `mkcert`: the checksum manifest and the
  platform binary, the manifest's build-provenance attestation, and the Sigstore trust root that
  attestation is checked against (cached in `dependencies/.sigstore` and refreshed on each later install or
  update). **Unlike the other
  downloads, these are not fetched on first run.** Nothing is downloaded until you open Settings →
  Server → Local HTTPS and generate a certificate, or update mkcert from Settings → Dependencies, so a
  deployment that never uses that feature never contacts them. The certificate itself is then minted
  entirely on your machine -- the binary runs locally and sends nothing anywhere. Setting the
  `WS_SCRCPY_MKCERT_URL_BASE` environment variable moves the version lookup, both downloads and the
  attestation lookup to `<that base>/releases/latest`, `<that base>/releases/download/...` and
  `<that base>/attestations/...`, and that server receives them instead of GitHub (a test / mirror seam).
  The Sigstore trust root is still fetched from Sigstore, and the attestation must still be signed by the
  fork's own release workflow.

These are standard HTTPS GETs. The operators see your IP and User-Agent, like any other HTTP fetch. You can pre-populate `dependencies/` from another machine and the manager will skip the downloads.

### 3. Code-signing verification (currently N/A)

Release artifacts are currently unsigned, so there is no code-signing revocation check on install. If we adopt a code-signing path in the future, this section will document the OS-level verification behavior (Windows SmartScreen / Linux GPG) and which third-party operator your OS may contact during signature verification.

## What we don't do

- **No telemetry.** We don't ping a metrics endpoint on startup, on feature use, or on shutdown.
- **No analytics.** We don't send page views, click events, or session times anywhere.
- **No crash reporting.** We don't ship Sentry, Bugsnag, or anything similar. If we add this in the future, the change will be flagged in `CHANGELOG.md` and this file will be updated.
- **No project-operated account.** There is no ws-scrcpy-web cloud account and no sync — the app is local-only. It has an optional login for the app's own UI, which authenticates against accounts stored on your machine; no credentials ever leave it.
- **No tracking cookies.** UI preferences persist server-side in the local SQLite store (see below); the browser keeps only a one-time migration marker in `localStorage`. The app does set two first-party, `HttpOnly`, same-site cookies that never leave your machine — see [Web UI storage](#web-ui-storage).

## Third-party operators

When traffic does leave your machine, it goes to one of these well-known operators. Their privacy policies cover what they do with the IP/User-Agent metadata they receive:

| Operator | Role | Privacy policy |
|---|---|---|
| GitHub (Microsoft) | Hosts release artifacts, the Velopack feed, and the source repo; answers the release and attestation lookups (`api.github.com`) | https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement |
| Google | Hosts ADB platform-tools | https://policies.google.com/privacy |
| Node.js Foundation | Hosts Node.js binaries | https://nodejs.org/en/about/privacy |
| Velopack | Update SDK (the SDK runs locally; no data goes to Velopack itself) | https://velopack.io |
| Genymobile (scrcpy) | Source of scrcpy-server binary, hosted on GitHub | See GitHub policy above |
| Sigstore (OpenSSF, Linux Foundation) | Serves the trust root that mkcert's build-provenance attestation is checked against (`tuf-repo-cdn.sigstore.dev`); contacted only when mkcert is installed or updated | https://www.linuxfoundation.org/legal/privacy-policy |

## Web UI storage

The browser side of the app sets **no tracking and no third-party cookies**. It does set two
first-party cookies, both `HttpOnly` and same-site, neither of which ever leaves your machine and
neither of which identifies you to anyone:

- **A per-launch instance token.** Issued to any browser that loads a page, and discarded when the
  server restarts. It exists so a non-browser client cannot drive the API, and so another site
  cannot make your browser act on the app behind your back (CSRF / DNS-rebinding defence). It
  carries no identity — only a random value that is valid for the life of that one server process.
- **A session cookie, only if you enable login.** Present only when the optional login is turned on,
  and tied to an account stored in the local SQLite database on your machine.

Both are described in [SECURITY.md](SECURITY.md). UI preferences — theme, per-device video/stream settings (codec, encoder, fps, bitrate), per-device audio settings, file-browser icon size, and saved network-scan subnets — persist **server-side in the app's local SQLite database** (`wsscrcpy.db`, in your data directory alongside `config.json` and `logs/`), written by the localhost server through its settings API. The database stays on your machine; nothing is transmitted off-device.

Browser `localStorage` now holds only a one-time migration marker (`ws-scrcpy-web:migrated-to-sqlite`, set after any legacy preferences are imported into the database) and, if you turn it on, a verbose-logging debug flag (`ws-scrcpy-web-debug`). No preferences, no identifiers.

No third-party scripts. No fonts loaded from CDNs. No analytics SDKs. The browser bundle ships from your local server only.

## Children's privacy

ws-scrcpy-web is developer/power-user tooling and is not directed at children. We don't collect anything from anyone regardless. (COPPA disclosure flag: no knowing collection of data from users under 13.)

## Changes to this policy

This file is versioned in the repo alongside the rest of the project. If we add network behavior that doesn't match what's described here -- crash reporting, telemetry, an account system, anything -- we will:

1. Add it to `CHANGELOG.md` under "Changed" or "Added".
2. Update this file with the new behavior.
3. Bump the "Effective" date at the top.

Significant changes will also be called out in the release notes for that version.

## Contact

Questions, concerns, or to report a privacy issue: open a [GitHub issue](https://github.com/bilbospocketses/ws-scrcpy-web/issues).
