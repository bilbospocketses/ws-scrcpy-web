# Dependency Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained dependency management system with a browser UI on the ws-scrcpy-web home page, allowing users to check and update runtime dependencies (Node.js + node-pty, ADB, scrcpy-server) without any system-wide installations.

**Architecture:** Server-side `DependencyManager` handles version detection, remote version checking, and download/install with platform-aware logic. HTTP API endpoints expose operations to the browser. A `DependencyPanel` renders status and update controls on the home page. External launcher scripts (`start.cmd`/`start.sh`) handle the Node.js restart problem (can't replace a running binary on Windows).

**Tech Stack:** TypeScript (server + browser), Node.js HTTP API, vanilla DOM (matching existing UI patterns), GitHub API + nodejs.org API + Google SDK URLs for version checking.

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `src/common/DependencyTypes.ts` | Shared types: DependencyInfo, DependencyStatus, UpdateResult |
| `src/server/DependencyDefinitions.ts` | Declarative config for each dependency (version commands, download URLs, platform logic) |
| `src/server/DependencyManager.ts` | Core logic: detect installed versions, check remote versions, download, extract, install |
| `src/server/api/DependencyApi.ts` | HTTP route handler for `/api/dependencies/*` endpoints |
| `src/app/client/DependencyPanel.ts` | Browser-side UI: renders dependency table with status and update buttons |
| `src/style/dependencies.css` | Styling for the dependency panel |
| `src/common/__tests__/dependencyTypes.test.ts` | Tests for version comparison |
| `src/server/__tests__/dependencyDefinitions.test.ts` | Tests for platform detection, URL generation |
| `src/server/__tests__/dependencyManager.test.ts` | Tests for version parsing, status logic |
| `start.cmd` | Windows launcher: runs node.exe from dependencies/, handles restart |
| `start.sh` | Linux launcher: runs node from dependencies/, handles restart |

### Modified Files

| File | Change |
|------|--------|
| `src/server/services/HttpServer.ts` | Add API route interception before static file serving |
| `src/server/index.ts` | Initialize DependencyManager on startup |
| `src/app/index.ts` | Import and render DependencyPanel on home page |
| `src/app/client/BaseDeviceTracker.ts` | Add hook point for DependencyPanel above device list |
| `webpack/ws-scrcpy-web.common.ts` | Add `dependencies.css` to CSS imports |
| `src/server/Config.ts` | Add `dependenciesPath` config option |

---

## Task 1: Shared Types and Version Comparison

**Files:**
- Create: `src/common/DependencyTypes.ts`
- Create: `src/common/__tests__/dependencyTypes.test.ts`

- [ ] **Step 1: Write failing tests for version comparison**

```typescript
// src/common/__tests__/dependencyTypes.test.ts
import { describe, expect, it } from 'vitest';
import { compareVersions, DependencyStatus } from '../DependencyTypes';

describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
        expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    });

    it('returns -1 when installed is older', () => {
        expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    });

    it('returns 1 when installed is newer', () => {
        expect(compareVersions('1.3.0', '1.2.4')).toBe(1);
    });

    it('handles different segment lengths', () => {
        expect(compareVersions('35', '35.0.1')).toBe(-1);
    });

    it('returns -1 when either version is null', () => {
        expect(compareVersions(null, '1.0.0')).toBe(-1);
        expect(compareVersions('1.0.0', null)).toBe(-1);
    });

    it('strips leading v from version strings', () => {
        expect(compareVersions('v1.2.3', 'v1.2.3')).toBe(0);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/common/__tests__/dependencyTypes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement shared types**

```typescript
// src/common/DependencyTypes.ts
export enum DependencyStatus {
    Unknown = 'unknown',
    UpToDate = 'up-to-date',
    UpdateAvailable = 'update-available',
    Checking = 'checking',
    Updating = 'updating',
    Error = 'error',
}

export interface DependencyInfo {
    name: string;
    displayName: string;
    installedVersion: string | null;
    latestVersion: string | null;
    status: DependencyStatus;
    description: string;
    errorMessage?: string;
    /** True if updating this dependency requires an app restart */
    requiresRestart: boolean;
    /** True if this dependency is paired with another (e.g., node-pty with Node.js) */
    pairedWith?: string;
}

export interface UpdateResult {
    success: boolean;
    newVersion?: string;
    errorMessage?: string;
    requiresRestart: boolean;
}

export function compareVersions(a: string | null, b: string | null): number {
    if (a === null || b === null) return -1;
    const pa = a.replace(/^v/, '').split('.').map(Number);
    const pb = b.replace(/^v/, '').split('.').map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const na = pa[i] ?? 0;
        const nb = pb[i] ?? 0;
        if (na < nb) return -1;
        if (na > nb) return 1;
    }
    return 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/common/__tests__/dependencyTypes.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/common/DependencyTypes.ts src/common/__tests__/dependencyTypes.test.ts
git commit -m "feat(deps): add shared dependency types and version comparison"
```

---

## Task 2: Dependency Definitions

**Files:**
- Create: `src/server/DependencyDefinitions.ts`
- Create: `src/server/__tests__/dependencyDefinitions.test.ts`

- [ ] **Step 1: Write failing tests for platform detection and URL generation**

```typescript
// src/server/__tests__/dependencyDefinitions.test.ts
import { describe, expect, it } from 'vitest';
import { getPlatform, getArch, getDependencyDefinitions } from '../DependencyDefinitions';

describe('getPlatform', () => {
    it('returns win32 or linux based on os.platform()', () => {
        const platform = getPlatform();
        expect(['win32', 'linux']).toContain(platform);
    });
});

describe('getArch', () => {
    it('returns x64 or arm64', () => {
        const arch = getArch();
        expect(['x64', 'arm64']).toContain(arch);
    });
});

describe('getDependencyDefinitions', () => {
    it('returns definitions for all managed dependencies', () => {
        const defs = getDependencyDefinitions();
        const names = defs.map((d) => d.name);
        expect(names).toContain('nodejs');
        expect(names).toContain('adb');
        expect(names).toContain('scrcpy-server');
    });

    it('each definition has required fields', () => {
        const defs = getDependencyDefinitions();
        for (const def of defs) {
            expect(def.name).toBeTruthy();
            expect(def.displayName).toBeTruthy();
            expect(def.description).toBeTruthy();
            expect(typeof def.checkInstalled).toBe('function');
            expect(typeof def.checkLatest).toBe('function');
        }
    });

    it('nodejs definition includes node-pty pairing', () => {
        const defs = getDependencyDefinitions();
        const node = defs.find((d) => d.name === 'nodejs');
        expect(node?.pairedWith).toBe('node-pty');
        expect(node?.requiresRestart).toBe(true);
    });

    it('scrcpy-server does not require restart', () => {
        const defs = getDependencyDefinitions();
        const scrcpy = defs.find((d) => d.name === 'scrcpy-server');
        expect(scrcpy?.requiresRestart).toBe(false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/dependencyDefinitions.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement dependency definitions**

```typescript
// src/server/DependencyDefinitions.ts
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execFileAsync = promisify(execFile);

export function getPlatform(): 'win32' | 'linux' {
    return os.platform() === 'win32' ? 'win32' : 'linux';
}

export function getArch(): 'x64' | 'arm64' {
    return os.arch() === 'arm64' ? 'arm64' : 'x64';
}

export interface DependencyDefinition {
    name: string;
    displayName: string;
    description: string;
    requiresRestart: boolean;
    pairedWith?: string;
    /** Returns installed version string or null */
    checkInstalled: (depsPath: string) => Promise<string | null>;
    /** Returns latest version string from remote */
    checkLatest: () => Promise<string | null>;
    /** Returns download URL for the latest version */
    getDownloadUrl: (version: string) => string;
    /** Install from downloaded archive to deps folder. Returns new version. */
    install: (archivePath: string, depsPath: string) => Promise<string>;
}

function nodeExecutable(depsPath: string): string {
    const ext = getPlatform() === 'win32' ? '.exe' : '';
    return path.join(depsPath, 'node', `node${ext}`);
}

function adbExecutable(depsPath: string): string {
    const ext = getPlatform() === 'win32' ? '.exe' : '';
    return path.join(depsPath, 'adb', `adb${ext}`);
}

async function runVersionCommand(exe: string, args: string[], pattern: RegExp): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(exe, args, { timeout: 5000 });
        const match = stdout.match(pattern);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

export function getDependencyDefinitions(): DependencyDefinition[] {
    const platform = getPlatform();
    const arch = getArch();

    return [
        {
            name: 'nodejs',
            displayName: 'Node.js',
            description: 'JavaScript runtime that runs the ws-scrcpy-web server',
            requiresRestart: true,
            pairedWith: 'node-pty',
            checkInstalled: async (depsPath) => {
                return runVersionCommand(nodeExecutable(depsPath), ['--version'], /v([\d.]+)/);
            },
            checkLatest: async () => {
                const res = await fetch('https://nodejs.org/dist/index.json');
                const releases = (await res.json()) as { version: string; lts: string | false }[];
                const lts = releases.find((r) => r.lts !== false);
                return lts ? lts.version.replace(/^v/, '') : null;
            },
            getDownloadUrl: (version) => {
                if (platform === 'win32') {
                    return `https://nodejs.org/dist/v${version}/node-v${version}-win-${arch}.zip`;
                }
                return `https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.tar.gz`;
            },
            install: async (_archivePath, _depsPath) => {
                // Implemented in DependencyManager — extracts archive, copies node binary + node-pty
                throw new Error('Use DependencyManager.installNodejs()');
            },
        },
        {
            name: 'adb',
            displayName: 'ADB (Android Debug Bridge)',
            description: 'Communicates with Android devices (push, shell, tunnel)',
            requiresRestart: false,
            checkInstalled: async (depsPath) => {
                return runVersionCommand(adbExecutable(depsPath), ['--version'], /Version ([\d.]+)/);
            },
            checkLatest: async () => {
                // Google doesn't publish version numbers in a clean API.
                // We check the SDK repository XML for the platform-tools revision.
                const res = await fetch('https://dl.google.com/android/repository/repository2-3.xml');
                const xml = await res.text();
                const match = xml.match(
                    /path="platform-tools"[\s\S]*?<major>(\d+)<\/major>\s*<minor>(\d+)<\/minor>\s*<micro>(\d+)<\/micro>/,
                );
                return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
            },
            getDownloadUrl: (_version) => {
                // Google only provides "latest" URLs, no versioned downloads
                if (platform === 'win32') {
                    return 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
                }
                return 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip';
            },
            install: async (_archivePath, _depsPath) => {
                throw new Error('Use DependencyManager.installAdb()');
            },
        },
        {
            name: 'scrcpy-server',
            displayName: 'scrcpy-server',
            description: 'Runs on Android device to capture screen, audio, and accept input',
            requiresRestart: false,
            checkInstalled: async (_depsPath) => {
                // Read from the Constants.ts compiled value — the server binary is in dist/assets/
                try {
                    const { SERVER_VERSION } = await import('../../common/Constants');
                    return SERVER_VERSION;
                } catch {
                    return null;
                }
            },
            checkLatest: async () => {
                const res = await fetch('https://api.github.com/repos/Genymobile/scrcpy/releases/latest', {
                    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ws-scrcpy-web' },
                });
                const data = (await res.json()) as { tag_name: string };
                return data.tag_name?.replace(/^v/, '') ?? null;
            },
            getDownloadUrl: (version) => {
                return `https://github.com/Genymobile/scrcpy/releases/download/v${version}/scrcpy-server-v${version}`;
            },
            install: async (_archivePath, _depsPath) => {
                throw new Error('Use DependencyManager.installScrcpyServer()');
            },
        },
    ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/dependencyDefinitions.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/DependencyDefinitions.ts src/server/__tests__/dependencyDefinitions.test.ts
git commit -m "feat(deps): add dependency definitions with version check and download URLs"
```

---

## Task 3: Dependency Manager Core

**Files:**
- Create: `src/server/DependencyManager.ts`
- Create: `src/server/__tests__/dependencyManager.test.ts`
- Modify: `src/server/Config.ts` — add `dependenciesPath` getter

- [ ] **Step 1: Add dependenciesPath to Config**

In `src/server/Config.ts`, add to the FlatConfig interface:

```typescript
interface FlatConfig {
    port?: number;
    adbPath?: string;
    dependenciesPath?: string;
    server?: ServerItem[];
}
```

Add to the Config class constructor and getInstance:

```typescript
// In getInstance(), after adbPath resolution:
const dependenciesPath = process.env['DEPS_PATH'] ?? fileConfig.dependenciesPath
    ?? path.resolve(path.dirname(process.argv[1] || '.'), '..', 'dependencies');

this.instance = new Config(servers, adbPath, dependenciesPath);

// Constructor:
constructor(
    private readonly _servers: ServerItem[],
    private readonly _adbPath: string,
    private readonly _dependenciesPath: string,
) {}

// Getter:
public get dependenciesPath(): string {
    return this._dependenciesPath;
}
```

- [ ] **Step 2: Write failing tests for DependencyManager**

```typescript
// src/server/__tests__/dependencyManager.test.ts
import { describe, expect, it } from 'vitest';
import { DependencyManager } from '../DependencyManager';
import { DependencyStatus } from '../../common/DependencyTypes';

describe('DependencyManager', () => {
    it('initializes with all dependencies in unknown state', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const deps = mgr.getAll();
        expect(deps.length).toBe(3);
        expect(deps.every((d) => d.status === DependencyStatus.Unknown)).toBe(true);
    });

    it('getByName returns correct dependency', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const node = mgr.getByName('nodejs');
        expect(node).toBeDefined();
        expect(node!.displayName).toBe('Node.js');
    });

    it('getByName returns undefined for unknown dependency', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        expect(mgr.getByName('nonexistent')).toBeUndefined();
    });

    it('nodejs is marked as requires restart', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const node = mgr.getByName('nodejs');
        expect(node!.requiresRestart).toBe(true);
    });

    it('scrcpy-server is marked as no restart needed', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const scrcpy = mgr.getByName('scrcpy-server');
        expect(scrcpy!.requiresRestart).toBe(false);
    });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/dependencyManager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement DependencyManager**

