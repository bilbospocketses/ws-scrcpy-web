# ws-scrcpy-web

<p align="center">
  <img src="assets/banner.png" alt="ws-scrcpy-web" width="600">
</p>

ws-scrcpy-web is a self-hosted, browser-based Android screen-mirroring app (independent project at [bilbospocketses/ws-scrcpy-web](https://github.com/bilbospocketses/ws-scrcpy-web), descended from [NetrisTV/ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy)) that needs no client install beyond a browser. A local Node.js server uses ADB to push Genymobile's vanilla [scrcpy-server](https://github.com/Genymobile/scrcpy) onto the device and multiplexes its video/audio/control TCP sockets onto a single WebSocket via a 1-byte channel prefix. The browser client is a custom TypeScript protocol layer that demuxes the stream and decodes H.264/H.265/AV1 video and Opus/AAC/FLAC/PCM audio entirely through WebCodecs (no WASM fallbacks).

Input flows back as mouse, UHID keyboard, i16-fixed-point scroll, and a D-pad/Touch mode toggle for leanback TV apps, alongside extras like an ADB shell, file manager, mDNS scan, sleep/wake, and device labels. It ships self-contained (bundled Node + ADB, launcher scripts, in-app updater) and exposes a public `WsScrcpy.startStream()` UMD/ESM library plus an `embed.html` shim for embedding live streams into other apps.

## Key Design Decisions

- **Vanilla scrcpy-server** -- uses unmodified Genymobile scrcpy-server binaries. No Java patching, no custom forks. Drop in new versions as they release; the in-app dependency manager checks for and applies updates.
- **Node.js ADB proxy** -- the server bridges ADB tunnels to WebSocket connections for the browser. The protocol layer is implemented in TypeScript.
- **WebCodecs only** -- no WASM decoder fallbacks. Modern browsers only.
- **Pure browser code** -- no Node.js Buffer polyfill or path-browserify in the browser bundle.
- **Focused feature set** -- screen mirroring, touch/keyboard/UHID control, ADB shell, file management. No iOS support, no Chrome DevTools proxy.

## Features

- Real-time screen mirroring in the browser via WebSocket
- **Multi-codec video** -- H.264, H.265 (HEVC), AV1 with automatic detection and smart encoder selection
- **Multi-codec audio** -- Opus, AAC, FLAC, raw PCM via WebCodecs AudioDecoder
- **UHID keyboard/mouse** -- hardware-level input via USB HID reports (pointer lock for mouse)
- **D-pad / Touch input modes** -- toolbar toggle between D-pad mode (default, for TV apps like Peacock/Netflix) and Touch mode (for touch-aware apps). D-pad mode maps left-click to OK, scroll wheel to up/down, Shift+scroll to left/right
- **Scroll wheel support** -- mouse wheel scrolling on the mirrored device, tuned for latent streams
- Touch and keyboard input forwarding (classic scrcpy keycode mode)
- **Configure stream modal** -- native `<dialog>` overlay with codec/encoder selection, device probe, and advanced settings
- **Redesigned toolbar** -- compact controls with quick stats (FPS, resolution, codec), stream refresh button, and consistent alignment
- **Quality stats overlay** -- real-time FPS, bitrate, resolution, codec, and encoder info
- **Stream modal** -- native `<dialog>` overlay for the full mirroring experience (video, toolbar, audio, UHID input). Home page stays visible behind the backdrop — close the stream and you're right back at the device list
- **Viewport scaling** -- video scales to fill available space with correct aspect ratio
- **Remote ADB shell** -- native `<dialog>` terminal modal with xterm.js, close confirmation for active sessions, Escape/backdrop blocked (terminal needs both)
- **File browser** -- native `<dialog>` modal with breadcrumb navigation, sortable columns (sticky header so size/date stay aligned when scrolling), SVG file type icons (6 types), configurable icon sizes, hover action icons sized to match, reserved actions column so columns never shift on hover, selection with bulk operations, drag-and-drop upload, download with progress, delete with confirmation, client-side filter
- **Programmatic stream API** -- load `ws-scrcpy.umd.js` or `ws-scrcpy.esm.js` and call `WsScrcpy.startStream(container, deviceId, options)` to render a stream into any DOM element. Includes bundled TypeScript types (`ws-scrcpy.d.ts`). Also provides a thin `/embed.html?device=<udid>` wrapper for iframe consumers.
- **Device labels** -- name your devices for easy identification, persisted across sessions in `device-labels.json`, inline edit from device cards or during network scan
- **Network device discovery** -- two-channel scan for ADB devices on the local network: mDNS advertisement for modern devices plus TCP port-5555 sweep for older devices that don't advertise. Configuration dialog auto-detects your gateway subnet and accepts additional subnets (CIDR, bare IP, or IP range); subnets persist across sessions. Streaming progress chip with cancel support; scan skips already-connected devices and dedupes mDNS+TCP hits. Manual-add fallback for single-IP cases.
- **Device disconnect** -- disconnect network devices directly from the device card
- **Sleep/wake toggle** -- turn devices on or off from the device card; state polled server-side and pushed via WebSocket so buttons stay in sync even when the device sleeps on a timer or via the physical remote
- **Dark/light theme** -- toggle between dark (default) and light modes, preference saved to localStorage
- **Responsive layout** -- centered page container scales from mobile to 4K (up to 5 device cards)
- **In-app dependency updater** -- check and update Node.js, ADB, and scrcpy-server from the home page
- **System tray helper** -- shows connection status, quick-open browser, mode-aware text (local vs. service); auto-spawns and auto-recovers via the launcher's supervisor
- **Server logging** -- all server output logged to `ws-scrcpy-web.log` with timestamps, tag prefixes, and 5MB rotation

## Service Mode

ws-scrcpy-web can run as a Windows service (via Servy) or a Linux systemd unit, starting at boot and surviving logouts. Install/uninstall is handled from the browser UI. Service install requires a single UAC prompt; uninstall requires none -- the service-mode Node hands off to a Rust operation-server that serves a "please wait" transition page while `post-stop.bat` runs `servy-cli uninstall` and spawns a fresh user-session launcher. The browser auto-navigates to the new instance when it is ready. No 30-second port sweep, no manual relaunch.

## Embedding

### Embedding: theme bridge

When ws-scrcpy-web is embedded in a cross-origin iframe, the host page can sync
its dark/light theme via `postMessage`. ws-scrcpy-web's listener and handshake
fire automatically on load — no extra wiring needed inside ws-scrcpy-web.

**Protocol** (all message types are namespaced with `ws-scrcpy-web:`):

| Direction | Message type | Payload | When |
|-----------|--------------|---------|------|
| iframe → parent | `theme-ready` | `{theme: 'dark' \| 'light'}` | One-shot on load; re-sent on demand (see below) |
| iframe → parent | `theme-changed` | `{theme: 'dark' \| 'light'}` | When ws-scrcpy-web's in-app theme toggle changes the theme |
| parent → iframe | `theme` | `{theme: 'dark' \| 'light'}` | Host pushes a new theme to the iframe |
| parent → iframe | `theme-request` | `{}` | Host asks the iframe to re-announce `theme-ready` |

**Minimum host integration:**

```javascript
// 1) Reply to the iframe's load handshake with your current theme.
window.addEventListener('message', (e) => {
    if (e.data?.type === 'ws-scrcpy-web:theme-ready') {
        const iframe = document.getElementById('ws-scrcpy-iframe');
        iframe.contentWindow.postMessage(
            { type: 'ws-scrcpy-web:theme', theme: getMyHostTheme() },
            e.origin,
        );
    }
    // 2) Sync your host theme when ws-scrcpy-web's in-app toggle fires.
    if (e.data?.type === 'ws-scrcpy-web:theme-changed') {
        if (e.data.theme === 'dark' || e.data.theme === 'light') {
            setMyHostTheme(e.data.theme);
        }
    }
});

// 3) When the host's theme changes, push it to the iframe.
function pushThemeToIframe(theme) {
    const iframe = document.getElementById('ws-scrcpy-iframe');
    if (!iframe?.contentWindow) return;
    const origin = new URL(iframe.src, location.href).origin;
    iframe.contentWindow.postMessage({ type: 'ws-scrcpy-web:theme', theme }, origin);
}
```

**Race condition note.** The iframe posts `theme-ready` once at module load. If
your host attaches its `message` listener AFTER iframe load (e.g., inside
`iframe.onload`), the one-shot post arrives before you're listening. Three
ways to avoid losing it:

1. **Recommended:** attach the host's `message` listener as early as possible — for JS-created iframes, before adding the element to the DOM or setting `src`; for static HTML iframes, in an inline `<script>` in `<head>` (so it runs before the iframe begins loading).
2. **Or:** post `{type: 'ws-scrcpy-web:theme-request'}` to the iframe once
   you're ready — ws-scrcpy-web replies with a fresh `theme-ready`.
3. **Don't** rely on `iframe.onload` as your listener-attach point; the
   handshake may already have fired by then.

**Programmatic API.** When the bundle loads as a UMD library, the helpers
land on `window.WsScrcpy.*`:

```javascript
WsScrcpy.getTheme();                       // 'dark' | 'light'
WsScrcpy.setTheme('light');                // applies + persists
WsScrcpy.installThemeEmbedListener();      // already called on load
WsScrcpy.notifyThemeReady();               // already called on load
WsScrcpy.notifyThemeChanged();             // called by in-app toggle button
```

ESM consumers can `import` the same names from the package entry.

**Security: `allowedOrigins`.** The default listener accepts theme messages
from any origin (`allowedOrigins: '*'`). This is permissive by design so the
helper is drop-in for any embedder. Locked-down deployments should call

```javascript
WsScrcpy.installThemeEmbedListener({
    allowedOrigins: ['https://your-host.example'],
});
```

themselves and skip the auto-install. Currently the only way to override the auto-install is to fork
`src/app/index.ts` (or shadow it via your bundler) and replace the
`installThemeEmbedListener()` call with your locked-down options. A
dedicated build flag may land in a future minor. Origin validation gates BOTH `theme` push messages AND
`theme-request` pings — non-allowed origins cannot ask the iframe to
re-announce `theme-ready`, preventing leak vectors.

## Downloads

Get the latest release from the [Releases page](https://github.com/bilbospocketses/ws-scrcpy-web/releases/latest):

- **Windows MSI** (recommended) — installs per-machine to `C:\Program Files\WsScrcpyWeb\` with writable runtime state at `C:\ProgramData\WsScrcpyWeb\`. Requires admin (UAC) to install and to apply each subsequent update. Multi-user friendly; service mode and local mode share configuration.
- **Windows portable ZIP** — unzip and run; no install required, no auto-updates. Useful for air-gapped setups.
- **Linux AppImage** — download `WsScrcpyWeb-linux-stable.AppImage` (or `WsScrcpyWeb-linux-beta.AppImage` for the beta channel), `chmod +x` it, and run. See [Linux install](#linux-install-appimage) below.

**Upgrading from v0.1.20 or earlier on Windows:** the install layout changed. See [docs/PROGRAMDATA-MIGRATION.md](docs/PROGRAMDATA-MIGRATION.md) for the uninstall-then-reinstall steps.

**Upgrading from v0.1.21, v0.1.22, or v0.1.23-beta.{1..6}:** the in-app updater on those builds is broken at varying severity (multiple compounding bugs across Velopack PerMachine + ACL + Job Object + auto-apply paths — see CHANGELOG entries v0.1.23-beta.1 through beta.13 for the full diagnosis chain). Clicking "apply update" from those versions either hangs, loops, or silently no-ops. **You must uninstall via Settings → Apps and fresh-install the v0.1.23+ MSI to escape the broken-updater chain.** Once on v0.1.23-beta.7 or newer, the in-app updater is fully functional and subsequent updates apply with a single first-launch UAC prompt.

Release artifacts are currently **unsigned** (no Authenticode / codesign) — code-signing is under evaluation. Each release ships a `SHA256SUMS` file and [Sigstore SLSA Provenance](https://slsa.dev/) attestations for supply-chain verification.

For data-handling details, see our [Privacy Policy](PRIVACY.md).

## Requirements

Required for building from source. See [Self-Contained Deployment](#self-contained-deployment) for standalone installations that bundle everything.

- **Node.js** 24 LTS or later
- **ADB** installed and in PATH
- **Android device** with USB debugging or wireless debugging enabled

## Quick Start (Developer Mode)

For development and building from source:

```bash
npm install
npm start
```

Open `http://localhost:8000` in your browser.

This mode requires Node.js and ADB installed on your system. See [Self-Contained Deployment](#self-contained-deployment) for a standalone installation that bundles everything.

### Optional: `npm run fetch-prebuilts`

Pre-populates the `node-pty` native binary for air-gapped or offline setups.
Normally unnecessary — `npm start` and `npm test` trigger this implicitly
on first run via the resolver and vitest globalSetup respectively.

## Self-Contained Deployment

ws-scrcpy-web ships as a fully self-contained app with no system-wide installations required. There are three deployment paths, all of which keep all dependencies inside the install folder — no PATH changes, no global installs, no admin/root needed.

### Three deployment paths

| Path | Best for | Notes |
|------|----------|-------|
| **Windows MSI** (`*.msi`, recommended) | Most Windows users; multi-user / service-mode setups | Per-machine install to `C:\Program Files\WsScrcpyWeb\`. Writable state at `C:\ProgramData\WsScrcpyWeb\` (Authenticated Users:Modify). Velopack auto-updates apply with one UAC prompt each. |
| **Linux AppImage** | Most Linux users | Single executable. Velopack-managed auto-updates. Optional systemd service mode. |
| **Portable ZIP** (Windows) / source build | Air-gapped or no-install setups | Extract and run; layout shown below. |

### What's in the box (portable / source layout)

```
ws-scrcpy-web/
  dist/                    -- compiled application (server + browser bundles)
    assets/
      scrcpy-server        -- Android-side binary, pushed to devices via ADB
    public/                -- browser UI (HTML, JS, CSS)
    index.js               -- server entry point
  dependencies/            -- populated automatically on first run
    node/                  -- Node.js runtime + node-pty native files
    adb/                   -- ADB platform-tools
  start.cmd                -- Windows launcher
  start.sh                 -- Linux launcher
```

(The MSI and AppImage paths use Velopack's own install layout — `current/` plus a stable launcher stub — and you don't need to think about it.)

**Windows note:** the launcher writes runtime state (config, logs, downloaded deps) to `%PROGRAMDATA%\WsScrcpyWeb\` regardless of where the app itself lives. On Windows, the `dependencies/` folder under the install or repo directory is effectively unused at runtime — the real `dependencies/` is `%PROGRAMDATA%\WsScrcpyWeb\dependencies\`. On Linux, runtime deps still live under the install/repo `dependencies/` for now.

### Initial setup

1. Run `start.cmd` (Windows) or `./start.sh` (Linux). The launcher script handles the rest.
2. On first run, the in-app **dependency manager** automatically downloads Node.js, ADB platform-tools, and `scrcpy-server` into `dependencies/` (Windows: `%PROGRAMDATA%\WsScrcpyWeb\dependencies\`; Linux: alongside the install). You'll see a progress banner; it takes a minute or two depending on your connection.
3. Once dependencies are populated, the server starts. Open `http://localhost:8000` in your browser.
4. From the home page's **Dependencies** panel you can re-check or update Node.js, ADB, and `scrcpy-server` later with one click — they're independently swappable without rebuilding the app.

If you prefer to avoid the network fetch on first run (air-gapped setups, slow connections), you can pre-populate the dependencies folder manually. **On Windows the target is `%PROGRAMDATA%\WsScrcpyWeb\dependencies\`**; on Linux it's the `dependencies/` folder next to `dist/`.

- **Node.js** — extract a Node.js LTS Windows / Linux build into `<deps>/node/` (the binary should be at `<deps>/node/node.exe` or `<deps>/node/node`).
- **ADB** — extract Android `platform-tools` into `<deps>/adb/`.
- **scrcpy-server** — drop the appropriate `scrcpy-server-vX.Y.Z` binary into `dist/assets/`.

The dependency manager skips downloads when it finds an existing valid copy.

### What Updates Automatically (In-App Updater)

The Dependencies panel on the home page lets you check for updates and install them with one click. These runtime dependencies are standalone binaries that can be safely swapped without recompiling the application:

| Dependency | What it does | How it updates |
|------------|-------------|----------------|
| **Node.js + node-pty** | Runs the server; provides ADB shell terminal | Downloads new binary from nodejs.org. Paired update -- both must match. Requires app restart (handled automatically by the launcher script). |
| **ADB (platform-tools)** | Communicates with Android devices | Downloads latest zip from Google, extracts, swaps files. ADB server is stopped and restarted automatically. No app restart needed. |
| **scrcpy-server** | Runs on Android devices to capture screen and audio | Downloads new binary from Genymobile/scrcpy releases. Replaces file in `dist/assets/`. No restart needed -- new binary is pushed to devices on next connection. |

### What Requires a New Release (Build-Time Dependencies)

These dependencies are compiled into the `dist/` output during the build process. They cannot be updated independently -- a new version of ws-scrcpy-web must be built and deployed:

| Dependency | Why it's compiled in | Update approach |
|------------|---------------------|----------------|
| **ws** (WebSocket library) | Bundled into `dist/index.js` by webpack. This is the core communication layer between browser and server -- too critical to hot-swap without testing. A bad ws update could silently break all connections. | Checked before each release (see `docs/TECHNICAL_GUIDE.md` section 12). Updated, tested, and shipped as part of a new ws-scrcpy-web version. |
| **@xterm/xterm** (terminal renderer) | Bundled into `dist/public/bundle.js`. Major versions can change APIs that affect the shell feature. | Updated during release builds. |
| **TypeScript, webpack, Biome, css-loader, etc.** | Build toolchain only -- not shipped to users at all. These compile the source into `dist/` and are never present in a deployment. | Updated by developers before building a new release. |

### How the Launcher Works

Production installs (MSI/AppImage) use a compiled Rust launcher (`ws-scrcpy-web-launcher.exe`) that supervises Node.js and manages the full application lifecycle:

1. **Supervisor loop** -- spawns Node as a child process, monitors its exit code. Exit code 75 or a `.restart` marker triggers a respawn (used by the dependency updater after Node.js updates). Normal exit shuts down cleanly.
2. **Tray supervisor** -- spawns the standalone tray helper and polls every 10 seconds; respawns it automatically if it crashes or is killed by the user.
3. **UAC elevation** -- uses `ShellExecuteExW` with the `runas` verb for privileged operations (service install, update apply). No PowerShell intermediary.
4. **Operation-server** -- during service uninstall or app update, spawns a minimal Rust HTTP server on the same port to serve a "please wait" transition page. The operation-server detects when the new instance is ready and winds down.
5. **Job object** -- all child processes (Node, tray, operation-server) are assigned to a Windows Job Object with `KILL_ON_JOB_CLOSE`, so nothing orphans if the launcher is killed.
6. **Single-instance mutex** -- prevents duplicate launcher instances.

In dev mode, `start.cmd` / `start.sh` provide a simpler restart loop for the same purpose.

### Linux install (AppImage)

Linux releases ship as a single self-contained AppImage built with [Velopack](https://velopack.io/). No package manager, no sudo (for user-scope installs), no system-wide changes.

1. Download `WsScrcpyWeb-linux-stable.AppImage` (stable channel) or `WsScrcpyWeb-linux-beta.AppImage` (beta channel) from the [Releases](https://github.com/bilbospocketses/ws-scrcpy-web/releases) page.
2. Make it executable: `chmod +x WsScrcpyWeb-linux-stable.AppImage`
3. Run it: `./WsScrcpyWeb-linux-stable.AppImage`
4. It opens `http://localhost:8000` in your browser on launch — if it doesn't, open it yourself.

The first-run welcome modal offers to install ws-scrcpy-web as a systemd service. Two scopes are available:

- **just for me (no sudo)** — installs to `~/.config/systemd/user/WsScrcpyWeb.service`. Starts at login. `loginctl enable-linger` is invoked best-effort so the service survives logout.
- **all users (requires sudo)** — installs to `/etc/systemd/system/WsScrcpyWeb.service`. Starts at boot. From the desktop the install triggers a single `pkexec` graphical password prompt and runs the app once as root (`pkexec WsScrcpyWeb.AppImage --install-system-service`) to stage `/opt`, write the unit, and `systemctl enable --now`; the app then switches over to the service on its own. Falls back gracefully if `pkexec` isn't installed: the error tells you to install polkit (`sudo dnf install polkit` on Fedora) or pick user scope. On a headless server, install it directly from a root shell instead: `sudo ./WsScrcpyWeb-linux-*.AppImage --install-system-service` (also `--uninstall-system-service [--keep-state]` and `--system-service-status`).

You can also install/uninstall the service later from Settings → Service.

**Settings → Server (Linux)** has two further actions. **Install for all users** relocates the app to a machine-wide `/opt` install under a single `pkexec` prompt (the control greys out once it's installed system-wide). **Uninstall…** completely removes ws-scrcpy-web — including any installed user- or system-scope service and a machine-wide `/opt` install — in a single pass, with at most one `pkexec` prompt; a **keep my settings & logs** option preserves your `config.json` and logs (so a later reinstall reuses your saved port) while still removing the program and its bundled dependencies.

#### AppImage placement caveat

For a **user-scope** service the systemd unit's `ExecStart=` points at the AppImage where it lived at install time, so **do not move or rename the AppImage after installing a user-scope service** — it will fail to start on next login. If you need to relocate it, uninstall the service first, move the file, then re-install. A **system-scope** service is unaffected: the installer stages a copy of the AppImage to `/opt/ws-scrcpy-web/` (labelled `bin_t` for SELinux) and points `ExecStart=` there, so moving your home AppImage does not break it.

#### Verifying the AppImage signature

AppImage signing is currently under evaluation; releases ship **unsigned** for now. Verify integrity via the `SHA256SUMS` file in the release. When a Linux signing path is wired in, this section will document the verification steps for detached signatures.

#### glibc requirement

The bundled `node-pty` native binary is built against glibc. Musl-based distros (Alpine and similar) are not supported. Run on glibc-based distros: Ubuntu, Debian, Fedora, Arch, openSUSE, etc. — anything that ships glibc 2.31+ should work.

#### libfuse2 — not required

The AppImage needs no host `libfuse2`. Packaging swaps in the static [type-2 AppImage runtime](https://github.com/AppImage/type2-runtime) (libfuse is statically linked), and the in-app updater uses Velopack's bundled type-2 runtime for the update mount — so the app both **launches** and **self-updates** on any glibc-based distro, including fresh Ubuntu 24+, Fedora 40+, and Arch installs that no longer ship libfuse2. Just `chmod +x` and run.

#### Tray icon

ws-scrcpy-web does not currently expose a tray icon on Linux. On Windows the launcher provides a tray for quick stop/restart, but the Linux launcher has no tray surface yet — when one is added it will mirror the Windows behavior. For now use Settings → Server → stop the server and close the app in the web UI to stop the app cleanly.

## Configuration

Almost all configuration is managed through the in-app **Settings** panel (gear icon, top-right of the home page). Settings persist to `config.json` next to the running app:

| Field | Default | Where to change it |
|-------|---------|--------------------|
| `webPort` | `8000` (auto-shifts if busy) | Settings → Server → Web port |
| `installMode` | (set on first run) | Welcome modal / Settings → Service |
| `firstRunComplete` | `false` | Set automatically after first-run modal |
| `autoUpdate` | `true` | Settings → Updates → Automatically download updates |
| `updateCheckIntervalMinutes` | `60` | Settings → Updates → Check interval |
| `channel` | `stable` | Settings → Updates → Channel |
| `githubOwner` | `bilbospocketses` | Settings → Updates → GitHub owner (override for forks) |

Not a stored field, but reached the same way: **Settings → Server → stop the server and close the app** cleanly stops the server and quits the app — the primary clean-exit path on Linux (no tray there), disabled in service mode.

**Update channels are baked into the installation.** Velopack tracks the channel (stable or beta) at the package level — it's part of the installed identity, not just a config preference. Changing the `channel` setting changes which feed the updater *queries*, but the in-app updater cannot cross from one channel to another. A beta installation will not successfully apply a stable update (or vice versa), even if the updater detects and downloads it. **To switch channels, uninstall the current version and fresh-install the desired channel's MSI/AppImage.** This is a Velopack platform constraint, not a ws-scrcpy-web limitation.

A few advanced switches are only available via environment variables:

| Variable | Purpose |
|----------|---------|
| `DEPS_PATH` | Override the location of the `dependencies/` folder (used by the installer to point at the per-user data dir while the app itself lives under `current/`). |
| `VELOPACK_FEED_URL` | Force the Velopack auto-updater to use a custom feed URL (mostly useful for the local update-flow sandbox test). |
| `ADB_PATH` | Override the path to the ADB executable (rarely needed; the dependency manager handles ADB by default). |

### Access control

ws-scrcpy-web has **no login** — anyone who can reach the port can control connected devices, so run it only on a trusted local/LAN network. The server blocks cross-site (CSRF) and DNS-rebinding attacks with a Host allowlist, an Origin check, and a per-launch token cookie; by default it accepts only `localhost` and IP-literal hosts.

To serve it on a domain name behind a TLS-terminating reverse proxy, add the domain(s) to a server-only `allowedHosts` array in `config.json` (read at startup, never exposed via the in-app API), and make sure the proxy forwards the original `Host` header:

```json
{ "allowedHosts": ["devices.example.com"] }
```

See [`SECURITY.md`](SECURITY.md) and `docs/TECHNICAL_GUIDE.md` §24 for the full access-control model.

## Logging

The server logs all output to `ws-scrcpy-web.log`. Every line includes an ISO 8601 timestamp and a module tag (e.g., `[ScrcpyConnection]`, `[Server]`). The log file rotates at 10 MB (per write), keeping one backup (`.log.1`). In dev (`npm start`, no launcher) console output is preserved in the terminal; under the launcher the console echo is suppressed and `ws-scrcpy-web.log` is the single source of truth.

**Log file locations:**

- **Installed (Velopack MSI):** `C:\ProgramData\WsScrcpyWeb\logs\` holds all logs — each rotated at 10 MB (one `.1` backup):
  - `ws-scrcpy-web.log` — **canonical Node-server log** (the `Logger` file)
  - `launcher.log` — **canonical launcher log** (Rust `common::log` file); `tray.log` is the same for the tray helper
  - `server.log` — **thin crash-catcher**: launcher redirects Node child stdout/stderr here, but `Logger` suppresses its own echo under the launcher (`isTTY` gate), so this file only fills on raw crashes / native failures
  - `service.log` — **thin crash-catcher** (service mode only): service manager captures launcher stderr here, but the launcher suppresses normal lines under a service (`is_terminal()` gate), so this file only fills on raw launcher panics
- **Dev / `npm start`:** `ws-scrcpy-web.log` lands at the project root (legacy dev fallback); `server.log` / `service.log` are absent.

See `docs/TECHNICAL_GUIDE.md` section 15 for details on the Logger utility and adding logging to new modules.

## Docker

A legacy `Dockerfile` exists in the repo but is not actively maintained and targets an older Node version. Docker-based deployment is planned but has not shipped yet. For now, use the MSI, AppImage, or portable ZIP.

## Acknowledgments

This project is based on [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) by [Sergey Volkov](https://github.com/nicedayzhu) / Netris, JSC. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full license details.

Screen mirroring powered by [scrcpy](https://github.com/Genymobile/scrcpy) by [Genymobile](https://github.com/Genymobile) / [Romain Vimont](https://github.com/rom1v).

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
