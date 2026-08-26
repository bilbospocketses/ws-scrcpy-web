/**
 * Minimal ZIP extractor — pure JS, no dependencies, bundled into the server
 * bundle by webpack.
 *
 * Why this exists: the dependency manager has to unpack two ZIPs (Google's
 * `platform-tools-latest-<os>.zip` and, on Windows, the Node.js distribution).
 * It used to shell out to PowerShell `Expand-Archive` / system `unzip`, which
 * resolved binaries via `PATH` — a Local-Dependencies-Only violation. That was
 * replaced by shelling out to the Rust launcher's `--unzip` subcommand, which
 * fixed the PATH problem but made extraction depend on a binary that only
 * exists in a packaged install: `resolveLauncherPath()` is
 * `cwd/ws-scrcpy-web-launcher`, absent from every source checkout. The result
 * was that `autoInstallMissing` silently skipped adb (and Node) in dev on all
 * three platforms — invisible on Windows, where the dev tree and an MSI install
 * share `%PROGRAMDATA%\WsScrcpyWeb\dependencies\`, and fatal on Linux/macOS,
 * where the dev deps folder starts empty.
 *
 * Doing it in-process solves both: no PATH lookup and no external binary, which
 * is Local-Dependencies-Only compliant in the same way `ws` is — compiled into
 * the app's own artifact rather than resolved from the host.
 *
 * Scope is deliberately narrow. We read the **central directory** rather than
 * streaming local headers, which means data descriptors (the streaming-writer
 * case where sizes trail the data) are simply never consulted. Store and
 * deflate are supported because that is what our two inputs use. Anything else
 * — ZIP64, encryption, symlinks, an unknown compression method — throws with a
 * named reason instead of producing a subtly wrong tree.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const EOCD_MIN_SIZE = 22;
/** ZIP comment length is a uint16, so the EOCD starts at most this far from EOF. */
const MAX_COMMENT = 0xffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** `versionMadeBy >> 8` for archives written on a UNIX host (mode bits are meaningful). */
const MADE_BY_UNIX = 3;

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

export interface ZipEntry {
    /** Entry path as recorded, always forward-slashed. */
    name: string;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    crc32: number;
    localHeaderOffset: number;
    /** POSIX mode from the external attributes, or null when the archive carries none. */
    unixMode: number | null;
    isDirectory: boolean;
}

function findEocdOffset(buf: Buffer): number {
    const start = Math.max(0, buf.length - (EOCD_MIN_SIZE + MAX_COMMENT));
    for (let i = buf.length - EOCD_MIN_SIZE; i >= start; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) return i;
    }
    throw new Error('not a ZIP archive: end-of-central-directory record not found');
}

/**
 * Parse the central directory. Exported for tests — extraction goes through
 * {@link extractZipTo}.
 */
