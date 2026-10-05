import type { Db } from './Db';

/**
 * The store's half of the graceful stop (`gracefulShutdown` in index.ts, which
 * SIGINT/SIGTERM, the Settings "stop server & exit" button and the tray's
 * `POST /api/server/shutdown` all run). Call it LAST: after it the store is
 * closed, and adb kill-server and service release do not use it.
 *
 * 1. Snapshot to `<db>.bak`, the last-good copy the corrupt-store recovery in
 *    openDatabase restores from.
 * 2. Close the connection. WAL mode keeps recent pages in `wsscrcpy.db-wal`
 *    until a checkpoint, and nothing checkpointed on the way out, so every stop
 *    used to leave a 4 KB `wsscrcpy.db` header beside a ~119 KB `-wal`. Junk
 *    written over the main file alone was then masked by the WAL and the
 *    recovery never ran (finding 10.21, smoke row 10.17). Closing the last
 *    connection checkpoints the WAL into the main file and removes it.
 *
 * Each step is best-effort and logged on failure: a failed backup must not stop
 * the close, and neither may block the exit.
 */
export function backupAndCloseStore(db: Db, log: { warn(message: string): void }): void {
    try {
        db.backup(`${db.dbPath}.bak`);
    } catch (err) {
        log.warn(`db backup on shutdown failed: ${(err as Error).message}`);
    }
    try {
        db.close();
    } catch (err) {
        log.warn(`db close on shutdown failed: ${(err as Error).message}`);
    }
}
