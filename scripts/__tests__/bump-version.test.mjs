import { describe, expect, it } from 'vitest';
import {
    bumpCargoLock,
    bumpCargoToml,
    bumpChangelog,
    bumpPackageJson,
    formatToday,
    validateSemver,
} from '../bump-version.mjs';

describe('validateSemver', () => {
    it('accepts plain semver', () => {
        expect(() => validateSemver('0.1.0')).not.toThrow();
        expect(() => validateSemver('1.2.3')).not.toThrow();
        expect(() => validateSemver('0.0.0')).not.toThrow();
    });

    it('accepts prerelease', () => {
        expect(() => validateSemver('0.1.0-pre.1')).not.toThrow();
        expect(() => validateSemver('1.0.0-beta.3')).not.toThrow();
    });

    it('accepts prerelease with build metadata', () => {
        expect(() => validateSemver('1.0.0-beta.3+build.4')).not.toThrow();
    });

    it('rejects v-prefix', () => {
        expect(() => validateSemver('v0.1.0')).toThrow(/Invalid semver/);
    });

    it('rejects partial versions', () => {
        expect(() => validateSemver('1.0')).toThrow(/Invalid semver/);
        expect(() => validateSemver('1')).toThrow(/Invalid semver/);
    });

    it('rejects non-string', () => {
        expect(() => validateSemver(undefined)).toThrow(/Invalid semver/);
        expect(() => validateSemver(null)).toThrow(/Invalid semver/);
        expect(() => validateSemver(123)).toThrow(/Invalid semver/);
    });
});

describe('bumpPackageJson', () => {
    it('replaces the top-level version field', () => {
        const input = '{\n  "name": "x",\n  "version": "1.0.0",\n  "other": 1\n}';
        const out = bumpPackageJson(input, '0.1.0');
        expect(out).toContain('"version": "0.1.0"');
        expect(out).not.toContain('"version": "1.0.0"');
    });

    it('preserves surrounding formatting', () => {
        const input = '{\n  "version": "1.2.3"\n}';
        const out = bumpPackageJson(input, '4.5.6');
        expect(out).toBe('{\n  "version": "4.5.6"\n}');
    });

    it('throws if no version field', () => {
        expect(() => bumpPackageJson('{}', '0.1.0')).toThrow(/no "version" field/);
    });
});

describe('bumpCargoToml', () => {
    const sampleCargo = `[workspace]
resolver = "2"
members = ["launcher", "tray"]

[workspace.package]
version = "0.0.0"
edition = "2021"

[workspace.dependencies]
serde = { version = "1.0" }
`;

    it('replaces the workspace.package version', () => {
        const out = bumpCargoToml(sampleCargo, '0.1.0');
        expect(out).toContain('version = "0.1.0"');
        expect(out).not.toContain('version = "0.0.0"');
    });

    it('does NOT touch dependency versions', () => {
        const out = bumpCargoToml(sampleCargo, '0.1.0');
        // serde dep version still "1.0"
        expect(out).toContain('serde = { version = "1.0" }');
    });

    it('throws if no workspace.package version found', () => {
        const noWorkspace = '[package]\nversion = "0.1.0"\n';
        expect(() => bumpCargoToml(noWorkspace, '0.2.0')).toThrow(/\[workspace\.package\]/);
    });
});

