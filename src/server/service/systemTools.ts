/**
 * Resolve an OS tool to its absolute path, scanning the canonical system
 * locations in priority order (POSIX: /usr/bin,/bin,/usr/sbin,/sbin; Windows:
 * %SystemRoot%\System32). Closes the PATH-hijack surface flagged by review #20
 * and required by the Local-Dependencies-Only rule: OS tools
 * (systemctl/pkexec/taskkill/icacls/ip/arp/route/…) are never invoked by bare
 * name, which would resolve via $PATH / %PATH%. Falls back to the bare name only
 * when no absolute candidate exists, so the failure surfaces as a clear ENOENT
 * rather than a silent miss.
 */
import * as fs from 'node:fs';

/** POSIX search order: user bins first (/usr/bin, /bin), then admin bins (/usr/sbin, /sbin). */
const POSIX_SEARCH_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;

/** Windows OS tools (taskkill, icacls, arp, route, …) live under %SystemRoot%\System32. */
function windowsSystemDirs(): string[] {
    const root = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows';
    return [`${root}\\System32`, root];
}

export function resolveSystemTool(
    tool: string,
    exists: (p: string) => boolean = fs.existsSync,
    platform: NodeJS.Platform = process.platform,
): string {
    if (platform === 'win32') {
        // OS tools live in System32; append .exe if the caller passed a bare name.
        const exe = /\.(exe|cmd|bat)$/i.test(tool) ? tool : `${tool}.exe`;
        for (const dir of windowsSystemDirs()) {
            const candidate = `${dir}\\${exe}`;
            if (exists(candidate)) return candidate;
        }
        return tool;
    }
    for (const dir of POSIX_SEARCH_DIRS) {
        const candidate = `${dir}/${tool}`;
        if (exists(candidate)) return candidate;
    }
    return tool;
}

/** A spawn plan: the command to exec + its args, plus whether it escapes via systemd. */
export interface DetachedSpawnPlan {
    cmd: string;
    args: string[];
    /** True when wrapped in `systemd-run` (own transient unit / cgroup). */
    viaSystemd: boolean;
}

/**
 * Build a spawn (cmd, args) for a helper/relaunch that MUST outlive the
 * launching AppImage. The plain `detached: true` spawn we used before keeps the
 * child in the *app's* cgroup, so when the app's scope/transient unit is reaped
 * (e.g. an instance launched via `systemd-run --collect` — the service-uninstall
 * relaunch) the child is killed mid-operation (bug #27). Preference order:
 *   1. `systemd-run --user --collect [--unit=…]` — runs in its OWN transient unit
 *      (separate cgroup), surviving the app's teardown. The robust path on systemd.
 *   2. `setsid <prog>` — new session; the robust path on non-systemd hosts (no
 *      transient-unit cgroup reaping exists there).
 *   3. bare `<prog>` — last resort (caller still passes {detached:true}).
 * `resolve` returns an absolute path when the tool exists, else the bare name —
 * so `startsWith('/')` distinguishes "found" from "absent" (Local-Deps).
 */
export function buildDetachedSpawn(
    program: string,
    programArgs: string[],
    opts: { unit?: string; system?: boolean } = {},
    resolve: (t: string) => string = (t) => resolveSystemTool(t),
): DetachedSpawnPlan {
    const systemdRun = resolve('systemd-run');
    if (systemdRun.startsWith('/')) {
        // System scope runs as root -> the system manager (no --user). User
        // scope keeps --user (a user-manager-owned transient unit).
        const scopeArg = opts.system ? [] : ['--user'];
        const unitArg = opts.unit ? [`--unit=${opts.unit}`] : [];
        return {
            cmd: systemdRun,
            args: [...scopeArg, '--collect', ...unitArg, program, ...programArgs],
            viaSystemd: true,
        };
    }
    const setsid = resolve('setsid');
    if (setsid.startsWith('/')) {
        return { cmd: setsid, args: [program, ...programArgs], viaSystemd: false };
    }
    return { cmd: program, args: programArgs, viaSystemd: false };
}
