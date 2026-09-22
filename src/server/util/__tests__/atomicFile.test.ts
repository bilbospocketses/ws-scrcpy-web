import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSystemTool } from '../../service/systemTools';
import { copyFileAtomic, copyFileAtomicSync, writeFileAtomicSync } from '../atomicFile';

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
    // This used to clear the hidden attribute off every entry first, on the
    // stated grounds that "a hidden leftover would otherwise trip rmSync".
    // MEASURED 2026-09-22, and it is not true: `fs.rmSync(.., {force: true})`
    // deletes a hidden file, a read-only file, and a hidden+read-only file
    // without complaint -- `force` already clears the read-only attribute, and
    // hidden never blocked deletion in the first place. The loop was guarding
    // against nothing.
    //
    // It was not free, either. Each `attrib` spawn costs ~343 ms on this box
    // even IDLE -- endpoint AV sits in the process-creation path -- so a
    // teardown that spawns once per file ran up seconds per test and was the
    // single largest contributor to item 140's `Hook timed out in 10000ms`
    // failures under load. `setHidden`/`isHidden` still shell out, but those
    // are the subject under test rather than bookkeeping, and they run once.
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
 * The async twin, for the one caller that copies thousands of files while the
 * server is answering requests (DependencyManager.copyDirContents). Same
 * temp-then-rename contract; the difference is that every step goes through
 * fs.promises, so the event loop turns between them.
 */
