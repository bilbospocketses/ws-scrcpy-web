// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListFilesModal } from '../ListFilesModal';

/**
 * The footer text a refused delete leaves behind (qa-harness smoke row 9.11).
 *
 * The modal is built with `Object.create` rather than its constructor, which
 * opens the multiplexed device channel: `deleteFiles` only needs the footer
 * element it writes to, the udid it posts, and `loadDirectory` (stubbed) for
 * the reload it always does afterwards.
 */
function makeModal(): { modal: any; info: HTMLElement; loadDirectory: ReturnType<typeof vi.fn> } {
    const modal = Object.create(ListFilesModal.prototype);
    const frameEl = document.createElement('div');
    const info = document.createElement('span');
    info.className = 'lf-footer-info';
    info.textContent = '3 items';
    frameEl.appendChild(info);
    const loadDirectory = vi.fn();
    Object.assign(modal, {
        frameEl,
        udid: 'serial-1',
        currentPath: '/system',
        loadDirectory,
        updateFooterInfo: vi.fn(),
    });
    return { modal, info, loadDirectory };
}

describe('ListFilesModal.deleteFiles footer text (9.11)', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('names the path and the reason when rm refuses a path (207)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                status: 207,
                json: async () => ({
                    success: false,
                    errors: [{ path: '/system/app', error: 'Read-only file system' }],
                }),
            }),
        );
        const { modal, info, loadDirectory } = makeModal();

        await modal.deleteFiles(['/system/app']);

        expect(info.textContent).toBe('delete failed: /system/app: Read-only file system');
        expect(info.textContent).not.toContain('[object Object]');
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('/system/app: Read-only file system');
        expect(loadDirectory).toHaveBeenCalledWith('/system');
    });

    it('says why a refused request was refused (400)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 400,
                json: async () => ({ error: 'refusing to delete a protected root: /system' }),
            }),
        );
        const { modal, info } = makeModal();

        await modal.deleteFiles(['/system']);

        expect(info.textContent).toBe('delete failed: refusing to delete a protected root: /system');
    });

    it('falls back to the HTTP status when a refused response has no JSON body', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 502,
                json: async () => {
                    throw new SyntaxError('Unexpected token < in JSON');
                },
            }),
        );
        const { modal, info } = makeModal();

        await modal.deleteFiles(['/sdcard/Download/a.txt']);

        expect(info.textContent).toBe('delete failed: HTTP 502');
    });
});
