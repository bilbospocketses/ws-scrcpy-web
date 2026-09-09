import { afterEach, describe, expect, it } from 'vitest';
import { cookieSameSiteAttrs } from './cookiePolicy';
import { setFrameAncestors } from './frameGuard';

describe('cookiePolicy.cookieSameSiteAttrs', () => {
    afterEach(() => {
        setFrameAncestors([]);
    });

    describe('framing not opted in (the default)', () => {
        it('keeps the caller default and adds nothing on plain http', () => {
            expect(cookieSameSiteAttrs('Strict', false)).toEqual(['SameSite=Strict']);
            expect(cookieSameSiteAttrs('Lax', false)).toEqual(['SameSite=Lax']);
        });

        it('keeps the caller default and adds Secure on https', () => {
            expect(cookieSameSiteAttrs('Strict', true)).toEqual(['SameSite=Strict', 'Secure']);
            expect(cookieSameSiteAttrs('Lax', true)).toEqual(['SameSite=Lax', 'Secure']);
        });
    });

    describe('framing opted in', () => {
        it('relaxes to None; Secure; Partitioned on https', () => {
            setFrameAncestors(['https://dashboard.example.net']);

            expect(cookieSameSiteAttrs('Strict', true)).toEqual(['SameSite=None', 'Secure', 'Partitioned']);
            expect(cookieSameSiteAttrs('Lax', true)).toEqual(['SameSite=None', 'Secure', 'Partitioned']);
        });

        it('does NOT relax on plain http — SameSite=None without Secure is rejected outright', () => {
            // Emitting None without Secure would make the browser drop the
            // cookie entirely, breaking the ordinary same-site tab as well as
            // the iframe. Staying Strict leaves embedding broken but nothing
            // else, which is the strictly better failure.
            setFrameAncestors(['https://dashboard.example.net']);

            expect(cookieSameSiteAttrs('Strict', false)).toEqual(['SameSite=Strict']);
            expect(cookieSameSiteAttrs('Lax', false)).toEqual(['SameSite=Lax']);
        });

        it('returns to the default policy when the allowlist is emptied', () => {
            setFrameAncestors(['https://dashboard.example.net']);
            setFrameAncestors([]);

            expect(cookieSameSiteAttrs('Strict', true)).toEqual(['SameSite=Strict', 'Secure']);
        });
    });
});
