import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    AUTHENTICODE_FILES_ENV,
    AUTHENTICODE_SCRIPT,
    type AuthenticodeChecker,
    type AuthenticodeResult,
    defaultAuthenticodeChecker,
    isGoogleSigner,
    listSignableFiles,
    parseAuthenticodeOutput,
    parseDistinguishedName,
    verifyPlatformToolsAuthenticode,
} from '../adbAuthenticode';

/** What Get-AuthenticodeSignature reports for platform-tools r37's adb.exe (read 2026-10-07). */
const GOOGLE_SUBJECT =
    'CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US, SERIALNUMBER=3582691, ' +
    'OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US';
const GOOGLE_VALID: AuthenticodeResult = { status: 'Valid', subject: GOOGLE_SUBJECT };

/** The 11 binaries of platform-tools r37 for Windows, all signed Valid by Google LLC (read 2026-10-07). */
const R37_BINARIES = [
    'adb.exe',
    'AdbWinApi.dll',
    'AdbWinUsbApi.dll',
    'etc1tool.exe',
    'fastboot.exe',
    'hprof-conv.exe',
    'libwinpthread-1.dll',
    'make_f2fs.exe',
    'make_f2fs_casefold.exe',
    'mke2fs.exe',
    'sqlite3.exe',
];

describe('isGoogleSigner', () => {
    it("accepts the subject Google's adb.exe is signed with", () => {
        expect(isGoogleSigner(GOOGLE_SUBJECT)).toBe(true);
    });

    it.each([
        ['another publisher', 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'],
        ['Google LLC as the CN only', 'CN=Google LLC, O=Evil Corp, C=US'],
        ['Google LLC as the O only', 'CN=Evil Corp, O=Google LLC, C=US'],
        ['Google LLC inside another value', 'CN=Not Google LLC, O=Google LLC Fan Club, C=US'],
        ['two CNs', 'CN=Google LLC, CN=Evil Corp, O=Google LLC'],
        ['no subject', null],
        ['an empty subject', ''],
    ])('refuses %s', (_label, subject) => {
        expect(isGoogleSigner(subject)).toBe(false);
    });

    it('reads a quoted value holding a comma as one value', () => {
        expect(parseDistinguishedName('CN="Google, LLC", O=Google LLC').get('CN')).toEqual(['Google, LLC']);
        expect(isGoogleSigner('CN="Google, LLC", O=Google LLC')).toBe(false);
    });
});

describe('parseAuthenticodeOutput', () => {
    const files = ['C:\\pt\\adb.exe', 'C:\\pt\\AdbWinApi.dll'];

    it('reads the JSON array the script prints, one result per file, ignoring a BOM and stray lines', () => {
        const out =
            '\uFEFFWARNING: noise\r\n' +
            `${JSON.stringify([
                {
                    file: files[0],
                    status: 'Valid',
                    subject: 'CN=Google LLC, O=Google LLC',
                    statusMessage: 'Signature verified.',
                },
                { file: files[1], status: 'NotSigned', subject: null },
            ])}\r\n`;
        expect(parseAuthenticodeOutput(out, files)).toEqual([
            { status: 'Valid', subject: 'CN=Google LLC, O=Google LLC', statusMessage: 'Signature verified.' },
            { status: 'NotSigned', subject: null },
        ]);
    });

    it('throws on output with no result', () => {
        expect(() => parseAuthenticodeOutput('', files)).toThrow('Get-AuthenticodeSignature printed no result');
    });

    it('throws when it answers for fewer files than were asked about', () => {
        const out = JSON.stringify([{ file: files[0], status: 'Valid', subject: null }]);
        expect(() => parseAuthenticodeOutput(out, files)).toThrow(
            'Get-AuthenticodeSignature answered for 1 of 2 files',
        );
    });

    it('throws when the answers are not in the order asked', () => {
        const out = JSON.stringify([
            { file: files[1], status: 'Valid', subject: null },
            { file: files[0], status: 'Valid', subject: null },
        ]);
        expect(() => parseAuthenticodeOutput(out, files)).toThrow(/answered out of order/);
    });

    it('takes its input from the child environment as data, never spliced into the script', () => {
        expect(AUTHENTICODE_SCRIPT).toContain(`ConvertFrom-Json -InputObject $env:${AUTHENTICODE_FILES_ENV}`);
        expect(AUTHENTICODE_SCRIPT).toContain('Get-AuthenticodeSignature -LiteralPath $file');
    });
});

describe('verifyPlatformToolsAuthenticode', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-pt-authenticode-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function stage(files: string[]): void {
        for (const rel of files) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), 'MZ');
        }
    }

    /** A checker answering per file name, recording every call. */
    function checker(answer: (name: string) => AuthenticodeResult) {
        const calls: string[][] = [];
        const check: AuthenticodeChecker = async (files) => {
            calls.push([...files]);
            return files.map((f) => answer(path.basename(f)));
        };
        return { check, calls };
    }

    it("passes r37's eleven binaries, all checked in ONE call, and ignores files that are not code", async () => {
        stage([...R37_BINARIES, 'NOTICE.txt', 'source.properties']);
        const { check, calls } = checker(() => GOOGLE_VALID);

        await expect(verifyPlatformToolsAuthenticode(dir, check)).resolves.toBeUndefined();

        expect(calls).toHaveLength(1);
        expect(calls[0]!.map((f) => path.basename(f)).sort()).toEqual([...R37_BINARIES].sort());
        for (const f of calls[0]!) expect(path.dirname(f)).toBe(dir);
    });

    it('lists every .exe and .dll recursively, whatever the case of the extension', async () => {
        stage(['adb.exe', 'lib64/evil.DLL', 'deep/er/tool.Exe', 'readme.md', 'lib64/libc++.so']);
        expect(await listSignableFiles(dir)).toEqual(['adb.exe', 'deep/er/tool.Exe', 'lib64/evil.DLL']);
    });

    it.each([
        [
            'AdbWinApi.dll',
            { status: 'NotSigned', subject: null },
            'AdbWinApi.dll Authenticode signature is not valid (NotSigned) -- refusing to install',
        ],
        [
            'fastboot.exe',
            {
                status: 'HashMismatch',
                subject: GOOGLE_SUBJECT,
                statusMessage: 'The contents of the file may have been tampered with.',
            },
            'fastboot.exe Authenticode signature is not valid (HashMismatch: The contents of the file may have been tampered with.) -- refusing to install',
        ],
        [
            'sqlite3.exe',
            { status: 'Valid', subject: 'CN=OpenJS Foundation, O=OpenJS Foundation, C=US' },
            'sqlite3.exe is signed by "CN=OpenJS Foundation, O=OpenJS Foundation, C=US", not Google LLC -- refusing to install',
        ],
        [
            'adb.exe',
            { status: 'NotSigned', subject: null },
            'adb.exe Authenticode signature is not valid (NotSigned) -- refusing to install',
        ],
    ] as [string, AuthenticodeResult, string][])(
        'refuses a genuine folder with one bad file: %s',
        async (bad, answer, message) => {
            stage(R37_BINARIES);
            const { check } = checker((name) => (name === bad ? answer : GOOGLE_VALID));

            await expect(verifyPlatformToolsAuthenticode(dir, check)).rejects.toThrow(message);
        },
    );

    it('refuses a substituted DLL in a subfolder, naming it by its path in the archive', async () => {
        stage([...R37_BINARIES, 'lib/AdbWinApi.dll']);
        const { check } = checker(() => GOOGLE_VALID);
        const nested: AuthenticodeChecker = async (files) => {
            const results = await check(files);
            return results.map((r, i) =>
                files[i]!.includes(`${path.sep}lib${path.sep}`) ? { status: 'NotSigned', subject: null } : r,
            );
        };

        await expect(verifyPlatformToolsAuthenticode(dir, nested)).rejects.toThrow(
            'lib/AdbWinApi.dll Authenticode signature is not valid (NotSigned) -- refusing to install',
        );
    });

    it('names the FIRST failing file when several fail', async () => {
        stage(R37_BINARIES);
        const { check } = checker((name) =>
            name === 'adb.exe' ? GOOGLE_VALID : { status: 'NotSigned', subject: null },
        );

        await expect(verifyPlatformToolsAuthenticode(dir, check)).rejects.toThrow(/^AdbWinApi\.dll Authenticode/);
    });

    it('refuses an archive with no adb.exe, without running the check', async () => {
        stage(R37_BINARIES.filter((f) => f !== 'adb.exe'));
        const { check, calls } = checker(() => GOOGLE_VALID);

        await expect(verifyPlatformToolsAuthenticode(dir, check)).rejects.toThrow(
            'adb.exe missing from the platform-tools archive -- refusing to install',
        );
        expect(calls).toEqual([]);
    });

    it('refuses when the check itself cannot run', async () => {
        stage(R37_BINARIES);
        await expect(
            verifyPlatformToolsAuthenticode(dir, async () => {
                throw new Error('spawn powershell.exe ENOENT');
            }),
        ).rejects.toThrow(
            'platform-tools Authenticode check could not run (spawn powershell.exe ENOENT) -- refusing to install unverified platform-tools',
        );
    });

    it('refuses when the check answers for fewer files than it was given', async () => {
        stage(R37_BINARIES);
        await expect(verifyPlatformToolsAuthenticode(dir, async () => [GOOGLE_VALID])).rejects.toThrow(
            'platform-tools Authenticode check could not run (answered for 1 of 11 files) -- refusing to install unverified platform-tools',
        );
    });
});

