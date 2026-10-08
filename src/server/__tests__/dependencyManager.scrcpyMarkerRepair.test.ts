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
import { copyFileAtomicSync } from '../util/atomicFile';
import { sha256FileSync } from '../verifySha256';

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
 * dependencyManager.signatures.test.ts. The 5.0 cases, and the seed (which is
 * hashed and must match a pin since 2026-10-08), use the real vendored jar.
 */
const h = vi.hoisted(() => ({
    FAKE_41_JAR: 'stand-in for the scrcpy-server v4.1 jar',
    /** Paths whose hashing throws, as an unreadable file does. */
    unreadable: new Set<string>(),
    /** When set, a write to a path it accepts throws. */
    writeFails: null as null | ((p: string) => boolean),
    /** Called before every atomic copy, with its destination. */
    onCopy: null as null | ((dest: string) => void),
}));

vi.mock('../../common/Constants', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../common/Constants')>();
    const { createHash: hash } = await import('crypto');
    return {
        ...actual,
        SERVER_JAR_SHA256: {
            ...actual.SERVER_JAR_SHA256,
            '4.1': hash('sha256').update(h.FAKE_41_JAR).digest('hex'),
        },
    };
});

// The real helpers, wrapped: every hash of a jar or seed goes through
// sha256FileSync, and every jar and marker write through atomicFile, in every
// module that does one -- so these spies see all of them.
vi.mock('../verifySha256', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../verifySha256')>();
    return {
        ...actual,
        sha256FileSync: vi.fn((p: string) => {
            if (h.unreadable.has(p)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            return actual.sha256FileSync(p);
        }),
    };
});

vi.mock('../util/atomicFile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../util/atomicFile')>();
    return {
        ...actual,
        copyFileAtomicSync: vi.fn((src: string, dest: string) => {
            h.onCopy?.(dest);
            actual.copyFileAtomicSync(src, dest);
        }),
        writeFileAtomicSync: vi.fn((dest: string, ...rest: unknown[]) => {
            if (h.writeFails?.(dest)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
            (actual.writeFileAtomicSync as (...a: unknown[]) => void)(dest, ...rest);
        }),
    };
});

