#!/usr/bin/env node
// scripts/extract-changelog.mjs
//
// Extract a single version's section from CHANGELOG.md, ready to feed to
// softprops/action-gh-release as `body_path`.
//
// Usage:
//   node scripts/extract-changelog.mjs <version> [--out <path>] [--unsigned]
//   node scripts/extract-changelog.mjs v0.1.0
//   node scripts/extract-changelog.mjs Unreleased --unsigned > release-notes.md
//
// Behavior:
//   - Strips a leading `v` from <version> if present (`v0.1.0` -> `0.1.0`).
//   - Looks for `## [<version>]` in CHANGELOG.md (e.g., `## [0.1.0] - 2026-04-26`).
//   - Captures content between that header and the next `## [` header (or EOF).
//   - Always prepends a SignPath Foundation credit (OSS program requirement).
//   - With --unsigned, additionally prepends a warning block AFTER the
//     credit but BEFORE the captured content.
//   - Default output is stdout. With --out <path>, writes to file.
//   - Throws (exit 1 with descriptive message) if the version section isn't found.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

export const SIGNPATH_CREDIT =
    '_Signed via [SignPath Foundation](https://signpath.org)._\n\n';

export const UNSIGNED_WARNING =
    '> ⚠️ **This release is unsigned.** [SignPath Foundation](https://signpath.org) is reviewing our application for free OSS code-signing. Once approved, we\'ll cut a signed v0.1.1. Until then, you may see Windows SmartScreen warnings — verify integrity via the `SHA256SUMS` file in this release.\n\n';

/**
 * Strip a single leading `v` from a version string. `v0.1.0` -> `0.1.0`,
 * `0.1.0` -> `0.1.0`, `Unreleased` -> `Unreleased`.
 */
export function normalizeVersion(version) {
    if (typeof version !== 'string' || version.length === 0) {
        throw new Error('version must be a non-empty string');
    }
    if (version.startsWith('v') || version.startsWith('V')) {
        return version.slice(1);
    }
    return version;
}

/**
 * Extract the body of the `## [<version>]` section from CHANGELOG markdown.
 * Returns the text between the header line and the next `## [` header (or EOF),
 * with leading/trailing blank lines trimmed.
 *
 * Throws if the section can't be found.
 */
export function extractSection(changelogContent, version) {
    const normalized = normalizeVersion(version);
    const lines = changelogContent.split(/\r?\n/);

    // Find the header. Match `## [<version>]` (with optional trailing text like ` - 2026-04-26`).
    // Use a literal-string check to avoid regex escaping pitfalls in version strings.
    const headerPrefix = `## [${normalized}]`;
    const headerIdx = lines.findIndex((l) => l.startsWith(headerPrefix));
    if (headerIdx === -1) {
        throw new Error(
            `CHANGELOG.md: section "## [${normalized}]" not found. Did you forget to bump CHANGELOG?`,
        );
    }

    // Capture from line after header up to the next `## [` header or EOF.
    let endIdx = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## [')) {
            endIdx = i;
            break;
        }
    }

    const sectionLines = lines.slice(headerIdx + 1, endIdx);

    // Trim leading/trailing blank lines.
    while (sectionLines.length > 0 && sectionLines[0].trim() === '') {
        sectionLines.shift();
    }
    while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1].trim() === '') {
        sectionLines.pop();
    }

    return sectionLines.join('\n');
}

/**
 * Build the final release-notes markdown for <version>.
 * Always prepends the SignPath credit; if `unsigned`, also prepends the warning block.
 */
export function buildReleaseNotes(changelogContent, version, { unsigned = false } = {}) {
    const section = extractSection(changelogContent, version);
    const prefix = unsigned ? SIGNPATH_CREDIT + UNSIGNED_WARNING : SIGNPATH_CREDIT;
    // Section may be empty for an empty `[Unreleased]`; still emit the prefix.
    return section.length === 0 ? prefix.replace(/\n+$/, '\n') : prefix + section + '\n';
}

function parseArgs(argv) {
    const args = { version: null, out: null, unsigned: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--unsigned') {
            args.unsigned = true;
        } else if (a === '--out') {
            args.out = argv[++i];
            if (!args.out) {
                throw new Error('--out requires a path argument');
            }
        } else if (a.startsWith('--out=')) {
            args.out = a.slice('--out='.length);
        } else if (a.startsWith('--')) {
            throw new Error(`Unknown flag: ${a}`);
        } else if (args.version === null) {
            args.version = a;
        } else {
            throw new Error(`Unexpected positional argument: ${a}`);
        }
    }
    if (!args.version) {
        throw new Error('Usage: node scripts/extract-changelog.mjs <version> [--out <path>] [--unsigned]');
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const changelogPath = join(REPO_ROOT, 'CHANGELOG.md');
    const changelog = readFileSync(changelogPath, 'utf8');
    const notes = buildReleaseNotes(changelog, args.version, { unsigned: args.unsigned });

    if (args.out) {
        writeFileSync(args.out, notes);
    } else {
        process.stdout.write(notes);
    }
}

// Run when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/extract-changelog.mjs')) {
    main().catch((e) => {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    });
}
