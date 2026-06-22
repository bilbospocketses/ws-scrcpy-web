# Privacy Policy

**Effective: 2026-04-27**

## TL;DR

We don't collect anything. The app runs entirely on your machine.

## What stays local

Everything you do with ws-scrcpy-web stays on your computer:

- **ADB connections** to Android devices -- USB or your local network only.
- **scrcpy stream data** (video, audio, touch/keyboard input) -- bounces between the device, the local server, and your browser. Never leaves the LAN.
- **Network device discovery** (mDNS + TCP port-5555 sweep) -- your machine talks to your local network only.
- **Web UI** -- served from `localhost`. No third-party scripts, no analytics, no tracking pixels.
- **UI preferences** -- theme choice (dark/light), per-device video/audio stream settings, file-browser icon size, and saved subnets for network scans -- persist **server-side in the app's local SQLite database** (`wsscrcpy.db`, in your data directory), written by the localhost server. They no longer use browser `localStorage` (which now holds only a one-time migration marker). No cookies.

## What leaves your machine

Three categories of outbound traffic. All are opt-in or operationally necessary, and none of them include your data.

### 1. Update checks (Velopack)

The app polls a Velopack feed for new releases. By default this is:

```
https://github.com/<owner>/ws-scrcpy-web/releases/latest/download/releases.<channel>.json
```

The request reveals your IP address and User-Agent string to GitHub (the file host), nothing else. You can:

- **Disable updates entirely** in Settings → Updates → "automatically download updates" off + skip the manual check button.
- **Switch channels** between stable and beta.
- **Override the feed URL** by setting the `VELOPACK_FEED_URL` environment variable -- useful for air-gapped deployments pointing at a local mirror.

### 2. Dependency installation (first run + retry)

The first-run dependency manager and the in-app updater fetch standalone runtime dependencies on demand. Outbound destinations:

- `https://nodejs.org/dist/` -- Node.js binaries.
- `https://dl.google.com/android/repository/` -- ADB platform-tools.
- `https://github.com/Genymobile/scrcpy/releases/...` -- scrcpy-server binary.
- `https://github.com/<owner>/ws-scrcpy-web/releases/...` -- our own node-pty prebuilts.

These are standard HTTPS GETs. The operators see your IP and User-Agent, like any other HTTP fetch. You can pre-populate `dependencies/` from another machine and the manager will skip the downloads.

### 3. Code-signing verification (currently N/A)

Release artifacts are currently unsigned, so there is no code-signing revocation check on install. If we adopt a code-signing path in the future, this section will document the OS-level verification behavior (Windows SmartScreen / Linux GPG) and which third-party operator your OS may contact during signature verification.

## What we don't do

- **No telemetry.** We don't ping a metrics endpoint on startup, on feature use, or on shutdown.
- **No analytics.** We don't send page views, click events, or session times anywhere.
- **No crash reporting.** We don't ship Sentry, Bugsnag, or anything similar. If we add this in the future, the change will be flagged in `CHANGELOG.md` and this file will be updated.
- **No project-operated server.** There is no ws-scrcpy-web cloud account, no login, no sync. The app is local-only.
- **No cookies.** UI preferences persist server-side in the local SQLite store (see below); the browser keeps only a one-time migration marker in `localStorage`. No cookies of any kind.

## Third-party operators

When traffic does leave your machine, it goes to one of these well-known operators. Their privacy policies cover what they do with the IP/User-Agent metadata they receive:

| Operator | Role | Privacy policy |
|---|---|---|
| GitHub (Microsoft) | Hosts release artifacts, the Velopack feed, and the source repo | https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement |
| Google | Hosts ADB platform-tools | https://policies.google.com/privacy |
| Node.js Foundation | Hosts Node.js binaries | https://nodejs.org/en/about/privacy |
| Velopack | Update SDK (the SDK runs locally; no data goes to Velopack itself) | https://velopack.io |
| Genymobile (scrcpy) | Source of scrcpy-server binary, hosted on GitHub | See GitHub policy above |

## Web UI storage (no cookies)

The browser side of the app uses no cookies. UI preferences — theme, per-device video/stream settings (codec, encoder, fps, bitrate), per-device audio settings, file-browser icon size, and saved network-scan subnets — persist **server-side in the app's local SQLite database** (`wsscrcpy.db`, in your data directory alongside `config.json` and `logs/`), written by the localhost server through its settings API. The database stays on your machine; nothing is transmitted off-device.

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
