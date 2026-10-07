import { createHash } from 'crypto';
import { createReadStream } from 'fs';

/** Stream-hash `filePath` with `algorithm` and return the lowercase hex digest. */
function hashFile(filePath: string, algorithm: 'sha256' | 'sha1'): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash(algorithm);
        const stream = createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/** Stream-hash `filePath` (sha256) and return the lowercase hex digest. */
export function sha256File(filePath: string): Promise<string> {
    return hashFile(filePath, 'sha256');
}

/** True iff `filePath`'s sha256 equals `expectedHex` (case-insensitive). */
export async function verifySha256(filePath: string, expectedHex: string): Promise<boolean> {
    const actual = await sha256File(filePath);
    return actual.toLowerCase() === expectedHex.toLowerCase();
}

/**
 * True iff `filePath`'s sha1 equals `expectedHex` (case-insensitive). Only for a
 * publisher that lists nothing stronger -- Google's platform-tools index -- and
 * only alongside an exact size check; see `DependencyManager.verifyAdbArchive`.
 */
export async function verifySha1(filePath: string, expectedHex: string): Promise<boolean> {
    const actual = await hashFile(filePath, 'sha1');
    return actual.toLowerCase() === expectedHex.toLowerCase();
}
