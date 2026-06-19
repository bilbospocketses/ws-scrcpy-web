import type { IncomingMessage, ServerResponse } from 'http';
import { getNodePty } from '../NodePtyResolver';

export class CapabilitiesApi {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (url !== '/api/capabilities') return false;

        if (req.method !== 'GET') {
            res.writeHead(405);
            res.end(JSON.stringify({ error: 'method not allowed' }));
            return true;
        }

        const handle = getNodePty();
        const shell = handle?.available === true;
        // v0.1.8: surface the reason when shell is unavailable so the
        // frontend can show an actionable error (download failed,
        // missing prebuilt for this Node ABI, native module load
        // failure, etc.) instead of just hiding the shell modal
        // silently.
        const shellReason = handle?.available === false ? handle.reason : undefined;
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ shell, ...(shellReason ? { shellReason } : {}) }));
        return true;
    }
}