```typescript
// src/server/DependencyManager.ts
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { type DependencyInfo, DependencyStatus, type UpdateResult, compareVersions } from '../common/DependencyTypes';
import { type DependencyDefinition, getDependencyDefinitions, getPlatform } from './DependencyDefinitions';

const execFileAsync = promisify(execFile);

export class DependencyManager {
    private definitions: DependencyDefinition[];
    private state: Map<string, DependencyInfo> = new Map();

    constructor(private readonly depsPath: string) {
        this.definitions = getDependencyDefinitions();
        for (const def of this.definitions) {
            this.state.set(def.name, {
                name: def.name,
                displayName: def.displayName,
                installedVersion: null,
                latestVersion: null,
                status: DependencyStatus.Unknown,
                description: def.description,
                requiresRestart: def.requiresRestart,
                pairedWith: def.pairedWith,
            });
        }
    }

    getAll(): DependencyInfo[] {
        return Array.from(this.state.values());
    }

    getByName(name: string): DependencyInfo | undefined {
        return this.state.get(name);
    }

    async checkInstalled(name: string): Promise<void> {
        const def = this.definitions.find((d) => d.name === name);
        const info = this.state.get(name);
        if (!def || !info) return;

        try {
            info.installedVersion = await def.checkInstalled(this.depsPath);
        } catch (err: any) {
            info.installedVersion = null;
            info.errorMessage = err.message;
        }
        this.updateStatus(info);
    }

    async checkLatest(name: string): Promise<void> {
        const def = this.definitions.find((d) => d.name === name);
        const info = this.state.get(name);
        if (!def || !info) return;

        info.status = DependencyStatus.Checking;
        try {
            info.latestVersion = await def.checkLatest();
            info.errorMessage = undefined;
        } catch (err: any) {
            info.status = DependencyStatus.Error;
            info.errorMessage = `Version check failed: ${err.message}`;
            return;
        }
        this.updateStatus(info);
    }

    async checkAll(): Promise<void> {
        await Promise.all(this.definitions.map((d) => this.checkInstalled(d.name)));
        await Promise.all(this.definitions.map((d) => this.checkLatest(d.name)));
    }

    async update(name: string): Promise<UpdateResult> {
        const def = this.definitions.find((d) => d.name === name);
        const info = this.state.get(name);
        if (!def || !info) {
            return { success: false, errorMessage: `Unknown dependency: ${name}`, requiresRestart: false };
        }
        if (!info.latestVersion) {
            return { success: false, errorMessage: 'No latest version known. Run check first.', requiresRestart: false };
        }

        info.status = DependencyStatus.Updating;
        const tempDir = path.join(os.tmpdir(), 'ws-scrcpy-web', `update-${name}-${Date.now()}`);

        try {
            fs.mkdirSync(tempDir, { recursive: true });
            const downloadUrl = def.getDownloadUrl(info.latestVersion);
            const archivePath = await this.download(downloadUrl, tempDir);

            let newVersion: string;
            switch (name) {
                case 'nodejs':
                    newVersion = await this.installNodejs(archivePath, info.latestVersion);
                    break;
                case 'adb':
                    newVersion = await this.installAdb(archivePath);
                    break;
                case 'scrcpy-server':
                    newVersion = await this.installScrcpyServer(archivePath, info.latestVersion);
                    break;
                default:
                    throw new Error(`No install handler for ${name}`);
            }

            info.installedVersion = newVersion;
            info.status = DependencyStatus.UpToDate;
            info.errorMessage = undefined;
            return { success: true, newVersion, requiresRestart: def.requiresRestart };
        } catch (err: any) {
            info.status = DependencyStatus.Error;
            info.errorMessage = `Update failed: ${err.message}`;
            return { success: false, errorMessage: err.message, requiresRestart: false };
        } finally {
            // Best-effort cleanup
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }
    }

    private async download(url: string, destDir: string): Promise<string> {
        const filename = url.split('/').pop() || 'download';
        const destPath = path.join(destDir, filename);
        const res = await fetch(url, { redirect: 'follow' });
        if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
        await pipeline(res.body as any, createWriteStream(destPath));
        return destPath;
    }

    private async extractZip(archivePath: string, destDir: string): Promise<void> {
        if (getPlatform() === 'win32') {
            await execFileAsync('powershell', [
                '-NoProfile', '-Command',
                `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
            ]);
        } else {
            await execFileAsync('unzip', ['-o', archivePath, '-d', destDir]);
        }
    }

    private async extractTarGz(archivePath: string, destDir: string): Promise<void> {
        await execFileAsync('tar', ['xzf', archivePath, '-C', destDir]);
    }

    private async installNodejs(archivePath: string, version: string): Promise<string> {
        const extractDir = path.join(path.dirname(archivePath), 'extracted');
        fs.mkdirSync(extractDir, { recursive: true });

        if (archivePath.endsWith('.zip')) {
            await this.extractZip(archivePath, extractDir);
        } else {
            await this.extractTarGz(archivePath, extractDir);
        }

        // Node.js archives contain a top-level directory like node-v24.14.1-win-x64/
        const entries = fs.readdirSync(extractDir);
        const nodeDir = entries.find((e) => e.startsWith('node-'));
        if (!nodeDir) throw new Error('Node.js archive does not contain expected directory');
        const sourceDir = path.join(extractDir, nodeDir);

        const destDir = path.join(this.depsPath, 'node');
        fs.mkdirSync(destDir, { recursive: true });

        // Copy node binary
        const ext = getPlatform() === 'win32' ? '.exe' : '';
        const sourceBin = path.join(sourceDir, `node${ext}`);
        const destBin = path.join(destDir, `node${ext}`);

        // On Windows, rename running binary first
        if (getPlatform() === 'win32' && fs.existsSync(destBin)) {
            const oldBin = `${destBin}.old`;
            try { fs.unlinkSync(oldBin); } catch {}
            fs.renameSync(destBin, oldBin);
        } else if (fs.existsSync(destBin)) {
            fs.unlinkSync(destBin);
        }

        fs.copyFileSync(sourceBin, destBin);
        if (getPlatform() !== 'win32') {
            fs.chmodSync(destBin, 0o755);
        }

        // TODO: Download matching node-pty prebuilt binaries for this Node version
        // For now, node-pty files must be manually placed or copied from npm install

        return version;
    }

    private async installAdb(archivePath: string): Promise<string> {
        const extractDir = path.join(path.dirname(archivePath), 'extracted');
        fs.mkdirSync(extractDir, { recursive: true });
        await this.extractZip(archivePath, extractDir);

        // platform-tools zip contains a platform-tools/ subfolder
        const sourceDir = path.join(extractDir, 'platform-tools');
        if (!fs.existsSync(sourceDir)) throw new Error('ADB archive does not contain platform-tools directory');

        const destDir = path.join(this.depsPath, 'adb');

        // Stop ADB server before replacing files
        const ext = getPlatform() === 'win32' ? '.exe' : '';
        const currentAdb = path.join(destDir, `adb${ext}`);
        if (fs.existsSync(currentAdb)) {
            try { await execFileAsync(currentAdb, ['kill-server']); } catch {}
            // Brief pause to let OS release file locks
            await new Promise((r) => setTimeout(r, 500));
        }

        // Replace all files
        fs.mkdirSync(destDir, { recursive: true });
        for (const file of fs.readdirSync(sourceDir)) {
            const src = path.join(sourceDir, file);
            const dest = path.join(destDir, file);
            if (fs.statSync(src).isFile()) {
                fs.copyFileSync(src, dest);
                if (getPlatform() !== 'win32') fs.chmodSync(dest, 0o755);
            }
        }

        // Detect new version
        const def = this.definitions.find((d) => d.name === 'adb')!;
        const newVersion = await def.checkInstalled(this.depsPath);
        return newVersion || 'unknown';
    }

    private async installScrcpyServer(archivePath: string, version: string): Promise<string> {
        // scrcpy-server is a single binary file (no archive extraction)
        const destPath = path.join(__dirname, 'assets', 'scrcpy-server');

        // The download might be a direct binary or the archive might be the file itself
        fs.copyFileSync(archivePath, destPath);

        return version;
    }

    private updateStatus(info: DependencyInfo): void {
        if (info.installedVersion === null) {
            info.status = DependencyStatus.Error;
            if (!info.errorMessage) info.errorMessage = 'Not installed';
            return;
        }
        if (info.latestVersion === null) {
            info.status = DependencyStatus.Unknown;
            return;
        }
        const cmp = compareVersions(info.installedVersion, info.latestVersion);
        info.status = cmp < 0 ? DependencyStatus.UpdateAvailable : DependencyStatus.UpToDate;
    }

    /** Signal the launcher script to restart the process */
    requestRestart(): void {
        // Write a restart marker file that the launcher script watches
        const markerPath = path.join(this.depsPath, '..', '.restart');
        fs.writeFileSync(markerPath, `${Date.now()}`);
        // Exit the process — the launcher will restart it
        setTimeout(() => process.exit(0), 500);
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/dependencyManager.test.ts`
Expected: 5 tests PASS

- [ ] **Step 6: Build to verify compilation**

Run: `npm run build`
Expected: compiled successfully

- [ ] **Step 7: Commit**

```bash
git add src/server/DependencyManager.ts src/server/__tests__/dependencyManager.test.ts src/server/Config.ts
git commit -m "feat(deps): add DependencyManager with install, check, and update logic"
```

---

## Task 4: HTTP API for Dependencies

**Files:**
- Create: `src/server/api/DependencyApi.ts`
- Modify: `src/server/services/HttpServer.ts` — add API route interception
- Modify: `src/server/index.ts` — initialize DependencyManager

- [ ] **Step 1: Create DependencyApi**

```typescript
// src/server/api/DependencyApi.ts
import type { IncomingMessage, ServerResponse } from 'http';
import type { DependencyManager } from '../DependencyManager';

export class DependencyApi {
    constructor(private readonly manager: DependencyManager) {}

    /** Returns true if this request was handled as an API call */
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/dependencies')) return false;

        res.setHeader('Content-Type', 'application/json');

        try {
            // GET /api/dependencies — list all
            if (req.method === 'GET' && url === '/api/dependencies') {
                const deps = this.manager.getAll();
                res.writeHead(200);
                res.end(JSON.stringify(deps));
                return true;
            }

            // POST /api/dependencies/check — check all for updates
            if (req.method === 'POST' && url === '/api/dependencies/check') {
                await this.manager.checkAll();
                const deps = this.manager.getAll();
                res.writeHead(200);
                res.end(JSON.stringify(deps));
                return true;
            }

            // POST /api/dependencies/:name/update — update specific dependency
            const updateMatch = url.match(/^\/api\/dependencies\/([a-z-]+)\/update$/);
            if (req.method === 'POST' && updateMatch) {
                const name = updateMatch[1];
                const result = await this.manager.update(name);
                res.writeHead(result.success ? 200 : 500);
                res.end(JSON.stringify(result));
                return true;
            }

            // POST /api/dependencies/restart — restart the server
            if (req.method === 'POST' && url === '/api/dependencies/restart') {
                res.writeHead(200);
                res.end(JSON.stringify({ message: 'Restarting...' }));
                this.manager.requestRestart();
                return true;
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err: any) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
            return true;
        }
    }
}
```

- [ ] **Step 2: Modify HttpServer to intercept API routes**

In `src/server/services/HttpServer.ts`, the static file server's request handler needs to check the API first. Add the DependencyApi as an optional handler that runs before the static file server.

Add a static setter for the API handler and check it in the request handler before serving static files:

```typescript
// At top of HttpServer or as a module-level variable:
private static apiHandler: DependencyApi | null = null;

