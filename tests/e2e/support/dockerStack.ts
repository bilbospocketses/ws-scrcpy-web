import { execFileSync, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from '@playwright/test';
import { WAIT_MS } from './timeouts';

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

/**
 * `docker <args>`. `timeoutMs` is a hang guard, never a speed check: none is
 * below WAIT_MS, and a run that reaches it fails as HUNG, naming the command.
 */
function docker(args: string[], timeoutMs: number): string {
    try {
        return execFileSync('docker', args, {
            encoding: 'utf8',
            timeout: timeoutMs,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
            throw new Error(`HUNG: \`docker ${args.join(' ')}\` did not finish in ${timeoutMs / 1000} s`, {
                cause: err,
            });
        }
        throw err;
    }
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
    return docker(['exec', '-u', '0', container, 'sh', '-c', script], WAIT_MS);
}

/**
 * Both streams. `docker logs` replays the container's stderr on its OWN stderr,
 * so the stdout-only `docker()` returned "" for anything the entrypoint wrote
 * with `>&2` (found by row 20.21, whose refusal message goes there).
 */
export function dockerLogs(container: string): string {
    const r = spawnSync('docker', ['logs', container], { encoding: 'utf8', timeout: WAIT_MS });
    if (r.error) return `(docker logs failed: ${String(r.error)})`;
    return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** Docker's own word for the container's state ('running', 'exited', …) and its exit code. */
export function dockerInspectState(container: string): { status: string; exitCode: number } {
    const out = docker(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', container], WAIT_MS).trim();
    const [status = '', code = 'NaN'] = out.split(' ');
    return { status, exitCode: Number(code) };
}

/**
 * `docker stop` with docker's default grace (10 s). Row 20.12 reads the exit
 * code afterwards: 0 means node finished inside the grace, 137 that docker
 * SIGKILLed it.
 */
export function dockerStop(container: string): void {
    docker(['stop', container], WAIT_MS);
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
    return docker(['run', '--rm', '--entrypoint', 'cat', '-v', `${volume}:/data:ro`, appImage(), filePath], WAIT_MS);
}

/** The image under test: the tier's `WSSW_IMAGE`, else the compose default. */
export function appImage(): string {
    return process.env['WSSW_IMAGE'] ?? 'ws-scrcpy-web:local';
}

/**
 * `docker <args>` for a spec that runs its own container with flags compose
 * cannot vary per run (row 20.21's `--user`). Throws on a non-zero exit.
 */
export function dockerCli(args: string[], timeoutMs = WAIT_MS): string {
    return docker(args, timeoutMs);
}

/**
 * How long a `docker pull` may print nothing before it fails as HUNG. Without a
 * TTY docker prints one line per layer event (waiting, download complete,
 * extracting, pull complete), so one large layer on a slow link is silent for
 * its whole download; the window is long for that reason.
 */
const DOCKER_PULL_STALL_MS = 10 * 60_000;

/**
 * `docker pull`, bounded by NO PROGRESS rather than total time: a first pull of
 * the ~200 MB image on a cold runner is only slow. It fails as HUNG when docker
 * prints nothing for DOCKER_PULL_STALL_MS, and with docker's own output when the
 * pull itself fails.
 */
export function dockerPull(ref: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('docker', ['pull', ref], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let stalled = false;
        let timer: NodeJS.Timeout | undefined;
        const progress = (): void => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                stalled = true;
                child.kill();
            }, DOCKER_PULL_STALL_MS);
        };
        const onData = (chunk: Buffer): void => {
            output += chunk.toString();
            progress();
        };
        progress();
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            if (stalled) {
                reject(
                    new Error(
                        `HUNG: \`docker pull ${ref}\` printed nothing for ${DOCKER_PULL_STALL_MS / 1000} s:\n${output}`,
                    ),
                );
            } else if (code !== 0) {
                reject(new Error(`\`docker pull ${ref}\` exited ${code}:\n${output}`));
            } else {
                resolve();
            }
        });
    });
}

/** `docker image inspect --format <fmt>` for one image ref. */
export function dockerImageInspect(ref: string, format: string): string {
    return docker(['image', 'inspect', '--format', format, ref], WAIT_MS).trim();
}
