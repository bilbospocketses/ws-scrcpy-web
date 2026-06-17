/**
 * Linux ServiceClient implementation backed by systemd / systemctl.
 *
 * Mirrors the ServyClient (Windows) shape: synchronous CLI invocations via
 * `execFileSync` wrapped in resolved Promises to satisfy the cross-platform
 * `ServiceClient` interface.
 *
 * Two scopes are supported (selected via `ServiceInstallOptions.scope`):
 *
 *   - **user**   — unit at `~/.config/systemd/user/<name>.service`. Installed
 *                  without sudo. Started via `systemctl --user`. `loginctl
 *                  enable-linger` is invoked best-effort so the service
 *                  survives a full logout. A `~/.config/autostart/
 *                  ws-scrcpy-web-tray.desktop` file is written to autostart
 *                  the tray helper at desktop login (best-effort).
 *
 *   - **system** — unit at `/etc/systemd/system/<name>.service`. System-scope
 *                  installs are no longer handled by this `install()` method;
 *                  they go through `systemServiceCli.installSystemService`
 *                  (the `--install-system-service` CLI core, elevated via one
 *                  awaited `pkexec`). The old `pkexec sh -c` path was removed
 *                  in the system-service redesign. `uninstall()` still supports
 *                  system scope.
 *
 * Status is detected via `systemctl is-active` (machine-readable single
 * keyword) rather than `systemctl status` (verbose, locale-sensitive).
 *
 * `uninstall` resolves the active scope from whichever unit file exists on
 * disk, then disables + removes it. Idempotent — a no-op if neither unit
 * file is present.
 *
 * See `docs/plans/sp3-p4b-contracts.md` for the full spec.
 */

import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Logger } from '../Logger';
import { fileExists } from '../util/fsExists';
import type { ServiceClient, ServiceInstallOptions, ServiceStatus } from './ServiceClient';
import { assertServiceName, shQuote } from './shellEscape';
import { resolveSystemTool } from './systemTools';

const execFileAsync = promisify(execFile);

const log = Logger.for('SystemdClient');

/** systemd scope: per-user (default.target) or system-wide (multi-user.target). */
export type SystemdScope = 'user' | 'system';

/** Resolve systemctl to an absolute path + return the (bin, args) pair for execFile. */
export function systemctlArgv(
    args: string[],
    resolve: (t: string) => string = (t) => resolveSystemTool(t),
): { bin: string; args: string[] } {
    return { bin: resolve('systemctl'), args };
}

/** Filename of the tray helper binary on Linux (no extension). */
const TRAY_HELPER_BIN = 'ws-scrcpy-web-tray';
/** Autostart .desktop filename written under `~/.config/autostart/`. */
const TRAY_AUTOSTART_FILE = 'ws-scrcpy-web-tray.desktop';

/** Root-owned staging dir for the system-scope AppImage (SELinux bin_t — init_t can exec). */
export const STAGED_SYSTEM_DIR = '/opt/ws-scrcpy-web';
/** Stable, channel-agnostic filename for the staged system-scope AppImage. */
export const STAGED_SYSTEM_APPIMAGE = 'WsScrcpyWeb.AppImage';
/**
 * Writable state dir for the system-scope service (config.json, logs/). Lives
 * under `/var/lib` — the policy's built-in `/var/lib(/.*)?` rule labels it
 * `var_lib_t` automatically on creation, so NO custom `semanage` rule is needed
 * (a guarded `restorecon -Rv` at install is just belt-and-suspenders). `/var/opt`
 * was impossible on SELinux: Fedora's `file_contexts.subs_dist` aliases
 * `/var/opt -> /opt`, so semanage rejects any label rule beneath it and the path
 * inherits `/opt`'s `bin_t` — which broke the system-service install on every
 * SELinux distro since beta.41 (proven: `matchpathcon /var/lib/... -> var_lib_t`).
 */
export const SYSTEM_STATE_DIR = '/var/lib/ws-scrcpy-web';
/** VERSION file written into /opt at machine-wide install (binary-only relocate). */
export const SYSTEM_OPT_VERSION_FILE = `${STAGED_SYSTEM_DIR}/VERSION`;
/** System-wide .desktop entry for all users (machine-wide install only). */
export const SYSTEM_DESKTOP_FILE = '/usr/share/applications/ws-scrcpy-web.desktop';
/** hicolor theme apps dir for the machine-wide menu icon (256x256). */
export const SYSTEM_ICON_DIR = '/usr/share/icons/hicolor/256x256/apps';
/** Machine-wide menu icon file — its basename matches the .desktop's
 *  `Icon=ws-scrcpy-web` so the launcher entry resolves to a real icon, and the
 *  full path matches the launcher uninstaller's SYS_ICON teardown
 *  (launcher/src/linux_app_uninstall.rs). */
