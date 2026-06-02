// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import { spawn } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InstallMode } from '../../common/ConfigEvents';
import {
    WS_SCRCPY_SERVICE_DESCRIPTION,
    WS_SCRCPY_SERVICE_DISPLAY_NAME,
    WS_SCRCPY_SERVICE_NAME,
    type ServiceActionFailure,
    type ServiceActionSuccess,
    type ServiceInstallRequest,
    type ServiceStatusResponse,
} from '../../common/ServiceEvents';
import { Config } from '../Config';
import { detectInstallScope } from '../InstallScope';
import { Logger } from '../Logger';
import { consumeToken } from '../service/resumeToken';
import { ServiceInstallError } from '../service/ServyClient';
import {
    getServiceClient,
    type ServiceClientFactoryResult,
} from '../service';
import { resolveSystemTool } from '../service/systemTools';
import { readJsonBody } from './utils';

const log = Logger.for('ServiceApi');

/**
 * HTTP API for SP3 P3 service-mode operations.
 *
 *   GET  /api/service/status     -> ServiceStatusResponse (always 200)
 *   POST /api/service/install    -> ServiceActionSuccess | 501/500 ServiceActionFailure
 *   POST /api/service/uninstall  -> ServiceActionSuccess | 501/500 ServiceActionFailure
 *
 * All non-error responses use HTTP 200; "service mode unsupported on this
 * platform" is communicated through the body's `supported`/`ok` flag, not the
 * status code, because it's a normal first-class state for non-Windows hosts.
 *
 * `ServiceApi` is wired as an `addApiHandler` consumer in src/server/index.ts
 * alongside the P2 ConfigApi.
 */
export class ServiceApi {
    /**
     * Optional override of the factory and install-scope detector — wired in
     * for unit tests so we don't need to vi.mock the entire service module.
     * Production callers omit both args and the API uses the real factory +
     * `detectInstallScope()`.
     */
    constructor(
        private readonly factory: () => ServiceClientFactoryResult = () => getServiceClient(),
        private readonly scope: () => 'user' | 'system' = () => detectInstallScope(),
        private readonly existsCheck: (p: string) => boolean = (p: string) => fs.existsSync(p),
        private readonly spawnDetached: (cmd: string, args: string[]) => void = (cmd, args) => {
            const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
            child.on('error', (err) => log.warn(`spawnDetached ${cmd} error: ${err.message}`));
            child.unref();
        },
    ) {}

    public async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/service/')) return false;

        res.setHeader('Content-Type', 'application/json');

        try {
            if (req.method === 'GET' && url === '/api/service/status') {
                return await this.handleStatus(res);
            }
            if (req.method === 'POST' && url === '/api/service/install') {
                return await this.handleInstall(req, res);
            }
            if (req.method === 'POST' && url === '/api/service/uninstall') {
                return await this.handleUninstall(req, res);
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err) {
            log.error(`${req.method} ${req.url} threw: ${(err as Error)?.message ?? String(err)}`);
            const body: ServiceActionFailure = { ok: false, error: (err as Error).message, reason: 'unknown' };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }
    }

    /**
     * Read config.json from disk and return the current webPort + file mtime.
     * Returns null fields on any read/parse/stat failure (caller treats as "not ready").
     */
    private readDiskConfig(): { diskWebPort: number | null; configMtime: number | null } {
        try {
            const cfgPath = Config.getInstance().getConfigFilePath();
            const stat = fs.statSync(cfgPath);
            const raw = fs.readFileSync(cfgPath, 'utf-8');
            const parsed = JSON.parse(raw) as { webPort?: unknown };
            const port = typeof parsed.webPort === 'number' ? parsed.webPort : null;
            return { diskWebPort: port, configMtime: stat.mtimeMs };
        } catch {
            return { diskWebPort: null, configMtime: null };
        }
    }

