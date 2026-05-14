# Dev/install layout parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align dev-mode dependencies-path resolution with the launcher's `<dataRoot>/dependencies/` contract on Windows, so `npm run build && npm start` from the repo reads and writes the exact same ProgramData state an MSI install does — eliminating the class of "dev sees a different layout than installed app" debugging traps.

**Architecture:** Single resolver edit (`Config.ts::resolveDependenciesPath`) gains a `platform` parameter and, on Windows, returns `<dataRoot>/dependencies/` regardless of dev-tell, matching `launcher/src/paths.rs:65-68`. A new `prestart` step stages `assets/scrcpy-server` into `seed/scrcpy-server/` so `DependencyManager.promoteSeedScrcpyServer` finds it in dev exactly the way it does in install. Orphan files removed from repo.

**Tech Stack:** TypeScript (Node server), vitest, ESM scripts under `scripts/`.

**Spec:** `docs/superpowers/specs/2026-05-14-dev-install-layout-parity-design.md`

**Branch:** `feat/dev-install-layout-parity` (already created off `main`, spec committed as `2c83742`).

---

## File Structure

**Modify:**
- `src/server/Config.ts` — `resolveDependenciesPath` signature + body + error message (lines 58-76 today)
- `src/server/__tests__/config.depsPath.test.ts` — replace test 4 with 4a/4b split, add 2 new Windows tests, rework tests 5-6 wording
- `package.json` — chain `stage-seed-scrcpy-server.mjs` into the existing `stage-seed` npm script
- `.gitignore` — add `dependencies/scrcpy-server/` and `dependencies/service.log` so dev runtime-state files stop showing as untracked
- `CHANGELOG.md` — `[Unreleased]` entry
- `docs/TECHNICAL_GUIDE.md` — paths/packaging chapter, if it documents the dev fallback

**Create:**
- `scripts/stage-seed-scrcpy-server.mjs` — new prestart hook, copies `assets/scrcpy-server` → `seed/scrcpy-server/scrcpy-server` idempotently
- `dependencies/README.md` — short note that this folder is Linux-dev-only after Phase 1 (Windows dev now reads `<dataRoot>/dependencies/`)

**Delete:**
- `<repo>/config.json` — orphan; never read on Windows after Phase 1 migration
- `<repo>/dependencies/service.log` — leftover from an earlier dev run

**External (outside the repo — done in Task 7):**
- `C:\Users\jscha\.claude\projects\C--Users-jscha\memory\todo_ws_scrcpy_web.md` — add §19 entry for the v0.5.0 Linux Phase-1-equivalent `dataRoot` follow-up

---

## Task 1: Resolver test rewrite (failing tests first)

**Files:**
- Modify: `src/server/__tests__/config.depsPath.test.ts`

- [ ] **Step 1.1: Replace the entire test file**

The existing test file relies on the default `process.platform` (host platform) for the dev-fallback test. Under the new contract, dev fallback differs by platform — tests must inject `platform` explicitly so they're host-independent. Full replacement file content:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDependenciesPath } from '../Config';

