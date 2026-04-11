# SP1 — Dependency Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip dead features (iOS, DevTools, vendor decoders), modernize all dependencies (39→16), replace adbkit with CLI wrapper, replace Express with built-in http, update build tooling — while preserving existing scrcpy v1.19 functionality end-to-end.

**Architecture:** The existing ws-scrcpy codebase uses adbkit (ADB protocol library), Express (HTTP), ifdef-loader (conditional compilation), and 4 video decoders. We strip to WebCodecs-only, replace adbkit with child_process CLI calls (Device.ts already has both paths), replace Express with Node's http module, switch from YAML to JSON config, and modernize TypeScript/webpack/linting.

**Tech Stack:** TypeScript 5.5, webpack 5, Biome, Node.js 18+, ws (WebSocket), node-pty, @xterm/xterm v5

**Spec:** `docs/specs/2026-04-10-sp1-dependency-modernization.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/server/AdbClient.ts` | ADB CLI wrapper replacing @dead50f7/adbkit |
| `src/server/StaticFileServer.ts` | Built-in http static file server replacing Express |
| `public/index.html` | Handwritten HTML entry point |
| `config.example.json` | JSON config template |
| `biome.json` | Biome linter/formatter config |
| `.github/workflows/ci.yml` | GitHub Actions CI |
| `Dockerfile` | Container build |
| `.dockerignore` | Docker ignore rules |

### Major Modifications

| File | Change |
|------|--------|
| `package.json` | Full overhaul — name, deps, scripts, engine, license |
| `tsconfig.json` | ES2022 target, strict, drop helpers |
| `webpack/ws-scrcpy-web.common.ts` | Remove dead loaders, update asset handling |
| `src/server/index.ts` | Strip ifdef blocks, remove adbkit/npmlog, use new HttpServer |
| `src/server/Config.ts` | JSON-only config, remove YAML/ifdef |
| `src/server/services/HttpServer.ts` | Replace Express with StaticFileServer |
| `src/server/goog-device/Device.ts` | Replace adbkit calls with AdbClient CLI |
| `src/server/goog-device/ScrcpyServer.ts` | Use AdbClient for push, remove adbkit import |
| `src/server/goog-device/services/ControlCenter.ts` | Replace adbkit Tracker with CLI polling |
| `src/app/index.ts` | Strip ifdef blocks, remove dead decoder registrations |
| `src/app/googDevice/client/ShellClient.ts` | Update xterm imports to @xterm/ scope |

### Deleted Files/Directories

| Path | Reason |
|------|--------|
| `vendor/` | All WASM decoders replaced by WebCodecs |
| `src/app/applDevice/` | iOS removed |
| `src/server/appl-device/` | iOS removed |
| `typings/` | Appium types (iOS) |
| `src/app/player/BroadwayPlayer.ts` | Decoder removed |
| `src/app/player/TinyH264Player.ts` | Decoder removed |
| `src/app/player/MsePlayer.ts` | Decoder removed |
| `src/app/player/MsePlayerForQVHack.ts` | Decoder removed |
| `src/app/player/MjpegPlayer.ts` | Decoder removed |
| `src/app/googDevice/client/DevtoolsClient.ts` | DevTools removed |
| `src/server/goog-device/mw/RemoteDevtools.ts` | DevTools removed |
| `src/types/ParamsDevtools.d.ts` | DevTools removed |
| `src/types/RemoteDevtools.d.ts` | DevTools removed |
| `src/types/RemoteDevtoolsCommand.ts` | DevTools removed |
| `src/style/devtools.css` | DevTools removed |
| `src/server/goog-device/adb/` | adbkit wrappers replaced by AdbClient |
| `src/server/goog-device/AdbUtils.ts` | adbkit utilities replaced |
| `config.example.yaml` | Replaced by JSON |
| `.eslintrc` | Replaced by Biome |
| `.prettierrc` | Replaced by Biome |
| `webpack/default.build.config.json` | ifdef flags gone |
| `webpack/build.config.override.json` (root) | ifdef flags gone |
| `webpack/build.config.utils.ts` | ifdef config loader gone |

---

## Task 1: Strip Dead Code

