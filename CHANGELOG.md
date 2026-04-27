# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-04-27

### Fixed

- **Setup.exe now installs successfully on clean Windows boxes.** v0.1.0 failed with `VCRUNTIME140.dll was not found` → `application install hook failed` on any machine missing the Visual C++ Redistributable (true of a fresh Win11 install). The Rust launcher and tray binaries now statically link the MSVC C runtime (`-C target-feature=+crt-static`), so they have no runtime DLL dependency on VCRedist. Verified with `dumpbin /dependents`: only Windows-native DLLs remain.
- Internal: `libcDetect.test.ts` mock typing widened from `string` to `fs.PathLike`, and `detectInstallScope` now uses `path.win32.dirname` for execPath splitting on POSIX CI hosts. CI-only fixes; no runtime behavior change.

### Changed

- **Branded app icon** now appears in Explorer, taskbar, Start Menu, Add/Remove Programs, and the Setup.exe installer itself. Previously all three displayed the default Rust toolchain / Velopack generic icon. Setup.exe gets it via `vpk pack --icon`; the launcher and tray binaries embed it via new `build.rs` files using the `winresource` crate.

### Removed

- **Windows MSI artifact withdrawn.** The MSI we shipped in v0.1.0 was Velopack's `--msiDeploymentTool` output — designed for SCCM / Intune mass deployment, not user-clickable (it silently registered as a "Deployment Tool" in Add/Remove Programs without installing the actual app). Setup.exe (per-user, wizardful) and Portable.zip remain the supported Windows install paths. A real user-facing WiX MSI is logged as a future enhancement.

## [0.1.0] - 2026-04-27

First public release.

### Installation

- **Windows installer (`Setup.exe`)** — installs per-user under `%LocalAppData%`, no admin required. Best for most users. Velopack-managed auto-updates from the in-app **Settings** panel or the header **Update Available** button.
- **Windows MSI** — installs system-wide under `Program Files` (requires admin). For corporate / SCCM / Group Policy deployment scenarios. Same auto-update behavior as Setup.exe.
- **Linux AppImage** — single executable; `chmod +x` and run. Velopack-managed auto-updates.
- **Windows portable ZIP** — unzip and run; no install required, no auto-updates. Air-gapped friendly.
- Stable and beta release channels, switchable in Settings without reinstall.
- Manual install path still works: clone the repo, `npm install`, `npm start`.

### Service mode

