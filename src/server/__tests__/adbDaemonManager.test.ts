import { afterEach, describe, expect, it } from 'vitest';
import { AdbDaemonManager } from '../AdbDaemonManager';
import { AdbExecError } from '../AdbClient';

/**
 * Subclass that mocks the side-effectful spawn / kill-server steps so the
 * state machine + single-flight + waitMs semantics can be exercised
 * deterministically without touching a real adb binary or child process.
 */
class TestableAdbDaemonManager extends AdbDaemonManager {
    public spawnCallCount = 0;
    public killCallCount = 0;
    private spawnQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

    constructor(adbPath = '/fake/adb') {
        super(adbPath);
    }

    protected override waitForBinary(): Promise<void> {
        return Promise.resolve();
    }

    protected override spawnDetachedDaemon(): Promise<void> {
        this.spawnCallCount++;
        return new Promise<void>((resolve, reject) => {
            this.spawnQueue.push({ resolve, reject });
        });
    }

    protected override executeKillServer(): Promise<void> {
        this.killCallCount++;
        return Promise.resolve();
    }

    resolveSpawn(): void {
        const entry = this.spawnQueue.shift();
        if (!entry) throw new Error('no pending spawn to resolve');
        entry.resolve();
    }

    rejectSpawn(err: Error): void {
        const entry = this.spawnQueue.shift();
        if (!entry) throw new Error('no pending spawn to reject');
        entry.reject(err);
    }
}

const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

afterEach(() => {
    AdbDaemonManager._resetForTest();
});

describe('AdbDaemonManager — singleton', () => {
    it('returns same instance for same adbPath', () => {
        const a = AdbDaemonManager.getInstance('/path/adb');
        const b = AdbDaemonManager.getInstance('/path/adb');
        expect(a).toBe(b);
    });

    it('returns different instances for different adbPaths', () => {
        const a = AdbDaemonManager.getInstance('/path1/adb');
        const b = AdbDaemonManager.getInstance('/path2/adb');
        expect(a).not.toBe(b);
    });

    it('_resetForTest clears the instance cache', () => {
        const a = AdbDaemonManager.getInstance('/path/adb');
        AdbDaemonManager._resetForTest();
        const b = AdbDaemonManager.getInstance('/path/adb');
        expect(a).not.toBe(b);
    });
});

describe('AdbDaemonManager — state machine', () => {
    it('starts idle and not ready', () => {
        const mgr = new TestableAdbDaemonManager();
        expect(mgr.getState()).toBe('idle');
        expect(mgr.isReady()).toBe(false);
    });

    it('transitions idle → starting → ready on successful spawn', async () => {
        const mgr = new TestableAdbDaemonManager();
        const p = mgr.ensureReady();
        await flush();
        expect(mgr.getState()).toBe('starting');
        expect(mgr.isReady()).toBe(false);
        mgr.resolveSpawn();
        await p;
        expect(mgr.getState()).toBe('ready');
        expect(mgr.isReady()).toBe(true);
    });

    it('returns to idle on spawn failure (retryable)', async () => {
        const mgr = new TestableAdbDaemonManager();
        const p = mgr.ensureReady();
        await flush();
        mgr.rejectSpawn(new Error('spawn boom'));
        await expect(p).rejects.toThrow('spawn boom');
        expect(mgr.getState()).toBe('idle');
        expect(mgr.isReady()).toBe(false);
        // Retry: second ensureReady should kick off a fresh spawn.
        const p2 = mgr.ensureReady();
        await flush();
        expect(mgr.getState()).toBe('starting');
        expect(mgr.spawnCallCount).toBe(2);
        mgr.resolveSpawn();
        await p2;
        expect(mgr.isReady()).toBe(true);
    });
});

