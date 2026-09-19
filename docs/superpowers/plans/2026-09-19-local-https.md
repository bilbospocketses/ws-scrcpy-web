# Local HTTPS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user turn on HTTPS from Settings, so streaming works from another machine on the LAN instead of only on the serving machine.

**Architecture:** The server already speaks HTTPS — `HttpServer.start()` reads a `servers` array and calls `https.createServer(serverItem.options, …)`, and `Config.parseServerItem` already accepts `certPath`/`keyPath`. This plan adds certificate *acquisition* on top: a vendored `mkcert` binary from our own hardened fork, a `CertService` owning the certificate lifecycle, a `TlsApi` exposing it, a pure `httpExposure` decision function gating plain HTTP, and a Settings panel.

**Tech Stack:** TypeScript, Node 24, `node:sqlite` (`AppSettingsStore`), vitest (unit), Playwright (e2e), biome (lint).

**Spec:** `docs/superpowers/specs/2026-09-18-local-https-design.md` — read it first. The measured facts in it (a click-through cert warning IS a secure context; `mkcert -install` is not needed; `C:\ProgramData\WsScrcpyWeb` grants `BUILTIN\Users` read) are why several tasks below look the way they do.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Local-Dependencies-Only.** `mkcert` resolves from `dependencies/mkcert/<version>/mkcert(.exe)` and **never** from PATH. No `execFile('mkcert', …)` anywhere.
- **Vendor source:** `bilbospocketses/mkcert`, release **`v1.4.4-bt.2`** (our hardened fork, not upstream). Asset names: `mkcert-v1.4.4-bt.2-windows-amd64.exe`, `mkcert-v1.4.4-bt.2-linux-amd64`, `mkcert-v1.4.4-bt.2-linux-arm64`, `mkcert-v1.4.4-bt.2-darwin-amd64`, `mkcert-v1.4.4-bt.2-darwin-arm64`, plus `mkcert-v1.4.4-bt.2-SHA256SUMS.txt`.
- **Runtime npm dependencies stay at two** (`velopack`, `ws`). Do not add one. If a task seems to need a library, it does not.
- **UI text is lowercase**, except device labels, manufacturer/model strings, and home-page section headings.
- **`textContent` / `setAttribute`, never `innerHTML`**, for anything server-supplied. Hardcoded SVG constants are the only exception, following `SettingsHeader.ts`.
- **TDD.** Every task writes the failing test first and runs it to watch it fail. A test that passes on first run is testing the wrong thing.
- **Four mkcert invocation requirements** (spec §2b) apply to every spawn: absolute `-cert-file`/`-key-file`, per-user `CAROOT`, `TRUST_STORES=none`, validated subject.
- **Commands** run from the repo root with `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run <script>` — this repo is worked from parallel sessions and must not rely on cwd.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/DependencyDefinitions.ts` *(modify)* | One new `DependencyDefinition` for mkcert |
| `src/server/tls/certPaths.ts` *(create)* | Where the CA and leaf live, per platform. Pure, no I/O. |
| `src/server/tls/CertService.ts` *(create)* | Certificate lifecycle: state, generate, read CA, revoke |
| `src/server/tls/httpExposure.ts` *(create)* | Pure decision: `(mode, isLoopback) → 'serve' \| 'refuse' \| 'redirect'` |
| `src/server/api/TlsApi.ts` *(create)* | `/api/tls/*` routes, admin-gated |
| `src/server/Config.ts` *(modify)* | Emit the HTTPS `servers` entry; HTTPS port model |
| `src/server/services/HttpServer.ts` *(modify)* | Consult `httpExposure` on the plain-HTTP listener |
| `src/server/index.ts` *(modify)* | Register `TlsApi` |
| `src/app/client/settings/tabs/ServerTab.ts` *(modify)* | The Local HTTPS panel |
| `tests/e2e/local-https.spec.ts` *(create)* | Real-browser secure-context proof |

`certPaths.ts` and `httpExposure.ts` are separate from `CertService.ts` on purpose: both are pure and are the two places where being wrong is expensive (key material in a world-readable directory; locking the user out of Settings). Pure functions make them exhaustively testable without spawning anything.

---

### Task 1: mkcert dependency definition

**Files:**
- Modify: `src/server/DependencyDefinitions.ts`
- Test: `src/server/__tests__/dependencyDefinitions.mkcert.test.ts` *(create)*

**Interfaces:**
- Consumes: the existing `DependencyDefinition` interface (`src/server/DependencyDefinitions.ts:44`), `getPlatform()`, `getArch()`.
- Produces: a definition with `name: 'mkcert'`, installed at `<depsPath>/mkcert/mkcert(.exe)`. Later tasks call `path.join(depsPath, 'mkcert', exeName)`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/__tests__/dependencyDefinitions.mkcert.test.ts
import { describe, expect, it } from 'vitest';
import { getDependencyDefinitions } from '../DependencyDefinitions';

describe('mkcert dependency definition', () => {
    const def = () => getDependencyDefinitions().find((d) => d.name === 'mkcert')!;

    it('is registered', () => {
        expect(def()).toBeDefined();
    });

    it('pins our fork, not upstream — upstream is dormant and unfixed', () => {
        const url = def().getDownloadUrl('v1.4.4-bt.2');
        expect(url).toContain('bilbospocketses/mkcert');
        expect(url).not.toContain('FiloSottile');
    });

    it('asks for an asset name that exists in the release', () => {
        // Real asset names, verified against the published release 2026-09-19.
        const known = [
            'mkcert-v1.4.4-bt.2-windows-amd64.exe',
            'mkcert-v1.4.4-bt.2-linux-amd64',
            'mkcert-v1.4.4-bt.2-linux-arm64',
            'mkcert-v1.4.4-bt.2-darwin-amd64',
            'mkcert-v1.4.4-bt.2-darwin-arm64',
        ];
        const asset = def().getDownloadUrl('v1.4.4-bt.2').split('/').pop()!;
        expect(known).toContain(asset);
    });

    it('carries a fallbackVersion, so a rate-limited lookup still installs something', () => {
        // Same reasoning as scrcpy-server: api.github.com rate-limits at 60/hour
        // unauthenticated, and without this a first run installs nothing silently.
        expect(def().fallbackVersion).toBe('v1.4.4-bt.2');
    });

    it('does not require a restart — nothing is loaded from it in-process', () => {
        expect(def().requiresRestart).toBe(false);
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- dependencyDefinitions.mkcert`
Expected: FAIL — `def()` is `undefined`, so `.getDownloadUrl` throws `TypeError`.

- [ ] **Step 3: Add the definition**

Add to the array returned by `getDependencyDefinitions()` in `src/server/DependencyDefinitions.ts`, following the `scrcpy-server` entry's shape (`:169`):

```typescript
{
    name: 'mkcert',
    displayName: 'mkcert',
    description: 'Issues the local certificate that lets browsers stream over HTTPS on a LAN',
    requiresRestart: false,
    // Our own hardened fork, NOT FiloSottile/mkcert. Upstream has been dormant
    // since 2024-08 and its last release is from 2022; the fork carries five
    // dependency bumps, 28 tests where upstream has none, and fixes for four
    // review findings including an argument-controlled path escape that wrote
    // outside the working directory and still exited 0.
    fallbackVersion: MKCERT_VERSION,
    checkInstalled: async (depsPath) => {
        const exe = path.join(depsPath, 'mkcert', mkcertExeName());
        if (!fs.existsSync(exe)) return null;
        return runVersionCommand(exe, ['-version'], /v?([\d.]+(?:-bt\.\d+)?)/);
    },
    checkLatest: async () => {
        const res = await fetchOkWithRetry(
            'https://api.github.com/repos/bilbospocketses/mkcert/releases/latest',
            VERSION_CHECK_POLICY,
        );
        if (!res) return null;
        const body = (await res.json()) as { tag_name?: string };
        return body.tag_name ?? null;
    },
    getDownloadUrl: (version) =>
        `https://github.com/bilbospocketses/mkcert/releases/download/${version}/${mkcertAssetName(version)}`,
},
```

And these helpers, near `getPlatform()` at the top of the same file:

```typescript
/** The release we vendor. Bump deliberately: it is trust material. */
export const MKCERT_VERSION = 'v1.4.4-bt.2';