vi.mock('../service/elevatedRunner', () => ({
    launcherIsAvailable: vi.fn(async () => true),
    resolveLauncherPath: () => '/fake/launcher.exe',
}));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VENDORED_JAR = path.join(REPO_ROOT, 'assets', 'scrcpy-server');
const VENDORED = fs.readFileSync(VENDORED_JAR);
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const VENDORED_SHA = sha256(VENDORED);
const UNPINNED = 'some jar nothing pins';

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
        fs.writeFileSync(seedFile, VENDORED);
        vi.spyOn(DependencyManager, 'seedScrcpyServerPath').mockReturnValue(seedFile);
        jar = path.join(depsPath, 'scrcpy-server', 'scrcpy-server');
        marker = path.join(depsPath, 'scrcpy-server', '.version');
        h.unreadable.clear();
        h.writeFails = null;
        h.onCopy = null;
        vi.mocked(sha256FileSync).mockClear();
        vi.mocked(copyFileAtomicSync).mockClear();
    });

    afterEach(() => {
        h.unreadable.clear();
        h.writeFails = null;
        h.onCopy = null;
        vi.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    /** A jar on disk with no marker beside it: what an earlier build's seed promote left. */
    function placeJar(bytes: string | Buffer): void {
        fs.mkdirSync(path.dirname(jar), { recursive: true });
        fs.writeFileSync(jar, bytes);
    }

    function hashedPaths(): string[] {
        return vi.mocked(sha256FileSync).mock.calls.map(([p]) => p);
    }

    function copiedTo(): string[] {
        return vi.mocked(copyFileAtomicSync).mock.calls.map(([, dest]) => dest);
    }

    /** A manager whose first-run state is "scrcpy-server not installed, latest known". */
    function managerWithScrcpyMissing(opts: { inContainer?: boolean } = {}): {
        mgr: DependencyManager;
        update: ReturnType<typeof vi.spyOn>;
    } {
        const mgr = new DependencyManager(depsPath, opts);
        const update = vi.spyOn(mgr, 'update').mockResolvedValue({
            success: true,
            newVersion: 'stub',
            requiresRestart: false,
        });
        const scrcpy = mgr.getByName('scrcpy-server')!;
        scrcpy.installedVersion = null;
        scrcpy.latestVersion = SERVER_VERSION;
        return { mgr, update };
    }

    function githubLatestIs(version: string): void {
        vi.spyOn(global, 'fetch').mockImplementation(
            async () => new Response(JSON.stringify({ tag_name: `v${version}` }), { status: 200 }),
        );
    }

    it('the seed promote records the seed version in the marker', async () => {
        const { mgr } = managerWithScrcpyMissing();

        await mgr.autoInstallMissing();

        expect(sha256(fs.readFileSync(jar))).toBe(VENDORED_SHA);
        // The file itself, not getInstalledScrcpyServerVersion, which would
        // also identify the jar by its hash with no marker at all.
        expect(readScrcpyServerVersionMarker(depsPath)).toBe(SERVER_VERSION);
    });

    it('a marker-less jar with the 4.1 pin is recorded as 4.1, kept, and offered SERVER_VERSION as an update', async () => {
        placeJar(h.FAKE_41_JAR);
        const mgr = new DependencyManager(depsPath);

        mgr.repairScrcpyServerVersionMarker();

        expect(readScrcpyServerVersionMarker(depsPath)).toBe('4.1');
        expect(getInstalledScrcpyServerVersion(depsPath)).toBe('4.1');
        expect(fs.readFileSync(jar, 'utf8')).toBe(h.FAKE_41_JAR);

        // The panel: installed 4.1, and GitHub's newest release reported as the
        // version this build ships, so the row offers the update.
        githubLatestIs(SERVER_VERSION);
        await mgr.checkInstalled('scrcpy-server');
        await mgr.checkLatest('scrcpy-server');
        const info = mgr.getByName('scrcpy-server')!;
        expect(info.installedVersion).toBe('4.1');
        expect(info.latestVersion).toBe(SERVER_VERSION);
        expect(info.status).toBe(DependencyStatus.UpdateAvailable);
    });

    it('a marker-less copy of the vendored jar is recorded as SERVER_VERSION and kept', () => {
        placeJar(VENDORED);
        const mgr = new DependencyManager(depsPath);

        mgr.repairScrcpyServerVersionMarker();

        expect(SERVER_VERSION).toBe('5.0');
        expect(readScrcpyServerVersionMarker(depsPath)).toBe('5.0');
        expect(sha256(fs.readFileSync(jar))).toBe(VENDORED_SHA);
        expect(copiedTo()).toEqual([]);
    });

    it('a marker-less jar matching no pin is replaced by the seed, recorded as SERVER_VERSION', () => {
        placeJar(UNPINNED);
        const mgr = new DependencyManager(depsPath);

        mgr.repairScrcpyServerVersionMarker();

        expect(sha256(fs.readFileSync(jar))).toBe(VENDORED_SHA);
        expect(readScrcpyServerVersionMarker(depsPath)).toBe(SERVER_VERSION);
    });

    it('a marker-less jar that cannot be read is replaced by the seed, recorded as SERVER_VERSION', () => {
        placeJar(h.FAKE_41_JAR);
        h.unreadable.add(jar);
        const mgr = new DependencyManager(depsPath);

        mgr.repairScrcpyServerVersionMarker();

        expect(hashedPaths()).toContain(jar);
        h.unreadable.clear();
        expect(sha256(fs.readFileSync(jar))).toBe(VENDORED_SHA);
        expect(readScrcpyServerVersionMarker(depsPath)).toBe(SERVER_VERSION);
    });

    it('outside a container, a jar WITH a marker is left exactly as it is, and nothing is hashed', () => {
        placeJar(UNPINNED);
        fs.writeFileSync(marker, '4.0');
        const mgr = new DependencyManager(depsPath);

        mgr.repairScrcpyServerVersionMarker();

        // The hashing helper every jar and seed hash goes through.
        expect(hashedPaths()).toEqual([]);
        expect(copiedTo()).toEqual([]);
        expect(fs.readFileSync(marker, 'utf8')).toBe('4.0');
        expect(fs.readFileSync(jar, 'utf8')).toBe(UNPINNED);
    });

    it('with no jar installed it writes nothing: the install that brings one writes its marker', () => {
        const mgr = new DependencyManager(depsPath);

        mgr.repairScrcpyServerVersionMarker();

        expect(fs.existsSync(jar)).toBe(false);
        expect(fs.existsSync(marker)).toBe(false);
    });

    it('a marker-less unknown jar with no seed to replace it is left alone, and boot is not stopped', () => {
        vi.mocked(DependencyManager.seedScrcpyServerPath).mockReturnValue(path.join(root, 'no-such-seed'));
        placeJar(UNPINNED);
        const mgr = new DependencyManager(depsPath);

        expect(() => mgr.repairScrcpyServerVersionMarker()).not.toThrow();

        expect(fs.readFileSync(jar, 'utf8')).toBe(UNPINNED);
        expect(fs.existsSync(marker)).toBe(false);
    });

    describe('M1: a jar whose marker could not be written is still identified by its hash', () => {
        it('the repair cannot write the marker: the pinned 4.1 jar is still reported and launched as 4.1', async () => {
            placeJar(h.FAKE_41_JAR);
            h.writeFails = (p) => p === marker;
            const mgr = new DependencyManager(depsPath);

            expect(() => mgr.repairScrcpyServerVersionMarker()).not.toThrow();

            expect(fs.existsSync(marker)).toBe(false);
            // DeviceProbe and ScrcpyConnection launch with exactly this value.
            expect(getInstalledScrcpyServerVersion(depsPath)).toBe('4.1');
            await mgr.checkInstalled('scrcpy-server');
            expect(mgr.getByName('scrcpy-server')!.installedVersion).toBe('4.1');
        });

        it('hashes a marker-less jar once per change to the file, not once per call', () => {
            placeJar(h.FAKE_41_JAR);

            expect(getInstalledScrcpyServerVersion(depsPath)).toBe('4.1');
            expect(getInstalledScrcpyServerVersion(depsPath)).toBe('4.1');
            expect(hashedPaths().filter((p) => p === jar)).toHaveLength(1);

            // Replaced (a different size, so a different identity): hashed again.
            fs.writeFileSync(jar, VENDORED);
            expect(getInstalledScrcpyServerVersion(depsPath)).toBe('5.0');
            expect(hashedPaths().filter((p) => p === jar)).toHaveLength(2);
        });

        it('a marker-less jar nothing pins, or none at all, falls back to SERVER_VERSION', () => {
            expect(getInstalledScrcpyServerVersion(depsPath)).toBe(SERVER_VERSION);
            placeJar(UNPINNED);
            expect(getInstalledScrcpyServerVersion(depsPath)).toBe(SERVER_VERSION);
        });

        it('a marker is answered without hashing the jar', () => {
            placeJar(h.FAKE_41_JAR);
            fs.writeFileSync(marker, '4.1');

            expect(getInstalledScrcpyServerVersion(depsPath)).toBe('4.1');
            expect(hashedPaths()).toEqual([]);
        });
    });

    describe('M2: the seed is hashed before it is copied, and recorded as what it is', () => {
        it('a stale 4.1 seed is promoted with marker 4.1, and outside a container the panel offers SERVER_VERSION', async () => {
            fs.writeFileSync(seedFile, h.FAKE_41_JAR);
            const { mgr, update } = managerWithScrcpyMissing();

            await mgr.autoInstallMissing();

            expect(fs.readFileSync(jar, 'utf8')).toBe(h.FAKE_41_JAR);
            expect(readScrcpyServerVersionMarker(depsPath)).toBe('4.1');
            expect(update).not.toHaveBeenCalledWith('scrcpy-server');
            githubLatestIs(SERVER_VERSION);
            await mgr.checkLatest('scrcpy-server');
            const info = mgr.getByName('scrcpy-server')!;
            expect(info.installedVersion).toBe('4.1');
            expect(info.status).toBe(DependencyStatus.UpdateAvailable);
        });

        it('a seed matching no pin is refused: nothing is copied, and the download installs scrcpy-server instead', async () => {
            fs.writeFileSync(seedFile, 'a seed nothing pins');
            const { mgr, update } = managerWithScrcpyMissing();

            await mgr.autoInstallMissing();

            expect(hashedPaths()).toContain(seedFile);
            expect(copiedTo()).toEqual([]);
            expect(fs.existsSync(jar)).toBe(false);
            expect(fs.existsSync(marker)).toBe(false);
            expect(update).toHaveBeenCalledWith('scrcpy-server');
        });

        it('the repair does not replace an unknown jar with a seed matching no pin', () => {
            fs.writeFileSync(seedFile, 'a seed nothing pins');
            placeJar(UNPINNED);
            const mgr = new DependencyManager(depsPath);

            mgr.repairScrcpyServerVersionMarker();

            expect(copiedTo()).toEqual([]);
            expect(fs.readFileSync(jar, 'utf8')).toBe(UNPINNED);
            expect(fs.existsSync(marker)).toBe(false);
        });

        it('the repair records a stale 4.1 seed it copies over an unknown jar as 4.1', () => {
            fs.writeFileSync(seedFile, h.FAKE_41_JAR);
            placeJar(UNPINNED);
            const mgr = new DependencyManager(depsPath);

            mgr.repairScrcpyServerVersionMarker();

            expect(fs.readFileSync(jar, 'utf8')).toBe(h.FAKE_41_JAR);
            expect(readScrcpyServerVersionMarker(depsPath)).toBe('4.1');
        });
    });

    describe('I1: in a container the image owns scrcpy-server', () => {
        it('a marker-less 4.1 jar is replaced by the seed, and recorded as SERVER_VERSION', () => {
            placeJar(h.FAKE_41_JAR);
            const mgr = new DependencyManager(depsPath, { inContainer: true });

            mgr.repairScrcpyServerVersionMarker();

            expect(sha256(fs.readFileSync(jar))).toBe(VENDORED_SHA);
            expect(readScrcpyServerVersionMarker(depsPath)).toBe(SERVER_VERSION);
            expect(getInstalledScrcpyServerVersion(depsPath)).toBe(SERVER_VERSION);
        });

        it('a jar whose marker says 4.1 is replaced, and its marker is gone before the copy', () => {
            placeJar(h.FAKE_41_JAR);
            fs.writeFileSync(marker, '4.1');
            let markerAtCopy: boolean | undefined;
            h.onCopy = (dest) => {
                if (dest === jar) markerAtCopy = fs.existsSync(marker);
            };
            const mgr = new DependencyManager(depsPath, { inContainer: true });

            mgr.repairScrcpyServerVersionMarker();

            expect(markerAtCopy).toBe(false);
            expect(sha256(fs.readFileSync(jar))).toBe(VENDORED_SHA);
            expect(readScrcpyServerVersionMarker(depsPath)).toBe(SERVER_VERSION);
        });

        it('a jar already on SERVER_VERSION is untouched, and nothing is hashed', () => {
            placeJar(VENDORED);
            fs.writeFileSync(marker, SERVER_VERSION);
            const before = fs.statSync(jar).mtimeMs;
            const mgr = new DependencyManager(depsPath, { inContainer: true });

            mgr.repairScrcpyServerVersionMarker();

            expect(copiedTo()).toEqual([]);
            expect(hashedPaths()).toEqual([]);
            expect(fs.statSync(jar).mtimeMs).toBe(before);
            expect(fs.readFileSync(marker, 'utf8')).toBe(SERVER_VERSION);
        });

        it('a marker-less SERVER_VERSION jar is recorded, not copied over', () => {
            placeJar(VENDORED);
            const mgr = new DependencyManager(depsPath, { inContainer: true });

            mgr.repairScrcpyServerVersionMarker();

            expect(copiedTo()).toEqual([]);
            expect(readScrcpyServerVersionMarker(depsPath)).toBe(SERVER_VERSION);
        });

        it('with no usable seed, a 4.1 jar is kept and recorded as 4.1', () => {
            fs.writeFileSync(seedFile, 'a seed nothing pins');
            placeJar(h.FAKE_41_JAR);
            const mgr = new DependencyManager(depsPath, { inContainer: true });

            mgr.repairScrcpyServerVersionMarker();

            expect(copiedTo()).toEqual([]);
            expect(fs.readFileSync(jar, 'utf8')).toBe(h.FAKE_41_JAR);
            expect(readScrcpyServerVersionMarker(depsPath)).toBe('4.1');
        });

        it('control: outside a container the same marker-less 4.1 jar is kept', () => {
            placeJar(h.FAKE_41_JAR);
            const mgr = new DependencyManager(depsPath, { inContainer: false });

            mgr.repairScrcpyServerVersionMarker();

            expect(fs.readFileSync(jar, 'utf8')).toBe(h.FAKE_41_JAR);
            expect(readScrcpyServerVersionMarker(depsPath)).toBe('4.1');
        });

        it('control: outside a container a jar whose marker says 4.1 is kept', () => {
            placeJar(h.FAKE_41_JAR);
            fs.writeFileSync(marker, '4.1');
            const mgr = new DependencyManager(depsPath, { inContainer: false });

            mgr.repairScrcpyServerVersionMarker();

            expect(fs.readFileSync(jar, 'utf8')).toBe(h.FAKE_41_JAR);
            expect(fs.readFileSync(marker, 'utf8')).toBe('4.1');
        });
    });

    describe('M3: the panel update deletes the old marker before it copies the jar', () => {
        type WithInstall = { installScrcpyServer(downloadPath: string, version: string): Promise<void> };

        it('the marker is absent when the copy runs, and records the new version after', async () => {
            placeJar(h.FAKE_41_JAR);
            fs.writeFileSync(marker, '4.1');
            let markerAtCopy: boolean | undefined;
            h.onCopy = (dest) => {
                if (dest === jar) markerAtCopy = fs.existsSync(marker);
            };
            const mgr = new DependencyManager(depsPath);

            await (mgr as unknown as WithInstall).installScrcpyServer(VENDORED_JAR, '5.0');

            expect(markerAtCopy).toBe(false);
            expect(sha256(fs.readFileSync(jar))).toBe(VENDORED_SHA);
            expect(readScrcpyServerVersionMarker(depsPath)).toBe('5.0');
        });

        it('a failure after the copy leaves a marker-less jar identified by its hash, never the old marker', async () => {
            placeJar(h.FAKE_41_JAR);
            fs.writeFileSync(marker, '4.1');
            h.writeFails = (p) => p === marker;
            const mgr = new DependencyManager(depsPath);

            await expect((mgr as unknown as WithInstall).installScrcpyServer(VENDORED_JAR, '5.0')).rejects.toThrow(
                /EIO/,
            );

            expect(fs.existsSync(marker)).toBe(false);
            expect(getInstalledScrcpyServerVersion(depsPath)).toBe('5.0');
        });

        it('the seed promote takes the same order', async () => {
            let markerAtCopy: boolean | undefined;
            h.onCopy = (dest) => {
                if (dest === jar) markerAtCopy = fs.existsSync(marker);
            };
            // A marker with no jar: what a crash mid-way through an older build's
            // install could leave.
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            fs.writeFileSync(marker, '4.1');
            const { mgr } = managerWithScrcpyMissing();

            await mgr.autoInstallMissing();

            expect(markerAtCopy).toBe(false);
            expect(readScrcpyServerVersionMarker(depsPath)).toBe(SERVER_VERSION);
        });
    });
});

