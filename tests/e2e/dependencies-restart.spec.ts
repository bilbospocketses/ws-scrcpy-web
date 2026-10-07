import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { fetchFromPage, openSettings, openSettingsTab } from './support/auth';
import { dismissPrivatePrompts, freshPage } from './support/ownedServer';
import {
    privateServerPaths,
    removePrivateRoot,
    type ServerHandle,
    seedPrivateDataRoot,
    spawnServer,
    stopQuietly,
    waitForDependencies,
    waitForServer,
    withTimeout,
} from './support/privateServer';
import { logOffset, logSince, readServerLog } from './support/serverLog';

/**
 * Smoke row 9.12, Settings → Dependencies → Restart Now. Fast tier.
 *
 * Node.js is the one dependency whose update needs a restart, and nodejs.org
 * never offers a deterministic one, so `WS_SCRCPY_NODE_DIST_BASE` points Node's
 * release index, archive and SHASUMS256.txt at a fixture this file serves on
 * loopback. The install still checks the archive against that list. The
 * fixture offers the runner's own Node with its patch raised by one, over an
 * installed `<major>.0.0`.
 *
 * It must stay on the RUNNER's major. The lookup keeps only releases whose
 * major's ABI the node-pty prebuilt manifest covers, and it reads the real
 * manifest from GitHub when GitHub answers, else the cached copy this spec
 * stages. The cached copy names the runner's own ABI, and the real manifest
 * covers it too: CI runs Node 24.x (ci.yml), ABI 137, and the manifest lists
 * 137 and 127. Any other major could be offered one way and refused the other.
 * (A runner on a major missing from NODE_LTS_ABI is offered nothing either way.)
 *
 * The installed version is read by RUNNING `<deps>/node/bin/node --version`, so
 * both the installed fake and the one in the archive are shell scripts: Linux
 * only (CI). Windows would need a real PE `node.exe` printing a chosen version.
 *
 * The harness has no launcher: Restart Now ends the process with exit 75 and a
 * `.restart` marker, and this spec plays the launcher's part, booting the same
 * root again on the same port. The server is still the runner's own Node, not
 * the fake; what restarts is the server, which is the row's subject.
 *
 * Ports: 8145 the spec-owned server, 8146 the fixture.
 */

const SERVER_PORT = 8145;
const FIXTURE_PORT = 8146;
const FIXTURE_BASE = `http://127.0.0.1:${FIXTURE_PORT}`;
const NODE_DIST_BASE_ENV = 'WS_SCRCPY_NODE_DIST_BASE';
// The runner's own major, so its ABI is covered whichever manifest the lookup reads.
const [MAJOR, MINOR, PATCH] = process.versions.node.split('.').map(Number) as [number, number, number];
const INSTALLED = `${MAJOR}.0.0`;
const OFFERED = `${MAJOR}.${MINOR}.${PATCH + 1}`;
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const ARCHIVE_DIR = `node-v${OFFERED}-linux-${ARCH}`;
const ARCHIVE_PATH = `/v${OFFERED}/${ARCHIVE_DIR}.tar.gz`;
// The install refuses an archive its SHASUMS256.txt does not vouch for, and
// reads that list from the same base as the archive.
const SHASUMS_PATH = `/v${OFFERED}/SHASUMS256.txt`;

interface DependencyInfo {
    name: string;
    installedVersion: string | null;
    latestVersion: string | null;
    status: string;
}

