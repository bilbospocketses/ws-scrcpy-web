import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerItem } from '../../types/Configuration';
import { Config, httpsCollisionWarning } from '../Config';
import { EnvName } from '../EnvName';
import { findAvailablePort as realFindAvailablePort } from '../PortPicker';
import { reconcileWebPort, type WebPortConfig } from '../reconcileWebPort';

/**
 * WS_SCRCPY_WEB_PORT is the ONE port override (user decision 2026-10-04; `PORT`
 * was retired). It forces the exact port the server listens on AND reports,
 * even when config.json says otherwise, and never walks forward.
 *
 * HttpServer.start() binds `config.servers[i].port` for every entry, so
 * `servers[0].port` IS the listener port these tests assert on.
 */

/** A port the OS just handed out and released: free at the moment of return. */
async function freePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

/** Two distinct free ports. */
async function twoFreePorts(): Promise<[number, number]> {
    const a = await freePort();
    let b = await freePort();
    while (b === a) b = await freePort();
    return [a, b];
}

/** Hold a port for the duration of a test. */
async function holdPort(port: number): Promise<net.Server> {
    return new Promise<net.Server>((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(port, () => resolve(srv));
    });
}

function silentLog() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('reconcileWebPort -- WS_SCRCPY_WEB_PORT against a real Config', () => {
    const tmpDirs: string[] = [];
    const held: net.Server[] = [];
    const savedEnv = {
        CONFIG: process.env[EnvName.CONFIG_PATH],
        DEPS: process.env['DEPS_PATH'],
    };

    afterEach(async () => {
        Config._resetForTest();
        if (savedEnv.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
        else process.env[EnvName.CONFIG_PATH] = savedEnv.CONFIG;
        if (savedEnv.DEPS === undefined) delete process.env['DEPS_PATH'];
        else process.env['DEPS_PATH'] = savedEnv.DEPS;
        while (held.length) {
            const srv = held.pop()!;
            await new Promise<void>((resolve) => srv.close(() => resolve()));
        }
        while (tmpDirs.length) {
            const d = tmpDirs.pop()!;
            try {
                fs.rmSync(d, { recursive: true, force: true });
            } catch {
                /* best-effort cleanup */
            }
        }
    });

    function setup(initialConfig: unknown): { configPath: string; config: Config } {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-webport-'));
        tmpDirs.push(tmpRoot);
        const configPath = path.join(tmpRoot, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(initialConfig));
        process.env[EnvName.CONFIG_PATH] = configPath;
        process.env['DEPS_PATH'] = path.join(tmpRoot, 'deps');
        Config._resetForTest();
        return { configPath, config: Config.getInstance() };
    }

    it('override differs from config.json webPort and is free: the listener binds the override', async () => {
        const [configured, override] = await twoFreePorts();
        const { config } = setup({ webPort: configured });
        expect(config.servers[0]!.port).toBe(configured);

        const settled = await reconcileWebPort(config, {
            env: { WS_SCRCPY_WEB_PORT: String(override) },
            log: silentLog(),
        });

        expect(settled).toBe(override);
        // The port the app REPORTS ...
        expect(config.getFirstRunStatus().webPort).toBe(override);
        // ... must be the port it LISTENS on.
        expect(config.servers[0]!.port).toBe(override);
    });

    it('override differs from config.json webPort: persisted, but reported as CHOSEN, not auto-shifted', async () => {
        // Persisted so config.json names the port this boot serves (the Docker
        // image's WS_SCRCPY_WEB_PORT=8000 against a /data/config.json naming
        // another). Not a shift: nothing was busy, the caller asked.
        const [configured, override] = await twoFreePorts();
        const { configPath, config } = setup({ webPort: configured });

        await reconcileWebPort(config, { env: { WS_SCRCPY_WEB_PORT: String(override) }, log: silentLog() });

        expect(config.getFirstRunStatus()).toMatchObject({ webPort: override, portWasAutoShifted: false });
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).webPort).toBe(override);
        expect(config.getAppConfig().webPort).toBe(override);
    });

    it('no override, configured port held by another program: still reports portWasAutoShifted (smoke 1.12)', async () => {
        const configured = await freePort();
        held.push(await holdPort(configured));
        const { configPath, config } = setup({ webPort: configured });

        const settled = await reconcileWebPort(config, {
            env: {},
            isServiceInstance: () => false,
            isSiblingInstance: async () => false,
            log: silentLog(),
        });

        expect(settled).not.toBeNull();
        expect(settled).toBeGreaterThan(configured);
        expect(config.servers[0]!.port).toBe(settled);
        expect(config.getFirstRunStatus()).toMatchObject({ webPort: settled, portWasAutoShifted: true });
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).webPort).toBe(settled);
    });

    it('override equals config.json webPort: the listener binds it and nothing reads as shifted', async () => {
        const port = await freePort();
        const { configPath, config } = setup({ webPort: port });
        const before = fs.readFileSync(configPath, 'utf-8');

        const settled = await reconcileWebPort(config, {
            env: { WS_SCRCPY_WEB_PORT: String(port) },
            log: silentLog(),
        });

        expect(settled).toBe(port);
        expect(config.servers[0]!.port).toBe(port);
        expect(config.getFirstRunStatus()).toMatchObject({ webPort: port, portWasAutoShifted: false });
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    });

    it('override port busy: says so without a walk range, and the listener still targets the override, not config.json', async () => {
        // The exact port is the contract. Falling back to config.json's port
        // would serve somewhere the caller did not ask for; instead HttpServer
        // tries the override, its bind fails, and with nothing else listening
        // the process exits non-zero (smoke row 12.6).
        const [configured, override] = await twoFreePorts();
        held.push(await holdPort(override));
        const { configPath, config } = setup({ webPort: configured });
        const before = fs.readFileSync(configPath, 'utf-8');
        const log = silentLog();
        const isSiblingInstance = vi.fn(async () => false);

        const settled = await reconcileWebPort(config, {
            env: { WS_SCRCPY_WEB_PORT: String(override) },
            log,
            isSiblingInstance,
        });

        // No walk forward: override+1 is almost certainly free, and it was not taken.
        expect(settled).toBeNull();
        expect(log.error).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(
            `WS_SCRCPY_WEB_PORT ${override} is busy; not walking forward (the override is exact)`,
        );
        expect(isSiblingInstance).not.toHaveBeenCalled();
        expect(config.servers[0]!.port).toBe(override);
        // Reported as the port asked for, never persisted: nothing bound it.
        expect(config.getFirstRunStatus()).toMatchObject({ webPort: override, portWasAutoShifted: false });
        expect(config.getAppConfig().webPort).toBe(configured);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    });

    it('override port busy: a real HTTP bind on the settled port fails rather than serving config.json', async () => {
        const [configured, override] = await twoFreePorts();
        held.push(await holdPort(override));
        const { config } = setup({ webPort: configured });

        await reconcileWebPort(config, { env: { WS_SCRCPY_WEB_PORT: String(override) }, log: silentLog() });

        // What HttpServer.start() does with servers[0]: listen on its port.
        const probe = net.createServer();
        const outcome = await new Promise<string>((resolve) => {
            probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
            probe.listen(config.servers[0]!.port, () => resolve('listening'));
        });
        if (outcome === 'listening') await new Promise<void>((r) => probe.close(() => r()));
        expect(outcome).toBe('EADDRINUSE');
    });

    it('no override and nothing free in the walk: the range message is unchanged', async () => {
        const { config } = setup({ webPort: 8000 });
        const log = silentLog();

        await reconcileWebPort(config, { env: {}, findAvailablePort: async () => null, log });

        expect(log.error).toHaveBeenCalledWith('No free port available in range 8000..8099');
    });

    it('advanced server[] array: the override applies to its FIRST entry, as PORT used to', async () => {
        const [configured, override] = await twoFreePorts();
        const { config } = setup({ webPort: configured, server: [{ port: 7123 }, { port: 7124 }] });
        expect(config.servers.map((s) => s.port)).toEqual([7123, 7124]);

        await reconcileWebPort(config, { env: { WS_SCRCPY_WEB_PORT: String(override) }, log: silentLog() });

        expect(config.servers.map((s) => s.port)).toEqual([override, 7124]);
    });

    it('advanced server[] array with no override: its own first port is kept when webPort is free', async () => {
        const configured = await freePort();
        const { config } = setup({ webPort: configured, server: [{ port: 7123 }] });

        await reconcileWebPort(config, { env: {}, log: silentLog() });

        expect(config.servers[0]!.port).toBe(7123);
    });

    // ── The Linux SYSTEM service: config.json's webPort is exact ──
    //
    // User decision 2026-10-04: the system unit no longer pins
    // WS_SCRCPY_WEB_PORT, so a Settings port change survives the restart. The
    // pin's one job moves here: during the page's install the user's own copy
    // still holds the port for a moment, and the service must fail its bind
    // (systemd restarts it) rather than walk to port+1 and persist that.

    it('Linux system service, webPort busy (the install handoff): no walk forward, the bind fails, nothing persisted', async () => {
        const configured = await freePort();
        held.push(await holdPort(configured));
        const { configPath, config } = setup({ webPort: configured, installMode: 'system-service' });
        const before = fs.readFileSync(configPath, 'utf-8');
        const log = silentLog();
        const isSiblingInstance = vi.fn(async () => false);

        const settled = await reconcileWebPort(config, {
            env: {},
            isServiceInstance: () => true,
            isLinuxSystemServiceInstance: () => true,
            isSiblingInstance,
            log,
        });

        expect(settled).toBeNull();
        expect(log.error).toHaveBeenCalledWith(
            `webPort ${configured} is busy; the system service does not walk forward ` +
                '(it exits, and systemd restarts it until the port is free)',
        );
        expect(isSiblingInstance).not.toHaveBeenCalled();
        expect(config.servers[0]!.port).toBe(configured);
        expect(config.getFirstRunStatus()).toMatchObject({ webPort: configured, portWasAutoShifted: false });
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);

        // What HttpServer.start() does with servers[0]: its bind fails.
        const probe = net.createServer();
        const outcome = await new Promise<string>((resolve) => {
            probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
            probe.listen(config.servers[0]!.port, () => resolve('listening'));
        });
        if (outcome === 'listening') await new Promise<void>((r) => probe.close(() => r()));
        expect(outcome).toBe('EADDRINUSE');
    });

    it('Linux system service after a Settings port change: the respawn binds the NEW config.json port exactly', async () => {
        // ConfigApi wrote Q and exited 75; the launcher respawned Node with the
        // unit's env, which no longer carries a port.
        const [installPort, chosen] = await twoFreePorts();
        const { configPath, config } = setup({ webPort: installPort, installMode: 'system-service' });
        config.updateAppConfig({ webPort: chosen });
        Config._resetForTest();
        const respawned = Config.getInstance();
        const before = fs.readFileSync(configPath, 'utf-8');
        const findAvailablePort = vi.fn(realFindAvailablePort);

        const settled = await reconcileWebPort(respawned, {
            env: {},
            findAvailablePort,
            isServiceInstance: () => true,
            isLinuxSystemServiceInstance: () => true,
            log: silentLog(),
        });

        expect(findAvailablePort).toHaveBeenCalledWith(chosen, chosen);
        expect(settled).toBe(chosen);
        expect(respawned.servers[0]!.port).toBe(chosen);
        expect(respawned.getFirstRunStatus()).toMatchObject({ webPort: chosen, portWasAutoShifted: false });
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    });

    it('Linux system service, a unit that still pins WS_SCRCPY_WEB_PORT (installed before the pin was dropped): the pin wins', async () => {
        // Why such an install must be reinstalled or updated before a Settings
        // change sticks: the explicit override keeps its contract.
        const [configured, pinned] = await twoFreePorts();
        const { config } = setup({ webPort: configured, installMode: 'system-service' });

        const settled = await reconcileWebPort(config, {
            env: { WS_SCRCPY_WEB_PORT: String(pinned) },
            isServiceInstance: () => true,
            isLinuxSystemServiceInstance: () => true,
            log: silentLog(),
        });

        expect(settled).toBe(pinned);
        expect(config.servers[0]!.port).toBe(pinned);
    });
});

