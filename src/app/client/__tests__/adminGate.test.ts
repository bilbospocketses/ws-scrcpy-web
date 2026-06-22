import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_SECTIONS, canSeeSection } from '../adminGate';

describe('canSeeSection', () => {
    describe('admin role', () => {
        it('can see every admin-only section', () => {
            for (const section of ADMIN_ONLY_SECTIONS) {
                expect(canSeeSection('admin', section), `admin should see '${section}'`).toBe(true);
            }
        });

        it('can see user-level sections too', () => {
            expect(canSeeSection('admin', 'theme')).toBe(true);
        });
    });

    describe('user role', () => {
        it('cannot see any admin-only section', () => {
            for (const section of ADMIN_ONLY_SECTIONS) {
                expect(canSeeSection('user', section), `user should NOT see '${section}'`).toBe(false);
            }
        });

        it('can see user-level sections', () => {
            expect(canSeeSection('user', 'theme')).toBe(true);
        });
    });

    describe('null / undefined role', () => {
        it('null cannot see an admin-only section', () => {
            expect(canSeeSection(null, 'updates')).toBe(false);
        });

        it('null CAN see a user-level section', () => {
            expect(canSeeSection(null, 'theme')).toBe(true);
        });

        it('undefined cannot see an admin-only section', () => {
            expect(canSeeSection(undefined, 'updates')).toBe(false);
        });

        it('undefined CAN see a user-level section', () => {
            expect(canSeeSection(undefined, 'theme')).toBe(true);
        });
    });

    describe('specific admin-only section names (explicit smoke)', () => {
        const adminSections = ['updates', 'service', 'users', 'webPort', 'serverControls'] as const;

        for (const section of adminSections) {
            it(`'${section}' requires admin`, () => {
                expect(canSeeSection('admin', section)).toBe(true);
                expect(canSeeSection('user', section)).toBe(false);
                expect(canSeeSection(null, section)).toBe(false);
            });
        }
    });
});