export function mkcertExeName(): string {
    return os.platform() === 'win32' ? 'mkcert.exe' : 'mkcert';
}

/**
 * Asset naming in bilbospocketses/mkcert releases. Darwin is included because
 * the matrix publishes it, even though ws-scrcpy-web does not ship macOS yet.
 */
export function mkcertAssetName(version: string): string {
    const plat = os.platform();
    const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
    if (plat === 'win32') return `mkcert-${version}-windows-${arch}.exe`;
    if (plat === 'darwin') return `mkcert-${version}-darwin-${arch}`;
    return `mkcert-${version}-linux-${arch}`;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- dependencyDefinitions.mkcert`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/DependencyDefinitions.ts src/server/__tests__/dependencyDefinitions.mkcert.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(tls): vendor mkcert from our hardened fork"
```

---

### Task 2: Certificate paths, including the Windows ACL problem

**Files:**
- Create: `src/server/tls/certPaths.ts`
- Test: `src/server/tls/certPaths.test.ts`

**Interfaces:**
- Consumes: nothing. Pure.
- Produces: `resolveCertPaths(opts: CertPathOpts): CertPaths` where
  `CertPathOpts = { platform: NodeJS.Platform; dataRoot: string; localAppData?: string; home?: string }`
  and `CertPaths = { caRoot: string; certFile: string; keyFile: string }`. Every path absolute.

**Why this is its own file:** the spec's blocker. `<dataRoot>/tls/ca` on Windows resolves to `C:\ProgramData\WsScrcpyWeb`, whose ACL was measured granting `BUILTIN\Users: ReadAndExecute` by inheritance — and mkcert's `0400` sets only the read-only attribute on Windows, no ACL. That combination puts the CA private key where any local account can read it.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/tls/certPaths.test.ts
import { describe, expect, it } from 'vitest';
import { resolveCertPaths } from './certPaths';

describe('resolveCertPaths', () => {
    it('keeps CAROOT OUT of the shared data root on Windows', () => {
        // C:\ProgramData\WsScrcpyWeb grants BUILTIN\Users ReadAndExecute by
        // inheritance (measured 2026-09-18), and mkcert sets no ACL on Windows,
        // so a CAROOT there is a CA private key any local account can read.
        const p = resolveCertPaths({
            platform: 'win32',
            dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
            localAppData: 'C:\\Users\\jane\\AppData\\Local',
        });
        expect(p.caRoot.toLowerCase()).not.toContain('programdata');
        expect(p.caRoot.toLowerCase()).toContain('appdata\\local');
    });

    it('puts CAROOT under the data root on POSIX, where the mode is real', () => {
        const p = resolveCertPaths({ platform: 'linux', dataRoot: '/data' });
        expect(p.caRoot).toBe('/data/tls/ca');
    });

    it('always returns absolute paths — mkcert writes leaves to the process cwd otherwise', () => {
        for (const opts of [
            { platform: 'linux' as const, dataRoot: '/data' },
            { platform: 'win32' as const, dataRoot: 'C:\\ProgramData\\WsScrcpyWeb', localAppData: 'C:\\Users\\jane\\AppData\\Local' },
        ]) {
            const p = resolveCertPaths(opts);
            for (const v of [p.caRoot, p.certFile, p.keyFile]) {
                expect(v === '' || v.startsWith('/') || /^[A-Za-z]:\\/.test(v)).toBe(true);
            }
        }
    });

    it('keeps the leaf with the data root, so a container volume carries it', () => {
        const p = resolveCertPaths({ platform: 'linux', dataRoot: '/data' });
        expect(p.certFile).toBe('/data/tls/cert.pem');
        expect(p.keyFile).toBe('/data/tls/key.pem');
    });

    it('falls back to HOME on Windows when LOCALAPPDATA is unset', () => {
        const p = resolveCertPaths({
            platform: 'win32',
            dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
            home: 'C:\\Users\\jane',
        });
        expect(p.caRoot.toLowerCase()).toContain('jane');
        expect(p.caRoot.toLowerCase()).not.toContain('programdata');
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- certPaths`
Expected: FAIL — `Cannot find module './certPaths'`.

- [ ] **Step 3: Implement**

```typescript
// src/server/tls/certPaths.ts
import path from 'path';

export interface CertPathOpts {
    platform: NodeJS.Platform;
    dataRoot: string;
    localAppData?: string | undefined;
    home?: string | undefined;
}

export interface CertPaths {
    /** CAROOT — holds rootCA.pem and rootCA-key.pem. */
    caRoot: string;
    /** Absolute leaf certificate path passed as -cert-file. */
    certFile: string;
    /** Absolute leaf key path passed as -key-file. */
    keyFile: string;
}

/**
 * Where the CA and the leaf live.
 *
 * The leaf pair goes in the data root on every platform: it must survive an app
 * update, and in a container it must survive `docker rm`, which is what the
 * /data volume is for.
 *
 * CAROOT is the exception on Windows, and it is not a style choice. mkcert
 * writes the CA key `0400`, but Go maps a Unix mode to the read-only ATTRIBUTE
 * on Windows and sets no ACL at all -- measured 2026-09-18, the generated
 * rootCA-key.pem inherited FullControl for the interactive user. The Windows
 * data root is C:\ProgramData\WsScrcpyWeb, whose ACL grants BUILTIN\Users
 * ReadAndExecute by inheritance. Put those two facts together and a CAROOT
 * there is a CA private key readable by every local account -- who could then
 * mint a certificate for any name that every machine trusting this CA accepts.
 * So on Windows the CA goes in a per-user directory whose inherited ACL is
 * already restrictive.
 *
 * On POSIX the mode does what it says, so the data root is fine at 0700.
 */
export function resolveCertPaths(opts: CertPathOpts): CertPaths {
    const tlsDir = path.join(opts.dataRoot, 'tls');
    const certFile = path.join(tlsDir, 'cert.pem');
    const keyFile = path.join(tlsDir, 'key.pem');

    if (opts.platform === 'win32') {
        const base = opts.localAppData || (opts.home ? path.join(opts.home, 'AppData', 'Local') : '');
        if (!base) {
            throw new Error('cannot resolve a per-user CAROOT on Windows: neither LOCALAPPDATA nor HOME is set');
        }
        return { caRoot: path.join(base, 'WsScrcpyWeb', 'tls', 'ca'), certFile, keyFile };
    }

    return { caRoot: path.join(tlsDir, 'ca'), certFile, keyFile };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- certPaths`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/tls/certPaths.ts src/server/tls/certPaths.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(tls): resolve cert paths, keeping CAROOT off the shared data root on Windows"
```

---

### Task 3: The `httpExposure` decision

**Files:**
- Create: `src/server/tls/httpExposure.ts`
- Test: `src/server/tls/httpExposure.test.ts`

**Interfaces:**
- Consumes: nothing. Pure.
- Produces: `export type HttpExposure = 'open' | 'httpsOnly' | 'redirect'`, `export const HTTP_EXPOSURE_KEY = 'httpExposure'`, and
  `export function decideHttpRequest(mode: HttpExposure, isLoopback: boolean): 'serve' | 'refuse' | 'redirect'`.

**Why pure and exhaustive:** this is the lockout-critical logic. Get it wrong and a user who picked "HTTPS only" cannot reach Settings to pick anything else, with a bad certificate and no way back. The loopback exemption is what makes both narrowed modes recoverable.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/tls/httpExposure.test.ts
import { describe, expect, it } from 'vitest';
import { decideHttpRequest, type HttpExposure } from './httpExposure';

const MODES: HttpExposure[] = ['open', 'httpsOnly', 'redirect'];

describe('decideHttpRequest', () => {
    it('serves everyone in open mode', () => {
        expect(decideHttpRequest('open', true)).toBe('serve');
        expect(decideHttpRequest('open', false)).toBe('serve');
    });

    it('refuses only NON-loopback callers in httpsOnly', () => {
        expect(decideHttpRequest('httpsOnly', false)).toBe('refuse');
        expect(decideHttpRequest('httpsOnly', true)).toBe('serve');
    });

    it('redirects only NON-loopback callers in redirect mode', () => {
        expect(decideHttpRequest('redirect', false)).toBe('redirect');
        expect(decideHttpRequest('redirect', true)).toBe('serve');
    });

    // THE LOCKOUT GUARANTEE. If this ever fails, a user with a broken
    // certificate cannot reach Settings to turn the mode back off, and the
    // Control Menu integration's /api/whoami loopback probe breaks with it.
    it('NEVER withholds plain HTTP from loopback, in any mode', () => {
        for (const mode of MODES) {
            expect(decideHttpRequest(mode, true)).toBe('serve');
        }
    });

    it('treats an unknown persisted mode as open rather than locking anyone out', () => {
        // The value comes out of the database; a hand-edited or
        // future-version row must not brick access.
        expect(decideHttpRequest('nonsense' as HttpExposure, false)).toBe('serve');
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- httpExposure`
Expected: FAIL — `Cannot find module './httpExposure'`.

- [ ] **Step 3: Implement**

```typescript
// src/server/tls/httpExposure.ts

/** How the plain-HTTP listener behaves once a certificate exists. */
export type HttpExposure = 'open' | 'httpsOnly' | 'redirect';

/** app_settings key holding the HttpExposure value. */
export const HTTP_EXPOSURE_KEY = 'httpExposure';

/**
 * What the plain-HTTP listener should do with one request.
 *
 * LOOPBACK IS EXEMPT FROM BOTH NARROWED MODES, and that is the whole design.
 * Without it, a certificate that goes bad -- expired, IP moved under DHCP,
 * CAROOT wiped by a container recreate -- removes the only route to the
 * Settings page that could turn the mode back off, and the recovery becomes
 * hand-editing config.json. It also keeps /api/whoami answering over loopback
 * HTTP, which the Control Menu integration probes.
 *
 * An unrecognised mode serves. The value is read from the database, and a
 * hand-edited or newer-version row must not be able to brick access.
 */
export function decideHttpRequest(mode: HttpExposure, isLoopback: boolean): 'serve' | 'refuse' | 'redirect' {
    if (isLoopback) return 'serve';
    if (mode === 'httpsOnly') return 'refuse';
    if (mode === 'redirect') return 'redirect';
    return 'serve';
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- httpExposure`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/tls/httpExposure.ts src/server/tls/httpExposure.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(tls): http exposure modes, with loopback exempt from both narrowed ones"
```

---

### Task 4: `CertService` — state and generation

**Files:**
- Create: `src/server/tls/CertService.ts`
- Test: `src/server/tls/CertService.test.ts`

**Interfaces:**
- Consumes: `resolveCertPaths` (Task 2), `mkcertExeName` / `MKCERT_VERSION` (Task 1).
- Produces:
  ```typescript
  export type CertSubjectKind = 'ip' | 'hostname';
  export interface CertState { status: 'none' | 'ready'; subject?: string; kind?: CertSubjectKind; notAfter?: string; }
  export interface CertServiceDeps {
      paths: CertPaths;
      mkcertExe: string;
      run: (exe: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stderr: string }>;
      exists: (p: string) => boolean;
      readFile: (p: string) => string;
  }
  export class CertService {
      constructor(deps: CertServiceDeps);
      getState(): CertState;
      generate(kind: CertSubjectKind, value: string): Promise<CertState>;
      caRootPem(): string;
      revoke(): void;
  }
  ```

Dependencies are injected so tests never spawn a real binary. `run` is the only process boundary.

> **AMENDED 2026-09-19 (controller), after a spec-vs-plan pass: the leaf key's permissions are nobody's
> job in this plan, and they must be this task's.**
>
> Spec §2 says the leaf key *"gets the same treatment: an explicit restrictive ACL on Windows rather
> than a `0600` we assume is doing something."* **No task in this plan sets any permission on any key.**
> Task 2 has since moved the Windows leaf into the per-user directory (controller ruling), so Windows is
> handled by directory inheritance — but **POSIX is still unaddressed**: whatever mode mkcert happens to
> choose is all that protects it, and this plan never established what that is.
>
> After a successful generate, this task must make the leaf key owner-only on POSIX
> (`fs.chmodSync(keyFile, 0o600)` via an injected dep so it stays testable), and assert it with a test
> that reads the mode back — skipped on win32.
>
> **Do not write a mode on Windows and assume it did something.** That is the precise mistake the spec
> exists to warn about: Go maps a Unix mode to the read-only attribute there and sets no ACL. On Windows
> the per-user directory is the control, and the test should say so in a comment rather than silently
> skipping.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/tls/CertService.test.ts
import { describe, expect, it, vi } from 'vitest';
import { CertService, type CertServiceDeps } from './CertService';

function makeService(over: Partial<CertServiceDeps> = {}) {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    const deps: CertServiceDeps = {
        paths: {
            caRoot: 'C:\\Users\\jane\\AppData\\Local\\WsScrcpyWeb\\tls\\ca',
            certFile: 'C:\\ProgramData\\WsScrcpyWeb\\tls\\cert.pem',
            keyFile: 'C:\\ProgramData\\WsScrcpyWeb\\tls\\key.pem',
        },
        mkcertExe: 'C:\\app\\dependencies\\mkcert\\mkcert.exe',
        run,
        exists: () => false,
        readFile: () => '',
        ...over,
    };
    return { svc: new CertService(deps), run };
}

describe('CertService.generate', () => {
    it('passes -cert-file and -key-file as ABSOLUTE paths', async () => {
        // mkcert writes leaves to the PROCESS CWD otherwise, and a spawned
        // process inherits whatever cwd it was given.
        const { svc, run } = makeService();
        await svc.generate('ip', '192.168.86.3');
        const args: string[] = run.mock.calls[0][1];
        const cert = args[args.indexOf('-cert-file') + 1];
        const key = args[args.indexOf('-key-file') + 1];
        expect(/^[A-Za-z]:\\|^\//.test(cert)).toBe(true);
        expect(/^[A-Za-z]:\\|^\//.test(key)).toBe(true);
    });

    it('sets CAROOT to the per-user path, not the data root', async () => {
        const { svc, run } = makeService();
        await svc.generate('ip', '192.168.86.3');
        const env: Record<string, string> = run.mock.calls[0][2];
        expect(env.CAROOT.toLowerCase()).not.toContain('programdata');
    });

    it('sets TRUST_STORES=none so a stray JAVA_HOME cannot abort generation', async () => {
        const { svc, run } = makeService();
        await svc.generate('ip', '192.168.86.3');
        expect(run.mock.calls[0][2].TRUST_STORES).toBe('none');
    });

    it('constrains the CA by IP when the subject is an IP', async () => {
        // X.509 applies name constraints PER NAME TYPE. Constraining DNS alone
        // leaves IP addresses entirely unconstrained, and our subject is
        // usually a LAN IP -- so a DNS-only constraint would be theatre.
        const { svc, run } = makeService();
        await svc.generate('ip', '192.168.86.3');
        const args: string[] = run.mock.calls[0][1];
        expect(args).toContain('-name-constraints');
        expect(args[args.indexOf('-name-constraints') + 1]).toContain('192.168.86.3');
    });

    it('names the CA so it is identifiable in a trust store years later', async () => {
        const { svc, run } = makeService();
        await svc.generate('hostname', 'devices.lan');
        const args: string[] = run.mock.calls[0][1];
        expect(args).toContain('-ca-name');
        expect(args[args.indexOf('-ca-name') + 1]).toContain('ws-scrcpy-web');
    });

    it('refuses a subject that failed validation, without spawning anything', async () => {
        const { svc, run } = makeService();
        await expect(svc.generate('ip', '-Hevil.com')).rejects.toThrow(/invalid/i);
        expect(run).not.toHaveBeenCalled();
    });

    it('surfaces mkcert stderr verbatim and writes no state on failure', async () => {
        const run = vi.fn().mockResolvedValue({ code: 1, stderr: 'mkcert: boom' });
        const { svc } = makeService({ run });
        await expect(svc.generate('ip', '192.168.86.3')).rejects.toThrow(/mkcert: boom/);
        expect(svc.getState().status).toBe('none');
    });
});

describe('CertService.getState', () => {
    it('reports none when no leaf exists', () => {
        const { svc } = makeService();
        expect(svc.getState().status).toBe('none');
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- CertService`
Expected: FAIL — `Cannot find module './CertService'`.

- [ ] **Step 3: Implement**

```typescript
// src/server/tls/CertService.ts
import { isConnectAddress } from '../security/deviceInput';
import type { CertPaths } from './certPaths';

export type CertSubjectKind = 'ip' | 'hostname';

export interface CertState {
    status: 'none' | 'ready';
    subject?: string;
    kind?: CertSubjectKind;
    notAfter?: string;
}

export interface CertServiceDeps {
    paths: CertPaths;
    mkcertExe: string;
    run: (exe: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stderr: string }>;
    exists: (p: string) => boolean;
    readFile: (p: string) => string;
}

/**
 * Owns the certificate lifecycle. Every process boundary goes through
 * `deps.run`, so the whole class is testable without spawning mkcert.
 *
 * The four invocation requirements from the fork's code review are enforced
 * HERE rather than at the call site, so there is one place to check them:
 * absolute -cert-file/-key-file, a per-user CAROOT, TRUST_STORES=none, and a
 * validated subject.
 */
export class CertService {
    private state: CertState = { status: 'none' };

    constructor(private readonly deps: CertServiceDeps) {}

    getState(): CertState {
        if (this.state.status === 'ready') return this.state;
        if (this.deps.exists(this.deps.paths.certFile)) return { ...this.state, status: 'ready' };
        return { status: 'none' };
    }

    async generate(kind: CertSubjectKind, value: string): Promise<CertState> {
        // Validated BEFORE the spawn. The fork fixed the path escape this
        // guards against (F3), so this is defence in depth -- but it reverts to
        // load-bearing the moment anyone points this at an upstream binary.
        if (!isConnectAddress(value)) {
            throw new Error(`invalid certificate subject: ${JSON.stringify(value)}`);
        }

        const { caRoot, certFile, keyFile } = this.deps.paths;
        const args = [
            '-cert-file', certFile,
            '-key-file', keyFile,
            '-ca-name', 'ws-scrcpy-web local CA',
            // Constrain what this CA may ever vouch for, so a stolen CA key
            // cannot mint a certificate for an unrelated name. Per name TYPE:
            // an IP subject must constrain IP ranges, because constraining DNS
            // alone leaves IPs unconstrained.
            '-name-constraints', value,
            value,
        ];
        const env: Record<string, string> = { CAROOT: caRoot, TRUST_STORES: 'none' };

        const { code, stderr } = await this.deps.run(this.deps.mkcertExe, args, env);
        if (code !== 0) {
            throw new Error(`mkcert failed (exit ${code}): ${stderr.trim()}`);
        }

        this.state = { status: 'ready', subject: value, kind };
        return this.state;
    }

    caRootPem(): string {
        return this.deps.readFile(`${this.deps.paths.caRoot}/rootCA.pem`);
    }

    revoke(): void {
        this.state = { status: 'none' };
    }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- CertService`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/tls/CertService.ts src/server/tls/CertService.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(tls): CertService, enforcing the four mkcert invocation requirements"
```

---

### Task 5: `TlsApi` routes

**Files:**
- Create: `src/server/api/TlsApi.ts`
- Modify: `src/server/index.ts` (register the handler)
- Test: `src/server/__tests__/tlsApi.test.ts`

**Interfaces:**
- Consumes: `CertService` (Task 4), `requireAdmin(req, res): boolean` (`src/server/auth/requireAdmin.ts:7`), `readJsonBodyStrict`, `makeReqRes` from `./helpers/httpMock`.
- Produces: `export class TlsApi { constructor(getService: () => CertService); handle(req, res): Promise<boolean> }` — matching the `ApiHandler` interface at `src/server/services/HttpServer.ts:17`.

Routes: `GET /api/tls/state`, `POST /api/tls/generate`, `GET /api/tls/ca-root`, `POST /api/tls/revoke`.

> **AMENDED 2026-09-19 (controller), after a spec-vs-plan pass.** Three spec requirements this task
> originally dropped. Each is in the spec and was missing here, so the brief was the defect.
>
> **(a) Rate-limit `GET /api/tls/ca-root`.** Spec §7: the endpoint is "admin-gated … also rate-limited
> and logs each download". The task logs but never limits. A root CA leaving the machine is worth both.
> A small in-memory counter is enough — this is one operator clicking a button, not a public API.
> Add a test that a burst of requests is refused after the limit, and that the limit is per-process
> rather than per-connection.
>
> **(b) `GET /api/tls/state` must also return `candidateIps: string[]`.** Task 8's panel consumes
> `candidateIps` in every one of its tests, and **no task produces it** — the plan simply never assigned
> the work. Spec §6 is explicit that the helper "does not exist yet and must be written", and that
> picking well is not cosmetic: this machine has **nine** IPv4 addresses (VirtualBox, two link-locals,
> WSL, Docker, two VPN adapters) and exactly one is reachable from a phone. Write it as a pure function
> taking `os.networkInterfaces()`-shaped input so it is testable without a network: RFC1918 only,
> exclude CGNAT `100.64/10` (Tailscale and carriers share it), exclude link-local `169.254/16`, and
> return **all** candidates rather than only a winner — the panel shows them and the user overrides.
> Test it against a fixture containing this machine's actual nine-address shape.
>
> **(c) The generate route must skip the `allowedHosts` write for an IP subject.** Spec Resolved
> Decision 2: a hostname subject needs the entry or requests are refused as DNS-rebinding, but a raw IP
> **already passes** the host check, and appending one would recreate exactly the confusion issue #691
> was about — a user reading `allowedHosts: ["192.168.86.3"]` reasonably concludes IPs belong there.
> Add the write for `kind === 'hostname'` only, say so in the response so the panel can tell the user,
> and test that an IP subject writes nothing.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/__tests__/tlsApi.test.ts
import { describe, expect, it, vi } from 'vitest';
import { TlsApi } from '../api/TlsApi';
import { makeReqRes } from './helpers/httpMock';

vi.mock('../auth/requireAdmin', () => ({ requireAdmin: vi.fn(() => true) }));
import { requireAdmin } from '../auth/requireAdmin';

function makeApi(over: Record<string, unknown> = {}) {
    const svc = {
        getState: vi.fn(() => ({ status: 'none' })),
        generate: vi.fn(async () => ({ status: 'ready', subject: '192.168.86.3', kind: 'ip' })),
        caRootPem: vi.fn(() => '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n'),
        revoke: vi.fn(),
        ...over,
    };
    return { api: new TlsApi(() => svc as never), svc };
}

describe('TlsApi', () => {
    it('does not claim urls outside /api/tls', async () => {
        const { api } = makeApi();
        const r = makeReqRes('GET', '/api/devices');
        expect(await api.handle(r.req, r.res)).toBe(false);
    });

    it('is admin-gated — handing out a root CA must not be anonymous', async () => {
        vi.mocked(requireAdmin).mockReturnValueOnce(false);
        const { api, svc } = makeApi();
        const r = makeReqRes('GET', '/api/tls/ca-root');
        expect(await api.handle(r.req, r.res)).toBe(true);
        expect(svc.caRootPem).not.toHaveBeenCalled();
    });

    it('serves the CA as a download, not inline', async () => {
        const { api } = makeApi();
        const r = makeReqRes('GET', '/api/tls/ca-root');
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect(r.getHeader('content-disposition')).toContain('attachment');
    });

    it('rejects a generate with a missing subject, without calling the service', async () => {
        const { api, svc } = makeApi();
        const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip' });
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(400);
        expect(svc.generate).not.toHaveBeenCalled();
    });

    it('does not echo a rejected subject back to the caller', async () => {
        const generate = vi.fn().mockRejectedValue(new Error('invalid certificate subject: "-Hevil.com"'));
        const { api } = makeApi({ generate });
        const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '-Hevil.com' });
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(400);
        expect(JSON.stringify(r.getJson())).not.toContain('evil.com');
    });

    it('returns the new state on a successful generate', async () => {
        const { api } = makeApi();
        const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '192.168.86.3' });
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect((r.getJson() as { status: string }).status).toBe('ready');
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- tlsApi`
Expected: FAIL — `Cannot find module '../api/TlsApi'`.

- [ ] **Step 3: Implement**

```typescript
// src/server/api/TlsApi.ts
import type { IncomingMessage, ServerResponse } from 'http';
import { requireAdmin } from '../auth/requireAdmin';
import { Logger } from '../Logger';
import type { CertService, CertSubjectKind } from '../tls/CertService';
import { readJsonBodyStrict, sendInternalError } from './utils';

const log = Logger.for('TlsApi');
const PREFIX = '/api/tls';

export class TlsApi {
    constructor(private readonly getService: () => CertService) {}

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        let pathname: string;
        try {
            pathname = new URL(req.url || '', 'http://localhost').pathname;
        } catch {
            return false;
        }
        if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;

        // Admin-gated as a whole, placed BEFORE the route table so a route
        // added later cannot land ungated. Handing out a root CA is the exact
        // shape of a malware delivery step; it does not get an anonymous
        // endpoint even though this CA is only dangerous to someone who
        // installs it.
        if (!requireAdmin(req, res)) return true;

        const svc = this.getService();
        try {
            if (req.method === 'GET' && pathname === `${PREFIX}/state`) {
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(200);
                res.end(JSON.stringify(svc.getState()));
                return true;
            }

            if (req.method === 'GET' && pathname === `${PREFIX}/ca-root`) {
                const pem = svc.caRootPem();
                log.info('CA root downloaded');
                res.setHeader('Content-Type', 'application/x-pem-file');
                res.setHeader('Content-Disposition', 'attachment; filename="ws-scrcpy-web-local-ca.pem"');
                res.writeHead(200);
                res.end(pem);
                return true;
            }

            if (req.method === 'POST' && pathname === `${PREFIX}/generate`) {
                const body = await readJsonBodyStrict<{ kind?: unknown; value?: unknown }>(req);
                const kind = body.kind === 'hostname' ? 'hostname' : 'ip';
                const value = typeof body.value === 'string' ? body.value.trim() : '';
                res.setHeader('Content-Type', 'application/json');
                if (!value) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'value is required' }));
                    return true;
                }
                try {
                    const state = await svc.generate(kind as CertSubjectKind, value);
                    res.writeHead(200);
                    res.end(JSON.stringify(state));
                } catch {
                    // Deliberately does NOT echo the message: it can contain the
                    // caller's own input, which would land in their DOM.
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'that address could not be used for a certificate' }));
                }
                return true;
            }

            if (req.method === 'POST' && pathname === `${PREFIX}/revoke`) {
                svc.revoke();
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true }));
                return true;
            }

            res.setHeader('Content-Type', 'application/json');
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'no such tls route' }));
            return true;
        } catch (e) {
            sendInternalError(res, e);
            return true;
        }
    }
}
```

Then register it in `src/server/index.ts`, beside the others (after `const pairingApi = …` at `:172`):

```typescript
const tlsApi = new TlsApi(() => CertService.getInstance());
HttpServer.addApiHandler(tlsApi);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- tlsApi`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/TlsApi.ts src/server/index.ts src/server/__tests__/tlsApi.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(tls): admin-gated /api/tls routes"
```

---

### Task 6: Wire `httpExposure` into the plain-HTTP listener

**Files:**
- Modify: `src/server/services/HttpServer.ts`
- Test: `src/server/__tests__/httpExposureWiring.test.ts`

**Interfaces:**
- Consumes: `decideHttpRequest`, `HTTP_EXPOSURE_KEY` (Task 3); `isLoopback` (already used by `ServerShutdownApi.ts:109`); `Config.getInstance().db.appSettings.get(key)`.
- Produces: no new exports. Behaviour only.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/__tests__/httpExposureWiring.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createHttpRequestHandler } from '../services/HttpServer';
import { makeReqRes } from './helpers/httpMock';

// The handler is built with serverIsTls=false, i.e. the PLAIN-HTTP listener.
function plainHandler(mode: string) {
    vi.stubGlobal('__TEST_HTTP_EXPOSURE__', mode);
    return createHttpRequestHandler([], () => {}, false);
}

describe('plain-HTTP listener under each exposure mode', () => {
    it('serves a LAN caller in open mode', async () => {
        const h = plainHandler('open');
        const r = makeReqRes('GET', '/', undefined, {}, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).not.toBe(421);
    });

    it('refuses a LAN caller in httpsOnly', async () => {
        const h = plainHandler('httpsOnly');
        const r = makeReqRes('GET', '/', undefined, {}, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).toBe(421);
    });

    it('redirects a LAN caller in redirect mode', async () => {
        const h = plainHandler('redirect');
        const r = makeReqRes('GET', '/', undefined, {}, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).toBe(302);
        expect(r.getHeader('location')).toMatch(/^https:/);
    });

    it('SERVES LOOPBACK IN EVERY MODE — the lockout guarantee', async () => {
        for (const mode of ['open', 'httpsOnly', 'redirect']) {
            const h = plainHandler(mode);
            const r = makeReqRes('GET', '/', undefined, {}, { remoteAddress: '127.0.0.1' });
            await h(r.req, r.res);
            expect(r.getStatus(), `mode ${mode}`).not.toBe(421);
            expect(r.getStatus(), `mode ${mode}`).not.toBe(302);
        }
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- httpExposureWiring`
Expected: FAIL — the `httpsOnly` case returns a normal status, not 421, because nothing consults the mode yet.

- [ ] **Step 3: Implement**

In `createHttpRequestHandler` (`src/server/services/HttpServer.ts:30`), before the request gate and the API chain, add — **only when `serverIsTls` is false**:

```typescript
// Plain-HTTP exposure. Runs BEFORE the API chain so a narrowed mode applies
// to every route uniformly, including static assets.
//
// Loopback is exempt in every mode; see decideHttpRequest. Without that, a
// certificate that goes bad removes the only route to the Settings page that
// could turn the mode back off.
if (!serverIsTls) {
    const mode = readHttpExposure();
    const decision = decideHttpRequest(mode, isLoopback(req.socket?.remoteAddress ?? ''));
    // (readHttpExposure and httpsPort are defined below in this same file)
    if (decision === 'refuse') {
        // 421 Misdirected Request: the right name on the wrong listener.
        res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('this server is configured for https only. open it over https, or browse from the machine itself.');
        return;
    }
    if (decision === 'redirect') {
        const host = (req.headers.host ?? '').split(':')[0];
        res.writeHead(302, { Location: `https://${host}:${httpsPort()}${req.url ?? '/'}` });
        res.end();
        return;
    }
}
```

And the two helpers it uses, as module-level functions in the same file:

```typescript
/**
 * The persisted exposure mode. Defaults to 'open', so a fresh install and a
 * database that has never seen this key both behave exactly as today.
 */
function readHttpExposure(): HttpExposure {
    try {
        const v = Config.getInstance().db.appSettings.get(HTTP_EXPOSURE_KEY);
        return v === 'httpsOnly' || v === 'redirect' ? v : 'open';
    } catch {
        // A database that will not answer must not be able to refuse requests.
        return 'open';
    }
}

/** The port the redirect target lives on. Independent of the HTTP port. */
function httpsPort(): number {
    const https = Config.getInstance().servers.find((s) => s.secure);
    return https?.port ?? DEFAULT_HTTPS_PORT;
}
```

Both fail **open** on purpose: an unreadable setting or a missing HTTPS entry must degrade to serving
plain HTTP, never to refusing it. A feature that can lock the user out when its own storage misbehaves is
worse than the problem it solves.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- httpExposureWiring`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the whole suite — this task changes every request**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test`
Expected: PASS. A failure here is a real regression: this code is on the path of every plain-HTTP request in the app.

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/services/HttpServer.ts src/server/__tests__/httpExposureWiring.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(tls): apply the http exposure mode on the plain listener"
```

---

### Task 7: The HTTPS listener entry and the port model

**Files:**
- Modify: `src/server/Config.ts` (near `resolveServers`, `:505-530`)
- Test: `src/server/__tests__/configHttpsServers.test.ts`

**Interfaces:**
- Consumes: `resolveCertPaths` (Task 2), the existing `ServerItem` shape accepted by `parseServerItem` (`src/server/Config.ts:521`).
- Produces: `Config.getInstance().servers` containing a second `{ secure: true, port, options: { certPath, keyPath } }` entry when a certificate exists.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/__tests__/configHttpsServers.test.ts
import { describe, expect, it } from 'vitest';
import { buildServers } from '../Config';

describe('buildServers', () => {
    it('emits only HTTP when no certificate exists', () => {
        const servers = buildServers({ httpPort: 8000, certExists: false, certFile: '', keyFile: '', httpsPort: 8443 });
        expect(servers).toHaveLength(1);
        expect(servers[0]!.secure).toBe(false);
    });

    it('adds an HTTPS entry alongside HTTP once a certificate exists', () => {
        const servers = buildServers({
            httpPort: 8000, certExists: true,
            certFile: '/data/tls/cert.pem', keyFile: '/data/tls/key.pem', httpsPort: 8443,
        });
        expect(servers).toHaveLength(2);
        expect(servers.find((s) => s.secure)!.port).toBe(8443);
        expect(servers.find((s) => !s.secure)!.port).toBe(8000);
    });

    it('does NOT move the https port when the http port changes', () => {
        // Independent defaults. Setting HTTP to 80 must not imply HTTPS 443 --
        // the user sets that explicitly or not at all.
        const servers = buildServers({
            httpPort: 80, certExists: true,
            certFile: '/data/tls/cert.pem', keyFile: '/data/tls/key.pem', httpsPort: 8443,
        });
        expect(servers.find((s) => s.secure)!.port).toBe(8443);
    });

    it('passes certPath/keyPath, which parseServerItem already reads', () => {
        const servers = buildServers({
            httpPort: 8000, certExists: true,
            certFile: '/data/tls/cert.pem', keyFile: '/data/tls/key.pem', httpsPort: 8443,
        });
        const https = servers.find((s) => s.secure)!;
        expect(https.options).toMatchObject({ certPath: '/data/tls/cert.pem', keyPath: '/data/tls/key.pem' });
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- configHttpsServers`
Expected: FAIL — `buildServers` is not exported from `../Config`.

- [ ] **Step 3: Implement**

Add to `src/server/Config.ts`, and call it from `resolveServers` where `return [{ secure: false, port }]` currently is (`:518`):

```typescript
export interface BuildServersOpts {
    httpPort: number;
    httpsPort: number;
    certExists: boolean;
    certFile: string;
    keyFile: string;
}

/**
 * The listener set. HTTP is always present -- the HTTPS entry is added only
 * when a certificate actually exists on disk.
 *
 * The two ports are INDEPENDENT. Setting HTTP to 80 does not imply HTTPS 443;
 * HTTPS stays on its own default until the user sets it explicitly. Coupling
 * them would move a port the user never touched.
 *
 * AMENDED 2026-09-19: `certExists` must mean READABLE, not merely present. Spec's error table
 * requires "cert/key unreadable at boot -> HTTPS listener is skipped, HTTP still starts", and a
 * file that exists but cannot be opened (wrong ACL after a profile move, a half-written file) would
 * otherwise pass an existence check and then crash `https.createServer` at boot. The caller must
 * probe readability, not `fs.existsSync`.
 *
 * A missing or unreadable certificate yields HTTP alone rather than a boot
 * failure: an optional feature must never be able to stop the app starting.
 */
export function buildServers(opts: BuildServersOpts): ServerItem[] {
    const http: ServerItem = { secure: false, port: opts.httpPort };
    if (!opts.certExists) return [http];
    return [
        http,
        {
            secure: true,
            port: opts.httpsPort,
            options: { certPath: opts.certFile, keyPath: opts.keyFile },
        },
    ];
}

/** HTTPS default. Deliberately not derived from the HTTP port. */
export const DEFAULT_HTTPS_PORT = 8443;
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- configHttpsServers`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/Config.ts src/server/__tests__/configHttpsServers.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(tls): emit the https listener entry with an independent port"
```

---

### Task 8: The Settings → Server panel

**Files:**
- Modify: `src/app/client/settings/tabs/ServerTab.ts`
- Modify: `src/style/home.css` (panel styles)
- Test: `src/app/client/settings/__tests__/localHttpsPanel.test.ts`

**Interfaces:**
- Consumes: `GET /api/tls/state`, `POST /api/tls/generate`, `GET /api/tls/ca-root` (Task 5). The tab's existing staged-save pattern — read `ServerTab.ts` before writing, and follow it rather than inventing a second save mechanism.
- Produces: no exports consumed by later tasks.

**Notifications this task must render** (spec §"UI notifications"), each at the point the matching mistake gets made:

| # | Trigger | Text (lowercase) |
|---|---|---|
| 2 | always, beside `allowedHosts` | `allowedHosts takes domain names only. raw ip addresses already work, and it does not affect streaming.` |
| 3 | cert exists, page is on an untrusted-CA origin | `this browser does not trust the certificate yet. install the ca below to remove the warning — streaming already works.` |
| 4 | cert subject is an IP not matching any local interface | `this certificate names <ip>, which is no longer an address of this machine. regenerate, or switch to a hostname.` |
| 5 | port field < 1024 on linux/darwin | `ports below 1024 need elevated privileges on this platform; the server may fail to start.` |
| 6 | selecting a narrowed exposure mode | `plain http will stop answering other machines. this machine keeps working over localhost, so you cannot lock yourself out.` |
| 7 | selecting a narrowed exposure mode | `the server will restart and any active streams will drop.` |
| 8 | after generating for a hostname | `this name must resolve on every machine that connects — add it to their hosts file or your local dns.` |
| 9 | cert `notAfter` is within 30 days | `this certificate expires on <date>. regenerate before then, or streaming stops working from other machines.` |

Notification **9** is the spec's renewal decision — warn at 30 days, **never regenerate silently**. Do
not reuse the dependency-update badge for it: that badge means "a bundled tool has an update", and
overloading it with "your TLS is expiring" makes both vaguer.

- [ ] **Step 1: Write the failing test**

```typescript
// @vitest-environment jsdom
// src/app/client/settings/__tests__/localHttpsPanel.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildLocalHttpsPanel } from '../tabs/ServerTab';

const state = (over = {}) => ({ status: 'none', ...over });

describe('local https panel', () => {
    it('offers the machine IP prefilled, so the common case is one click', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        const input = el.querySelector<HTMLInputElement>('[data-tls-subject]')!;
        expect(input.value).toBe('192.168.86.3');
    });

    it('warns that a sub-1024 port needs privileges on linux', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'linux',
        });
        const port = el.querySelector<HTMLInputElement>('[data-tls-port]')!;
        port.value = '443';
        port.dispatchEvent(new Event('input'));
        expect(el.textContent).toMatch(/elevated privileges/i);
    });

    it('promises no lockout when a narrowed mode is selected', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready' })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        el.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.click();
        expect(el.textContent).toMatch(/cannot lock yourself out/i);
        expect(el.textContent).toMatch(/server will restart/i);
    });

    it('tells the user streaming ALREADY works when the CA is untrusted', async () => {
        // The measured fact that makes this panel honest: a click-through cert
        // warning is still a secure context. Someone seeing a browser warning
        // assumes it is broken and stops; this is where that gets corrected.
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready' })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
            caTrusted: false,
        });
        expect(el.textContent).toMatch(/streaming already works/i);
    });

    it('says a hostname must resolve on every client', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', kind: 'hostname', subject: 'devices.lan' })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.textContent).toMatch(/must resolve on every machine/i);
    });

    it('uses textContent for the subject — it is user input echoed back', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', subject: '<img src=x onerror=alert(1)>' })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.querySelector('img')).toBeNull();
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- localHttpsPanel`
Expected: FAIL — `buildLocalHttpsPanel` is not exported from `../tabs/ServerTab`.

- [ ] **Step 3: Implement**

Read `src/app/client/settings/tabs/ServerTab.ts` first and follow its existing staging/save conventions. Export `buildLocalHttpsPanel(deps)` building a section with: a subject radio (IP prefilled / hostname), a port field, a **generate** button, a **download CA certificate** link to `/api/tls/ca-root`, a per-OS trust-instructions accordion, and the exposure radio with an **ok** button. Render notifications 2–8 from the table above at their stated triggers. Use `textContent` for every server-supplied string.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- localHttpsPanel`
Expected: PASS, 6 tests.

- [ ] **Step 5: Lint and type-check**

Run: `npx --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" tsc --noEmit -p "C:/Users/jscha/source/repos/ws-scrcpy-web/tsconfig.json"` then `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/settings/tabs/ServerTab.ts src/style/home.css src/app/client/settings/__tests__/localHttpsPanel.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(tls): local https panel in settings, with its notifications"
```

---

### Task 9: End-to-end secure-context proof

**Files:**
- Create: `tests/e2e/local-https.spec.ts`
- Modify: `docs/smoke-tests/smoke-test.md` and `docs/smoke-tests/automation-coverage.md`

**Interfaces:**
- Consumes: the whole stack. No new exports.

**Why this task cannot be skipped:** jsdom applies no stylesheet and has no WebCodecs, so every unit test in this plan can pass while the feature does not work in a browser. This is the only test that proves the point of the feature. It is also the test class that caught a real user-facing bug in the dependency-badge work — a class rule silently defeating the `hidden` attribute.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/e2e/local-https.spec.ts
import { expect, test } from '@playwright/test';

// The origin MUST NOT be loopback: http://localhost is a secure context on its
// own, so a pass there proves nothing about the certificate.
const LAN_ORIGIN = process.env.QA_LAN_HTTPS_ORIGIN; // e.g. https://192.168.86.3:8443

test.describe('local https', () => {
    test.skip(!LAN_ORIGIN, 'QA_LAN_HTTPS_ORIGIN not set');

    test('a generated certificate yields a secure context with a working decoder', async ({ browser }) => {
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        await page.goto(LAN_ORIGIN!);

        const probe = await page.evaluate(async () => ({
            isSecureContext: window.isSecureContext,
            hasVideoDecoder: typeof VideoDecoder !== 'undefined',
            h264: typeof VideoDecoder === 'undefined'
                ? false
                : (await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E', codedWidth: 1280, codedHeight: 720 })).supported,
        }));

        expect(probe.isSecureContext).toBe(true);
        expect(probe.hasVideoDecoder).toBe(true);
        // isConfigSupported, not just presence: a decoder that exists but
        // cannot configure would pass a typeof check and still not stream.
        expect(probe.h264).toBe(true);
        await ctx.close();
    });

    test('plain http on the same LAN address is NOT a secure context', async ({ browser }) => {
        // The control. Without it, a pass above cannot be distinguished from a
        // browser that reports isSecureContext true everywhere.
        const plain = LAN_ORIGIN!.replace(/^https:/, 'http:').replace(/:\d+$/, ':8000');
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(plain);
        const secure = await page.evaluate(() => window.isSecureContext);
        expect(secure).toBe(false);
        await ctx.close();
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test:e2e -- local-https`
Expected: FAIL (or skip if `QA_LAN_HTTPS_ORIGIN` is unset — set it to the HTTPS origin of a server with a generated certificate and re-run; a skip is not a pass).

- [ ] **Step 3: Make it pass**

No new production code should be needed. If it fails, the failure is real and belongs to an earlier task.

- [ ] **Step 4: Add the smoke rows**

Add to `docs/smoke-tests/smoke-test.md` and the coverage register, following the existing row format: generate-for-IP then stream from another machine; install the CA and confirm the warning disappears; each exposure mode including that loopback still answers; and the DHCP-moved-IP notice.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add tests/e2e/local-https.spec.ts docs/smoke-tests/
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "test(e2e): prove a generated cert gives a secure context on a LAN origin"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`, `docs/TECHNICAL_GUIDE.md`, `CHANGELOG.md`

- [ ] **Step 1: README** — in the Access-control section (which already names the two gates), add that Local HTTPS now exists as a third option alongside a reverse proxy, and that it does not replace the proxy for anything beyond a home LAN.

- [ ] **Step 2: TECHNICAL_GUIDE** — a section covering `CertService`, `certPaths` and the Windows CAROOT reasoning, `httpExposure` and the loopback exemption, and the four mkcert invocation requirements. Add the new files to the Key Files table.

- [ ] **Step 3: CHANGELOG** — one entry under `## [Unreleased]`. **Do not type a `## [version]` heading**; the bump promotes Unreleased and aborts if the heading already exists.

- [ ] **Step 4: Verify the changelog landed in the right section**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" diff origin/main -- CHANGELOG.md | grep -c "^-[^-]"   # expect 0
```

Then assert *which section* the entry is in, not only that nothing was deleted — a rebase across a release cut appends into the just-stamped version block with zero deletions and no conflict.

- [ ] **Step 5: Run the full suite, tsc and lint**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test` then `tsc --noEmit` then `npm run lint`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add README.md docs/TECHNICAL_GUIDE.md CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(tls): document local https, the CAROOT reasoning and the exposure modes"
```

---

## Self-Review

**Spec coverage.** §1 vendored mkcert → Task 1. §2 CertService + storage + Windows ACL → Tasks 2, 4. §2b invocation requirements → Task 4 (asserted in tests, not merely described). §2c new flags → Task 4. §3 listener wiring → Task 7. §4 port model → Task 7. §5 exposure modes → Tasks 3, 6. §6 subject IP/hostname → Tasks 4, 8. §7 CA download + trust instructions → Tasks 5, 8. UI notifications → Task 8 (all nine). Error handling → Tasks 4, 5, 7. Testing → Tasks 1–9. Resolved decision 1 (warn at 30 days) → Task 8, notification 9. Resolved decision 3 (bind-mount CAROOT validation) → Task 9's smoke rows.

**Resolved decision 2 is the one to watch.** "Enabling HTTPS auto-adds the subject to `allowedHosts`" is **not** implemented by any task above, deliberately — for an **IP** subject the spec requires *skipping* the write, since raw IPs already pass the host check and appending one would recreate the exact confusion issue #691 was about. Only a **hostname** subject needs it. Whoever implements Task 4 should add it there, gated on `kind === 'hostname'`, with a test asserting the IP path writes nothing.

**Placeholders.** None. Every code step carries real code; Task 8 step 3 and Task 10 describe prose changes where code blocks do not apply.

**Type consistency.** `CertPaths { caRoot, certFile, keyFile }` is used identically in Tasks 2, 4 and 7. `HttpExposure` and `decideHttpRequest` match between Tasks 3 and 6. `CertState` matches between Tasks 4, 5 and 8. `mkcertExeName()` is defined in Task 1 and used as Task 4's `mkcertExe`. `readHttpExposure()` and `httpsPort()` are defined in Task 6 step 3, where they are used.
