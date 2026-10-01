import { describe, expect, it, vi } from 'vitest';
import { STAGED_SYSTEM_HELPER, stageSystemHelper } from './systemHelper';

const SOURCE = '/var/lib/ws-scrcpy-web/control/operation-server/ws-scrcpy-web-launcher.exe';

describe('stageSystemHelper (FD1/FD2: a system unit cannot exec a var_lib_t helper)', () => {
    it('copies the helper under the bin_t /opt tree, makes it executable, and returns that path', () => {
        const copy = vi.fn();
        const chmod = vi.fn();
        const got = stageSystemHelper(SOURCE, { rootOnLinux: () => true, copy, chmod, selinuxActive: () => false });
        expect(got).toBe(STAGED_SYSTEM_HELPER);
        expect(STAGED_SYSTEM_HELPER.startsWith('/opt/ws-scrcpy-web/')).toBe(true);
        expect(copy).toHaveBeenCalledWith(SOURCE, STAGED_SYSTEM_HELPER);
        expect(chmod).toHaveBeenCalledWith(STAGED_SYSTEM_HELPER, 0o755);
    });

    it('re-applies the fcontext rule with restorecon only where SELinux is present', () => {
        const restorecon = vi.fn();
        stageSystemHelper(SOURCE, {
            rootOnLinux: () => true,
            copy: vi.fn(),
            chmod: vi.fn(),
            selinuxActive: () => true,
            restorecon,
        });
        expect(restorecon).toHaveBeenCalledWith(STAGED_SYSTEM_HELPER);

        const skipped = vi.fn();
        stageSystemHelper(SOURCE, {
            rootOnLinux: () => true,
            copy: vi.fn(),
            chmod: vi.fn(),
            selinuxActive: () => false,
            restorecon: skipped,
        });
        expect(skipped).not.toHaveBeenCalled();
    });

    it('a failed restorecon keeps the staged copy (its inherited label stands)', () => {
        const got = stageSystemHelper(SOURCE, {
            rootOnLinux: () => true,
            copy: vi.fn(),
            chmod: vi.fn(),
            selinuxActive: () => true,
            restorecon: () => {
                throw new Error('restorecon: not found');
            },
        });
        expect(got).toBe(STAGED_SYSTEM_HELPER);
    });

    it('does nothing unless root on Linux: the source path passes through, nothing is copied', () => {
        const copy = vi.fn();
        expect(stageSystemHelper(SOURCE, { rootOnLinux: () => false, copy, chmod: vi.fn() })).toBe(SOURCE);
        expect(copy).not.toHaveBeenCalled();
    });

    it('falls back to the source when the copy fails, never to a stale staged copy', () => {
        const got = stageSystemHelper(SOURCE, {
            rootOnLinux: () => true,
            copy: () => {
                throw new Error('EACCES');
            },
            chmod: vi.fn(),
            selinuxActive: () => true,
            restorecon: vi.fn(),
        });
        expect(got).toBe(SOURCE);
    });
});