export function readCentralDirectory(buf: Buffer): ZipEntry[] {
    const eocd = findEocdOffset(buf);

    // ZIP64 archives put the real counts/offsets in a separate record and leave
    // 0xffff/0xffffffff sentinels here. Neither of our inputs is anywhere near
    // the 4 GiB / 65535-entry thresholds, so rather than implement it, detect it.
    if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === EOCD64_LOCATOR_SIG) {
        throw new Error('ZIP64 archives are not supported by this extractor');
    }

    const entryCount = buf.readUInt16LE(eocd + 10);
    const centralSize = buf.readUInt32LE(eocd + 12);
    const centralOffset = buf.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
        throw new Error('ZIP64 archives are not supported by this extractor');
    }

    const entries: ZipEntry[] = [];
    let p = centralOffset;
    for (let i = 0; i < entryCount; i++) {
        if (buf.readUInt32LE(p) !== CENTRAL_SIG) {
            throw new Error(`corrupt ZIP: bad central-directory signature at entry ${i}`);
        }
        const versionMadeBy = buf.readUInt16LE(p + 4);
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const crc32 = buf.readUInt32LE(p + 16);
        const compressedSize = buf.readUInt32LE(p + 20);
        const uncompressedSize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const externalAttrs = buf.readUInt32LE(p + 38);
        const localHeaderOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');

        // Bit 0 = encrypted. We have no business decrypting anything.
        if (flags & 0x0001) {
            throw new Error(`encrypted ZIP entry is not supported: ${name}`);
        }

        const unixMode = versionMadeBy >> 8 === MADE_BY_UNIX ? (externalAttrs >>> 16) & 0xffff : null;
        if (unixMode !== null && (unixMode & S_IFMT) === S_IFLNK) {
            // Symlinks in an archive are an extraction-escape vector and neither
            // of our inputs has any. Fail loudly rather than silently drop a file
            // something later depends on.
            throw new Error(`symlink entries are not supported: ${name}`);
        }

        entries.push({
            name,
            method,
            compressedSize,
            uncompressedSize,
            crc32,
            localHeaderOffset,
            unixMode,
            isDirectory: name.endsWith('/'),
        });

        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/**
 * Resolve an entry name under `destDir`, refusing anything that escapes it
 * (`../`, an absolute path, a drive-relative Windows path). Zip-slip guard.
 */
export function resolveEntryPath(destDir: string, entryName: string): string {
    const resolvedDest = path.resolve(destDir);
    const target = path.resolve(resolvedDest, entryName);
    const withSep = resolvedDest.endsWith(path.sep) ? resolvedDest : resolvedDest + path.sep;
    if (target !== resolvedDest && !target.startsWith(withSep)) {
        throw new Error(`ZIP entry escapes the destination directory: ${entryName}`);
    }
    return target;
}

function readEntryData(buf: Buffer, entry: ZipEntry): Buffer {
    if (buf.readUInt32LE(entry.localHeaderOffset) !== LOCAL_SIG) {
        throw new Error(`corrupt ZIP: bad local header for ${entry.name}`);
    }
    // The local header's name/extra lengths can differ from the central
    // directory's, so the data offset must come from the local header itself.
    const nameLen = buf.readUInt16LE(entry.localHeaderOffset + 26);
    const extraLen = buf.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);

    let data: Buffer;
    if (entry.method === METHOD_STORE) {
        data = Buffer.from(raw);
    } else if (entry.method === METHOD_DEFLATE) {
        data = zlib.inflateRawSync(raw);
    } else {
        throw new Error(`unsupported ZIP compression method ${entry.method} for ${entry.name}`);
    }

    if (data.length !== entry.uncompressedSize) {
        throw new Error(`ZIP entry ${entry.name}: expected ${entry.uncompressedSize} bytes, got ${data.length}`);
    }
    // zlib.crc32 landed in Node 20.15; we ship 24. Catching a bad byte here beats
    // discovering it when adb refuses to run.
    const actual = zlib.crc32(data) >>> 0;
    if (actual !== entry.crc32 >>> 0) {
        throw new Error(`ZIP entry ${entry.name}: CRC32 mismatch`);
    }
    return data;
}

/**
 * Extract `zipPath` into `destDir`, creating it if needed.
 *
 * POSIX modes recorded by the archive are applied, so an `adb` marked
 * executable by Google's build stays executable. Archives written on Windows
 * carry no mode bits; those entries get 0644 / 0755.
 */
export async function extractZipTo(zipPath: string, destDir: string): Promise<void> {
    const buf = await fs.promises.readFile(zipPath);
    const entries = readCentralDirectory(buf);

    await fs.promises.mkdir(destDir, { recursive: true });

    // Directories first, so a file can never be written before its parent and
    // an explicit directory entry's mode is not clobbered by mkdir recursion.
    for (const entry of entries) {
        if (!entry.isDirectory) continue;
        const target = resolveEntryPath(destDir, entry.name);
        await fs.promises.mkdir(target, { recursive: true });
    }

    for (const entry of entries) {
        if (entry.isDirectory) continue;
        const target = resolveEntryPath(destDir, entry.name);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const data = readEntryData(buf, entry);
        await fs.promises.writeFile(target, data);
        if (process.platform !== 'win32') {
            const mode = entry.unixMode !== null ? entry.unixMode & 0o7777 : DEFAULT_FILE_MODE;
            await fs.promises.chmod(target, mode || DEFAULT_FILE_MODE);
        }
    }

    if (process.platform !== 'win32') {
        for (const entry of entries) {
            if (!entry.isDirectory) continue;
            const target = resolveEntryPath(destDir, entry.name);
            const mode = entry.unixMode !== null ? entry.unixMode & 0o7777 : DEFAULT_DIR_MODE;
            await fs.promises.chmod(target, mode || DEFAULT_DIR_MODE);
        }
    }
}