export const SYSTEM_ICON_FILE = `${SYSTEM_ICON_DIR}/ws-scrcpy-web.png`;
/**
 * Root-owned dependencies dir for the system-scope service (node/adb/
 * scrcpy-server). Under the bin_t-labelled /opt tree so init_t may exec them,
 * and so the app runs its OWN deps rather than a copy from a user's home
 * (Local-Dependencies-Only, #36).
 */
export const STAGED_SYSTEM_DEPS_DIR = `${STAGED_SYSTEM_DIR}/dependencies`;

/**
 * The systemd unit's Environment vars for a given platform + scope. Linux
 * system-scope MUST point at the app's own /opt tree (Local-Dependencies-Only)
 * and set DATA_ROOT so the root service (which has no HOME) doesn't fall back
 * to ephemeral /tmp (#36). Every other case keeps the caller's deps path and
 * lets the launcher bridge DATA_ROOT (Windows ProgramData, Linux user XDG/HOME).
 */
export function buildServiceUnitEnv(
    platform: NodeJS.Platform,
    scope: SystemdScope | undefined,
    userDepsPath: string,
): Record<string, string> {
    // WS_SCRCPY_SERVICE marks the process as the installed service so it can
    // identify itself to the post-install port-discovery poll — the local
    // instance that triggers the install never carries it. Set on every scope.
    if (platform === 'linux' && scope === 'system') {
        return { DATA_ROOT: SYSTEM_STATE_DIR, DEPS_PATH: STAGED_SYSTEM_DEPS_DIR, WS_SCRCPY_SERVICE: '1' };
    }
    return { DEPS_PATH: userDepsPath, WS_SCRCPY_SERVICE: '1' };
}

/**
 * The config.json seeded into the system service's /opt data dir at install so
 * it reads a correct, persistent config on first boot (#36): it knows it is a
 * service (ServiceFirstRunModal, not WelcomeModal), is already first-run-
 * complete, and binds the same web port the installing user is on (so the
 * post-install browser hand-off lands on the same URL). Other fields fall to
 * Config defaults when the service loads this file.
 */
export function buildSystemSeedConfig(currentWebPort: number): Record<string, unknown> {
    return { installMode: 'system-service', firstRunComplete: true, webPort: currentWebPort };
}

/** Per-user decline marker filename — no leading slash, relative to <dataRoot>/control/. */
export const DECLINE_MARKER_NAME = 'system-install-declined';

/**
 * Run a command via pkexec for graphical privilege escalation. The user
 * sees a single password prompt for the entire shell command. Throws on
 * auth-cancel (exit 126), pkexec-not-found, or command failure.
 */
export async function runPkexec(shellCmd: string, label: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync(resolveSystemTool('pkexec'), ['sh', '-c', shellCmd], {
            encoding: 'utf8',
        });
        return stdout;
    } catch (err) {
        const e = err as NodeJS.ErrnoException & { code?: string | number; stderr?: string };
        if (e.code === 'ENOENT') {
            throw new Error(
                `pkexec not found. install polkit (e.g. "sudo dnf install polkit" on fedora) or use user scope instead.`,
            );
        }
        const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
        const exitCode = typeof e.code === 'number' ? e.code : (e as { status?: number }).status;
        if (exitCode === 126) {
            throw new Error('authentication was dismissed. service install cancelled.');
        }
        throw new Error(`pkexec ${label} failed: ${stderr || e.message}`);
    }
}

/**
 * Check if libfuse2 is available (required for Velopack AppImage updates).
 * If missing, return the package-manager install command for the detected
 * distro family (deb or rpm). Returns null if already present.
 */
export async function isLibfuse2Installed(): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync(resolveSystemTool('ldconfig'), ['-p'], {
            encoding: 'utf8',
        });
        return stdout.includes('libfuse.so.2');
    } catch {
        return false;
    }
}

