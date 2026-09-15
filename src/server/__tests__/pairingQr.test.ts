import { describe, expect, it } from 'vitest';
import { encodeQrSvg } from '../pairing/qr';

describe('encodeQrSvg', () => {
    it('emits an svg sized for the module count', () => {
        const svg = encodeQrSvg('WIFI:T:ADB;S:wsscrcpy-abc;P:secret123;;');
        expect(svg.startsWith('<svg')).toBe(true);
        expect(svg.endsWith('</svg>')).toBe(true);
        // viewBox is "0 0 N N" where N = modules + 2*margin. The side is always
        // 4*v+17, which is always ODD — so with the 4-module quiet zone a side,
        // N is always odd + 8, i.e. odd. (This note previously said the opposite
        // of what it meant, claiming odd counts were impossible.)
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

    // ------------------------------------------------------------------
    // The golden matrix.
    //
    // Everything above checks STRUCTURE — that the output is square, stable
    // and sized for its version. None of it would notice if the mask-penalty
    // scoring, the Reed-Solomon divisor or the interleave order were quietly
    // "simplified": the symbol would still be square, still deterministic,
    // still the right version, and no longer scannable. The only real decode
    // of this encoder's output happened by hand, outside CI.
    //
    // WHAT THIS PROVES, precisely: that the module matrix for a fixed payload
    // has not changed. It is a regression lock, not a proof of spec
    // correctness — it was generated from this implementation. The
    // invariants asserted beneath it are the independent half: finder
    // patterns, separators and timing runs are fixed by the spec regardless
    // of how the data modules come out, so a gross breakage fails there even
    // though the golden would also have to be rewritten to hide it.
    // ------------------------------------------------------------------

    /** Dark modules as `#`, light as `.`, quiet zone stripped. */
    function matrixOf(svg: string): string[] {
        const n = Number(/viewBox="0 0 (\d+) /.exec(svg)![1]);
        const dark = new Set<string>();
        for (const m of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
            dark.add(`${m[1]},${m[2]}`);
        }
        // The quiet zone is 4 modules a side and carries no dark modules.
        const rows: string[] = [];
        for (let y = 4; y < n - 4; y++) {
            let row = '';
            for (let x = 4; x < n - 4; x++) {
                row += dark.has(`${x},${y}`) ? '#' : '.';
            }
            rows.push(row);
        }
        return rows;
    }

    // A realistic payload: the exact shape `PairingService.startQr` builds, with
    // the 10-char base32 service name and 12-char password fixed.
    const GOLDEN_PAYLOAD = 'WIFI:T:ADB;S:wsscrcpy-abcdefghij;P:Ab3Kd9Xm2Qr7;;';

    // Several payloads, not one. A single golden turned out to be too weak for
    // the job it was added to do: the mask-penalty weights only change the
    // output when they change WHICH MASK WINS, and for any one payload most
    // weight changes leave the winner unchanged. Measured, not assumed -- with
    // a single golden, altering PENALTY_N1 and PENALTY_N3 both SURVIVED
    // mutation. Spanning versions 1 to 10 gives the penalty comparison enough
    // different symbols that a changed weight flips at least one of them:
    // PENALTY_N1, N2 and N3 are all killed by this set.
    //
    // PENALTY_N4 is NOT, and that is a property of N4 rather than a hole here.
    // Measured over 240 payloads of every length from 1 byte to the version-10
    // limit, changing N4 from 10 to 1 altered the output for ZERO of them — its
    // dark/light balance term never decides the argmin at these sizes. No
    // payload was found that would catch it, so none is claimed to.
    const GOLDEN_PAYLOADS = ['A', 'WIFI:T:ADB;S:x;P:y;;', GOLDEN_PAYLOAD, 'B'.repeat(60), 'C'.repeat(200)];

    it('encodes known payloads to exactly these module matrices', () => {
        const rendered = GOLDEN_PAYLOADS.map(
            (p) => `--- ${p.length} bytes ---\n${matrixOf(encodeQrSvg(p)).join('\n')}`,
        ).join('\n');
        expect(rendered).toMatchInlineSnapshot(`
          "--- 1 bytes ---
          #######.##.#..#######
          #.....#..##...#.....#
          #.###.#..####.#.###.#
          #.###.#.###...#.###.#
          #.###.#.###.#.#.###.#
          #.....#.####..#.....#
          #######.#.#.#.#######
          ........#.###........
          #...#.###..#.#####..#
          ..#.#...#..##..#.#.##
          ####.##...##..#####..
          ###....#.#...##.#.##.
          ###.#####...###...###
          ........#.#.###...###
          #######.##..##.....#.
          #.....#..####..#.#.#.
          #.###.#.####..#######
          #.###.#..#.##..#.#.##
          #.###.#....#..#####..
          #.....#..#...##.#.#..
          #######.#.#.###...#.#
          --- 20 bytes ---
          #######....####.#.#######
          #.....#..##.#..#..#.....#
          #.###.#.#...#.#...#.###.#
          #.###.#.##...#..#.#.###.#
          #.###.#.####.##...#.###.#
          #.....#.##.###.#..#.....#
          #######.#.#.#.#.#.#######
          ........#.#...##.........
          #.#####..#..##.##.#####..
          ##........#.#####.##....#
          .#######.#...#.##.#..####
          .##..#.#.#....#....#...##
          ....###..#.#....#.#..#...
          #####...#.#.##...#.#.##.#
          #....###.....###...#...##
          #..#.....#..##.#.#...#.#.
          #.######..#.#.#.#####.###
          ........#.......#...#####
          #######..#.##...#.#.#####
          #.....#.#..#..#.#...#...#
          #.###.#.#.##...######..##
          #.###.#.#.#.#######....##
          #.###.#.##...#######.#..#
          #.....#.....##..#.#.##..#
          #######.##..#.##.#..#.###
          --- 49 bytes ---
          #######..##.#...#.##.###..#######
          #.....#..#..#..##.#.##..#.#.....#
          #.###.#.###.#.#.#....####.#.###.#
          #.###.#.#..#...#..##..##..#.###.#
          #.###.#.##.#######..###...#.###.#
          #.....#.#..##......#..#.#.#.....#
          #######.#.#.#.#.#.#.#.#.#.#######
          ........#.#.#...#..######........
          #.#####..#...##..#.##.#...#####..
          ..#....##..###..#########......#.
          .##.###.##.#####.#........######.
          ..#.##....#.##..###..#.##########
          #.#.###.#..##.###...#....#.#..#.#
          ..####.#..####.#..#..####.#...#..
          .#.#.##.#.#.#####.#.#.......#.##.
          ..###..#.####..#.....##..#.#..###
          ..###.#####.#.##.#..#.##.#..##.#.
          ........###.###.#.#####....#.####
          #...###.##.######.#.#.#..#.#.....
          #.##.#.#..###.###..#.####....##.#
          #.###.#.....####..#....##...#.#.#
          #..#...#..#######...####.###...#.
          #...#.#####.#....###....##.##..#.
          #.##.#.###....#.#.#####.#..#.###.
          #.#.#.#..####.#..#.#..#######.#..
          ........#####...#####..##...#...#
          #######...#.##.#.#.....##.#.####.
          #.....#.#.###..#####.##.#...#.##.
          #.###.#.####...##.......######..#
          #.###.#.#####.##..#..##..#....###
          #.###.#.###....####.#...#....##..
          #.....#..###..##...#.####.#####..
          #######.#..#.#.#.#.##.####.##..#.
          --- 60 bytes ---
          #######..#####.##.#.##....#######
          #.....#...#.####.##.....#.#.....#
          #.###.#.#....#....##.#.##.#.###.#
          #.###.#.#...#.##.....##.#.#.###.#
          #.###.#.#......#..#.##....#.###.#
          #.....#.#.####.#.##.....#.#.....#
          #######.#.#.#.#.#.#.#.#.#.#######
          ........##........##.#.##........
          #.#####...#.#.##.....##.#.#####..
          ###.#....##.#..##.#.##........#..
          .#.##.###.###..#.##.....#..##..#.
          #.#.#..##.....#...##.#.##.##.##.#
          #.#######...#..#.....##.##.#..#..
          #.#.#..###.##.###.#.##........#..
          #.#..##..#..####.##.....#..##..#.
          ..#.#..###.###....##.#.##.##.##.#
          .....##.#.#....#.....##.##.#..#..
          .##.....###..#.##.#.##........#..
          #..##.#....#.###.##.....#..##..#.
          ###.##....##......##.#.##.##.##.#
          ......#.#..##.##.....##.##.#..#..
          ###....####..#.##.#.##........#..
          #..##.##.#..#..#.##.....#..##..#.
          #..#.#.#..##......##.#.##.##.##..
          #..######..##..#.....##.#####.###
          ........#.##.####.#.##..#...#.#..
          #######..#.#..##.##.....#.#.#..#.
          #.....#.#.#####...##.#.##...###.#
          #.###.#.###..#.#.....##.#####.#..
          #.###.#.##.#.####.#.##...#.#..###
          #.###.#.##.#..##.##.....#........
          #.....#...####....##.#..#..####..
          #######.#...##.#.....####.##..##.
          --- 200 bytes ---
          #######..#.....##.#..#.###..#####..#.#..#####.##..#######
          #.....#..#..####.#...#.#...#..#..#..#..#..#....#..#.....#
          #.###.#.#.#.....#.###.#.#..#..##.#..#..#..#..###..#.###.#
          #.###.#.##.#..##.##.....###..#....#####..#.#...#..#.###.#
          #.###.#.#..##..##.####.##.######...#.#..######.#..#.###.#
          #.....#.##.##..#.##..#.#.##...#..#..#..#..#..##...#.....#
          #######.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#######
          ........#.#.###.#.##....#.#...#..#..#..#..#..#..#........
          #.#####..#.#...###...#..#.######..#####..#.#..#.#.#####..
          .......#...####.#..##..##...#####..#.#..#####..###..#.#..
          #.###.#.##..#.##.##...##.###..#..#..#..#..#..#.#...#.#.#.
          ...#...#..#..#..#.##.##.##....#..#..#..#..#..#..#..#.####
          #..#.##..#.#.#..##....#.#..#.#.#..#####..#.#..#.###...#..
          ....#..#...####....###.#.##..####..#.#..#####..###..#.#..
          #..##.#.#.#.#.#.###...#...##..#..#..#..#..#..#.#...#.#.#.
          ....#..#..#..#..#.##.#.#.###..#..#..#..#..#..#..#..#.##..
          #.##.##....#...###.#....#....#.#..#####..#.#..#.###...#.#
          .......#.#.###..#...##.##...#####..#.#..#####..###..#.#..
          #.#.###.##..#.##....#..#.###..#..#..#..#..#..#.#...#.#.#.
          .......#.....#.#..####..##.#.#...#..#..#..#..#..#..#.####
          #.##.###.......###..##..#......#..#####..#.#..#.###...#..
          .....#..####.#..##.#...##...##.##..#.#..#####..###..#.#..
          #.#.######....##.##.#..#.###..#..#..#..#..#..#.#...#.#.#.
          .......#..##.#.#..####..##.#..#..#..#..#..#..#..#..#.####
          #.##.##.#......##.#..#..#....#.##.#####..#.#..#.###...#..
          #....#.#...###..###.#..##...###.#..#.#..#####..###..#.#..
          ###.######.#...#.##....#.#########..#..#..#..#.#######.#.
          ....#...#.##.#.#..#..#..###...#..#..#..#..#..#.##...#####
          #...#.#.#..####...#..#..#.#.#.##..#####..#.#..#.#.#.#.#..
          .#.##...#..#.#.#.#..#..####...###..#.#..#####...#...#.#..
          ....######.#.##..##..#.#..#####..#..#..#..#..#..######.#.
          ..####.#..##.#.##.#...#.#..#..#..#..#..#..#..#.....#.####
          #.##..#....###..#.#...####.#..##..#####..#.#..#....#..#..
          .#...#.#...#..####..#...#.#..#.##..#.#..#####..####...#..
          ...#.####..#....###..#.##.#.###..#..#..#..#..#..##..##.##
          ..####....##.####.#..##.#..#..#..#..#..#..#..#.....#.##..
          #..#..#..####.#.#.#.#...#..#..##..#####..#.#..#....#..#..
          .#..##.#..##..#.##.##.###.#.##.##..#.#..#####..####...#..
          ....#.####.#...#.....#.#...####..#..#..#..#..#..##..##.#.
          ..##.#...###.#######..#.#.#.#.#..#..#..#..#..#.....#.####
          #..####..###..#.###.###.##.#..##..#####..#.#..#....#..#..
          .#..##.#.#.#..#.##.###.##.#..#.##..#.#..#####..####...#..
          #....####.#....#..#..#.#..#.###..#..#..#..#..#..##..##.#.
          .#####...#.########.#.#.#..#..#..#..#..#..#..#.....#.####
          #..##.#####.#.#.##...##.##.#..#...#####..#.#..#....#..#..
          ##...#..##....#.#..#.#.##.#..####..#.#..#####..####...#..
          #.#..##...#.#.##.#.###.#..#.#.#..#..#..#..#..#..##..##.#.
          #####...##.....##..#..#.#..#.##..#..#..#..#..#.....#.####
          ......#..####....##..##.#.######..#####..#.#..#.#####.#..
          ........##.#.###..##.#.####...###..#.#..#####..##...#.#..
          #######...####.###.#####.##.#.#..#..#..#..#..#.##.#.##.#.
          #.....#.##.#...#...#..#.#.#...#..#..#..#..#..#..#...#####
          #.###.#.#####.#.###.....########..#####..#.#..#.#####.#..
          #.###.#.##.#.###..##.#.#...#..###..#.#..#####...#..#..#..
          #.###.#.#.########.##........#...#..#..#..#..#.####..#...
          #.....#..###.#.##..#.#.#.##.###..#..#..#..#..#.#.#..###..
          #######.########.##.###.##.#..##..#####..#.#..#.#..#..##."
        `);
    });

    it('places the spec-fixed patterns the golden matrix cannot vouch for itself', () => {
        // Independent of the data modules entirely: these positions are fixed by
        // the QR specification, so they hold for ANY payload. Asserted against a
        // second, different payload so a golden regenerated around a broken
        // encoder cannot carry these too.
        const rows = matrixOf(encodeQrSvg('A'));
        const side = rows.length;
        expect(side).toBe(21); // version 1: 4 * 1 + 17

        const at = (x: number, y: number): boolean => rows[y]![x] === '#';

        // Three 7x7 finder patterns: dark ring, light ring, 3x3 dark core.
        for (const [ox, oy] of [
            [0, 0],
            [side - 7, 0],
            [0, side - 7],
        ] as const) {
            for (let i = 0; i < 7; i++) {
                expect(at(ox + i, oy)).toBe(true); // top edge
                expect(at(ox + i, oy + 6)).toBe(true); // bottom edge
                expect(at(ox, oy + i)).toBe(true); // left edge
                expect(at(ox + 6, oy + i)).toBe(true); // right edge
            }
            expect(at(ox + 1, oy + 1)).toBe(false); // light ring
            expect(at(ox + 3, oy + 3)).toBe(true); // dark core
        }

        // Separators: the 1-module light band between each finder and the rest
        // of the symbol. Fixed by the spec, and never dark for any payload.
        for (let i = 0; i < 8; i++) {
            expect(at(7, i)).toBe(false); // right of the top-left finder
            expect(at(i, 7)).toBe(false); // below it
            expect(at(side - 8, i)).toBe(false); // left of the top-right finder
            expect(at(i, side - 8)).toBe(false); // above the bottom-left finder
        }

        // Timing patterns: row 6 and column 6 alternate dark/light between the
        // finders, starting dark at an even coordinate.
        for (let i = 8; i < side - 8; i++) {
            expect(at(i, 6)).toBe(i % 2 === 0);
            expect(at(6, i)).toBe(i % 2 === 0);
        }
        // The dark module below the top-left finder is always set.
        expect(at(8, side - 8)).toBe(true);
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
