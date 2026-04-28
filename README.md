# ws-scrcpy-web

<p align="center">
  <img src="assets/banner.png" alt="ws-scrcpy-web" width="600">
</p>

ws-scrcpy-web is a self-hosted, browser-based Android screen-mirroring app (independent project at [bilbospocketses/ws-scrcpy-web](https://github.com/bilbospocketses/ws-scrcpy-web), descended from [NetrisTV/ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy)) that needs no client install beyond a browser. A local Node.js server uses ADB to push Genymobile's vanilla [scrcpy-server](https://github.com/Genymobile/scrcpy) v3.3.4 onto the device and multiplexes its video/audio/control TCP sockets onto a single WebSocket via a 1-byte channel prefix. The browser client is a custom TypeScript protocol layer that demuxes the stream and decodes H.264/H.265/AV1 video and Opus/AAC/FLAC/PCM audio entirely through WebCodecs (no WASM fallbacks).

Input flows back as mouse, UHID keyboard, i16-fixed-point scroll, and a D-pad/Touch mode toggle for leanback TV apps, alongside extras like an ADB shell, file manager, mDNS scan, sleep/wake, and device labels. It ships self-contained (bundled Node + ADB, launcher scripts, in-app updater) and exposes a public `WsScrcpy.startStream()` UMD/ESM library plus an `embed.html` shim for embedding live streams into other apps.

## Key Design Decisions

- **Vanilla scrcpy-server v3.x** -- uses unmodified Genymobile scrcpy-server binaries. No Java patching, no custom forks. Drop in new versions as they release.
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
- **Server logging** -- all server output logged to `ws-scrcpy-web.log` with timestamps, tag prefixes, and 5MB rotation
- Docker support (Dockerfile included)

## Downloads

Get the latest release from the [Releases page](https://github.com/bilbospocketses/ws-scrcpy-web/releases/latest):

- **Windows MSI** (recommended, v0.1.21+) — installs per-machine to `C:\Program Files\WsScrcpyWeb\` with writable runtime state at `C:\ProgramData\WsScrcpyWeb\`. Requires admin (UAC) to install and to apply each subsequent update. Multi-user friendly; service mode and local mode share configuration.
- **Windows installer (`Setup.exe`)** — per-user under `%LOCALAPPDATA%`, no admin required. Service mode is supported but the in-app updater can't operate while running as Local System. Shipped through v0.1.21 as a fallback; **dropped in v0.1.22** in favor of the MSI.
- **Windows portable ZIP** — unzip and run; no install required, no auto-updates. Useful for air-gapped setups.
- **Linux AppImage** — `chmod +x ws-scrcpy-web-<version>.AppImage` and run. See [Linux install](#linux-install-appimage) below.

**Upgrading from v0.1.20 or earlier on Windows:** the install layout changed. See [docs/PROGRAMDATA-MIGRATION.md](docs/PROGRAMDATA-MIGRATION.md) for the uninstall-then-reinstall steps.

Release artifacts are code-signed via [SignPath Foundation](https://signpath.org), which provides free code signing for OSS projects. Each release also ships a `SHA256SUMS` file you can verify against.

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
| **Windows installer** (`Setup.exe`, fallback through v0.1.21) | Per-user installs without UAC on every update | Velopack-managed per-user install to `%LocalAppData%`. Service mode works but in-app updater is degraded. Dropped in v0.1.22. |
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

(The `Setup.exe` and AppImage paths use Velopack's own install layout — `current/` plus a stable launcher stub — and you don't need to think about it.)

### Initial setup

1. Run `start.cmd` (Windows) or `./start.sh` (Linux). The launcher script handles the rest.
2. On first run, the in-app **dependency manager** automatically downloads Node.js, ADB platform-tools, and `scrcpy-server` into `dependencies/`. You'll see a progress banner; it takes a minute or two depending on your connection.
3. Once dependencies are populated, the server starts. Open `http://localhost:8000` in your browser.
4. From the home page's **Dependencies** panel you can re-check or update Node.js, ADB, and `scrcpy-server` later with one click — they're independently swappable without rebuilding the app.

If you prefer to avoid the network fetch on first run (air-gapped setups, slow connections), you can pre-populate `dependencies/` manually:

- **Node.js** — extract a Node.js LTS Windows / Linux build into `dependencies/node/` (the binary should be at `dependencies/node/node.exe` or `dependencies/node/node`).
- **ADB** — extract Android `platform-tools` into `dependencies/adb/`.
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

The launcher scripts (`start.cmd` / `start.sh`) solve a specific problem: on Windows, you cannot replace a running executable. When the in-app updater downloads a new Node.js binary:

1. The server renames the running `node.exe` to `node.exe.old`
2. The server copies the new `node.exe` into place
3. The server writes a `.restart` marker file and exits
4. The launcher detects the marker, cleans up the old binary, and relaunches
5. The browser automatically reconnects when the server comes back

On Linux, file locking is not an issue (running binaries can be overwritten), but the launcher still handles the restart loop for consistency.

### Linux install (AppImage)

Linux releases ship as a single self-contained AppImage built with [Velopack](https://velopack.io/). No package manager, no sudo (for user-scope installs), no system-wide changes.

1. Download `WsScrcpyWeb-linux.AppImage` from the [Releases](https://github.com/bilbospocketses/ws-scrcpy-web/releases) page.
2. Make it executable: `chmod +x WsScrcpyWeb-linux.AppImage`
3. Run it: `./WsScrcpyWeb-linux.AppImage`
4. Open `http://localhost:8000` in your browser.

The first-run welcome modal offers to install ws-scrcpy-web as a systemd service. Two scopes are available:

- **just for me (no sudo)** — installs to `~/.config/systemd/user/ws-scrcpy-web.service`. Starts at login. `loginctl enable-linger` is invoked best-effort so the service survives logout.
- **all users (requires sudo)** — installs to `/etc/systemd/system/ws-scrcpy-web.service`. Starts at boot. Requires the AppImage to be relaunched with `sudo` so the install API can write to `/etc/`.

You can also install/uninstall the service later from Settings → Service.

#### AppImage placement caveat

The systemd unit's `ExecStart=` is set to the absolute AppImage path at install time. **Do not move or rename the AppImage after installing the service** — the service will fail to start on next boot/login. If you need to relocate the AppImage, uninstall the service first, move the file, then re-install.

#### Verifying the AppImage signature

Once SignPath Foundation's OSS approval lands (tracked for v0.1.1), each AppImage release will ship with a detached GPG signature alongside it. Verify with:

```bash
gpg --verify ws-scrcpy-web-<version>.AppImage.sig ws-scrcpy-web-<version>.AppImage
```

The public key for SignPath Foundation's Linux signing policy is published at <https://signpath.org/keys>.

Until SignPath approval lands, the v0.1.0 release ships **unsigned** — the `.sig` file will not exist, and you'll need to verify integrity via the `SHA256SUMS` file in the release instead. The release notes for unsigned releases include a prominent notice. v0.1.1 will be the first signed release.

#### glibc requirement

The bundled `node-pty` native binary is built against glibc. Musl-based distros (Alpine and similar) are not supported in v0.1. Run on glibc-based distros: Ubuntu, Debian, Fedora, Arch, openSUSE, etc. — anything that ships glibc 2.31+ should work.

#### Tray icon

ws-scrcpy-web tries to surface a system tray icon (best-effort) for quick stop/restart. On stock GNOME without the AppIndicator extension, on headless servers, or on minimal Wayland sessions, the tray may not appear — that's expected. Use Settings → Server → Stop Server in the web UI as a fallback.

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

A few advanced switches are only available via environment variables:

| Variable | Purpose |
|----------|---------|
| `DEPS_PATH` | Override the location of the `dependencies/` folder (used by the installer to point at the per-user data dir while the app itself lives under `current/`). |
| `VELOPACK_FEED_URL` | Force the Velopack auto-updater to use a custom feed URL (mostly useful for the local update-flow sandbox test). |
| `ADB_PATH` | Override the path to the ADB executable (rarely needed; the dependency manager handles ADB by default). |

## Logging

The server logs all output to `ws-scrcpy-web.log` in the project root. Every line includes an ISO 8601 timestamp and a module tag (e.g., `[ScrcpyConnection]`, `[Server]`). The log file rotates on startup when it exceeds 5MB, keeping one backup (`.log.1`). Console output is preserved alongside the file -- you still see everything in the terminal.

See `docs/TECHNICAL_GUIDE.md` section 15 for details on the Logger utility and adding logging to new modules.

## Docker

```bash
docker build -t ws-scrcpy-web .
docker run -p 8000:8000 ws-scrcpy-web
```

Note: The container needs ADB access to Android devices. For network ADB (wireless), the devices must be reachable from the container network.

## Acknowledgments

This project is based on [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) by [Sergey Volkov](https://github.com/nicedayzhu) / Netris, JSC. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full license details.

Screen mirroring powered by [scrcpy](https://github.com/Genymobile/scrcpy) by [Genymobile](https://github.com/Genymobile) / [Romain Vimont](https://github.com/rom1v).

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
