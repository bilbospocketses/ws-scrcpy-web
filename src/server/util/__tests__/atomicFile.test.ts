import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSystemTool } from '../../service/systemTools';
import { copyFileAtomicSync, writeFileAtomicSync } from '../atomicFile';

/**
 * Resolved through the repo's own `resolveSystemTool` rather than a hardcoded
 * path: OS tools get an absolute path (System32 on Windows, via `%SystemRoot%`)
 * instead of a bare name that would resolve through `%PATH%`. That is what the
 * Local-Dependencies-Only rule requires and what review #20 added the helper
 * for — `taskkill` and `icacls` already go through it.
 *
 * Test-only scaffolding: this is used to *create* the hidden condition. The fix
 * itself is pure `fs` and shells out to nothing, which is precisely why no
 * binary has to be vendored for a deployed endpoint.
 */
const ATTRIB = resolveSystemTool('attrib');
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

    it('writeFileAtomicSync overwrites a hidden destination and clears the attribute (windows)', () => {
        const dest = path.join(dir, 'dest.txt');
        fs.writeFileSync(dest, 'old');
        setHidden(dest);

        writeFileAtomicSync(dest, 'new');

        expect(fs.readFileSync(dest, 'utf8')).toBe('new');
        expect(isHidden(dest)).toBe(false);
    });
});

/**
 * Replacing by rename installs a new inode, so the destination's permissions
 * have to be carried across deliberately — otherwise the replacement would
 * silently adopt the writing process's umask, which `fs.writeFileSync` and
 * `fs.copyFileSync` never do. Windows only models the read-only bit, so this
 * is POSIX-only; CI runs on ubuntu-latest, so it does get exercised.
 */
describe.runIf(!isWindows)('mode preservation (POSIX)', () => {
    it('writeFileAtomicSync keeps the destination mode', () => {
        const dest = path.join(dir, 'modes.txt');
        fs.writeFileSync(dest, 'old');
        fs.chmodSync(dest, 0o600);

        writeFileAtomicSync(dest, 'new');

        expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(dest, 'utf8')).toBe('new');
    });

    it('copyFileAtomicSync adopts the source mode, matching fs.copyFileSync', () => {
        const src = path.join(dir, 'src.bin');
        const dest = path.join(dir, 'dest.bin');
        fs.writeFileSync(src, 'new');
        fs.chmodSync(src, 0o755);
        fs.writeFileSync(dest, 'old');
        fs.chmodSync(dest, 0o600);

        copyFileAtomicSync(src, dest);

        // Pinned against the real fs.copyFileSync rather than a literal, so the
        // two can't drift. Note this is the OPPOSITE of writeFileAtomicSync:
        // libuv fchmods the destination to match the source, so the 0o600 does
        // not survive a copy the way it survives a write.
        const control = path.join(dir, 'control.bin');
        fs.writeFileSync(control, 'old');
        fs.chmodSync(control, 0o600);
        fs.copyFileSync(src, control);

        expect(fs.statSync(dest).mode & 0o777).toBe(fs.statSync(control).mode & 0o777);
        expect(fs.statSync(dest).mode & 0o777).toBe(0o755);
        expect(fs.readFileSync(dest, 'utf8')).toBe('new');
    });

    it('an explicit mode from the caller outranks preservation', () => {
        const dest = path.join(dir, 'explicit.txt');
        fs.writeFileSync(dest, 'old');
        fs.chmodSync(dest, 0o600);

        writeFileAtomicSync(dest, 'new', { mode: 0o640 });

        // Compared against a plain writeFileSync with the same mode rather than
        // against 0o640 literally, so the assertion holds under any umask.
        const control = path.join(dir, 'control.txt');
        fs.writeFileSync(control, 'x', { mode: 0o640 });
        expect(fs.statSync(dest).mode & 0o777).toBe(fs.statSync(control).mode & 0o777);
        expect(fs.statSync(dest).mode & 0o777).not.toBe(0o600);
    });
});
