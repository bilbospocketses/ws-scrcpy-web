import type { IncomingMessage, ServerResponse } from 'http';
import type { AppConfigEnvelope, AppConfigPatchResponse } from '../../common/ConfigEvents';
import { getAppVersion } from '../appVersion';
import { callerIsLocal, remoteAdminForcedByEnv, requireOperator, resolveAdminScope } from '../auth/requireOperator';
import { Config, ConfigValidationError, validateWebPortInput } from '../Config';
import { Logger } from '../Logger';
import { applyUpdaterConfigChange, type UpdaterControls } from '../updaterConfigSync';
import { hostOnlyConfigKeys, refuseInContainer } from './containerGuard';
import { certificateExists, portCollisionRefusal } from './portCollision';
import { scheduleRestartForPortChange } from './restartRequest';
import { type SystemServicePortGuardDeps, systemServicePortRefusal } from './systemServicePortGuard';
import { BodyTooLargeError, readBodyCapped } from './utils';

const log = Logger.for('ConfigApi');

/**
 * The port-guard fields are test seams; production uses the real probe and
 * instance check.
 */
export interface ConfigApiOptions extends SystemServicePortGuardDeps {
    /**
     * The RUNNING update service, told about a written channel, owner or
     * interval (`applyUpdaterConfigChange`). Production hands in the same
     * `UpdateService` `UpdatesApi` gets (index.ts); tests hand in spies. Absent,
     * a write only reaches config.json and the service keeps its old values
     * until restart (6.11 follow-up).
     */
    updater?: UpdaterControls;
    /** As `SettingsBatchApiOptions.certReady`: tests inject whether a certificate exists. */
    certReady?: () => boolean;
}

export class ConfigApi {
    constructor(private readonly opts: ConfigApiOptions = {}) {}

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/config')) return false;

        res.setHeader('Content-Type', 'application/json');

        try {
            if (req.method === 'GET' && url === '/api/config') {
                const cfg = Config.getInstance();
                const envelope: AppConfigEnvelope = {
                    config: cfg.getAppConfig(),
                    runtime: {
                        ...cfg.getFirstRunStatus(),
                        adminScope: resolveAdminScope(),
                        callerIsLocal: callerIsLocal(req),
                        remoteAdminForced: remoteAdminForcedByEnv(),
                        appVersion: getAppVersion(),
                    },
                };
                res.writeHead(200);
                res.end(JSON.stringify(envelope));
                return true;
            }

            if (req.method === 'PATCH' && url === '/api/config') {
                if (!requireOperator(req, res)) return true;
                let body: string;
                try {
                    body = await readBodyCapped(req);
                } catch (err) {
                    if (err instanceof BodyTooLargeError) {
                        res.writeHead(413);
                        res.end(JSON.stringify({ error: 'Request body too large', field: '' }));
                        return true;
                    }
                    throw err;
                }
                let parsed: unknown;
                try {
                    parsed = body.length === 0 ? {} : JSON.parse(body);
                } catch (err) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: `Invalid JSON: ${(err as Error).message}`, field: '' }));
                    return true;
                }
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Body must be a JSON object', field: '' }));
                    return true;
                }
                // In a container the port, the install mode, first-run and the
                // updater settings belong to docker and the image (container
                // audit): refuse the whole write rather than apply part of it.
                const hostOnly = hostOnlyConfigKeys(Object.keys(parsed));
                if (hostOnly.length > 0 && refuseInContainer(res, `change ${hostOnly.join(', ')}`, 'docker-settings')) {
                    return true;
                }
                const cfg = Config.getInstance();
                // The Linux system service binds its port exactly: refuse a busy
                // one before anything is written (systemServicePortGuard.ts).
                const refusal = await systemServicePortRefusal(
                    (parsed as Record<string, unknown>)['webPort'],
                    cfg.servers.map((s) => s.port),
                    this.opts,
                );
                if (refusal) {
                    log.warn(`PATCH /api/config refused: ${refusal}`);
                    res.writeHead(409);
                    res.end(JSON.stringify({ error: refusal, field: 'webPort' }));
                    return true;
                }
                // The settings batch's rule, through the one helper both use: a
                // web port on the https port is refused while a certificate
                // exists (portCollision.ts). A value `updateAppConfig` would
                // refuse anyway is left to it, so its 400 still names the field.
                const webPortValue = (parsed as Record<string, unknown>)['webPort'];
                const webPortValid = validateWebPortInput(webPortValue);
                if (webPortValue !== undefined && webPortValid.ok) {
                    const collision = portCollisionRefusal(
                        webPortValid.value,
                        cfg.httpsPort,
                        this.opts.certReady ?? certificateExists,
                    );
                    if (collision) {
                        log.warn(`PATCH /api/config refused: ${collision}`);
                        res.writeHead(409);
                        res.end(JSON.stringify({ error: collision, field: 'webPort' }));
                        return true;
                    }
                }
                try {
                    const before = cfg.getAppConfig();
                    const result = cfg.updateAppConfig(parsed as Record<string, unknown>);
                    const response: AppConfigPatchResponse = {
                        config: result.config,
                        restartRequired: result.restartRequired,
                    };

                    // v0.1.8: when a port change requires a restart,
                    // name the new port and schedule the actual restart
                    // via the existing .restart marker + exit-75
                    // mechanism. The launcher's supervisor will pick up
                    // the marker, restart Node, and the new server binds
                    // the new port. The browser navigates to that port on
                    // its OWN origin a few seconds after the response, by
                    // which time the new server should be listening.
                    // (Only the port: a server-built http://localhost URL
                    // sent every off-box client to its own machine.)
                    if (result.restartRequired) {
                        response.redirectPort = result.config.webPort;
                        scheduleRestartForPortChange(cfg.restartMarkerPath, log);
                    } else if (this.opts.updater) {
                        // Tell the RUNNING update service what moved, as the
                        // Settings dialog's Save does (SettingsBatchApi). Not
                        // when the port moved: this process ends a second later
                        // and the next one's UpdateService.init() reads the new
                        // values. Not awaited: a reconfigure resolves only after
                        // its check (and on Windows with automatic updates on,
                        // its download). A container never reaches here with an
                        // updater field: the host-only refusal above answers 409.
                        applyUpdaterConfigChange(this.opts.updater, before, cfg.getAppConfig()).catch(
                            (err: unknown) => {
                                const message = err instanceof Error ? err.message : String(err);
                                log.warn(`the update service did not take the new settings: ${message}`);
                            },
                        );
                    }

                    res.writeHead(200);
                    res.end(JSON.stringify(response));
                    return true;
                } catch (err) {
                    if (err instanceof ConfigValidationError) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: err.message, field: err.field }));
                        return true;
                    }
                    throw err;
                }
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
}