async function libfuse2InstallCmd(): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(resolveSystemTool('ldconfig'), ['-p'], {
            encoding: 'utf8',
        });
        if (stdout.includes('libfuse.so.2')) return null;
    } catch {
        // ldconfig not found or failed — assume libfuse2 is missing.
    }

    if (await fileExists('/usr/bin/dnf')) {
        return 'dnf install -y fuse-libs';
    }
    if (await fileExists('/usr/bin/apt-get')) {
        return 'apt-get install -y libfuse2';
    }
    if (await fileExists('/usr/bin/yum')) {
        return 'yum install -y fuse-libs';
    }
    log.warn('libfuse2 missing but cannot detect package manager (no dnf, apt-get, or yum)');
    return null;
}

/**
 * Ensure libfuse2 is installed (required for Velopack AppImage updates).
 * Uses pkexec for graphical privilege escalation if installation is needed.
 */
export async function ensureLibfuse2(): Promise<void> {
    const cmd = await libfuse2InstallCmd();
    if (!cmd) return;
    log.info(`libfuse2 not found; installing via: ${cmd}`);
    await runPkexec(cmd, 'install libfuse2');
    log.info('libfuse2 installed successfully');
}

async function runSystemctl(args: string[], label: string): Promise<string> {
    try {
        const { bin, args: a } = systemctlArgv(args);
        const { stdout } = await execFileAsync(bin, a, { encoding: 'utf8' });
        return stdout;
    } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; stdout?: Buffer | string };
        const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? '');
        const stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? '');
        const detail = (stderr || stdout || e.message).trim();
        throw new Error(`systemctl ${label} failed: ${detail || e.message}`);
    }
}

/**
 * Render the systemd unit file body for the given install options + scope.
 * Exposed so tests can snapshot the rendered output.
 */
export function renderUnitFile(opts: ServiceInstallOptions, scope: SystemdScope): string {
    const envLines = Object.entries(opts.envVars)
        .map(([k, v]) => `Environment=${k}=${v}`)
        .join('\n');
    const wantedBy = scope === 'user' ? 'default.target' : 'multi-user.target';
    // System scope runs under init_t and may NOT exec a user_home_t AppImage,
    // so the unit references the staged /opt copy (labelled bin_t at install).
    // User scope runs as the unconfined user and execs the home AppImage directly.
    const execStart = scope === 'system' ? `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}` : opts.binPath;
    const workingDir = scope === 'system' ? STAGED_SYSTEM_DIR : opts.startupDir;
    return [
        '[Unit]',
        `Description=${opts.description}`,
        scope === 'system' ? 'After=network-online.target' : 'After=network.target',
        ...(scope === 'system' ? ['Wants=network-online.target'] : []),
        // systemd reads StartLimit* from [Unit], NOT [Service] (it silently
        // ignores them in [Service] -> the restart cap never applies).
        // System scope: 60 s window (takeover-retry scenario — fail fast within
        // the handoff window). User scope: 300 s (5-minute window).
        scope === 'system' ? 'StartLimitIntervalSec=60' : 'StartLimitIntervalSec=300',
        `StartLimitBurst=${opts.maxRestartAttempts}`,
        '',
        '[Service]',
        'Type=simple',
        `ExecStart=${execStart}`,
        `WorkingDirectory=${workingDir}`,
        'Restart=on-failure',
        scope === 'system' ? 'RestartSec=2' : 'RestartSec=5',
        ...(envLines ? [envLines] : []),
        `StandardOutput=append:${opts.logPath}`,
        `StandardError=append:${opts.logPath}`,
        '',
        '[Install]',
        `WantedBy=${wantedBy}`,
        '',
    ].join('\n');
}

/**
 * Build the privileged shell script for a machine-wide install. Runs under a
 * single pkexec prompt. Relocates ONLY the AppImage binary to /opt (no deps,
 * no systemd unit) — deps stay per-user in ~/.local. Writes VERSION, drops a
 * system-wide .desktop entry for all users, and refreshes the menu cache. When
 * `iconSource` is supplied it also installs that icon file into the hicolor theme
 * (so the .desktop's `Icon=ws-scrcpy-web` resolves to a real icon, not a generic
 * placeholder) and refreshes the icon cache — best-effort, omitted entirely when
 * absent. As the final step it DELETES the original (home) AppImage — a true
 * relocate — so the user can't end up running a stale home copy alongside the
 * /opt one.
 * `binTool`/`sbinTool` are injectable for testing; production resolves absolute
 * paths via systemTools (Local-Dependencies-Only — no bare-name $PATH lookup).
 */
