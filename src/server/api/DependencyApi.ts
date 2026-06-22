import type { IncomingMessage, ServerResponse } from 'http';
import { DependencyStatus } from '../../common/DependencyTypes';
import { requireAdmin } from '../auth/requireAdmin';
import type { DependencyManager } from '../DependencyManager';

export class DependencyApi {
    constructor(private readonly manager: DependencyManager) {}

    /** Returns true if this request was handled as an API call */
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/dependencies')) return false;

        res.setHeader('Content-Type', 'application/json');

        if (!requireAdmin(req, res)) return true;

        try {
            // GET /api/dependencies — list all
            if (req.method === 'GET' && url === '/api/dependencies') {
                const deps = await this.manager.getAll();
                res.writeHead(200);
                res.end(JSON.stringify(deps));
                return true;
            }

            // POST /api/dependencies/check — check all for updates
            if (req.method === 'POST' && url === '/api/dependencies/check') {
                await this.manager.checkAll();
                const deps = await this.manager.getAll();
                res.writeHead(200);
                res.end(JSON.stringify(deps));
                return true;
            }

            // POST /api/dependencies/:name/update — update specific dependency
            const updateMatch = url.match(/^\/api\/dependencies\/([a-z-]+)\/update$/);
            if (req.method === 'POST' && updateMatch) {
                const name = updateMatch[1]!;
                const result = await this.manager.update(name);
                if (result.reason === 'launcher-required') {
                    res.writeHead(503);
                } else {
                    res.writeHead(result.success ? 200 : 500);
                }
                res.end(JSON.stringify(result));
                return true;
            }

            // POST /api/dependencies/restart — restart the server
            if (req.method === 'POST' && url === '/api/dependencies/restart') {
                res.writeHead(200);
                res.end(JSON.stringify({ message: 'Restarting...' }));
                this.manager.requestRestart();
                return true;
            }

            // POST /api/dependencies/retry-install — retry first-run bootstrap
            if (req.method === 'POST' && url === '/api/dependencies/retry-install') {
                const before = new Map<string, { installedVersion: string | null }>();
                for (const info of await this.manager.getAll()) {
                    before.set(info.name, { installedVersion: info.installedVersion });
                }
                await this.manager.checkAll();
                await this.manager.autoInstallMissing();
                const installed: string[] = [];
                const stillMissing: string[] = [];
                const errors: Record<string, string> = {};
                for (const info of await this.manager.getAll()) {
                    const prev = before.get(info.name);
                    if (prev?.installedVersion === null && info.installedVersion !== null) {
                        installed.push(info.name);
                    }
                    if (info.installedVersion === null) {
                        stillMissing.push(info.name);
                    }
                    if (info.status === DependencyStatus.Error && info.errorMessage) {
                        errors[info.name] = info.errorMessage;
                    }
                }
                const success = stillMissing.length === 0 && Object.keys(errors).length === 0;
                res.writeHead(200);
                res.end(JSON.stringify({ success, installed, stillMissing, errors }));
                return true;
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err: any) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
            return true;
        }
    }
}
