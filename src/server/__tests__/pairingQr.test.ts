import { describe, expect, it } from 'vitest';
import { encodeQrSvg } from '../pairing/qr';

describe('encodeQrSvg', () => {
    it('emits an svg sized for the module count', () => {
        const svg = encodeQrSvg('WIFI:T:ADB;S:wsscrcpy-abc;P:secret123;;');
        expect(svg.startsWith('<svg')).toBe(true);
        expect(svg.endsWith('</svg>')).toBe(true);
        // viewBox is "0 0 N N" where N = modules + 2*margin. Square, and odd
        // module counts are impossible for QR (always 4*v+17, always odd).
        const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
        expect(m).not.toBeNull();
        expect(m![1]).toBe(m![2]);
    });

    it('is deterministic for the same input', () => {
        const a = encodeQrSvg('WIFI:T:ADB;S:x;P:y;;');
        const b = encodeQrSvg('WIFI:T:ADB;S:x;P:y;;');
        expect(a).toBe(b);
    });

    it('changes when the payload changes', () => {
        expect(encodeQrSvg('WIFI:T:ADB;S:x;P:y;;')).not.toBe(encodeQrSvg('WIFI:T:ADB;S:x;P:z;;'));
    });

    it('refuses empty input rather than emitting a blank code', () => {
        expect(() => encodeQrSvg('')).toThrow(/empty/i);
    });

    it('floats the version with the payload size', () => {
        // Module count is 4 * version + 17, plus the default margin of 4 a side.
        const small = /viewBox="0 0 (\d+) /.exec(encodeQrSvg('A'))![1];
        const large = /viewBox="0 0 (\d+) /.exec(encodeQrSvg('A'.repeat(200)))![1];
        expect(Number(small)).toBe(21 + 8); // version 1
        expect(Number(large)).toBe(57 + 8); // version 10
    });

    it('refuses a payload too long for version 10', () => {
        // 213 bytes is the level-M byte-mode capacity of a version 10 symbol.
        expect(() => encodeQrSvg('y'.repeat(213))).not.toThrow();
        expect(() => encodeQrSvg('y'.repeat(214))).toThrow(/too long/i);
    });

    it('never interpolates the payload into the markup', () => {
        // The caller injects this with innerHTML, so the text must not reach the
        // output and the output must carry no script or event handlers.
        const hostile = '"><script>alert(1)</script><svg onload="x"';
        const svg = encodeQrSvg(hostile);
        expect(svg).not.toContain('script');
        expect(svg).not.toContain('onload');
        expect(svg).not.toContain('alert');
        // Only <rect> and <path> built from the numeric matrix. Strip the cell
        // subpaths and what remains must be exactly the fixed scaffolding.
        const n = Number(/viewBox="0 0 (\d+) /.exec(svg)![1]);
        expect(svg.replace(/M\d+ \d+h1v1h-1z/g, '')).toBe(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
                `<rect width="${n}" height="${n}" fill="#fff"/>` +
                `<path d="" fill="#000"/>` +
                '</svg>',
        );
    });
});