describe('copyFileAtomic', () => {
    it('copies to a new path, creating missing parents', async () => {
        const src = path.join(dir, 'src.bin');
        const dest = path.join(dir, 'a', 'b', 'dest.bin');
        fs.writeFileSync(src, 'payload');
        await copyFileAtomic(src, dest);
        expect(fs.readFileSync(dest, 'utf8')).toBe('payload');
    });

    it('overwrites an existing file', async () => {
        const src = path.join(dir, 'src.bin');
        const dest = path.join(dir, 'dest.bin');
        fs.writeFileSync(src, 'new');
        fs.writeFileSync(dest, 'old');
        await copyFileAtomic(src, dest);
        expect(fs.readFileSync(dest, 'utf8')).toBe('new');
    });

    it('leaves no temp files behind, on success and on failure', async () => {
        const src = path.join(dir, 'src.bin');
        const dest = path.join(dir, 'dest.bin');
        fs.writeFileSync(src, 'payload');
        await copyFileAtomic(src, dest);
        expect(fs.readdirSync(dir).sort()).toEqual(['dest.bin', 'src.bin']);

        await expect(copyFileAtomic(path.join(dir, 'missing.bin'), path.join(dir, 'other.bin'))).rejects.toThrow(
            /ENOENT/,
        );
        expect(fs.readdirSync(dir).sort()).toEqual(['dest.bin', 'src.bin']);
    });

    it('does not block the event loop while it runs', async () => {
        const src = path.join(dir, 'src.bin');
        const dest = path.join(dir, 'dest.bin');
        fs.writeFileSync(src, 'payload');
        let finished = false;
        let macrotaskRanBeforeFinish = false;
        setImmediate(() => {
            macrotaskRanBeforeFinish = !finished;
        });
        await copyFileAtomic(src, dest);
        finished = true;
        await new Promise<void>((r) => setImmediate(r));
        expect(macrotaskRanBeforeFinish).toBe(true);
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

/**
 * Item 140. These three helpers already defended against one cause of `EPERM`
 * on Windows -- a destination whose HIDDEN or READONLY attribute refuses the
 * write -- by writing a temp sibling and renaming over it. Windows reports a
 * second, unrelated condition with the same errno: the rename itself is
 * refused while another process holds a handle on the source or destination,
 * which in practice is a real-time scanner that opened our temp file
 * microseconds after we created it. Renaming cannot fix that, because renaming
 * is the operation being refused.
 *
 * It presented for weeks as three unrelated flaky tests. Measured 2026-09-22:
 * 17 clean full-suite runs on a quiet machine, then 1 failing run in 3 with
 * the CPU pinned at 100%, every failure an `EPERM ... rename` out of one of
 * these functions and a different caller each time. Load widens the window; it
 * is not the cause.
 *
 * The rename is injected rather than spied: `vi.spyOn(fs, 'renameSync')` throws
 * `Cannot spy on export "renameSync". Module namespace is not configurable in
 * ESM`. Injecting also makes these tests drive the REAL public functions, so
 * they prove the retry is wired in and not merely that the policy is correct
 * in isolation.
 */
describe('rename retry on a transient sharing violation (item 140)', () => {
    function eperm(): NodeJS.ErrnoException {
        return Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }

    /** A rename that fails `failures` times with EPERM, then really renames. */
    function flakyRename(failures: number): { impl: (f: string, t: string) => void; calls: () => number } {
        let calls = 0;
        return {
            impl: (from: string, to: string) => {
                calls += 1;
                if (calls <= failures) throw eperm();
                fs.renameSync(from, to);
            },
            calls: () => calls,
        };
    }

    it('writeFileAtomicSync survives a rename that fails twice and then succeeds', () => {
        const dest = path.join(dir, 'config.json');
        fs.writeFileSync(dest, 'old');
        const flaky = flakyRename(2);

        writeFileAtomicSync(dest, 'new', undefined, flaky.impl);

        expect(flaky.calls()).toBe(3);
        expect(fs.readFileSync(dest, 'utf8')).toBe('new');
        // The write landed AND the two failed attempts left nothing behind. A
        // retry leaking a temp per attempt shows up here, not in the content.
        expect(fs.readdirSync(dir)).toEqual(['config.json']);
    });

    it('gives up and rethrows once the budget is exhausted, leaving the old file intact', () => {
        const dest = path.join(dir, 'config.json');
        fs.writeFileSync(dest, 'old');
        let calls = 0;
        const always = () => {
            calls += 1;
            throw eperm();
        };

        expect(() => writeFileAtomicSync(dest, 'new', undefined, always)).toThrow(/EPERM/);

        // Bounded: 1 initial attempt + 6 backoff steps. Pinning the number is
        // what stops a well-meaning "retry until it works" turning a genuine
        // permission error into a hang.
        expect(calls).toBe(7);
        // Never a partial destination -- the point of temp-then-rename.
        expect(fs.readFileSync(dest, 'utf8')).toBe('old');
        expect(fs.readdirSync(dir)).toEqual(['config.json']);
    });

    it('does NOT retry an error that is not a sharing violation', () => {
        const dest = path.join(dir, 'config.json');
        let calls = 0;
        const enoent = () => {
            calls += 1;
            throw Object.assign(new Error('ENOENT: no such file or directory, rename'), { code: 'ENOENT' });
        };

        expect(() => writeFileAtomicSync(dest, 'new', undefined, enoent)).toThrow(/ENOENT/);

        // Exactly one attempt. Retrying ENOENT would only delay a real error by
        // the whole budget, and this is what would catch a retry predicate
        // widened to "any error".
        expect(calls).toBe(1);
    });

    it('copyFileAtomicSync retries on the same terms', () => {
        const src = path.join(dir, 'src.bin');
        const dest = path.join(dir, 'dest.bin');
        fs.writeFileSync(src, 'new');
        fs.writeFileSync(dest, 'old');
        const flaky = flakyRename(1);

        copyFileAtomicSync(src, dest, flaky.impl);

        expect(flaky.calls()).toBe(2);
        expect(fs.readFileSync(dest, 'utf8')).toBe('new');
        expect(fs.readdirSync(dir).sort()).toEqual(['dest.bin', 'src.bin']);
    });

    it('copyFileAtomic (async) retries without blocking, on the same terms', async () => {
        const src = path.join(dir, 'src.bin');
        const dest = path.join(dir, 'dest.bin');
        fs.writeFileSync(src, 'new');
        fs.writeFileSync(dest, 'old');
        let calls = 0;
        const flaky = async (from: string, to: string): Promise<void> => {
            calls += 1;
            if (calls === 1) throw eperm();
            await fs.promises.rename(from, to);
        };

        await copyFileAtomic(src, dest, flaky);

        expect(calls).toBe(2);
        expect(fs.readFileSync(dest, 'utf8')).toBe('new');
        expect(fs.readdirSync(dir).sort()).toEqual(['dest.bin', 'src.bin']);
    });
});
