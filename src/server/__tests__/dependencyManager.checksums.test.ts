import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_JAR_SHA256, SERVER_VERSION } from '../../common/Constants';
import { DependencyStatus } from '../../common/DependencyTypes';
import { getDependencyDefinitions, NODE_DIST_BASE_ENV, parseAdbArchive } from '../DependencyDefinitions';
import { DependencyManager } from '../DependencyManager';
import { bytesResponse, makeTestReleaseKeys } from './helpers/releaseSigning';

/**
 * Node.js, adb and scrcpy-server are checked against what their publishers
 * list before anything is installed -- the mkcert block in
 * dependencyManager.test.ts is the model. Every check fails closed: a bad hash,
 * a list that does not name the asset, or a list that cannot be fetched all
 * end the update with nothing installed.
 *
 * `child_process` is mocked so the one side effect that precedes an adb
 * install -- `adb kill-server` on the existing binary -- can be observed, not
 * just inferred from the install method not running.
 *
 * Node's and scrcpy's lists are signed (M5): each fixture list here is signed
 * with a throwaway key handed to the manager through its `releaseKeys` seam.
 * The refusals of the signature itself are in dependencyManager.signatures.test.ts.
 */
const execFileCalls = vi.hoisted(() => [] as { file: string; args: string[] }[]);
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    const { promisify } = await import('util');
    const execFile = Object.assign(
        () => {
            throw new Error('only the promisified execFile is used');
        },
        {
            [promisify.custom]: async (file: string, args: readonly string[]) => {
                execFileCalls.push({ file, args: [...args] });
                return { stdout: '', stderr: '' };
            },
        },
    );
    return { ...actual, default: { ...actual, execFile }, execFile };
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const sha1 = (data: string | Buffer) => createHash('sha1').update(data).digest('hex');
const urlOf = (input: string | URL | Request) => String(input instanceof Request ? input.url : input);

/** Every URL fetched, in order; `answer` builds a FRESH response per call (a body reads once). */
function stubFetch(answer: (url: URL) => Response): string[] {
    const fetched: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
        const url = urlOf(input);
        fetched.push(url);
        return answer(new URL(url));
    });
    return fetched;
}

const notFound = () => new Response('Not Found', { status: 404 });

let keys: Awaited<ReturnType<typeof makeTestReleaseKeys>>;
beforeAll(async () => {
    keys = await makeTestReleaseKeys();
});