describe('resolveDependenciesPath', () => {
    let tmpRoot: string;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-'));
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('returns DEPS_PATH env when set', () => {
        const result = resolveDependenciesPath(
            { DEPS_PATH: '/explicit/deps' },
            {},
            '/any/entry.js',
            () => true,
            'linux',
        );
        expect(result).toBe('/explicit/deps');
    });

    it('env wins over fileConfig and dev fallback', () => {
        const result = resolveDependenciesPath(
            { DEPS_PATH: '/env/deps' },
            { dependenciesPath: '/config/deps' },
            '/any/entry.js',
            () => true,
            'linux',
        );
        expect(result).toBe('/env/deps');
    });

    it('returns fileConfig.dependenciesPath when env is absent', () => {
        const result = resolveDependenciesPath(
            {},
            { dependenciesPath: '/from/config' },
            '/any/entry.js',
            () => true,
            'linux',
        );
        expect(result).toBe('/from/config');
    });

    it('on Linux, falls back to ../dependencies when package.json sibling exists (dev tell)', () => {
        const entry = path.join(tmpRoot, 'dist', 'index.js');
        fs.mkdirSync(path.dirname(entry), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
        const result = resolveDependenciesPath({}, {}, entry, fs.existsSync, 'linux');
        expect(result).toBe(path.resolve(tmpRoot, 'dependencies'));
    });

    it('on Windows, returns <dataRoot>/dependencies regardless of dev tell', () => {
        const result = resolveDependenciesPath(
            { PROGRAMDATA: 'D:\\Custom\\ProgramData' },
            {},
            'C:\\anywhere\\dist\\index.js',
            () => true, // pretend dev tell exists — should be ignored on Windows
            'win32',
        );
        expect(result).toBe(path.win32.join('D:\\Custom\\ProgramData', 'WsScrcpyWeb', 'dependencies'));
    });

    it('on Windows, defaults PROGRAMDATA to C:\\ProgramData when env is absent', () => {
        const result = resolveDependenciesPath(
            {},
            {},
            'C:\\anywhere\\dist\\index.js',
            () => false,
            'win32',
        );
        expect(result).toBe(path.win32.join('C:\\ProgramData', 'WsScrcpyWeb', 'dependencies'));
    });

    it('on Linux, throws a clear error when no source resolves and dev tell is missing', () => {
        expect(() =>
            resolveDependenciesPath({}, {}, '/no/package/json/here/dist/index.js', () => false, 'linux'),
        ).toThrow(/DEPS_PATH is not set/);
    });

    it('error message names DEPS_PATH and the platform-appropriate fallback location', () => {
        try {
            resolveDependenciesPath({}, {}, '/no/pkg/dist/index.js', () => false, 'linux');
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).toContain('DEPS_PATH');
            expect(msg).toContain('<dataRoot>');
            expect(msg).toContain('package.json');
        }
    });
});
```

- [ ] **Step 1.2: Run vitest to confirm the new Windows tests fail**

```
npx vitest run src/server/__tests__/config.depsPath.test.ts
```

Expected: 8 total tests, **2 failures** — the two `on Windows, ...` cases. Pre-implementation, `resolveDependenciesPath` does not accept a `platform` parameter, so passing `'win32'` as a 5th argument is ignored and the function falls through to the existing dev-fallback (or throws). The first 6 tests should already pass because they pass `'linux'` (a no-op under the current code since the extra arg is ignored) and otherwise mirror existing behavior.

If MORE than 2 tests fail, stop and reconcile — likely the type-checker is rejecting the extra argument; use a `// @ts-expect-error` shim on the two Windows test calls, run again, and only the assertions should fail. Remove the shims after Step 1.3.

---

## Task 2: Resolver implementation

**Files:**
- Modify: `src/server/Config.ts` lines 52-76 (the `resolveDependenciesPath` function + its leading doc comment)

- [ ] **Step 2.1: Replace `resolveDependenciesPath` with platform-aware version**

Open `src/server/Config.ts`. Locate the existing function (currently lines 52-76). Replace the entire function plus its leading doc comment with:

```ts
/**
 * Pure resolver: produces the absolute dependencies-folder path the app should
 * manage. Priority: DEPS_PATH env → config.json → platform-specific fallback.
 *
 * On Windows, fallback is <dataRoot>/dependencies/ (default
 * %PROGRAMDATA%\WsScrcpyWeb\dependencies\) — matching launcher/src/paths.rs:65-68
 * so dev mode running `node dist/index.js` from the repo reads the same
 * dependencies folder an MSI install does. There is no dev-tell gate on
 * Windows; ProgramData IS the dependencies home regardless of dev vs install.
 *
 * On non-Windows, fallback is <entryDir>/../dependencies/ gated on a
 * package.json sibling "dev tell" — the same behavior as pre-Phase-1.
 * paths.rs:62 collapses data_root onto install_root for Linux, so there's
 * no migration target yet; a v0.5.0 follow-up tracks the Linux design.
 */
export function resolveDependenciesPath(
    env: NodeJS.ProcessEnv,
    fileConfig: FlatConfig,
    entryScript: string,
    exists: (p: string) => boolean = fs.existsSync,
    platform: NodeJS.Platform = process.platform,
): string {
    if (env['DEPS_PATH']) return env['DEPS_PATH'];
    if (fileConfig.dependenciesPath) return fileConfig.dependenciesPath;

    if (platform === 'win32') {
        const dataRoot = resolveDataRoot(env, platform);
        if (dataRoot) return path.win32.join(dataRoot, 'dependencies');
        // resolveDataRoot returns non-null on Windows by contract; this is
        // a defensive fallthrough for tests that mock resolveDataRoot.
    }

    const entryDir = path.dirname(entryScript);
    const devCandidate = path.resolve(entryDir, '..', 'dependencies');
    const devTell = path.resolve(entryDir, '..', 'package.json');
    if (exists(devTell)) return devCandidate;

    throw new Error(
        'DEPS_PATH is not set and no dependencies path is configured. ' +
        'On Windows, dependencies are expected at <dataRoot>/dependencies ' +
        '(default %PROGRAMDATA%\\WsScrcpyWeb\\dependencies). ' +
        'On Linux, set DEPS_PATH or place a `dependencies/` folder next to ' +
        'a `package.json` sibling of the entry script.',
    );
}
```

