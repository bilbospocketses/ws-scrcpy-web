import { createHash } from 'crypto';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_VERSION } from '../../common/Constants';
import { DependencyStatus } from '../../common/DependencyTypes';
import { DependencyManager } from '../DependencyManager';
import { getInstalledScrcpyServerVersion, readScrcpyServerVersionMarker } from '../scrcpyServerVersion';

/**
 * Before 2026-10-07 the seed promote copied the bundled jar into
 * <deps>/scrcpy-server/ and wrote no `.version` marker, and
 * getInstalledScrcpyServerVersion answered a marker-less jar with
 * SERVER_VERSION. So once SERVER_VERSION went 4.1 -> 5.0, every such install
 * (Docker's persistent /data/dependencies included) would have started its
 * 4.1 jar with "5.0" -- which scrcpy refuses outright -- and the panel would
 * have reported 5.0 and offered no update.
 *
 * The 4.1 jar is not in the tree any more, so its pin is replaced here by the
 * hash of a stand-in; the real 4.1 pin is checked against scrcpy's own list in
 * dependencyManager.signatures.test.ts. The 5.0 cases use the real vendored jar.
 */
const { FAKE_41_JAR } = vi.hoisted(() => ({ FAKE_41_JAR: 'stand-in for the scrcpy-server v4.1 jar' }));

vi.mock('../../common/Constants', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../common/Constants')>();
    const { createHash: hash } = await import('crypto');
    return {
        ...actual,
        SERVER_JAR_SHA256: {
            ...actual.SERVER_JAR_SHA256,
            '4.1': hash('sha256').update(FAKE_41_JAR).digest('hex'),
        },
    };
});

vi.mock('../service/elevatedRunner', () => ({
    launcherIsAvailable: vi.fn(async () => true),
    resolveLauncherPath: () => '/fake/launcher.exe',
}));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VENDORED_JAR = path.join(REPO_ROOT, 'assets', 'scrcpy-server');
const SEED_BYTES = 'seed-jar-bytes';
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