**Files:**
- Delete: `vendor/`, `src/app/applDevice/`, `src/server/appl-device/`, `typings/`
- Delete: `src/app/player/BroadwayPlayer.ts`, `src/app/player/TinyH264Player.ts`, `src/app/player/MsePlayer.ts`, `src/app/player/MsePlayerForQVHack.ts`, `src/app/player/MjpegPlayer.ts`
- Delete: `src/app/googDevice/client/DevtoolsClient.ts`, `src/server/goog-device/mw/RemoteDevtools.ts`
- Delete: `src/types/ParamsDevtools.d.ts`, `src/types/RemoteDevtools.d.ts`, `src/types/RemoteDevtoolsCommand.ts`, `src/style/devtools.css`
- Delete: `config.example.yaml`, `.eslintrc`, `.prettierrc`
- Delete: `webpack/default.build.config.json`, `build.config.override.json`, `webpack/build.config.utils.ts`

- [ ] **Step 1: Delete directories**

```bash
cd /c/Users/jscha/source/repos/ws-scrcpy-web
rm -rf vendor/ src/app/applDevice/ src/server/appl-device/ typings/
```

- [ ] **Step 2: Delete dead player files**

```bash
rm src/app/player/BroadwayPlayer.ts src/app/player/TinyH264Player.ts \
   src/app/player/MsePlayer.ts src/app/player/MsePlayerForQVHack.ts \
   src/app/player/MjpegPlayer.ts
```

- [ ] **Step 3: Delete DevTools files**

```bash
rm src/app/googDevice/client/DevtoolsClient.ts \
   src/server/goog-device/mw/RemoteDevtools.ts \
   src/types/ParamsDevtools.d.ts src/types/RemoteDevtools.d.ts \
   src/types/RemoteDevtoolsCommand.ts
rm -f src/style/devtools.css
```

- [ ] **Step 4: Delete old config/lint files**

```bash
rm -f config.example.yaml .eslintrc .prettierrc
rm -f webpack/default.build.config.json build.config.override.json webpack/build.config.utils.ts
```

- [ ] **Step 5: Clean up imports in `src/app/index.ts`**

Read the file. Remove all `/// #if` / `/// #endif` blocks and their contents for: `USE_BROADWAY`, `USE_H264_CONVERTER`, `USE_TINY_H264`, `INCLUDE_APPL`, `INCLUDE_DEV_TOOLS`. Keep only the `USE_WEBCODECS` player registration (now unconditional), `INCLUDE_ADB_SHELL`, and `INCLUDE_FILE_LISTING` blocks — but remove the ifdef directives themselves, making the code unconditional. The file should directly import WebCodecsPlayer, ShellClient, FileListingClient, and GoogDeviceTracker without any conditional compilation.

- [ ] **Step 6: Clean up imports in `src/server/index.ts`**

Remove the `INCLUDE_APPL` async function (`loadApplModules`). Remove the `INCLUDE_DEV_TOOLS` import of `RemoteDevtools`. Remove the npmlog dynamic import. Make `loadGoogModules` the only module loader, and make its contents unconditional (no ifdefs for INCLUDE_ADB_SHELL, INCLUDE_DEV_TOOLS, INCLUDE_FILE_LISTING — keep shell and file listing as always-on, remove devtools).

- [ ] **Step 7: Clean up `src/server/Config.ts`**

Remove the `/// #if INCLUDE_APPL` block and the `YAML` import. Remove YAML parsing — only support JSON config files. Remove `runApplTracker` and `announceApplTracker` from the default config. Remove the `INCLUDE_GOOG` ifdef — `runGoogTracker` is always true.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: strip iOS, DevTools, vendor decoders, and ifdef conditional compilation

Removes: iOS support (applDevice), Chrome DevTools proxy, Broadway/TinyH264/MSE/MJPEG decoders,
vendor directory, YAML config, ifdef-loader conditional compilation.
Keeps: WebCodecs decoder, ADB shell, file manager, Android stream client."
```

---

## Task 2: AdbClient — Replace adbkit with CLI Wrapper

**Files:**
- Create: `src/server/AdbClient.ts`
- Modify: `src/server/goog-device/Device.ts`
- Modify: `src/server/goog-device/ScrcpyServer.ts`
- Modify: `src/server/goog-device/services/ControlCenter.ts`
- Delete: `src/server/goog-device/adb/` (entire directory)
- Delete: `src/server/goog-device/AdbUtils.ts`

- [ ] **Step 1: Create `src/server/AdbClient.ts`**

A thin wrapper around `child_process.execFile` that provides typed methods for ADB operations. Key methods:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

export class AdbClient {
    constructor(private adbPath: string = 'adb') {}

    async devices(): Promise<Array<{ serial: string; state: string }>>
    async shell(serial: string, command: string): Promise<string>
    async push(serial: string, local: string, remote: string): Promise<void>
    async pull(serial: string, remote: string, local: string): Promise<void>
    async forward(serial: string, local: string, remote: string): Promise<void>
    async reverse(serial: string, remote: string, local: string): Promise<void>
    async getProperties(serial: string): Promise<Record<string, string>>
    async listFiles(serial: string, path: string): Promise<Array<{ name: string; size: number; mtime: Date }>>

    private async exec(args: string[]): Promise<string>
}
```

