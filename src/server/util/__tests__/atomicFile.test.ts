import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileAtomicSync, writeFileAtomicSync } from '../atomicFile';

/**
 * Absolute path rather than a bare `attrib` — same reason
 * `scripts/fetch-node.mjs` pins `C:\Windows\System32\tar.exe`: the
 * Local-Dependencies-Only rule forbids resolving binaries through the system
 * PATH. This is test-only scaffolding; nothing in `src/` shells out to it.
 */
const ATTRIB = 'C:\\Windows\\System32\\attrib.exe';
const isWindows = process.platform === 'win32';

function setHidden(file: string): void {
    execFileSync(ATTRIB, ['+h', file], { windowsHide: true });
}

function isHidden(file: string): boolean {
    // `attrib <file>` prints the attribute letters in a fixed-width prefix,
    // e.g. "A    H        C:\path\to\file".
    const out = execFileSync(ATTRIB, [file], { windowsHide: true, encoding: 'utf8' });
    return /^.{0,20}H/.test(out);
}

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicfile-'));
});

afterEach(() => {
    // Clear attributes first: a hidden leftover would otherwise trip rmSync.
    if (isWindows && fs.existsSync(dir)) {
        for (const entry of fs.readdirSync(dir)) {
            try {
                execFileSync(ATTRIB, ['-h', path.join(dir, entry)], { windowsHide: true });
            } catch {
                /* best-effort */
            }
        }
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomicSync', () => {
    it('writes a new file', () => {
        const dest = path.join(dir, 'new.txt');
        writeFileAtomicSync(dest, 'payload');
        expect(fs.readFileSync(dest, 'utf8')).toBe('payload');
    });

    it('creates missing parent directories', () => {
        const dest = path.join(dir, 'a', 'b', 'deep.txt');
        writeFileAtomicSync(dest, 'payload');
        expect(fs.readFileSync(dest, 'utf8')).toBe('payload');
    });

    it('overwrites an existing file', () => {
        const dest = path.join(dir, 'existing.txt');
        fs.writeFileSync(dest, 'old');
        writeFileAtomicSync(dest, 'new');
        expect(fs.readFileSync(dest, 'utf8')).toBe('new');
    });

    it('leaves no temp files behind', () => {
        const dest = path.join(dir, 'clean.txt');
        writeFileAtomicSync(dest, 'payload');
        expect(fs.readdirSync(dir)).toEqual(['clean.txt']);
    });
});

describe('copyFileAtomicSync', () => {
    it('copies to a new path', () => {
        const src = path.join(dir, 'src.bin');
        const dest = path.join(dir, 'dest.bin');
        fs.writeFileSync(src, 'payload');
        copyFileAtomicSync(src, dest);
        expect(fs.readFileSync(dest, 'utf8')).toBe('payload');
    });

    it('overwrites an existing file', () => {
        const src = path.join(dir, 'src.bin');
        const dest = path.join(dir, 'dest.bin');
        fs.writeFileSync(src, 'new');
        fs.writeFileSync(dest, 'old');
        copyFileAtomicSync(src, dest);
        expect(fs.readFileSync(dest, 'utf8')).toBe('new');
    });

    it('leaves no temp files behind', () => {
        const src = path.join(dir, 'src.bin');
        const dest = path.join(dir, 'dest.bin');
        fs.writeFileSync(src, 'payload');
        copyFileAtomicSync(src, dest);
        expect(fs.readdirSync(dir).sort()).toEqual(['dest.bin', 'src.bin']);
    });
});

/**
 * The reason this module exists. Windows refuses
 * `CreateFile(CREATE_ALWAYS)` and `CopyFileEx` when the destination already
 * exists and carries FILE_ATTRIBUTE_HIDDEN — both surface through Node as
 * EPERM. Every file under the app's `dependencies/` tree was found hidden on
 * a real machine, which broke the dependency updater outright (it could not
 * overwrite its own binaries) and silently broke the node-pty manifest
 * refresh on every boot.
 */
describe.runIf(isWindows)('hidden destinations (Windows)', () => {
    it('raw fs calls fail on a hidden destination — the bug being fixed', () => {
        const src = path.join(dir, 'src.bin');
        const dest = path.join(dir, 'dest.bin');
        fs.writeFileSync(src, 'new');
        fs.writeFileSync(dest, 'old');
        setHidden(dest);

        expect(() => fs.copyFileSync(src, dest)).toThrow(/EPERM/);
        expect(() => fs.writeFileSync(dest, 'new')).toThrow(/EPERM/);
    });

    it('copyFileAtomicSync overwrites a hidden destination and clears the attribute', () => {
        const src = path.join(dir, 'src.bin');
        const dest = path.join(dir, 'dest.bin');
        fs.writeFileSync(src, 'new');
        fs.writeFileSync(dest, 'old');
        setHidden(dest);

        copyFileAtomicSync(src, dest);

        expect(fs.readFileSync(dest, 'utf8')).toBe('new');
        expect(isHidden(dest)).toBe(false);
    });

    it('writeFileAtomicSync overwrites a hidden destination and clears the attribute', () => {
        const dest = path.join(dir, 'dest.txt');
        fs.writeFileSync(dest, 'old');
        setHidden(dest);

        writeFileAtomicSync(dest, 'new');

        expect(fs.readFileSync(dest, 'utf8')).toBe('new');
        expect(isHidden(dest)).toBe(false);
    });
});
