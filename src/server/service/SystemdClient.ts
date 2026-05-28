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
 *   - **system** — unit at `/etc/systemd/system/<name>.service`. Requires
 *                  root to write; when `process.getuid() !== 0`, elevation
 *                  goes through pkexec (PR #211) — the unit body is written
 *                  to a tmp path and `pkexec sh -c "cp ... && daemon-reload
 *                  && enable"` runs the privileged steps under a single
 *                  graphical password prompt. No tray autostart (system-scope
 *                  services typically run on headless servers without a
 *                  desktop session).
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

import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Logger } from '../Logger';
import type {
    ServiceClient,
    ServiceInstallOptions,
    ServiceStatus,
} from './ServiceClient';

const execFileAsync = promisify(execFile);

const log = Logger.for('SystemdClient');

/** systemd scope: per-user (default.target) or system-wide (multi-user.target). */
export type SystemdScope = 'user' | 'system';

/** Filename of the tray helper binary on Linux (no extension). */
const TRAY_HELPER_BIN = 'ws-scrcpy-web-tray';
/** Autostart .desktop filename written under `~/.config/autostart/`. */
const TRAY_AUTOSTART_FILE = 'ws-scrcpy-web-tray.desktop';

/**
 * Wrap execFileSync so the thrown Error includes stderr — matches the pattern
 * established in ServyClient. Without this, Node surfaces only the exit code.
 */
/**
 * Run a command via pkexec for graphical privilege escalation. The user
 * sees a single password prompt for the entire shell command. Throws on
 * auth-cancel (exit 126), pkexec-not-found, or command failure.
 */
