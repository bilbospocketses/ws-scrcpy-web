import { createHash } from 'crypto';
import * as fs from 'fs';
import os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticodeResult } from '../adbAuthenticode';
import { DependencyManager } from '../DependencyManager';

/**
 * M5: on Windows, after size + SHA-1, the extracted adb.exe must be validly
 * Authenticode-signed by Google LLC -- and that is checked BEFORE the running
 * adb is stopped, so a refused binary never takes a working daemon down. Linux
 * has no equivalent and makes no call.
 *
 * `os.platform` is stubbed so both branches run on either host; the checker is
 * the manager's `checkAuthenticode` constructor seam.
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

const sha1 = (data: string) => createHash('sha1').update(data).digest('hex');
const GOOGLE = 'CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US';
const version = '37.0.1';
const ZIP = 'not-a-real-platform-tools-zip-but-deterministic-bytes';

describe.each(['win32', 'linux'] as const)('DependencyManager.update("adb") Authenticode step on %s', (platform) => {
    const exe = platform === 'win32' ? 'adb.exe' : 'adb';
    const asset = `platform-tools_r${version}-${platform === 'win32' ? 'win' : 'linux'}.zip`;
    let tmpDepsDir: string;
    let installedAdb: string;

    beforeEach(() => {
        vi.spyOn(os, 'platform').mockReturnValue(platform);
        tmpDepsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dm-adb-authenticode-'));
        installedAdb = path.join(tmpDepsDir, 'adb', exe);
        fs.mkdirSync(path.dirname(installedAdb), { recursive: true });
        fs.writeFileSync(installedAdb, 'OLD-ADB');
        execFileCalls.length = 0;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tmpDepsDir, { recursive: true, force: true });
    });

    const xml = `<sdk:sdk-repository><remotePackage path="platform-tools"><archives><archive><complete>
        <size>${Buffer.byteLength(ZIP)}</size><checksum type="sha1">${sha1(ZIP)}</checksum><url>${asset}</url>
        </complete></archive></archives></remotePackage></sdk:sdk-repository>`;

    /**
     * `answer` is what the checker says about adb.exe; `dllAnswer` what it says
     * about the AdbWinApi.dll beside it (default: valid Google). `withAdb`
     * false stages an archive with no adb binary at all.
     */
    function setup(answer: AuthenticodeResult, opts: { dllAnswer?: AuthenticodeResult; withAdb?: boolean } = {}) {
        vi.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
            const url = new URL(String(input instanceof Request ? input.url : input));
            return url.pathname.endsWith('/repository2-3.xml') ? new Response(xml) : new Response(ZIP);
        });
        const checked: string[][] = [];
        const mgr = new DependencyManager(tmpDepsDir, {
            checkAuthenticode: async (files) => {
                checked.push([...files]);
                return files.map((f) =>
                    path.basename(f) === 'adb.exe' ? answer : (opts.dllAnswer ?? { status: 'Valid', subject: GOOGLE }),
                );
            },
        });
        mgr.getByName('adb')!.latestVersion = version;
        vi.spyOn(mgr as any, 'extractZip').mockImplementation(async (...args: unknown[]) => {
            const dest = path.join(args[1] as string, 'platform-tools');
            fs.mkdirSync(dest, { recursive: true });
            if (opts.withAdb !== false) fs.writeFileSync(path.join(dest, exe), 'NEW-ADB');
            fs.writeFileSync(path.join(dest, platform === 'win32' ? 'AdbWinApi.dll' : 'libfoo.so'), 'NEW-LIB');
        });
        return { mgr, checked };
    }

    const killServerCalls = () => execFileCalls.filter((c) => c.args.includes('kill-server'));

    it(`installs a ${platform === 'win32' ? 'valid Google LLC signature on every binary' : 'size + SHA-1 match with no Authenticode call'}`, async () => {
        const { mgr, checked } = setup({ status: 'Valid', subject: GOOGLE });

        const result = await mgr.update('adb');

        expect(result.success, result.errorMessage).toBe(true);
        expect(fs.readFileSync(installedAdb, 'utf8')).toBe('NEW-ADB');
        expect(killServerCalls()).toHaveLength(1);
        if (platform === 'win32') {
            // One call, covering adb.exe AND the DLL it loads from beside itself.
            expect(checked).toHaveLength(1);
            expect(checked[0]!.map((f) => path.basename(f)).sort()).toEqual(['AdbWinApi.dll', 'adb.exe']);
            for (const f of checked[0]!) expect(path.basename(path.dirname(f))).toBe('platform-tools');
        } else {
            expect(checked).toEqual([]);
        }
    });

    if (platform === 'win32') {
        it('refuses a genuine adb.exe beside an unsigned AdbWinApi.dll, before kill-server, and installs nothing', async () => {
            const { mgr } = setup(
                { status: 'Valid', subject: GOOGLE },
                { dllAnswer: { status: 'NotSigned', subject: null } },
            );

            const result = await mgr.update('adb');

            expect(result.success).toBe(false);
            expect(result.errorMessage).toBe(
                'AdbWinApi.dll Authenticode signature is not valid (NotSigned) -- refusing to install',
            );
            expect(killServerCalls()).toEqual([]);
            expect(fs.readFileSync(installedAdb, 'utf8')).toBe('OLD-ADB');
            expect(fs.existsSync(path.join(tmpDepsDir, 'adb', 'AdbWinApi.dll'))).toBe(false);
        });

        it('refuses an archive with no adb.exe, saying so, before kill-server', async () => {
            const { mgr, checked } = setup({ status: 'Valid', subject: GOOGLE }, { withAdb: false });

            const result = await mgr.update('adb');

            expect(result.success).toBe(false);
            expect(result.errorMessage).toBe('adb.exe missing from the platform-tools archive -- refusing to install');
            expect(checked).toEqual([]);
            expect(killServerCalls()).toEqual([]);
            expect(fs.readFileSync(installedAdb, 'utf8')).toBe('OLD-ADB');
        });
    }

    const refusals: [string, AuthenticodeResult, string][] = [
        [
            'an unsigned adb.exe',
            { status: 'NotSigned', subject: null },
            'adb.exe Authenticode signature is not valid (NotSigned) -- refusing to install',
        ],
        [
            'another signer',
            { status: 'Valid', subject: 'CN=OpenJS Foundation, O=OpenJS Foundation, C=US' },
            'adb.exe is signed by "CN=OpenJS Foundation, O=OpenJS Foundation, C=US", not Google LLC -- refusing to install',
        ],
        [
            'an invalid Google signature',
            { status: 'HashMismatch', subject: GOOGLE },
            'adb.exe Authenticode signature is not valid (HashMismatch) -- refusing to install',
        ],
    ];

    it.each(refusals)(
        platform === 'win32'
            ? 'refuses %s before kill-server, and installs nothing'
            : 'ignores what a checker would say about %s',
        async (_label, answer, message) => {
            const { mgr, checked } = setup(answer);

            const result = await mgr.update('adb');

            if (platform === 'win32') {
                expect(result.success).toBe(false);
                expect(result.errorMessage).toBe(message);
                expect(killServerCalls()).toEqual([]);
                expect(fs.readFileSync(installedAdb, 'utf8')).toBe('OLD-ADB');
            } else {
                expect(result.success, result.errorMessage).toBe(true);
                expect(checked).toEqual([]);
            }
        },
    );
});
