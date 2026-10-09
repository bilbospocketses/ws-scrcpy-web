import type { IncomingMessage, ServerResponse } from 'http';
import { type DependencyInfo, DependencyStatus } from '../../common/DependencyTypes';
import { requireOperator } from '../auth/requireOperator';
import type { DependencyManager } from '../DependencyManager';
import { refuseInContainer } from './containerGuard';

export class DependencyApi {
    constructor(private readonly manager: DependencyManager) {}

    /** Returns true if this request was handled as an API call */
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/dependencies')) return false;

        res.setHeader('Content-Type', 'application/json');

        if (!requireOperator(req, res)) return true;

        try {
            // GET /api/dependencies — list all
            if (req.method === 'GET' && url === '/api/dependencies') {
                const deps = await this.manager.getAll();
                res.writeHead(200);
                res.end(JSON.stringify(deps));
                return true;
            }

            // POST /api/dependencies/check — check all for updates. A container's
            // dependency set belongs to the image (item 135), so checking for and
            // installing updates is refused there (container audit). The GET list
            // and retry-install stay open: the first-run banner needs both.
            if (req.method === 'POST' && url === '/api/dependencies/check') {
                if (refuseInContainer(res, 'check dependencies for updates', 'pull-image')) return true;
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
                if (refuseInContainer(res, `update ${name}`, 'pull-image')) return true;
                const result = await this.manager.update(name);
                // The 503 "launcher-required" branch is gone: extraction is
                // in-process now, so no dependency is unupdatable for want of a
                // packaged binary.
                res.writeHead(result.success ? 200 : 500);
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
                // An install-on-first-use dependency (`deferInstall`, mkcert) is
                // not part of the first-run bootstrap this route retries:
                // autoInstallMissing never downloads it, and the first-run
                // banner, this route's caller, leaves it out of what it calls
                // incomplete (FirstRunBanner.pendingDeps). Not being installed
                // is its normal state, so it is not "still missing" -- counting
                // it made every host without mkcert answer success:false. Its
                // own install, and that install's failure, belong to the
                // Dependencies panel's install button (performUpdate). A check
                // run here that leaves it in Error still lands in `errors`
                // below, like any other dependency's.
                const notYetNeeded = (info: DependencyInfo): boolean =>
                    info.deferInstall === true && info.installedVersion === null;
                for (const info of await this.manager.getAll()) {
                    const prev = before.get(info.name);
                    if (prev?.installedVersion === null && info.installedVersion !== null) {
                        installed.push(info.name);
                    }
                    if (info.installedVersion === null && !notYetNeeded(info)) {
                        stillMissing.push(info.name);
                    }
                    if (info.status === DependencyStatus.Error && info.errorMessage) {
                        errors[info.name] = info.errorMessage;
                    }
                }
                // A dependency whose latest version is unknown is skipped by
                // autoInstallMissing rather than installed — deliberately, so an
                // offline first run does not thrash. But the skip left no trace:
                // the reply came back {success:false, stillMissing:['adb'],
                // errors:{}}, which reads as "the retry failed" with nothing to
                // say why, for a dependency that was never attempted and which
                // the banner's own poll then installed seconds later once the
                // version check succeeded. Say what actually happened
                // (finding 9.7).
                for (const info of await this.manager.getAll()) {
                    if (
                        info.installedVersion === null &&
                        info.latestVersion === null &&
                        !notYetNeeded(info) &&
                        !errors[info.name]
                    ) {
                        errors[info.name] =
                            'latest version unknown, so no install was attempted — check network access and retry';
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
