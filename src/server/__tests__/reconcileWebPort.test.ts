import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerItem } from '../../types/Configuration';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
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
    return { info: vi.fn(), error: vi.fn() };
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

    it('override port busy: logs the error, does not walk forward, leaves the listener and the report alone', async () => {
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
        expect(log.error.mock.calls[0]![0]).toContain(String(override));
        expect(isSiblingInstance).not.toHaveBeenCalled();
        expect(config.servers[0]!.port).toBe(configured);
        expect(config.getFirstRunStatus()).toMatchObject({ webPort: configured, portWasAutoShifted: false });
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
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
});

describe('reconcileWebPort -- seams', () => {
    function fakeConfig(webPort: number, servers: ServerItem[]) {
        const setActualWebPort = vi.fn<WebPortConfig['setActualWebPort']>();
        const config: WebPortConfig = { getAppConfig: () => ({ webPort }), servers, setActualWebPort };
        return Object.assign(config, { setActualWebPort });
    }

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
        expect(config.setActualWebPort).toHaveBeenCalledWith(8123);
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
