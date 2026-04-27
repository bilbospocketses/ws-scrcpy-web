// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage } from 'http';

/**
 * Drain `req` and parse a JSON body. Returns `{}` on empty body, parse failure,
 * or non-object payloads (arrays, primitives). Best-effort by design — callers
 * that need strict validation should layer it on top of the returned object.
 *
 * Originally lived in ServiceApi.ts (P4b); extracted here for reuse by
 * UpdatesApi (P5) and any future PATCH endpoints. Behavior preserved exactly.
 */
export function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            if (body.length === 0) {
                resolve({});
                return;
            }
            try {
                const parsed = JSON.parse(body);
                if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                    resolve(parsed as Record<string, unknown>);
                    return;
                }
            } catch {
                // fall through
            }
            resolve({});
        });
        req.on('error', () => resolve({}));
    });
}
