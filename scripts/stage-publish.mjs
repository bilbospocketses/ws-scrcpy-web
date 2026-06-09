#!/usr/bin/env node
// scripts/stage-publish.mjs
//
// Assemble publish/ for vpk pack consumption.
//
// Inputs (must exist before running):
//   - target/release/ws-scrcpy-web-launcher.exe   (cargo build --release)
//   - target/release/ws-scrcpy-web-tray.exe       (cargo build --release)
//   - dist/                                       (npm run build)
//   - package.json + package-lock.json
//   - start.cmd                                   (legacy dev launcher)
//
// Optional inputs (warn-skip if missing):
//   - seed/node/                                  (added during P6 packaging)
//   - dependencies/servy-cli.exe                  (added by P3 fetch-servy.mjs)
//
// Output:
//   publish/
//     ws-scrcpy-web-launcher.exe
//     ws-scrcpy-web-tray.exe
//     start.cmd
//     dist/
//     node_modules/        (production deps only)
//     package.json
//     package-lock.json
//     [seed/node/]
//     [servy-cli.exe]

import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const PUBLISH = join(REPO_ROOT, 'publish');
// Spawning `npm` cross-platform with execFileSync:
//   - On Windows, `npm` resolves to `npm.cmd` which Node 20+ refuses to
//     execFile directly (CVE-2024-27980). Calling `cmd.exe /c npm.cmd ...`
//     dispatches through cmd.exe (a real PE), avoiding the restriction
//     without needing shell:true (which triggers DEP0190 on arg arrays).
//   - On non-Windows, plain `npm` works.
const NPM_CMD = process.platform === 'win32' ? 'cmd.exe' : 'npm';
const NPM_ARGS_PREFIX = process.platform === 'win32' ? ['/c', 'npm.cmd'] : [];

function step(name, fn) {
    process.stdout.write(`  ${name.padEnd(28)} `);
    try {
        fn();
        console.log('OK');
    } catch (e) {
        console.log('FAILED');
        throw e;
    }
}

function requirePath(path, label) {
    if (!existsSync(path)) {
        throw new Error(`${label} not found at ${path}. Run prerequisite build steps first.`);
    }
}

