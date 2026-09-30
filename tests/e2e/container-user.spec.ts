import { expect, request, test } from '@playwright/test';
import { mintToken } from './support/auth';
import { appImage, dockerCli, dockerExecRoot, dockerInspectState, dockerLogs } from './support/dockerStack';

/**
 * Smoke row 20.21: the image run as another user (`docker run --user`, compose
 * `user:`). Item 12 of the container audit, measured 2026-09-30 before the fix:
 * - on a fresh named volume (root-owned) the server died at boot with exit 1 and
 *   nothing naming the cause;
 * - on a volume pre-owned by that uid it booted, but Docker's HOME=/ made adb
 *   abort on "Cannot mkdir '//.android'", so no device could ever appear.
 *
 * `@docker-host`: each test runs its own container through the docker CLI (a
 * per-run `--user` is not something the shared compose stack can vary), on its
 * own port and volume, and removes both in its `finally`. Port 8140 is outside
 * the 8123-8139 range the other stacks and private servers use.
 */

const NAME = 'wssw-user';
const VOLUME = 'wssw-user-data';
const PORT = 8140;
const BASE = `http://127.0.0.1:${PORT}`;
const UID = '1234:1234';

function cleanup(): void {
    for (const args of [
        ['rm', '-f', NAME],
        ['volume', 'rm', '-f', VOLUME],
    ]) {
        try {
            dockerCli(args);
        } catch {
            // nothing to remove
        }
    }
}

async function waitForExit(timeoutMs: number): Promise<{ status: string; exitCode: number }> {
    const deadline = Date.now() + timeoutMs;
    let last = dockerInspectState(NAME);
    while (last.status !== 'exited' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        last = dockerInspectState(NAME);
    }
    return last;
}

test.describe('the container run as another user (smoke §20.21)', () => {
    test('@docker @docker-host 20.21 `--user` on a volume that uid does not own stops at once and names the fix', async () => {
        test.setTimeout(180_000);
        cleanup();
        try {
            dockerCli(['run', '-d', '--name', NAME, '--user', UID, '-v', `${VOLUME}:/data`, appImage()]);
            expect(await waitForExit(60_000), 'container state').toEqual({ status: 'exited', exitCode: 1 });
            const logs = dockerLogs(NAME);
            expect(logs).toContain('[entrypoint] /data is not writable by uid 1234:1234.');
            expect(logs).toContain('--entrypoint chown');
            expect(logs).toContain('drop --user');
        } finally {
            cleanup();
        }
    });

    test('@docker @docker-host 20.21 `--user` on a volume that uid owns: it boots, HOME is on the volume, and adb works', async () => {
        test.setTimeout(480_000);
        cleanup();
        const ctx = await request.newContext({ baseURL: BASE });
        try {
            // The documented fix, run exactly as the entrypoint's message gives it.
            dockerCli(['run', '--rm', '-u', '0', '-v', `${VOLUME}:/data`, '--entrypoint', 'chown', appImage(), '-R', UID, '/data']);
            dockerCli([
                'run',
                '-d',
                '--name',
                NAME,
                '--user',
                UID,
                '-p',
                `127.0.0.1:${PORT}:8000`,
                '-e',
                'WS_SCRCPY_ALLOW_REMOTE_ADMIN=1',
                '-v',
                `${VOLUME}:/data`,
                appImage(),
            ]);
            await expect
                .poll(async () => (await ctx.get('/api/config').catch(() => null))?.status() ?? 0, {
                    timeout: 120_000,
                    message: 'server answers /api/config',
                })
                .toBe(200);
            await mintToken(ctx);

            // adb creates $HOME/.android on EVERY invocation, `--version`
            // included, and aborts when it cannot. So a real installed version
            // is only possible with a writable HOME; before the fix it stayed
            // null on this exact setup.
            let adbVersion: string | null = null;
            await expect
                .poll(
                    async () => {
                        const deps = (await (await ctx.get('/api/dependencies')).json()) as {
                            name: string;
                            installedVersion: string | null;
                        }[];
                        adbVersion = deps.find((d) => d.name === 'adb')?.installedVersion ?? null;
                        return adbVersion;
                    },
                    { timeout: 300_000, message: 'adb installed and answering --version' },
                )
                .toMatch(/^\d+\.\d+\.\d+$/);

            expect(dockerExecRoot(NAME, 'stat -c %u /proc/1').trim(), 'PID 1 runs as the requested uid').toBe('1234');
            expect(dockerExecRoot(NAME, 'test -d /data/home/.android && echo present').trim()).toBe('present');
            // The server log on the volume, not `docker logs`: its console echo is
            // TTY-only. Before the fix this is where adb's abort showed up.
            const serverLog = dockerExecRoot(NAME, 'cat /data/logs/ws-scrcpy-web.log');
            expect(serverLog).toContain('adbPath=');
            expect(serverLog).not.toContain('Cannot mkdir');
        } finally {
            await ctx.dispose();
            cleanup();
        }
    });
});
