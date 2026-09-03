#!/usr/bin/env node
// scripts/build-suite-bundle.mjs
//
// Build the Playwright suite bundle qa-harness mounts into its Linux runner
// (P3 §8 artifacts 2 and 3): `wssw-suite-<version>.tar.gz` carrying `tests/`,
// the two Playwright configs, `qa-manifest.json`, `tsconfig.json`,
// `package.json` and `package-lock.json` — and nothing else. The runner drives
// a *published image*; a bundle carrying `src/` or `dist/` would invite exactly
// the source coupling §8 forbids, one convenience at a time. `tsconfig.json`
// rides along because `tests/e2e/tsconfig.json` extends it; without it the
// suite cannot be typechecked from inside the bundle.
//
//   node scripts/build-suite-bundle.mjs [--out <dir>] [--verify]
//
// `--out` defaults to `Releases/` (gitignored). `--verify` extracts the finished
// archive into `.suite-check/` and typechecks the suite from inside the copy,
// so a bundle missing a file fails here, not in the harness as a Playwright
// module-resolution error a long way from its cause.
//
// The manifest is checked before anything is archived: `runner.playwrightVersion`
// must equal the version `package-lock.json` locks for `@playwright/test`. The
// runner refuses a bundle whose version differs from the one baked into its
// image, so a stale manifest would fail at run time with a browser error that
// names neither version. Every suite's `command` must be an npm script, and
// every `suiteMap` entry must point into the bundle.
//
// tar is invoked by absolute path only — `C:\Windows\System32\tar.exe` on
// Windows, `resolvePosixTar()` elsewhere — never the bare name $PATH would
// resolve (Local-Dependencies-Only, the same policy as fetch-node.mjs).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePosixTar } from './posix-tar.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS_TAR = 'C:\\Windows\\System32\\tar.exe';

/** Top-level members of the bundle, relative to the repo root. Nothing else goes in. */
export const BUNDLE_MEMBERS = [
    'tests',
    'playwright.config.ts',
    'playwright.docker.config.ts',
    'qa-manifest.json',
    'tsconfig.json',
    'package.json',
    'package-lock.json',
];

/** Directory names skipped anywhere under a member: build outputs and run artefacts. */
export const EXCLUDED_DIRS = new Set([
    'node_modules',
    'dist',
    'build',
    'test-results',
    'playwright-report',
    'blob-report',
    '__pycache__',
]);

/** File names skipped anywhere under a member. */
export const EXCLUDED_FILE_PATTERNS = [/\.log(\.\d+)?$/, /\.tsbuildinfo$/, /^\.DS_Store$/];

/** Whether a bundle-relative POSIX path belongs in the archive. */
export function includeEntry(relPath) {
    const parts = relPath.split('/');
    if (parts.slice(0, -1).some((p) => EXCLUDED_DIRS.has(p))) {
        return false;
    }
    const base = parts[parts.length - 1] ?? '';
    return !EXCLUDED_FILE_PATTERNS.some((re) => re.test(base));
}

/** The archive's file name for a package version. */
export function bundleName(version) {
    return `wssw-suite-${version}.tar.gz`;
}

/**
 * Every file the bundle will carry, as sorted bundle-relative POSIX paths.
 * Throws if a member is missing: a bundle built without, say, the manifest is
 * not a bundle with a warning, it is the wrong artefact.
 */
export function collectBundleFiles(root, fsApi = fs) {
    const files = [];
    const walk = (rel) => {
        const abs = path.join(root, rel);
        for (const entry of fsApi.readdirSync(abs, { withFileTypes: true })) {
            const childRel = `${rel}/${entry.name}`;
            if (entry.isDirectory()) {
                if (!EXCLUDED_DIRS.has(entry.name)) {
                    walk(childRel);
                }
            } else if (includeEntry(childRel)) {
                files.push(childRel);
            }
        }
    };
    for (const member of BUNDLE_MEMBERS) {
        const st = fsApi.statSync(path.join(root, member), { throwIfNoEntry: false });
        if (!st) {
            throw new Error(`bundle member missing: ${member}`);
        }
        if (st.isDirectory()) {
            walk(member);
        } else {
            files.push(member);
        }
    }
    return files.sort();
}

/**
 * Problems with the manifest, as human-readable strings. Empty means it is fit
 * to ship. `lock` is the parsed package-lock.json, `pkg` the parsed package.json,
 * `files` the bundle file list.
 */
