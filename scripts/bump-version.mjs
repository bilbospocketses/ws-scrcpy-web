#!/usr/bin/env node
// scripts/bump-version.mjs
//
// Bump the project version in lockstep across:
//   - package.json     (npm package version)
//   - Cargo.toml       (workspace.package.version, propagated to launcher + tray)
//   - Cargo.lock       (the workspace member crates' resolved version entries)
//   - CHANGELOG.md     ([Unreleased] -> [<version>] - YYYY-MM-DD; new [Unreleased] block left empty)
//
// Usage:
//   node scripts/bump-version.mjs <new-version>
//   npm run version:bump <new-version>
//
// Validates the new version is well-formed semver before touching any files.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

// Liberal semver regex: major.minor.patch with optional prerelease and build metadata.
// Examples: 0.1.0, 0.1.0-pre.1, 1.0.0-beta.3+build.4
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function validateSemver(v) {
    if (typeof v !== 'string' || !SEMVER_RE.test(v)) {
        throw new Error(`Invalid semver: "${v}"`);
    }
}

export function bumpPackageJson(content, newVersion) {
    const updated = content.replace(/("version"\s*:\s*")[^"]+(")/, `$1${newVersion}$2`);
    if (updated === content) {
        throw new Error('package.json: no "version" field found to update');
    }
    return updated;
}

export function bumpCargoToml(content, newVersion) {
    // Match the version field within [workspace.package]. Non-greedy so we
    // stop at the FIRST `version = "..."` after `[workspace.package]`.
    const re = /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/;
    const updated = content.replace(re, `$1${newVersion}$2`);
    if (updated === content) {
        throw new Error('Cargo.toml: [workspace.package] version field not found');
    }
    return updated;
}

// The workspace member crates whose Cargo.lock versions track the app version
// (they inherit `version.workspace = true` from Cargo.toml).
export const WORKSPACE_CRATES = [
    'ws-scrcpy-web-common',
    'ws-scrcpy-web-launcher',
    'ws-scrcpy-web-tray',
];

/**
 * Sync the workspace member crates' resolved versions in Cargo.lock. Done by
 * text-rewrite (NOT `cargo update`) so it runs in the auto-release bump job,
 * which has Node but no Rust toolchain (auto-release.yml). Without this the
 * lock's [[package]] versions lag the manifest until a release build
 * regenerates the lock — the drift item 40 was logged for.
 */
export function bumpCargoLock(content, newVersion) {
    let updated = content;
    let changed = 0;
    for (const crate of WORKSPACE_CRATES) {
        // Replace the `version = "..."` line immediately following this crate's
        // [[package]] `name = "..."` line. The crate names also appear as bare
        // entries in other crates' `dependencies = [...]` lists (no version),
        // which this pattern leaves untouched.
        const re = new RegExp(`(name = "${crate}"\\r?\\nversion = ")[^"]+(")`);
        const next = updated.replace(re, `$1${newVersion}$2`);
        if (next !== updated) changed++;
        updated = next;
    }
    if (changed !== WORKSPACE_CRATES.length) {
        throw new Error(
            `Cargo.lock: expected to update ${WORKSPACE_CRATES.length} workspace crate ` +
                `versions but updated ${changed}. Did a workspace crate get renamed?`,
        );
    }
    return updated;
}

export function formatToday(now = new Date()) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function bumpChangelog(content, newVersion, today = formatToday()) {
    if (content.includes(`## [${newVersion}]`)) {
        throw new Error(`CHANGELOG.md already has a section for [${newVersion}]`);
    }

    const lines = content.split(/\r?\n/);
    const unreleasedIdx = lines.findIndex((l) => l.trim() === '## [Unreleased]');
    if (unreleasedIdx === -1) {
        throw new Error('CHANGELOG.md does not contain "## [Unreleased]" section');
    }

    // Find the next `## ` heading after [Unreleased]; everything between
    // [Unreleased] and that heading is the body to move to the new version.
    let nextHeadingIdx = lines.length;
    for (let i = unreleasedIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) {
            nextHeadingIdx = i;
            break;
        }
    }

    // Extract the body content (lines between [Unreleased] heading and next heading).
    // Drop any leading blank lines: the canonical CHANGELOG format has a blank line
    // immediately after `## [Unreleased]`, and we already emit our own blank line
    // separator between the new version heading and the body — keeping the captured
    // leading blank would produce a doubled-blank.
    const rawBodyLines = lines.slice(unreleasedIdx + 1, nextHeadingIdx);
    const firstNonBlank = rawBodyLines.findIndex((l) => l.trim() !== '');
    const bodyLines = firstNonBlank === -1 ? [] : rawBodyLines.slice(firstNonBlank);

    // Build the new lines array:
    // [... before Unreleased ...]
    // ## [Unreleased]
    // <blank line>
    // ## [<version>] - <date>
    // <blank line>
    // <body, leading blanks stripped>
    // [... rest of file ...]

    const beforeUnreleased = lines.slice(0, unreleasedIdx);
    const afterBody = lines.slice(nextHeadingIdx);

    const newHeading = `## [${newVersion}] - ${today}`;
    const newLines = [
        ...beforeUnreleased,
        '## [Unreleased]',
        '',
        newHeading,
        '',
        ...bodyLines,
        ...afterBody,
    ];

    return newLines.join('\n');
}

async function main() {
    const newVersion = process.argv[2];
    if (!newVersion) {
        console.error('Usage: node scripts/bump-version.mjs <new-version>');
        process.exit(1);
    }
    validateSemver(newVersion);

    const today = formatToday();
    const pkgPath = join(REPO_ROOT, 'package.json');
    const cargoPath = join(REPO_ROOT, 'Cargo.toml');
    const cargoLockPath = join(REPO_ROOT, 'Cargo.lock');
    const changelogPath = join(REPO_ROOT, 'CHANGELOG.md');

    const pkg = readFileSync(pkgPath, 'utf8');
    const cargo = readFileSync(cargoPath, 'utf8');
    const cargoLock = readFileSync(cargoLockPath, 'utf8');
    const changelog = readFileSync(changelogPath, 'utf8');

    // Compute first (so any failure leaves all files untouched).
    const newPkg = bumpPackageJson(pkg, newVersion);
    const newCargo = bumpCargoToml(cargo, newVersion);
    const newCargoLock = bumpCargoLock(cargoLock, newVersion);
    const newChangelog = bumpChangelog(changelog, newVersion, today);

    writeFileSync(pkgPath, newPkg);
    writeFileSync(cargoPath, newCargo);
    writeFileSync(cargoLockPath, newCargoLock);
    writeFileSync(changelogPath, newChangelog);

    console.log(`Bumped to v${newVersion}`);
    console.log('  package.json     OK');
    console.log('  Cargo.toml       OK');
    console.log('  Cargo.lock       OK');
    console.log(`  CHANGELOG.md     OK ([${newVersion}] - ${today})`);
}

// Run main when invoked as the entry script (not when imported by tests).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/bump-version.mjs')) {
    main().catch((e) => {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    });
}