/** A shell script standing in for `node`: `--version` is all the app asks of it. */
function fakeNode(file: string, version: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\necho v${version}\n`, { mode: 0o755 });
}

/**
 * nodejs.org's layout under one base: the release index, one archive and its
 * SHASUMS256.txt. `hits` records every path asked for.
 */
class FixtureNodeDist {
    readonly hits: string[] = [];
    private server?: Server;
    private readonly shasums: string;

    constructor(private readonly archive: Buffer) {
        this.shasums = `${createHash('sha256').update(archive).digest('hex')}  ${ARCHIVE_DIR}.tar.gz\n`;
    }

    async start(): Promise<void> {
        this.server = createServer((req, res) => {
            const url = req.url ?? '';
            this.hits.push(url);
            if (url === '/index.json') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify([{ version: `v${OFFERED}`, lts: 'Fixture' }]));
                return;
            }
            if (url === ARCHIVE_PATH) {
                res.writeHead(200, { 'content-type': 'application/gzip' });
                res.end(this.archive);
                return;
            }
            if (url === SHASUMS_PATH) {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end(this.shasums);
                return;
            }
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: 'Not Found' }));
        });
        const server = this.server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(FIXTURE_PORT, '127.0.0.1', () => resolve());
        });
    }

    async stop(): Promise<void> {
        const server = this.server;
        if (!server) return;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

test('9.12 Settings → Dependencies: a Node update offers Restart Now, which shows "Restarting..." and the page reloads onto the restarted server', async ({
    browser,
}) => {
    test.skip(process.platform === 'win32', 'needs an executable fake node; a shell script runs on Linux only');
    test.setTimeout(300_000);

    const paths = privateServerPaths('ws-scrcpy-web-e2e-deps-restart', SERVER_PORT);
    seedPrivateDataRoot(paths);
    const deps = path.join(paths.dataRoot, 'dependencies');
    const installedNode = path.join(deps, 'node', 'bin', 'node');
    fakeNode(installedNode, INSTALLED);
    // The cached prebuilt manifest the lookup falls back to when GitHub cannot
    // be reached, covering the runner's ABI; reachable, the real one replaces it.
    fs.mkdirSync(path.join(deps, 'node-pty'), { recursive: true });
    fs.writeFileSync(
        path.join(deps, 'node-pty', 'manifest.json'),
        JSON.stringify({ upstreamVersion: '1.1.0', coveredAbis: [process.versions.modules] }),
    );

    // The archive nodejs.org would serve, cut down to the one file the install
    // and its version check read. Built under the private root, so the
    // root's own removal takes it.
    const stage = path.join(paths.programData, 'fixture');
    fakeNode(path.join(stage, ARCHIVE_DIR, 'bin', 'node'), OFFERED);
    const tarball = path.join(paths.programData, 'fixture.tar.gz');
    execFileSync('tar', ['-czf', tarball, '-C', stage, ARCHIVE_DIR]);
    const fixture = new FixtureNodeDist(fs.readFileSync(tarball));
    await fixture.start();

    const env = { [NODE_DIST_BASE_ENV]: FIXTURE_BASE };
    const handles: ServerHandle[] = [];
    try {
        handles.push(spawnServer(paths, { env }));
        await waitForServer(handles[0]!, paths.baseURL);
        // Restarting mid-download would leave the boot's adb fetch aborted in the log.
        await waitForDependencies(paths.baseURL);
        expect(readServerLog(paths)).toContain(
            `Node.js release index and downloads from ${NODE_DIST_BASE_ENV}=${FIXTURE_BASE}`,
        );

        await dismissPrivatePrompts(paths.baseURL);
        const { context, page } = await freshPage(browser, paths.baseURL);
        try {
            await page.goto('/');
            const settings = await openSettings(page);
            const section = await openSettingsTab(settings, 'Dependencies');
            const panel = section.locator('#dependency-panel');
            const nodeRow = panel.locator('tbody tr.dep-row').filter({ hasText: 'Node.js' });
            await expect(nodeRow).toHaveCount(1);
            await expect(nodeRow.locator('td.dep-version').first()).toHaveText(INSTALLED);
            // No restart control until an update asks for one.
            await expect(panel.getByRole('button', { name: /restart/i })).toHaveCount(0);

            const checked = page.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/dependencies/check',
            );
            await panel.locator('button.dep-check-all').click();
            expect((await checked).status()).toBe(200);
            expect(fixture.hits, 'the release index came from the fixture').toContain('/index.json');
            await expect(nodeRow.locator('td.dep-version').nth(1)).toHaveText(OFFERED);
            await expect(nodeRow.locator('.dep-badge')).toHaveText('Update available');

            const updated = page.waitForResponse(
                (r) =>
                    r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/dependencies/nodejs/update',
            );
            await nodeRow.locator('button[data-update="nodejs"]').click();
            const update = await updated;
            expect(update.status(), await update.text()).toBe(200);
            expect(await update.json()).toEqual({ success: true, newVersion: OFFERED, requiresRestart: true });
            expect(fixture.hits, 'the archive came from the fixture').toContain(ARCHIVE_PATH);
            expect(fixture.hits, 'and was checked against the fixture SHASUMS256.txt').toContain(SHASUMS_PATH);
            // The update really landed: the version check ran the new binary.
            await expect(nodeRow.locator('td.dep-version').first()).toHaveText(OFFERED);

            const prompt = panel.locator('.dep-restart-prompt');
            await expect(prompt).toBeVisible();
            await expect(prompt.locator('p')).toHaveText('A dependency was updated that requires a restart.');
            // The only restart control: one button, in the prompt.
            const restartControls = panel.getByRole('button', { name: /restart/i });
            await expect(restartControls).toHaveCount(1);
            await expect(restartControls).toHaveText('Restart Now');

            const first = handles[0]!;
            const offset = logOffset(paths);
            const restartPosted = page.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/dependencies/restart',
            );
            await prompt.getByRole('button', { name: 'Restart Now' }).click();
            const restart = await restartPosted;
            expect(restart.status()).toBe(200);
            expect(await restart.json()).toEqual({ message: 'Restarting...' });
            await expect(panel.locator('.dep-restarting h2')).toHaveText('Restarting...');
            await expect(panel.locator('.dep-restarting p')).toHaveText(
                'The server is restarting. This page will reload automatically.',
            );

            const exit = await withTimeout(first.exited, 15_000, () => `waiting for exit 75:\n${first.output()}`);
            expect(exit.code, first.output()).toBe(75);
            expect(fs.readFileSync(paths.restartMarkerPath, 'utf8')).toMatch(/^restart-requested-\d+$/);

            // The launcher's part: the same root, the same port, the same environment.
            const reloaded = page.waitForEvent('load', { timeout: 60_000 });
            handles.push(spawnServer(paths, { env }));
            await waitForServer(handles[1]!, paths.baseURL);
            await reloaded;
            expect(logSince(paths, offset), 'the second process booted on the same root').toContain(
                `Node.js release index and downloads from ${NODE_DIST_BASE_ENV}=${FIXTURE_BASE}`,
            );

            // The reloaded page holds the restarted process's token: its own
            // request is answered, and that process reads the updated Node.
            const after = await fetchFromPage(page, '/api/dependencies');
            expect(after.status).toBe(200);
            const node = (after.body as DependencyInfo[]).find((d) => d.name === 'nodejs');
            expect(node?.installedVersion).toBe(OFFERED);
            await expect(page.locator('#dependency-panel .dep-restarting')).toHaveCount(0);
        } finally {
            await context.close();
        }
    } finally {
        for (const handle of handles) await stopQuietly(handle, '9.12');
        await fixture.stop();
        try {
            removePrivateRoot(paths);
        } catch (err) {
            console.warn(`9.12 cleanup: ${String(err)}`);
        }
    }
});
