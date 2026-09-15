#!/usr/bin/env node
// scripts/vpk-path.mjs
//
// THE single resolver for the Velopack CLI (`vpk`). Every call site — the
// `package:pack` npm script, scripts/package-linux.mjs, scripts/test-update-flow.ps1
// and both release.yml legs — goes through here. Five copies of a path
// expression is how one of them drifts back to PATH later.
//
// WHY THIS EXISTS (Local-Dependencies-Only):
//   Every binary dependency must be invoked from inside the app's own folder,
//   never from the system PATH, an env var, or a global install. `vpk` used to
//   be installed with `dotnet tool install -g` and invoked bare, which resolved
//   through PATH and silently depended on whatever version the host happened to
//   have. It is now installed with `--tool-path` into
//   dependencies/vpk/v<version>/ and invoked by absolute path.
//
//   `dotnet` itself is deliberately NOT vendored: it is the toolchain that
//   fetches the dependency, not the dependency. That distinction is settled.
//
// FETCHED, NOT VENDORED:
//   dependencies/vpk/ is gitignored. The install is reproduced on demand from
//   NuGet, the same way scripts/fetch-servy.mjs and scripts/fetch-node.mjs
//   reproduce their binaries. The version is part of the path, so a bump lands
//   in a new directory and cannot silently reuse a stale install.
//
// VERSION PIN — ONE NUMBER, DERIVED:
//   The vpk CLI version is NOT independently pinned. It tracks the resolved
//   `velopack` npm dependency in package-lock.json, because the client library
//   and the packaging CLI must agree on the on-disk/release-feed serialization
//   format. release.yml carried that requirement as a comment ("Match the npm
//   `velopack` package version to keep client/server serialization in sync")
//   next to a hardcoded `--version 1.2.0` — two numbers a dependency bump could
//   drift apart. Reading the lock makes the coupling mechanical instead.
//
// Usage from JS:
//   import { ensureVpk } from './vpk-path.mjs';
//   execFileSync(ensureVpk(), ['pack', ...]);
//
// Usage from a shell (pwsh / bash / CI), prints the absolute path on stdout:
//   node scripts/vpk-path.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

function log(msg) {
    // stderr, not stdout — stdout carries the resolved path for shell callers
    // that capture it (`$vpk = node scripts/vpk-path.mjs`).
    console.error(`[vpk-path] ${msg}`);
}

/**
 * Resolve the exact `velopack` version from a package-lock.json's text.
 * Exported for unit testing. Throws rather than guessing: a missing entry means
 * the dependency was renamed or removed, and silently falling back to a
 * hardcoded version is how the two numbers drift apart again.
 */
export function readVelopackVersion(lockJsonText) {
    const lock = JSON.parse(lockJsonText);
    const version = lock.packages?.['node_modules/velopack']?.version;
    if (typeof version !== 'string' || version.length === 0) {
        throw new Error(
            'package-lock.json: no resolved version for the `velopack` dependency. ' +
                'The vpk CLI version tracks it; run `npm install` or restore the dependency.',
        );
    }
    return version;
}

/** The pinned vpk CLI version — the resolved `velopack` npm dependency. */
export function vpkVersion() {
    return readVelopackVersion(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
}

/** Absolute path to the version-scoped tool directory (gitignored). */
export function vpkDir(version = vpkVersion()) {
    return join(REPO_ROOT, 'dependencies', 'vpk', `v${version}`);
}

/**
 * Absolute path to the vpk executable. `vpk.exe` on Windows, `vpk` elsewhere —
 * both package-linux.mjs (Linux) and package:pack (Windows) call this.
 * Does NOT install; use ensureVpk() for that.
 */
export function vpkExePath(version = vpkVersion()) {
    const exe = process.platform === 'win32' ? 'vpk.exe' : 'vpk';
    return join(vpkDir(version), exe);
}

/**
 * Return the absolute path to vpk, installing it into the app's own
 * dependencies/ folder first if it is not already there.
 *
 * Idempotent by existence check: a second call is a no-op that does not shell
 * out to dotnet at all. (`dotnet tool install` into a populated --tool-path is
 * itself a harmless exit-0 "is already installed", but skipping it keeps repeat
 * builds from paying the round-trip.)
 */
export function ensureVpk() {
    const version = vpkVersion();
    const exePath = vpkExePath(version);
    if (existsSync(exePath)) {
        return exePath;
    }

    const dir = vpkDir(version);
    log(`vpk ${version} not present; installing into ${dir}`);
    // Array-form args — no shell interpolation, no injection surface.
    // `dotnet` from PATH is intentional: it is the toolchain fetching the
    // dependency, not an app dependency itself.
    // stdio: child stdout is redirected to OUR stderr (fd 2), not inherited.
    // `dotnet tool install` chats on stdout ("Tool 'vpk' was successfully
    // installed"), and this module's stdout contract is "the resolved path and
    // nothing else" -- a shell caller doing `$vpk = node scripts/vpk-path.mjs`
    // would otherwise capture three lines on a cold run and none on a warm one.
    execFileSync('dotnet', ['tool', 'install', 'vpk', '--version', version, '--tool-path', dir], {
        stdio: ['ignore', 2, 'inherit'],
    });

    if (!existsSync(exePath)) {
        throw new Error(
            `dotnet tool install reported success but ${exePath} does not exist. ` +
                'Refusing to fall back to a PATH-resolved vpk.',
        );
    }
    log(`vpk ${version} ready at ${exePath}`);
    return exePath;
}

// CLI entry: ensure + print the absolute path on stdout, for shell callers.
// argv[1] is UNDEFINED under `node -e` -- which is exactly how the `package:pack`
// npm script imports this module -- and pathToFileURL(undefined) throws, so the
// guard must short-circuit before it rather than assume a script path exists.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        process.stdout.write(`${ensureVpk()}\n`);
    } catch (e) {
        log(`failed to resolve vpk: ${e.message}`);
        process.exit(1);
    }
}