function main() {
    const isWindows = process.platform === 'win32';
    const exeSuffix = isWindows ? '.exe' : '';
    console.log(`Staging publish/ for ${isWindows ? 'Windows' : 'Linux'} ...`);

    // 1. Verify required prereqs (fail fast before any file ops).
    //
    // Linux launcher is built for the x86_64-unknown-linux-musl target so the
    // shipped ELF has no glibc dependency (matches the static-CRT story on
    // Windows). See `.github/workflows/release.yml` for the cargo build step.
    const launcherBin = isWindows
        ? join(REPO_ROOT, 'target', 'release', 'ws-scrcpy-web-launcher.exe')
        : join(
              REPO_ROOT,
              'target',
              'x86_64-unknown-linux-musl',
              'release',
              'ws-scrcpy-web-launcher',
          );
    // Tray helper is Windows-only (per P4b decision (b): common::tray returns
    // Cancelled on non-Windows; no Linux tray binary is shipped). On Linux we
    // skip both copy and prereq check.
    const trayBin = isWindows
        ? join(REPO_ROOT, 'target', 'release', 'ws-scrcpy-web-tray.exe')
        : null;
    const distDir = join(REPO_ROOT, 'dist');
    const pkgJson = join(REPO_ROOT, 'package.json');
    const pkgLock = join(REPO_ROOT, 'package-lock.json');
    // start.cmd is the legacy Windows dev launcher; not relevant for Linux
    // packaging where the AppImage's main exe is the launcher itself.
    const startCmd = isWindows ? join(REPO_ROOT, 'start.cmd') : null;

    requirePath(launcherBin, 'launcher binary (cargo build --release)');
    if (trayBin) requirePath(trayBin, 'tray binary (cargo build --release)');
    requirePath(distDir, 'dist/ (npm run build)');
    requirePath(pkgJson, 'package.json');
    requirePath(pkgLock, 'package-lock.json');
    if (startCmd) requirePath(startCmd, 'start.cmd');

    // 2. Clean publish/ for idempotency
    if (existsSync(PUBLISH)) {
        step('Clean publish/', () => rmSync(PUBLISH, { recursive: true, force: true }));
    }
    mkdirSync(PUBLISH, { recursive: true });

    // 3. Binaries
    step(`Copy launcher${exeSuffix}`, () =>
        copyFileSync(launcherBin, join(PUBLISH, `ws-scrcpy-web-launcher${exeSuffix}`)),
    );
    if (trayBin) {
        step('Copy tray.exe', () => copyFileSync(trayBin, join(PUBLISH, 'ws-scrcpy-web-tray.exe')));
    }

    // 4. dist/
    step('Copy dist/', () => cpSync(distDir, join(PUBLISH, 'dist'), { recursive: true }));

    // 5. package.json + package-lock.json (npm ci needs both)
    step('Copy package.json', () => copyFileSync(pkgJson, join(PUBLISH, 'package.json')));
    step('Copy package-lock.json', () =>
        copyFileSync(pkgLock, join(PUBLISH, 'package-lock.json')),
    );

    // 5b. Linux menu icon — bundle the 256x256 tray-icon.png alongside
    // package.json so the machine-wide install can copy it into the hicolor theme
    // for the system .desktop entry (Icon=ws-scrcpy-web). Resolved at runtime via
    // path.resolve(__dirname, '..', 'tray-icon.png') — the same bundled-file pattern
    // getAppVersion() uses for package.json. (vpk's --icon embeds the icon in the
    // AppImage too, but that copy is NOT reliably reachable as $APPDIR/.DirIcon —
    // the prior approach, which left the menu icon blank.)
    const trayIcon = join(REPO_ROOT, 'assets', 'tray-icon.png');
    if (existsSync(trayIcon)) {
        step('Copy tray-icon.png', () => copyFileSync(trayIcon, join(PUBLISH, 'tray-icon.png')));
    } else {
        console.log('  tray-icon.png skip (assets/tray-icon.png not present)');
    }

    // 6. Install production deps into publish/.
    // execFileSync with explicit args array — no user input, no injection
    // surface. cmd.exe wrapper avoids the .cmd-execFile restriction
    // without using shell:true (which triggers DEP0190 on Node 24+).
    step('npm ci --omit=dev', () => {
        execFileSync(NPM_CMD, [...NPM_ARGS_PREFIX, 'ci', '--omit=dev'], {
            cwd: PUBLISH,
            stdio: 'inherit',
        });
    });

    // 6a. v0.1.23-stable (item 5 / Approach C): relocate node-pty +
    // node-addon-api out of publish/node_modules/ and into
    // publish/seed/node-pty-pkg/node_modules/. Per the
    // Local-Dependencies-Only architecture, runtime mutable state
    // (including any swapped pty.node from a Node ABI auto-update) must
    // not live under the install root's `current/` image. NodePtyResolver
    // copies this seed to <dataRoot>/dependencies/node-pty/<v-host>/ on
    // first launch and loads node-pty from there via createRequire().
    //
    // node-pty was installed as an OPTIONAL dep so non-platform npm ci
    // doesn't fail; on win32/linux the postinstall fetches a prebuilt and
    // we relocate the resulting tree here. node-addon-api is its
    // transitive dep and must travel with it.
    step('Relocate node-pty → seed/node-pty-pkg', () => {
        const seedNodePtyPkg = join(PUBLISH, 'seed', 'node-pty-pkg', 'node_modules');
        mkdirSync(seedNodePtyPkg, { recursive: true });
        const nodePtySrc = join(PUBLISH, 'node_modules', 'node-pty');
        const nodeAddonApiSrc = join(PUBLISH, 'node_modules', 'node-addon-api');
        if (!existsSync(nodePtySrc)) {
            throw new Error(
                `node-pty not present at ${nodePtySrc} after npm ci — ` +
                'optional-dep postinstall may have failed (network? missing platform?)',
            );
        }
        cpSync(nodePtySrc, join(seedNodePtyPkg, 'node-pty'), { recursive: true });
        rmSync(nodePtySrc, { recursive: true, force: true });
        if (existsSync(nodeAddonApiSrc)) {
            cpSync(nodeAddonApiSrc, join(seedNodePtyPkg, 'node-addon-api'), { recursive: true });
            rmSync(nodeAddonApiSrc, { recursive: true, force: true });
        }
    });

    // 7. Legacy dev launcher (Windows only)
    if (startCmd) {
        step('Copy start.cmd', () => copyFileSync(startCmd, join(PUBLISH, 'start.cmd')));
    }

    // 8. Optional: seed/ (added during P6 packaging finalization)
    const seedDir = join(REPO_ROOT, 'seed');
    if (existsSync(seedDir)) {
        step('Copy seed/', () => cpSync(seedDir, join(PUBLISH, 'seed'), { recursive: true }));
    } else {
        console.log('  seed/ skip (will be populated in P6 packaging)');
    }

    // 8a. v0.1.9: stage scrcpy-server seed. Source is the repo's vendored
    // copy at assets/scrcpy-server (90 KB JAR, version pinned to whatever
    // Constants.SERVER_VERSION says). Destination is publish/seed/scrcpy-server/
    // so DependencyManager.promoteSeedScrcpyServer can promote it on
    // first run for offline-capable installs. Network-driven updates via
    // the dep updater later replace this with a fresher version under
    // <deps>/scrcpy-server/.
    //
    // Why we still ship a seed even though the dep updater can fetch from
    // GitHub: fresh installs on a network-restricted host (no internet,
    // VPN, dev container) need a working scrcpy-server binary to push to
    // connected devices. The seed guarantees that.
    const scrcpyAsset = join(REPO_ROOT, 'assets', 'scrcpy-server');
    if (existsSync(scrcpyAsset)) {
        step('Stage scrcpy-server seed', () => {
            const seedScrcpyDir = join(PUBLISH, 'seed', 'scrcpy-server');
            mkdirSync(seedScrcpyDir, { recursive: true });
            copyFileSync(scrcpyAsset, join(seedScrcpyDir, 'scrcpy-server'));
        });
    } else {
        console.log('  scrcpy-server seed skip (assets/scrcpy-server not present)');
    }

    // 9. Servy CLI (P3) — Windows only. On Linux, systemd is the service manager
    // (per P4b SystemdClient); no Servy binary is bundled.
    const fetchServyScript = join(__dirname, 'fetch-servy.mjs');
    if (isWindows) {
        step('Fetch + verify Servy', () => {
            execFileSync(process.execPath, [fetchServyScript], { stdio: 'inherit' });
        });
        const placedServy = join(PUBLISH, 'servy-cli.exe');
        if (!existsSync(placedServy)) {
            throw new Error(
                `fetch-servy.mjs returned 0 but ${placedServy} is missing; aborting stage.`,
            );
        }
    } else {
        console.log('  servy-cli.exe skip (Linux uses systemd)');
    }

    console.log(`\npublish/ is ready for vpk pack (${isWindows ? 'Windows MSI' : 'Linux AppImage'}).`);
}

main();
