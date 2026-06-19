import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    _resetForTest,
    _setSeedRootForTest,
    dataRootPackageDir,
    getHostInfo,
    packageHasBinary,
    resolveNodePty,
} from '../NodePtyResolver';

/**
 * v0.1.23-stable Approach C: integration coverage for the seed → dataRoot
 * → load happy path. The download/overlay branch is exercised in unit
 * tests for the helpers; the network-fixture-based tests from the
 * pre-Approach-C era are gone since the resolver no longer takes a
 * download-first path on first launch.
 *
 * Seed source: the live `node_modules/node-pty/` and `node-addon-api/`
 * the dev tree already has (vitest globalSetup ensures node-pty's
 * postinstall has placed pty.node). We mock `seedPackageRoot()` to
 * point at a temp dir where we mirror the seed layout.
 */
describe('NodePtyResolver — integration (seed → dataRoot)', () => {
    let tempDepsPath: string;
    let fakeSeedRoot: string;

    beforeEach(() => {
        _resetForTest();
        tempDepsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepty-deps-'));
        fakeSeedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepty-seed-'));

        // Mirror the production seed layout:
        //   <seedRoot>/node_modules/node-pty/
        //   <seedRoot>/node_modules/node-addon-api/
        const seedNodeModules = path.join(fakeSeedRoot, 'node_modules');
        fs.mkdirSync(seedNodeModules, { recursive: true });
        const liveNm = path.join(process.cwd(), 'node_modules');
        fs.cpSync(path.join(liveNm, 'node-pty'), path.join(seedNodeModules, 'node-pty'), { recursive: true });
        fs.cpSync(path.join(liveNm, 'node-addon-api'), path.join(seedNodeModules, 'node-addon-api'), {
            recursive: true,
        });
        _setSeedRootForTest(fakeSeedRoot);
    });

    afterEach(() => {
        _setSeedRootForTest(null);
        try {
            fs.rmSync(tempDepsPath, { recursive: true, force: true });
        } catch {}
        try {
            fs.rmSync(fakeSeedRoot, { recursive: true, force: true });
        } catch {}
    });

    it('first launch stages seed → dataRoot and loads node-pty', async () => {
        const handle = await resolveNodePty(tempDepsPath);

        expect(handle.reason).toBeUndefined();
        expect(handle.available).toBe(true);
        expect(typeof (handle.pty as any).spawn).toBe('function');

        // Verify staging actually happened in dataRoot (not in install
        // root / process.cwd()/node_modules — the architectural concern).
        const host = getHostInfo();
        // The seed's node-pty package.json reports its real version; the
        // resolver uses that to compute the package dir, so we read it
        // back from the seed to construct the expected path.
        const seedPkg = JSON.parse(
            fs.readFileSync(path.join(fakeSeedRoot, 'node_modules', 'node-pty', 'package.json'), 'utf8'),
        ) as { version: string };
        const expectedPkgDir = dataRootPackageDir(tempDepsPath, seedPkg.version, host);
        expect(packageHasBinary(expectedPkgDir)).toBe(true);
    });

    it('second launch is idempotent — copySeedToDataRoot short-circuits', async () => {
        await resolveNodePty(tempDepsPath);

        // Capture the staged pty.node's mtime; second launch should not
        // touch it (copySeedToDataRoot short-circuits when target has the
        // binary already).
        const host = getHostInfo();
        const seedPkg = JSON.parse(
            fs.readFileSync(path.join(fakeSeedRoot, 'node_modules', 'node-pty', 'package.json'), 'utf8'),
        ) as { version: string };
        const ptyNodeFile = path.join(
            dataRootPackageDir(tempDepsPath, seedPkg.version, host),
            'node_modules',
            'node-pty',
            'build',
            'Release',
            'pty.node',
        );
        const mtimeBefore = fs.statSync(ptyNodeFile).mtimeMs;

        _resetForTest();
        const handle = await resolveNodePty(tempDepsPath);
        expect(handle.available).toBe(true);

        const mtimeAfter = fs.statSync(ptyNodeFile).mtimeMs;
        expect(mtimeAfter).toBe(mtimeBefore);
    });

    it('returns reason=no-seed-package when seed has no package.json', async () => {
        // Wipe the staged seed so readSeedNodePtyVersion returns null.
        fs.rmSync(fakeSeedRoot, { recursive: true, force: true });
        fs.mkdirSync(fakeSeedRoot, { recursive: true });

        _resetForTest();
        const handle = await resolveNodePty(tempDepsPath);
        expect(handle.available).toBe(false);
        expect(handle.reason).toBe('no-seed-package');
    });
});
