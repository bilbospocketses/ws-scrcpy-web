# Stream API + Embed Mode Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `WsScrcpy.startStream` as a public UMD + ESM library, add a thin `/embed.html` wrapper consuming it, dogfood from `ConnectModal`, and delete the legacy `?embed=true` / `#!action=stream` paths and the more-box.

**Architecture:** `StreamClientScrcpy` remains the rendering engine. A new `src/app/public/` package is a thin, typed facade over it. The library builds as two webpack bundles from the same source (UMD + ESM). `embed.html` is a ~20-line page that calls the library with URL params. The home page's `ConnectModal` imports the public API so there is a single stream-rendering code path.

**Tech Stack:** TypeScript 6, webpack 5, vitest + jsdom, mini-css-extract-plugin.

**Spec:** `docs/superpowers/specs/2026-04-17-stream-api-design.md`

---

## File Structure

```
src/app/public/
├── index.ts            Library entry — re-exports startStream + version
├── startStream.ts      Public API impl: thin facade over StreamClientScrcpy.start()
├── types.ts            Public TS interfaces (StartStreamOptions, StreamHandle, StreamInfo)
├── embed-entry.ts      embed.js source — URL params → startStream call
└── __tests__/
    ├── startStream.test.ts
    └── embedEntry.test.ts

public/
├── index.html          (existing, unchanged)
└── embed.html          NEW — shipped alongside index.html

webpack/
├── ws-scrcpy-web.common.ts   (modified — adds library() + embed() config factories)
├── ws-scrcpy-web.prod.ts     (modified — exports array including library + embed configs)
└── ws-scrcpy-web.dev.ts      (modified — same)

src/style/
├── app.css             (modified — body.embed + more-box rules deleted)
├── ws-scrcpy.css       NEW — stream + toolbar styles for library consumers
└── morebox.css         DELETED

src/app/
├── index.ts            (modified — hash routing + embed param deleted)
└── googDevice/
    ├── client/
    │   ├── StreamClientScrcpy.ts   (modified — embed handling + moreBox deleted)
    │   └── ConnectModal.ts         (modified — uses public API)
    └── toolbox/
        ├── GoogMoreBox.ts          DELETED
        └── GoogToolBox.ts          (modified — drops moreBox arg)
```

---

### Task 1: Public TypeScript types

**Files:**
- Create: `src/app/public/types.ts`

- [ ] **Step 1: Create the types file**

Create `src/app/public/types.ts`:

```typescript
/**
 * Public types for the WsScrcpy programmatic stream API.
 * Shipped as ws-scrcpy.d.ts alongside the UMD and ESM bundles.
 */

export interface StartStreamOptions {
    // Connection (optional — defaults to current location)
    host?: string;
    port?: number;
    secure?: boolean;
    pathname?: string;

    // Stream settings (optional — smart auto-selection if omitted)
    codec?: 'h264' | 'h265' | 'av1';
    encoder?: string;
    bitrate?: number;
    maxFps?: number;
    maxSize?: number;

    // Features
    audio?: boolean;      // default true
    keyboard?: boolean;   // default true

    // Lifecycle callbacks
    onConnect?: (info: StreamInfo) => void;
    onDisconnect?: (reason?: string) => void;
    onError?: (err: Error) => void;
}

export interface StreamInfo {
    codec: string;
    encoder: string;
    resolution: string;
}

export interface StreamHandle {
    stop(): void;
    readonly isConnected: boolean;
    readonly deviceId: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/public/types.ts
git commit -m "feat: add public types for WsScrcpy stream API"
```

---

### Task 2: `startStream()` implementation with tests

**Files:**
- Create: `src/app/public/startStream.ts`
- Create: `src/app/public/__tests__/startStream.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/app/public/__tests__/startStream.test.ts`:

```typescript
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startStream } from '../startStream';

// Mock StreamClientScrcpy — startStream is a facade over it
vi.mock('../../googDevice/client/StreamClientScrcpy', () => ({
    StreamClientScrcpy: {
        start: vi.fn(() => ({
            instance: { stopStream: vi.fn() },
            stop: vi.fn(),
        })),
    },
}));

describe('startStream', () => {
    let container: HTMLElement;
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });
    afterEach(() => {
        container.remove();
        vi.clearAllMocks();
    });

    it('throws if deviceId is missing', () => {
        expect(() => startStream(container, '')).toThrow(/deviceId/);
    });

    it('throws if container already has an active stream', () => {
        startStream(container, 'abc123');
        expect(() => startStream(container, 'abc123')).toThrow(/active stream/);
    });

    it('returns a handle with deviceId set', () => {
        const handle = startStream(container, 'abc123');
        expect(handle.deviceId).toBe('abc123');
        expect(handle.isConnected).toBe(false);
    });

    it('returns a handle with stop() that is idempotent', () => {
        const handle = startStream(container, 'abc123');
        expect(() => handle.stop()).not.toThrow();
        expect(() => handle.stop()).not.toThrow();
    });

    it('passes options through to StreamClientScrcpy.start', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { codec: 'h265', bitrate: 8000000 });
        expect(StreamClientScrcpy.start).toHaveBeenCalled();
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0];
        const params = args[0];
        expect(params.udid).toBe('abc123');
        expect(params.videoCodec).toBe('h265');
        expect(params.bitrate).toBe(8000000);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx vitest run src/app/public/__tests__/startStream.test.ts
```

Expected: FAIL (module `../startStream` not found).

- [ ] **Step 3: Implement `startStream.ts`**

Create `src/app/public/startStream.ts`:

```typescript
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import type { ParamsStreamScrcpy } from '../../types/ParamsStreamScrcpy';
import { ACTION } from '../../common/Action';
import type { StartStreamOptions, StreamHandle } from './types';

const ACTIVE_STREAM_ATTR = 'data-ws-scrcpy-active';

export function startStream(
    container: HTMLElement,
    deviceId: string,
    options: StartStreamOptions = {},
): StreamHandle {
    if (!deviceId || typeof deviceId !== 'string') {
        throw new Error('startStream: deviceId is required');
    }
    if (container.hasAttribute(ACTIVE_STREAM_ATTR)) {
        throw new Error('startStream: container already has an active stream; call stop() first');
    }
    container.setAttribute(ACTIVE_STREAM_ATTR, '1');

    let isConnected = false;
    let stopFn: (() => void) | undefined;

    const codecMap: Record<string, string> = { h264: 'h264', h265: 'h265', av1: 'av1' };
    const videoCodec = options.codec ? codecMap[options.codec] : undefined;

    const params: ParamsStreamScrcpy = {
        action: ACTION.STREAM_SCRCPY,
        udid: deviceId,
        player: 'webcodecs',
        ws: '',
        hostname: options.host ?? '',
        port: options.port ?? 0,
        secure: options.secure ?? false,
        pathname: options.pathname ?? '',
        useProxy: false,
        videoCodec: videoCodec as ParamsStreamScrcpy['videoCodec'],
        encoderName: options.encoder,
        bitrate: options.bitrate,
        maxFps: options.maxFps,
        fitToScreen: true,
    } as ParamsStreamScrcpy;
    // NOTE: before implementing, open src/types/ParamsStreamScrcpy.d.ts and
    // reconcile fields exactly — remove any here that don't exist on the type,
    // and add any that are required. Do NOT import ParseFlag; that type is not
    // in this codebase.

    try {
        const { instance, stop } = StreamClientScrcpy.start(
            params,
            undefined,
            true,
            undefined,
            container,
            () => {
                isConnected = false;
                options.onDisconnect?.();
            },
        );
        stopFn = () => {
            stop();
            container.removeAttribute(ACTIVE_STREAM_ATTR);
        };
        // Hook onConnect from the instance when metadata arrives
        instance.onMetadataReceived = (info) => {
            isConnected = true;
            options.onConnect?.(info);
        };
        // Hook async errors (WebSocket refused, probe failure, abnormal close)
        instance.onErrorReceived = (err) => {
            options.onError?.(err);
        };
    } catch (err) {
        container.removeAttribute(ACTIVE_STREAM_ATTR);
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
        throw err;
    }

    let stopped = false;
    return {
        stop(): void {
            if (stopped) return;
            stopped = true;
            stopFn?.();
        },
        get isConnected() { return isConnected; },
        get deviceId() { return deviceId; },
    };
}
```

Note: `instance.onMetadataReceived` is a hook to be added to `StreamClientScrcpy` in Task 3. For now leaving the assignment — the mock in tests ignores it.

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run src/app/public/__tests__/startStream.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/public/startStream.ts src/app/public/__tests__/startStream.test.ts
git commit -m "feat: startStream public API facade over StreamClientScrcpy"
```

---

### Task 3: Add `onMetadataReceived` hook to StreamClientScrcpy

**Files:**
- Modify: `src/app/googDevice/client/StreamClientScrcpy.ts`

- [ ] **Step 1: Locate the metadata handler**

Open `src/app/googDevice/client/StreamClientScrcpy.ts`. Find the `onMetadata` handler (search for `onMetadata` — it's the callback passed to `ScrcpyDemuxer`). It parses session metadata (codec, encoder, resolution).

- [ ] **Step 2: Add the public callback fields**

Near the other class fields around line 140, add:

```typescript
/** Public hook — fires after session metadata is parsed. Used by the public startStream API. */
public onMetadataReceived?: (info: { codec: string; encoder: string; resolution: string }) => void;

/** Public hook — fires on async stream errors (WebSocket refused, probe failure, etc.). */
public onErrorReceived?: (err: Error) => void;
```

- [ ] **Step 3: Fire the callback**

Inside the existing `onMetadata` handler (around line 304), right after the existing metadata fields are parsed, add:

```typescript
this.onMetadataReceived?.({
    codec: metadata.videoCodec ?? '',
    encoder: metadata.encoderName ?? '',
    resolution: `${metadata.width ?? 0}x${metadata.height ?? 0}`,
});
```

**Exact property names:** open the handler and use whichever fields the existing code references to display codec/encoder/resolution in the stats overlay (same source of truth). The public API's `onConnect` fires HERE and only here — there is no first-frame-decoded signal in the codebase, and the spec has been relaxed to "on metadata received." Do not attempt to defer `onConnect` until first-frame decoding.

- [ ] **Step 3b: Wire `onErrorReceived` into async failure paths**

The `ScrcpyDemuxer` (or its internal WebSocket) exposes error/close events. Find where `this.demuxer.onDisconnect(...)` is wired (around line 444). Add a similar hook for error — either:

(a) If `ScrcpyDemuxer` has an `onError` method: `this.demuxer.onError((err) => this.onErrorReceived?.(err));`
(b) Otherwise, treat `onDisconnect` with a non-zero / non-normal close code as an error. Update the `onDisconnected` handler to check the close code and route to `onErrorReceived?.(new Error(reason))` for abnormal closures (not 1000, not 1001).

Pick option (a) if available; fall back to (b) only if the demuxer doesn't expose error events. Inspect `src/app/ScrcpyDemuxer.ts` to decide.

Also add: if the initial probe fails (`detectBestCodecAndEncoder` throws around line 426), catch and fire `onErrorReceived` before re-throwing / returning.

- [ ] **Step 4: Run full test suite**

```
npx vitest run
```

Expected: PASS (all existing + 5 new from Task 2).

- [ ] **Step 5: Commit**

```bash
git add src/app/googDevice/client/StreamClientScrcpy.ts
git commit -m "feat: onMetadataReceived hook on StreamClientScrcpy for public API"
```

---

### Task 4: Library entry point + version

**Files:**
- Create: `src/app/public/index.ts`
- Modify: `webpack/ws-scrcpy-web.common.ts`

- [ ] **Step 1: Create the library entry**

Create `src/app/public/index.ts`:

```typescript
/**
 * WsScrcpy public library entry.
 * Exposes startStream + version via both UMD (window.WsScrcpy) and ESM (named exports).
 */

import '../../style/ws-scrcpy.css';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import { WebCodecsPlayer } from '../player/WebCodecsPlayer';

// Register the default player so startStream works standalone
// (the home page also registers it, but a pure library consumer might not)
StreamClientScrcpy.registerPlayer(WebCodecsPlayer);

export { startStream } from './startStream';
export type { StartStreamOptions, StreamInfo, StreamHandle } from './types';

