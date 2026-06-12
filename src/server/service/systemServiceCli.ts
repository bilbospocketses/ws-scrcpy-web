// biome-ignore lint/style/useNodejsImportProtocol: webpack externals
import { execFile } from 'child_process';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals
import * as fs from 'fs';
import {
    STAGED_SYSTEM_DIR, STAGED_SYSTEM_APPIMAGE, STAGED_SYSTEM_DEPS_DIR, SYSTEM_STATE_DIR,
    renderUnitFile, buildServiceUnitEnv, buildSystemSeedConfig,
} from './SystemdClient';
import { resolveSystemTool } from './systemTools';
import { WS_SCRCPY_SERVICE_NAME, WS_SCRCPY_SERVICE_DESCRIPTION } from '../../common/ServiceEvents';
import { Config } from '../Config';
import { Logger } from '../Logger';

const log = Logger.for('systemServiceCli');

export interface CommandResult { code: number; stdout: string; stderr: string; }
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

export interface CoreDeps {
    getuid: () => number;
    run: CommandRunner;
    writeFile: (path: string, content: string, opts: { mode: number }) => void;
    appImageSource: string;
    depsSource: string;
    tool: (t: string) => string;       // /usr/bin resolver
    sbinTool: (t: string) => string;   // /usr/sbin resolver (semanage/restorecon)
}

const UNIT_PATH = `/etc/systemd/system/${WS_SCRCPY_SERVICE_NAME}.service`;
const STAGED_BIN = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
const FCONTEXT_SPEC = `${STAGED_SYSTEM_DIR}(/.*)?`;

function assertRoot(getuid: () => number): void {
    if (getuid() !== 0) {
        throw new Error('--install-system-service must run as root (use sudo, or the desktop installer which elevates via pkexec).');
    }
}

export async function installSystemService(opts: { port: number }, d: CoreDeps): Promise<void> {
    assertRoot(d.getuid);
    const mkdir = d.tool('mkdir'), cp = d.tool('cp'), chmod = d.tool('chmod'), systemctl = d.tool('systemctl');
    const semanage = d.sbinTool('semanage'), restorecon = d.sbinTool('restorecon');

    await d.run([mkdir, '-p', STAGED_SYSTEM_DIR]);
    await d.run([mkdir, '-p', SYSTEM_STATE_DIR]);
    await d.run([cp, d.appImageSource, STAGED_BIN]);
    await d.run([chmod, '0755', STAGED_BIN]);
    await d.run([mkdir, '-p', STAGED_SYSTEM_DEPS_DIR]);
    await d.run([cp, '-a', `${d.depsSource}/.`, `${STAGED_SYSTEM_DEPS_DIR}/`]);

    await d.run([semanage, 'fcontext', '-a', '-t', 'bin_t', FCONTEXT_SPEC]);
    await d.run([restorecon, '-R', STAGED_SYSTEM_DIR]);
    await d.run([restorecon, '-R', SYSTEM_STATE_DIR]);

    const seed = buildSystemSeedConfig(opts.port);
    d.writeFile(`${SYSTEM_STATE_DIR}/config.json`, JSON.stringify(seed, null, 2) + '\n', { mode: 0o644 });
    const envVars = { ...buildServiceUnitEnv('linux', 'system', STAGED_SYSTEM_DEPS_DIR), WS_SCRCPY_WEB_PORT: String(opts.port) };
    const unit = renderUnitFile({
        name: WS_SCRCPY_SERVICE_NAME, description: WS_SCRCPY_SERVICE_DESCRIPTION,
        binPath: STAGED_BIN, startupDir: STAGED_SYSTEM_DIR, maxRestartAttempts: 10,
        envVars, logPath: `${SYSTEM_STATE_DIR}/logs/service.log`,
    } as unknown as Parameters<typeof renderUnitFile>[0], 'system');
    d.writeFile(UNIT_PATH, unit, { mode: 0o644 });
    await d.run([systemctl, 'daemon-reload']);
    await d.run([systemctl, 'enable', '--now', `${WS_SCRCPY_SERVICE_NAME}.service`]);
    log.info('system service installed + enabled');
}