describe('bumpChangelog', () => {
    const sampleChangelog = `# Changelog

## [Unreleased]

### Added
- some new thing

## [0.0.1] - 2026-01-01

### Added
- initial
`;

    it('inserts new release header before the next section', () => {
        const out = bumpChangelog(sampleChangelog, '0.1.0', '2026-04-26');
        expect(out).toContain('## [Unreleased]');
        expect(out).toContain('## [0.1.0] - 2026-04-26');
        expect(out).toContain('## [0.0.1] - 2026-01-01');
        // Order: [Unreleased] -> [0.1.0] -> [0.0.1]
        const idxUnreleased = out.indexOf('## [Unreleased]');
        const idxNew = out.indexOf('## [0.1.0]');
        const idxOld = out.indexOf('## [0.0.1]');
        expect(idxUnreleased).toBeLessThan(idxNew);
        expect(idxNew).toBeLessThan(idxOld);
    });

    it('relocates [Unreleased] content to the new version heading', () => {
        const out = bumpChangelog(sampleChangelog, '0.1.0', '2026-04-26');
        // The "some new thing" entry should now appear under [0.1.0], not [Unreleased]
        const unreleasedSection = out.slice(
            out.indexOf('## [Unreleased]'),
            out.indexOf('## [0.1.0]'),
        );
        expect(unreleasedSection).not.toContain('some new thing');

        // Verify it appears under the new version heading
        const newVersionSection = out.slice(
            out.indexOf('## [0.1.0]'),
            out.indexOf('## [0.0.1]'),
        );
        expect(newVersionSection).toContain('some new thing');
    });

    it('throws if [Unreleased] section is missing', () => {
        const noUnreleased = '# Changelog\n\n## [0.0.1] - 2026-01-01\n';
        expect(() => bumpChangelog(noUnreleased, '0.1.0')).toThrow(/Unreleased/);
    });

    it('throws if a section for the target version already exists', () => {
        const dup = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-04-01\n';
        expect(() => bumpChangelog(dup, '0.1.0')).toThrow(/already has a section for \[0\.1\.0\]/);
    });

    it('handles a changelog with only [Unreleased] (no prior release)', () => {
        const empty = '# Changelog\n\n## [Unreleased]\n';
        const out = bumpChangelog(empty, '0.1.0', '2026-04-26');
        expect(out).toContain('## [0.1.0] - 2026-04-26');
    });

    it('relocates body under Unreleased to the new version heading', () => {
        const input = `# Changelog

## [Unreleased]

- Some change.
- Another change.

## [0.0.1] - 2026-01-01

- Old thing.
`;
        const out = bumpChangelog(input, '0.1.0', '2026-04-26');
        // Body (bullets) should be under [0.1.0], not under [Unreleased]
        const unreleasedSection = out.slice(
            out.indexOf('## [Unreleased]'),
            out.indexOf('## [0.1.0]'),
        );
        expect(unreleasedSection).not.toContain('Some change');
        expect(unreleasedSection).not.toContain('Another change');

        const newVersionSection = out.slice(
            out.indexOf('## [0.1.0]'),
            out.indexOf('## [0.0.1]'),
        );
        expect(newVersionSection).toContain('Some change');
        expect(newVersionSection).toContain('Another change');
    });

    it('relocates sub-headings under Unreleased', () => {
        const input = `# Changelog

## [Unreleased]

### Fixed
- Bug fix 1.
- Bug fix 2.

## [0.0.1] - 2026-01-01

### Added
- Initial.
`;
        const out = bumpChangelog(input, '0.1.0', '2026-04-26');

        // "### Fixed" should be under [0.1.0], not under [Unreleased]
        const unreleasedSection = out.slice(
            out.indexOf('## [Unreleased]'),
            out.indexOf('## [0.1.0]'),
        );
        expect(unreleasedSection).not.toContain('### Fixed');
        expect(unreleasedSection).not.toContain('Bug fix');

        const newVersionSection = out.slice(
            out.indexOf('## [0.1.0]'),
            out.indexOf('## [0.0.1]'),
        );
        expect(newVersionSection).toContain('### Fixed');
        expect(newVersionSection).toContain('Bug fix 1');
        expect(newVersionSection).toContain('Bug fix 2');
    });

    it('prepends empty Unreleased above the new version heading', () => {
        const input = `# Changelog

## [Unreleased]

- Some change.

## [0.0.1] - 2026-01-01

- Old.
`;
        const out = bumpChangelog(input, '0.1.0', '2026-04-26');

        // [Unreleased] should appear BEFORE [0.1.0]
        const idxUnreleased = out.indexOf('## [Unreleased]');
        const idxNew = out.indexOf('## [0.1.0]');
        expect(idxUnreleased).toBeLessThan(idxNew);

        // [Unreleased] should be mostly empty (just the heading + blank line)
        const unreleasedSection = out.slice(idxUnreleased, idxNew);
        // Should contain the heading and maybe a blank line, but NOT the old content
        expect(unreleasedSection).toContain('## [Unreleased]');
        expect(unreleasedSection).not.toContain('Some change');
    });

    it('handles empty Unreleased correctly', () => {
        const input = `# Changelog

## [Unreleased]

## [0.0.1] - 2026-01-01

- Old.
`;
        const out = bumpChangelog(input, '0.1.0', '2026-04-26');

        // [Unreleased] section should be empty (just heading + blank line)
        const idxUnreleased = out.indexOf('## [Unreleased]');
        const idxNew = out.indexOf('## [0.1.0]');
        const unreleasedSection = out.slice(idxUnreleased, idxNew).trim();

        // New version section should also be empty (just heading + blank line)
        const idxOld = out.indexOf('## [0.0.1]');
        const newVersionSection = out.slice(idxNew, idxOld).trim();

        expect(unreleasedSection).toBe('## [Unreleased]');
        expect(newVersionSection).toBe('## [0.1.0] - 2026-04-26');
    });

    it('does not produce a doubled blank line between new version heading and body', () => {
        // The canonical CHANGELOG format has a blank line after `## [Unreleased]`.
        // bumpChangelog must strip the captured leading blank so the output is:
        //   ## [<new>] - DATE\n\n### Fixed
        // not:
        //   ## [<new>] - DATE\n\n\n### Fixed
        const input = `# Changelog

## [Unreleased]

### Fixed
- A fix.

## [0.0.1] - 2026-01-01
`;
        const out = bumpChangelog(input, '0.1.0', '2026-04-26');
        // Exactly one blank line between the new heading and "### Fixed".
        expect(out).toContain('## [0.1.0] - 2026-04-26\n\n### Fixed');
        expect(out).not.toContain('## [0.1.0] - 2026-04-26\n\n\n### Fixed');
    });
});