// Injected at build time via webpack DefinePlugin
declare const __WSSCRCPY_VERSION__: string;
export const version: string = __WSSCRCPY_VERSION__;
```

- [ ] **Step 2: Create empty `ws-scrcpy.css` placeholder**

Create `src/style/ws-scrcpy.css` with a single comment line:

```css
/* Stream + toolbar styles (populated in Task 11) */
```

This file is imported by the library entry above; its real contents arrive when we split `app.css`.

- [ ] **Step 3: Add DefinePlugin for version**

In `webpack/ws-scrcpy-web.common.ts`, after the existing `buildConfigDefinePlugin` definition (around line 9-11), add:

```typescript
import { readFileSync } from 'fs';
const pkgVersion: string = JSON.parse(
    readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
).version;

const versionDefinePlugin = new webpack.DefinePlugin({
    '__WSSCRCPY_VERSION__': JSON.stringify(pkgVersion),
});
```

Export it so later tasks can reuse it:

```typescript
export { versionDefinePlugin };
```

- [ ] **Step 4: Commit**

```bash
git add src/app/public/index.ts src/style/ws-scrcpy.css webpack/ws-scrcpy-web.common.ts
git commit -m "feat: public library entry + version define plugin"
```

---

### Task 5: Webpack library config (UMD + ESM)

**Files:**
- Modify: `webpack/ws-scrcpy-web.common.ts`
- Modify: `webpack/ws-scrcpy-web.prod.ts`
- Modify: `webpack/ws-scrcpy-web.dev.ts`

- [ ] **Step 1: Add library config factories**

At the bottom of `webpack/ws-scrcpy-web.common.ts`, append:

```typescript
const libraryCommon = {
    entry: path.join(PROJECT_ROOT, './src/app/public/index.ts'),
    externals: ['fs'],
    plugins: [
        new MiniCssExtractPlugin({ filename: 'ws-scrcpy.css' }),
        versionDefinePlugin,
    ],
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
};

const libraryUmd: webpack.Configuration = {
    ...libraryCommon,
    output: {
        filename: 'ws-scrcpy.umd.js',
        path: CLIENT_DIST_PATH,
        library: { name: 'WsScrcpy', type: 'umd', export: undefined },
        globalObject: 'globalThis',
    },
};

const libraryEsm: webpack.Configuration = {
    ...libraryCommon,
    experiments: { outputModule: true },
    output: {
        filename: 'ws-scrcpy.esm.js',
        path: CLIENT_DIST_PATH,
        library: { type: 'module' },
    },
    // ESM build skips the CSS extractor — UMD build emits the shared ws-scrcpy.css.
    // We must ALSO override the CSS rule to use style-loader, because the inherited
    // module.rules from common() references MiniCssExtractPlugin.loader which throws
    // at compile time without its paired plugin.
    module: {
        rules: [
            { test: /\.css$/i, use: ['style-loader', 'css-loader'] },
            { test: /\.tsx?$/, use: [{ loader: 'ts-loader', options: { transpileOnly: true } }], exclude: /node_modules/ },
            { test: /\.svg$/, type: 'asset/source' },
            { test: /\.(png|jpe?g|gif)$/i, type: 'asset/resource' },
            { test: /[\\/]assets[\\/]scrcpy-server/, type: 'asset/resource', generator: { filename: 'assets/scrcpy-server' } },
        ],
    },
    plugins: [versionDefinePlugin],
};

export const libraryUmdConfig = () => Object.assign({}, common(), libraryUmd);
export const libraryEsmConfig = () => Object.assign({}, common(), libraryEsm);
```

- [ ] **Step 2: Wire into prod config**

Replace `webpack/ws-scrcpy-web.prod.ts` contents with:

```typescript
import { backend, frontend, libraryUmdConfig, libraryEsmConfig } from './ws-scrcpy-web.common';
import webpack from 'webpack';

const prodOpts: webpack.Configuration = {
    mode: 'production',
};

const front = () => Object.assign({}, frontend(), prodOpts);
const back = () => Object.assign({}, backend(), prodOpts);
const libUmd = () => Object.assign({}, libraryUmdConfig(), prodOpts);
const libEsm = () => Object.assign({}, libraryEsmConfig(), prodOpts);

module.exports = [front, back, libUmd, libEsm];
```

- [ ] **Step 3: Wire into dev config**

Read `webpack/ws-scrcpy-web.dev.ts` first, then mirror the prod pattern — add `libUmd` and `libEsm` entries to the exported array, wrapped with whatever dev options it currently applies.

- [ ] **Step 4: Run a build**

```
npm run build
```

Expected: clean build, with new files in `dist/public/`:
- `ws-scrcpy.umd.js`
- `ws-scrcpy.esm.js`
- `ws-scrcpy.css`

Verify:
```
ls dist/public/ws-scrcpy*
```

- [ ] **Step 5: Smoke-test UMD exposes window.WsScrcpy**

```
node dist/index.js
```

In a browser, open http://localhost:8000/, open devtools console, paste:

```js
const s = document.createElement('script');
s.src = '/ws-scrcpy.umd.js';
document.head.appendChild(s);
s.onload = () => console.log(typeof window.WsScrcpy?.startStream, window.WsScrcpy?.version);
```

Expected console output: `function <version-string>`.

- [ ] **Step 6: Commit**

```bash
git add webpack/ws-scrcpy-web.common.ts webpack/ws-scrcpy-web.prod.ts webpack/ws-scrcpy-web.dev.ts
git commit -m "build: webpack config for UMD + ESM library bundles"
```

---

### Task 6: embed-entry URL parsing (with tests)

**Files:**
- Create: `src/app/public/embed-entry.ts`
- Create: `src/app/public/__tests__/embedEntry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/app/public/__tests__/embedEntry.test.ts`:

```typescript
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { parseEmbedParams } from '../embed-entry';

