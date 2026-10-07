import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { envWithoutPsModulePath, POWERSHELL_EXE } from './util/reapOwnAdb';

/**
 * M5: on Windows, EVERY `.exe` and `.dll` inside a platform-tools archive must
 * carry a valid Authenticode signature from Google LLC before any of it is
 * installed.
 *
 * Google publishes no signature over `repository2-3.xml`, so the archive's own
 * check is its size and SHA-1 from that index, both read over TLS from the host
 * that serves the archive. The Authenticode signatures are the one publisher
 * signature that exists, and they are on the binaries the app goes on to run.
 * Checking `adb.exe` alone is not enough: the whole folder is installed, and
 * adb.exe loads `AdbWinApi.dll` from its own directory first, so a genuine
 * adb.exe beside a substituted DLL would run the substitute. Every file of
 * r37's Windows platform-tools (11: adb.exe, AdbWinApi.dll, AdbWinUsbApi.dll,
 * etc1tool.exe, fastboot.exe, hprof-conv.exe, libwinpthread-1.dll,
 * make_f2fs.exe, make_f2fs_casefold.exe, mke2fs.exe, sqlite3.exe) is signed
 * `Valid` by `CN=Google LLC, O=Google LLC` (read 2026-10-07). Linux has no
 * equivalent: there, adb is verified by size and SHA-1 alone.
 *
 * **Mechanism: `Get-AuthenticodeSignature` in Windows PowerShell 5.1, run by
 * absolute path, ONCE for the whole list.** It is a thin wrapper over
 * `WinVerifyTrust`, the OS's own check (chain to a trusted root, certificate
 * validity, the file's hash against the signed digest), and it needs nothing
 * installed: calling `WinVerifyTrust` directly from Node would need a native
 * addon or an FFI package this app does not ship. The executable is the literal
 * System32 path (`POWERSHELL_EXE`), never a PATH lookup, and the files to check
 * reach the script as a JSON array in the child's environment, so nothing is
 * spliced into the script text. One spawn for all 11 files took ~0.8 s warm and
 * ~3.5 s cold on the dev box.
 */

/** What the check reports about one file. */
export interface AuthenticodeResult {
    /** `Get-AuthenticodeSignature`'s `Status`: `Valid`, `NotSigned`, `HashMismatch`, `UnknownError`, ... */
    status: string;
    /** The signer certificate's subject DN, or null when there is none. */
    subject: string | null;
    statusMessage?: string;
}

/**
 * Checks every file in one go. The answer holds one result per file, in the
 * order asked; anything else is treated as a check that could not run.
 */
export type AuthenticodeChecker = (files: readonly string[]) => Promise<AuthenticodeResult[]>;

/** The child-environment variable the script reads its one input from: a JSON array of paths. */
export const AUTHENTICODE_FILES_ENV = 'WS_SCRCPY_AUTHENTICODE_FILES';

/**
 * UTF-8 out, one JSON array. `-LiteralPath` so a `[` in a path is not a
 * wildcard. `ConvertFrom-Json` is NOT wrapped in `@()`: Windows PowerShell 5.1
 * emits the parsed array as one object, and `@()` would nest it. A file the
 * cmdlet throws on is reported as status `Error` with the exception's message,
 * so the caller can still name it; `ConvertTo-Json -InputObject @(...)` keeps a
 * one-element answer an array.
 */
export const AUTHENTICODE_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }',
    `$files = ConvertFrom-Json -InputObject $env:${AUTHENTICODE_FILES_ENV}`,
    '$out = New-Object System.Collections.ArrayList',
    'foreach ($f in $files) {',
    '    $file = [string]$f',
    '    try {',
    '        $s = Get-AuthenticodeSignature -LiteralPath $file',
    '        $subject = $null',
    '        if ($s.SignerCertificate) { $subject = [string]$s.SignerCertificate.Subject }',
    '        [void]$out.Add([ordered]@{ file = $file; status = [string]$s.Status; subject = $subject; statusMessage = [string]$s.StatusMessage })',
    '    } catch {',
    "        [void]$out.Add([ordered]@{ file = $file; status = 'Error'; subject = $null; statusMessage = [string]$_.Exception.Message })",
    '    }',
    '}',
    '[Console]::Out.WriteLine((ConvertTo-Json -InputObject @($out) -Compress))',
].join('\n');

