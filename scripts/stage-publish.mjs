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

    // 1. Verify required prereqs (fail fast before any file ops)
    const launcherBin = join(
        REPO_ROOT,
        'target',
        'release',
        `ws-scrcpy-web-launcher${exeSuffix}`,
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
