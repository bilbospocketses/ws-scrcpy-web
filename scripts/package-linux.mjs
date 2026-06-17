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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const PACK_ID = 'WsScrcpyWeb';                    // Matches Windows packId
const MAIN_EXE = 'ws-scrcpy-web-launcher';        // Linux binary, no .exe
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
    // Fallback: parse Cargo.toml's [workspace.package] version.
    const cargoPath = join(REPO_ROOT, 'Cargo.toml');
    if (existsSync(cargoPath)) {
        const v = parseCargoWorkspaceVersion(readFileSync(cargoPath, 'utf8'));
        if (v) return v;
    }
    throw new Error('Could not resolve a version from package.json or Cargo.toml');
}

/**
 * Extract `version` from the `[workspace.package]` section of a Cargo.toml.
 * Scoped to that section — not the first line-start `version =` anywhere — so a
 * `version =` in an earlier section can't be grabbed by position. Returns null
 * if absent. (#102)
 */
export function parseCargoWorkspaceVersion(tomlText) {
    const m = tomlText.match(/\[workspace\.package\][^[]*?\bversion\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
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
    // Linux ships per-platform Velopack channels (linux-beta / linux-stable) so
    // its releases.<channel>.json feed + nupkg don't collide with the Windows
    // beta/stable feeds on the same GitHub release. Derive beta/stable from the
    // version (mirrors release.yml's tag→channel rule; assert-version-sync keeps
    // package.json === tag). MUST match UpdateService.resolveExplicitChannel so
    // the installed app queries the feed we actually publish.
    const channelBase = version.includes('-beta') ? 'beta' : 'stable';
    const CHANNEL = `linux-${channelBase}`;
    log(`packing AppImage: id=${PACK_ID} version=${version} channel=${CHANNEL}`);

    // execFileSync with array-form args — no shell interpolation, no
    // injection surface. Inherit stdio so vpk's progress reaches the user.
    // -o Releases pins flat output (matching the Windows leg) so the AppImage,
    // the releases.<channel>.json feed, and the *-full.nupkg all land directly
    // in Releases/ for the CI upload globs to harvest.
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
            '-o', 'Releases',
        ],
        { cwd: REPO_ROOT, stdio: 'inherit' },
    );

    // Swap the AppImage runtime to the upstream static-fuse runtime so
    // the .AppImage runs on hosts without libfuse2/libfuse3 installed.
    // Velopack ships the older fuse2-linked runtime by default; the
    // swap is what makes the artifact truly portable.
    // -o Releases (above) pins flat output, so the AppImage is directly in Releases/.
    const releasesDir = join(REPO_ROOT, 'Releases');
    const appimages = existsSync(releasesDir)
        ? readdirSync(releasesDir).filter((f) => f.endsWith('.AppImage'))
        : [];
    if (appimages.length === 0) {
        err(`vpk pack produced no .AppImage in ${releasesDir}; cannot swap runtime.`);
        process.exit(1);
    }
    const swapScript = join(__dirname, 'swap-appimage-runtime.mjs');
    for (const name of appimages) {
        const target = join(releasesDir, name);
        log(`swapping runtime in ${target}`);
        execFileSync(process.execPath, [swapScript, target], {
            cwd: REPO_ROOT,
            stdio: 'inherit',
        });
    }

    log('AppImage packaging + runtime swap complete. Output under Releases/linux/.');
}

// Only run when invoked directly (`node scripts/package-linux.mjs`), not when
// imported (e.g. by the unit test for parseCargoWorkspaceVersion). (#102)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main();
    } catch (e) {
        err(`unexpected error: ${e.message}`);
        process.exit(1);
    }
}