export function buildMachineWideInstallScript(
    args: { sourceAppImage: string; version: string; iconSource?: string | undefined },
    binTool: (t: string) => string = (t) => resolveSystemTool(t),
    sbinTool: (t: string) => string = (t) => resolveSystemTool(t),
): string {
    const staged = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
    const mkdir = binTool('mkdir');
    const cp = binTool('cp');
    const chmod = binTool('chmod');
    const printf = binTool('printf');
    const semanage = sbinTool('semanage');
    const restorecon = sbinTool('restorecon');
    const updateDesktopDb = binTool('update-desktop-database');
    const rm = binTool('rm');
    const desktop = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=ws-scrcpy-web',
        `Exec=${staged}`,
        'Icon=ws-scrcpy-web',
        'Categories=Utility;',
    ].join('\\n');
    const steps = [
        `${mkdir} -p ${STAGED_SYSTEM_DIR}`,
        `${cp} ${shQuote(args.sourceAppImage)} "${staged}"`,
        `${chmod} 0755 "${staged}"`,
        `${printf} '%s' ${shQuote(args.version)} > ${SYSTEM_OPT_VERSION_FILE}`,
        // bin_t add + restorecon as INDEPENDENT `;`-separated steps (whole subshell
        // `|| true`) so neither a re-install's "already defined" nor the `-m`-to-
        // unchanged failure can short-circuit the restorecon (beta.61 #9 fix). No chcon.
        `( ${semanage} fcontext -a -t bin_t '${STAGED_SYSTEM_DIR}(/.*)?' || ${semanage} fcontext -m -t bin_t '${STAGED_SYSTEM_DIR}(/.*)?' ; ${restorecon} -Rv "${STAGED_SYSTEM_DIR}" ) || true`,
        `( ${printf} '${desktop}\\n' > ${SYSTEM_DESKTOP_FILE} || true )`,
        `( ${updateDesktopDb} /usr/share/applications || true )`,
    ];
    // Install the launcher icon into the hicolor theme so the .desktop's
    // `Icon=ws-scrcpy-web` resolves to a real icon instead of a generic
    // placeholder. The caller (ServiceApi) stages the bundled tray-icon.png to a
    // root-readable temp (os.tmpdir()) and passes THAT as `iconSource` — the pkexec
    // cp runs as root, which can't read the user's FUSE-mounted AppImage. Omitted
    // (graceful skip) when absent.
    // Wrapped in ONE best-effort group (trailing `|| true`, like the SELinux line
    // above): POSIX sh gives `&&`/`||` EQUAL left-assoc precedence, so a missing
    // `.DirIcon` (cp fails) must not break the outer `&&` chain and skip the
    // home-AppImage delete below — the relocate must still complete. Teardown
    // removes this file (launcher/src/linux_app_uninstall.rs — SYS_ICON).
    if (args.iconSource) {
        const iconCache = binTool('gtk-update-icon-cache');
        steps.push(
            `( ${mkdir} -p ${SYSTEM_ICON_DIR} && ${cp} ${shQuote(args.iconSource)} ${SYSTEM_ICON_FILE} && ( ${iconCache} -f /usr/share/icons/hicolor || true ) || true )`,
        );
    }
    // Final step — remove the original (home) AppImage now that the binary
    // lives in /opt: a true relocate. Runs as root (pkexec), so it can unlink
    // the user's file; unlinking is safe while the home AppImage is still the
    // running process (the inode stays alive for the live FUSE mount until it
    // exits / re-execs to /opt). `|| true` so a failed cleanup never aborts an
    // otherwise-successful install.
    steps.push(`( ${rm} -f ${shQuote(args.sourceAppImage)} || true )`);
    return steps.join(' && ');
}