public static setApiHandler(handler: DependencyApi): void {
    HttpServer.apiHandler = handler;
}

// In the request listener (where StaticFileServer handles requests),
// add before the static file handler:
if (HttpServer.apiHandler) {
    const handled = await HttpServer.apiHandler.handle(req, res);
    if (handled) return;
}
```

- [ ] **Step 3: Initialize DependencyManager in server startup**

In `src/server/index.ts`, after Config initialization:

```typescript
import { DependencyManager } from './DependencyManager';
import { DependencyApi } from './api/DependencyApi';
import { Config } from './Config';

// After config init:
const depManager = new DependencyManager(Config.getInstance().dependenciesPath);
const depApi = new DependencyApi(depManager);
HttpServer.setApiHandler(depApi);

// Kick off initial check in background (don't block startup)
depManager.checkAll().catch((err) => console.error('[DependencyManager] Initial check failed:', err));
```

- [ ] **Step 4: Build to verify compilation**

Run: `npm run build`
Expected: compiled successfully

- [ ] **Step 5: Commit**

```bash
git add src/server/api/DependencyApi.ts src/server/services/HttpServer.ts src/server/index.ts
git commit -m "feat(deps): add HTTP API for dependency management"
```

---

## Task 5: Browser UI — Dependency Panel

**Files:**
- Create: `src/app/client/DependencyPanel.ts`
- Create: `src/style/dependencies.css`
- Modify: `src/app/index.ts` — render panel on home page

- [ ] **Step 1: Create DependencyPanel**

```typescript
// src/app/client/DependencyPanel.ts
import type { DependencyInfo, UpdateResult } from '../../common/DependencyTypes';