describe('AdbDaemonManager — single-flight', () => {
    it('N concurrent ensureReady() share one spawn', async () => {
        const mgr = new TestableAdbDaemonManager();
        const ps = [mgr.ensureReady(), mgr.ensureReady(), mgr.ensureReady(), mgr.ensureReady()];
        await flush();
        expect(mgr.spawnCallCount).toBe(1);
        mgr.resolveSpawn();
        await Promise.all(ps);
        expect(mgr.isReady()).toBe(true);
        expect(mgr.spawnCallCount).toBe(1);
    });

    it('ensureReady after success returns immediately without new spawn', async () => {
        const mgr = new TestableAdbDaemonManager();
        const p = mgr.ensureReady();
        await flush();
        mgr.resolveSpawn();
        await p;
        expect(mgr.spawnCallCount).toBe(1);
        await mgr.ensureReady();
        expect(mgr.spawnCallCount).toBe(1);
    });
});

describe('AdbDaemonManager — waitMs timeout', () => {
    it('ensureReady({ waitMs }) rejects with AdbExecError(timeout) when spawn takes longer', async () => {
        const mgr = new TestableAdbDaemonManager();
        const p = mgr.ensureReady({ waitMs: 30 });
        await expect(p).rejects.toBeInstanceOf(AdbExecError);
        try {
            // The previous await consumed the rejection; re-await the same
            // settled promise to inspect its kind without re-triggering work.
            await p;
            expect.fail('should have rejected');
        } catch (err) {
            expect((err as AdbExecError).kind).toBe('timeout');
            expect((err as AdbExecError).args).toEqual(['start-server']);
        }
        // The inflight is still going — the timeout only short-circuited the caller.
        expect(mgr.getState()).toBe('starting');
    });

    it('timeout does not disturb in-flight; subsequent ensureReady gets eventual result', async () => {
        const mgr = new TestableAdbDaemonManager();
        const p1 = mgr.ensureReady({ waitMs: 30 });
        await expect(p1).rejects.toBeInstanceOf(AdbExecError);
        expect(mgr.getState()).toBe('starting');
        // A second caller without waitMs picks up the same inflight.
        const p2 = mgr.ensureReady();
        mgr.resolveSpawn();
        await p2;
        expect(mgr.isReady()).toBe(true);
        expect(mgr.spawnCallCount).toBe(1);
    });
});

describe('AdbDaemonManager — kill', () => {
    it('kill() is a no-op when idle', async () => {
        const mgr = new TestableAdbDaemonManager();
        expect(mgr.getState()).toBe('idle');
        await mgr.kill();
        expect(mgr.getState()).toBe('idle');
        expect(mgr.killCallCount).toBe(0);
    });

    it('kill() transitions ready → killed and invokes adb kill-server', async () => {
        const mgr = new TestableAdbDaemonManager();
        const p = mgr.ensureReady();
        await flush();
        mgr.resolveSpawn();
        await p;
        expect(mgr.isReady()).toBe(true);
        await mgr.kill();
        expect(mgr.getState()).toBe('killed');
        expect(mgr.killCallCount).toBe(1);
    });

    it('kill() is a no-op when already killed', async () => {
        const mgr = new TestableAdbDaemonManager();
        const p = mgr.ensureReady();
        await flush();
        mgr.resolveSpawn();
        await p;
        await mgr.kill();
        await mgr.kill();
        expect(mgr.killCallCount).toBe(1);
    });

    it('ensureReady after kill re-spawns', async () => {
        const mgr = new TestableAdbDaemonManager();
        const p = mgr.ensureReady();
        await flush();
        mgr.resolveSpawn();
        await p;
        await mgr.kill();
        expect(mgr.getState()).toBe('killed');
        const p2 = mgr.ensureReady();
        await flush();
        expect(mgr.getState()).toBe('starting');
        expect(mgr.spawnCallCount).toBe(2);
        mgr.resolveSpawn();
        await p2;
        expect(mgr.isReady()).toBe(true);
    });

    it('kill() during in-flight spawn ends in killed even if spawn settles after', async () => {
        const mgr = new TestableAdbDaemonManager();
        const p = mgr.ensureReady();
        await flush();
        expect(mgr.getState()).toBe('starting');
        await mgr.kill();
        expect(mgr.getState()).toBe('killed');
        // Now the in-flight spawn settles — state must NOT revert to 'ready'.
        mgr.resolveSpawn();
        await p;
        expect(mgr.getState()).toBe('killed');
    });
});