describe('DependencyManager.update("nodejs") — SHASUMS256.txt before install', () => {
    const version = '24.99.0';
    const ARCHIVE = 'not-a-real-node-archive-but-deterministic-bytes';
    let tmpDepsDir: string;
    // The archive name the download URL ends in, whichever platform runs this.
    const asset = () =>
        path.posix.basename(
            new URL(
                getDependencyDefinitions(tmpDepsDir)
                    .find((d) => d.name === 'nodejs')!
                    .getDownloadUrl(version),
            ).pathname,
        );

    beforeEach(() => {
        tmpDepsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dm-node-sums-'));
        vi.stubEnv(NODE_DIST_BASE_ENV, undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        fs.rmSync(tmpDepsDir, { recursive: true, force: true });
    });

    /**
     * SHASUMS256.txt answers `sums` -- a list, which the test key signs at
     * `.sig`, or a Response served for both -- and anything else is the
     * archive. installNodejs is a spy.
     */
    async function setup(sums: string | (() => Response)) {
        const sig = typeof sums === 'string' ? await keys.node.sign(sums) : null;
        const fetched = stubFetch((u) => {
            if (u.pathname.endsWith('/SHASUMS256.txt')) return typeof sums === 'string' ? new Response(sums) : sums();
            if (u.pathname.endsWith('/SHASUMS256.txt.sig')) return sig ? bytesResponse(sig) : notFound();
            return new Response(ARCHIVE);
        });
        const mgr = new DependencyManager(tmpDepsDir, { releaseKeys: keys.releaseKeys });
        mgr.getByName('nodejs')!.latestVersion = version;
        const install = vi.spyOn(mgr as any, 'installNodejs').mockResolvedValue(undefined);
        return { mgr, install, fetched };
    }

    it('installs when the archive matches its SHASUMS256.txt entry', async () => {
        const { mgr, install } = await setup(
            `${'a'.repeat(64)}  node-v${version}-other.zip\n${sha256(ARCHIVE)}  ${asset()}\n`,
        );

        const result = await mgr.update('nodejs');

        expect(result.success, result.errorMessage).toBe(true);
        expect(install).toHaveBeenCalledTimes(1);
        expect(path.basename(install.mock.calls[0]![0] as string)).toBe(asset());
    });

    it('refuses a mismatch, and installs nothing', async () => {
        const wrong = '0'.repeat(64);
        const { mgr, install } = await setup(`${wrong}  ${asset()}\n`);

        const result = await mgr.update('nodejs');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `Node.js checksum mismatch for ${asset()} (expected ${wrong}) -- refusing to install`,
        );
        expect(install).not.toHaveBeenCalled();
        expect(mgr.getByName('nodejs')!.status).toBe(DependencyStatus.Error);
    });

    it('refuses when SHASUMS256.txt does not list the archive', async () => {
        const { mgr, install } = await setup(`${sha256(ARCHIVE)}  node-v${version}-aix-ppc64.tar.gz\n`);

        const result = await mgr.update('nodejs');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `Node.js checksum list does not list ${asset()} -- refusing to install an unverified runtime`,
        );
        expect(install).not.toHaveBeenCalled();
    });

    it('refuses when SHASUMS256.txt cannot be fetched', async () => {
        const { mgr, install } = await setup(notFound);

        const result = await mgr.update('nodejs');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `Node.js checksum list fetch failed: HTTP 404 from https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
        );
        expect(install).not.toHaveBeenCalled();
    });

    it('reads SHASUMS256.txt from WS_SCRCPY_NODE_DIST_BASE, beside the archive', async () => {
        const base = 'http://127.0.0.1:8146/dist';
        vi.stubEnv(NODE_DIST_BASE_ENV, `${base}/`);
        const { mgr, fetched } = await setup(`${sha256(ARCHIVE)}  ${asset()}\n`);

        const result = await mgr.update('nodejs');

        expect(result.success, result.errorMessage).toBe(true);
        expect(fetched).toContain(`${base}/v${version}/SHASUMS256.txt`);
        expect(fetched.filter((u) => new URL(u).hostname === 'nodejs.org')).toEqual([]);
    });
});

describe('DependencyManager.update("adb") — size and SHA-1 from repository2-3.xml before install', () => {
    const version = '37.0.1';
    const ZIP = 'not-a-real-platform-tools-zip-but-deterministic-bytes';
    const OS = process.platform === 'win32' ? 'win' : 'linux';
    const OTHER_OS = process.platform === 'win32' ? 'linux' : 'win';
    const asset = `platform-tools_r${version}-${OS}.zip`;
    const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
    const XML_URL = 'https://dl.google.com/android/repository/repository2-3.xml';
    let tmpDepsDir: string;
    let installedAdb: string;

    /** platform-tools' block as dl.google.com publishes it, with the archives the test names. */
    const repositoryXml = (archives: { url: string; size: number; sha1: string }[]) =>
        `<?xml version="1.0" ?><sdk:sdk-repository>
  <remotePackage path="platform-tools">
    <revision><major>37</major><minor>0</minor><micro>1</micro></revision>
    <archives>${archives
        .map(
            (a) => `
      <archive>
        <complete>
          <size>${a.size}</size>
          <checksum type="sha1">${a.sha1}</checksum>
          <url>${a.url}</url>
        </complete>
        <host-os>${a.url.includes('-win') ? 'windows' : 'linux'}</host-os>
      </archive>`,
        )
        .join('')}
    </archives>
  </remotePackage>
</sdk:sdk-repository>`;

    beforeEach(() => {
        tmpDepsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dm-adb-sums-'));
        // An adb already installed, so `kill-server` -- the install's first
        // side effect -- has something to run against.
        installedAdb = path.join(tmpDepsDir, 'adb', exe);
        fs.mkdirSync(path.dirname(installedAdb), { recursive: true });
        fs.writeFileSync(installedAdb, 'OLD-ADB');
        execFileCalls.length = 0;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tmpDepsDir, { recursive: true, force: true });
    });

    const killServerCalls = () => execFileCalls.filter((c) => c.args.includes('kill-server'));

    /**
     * The XML answers `xml`; anything else is the zip. Extraction is faked to
     * lay out platform-tools/. The fake adb.exe is not Authenticode-signed, so
     * the Windows signer check (dependencyManager.adbAuthenticode.test.ts) is
     * answered as a valid Google LLC signature here.
     */
    function setup(xml: () => Response) {
        const fetched = stubFetch((u) => (u.pathname.endsWith('/repository2-3.xml') ? xml() : new Response(ZIP)));
        const mgr = new DependencyManager(tmpDepsDir, {
            checkAuthenticode: async () => ({ status: 'Valid', subject: 'CN=Google LLC, O=Google LLC, C=US' }),
        });
        mgr.getByName('adb')!.latestVersion = version;
        vi.spyOn(mgr as any, 'extractZip').mockImplementation(async (...args: unknown[]) => {
            const dest = path.join(args[1] as string, 'platform-tools');
            fs.mkdirSync(dest, { recursive: true });
            fs.writeFileSync(path.join(dest, exe), 'NEW-ADB');
        });
        const install = vi.spyOn(mgr as any, 'installAdb');
        return { mgr, install, fetched };
    }

    const listing = (over: Partial<{ size: number; sha1: string }> = {}) =>
        repositoryXml([
            { url: `platform-tools_r${version}-${OTHER_OS}.zip`, size: 1, sha1: 'f'.repeat(40) },
            { url: asset, size: Buffer.byteLength(ZIP), sha1: sha1(ZIP), ...over },
        ]);

    it('downloads the VERSIONED archive and installs it when size and SHA-1 match', async () => {
        const { mgr, install, fetched } = setup(() => new Response(listing()));

        const result = await mgr.update('adb');

        expect(result.success, result.errorMessage).toBe(true);
        expect(fetched).toContain(`https://dl.google.com/android/repository/${asset}`);
        expect(fetched.some((u) => new URL(u).pathname.includes('-latest-'))).toBe(false);
        expect(install).toHaveBeenCalledTimes(1);
        // The contrast for the refusals below: here kill-server DID run.
        expect(killServerCalls()).toHaveLength(1);
        expect(fs.readFileSync(installedAdb, 'utf8')).toBe('NEW-ADB');
    });

    it('refuses a SHA-1 mismatch before kill-server, and installs nothing', async () => {
        const wrong = '0'.repeat(40);
        const { mgr, install } = setup(() => new Response(listing({ sha1: wrong })));

        const result = await mgr.update('adb');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `adb checksum mismatch for ${asset} (expected ${wrong}) -- refusing to install`,
        );
        expect(install).not.toHaveBeenCalled();
        expect(killServerCalls()).toEqual([]);
        expect(fs.readFileSync(installedAdb, 'utf8')).toBe('OLD-ADB');
        expect(mgr.getByName('adb')!.status).toBe(DependencyStatus.Error);
    });

    it('refuses a size mismatch even when the SHA-1 matches', async () => {
        const listed = Buffer.byteLength(ZIP) + 1;
        const { mgr, install } = setup(() => new Response(listing({ size: listed })));

        const result = await mgr.update('adb');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `adb size mismatch for ${asset} (expected ${listed} bytes, got ${Buffer.byteLength(ZIP)}) -- refusing to install`,
        );
        expect(install).not.toHaveBeenCalled();
        expect(killServerCalls()).toEqual([]);
    });

    it('refuses when repository2-3.xml does not list the archive', async () => {
        const { mgr, install } = setup(
            () =>
                new Response(
                    repositoryXml([{ url: `platform-tools_r${version}-${OTHER_OS}.zip`, size: 1, sha1: sha1(ZIP) }]),
                ),
        );

        const result = await mgr.update('adb');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `adb checksum list does not list ${asset} -- refusing to install unverified platform-tools`,
        );
        expect(install).not.toHaveBeenCalled();
        expect(killServerCalls()).toEqual([]);
    });

    it('refuses when repository2-3.xml cannot be fetched', async () => {
        const { mgr, install } = setup(notFound);

        const result = await mgr.update('adb');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(`adb checksum list fetch failed: HTTP 404 from ${XML_URL}`);
        expect(install).not.toHaveBeenCalled();
        expect(killServerCalls()).toEqual([]);
    });

    it('refuses a version that names no release, rather than fetching a floating -latest- archive', async () => {
        const { mgr, install, fetched } = setup(() => new Response(listing()));
        mgr.getByName('adb')!.latestVersion = 'latest';

        const result = await mgr.update('adb');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            'adb version "latest" is not a platform-tools release number -- refusing to download an unversioned archive',
        );
        expect(fetched).toEqual([]);
        expect(install).not.toHaveBeenCalled();
    });
});

