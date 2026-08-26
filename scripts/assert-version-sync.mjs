#!/usr/bin/env node
// scripts/assert-version-sync.mjs
//
// CI gate: assert that package.json, Cargo.toml [workspace.package].version,
// and the supplied git tag (with `v` prefix stripped) all agree.
//
// Usage:
//   node scripts/assert-version-sync.mjs <git-tag>
//   npm run version:check <git-tag>
//
// Examples:
//   node scripts/assert-version-sync.mjs v0.1.0    # passes if all == 0.1.0
//   node scripts/assert-version-sync.mjs 0.1.0     # also accepted

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

export function stripVPrefix(tag) {
    if (typeof tag !== 'string') {
        throw new Error(`Tag must be a string, got ${typeof tag}`);
    }
    return tag.startsWith('v') ? tag.slice(1) : tag;
}

export function readPackageJsonVersion(content) {
    const match = content.match(/"version"\s*:\s*"([^"]+)"/);
    if (!match) {
        throw new Error('package.json: no "version" field found');
    }
    return match[1];
}

export function readCargoTomlVersion(content) {
    // Match the version field within [workspace.package]. Non-greedy.
    const re = /\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/;
    const match = content.match(re);
    if (!match) {
        throw new Error('Cargo.toml: [workspace.package] version field not found');
    }
    return match[1];
}

/**
 * package-lock.json carries the version twice — at the root and on the
 * `packages[""]` self-entry — and both must agree with package.json, or the
 * next `npm install` rewrites the lock and dirties a clean checkout.
 */
export function readPackageLockVersion(content) {
    const lock = JSON.parse(content);
    const root = lock.version;
    if (typeof root !== 'string') {
        throw new Error('package-lock.json: no root "version" field found');
    }
    const self = lock.packages?.['']?.version;
    if (typeof self === 'string' && self !== root) {
        throw new Error(`package-lock.json: root version "${root}" disagrees with packages[""] "${self}"`);
    }
    return root;
}

// `lockVersion` is optional so existing callers/tests that predate the
// package-lock check keep working; when supplied it must match the rest.
export function check({ pkgVersion, cargoVersion, tagVersion, lockVersion }) {
    const all = [pkgVersion, cargoVersion, tagVersion];
    if (lockVersion !== undefined) {
        all.push(lockVersion);
    }
    const unique = new Set(all);
    if (unique.size === 1) {
        return { ok: true, version: pkgVersion };
    }
    return {
        ok: false,
        pkgVersion,
        cargoVersion,
        tagVersion,
        lockVersion,
    };
}

function main() {
    const tag = process.argv[2];
    if (!tag) {
        console.error('Usage: node scripts/assert-version-sync.mjs <git-tag>');
        process.exit(1);
    }
    const tagVersion = stripVPrefix(tag);

    const pkgVersion = readPackageJsonVersion(
        readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    );
    const cargoVersion = readCargoTomlVersion(
        readFileSync(join(REPO_ROOT, 'Cargo.toml'), 'utf8'),
    );
    const lockVersion = readPackageLockVersion(
        readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'),
    );

    const result = check({ pkgVersion, cargoVersion, tagVersion, lockVersion });

    if (result.ok) {
        console.log(`Versions in sync: ${result.version}`);
        process.exit(0);
    }

    console.error('Version mismatch detected:');
    console.error(`  package.json:      ${pkgVersion}`);
    console.error(`  package-lock.json: ${lockVersion}`);
    console.error(`  Cargo.toml:        ${cargoVersion}`);
    console.error(`  git tag (input):   ${tagVersion}  (from "${tag}")`);
    console.error('');
    console.error('Run `npm run version:bump <new-version>` to bring them all into sync,');
    console.error('then commit and re-tag.');
    process.exit(1);
}

if (
    process.argv[1] &&
    process.argv[1].replace(/\\/g, '/').endsWith('scripts/assert-version-sync.mjs')
) {
    try {
        main();
    } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    }
}
