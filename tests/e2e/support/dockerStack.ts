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

/** Docker's own word for the container's state ('running', 'exited', …) and its exit code. */
export function dockerInspectState(container: string): { status: string; exitCode: number } {
    const out = docker(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', container], 30_000).trim();
    const [status = '', code = 'NaN'] = out.split(' ');
    return { status, exitCode: Number(code) };
}

/** `docker stop` with docker's default grace (10 s), timed: rows 20.6/20.12 assert it finishes inside it. */
export function dockerStop(container: string): { elapsedMs: number } {
    const started = Date.now();
    docker(['stop', container], 60_000);
    return { elapsedMs: Date.now() - started };
}

/**
 * `docker rm` the stack's container and bring it back on the SAME volume — row
 * 20.11's "docker rm the container, keep the volume, compose up again". Not
 * composeUpFresh, which is `down -v` and would take the volume with it.
 */
export function composeRecreateKeepingVolume(file: string, opts?: { timeoutMs?: number }): void {
    const f = composeFile(file);
    docker(['compose', '-f', f, 'rm', '--stop', '--force'], 120_000);
    docker(['compose', '-f', f, 'up', '--wait'], opts?.timeoutMs ?? 300_000);
}

/**
 * Read a file off a named volume without a running container: a throwaway run
 * of the app image itself with `cat` as the entrypoint. The app image rather
 * than a `busybox`/`alpine` pull because it is already present wherever this
 * tier runs, and the tier must not depend on Docker Hub being reachable.
 */
export function readVolumeFile(volume: string, filePath: string): string {
    const image = process.env['WSSW_IMAGE'] ?? 'ws-scrcpy-web:local';
    return docker(['run', '--rm', '--entrypoint', 'cat', '-v', `${volume}:/data:ro`, image, filePath], 60_000);
}

/** `docker pull`, generously timed: a first pull of the ~200 MB image on a cold runner. */
export function dockerPull(ref: string): void {
    docker(['pull', ref], 600_000);
}

/** `docker image inspect --format <fmt>` for one image ref. */
export function dockerImageInspect(ref: string, format: string): string {
    return docker(['image', 'inspect', '--format', format, ref], 30_000).trim();
}
