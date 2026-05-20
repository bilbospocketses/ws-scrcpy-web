// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
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
import { discoverServicePort } from '../service/discoverServicePort';
import { resolveLauncherPath as resolveLauncherPathForElevation } from '../service/elevatedRunner';
import { consumeToken, issueToken } from '../service/resumeToken';
import { writeUninstallHandoffMarker } from '../util/control-marker';
import { resolveActiveSessionId } from '../util/active-session';
import { ServiceInstallError } from '../service/ServyClient';
import {
    getServiceClient,
    type ServiceClientFactoryResult,
} from '../service';
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
        // v0.1.8: injection points for the install + uninstall handoff
        // helpers. Tests stub these to short-circuit slow real network
        // probing and elevation. Production callers omit and the API
        // uses the real implementations.
        private readonly discover: (
            opts: { ownPid: number; startPort: number; range: number; timeoutMs: number },
        ) => Promise<string | null> = discoverServicePort,
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
        const body: ServiceStatusResponse = {
            supported: true,
            platform: result.platform,
            status,
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
        //     when absent. If the caller asked for system scope but we're not
        //     root, return 403 BEFORE invoking the client — SystemdClient also
        //     guards this, but doing it at the API boundary lets us return a
        //     clean HTTP error code.
        let scope: 'user' | 'system';
        if (result.platform === 'linux') {
            const body = await readJsonBody(req);
            const requested = (body as ServiceInstallRequest).scope;
            scope = requested === 'system' ? 'system' : 'user';

            if (scope === 'system' && process.getuid?.() !== 0) {
                const failure: ServiceActionFailure = {
                    ok: false,
                    error:
                        'system scope requires root. Relaunch the AppImage with sudo, ' +
                        'or pick user scope.',
                    reason: 'unknown',
                };
                res.writeHead(403);
                res.end(JSON.stringify(failure));
                return true;
            }
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
            // Linux: SystemdClient takes the launcher binary directly via
            // process.execPath (the AppImage entrypoint). Working directory
            // is the launcher's parent dir.
            binPath = process.execPath;
            startupDir = path.dirname(process.execPath);
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

        // v0.1.8 install-flow auto-redirect (Windows only — Linux
        // SystemdClient already runs the service in the user session,
        // no port-shift, no handoff needed). Discover the new
        // service-instance's port by polling localhost:8000..8099 for
        // the /api/whoami endpoint that returns a pid != ours.
        let redirectTo: string | undefined;
        if (result.platform === 'win32') {
            try {
                const ownPort = cfg.servers[0]?.port ?? 8000;
                const found = await this.discover({
                    ownPid: process.pid,
                    startPort: ownPort,
                    range: 100,
                    timeoutMs: 30_000,
                });
                if (found) {
                    redirectTo = found;
                    // Schedule our own shutdown shortly after the
                    // response goes out. The user's browser will have
                    // navigated to `redirectTo` by then; killing this
                    // local instance avoids two app instances + two
                    // tray icons. 5s is enough for the 200 response to
                    // flush and the browser to load the new port.
                    setTimeout(() => {
                        log.info('install-flow handoff complete; local instance exiting');
                        process.exit(0);
                    }, 5000).unref();
                }
            } catch (err) {
                log.warn(`port-discovery for redirectTo failed: ${(err as Error).message}`);
            }
        }

        const body: ServiceActionSuccess = {
            ok: true,
            status,
            installMode: newInstallMode,
            ...(redirectTo ? { redirectTo } : {}),
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
            // No resume token → could be a direct click from the
            // local UI, OR could be a click from the service UI that
            // hasn't been redirected yet. Detect the service-context
            // case and do the handoff.
            const installMode = cfg.getAppConfig().installMode;
            const runningAsService = installMode === 'user-service' || installMode === 'system-service';
            const isWindows = result.platform === 'win32';

            if (isWindows && runningAsService && this.isLikelyLocalSystem()) {
                const handoff = await this.handoffUninstallToUserSession(cfg.dependenciesPath, res);
                if (handoff) return true;
                // Handoff failed AND we're running as LocalSystem. We CANNOT fall
                // through to direct runElevated() here — PowerShell Start-Process
                // -Verb RunAs from LocalSystem has no interactive desktop to show
                // the UAC prompt on, so it silently fails. Return a clear error
                // and let the user retry (per spec
                // docs/superpowers/specs/2026-04-30-service-mode-admin-uac-ux-design.md).
                const body: ServiceActionFailure = {
                    ok: false,
                    error: "Couldn't reach the user session to relay the uninstall request. Make sure ws-scrcpy-web is running for your user, then try again.",
                    reason: 'handoff-timeout',
                };
                res.writeHead(503);
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

    /**
     * Theory D handoff: write a control marker that the user-session
     * tray helper polls; the helper spawns the local launcher in its
     * own session natively (no cross-session WTS APIs). Then poll for
     * the new launcher's port, issue a resume token, and return the
     * redirect response. Returns `true` if the handoff succeeded and
     * the response was sent; `false` if any step failed (caller falls
     * back to direct uninstall).
     */
    private async handoffUninstallToUserSession(
        installRoot: string,
        res: ServerResponse,
    ): Promise<boolean> {
        const launcherPath = resolveLauncherPathForElevation();
        // Theory D: write a control marker that the user-session tray helper
        // polls — replaces the WTS cross-session spawn that was failing with
        // ERROR_ACCESS_DENIED in v0.1.24-beta.{1,2,3}.
        const sessionResult = await resolveActiveSessionId(launcherPath);
        const targetSessionId = sessionResult.ok ? sessionResult.sessionId : null;
        if (!sessionResult.ok) {
            log.warn(`uninstall handoff: could not resolve active session, marker will accept any tray helper: ${sessionResult.errorMessage}`);
        }
        // dataRoot is the parent of the dependenciesPath that was passed in as
        // installRoot (same derivation as the logsDir path in handleInstall).
        const dataRoot = path.dirname(installRoot);
        // --local-takeover is load-bearing: it forces the spawned launcher to
        // override its is_service_mode decision and start the local-mode tray.
        // config.json still reads installMode='user-service' at spawn time;
        // only after the resume-flow uninstall completes does it flip to 'user'.
        // Without this flag the new launcher would boot tray-less and the user
        // would be stranded post-uninstall.
        const writeResult = await writeUninstallHandoffMarker(dataRoot, {
            targetSessionId,
            launcherPath,
            launcherArgs: ['--local-takeover'],
        });
        if (!writeResult.ok) {
            log.warn(`uninstall handoff: marker write failed: ${writeResult.errorMessage}`);
            return false;
        }
        log.info(`uninstall handoff: marker written (targetSessionId=${targetSessionId ?? 'any'})`);

        // Poll for the new launcher's port. Ports start at 8000; the
        // service is on whichever port we currently bind. The new
        // local launcher will auto-shift to a free one.
        const found = await this.discover({
            ownPid: process.pid,
            startPort: 8000,
            range: 100,
            timeoutMs: 30_000,
        });
        if (!found) {
            log.warn('uninstall handoff: new local launcher did not become reachable within 30s');
            return false;
        }

        const token = issueToken(installRoot, 'uninstall-service');
        const redirectTo = `${found}/?resume=uninstall-service&token=${encodeURIComponent(token)}`;

        const body: ServiceActionSuccess = {
            ok: true,
            // Service is still running at this point — the local
            // launcher will do the actual uninstall.
            status: 'running',
            installMode: 'user-service',
            redirectTo,
            resumeToken: token,
        };
        res.writeHead(200);
        res.end(JSON.stringify(body));
        return true;
    }
}