describe('formatToday', () => {
    it('zero-pads month and day', () => {
        expect(formatToday(new Date(2026, 0, 5))).toBe('2026-01-05');
    });

    it('uses 4-digit year', () => {
        expect(formatToday(new Date(2026, 11, 31))).toBe('2026-12-31');
    });
});

describe('bumpCargoLock', () => {
    // Mirrors the real Cargo.lock shape: each workspace member is a [[package]]
    // block whose `version = "..."` line immediately follows `name = "..."`.
    // The members also appear as bare names inside other crates' dependency
    // lists (no version attached) — those must NOT be rewritten.
    const sampleLock = `# This file is automatically @generated by Cargo.
version = 4

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "ws-scrcpy-web-common"
version = "0.1.30-beta.31"
dependencies = [
 "serde",
]

[[package]]
name = "ws-scrcpy-web-launcher"
version = "0.1.30-beta.31"
dependencies = [
 "ws-scrcpy-web-common",
]

[[package]]
name = "ws-scrcpy-web-tray"
version = "0.1.30-beta.31"
dependencies = [
 "ws-scrcpy-web-common",
]
`;

    it('bumps all three workspace crate versions', () => {
        const out = bumpCargoLock(sampleLock, '0.1.30-beta.37');
        expect(out).toContain('name = "ws-scrcpy-web-common"\nversion = "0.1.30-beta.37"');
        expect(out).toContain('name = "ws-scrcpy-web-launcher"\nversion = "0.1.30-beta.37"');
        expect(out).toContain('name = "ws-scrcpy-web-tray"\nversion = "0.1.30-beta.37"');
        expect(out).not.toContain('0.1.30-beta.31');
    });

    it('does NOT touch third-party crate versions', () => {
        const out = bumpCargoLock(sampleLock, '0.1.30-beta.37');
        expect(out).toContain('name = "serde"\nversion = "1.0.0"');
    });

    it('does NOT rewrite the workspace-crate names inside dependency lists', () => {
        const out = bumpCargoLock(sampleLock, '0.1.30-beta.37');
        expect(out).toContain(' "ws-scrcpy-web-common",');
    });

    it('throws if a workspace crate is missing (rename guard)', () => {
        const renamed = sampleLock.replace('name = "ws-scrcpy-web-tray"', 'name = "ws-scrcpy-web-renamed"');
        expect(() => bumpCargoLock(renamed, '0.1.30-beta.37')).toThrow(/Cargo\.lock/);
    });
});