export async function uninstallSystemService(opts: { keepState: boolean }, d: CoreDeps & { removeFile: (p: string) => void }): Promise<void> {
    assertRoot(d.getuid);
    const systemctl = d.tool('systemctl'), rm = d.tool('rm'), semanage = d.sbinTool('semanage'), restorecon = d.sbinTool('restorecon');
    await d.run([systemctl, 'disable', '--now', `${WS_SCRCPY_SERVICE_NAME}.service`]).catch(() => undefined);
    d.removeFile(UNIT_PATH);
    await d.run([systemctl, 'daemon-reload']);
    await d.run([semanage, 'fcontext', '-d', FCONTEXT_SPEC]).catch(() => undefined);
    await d.run([restorecon, '-R', STAGED_SYSTEM_DIR]).catch(() => undefined);
    await d.run([rm, '-rf', STAGED_SYSTEM_DIR]);
    if (opts.keepState) {
        for (const sub of ['dependencies', 'bin', 'control']) await d.run([rm, '-rf', `${SYSTEM_STATE_DIR}/${sub}`]);
    } else {
        await d.run([rm, '-rf', SYSTEM_STATE_DIR]);
    }
    log.info(`system service uninstalled (keepState=${opts.keepState})`);
}

export async function systemServiceStatus(d: CoreDeps & { existsCheck: (p: string) => boolean }): Promise<{ installed: boolean; active: boolean }> {
    const installed = d.existsCheck(UNIT_PATH);
    if (!installed) return { installed: false, active: false };
    const r = await d.run([d.tool('systemctl'), 'is-active', `${WS_SCRCPY_SERVICE_NAME}.service`]).catch(() => ({ code: 1, stdout: '', stderr: '' } as CommandResult));
    return { installed: true, active: r.stdout.trim() === 'active' };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export type ParsedSystemServiceArgs =
    | { op: 'install'; port: number | undefined }
    | { op: 'uninstall'; keepState: boolean }
    | { op: 'status' };

export function parseSystemServiceArgs(argv: string[]): ParsedSystemServiceArgs | null {
    if (argv.includes('--install-system-service')) {
        const portIdx = argv.indexOf('--port');
        const portStr = portIdx !== -1 ? argv[portIdx + 1] : undefined;
        const port = portStr !== undefined ? parseInt(portStr, 10) : undefined;
        return { op: 'install', port };
    }
    if (argv.includes('--uninstall-system-service')) {
        return { op: 'uninstall', keepState: argv.includes('--keep-state') };
    }
    if (argv.includes('--system-service-status')) {
        return { op: 'status' };
    }
    return null;
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

type CliDeps = CoreDeps & {
    removeFile: (p: string) => void;
    existsCheck: (p: string) => boolean;
    defaultPort: () => number;
    log: (s: string) => void;
};

export async function runSystemServiceCli(parsed: ParsedSystemServiceArgs, deps: CliDeps): Promise<number> {
    try {
        switch (parsed.op) {
            case 'install': {
                const port = parsed.port ?? deps.defaultPort();
                await installSystemService({ port }, deps);
                return 0;
            }
            case 'uninstall': {
                await uninstallSystemService({ keepState: parsed.keepState }, deps);
                return 0;
            }
            case 'status': {
                const s = await systemServiceStatus(deps);
                deps.log(JSON.stringify(s));
                return 0;
            }
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log(msg);
        return 1;
    }
}

// ---------------------------------------------------------------------------
// Production deps factory
// ---------------------------------------------------------------------------

/**
 * Wire the real OS dependencies for use at runtime (as opposed to test stubs).
 * The CommandRunner receives fully-resolved absolute paths from `tool`/`sbinTool`
 * (resolveSystemTool returns /usr/bin/<t> or bare name as last-resort fallback),
 * so no system-PATH resolution occurs in the runner itself. execFile is invoked
 * with NO timeout option — deliberately: long-running ops (cp -a of a large
 * deps tree, daemon-reload) must not be killed mid-flight.
 */
export function makeProductionCoreDeps(): CliDeps {
    const run: CommandRunner = (argv) => new Promise((resolve) => {
        execFile(argv[0]!, argv.slice(1), { encoding: 'utf8' }, (err, stdout, stderr) => {
            const e = err as (NodeJS.ErrnoException & { status?: number }) | null;
            const code = e ? (typeof e.code === 'number' ? e.code : (e.status ?? 1)) : 0;
            resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
        });
    });
    return {
        getuid: () => process.getuid?.() ?? 0,
        run,
        writeFile: (p, content, opts) => fs.writeFileSync(p, content, opts),
        removeFile: (p) => { try { fs.unlinkSync(p); } catch { /* already gone */ } },
        existsCheck: (p) => fs.existsSync(p),
        appImageSource: process.env['APPIMAGE'] ?? process.execPath,
        depsSource: Config.getInstance().dependenciesPath,
        tool: (t) => resolveSystemTool(t),
        sbinTool: (t) => resolveSystemTool(t),
        defaultPort: () => Config.getInstance().getAppConfig().webPort,
        log: (s) => { process.stdout.write(s + '\n'); },
    };
}

