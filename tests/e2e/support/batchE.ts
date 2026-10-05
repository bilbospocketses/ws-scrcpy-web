import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page, type Route, test } from '@playwright/test';
import { openSettings, openSettingsTab } from './auth';
import { type PrivateServerPaths, privateServerPaths, type ServerHandle } from './privateServer';
import { type SelfSignedPair, selfSignedCert } from './selfSignedCert';

/**
 * Helpers for `local-https-fast.spec.ts` (smoke §21, the fast-tier halves).
 *
 * Why a spawn of its own rather than `privateServer.spawnServer`: on Windows the
 * TLS home is NOT under the data root. `resolveCertPaths` (src/server/tls/certPaths.ts)
 * puts it in `%LOCALAPPDATA%\WsScrcpyWeb-tls`, and `spawnServer` passes the
 * runner's own environment through, so a private server there reads, and a
 * generate would DELETE, the developer's real CA. This spawn points
 * LOCALAPPDATA inside the private root as well, so every row here works on a
 * TLS home the spec created and wipes. On Linux the TLS home is
 * `<dataRoot>/tls` and the override is inert.
 */

export interface TlsServerPaths extends PrivateServerPaths {
    /** Handed to the child as LOCALAPPDATA; only Windows reads it. */
    localAppData: string;
    /** Where the server's CertService looks: certPaths.ts's resolveCertPaths, per platform. */
    tlsHome: string;
    certFile: string;
    keyFile: string;
    caRoot: string;
    caPemFile: string;
    logFile: string;
    /** `<deps>/mkcert/<exe>`: createCertService.ts's resolveMkcertExe. */
    mkcertExe: string;
}

export function tlsServerPaths(name: string, port: number): TlsServerPaths {
    const base = privateServerPaths(name, port);
    const localAppData = path.join(base.programData, 'LocalAppData');
    const tlsHome =
        process.platform === 'win32' ? path.join(localAppData, 'WsScrcpyWeb-tls') : path.join(base.dataRoot, 'tls');
    const caRoot = path.join(tlsHome, 'ca');
    return {
        ...base,
        localAppData,
        tlsHome,
        certFile: path.join(tlsHome, 'cert.pem'),
        keyFile: path.join(tlsHome, 'key.pem'),
        caRoot,
        caPemFile: path.join(caRoot, 'rootCA.pem'),
        logFile: path.join(base.dataRoot, 'logs', 'ws-scrcpy-web.log'),
        mkcertExe: path.join(
            base.dataRoot,
            'dependencies',
            'mkcert',
            process.platform === 'win32' ? 'mkcert.exe' : 'mkcert',
        ),
    };
}

