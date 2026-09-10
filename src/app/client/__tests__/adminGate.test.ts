import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_SECTIONS, adminApiReachable, canSeeSection } from '../adminGate';

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

describe('adminApiReachable', () => {
    it('is true on a server that predates the guard', () => {
        expect(adminApiReachable({})).toBe(true);
    });

    it('is true for a loopback caller under the local policy', () => {
        expect(adminApiReachable({ adminScope: 'local', callerIsLocal: true })).toBe(true);
    });

    it('is FALSE for a remote caller under the local policy — the flagless container', () => {
        expect(adminApiReachable({ adminScope: 'local', callerIsLocal: false })).toBe(false);
    });

    it('is true once the opt-out is set, or once sign-in is on', () => {
        expect(adminApiReachable({ adminScope: 'remote', callerIsLocal: false })).toBe(true);
        expect(adminApiReachable({ adminScope: 'authenticated', callerIsLocal: false })).toBe(true);
    });
});

describe('the two predicates are independent', () => {
    it('an admin whose calls would 403 is gated by reachability, not by role', () => {
        expect(canSeeSection('admin', 'dependencies')).toBe(true);
        expect(adminApiReachable({ adminScope: 'local', callerIsLocal: false })).toBe(false);
    });

    it('a viewer on loopback is reachable but still not permitted', () => {
        expect(adminApiReachable({ adminScope: 'local', callerIsLocal: true })).toBe(true);
        expect(canSeeSection('user', 'dependencies')).toBe(false);
    });
});