/** PowerShell's cold start on a loaded, scanned box, plus a certificate-chain build per file. */
const TIMEOUT_MS = 30_000;

/**
 * The JSON array the script prints, checked against the files asked for: the
 * same count, in the same order, each naming its own file. A mismatch throws,
 * which the caller treats as a check that could not run.
 */
export function parseAuthenticodeOutput(stdout: string, files: readonly string[]): AuthenticodeResult[] {
    const line = stdout
        .replace(/^﻿/, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.startsWith('['));
    if (!line) throw new Error('Get-AuthenticodeSignature printed no result');
    const parsed = JSON.parse(line) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Get-AuthenticodeSignature printed no result list');
    if (parsed.length !== files.length) {
        throw new Error(`Get-AuthenticodeSignature answered for ${parsed.length} of ${files.length} files`);
    }
    return parsed.map((entry: { file?: unknown; status?: unknown; subject?: unknown; statusMessage?: unknown }, i) => {
        if (entry?.file !== files[i]) {
            throw new Error(`Get-AuthenticodeSignature answered out of order at ${JSON.stringify(files[i])}`);
        }
        if (typeof entry.status !== 'string') throw new Error('Get-AuthenticodeSignature printed no status');
        return {
            status: entry.status,
            subject: typeof entry.subject === 'string' ? entry.subject : null,
            ...(typeof entry.statusMessage === 'string' ? { statusMessage: entry.statusMessage } : {}),
        };
    });
}

export const defaultAuthenticodeChecker: AuthenticodeChecker = (files) =>
    new Promise((resolve, reject) => {
        const encoded = Buffer.from(AUTHENTICODE_SCRIPT, 'utf16le').toString('base64');
        execFile(
            POWERSHELL_EXE,
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            {
                timeout: TIMEOUT_MS,
                windowsHide: true,
                encoding: 'utf8',
                env: { ...envWithoutPsModulePath(), [AUTHENTICODE_FILES_ENV]: JSON.stringify(files) },
            },
            (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                try {
                    resolve(parseAuthenticodeOutput(String(stdout ?? ''), files));
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

/** A file Windows can load as code, by extension, in any case. */
const SIGNABLE = /\.(?:exe|dll)$/i;

/**
 * Every `.exe` and `.dll` under `dir`, recursively, as paths relative to it
 * with `/` separators, sorted. Anything that is not a directory counts as a
 * file, which is exactly how the install's copy treats it, so the set checked
 * is the set installed.
 */
export async function listSignableFiles(dir: string, prefix = ''): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.promises.readdir(path.join(dir, prefix), { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...(await listSignableFiles(dir, rel)));
        else if (SIGNABLE.test(entry.name)) out.push(rel);
    }
    return out.sort();
}

/**
 * Throws unless the extracted platform-tools folder has an `adb.exe` and every
 * `.exe` and `.dll` in it is validly Authenticode-signed by Google LLC. The
 * first file that fails is the one the message names. Nothing is checked
 * piecemeal: one call to `check` covers the whole list.
 */
export async function verifyPlatformToolsAuthenticode(
    platformToolsDir: string,
    check: AuthenticodeChecker,
): Promise<void> {
    if (!fs.existsSync(path.join(platformToolsDir, 'adb.exe'))) {
        throw new Error('adb.exe missing from the platform-tools archive -- refusing to install');
    }
    const files = await listSignableFiles(platformToolsDir);
    let results: AuthenticodeResult[];
    try {
        results = await check(files.map((rel) => path.join(platformToolsDir, ...rel.split('/'))));
        if (results.length !== files.length) {
            throw new Error(`answered for ${results.length} of ${files.length} files`);
        }
    } catch (err) {
        throw new Error(
            `platform-tools Authenticode check could not run (${(err as Error).message}) -- refusing to install unverified platform-tools`,
        );
    }
    for (const [i, name] of files.entries()) {
        const result = results[i]!;
        if (result.status !== 'Valid') {
            throw new Error(
                `${name} Authenticode signature is not valid (${result.status}` +
                    `${result.statusMessage ? `: ${result.statusMessage}` : ''}) -- refusing to install`,
            );
        }
        if (!isGoogleSigner(result.subject)) {
            throw new Error(
                `${name} is signed by ${JSON.stringify(result.subject)}, not ${ADB_SIGNER} -- refusing to install`,
            );
        }
    }
}
