# Linux AppImage self-update (local mode) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Linux local-mode in-app updates apply + relaunch deterministically by downloading the published AppImage, verifying its SHA-256 against the release `SHA256SUMS`, and swapping it via the out-of-mount launcher helper — replacing Velopack's broken `UpdateNix` apply — and make the upgrading overlay render in the browser top layer.

**Architecture:** Discovery stays on Velopack (version detection only; the unused nupkg download is skipped on Linux). On apply, the Node server downloads the release AppImage to a `dataRoot` staging dir, verifies it against the release `SHA256SUMS`, and spawns the already-staged launcher helper in a new `--linux-apply` mode; the helper waits for the server to exit, backs up + swaps `$APPIMAGE`, and relaunches it. The client reuses PR #246's reconnect-poll handoff, with the overlay upgraded to a top-layer `<dialog>`. Windows + Linux service mode are untouched.

**Tech Stack:** TypeScript (Node 24 http server, global `fetch`, `node:crypto`), Rust (launcher), vanilla TS DOM client, vitest + cargo test.

**Spec:** `docs/specs/2026-06-01-linux-appimage-self-update-design.md`

---

## Windows-freeze invariant

Every change is reached only on Linux: the Node changes are behind `this.platform !== 'win32'` (and the existing service-mode early-return guarantees the new apply branch is Linux-*local* only), and the Rust helper is `#[cfg(target_os = "linux")]`. `launcher/src/operation_server.rs`, the Windows `applyUpdate` operation-server branch, the Windows `handleApply` redirect, and the service-mode branch are not edited. **Run `npx vitest run` after every Node/client task and confirm the Windows operation-server + service-mode apply tests stay green.**

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/server/linuxUpdateAssets.ts` | Pure helpers: asset name, release URL, `SHA256SUMS` parse | Create |
| `src/server/verifySha256.ts` | Stream-hash a file + compare | Create |
| `src/server/downloadToFile.ts` | Download a URL to disk / as text (injectable fetch) | Create |
| `src/server/UpdateService.ts` | Skip nupkg download on Linux; rewrite Linux-local `applyUpdate` | Modify |
| `src/app/client/UpgradingOverlay.ts` | Render as a top-layer `<dialog>` (`showModal`) | Modify |
| `launcher/src/linux_apply.rs` | `--linux-apply` helper: wait-pid, backup, swap, relaunch | Create |
| `launcher/src/main.rs` | Register + dispatch `linux_apply` (Linux only) | Modify |

---

## Task 1: Skip the unused Velopack nupkg download on Linux

**Files:**
- Modify: `src/server/UpdateService.ts` (the `checkForUpdates` autoUpdate branch, ~lines 365–372)
- Test: `src/server/__tests__/UpdateService.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the `describe('UpdateService', …)` block (mirror the existing construction style of the other tests in this file):

```ts
it('checkForUpdates (linux): autoUpdate=true does NOT download the nupkg; status=ready', async () => {
    Config.getInstance().updateAppConfig({ autoUpdate: true });
    const downloadUpdateAsync = vi.fn(async () => undefined);
    const mgr = fakeMgr({
        checkForUpdatesAsync: async () => fakeUpdateInfo('0.2.0'),
        downloadUpdateAsync,
    });
    const svc = new UpdateService({
        platform: 'linux',
        installRoot: path.join('/fake', 'mount', 'usr'),
        existsSync: () => true,
        updateManagerFactory: () => mgr,
        setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
        clearIntervalFn: () => undefined,
    });
    process.env['APPIMAGE'] = '/home/u/Downloads/App.AppImage';
    svc.init();
    await svc.checkForUpdates();
    expect(svc.getStatus().status).toBe('ready');
    expect(downloadUpdateAsync).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/__tests__/UpdateService.test.ts -t "does NOT download the nupkg"`
Expected: FAIL — `downloadUpdateAsync` IS called (current code calls `downloadIfNeeded` when `autoUpdate` is true regardless of platform).

- [ ] **Step 3: Implement the Linux skip**

