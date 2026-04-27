#!/usr/bin/env node
// scripts/package-linux.mjs
//
// Wrap `vpk pack` for Linux AppImage output (SP3 P4b).
//
// Velopack's Linux backend produces an AppImage only — no .deb / .rpm /
// Snap / Flatpak. AppImages run on any modern glibc-based distro without
// sudo or pkg-manager integration.
//
// Inputs (must exist before running):
//   - publish/                                  (assembled by a Linux-side
//                                                stage step — cargo build +
//                                                npm run build + npm ci)
//   - publish/ws-scrcpy-web-launcher            (Linux launcher binary)
//   - assets/tray-icon.png                      (256x256 PNG; vpk insists on PNG)
//   - vpk on PATH                               (`dotnet tool install -g vpk`)
//
// Output:
//   Releases/<channel>/                         (vpk default; usually
//                                                Releases/linux/)
//
// Run standalone (Linux only):
//   node scripts/package-linux.mjs
//
// On non-Linux hosts (e.g., dev workflow on Windows), this script logs +
// exits 0 — same shape as fetch-servy.mjs / package-stage.mjs.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const PACK_ID = 'WsScrcpyWeb';                    // Matches Windows packId
const MAIN_EXE = 'ws-scrcpy-web-launcher';        // Linux binary, no .exe
const CHANNEL = 'linux';                          // Velopack default for Linux
const CATEGORIES = 'Utility';                     // FreeDesktop categories spec

const PUBLISH_DIR = join(REPO_ROOT, 'publish');
const ICON_PATH = join(REPO_ROOT, 'assets', 'tray-icon.png');
const LAUNCHER_BIN = join(PUBLISH_DIR, MAIN_EXE);

function log(msg) {
    console.log(`[package-linux] ${msg}`);
}

function err(msg) {
    console.error(`[package-linux] ${msg}`);
}

/** Read package.json version. Falls back to Cargo.toml workspace.package.version. */
function readVersion() {
    const pkgPath = join(REPO_ROOT, 'package.json');
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
            if (typeof pkg.version === 'string' && pkg.version.length > 0) {
                return pkg.version;
            }
        } catch (e) {
            err(`failed to parse package.json: ${e.message}`);
        }
    }
    // Fallback: parse Cargo.toml workspace.package.version naively.
    const cargoPath = join(REPO_ROOT, 'Cargo.toml');
    if (existsSync(cargoPath)) {
        const text = readFileSync(cargoPath, 'utf8');
        const m = text.match(/^\s*version\s*=\s*"([^"]+)"/m);
        if (m) return m[1];
    }
    throw new Error('Could not resolve a version from package.json or Cargo.toml');
}

/** Verify `vpk` is callable on PATH. Returns true / false. */
function vpkOnPath() {
    try {
        execFileSync('vpk', ['--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
        return true;
    } catch {
        return false;
    }
}

function main() {
    if (process.platform !== 'linux') {
        log(`Linux packaging is Linux-only; current platform is ${process.platform}. Skipping.`);
        return;
    }

    // Pre-condition checks (fail fast with descriptive errors).
    if (!existsSync(PUBLISH_DIR)) {
        throw new Error(`publish/ not found at ${PUBLISH_DIR}. Run the Linux stage step first.`);
    }
    if (!existsSync(LAUNCHER_BIN)) {
        throw new Error(
            `Linux launcher binary not found at ${LAUNCHER_BIN}. ` +
            `Build via \`cargo build --release --workspace\` and stage into publish/.`,
        );
    }
    if (!existsSync(ICON_PATH)) {
        throw new Error(`Icon not found at ${ICON_PATH}.`);
    }
    if (!vpkOnPath()) {
        throw new Error(
            'vpk not on PATH. Install via `dotnet tool install -g vpk` ' +
            '(see https://docs.velopack.io/getting-started/installation).',
        );
    }

    const version = readVersion();
    log(`packing AppImage: id=${PACK_ID} version=${version} channel=${CHANNEL}`);

    // execFileSync with array-form args — no shell interpolation, no
    // injection surface. Inherit stdio so vpk's progress reaches the user.
    execFileSync(
        'vpk',
        [
            'pack',
            '-u', PACK_ID,
            '-v', version,
            '-p', PUBLISH_DIR,
            '--mainExe', MAIN_EXE,
            '--icon', ICON_PATH,
            '--categories', CATEGORIES,
            '--channel', CHANNEL,
        ],
        { cwd: REPO_ROOT, stdio: 'inherit' },
    );

    log('AppImage packaging complete. Output under Releases/linux/.');
}

try {
    main();
} catch (e) {
    err(`unexpected error: ${e.message}`);
    process.exit(1);
}
