# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Internal
- New `src/types/assets.d.ts` declares ambient modules for webpack-loaded side-effect imports (`*.css`, `*.svg`, `*.png`, `*.jpg`, `*.gif`, `*/assets/scrcpy-server`) plus the DefinePlugin build-time constants `__PATHNAME__` and `__WSSCRCPY_VERSION__`. The standalone `tsc` checker and `dts-bundle-generator` can now resolve these imports without error. Drops the TS pre-emit diagnostic count from **78 → 43** (phase 1a of the TS cleanup initiative — clears all TS2307, TS2882, and TS2552 errors)
- Phase 1b one-off fixes (**43 → 35**): inline `[DeviceProbe]` / `[ScrcpyConnection]` tag strings where a missing module-level `const TAG` referenced undefined names; `import type { BasePlayer }` (named) in `ConnectModal.ts` instead of default; `import { WebSocketServer as WSServer }` in `WebSocketServer.ts` (the `ws` package type defs export `Server` as type-only, the value class is `WebSocketServer`); optional chaining on `os.networkInterfaces()` iterator in `Utils.ts` (the dict values are possibly undefined); widened `Omit<Required<ScrcpyOptions>, 'scid' \| 'videoEncoder'>` so the serializer doesn't demand a default for the always-optional `videoEncoder` field; cast-through-unknown in the same file's dict indexer; second `@ts-expect-error` directive in `Mw.ts` for the `WS \| Multiplexer` union's second `addEventListener` call (real fix comes in phase 1e)
- Phase 1c `HostItem` shape drift (**35 → 32**): `BaseDeviceTracker.buildUrl()` was declared to take a full `HostItem` but only reads `secure`/`hostname`/`port`/`pathname`. Three call sites passed narrower object literals (either missing `type` or with a widened `type: 'android' \| 'ios'` from `ParamsDeviceTracker`) and tripped `TS2345`. Narrowed the `buildUrl` parameter to an inline structural type matching exactly what the function consumes — `HostItem` is still accepted (it's a superset), and the narrower call sites now type-check cleanly

### Performance
- Main frontend bundle (`bundle.js`) dropped from **525 KiB → 162 KiB** (-69%) by converting static imports of `ShellModal`, `ListFilesModal`, and `ConnectModal` to dynamic `await import()` at the click-handler call sites in `DeviceTracker.ts` and `ConfigureScrcpy.ts`. xterm.js (the heaviest dep at ~326 KiB) now loads only when the user clicks the `shell` button — home page initial-paint no longer pays for it. `ConnectModal` and `ListFilesModal` split out similarly. Webpack `performance` budget tuned to 400 KiB asset / 500 KiB entrypoint on both frontend and library configs — the 244 KiB default targets content sites, not a tool app with an embedded streaming stack + terminal + file manager. All 5 webpack configs now build with zero warnings.

### Added
- `SECURITY.md` now points to GitHub Security Advisories for private vulnerability reporting
- `CONTRIBUTING.md` with setup, style guide, and PR expectations
- `CHANGELOG.md` following Keep a Changelog format
- `repository`, `author`, `bugs`, `homepage`, and `keywords` fields in `package.json`
- `CommandControlMessage.createGetClipboardCommand(copyKey)` factory with `COPY_KEY_NONE` / `COPY_KEY_COPY` / `COPY_KEY_CUT` constants

### Changed
- Personal filesystem paths scrubbed from historical plan documents in `docs/plans/` and `docs/superpowers/plans/`
- Stream layout in `ws-scrcpy.css` promoted to flex-row (video | toolbar) with CSS grid for canvas-layer stacking — replaces legacy `float: right` + `position: absolute` layout. Redundant `dialog.connect-modal` layout overrides in `modal.css` deleted; modal keeps a targeted canvas-layer cap to fit inside the `95vw × 90vh` frame
- Home page section headings ("Connected Devices", "Available Network Devices", "Dependencies") now render at a consistent `18px / 600` weight. `#devices .tracker-name` was `font-size: larger; font-weight: bolder` and `.dep-header h2` was `1.1rem` — both now inherit / match `.home-section h2`
- `.dep-btn` hover (scan network, check for updates) replaced `opacity: 0.8` with `background-color: var(--device-list-hover-color)` — matches the blue-tint hover used on device card overlay buttons (`.action-button`)
- Device card button padding (`.action-button`, `div.desc-block a`) dropped from `6px 12px` to `0.3rem 0.75rem` so the "connect" / shell / list-files pills match the vertical size of `.dep-btn` (scan network, check for updates) on the same page
- `.home-section` now sets `font-family: monospace` so the "Available Network Devices" and "Dependencies" panels match the monospace styling used by the device list section above them; previously they were rendering in the browser-default (serif) font
- Device card overlay buttons laid out as a 2×2 grid filled column-first: left column `[shell][list files]`, right column `[connect][config stream]`. Buttons are vertically centered and left-aligned in their cells. `.services` swapped from `flex-wrap` to `display: grid; grid-template-columns: 1fr 1fr; grid-auto-flow: column; align-items: center; justify-items: start`; the `.services-break` hack div is gone. `.services-label` spans both columns via `grid-column: 1 / -1; grid-row: 1` so it stays anchored at the top regardless of fill direction
- Services label renamed `opens in overlay` → `opens in modal` (matches the actual UI — these are dialog-based modals, not overlays). Stream-entry button text renamed `configure stream` → `config stream` for brevity
- Device card button typography normalized: `disconnect` and `turn on`/`turn off` were pinned to `font-size: 12px` while every other button on the page uses `var(--font-size)` (14px) — now all bump to 14px. `font-family: monospace` added explicitly to `#devices .device-list button` and `.desc-block a` / `.desc-block .action-button` so `<button>` elements (which don't inherit font-family from their parent in most browsers by default) don't fall back to the UA default sans-serif; catches `config stream` and the `list files` anchor that were rendering in different fonts than the rest of the card
- All `font-family: monospace` call sites now route through a new `--font-mono` CSS variable in `app.css`: `Consolas, 'Segoe UI Mono', 'SF Mono', Menlo, 'Liberation Mono', 'DejaVu Sans Mono', monospace`. The bare `monospace` generic keyword resolves to the browser/OS's configured monospace default, which on Chromium/Windows is often **Courier New** (slab-serif). The new stack explicitly prefers clean sans-serif monospace fonts per-platform and only falls back to the generic keyword as a last resort
- Disconnect / turn on / turn off / scan-connect buttons no longer swap label text on click (`'disconnecting...'`, `'turning on...'`, `'Connecting...'`/`'Connected'`/`'Failed'`/`'Error'`). With the new 14px font the longer transient labels overflowed their fixed-width buttons. Click handlers now only toggle `disabled` state — CSS `:disabled` rules already apply `opacity: 0.5` for visual feedback. Sleep/wake still updates its label after the response resolves (because the label reflects the device's awake state, not the in-flight action)

### Fixed
- Configure Stream dialog no longer lets the user pair a video codec with a mismatched encoder (e.g. `h264` + HEVC encoder), which crashed scrcpy-server on the device when MediaCodec rejected the configuration. Encoder dropdown is now filtered by the selected video codec using the same `.avc.` / `.hevc.` / `.av1.` name patterns that `detectVideoCodecs()` uses; a `change` listener on the codec dropdown re-filters encoders live. When the previous encoder is not valid for the new codec (or none was picked), the dropdown auto-selects the first matching encoder rather than falling back to `''` — Android's MediaCodec typically orders HW encoders first, so this ends up selecting a HW encoder on most devices
- Stream library stylesheet (`ws-scrcpy.css`) now self-contains theme variables so `/embed.html` renders back/home/overview buttons correctly in light mode
- `/embed.html` no longer shows black dead space to the right of the video or below it — stream now fills the viewport via `body[data-embed-entry]` opt-in flex layout. `StreamClientScrcpy.getMaxSize()` now reads `window.innerWidth/Height` directly (not `document.body`), avoiding a zero-sized measurement at mount time when placed inside a `fit-content` modal frame
- Clipboard GET toolbar button sent the wrong control-message size (1 byte instead of 2 — missing the required `copy_key` byte per scrcpy v3.3.4's `ControlMessageReader.parseGetClipboard`). Alternating GET and SET presses silently misaligned the control stream by one byte, causing scrcpy-server to parse garbage and close the session. Now sends `[type=8, copy_key=0]` per protocol
- Portrait-aspect devices (e.g. Pixel 9, 952×2128) no longer render past the bottom of the viewport in `/embed.html`. The canvas was rendering at its intrinsic size because the player's `calculateScreenInfoForBounds` is gated on `resizeVideoToBounds` (false on every subclass — effectively dead code), so CSS alone was responsible for fit-to-viewport. The legacy viewport-based `max-width: calc(100vw - 3.715rem); max-height: 100vh` on `.video-layer` and `.touch-layer` was lost in the layout refactor; restored as the default so canvas scales down to viewport while preserving aspect. Modal's tighter `calc(95vw - …)` / `calc(90vh - …)` still wins via specificity.
- Embed layout: video + toolbar now right-aligned as a pair (matches legacy `float: right` look). Previously the video cell was stretched across the flex row with `flex: 1`, centering the canvas in the middle and leaving the toolbar marooned at the far right — obvious on phone aspects where the centered canvas was narrow. Now `body[data-embed-entry] .device-view` uses `justify-content: flex-end`; the video cell stays content-sized so the toolbar sits flush against the mirror's right edge.

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
