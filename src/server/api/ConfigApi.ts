// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import * as fs from 'node:fs';
import type { AppConfigEnvelope, AppConfigPatchResponse } from '../../common/ConfigEvents';
import { Config, ConfigValidationError } from '../Config';
import { Logger } from '../Logger';

const log = Logger.for('ConfigApi');

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

export class ConfigApi {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/config')) return false;

        res.setHeader('Content-Type', 'application/json');

        try {
            if (req.method === 'GET' && url === '/api/config') {
                const cfg = Config.getInstance();
                const envelope: AppConfigEnvelope = {
                    config: cfg.getAppConfig(),
                    runtime: cfg.getFirstRunStatus(),
                };
                res.writeHead(200);
                res.end(JSON.stringify(envelope));
                return true;
            }

            if (req.method === 'PATCH' && url === '/api/config') {
                const body = await readBody(req);
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
                try {
                    const cfg = Config.getInstance();
                    const result = cfg.updateAppConfig(parsed as Record<string, unknown>);
                    const response: AppConfigPatchResponse = {
                        config: result.config,
                        restartRequired: result.restartRequired,
                    };

                    // v0.1.8: when a port change requires a restart,
                    // build the redirect URL pointing at the new port
                    // and schedule the actual restart via the existing
                    // .restart marker + exit-75 mechanism. The
                    // launcher's supervisor will pick up the marker,
                    // restart Node, and the new server binds the new
                    // port. The browser redirects 3s after the
                    // response, by which time the new server should
                    // be listening.
                    if (result.restartRequired) {
                        response.redirectTo = `http://localhost:${result.config.webPort}`;
                        const markerPath = cfg.restartMarkerPath;
                        try {
                            fs.writeFileSync(markerPath, `restart-requested-${Date.now()}`);
                        } catch (err) {
                            log.warn(
                                `could not write .restart marker (port change won't take effect until manual restart): ${(err as Error).message}`,
                            );
                        }
                        // Schedule own exit AFTER responding. exit-75
                        // is the supervisor's restart signal. Delay
                        // long enough for the response body + headers
                        // to fully flush over the socket.
                        setTimeout(() => {
                            log.info('port change committed; exiting with 75 to trigger restart');
                            process.exit(75);
                        }, 1000).unref();
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
