# Stream API + Embed Mode Rewrite — Design Spec

**Date:** 2026-04-17
**Topic:** Expose a public programmatic stream API (`WsScrcpy.startStream`) and replace the current iframe-based CSS-hack embed mode with a thin, library-driven `embed.html` wrapper.
**Status:** Approved (brainstorm complete, spec pending implementation plan)
**Addresses:** TODO item 6 in `project_wsscrcpy_todo.md`

---

## 1. Goals

- Expose `WsScrcpy.startStream(container, deviceId, options)` as the canonical public API for rendering a scrcpy stream into any DOM element.
- Ship the library as both **UMD** (`window.WsScrcpy`) and **ES module** (`import { startStream } from ...`) so consumers can load it via `<script>` tag or via module import.
- Replace the current URL-hash + CSS-hack embed mode (`#!action=stream&udid=...&embed=true` + `body.embed` CSS rules) with a dedicated `embed.html` page that thinly wraps the library.
- Delete the more-box (overflow menu) — YAGNI, unused in real workflows, and the first thing `body.embed` currently hides.
- Dogfood: the home page's own `ConnectModal` consumes the public library — same code path as external consumers.

## 2. Non-Goals

- Publishing the library to npm. Current scope is consumption from `dist/public/` of a running ws-scrcpy-web server (same origin).
- Updating Control Menu's iframe URL. User has confirmed they will fix Control Menu breakage after this lands.
- Cross-origin iframe postMessage protocol. The iframe path (via `embed.html`) remains but is now just a thin URL-param wrapper over the library — there is no parent↔iframe API.
- Publishing a documentation site. The only documentation update is to `docs/TECHNICAL_GUIDE.md`.

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  ws-scrcpy-web server (Node.js — unchanged)                     │
│   · multiplexed WebSocket (scrcpy protocol, shell, filelisting) │
│   · HTTP /api/* endpoints                                       │
└─────────────────────────────────────────────────────────────────┘
                                ▲
                                │ WebSocket + HTTP
                                │
┌───────────────────────────────┴─────────────────────────────────┐
│  Browser (dist/public/)                                         │
│                                                                 │
│  index.html      ← home page (unchanged UX)                     │
│  bundle.js       ← home-page app — ConnectModal calls library   │
│  bundle.css                                                     │
│                                                                 │
│  embed.html      ← NEW: wrapper, reads URL params, calls lib    │
│  embed.js        ← NEW: entry for embed.html                    │
│                                                                 │
│  ws-scrcpy.umd.js ← NEW: library as UMD (window.WsScrcpy)       │
│  ws-scrcpy.esm.js ← NEW: library as ES module                   │
│  ws-scrcpy.css    ← NEW: stream + toolbar styles                │
└─────────────────────────────────────────────────────────────────┘
```

`StreamClientScrcpy` remains the rendering engine. The public API is a thin, typed facade over it. The home page's `ConnectModal` stops reaching into `StreamClientScrcpy.start()` directly and calls `WsScrcpy.startStream()` instead — same code path as external consumers.

## 4. Public API Surface

```ts
// ws-scrcpy.d.ts (generated, shipped alongside bundles)

export function startStream(
    container: HTMLElement,
    deviceId: string,
    options?: StartStreamOptions,
): StreamHandle;

export interface StartStreamOptions {
    // Connection (optional — defaults to current location)
    host?: string;
    port?: number;
    secure?: boolean;
    pathname?: string;

    // Stream settings (optional — smart auto-selection if omitted)
    codec?: 'h264' | 'h265' | 'av1';
    encoder?: string;           // e.g. 'c2.mtk.hevc.encoder'
    bitrate?: number;           // bits per second
    maxFps?: number;
    maxSize?: number;           // pixel bound (longest dimension)

    // Features
    audio?: boolean;            // default true
    keyboard?: boolean;         // default true

    // Lifecycle callbacks
    onConnect?: (info: StreamInfo) => void;
    onDisconnect?: (reason?: string) => void;
    onError?: (err: Error) => void;
}

export interface StreamInfo {
    codec: string;              // actual codec in use (auto-resolved)
    encoder: string;            // actual encoder in use
    resolution: string;         // e.g. "1920x1080"
}

export interface StreamHandle {
    stop(): void;
    readonly isConnected: boolean;
    readonly deviceId: string;
}

export const version: string;   // from package.json via DefinePlugin
```

### 4.1 Behavioral Contract

- Calling `startStream()` renders a stream inside `container`. `container` is cleared of existing DOM on mount.
- Calling `startStream()` twice in the same container without `stop()` first throws `Error('container already has an active stream; call stop() first')`.
- `fitToScreen` is implicit and always on. Video scales to `container` bounds while preserving aspect ratio.
- Smart codec auto-selection runs if `codec`/`encoder` are omitted (existing logic in `StreamClientScrcpy`: H.265 > H.264 > AV1, filtered by device + browser support).
- `stop()` closes the WebSocket, disposes the decoder + worklet, empties the container. `stop()` is idempotent.
- Stream stops automatically on any of: device disconnect, WebSocket close (from any cause), or explicit `stop()`. In all cases `onDisconnect` fires once.
- `onConnect` fires after session metadata is received. `handle.isConnected` flips to `true` at that point and back to `false` when the stream stops. (Note: the codebase has no first-frame-decoded signal today; wiring one would require a new event on `BasePlayer` + emit from `WebCodecsPlayer` decoder output. Deferred. A future `onFirstFrame?: () => void` callback would be a non-breaking extension if ever needed.)
- A missing or non-string `deviceId` is a caller error: `startStream` throws `startStream: deviceId is required` synchronously and returns no handle, so `onError` never fires for it.
- Errors during startup (probe failure, WebSocket refused) fire `onError` and reject the stream. `handle.isConnected` stays `false`. `onDisconnect` does NOT fire in this case — an error that prevented connection is not a disconnect.
- `handle.deviceId` reflects the `deviceId` arg regardless of connection success.

### 4.2 Global Exports

**UMD (`ws-scrcpy.umd.js`):**
- `window.WsScrcpy.startStream`
- `window.WsScrcpy.version`

**ESM (`ws-scrcpy.esm.js`):**
- named export `startStream`
- named export `version`

**TypeScript types (`ws-scrcpy.d.ts`):** generated from source at build time and shipped next to the bundles.

## 5. `embed.html` Wrapper

`embed.html` is a minimal page (~20 lines of HTML, ~60 lines of TS) that reads URL params and calls `WsScrcpy.startStream(document.body, device, options)`.

### 5.1 Page Structure

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>ws-scrcpy-web stream</title>
    <link rel="stylesheet" href="ws-scrcpy.css">
    <style>
        html, body { margin: 0; padding: 0; width: 100%; height: 100%;
                     background: transparent; overflow: hidden; }
        #status { position: fixed; top: 8px; left: 8px; font: 12px monospace;
                  color: #ddd; background: rgba(0,0,0,0.5); padding: 4px 8px;
                  border-radius: 4px; pointer-events: none; z-index: 1000; }
        #status.hidden { display: none; }
    </style>
</head>
<body>
    <div id="status">connecting...</div>
    <script src="ws-scrcpy.umd.js"></script>
    <script src="embed.js"></script>
</body>
</html>
```

### 5.2 URL → Options Mapping

| URL Param | Type   | Default              | Notes                                                      |
|-----------|--------|----------------------|------------------------------------------------------------|
| `device`  | string | **required**         | ADB serial or `ip:port`; missing → error, nothing renders  |
| `host`    | string | `location.hostname`  | Server host                                                |
| `port`    | int    | `location.port`      | Parsed via `parseInt`; NaN falls back to default           |
| `secure`  | bool   | `location.protocol === 'https:'` | `"true"/"false"` string-to-bool                |
| `pathname`| string | `location.pathname`  |                                                            |
| `codec`   | string | auto                 | `"h264"`, `"h265"`, `"av1"` only; others ignored           |
| `encoder` | string | auto                 |                                                            |
| `bitrate` | int    | auto                 |                                                            |
| `maxFps`  | int    | auto                 |                                                            |
| `maxSize` | int    | auto                 |                                                            |
| `audio`   | bool   | `true`               |                                                            |
| `keyboard`| bool   | `true`               |                                                            |

**Forward compatibility:** unknown URL params are silently ignored.

### 5.3 Status Behavior

- Initial: `connecting...`
- On `onConnect`: show `connected · <codec> · <resolution>`, auto-hide after 2 s
- On `onDisconnect`: show `disconnected` (with reason if available), stays visible
- On `onError`: show `error: <message>`, stays visible
- Missing `device` param: show `missing required "device" param`, no stream attempt

### 5.4 Transparent Background

`embed.html` sets `body { background: transparent }` so consumers embedding via iframe can put whatever background they want behind the video. Matches the current `body.embed` behavior we're deleting.

## 6. File Changes

### 6.1 New Files

```
src/app/public/index.ts              Library entry: re-exports startStream + version
src/app/public/startStream.ts        Public API implementation (facade over StreamClientScrcpy)
src/app/public/types.ts              Public TypeScript interfaces
src/app/public/embed-entry.ts        embed.js source — URL param parsing + startStream call
public/embed.html                    Shipped alongside index.html
webpack/ws-scrcpy-web.library.ts     Webpack config for UMD + ESM dual output
docs/superpowers/specs/2026-04-17-stream-api-design.md   This document
```

### 6.2 Modified Files

```
src/app/googDevice/client/StreamClientScrcpy.ts
    The static start() may gain internal helpers for programmatic use,
    but its existing signature stays in place until ConnectModal is
    rewired. During implementation, ConnectModal switches to the public
    library and StreamClientScrcpy.start() becomes internal-only.

src/app/googDevice/client/ConnectModal.ts
    Calls WsScrcpy.startStream(this.bodyEl, udid, options) instead of
    StreamClientScrcpy.start(...).

src/app/index.ts
    Remove #!action=stream hash routing.
    Remove ?embed=true URL param handling.
    Remove document.body.classList.add('embed') on load.

src/style/app.css
    Remove body.embed { ... } rules.
    Stream + toolbar rules move to new ws-scrcpy.css so library consumers
    get them; home-page bundle.css @imports ws-scrcpy.css.

webpack/ws-scrcpy-web.common.ts
    Home-page bundle config (unchanged entry). May need @import restructuring.

webpack/ws-scrcpy-web.prod.ts
    Export an array of two configs: home page + library.

webpack/ws-scrcpy-web.dev.ts
    Same dual-config structure.
```

### 6.3 Deleted Code

Deleted items live inside existing files rather than whole-file deletions:

- **more-box DOM + rendering code** in `StreamClientScrcpy.ts`, `GoogMoreBox.ts` (whole file), related CSS in `app.css`, and any unit tests that depend on it
- **`body.embed` CSS rules** in `src/style/app.css`: `body.embed`, `body.embed .more-box`, `body.embed .device-view`, `body.embed .video`
- **`?embed=true` URL handling** in `src/app/index.ts` (line 19–20)
- **`#!action=stream` URL hash routing** in `src/app/index.ts`
- **click-to-focus hack** in `StreamClientScrcpy.ts` (currently triggered by embed mode)
- **`setBodyClass('stream')` call** when `container` is provided (container scoping replaces body-class scoping)
- **embed-mode `fitToScreen` auto-enable** in `parseParameters` — the public API always runs with container-bound scaling

## 7. Webpack Configuration

Two webpack configs run in parallel for each mode (dev + prod):

### 7.1 Home Page Config (existing, adjusted)

- Entry: `src/app/index.ts`
- Output: `dist/public/bundle.js`, `dist/public/bundle.css`
- Target: browser, IIFE (implicit)
- HTML plugin: copies `public/index.html` to `dist/public/index.html`
- **New:** `bundle.css` includes `@import url('./ws-scrcpy.css')` so home-page modals share stream styling

### 7.2 Library Config (new)

- Entries:
  - `src/app/public/index.ts` → UMD build
  - `src/app/public/index.ts` → ESM build (same source, different output)
  - `src/app/public/embed-entry.ts` → `embed.js` (IIFE, calls library at load time)
- Outputs:
  - `dist/public/ws-scrcpy.umd.js`  (`output.library: { name: 'WsScrcpy', type: 'umd' }`)
  - `dist/public/ws-scrcpy.esm.js`  (`output.library: { type: 'module' }`, `experiments.outputModule: true`)
  - `dist/public/ws-scrcpy.css`
  - `dist/public/embed.js`
  - `dist/public/embed.html` (copied from `public/embed.html`)
- `ws-scrcpy.d.ts` generated via `tsc --emitDeclarationOnly --outDir dist/public` as a post-build step

### 7.3 Build Script

`package.json` scripts remain as-is; `npm run build` now invokes webpack with the array config, producing both bundles in one pass. `npm run build:dev` same pattern.

## 8. Home-Page `ConnectModal` Rewire

Today:
```ts
// ConnectModal.ts (simplified)
const { instance, stop } = StreamClientScrcpy.start(
    params, player, fitToScreen, videoSettings, this.bodyEl, () => this.close(),
);
```

After:
```ts
import { startStream } from '../public';  // or global WsScrcpy if kept lean

this.handle = startStream(this.bodyEl, params.udid, {
    codec: params.codec,
    encoder: params.encoder,
    bitrate: params.bitrate,
    maxFps: params.maxFps,
    maxSize: params.maxSize,
    audio: true,
    keyboard: true,
    onDisconnect: () => this.close(),
    onError: (err) => { console.error(err); this.close(); },
});
```

`onBeforeClose()` calls `this.handle?.stop()`. The public library is the one and only stream-rendering entry point in the codebase.

## 9. Testing

### 9.1 Unit Tests (vitest — existing framework)

- `startStream.test.ts` — options defaults, invalid input errors, container-reuse rejection
- `embed-entry.test.ts` — URL param mapping (strings, ints, booleans, missing required `device`, unknown params ignored)
- All existing tests continue to pass (control messages, multiplexer, binary readers/writers, device labels, etc.)

### 9.2 Integration Tests

None. Streaming involves ADB, WebCodecs, WebSocket timing that vitest cannot fake cleanly. Manual smoke testing covers end-to-end.

### 9.3 Manual Smoke Test Checklist

1. Home page → Configure → Connect opens `ConnectModal` → streams via public library
2. `/embed.html?device=<udid>` in a browser tab → streams with transparent background + toolbar
3. `/embed.html?device=<udid>&codec=h264` → stream forces H.264
4. `/embed.html` with no `device` param → shows error status, no WebSocket attempt
5. `/embed.html?device=<bogus>` → shows `onError` status
6. `handle.stop()` in browser console → tears down cleanly, container empty, no stray WebSocket
7. Device disconnect mid-stream → fires `onDisconnect`, container empties
8. Two `startStream()` calls into separate containers on the same page → both streams independent
9. Control Menu iframe pointed at `/embed.html?device=...` → still works (breakage fixed separately if needed)
10. Toolbar behaviors work in embed: d-pad/touch toggle, refresh, stats, keyboard toggle

### 9.4 Version Stamp

`WsScrcpy.version` exposed via webpack `DefinePlugin` from `package.json` `version` field. Consumers can log / gate features on it.

## 10. Migration and Risk

### 10.1 Breaking Changes

- Direct links to `#!action=stream&udid=...` stop working. **Replacement:** `/embed.html?device=...`
- `?embed=true` URL param is ignored (`body.embed` CSS no longer exists). **Replacement:** use `embed.html`, which always runs in transparent-background mode
- `GoogMoreBox` deleted — no feature removal (more-box contents were all redundant with toolbar buttons already)
- Control Menu's inline-embed iframe URL will need updating (user has accepted this)

### 10.2 Risks

- **Dual webpack config complexity** — two separate compilation graphs increases build time and config surface. Mitigation: keep configs small, share common bits via `common.ts`
- **ESM output requires `experiments.outputModule`** — experimental webpack flag. Mitigation: tested in webpack 5.106 which supports it; fallback to UMD-only if blocked
- **Home page dogfooding** — if the library has a bug, the home-page `ConnectModal` breaks too. Mitigation: that's the point (one code path, one set of bugs to find); tested before merge
- **TypeScript declaration generation** — tsc-only step; must handle path aliases. Mitigation: verify `.d.ts` output during implementation
- **Home-page consumption of the library** — two approaches: (a) home page imports from the library bundle at runtime (`<script>` both), or (b) home page imports the TypeScript source directly and webpack bundles it into `bundle.js`. **Decision: (b).** The home page imports `startStream` from `src/app/public/index.ts` as normal TypeScript. Webpack compiles the source into `bundle.js` directly. The library bundles (UMD, ESM) are built from the same source as separate webpack outputs for external consumers. No runtime coupling between bundles, no bundle-loading dance, single source of truth at the TypeScript level.

### 10.3 Rollback

Commits are small and incremental (per implementation plan). Any single step can be reverted without touching server code.

## 11. Out of Scope / Future Work

- Publishing to npm (requires package-level decisions about versioning, release workflow)
- Cross-origin iframe `postMessage` protocol (if a future consumer needs sandboxed control)
- Device-list / scan / label / updater APIs as public library exports
- Documentation site beyond `TECHNICAL_GUIDE.md`
- Control Menu iframe rewrite (separate project, happens after this ships)