/** `privateServer.spawnServer`'s env block, plus LOCALAPPDATA pointed inside the private root. */
export function spawnTlsServer(paths: TlsServerPaths): ServerHandle {
    const configFile = test.info().config.configFile;
    const repoRoot = configFile ? path.dirname(configFile) : process.cwd();
    const distIndex = path.resolve(repoRoot, 'dist', 'index.js');
    // Windows env names are case-insensitive, and an inherited `LocalAppData`
    // beside our `LOCALAPPDATA` would leave which one the child sees to chance.
    const inherited = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'LOCALAPPDATA'),
    );
    mkdirSync(paths.localAppData, { recursive: true });
    const child = spawn(process.execPath, [distIndex], {
        env: {
            ...inherited,
            LOCALAPPDATA: paths.localAppData,
            PROGRAMDATA: paths.programData,
            DATA_ROOT: paths.dataRoot,
            DEPS_PATH: path.join(paths.dataRoot, 'dependencies'),
            WS_SCRCPY_CONFIG: paths.configPath,
            WS_SCRCPY_WEB_PORT: String(paths.port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [];
    child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    return { child, exited, output: () => chunks.join('') };
}

/** Wipe the whole private root (data root AND the redirected LOCALAPPDATA). */
export function removeTlsServerRoot(paths: TlsServerPaths): void {
    rmSync(paths.programData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

export interface PlantedCert {
    leaf: SelfSignedPair;
    ca: SelfSignedPair;
}

/**
 * Put a leaf (and, unless told not to, a CA root) where CertService reads them,
 * in place of what mkcert would have written. The leaf is the in-process
 * throwaway from selfSignedCert.ts, valid for one day either side of now, so
 * it is also, by construction, a certificate inside the panel's 30-day expiry
 * window. Nothing here is ever installed into a trust store.
 */
export function plantCert(paths: TlsServerPaths, opts: { withCa?: boolean } = {}): PlantedCert {
    const leaf = selfSignedCert();
    const ca = selfSignedCert('ws-scrcpy-web e2e CA');
    mkdirSync(paths.caRoot, { recursive: true });
    writeFileSync(paths.certFile, leaf.cert, 'utf8');
    writeFileSync(paths.keyFile, leaf.key, 'utf8');
    if (opts.withCa !== false) writeFileSync(paths.caPemFile, ca.cert, 'utf8');
    return { leaf, ca };
}

/**
 * An mkcert that fails. A copy of the runner's own node binary named mkcert:
 * the server finds a file at `<deps>/mkcert/<exe>`, so `ensureMkcertInstalled`
 * downloads nothing, and every spawn exits non-zero on mkcert's flags
 * (`node: bad option: -cert-file`) with real stderr behind it. Cross-platform,
 * which a shell script is not, and it cannot mint anything.
 */
export function installFailingMkcert(paths: TlsServerPaths): void {
    mkdirSync(path.dirname(paths.mkcertExe), { recursive: true });
    copyFileSync(process.execPath, paths.mkcertExe);
    if (process.platform !== 'win32') chmodSync(paths.mkcertExe, 0o755);
}

export function readServerLog(paths: TlsServerPaths): string {
    return existsSync(paths.logFile) ? readFileSync(paths.logFile, 'utf8') : '';
}

export function countOccurrences(haystack: string, needle: string): number {
    let n = 0;
    for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
    return n;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** Settings → Server → the Local HTTPS section, once its state fetch has rendered. */
export async function openLocalHttpsPanel(page: Page): Promise<Locator> {
    const settings = await openSettings(page);
    const server = await openSettingsTab(settings, 'Server');
    const panel = server
        .locator('section.settings-section')
        .filter({ has: page.locator('h3.settings-section-heading', { hasText: 'Local HTTPS' }) });
    await expect(panel).toBeVisible();
    // The panel is swapped in only after GET /api/tls/state has answered.
    await expect(panel.locator('[data-tls-generate]')).toBeVisible();
    return panel;
}

/**
 * Answer GET /api/tls/state with `initial`, and with whatever `set()` names
 * after that (takes effect on the panel's next build, i.e. a reload); the
 * server never sees the request.
 */
export async function stubTlsState(
    page: Page,
    initial: Record<string, unknown>,
): Promise<{ set(state: Record<string, unknown>): void }> {
    let current = initial;
    await page.route(
        (url) => url.pathname === '/api/tls/state',
        (route: Route) =>
            route.request().method() === 'GET'
                ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) })
                : route.fallback(),
    );
    return {
        set(state) {
            current = state;
        },
    };
}

export interface TlsWriteLog {
    writes: { method: string; pathname: string; body: unknown }[];
}

/**
 * Catch every non-GET to /api/tls/* before it leaves the browser, so a panel
 * driven against the SHARED server can never generate, revoke, change exposure
 * or restart it through the https port. `respond` decides the stubbed answer.
 */
export async function guardTlsWrites(
    page: Page,
    respond: (pathname: string, body: unknown) => { status: number; json: unknown } = () => ({
        status: 418,
        json: { error: 'blocked by the e2e write guard' },
    }),
): Promise<TlsWriteLog> {
    const log: TlsWriteLog = { writes: [] };
    await page.route(
        (url) => url.pathname.startsWith('/api/tls/'),
        (route: Route) => {
            const req = route.request();
            if (req.method() === 'GET' || req.method() === 'HEAD') return route.fallback();
            const pathname = new URL(req.url()).pathname;
            let body: unknown = null;
            try {
                body = req.postDataJSON();
            } catch {
                body = req.postData();
            }
            log.writes.push({ method: req.method(), pathname, body });
            const answer = respond(pathname, body);
            return route.fulfill({
                status: answer.status,
                contentType: 'application/json',
                body: JSON.stringify(answer.json),
            });
        },
    );
    return log;
}