export class DependencyPanel {
    private container: HTMLElement;
    private tableBody: HTMLTableSectionElement | null = null;

    constructor() {
        this.container = document.createElement('div');
        this.container.id = 'dependency-panel';
        this.container.innerHTML = `
            <div class="dep-header">
                <h2>Dependencies</h2>
                <button class="dep-btn dep-check-all">Check for Updates</button>
            </div>
            <table class="dep-table">
                <thead>
                    <tr>
                        <th>Dependency</th>
                        <th>Installed</th>
                        <th>Latest</th>
                        <th>Status</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        `;
        this.tableBody = this.container.querySelector('tbody');
        this.container.querySelector('.dep-check-all')!.addEventListener('click', () => this.checkAll());
    }

    static async create(): Promise<DependencyPanel> {
        const panel = new DependencyPanel();
        await panel.load();
        return panel;
    }

    getElement(): HTMLElement {
        return this.container;
    }

    private async load(): Promise<void> {
        try {
            const res = await fetch('/api/dependencies');
            const deps: DependencyInfo[] = await res.json();
            this.render(deps);
        } catch (err) {
            this.renderError('Failed to load dependencies');
        }
    }

    private async checkAll(): Promise<void> {
        const btn = this.container.querySelector('.dep-check-all') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Checking...';
        try {
            const res = await fetch('/api/dependencies/check', { method: 'POST' });
            const deps: DependencyInfo[] = await res.json();
            this.render(deps);
        } catch (err) {
            this.renderError('Check failed');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Check for Updates';
        }
    }

