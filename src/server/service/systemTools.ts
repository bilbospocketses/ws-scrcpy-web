/**
 * Resolve an OS tool to its absolute path, scanning the canonical bin/sbin
 * locations in priority order. Closes the PATH-hijack surface required by the
 * Local-Dependencies-Only rule: we never invoke systemctl/pkexec/etc. by bare
 * name (which would resolve via $PATH). Falls back to the bare name only when
 * no absolute candidate exists, so the failure surfaces as a clear ENOENT
 * rather than a silent miss.
 */
import * as fs from 'node:fs';

/** Search order: user bins first (/usr/bin, /bin), then admin bins (/usr/sbin, /sbin). */
const SEARCH_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;

export function resolveSystemTool(
    tool: string,
    exists: (p: string) => boolean = fs.existsSync,
): string {
    for (const dir of SEARCH_DIRS) {
        const candidate = `${dir}/${tool}`;
        if (exists(candidate)) return candidate;
    }
    return tool;
}