describe('parseAdbArchive', () => {
    it('reads size and SHA-1 for the named archive inside the platform-tools package only', () => {
        const xml = `<sdk:sdk-repository>
  <remotePackage path="build-tools;37.0.0"><archives><archive><complete>
    <size>5</size><checksum type="sha1">${'e'.repeat(40)}</checksum><url>platform-tools_r37.0.1-win.zip</url>
  </complete></archive></archives></remotePackage>
  <remotePackage path="platform-tools"><archives><archive><complete>
    <size>8044989</size><checksum type="sha1">E03E78B1D80B396F1C3358E31251CB31740E1110</checksum>
    <url>platform-tools_r37.0.1-win.zip</url>
  </complete></archive></archives></remotePackage>
</sdk:sdk-repository>`;
        expect(parseAdbArchive(xml, 'platform-tools_r37.0.1-win.zip')).toEqual({
            size: 8044989,
            sha1: 'e03e78b1d80b396f1c3358e31251cb31740e1110',
        });
        expect(parseAdbArchive(xml, 'platform-tools_r37.0.1-linux.zip')).toBeNull();
    });
});

describe('DependencyManager.update("scrcpy-server") — SHA256SUMS.txt and the pinned table before install', () => {
    const JAR = 'not-a-real-scrcpy-server-but-deterministic-bytes';
    let tmpDepsDir: string;
    const installed = () => path.join(tmpDepsDir, 'scrcpy-server', 'scrcpy-server');
    const sumsUrl = (v: string) => `https://github.com/Genymobile/scrcpy/releases/download/v${v}/SHA256SUMS.txt`;

    beforeEach(() => {
        tmpDepsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dm-scrcpy-sums-'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tmpDepsDir, { recursive: true, force: true });
    });

    /**
     * SHA256SUMS.txt answers `sums`, whose body the test key signs at `.asc`
     * when it is a 200; anything else is `jar`.
     */
    async function setup(version: string, sums: () => Response, jar: string | Buffer = JAR) {
        const body = typeof jar === 'string' ? jar : new Uint8Array(jar);
        const sample = sums();
        const sig = sample.ok ? await keys.scrcpy.sign(await sample.text(), { armored: true }) : null;
        const fetched = stubFetch((u) => {
            if (u.pathname.endsWith('/SHA256SUMS.txt')) return sums();
            if (u.pathname.endsWith('/SHA256SUMS.txt.asc')) return sig ? bytesResponse(sig) : notFound();
            return new Response(body);
        });
        const mgr = new DependencyManager(tmpDepsDir, { releaseKeys: keys.releaseKeys });
        mgr.getByName('scrcpy-server')!.latestVersion = version;
        return { mgr, fetched };
    }

    it('installs a version the pinned table does not know when it matches SHA256SUMS.txt', async () => {
        const { mgr, fetched } = await setup(
            '4.0',
            () => new Response(`${sha256(JAR)}  scrcpy-server-v4.0\n${'b'.repeat(64)}  scrcpy-win64-v4.0.zip\n`),
        );

        const result = await mgr.update('scrcpy-server');

        expect(result.success, result.errorMessage).toBe(true);
        expect(fetched).toContain(sumsUrl('4.0'));
        expect(fs.readFileSync(installed(), 'utf8')).toBe(JAR);
    });

    it('refuses a mismatch, and installs nothing', async () => {
        const wrong = '0'.repeat(64);
        const { mgr } = await setup('4.0', () => new Response(`${wrong}  scrcpy-server-v4.0\n`));

        const result = await mgr.update('scrcpy-server');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `scrcpy-server checksum mismatch for scrcpy-server-v4.0 (expected ${wrong}) -- refusing to install`,
        );
        expect(fs.existsSync(installed())).toBe(false);
        expect(mgr.getByName('scrcpy-server')!.status).toBe(DependencyStatus.Error);
    });

    it('refuses when SHA256SUMS.txt does not list the asset', async () => {
        const { mgr } = await setup('4.0', () => new Response(`${sha256(JAR)}  scrcpy-win64-v4.0.zip\n`));

        const result = await mgr.update('scrcpy-server');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            'scrcpy-server checksum list does not list scrcpy-server-v4.0 -- refusing to install an unverified binary',
        );
        expect(fs.existsSync(installed())).toBe(false);
    });

    it('refuses when SHA256SUMS.txt cannot be fetched', async () => {
        const { mgr } = await setup('4.0', notFound);

        const result = await mgr.update('scrcpy-server');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(`scrcpy-server checksum list fetch failed: HTTP 404 from ${sumsUrl('4.0')}`);
        expect(fs.existsSync(installed())).toBe(false);
    });

    it('refuses when SHA256SUMS.txt disagrees with SERVER_JAR_SHA256, even though the download matches the list', async () => {
        const pinned = SERVER_JAR_SHA256[SERVER_VERSION]!;
        const { mgr } = await setup(
            SERVER_VERSION,
            () => new Response(`${sha256(JAR)}  scrcpy-server-v${SERVER_VERSION}\n`),
        );

        const result = await mgr.update('scrcpy-server');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `scrcpy-server checksum list disagrees with the pinned SERVER_JAR_SHA256 for scrcpy-server-v${SERVER_VERSION} ` +
                `(list ${sha256(JAR)}, pinned ${pinned}) -- refusing to install`,
        );
        expect(fs.existsSync(installed())).toBe(false);
    });

    it('installs the pinned version when the list, the table and the download all agree', async () => {
        const vendored = fs.readFileSync(path.join(REPO_ROOT, 'assets', 'scrcpy-server'));
        const { mgr } = await setup(
            SERVER_VERSION,
            () => new Response(`${SERVER_JAR_SHA256[SERVER_VERSION]}  scrcpy-server-v${SERVER_VERSION}\n`),
            vendored,
        );

        const result = await mgr.update('scrcpy-server');

        expect(result.success, result.errorMessage).toBe(true);
        expect(sha256(fs.readFileSync(installed()))).toBe(SERVER_JAR_SHA256[SERVER_VERSION]);
    });
});