describe('reconcileWebPort -- seams', () => {
    function fakeConfig(webPort: number, servers: ServerItem[], usesAdvancedServerConfig = false) {
        const setActualWebPort = vi.fn<WebPortConfig['setActualWebPort']>();
        const config: WebPortConfig = {
            getAppConfig: () => ({ webPort }),
            servers,
            usesAdvancedServerConfig,
            setActualWebPort,
        };
        return Object.assign(config, { setActualWebPort });
    }

    const tlsEntry = (port: number): ServerItem => ({ secure: true, port, options: { cert: 'C', key: 'K' } });
    const exactOnly = (port: number) => async (start: number, end: number) =>
        start === port && end === port ? port : null;

    it('override equal to httpsPort: HTTPS is disabled for this boot, with the build-time warning', async () => {
        const config = fakeConfig(8000, [{ secure: false, port: 8000 }, tlsEntry(8443)]);
        const log = silentLog();

        await reconcileWebPort(config, {
            env: { WS_SCRCPY_WEB_PORT: '8443' },
            findAvailablePort: exactOnly(8443),
            log,
        });

        expect(config.servers).toEqual([{ secure: false, port: 8443 }]);
        expect(log.warn).toHaveBeenCalledWith(httpsCollisionWarning(8443, 8443));
        // The same text Config.buildServers emits for a webPort that collides.
        expect(httpsCollisionWarning(8443, 8443)).toBe(
            'config.json: httpsPort (8443) collides with the http port (8443); ' +
                'HTTPS is disabled for this boot -- set httpsPort to a different port to enable it',
        );
    });

    it('an auto-shift that lands on httpsPort disables HTTPS the same way', async () => {
        const config = fakeConfig(8000, [{ secure: false, port: 8000 }, tlsEntry(8001)]);
        const log = silentLog();

        await reconcileWebPort(config, {
            env: {},
            findAvailablePort: async (start) => start + 1,
            isServiceInstance: () => false,
            isSiblingInstance: async () => false,
            log,
        });

        expect(config.servers).toEqual([{ secure: false, port: 8001 }]);
        expect(log.warn).toHaveBeenCalledWith(httpsCollisionWarning(8001, 8001));
    });

    it('an advanced server[] array is used as written: no HTTPS entry is dropped', async () => {
        const config = fakeConfig(8000, [{ secure: false, port: 7000 }, tlsEntry(8443)], true);
        const log = silentLog();

        await reconcileWebPort(config, {
            env: { WS_SCRCPY_WEB_PORT: '8443' },
            findAvailablePort: exactOnly(8443),
            log,
        });

        expect(config.servers.map((s) => s.port)).toEqual([8443, 8443]);
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('the override moves only the HTTP entry; the Local HTTPS listener keeps httpsPort', async () => {
        const config = fakeConfig(8000, [
            { secure: false, port: 8000 },
            { secure: true, port: 8443, options: { cert: 'C', key: 'K' } },
        ]);

        await reconcileWebPort(config, {
            env: { WS_SCRCPY_WEB_PORT: '8123' },
            findAvailablePort: async (start, end) => (start === 8123 && end === 8123 ? 8123 : null),
            log: silentLog(),
        });

        expect(config.servers.map((s) => s.port)).toEqual([8123, 8443]);
        expect(config.setActualWebPort).toHaveBeenCalledWith(8123, { autoShifted: false });
    });

    it('no override, configured port busy by another program: walks forward, persists, and binds the shift', async () => {
        const config = fakeConfig(8000, [{ secure: false, port: 8000 }]);
        const findAvailablePort = vi.fn(async (start: number) => start + 1);

        await reconcileWebPort(config, {
            env: {},
            findAvailablePort,
            isServiceInstance: () => false,
            isSiblingInstance: async () => false,
            log: silentLog(),
        });

        expect(findAvailablePort).toHaveBeenCalledWith(8000, 8099);
        expect(config.setActualWebPort).toHaveBeenCalledWith(8001, { persist: true });
        expect(config.servers[0]!.port).toBe(8001);
    });

    it('Linux system service: the walk range is the configured port alone, and an advanced array binds it too', async () => {
        // As the pinned unit did: its override applied to servers[0] of an advanced array.
        const config = fakeConfig(8000, [{ secure: false, port: 7000 }], true);
        const findAvailablePort = vi.fn(async (start: number) => start);

        const settled = await reconcileWebPort(config, {
            env: {},
            findAvailablePort,
            isServiceInstance: () => true,
            isLinuxSystemServiceInstance: () => true,
            log: silentLog(),
        });

        expect(findAvailablePort).toHaveBeenCalledWith(8000, 8000);
        expect(settled).toBe(8000);
        expect(config.servers[0]!.port).toBe(8000);
        expect(config.setActualWebPort).toHaveBeenCalledWith(8000, { autoShifted: false });
    });

    it('the Windows service and the Linux USER service still walk forward and persist the shift', async () => {
        // The Windows ~15 s handoff depends on the service persisting the port
        // it actually serves (isServiceInstance); unchanged by the system rule.
        const config = fakeConfig(8000, [{ secure: false, port: 8000 }]);
        const findAvailablePort = vi.fn(async (start: number) => start + 1);
        const isSiblingInstance = vi.fn(async () => true);

        await reconcileWebPort(config, {
            env: {},
            findAvailablePort,
            isServiceInstance: () => true,
            isLinuxSystemServiceInstance: () => false,
            isSiblingInstance,
            log: silentLog(),
        });

        expect(findAvailablePort).toHaveBeenCalledWith(8000, 8099);
        expect(isSiblingInstance).not.toHaveBeenCalled();
        expect(config.setActualWebPort).toHaveBeenCalledWith(8001, { persist: true });
        expect(config.servers[0]!.port).toBe(8001);
    });

    it('PORT in the environment is not read', async () => {
        const config = fakeConfig(8000, [{ secure: false, port: 8000 }]);
        const findAvailablePort = vi.fn(async (start: number) => start);

        await reconcileWebPort(config, { env: { PORT: '9123' }, findAvailablePort, log: silentLog() });

        expect(findAvailablePort).toHaveBeenCalledWith(8000, 8099);
        expect(config.servers[0]!.port).toBe(8000);
    });
});

describe('Config server list -- PORT is retired', () => {
    it('PORT does not change the flat-config HTTP listener', () => {
        const servers = Config._buildServersForTest({}, 8000, null, { PORT: '9123' });
        expect(servers.map((s) => s.port)).toEqual([8000]);
    });

    it('PORT does not change the first entry of an advanced server[] array', () => {
        const servers = Config._buildServersForTest({ server: [{ secure: false, port: 7123 }] }, 8000, null, {
            PORT: '9123',
        });
        expect(servers.map((s) => s.port)).toEqual([7123]);
    });
});
