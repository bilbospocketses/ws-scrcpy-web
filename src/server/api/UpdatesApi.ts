// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import type { UpdateChannel } from '../../common/ConfigEvents';
import { VALID_CHANNELS } from '../../common/ConfigEvents';
import type {
    UpdatesApplyResponse,
    UpdatesConfigPatchRequest,
    UpdatesErrorResponse,
    UpdatesStatusResponse,
} from '../../common/UpdateEvents';
import { Config } from '../Config';
import { Logger } from '../Logger';
import type { UpdateService } from '../UpdateService';
import { isLibfuse2Installed, ensureLibfuse2 } from '../service/SystemdClient';
import { readJsonBody } from './utils';

const log = Logger.for('UpdatesApi');

const APPLY_EXIT_DELAY_MS = 100;

/**
 * HTTP API for SP3 P5 update flow.
 *
 *   GET    /api/updates/status -> UpdatesStatusResponse (always 200)
 *   POST   /api/updates/check  -> UpdatesStatusResponse (200) or 503 in dev mode
 *   POST   /api/updates/apply  -> { ok: true } (200) or 409/503; server exits ~100ms later
 *   PATCH  /api/updates/config -> UpdatesStatusResponse (200) or 400 on bad input
 *
 * All velopack interaction is delegated to {@link UpdateService}. The API
 * layer is purely transport: parse, validate, dispatch, format. Test-friendly
 * via DI on the schedule/exit hooks for the deferred apply exit.
 */
export class UpdatesApi {
    constructor(
        private readonly svc: UpdateService,
        /** Override hooks for unit tests. Production callers omit both args. */
        private readonly schedule: (cb: () => void, ms: number) => unknown = setTimeout,
        private readonly exit: (code: number) => void = (code: number) => process.exit(code),
    ) {}

    public async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/updates/')) return false;

        res.setHeader('Content-Type', 'application/json');

        try {
            if (req.method === 'GET' && url === '/api/updates/status') {
                return this.handleStatus(res);
            }
            if (req.method === 'POST' && url === '/api/updates/check') {
                return await this.handleCheck(res);
            }
            if (req.method === 'POST' && url === '/api/updates/apply') {
                return await this.handleApply(res);
            }
            if (req.method === 'PATCH' && url === '/api/updates/config') {
                return await this.handleConfig(req, res);
            }
            if (req.method === 'POST' && url === '/api/updates/install-libfuse2') {
                return await this.handleInstallLibfuse2(res);
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err) {
            log.error(`${req.method} ${req.url} threw: ${(err as Error)?.message ?? String(err)}`);
            res.writeHead(500);
            res.end(JSON.stringify({ error: (err as Error).message }));
            return true;
        }
    }

    /**
     * Compose the full UpdatesStatusResponse: backend service state +
     * config.json mirror (for UI convenience so the frontend doesn't need
     * to fetch /api/config separately).
     */
    private buildStatusResponse(): UpdatesStatusResponse {
        const cfg = Config.getInstance().getAppConfig();
        const s = this.svc.getStatus();
        const out: UpdatesStatusResponse = {
            isInstalled: s.isInstalled,
            currentVersion: s.currentVersion,
            status: s.status,
            autoUpdate: cfg.autoUpdate,
            channel: cfg.channel,
            githubOwner: cfg.githubOwner,
            updateCheckIntervalMinutes: cfg.updateCheckIntervalMinutes,
        };
        if (process.platform !== 'win32') {
            out.libfuse2Installed = isLibfuse2Installed();
        }
        if (s.availableVersion !== undefined) out.availableVersion = s.availableVersion;
        if (s.progress !== undefined) out.progress = s.progress;
        if (s.errorMessage !== undefined) out.errorMessage = s.errorMessage;
        if (s.lastCheckedAt) out.lastCheckedAt = s.lastCheckedAt.toISOString();
        return out;
    }

    private handleStatus(res: ServerResponse): boolean {
        res.writeHead(200);
        res.end(JSON.stringify(this.buildStatusResponse()));
        return true;
    }

    private async handleCheck(res: ServerResponse): Promise<boolean> {
        if (!this.svc.getStatus().isInstalled) {
            const body: UpdatesErrorResponse = {
                ok: false,
                error: 'dev mode — packaging features disabled',
            };
            res.writeHead(503);
            res.end(JSON.stringify(body));
            return true;
        }
        await this.svc.checkForUpdates();
        res.writeHead(200);
        res.end(JSON.stringify(this.buildStatusResponse()));
        return true;
    }

