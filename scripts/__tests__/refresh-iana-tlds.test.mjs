import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTldList, renderTldModule } from '../refresh-iana-tlds.mjs';

/**
 * scripts/refresh-iana-tlds.mjs: IANA's delegated-TLD list into
 * src/common/ianaTlds.ts. Offline: the parser and renderer are pure, and the
 * committed module is checked to be exactly what the renderer makes of its own
 * contents, so a hand edit to the generated file is caught.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(__dirname, '..', '..', 'src', 'common', 'ianaTlds.ts');
const HEADER = '# Version 2026100900, Last Updated Fri Oct  9 07:07:01 2026 UTC';

/** A plausible list: the header and `n` labels. */
function list(n, extra = []) {
    const labels = Array.from({ length: n }, (_, i) => `T${i}`);
    return [HEADER, ...labels, ...extra].join('\n');
}

describe('parseTldList', () => {
    it('keeps the header and lower-cases every label, CRLF or LF', () => {
        const parsed = parseTldList(`${list(1000, ['XN--P1AI', 'THEATRE']).replace(/\n/g, '\r\n')}\r\n`);
        expect(parsed.header).toBe(HEADER);
        expect(parsed.tlds).toHaveLength(1002);
        expect(parsed.tlds.slice(-2)).toEqual(['xn--p1ai', 'theatre']);
    });

    it.each([
        ['no version header', list(1000).replace(HEADER, 'AAA')],
        ['a line that is not one label', list(1000, ['CO.UK'])],
        ['a label listed twice', list(1000, ['T5'])],
        ['a truncated list', list(10)],
    ])('refuses %s', (_label, text) => {
        expect(() => parseTldList(text)).toThrow();
    });
});

describe('renderTldModule', () => {
    it('writes the header, one TLD per line, and marks a British-spelled TLD for the spelling gate', () => {
        const module = renderTldModule({ header: HEADER, tlds: ['aaa', 'theatre', 'xn--p1ai'] });
        expect(module).toContain(`export const IANA_TLDS_VERSION = '${HEADER}';`);
        expect(module).toContain("    'aaa',\n");
        expect(module).toContain("    'theatre', // spelling: allow");
        expect(module).toContain("    'xn--p1ai',\n");
    });

    it('the committed src/common/ianaTlds.ts is exactly what it renders', () => {
        const committed = fs.readFileSync(MODULE, 'utf8').replace(/\r\n/g, '\n');
        const header = /export const IANA_TLDS_VERSION = '([^']+)';/.exec(committed)?.[1];
        const tlds = [...committed.matchAll(/^ {4}'([a-z0-9-]+)',/gm)].map((m) => m[1]);
        expect(header).toBeDefined();
        expect(tlds.length).toBeGreaterThan(1000);
        expect(committed).toBe(renderTldModule({ header, tlds }));
    });
});
