// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';

export type FetchFn = typeof fetch;

/**
 * Download `url` to `destPath`. Buffers the body then writes (artifacts are
 * ~60 MB — acceptable transient memory; keeps the write a single file op).
 * Throws on a non-2xx response or network error.
 */
export async function downloadToFile(url: string, destPath: string, fetchFn: FetchFn = fetch): Promise<void> {
    const res = await fetchFn(url);
    if (!res.ok) {
        throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(destPath, buf);
}

/** Fetch `url` and return the body as text. Throws on a non-2xx response. */
export async function fetchText(url: string, fetchFn: FetchFn = fetch): Promise<string> {
    const res = await fetchFn(url);
    if (!res.ok) {
        throw new Error(`fetch failed: ${res.status} ${res.statusText} for ${url}`);
    }
    return res.text();
}