Each method calls `this.exec(['-s', serial, 'shell', command])` or equivalent, parses stdout, and returns structured data. Error handling: throw on non-zero exit code with stderr message.

`devices()` parses `adb devices -l` output. `getProperties()` parses `adb shell getprop` output (lines like `[prop.name]: [value]`). `listFiles()` parses `adb shell ls -la` output for the file manager feature.

- [ ] **Step 2: Refactor `src/server/goog-device/Device.ts`**

The Device class currently has two shell methods:
- `runShellCommandAdbKit(command)` — uses adbkit `client.shell()`
- `runShellCommandAdb(command)` — uses `child_process.spawn('adb')`

Replace both with a single method that uses `AdbClient`:

1. Remove `import { AdbExtended } from './adb'` and `import AdbKitClient` and `import PushTransfer`
2. Import `AdbClient` instead
3. Replace `this.client = AdbExtended.createClient()` with `this.adbClient = new AdbClient()`
4. Replace `runShellCommandAdbKit(command)` body: call `this.adbClient.shell(this.udid, command)`
5. Replace `runShellCommandAdb(command)` body: same `this.adbClient.shell(this.udid, command)` (unify the two methods into one)
6. Replace `push(contents, path)` method: call `this.adbClient.push(this.udid, contents, path)`
7. Replace `getProperties()`: call `this.adbClient.getProperties(this.udid)`

- [ ] **Step 3: Refactor `src/server/goog-device/ScrcpyServer.ts`**

1. Remove `import PushTransfer from '@dead50f7/adbkit/...'`
2. Remove the `import '../../../vendor/Genymobile/scrcpy/scrcpy-server.jar'` (vendor deleted — the jar will be bundled differently or referenced from a known path)
3. `copyServer()` now calls `device.push(src, dst)` which uses AdbClient internally — the interface stays the same, just the implementation changed in Device.ts

