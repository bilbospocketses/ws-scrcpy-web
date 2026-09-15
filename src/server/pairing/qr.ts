/*
 * QR Code generator library (TypeScript)
 *
 * Copyright (c) Project Nayuki. (MIT License)
 * https://www.nayuki.io/page/qr-code-generator-library
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */

/*
 * Vendored (not npm-installed) from Project Nayuki's reference implementation and
 * trimmed to the single configuration the pairing QR needs:
 *
 *   - byte mode only. The numeric, alphanumeric, kanji and ECI segment modes are
 *     deleted rather than left unused.
 *   - error-correction level M, fixed. No ECC boosting.
 *   - versions 1..10. A payload that does not fit version 10 throws.
 *
 * The public surface is `encodeQrSvg`. The returned markup is built solely from
 * the numeric module matrix -- the input text is never interpolated into it, and
 * it contains no <script> and no event attributes -- because the caller injects
 * it with innerHTML.
 */

const MIN_VERSION = 1;
const MAX_VERSION = 10;

// Error-correction level M only. Index is the QR version; index 0 is unused
// padding and holds an illegal value so an off-by-one is loud rather than subtle.
//                                        v0  v1  v2  v3  v4  v5  v6  v7  v8  v9 v10
const ECC_CODEWORDS_PER_BLOCK: number[] = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_ERROR_CORRECTION_BLOCKS: number[] = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

// Format-information bits for level M (the two-bit field is 0b00 for M).
const ECC_FORMAT_BITS = 0;

// Mask-pattern penalty weights, from the QR Code specification.
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

export interface QrSvgOptions {
    /** Pixel size of one module. When given, the <svg> gets width/height attributes. */
    moduleSize?: number;
    /** Quiet-zone width in modules. Defaults to 4, the minimum the spec requires. */
    margin?: number;
}

/**
 * Encodes `text` as a QR Code (byte mode, ECC level M, version 1..10) and returns a
 * complete standalone `<svg>...</svg>` string.
 *
 * @throws Error if `text` is empty, or is too long to fit a version 10 symbol.
 */