    private async updateDep(name: string): Promise<void> {
        const btn = this.container.querySelector(`[data-update="${name}"]`) as HTMLButtonElement;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Updating...';
        }
        try {
            const res = await fetch(`/api/dependencies/${name}/update`, { method: 'POST' });
            const result: UpdateResult = await res.json();
            if (result.success) {
                await this.load(); // Refresh the table
                if (result.requiresRestart) {
                    this.showRestartPrompt();
                }
            } else {
                alert(`Update failed: ${result.errorMessage}`);
                await this.load();
            }
        } catch (err) {
            alert('Update request failed');
            await this.load();
        }
    }

    private async requestRestart(): Promise<void> {
        try {
            await fetch('/api/dependencies/restart', { method: 'POST' });
            // Server will exit — show reconnecting message
            this.container.innerHTML = `
                <div class="dep-restarting">
                    <h2>Restarting...</h2>
                    <p>The server is restarting. This page will reload automatically.</p>
                </div>
            `;
            // Poll until server is back
            this.pollForRestart();
        } catch {
            // Expected — server shut down
            this.pollForRestart();
        }
    }

    private pollForRestart(): void {
        const check = async () => {
            try {
                const res = await fetch('/api/dependencies');
                if (res.ok) {
                    window.location.reload();
                    return;
                }
            } catch {}
            setTimeout(check, 2000);
        };
        setTimeout(check, 3000);
    }

    private showRestartPrompt(): void {
        const existing = this.container.querySelector('.dep-restart-prompt');
        if (existing) return;
        const prompt = document.createElement('div');
        prompt.className = 'dep-restart-prompt';
        prompt.innerHTML = `
            <p>A dependency was updated that requires a restart.</p>
            <button class="dep-btn dep-restart-btn">Restart Now</button>
        `;
        prompt.querySelector('.dep-restart-btn')!.addEventListener('click', () => this.requestRestart());
        this.container.querySelector('.dep-header')!.after(prompt);
    }

    private render(deps: DependencyInfo[]): void {
        if (!this.tableBody) return;
        // Remove restart prompt if no longer needed
        const prompt = this.container.querySelector('.dep-restart-prompt');
        if (prompt) prompt.remove();

        this.tableBody.innerHTML = '';
        for (const dep of deps) {
            const row = document.createElement('tr');
            row.className = `dep-row dep-status-${dep.status}`;
            row.innerHTML = `
                <td>
                    <strong>${dep.displayName}</strong>
                    ${dep.pairedWith ? `<span class="dep-paired">+ ${dep.pairedWith}</span>` : ''}
                    <div class="dep-description">${dep.description}</div>
                </td>
                <td class="dep-version">${dep.installedVersion || 'Not installed'}</td>
                <td class="dep-version">${dep.latestVersion || '—'}</td>
                <td class="dep-status">${this.statusLabel(dep)}</td>
                <td class="dep-action">${this.actionButton(dep)}</td>
            `;
            // Wire update button
            const updateBtn = row.querySelector(`[data-update]`) as HTMLButtonElement | null;
            if (updateBtn) {
                updateBtn.addEventListener('click', () => this.updateDep(dep.name));
            }
            this.tableBody.appendChild(row);
        }
    }

    private statusLabel(dep: DependencyInfo): string {
        switch (dep.status) {
            case 'up-to-date': return '<span class="dep-badge dep-ok">Up to date</span>';
            case 'update-available': return '<span class="dep-badge dep-warn">Update available</span>';
            case 'checking': return '<span class="dep-badge dep-info">Checking...</span>';
            case 'updating': return '<span class="dep-badge dep-info">Updating...</span>';
            case 'error': return `<span class="dep-badge dep-error" title="${dep.errorMessage || ''}">Error</span>`;
            default: return '<span class="dep-badge dep-unknown">Unknown</span>';
        }
    }

    private actionButton(dep: DependencyInfo): string {
        if (dep.status === 'update-available') {
            return `<button class="dep-btn dep-update" data-update="${dep.name}">Update</button>`;
        }
        if (dep.status === 'updating') {
            return '<button class="dep-btn" disabled>Updating...</button>';
        }
        return '';
    }

    private renderError(message: string): void {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = `<tr><td colspan="5" class="dep-error-msg">${message}</td></tr>`;
    }
}
```

- [ ] **Step 2: Create dependencies CSS**

```css
/* src/style/dependencies.css */
#dependency-panel {
    padding: 20px;
    margin-bottom: 20px;
    border-bottom: 1px solid var(--border-color, #444);
}