- [ ] **Step 2.2: Run vitest to confirm all 8 tests pass**

```
npx vitest run src/server/__tests__/config.depsPath.test.ts
```

Expected: all 8 tests PASS.

- [ ] **Step 2.3: Run the full vitest suite to catch regressions**

```
npx vitest run
```

Expected: full suite green. The resolver is called by other test files (`Config.test.ts`, `config.adbPath.test.ts`, integration tests). If anything breaks, the most likely cause is a call site relying on the old 4-argument signature — the new 5th param has a default, so old call sites should still work. If they don't, fix the regression before continuing.

- [ ] **Step 2.4: Type-check**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2.5: Commit**

```
git add src/server/Config.ts src/server/__tests__/config.depsPath.test.ts
git commit -m "$(cat <<'EOF'
fix(config): align Windows dev resolveDependenciesPath with launcher

resolveDependenciesPath now returns <dataRoot>/dependencies/ on Windows
regardless of dev-tell, matching launcher/src/paths.rs:65-68. Non-Windows
fallback unchanged (Linux still uses <entryDir>/../dependencies/ until
the Phase-1-equivalent dataRoot is designed).

New platform parameter (defaults to process.platform) for host-independent
tests. Updated error message names the platform-appropriate fallback.

Tests: 8 cases (2 new Windows-branch, 1 new PROGRAMDATA-default, rest
adjusted to inject platform explicitly).
EOF
)"
```

---

## Task 3: scrcpy-server seed staging script

**Files:**
- Create: `scripts/stage-seed-scrcpy-server.mjs`
- Modify: `package.json` (the `stage-seed` npm script)

- [ ] **Step 3.1: Create `scripts/stage-seed-scrcpy-server.mjs`**

```js
#!/usr/bin/env node
// Stage the vendored scrcpy-server JAR into <repo>/seed/scrcpy-server/
// so dev-mode DependencyManager.promoteSeedScrcpyServer can promote it
// into <dataRoot>/dependencies/scrcpy-server/scrcpy-server on first
// launch, mirroring what scripts/stage-publish.mjs:194-203 does for MSI
// install packaging.
//
// Run as a prestart hook (see package.json). Idempotent: skip copy when
// destination already byte-identical to source.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const source = join(REPO_ROOT, 'assets', 'scrcpy-server');
const destDir = join(REPO_ROOT, 'seed', 'scrcpy-server');
const dest = join(destDir, 'scrcpy-server');

function sha256(filePath) {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function main() {
    if (!existsSync(source)) {
        console.error(`[stage-seed-scrcpy-server] FATAL: ${source} missing`);
        process.exit(1);
    }
    const srcStat = statSync(source);
    if (srcStat.size === 0) {
        console.error(`[stage-seed-scrcpy-server] FATAL: ${source} is zero-length`);
        process.exit(1);
    }
    if (existsSync(dest) && sha256(source) === sha256(dest)) {
        console.log(`[stage-seed-scrcpy-server] already up-to-date (${srcStat.size} bytes)`);
        return;
    }
    mkdirSync(destDir, { recursive: true });
    copyFileSync(source, dest);
    console.log(`[stage-seed-scrcpy-server] staged ${source} -> ${dest} (${srcStat.size} bytes)`);
}

main();
```

- [ ] **Step 3.2: Run the script standalone, confirm fresh-copy path**

```
node scripts/stage-seed-scrcpy-server.mjs
```

Expected: `[stage-seed-scrcpy-server] staged ...assets\scrcpy-server -> ...seed\scrcpy-server\scrcpy-server (90980 bytes)`.

Verify:
```
ls seed/scrcpy-server/scrcpy-server  # expect 90980 bytes
```

- [ ] **Step 3.3: Run the script again, confirm idempotent path**