    private async handleStatus(res: ServerResponse): Promise<boolean> {
        const result = this.factory();
        if (!result.supported) {
            const body: ServiceStatusResponse = {
                supported: false,
                platform: result.platform,
                unsupportedReason: result.unsupportedReason,
            };
            res.writeHead(200);
            res.end(JSON.stringify(body));
            return true;
        }
        const status = await result.client.status(WS_SCRCPY_SERVICE_NAME);
        const disk = this.readDiskConfig();
        const installMode = Config.getInstance().getAppConfig().installMode;
        // Authoritative installed scope from the filesystem (which systemd unit
        // exists), independent of the mutable installMode. Only SystemdClient
        // implements getInstalledScope; Windows omits it (scope auto-detected
        // from execPath there, and the scope radios are Linux-only in the UI).
        const scope = result.client.getInstalledScope
            ? await result.client.getInstalledScope(WS_SCRCPY_SERVICE_NAME)
            : undefined;
        const body: ServiceStatusResponse = {
            supported: true,
            platform: result.platform,
            status,
            installMode,
            ...(scope !== undefined ? { scope } : {}),
            ...(disk.diskWebPort != null ? { diskWebPort: disk.diskWebPort } : {}),
            ...(disk.configMtime != null ? { configMtime: disk.configMtime } : {}),
        };
        res.writeHead(200);
        res.end(JSON.stringify(body));
        return true;
    }