    private async handleApply(res: ServerResponse): Promise<boolean> {
        const s = this.svc.getStatus();
        if (!s.isInstalled) {
            const body: UpdatesErrorResponse = {
                ok: false,
                error: 'dev mode — packaging features disabled',
            };
            res.writeHead(503);
            res.end(JSON.stringify(body));
            return true;
        }
        if (s.status !== 'ready') {
            const body: UpdatesErrorResponse = {
                ok: false,
                error: `apply not allowed in current state: ${s.status}`,
            };
            res.writeHead(409);
            res.end(JSON.stringify(body));
            return true;
        }

        let redirectPort: number | null = null;
        try {
            const result = await this.svc.applyUpdate();
            redirectPort = result.redirectPort;
        } catch (err) {
            const body: UpdatesErrorResponse = { ok: false, error: (err as Error).message };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }

        if (redirectPort !== null) {
            const redirectUrl = `http://localhost:${redirectPort}/`;
            const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>updating</title></head>
<body><p>redirecting to update page...</p>
<script>window.location.href=${JSON.stringify(redirectUrl)};</script>
</body></html>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } else {
            const body: UpdatesApplyResponse = { ok: true };
            // Linux: tell the client to show the upgrading overlay and poll-
            // reconnect to the relaunched app. Windows uses the redirectPort
            // HTML branch above, so it never reaches here with a real install.
            if (process.platform !== 'win32') {
                body.mode = 'reconnect';
            }
            res.writeHead(200);
            res.end(JSON.stringify(body));
        }

        this.schedule(() => {
            log.info('exiting (process.exit 0) after applyUpdate');
            this.exit(0);
        }, APPLY_EXIT_DELAY_MS);
        return true;
    }

    private async handleConfig(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const raw = await readJsonBody(req);
        const validated = validatePatch(raw);
        if (!validated.ok) {
            const body: UpdatesErrorResponse = { ok: false, error: validated.error };
            res.writeHead(400);
            res.end(JSON.stringify(body));
            return true;
        }
        const patch = validated.value;

        const cfg = Config.getInstance();
        const before = cfg.getAppConfig();
        // Persist via Config; even with no fields, this is a no-op write.
        // updateAppConfig validates types again — but we've already validated,
        // so a throw here would be a bug. Wrap defensively.
        try {
            cfg.updateAppConfig(patch);
        } catch (err) {
            const body: UpdatesErrorResponse = { ok: false, error: (err as Error).message };
            res.writeHead(400);
            res.end(JSON.stringify(body));
            return true;
        }
        const after = cfg.getAppConfig();

        const channelChanged = patch.channel !== undefined && patch.channel !== before.channel;
        const ownerChanged = patch.githubOwner !== undefined && patch.githubOwner !== before.githubOwner;
        const intervalChanged =
            patch.updateCheckIntervalMinutes !== undefined &&
            patch.updateCheckIntervalMinutes !== before.updateCheckIntervalMinutes;

        if (channelChanged || ownerChanged) {
            await this.svc.reconfigure(after.channel, after.githubOwner);
        } else if (intervalChanged) {
            this.svc.restartTimer(after.updateCheckIntervalMinutes, after.autoUpdate);
        }

        res.writeHead(200);
        res.end(JSON.stringify(this.buildStatusResponse()));
        return true;
    }

    private async handleInstallLibfuse2(res: ServerResponse): Promise<boolean> {
        if (process.platform === 'win32') {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: 'libfuse2 is Linux-only' }));
            return true;
        }
        if (isLibfuse2Installed()) {
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, alreadyInstalled: true }));
            return true;
        }
        try {
            await ensureLibfuse2();
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
        return true;
    }
}

// ──────────────────────────────────────────────────────────────────────────
// PATCH body validation

type ValidationResult =
    | { ok: true; value: UpdatesConfigPatchRequest }
    | { ok: false; error: string };

function validatePatch(raw: Record<string, unknown>): ValidationResult {
    const out: UpdatesConfigPatchRequest = {};

    if ('autoUpdate' in raw) {
        if (typeof raw['autoUpdate'] !== 'boolean') {
            return { ok: false, error: 'autoUpdate must be a boolean' };
        }
        out.autoUpdate = raw['autoUpdate'];
    }

    if ('channel' in raw) {
        if (typeof raw['channel'] !== 'string' || !VALID_CHANNELS.includes(raw['channel'] as UpdateChannel)) {
            return {
                ok: false,
                error: `channel must be one of: ${VALID_CHANNELS.join(', ')}`,
            };
        }
        out.channel = raw['channel'] as UpdateChannel;
    }

    if ('githubOwner' in raw) {
        // Decision 7: any non-empty string accepted.
        if (typeof raw['githubOwner'] !== 'string' || (raw['githubOwner'] as string).length === 0) {
            return { ok: false, error: 'githubOwner must be a non-empty string' };
        }
        out.githubOwner = raw['githubOwner'] as string;
    }

    if ('updateCheckIntervalMinutes' in raw) {
        const n = raw['updateCheckIntervalMinutes'];
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 5 || n > 1440) {
            return {
                ok: false,
                error: 'updateCheckIntervalMinutes must be an integer between 5 and 1440',
            };
        }
        out.updateCheckIntervalMinutes = n;
    }

    return { ok: true, value: out };
}