```
node scripts/stage-seed-scrcpy-server.mjs
```

Expected: `[stage-seed-scrcpy-server] already up-to-date (90980 bytes)` (no copy).

- [ ] **Step 3.4: Wire into package.json's `stage-seed` script**

Locate the existing `stage-seed` entry in `package.json` (currently `"stage-seed": "node scripts/stage-seed-node-pty.mjs"`). Replace with:

```json
    "stage-seed": "node scripts/stage-seed-node-pty.mjs && node scripts/stage-seed-scrcpy-server.mjs",
```

(Single line, preserve indentation and trailing comma to match neighboring entries.)

- [ ] **Step 3.5: Verify the prestart chain runs both stagers**

```
npm run prestart
```

Expected: output shows both `stage-seed-node-pty` and `stage-seed-scrcpy-server` lines. Exit code 0. Re-run to confirm both are idempotent in steady state.

- [ ] **Step 3.6: Commit**

```
git add scripts/stage-seed-scrcpy-server.mjs package.json
git commit -m "$(cat <<'EOF'
build(seed): stage scrcpy-server seed in dev mode

New scripts/stage-seed-scrcpy-server.mjs runs as part of the existing
`stage-seed` npm script (chained after stage-seed-node-pty.mjs). It
copies assets/scrcpy-server -> seed/scrcpy-server/scrcpy-server so
DependencyManager.promoteSeedScrcpyServer finds the seed in dev exactly
the way it does in MSI install (where stage-publish.mjs:194-203 stages
the same artifact into publish/seed/scrcpy-server/).

Idempotent (sha256 check skips redundant copies). No drift between dev
seed and install seed — both pull from assets/scrcpy-server, the
vendored JAR pinned to Constants.SERVER_VERSION.
EOF
)"
```

---

## Task 4: Repo cleanup (orphans + gitignore)

**Files:**
- Delete: `config.json`, `dependencies/service.log`
- Create: `dependencies/README.md`
- Modify: `.gitignore`

- [ ] **Step 4.1: Delete orphan files**

```
rm config.json
rm -f dependencies/service.log
```

`config.json` at the repo root is the pre-Phase-1 dev-mode config; never read on Windows after Phase 1 (Config.ts:145-159 routes through `<dataRoot>` first). `dependencies/service.log` is leftover dev-run state — should never have been in repo.

- [ ] **Step 4.2: Create `dependencies/README.md`**

```markdown
# `dependencies/` — Linux dev fallback only

On **Windows**, the dev server reads and writes dependencies at
`%PROGRAMDATA%\WsScrcpyWeb\dependencies\`, matching what the launcher's
[`paths.rs`](../launcher/src/paths.rs) computes for an MSI install
(see `Config.ts::resolveDependenciesPath` and
[the dev/install layout parity design](../docs/superpowers/specs/2026-05-14-dev-install-layout-parity-design.md)).
The `.gitkeep`-pinned subdirs in this folder are vestigial on Windows;
they're kept for Linux dev only.

On **Linux** dev, this folder is still the resolver's fallback target —
`paths.rs:62` collapses `data_root` onto `install_root` on non-Windows
hosts pending a Phase-1-equivalent design (tracked in
`todo_ws_scrcpy_web.md` §19).

Do not commit binary contents of subdirs here; they're populated at
runtime by `DependencyManager.autoInstallMissing()` (downloads adb,
Node, scrcpy-server on first launch into `<dataRoot>/dependencies/` on
Windows, or `<repo>/dependencies/` on Linux).
```

