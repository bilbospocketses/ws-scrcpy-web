import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
    AUTHENTICODE_FILE_ENV,
    AUTHENTICODE_SCRIPT,
    defaultAuthenticodeChecker,
    isGoogleSigner,
    parseAuthenticodeOutput,
    parseDistinguishedName,
    verifyAdbAuthenticode,
} from '../adbAuthenticode';

/** What Get-AuthenticodeSignature reports for platform-tools r37's adb.exe (read 2026-10-07). */
const GOOGLE_SUBJECT =
    'CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US, SERIALNUMBER=3582691, ' +
    'OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US';

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
    it('reads the JSON line the script prints, ignoring a BOM and stray lines', () => {
        const out = `\uFEFFWARNING: noise\r\n{"status":"Valid","subject":"CN=Google LLC, O=Google LLC","statusMessage":"Signature verified."}\r\n`;
        expect(parseAuthenticodeOutput(out)).toEqual({
            status: 'Valid',
            subject: 'CN=Google LLC, O=Google LLC',
            statusMessage: 'Signature verified.',
        });
    });

    it('reads an unsigned file as a null subject', () => {
        expect(parseAuthenticodeOutput('{"status":"NotSigned","subject":null}')).toEqual({
            status: 'NotSigned',
            subject: null,
        });
    });

    it('throws on output with no result', () => {
        expect(() => parseAuthenticodeOutput('')).toThrow('Get-AuthenticodeSignature printed no result');
    });

    it('takes its one input from the child environment, never spliced into the script', () => {
        expect(AUTHENTICODE_SCRIPT).toContain(`-LiteralPath $env:${AUTHENTICODE_FILE_ENV}`);
    });
});

describe('verifyAdbAuthenticode', () => {
    const file = 'C:\\tmp\\platform-tools\\adb.exe';

    it('passes a valid Google LLC signature', async () => {
        await expect(
            verifyAdbAuthenticode(file, async () => ({ status: 'Valid', subject: GOOGLE_SUBJECT })),
        ).resolves.toBeUndefined();
    });

    it('refuses an unsigned file', async () => {
        await expect(verifyAdbAuthenticode(file, async () => ({ status: 'NotSigned', subject: null }))).rejects.toThrow(
            'adb.exe Authenticode signature is not valid (NotSigned) -- refusing to install',
        );
    });

    it('refuses an invalid signature even from Google', async () => {
        await expect(
            verifyAdbAuthenticode(file, async () => ({
                status: 'HashMismatch',
                subject: GOOGLE_SUBJECT,
                statusMessage: 'The contents of the file may have been tampered with.',
            })),
        ).rejects.toThrow(
            'adb.exe Authenticode signature is not valid (HashMismatch: The contents of the file may have been tampered with.) -- refusing to install',
        );
    });

    it('refuses a valid signature by another signer', async () => {
        const subject = 'CN=OpenJS Foundation, O=OpenJS Foundation, C=US';
        await expect(verifyAdbAuthenticode(file, async () => ({ status: 'Valid', subject }))).rejects.toThrow(
            `adb.exe is signed by ${JSON.stringify(subject)}, not Google LLC -- refusing to install`,
        );
    });

    it('refuses when the check itself cannot run', async () => {
        await expect(
            verifyAdbAuthenticode(file, async () => {
                throw new Error('spawn powershell.exe ENOENT');
            }),
        ).rejects.toThrow(
            'adb.exe Authenticode check could not run (spawn powershell.exe ENOENT) -- refusing to install unverified platform-tools',
        );
    });
});

// The real mechanism, on the platform it exists on: an unsigned file and the
// running node.exe (signed by the OpenJS Foundation, so Valid but not Google).
describe.runIf(process.platform === 'win32')('defaultAuthenticodeChecker on Windows', () => {
    it('reports an unsigned file as NotSigned, and a path with [brackets] is not a wildcard', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-authenticode-[x]-'));
        try {
            // A script, because a signable type with no signature is what
            // reads NotSigned; bytes that are no PE at all read UnknownError.
            const file = path.join(dir, 'unsigned.ps1');
            fs.writeFileSync(file, 'Write-Output 1\n');
            const result = await defaultAuthenticodeChecker(file);
            expect(result.status).toBe('NotSigned');
            expect(result.subject).toBeNull();

            const garbage = path.join(dir, 'adb.exe');
            fs.writeFileSync(garbage, 'MZ not really a PE file');
            await expect(verifyAdbAuthenticode(garbage, defaultAuthenticodeChecker)).rejects.toThrow(
                /^adb\.exe Authenticode signature is not valid \(UnknownError/,
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reads node.exe's valid signature and its signer", async () => {
        const result = await defaultAuthenticodeChecker(process.execPath);
        expect(result.status).toBe('Valid');
        expect(parseDistinguishedName(result.subject ?? '').get('O')).toEqual(['OpenJS Foundation']);
        await expect(verifyAdbAuthenticode(process.execPath, defaultAuthenticodeChecker)).rejects.toThrow(
            /is signed by .*OpenJS Foundation.*, not Google LLC/,
        );
    });
});
