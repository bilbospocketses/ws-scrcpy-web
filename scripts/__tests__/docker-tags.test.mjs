import { describe, expect, it } from 'vitest';
import { IMAGE, computeTags } from '../../.github/scripts/docker-tags.mjs';

/**
 * The rule that decides whether a build becomes `:latest` is exercised here
 * rather than first on a real release. A beta published as `:latest` reaches
 * every user who follows the default tag — the one output whose being wrong is
 * silently destructive, and what SP4 D3 exists to prevent.
 */
describe('docker tag computation', () => {
    describe('pre-release versions', () => {
        it.each(['v0.1.30-beta.82', '0.1.30-beta.82', 'v1.0.0-beta.1', 'v2.3.4-beta.100'])(
            'tags %s as :beta and NEVER :latest',
            (tag) => {
                const { tags, isBeta } = computeTags(tag);
                expect(isBeta).toBe(true);
                expect(tags).toContain(`${IMAGE}:beta`);
                // The assertions that matter are the negative ones.
                expect(tags).not.toContain(`${IMAGE}:latest`);
                expect(tags).not.toContain(`${IMAGE}:stable`);
            },
        );

        it('still emits the immutable version tag, first', () => {
            const { tags } = computeTags('v0.1.30-beta.82');
            expect(tags[0]).toBe(`${IMAGE}:0.1.30-beta.82`);
            expect(tags).toEqual([`${IMAGE}:0.1.30-beta.82`, `${IMAGE}:beta`]);
        });
    });

    describe('stable versions', () => {
        it.each(['v0.1.30', '0.1.30', 'v1.0.0', 'v2.3.4'])('tags %s as :latest and :stable', (tag) => {
            const { tags, isBeta } = computeTags(tag);
            expect(isBeta).toBe(false);
            expect(tags).toContain(`${IMAGE}:latest`);
            expect(tags).toContain(`${IMAGE}:stable`);
            expect(tags).not.toContain(`${IMAGE}:beta`);
        });

        it('emits the immutable version tag first', () => {
            const { tags } = computeTags('v0.1.30');
            expect(tags[0]).toBe(`${IMAGE}:0.1.30`);
            expect(tags).toEqual([`${IMAGE}:0.1.30`, `${IMAGE}:latest`, `${IMAGE}:stable`]);
        });
    });

    describe('the leading v', () => {
        it('is stripped, and only from the front', () => {
            expect(computeTags('v0.1.30').version).toBe('0.1.30');
            expect(computeTags('0.1.30').version).toBe('0.1.30');
        });
    });

    describe('refuses input it cannot publish safely', () => {
        it.each([undefined, null, '', '   ', 'v'])('throws on %o rather than tagging something empty', (bad) => {
            // An empty version would produce `image:` — which Docker resolves to
            // `:latest`. Failing the workflow is the only safe answer.
            expect(() => computeTags(/** @type {string} */ (bad))).toThrow();
        });
    });

    it('agrees with package-linux.mjs on what counts as a beta', () => {
        // Both use `version.includes('-beta')`. Restated in two places on
        // purpose (the workflow must not depend on the Node toolchain being set
        // up first), so the agreement is asserted rather than assumed.
        for (const v of ['0.1.30-beta.82', '1.0.0-beta.1']) {
            expect(computeTags(v).isBeta).toBe(v.includes('-beta'));
        }
        for (const v of ['0.1.30', '1.0.0']) {
            expect(computeTags(v).isBeta).toBe(v.includes('-beta'));
        }
    });
});