In `checkForUpdates`, replace the autoUpdate branch:

```ts
            const cfg = Config.getInstance().getAppConfig();
            if (cfg.autoUpdate) {
                await this.downloadIfNeeded();
            } else {
                // autoUpdate disabled: surface "available" via status='ready' but no download yet.
                // waitExitThenApplyUpdate handles undownloaded updates internally on Apply.
                this.state.status = 'ready';
            }
```

with:

```ts
            const cfg = Config.getInstance().getAppConfig();
            // On Linux our apply downloads the published AppImage directly, so the
            // Velopack nupkg is never used — never pre-download it (saves ~60 MB per
            // check). On Windows, keep the autoUpdate pre-download. autoUpdate=false
            // also lands in the else. Availability is surfaced via status='ready'.
            if (cfg.autoUpdate && this.platform !== 'linux') {
                await this.downloadIfNeeded();
            } else {
                this.state.status = 'ready';
            }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/server/__tests__/UpdateService.test.ts`
Expected: PASS (the new test + all existing UpdateService tests; the Windows autoUpdate-download test still passes because its platform is win32).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/UpdateService.ts src/server/__tests__/UpdateService.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(linux): skip unused Velopack nupkg auto-download on Linux"
```

---

## Task 2: Linux release-asset helpers (URL + SHA256SUMS parse)

Pure functions, no I/O — unit-testable in isolation.

**Files:**
- Create: `src/server/linuxUpdateAssets.ts`
- Test: `src/server/__tests__/linuxUpdateAssets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { linuxAppImageAssetName, releaseAssetUrl, parseSha256Sums } from '../linuxUpdateAssets';

