import { afterEach, describe, expect, it } from 'vitest';
import { cookieSecurity } from './cookiePolicy';
import { setFrameAncestors } from './frameGuard';

describe('cookiePolicy.cookieSecurity', () => {
    afterEach(() => {
        setFrameAncestors([]);
    });

    describe('framing not opted in (the default)', () => {
        it('keeps the caller default and adds nothing on plain http', () => {
            expect(cookieSecurity('Strict', false)).toEqual({ sameSite: 'Strict', secure: false, partitioned: false });
            expect(cookieSecurity('Lax', false)).toEqual({ sameSite: 'Lax', secure: false, partitioned: false });
        });

        it('keeps the caller default and marks Secure on https', () => {
            expect(cookieSecurity('Strict', true)).toEqual({ sameSite: 'Strict', secure: true, partitioned: false });
            expect(cookieSecurity('Lax', true)).toEqual({ sameSite: 'Lax', secure: true, partitioned: false });
        });
    });

    describe('framing opted in', () => {
        it('relaxes to None + Secure + Partitioned on https', () => {
            setFrameAncestors(['https://dashboard.example.net']);

            expect(cookieSecurity('Strict', true)).toEqual({ sameSite: 'None', secure: true, partitioned: true });
            expect(cookieSecurity('Lax', true)).toEqual({ sameSite: 'None', secure: true, partitioned: true });
        });

        it('does NOT relax on plain http — SameSite=None without Secure is rejected outright', () => {
            // Emitting None without Secure would make the browser drop the
            // cookie entirely, breaking the ordinary same-site tab as well as
            // the iframe. Staying site-scoped leaves embedding broken but
            // nothing else, which is the strictly better failure.
            setFrameAncestors(['https://dashboard.example.net']);

            expect(cookieSecurity('Strict', false)).toEqual({ sameSite: 'Strict', secure: false, partitioned: false });
            expect(cookieSecurity('Lax', false)).toEqual({ sameSite: 'Lax', secure: false, partitioned: false });
        });

        it('never marks Partitioned without None + Secure', () => {
            setFrameAncestors(['https://dashboard.example.net']);
            for (const secure of [true, false]) {
                const s = cookieSecurity('Lax', secure);
                if (s.partitioned) {
                    expect(s.sameSite).toBe('None');
                    expect(s.secure).toBe(true);
                }
            }
        });

        it('returns to the default policy when the allowlist is emptied', () => {
            setFrameAncestors(['https://dashboard.example.net']);
            setFrameAncestors([]);

            expect(cookieSecurity('Strict', true)).toEqual({ sameSite: 'Strict', secure: true, partitioned: false });
        });
    });
});
