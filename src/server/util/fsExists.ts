import * as fs from 'node:fs';

/**
 * Async, non-blocking existence check — the event-loop-friendly replacement for
 * `fs.existsSync` (review finding #32). Resolves `true` when the path exists and
 * is accessible, `false` otherwise. Never throws: an inaccessible/missing path
 * (any `access` rejection) maps to `false`, matching `existsSync`'s contract.
 */
export async function fileExists(p: string): Promise<boolean> {
    try {
        await fs.promises.access(p);
        return true;
    } catch {
        return false;
    }
}
