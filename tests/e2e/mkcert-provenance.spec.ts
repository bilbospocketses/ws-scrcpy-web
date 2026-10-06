import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { openSettings, openSettingsTab } from './support/auth';
import { apiContext, dismissPrivatePrompts, freshPage, OwnedServer, REMOTE_ADMIN_ENV } from './support/ownedServer';

/**
 * Smoke row 21.12, mkcert provenance: the refusals. Fast tier, item 167.
 *
 * `WS_SCRCPY_MKCERT_URL_BASE` points every URL the mkcert path reads (the
 * latest-release lookup, the SHA256SUMS manifest, the binary and the
 * attestation lookup) at a fixture this file serves on loopback. Nothing the
 * fixture serves can verify: there is no way, and no seam, to make a fixture
 * pass the Sigstore check, which is the point. So every case here is a refusal,
 * and the accepted path stays 21.1's.
 *
 * Ports: 8197 the spec-owned server, 8198 the fixture.
 */

const SERVER_PORT = 8197;
const FIXTURE_PORT = 8198;
const FIXTURE_BASE = `http://127.0.0.1:${FIXTURE_PORT}`;
const MKCERT_URL_BASE_ENV = 'WS_SCRCPY_MKCERT_URL_BASE';

interface DependencyInfo {
    name: string;
    installedVersion: string | null;
    latestVersion: string | null;
    status: string;
    errorMessage?: string;
}

interface UpdateResult {
    success: boolean;
    errorMessage?: string;
}

type Attestation = 'missing' | 'message-signature';

/**
 * A release server in GitHub's own layout under one base. `latest` and
 * `attestation` are switched between cases; `hits` records every path asked
 * for, so a case can prove what was NOT downloaded.
 */
class FixtureRelease {
    latest = 'v9.9.9';
    attestation: Attestation = 'missing';
    readonly hits: string[] = [];
    private server?: Server;

