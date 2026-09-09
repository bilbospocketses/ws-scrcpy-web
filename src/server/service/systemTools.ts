/**
 * Resolve an OS tool to its absolute path, scanning the canonical system
 * locations in priority order (POSIX: /usr/bin,/bin,/usr/sbin,/sbin; Windows:
 * %SystemRoot%\System32). Closes the PATH-hijack surface flagged by review #20
 * and required by the Local-Dependencies-Only rule: OS tools
 * (systemctl/pkexec/taskkill/icacls/ip/arp/route/…) are never invoked by bare
 * name, which would resolve via $PATH / %PATH%.
 *
 * The last-resort fallback IS the bare name, and that is deliberate — but not
 * for the reason this comment used to give. It claimed the bare name "surfaces
 * a clear ENOENT rather than a silent miss", which is simply false: a bare name
 * is resolved through PATH and may well succeed. The real reason is
 * NON-FHS DISTRIBUTIONS. On NixOS and Guix the system tools are not in
 * /usr/bin, /bin, /usr/sbin or /sbin at all — they live under
 * /run/current-system/sw/bin — so after the four absolute probes miss, PATH is
 * the only thing that can still find them. Removing the fallback would resolve
 * a hardening argument by breaking those systems outright.
 *
 * That is materially different from calling `spawn('systemctl')` directly: PATH
 * is reached only after four absolute candidates have been checked and missed,
 * so the hijack surface is the narrow tail rather than the default. Corrected
 * 2026-09-09 (item 123).
 */
import * as fs from 'node:fs';

/** POSIX search order: user bins first (/usr/bin, /bin), then admin bins (/usr/sbin, /sbin). */
const POSIX_SEARCH_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;

/**
 * Windows OS tools (taskkill, icacls, arp, route, …) live under System32.
 *
 * The path is a LITERAL, not `%SystemRoot%`. Reading the env var was the older
 * shape here, and it is a forbidden resolution path under the same
 * Local-Dependencies-Only rule this function exists to serve: an env var is
 * attacker- and caller-controlled in exactly the way `$PATH` is. The repo
 * already standardises on the literal elsewhere for the same reason —
 * `launcher/src/elevated_runner.rs` pins `C:\Windows\System32\cmd.exe` with the
 * comment "OS-stable, never moves", and `openBrowser.ts` did the same in #653.
 * Fixed 2026-09-09 (item 123), which found the two halves disagreeing.
 */
const WINDOWS_ROOT = 'C:\\Windows';

function windowsSystemDirs(): string[] {
    return [`${WINDOWS_ROOT}\\System32`, WINDOWS_ROOT];
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