// The real mechanism, on the platform it exists on, in one spawn: an unsigned
// script, bytes that are no PE, the running node.exe (signed by the OpenJS
// Foundation, so Valid but not Google), and a file that does not exist.
describe.runIf(process.platform === 'win32')('defaultAuthenticodeChecker on Windows', () => {
    it('answers for every file in one call, in order, and a path with [brackets] is not a wildcard', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-authenticode-[x]-'));
        try {
            // A script, because a signable type with no signature is what
            // reads NotSigned; bytes that are no PE at all read UnknownError.
            const unsigned = path.join(dir, 'unsigned.ps1');
            fs.writeFileSync(unsigned, 'Write-Output 1\n');
            const garbage = path.join(dir, 'adb.exe');
            fs.writeFileSync(garbage, 'MZ not really a PE file');
            const missing = path.join(dir, 'missing.dll');

            const results = await defaultAuthenticodeChecker([unsigned, garbage, process.execPath, missing]);

            expect(results.map((r) => r.status)).toEqual(['NotSigned', 'UnknownError', 'Valid', 'Error']);
            expect(results[0]!.subject).toBeNull();
            expect(parseDistinguishedName(results[2]!.subject ?? '').get('O')).toEqual(['OpenJS Foundation']);
            expect(results[3]!.statusMessage).toMatch(/not found/i);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('answers a one-file list as a one-element list', async () => {
        const results = await defaultAuthenticodeChecker([process.execPath]);
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe('Valid');
    });

    it('refuses a folder whose only adb.exe is signed by someone other than Google', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-authenticode-node-'));
        try {
            fs.copyFileSync(process.execPath, path.join(dir, 'adb.exe'));
            await expect(verifyPlatformToolsAuthenticode(dir, defaultAuthenticodeChecker)).rejects.toThrow(
                /^adb\.exe is signed by .*OpenJS Foundation.*, not Google LLC/,
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