    async start(): Promise<void> {
        this.server = createServer((req, res) => {
            const url = req.url ?? '';
            this.hits.push(url);
            const json = (status: number, body: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            if (url === '/releases/latest') return json(200, { tag_name: this.latest });
            const manifest = url.match(/^\/releases\/download\/([^/]+)\/mkcert-\1-SHA256SUMS\.txt$/);
            if (manifest) {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end(`${'0'.repeat(64)}  mkcert-${manifest[1]}-linux-amd64\n`);
                return;
            }
            if (url.startsWith('/releases/download/')) {
                res.writeHead(200, { 'content-type': 'application/octet-stream' });
                res.end('not a binary');
                return;
            }
            if (url.startsWith('/attestations/sha256:')) {
                // GitHub answers 404 for a digest it holds no attestation for.
                if (this.attestation === 'missing') return json(404, { message: 'Not Found' });
                // A bundle carrying a message signature beside its DSSE envelope,
                // a shape the app refuses before any signature is checked.
                return json(200, {
                    attestations: [
                        {
                            bundle: {
                                mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
                                verificationMaterial: {},
                                dsseEnvelope: {
                                    payload: '',
                                    payloadType: 'application/vnd.in-toto+json',
                                    signatures: [],
                                },
                                messageSignature: {
                                    messageDigest: { algorithm: 'SHA2_256', digest: '' },
                                    signature: '',
                                },
                            },
                        },
                    ],
                });
            }
            json(404, { message: 'Not Found' });
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

async function mkcertInfo(api: APIRequestContext): Promise<DependencyInfo> {
    const res = await api.get('/api/dependencies');
    expect(res.status()).toBe(200);
    const mkcert = ((await res.json()) as DependencyInfo[]).find((d) => d.name === 'mkcert');
    expect(mkcert, 'mkcert must be listed outside a container').toBeDefined();
    return mkcert as DependencyInfo;
}

async function checkAll(api: APIRequestContext): Promise<DependencyInfo> {
    const res = await api.post('/api/dependencies/check');
    expect(res.status(), await res.text()).toBe(200);
    return mkcertInfo(api);
}

async function updateMkcert(api: APIRequestContext): Promise<{ status: number; result: UpdateResult }> {
    const res = await api.post('/api/dependencies/mkcert/update');
    return { status: res.status(), result: (await res.json()) as UpdateResult };
}

test.describe('21.12 mkcert provenance: the refusals (a fixture release server)', () => {
    const fixture = new FixtureRelease();
    let server: OwnedServer | undefined;
    let api: APIRequestContext | undefined;
    let mkcertDir = '';

    test.beforeAll(async () => {
        test.setTimeout(150_000);
        await fixture.start();
        server = await OwnedServer.start('21-12', SERVER_PORT, {
            [REMOTE_ADMIN_ENV]: undefined,
            [MKCERT_URL_BASE_ENV]: FIXTURE_BASE,
        });
        mkcertDir = path.join(server.paths.dataRoot, 'dependencies', 'mkcert');
        api = await apiContext(server.baseURL);
    });

    test.afterAll(async () => {
        await api?.dispose();
        await server?.dispose('21.12');
        await fixture.stop();
    });

    test.beforeEach(() => {
        fixture.hits.length = 0;
        fs.rmSync(mkcertDir, { recursive: true, force: true });
    });

    test('21.12 the variable moves the release lookup: boot asked the fixture, not GitHub', async () => {
        const a = api as APIRequestContext;
        fixture.latest = 'v9.9.9';
        const info = await checkAll(a);
        expect(fixture.hits).toContain('/releases/latest');
        expect(info.latestVersion).toBe('v9.9.9');
        expect(info.installedVersion).toBeNull();
    });

    test('21.12 an unattested release is refused, nothing is downloaded past the manifest and nothing lands in <deps>/mkcert', async () => {
        const a = api as APIRequestContext;
        fixture.latest = 'v9.9.9';
        fixture.attestation = 'missing';
        await checkAll(a);
        const { status, result } = await updateMkcert(a);
        expect(status, JSON.stringify(result)).toBe(500);
        expect(result.success).toBe(false);
        // The layer that failed is named: provenance, not the download or the hash.
        expect(result.errorMessage).toMatch(
            /^no build-provenance attestation exists for mkcert v9\.9\.9's checksum manifest \(sha256 [0-9a-f]{64}\) -- refusing to trust it$/,
        );
        expect(fixture.hits).toContain('/releases/download/v9.9.9/mkcert-v9.9.9-SHA256SUMS.txt');
        expect(fixture.hits.some((h) => h.startsWith('/attestations/sha256:'))).toBe(true);
        expect(
            fixture.hits.filter((h) => h.startsWith('/releases/download/') && !h.endsWith('-SHA256SUMS.txt')),
            'the binary must never be fetched for a manifest nothing vouches for',
        ).toEqual([]);
        expect(fs.existsSync(mkcertDir), `${mkcertDir} must not exist`).toBe(false);
        expect((await mkcertInfo(a)).installedVersion).toBeNull();
    });

    test('21.12 an attestation that cannot verify is refused the same way, naming why', async () => {
        const a = api as APIRequestContext;
        fixture.latest = 'v9.9.9';
        fixture.attestation = 'message-signature';
        await checkAll(a);
        const { status, result } = await updateMkcert(a);
        expect(status, JSON.stringify(result)).toBe(500);
        expect(result.errorMessage).toBe(
            "mkcert v9.9.9's checksum manifest has no attestation this app can verify " +
                '(the attestation carries a message signature as well as a DSSE envelope) -- refusing to trust it',
        );
        expect(
            fixture.hits.filter((h) => h.startsWith('/releases/download/') && !h.endsWith('-SHA256SUMS.txt')),
        ).toEqual([]);
        expect(fs.existsSync(mkcertDir)).toBe(false);
    });

    for (const tag of ['v1.4.4-bt.2', 'v01.2.3']) {
        test(`21.12 a release tagged ${tag} is refused at the lookup, and an update then refuses too`, async () => {
            const a = api as APIRequestContext;
            fixture.latest = tag;
            const info = await checkAll(a);
            // Nothing installed, so a refused lookup is an error the panel shows.
            expect(info.status).toBe('error');
            expect(info.latestVersion).toBeNull();
            expect(info.errorMessage).toBe(`unexpected mkcert release tag ${JSON.stringify(tag)}`);
            const { status, result } = await updateMkcert(a);
            expect(status, JSON.stringify(result)).toBe(500);
            expect(result.errorMessage).toBe(`unexpected mkcert release tag ${JSON.stringify(tag)}`);
            expect(fixture.hits.filter((h) => h.startsWith('/releases/download/'))).toEqual([]);
            expect(fs.existsSync(mkcertDir)).toBe(false);
        });
    }

    test('21.12 with mkcert 1.4.4-bt.2 installed, Settings → Dependencies shows "update available" to the latest release', async ({
        browser,
    }) => {
        // The installed version is read by RUNNING `mkcert -version`, so the
        // fake has to execute: a shell script on Linux (CI). Windows would need
        // a real PE binary that prints a -bt version, and there is none to use.
        test.skip(process.platform === 'win32', 'needs an executable fake mkcert; a shell script runs on Linux only');
        const a = api as APIRequestContext;
        fixture.latest = 'v0.1.0';
        fs.mkdirSync(mkcertDir, { recursive: true });
        const fake = path.join(mkcertDir, 'mkcert');
        fs.writeFileSync(fake, '#!/bin/sh\necho "v1.4.4-bt.2"\n', { mode: 0o755 });

        // The retired numbering is numerically ABOVE v0.1.0; only treating the
        // fork's latest as authoritative offers the update.
        const info = await checkAll(a);
        expect(info.installedVersion).toBe('1.4.4-bt.2');
        expect(info.latestVersion).toBe('v0.1.0');
        expect(info.status).toBe('update-available');

        const srv = server as OwnedServer;
        await dismissPrivatePrompts(srv.baseURL);
        const { context, page } = await freshPage(browser, srv.baseURL);
        try {
            await page.goto('/');
            const settings = await openSettings(page);
            const section = await openSettingsTab(settings, 'Dependencies');
            const row = section.locator('tbody tr.dep-row').filter({ hasText: 'mkcert' });
            await expect(row).toHaveCount(1);
            await expect(row).toContainText('1.4.4-bt.2');
            await expect(row.locator('.dep-badge')).toHaveText('Update available');
        } finally {
            await context.close();
        }
    });
});
