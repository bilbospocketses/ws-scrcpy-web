/**
 * Reusable Disposable helpers for the TS6 `using` declaration pattern.
 *
 * Extracted as part of §25 (TS6 src/ compliance) — see CHANGELOG. Other
 * cleanup patterns in src/server/ that don't recur across multiple sites
 * are kept as inline-Disposable literals at the call site rather than
 * extracted here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Disposable handle around a freshly-created temp directory.
 *
 * Replaces the `fs.mkdtempSync` + try/finally + `fs.rmSync` triplet that
 * appeared at three sites pre-§25 (`DependencyManager.update`,
 * `elevatedRunner.runElevated`, `adbClient.test`). The `path` field is the
 * absolute temp-directory path; `[Symbol.dispose]` recursively deletes it
 * (force=true, recursive=true — matches the pre-§25 cleanup contract).
 *
 * Errors during dispose are swallowed: leaving a temp directory on disk
 * isn't dangerous (a fresh one is created per call), and throwing from
 * dispose would mask whatever was being thrown by the using-scope body.
 */
export interface TempDirHandle extends Disposable {
    readonly path: string;
}

export function tempDir(prefix = 'ws-scrcpy-'): TempDirHandle {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return {
        path: dir,
        [Symbol.dispose](): void {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // Best-effort — see comment above.
            }
        },
    };
}
