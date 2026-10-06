import { describe, expect, it } from 'vitest';
import { describeDeleteResponse } from '../deleteResult';

/**
 * `POST /api/devices/files/delete` (DeviceDiscoveryApi) answers in three shapes:
 *
 *   200  { success: true }                                   every path removed
 *   207  { success: false, errors: [{ path, error }, ...] }  rm failed for some
 *   400  { error: '<message>' }                              request refused
 *                                                             (protected root,
 *                                                             traversal, too many)
 *
 * The file browser used to interpolate `errors[0]` straight into the footer, so
 * a 207 read `delete failed: [object Object]`, and it never looked at a 400 at
 * all, so a refused request said nothing. qa-harness smoke row 9.11.
 */
describe('describeDeleteResponse', () => {
    it('names the path and the reason for a single per-path failure (207)', () => {
        const out = describeDeleteResponse(207, true, {
            success: false,
            errors: [{ path: '/system/app', error: 'rm: /system/app: Read-only file system' }],
        });
        expect(out).toEqual({
            message: 'delete failed: /system/app: rm: /system/app: Read-only file system',
            details: ['/system/app: rm: /system/app: Read-only file system'],
        });
    });

    it('names the first failure and counts the rest when several paths fail (207)', () => {
        const out = describeDeleteResponse(207, true, {
            success: false,
            errors: [
                { path: '/system/a', error: 'Read-only file system' },
                { path: '/system/b', error: 'Permission denied' },
                { path: '/system/c', error: 'Operation not permitted' },
            ],
        });
        expect(out?.message).toBe('delete failed: /system/a: Read-only file system (+2 more)');
        expect(out?.details).toEqual([
            '/system/a: Read-only file system',
            '/system/b: Permission denied',
            '/system/c: Operation not permitted',
        ]);
    });

    it('tolerates plain-string errors', () => {
        const out = describeDeleteResponse(207, true, {
            success: false,
            errors: ['first went wrong', 'second went wrong'],
        });
        expect(out).toEqual({
            message: 'delete failed: first went wrong (+1 more)',
            details: ['first went wrong', 'second went wrong'],
        });
    });

    it('says why a refused request was refused (400 { error })', () => {
        const out = describeDeleteResponse(400, false, { error: 'refusing to delete a protected root: /system' });
        expect(out).toEqual({
            message: 'delete failed: refusing to delete a protected root: /system',
            details: ['refusing to delete a protected root: /system'],
        });
    });

    it('falls back to the HTTP status when a non-OK body is not parsable', () => {
        const out = describeDeleteResponse(502, false, undefined);
        expect(out).toEqual({ message: 'delete failed: HTTP 502', details: ['HTTP 502'] });
    });

    it('falls back to the HTTP status when a non-OK body carries no error text', () => {
        expect(describeDeleteResponse(500, false, {})?.message).toBe('delete failed: HTTP 500');
    });

    it('reports nothing for a successful delete', () => {
        expect(describeDeleteResponse(200, true, { success: true })).toBeNull();
    });
});
