import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadToFile, fetchText } from '../downloadToFile';

describe('downloadToFile', () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
        dirs.length = 0;
    });

    it('writes a 200 response body to disk', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
        dirs.push(dir);
        const dest = path.join(dir, 'out.bin');
        const fetchFn = (async () => new Response('payload-bytes')) as unknown as typeof fetch;
        await downloadToFile('https://example/x', dest, fetchFn);
        expect(fs.readFileSync(dest, 'utf8')).toBe('payload-bytes');
    });

    it('throws on a non-2xx response', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
        dirs.push(dir);
        const fetchFn = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
        await expect(downloadToFile('https://example/x', path.join(dir, 'o'), fetchFn)).rejects.toThrow(/404/);
    });

    it('fetchText returns the body text', async () => {
        const fetchFn = (async () => new Response('line1\nline2')) as unknown as typeof fetch;
        expect(await fetchText('https://example/s', fetchFn)).toBe('line1\nline2');
    });
});