describe('linuxUpdateAssets', () => {
    it('builds the channel-suffixed AppImage asset name', () => {
        expect(linuxAppImageAssetName('beta')).toBe('WsScrcpyWeb-linux-beta.AppImage');
        expect(linuxAppImageAssetName('stable')).toBe('WsScrcpyWeb-linux-stable.AppImage');
    });

    it('builds the release download URL', () => {
        expect(releaseAssetUrl('bilbospocketses', '0.1.30-beta.26', 'WsScrcpyWeb-linux-beta.AppImage'))
            .toBe('https://github.com/bilbospocketses/ws-scrcpy-web/releases/download/v0.1.30-beta.26/WsScrcpyWeb-linux-beta.AppImage');
    });

    it('parses SHA256SUMS by basename (path-prefixed entries)', () => {
        const sums =
            'ec1f3987e95cba5c179b14a1c04aa355a7710d72dc31c8eca9cb39f62ad9c7bc  ./linux-final/WsScrcpyWeb-linux-beta.AppImage\n' +
            '952bebf9fd143145b258348c14d942fe76c9b4018f64f7444c2fdbe22f5aee34  ./linux-final/WsScrcpyWeb-0.1.30-beta.26-linux-beta-full.nupkg\n';
        expect(parseSha256Sums(sums, 'WsScrcpyWeb-linux-beta.AppImage'))
            .toBe('ec1f3987e95cba5c179b14a1c04aa355a7710d72dc31c8eca9cb39f62ad9c7bc');
    });

    it('returns null when the asset is absent', () => {
        expect(parseSha256Sums('deadbeef  ./x/other.bin\n', 'WsScrcpyWeb-linux-beta.AppImage')).toBeNull();
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/__tests__/linuxUpdateAssets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { UpdateChannel } from '../common/ConfigEvents';

/** Published Linux AppImage asset name (channel-suffixed, NOT version-suffixed). */
export function linuxAppImageAssetName(channel: UpdateChannel): string {
    return `WsScrcpyWeb-linux-${channel}.AppImage`;
}

/** GitHub release asset download URL for a given version tag (`v<version>`). */
export function releaseAssetUrl(githubOwner: string, version: string, assetName: string): string {
    return `https://github.com/${githubOwner}/ws-scrcpy-web/releases/download/v${version}/${assetName}`;
}

/**
 * Parse `sha256sum`-style text and return the lowercase hex digest for `filename`,
 * matched by BASENAME (our SHA256SUMS lists path-prefixed entries like
 * `./linux-final/<asset>`). Returns null if not found.
 */
export function parseSha256Sums(text: string, filename: string): string | null {
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // "<64 hex>  <name>"  (two spaces; "*" binary marker tolerated)
        const m = trimmed.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
        if (!m) continue;
        const base = m[2].trim().split('/').pop();
        if (base === filename) return m[1].toLowerCase();
    }
    return null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/server/__tests__/linuxUpdateAssets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/linuxUpdateAssets.ts src/server/__tests__/linuxUpdateAssets.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): release-asset URL + SHA256SUMS parse helpers"
```

---

## Task 3: SHA-256 file verification

**Files:**
- Create: `src/server/verifySha256.ts`
- Test: `src/server/__tests__/verifySha256.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifySha256 } from '../verifySha256';

describe('verifySha256', () => {
    let file: string;
    let goodHash: string;
    beforeAll(() => {
        file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sha-')), 'blob');
        const data = Buffer.from('hello appimage');
        fs.writeFileSync(file, data);
        goodHash = createHash('sha256').update(data).digest('hex');
    });
    afterAll(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

    it('returns true for a matching hash (case-insensitive)', async () => {
        expect(await verifySha256(file, goodHash.toUpperCase())).toBe(true);
    });
    it('returns false for a wrong hash', async () => {
        expect(await verifySha256(file, '0'.repeat(64))).toBe(false);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/__tests__/verifySha256.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { createHash } from 'crypto';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { createReadStream } from 'fs';

/** Stream-hash `filePath` (sha256) and return the lowercase hex digest. */
export function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/** True iff `filePath`'s sha256 equals `expectedHex` (case-insensitive). */
export async function verifySha256(filePath: string, expectedHex: string): Promise<boolean> {
    const actual = await sha256File(filePath);
    return actual.toLowerCase() === expectedHex.toLowerCase();
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/server/__tests__/verifySha256.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/verifySha256.ts src/server/__tests__/verifySha256.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat: streaming sha256 file verification helper"
```

---

## Task 4: Download-to-file + fetch-text helpers

**Files:**
- Create: `src/server/downloadToFile.ts`
- Test: `src/server/__tests__/downloadToFile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadToFile, fetchText } from '../downloadToFile';

describe('downloadToFile', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

    it('streams a 200 response body to disk', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')); dirs.push(dir);
        const dest = path.join(dir, 'out.bin');
        const fetchFn = (async () => new Response('payload-bytes')) as unknown as typeof fetch;
        await downloadToFile('https://example/x', dest, fetchFn);
        expect(fs.readFileSync(dest, 'utf8')).toBe('payload-bytes');
    });

    it('throws on a non-2xx response', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')); dirs.push(dir);
        const fetchFn = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
        await expect(downloadToFile('https://example/x', path.join(dir, 'o'), fetchFn)).rejects.toThrow(/404/);
    });

    it('fetchText returns the body text', async () => {
        const fetchFn = (async () => new Response('line1\nline2')) as unknown as typeof fetch;
        expect(await fetchText('https://example/s', fetchFn)).toBe('line1\nline2');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/__tests__/downloadToFile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';

export type FetchFn = typeof fetch;

/**
 * Download `url` to `destPath`. Buffers the body then writes (artifacts are
 * ~60 MB — acceptable transient memory; keeps the helper simple and the write
 * atomic-per-file). Throws on a non-2xx response or network error.
 */
export async function downloadToFile(url: string, destPath: string, fetchFn: FetchFn = fetch): Promise<void> {
    const res = await fetchFn(url);
    if (!res.ok) {
        throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(destPath, buf);
}

/** Fetch `url` and return the body as text. Throws on a non-2xx response. */
export async function fetchText(url: string, fetchFn: FetchFn = fetch): Promise<string> {
    const res = await fetchFn(url);
    if (!res.ok) {
        throw new Error(`fetch failed: ${res.status} ${res.statusText} for ${url}`);
    }
    return res.text();
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/server/__tests__/downloadToFile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/downloadToFile.ts src/server/__tests__/downloadToFile.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat: download-to-file + fetch-text helpers (injectable fetch)"
```

---

## Task 5: Rewrite the Linux-local `applyUpdate` branch

The existing service-mode block returns first, so the `this.platform !== 'win32'` block is reached only for Linux **local** mode. We replace its body (the old `waitExitThenApplyUpdate(restart=true)`) with download → verify → spawn-helper. We also add a `fetchFn` injection seam.

**Files:**
- Modify: `src/server/UpdateService.ts` (imports, `UpdateServiceOptions`, constructor, `applyUpdate` Linux branch ~lines 433–440)
- Test: `src/server/__tests__/UpdateService.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('applyUpdate (linux local): downloads + verifies + spawns helper; mode reconnect', async () => {
    const { createHash } = await import('crypto');
    Config.getInstance().updateAppConfig({ autoUpdate: false, installMode: 'user', channel: 'beta', githubOwner: 'bilbospocketses' });
    const appImageBytes = Buffer.from('NEW-APPIMAGE-CONTENT');
    const goodHash = createHash('sha256').update(appImageBytes).digest('hex');
    const sums = `${goodHash}  ./linux-final/WsScrcpyWeb-linux-beta.AppImage\n`;
    const fetchFn = vi.fn(async (url: string) =>
        url.endsWith('.AppImage') ? new Response(appImageBytes) : new Response(sums),
    ) as unknown as typeof fetch;
    const spawnMock = vi.mocked(child_process.spawn);
    spawnMock.mockClear();

    const mgr = fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo('0.1.30-beta.26') });
    const svc = new UpdateService({
        platform: 'linux',
        installRoot: path.join('/fake', 'mount', 'usr'),
        existsSync: () => true,
        updateManagerFactory: () => mgr,
        setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
        clearIntervalFn: () => undefined,
        fetchFn,
    });
    process.env['APPIMAGE'] = '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage';
    svc.init();
    await svc.checkForUpdates();
    expect(svc.getStatus().status).toBe('ready');

    const result = await svc.applyUpdate();
    expect(result.redirectPort).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = spawnMock.mock.calls[0]!;
    expect(String(bin)).toMatch(/control[\\/]operation-server[\\/]ws-scrcpy-web-launcher\.exe$/);
    expect(argv).toEqual(expect.arrayContaining(['--linux-apply', '--target', '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage']));
});

it('applyUpdate (linux local): SHA mismatch aborts, no helper spawn', async () => {
    Config.getInstance().updateAppConfig({ autoUpdate: false, installMode: 'user', channel: 'beta', githubOwner: 'bilbospocketses' });
    const sums = `${'0'.repeat(64)}  ./linux-final/WsScrcpyWeb-linux-beta.AppImage\n`;
    const fetchFn = vi.fn(async (url: string) =>
        url.endsWith('.AppImage') ? new Response(Buffer.from('CORRUPT')) : new Response(sums),
    ) as unknown as typeof fetch;
    const spawnMock = vi.mocked(child_process.spawn);
    spawnMock.mockClear();

    const mgr = fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo('0.1.30-beta.26') });
    const svc = new UpdateService({
        platform: 'linux', installRoot: path.join('/fake', 'mount', 'usr'), existsSync: () => true,
        updateManagerFactory: () => mgr, setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
        clearIntervalFn: () => undefined, fetchFn,
    });
    process.env['APPIMAGE'] = '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage';
    svc.init();
    await svc.checkForUpdates();
    await expect(svc.applyUpdate()).rejects.toThrow(/mismatch/i);
    expect(spawnMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/__tests__/UpdateService.test.ts -t "linux local"`
Expected: FAIL — `fetchFn` is not an accepted option / the branch still calls `waitExitThenApplyUpdate`, so spawn isn't called and `mode` assertions fail.

- [ ] **Step 3: Add the `fetchFn` seam + imports**

The three helper modules live next to `UpdateService.ts` in `src/server/`, so add these server-relative imports alongside the existing ones:

```ts
import { linuxAppImageAssetName, releaseAssetUrl, parseSha256Sums } from './linuxUpdateAssets';
import { verifySha256 } from './verifySha256';
import { downloadToFile, fetchText } from './downloadToFile';
```

Add to `UpdateServiceOptions`:

```ts
    /** Override global fetch for tests (download + SHA256SUMS). Default: global fetch. */
    fetchFn?: typeof fetch;
```

Add the field + constructor assignment (next to the other `private readonly` fields / assignments):

```ts
    private readonly fetchFn: typeof fetch;
```
```ts
        this.fetchFn = opts.fetchFn ?? fetch;
```

- [ ] **Step 4: Replace the Linux-local apply branch**

Replace:

```ts
        if (this.platform !== 'win32') {
            this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, true);
            return { redirectPort: null };
        }
```

with:

```ts
        // Linux local mode: Velopack 1.0.1's UpdateNix apply fails on our AppImage
        // (it re-derives a locator from `--root <appimage>` and fails the
        // UpdateExePath check — see docs/specs/2026-06-01-linux-appimage-self-update-design.md).
        // Replace it: download the published AppImage, verify its SHA-256 against the
        // release SHA256SUMS, then hand off to the out-of-mount helper to swap
        // $APPIMAGE + relaunch. (Service mode returned above, so this is local-only.)
        if (this.platform !== 'win32') {
            const config = Config.getInstance();
            const appCfg = config.getAppConfig();
            const version = this.state.availableVersion;
            if (!version) {
                throw new Error('apply: no available version resolved');
            }
            const assetName = linuxAppImageAssetName(appCfg.channel);
            const appImageUrl = releaseAssetUrl(appCfg.githubOwner, version, assetName);
            const sumsUrl = releaseAssetUrl(appCfg.githubOwner, version, 'SHA256SUMS');

            const dataRoot = config.dataRoot ?? path.dirname(config.dependenciesPath);
            const stagingDir = path.join(dataRoot, 'control', 'update-staging');
            await fs.promises.mkdir(stagingDir, { recursive: true });
            const stagedPath = path.join(stagingDir, `${assetName}.new`);

            log.info(`applyUpdate(linux): downloading ${appImageUrl}`);
            await downloadToFile(appImageUrl, stagedPath, this.fetchFn);
            const sumsText = await fetchText(sumsUrl, this.fetchFn);
            const expected = parseSha256Sums(sumsText, assetName);
            if (!expected) {
                await fs.promises.rm(stagedPath, { force: true });
                throw new Error(`apply: SHA256SUMS has no entry for ${assetName}`);
            }
            const ok = await verifySha256(stagedPath, expected);
            if (!ok) {
                await fs.promises.rm(stagedPath, { force: true });
                throw new Error(`apply: SHA-256 mismatch for ${assetName} — aborting`);
            }

            const appImagePath = process.env['APPIMAGE'] ?? '';
            // The launcher stages this helper copy (named *.exe even on Linux) to
            // dataRoot on every boot — outside the AppImage mount, so it survives exit.
            const helperPath = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
            const child = spawn(
                helperPath,
                ['--linux-apply', '--staged', stagedPath, '--target', appImagePath, '--wait-pid', String(process.pid)],
                { detached: true, stdio: 'ignore' },
            );
            child.unref();
            log.info(`applyUpdate(linux): spawned helper pid ${child.pid} to swap ${appImagePath}`);
            return { redirectPort: null };
        }
```

Also clean up the rollback backup on the next Linux launch. In `init()`, immediately after the production-mode check confirms an installed Linux app (just before the `try { … this.factory(…) }` block), best-effort remove a leftover `<$APPIMAGE>.bak` — a successful boot means the previous version's backup is no longer needed:

```ts
        // Linux: a successful relaunch means the previous version's rollback
        // backup is safe to drop. Best-effort; ignore failures.
        if (this.platform !== 'win32') {
            const appImage = process.env['APPIMAGE'];
            if (appImage) {
                void fs.promises.rm(`${appImage}.bak`, { force: true }).catch(() => undefined);
            }
        }
```

- [ ] **Step 5: Run the targeted + full UpdateService suite**

Run: `npx vitest run src/server/__tests__/UpdateService.test.ts`
Expected: PASS — both new Linux tests + all existing Windows/service apply tests (the service-mode `waitExitThenApplyUpdate(false)` and Windows operation-server tests are unchanged).

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: tsc clean; entire suite green.

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/UpdateService.ts src/server/__tests__/UpdateService.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(linux): hand-rolled AppImage apply (download+verify+helper), not Velopack UpdateNix"
```

---

## Task 6: Render the upgrading overlay in the top layer (Bug A)

The Settings modal is a native `<dialog>` opened with `showModal()` → browser top layer. A `z-index:99999` body div can't sit above it. Re-implement `UpgradingOverlay` as a `<dialog>` opened with `showModal()` (shown last → on top).

**Files:**
- Modify: `src/app/client/UpgradingOverlay.ts`
- Test: `src/app/client/__tests__/UpgradingOverlay.test.ts`

- [ ] **Step 1: Update the test (mock showModal like the other dialog tests)**

Replace the existing `UpgradingOverlay.test.ts` body with:

```ts
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { UpgradingOverlay } from '../UpgradingOverlay';

beforeAll(() => {
    // jsdom doesn't implement the top-layer dialog methods.
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

describe('UpgradingOverlay', () => {
    it('mounts a top-layer <dialog> via showModal and removes cleanly', () => {
        const spy = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
        const o = new UpgradingOverlay();
        o.mount();
        const el = document.querySelector('dialog.upgrading-overlay');
        expect(el).not.toBeNull();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(el!.textContent).toContain('updating');
        o.setState('timeout', 'http://localhost:8000/');
        expect(document.querySelector('.upgrading-overlay')!.textContent).toContain('http://localhost:8000/');
        o.remove();
        expect(document.querySelector('.upgrading-overlay')).toBeNull();
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/client/__tests__/UpgradingOverlay.test.ts`
Expected: FAIL — current overlay creates a `div`, not a `dialog`, and never calls `showModal`.

- [ ] **Step 3: Implement the top-layer overlay**

Change the field type and `mount`/`remove` in `UpgradingOverlay.ts`:

```ts
    private root: HTMLDialogElement | null = null;
    private msg: HTMLParagraphElement | null = null;

    mount(): void {
        if (this.root) return;
        const root = document.createElement('dialog');
        root.className = 'upgrading-overlay';
        // Inline critical styles so it renders even if the stylesheet is mid-reload.
        // It's a <dialog> in the top layer (via showModal), so it sits above the
        // Settings dialog regardless of z-index. Fill the viewport; kill default
        // dialog chrome.
        root.style.cssText =
            'position:fixed;inset:0;width:100vw;height:100vh;max-width:100vw;max-height:100vh;' +
            'box-sizing:border-box;border:none;margin:0;padding:2rem;display:flex;' +
            'flex-direction:column;align-items:center;justify-content:center;gap:1rem;' +
            'background:rgba(0,0,0,0.85);color:#fff;font:14px/1.5 system-ui,sans-serif;text-align:center;';
        const spinner = document.createElement('div');
        spinner.className = 'upgrading-overlay-spinner';
        const msg = document.createElement('p');
        msg.className = 'upgrading-overlay-msg';
        root.append(spinner, msg);
        document.body.appendChild(root);
        if (typeof root.showModal === 'function') {
            root.showModal();
        }
        this.root = root;
        this.msg = msg;
        this.setState('applying');
    }

    remove(): void {
        if (this.root) {
            if (this.root.open && typeof this.root.close === 'function') {
                this.root.close();
            }
            this.root.remove();
        }
        this.root = null;
        this.msg = null;
    }
```

`setState` and `runUpgradingHandoff` are unchanged.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/app/client/__tests__/UpgradingOverlay.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean + green.

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/UpgradingOverlay.ts src/app/client/__tests__/UpgradingOverlay.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(linux): render upgrading overlay as a top-layer <dialog> (above Settings)"
```

---

## Task 7: Rust `--linux-apply` helper

**Files:**
- Create: `launcher/src/linux_apply.rs`
- Modify: `launcher/src/main.rs` (register module + dispatch)
- Test: inline `#[cfg(test)]` in `linux_apply.rs`

> **Note (host caveat):** this module is `#[cfg(target_os = "linux")]`; it does NOT compile or test on the Windows dev host. It is built + tested by the **Linux** CI leg (`cargo test` on the Linux runner) and confirmed by the real-Linux verification in Task 8. On Windows, `cargo build` simply excludes it.

- [ ] **Step 1: Write `linux_apply.rs` with its failing tests**

```rust
// §41 — Linux local-mode in-app update apply. Velopack 1.0.1's UpdateNix apply
// fails on our AppImage (it re-derives a locator from `--root <appimage>` and
// fails the UpdateExePath check). Instead the Node server downloads + verifies
// the new AppImage, then spawns THIS helper (the launcher copy staged in
// dataRoot, outside the mount) to swap $APPIMAGE + relaunch.
// See docs/specs/2026-06-01-linux-appimage-self-update-design.md.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::log;

/// Dispatch: if argv contains `--linux-apply`, handle it and return Some(exit_code).
pub fn handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--linux-apply") {
        return None;
    }
    Some(run(args))
}

fn arg_value<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).map(|s| s.as_str())
}

fn run(args: &[String]) -> i32 {
    let staged = match arg_value(args, "--staged") {
        Some(s) => PathBuf::from(s),
        None => { log::error("linux-apply: missing --staged"); return 2; }
    };
    let target = match arg_value(args, "--target") {
        Some(s) => PathBuf::from(s),
        None => { log::error("linux-apply: missing --target"); return 2; }
    };
    let wait_pid = arg_value(args, "--wait-pid").and_then(|s| s.parse::<u32>().ok());
    log::info(&format!("linux-apply: staged={staged:?} target={target:?} wait_pid={wait_pid:?}"));

    if let Some(pid) = wait_pid {
        wait_for_pid_exit(pid, Duration::from_secs(60));
    }

    match swap_appimage(&staged, &target) {
        Ok(()) => { log::info("linux-apply: swap ok, relaunching"); relaunch(&target); 0 }
        Err(e) => { log::error(&format!("linux-apply: swap failed: {e}")); 1 }
    }
}

/// `<target>.bak`
pub fn backup_path(target: &Path) -> PathBuf {
    let mut s = target.as_os_str().to_os_string();
    s.push(".bak");
    PathBuf::from(s)
}

/// Back up `target` -> `<target>.bak`, move `staged` over `target`, chmod 0755.
/// On a move failure after backup, restore the backup. Pure file ops — unit-tested.
pub fn swap_appimage(staged: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if !staged.exists() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "staged file missing"));
    }
    let backup = backup_path(target);
    if target.exists() {
        // rename within-fs; fall back to copy for cross-fs.
        std::fs::rename(target, &backup)
            .or_else(|_| std::fs::copy(target, &backup).map(|_| ()))?;
    }
    let moved = std::fs::rename(staged, target)
        .or_else(|_| std::fs::copy(staged, target).and_then(|_| std::fs::remove_file(staged)).map(|_| ()));
    if let Err(e) = moved {
        if backup.exists() { let _ = std::fs::rename(&backup, target); }
        return Err(e);
    }
    std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

/// Poll until `/proc/<pid>` disappears or `timeout` elapses. No libc dependency.
fn wait_for_pid_exit(pid: u32, timeout: Duration) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if !Path::new(&format!("/proc/{pid}")).exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    log::error(&format!("linux-apply: pid {pid} still alive after {timeout:?}; proceeding anyway"));
}

/// Spawn the new AppImage detached; the helper then exits.
fn relaunch(target: &Path) {
    match std::process::Command::new(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => log::info(&format!("linux-apply: relaunched {target:?} (pid {})", child.id())),
        Err(e) => log::error(&format!("linux-apply: relaunch failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_replaces_target_and_backs_up_old() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("App.AppImage");
        let staged = tmp.path().join("App.AppImage.new");
        std::fs::write(&target, b"OLD").unwrap();
        std::fs::write(&staged, b"NEW").unwrap();

        swap_appimage(&staged, &target).unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"NEW");
        assert_eq!(std::fs::read(backup_path(&target)).unwrap(), b"OLD");
        assert!(!staged.exists(), "staged file consumed");
    }

    #[test]
    fn swap_errors_and_preserves_target_when_staged_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("App.AppImage");
        std::fs::write(&target, b"OLD").unwrap();
        let staged = tmp.path().join("does-not-exist.new");

        assert!(swap_appimage(&staged, &target).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"OLD", "target untouched on error");
    }

    #[test]
    fn arg_value_reads_following_token() {
        let args = vec!["x".into(), "--target".into(), "/a/b".into()];
        assert_eq!(arg_value(&args, "--target"), Some("/a/b"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }
}
```

- [ ] **Step 2: Register + dispatch in `main.rs`**

Add the module declaration near the other `mod` lines (e.g. after `mod operation_server;`):

```rust
#[cfg(target_os = "linux")]
mod linux_apply;
```

In `fn main()`, add the dispatch alongside the other `handle(&args)` early-exits (e.g. right after the `unzip_handler::handle` block):

```rust
    // Linux in-app update apply helper (spawned by the Node server in dataRoot,
    // outside the AppImage mount). Swaps $APPIMAGE + relaunches. Linux-only.
    #[cfg(target_os = "linux")]
    if let Some(code) = linux_apply::handle(&args) {
        log::info(&format!("linux-apply exiting with code {code}"));
        std::process::exit(code);
    }
```

- [ ] **Step 3: Verify (Linux toolchain only)**

On a Linux host / CI leg:
Run: `cargo test -p ws-scrcpy-web-launcher linux_apply`
Expected: 3 tests pass.

On the Windows dev host (module is cfg'd out):
Run: `cargo build --workspace`
Expected: builds (the module + dispatch are excluded on Windows).

> If the launcher crate name differs, use the name from `launcher/Cargo.toml`'s `[package] name`.

- [ ] **Step 4: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/linux_apply.rs launcher/src/main.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): --linux-apply launcher helper (swap AppImage + relaunch)"
```

---

## Task 8: Final verification + Windows-freeze review

- [ ] **Step 1: Full typecheck + suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; **all** tests pass, including the pre-existing Windows operation-server + service-mode apply tests.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: webpack build succeeds (server + client bundles include the new modules).

- [ ] **Step 3: Windows-freeze review (manual)**

Confirm `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" diff main -- launcher/src/operation_server.rs` is empty, and that the `applyUpdate` Windows operation-server branch + `handleApply` redirect + the service-mode `waitExitThenApplyUpdate(...false)` branch are byte-identical to `main`.

- [ ] **Step 4: Real-Linux verification (Fedora, user mode)**

Cut a fix beta via the bump-PR → Auto Release pipeline (e.g. beta.27 then a no-op beta.28 target, or beta.27→whatever-is-next). Install beta.<N> in user mode, click update:
- The upgrading overlay is **visible** (above any Settings dialog).
- `$APPIMAGE` is rewritten (size/mtime change; reported version becomes beta.<N+1>); the app relaunches on the new version and the browser reconnects.
- `<dataRoot>/control/update-staging/` no longer holds the consumed `.new` (the helper renamed it into place); `$APPIMAGE.bak` is created during the swap and removed on the next Linux launch by the `init()` cleanup added in Task 5.
- `/tmp/velopack.log` shows **no** new `UpdateNix` apply attempt (the updater is no longer invoked for apply).

---

## Out of scope (separate task sets)

- Linux **service-mode** (user-service + system-service) update apply.
- Items 32 (service uninstall teardown) + 33 (system-scope SELinux AVC).
- Velopack 1.0.1 → 1.1.1 bump (item 31) — decoupled from this fix.