- [ ] **Step 4.3: Update `.gitignore` to cover runtime-state files in dependencies/**

The `.gitignore` already covers `dependencies/node/`, `dependencies/adb/`, `dependencies/node-pty/`, `dependencies/servy/`, `dependencies/node-bootstrap/` (lines 18-22). Add the missing pair so future runtime state doesn't show as untracked:

```
dependencies/scrcpy-server/
dependencies/*.log
```

Place these immediately after the existing `dependencies/...` block (so the section stays contiguous).

- [ ] **Step 4.4: Confirm working tree state**

```
git status --short
```

Expected: only the changes from this task — deleted `config.json`, deleted `dependencies/service.log`, new `dependencies/README.md`, modified `.gitignore`. No stray untracked `dependencies/scrcpy-server/` or `dependencies/service.log` listings.

- [ ] **Step 4.5: Commit**

```
git add -A dependencies/ config.json .gitignore
git commit -m "$(cat <<'EOF'
chore(repo): remove pre-Phase-1 orphans + clarify dependencies/ scope

- Delete <repo>/config.json — never read on Windows after Phase 1
  (resolveConfigPath routes through <dataRoot>/config.json).
- Delete <repo>/dependencies/service.log — leftover dev-run state.
- Add dependencies/README.md explaining the folder is Linux-dev-only
  on the Windows side, with pointers to paths.rs and the parity spec.
- .gitignore: cover dependencies/scrcpy-server/ and dependencies/*.log
  so the folder doesn't show stray untracked runtime state.
EOF
)"
```

---

## Task 5: Manual smoke (clean ProgramData first launch)

**Files:** none modified.

This task validates the new contract end-to-end by reproducing what a clean MSI install does. It is not automatable — vitest can't model an empty ProgramData + real device probe + dep download. The smoke is short (~5 min) and gates the docs/CHANGELOG commit in Task 6.

- [ ] **Step 5.1: Stop every running ws-scrcpy-web process**

In an admin PowerShell:

```powershell
Get-Process node, ws-scrcpy-web-launcher, ws-scrcpy-web-tray, servy -ErrorAction SilentlyContinue | Stop-Process -Force
```

Verify nothing is listening on 8000 or 8001:

```powershell
Get-NetTCPConnection -LocalPort 8000,8001 -State Listen -ErrorAction SilentlyContinue
```

Expected: no output (no listeners).

- [ ] **Step 5.2: Wipe ProgramData state**

```powershell
Remove-Item -Recurse -Force C:\ProgramData\WsScrcpyWeb -ErrorAction SilentlyContinue
```

Verify gone:

```powershell
Test-Path C:\ProgramData\WsScrcpyWeb
```

Expected: `False`.

- [ ] **Step 5.3: Build and start the dev server**

```powershell
npm run build; if ($LASTEXITCODE -eq 0) { npm start }
```

Watch the startup logs. Expected highlights:

1. `[stage-seed-node-pty]` and `[stage-seed-scrcpy-server]` lines from prestart.
2. `[Config] adbPath=C:\ProgramData\WsScrcpyWeb\dependencies\adb\adb.exe (source=bundled)` — the new resolver firing.
3. `Server starting on port 8000` (or whatever's free starting from 8000, since `<dataRoot>\config.json` doesn't exist yet → defaults apply → starts at 8000).
4. `[DependencyManager] First-run: auto-installing nodejs` (or adb, scrcpy-server) — autoInstallMissing kicking off.
5. `promoted seed scrcpy-server → C:\ProgramData\WsScrcpyWeb\dependencies\scrcpy-server\scrcpy-server` — confirms the new seed-staging path works end-to-end.
6. ~30-60 s later: `[DependencyManager] Dependency check complete: 3 up-to-date`.

If `adbPath` log shows `C:\Users\jscha\source\repos\ws-scrcpy-web\dependencies\...` instead of ProgramData, the resolver change did not take effect — likely a stale `dist/` build. Rerun `npm run build` and retry.

- [ ] **Step 5.4: Verify dep panel via browser**

Open `http://localhost:8000` (or whatever port the log reported). After autoInstallMissing completes, the Dependencies panel should show all three deps as Installed with versions matching Latest, status "Up to date". The "Setup incomplete" banner should not be visible after the next 15 s poll.

- [ ] **Step 5.5: Verify ProgramData layout matches install**

```powershell
Get-ChildItem -Recurse -Depth 1 C:\ProgramData\WsScrcpyWeb | Select-Object FullName
```

Expected directory tree:
```
C:\ProgramData\WsScrcpyWeb\config.json
C:\ProgramData\WsScrcpyWeb\dependencies\
C:\ProgramData\WsScrcpyWeb\dependencies\adb\
C:\ProgramData\WsScrcpyWeb\dependencies\adb\adb.exe
C:\ProgramData\WsScrcpyWeb\dependencies\node\
C:\ProgramData\WsScrcpyWeb\dependencies\node\node.exe
C:\ProgramData\WsScrcpyWeb\dependencies\scrcpy-server\
C:\ProgramData\WsScrcpyWeb\dependencies\scrcpy-server\scrcpy-server
C:\ProgramData\WsScrcpyWeb\dependencies\scrcpy-server\.version
```

The `<repo>\dependencies\` subdirs should be **untouched** by this run (verify by their mtime — they should match their pre-smoke state).

- [ ] **Step 5.6: Stop the dev server (Ctrl+C in the terminal)**

Note any failures from this smoke run. If anything diverges from expected, STOP and reconcile before continuing — a docs commit asserting correctness on top of a broken smoke is worse than no commit.

- [ ] **Step 5.7: Smoke OK — proceed.** No commit here; smoke is verification, not artifact production.

---

## Task 6: Docs

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/TECHNICAL_GUIDE.md` (conditional — only if a Paths/Packaging chapter currently documents the dev fallback)

- [ ] **Step 6.1: Add `[Unreleased]` entry to `CHANGELOG.md`**

Open `CHANGELOG.md`. Locate the `## [Unreleased]` heading (add it under `# Changelog` if absent). Under it, in the existing `### Changed` / `### Fixed` / `### Removed` sub-sections (create them if missing), add:

```markdown
### Changed
- `resolveDependenciesPath` now returns `<dataRoot>/dependencies/` on Windows regardless of dev-tell, matching `launcher/src/paths.rs` and the MSI install layout. Dev mode (`npm start` from repo) now reads/writes the same ProgramData state an installed app does. Linux dev unchanged. ([design spec](docs/superpowers/specs/2026-05-14-dev-install-layout-parity-design.md))
- `prestart` chain now also stages `assets/scrcpy-server` into `seed/scrcpy-server/` so `DependencyManager.promoteSeedScrcpyServer` works identically in dev and install — no first-launch network fetch for scrcpy-server when running from repo.

### Removed
- Pre-Phase-1 orphan `<repo>/config.json` (never read on Windows since dataRoot migration).
```

- [ ] **Step 6.2: Audit `docs/TECHNICAL_GUIDE.md` for stale dev-fallback references**

```
grep -n -i "entryDir\|dev fallback\|repo/dependencies\|<repo>.dependencies" docs/TECHNICAL_GUIDE.md
```

If matches exist, open `docs/TECHNICAL_GUIDE.md` and locate the chapter (likely under a "Paths," "Packaging," or "Dependencies" heading). Update wording to describe the new contract:

> Dev mode running `node dist/index.js` from the repo resolves dependencies the same way an MSI install does — via `<dataRoot>/dependencies/` on Windows (where `<dataRoot>` defaults to `%PROGRAMDATA%\WsScrcpyWeb\`), via `<entryDir>/../dependencies/` on Linux. The launcher's `paths.rs::compute` and the server's `resolveDependenciesPath` produce the same result on Windows; tests in `config.depsPath.test.ts` lock that contract.

If `grep` returns no matches, skip this step.

- [ ] **Step 6.3: Commit docs**

```
git add CHANGELOG.md docs/TECHNICAL_GUIDE.md
git commit -m "$(cat <<'EOF'
docs: record dev/install layout parity in CHANGELOG + TG

CHANGELOG: under [Unreleased], note the Windows resolver alignment and
prestart seed staging behavior change.

TECHNICAL_GUIDE: update the paths chapter (where it existed) to
describe the new contract — Windows dev resolves through dataRoot like
install does; Linux dev unchanged pending v0.5.0 design.
EOF
)"
```

If `docs/TECHNICAL_GUIDE.md` wasn't modified in Step 6.2, the `git add` line still works (git ignores nonexistent additions when the file is unchanged) — but if you prefer, just commit `CHANGELOG.md` alone.

---

## Task 7: Global memory follow-up (Linux v0.5.0 TODO)

**Files:**
- Modify: `C:\Users\jscha\.claude\projects\C--Users-jscha\memory\todo_ws_scrcpy_web.md` (outside the repo — user's global memory store)

This task is intentionally last in the plan because the memory file is not part of the repo and editing it is a separate concern.

- [ ] **Step 7.1: Read the current TODO file to locate the insertion point**

Find the highest-numbered active section. Based on the spec author's snapshot, sections in active use run up through §18. The new section will be §19.

Conceptually it sits in Group B (release readiness) or Group A (packaging) — call it Group A since it's about install-layout coherence.

- [ ] **Step 7.2: Insert the new section before the `# Recent shipments` heading**

```markdown
## 19. v0.5.0 — design Linux Phase-1-equivalent dataRoot (Group A — DEFERRED)

**Status:** OPEN, deferred. Surfaced 2026-05-14 during the dev/install layout parity work (`feat/dev-install-layout-parity`).

**Context:** Phase 1 of the Program Files migration moved Windows writable state (config, deps, logs) to `%PROGRAMDATA%\WsScrcpyWeb\`. On Linux, `launcher/src/paths.rs:62` still collapses `data_root` onto `install_root`. After 2026-05-14's Windows resolver change, dev/install layout parity is solved for Windows but Linux dev still uses `<repo>/dependencies/` (the pre-Phase-1 fallback).

**Goal:** Pick a Linux Phase-1-equivalent target — candidates:
- `~/.local/share/wsscrcpy-web/` (XDG user-data, per-user state)
- `/var/lib/wsscrcpy-web/` (system-wide, matches systemd service expectations)
- Stay collapsed for AppImage; only diverge for Linux package builds

Then propagate through:
- `launcher/src/paths.rs::compute` — Linux branch of `data_root`
- `src/server/Config.ts::resolveDataRoot` — accept non-null result on Linux
- `src/server/Config.ts::resolveDependenciesPath` — extend Windows-only branch to platform-agnostic when `dataRoot` is non-null

**Trigger to promote:** before tagging v0.5.0 stable. Until then, Linux dev continues using `<repo>/dependencies/` as the resolver fallback — no behavioral change.

**Related memories (item-specific):**
- `docs/superpowers/specs/2026-05-14-dev-install-layout-parity-design.md` (in repo) — original Windows parity spec; the artifact a Linux extension would parallel
- `launcher/src/paths.rs:17-18` — comment noting "Linux dataRoot collapses to install_root for now"
```

- [ ] **Step 7.3: Update the operational-memories block reference if needed**

Open `todo_ws_scrcpy_web.md`'s top-of-file index line that summarizes the active-section list:

> - Active backlog: §1c bug 2 (deferred...), ... §18 local-vpk re-pin to 0.0.1589-ga2c5a97 (release pipeline).

Append `§19 v0.5.0 Linux dataRoot design (DEFERRED).` to the comma-separated list.

- [ ] **Step 7.4: Update the `last updated YYYY-MM-DD` date and active-item count in `project_index.md`**

Open `C:\Users\jscha\.claude\projects\C--Users-jscha\memory\project_index.md`. Find the ws-scrcpy-web TODO entry (currently `17 active items, last updated 2026-05-13`). Bump to `18 active items, last updated 2026-05-14`. Keep the one-line discipline (≤150 chars).

- [ ] **Step 7.5: No commit — memory file is outside the repo**

The memory store is not git-tracked from this repo. Save the file and move on.

---

## Task 8: Final verification + branch summary

- [ ] **Step 8.1: Final vitest run on the feature branch**

```
npx vitest run
```

Expected: full suite green.

- [ ] **Step 8.2: Type-check**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8.3: Inspect the branch's commit history**

```
git log --oneline main..HEAD
```

Expected commit list (in order):
1. `docs(specs): dev/install layout parity design`
2. `fix(config): align Windows dev resolveDependenciesPath with launcher`
3. `build(seed): stage scrcpy-server seed in dev mode`
4. `chore(repo): remove pre-Phase-1 orphans + clarify dependencies/ scope`
5. `docs: record dev/install layout parity in CHANGELOG + TG`

Five commits, atomic by concern. No "WIP" or "fix typo" stragglers — squash or reword first if any exist.

- [ ] **Step 8.4: Report status to the user**

Summarize:
- Branch: `feat/dev-install-layout-parity` (5 commits ahead of `main`)
- Tests: N total, all green (replace N with actual count)
- Smoke: Task 5 manual pass on 2026-05-14
- Next step: user can FF-merge to main when satisfied; per `feedback_pr_workflow.md` this repo is solo-owned, no PR step.

**Ask the user before pushing to `origin` or merging to `main`** — per CLAUDE.md, those are visible-to-others actions that need explicit authorization.

---

## Rollback

If any task fails or regresses behavior in production-like smoke, the rollback is straightforward:

```
git reset --hard 2c83742   # reset to the spec-only commit on this branch
# OR, if already merged to main and need to undo:
git revert <merge-commit>  # creates a clean revert commit
```

No data-format changes, no migration step. `<dataRoot>/dependencies/` already exists in installed-MSI users' systems; the resolver change only affects what dev mode reads.
