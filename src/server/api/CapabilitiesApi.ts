// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
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
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ shell }));
        return true;
    }
}