/**
 * Build the privileged shell script for an in-app update of a machine-wide-
 * no-service install (the user runs the root-owned `/opt` AppImage directly,
 * NOT a service). Runs under a single pkexec prompt.
 *
 * The swap is a RENAME, never a `cp`: `cp` overwrites the file in place, which
 * fails with `ETXTBSY` on the running AppImage. A rename works while the old
 * AppImage is still mounted — the old inode stays alive for the running process,
 * and the new file lands at the same path for the next launch:
 *
 *   1. `mv -f <opt>/WsScrcpyWeb.AppImage <opt>/WsScrcpyWeb.AppImage.bak` — back up
 *      the running binary (rollback). The live process keeps its mounted inode.
 *   2. `mv -f <staged> <opt>/WsScrcpyWeb.AppImage` — move the verified download in.
 *   3. `chmod 0755` the new file.
 *   4. re-apply the `bin_t` label best-effort — `restorecon` re-applies the
 *      persistent fcontext rule set at machine-wide install; `chcon -t bin_t` is
 *      the transient fallback; the trailing `|| true` keeps a non-SELinux host
 *      going (mirrors linux_apply.rs::relabel_command, which relabels the single
 *      swapped file with `restorecon -v` / `chcon -t bin_t`).
 *   5. `printf` the new VERSION marker into `/opt/ws-scrcpy-web/VERSION`.
 *
 * The relaunch is NOT part of this script — it must run as the user (not under
 * pkexec, which would come back as root). The caller spawns a separate detached
 * relaunch-only helper that waits for the old process to exit (releasing the
 * per-user flock) before relaunching the freshly-swapped `/opt` copy.
 *
 * `binTool`/`sbinTool` are injectable for testing; production resolves absolute
 * paths via systemTools (Local-Dependencies-Only — no bare-name $PATH lookup).
 */
export function buildMachineWideUpdateScript(
    args: { stagedAppImage: string; version: string },
    binTool: (t: string) => string = (t) => resolveSystemTool(t),
    sbinTool: (t: string) => string = (t) => resolveSystemTool(t),
): string {
    const target = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
    const backup = `${target}.bak`;
    const mv = binTool('mv');
    const chmod = binTool('chmod');
    const chcon = binTool('chcon');
    const printf = binTool('printf');
    const restorecon = sbinTool('restorecon');
    return [
        `${mv} -f "${target}" "${backup}"`,
        `${mv} -f ${shQuote(args.stagedAppImage)} "${target}"`,
        `${chmod} 0755 "${target}"`,
        `( ${restorecon} -v "${target}" || ${chcon} -t bin_t "${target}" || true )`,
        `${printf} '%s' ${shQuote(args.version)} > ${SYSTEM_OPT_VERSION_FILE}`,
    ].join(' && ');
}

/**
 * Build the privileged shell script for a system-scope uninstall (run via one
 * pkexec). The service name is validated and every interpolated value is
 * single-quoted so nothing in `name` / `unitPath` can break out of the root
 * `sh -c` (review finding #12).
 */
export function buildSystemUninstallScript(name: string, unitPath: string, systemctl: string): string {
    assertServiceName(name);
    return [
        `${systemctl} disable --now ${shQuote(`${name}.service`)} || true`,
        `rm -f ${shQuote(unitPath)}`,
        `${systemctl} daemon-reload`,
    ].join(' && ');
}

/**
 * Resolve the absolute path of the tray helper binary.
 *
 * Mirrors `ServyClient.resolveTrayHelperPath` shape:
 *   1. Installed (Velopack AppImage layout): sibling of the launcher in
 *      `process.cwd()`.
 *   2. Dev / from-source: `<cwd>/publish/ws-scrcpy-web-tray`.
 *
 * Returns `null` if neither candidate exists. Callers fall back to a bare-name
 * `Exec=ws-scrcpy-web-tray` in the .desktop file (PATH lookup) and log a
 * warning — best-effort so a missing tray binary doesn't fail the service
 * install.
 */
async function resolveTrayHelperPath(
    cwd: string = process.cwd(),
    exists: (p: string) => Promise<boolean> = fileExists,
): Promise<string | null> {
    const installedCandidate = path.join(cwd, TRAY_HELPER_BIN);
    if (await exists(installedCandidate)) return installedCandidate;
    const devCandidate = path.join(cwd, 'publish', TRAY_HELPER_BIN);
    if (await exists(devCandidate)) return devCandidate;
    return null;
}

/**
 * #31: whether a binary at a stable path is safe to reuse as a user-service
 * ExecStart without re-staging — it must be a regular file (lstat, so a symlink
 * an attacker could repoint is rejected), root-owned, and not group/other-
 * writable. Pure (takes the lstat result) so it is unit-testable.
 */
export function isSafeReusableBin(stat: fs.Stats): boolean {
    return stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0;
}