.dep-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
}

.dep-header h2 {
    margin: 0;
    font-size: 18px;
    color: var(--text-color, #eee);
}

.dep-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
}

.dep-table th {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 2px solid var(--border-color, #444);
    color: var(--text-color-secondary, #aaa);
    font-weight: 600;
}

.dep-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color-light, #333);
    color: var(--text-color, #eee);
    vertical-align: middle;
}

.dep-version {
    font-family: monospace;
    white-space: nowrap;
}

.dep-description {
    font-size: 12px;
    color: var(--text-color-secondary, #aaa);
    margin-top: 2px;
}

.dep-paired {
    font-size: 11px;
    color: var(--text-color-secondary, #aaa);
    margin-left: 6px;
}

.dep-btn {
    padding: 6px 14px;
    border: 1px solid var(--border-color, #555);
    border-radius: 6px;
    background: var(--btn-bg, #2a2a2a);
    color: var(--text-color, #eee);
    cursor: pointer;
    font-size: 13px;
}

.dep-btn:hover:not(:disabled) {
    background: var(--btn-hover-bg, #3a3a3a);
}

.dep-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.dep-update {
    background: var(--accent-bg, #1a6b3a);
    border-color: var(--accent-border, #2a8b4a);
}

.dep-update:hover:not(:disabled) {
    background: var(--accent-hover, #1a8b4a);
}

.dep-badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
}

.dep-ok { background: #1a3a1a; color: #4ade80; }
.dep-warn { background: #3a3a1a; color: #fbbf24; }
.dep-info { background: #1a2a3a; color: #60a5fa; }
.dep-error { background: #3a1a1a; color: #f87171; cursor: help; }
.dep-unknown { background: #2a2a2a; color: #888; }

.dep-restart-prompt {
    background: var(--accent-bg, #1a3a4a);
    border: 1px solid var(--accent-border, #2a5a6a);
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.dep-restart-prompt p {
    margin: 0;
    color: var(--text-color, #eee);
}

.dep-restart-btn {
    background: #b45309 !important;
    border-color: #d97706 !important;
}

.dep-restart-btn:hover:not(:disabled) {
    background: #d97706 !important;
}

.dep-restarting {
    text-align: center;
    padding: 40px;
    color: var(--text-color, #eee);
}

.dep-error-msg {
    text-align: center;
    color: #f87171;
    padding: 20px;
}
```

- [ ] **Step 3: Wire DependencyPanel into the home page**

In `src/app/index.ts`, import the panel and CSS, and render it before the device list. Add to the default (no action) path:

```typescript
import '../style/dependencies.css';
import { DependencyPanel } from './client/DependencyPanel';

// In the default path (where HostTracker.start() is called):
DependencyPanel.create().then((panel) => {
    const devices = document.getElementById('devices');
    if (devices) {
        devices.parentElement!.insertBefore(panel.getElement(), devices);
    } else {
        document.body.prepend(panel.getElement());
    }
});
```

- [ ] **Step 4: Add CSS import to webpack**

In `webpack/ws-scrcpy-web.common.ts`, ensure `dependencies.css` is included (it will be auto-included via the import in `index.ts` — no webpack config change needed since css-loader picks up imports).

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: compiled successfully, `dependencies.css` content appears in bundle.css

- [ ] **Step 6: Manual smoke test**

Start the dev server, open `http://localhost:8000`. Verify:
- Dependency panel appears above the device list
- Three dependencies shown (Node.js, ADB, scrcpy-server)
- "Check for Updates" button triggers version checks
- Status badges update

- [ ] **Step 7: Commit**

```bash
git add src/app/client/DependencyPanel.ts src/style/dependencies.css src/app/index.ts
git commit -m "feat(deps): add dependency panel UI on home page"
```

---

## Task 6: Launcher Scripts

**Files:**
- Create: `start.cmd` (Windows)
- Create: `start.sh` (Linux)

- [ ] **Step 1: Create Windows launcher**

```batch
@echo off
:: ws-scrcpy-web launcher for Windows
:: Runs Node.js from dependencies folder, handles restart on update

setlocal

set "SCRIPT_DIR=%~dp0"
set "NODE=%SCRIPT_DIR%dependencies\node\node.exe"
set "ENTRY=%SCRIPT_DIR%dist\index.js"
set "RESTART_MARKER=%SCRIPT_DIR%.restart"
set "DEPS_PATH=%SCRIPT_DIR%dependencies"

:: Ensure node binary exists
if not exist "%NODE%" (
    echo ERROR: Node.js not found at %NODE%
    echo Run the initial setup or place node.exe in dependencies\node\
    pause
    exit /b 1
)

:: Set environment so the app knows where dependencies live
set "DEPS_PATH=%DEPS_PATH%"

:: Clean up stale restart marker
if exist "%RESTART_MARKER%" del "%RESTART_MARKER%"

:: Clean up old node binary from previous update
if exist "%NODE%.old" del "%NODE%.old"

:loop
echo Starting ws-scrcpy-web...
"%NODE%" "%ENTRY%"
set "EXIT_CODE=%ERRORLEVEL%"

:: Check if restart was requested
if exist "%RESTART_MARKER%" (
    del "%RESTART_MARKER%"
    :: Clean up old node binary if update just happened
    if exist "%NODE%.old" del "%NODE%.old"
    echo Restarting...
    timeout /t 2 /nobreak >nul
    goto loop
)

:: Process exited without restart request — stop
echo ws-scrcpy-web exited with code %EXIT_CODE%
exit /b %EXIT_CODE%
```

- [ ] **Step 2: Create Linux launcher**

```bash
#!/bin/bash
# ws-scrcpy-web launcher for Linux
# Runs Node.js from dependencies folder, handles restart on update

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$SCRIPT_DIR/dependencies/node/node"
ENTRY="$SCRIPT_DIR/dist/index.js"
RESTART_MARKER="$SCRIPT_DIR/.restart"
export DEPS_PATH="$SCRIPT_DIR/dependencies"

# Ensure node binary exists
if [ ! -x "$NODE" ]; then
    echo "ERROR: Node.js not found at $NODE"
    echo "Run the initial setup or place the node binary in dependencies/node/"
    exit 1
fi

# Clean up stale restart marker
rm -f "$RESTART_MARKER"

while true; do
    echo "Starting ws-scrcpy-web..."
    "$NODE" "$ENTRY"
    EXIT_CODE=$?

    # Check if restart was requested
    if [ -f "$RESTART_MARKER" ]; then
        rm -f "$RESTART_MARKER"
        echo "Restarting..."
        sleep 2
        continue
    fi

    # Process exited without restart request — stop
    echo "ws-scrcpy-web exited with code $EXIT_CODE"
    exit $EXIT_CODE
done
```

- [ ] **Step 3: Make Linux script executable**

Run: `chmod +x start.sh`

- [ ] **Step 4: Add to .gitignore — exclude the dependencies folder contents but keep the structure**

Add to `.gitignore`:
```
dependencies/node/
dependencies/adb/
.restart
```

- [ ] **Step 5: Create empty dependency directories with .gitkeep**

```bash
mkdir -p dependencies/node dependencies/adb
touch dependencies/node/.gitkeep dependencies/adb/.gitkeep
```

- [ ] **Step 6: Commit**

```bash
git add start.cmd start.sh dependencies/ .gitignore
git commit -m "feat(deps): add launcher scripts and dependencies folder structure"
```

---

## Task 7: Integration and Documentation

**Files:**
- Modify: `docs/TECHNICAL_GUIDE.md` — add dependency updater section
- Modify: `README.md` — update Quick Start for self-contained mode

- [ ] **Step 1: Update TECHNICAL_GUIDE.md**

Add a new section 13 after the release checklist:

```markdown
## 13. Dependency Updater

### Architecture

The dependency updater manages runtime dependencies (Node.js + node-pty, ADB, scrcpy-server)
through a browser UI on the home page.

**Components:**
- `DependencyDefinitions.ts` — declarative config for each dependency (version sources, download URLs)
- `DependencyManager.ts` — core logic: version detection, remote checking, download, extract, install
- `DependencyApi.ts` — HTTP REST endpoints under `/api/dependencies/`
- `DependencyPanel.ts` — browser-side table UI with status badges and update buttons
- `start.cmd` / `start.sh` — launcher scripts that handle restart after Node.js updates

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/dependencies` | List all dependencies with current status |
| POST | `/api/dependencies/check` | Check all dependencies for updates |
| POST | `/api/dependencies/:name/update` | Download and install update for named dependency |
| POST | `/api/dependencies/restart` | Restart the server (via launcher script) |

### Restart Flow

Node.js cannot replace its own running binary on Windows. The solution:

1. User clicks "Update" for Node.js in the browser
2. Server downloads new Node.js, renames running `node.exe` to `node.exe.old`, copies new binary
3. Server writes `.restart` marker file and exits
4. Launcher script detects marker, deletes old binary, relaunches with new Node.js

### Dependencies Folder Structure

```
dependencies/
  node/       — node.exe (Windows) or node (Linux) + node-pty native files
  adb/        — ADB platform-tools (adb, fastboot, etc.)
```

scrcpy-server lives in `dist/assets/scrcpy-server` (managed by webpack build).
```

- [ ] **Step 2: Update README.md Quick Start**

Add a "Self-Contained Mode" section after the existing Quick Start:

```markdown
## Self-Contained Mode

For deployment without system-wide Node.js or ADB installations:

**Windows:**
```batch
start.cmd
```

**Linux:**
```bash
./start.sh
```

The launcher uses Node.js from `dependencies/node/` and ADB from `dependencies/adb/`.
Use the Dependencies panel on the home page to check for updates and install them.
```

- [ ] **Step 3: Run full test suite and build**

Run: `npm test && npm run build`
Expected: All tests pass, build succeeds

- [ ] **Step 4: Commit**

```bash
git add docs/TECHNICAL_GUIDE.md README.md
git commit -m "docs: add dependency updater architecture and self-contained mode setup"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** All runtime dependencies (Node.js+node-pty, ADB, scrcpy-server) have version checking, download URLs, and install logic. Browser UI shows all three with update controls. Launcher scripts handle restart for both Windows and Linux.
- [x] **Placeholder scan:** No TBD/TODO except the node-pty prebuilt download in installNodejs (documented as TODO with clear scope). All code blocks are complete.
- [x] **Type consistency:** `DependencyInfo`, `DependencyStatus`, `UpdateResult`, `compareVersions` are defined in Task 1 and used consistently in Tasks 3-5. `DependencyDefinition` is defined in Task 2 and consumed by Task 3. `DependencyApi` from Task 4 is wired into HttpServer. `DependencyPanel` from Task 5 is wired into index.ts.
- [x] **node-pty paired update:** Noted in definitions (pairedWith field) and in the UI (shows "+ node-pty" badge). Actual node-pty binary download needs implementation — marked as TODO within installNodejs.
