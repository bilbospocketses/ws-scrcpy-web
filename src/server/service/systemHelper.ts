import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../Logger';
import { copyFileAtomicSync } from '../util/atomicFile';
import { STAGED_SYSTEM_DIR } from './SystemdClient';
import { resolveSystemTool } from './systemTools';

const log = Logger.for('systemHelper');

/**
 * Where a ROOT-run helper is staged before a SYSTEM transient unit execs it.
 *
 * The launcher refreshes its helper copy into `<dataRoot>/control/operation-server/`
 * on every boot. For the system service that is `/var/lib/ws-scrcpy-web/...`, which
 * the targeted policy labels `var_lib_t`, and `init_t` (systemd, starting a
 * `systemd-run --system` unit) may not EXECUTE `var_lib_t`: the unit dies with
 * 203/EXEC. Measured by qa-harness on stock Fedora 44 (M3b B5, 2026-09-30): the
 * system-service uninstall (row 14.5) and the root self-update (row 6.6) both
 * failed that way, the update leaving the service dead. The same binary runs
 * when it is labelled `bin_t`.
 *
 * `/opt/ws-scrcpy-web` carries the app's own `bin_t` fcontext rule
 * (SYSTEM_FCONTEXT_SPEC), the same reason the root service's dependencies live
 * there, so a copy staged beneath it is executable by `init_t` with no new rule.
 */
export const STAGED_SYSTEM_HELPER = `${STAGED_SYSTEM_DIR}/control/ws-scrcpy-web-launcher`;

export interface StageSystemHelperDeps {
    /** Only root on Linux stages; anything else passes `source` through untouched. */
    rootOnLinux?: () => boolean;
    copy?: (src: string, dest: string) => void;
    chmod?: (p: string, mode: number) => void;
    selinuxActive?: () => boolean;
    restorecon?: (p: string) => void;
}

/**
 * Copy the data-root helper to STAGED_SYSTEM_HELPER and return that path, for a
 * ROOT caller about to start it as a system unit. On any failure, return
 * `source` unchanged with a warning: a host without SELinux runs it from there
 * as it always did, and a stale copy is never preferred over the fresh one.
 *
 * The copy is created inside the `bin_t` directory, so it inherits `bin_t`;
 * `restorecon` re-applies the fcontext rule as a guard against a mislabelled
 * parent, only where SELinux is present. Root-owned, mode 0755: root never runs
 * a file a user owns (D14), and the source is the root service's own copy.
 */
export function stageSystemHelper(source: string, deps: StageSystemHelperDeps = {}): string {
    // Guarded HERE, not only at the call sites: a unit test or a dev run on
    // Windows that reaches a system-service branch would otherwise mkdir
    // `C:\opt\ws-scrcpy-web\control`, and a non-root Linux run could only fail.
    const rootOnLinux =
        deps.rootOnLinux ??
        (() => process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0);
    if (!rootOnLinux()) return source;
    const copy = deps.copy ?? copyFileAtomicSync;
    const chmod = deps.chmod ?? ((p: string, mode: number) => fs.chmodSync(p, mode));
    const selinuxActive = deps.selinuxActive ?? (() => fs.existsSync('/sys/fs/selinux/enforce'));
    const restorecon =
        deps.restorecon ??
        ((p: string) => {
            spawnSync(resolveSystemTool('restorecon'), [p], { stdio: 'ignore', timeout: 10_000 });
        });
    try {
        copy(source, STAGED_SYSTEM_HELPER);
        chmod(STAGED_SYSTEM_HELPER, 0o755);
    } catch (err) {
        log.warn(
            `could not stage the helper under ${path.dirname(STAGED_SYSTEM_HELPER)} (${(err as Error).message}); ` +
                `running it from ${source}, which SELinux may refuse to execute`,
        );
        return source;
    }
    if (selinuxActive()) {
        try {
            restorecon(STAGED_SYSTEM_HELPER);
        } catch (err) {
            // The inherited bin_t label stands; this was only the guard.
            log.warn(`restorecon on ${STAGED_SYSTEM_HELPER} failed (continuing): ${(err as Error).message}`);
        }
    }
    log.info(`staged the system helper at ${STAGED_SYSTEM_HELPER}`);
    return STAGED_SYSTEM_HELPER;
}