async function runPkexec(shellCmd: string, label: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync('pkexec', ['sh', '-c', shellCmd], {
            encoding: 'utf8',
            timeout: 60_000,
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
export function isLibfuse2Installed(): boolean {
    try {
        const out = execFileSync('ldconfig', ['-p'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
        });
        return out.includes('libfuse.so.2');
    } catch {
        return false;
    }
}

function libfuse2InstallCmd(): string | null {
    try {
        const out = execFileSync('ldconfig', ['-p'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
        });
        if (out.includes('libfuse.so.2')) return null;
    } catch {
        // ldconfig not found or failed — assume libfuse2 is missing.
    }

    if (fs.existsSync('/usr/bin/dnf')) {
        return 'dnf install -y fuse-libs';
    }
    if (fs.existsSync('/usr/bin/apt-get')) {
        return 'apt-get install -y libfuse2';
    }
    if (fs.existsSync('/usr/bin/yum')) {
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
    const cmd = libfuse2InstallCmd();
    if (!cmd) return;
    log.info(`libfuse2 not found; installing via: ${cmd}`);
    await runPkexec(cmd, 'install libfuse2');
    log.info('libfuse2 installed successfully');
}

function runSystemctl(args: string[], label: string): string {
    try {
        return execFileSync('systemctl', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
        });
    } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; stdout?: Buffer | string };
        const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
        const stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') ?? '';
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
    // StartLimitIntervalSec=300 means: count restart attempts in a rolling
    // 5-minute window; if maxRestartAttempts is exceeded, systemd gives up.
    return [
        '[Unit]',
        `Description=${opts.description}`,
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        `ExecStart=${opts.binPath}`,
        `WorkingDirectory=${opts.startupDir}`,
        'Restart=on-failure',
        'RestartSec=5',
        `StartLimitBurst=${opts.maxRestartAttempts}`,
        'StartLimitIntervalSec=300',
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
function resolveTrayHelperPath(
    cwd: string = process.cwd(),
    exists: (p: string) => boolean = fs.existsSync,
): string | null {
    const installedCandidate = path.join(cwd, TRAY_HELPER_BIN);
    if (exists(installedCandidate)) return installedCandidate;
    const devCandidate = path.join(cwd, 'publish', TRAY_HELPER_BIN);
    if (exists(devCandidate)) return devCandidate;
    return null;
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

    /**
     * Inspect the filesystem to decide which scope owns this service. Used by
     * uninstall / status / restart / stop so callers don't have to track
     * scope themselves after the initial install.
     */
    private resolveActiveScope(name: string): SystemdScope | null {
        if (fs.existsSync(this.userUnitPath(name))) return 'user';
        if (fs.existsSync(this.systemUnitPath(name))) return 'system';
        return null;
    }

    public async install(opts: ServiceInstallOptions): Promise<void> {
        const scope = opts.scope;
        if (!scope) {
            throw new Error(
                'SystemdClient.install: scope is required (caller must pass user or system)',
            );
        }

        const unitContent = renderUnitFile(opts, scope);
        const unitPath = scope === 'user'
            ? this.userUnitPath(opts.name)
            : this.systemUnitPath(opts.name);

        if (scope === 'system' && process.getuid?.() !== 0) {
            // Not root — use pkexec for graphical privilege escalation.
            // Write unit to temp, then pkexec copies + enables in one prompt.
            const tmpFile = path.join(os.tmpdir(), `${opts.name}.service.tmp`);
            fs.writeFileSync(tmpFile, unitContent, { mode: 0o644 });
            try {
                const cmd = [
                    `cp "${tmpFile}" "${unitPath}"`,
                    'systemctl daemon-reload',
                    `systemctl enable --now ${opts.name}.service`,
                ].join(' && ');
                await runPkexec(cmd, 'install (system scope)');
            } finally {
                try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
            }
        } else {
            // User scope (no elevation) or already root.
            fs.mkdirSync(path.dirname(unitPath), { recursive: true });
            fs.writeFileSync(unitPath, unitContent, { mode: 0o644 });

            const baseArgs = scope === 'user' ? ['--user'] : [];
            runSystemctl([...baseArgs, 'daemon-reload'], 'daemon-reload');
            runSystemctl(
                [...baseArgs, 'enable', '--now', `${opts.name}.service`],
                `enable --now ${opts.name}.service`,
            );
        }

        if (scope === 'user') {
            // Best-effort linger so the service survives a full logout.
            // Common reasons this can fail: loginctl absent (non-systemd-logind
            // systems), missing privileges on hardened distros. Service is
            // already installed + running — degraded but functional.
            try {
                execFileSync('loginctl', ['enable-linger', os.userInfo().username], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
            } catch (err) {
                log.warn(
                    `loginctl enable-linger failed (service still installed): ${
                        (err as Error).message
                    }`,
                );
            }

            // Best-effort tray autostart. System scope skips this — headless
            // server case dominant, no desktop session to autostart into.
            try {
                this.writeTrayAutostart();
            } catch (err) {
                log.warn(
                    `tray autostart .desktop write failed (service install succeeded): ${
                        (err as Error).message
                    }`,
                );
            }
        }
    }

    public async uninstall(name: string): Promise<void> {
        const scope = this.resolveActiveScope(name);
        if (scope === null) {
            return;
        }

        if (scope === 'system' && process.getuid?.() !== 0) {
            const unitPath = this.systemUnitPath(name);
            const cmd = [
                `systemctl disable --now ${name}.service || true`,
                `rm -f "${unitPath}"`,
                'systemctl daemon-reload',
            ].join(' && ');
            await runPkexec(cmd, 'uninstall (system scope)');
        } else {
            const baseArgs = scope === 'user' ? ['--user'] : [];
            try {
                runSystemctl(
                    [...baseArgs, 'disable', '--now', `${name}.service`],
                    `disable --now ${name}.service`,
                );
            } catch (err) {
                log.info(`systemctl disable returned: ${(err as Error).message}`);
            }

            const unitPath = scope === 'user' ? this.userUnitPath(name) : this.systemUnitPath(name);
            try {
                fs.unlinkSync(unitPath);
            } catch {
                // Already gone.
            }

            try {
                runSystemctl([...baseArgs, 'daemon-reload'], 'daemon-reload (after uninstall)');
            } catch (err) {
                log.warn(`daemon-reload after uninstall failed: ${(err as Error).message}`);
            }
        }

        // Best-effort autostart cleanup (user scope only — system scope never
        // wrote one). Idempotent: ignore "already gone".
        if (scope === 'user') {
            try {
                this.removeTrayAutostart();
            } catch (err) {
                log.warn(
                    `tray autostart removal failed (service uninstall succeeded): ${
                        (err as Error).message
                    }`,
                );
            }
        }
    }

    public async status(name: string): Promise<ServiceStatus> {
        const scope = this.resolveActiveScope(name);
        if (scope === null) return 'not-installed';

        const baseArgs = scope === 'user' ? ['--user'] : [];
        // is-active prints one of: active, inactive, activating, failed,
        // unknown. It also exits non-zero for inactive/failed — that's NOT an
        // error for our purposes (the unit file exists; we just want the
        // running state).
        try {
            const out = execFileSync(
                'systemctl',
                [...baseArgs, 'is-active', `${name}.service`],
                { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
            ).trim();
            return out === 'active' ? 'running' : 'stopped';
        } catch {
            // Non-zero exit (inactive / failed / activating) — treat as stopped.
            return 'stopped';
        }
    }

    public async restart(name: string): Promise<void> {
        const scope = this.resolveActiveScope(name);
        if (scope === null) {
            throw new Error(`systemctl restart: ${name}.service not installed`);
        }
        const baseArgs = scope === 'user' ? ['--user'] : [];
        runSystemctl(
            [...baseArgs, 'restart', `${name}.service`],
            `restart ${name}.service`,
        );
    }

    public async stop(name: string): Promise<void> {
        const scope = this.resolveActiveScope(name);
        if (scope === null) {
            // Idempotent — nothing to stop.
            return;
        }
        const baseArgs = scope === 'user' ? ['--user'] : [];
        // Tolerate "already stopped" / "not loaded" — match ServyClient stop semantics.
        try {
            runSystemctl(
                [...baseArgs, 'stop', `${name}.service`],
                `stop ${name}.service`,
            );
        } catch (err) {
            log.info(`systemctl stop returned: ${(err as Error).message}`);
        }
    }

    /**
     * Write the tray helper autostart .desktop file under
     * `~/.config/autostart/`. The Linux equivalent of Windows's HKCU Run-key.
     *
     * If the tray binary can't be located on disk, write a `Exec=<bare-name>`
     * pointing at PATH lookup so a tray binary later placed on PATH still
     * works. Logs a warning in that case.
     */
    private writeTrayAutostart(): void {
        const desktopPath = this.trayAutostartPath();
        const trayPath = resolveTrayHelperPath();
        let exec: string;
        if (trayPath) {
            exec = trayPath;
        } else {
            exec = TRAY_HELPER_BIN;
            log.warn(
                `tray helper binary not found next to launcher or in publish/; ` +
                `writing Exec=${TRAY_HELPER_BIN} (relies on PATH lookup at login)`,
            );
        }

        const content = [
            '[Desktop Entry]',
            'Type=Application',
            'Name=ws-scrcpy-web tray',
            `Exec=${exec}`,
            'Hidden=false',
            'NoDisplay=false',
            'X-GNOME-Autostart-enabled=true',
            '',
        ].join('\n');

        fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
        fs.writeFileSync(desktopPath, content, { mode: 0o644 });
    }

    /** Remove the tray autostart .desktop file. Idempotent. */
    private removeTrayAutostart(): void {
        const desktopPath = this.trayAutostartPath();
        try {
            fs.unlinkSync(desktopPath);
        } catch {
            // Already gone — desired post-state.
        }
    }
}