/**
 * `src` with its comments blanked out, string and template literals kept. Only
 * what a real call expression in index.ts needs: a commented-out call must not
 * count as a call.
 */
function stripComments(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i]!;
        const next = src[i + 1];
        if (c === '/' && next === '/') {
            while (i < src.length && src[i] !== '\n') i++;
        } else if (c === '/' && next === '*') {
            const end = src.indexOf('*/', i + 2);
            i = end < 0 ? src.length : end + 2;
            out += ' ';
        } else if (c === "'" || c === '"' || c === '`') {
            let j = i + 1;
            while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
            out += src.slice(i, j + 1);
            i = j + 1;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

describe('index.ts runs the marker repair before anything can probe or stream', () => {
    const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, 'src', 'server', 'index.ts'), 'utf8'));

    it('calls it right after the dependency manager is built, before the services start', () => {
        const built = code.search(/\bconst depManager = getDependencyManager\(/);
        const repaired = code.search(/^\s*depManager\.repairScrcpyServerVersionMarker\(\s*\)\s*;/m);
        const servicesStart = code.search(/^\s*reconcileWebPort\(config\)/m);
        expect(built).toBeGreaterThan(-1);
        expect(repaired).toBeGreaterThan(built);
        expect(servicesStart).toBeGreaterThan(repaired);
    });

    it('control: the comment stripper does not count a commented-out call', () => {
        const commented = stripComments('a();\n// depManager.repairScrcpyServerVersionMarker();\n/* x(); */ b();');
        expect(commented).not.toMatch(/repairScrcpyServerVersionMarker/);
        expect(commented).not.toMatch(/x\(\)/);
        expect(stripComments("const u = 'http://x'; c();")).toContain("'http://x'");
    });
});