    private async handleInstall(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const result = this.factory();
        if (!result.supported) {
            const body: ServiceActionFailure = {
                ok: false,
                error: result.unsupportedReason ?? 'Service mode unsupported on this platform',
                reason: 'unsupported',
            };
            res.writeHead(501);
            res.end(JSON.stringify(body));
            return true;
        }

        const cfg = Config.getInstance();

        // Scope resolution differs by platform:
        //   - Windows: ignore the request body, use the injected scope detector
        //     (auto-detects from execPath via detectInstallScope()).
        //   - Linux:   read `scope` from the request body, default to 'user'
        //     when absent. System-scope install from a non-root process is
        //     elevated inside SystemdClient.install() via pkexec (PR #211);
        //     the API stays unelevated and just forwards the requested scope.
        //     A pre-#211 API-boundary 403 guard short-circuited the pkexec
        //     path and was removed — the user saw "Relaunch the AppImage with
        //     sudo" instead of a password prompt.
        let scope: 'user' | 'system';
        if (result.platform === 'linux') {
            const body = await readJsonBody(req);
            const requested = (body as ServiceInstallRequest).scope;
            scope = requested === 'system' ? 'system' : 'user';
        } else {
            scope = this.scope();
        }

        // Windows ServyClient ignores scope and always installs as Local System
        // (no `--user` flag). Linux SystemdClient consumes scope to decide
        // user-systemd vs system-systemd unit placement.
        const newInstallMode: InstallMode = scope === 'user' ? 'user-service' : 'system-service';

        // v0.1.7: the v0.1.6 admin-elevation guard at this boundary is
        // gone. ServyClient's install() now invokes a separate elevated
        // helper process (via PowerShell Start-Process -Verb RunAs); the
        // UAC prompt happens at that elevation step, not here. This API
        // remains unelevated.
        //
        // Resolve the service binary. On Windows we point Servy at the
        // packaged launcher, NOT process.execPath. process.execPath is the
        // currently-running Node binary, which (a) in dev resolves to
        // whatever Node is on PATH (same architectural failure as the
        // v0.1.4 bare-'adb' bug), and (b) even when bundled, Servy would
        // launch Node with no script argument and Node would idle in REPL
        // mode. The launcher is a local-deps binary in the install root,
        // takes no args, and already knows how to supervise Node +
        // dist/index.js — exactly what we want SCM to invoke.
        //
        // startupDir pins the SCM-launched child's CWD to the install
        // root so the launcher's relative seed/, dependencies/, dist/
        // resolution works. Without it, Servy falls back to the dir of
        // the executable and the launcher's path resolution silently
        // breaks (root of the v0.1.5 "service runs but app unreachable"
        // bug — Servy log showed "Working directory fallback applied:
        // C:\nvm4w\nodejs").
        let binPath: string;
        let startupDir: string;
        if (result.platform === 'win32') {
            const installRoot = process.cwd();
            const launcherExe = path.join(installRoot, 'ws-scrcpy-web-launcher.exe');
            if (!this.existsCheck(launcherExe)) {
                const failure: ServiceActionFailure = {
                    ok: false,
                    error:
                        `service mode requires the packaged launcher binary at ${launcherExe}, ` +
                        `which is not present (likely a dev/from-source run rather than a Velopack install). ` +
                        `Install ws-scrcpy-web via the MSI and retry.`,
                    reason: 'unknown',
                };
                res.writeHead(500);
                res.end(JSON.stringify(failure));
                return true;
            }
            binPath = launcherExe;
            startupDir = installRoot;
        } else {
            // Linux: the systemd unit must point at a STABLE entry that
            // launches the WHOLE app. The server runs as a Node CHILD of the
            // launcher (launcher/src/spawn.rs spawns `node dist/index.js`), so
            // process.execPath here is the Node binary — using it as ExecStart
            // would start Node with no script (REPL; under systemd's /dev/null
            // stdin it reads EOF and exits immediately), the exact failure the
            // win32 branch above warns about. The service would never bind or
            // auto-shift a web port, the install-flow redirect poll would never
            // see a config change, and status would read "stopped".
            //
            // For an AppImage the stable entry is the .AppImage file itself,
            // exposed by the runtime as $APPIMAGE (the same env UpdateService
            // keys production-mode detection off). Running it re-mounts and runs
            // the launcher, which spawns the server and binds the web port,
            // auto-shifting +1 on collision (PortPicker / reconcileWebPort) and
            // persisting the new port to config.json — which is what the
            // frontend's post-install poll watches. Fall back to
            // process.execPath for non-AppImage / from-source runs where
            // $APPIMAGE is unset.
            const appImagePath = process.env['APPIMAGE'];
            binPath = appImagePath && appImagePath.length > 0 ? appImagePath : process.execPath;
            startupDir = path.dirname(binPath);
        }

        // Record the home AppImage path so a later USER-scope uninstall can
        // relaunch the app in local mode. System scope runs the /opt copy and
        // won't know the user's home AppImage otherwise. Best-effort: a failed
        // marker write logs + continues (it only degrades the post-uninstall
        // relaunch, not the install).
        if (result.platform === 'linux') {
            const appImage = process.env['APPIMAGE'];
            if (appImage && appImage.length > 0) {
                const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
                const markerPath = path.join(dataRoot, 'control', 'local-appimage');
                try {
                    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
                    fs.writeFileSync(markerPath, appImage, 'utf8');
                } catch (err) {
                    log.warn(`could not write local-appimage marker: ${(err as Error).message}`);
                }
            }
        }

        // v0.1.24-beta.7: service.log moves under <dataRoot>/logs/ to
        // colocate with launcher.log + server.log + ws-scrcpy-web.log.
        // Pre-beta.7 it lived at <dataRoot>/dependencies/service.log,
        // which was unintuitive (Servy's stdio capture isn't a
        // dependency artifact). dataRoot derives from dependenciesPath
        // since the launcher always sets DEPS_PATH=<dataRoot>/dependencies/.
        const logsDir = path.join(path.dirname(cfg.dependenciesPath), 'logs');
        try {
            fs.mkdirSync(logsDir, { recursive: true });
        } catch {
            // Servy will fail with a clearer error than we can synthesize
            // if the directory truly can't be created.
        }
        const logPath = path.join(logsDir, 'service.log');
        const envVars: Record<string, string> = {
            DEPS_PATH: cfg.dependenciesPath,
        };

        // Persist installMode to disk BEFORE invoking the install. The
        // service-instance's Node process loads Config from config.json
        // synchronously at startup; if we write installMode AFTER Servy
        // has already started the service, there's a race where the
        // service-Node loads the OLD installMode, and the redirect-target
        // page sees `installMode: 'user'` and renders WelcomeModal instead
        // of ServiceFirstRunModal. Writing first closes that race.
        //
        // Hard-fail: if we can't persist the mode, abort before installing
        // — we'd otherwise have a real service running while the UI thinks
        // we're in user mode, which is worse than a clean 500.
        const previousMode = cfg.getAppConfig().installMode;
        try {
            cfg.updateAppConfig({ installMode: newInstallMode });
        } catch (err) {
            const body: ServiceActionFailure = {
                ok: false,
                error: `could not persist installMode before install: ${(err as Error).message}`,
                reason: 'unknown',
            };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }

        try {
            await result.client.install({
                name: WS_SCRCPY_SERVICE_NAME,
                displayName: WS_SCRCPY_SERVICE_DISPLAY_NAME,
                description: WS_SCRCPY_SERVICE_DESCRIPTION,
                binPath,
                startupDir,
                startType: 'Automatic',
                maxRestartAttempts: 3,
                envVars,
                logPath,
                // §32 Part 4: pass dataRoot so the elevated installer can write
                // <dataRoot>/post-stop/post-stop.bat and register it as Servy's
                // --postStopPath via cmd.exe (Velopack-untouchable location).
                // Linux SystemdClient ignores this field.
                dataRoot: Config.getInstance().dataRoot ?? undefined,
                // Linux SystemdClient consumes scope; Windows ServyClient ignores it.
                scope,
            });
        } catch (err) {
            // Install failed — revert installMode so the next page load
            // doesn't see a phantom service-mode config without an actual
            // service. Best-effort; if the revert itself fails we log and
            // surface the original install error.
            try {
                cfg.updateAppConfig({ installMode: previousMode ?? null });
            } catch (revertErr) {
                log.warn(
                    `installMode revert failed after install error: ${(revertErr as Error).message}`,
                );
            }
            // ServiceInstallError carries a structured result from the
            // elevated helper. UAC-declined gets its own 403 status so
            // the frontend can render a UAC-aware retry prompt; other
            // failures get 500.
            if (err instanceof ServiceInstallError && err.isUacDeclined()) {
                const body: ServiceActionFailure = { ok: false, error: err.message, reason: 'uac-declined' };
                res.writeHead(403);
                res.end(JSON.stringify(body));
                return true;
            }
            const body: ServiceActionFailure = { ok: false, error: (err as Error).message, reason: 'servy-failure' };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }

        const status = await result.client.status(WS_SCRCPY_SERVICE_NAME);
        const disk = this.readDiskConfig();

        // Schedule local-Node exit. This instance is useless once the service
        // is running. The frontend navigates to the service port once it
        // detects config.json mtime change — this timer is a safety cap, not
        // a timing mechanism.
        if (result.platform === 'win32') {
            setTimeout(() => {
                log.info('install-flow: local instance exiting (service is running)');
                process.exit(0);
            }, 15_000).unref();
        }

        const body: ServiceActionSuccess = {
            ok: true,
            status,
            installMode: newInstallMode,
            ...(disk.configMtime != null ? { configMtime: disk.configMtime } : {}),
            ...(disk.diskWebPort != null ? { diskWebPort: disk.diskWebPort } : {}),
        };
        res.writeHead(200);
        res.end(JSON.stringify(body));
        return true;
    }

