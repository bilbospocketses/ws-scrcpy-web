import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from '@playwright/test';

/**
 * Spec-owned compose stacks for the `@docker` rows that need a container the
 * main stack cannot be (1.9 boots with no resolver, 9.5 boots without the
 * node-pty prebuilt). Each spec brings its own stack up, on its own port and
 * volume, and tears it down in its `finally`.
 *
 * `docker` is resolved from the shell, as `playwright.docker.config.ts`'s
 * `docker compose up --wait` already is: the daemon is the tier's execution
 * environment, not an app dependency (the user ruled so for these rows on
 * 2026-09-03). The compose files live under tests/docker/.
 */

function repoRoot(): string {
    const configFile = test.info().config.configFile;
    return configFile ? path.dirname(configFile) : process.cwd();
}

function composeFile(name: string): string {
    return path.join(repoRoot(), 'tests', 'docker', name);
}

function docker(args: string[], timeoutMs: number): string {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `docker compose -f <file> up --wait`, on a fresh volume: any leftover stack is torn down first. */
export function composeUpFresh(file: string, opts?: { build?: boolean; timeoutMs?: number }): void {
    const f = composeFile(file);
    try {
        docker(['compose', '-f', f, 'down', '-v', '--remove-orphans'], 120_000);
    } catch {
        // nothing to tear down
    }
    const args = ['compose', '-f', f, 'up', '--wait'];
    if (opts?.build) args.splice(4, 0, '--build');
    docker(args, opts?.timeoutMs ?? 300_000);
}

export function composeDown(file: string): void {
    try {
        docker(['compose', '-f', composeFile(file), 'down', '-v', '--remove-orphans'], 120_000);
    } catch (err) {
        console.warn(`compose down ${file}: ${String(err)}`);
    }
}

/** Run a shell command inside a container as root. */
export function dockerExecRoot(container: string, script: string): string {
    return docker(['exec', '-u', '0', container, 'sh', '-c', script], 30_000);
}

export function dockerLogs(container: string): string {
    try {
        return docker(['logs', container], 30_000);
    } catch (err) {
        return `(docker logs failed: ${String(err)})`;
    }
}
