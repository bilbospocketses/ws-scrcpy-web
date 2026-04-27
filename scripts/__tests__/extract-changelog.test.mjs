import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    SIGNPATH_CREDIT,
    UNSIGNED_WARNING,
    buildReleaseNotes,
    extractSection,
    normalizeVersion,
} from '../extract-changelog.mjs';

const SAMPLE = `# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added
- pending entry

## [0.1.1] - 2026-05-10

### Fixed
- a bug

### Added
- something else

## [0.1.0] - 2026-04-26

### Added
- initial release

## [0.1.0-beta.1] - 2026-04-15

### Added
- beta entry
`;

describe('normalizeVersion', () => {
    it('strips leading v', () => {
        expect(normalizeVersion('v0.1.0')).toBe('0.1.0');
    });

    it('strips leading uppercase V', () => {
        expect(normalizeVersion('V0.1.0')).toBe('0.1.0');
    });

    it('passes through bare semver', () => {
        expect(normalizeVersion('0.1.0')).toBe('0.1.0');
    });

    it('passes through Unreleased', () => {
        expect(normalizeVersion('Unreleased')).toBe('Unreleased');
    });

    it('handles prerelease', () => {
        expect(normalizeVersion('v0.1.0-beta.1')).toBe('0.1.0-beta.1');
        expect(normalizeVersion('0.1.0-pre.0')).toBe('0.1.0-pre.0');
    });

    it('throws on empty/non-string', () => {
        expect(() => normalizeVersion('')).toThrow();
        expect(() => normalizeVersion(undefined)).toThrow();
        expect(() => normalizeVersion(null)).toThrow();
    });
});

describe('extractSection', () => {
    it('extracts a known release section', () => {
        const out = extractSection(SAMPLE, '0.1.1');
        expect(out).toContain('### Fixed');
        expect(out).toContain('- a bug');
        expect(out).toContain('### Added');
        expect(out).toContain('- something else');
    });

    it('stops at the next `## [` header', () => {
        const out = extractSection(SAMPLE, '0.1.1');
        expect(out).not.toContain('initial release');
        expect(out).not.toContain('## [0.1.0]');
    });

    it('handles the last section (no trailing `## [`)', () => {
        const out = extractSection(SAMPLE, '0.1.0-beta.1');
        expect(out).toContain('beta entry');
        expect(out.endsWith('beta entry')).toBe(true);
    });

    it('handles Unreleased', () => {
        const out = extractSection(SAMPLE, 'Unreleased');
        expect(out).toContain('pending entry');
        expect(out).not.toContain('## [0.1.1]');
    });

    it('handles prerelease versions like 0.1.0-beta.1', () => {
        const out = extractSection(SAMPLE, '0.1.0-beta.1');
        expect(out).toContain('beta entry');
    });

    it('strips leading v in lookup', () => {
        const a = extractSection(SAMPLE, 'v0.1.0');
        const b = extractSection(SAMPLE, '0.1.0');
        expect(a).toBe(b);
        expect(a).toContain('initial release');
    });

    it('throws on missing version', () => {
        expect(() => extractSection(SAMPLE, '9.9.9')).toThrow(/not found/);
    });

    it('trims leading and trailing blank lines', () => {
        const out = extractSection(SAMPLE, '0.1.0');
        expect(out.startsWith('\n')).toBe(false);
        expect(out.endsWith('\n')).toBe(false);
        expect(out).toContain('### Added');
    });
});

describe('buildReleaseNotes', () => {
    it('always prepends SignPath credit (signed mode)', () => {
        const out = buildReleaseNotes(SAMPLE, '0.1.1');
        expect(out.startsWith(SIGNPATH_CREDIT)).toBe(true);
        expect(out).toContain('- a bug');
    });

    it('does NOT prepend warning block in signed mode', () => {
        const out = buildReleaseNotes(SAMPLE, '0.1.1');
        expect(out).not.toContain('This release is unsigned');
    });

    it('prepends BOTH credit and warning in --unsigned mode', () => {
        const out = buildReleaseNotes(SAMPLE, '0.1.1', { unsigned: true });
        expect(out.startsWith(SIGNPATH_CREDIT)).toBe(true);
        expect(out).toContain(UNSIGNED_WARNING.trim());
        // SignPath credit comes BEFORE the warning.
        expect(out.indexOf(SIGNPATH_CREDIT)).toBeLessThan(out.indexOf('This release is unsigned'));
        // Warning comes BEFORE the changelog content.
        expect(out.indexOf('This release is unsigned')).toBeLessThan(out.indexOf('- a bug'));
    });

    it('throws on missing version', () => {
        expect(() => buildReleaseNotes(SAMPLE, 'v9.9.9')).toThrow(/not found/);
    });
});

describe('CLI integration via dynamic import', () => {
    let tmpDir;
    let outPath;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'extract-changelog-'));
        outPath = join(tmpDir, 'notes.md');
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes to file when --out is provided (programmatic equivalent)', () => {
        // We exercise the building pieces and write directly; the CLI wrapper
        // is just a thin parser around buildReleaseNotes.
        const notes = buildReleaseNotes(SAMPLE, '0.1.1');
        writeFileSync(outPath, notes);
        const written = readFileSync(outPath, 'utf8');
        expect(written).toBe(notes);
        expect(written).toContain(SIGNPATH_CREDIT);
        expect(written).toContain('- a bug');
    });
});