describe('scrcpy-server version marker: written on promote, repaired at boot', () => {
    let root: string;
    let depsPath: string;
    let seedFile: string;
    let jar: string;
    let marker: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'wssw-marker-repair-'));
        depsPath = path.join(root, 'deps');
        fs.mkdirSync(depsPath);
        seedFile = path.join(root, 'seed', 'scrcpy-server', 'scrcpy-server');
        fs.mkdirSync(path.dirname(seedFile), { recursive: true });
        fs.writeFileSync(seedFile, SEED_BYTES);
        vi.spyOn(DependencyManager, 'seedScrcpyServerPath').mockReturnValue(seedFile);
        jar = path.join(depsPath, 'scrcpy-server', 'scrcpy-server');
        marker = path.join(depsPath, 'scrcpy-server', '.version');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    /** A jar on disk with no marker beside it: what an earlier build's seed promote left. */
    function placeJar(bytes: string | Buffer): void {
        fs.mkdirSync(path.dirname(jar), { recursive: true });
        fs.writeFileSync(jar, bytes);
    }

    it('the seed promote records SERVER_VERSION in the marker', async () => {
        const mgr = new DependencyManager(depsPath);
        vi.spyOn(mgr, 'update').mockResolvedValue({ success: true, newVersion: 'stub', requiresRestart: false });
        const scrcpy = mgr.getByName('scrcpy-server')!;
        scrcpy.installedVersion = null;
        scrcpy.latestVersion = SERVER_VERSION;

        await mgr.autoInstallMissing();

        expect(fs.readFileSync(jar, 'utf8')).toBe(SEED_BYTES);
        // The file itself, not getInstalledScrcpyServerVersion, whose fallback
        // would read SERVER_VERSION with no marker at all.
        expect(readScrcpyServerVersionMarker(depsPath)).toBe(SERVER_VERSION);
    });

    it('a marker-less jar with the 4.1 pin is recorded as 4.1, kept, and offered SERVER_VERSION as an update', async () => {
        placeJar(FAKE_41_JAR);
        const mgr = new DependencyManager(depsPath);

        mgr.repairScrcpyServerVersionMarker();

        expect(readScrcpyServerVersionMarker(depsPath)).toBe('4.1');
        expect(getInstalledScrcpyServerVersion(depsPath)).toBe('4.1');
        expect(fs.readFileSync(jar, 'utf8')).toBe(FAKE_41_JAR);

        // The panel: installed 4.1, and GitHub's newest release reported as the
        // version this build ships, so the row offers the update.
        vi.spyOn(global, 'fetch').mockImplementation(
            async () => new Response(JSON.stringify({ tag_name: `v${SERVER_VERSION}` }), { status: 200 }),
        );
        await mgr.checkInstalled('scrcpy-server');
        await mgr.checkLatest('scrcpy-server');
        const info = mgr.getByName('scrcpy-server')!;
        expect(info.installedVersion).toBe('4.1');
        expect(info.latestVersion).toBe(SERVER_VERSION);
        expect(info.status).toBe(DependencyStatus.UpdateAvailable);
    });

    it('a marker-less copy of the vendored jar is recorded as SERVER_VERSION and kept', () => {
        const vendored = fs.readFileSync(VENDORED_JAR);
        placeJar(vendored);
        const mgr = new DependencyManager(depsPath);

        mgr.repairScrcpyServerVersionMarker();

        expect(SERVER_VERSION).toBe('5.0');
        expect(readScrcpyServerVersionMarker(depsPath)).toBe('5.0');
        expect(sha256(fs.readFileSync(jar))).toBe(sha256(vendored));
    });

    it('a marker-less jar matching no pin is replaced by the seed, recorded as SERVER_VERSION', () => {
        placeJar('some jar nothing pins');
        const mgr = new DependencyManager(depsPath);

        mgr.repairScrcpyServerVersionMarker();

        expect(fs.readFileSync(jar, 'utf8')).toBe(SEED_BYTES);
        expect(readScrcpyServerVersionMarker(depsPath)).toBe(SERVER_VERSION);
    });

    it('a marker-less jar that cannot be read is replaced by the seed, recorded as SERVER_VERSION', () => {
        placeJar(FAKE_41_JAR);
        const realRead = fs.readFileSync;
        vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
            if (p === jar) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
        }) as typeof fs.readFileSync);
        const mgr = new DependencyManager(depsPath);

        mgr.repairScrcpyServerVersionMarker();
        vi.mocked(fs.readFileSync).mockRestore();

        expect(fs.readFileSync(jar, 'utf8')).toBe(SEED_BYTES);
        expect(readScrcpyServerVersionMarker(depsPath)).toBe(SERVER_VERSION);
    });

    it('a jar WITH a marker is left exactly as it is, and never hashed', () => {
        placeJar('some jar nothing pins');
        fs.writeFileSync(marker, '4.0');
        const read = vi.spyOn(fs, 'readFileSync');
        const mgr = new DependencyManager(depsPath);

        mgr.repairScrcpyServerVersionMarker();

        expect(read.mock.calls.some(([p]) => p === jar)).toBe(false);
        read.mockRestore();
        expect(fs.readFileSync(marker, 'utf8')).toBe('4.0');
        expect(fs.readFileSync(jar, 'utf8')).toBe('some jar nothing pins');
    });

    it('with no jar installed it writes nothing: the install that brings one writes its marker', () => {
        const mgr = new DependencyManager(depsPath);

        mgr.repairScrcpyServerVersionMarker();

        expect(fs.existsSync(jar)).toBe(false);
        expect(fs.existsSync(marker)).toBe(false);
    });

    it('a marker-less unknown jar with no seed to replace it is left alone, and boot is not stopped', () => {
        vi.mocked(DependencyManager.seedScrcpyServerPath).mockReturnValue(path.join(root, 'no-such-seed'));
        placeJar('some jar nothing pins');
        const mgr = new DependencyManager(depsPath);

        expect(() => mgr.repairScrcpyServerVersionMarker()).not.toThrow();

        expect(fs.readFileSync(jar, 'utf8')).toBe('some jar nothing pins');
        expect(fs.existsSync(marker)).toBe(false);
    });
});

describe('index.ts runs the marker repair before anything can probe or stream', () => {
    it('calls it right after the dependency manager is built, before the services start', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'server', 'index.ts'), 'utf8');
        const built = src.indexOf('const depManager = getDependencyManager(');
        const repaired = src.indexOf('depManager.repairScrcpyServerVersionMarker();');
        const servicesStart = src.indexOf('reconcileWebPort(config)');
        expect(built).toBeGreaterThan(-1);
        expect(repaired).toBeGreaterThan(built);
        expect(servicesStart).toBeGreaterThan(repaired);
    });
});
