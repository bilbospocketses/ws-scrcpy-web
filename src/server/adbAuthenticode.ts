import { execFile } from 'child_process';
import { envWithoutPsModulePath, POWERSHELL_EXE } from './util/reapOwnAdb';

/**
 * M5: on Windows, the `adb.exe` inside a platform-tools archive must carry a
 * valid Authenticode signature from Google LLC before it is installed.
 *
 * Google publishes no signature over `repository2-3.xml`, so the archive's own
 * check is its size and SHA-1 from that index, both read over TLS from the host
 * that serves the archive. The Authenticode signature is the one publisher
 * signature that exists, and it is on the binary the app goes on to run. Linux
 * has no equivalent: there, adb is verified by size and SHA-1 alone.
 *
 * **Mechanism: `Get-AuthenticodeSignature` in Windows PowerShell 5.1, run by
 * absolute path.** It is a thin wrapper over `WinVerifyTrust`, the OS's own
 * check (chain to a trusted root, certificate validity, the file's hash against
 * the signed digest), and it needs nothing installed: calling `WinVerifyTrust`
 * directly from Node would need a native addon or an FFI package this app does
 * not ship. The executable is the literal System32 path (`POWERSHELL_EXE`), never
 * a PATH lookup, and the file to check reaches the script through the child's
 * environment, so nothing is spliced into the script text.
 */

/** What the check reports about one file. */
export interface AuthenticodeResult {
    /** `Get-AuthenticodeSignature`'s `Status`: `Valid`, `NotSigned`, `HashMismatch`, `UnknownError`, ... */
    status: string;
    /** The signer certificate's subject DN, or null when there is none. */
    subject: string | null;
    statusMessage?: string;
}

export type AuthenticodeChecker = (file: string) => Promise<AuthenticodeResult>;

/** The child-environment variable the script reads its one input from. */
export const AUTHENTICODE_FILE_ENV = 'WS_SCRCPY_AUTHENTICODE_FILE';

/** UTF-8 out, one JSON object; `-LiteralPath` so a `[` in the path is not a wildcard. */
export const AUTHENTICODE_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }',
    `$s = Get-AuthenticodeSignature -LiteralPath $env:${AUTHENTICODE_FILE_ENV}`,
    '$subject = $null',
    'if ($s.SignerCertificate) { $subject = [string]$s.SignerCertificate.Subject }',
    '[Console]::Out.WriteLine((@{ status = [string]$s.Status; subject = $subject; statusMessage = [string]$s.StatusMessage } | ConvertTo-Json -Compress))',
].join('\n');

/** PowerShell's cold start on a loaded, scanned box, plus a certificate-chain build. */
const TIMEOUT_MS = 30_000;

export function parseAuthenticodeOutput(stdout: string): AuthenticodeResult {
    const line = stdout
        .replace(/^﻿/, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.startsWith('{'));
    if (!line) throw new Error('Get-AuthenticodeSignature printed no result');
    const parsed = JSON.parse(line) as { status?: unknown; subject?: unknown; statusMessage?: unknown };
    if (typeof parsed.status !== 'string') throw new Error('Get-AuthenticodeSignature printed no status');
    return {
        status: parsed.status,
        subject: typeof parsed.subject === 'string' ? parsed.subject : null,
        ...(typeof parsed.statusMessage === 'string' ? { statusMessage: parsed.statusMessage } : {}),
    };
}

export const defaultAuthenticodeChecker: AuthenticodeChecker = (file) =>
    new Promise((resolve, reject) => {
        const encoded = Buffer.from(AUTHENTICODE_SCRIPT, 'utf16le').toString('base64');
        execFile(
            POWERSHELL_EXE,
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            {
                timeout: TIMEOUT_MS,
                windowsHide: true,
                encoding: 'utf8',
                env: { ...envWithoutPsModulePath(), [AUTHENTICODE_FILE_ENV]: file },
            },
            (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                try {
                    resolve(parseAuthenticodeOutput(String(stdout ?? '')));
                } catch (parseErr) {
                    reject(parseErr);
                }
            },
        );
    });

/**
 * The relative distinguished names of a subject DN as Windows prints it
 * (`CN=Google LLC, O=Google LLC, L=Mountain View, ...`). A value may be quoted
 * when it holds a comma; quotes are removed and `""` unescaped.
 */
export function parseDistinguishedName(dn: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const m of dn.matchAll(/(?:^|,)\s*([A-Za-z0-9.]+)=("(?:[^"]|"")*"|[^,]*)/g)) {
        const key = m[1]!.toUpperCase();
        let value = m[2]!.trim();
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
            value = value.slice(1, -1).replace(/""/g, '"');
        }
        out.set(key, [...(out.get(key) ?? []), value]);
    }
    return out;
}

export const ADB_SIGNER = 'Google LLC';

/** Exactly one CN and one O, both `Google LLC`. */
export function isGoogleSigner(subject: string | null): boolean {
    if (!subject) return false;
    const rdns = parseDistinguishedName(subject);
    const cn = rdns.get('CN') ?? [];
    const o = rdns.get('O') ?? [];
    return cn.length === 1 && cn[0] === ADB_SIGNER && o.length === 1 && o[0] === ADB_SIGNER;
}

/** Throws unless `file` is validly Authenticode-signed by Google LLC. */
export async function verifyAdbAuthenticode(file: string, check: AuthenticodeChecker): Promise<void> {
    let result: AuthenticodeResult;
    try {
        result = await check(file);
    } catch (err) {
        throw new Error(
            `adb.exe Authenticode check could not run (${(err as Error).message}) -- refusing to install unverified platform-tools`,
        );
    }
    if (result.status !== 'Valid') {
        throw new Error(
            `adb.exe Authenticode signature is not valid (${result.status}` +
                `${result.statusMessage ? `: ${result.statusMessage}` : ''}) -- refusing to install`,
        );
    }
    if (!isGoogleSigner(result.subject)) {
        throw new Error(
            `adb.exe is signed by ${JSON.stringify(result.subject)}, not ${ADB_SIGNER} -- refusing to install`,
        );
    }
}
