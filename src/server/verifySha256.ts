// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { createHash } from 'crypto';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { createReadStream } from 'fs';

/** Stream-hash `filePath` (sha256) and return the lowercase hex digest. */
export function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/** True iff `filePath`'s sha256 equals `expectedHex` (case-insensitive). */
export async function verifySha256(filePath: string, expectedHex: string): Promise<boolean> {
    const actual = await sha256File(filePath);
    return actual.toLowerCase() === expectedHex.toLowerCase();
}
