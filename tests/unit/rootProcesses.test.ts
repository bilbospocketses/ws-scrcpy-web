import { type ChildProcess, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { privateServerPaths, removePrivateRoot, seedPrivateDataRoot } from '../e2e/support/privateServer';
import { isProcessAlive, removeTree, stopProcessesUnder } from '../e2e/support/rootProcesses';

// Item 170. On Windows the harness stops a spec-owned server with
// TerminateProcess, so the server's own `adb kill-server` never runs, and the
// adb daemon it pre-warmed -- detached, started from the adb under the spec's
// data root -- survives and holds adb.exe open. Removing the root then threw
// EPERM, in teardown and again at the next run's seed.
//
// These tests stand a copy of node in for that daemon: copied to where the
// server installs adb, started detached and unref'd, left running. On Linux a
// running binary CAN be unlinked, so the removal alone never failed there; what
// these assert on every platform is that the process is gone afterwards.

// Not `adb.exe`, deliberately: on Windows, src/server/__tests__/UpdateService.test.ts
// mocks only `spawn`, so its applyUpdate runs the real `taskkill /F /IM adb.exe /T`
// and kills every adb.exe on the machine. Under the full suite that killed this
// file's stand-in mid-test (measured 2026-10-06, three runs of three). The
// folder is the real one; only the image name differs.
const STANDIN_NAME = process.platform === 'win32' ? 'adb-standin.exe' : 'adb-standin';

const spawned: ChildProcess[] = [];
const roots: string[] = [];

function uniqueName(): string {
    return `ws-scrcpy-web-e2e-unit-170-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Run `exe` as node, detached and unref'd, and resolve once its script is
 * running -- fully up, as the daemon it stands in for is by the time a
 * teardown runs. A bare spawn queried at once matched nothing in one full-suite
 * run (2026-10-06); the cause was not isolated, so the stand-in is made to
 * prove it is running before anything is asserted about stopping it.
 */
async function startNode(exe: string): Promise<ChildProcess> {
    const child = spawn(exe, ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
    });
    spawned.push(child);
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${exe} did not start within 30 s`)), 30_000);
        child.once('error', reject);
        child.stdout?.once('data', () => {
            clearTimeout(timer);
            resolve();
        });
    });
    child.stdout?.destroy();
    child.unref();
    return child;
}

/** Copy node into `<programData>/WsScrcpyWeb/dependencies/adb/`, where the server installs adb, and run it there. */
async function startFakeDaemon(programData: string): Promise<ChildProcess> {
    roots.push(programData);
    const dir = path.join(programData, 'WsScrcpyWeb', 'dependencies', 'adb');
    mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, STANDIN_NAME);
    copyFileSync(process.execPath, exe);
    return startNode(exe);
}

// The helper's own liveness check: on Linux a killed child of this worker stays
// a zombie (it answers kill(pid, 0)) until the event loop reaps it, so a plain
// signal-0 probe read every stopped stand-in as alive on Linux CI (#880).
const isAlive = isProcessAlive;

async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return predicate();
}

afterEach(async () => {
    // Always, even when a test failed: no stand-in daemon may outlive the file.
    for (const child of spawned.splice(0)) {
        const pid = child.pid;
        if (pid === undefined) continue;
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // already gone
        }
        await waitUntil(() => !isAlive(pid), 5_000);
    }
    // Retried by hand: an image can stay locked a moment after its process is gone.
    for (const root of roots.splice(0)) {
        let last: unknown;
        const removed = await waitUntil(() => {
            try {
                rmSync(root, { recursive: true, force: true });
                return true;
            } catch (err) {
                last = err;
                return false;
            }
        }, 10_000);
        if (!removed) console.warn('rootProcesses.test cleanup could not remove', root, String(last));
    }
});

describe('a process running from a spec data root (item 170)', () => {
    it('removePrivateRoot stops it, then removes the root', { timeout: 60_000 }, async () => {
        const paths = privateServerPaths(uniqueName(), 8170);
        const daemon = await startFakeDaemon(paths.programData);
        const pid = daemon.pid as number;
        expect(isAlive(pid), 'the stand-in daemon is running').toBe(true);

        removePrivateRoot(paths);

        expect(existsSync(paths.programData), 'the root is gone').toBe(false);
        expect(isAlive(pid), 'the stand-in daemon was stopped').toBe(false);
    });

    it('removeTree retries while a process that just exited still holds its image', { timeout: 60_000 }, async () => {
        // The hold outlives the process by a few ms, and rmSync's own maxRetries
        // does not retry EPERM (Node 24.19, Windows): without a retry of its own
        // this throws, with nothing left running.
        const paths = privateServerPaths(uniqueName(), 8170);
        const daemon = await startFakeDaemon(paths.programData);
        process.kill(daemon.pid as number, 'SIGKILL');

        removeTree(paths.programData);

        expect(existsSync(paths.programData), 'the root is gone').toBe(false);
    });

    it('seedPrivateDataRoot stops a leftover from an earlier run before re-seeding', { timeout: 60_000 }, async () => {
        const paths = privateServerPaths(uniqueName(), 8170);
        const daemon = await startFakeDaemon(paths.programData);
        const pid = daemon.pid as number;

        seedPrivateDataRoot(paths);

        expect(isAlive(pid), 'the leftover daemon was stopped').toBe(false);
        expect(existsSync(paths.configPath), 'the root was re-seeded').toBe(true);
        expect(
            existsSync(path.join(paths.dataRoot, 'dependencies', 'adb', STANDIN_NAME)),
            'the leftover adb was wiped',
        ).toBe(false);
    });

    it('stopProcessesUnder stops only what runs from INSIDE the root', { timeout: 60_000 }, async () => {
        const root = path.join(tmpdir(), uniqueName());
        // Shares the root's name as a string prefix: only the separator tells them apart.
        const sibling = `${root}-sibling`;
        const inside = await startFakeDaemon(root);
        const outside = await startFakeDaemon(sibling);
        // And the runner's own interpreter, from wherever it is installed.
        const plain = await startNode(process.execPath);
        expect(isAlive(inside.pid as number), 'the process inside the root is running').toBe(true);

        const stopped = stopProcessesUnder(root);

        expect(stopped.map((s) => Number(s.split(' ')[0]))).toEqual([inside.pid]);
        expect(isAlive(inside.pid as number), 'the process inside the root was stopped').toBe(false);
        expect(isAlive(outside.pid as number), 'the process in the sibling folder still runs').toBe(true);
        expect(isAlive(plain.pid as number), "the runner's own node still runs").toBe(true);
        expect(isAlive(process.pid), 'the current process still runs').toBe(true);
    });

    it('returns nothing for a root that does not exist', () => {
        expect(stopProcessesUnder(path.join(tmpdir(), uniqueName()))).toEqual([]);
    });
});
