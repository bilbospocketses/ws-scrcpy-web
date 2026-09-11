import { describe, expect, it } from 'vitest';
import {
    CANONICAL,
    DEPRECATED,
    DEPRECATED_THROUGH,
    IMAGE_NAME,
    MIRROR,
    activeNamespaces,
    computeTags,
} from '../../.github/scripts/docker-tags.mjs';

/**
 * The rule that decides whether a build becomes `:latest` is exercised here
 * rather than first on a real release. A beta published as `:latest` reaches
 * every user who follows the default tag — the one output whose being wrong is
 * silently destructive, and what SP4 D3 exists to prevent.
 *
 * Multi-registry (2026-09-10) makes that rule three times as easy to get
 * wrong, so the negative assertions below run per namespace rather than
 * against the list as a whole.
 */

/** @param {string} ns @param {string} tag */
const ref = (ns, tag) => `${ns}/${IMAGE_NAME}:${tag}`;

const BEFORE_SUNSET = new Date(`${DEPRECATED_THROUGH}T12:00:00Z`);
const AFTER_SUNSET = new Date('2026-12-10T00:00:01Z');

describe('docker tag computation', () => {
    describe('pre-release versions', () => {
        it.each(['v0.1.30-beta.82', '0.1.30-beta.82', 'v1.0.0-beta.1', 'v2.3.4-beta.100'])(
            'tags %s as :beta and NEVER :latest, on every namespace',
            (tag) => {
                const { tags, isBeta } = computeTags(tag, { now: BEFORE_SUNSET });
                expect(isBeta).toBe(true);
                for (const ns of [CANONICAL, MIRROR, DEPRECATED]) {
                    expect(tags).toContain(ref(ns, 'beta'));
                    // The assertions that matter are the negative ones.
                    expect(tags).not.toContain(ref(ns, 'latest'));
                    expect(tags).not.toContain(ref(ns, 'stable'));
                }
            },
        );

        it('emits six tags, immutable first, grouped canonical -> mirror -> deprecated', () => {
            const { tags } = computeTags('v0.1.30-beta.82', { now: BEFORE_SUNSET });
            expect(tags).toEqual([
                ref(CANONICAL, '0.1.30-beta.82'),
                ref(CANONICAL, 'beta'),
                ref(MIRROR, '0.1.30-beta.82'),
                ref(MIRROR, 'beta'),
                ref(DEPRECATED, '0.1.30-beta.82'),
                ref(DEPRECATED, 'beta'),
            ]);
        });
    });

    describe('stable versions', () => {
        it.each(['v0.1.30', '0.1.30', 'v1.0.0', 'v2.3.4'])('tags %s as :latest and :stable', (tag) => {
            const { tags, isBeta } = computeTags(tag, { now: BEFORE_SUNSET });
            expect(isBeta).toBe(false);
            for (const ns of [CANONICAL, MIRROR, DEPRECATED]) {
                expect(tags).toContain(ref(ns, 'latest'));
                expect(tags).toContain(ref(ns, 'stable'));
                expect(tags).not.toContain(ref(ns, 'beta'));
            }
        });

        it('emits nine tags, immutable first within each namespace', () => {
            const { tags } = computeTags('v0.1.30', { now: BEFORE_SUNSET });
            expect(tags).toEqual([
                ref(CANONICAL, '0.1.30'),
                ref(CANONICAL, 'latest'),
                ref(CANONICAL, 'stable'),
                ref(MIRROR, '0.1.30'),
                ref(MIRROR, 'latest'),
                ref(MIRROR, 'stable'),
                ref(DEPRECATED, '0.1.30'),
                ref(DEPRECATED, 'latest'),
                ref(DEPRECATED, 'stable'),
            ]);
        });
    });

    describe('the deprecated namespace sunsets on its own', () => {
        it('is still published on the sunset date itself', () => {
            expect(activeNamespaces(BEFORE_SUNSET)).toEqual([CANONICAL, MIRROR, DEPRECATED]);
            expect(computeTags('v0.1.30-beta.82', { now: BEFORE_SUNSET }).tags).toHaveLength(6);
        });

        it('is gone the day after, with no code change', () => {
            expect(activeNamespaces(AFTER_SUNSET)).toEqual([CANONICAL, MIRROR]);
            const { tags } = computeTags('v0.1.30-beta.82', { now: AFTER_SUNSET });
            expect(tags).toEqual([
                ref(CANONICAL, '0.1.30-beta.82'),
                ref(CANONICAL, 'beta'),
                ref(MIRROR, '0.1.30-beta.82'),
                ref(MIRROR, 'beta'),
            ]);
            expect(tags.join(' ')).not.toContain('jchapz30');
        });

        it('never drops the two permanent namespaces', () => {
            for (const now of [BEFORE_SUNSET, AFTER_SUNSET, new Date('2030-01-01T00:00:00Z')]) {
                expect(activeNamespaces(now)).toContain(CANONICAL);
                expect(activeNamespaces(now)).toContain(MIRROR);
            }
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