/**
 * Resolve a STABLE, executable `ExecStart` binary for a user-scope service. The
 * volatile launch path (`opts.binPath` = `$APPIMAGE`, e.g. `~/Downloads/…`) must
 * never be the unit's `ExecStart`: a browser-downloaded AppImage is `-rw-r--r--`
 * (the GUI launches it but systemd's `execve()` needs `+x`), and it's the
 * throwaway installer artifact.
 *
 *   - Reuse the machine-wide `/opt` binary only when `lstat` confirms it's a
 *     safe root-owned regular file (#31 — not a symlink); else stage our own.
 *   - Stage by copying to a temp file, `chmod 0755`, then an atomic `rename`
 *     into place (#31), so a concurrent unit start never sees a partial or
 *     briefly-non-executable binary.
 *
 * Returns `opts` with `binPath` + `startupDir` retargeted at the stable path.
 */
export async function stageStableUserBin(opts: ServiceInstallOptions): Promise<ServiceInstallOptions> {
    const optBin = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
    let optStat: fs.Stats | null = null;
    try {
        optStat = await fs.promises.lstat(optBin);
    } catch {
        optStat = null;
    }
    if (optStat && isSafeReusableBin(optStat)) {
        return { ...opts, binPath: optBin, startupDir: STAGED_SYSTEM_DIR };
    }
    if (!opts.dataRoot) {
        throw new Error('SystemdClient.install: user-scope install requires dataRoot to stage a stable binary');
    }
    const binDir = `${opts.dataRoot}/bin`;
    const stableBin = `${binDir}/${STAGED_SYSTEM_APPIMAGE}`;
    await fs.promises.mkdir(binDir, { recursive: true });
    // Atomic stage: copy to a temp file, make it executable, then rename into
    // place so a concurrent unit start never sees a partial / non-executable bin.
    const tmpBin = `${stableBin}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    await fs.promises.copyFile(opts.binPath, tmpBin);
    await fs.promises.chmod(tmpBin, 0o755);
    await fs.promises.rename(tmpBin, stableBin);
    return { ...opts, binPath: stableBin, startupDir: binDir };
}

export class SystemdClient implements ServiceClient {
    /** Absolute path to the user-scope unit file for `name`. */
    public userUnitPath(name: string): string {
        return path.join(os.homedir(), '.config', 'systemd', 'user', `${name}.service`);
    }

    /** Absolute path to the system-scope unit file for `name`. */
    public systemUnitPath(name: string): string {
        return path.join('/etc', 'systemd', 'system', `${name}.service`);
    }

    /** Absolute path to the tray helper autostart .desktop file (user scope). */
    public trayAutostartPath(): string {
        return path.join(os.homedir(), '.config', 'autostart', TRAY_AUTOSTART_FILE);
    }

    /** Absolute path of the staged system-scope AppImage (system scope ExecStart). */
    public stagedSystemBinPath(): string {
        // Forward-slash Linux path on purpose — this is the path written into the
        // Linux systemd unit. Do NOT use path.join here: on a Windows host it emits
        // backslashes, which both fails the test and is wrong for a Linux unit file.
        return `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
    }

    /**
     * Inspect the filesystem to decide which scope owns this service. Used by
     * uninstall / status / restart / stop so callers don't have to track
     * scope themselves after the initial install.
     */
    private async resolveActiveScope(name: string): Promise<SystemdScope | null> {
        if (await fileExists(this.userUnitPath(name))) return 'user';
        if (await fileExists(this.systemUnitPath(name))) return 'system';
        return null;
    }

    /**
     * Public accessor for the active scope (which unit file exists on disk).
     * Surfaced through `/api/service/status` so the frontend can pre-select the
     * Linux scope radio from filesystem truth rather than the mutable
     * `installMode` config (which can drift / be reverted). `null` when no unit
     * file exists for `name`.
     */
    public async getInstalledScope(name: string): Promise<SystemdScope | null> {
        return this.resolveActiveScope(name);
    }

    /**
     * F1: resolve a STABLE, executable `ExecStart` binary for a user-scope
     * service. The volatile launch path (`opts.binPath` = `$APPIMAGE`, e.g.
     * `~/Downloads/...AppImage`) must NEVER be the unit's `ExecStart`: a
     * browser-downloaded AppImage is `-rw-r--r--` (the GUI can launch it but
     * systemd's `execve()` requires `+x` → `203/EXEC`), and that file is the
     * throwaway installer artifact (a machine-wide install deletes it; users
     * delete downloads).
     *
     *   - Reuse the machine-wide `/opt` binary only when `lstat` confirms it's
     *     a safe root-owned regular file (#31) — no copy.
     *   - Otherwise stage the source AppImage to `<dataRoot>/bin/` via a temp
     *     file + `chmod 0755` + atomic rename (#31), so the unit always points
     *     at a complete, executable file.
     *
     * Delegates to the module-level `stageStableUserBin` (extracted so the
     * staging logic is unit-testable). Forward-slash paths (Linux unit file).
     */
    private withStableUserBin(opts: ServiceInstallOptions): Promise<ServiceInstallOptions> {
        return stageStableUserBin(opts);
    }

    public async install(opts: ServiceInstallOptions): Promise<void> {
        const scope = opts.scope;
        if (!scope) {
            throw new Error('SystemdClient.install: scope is required (caller must pass user or system)');
        }
        // System-scope installs now go through systemServiceCli.installSystemService
        // (the `--install-system-service` CLI core, elevated via sudo or one awaited
        // pkexec) — NOT this method. The old pkexec-sh-c path (buildSystemInstallScript
        // + the kill-on-timeout runPkexec) was removed in the system-service redesign.
        if (scope === 'system') {
            throw new Error(
                'SystemdClient.install no longer handles system scope — use systemServiceCli.installSystemService',
            );
        }

        // F1: user-scope services must ExecStart a STABLE, executable binary —
        // never the volatile launch path ($APPIMAGE / ~/Downloads).
        const effectiveOpts = await this.withStableUserBin(opts);
        const unitContent = renderUnitFile(effectiveOpts, scope);
        const unitPath = this.userUnitPath(opts.name);

        await fs.promises.mkdir(path.dirname(unitPath), { recursive: true });
        await fs.promises.writeFile(unitPath, unitContent, { mode: 0o644 });
        await runSystemctl(['--user', 'daemon-reload'], 'daemon-reload');
        // Never start with `--now` while the local instance still holds the per-user
        // lock / web port — the service would exit "already running" before binding.
        // Just `enable`; ServiceApi spawns the --user out-of-cgroup install-handoff
        // helper that starts it after the local instance exits and frees the port.
        await runSystemctl(['--user', 'enable', `${opts.name}.service`], `enable ${opts.name}.service`);

        // Best-effort linger so the service survives a full logout.
        // Common reasons this can fail: loginctl absent (non-systemd-logind
        // systems), missing privileges on hardened distros. Service is
        // already installed + running — degraded but functional.
        try {
            await execFileAsync(resolveSystemTool('loginctl'), ['enable-linger', os.userInfo().username]);
        } catch (err) {
            log.warn(`loginctl enable-linger failed (service still installed): ${(err as Error).message}`);
        }

        // Best-effort tray autostart. System scope skips this — headless
        // server case dominant, no desktop session to autostart into.
        try {
            await this.writeTrayAutostart();
        } catch (err) {
            log.warn(`tray autostart .desktop write failed (service install succeeded): ${(err as Error).message}`);
        }
    }

    /**
     * Disable + remove the systemd unit for `name`, resolving the active scope
     * from whichever unit file exists on disk. Idempotent — a no-op if neither
     * unit file is present.
     *
     * NOTE (item 32): the Linux `/api/service/uninstall` path no longer calls
     * this method. ServiceApi.handleUninstall hands off to an out-of-cgroup
     * `systemd-run` teardown helper instead, because running `systemctl disable
     * --now` from inside the service unit's own cgroup would kill the calling
     * process mid-operation. This method is retained as the `ServiceClient`
     * interface implementation (and for any non-cgroup-bound callers).
     */
    public async uninstall(name: string): Promise<void> {
        const scope = await this.resolveActiveScope(name);
        if (scope === null) {
            return;
        }

        if (scope === 'system' && process.getuid?.() !== 0) {
            const unitPath = this.systemUnitPath(name);
            const systemctl = resolveSystemTool('systemctl');
            const cmd = buildSystemUninstallScript(name, unitPath, systemctl);
            await runPkexec(cmd, 'uninstall (system scope)');
        } else {
            const baseArgs = scope === 'user' ? ['--user'] : [];
            try {
                await runSystemctl(
                    [...baseArgs, 'disable', '--now', `${name}.service`],
                    `disable --now ${name}.service`,
                );
            } catch (err) {
                log.info(`systemctl disable returned: ${(err as Error).message}`);
            }

            const unitPath = scope === 'user' ? this.userUnitPath(name) : this.systemUnitPath(name);
            try {
                await fs.promises.unlink(unitPath);
            } catch {
                // Already gone.
            }

            try {
                await runSystemctl([...baseArgs, 'daemon-reload'], 'daemon-reload (after uninstall)');
            } catch (err) {
                log.warn(`daemon-reload after uninstall failed: ${(err as Error).message}`);
            }
        }

        // Best-effort autostart cleanup (user scope only — system scope never
        // wrote one). Idempotent: ignore "already gone".
        if (scope === 'user') {
            try {
                await this.removeTrayAutostart();
            } catch (err) {
                log.warn(`tray autostart removal failed (service uninstall succeeded): ${(err as Error).message}`);
            }
        }
    }

    public async status(name: string): Promise<ServiceStatus> {
        const scope = await this.resolveActiveScope(name);
        if (scope === null) return 'not-installed';

        const baseArgs = scope === 'user' ? ['--user'] : [];
        // is-active prints one of: active, inactive, activating, failed,
        // unknown. It also exits non-zero for inactive/failed — that's NOT an
        // error for our purposes (the unit file exists; we just want the
        // running state).
        try {
            const { bin, args: a } = systemctlArgv([...baseArgs, 'is-active', `${name}.service`]);
            const { stdout } = await execFileAsync(bin, a, { encoding: 'utf8' });
            return stdout.trim() === 'active' ? 'running' : 'stopped';
        } catch {
            // Non-zero exit (inactive / failed / activating) — treat as stopped.
            return 'stopped';
        }
    }

    public async restart(name: string): Promise<void> {
        const scope = await this.resolveActiveScope(name);
        if (scope === null) {
            throw new Error(`systemctl restart: ${name}.service not installed`);
        }
        const baseArgs = scope === 'user' ? ['--user'] : [];
        await runSystemctl([...baseArgs, 'restart', `${name}.service`], `restart ${name}.service`);
    }

    public async stop(name: string): Promise<void> {
        const scope = await this.resolveActiveScope(name);
        if (scope === null) {
            // Idempotent — nothing to stop.
            return;
        }
        const baseArgs = scope === 'user' ? ['--user'] : [];
        // Tolerate "already stopped" / "not loaded" — match ServyClient stop semantics.
        try {
            await runSystemctl([...baseArgs, 'stop', `${name}.service`], `stop ${name}.service`);
        } catch (err) {
            log.info(`systemctl stop returned: ${(err as Error).message}`);
        }
    }

    /**
     * Write the tray helper autostart .desktop file under
     * `~/.config/autostart/`. The Linux equivalent of Windows's HKCU Run-key.
     *
     * F2: only written when a tray helper binary resolves to an ABSOLUTE path on
     * disk. If none is found, the autostart is SKIPPED entirely — we never write
     * a bare-name `Exec=ws-scrcpy-web-tray` (a PATH lookup that violates
     * Local-Dependencies-Only, and — since Linux has no tray binary, item 27 —
     * only leaves an orphaned autostart entry that never resolves).
     */
    private async writeTrayAutostart(): Promise<void> {
        const trayPath = await resolveTrayHelperPath();
        if (!trayPath) {
            log.info('tray helper binary not found; skipping tray autostart (no PATH-reliant Exec written)');
            return;
        }

        const desktopPath = this.trayAutostartPath();
        const content = [
            '[Desktop Entry]',
            'Type=Application',
            'Name=ws-scrcpy-web tray',
            `Exec=${trayPath}`,
            'Hidden=false',
            'NoDisplay=false',
            'X-GNOME-Autostart-enabled=true',
            '',
        ].join('\n');

        await fs.promises.mkdir(path.dirname(desktopPath), { recursive: true });
        await fs.promises.writeFile(desktopPath, content, { mode: 0o644 });
    }

    /** Remove the tray autostart .desktop file. Idempotent. */
    private async removeTrayAutostart(): Promise<void> {
        const desktopPath = this.trayAutostartPath();
        try {
            await fs.promises.unlink(desktopPath);
        } catch {
            // Already gone — desired post-state.
        }
    }
}