- Optional Windows service (managed by [Servy](https://github.com/aelassas/servy)) so `ws-scrcpy-web` runs at login or boot. Pick from the first-run welcome modal or Settings → Service.
- Optional Linux systemd unit. User scope (no sudo) writes to `~/.config/systemd/user/`; system scope (requires sudo) writes to `/etc/systemd/system/`. Welcome modal asks per-platform; `loginctl enable-linger` keeps user-scope services alive after logout.
- A small system-tray icon on Windows shows a single confirm-and-exit dialog. (Linux skips the tray entirely; use the web UI Stop Server button.)

### Streaming features

- **Multi-codec video** (H.264, H.265, AV1) and **multi-codec audio** (Opus, AAC, FLAC, raw PCM), all decoded via WebCodecs in the browser. No WASM fallbacks.
- **Audio capture** is SDK-aware with three sources (output / playback / mic), per-device persisted preferences, and graceful gating for older Android. Playback mode keeps device audio audible during capture (Android 13+).
- **D-pad / Touch input modes** with a toolbar toggle for leanback TV apps. UHID keyboard and mouse with hardware-level input via USB HID. Scroll wheel and Shift+scroll forwarding tuned for high-latency streams.
- **Programmatic stream API**: load `ws-scrcpy.umd.js` or `ws-scrcpy.esm.js` and call `WsScrcpy.startStream(container, deviceId, options)` to embed a stream into any DOM element. Bundled TypeScript types. Thin `embed.html?device=<udid>` shim for iframe consumers.

### Device discovery

- **Network scan** combining mDNS (modern devices) with a TCP-port-5555 sweep (older devices that do not advertise). Auto-detects gateway subnet; accepts additional subnets as CIDR, bare IP, or IP range. mDNS and TCP hits dedupe automatically.
- **Quick Scan** button on the home page for fast mDNS-only discovery.
- **Device labels** persist across sessions, keyed by both serial and MAC, so devices keep their names whether they show up via mDNS or TCP.
- **Sleep / wake toggle** on each device card with server-polled state, kept in sync over WebSocket so buttons stay accurate when the device sleeps via timer or remote.

### UI

- New **first-run welcome modal** that shows the chosen port (with auto-shift if 8000 is busy) and the service-install prompt.
- **Settings panel** (gear icon, top-right) for web port, auto-update preferences, channel selection, GitHub owner override, and service install/uninstall. Dev-mode banner when running from source.
- **Dark / light theme toggle** persisted in localStorage.
- File browser with breadcrumbs, sortable columns, drag-and-drop upload, download with progress, bulk delete.
- Remote ADB shell terminal with xterm.js.
- Browser tab title is now static ("Android Power Tools") on every page.

### Self-contained dependencies

- Bundled Node.js, ADB platform-tools, and `scrcpy-server` v3.3.4. The app downloads these on first run if missing, with SHA256 verification.
- Native `node-pty` prebuilds for Windows (x64, arm64) and Linux glibc (x64, arm64), built weekly via GitHub Actions matrix. Falls back to source-compile on unsupported targets.
- **In-app dependency updater** in the Settings panel: check and update Node.js, ADB, and `scrcpy-server` from the home page with one click.

### Privacy and code signing

- New `PRIVACY.md` documenting outbound traffic (update checks, optional dep installs from nodejs.org / dl.google.com / github.com). No telemetry. No analytics. No project-operated server.
- Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review at v0.1.0 release. Once approved, **v0.1.1** will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with the release.

### Notes

- See `docs/RELEASING.md` for the release runbook.
- `docs/TECHNICAL_GUIDE.md` covers architecture and module-level details.

## [1.0.0] - 2026-04-17

First public release. Browser-based Android screen mirroring rebuilt from the ground up on vanilla scrcpy v3.x with a modernized Node.js + TypeScript stack.

### Added

**Stream API + embed mode** (this release's headline)
- Public `WsScrcpy.startStream(container, deviceId, options)` library shipped as UMD (`ws-scrcpy.umd.js`) and ES module (`ws-scrcpy.esm.js`) with bundled TypeScript types (`ws-scrcpy.d.ts`)
- `/embed.html?device=<udid>` thin wrapper for iframe consumers; transparent background, auto-connect, full toolbar
- `StreamHandle` with idempotent `stop()`, `isConnected`, `deviceId`
- `onConnect` / `onDisconnect` / `onError` lifecycle callbacks with typed payloads
- Full URL parameter surface (`host`, `port`, `secure`, `pathname`, `codec`, `encoder`, `bitrate`, `maxFps`, `maxSize`, `audio`, `keyboard`)

**Modal system**
- Native HTML `<dialog>` base class (`Modal`) with glassmorphism styling, `@starting-style` transitions, and `addHeaderButton()` helper
- `ConfigureScrcpy`, `ShellModal`, `ConnectModal`, `ListFilesModal` all extend the base class
- Device labels displayed in modal headers

**File browser** (`ListFilesModal`)
- Sticky header, reserved actions column, SVG hover icons that scale with size picker, sortable columns, breadcrumb navigation, bulk selection, drag-and-drop upload, download with progress, client-side filter

**Input**
- UHID keyboard + mouse via USB HID report descriptors (pointer lock)
- D-pad / Touch input mode toggle (D-pad default for TV apps, fire-then-debounce for scroll wheel)
- Scroll wheel with i16fp encoding (`sc_float_to_i16fp`) and latent-stream-tuned normalization
- Clipboard toolbar buttons (GET device→host, SET host→device) — modernized from legacy MoreBox textarea flow

**Codecs**
- Multi-codec video: H.264, H.265 (HEVC), AV1 with smart auto-selection (H.265 preferred, falls back to H.264 for Firefox)
- Multi-codec audio: Opus, AAC, FLAC, raw PCM via WebCodecs `AudioDecoder` + `AudioWorklet`
- HEVC SPS parser with RBSP stripping, AV1 config record parser
- Edge H.265 rendering fix: 8-arg `drawImage` using full coded rect as source (Edge reports display dims ≠ coded dims)

**Device management**
- Connected-devices card grid with live WebSocket updates
- Network scan via `adb mdns services` with one-click connect
- Device labels persisted to `device-labels.json`, keyed by `ro.serialno`
- Per-card sleep/wake toggle with server-side polling (`dumpsys power`, 5s loop, `Promise.all` concurrency)
- Disconnect button for network-connected devices

**Deployment**
- Self-contained folder layout: `dependencies/node/`, `dependencies/adb/`, `start.cmd` / `start.sh` launcher scripts
- In-app updater for Node.js + node-pty (paired), ADB platform-tools, scrcpy-server
- Windows file-locking workaround: rename running `node.exe`, write `.restart` marker, launcher relaunches
- Dark/light theme toggle with localStorage persistence

**Server**
- Tagged logger (`Logger.for('Tag')`) replaces all raw `console.log`; tees to `ws-scrcpy-web.log` with ISO timestamps, 5MB rotation
- `uncaughtException` + `unhandledRejection` handlers log to file before exit
- Crash-safe WebSocket close (readyState guard, 123-byte reason truncation)
- Vanilla scrcpy-server v3.3.4 binary; no Java patching

**API endpoints**
- `GET /api/dependencies/*` — updater status and operations
- `GET /api/devices/labels` / `PUT /api/devices/labels`
- `POST /api/devices/scan` — mDNS discovery
- `POST /api/devices/connect` / `POST /api/devices/disconnect`
- `POST /api/devices/files/*` — file browser operations including delete

**Quality stats overlay**
- Top-left HUD shows resolution, video codec, encoder name, bitrate, FPS counters; font scales with canvas resolution
- Toolbar bar-chart button toggles stats visibility
- Server echoes encoder in session metadata

**Tests**
- Vitest suite for control messages, binary readers/writers, multiplexer, codec configs, device labels
- 87 tests passing across the final release

### Changed

- Dependencies overhaul: Node 24 LTS, TypeScript 6, Biome 2, webpack 5, node-pty 1.1.0, xterm 6.x
- Runtime dependencies reduced to 2 total: `ws`, `node-pty`
- Control message protocol: `ScrollControlMessage` now 20-byte int16 (not 25-byte int32); `TouchControlMessage` payload corrected to 31 bytes
- Default keyboard: ON at stream start
- Default FPS: 15 (tuned for latent network streams)
- Default encoder: auto-selects hardware HEVC (`c2.mtk.hevc.encoder`, Qualcomm or Exynos equivalents)
- Home page centered at max-width 1800px (5 cards on 4K)
- Toolbar icons centered via SVG sizing; vertical spacing increased

### Removed

- iOS support, Chrome DevTools proxy, WASM decoder fallbacks, vendor decoder shims (~6,500 lines deleted)
- `adbkit`, Express, YAML, ESLint, path-browserify (replaced by own implementations)
- `GoogMoreBox` (383 lines) — clipboard flow replaced by toolbar buttons
- `#!action=stream` URL hash routing
- `?embed=true` URL parameter and all `body.embed` CSS rules
- Patched `scrcpy-server.jar` — project now uses unmodified Genymobile binaries

### Fixed

- Edge WebCodecs H.265 displayWidth/codedWidth mismatch causing blurry or clipped frames
- Firefox `VideoDecoder.isConfigSupported` falsely rejecting `avc1.42E01E` — H.264 now skips the check
- Mouse click freeze after stream-quality refresh (race: old demuxer's async `onclose` fired after `isRefreshing` reset)
- Stale device cards persisting across disconnects (ControlCenter + client-side `updateDescriptor` both now remove disconnected devices)
- Scan Network missed plain `_adb._tcp` services (filter was restricted to `_adb-tls-connect`)
- `RemoteShell` crash from `ws.send()` on closed socket (readyState guard)
- `AdbUtils.ts` and `RemoteShell.ts` cross-platform fixes (hardcoded `'adb'` → `Config.adbPath`, `env.PWD` → `process.cwd()`)

### Security

- WebSocket close reason truncated to 123-byte spec limit with try/catch — offline devices no longer crash the Node process