export function checkManifest(manifest, { lock, pkg, files }) {
    const problems = [];
    if (manifest.schemaVersion !== 1) {
        problems.push(`schemaVersion must be 1, is ${JSON.stringify(manifest.schemaVersion)}`);
    }
    if (manifest.subject !== pkg.name) {
        problems.push(`subject must be the package name '${pkg.name}', is ${JSON.stringify(manifest.subject)}`);
    }
    const locked = lock?.packages?.['node_modules/@playwright/test']?.version;
    if (!locked) {
        problems.push('package-lock.json does not lock @playwright/test');
    } else if (manifest.runner?.playwrightVersion !== locked) {
        problems.push(
            `runner.playwrightVersion is ${JSON.stringify(manifest.runner?.playwrightVersion)} ` +
                `but package-lock.json locks @playwright/test ${locked} — the runner refuses a skew`,
        );
    }
    const suites = Array.isArray(manifest.suites) ? manifest.suites : [];
    if (suites.length === 0) {
        problems.push('suites is empty');
    }
    for (const suite of suites) {
        const m = /^npm run (\S+)$/.exec(suite.command ?? '');
        if (!m || !pkg.scripts?.[m[1]]) {
            problems.push(`suite '${suite.name}' command ${JSON.stringify(suite.command)} is not an npm script of this package`);
        }
    }
    for (const [name, dir] of Object.entries(manifest.suiteMap ?? {})) {
        if (!suites.some((s) => s.name === name)) {
            problems.push(`suiteMap.${name} names a suite that is not declared in suites`);
        }
        if (!files.some((f) => f === dir || f.startsWith(`${dir}/`))) {
            problems.push(`suiteMap.${name} -> ${dir} is not in the bundle`);
        }
    }
    return problems;
}

/** The tar to run: absolute path, per platform, never a bare name. */
export function resolveTar(platform = process.platform, existsSync = fs.existsSync) {
    if (platform === 'win32') {
        if (!existsSync(WINDOWS_TAR)) {
            throw new Error(`expected bsdtar at ${WINDOWS_TAR}`);
        }
        return WINDOWS_TAR;
    }
    return resolvePosixTar(existsSync);
}

function readJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
}

function sha256(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Build the archive into `outDir`; returns { archive, sha256, name, files }. */
export function build({ outDir }) {
    const pkg = readJson('package.json');
    const lock = readJson('package-lock.json');
    const manifest = readJson('qa-manifest.json');
    const files = collectBundleFiles(REPO);
    const problems = checkManifest(manifest, { lock, pkg, files });
    if (problems.length > 0) {
        throw new Error(`qa-manifest.json is not fit to ship:\n  - ${problems.join('\n  - ')}`);
    }

    // Stage a copy so the archive holds exactly the listed files under clean
    // top-level names, whichever tar builds it.
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'wssw-suite-'));
    try {
        for (const rel of files) {
            const dest = path.join(staging, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(path.join(REPO, rel), dest);
        }
        fs.mkdirSync(outDir, { recursive: true });
        const name = bundleName(pkg.version);
        const archive = path.resolve(outDir, name);
        fs.rmSync(archive, { force: true });
        execFileSync(resolveTar(), ['-czf', archive, '-C', staging, ...BUNDLE_MEMBERS], { stdio: 'inherit' });
        const digest = sha256(archive);
        fs.writeFileSync(`${archive}.sha256`, `${digest}  ${name}\n`);
        return { archive, sha256: digest, name, files };
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

/**
 * Extract the archive into `<repo>/.suite-check` and typecheck the suite from
 * inside the copy. Under the repo on purpose: TypeScript resolves
 * `@playwright/test` and `@types/node` by walking up to the repo's
 * node_modules, the way the runner's NODE_PATH does for the real bundle.
 */
export function verify(archive) {
    const check = path.join(REPO, '.suite-check');
    fs.rmSync(check, { recursive: true, force: true });
    fs.mkdirSync(check, { recursive: true });
    execFileSync(resolveTar(), ['-xzf', archive, '-C', check], { stdio: 'inherit' });

    const manifest = JSON.parse(fs.readFileSync(path.join(check, 'qa-manifest.json'), 'utf8'));
    if (typeof manifest.runner?.playwrightVersion !== 'string') {
        throw new Error('extracted qa-manifest.json has no runner.playwrightVersion — the runner would exit 40');
    }
    for (const dir of Object.values(manifest.suiteMap ?? {})) {
        if (!fs.existsSync(path.join(check, dir))) {
            throw new Error(`extracted bundle lacks suiteMap target ${dir}`);
        }
    }

    const tsc = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
    try {
        execFileSync(process.execPath, [tsc, '-p', path.join(check, 'tests', 'e2e'), '--noEmit'], { stdio: 'inherit' });
    } catch (err) {
        throw new Error(`the suite does not typecheck from inside the bundle (left in ${check} for inspection): ${err.message}`);
    }
    fs.rmSync(check, { recursive: true, force: true });
}

function parseArgs(argv) {
    const opts = { outDir: path.join(REPO, 'Releases'), verify: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--out') {
            const value = argv[++i];
            if (!value) {
                throw new Error('--out needs a directory');
            }
            opts.outDir = path.resolve(value);
        } else if (arg === '--verify') {
            opts.verify = true;
        } else {
            throw new Error(`unknown argument ${arg}`);
        }
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const result = build(opts);
    console.error(`[suite-bundle] ${result.files.length} files -> ${result.archive}`);
    if (opts.verify) {
        verify(result.archive);
        console.error('[suite-bundle] verified: the suite typechecks from inside the extracted bundle');
    }
    // stdout carries exactly the sha256sum-format line, for the release step to record.
    process.stdout.write(`${result.sha256}  ${result.name}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        main();
    } catch (err) {
        console.error(`[suite-bundle] ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
