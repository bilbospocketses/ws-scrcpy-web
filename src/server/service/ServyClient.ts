/**
 * Windows ServiceClient implementation backed by the Servy CLI (v8.2).
 *
 * Servy is a tiny single-binary service manager bundled into our publish/
 * folder by `scripts/fetch-servy.mjs`. We invoke it synchronously via
 * `execFileSync` — every operation is fast enough (sub-second) that we wrap
 * the result in a resolved Promise to satisfy the cross-platform interface.
 *
 * CLI shape (v8.2 — see https://github.com/aelassas/servy):
 *   servy-cli install --name <Name> --displayName <DisplayName>
 *                     --description <Description> --binPath <Path>
 *                     --account currentUser|LocalSystem
 *                     --startType Automatic|Manual|Disabled
 *                     --maxRestartAttempts <N>
 *                     --envVars KEY1=VAL1;KEY2=VAL2
 *                     --logPath <Path>
 *   servy-cli uninstall --name <Name>
 *   servy-cli start     --name <Name>
 *   servy-cli stop      --name <Name>
 *   servy-cli restart   --name <Name>
 *   servy-cli list                            (status is parsed from this)
 *
 * Status detection: Servy v8.2 has no single-service status subcommand, so we
 * call `servy-cli list` and regex-match the named row to extract the running /
 * stopped state. If the name isn't present in the listing, the service is
 * `not-installed`.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
    ServiceClient,
    ServiceInstallOptions,
    ServiceStatus,
} from './ServiceClient';

/**
 * Resolve the absolute path of `servy-cli.exe`.
 *
 * Two layouts:
 *   1. Installed (Velopack): `servy-cli.exe` sits next to the launcher in
 *      the install root, which is also `process.cwd()` when the launcher
 *      spawns Node — so `path.join(process.cwd(), 'servy-cli.exe')` works.
 *   2. Dev / from-source: when running out of a `dist/` checkout there's no
 *      Velopack staging, but lead may have hand-staged a publish/ folder.
 *      Fall back to `<repoRoot>/publish/servy-cli.exe`.
 *
 * If neither exists, fall back to the bare name `servy-cli.exe` so the error
 * surface from execFileSync is "ENOENT: spawn servy-cli.exe" rather than a
 * silent miss — easier to triage.
 */
export function resolveServyPath(
    cwd: string = process.cwd(),
    moduleDir: string = __dirname,
    exists: (p: string) => boolean = fs.existsSync,
): string {
    const installedCandidate = path.join(cwd, 'servy-cli.exe');
    if (exists(installedCandidate)) return installedCandidate;
    // dev / from-source: most reliable is cwd/publish/servy-cli.exe (npm start
    // runs from repo root, fetch-servy.mjs writes there).
    const cwdPublishCandidate = path.join(cwd, 'publish', 'servy-cli.exe');
    if (exists(cwdPublishCandidate)) return cwdPublishCandidate;
    // Source-layout fallback (only useful when running un-bundled): src/server/service/ -> ../../../publish/
    const sourceCandidate = path.resolve(moduleDir, '..', '..', '..', 'publish', 'servy-cli.exe');
    if (exists(sourceCandidate)) return sourceCandidate;
    return 'servy-cli.exe';
}

/** Format envVars as Servy --envVars expects: KEY1=VAL1;KEY2=VAL2. */
function formatEnvVars(envVars: Record<string, string>): string {
    return Object.entries(envVars)
        .map(([k, v]) => `${k}=${v}`)
        .join(';');
}

/**
 * Wrap execFileSync so the thrown Error includes stderr — by default Node
 * surfaces only the exit code, which makes Servy failures opaque.
 */
function runServy(servyPath: string, args: string[]): string {
    try {
        const stdout = execFileSync(servyPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
        });
        return stdout;
    } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; stdout?: Buffer | string };
        const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
        const stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') ?? '';
        const detail = (stderr || stdout || e.message).trim();
        throw new Error(
            `servy-cli ${args[0] ?? '?'} failed: ${detail || e.message}`,
        );
    }
}

/**
 * Parse `servy-cli list` output to find the named service's status.
 *
 * v8.2 list output is a fixed-width table with columns:
 *   Name  DisplayName  Status  StartType  Account
 *
 * We match the row whose first whitespace-delimited token equals `name`
 * (case-insensitive — Windows service names are case-insensitive). The
 * second-to-last meaningful column tells us Running / Stopped.
 *
 * If the service isn't listed at all, return 'not-installed'.
 */
export function parseServyListStatus(output: string, name: string): ServiceStatus {
    const lines = output.split(/\r?\n/);
    const target = name.toLowerCase();
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const cols = trimmed.split(/\s{2,}|\t+/).filter((c) => c.length > 0);
        if (cols.length === 0) continue;
        if (cols[0].toLowerCase() !== target) continue;
        // Look across remaining columns for the status keyword. Servy reports
        // "Running" or "Stopped" (with a capital). Match case-insensitively
        // for resilience against locale / formatting drift.
        const joined = cols.slice(1).join(' ').toLowerCase();
        if (/\brunning\b/.test(joined)) return 'running';
        if (/\bstopped\b/.test(joined)) return 'stopped';
        // Found the row but couldn't classify — treat as stopped (safer
        // default than 'not-installed', since the row is present).
        return 'stopped';
    }
    return 'not-installed';
}

export class ServyClient implements ServiceClient {
    private readonly servyPath: string;

    constructor(servyPath?: string) {
        this.servyPath = servyPath ?? resolveServyPath();
    }

    public async install(opts: ServiceInstallOptions): Promise<void> {
        const args = [
            'install',
            '--name', opts.name,
            '--displayName', opts.displayName,
            '--description', opts.description,
            '--binPath', opts.binPath,
            '--account', opts.account,
            '--startType', opts.startType,
            '--maxRestartAttempts', String(opts.maxRestartAttempts),
            '--envVars', formatEnvVars(opts.envVars),
            '--logPath', opts.logPath,
        ];
        runServy(this.servyPath, args);
    }

    public async uninstall(name: string): Promise<void> {
        runServy(this.servyPath, ['uninstall', '--name', name]);
    }

    public async status(name: string): Promise<ServiceStatus> {
        const out = runServy(this.servyPath, ['list']);
        return parseServyListStatus(out, name);
    }

    public async restart(name: string): Promise<void> {
        runServy(this.servyPath, ['restart', '--name', name]);
    }

    public async stop(name: string): Promise<void> {
        runServy(this.servyPath, ['stop', '--name', name]);
    }
}
