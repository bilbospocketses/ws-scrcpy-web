// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import * as path from 'node:path';
import type { InstallMode } from '../../common/ConfigEvents';
import {
    WS_SCRCPY_SERVICE_DESCRIPTION,
    WS_SCRCPY_SERVICE_DISPLAY_NAME,
    WS_SCRCPY_SERVICE_NAME,
    type ServiceActionFailure,
    type ServiceActionSuccess,
    type ServiceStatusResponse,
} from '../../common/ServiceEvents';
import { Config } from '../Config';
import { detectInstallScope } from '../InstallScope';
import { Logger } from '../Logger';
import {
    getServiceClient,
    type ServiceClientFactoryResult,
} from '../service';
import type { ServiceAccount } from '../service/ServiceClient';

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
                return await this.handleInstall(res);
            }
            if (req.method === 'POST' && url === '/api/service/uninstall') {
                return await this.handleUninstall(res);
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err) {
            log.error(`${req.method} ${req.url} threw: ${(err as Error)?.message ?? String(err)}`);
            const body: ServiceActionFailure = { ok: false, error: (err as Error).message };
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

    private async handleInstall(res: ServerResponse): Promise<boolean> {
        const result = this.factory();
        if (!result.supported) {
            const body: ServiceActionFailure = {
                ok: false,
                error: result.unsupportedReason ?? 'Service mode unsupported on this platform',
            };
            res.writeHead(501);
            res.end(JSON.stringify(body));
            return true;
        }

        const cfg = Config.getInstance();
        const scope = this.scope();
        const account: ServiceAccount = scope === 'user' ? 'currentUser' : 'LocalSystem';
        const newInstallMode: InstallMode = scope === 'user' ? 'user-service' : 'system-service';

        // The service launches the same Node binary the launcher would. We
        // bind to process.execPath because Velopack rewrites it on update;
        // dev runs (where there's no install layout) go through this path
        // intentionally so the smoke test reports a useful Servy error rather
        // than silently misconfiguring.
        const binPath = process.execPath;
        const logPath = path.join(cfg.dependenciesPath, 'service.log');
        const envVars: Record<string, string> = {
            DEPS_PATH: cfg.dependenciesPath,
        };

        try {
            await result.client.install({
                name: WS_SCRCPY_SERVICE_NAME,
                displayName: WS_SCRCPY_SERVICE_DISPLAY_NAME,
                description: WS_SCRCPY_SERVICE_DESCRIPTION,
                binPath,
                account,
                startType: 'Automatic',
                maxRestartAttempts: 3,
                envVars,
                logPath,
            });
        } catch (err) {
            const body: ServiceActionFailure = { ok: false, error: (err as Error).message };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }

        // Persist the new install mode so subsequent boots / UI loads agree.
        try {
            cfg.updateAppConfig({ installMode: newInstallMode });
        } catch (err) {
            log.warn(`installMode persist failed (service install succeeded): ${(err as Error).message}`);
        }

        const status = await result.client.status(WS_SCRCPY_SERVICE_NAME);
        const body: ServiceActionSuccess = {
            ok: true,
            status,
            installMode: newInstallMode,
        };
        res.writeHead(200);
        res.end(JSON.stringify(body));
        return true;
    }

    private async handleUninstall(res: ServerResponse): Promise<boolean> {
        const result = this.factory();
        if (!result.supported) {
            const body: ServiceActionFailure = {
                ok: false,
                error: result.unsupportedReason ?? 'Service mode unsupported on this platform',
            };
            res.writeHead(501);
            res.end(JSON.stringify(body));
            return true;
        }

        // Best-effort stop before uninstall. Ignore failures (service may
        // already be stopped or not installed); uninstall itself will surface
        // a real error if the service truly can't be torn down.
        try {
            await result.client.stop(WS_SCRCPY_SERVICE_NAME);
        } catch (err) {
            log.info(`stop before uninstall returned: ${(err as Error).message}`);
        }

        try {
            await result.client.uninstall(WS_SCRCPY_SERVICE_NAME);
        } catch (err) {
            const body: ServiceActionFailure = { ok: false, error: (err as Error).message };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }

        // Revert installMode: drop the '-service' suffix.
        const cfg = Config.getInstance();
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
}