    private async handleUninstall(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const result = this.factory();
        if (!result.supported) {
            const body: ServiceActionFailure = {
                ok: false,
                error: result.unsupportedReason ?? 'Service mode unsupported on this platform',
                reason: 'unsupported',
            };
            res.writeHead(501);
            res.end(JSON.stringify(body));
            return true;
        }

        const cfg = Config.getInstance();

        if (result.platform === 'linux') {
            // Item 32: do NOT run `systemctl disable --now` from here — this Node
            // process is inside the service unit's cgroup, so stopping the unit
            // would kill us mid-call (no clean teardown, no relaunch). Instead
            // hand off to an OUT-OF-CGROUP helper via systemd-run: it runs in its
            // own transient unit, survives stopping our unit, then tears down +
            // (user scope) relaunches local. Mirrors the Windows operation-server
            // handoff. We do NOT call client.uninstall() on Linux.
            const scope = result.client.getInstalledScope
                ? await result.client.getInstalledScope(WS_SCRCPY_SERVICE_NAME)
                : null;
            if (scope === null) {
                const body: ServiceActionSuccess = { ok: true, status: 'not-installed', installMode: 'user' };
                res.writeHead(200);
                res.end(JSON.stringify(body));
                return true;
            }

            // Revert installMode to local BEFORE the teardown so the relaunched
            // local instance reads local mode (mirrors the Windows revert-first ordering).
            const newMode: InstallMode = scope === 'system' ? 'system' : 'user';
            try {
                cfg.updateAppConfig({ installMode: newMode });
            } catch (err) {
                log.warn(`uninstall(linux): installMode revert failed (continuing): ${(err as Error).message}`);
            }

            const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            // Same staged out-of-mount helper UpdateService.applyUpdate uses — note the
            // `.exe` suffix is the fixed staged name even on Linux (refresh_helper_binary).
            const helper = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
            const systemdRun = resolveSystemTool('systemd-run');
            const sdArgs = [
                ...(scope === 'user' ? ['--user'] : []),
                '--collect',
                `--unit=wsscrcpy-teardown-${Date.now()}`,
                helper,
                '--linux-service-teardown', '--scope', scope, '--unit', WS_SCRCPY_SERVICE_NAME,
            ];
            this.spawnDetached(systemdRun, sdArgs);
            log.info(`uninstall(linux): spawned teardown helper via systemd-run (${scope} scope)`);

            const body: ServiceActionSuccess = { ok: true, status: 'shutting-down', installMode: newMode };
            res.writeHead(200);
            res.end(JSON.stringify(body));
            return true;
        }

        // v0.1.8: if a resume token is present in the request headers,
        // validate it before doing anything else. The token comes from
        // the service-instance handoff (frontend reads it from the
        // URL params and forwards it as `X-Resume-Token`). Valid
        // token → consume + proceed with uninstall. Invalid → 401
        // (don't proceed; the request is unauthenticated for this
        // sensitive action). Absent → normal uninstall click from a
        // local instance, no token required.
        const headerToken = req.headers?.['x-resume-token'];
        const tokenStr = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        if (typeof tokenStr === 'string' && tokenStr.length > 0) {
            const consumed = consumeToken(cfg.dependenciesPath, tokenStr, 'uninstall-service');
            if (!consumed) {
                const body: ServiceActionFailure = {
                    ok: false,
                    error: 'invalid or expired resume token',
                    reason: 'invalid-token',
                };
                res.writeHead(401);
                res.end(JSON.stringify(body));
                return true;
            }
            // Valid resume token → caller is the redirected local
            // instance from the service-context handoff. Proceed
            // directly with the uninstall (no second handoff).
        } else {
            const installMode = cfg.getAppConfig().installMode;
            const runningAsService = installMode === 'user-service' || installMode === 'system-service';
            const isWindows = result.platform === 'win32';

            if (isWindows && runningAsService && this.isLikelyLocalSystem()) {
                // Revert installMode BEFORE exiting so the freshly spawned
                // launcher (from --spawn-user-launcher in post-stop.bat)
                // reads local mode from config.json, not the stale service
                // mode. Without this, the fresh launcher enters service mode,
                // its tray supervisor tries WTSQueryUserToken (needs
                // SeTcbPrivilege), but the launcher runs as the regular user
                // → tray spawn fails forever with 0x80070522.
                let newMode: InstallMode = 'user';
                if (installMode === 'system-service') newMode = 'system';
                try {
                    cfg.updateAppConfig({ installMode: newMode });
                    log.info(`uninstall: reverted installMode ${installMode} → ${newMode}`);
                } catch (err) {
                    log.warn(`uninstall: installMode revert failed (continuing): ${(err as Error).message}`);
                }

                try {
                    await fs.promises.mkdir(path.dirname(cfg.uninstallPendingMarkerPath), { recursive: true });
                    await fs.promises.writeFile(cfg.uninstallPendingMarkerPath, '', 'utf8');
                    log.info(`uninstall: wrote uninstall-pending marker at ${cfg.uninstallPendingMarkerPath}`);
                } catch (err) {
                    log.error(`uninstall: failed to write uninstall-pending marker: ${(err as Error).message}`);
                    const body: ServiceActionFailure = {
                        ok: false,
                        error: `failed to write uninstall-pending marker: ${(err as Error).message}`,
                        reason: 'unknown',
                    };
                    res.writeHead(500);
                    res.end(JSON.stringify(body));
                    return true;
                }

                const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
                const helperPath = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
                try {
                    const child = spawn(helperPath, ['--operation-server'], {
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: true,
                        env: { ...process.env, WS_SCRCPY_DATA_ROOT: dataRoot },
                    });
                    // Absorb the async 'error' event (e.g. ENOENT when the helper
                    // isn't yet on disk) so it doesn't become an unhandled rejection.
                    child.on('error', (err) => {
                        log.warn(`uninstall: operation-server child error (bat will handle it): ${err.message}`);
                    });
                    child.unref();
                    log.info(`uninstall: spawned operation-server at ${helperPath}`);
                } catch (err) {
                    log.warn(`uninstall: failed to spawn operation-server (bat will handle it): ${(err as Error).message}`);
                }

                setTimeout(() => {
                    log.info('uninstall: scheduled exit firing (post-stop.bat takes over)');
                    process.exit(0);
                }, 5000).unref();

                const disk = this.readDiskConfig();
                const body: ServiceActionSuccess = {
                    ok: true,
                    status: 'shutting-down',
                    installMode: newMode,
                    ...(disk.configMtime != null ? { configMtime: disk.configMtime } : {}),
                };
                res.writeHead(200);
                res.end(JSON.stringify(body));
                return true;
            }
        }

        try {
            await result.client.uninstall(WS_SCRCPY_SERVICE_NAME);
        } catch (err) {
            if (err instanceof ServiceInstallError && err.isUacDeclined()) {
                const body: ServiceActionFailure = { ok: false, error: err.message, reason: 'uac-declined' };
                res.writeHead(403);
                res.end(JSON.stringify(body));
                return true;
            }
            const body: ServiceActionFailure = { ok: false, error: (err as Error).message, reason: 'servy-failure' };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }

        // Revert installMode: drop the '-service' suffix.
        const current = cfg.getAppConfig().installMode;
        let newMode: InstallMode = 'user';
        if (current === 'system-service' || current === 'system') newMode = 'system';
        try {
            cfg.updateAppConfig({ installMode: newMode });
        } catch (err) {
            log.warn(`installMode revert failed (service uninstall succeeded): ${(err as Error).message}`);
        }

        const status = await result.client.status(WS_SCRCPY_SERVICE_NAME);
        const body: ServiceActionSuccess = {
            ok: true,
            status,
            installMode: newMode,
        };
        res.writeHead(200);
        res.end(JSON.stringify(body));
        return true;
    }

    /**
     * Best-effort detection of "are we running as Local System (i.e.
     * inside the service)?". Returns true when `os.userInfo().username`
     * is `SYSTEM` (the canonical username for the LocalSystem account
     * on Windows). Returns false on any other identity, including the
     * user's own account when they're running locally.
     *
     * Not bulletproof — a user could theoretically be logged in as
     * `SYSTEM` (extremely unusual), and `os.userInfo()` can fail in
     * some edge cases. The downside of a false positive is we attempt
     * the WTS handoff and it fails, then we fall through to direct
     * uninstall. The downside of a false negative is the user's tab
     * disconnects on uninstall (the v0.1.7 behavior). Acceptable.
     */
    private isLikelyLocalSystem(): boolean {
        try {
            const info = require('node:os').userInfo() as { username: string };
            return info.username.toLowerCase() === 'system';
        } catch {
            return false;
        }
    }
}