export function encodeQrSvg(text: string, opts: QrSvgOptions = {}): string {
    if (!text) {
        throw new Error('encodeQrSvg: refusing to encode an empty payload');
    }
    const margin = opts.margin ?? 4;
    if (!Number.isInteger(margin) || margin < 0) {
        throw new Error(`encodeQrSvg: margin must be a non-negative integer, got ${String(opts.margin)}`);
    }
    const moduleSize = opts.moduleSize;
    if (moduleSize !== undefined && (!Number.isFinite(moduleSize) || moduleSize <= 0)) {
        throw new Error(`encodeQrSvg: moduleSize must be a positive number, got ${String(moduleSize)}`);
    }

    const modules = buildMatrix(text);
    const n = modules.length + margin * 2;

    let path = '';
    for (let y = 0; y < modules.length; y++) {
        const row = modules[y]!;
        for (let x = 0; x < row.length; x++) {
            if (row[x]) {
                path += `M${x + margin} ${y + margin}h1v1h-1z`;
            }
        }
    }

    const size = moduleSize === undefined ? '' : ` width="${n * moduleSize}" height="${n * moduleSize}"`;
    return (
        `<svg xmlns="http://www.w3.org/2000/svg"${size} viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
        `<rect width="${n}" height="${n}" fill="#fff"/>` +
        `<path d="${path}" fill="#000"/>` +
        '</svg>'
    );
}

/**
 * Builds the module matrix for `text`. `matrix[y][x]` is true where the module is dark.
 * The matrix is square, of side 4 * version + 17, and carries no quiet zone.
 */
function buildMatrix(text: string): boolean[][] {
    const data = Array.from(new TextEncoder().encode(text));
    const version = chooseVersion(data.length);
    const codewords = addEccAndInterleave(buildDataCodewords(data, version), version);
    return new QrMatrix(version, codewords).modules;
}

/** Smallest version in [MIN_VERSION, MAX_VERSION] whose level-M capacity holds `byteLength` bytes. */
function chooseVersion(byteLength: number): number {
    for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
        const capacityBits = getNumDataCodewords(version) * 8;
        // Mode indicator (4 bits) + character count field + the payload itself.
        const usedBits = 4 + charCountBits(version) + byteLength * 8;
        if (usedBits <= capacityBits) {
            return version;
        }
    }
    throw new Error(
        `encodeQrSvg: payload of ${byteLength} bytes is too long for a version ${MAX_VERSION} QR code at ECC level M`,
    );
}

/** Width of the byte-mode character-count field for a given version. */
function charCountBits(version: number): number {
    return version <= 9 ? 8 : 16;
}

/** The data bit stream for one byte-mode segment, terminated and padded to capacity. */
function buildDataCodewords(data: readonly number[], version: number): number[] {
    const bb: number[] = [];
    appendBits(bb, 0x4, 4); // Byte mode indicator
    appendBits(bb, data.length, charCountBits(version));
    for (const b of data) {
        appendBits(bb, b, 8);
    }

    const capacityBits = getNumDataCodewords(version) * 8;
    // Terminator, then pad to a byte boundary, then alternating pad bytes.
    appendBits(bb, 0, Math.min(4, capacityBits - bb.length));
    appendBits(bb, 0, (8 - (bb.length % 8)) % 8);
    for (let padByte = 0xec; bb.length < capacityBits; padByte ^= 0xec ^ 0x11) {
        appendBits(bb, padByte, 8);
    }

    const result: number[] = [];
    for (let i = 0; i < bb.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) {
            byte = (byte << 1) | bb[i + j]!;
        }
        result.push(byte);
    }
    return result;
}

/** Appends the `len` low-order bits of `val` to `bb`, most significant first. */
function appendBits(bb: number[], val: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
        bb.push((val >>> i) & 1);
    }
}

/** Number of data codewords (i.e. excluding ECC) for a version at level M. */
function getNumDataCodewords(version: number): number {
    return (
        Math.floor(getNumRawDataModules(version) / 8) -
        ECC_CODEWORDS_PER_BLOCK[version]! * NUM_ERROR_CORRECTION_BLOCKS[version]!
    );
}

/** Number of data bits that fit in a symbol of the given version, i.e. all modules minus function patterns. */
function getNumRawDataModules(version: number): number {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
        const numAlign = Math.floor(version / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (version >= 7) {
            result -= 36;
        }
    }
    return result;
}

/** Appends ECC to each block of `data` and interleaves the blocks into the final codeword sequence. */
function addEccAndInterleave(data: readonly number[], version: number): number[] {
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[version]!;
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[version]!;
    const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const blocks: number[][] = [];
    const rsDiv = reedSolomonComputeDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
        k += dat.length;
        const ecc = reedSolomonComputeRemainder(dat, rsDiv);
        if (i < numShortBlocks) {
            dat.push(0); // Placeholder, skipped by the interleaver below
        }
        blocks.push(dat.concat(ecc));
    }

    const result: number[] = [];
    for (let i = 0; i < blocks[0]!.length; i++) {
        for (let j = 0; j < blocks.length; j++) {
            // Skip the padding byte that short blocks carry in the data section.
            if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
                result.push(blocks[j]![i]!);
            }
        }
    }
    return result;
}

/** Reed-Solomon ECC generator polynomial of the given degree, as coefficients descending from x^(degree-1). */
function reedSolomonComputeDivisor(degree: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < degree - 1; i++) {
        result.push(0);
    }
    result.push(1); // Start with the monomial x^0

    // Compute the product polynomial (x - r^0)(x - r^1)...(x - r^(degree-1)) over GF(2^8),
    // and drop the highest monomial term which is always 1x^degree.
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = reedSolomonMultiply(result[j]!, root);
            if (j + 1 < result.length) {
                result[j] = result[j]! ^ result[j + 1]!;
            }
        }
        root = reedSolomonMultiply(root, 0x02);
    }
    return result;
}

/** Remainder of `data` divided by `divisor` over GF(2^8) -- the ECC codewords for one block. */
function reedSolomonComputeRemainder(data: readonly number[], divisor: readonly number[]): number[] {
    const result: number[] = divisor.map(() => 0);
    for (const b of data) {
        const factor = b ^ result.shift()!;
        result.push(0);
        for (let i = 0; i < divisor.length; i++) {
            result[i] = result[i]! ^ reedSolomonMultiply(divisor[i]!, factor);
        }
    }
    return result;
}

/** Product of two GF(2^8) field elements, modulo the QR polynomial x^8 + x^4 + x^3 + x^2 + 1. */
function reedSolomonMultiply(x: number, y: number): number {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z;
}

function getBit(x: number, i: number): boolean {
    return ((x >>> i) & 1) !== 0;
}

/**
 * A rendered QR symbol: function patterns, the interleaved codewords, and the
 * automatically chosen mask, all baked into `modules`.
 */
class QrMatrix {
    public readonly size: number;
    /** modules[y][x] -- true is dark. */
    public readonly modules: boolean[][];
    /** Marks modules the codeword placer and masker must not touch. */
    private readonly isFunction: boolean[][];

    public constructor(
        private readonly version: number,
        codewords: readonly number[],
    ) {
        this.size = version * 4 + 17;
        this.modules = [];
        this.isFunction = [];
        for (let i = 0; i < this.size; i++) {
            this.modules.push(new Array<boolean>(this.size).fill(false));
            this.isFunction.push(new Array<boolean>(this.size).fill(false));
        }

        this.drawFunctionPatterns();
        this.drawCodewords(codewords);

        // Pick the mask with the lowest penalty. Each mask is applied, scored, then
        // XORed off again before the next one is tried.
        let mask = 0;
        let minPenalty = Infinity;
        for (let i = 0; i < 8; i++) {
            this.applyMask(i);
            this.drawFormatBits(i);
            const penalty = this.getPenaltyScore();
            if (penalty < minPenalty) {
                mask = i;
                minPenalty = penalty;
            }
            this.applyMask(i);
        }
        this.applyMask(mask);
        this.drawFormatBits(mask);
    }

    private setFunctionModule(x: number, y: number, isDark: boolean): void {
        this.modules[y]![x] = isDark;
        this.isFunction[y]![x] = true;
    }

    private drawFunctionPatterns(): void {
        // Timing patterns
        for (let i = 0; i < this.size; i++) {
            this.setFunctionModule(6, i, i % 2 === 0);
            this.setFunctionModule(i, 6, i % 2 === 0);
        }

        // Finder patterns, with their separators (the 8x8 regions in three corners)
        this.drawFinderPattern(3, 3);
        this.drawFinderPattern(this.size - 4, 3);
        this.drawFinderPattern(3, this.size - 4);

        // Alignment patterns, skipping the three that collide with the finders
        const alignPatPos = this.getAlignmentPatternPositions();
        const numAlign = alignPatPos.length;
        for (let i = 0; i < numAlign; i++) {
            for (let j = 0; j < numAlign; j++) {
                const isFinderCorner =
                    (i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0);
                if (!isFinderCorner) {
                    this.drawAlignmentPattern(alignPatPos[i]!, alignPatPos[j]!);
                }
            }
        }

        this.drawFormatBits(0); // Dummy mask value; overwritten once the mask is chosen
        this.drawVersionInfo();
    }

    /** Draws the 15-bit format information (ECC level M plus mask), twice, with its BCH error correction. */
    private drawFormatBits(mask: number): void {
        const data = (ECC_FORMAT_BITS << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) {
            rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        }
        const bits = ((data << 10) | rem) ^ 0x5412;

        // First copy, around the top-left finder
        for (let i = 0; i <= 5; i++) {
            this.setFunctionModule(8, i, getBit(bits, i));
        }
        this.setFunctionModule(8, 7, getBit(bits, 6));
        this.setFunctionModule(8, 8, getBit(bits, 7));
        this.setFunctionModule(7, 8, getBit(bits, 8));
        for (let i = 9; i < 15; i++) {
            this.setFunctionModule(14 - i, 8, getBit(bits, i));
        }

        // Second copy, split between the other two finders
        for (let i = 0; i < 8; i++) {
            this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
        }
        for (let i = 8; i < 15; i++) {
            this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
        }
        this.setFunctionModule(8, this.size - 8, true); // Always dark
    }

    /** Draws the 18-bit version information, twice. Versions below 7 carry none. */
    private drawVersionInfo(): void {
        if (this.version < 7) {
            return;
        }
        let rem = this.version;
        for (let i = 0; i < 12; i++) {
            rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        }
        const bits = (this.version << 12) | rem;

        for (let i = 0; i < 18; i++) {
            const isDark = getBit(bits, i);
            const a = this.size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            this.setFunctionModule(a, b, isDark);
            this.setFunctionModule(b, a, isDark);
        }
    }

    /** Draws a 9x9 finder pattern centred on (x, y), clipped at the symbol edge. */
    private drawFinderPattern(x: number, y: number): void {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const dist = Math.max(Math.abs(dx), Math.abs(dy)); // Chebyshev norm
                const xx = x + dx;
                const yy = y + dy;
                if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
                    this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
                }
            }
        }
    }

    /** Draws a 5x5 alignment pattern centred on (x, y). */
    private drawAlignmentPattern(x: number, y: number): void {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
    }

    /** Centre coordinates of the alignment patterns for this version, ascending. */
    private getAlignmentPatternPositions(): number[] {
        if (this.version === 1) {
            return [];
        }
        const numAlign = Math.floor(this.version / 7) + 2;
        const step = Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
        const result = [6];
        for (let pos = this.size - 7; result.length < numAlign; pos -= step) {
            result.splice(1, 0, pos);
        }
        return result;
    }

    /** Places the codeword bits in the zigzag order the spec defines, skipping function modules. */
    private drawCodewords(data: readonly number[]): void {
        let i = 0; // Bit index into data
        for (let right = this.size - 1; right >= 1; right -= 2) {
            // Index of the right column in each column pair
            if (right === 6) {
                right = 5; // Skip the vertical timing pattern column
            }
            for (let vert = 0; vert < this.size; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? this.size - 1 - vert : vert;
                    if (!this.isFunction[y]![x] && i < data.length * 8) {
                        this.modules[y]![x] = getBit(data[i >>> 3]!, 7 - (i & 7));
                        i++;
                    }
                    // Any remaining remainder bits are left light, as the spec requires.
                }
            }
        }
    }

    /** XORs the given mask pattern over every non-function module. Applying it twice undoes it. */
    private applyMask(mask: number): void {
        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                let invert: boolean;
                switch (mask) {
                    case 0:
                        invert = (x + y) % 2 === 0;
                        break;
                    case 1:
                        invert = y % 2 === 0;
                        break;
                    case 2:
                        invert = x % 3 === 0;
                        break;
                    case 3:
                        invert = (x + y) % 3 === 0;
                        break;
                    case 4:
                        invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
                        break;
                    case 5:
                        invert = ((x * y) % 2) + ((x * y) % 3) === 0;
                        break;
                    case 6:
                        invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
                        break;
                    case 7:
                        invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
                        break;
                    default:
                        throw new Error(`encodeQrSvg: illegal mask ${mask}`);
                }
                if (!this.isFunction[y]![x] && invert) {
                    this.modules[y]![x] = !this.modules[y]![x];
                }
            }
        }
    }

    /** The spec's four-rule penalty score for the current module pattern. Lower is better. */
    private getPenaltyScore(): number {
        let result = 0;

        // Rule 1/3 horizontally: runs of same-coloured modules, and finder-like patterns
        for (let y = 0; y < this.size; y++) {
            let runColor = false;
            let runX = 0;
            const runHistory = [0, 0, 0, 0, 0, 0, 0];
            for (let x = 0; x < this.size; x++) {
                if (this.modules[y]![x] === runColor) {
                    runX++;
                    if (runX === 5) {
                        result += PENALTY_N1;
                    } else if (runX > 5) {
                        result++;
                    }
                } else {
                    this.finderPenaltyAddHistory(runX, runHistory);
                    if (!runColor) {
                        result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
                    }
                    runColor = this.modules[y]![x]!;
                    runX = 1;
                }
            }
            result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * PENALTY_N3;
        }

        // Rule 1/3 vertically
        for (let x = 0; x < this.size; x++) {
            let runColor = false;
            let runY = 0;
            const runHistory = [0, 0, 0, 0, 0, 0, 0];
            for (let y = 0; y < this.size; y++) {
                if (this.modules[y]![x] === runColor) {
                    runY++;
                    if (runY === 5) {
                        result += PENALTY_N1;
                    } else if (runY > 5) {
                        result++;
                    }
                } else {
                    this.finderPenaltyAddHistory(runY, runHistory);
                    if (!runColor) {
                        result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
                    }
                    runColor = this.modules[y]![x]!;
                    runY = 1;
                }
            }
            result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * PENALTY_N3;
        }

        // Rule 2: 2x2 blocks of one colour
        for (let y = 0; y < this.size - 1; y++) {
            for (let x = 0; x < this.size - 1; x++) {
                const color = this.modules[y]![x];
                if (
                    color === this.modules[y]![x + 1] &&
                    color === this.modules[y + 1]![x] &&
                    color === this.modules[y + 1]![x + 1]
                ) {
                    result += PENALTY_N2;
                }
            }
        }

        // Rule 4: balance of dark and light modules
        let dark = 0;
        for (const row of this.modules) {
            for (const color of row) {
                if (color) {
                    dark++;
                }
            }
        }
        const total = this.size * this.size;
        // Smallest k >= 0 such that (45 - 5k)% <= dark/total <= (55 + 5k)%
        const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
        result += k * PENALTY_N4;
        return result;
    }

    /** Counts the 1:1:3:1:1 finder-like runs in the history, including the 4-module light margin. */
    private finderPenaltyCountPatterns(runHistory: readonly number[]): number {
        const n = runHistory[1]!;
        const core =
            n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
        return (
            (core && runHistory[0]! >= n * 4 && runHistory[6]! >= n ? 1 : 0) +
            (core && runHistory[6]! >= n * 4 && runHistory[0]! >= n ? 1 : 0)
        );
    }

    /** Ends the current run, adds the implicit light border, and counts the patterns that closes. */
    private finderPenaltyTerminateAndCount(
        currentRunColor: boolean,
        currentRunLength: number,
        runHistory: number[],
    ): number {
        let runLength = currentRunLength;
        if (currentRunColor) {
            this.finderPenaltyAddHistory(runLength, runHistory);
            runLength = 0;
        }
        runLength += this.size; // Light border past the edge of the symbol
        this.finderPenaltyAddHistory(runLength, runHistory);
        return this.finderPenaltyCountPatterns(runHistory);
    }

    private finderPenaltyAddHistory(currentRunLength: number, runHistory: number[]): void {
        let runLength = currentRunLength;
        if (runHistory[0] === 0) {
            runLength += this.size; // Light border before the start of the symbol
        }
        runHistory.pop();
        runHistory.unshift(runLength);
    }
}