describe('parseEmbedParams', () => {
    const parse = (q: string) => parseEmbedParams(new URLSearchParams(q));

    it('returns null deviceId when missing', () => {
        expect(parse('')).toEqual({ deviceId: null, options: {} });
    });

    it('reads deviceId from "device" param', () => {
        expect(parse('device=abc').deviceId).toBe('abc');
    });

    it('parses string params', () => {
        const { options } = parse('device=x&host=foo&encoder=c2.mtk&pathname=/p');
        expect(options.host).toBe('foo');
        expect(options.encoder).toBe('c2.mtk');
        expect(options.pathname).toBe('/p');
    });

    it('parses integer params and ignores NaN', () => {
        const { options } = parse('device=x&port=8000&bitrate=abc&maxFps=30');
        expect(options.port).toBe(8000);
        expect(options.bitrate).toBeUndefined();
        expect(options.maxFps).toBe(30);
    });

    it('parses boolean params', () => {
        const { options } = parse('device=x&secure=true&audio=false&keyboard=true');
        expect(options.secure).toBe(true);
        expect(options.audio).toBe(false);
        expect(options.keyboard).toBe(true);
    });

    it('accepts only h264/h265/av1 for codec; ignores others', () => {
        expect(parse('device=x&codec=h265').options.codec).toBe('h265');
        expect(parse('device=x&codec=bogus').options.codec).toBeUndefined();
    });

    it('ignores unknown params', () => {
        expect(() => parse('device=x&mystery=42&another=foo')).not.toThrow();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx vitest run src/app/public/__tests__/embedEntry.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement embed-entry**

Create `src/app/public/embed-entry.ts`:

```typescript
/**
 * embed.html entry script. Parses URL params and calls WsScrcpy.startStream.
 * Built as a standalone IIFE bundle and shipped as embed.js.
 */

import { startStream } from './startStream';
import type { StartStreamOptions } from './types';

const CODECS = new Set(['h264', 'h265', 'av1']);

export function parseEmbedParams(params: URLSearchParams): {
    deviceId: string | null;
    options: StartStreamOptions;
} {
    const deviceId = params.get('device');
    const options: StartStreamOptions = {};

    const readStr = (key: keyof StartStreamOptions) => {
        const v = params.get(key as string);
        if (v) (options as Record<string, unknown>)[key] = v;
    };
    const readInt = (key: keyof StartStreamOptions) => {
        const v = params.get(key as string);
        if (!v) return;
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) (options as Record<string, unknown>)[key] = n;
    };
    const readBool = (key: keyof StartStreamOptions) => {
        const v = params.get(key as string);
        if (v === 'true') (options as Record<string, unknown>)[key] = true;
        else if (v === 'false') (options as Record<string, unknown>)[key] = false;
    };

    readStr('host');
    readStr('encoder');
    readStr('pathname');

    const codec = params.get('codec');
    if (codec && CODECS.has(codec)) options.codec = codec as StartStreamOptions['codec'];

    readInt('port');
    readInt('bitrate');
    readInt('maxFps');
    readInt('maxSize');

    readBool('secure');
    readBool('audio');
    readBool('keyboard');

    return { deviceId: deviceId ?? null, options };
}

// Only run the bootstrap when this file is loaded as the embed entry.
// (Not when imported by tests.)
if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.readyState !== 'loading') {
    bootstrap();
} else if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', bootstrap);
}

function bootstrap(): void {
    const statusEl = document.getElementById('status');
    const show = (msg: string, isError = false) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.classList.remove('hidden');
        statusEl.style.color = isError ? '#f06c75' : '#ddd';
    };
    const hide = () => statusEl?.classList.add('hidden');

    const { deviceId, options } = parseEmbedParams(new URLSearchParams(location.search));
    if (!deviceId) {
        show('missing required "device" param', true);
        return;
    }

    options.onConnect = (info) => {
        show(`connected · ${info.codec} · ${info.resolution}`);
        setTimeout(hide, 2000);
    };
    options.onDisconnect = (reason) => show(`disconnected${reason ? ` (${reason})` : ''}`, true);
    options.onError = (err) => show(`error: ${err.message}`, true);

    try {
        startStream(document.body, deviceId, options);
    } catch (err) {
        show(`error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run src/app/public/__tests__/embedEntry.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/public/embed-entry.ts src/app/public/__tests__/embedEntry.test.ts
git commit -m "feat: embed.html entry script — URL param parsing + startStream bootstrap"
```

---

### Task 7: embed.html page + webpack wiring

**Files:**
- Create: `public/embed.html`
- Modify: `webpack/ws-scrcpy-web.common.ts`
- Modify: `webpack/ws-scrcpy-web.prod.ts`
- Modify: `webpack/ws-scrcpy-web.dev.ts`

- [ ] **Step 1: Create embed.html**

Create `public/embed.html`:

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>ws-scrcpy-web stream</title>
    <link rel="stylesheet" href="ws-scrcpy.css">
    <style>
        html, body {
            margin: 0; padding: 0;
            width: 100%; height: 100%;
            background: transparent;
            overflow: hidden;
        }
        #status {
            position: fixed; top: 8px; left: 8px;
            font: 12px monospace;
            color: #ddd;
            background: rgba(0,0,0,0.5);
            padding: 4px 8px;
            border-radius: 4px;
            pointer-events: none;
            z-index: 1000;
        }
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

- [ ] **Step 2: Add embed webpack config factory**

At the bottom of `webpack/ws-scrcpy-web.common.ts`, append:

```typescript
// Copies public/embed.html alongside embed.js
class CopyEmbedHtmlPlugin {
    apply(compiler: webpack.Compiler) {
        compiler.hooks.afterEmit.tapAsync('CopyEmbedHtmlPlugin', (_: webpack.Compilation, callback: () => void) => {
            const fs = require('fs') as typeof import('fs');
            fs.copyFileSync(
                path.resolve(PROJECT_ROOT, 'public/embed.html'),
                path.resolve(CLIENT_DIST_PATH, 'embed.html'),
            );
            callback();
        });
    }
}

const embedConfig: webpack.Configuration = {
    entry: path.join(PROJECT_ROOT, './src/app/public/embed-entry.ts'),
    externals: ['fs'],
    plugins: [
        versionDefinePlugin,
        new CopyEmbedHtmlPlugin(),
    ],
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    output: {
        filename: 'embed.js',
        path: CLIENT_DIST_PATH,
    },
};

export const embedEntryConfig = () => Object.assign({}, common(), embedConfig);
```

- [ ] **Step 3: Add embed config to prod + dev exports**

In `webpack/ws-scrcpy-web.prod.ts`:

```typescript
import { backend, frontend, libraryUmdConfig, libraryEsmConfig, embedEntryConfig } from './ws-scrcpy-web.common';
// ...
const embed = () => Object.assign({}, embedEntryConfig(), prodOpts);
module.exports = [front, back, libUmd, libEsm, embed];
```

Mirror in `webpack/ws-scrcpy-web.dev.ts`.

- [ ] **Step 4: Build**

```
npm run build
```

Expected: `dist/public/embed.html` and `dist/public/embed.js` exist.

Verify:
```
ls dist/public/embed.*
```

- [ ] **Step 5: Smoke-test embed.html**

Start server, then in a browser open:
```
http://localhost:8000/embed.html
```

Expected: status text `missing required "device" param` on a transparent page.

Then:
```
http://localhost:8000/embed.html?device=<your-udid>
```

Expected: stream appears, toolbar visible, status shows briefly then hides.

- [ ] **Step 6: Commit**

```bash
git add public/embed.html webpack/ws-scrcpy-web.common.ts webpack/ws-scrcpy-web.prod.ts webpack/ws-scrcpy-web.dev.ts
git commit -m "feat: embed.html wrapper over WsScrcpy public library"
```

---

### Task 8: Rewire ConnectModal to use the public API

**Files:**
- Modify: `src/app/googDevice/client/ConnectModal.ts`

- [ ] **Step 1: Rewrite ConnectModal**

Replace the contents of `src/app/googDevice/client/ConnectModal.ts` with:

```typescript
import type { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import type BasePlayer from '../../player/BasePlayer';
import type VideoSettings from '../../VideoSettings';
import { Modal } from '../../ui/Modal';
import { startStream } from '../../public/startStream';
import type { StreamHandle } from '../../public/types';

export class ConnectModal extends Modal {
    private handle?: StreamHandle;

    constructor(
        params: ParamsStreamScrcpy,
        _player: BasePlayer,
        _fitToScreen: boolean,
        videoSettings: VideoSettings,
        deviceLabel: string,
    ) {
        super({ title: deviceLabel });
        this.dialog.classList.add('connect-modal');

        const bounds = videoSettings.bounds;
        const maxSize = bounds ? Math.max(bounds.width, bounds.height) : undefined;

        const codec = normalizeCodec(params.videoCodec);

        this.handle = startStream(this.bodyEl, params.udid, {
            host: params.hostname || undefined,
            port: params.port || undefined,
            secure: params.secure || undefined,
            pathname: params.pathname || undefined,
            codec,
            encoder: params.encoderName,
            bitrate: params.bitrate,
            maxFps: params.maxFps,
            maxSize,
            audio: true,
            keyboard: true,
            onDisconnect: () => this.close(),
            onError: (err) => {
                console.error('[ConnectModal]', err);
                this.close();
            },
        });
    }

    protected buildBody(_container: HTMLElement): void {
        // Empty — startStream populates the container after super() completes
    }

    protected onEscapeKey(_event: Event): void {
        // Block — UHID keyboard capture needs Escape
    }

    protected onBackdropClick(_event: MouseEvent): void {
        // Block — protect stream from accidental close
    }

    protected onBeforeClose(): void {
        this.handle?.stop();
        this.handle = undefined;
    }
}

function normalizeCodec(codec: string | undefined): 'h264' | 'h265' | 'av1' | undefined {
    if (codec === 'h264' || codec === 'h265' || codec === 'av1') return codec;
    return undefined;
}
```

- [ ] **Step 2: Run full test suite**

```
npx vitest run
```

Expected: PASS.

- [ ] **Step 3: Smoke-test ConnectModal**

Build + start:
```
npm run build
node dist/index.js
```

Open http://localhost:8000/, click configure → connect on a device. Verify the stream appears in the ConnectModal exactly as before. Close the modal — stream tears down, no leftover elements in the DOM.

- [ ] **Step 4: Commit**

```bash
git add src/app/googDevice/client/ConnectModal.ts
git commit -m "refactor: ConnectModal consumes WsScrcpy public startStream API"
```

---

### Task 9: Delete `#!action=stream` hash routing and `?embed=true` handling

**Files:**
- Modify: `src/app/index.ts`

- [ ] **Step 1: Remove the stream and embed branches**

Replace `src/app/index.ts` contents with:

```typescript
import '../style/app.css';
import '../style/home.css';
import '../style/dependencies.css';
import { HostTracker } from './client/HostTracker';
import { DependencyPanel } from './client/DependencyPanel';
import { NetworkDiscoveryPanel } from './client/NetworkDiscoveryPanel';
import { initTheme, createThemeToggle } from './client/ThemeToggle';
import type { Tool } from './client/Tool';
import { StreamClientScrcpy } from './googDevice/client/StreamClientScrcpy';

// Initialize theme immediately to prevent flash of wrong colors
initTheme();

window.onload = async (): Promise<void> => {
    const hash = location.hash.replace(/^#!/, '');
    const parsedQuery = new URLSearchParams(hash);
    const action = parsedQuery.get('action');

    // WebCodecs player must be registered so ConnectModal can find it
    const { WebCodecsPlayer } = await import('./player/WebCodecsPlayer');
    StreamClientScrcpy.registerPlayer(WebCodecsPlayer);

    const tools: Tool[] = [];

    const { ShellClient } = await import('./googDevice/client/ShellClient');
    if (action === ShellClient.ACTION && typeof parsedQuery.get('udid') === 'string') {
        ShellClient.start(ShellClient.parseParameters(parsedQuery));
        return;
    }
    tools.push(ShellClient);

    const { FileListingClient } = await import('./googDevice/client/FileListingClient');
    if (action === FileListingClient.ACTION) {
        FileListingClient.start(FileListingClient.parseParameters(parsedQuery));
        return;
    }
    tools.push(FileListingClient);

    if (tools.length) {
        const { DeviceTracker } = await import('./googDevice/client/DeviceTracker');
        tools.forEach((tool) => {
            DeviceTracker.registerTool(tool);
        });
    }

    document.body.appendChild(createThemeToggle());

    const pageContainer = document.createElement('div');
    pageContainer.className = 'page-container';
    document.body.appendChild(pageContainer);

    const devicesDiv = document.createElement('div');
    devicesDiv.id = 'devices';
    devicesDiv.className = 'table-wrapper';
    pageContainer.appendChild(devicesDiv);

    const discoveryPanel = new NetworkDiscoveryPanel();
    pageContainer.appendChild(discoveryPanel.getElement());

    DependencyPanel.create().then((depPanel) => {
        pageContainer.appendChild(depPanel.getElement());
    });

    HostTracker.start();
};
```

What was removed: the `embed=true` body-class toggle (lines 19-21 of old file) and the `action === StreamClientScrcpy.ACTION` branch (lines 26-29).

- [ ] **Step 2: Smoke-test**

Build + run. Home page loads normally. Old bookmark URL `http://localhost:8000/#!action=stream&udid=...` now loads the home page (stream flow deprecated — replaced by `/embed.html`).

- [ ] **Step 3: Commit**

```bash
git add src/app/index.ts
git commit -m "refactor: remove #!action=stream hash routing and ?embed=true param"
```

---

### Task 10: Remove embed handling inside StreamClientScrcpy

**Files:**
- Modify: `src/app/googDevice/client/StreamClientScrcpy.ts`

- [ ] **Step 1: Remove embed flag from parseParameters**

In `StreamClientScrcpy.ts`, find `parseParameters` (around line 211-226). Remove these lines:

```typescript
const embed = params.get('embed') === 'true';
```

and change the `return` statement so the `...(embed ? { fitToScreen: true } : {})` spread is dropped:

```typescript
return {
    ...typedParams,
    action,
    player: Util.parseString(params, 'player', true),
    udid: Util.parseString(params, 'udid', true),
    ws: Util.parseString(params, 'ws') || '',
};
```

- [ ] **Step 2: Remove click-to-focus hack**

Find the block around line 449-452:

```typescript
// In embed mode, also add click-to-focus
if (document.body.classList.contains('embed')) {
    video.addEventListener('click', () => video.focus(), { once: true });
}
```

Delete it entirely.

- [ ] **Step 3: Remove `setBodyClass('stream')`**

Find the constructor (around line 195-209). Remove the `if (!container) { this.setBodyClass('stream'); }` block. The library always runs container-scoped; there is no full-page stream mode anymore.

(Order note: this step is only safe because Task 9 already deleted the only caller of `StreamClientScrcpy.start()` with `URLSearchParams` — the hash-routed full-page stream path. If you are executing tasks out of order, confirm Task 9 is already committed before this step.)

- [ ] **Step 3b: Clean up per-stream listeners in `stopStream()`**

Find `stopStream` (around line 457). The `stop` closure (line 373-385) already removes `deviceView` and `moreBox` (moreBox removal will go away with Task 12), closes the demuxer, stops the audio player, and stops the video player. It does NOT clean up:

1. `KeyInputHandler` keyboard listeners (registered via `this.setHandleKeyboardEvents(true)` at line 447)
2. Autoplay `click`/`keydown` listeners on `document` (registered at lines 421-422 with `{ once: true }` but may survive if user never clicked before stop())

Add to the `stop` closure body, before the demuxer close:

```typescript
this.setHandleKeyboardEvents(false);
document.removeEventListener('click', resumeAudio);
document.removeEventListener('keydown', resumeAudio);
```

(`resumeAudio` is defined in enclosing scope at line 416.)

This prevents listener-stacking across consecutive `startStream()` calls on the same page.

- [ ] **Step 4: Run full test suite**

```
npx vitest run
```

Expected: PASS.

- [ ] **Step 5: Smoke-test**

Build + run. ConnectModal still works. `/embed.html?device=...` still works.

- [ ] **Step 6: Commit**

```bash
git add src/app/googDevice/client/StreamClientScrcpy.ts
git commit -m "refactor: drop embed-mode body-class, click-to-focus, setBodyClass('stream')"
```

---

### Task 11: Move stream + toolbar CSS to ws-scrcpy.css; delete body.embed rules

**Files:**
- Modify: `src/style/app.css`
- Modify: `src/style/ws-scrcpy.css`

- [ ] **Step 1: Delete body.embed block from app.css**

In `src/style/app.css`, find the block starting at line 190 (`/* Embed mode — minimal UI for iframe embedding */`) and spanning through the `body.embed .video { ... }` rule at line 212. Delete the entire block (lines 190-213).

- [ ] **Step 2: Identify stream + toolbar CSS to move (strict allowlist)**

Move ONLY rules whose outermost selector starts with one of these prefixes:
- `.device-view`
- `.video`
- `.control-wrapper` (and any `.control-wrapper > ...` descendant selectors)
- `.goog-*` (any class prefixed `goog-`)

If a rule's primary selector is anything else (`.page-container`, `.device-list`, `.dep-*`, `.scan-*`, `body` without a stream descendant, etc.), LEAVE IT in `app.css`. When unsure, DO NOT move it — it's safer to leave a stream-related rule in `app.css` than to orphan a home-page rule from its layout context.

- [ ] **Step 3: Populate ws-scrcpy.css**

Copy the identified rules into `src/style/ws-scrcpy.css`, replacing the placeholder comment. Then delete those same rules from `app.css`.

- [ ] **Step 4: Home-page bundle: import ws-scrcpy.css**

Open `src/style/app.css` and add at the top:

```css
@import url('./ws-scrcpy.css');
```

This gives the home page (ConnectModal) the stream styling without duplicating rules.

- [ ] **Step 5: Build and verify both bundles have the styles**

```
npm run build
grep -l 'device-view' dist/public/bundle.css dist/public/ws-scrcpy.css
```

Expected: both files contain `.device-view` rules.

- [ ] **Step 6: Smoke-test**

Build + run. ConnectModal renders stream with toolbar at correct sizing. `/embed.html?device=...` renders stream with toolbar. No visual regressions.

- [ ] **Step 7: Commit**

```bash
git add src/style/app.css src/style/ws-scrcpy.css
git commit -m "style: move stream/toolbar CSS to ws-scrcpy.css, delete body.embed rules"
```

---

### Task 11b: Add clipboard toolbar buttons (get + set, replaces GoogMoreBox clipboard sync)

GoogMoreBox today handles clipboard in both directions:
- **GET** (device → host): receives `DeviceMessage.TYPE_CLIPBOARD`, writes text to a hidden textarea, calls `document.execCommand('copy')`
- **SET** (host → device): user types in GoogMoreBox's textarea, picks "Set clipboard" from a command dropdown, send button calls `CommandControlMessage.createSetClipboardCommand(text)`

When we delete GoogMoreBox in Task 12, both directions vanish. Replace with two toolbar buttons using modern `navigator.clipboard` APIs.

**Files:**
- Modify: `src/app/googDevice/toolbox/GoogToolBox.ts`
- Modify: `src/app/googDevice/client/StreamClientScrcpy.ts`
- Modify: `src/app/SvgImage.ts` (add two clipboard icons)

- [ ] **Step 1: Add clipboard SVG icons**

In `src/app/SvgImage.ts`, in the icon registry, add two entries. The distinction is the arrow: down = pull from device, up = push to device.

```typescript
// GET: clipboard with down arrow — pull FROM device TO host
'clipboard-get': '<svg viewBox="0 0 24 24"><path d="M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm0 18l-5-5h3V9h4v6h3l-5 5z"/></svg>',

// SET: clipboard with up arrow — push FROM host TO device
'clipboard-set': '<svg viewBox="0 0 24 24"><path d="M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm0 7l5 5h-3v6h-4v-6H7l5-5z"/></svg>',
```

- [ ] **Step 2: Add the toolbar buttons**

In `src/app/googDevice/toolbox/GoogToolBox.ts`, in `createToolBox`, add two buttons next to the existing toolbar buttons:

```typescript
// GET: pull device clipboard to host
const clipGetBtn = document.createElement('button');
clipGetBtn.className = 'control-button';
clipGetBtn.title = 'copy device clipboard to host';
clipGetBtn.innerHTML = SvgImage.get('clipboard-get');
clipGetBtn.addEventListener('click', () => {
    client.sendMessage(CommandControlMessage.createSimpleCommand(ControlMessage.TYPE_GET_CLIPBOARD));
});
toolBox.appendChild(clipGetBtn);

// SET: push host clipboard to device
const clipSetBtn = document.createElement('button');
clipSetBtn.className = 'control-button';
clipSetBtn.title = 'push host clipboard to device';
clipSetBtn.innerHTML = SvgImage.get('clipboard-set');
clipSetBtn.addEventListener('click', async () => {
    if (!navigator.clipboard?.readText) {
        console.error('[GoogToolBox] navigator.clipboard.readText unavailable');
        return;
    }
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            client.sendMessage(CommandControlMessage.createSetClipboardCommand(text));
        }
    } catch (err) {
        // Browser may deny permission; surface via console only (no UI disruption)
        console.error('[GoogToolBox] clipboard read failed:', err);
    }
});
toolBox.appendChild(clipSetBtn);
```

Required imports at the top of the file (if not already present):
```typescript
import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import { ControlMessage } from '../../controlMessage/ControlMessage';
```

Note: `navigator.clipboard.readText()` requires user gesture (button click satisfies this) AND host permission (browser prompts on first click). Secure context required — localhost is considered secure.

- [ ] **Step 3: Handle the device's GET response in StreamClientScrcpy**

In `src/app/googDevice/client/StreamClientScrcpy.ts`, modify `OnDeviceMessage` (around line 268) to handle clipboard messages. The existing version may look like:

```typescript
public OnDeviceMessage = (data: Uint8Array): void => {
    const message = DeviceMessage.fromRaw(data);
    if (this.moreBox) {
        this.moreBox.OnDeviceMessage(message);
    }
};
```

Replace with:

```typescript
public OnDeviceMessage = (data: Uint8Array): void => {
    const message = DeviceMessage.fromRaw(data);
    if (message.type === DeviceMessage.TYPE_CLIPBOARD) {
        const text = message.getText();
        if (text && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch((err) => {
                console.error('[StreamClientScrcpy] clipboard write failed:', err);
            });
        }
    }
};
```

(The `if (this.moreBox) { ... }` block is removed; Task 12 will delete the `moreBox` field entirely.)

- [ ] **Step 4: Build and smoke-test both directions**

```
npm run build
node dist/index.js
```

**GET test:**
1. On the device: long-press text field → Copy some text (e.g., a URL).
2. Click the download-arrow clipboard button (tooltip: "copy device clipboard to host").
3. On host: paste somewhere (e.g., into the browser address bar). Text should match.

**SET test:**
1. On host: copy text to clipboard (anywhere — a file name, a URL, etc.).
2. Click the up-arrow clipboard button (tooltip: "push host clipboard to device").
3. If browser prompts for clipboard read permission, grant it.
4. On device: long-press a text field → Paste. Text should match.

Both directions should work. If permission is denied for SET, you'll see a console error but no UI disruption.

- [ ] **Step 5: Commit**

```bash
git add src/app/googDevice/toolbox/GoogToolBox.ts src/app/googDevice/client/StreamClientScrcpy.ts src/app/SvgImage.ts
git commit -m "feat: toolbar clipboard buttons — get (device→host) + set (host→device)"
```

---

### Task 12: Delete GoogMoreBox

**Files:**
- Delete: `src/app/googDevice/toolbox/GoogMoreBox.ts`
- Delete: `src/style/morebox.css`
- Modify: `src/app/googDevice/client/StreamClientScrcpy.ts`
- Modify: `src/app/googDevice/toolbox/GoogToolBox.ts`

- [ ] **Step 1: Delete morebox files**

```bash
rm src/app/googDevice/toolbox/GoogMoreBox.ts
rm src/style/morebox.css
```

- [ ] **Step 2: Remove MoreBox from StreamClientScrcpy**

In `src/app/googDevice/client/StreamClientScrcpy.ts`:

1. Delete the import at line 28: `import { GoogMoreBox } from '../toolbox/GoogMoreBox';`
2. Delete the field at line 140: `private moreBox?: GoogMoreBox;`
3. Delete the OnDeviceMessage forwarding around line 270-272:
   ```typescript
   if (this.moreBox) {
       this.moreBox.OnDeviceMessage(message);
   }
   ```
4. In the startup code around line 380-398, remove all references to `moreBox`:

```typescript
// Old:
parent = moreBox.parentElement;
if (parent) parent.removeChild(moreBox);
// ... later:
const googMoreBox = (this.moreBox = new GoogMoreBox(udid, player, this));
const moreBox = googMoreBox.getHolderElement();
googMoreBox.setOnStop(stop);
const googToolBox = GoogToolBox.createToolBox(udid, player, this, moreBox);
this.controlButtons = googToolBox.getHolderElement();
deviceView.appendChild(this.controlButtons);
const video = document.createElement('div');
video.className = 'video';
deviceView.appendChild(video);
deviceView.appendChild(moreBox);
```

becomes:

```typescript
// (removed the `parent = moreBox.parentElement` cleanup block)
const googToolBox = GoogToolBox.createToolBox(udid, player, this);
this.controlButtons = googToolBox.getHolderElement();
deviceView.appendChild(this.controlButtons);
const video = document.createElement('div');
video.className = 'video';
deviceView.appendChild(video);
```

- [ ] **Step 3: Update GoogToolBox.createToolBox signature**

In `src/app/googDevice/toolbox/GoogToolBox.ts`, find the `createToolBox` static method. Remove the `moreBox` parameter from its signature. If the body of `createToolBox` contains a button that toggled moreBox visibility, delete that button and its handler.

Search for `moreBox` in `GoogToolBox.ts` and delete every reference.

- [ ] **Step 4: Remove morebox.css import**

In any file that imports `morebox.css`, remove the import line. Expected locations: `GoogMoreBox.ts` (already deleted) and possibly `StreamClientScrcpy.ts` or `app.css`. Search:

```
grep -rn "morebox.css" src/
```

Delete all found imports.

- [ ] **Step 5: Run full test suite**

```
npx vitest run
```

Expected: PASS. If any test imported GoogMoreBox, delete the test file — the feature is gone.

- [ ] **Step 6: Build and smoke-test**

```
npm run build
node dist/index.js
```

Browse http://localhost:8000/, connect a device, verify toolbar still has: d-pad/touch toggle, refresh, stats, keyboard toggle. No more-box overflow button.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: delete GoogMoreBox (YAGNI — contents were all redundant with toolbar)"
```

---

### Task 12b: Generate TypeScript declarations (bundled)

Raw `tsc --emitDeclarationOnly` output produces relative imports (`from './startStream'`, `from './types'`) that break after flattening. Use `dts-bundle-generator` to produce a single self-contained `ws-scrcpy.d.ts`.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the bundler**

```
npm install --save-dev dts-bundle-generator
```

- [ ] **Step 2: Add a bundled types script**

Edit `package.json` scripts section:

```json
"build:types": "dts-bundle-generator -o dist/public/ws-scrcpy.d.ts --project tsconfig.json --no-check src/app/public/index.ts",
"build": "webpack --config webpack/ws-scrcpy-web.prod.ts --stats-error-details && npm run build:types"
```

- [ ] **Step 3: Verify output**

```
npm run build
cat dist/public/ws-scrcpy.d.ts | head -30
```

Expected: a single `.d.ts` file with inlined declarations for `startStream`, `StartStreamOptions`, `StreamHandle`, `StreamInfo`, and `version`. No relative imports inside the file (everything inlined).

Create a quick sanity check — a temporary `check-types.ts` (not committed):

```typescript
import type { StartStreamOptions, StreamHandle } from './dist/public/ws-scrcpy';
const opts: StartStreamOptions = { codec: 'h265' };
const handle: StreamHandle = null as unknown as StreamHandle;
console.log(opts, handle);
```

Run `npx tsc --noEmit check-types.ts` — expected: no errors. Delete the file afterward.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: emit bundled ws-scrcpy.d.ts via dts-bundle-generator"
```

---

### Task 13: Update TECHNICAL_GUIDE.md and README.md

**Files:**
- Modify: `docs/TECHNICAL_GUIDE.md`
- Modify: `README.md`

- [ ] **Step 1: Add a new section to TECHNICAL_GUIDE.md**

After the existing "Embed Mode" section (section 6), either replace its contents or add a new subsection titled "Public Stream API".

Include:
- The UMD usage example (`<script src="ws-scrcpy.umd.js">` + `window.WsScrcpy.startStream(container, udid, options)`)
- The ESM usage example (`import { startStream } from '/ws-scrcpy.esm.js'`)
- The full options / handle interface (copy from the spec §4)
- The `embed.html` URL param table (from the spec §5.2)
- A note that direct-link `#!action=stream` routing is removed — use `/embed.html?device=...` instead
- A note that more-box is removed

Write the section from scratch; do not leave placeholders.

- [ ] **Step 2: Update the README file-browser / feature list**

In `README.md`, in the features section:

Replace any mention of iframe embed mode with:

```markdown
- **Programmatic stream API** -- load `ws-scrcpy.umd.js` or `ws-scrcpy.esm.js` and call `WsScrcpy.startStream(container, deviceId, options)` to render a stream into any DOM element. Ship a thin `/embed.html?device=<udid>` wrapper for iframe consumers.
```

Remove any mention of `?embed=true` and `#!action=stream` URL patterns.

- [ ] **Step 3: Commit**

```bash
git add docs/TECHNICAL_GUIDE.md README.md
git commit -m "docs: public stream API + embed.html in TECHNICAL_GUIDE and README"
```

---

### Task 14: Final manual smoke test + push

**Files:** (none — verification only)

- [ ] **Step 1: Clean build**

```bash
rm -rf dist
npm run build
```

Verify output files exist:
```
ls dist/public/index.html dist/public/bundle.js dist/public/bundle.css \
   dist/public/embed.html dist/public/embed.js \
   dist/public/ws-scrcpy.umd.js dist/public/ws-scrcpy.esm.js dist/public/ws-scrcpy.css
```

- [ ] **Step 2: Start server**

```
node dist/index.js
```

- [ ] **Step 3: Run through the smoke-test checklist (from spec §9.3)**

1. [ ] Home page → Configure → Connect opens ConnectModal → streams
2. [ ] `/embed.html?device=<udid>` in a tab → transparent bg + toolbar
3. [ ] `/embed.html?device=<udid>&codec=h264` → forces H.264 (verify via stats overlay)
4. [ ] `/embed.html` with no device → `missing required "device" param` status
5. [ ] `/embed.html?device=<bogus>` → `error: ...` status
6. [ ] Console: grab handle, call `handle.stop()` → container empties, no stray WebSocket in Network tab
7. [ ] Device disconnect mid-stream (turn off device) → `onDisconnect` fires
8. [ ] Two `/embed.html` tabs for two different devices → both independent
9. [ ] Toolbar: d-pad/touch toggle, refresh, stats, keyboard toggle all functional
10. [ ] `window.WsScrcpy.version` returns the package version string

- [ ] **Step 4: Run full test suite**

```
npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 5: Push**

```bash
git push
```

- [ ] **Step 6: Update memory**

Update `project_wsscrcpy_todo.md`: mark item 6 as DONE with the merge commit SHA. Note that Control Menu will need its iframe URL updated as a follow-up.

---

## Rollback Notes

Each task commits independently. If a task breaks something, `git revert <sha>` restores the previous state without disturbing prior or later tasks. The server is never modified — all risk is in frontend changes.
