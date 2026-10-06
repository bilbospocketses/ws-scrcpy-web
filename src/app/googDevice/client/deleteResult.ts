/**
 * Turns the answer to `POST /api/devices/files/delete` into the file browser's
 * footer text. The server (DeviceDiscoveryApi) answers in three shapes:
 *
 *   200  { success: true }                                   every path removed
 *   207  { success: false, errors: [{ path, error }, ...] }  rm failed for some
 *   4xx  { error: '<message>' }                              request refused
 *                                                             (protected root,
 *                                                             traversal, too many)
 *
 * The modal used to interpolate `errors[0]` directly, which printed
 * `delete failed: [object Object]` for a 207, and it never looked at the
 * status, so a refused request said nothing (qa-harness smoke row 9.11).
 *
 * `body` is the parsed JSON, or `undefined` when it could not be parsed.
 * Returns `null` when there is nothing to report.
 */
export type DeleteFailure = {
    /** One line for the footer: `delete failed: …`. */
    message: string;
    /** Every failure, one `<path>: <error>` line each, for the console. */
    details: string[];
};

function describeError(item: unknown): string {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
        const { path, error } = item as { path?: unknown; error?: unknown };
        if (typeof path === 'string' && typeof error === 'string') return `${path}: ${error}`;
        if (typeof error === 'string') return error;
        if (typeof path === 'string') return path;
    }
    return JSON.stringify(item) ?? String(item);
}

export function describeDeleteResponse(status: number, ok: boolean, body: unknown): DeleteFailure | null {
    const result =
        body && typeof body === 'object'
            ? (body as { success?: unknown; errors?: unknown; error?: unknown })
            : undefined;

    if (result && result.success !== true && Array.isArray(result.errors) && result.errors.length > 0) {
        const details = result.errors.map(describeError);
        const more = details.length > 1 ? ` (+${details.length - 1} more)` : '';
        return { message: `delete failed: ${details[0]}${more}`, details };
    }

    if (!ok) {
        const reason = typeof result?.error === 'string' && result.error ? result.error : `HTTP ${status}`;
        return { message: `delete failed: ${reason}`, details: [reason] };
    }

    return null;
}