**Note:** The scrcpy-server.jar needs to be available at build/runtime. Since we deleted `vendor/`, we need a new location. Place it in `assets/scrcpy-server.jar` and update the path reference. The jar file itself is copied from the vendor directory before it was deleted (it's in git history), or downloaded from Genymobile's releases.

- [ ] **Step 4: Refactor `src/server/goog-device/services/ControlCenter.ts`**

The ControlCenter uses adbkit's `Tracker` for device connect/disconnect events. Replace with polling `AdbClient.devices()` on a timer:

1. Remove adbkit Tracker import
2. Add a polling loop: `setInterval(() => this.refreshDevices(), 2000)`
3. `refreshDevices()` calls `adbClient.devices()`, diffs against known device list, emits add/remove/change events

- [ ] **Step 5: Refactor file listing operations**

The `ExtendedClient` provides `pipeReadDir`, `pipePull`, `pipeStat` using ADB sync protocol. Replace with CLI equivalents:

- File listing: `adbClient.shell(serial, 'ls -la <path>')` → parse output
- File pull: `adbClient.pull(serial, remotePath, localTempPath)` → stream to client
- File stat: `adbClient.shell(serial, 'stat <path>')` → parse output

Update `src/server/goog-device/mw/FileListing.ts` to use AdbClient instead of ExtendedClient.

- [ ] **Step 6: Delete adbkit wrapper directory**

```bash
rm -rf src/server/goog-device/adb/
rm -f src/server/goog-device/AdbUtils.ts
```

- [ ] **Step 7: Verify build**

```bash
npx tsc --noEmit
```

Fix any remaining references to deleted adbkit types.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: replace adbkit with AdbClient CLI wrapper

All ADB operations now use child_process.execFile to shell out to the adb CLI.
Removes @dead50f7/adbkit dependency and custom ADB protocol wrappers.
Device tracking uses polling instead of adbkit Tracker."
```

---

## Task 3: Replace Express with Built-in HTTP Server

**Files:**
- Create: `src/server/StaticFileServer.ts`
- Modify: `src/server/services/HttpServer.ts`

- [ ] **Step 1: Create `src/server/StaticFileServer.ts`**

A ~30 line static file server using Node's built-in `fs` and `path`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { IncomingMessage, ServerResponse } from 'http';

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.jar': 'application/java-archive',
};

export function createStaticHandler(publicDir: string) {
    return (req: IncomingMessage, res: ServerResponse): void => {
        const urlPath = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
        const filePath = path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath);

        // Security: prevent directory traversal
        if (!filePath.startsWith(publicDir)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                // SPA fallback: serve index.html for unknown routes
                const indexPath = path.join(publicDir, 'index.html');
                fs.createReadStream(indexPath).pipe(res.writeHead(200, { 'Content-Type': 'text/html' }));
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            fs.createReadStream(filePath).pipe(res);
        });
    };
}
```

- [ ] **Step 2: Rewrite `src/server/services/HttpServer.ts`**

Replace Express with Node's built-in `http.createServer`:

1. Remove `import express, { Express } from 'express'`
2. Import `{ createStaticHandler } from '../StaticFileServer'`
3. In `start()`, replace `this.mainApp = express()` + `express.static()` with `const handler = createStaticHandler(HttpServer.PUBLIC_DIR)`
4. Replace `http.createServer(options, this.mainApp)` with `http.createServer(handler)`
5. Remove MJPEG proxy route (iOS feature, already stripped)
6. Remove HTTPS redirect Express app (simplify — just HTTP for now, HTTPS can be added back if needed)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: replace Express with built-in http static file server

Removes express dependency. Static files served via fs.createReadStream
with MIME type detection and directory traversal protection."
```

---

## Task 4: JSON Config + Remove YAML

**Files:**
- Create: `config.example.json`
- Modify: `src/server/Config.ts`
- Modify: `src/server/EnvName.ts` (if needed)

- [ ] **Step 1: Create `config.example.json`**

```json
{
    "port": 8000,
    "adbPath": "adb"
}
```

- [ ] **Step 2: Simplify `src/server/Config.ts`**

1. Remove `import YAML from 'yaml'`
2. Remove YAML_RE regex and YAML parsing branch
3. Config loading: `JSON.parse(fs.readFileSync(configPath, 'utf-8'))`
4. Support env var overrides: `PORT` overrides `config.port`, `ADB_PATH` overrides `config.adbPath`
5. Remove Apple-related config properties (`runApplTracker`, `announceApplTracker`)
6. Remove all `/// #if` directives — `runGoogTracker` is always true
7. Simplify server config — single `{ port }` instead of array of ServerItems (we're HTTP-only for now)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: switch config from YAML to JSON with env var overrides

Removes yaml dependency. Config via config.json file or PORT/ADB_PATH env vars."
```

---

## Task 5: Package.json + tsconfig Overhaul

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Rewrite `package.json`**

Update name, version, license, scripts, engines. Remove all dropped dependencies. Add new ones. The full dependency list:

**dependencies:**
```json
{
    "node-pty": "^0.10.1",
    "ws": "^8.18.0"
}
```

**devDependencies:**
```json
{
    "@biomejs/biome": "latest",
    "@types/node": "^22",
    "@types/ws": "^8",
    "@xterm/xterm": "^5",
    "@xterm/addon-attach": "latest",
    "@xterm/addon-fit": "latest",
    "buffer": "^6.0.3",
    "css-loader": "^6.8.1",
    "mini-css-extract-plugin": "^2.6.1",
    "path-browserify": "^1.0.1",
    "ts-loader": "^9.3.1",
    "ts-node": "^10.9.1",
    "typescript": "^5.5",
    "webpack": "^5.94.0",
    "webpack-cli": "^5"
}
```

**scripts:**
```json
{
    "clean": "rm -rf dist",
    "build:dev": "webpack --config webpack/ws-scrcpy-web.dev.ts --stats-error-details",
    "build": "webpack --config webpack/ws-scrcpy-web.prod.ts --stats-error-details",
    "start": "npm run build && node dist/index.js",
    "lint": "npx @biomejs/biome check src/",
    "format": "npx @biomejs/biome check --write src/"
}
```

- [ ] **Step 2: Update `tsconfig.json`**

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "ES2022",
        "moduleResolution": "bundler",
        "lib": ["ES2022", "DOM", "DOM.Iterable"],
        "outDir": "./build",
        "rootDir": "./src",
        "strict": true,
        "esModuleInterop": true,
        "allowSyntheticDefaultImports": true,
        "skipLibCheck": true,
        "forceConsistentCasingInFileNames": true,
        "resolveJsonModule": true,
        "declaration": true,
        "declarationMap": true,
        "sourceMap": true,
        "importHelpers": false
    },
    "include": ["src/**/*"],
    "exclude": ["node_modules", "dist", "build"]
}
```

- [ ] **Step 3: Delete `package-lock.json` and `node_modules`, fresh install**

```bash
rm -rf node_modules package-lock.json
npm install
```

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.json package-lock.json
git commit -m "feat: modernize package.json and tsconfig

TypeScript 5.5, ES2022 target, Node 22 types, Biome, @xterm/xterm v5.
Runtime deps: ws + node-pty only. Dev deps reduced from 30 to 15."
```

---

## Task 6: Webpack Config Update

**Files:**
- Rename: `webpack/ws-scrcpy.common.ts` → `webpack/ws-scrcpy-web.common.ts`
- Rename: `webpack/ws-scrcpy.dev.ts` → `webpack/ws-scrcpy-web.dev.ts`
- Rename: `webpack/ws-scrcpy.prod.ts` → `webpack/ws-scrcpy-web.prod.ts`

- [ ] **Step 1: Rename webpack config files**

```bash
mv webpack/ws-scrcpy.common.ts webpack/ws-scrcpy-web.common.ts
mv webpack/ws-scrcpy.dev.ts webpack/ws-scrcpy-web.dev.ts
mv webpack/ws-scrcpy.prod.ts webpack/ws-scrcpy-web.prod.ts
```

- [ ] **Step 2: Rewrite `webpack/ws-scrcpy-web.common.ts`**

Major changes:
1. Remove `ifdef-loader` from TypeScript loader chain — just `ts-loader` alone
2. Remove `worker-loader` rules
3. Replace `svg-inline-loader` with `{ type: 'asset/source' }` for `.svg` files
4. Replace `file-loader` for images/assets with `{ type: 'asset/resource' }`
5. Remove `HtmlWebpackPlugin` — we'll use a handwritten `public/index.html`
6. Remove `GeneratePackageJsonPlugin` (the `@dead50f7/` fork) — write a simple post-build copy or inline plugin
7. Remove `ProvidePlugin` for Buffer (keep `buffer` in resolve.fallback for SP1)
8. Replace `nodeExternals()` with `externals: [/^[a-z@]/]`
9. Remove `build.config.utils` import and all ifdef-related configuration
10. Update entry points if paths changed

- [ ] **Step 3: Update dev and prod configs**

Update imports to reference `ws-scrcpy-web.common.ts` instead of `ws-scrcpy.common.ts`.

- [ ] **Step 4: Create `public/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ws-scrcpy-web</title>
    <link rel="stylesheet" href="bundle.css">
</head>
<body>
    <script src="bundle.js"></script>
</body>
</html>
```

Configure webpack to copy this to `dist/public/` via `CopyWebpackPlugin` or simply include it in the build output directory setup.

- [ ] **Step 5: Verify webpack builds**

```bash
npx webpack --config webpack/ws-scrcpy-web.dev.ts
```

Fix any loader/plugin errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: modernize webpack config

Remove ifdef-loader, worker-loader, file-loader, svg-inline-loader, HtmlWebpackPlugin.
Use webpack 5 built-in asset modules. Handwritten index.html."
```

---

## Task 7: Biome Setup

**Files:**
- Create: `biome.json`

- [ ] **Step 1: Create `biome.json`**

```json
{
    "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
    "organizeImports": {
        "enabled": true
    },
    "formatter": {
        "enabled": true,
        "indentStyle": "space",
        "indentWidth": 4,
        "lineWidth": 120
    },
    "linter": {
        "enabled": true,
        "rules": {
            "recommended": true,
            "suspicious": {
                "noExplicitAny": "warn"
            },
            "complexity": {
                "noForEach": "off"
            }
        }
    },
    "javascript": {
        "formatter": {
            "quoteStyle": "single",
            "trailingCommas": "all",
            "semicolons": "always"
        }
    },
    "files": {
        "ignore": ["dist/", "build/", "node_modules/", "vendor/"]
    }
}
```

Note: Check the existing `.prettierrc` settings before deletion to match the code style (single vs double quotes, semicolons, indent width). Adjust `biome.json` to match.

- [ ] **Step 2: Run Biome and fix issues**

```bash
npx @biomejs/biome check --write src/
```

This will auto-fix formatting. Review any lint errors that can't be auto-fixed.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add Biome for linting and formatting, replace ESLint + Prettier"
```

---

## Task 8: xterm Upgrade

**Files:**
- Modify: `src/app/googDevice/client/ShellClient.ts`
- Modify: any other files importing from `xterm`

- [ ] **Step 1: Update xterm imports**

In `src/app/googDevice/client/ShellClient.ts`, change:

```typescript
// Old:
import { Terminal } from 'xterm';
import { AttachAddon } from 'xterm-addon-attach';
import { FitAddon } from 'xterm-addon-fit';

// New:
import { Terminal } from '@xterm/xterm';
import { AttachAddon } from '@xterm/addon-attach';
import { FitAddon } from '@xterm/addon-fit';
```

Also update any CSS imports — xterm v5 uses `@xterm/xterm/css/xterm.css` instead of `xterm/css/xterm.css`.

- [ ] **Step 2: Check for API changes**

xterm v5 has some API changes:
- `Terminal` constructor options are mostly the same
- `loadAddon()` method is the same
- Check that `AttachAddon` constructor still takes a WebSocket

Fix any type errors that arise.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: upgrade xterm to @xterm/xterm v5"
```

---

## Task 9: Scrcpy Server JAR Location

**Files:**
- Create: `assets/` directory
- Modify: `src/server/goog-device/ScrcpyServer.ts`
- Modify: webpack config (asset handling for .jar)

- [ ] **Step 1: Place scrcpy-server.jar in assets/**

The jar was previously in `vendor/Genymobile/scrcpy/scrcpy-server.jar`. Copy it to `assets/scrcpy-server.jar`. (Retrieve from git history if needed: `git show HEAD~N:vendor/Genymobile/scrcpy/scrcpy-server.jar > assets/scrcpy-server.jar`)

```bash
mkdir -p assets
git show ff61694:vendor/Genymobile/scrcpy/scrcpy-server.jar > assets/scrcpy-server.jar
```

(Adjust the commit reference based on how many commits back the vendor directory existed.)

- [ ] **Step 2: Update ScrcpyServer.ts path reference**

Change the import/path from `vendor/Genymobile/scrcpy/` to `assets/`:

```typescript
const FILE_DIR = path.join(__dirname, 'assets');
const FILE_NAME = 'scrcpy-server.jar';
```

Ensure webpack copies the `.jar` file to the dist output via asset module rules.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: move scrcpy-server.jar to assets/ directory"
```

---

## Task 10: CI/CD + Dockerfile

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
          cache: npm
      - run: npm ci
      - run: npx @biomejs/biome check src/
      - run: npm run build
```

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    android-tools-adb python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

EXPOSE 8000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Create `.dockerignore`**

```
node_modules
dist
build
.git
```

- [ ] **Step 4: Verify Docker build**

```bash
docker build -t ws-scrcpy-web .
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add GitHub Actions CI and Dockerfile"
```

---

## Task 11: Build Verification + Push

- [ ] **Step 1: Clean build**

```bash
npm run clean
npm run build
```

Expected: Build succeeds with zero errors.

- [ ] **Step 2: Lint**

```bash
npx @biomejs/biome check src/
```

Expected: No errors.

- [ ] **Step 3: Smoke test**

Start the server, connect an Android device, verify screen mirroring works in browser with WebCodecs decoder:

```bash
node dist/index.js
```

Open `http://localhost:8000` — device should appear, streaming should work.

- [ ] **Step 4: Review commit history**

```bash
git log --oneline
```

Verify all SP1 commits are clean and logical.

- [ ] **Step 5: Push**

```bash
git push origin main
```

- [ ] **Step 6: Verify CI passes**

Check GitHub Actions — the CI workflow should run lint + build successfully.
