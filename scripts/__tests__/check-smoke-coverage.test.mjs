import { describe, expect, it } from 'vitest';
import { evaluate, isWatched, parseOptOut, SMOKE_DOC } from '../check-smoke-coverage.mjs';

describe('isWatched', () => {
    it.each(['src/server/api/WhoamiApi.ts', 'src/app/client/ServiceOperationModal.ts', 'launcher/src/elevated_runner.rs'])(
        'watches %s',
        (p) => {
            expect(isWatched(p)).toBe(true);
        },
    );

    it.each([
        'src/common/Action.ts',
        'docs/TECHNICAL_GUIDE.md',
        'launcher/Cargo.toml',
        '.github/workflows/ci.yml',
        'src/app/client/__tests__/serviceOperationModal.test.ts',
        'src/server/db/openDatabase.test.ts',
    ])('ignores %s', (p) => {
        expect(isWatched(p)).toBe(false);
    });
});

describe('parseOptOut', () => {
    it('returns the reason', () => {
        expect(parseOptOut('intro\n<!-- smoke: none -- refactor, no behaviour change -->\n')).toBe(
            'refactor, no behaviour change',
        );
    });

    it('returns an empty string for a marker with no reason', () => {
        expect(parseOptOut('<!-- smoke: none -- -->')).toBe('');
        expect(parseOptOut('<!-- smoke: none --   \n  -->')).toBe('');
    });

    it('returns null when there is no marker', () => {
        expect(parseOptOut('no marker here')).toBeNull();
        expect(parseOptOut(null)).toBeNull();
    });

    it('does not treat a different marker as an opt-out', () => {
        expect(parseOptOut('<!-- one-brain: single-repo -- reason -->')).toBeNull();
    });
});

describe('evaluate', () => {
    const feature = ['src/server/api/WhoamiApi.ts', 'CHANGELOG.md'];

    it('is not applicable when nothing watched changed', () => {
        expect(evaluate({ files: ['docs/README.md', 'package.json'], body: '' })).toMatchObject({
            ok: true,
            verdict: 'not-applicable',
        });
    });

    it('is not applicable for a test-only change under a watched tree', () => {
        expect(
            evaluate({ files: ['src/server/__tests__/x.test.ts'], body: '' }),
        ).toMatchObject({ ok: true, verdict: 'not-applicable' });
    });

    it('passes when the smoke doc changes alongside the code', () => {
        expect(evaluate({ files: [...feature, SMOKE_DOC], body: '' })).toMatchObject({
            ok: true,
            verdict: 'smoke-doc-updated',
        });
    });

    it('passes with an opt-out that carries a reason, and records it', () => {
        expect(evaluate({ files: feature, body: '<!-- smoke: none -- log wording only -->' })).toMatchObject({
            ok: true,
            verdict: 'opted-out',
            reason: 'log wording only',
        });
    });

    it('FAILS a feature change with neither -- the #718-#721 / #727 shape', () => {
        expect(evaluate({ files: feature, body: 'Adds a thing.' })).toMatchObject({ ok: false, verdict: 'missing' });
    });

    it('FAILS an opt-out with an empty reason', () => {
        expect(evaluate({ files: feature, body: '<!-- smoke: none -- -->' })).toMatchObject({
            ok: false,
            verdict: 'empty-reason',
        });
    });

    it('catches a file renamed OUT of a watched tree via its previous path', () => {
        expect(evaluate({ files: ['src/moved.ts', 'src/server/old.ts'], body: '' })).toMatchObject({ ok: false });
    });

    it('does not count the automation register as the smoke doc', () => {
        expect(
            evaluate({ files: [...feature, 'docs/smoke-tests/automation-coverage.md'], body: '' }),
        ).toMatchObject({ ok: false });
    });
});
