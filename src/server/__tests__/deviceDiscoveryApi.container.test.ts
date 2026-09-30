import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Item 11 (row 20.20): in a container the only interface is docker's, so the
// subnet route must not propose it. detectSubnet is mocked so each test can see
// whether the route asked it at all.
const { detectSubnet } = vi.hoisted(() => ({
    detectSubnet: vi.fn(async () => ({
        cidr: '172.17.0.0/16',
        hostCount: 65534,
        source: 'interface',
        interfaceName: 'eth0',
    })),
}));
vi.mock('../network/SubnetDetector', () => ({ detectSubnet }));

import { DeviceDiscoveryApi } from '../api/DeviceDiscoveryApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DOCKER: process.env['WS_SCRCPY_DOCKER'],
};

function setup(docker: boolean): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-discovery-container-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    if (docker) process.env['WS_SCRCPY_DOCKER'] = '1';
    else delete process.env['WS_SCRCPY_DOCKER'];
    Config._resetForTest();
}

afterEach(() => {
    Config._resetForTest();
    for (const [k, v] of [
        [EnvName.CONFIG_PATH, saved.CONFIG],
        ['DEPS_PATH', saved.DEPS],
        ['WS_SCRCPY_DOCKER', saved.DOCKER],
    ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    detectSubnet.mockClear();
});

async function getSubnet(): Promise<{ status: number; body: unknown }> {
    let status = 0;
    const chunks: string[] = [];
    const req = { url: '/api/devices/scan/subnet', method: 'GET', headers: {} } as unknown as IncomingMessage;
    const res = {
        writeHead(code: number) {
            status = code;
            return res;
        },
        setHeader() {},
        end(c?: string) {
            if (c) chunks.push(c);
        },
    } as unknown as ServerResponse;
    await new DeviceDiscoveryApi().handle(req, res);
    return { status, body: JSON.parse(chunks.join('')) };
}

describe('GET /api/devices/scan/subnet in a container (item 11, row 20.20)', () => {
    it('answers { container: true } and never proposes the bridge subnet', async () => {
        setup(true);
        const { status, body } = await getSubnet();
        expect(status).toBe(200);
        expect(body).toEqual({ container: true });
        expect(detectSubnet).not.toHaveBeenCalled();
    });

    it('on a host, still answers the detected subnet', async () => {
        setup(false);
        const { status, body } = await getSubnet();
        expect(status).toBe(200);
        expect(body).toMatchObject({ cidr: '172.17.0.0/16', hostCount: 65534 });
        expect(detectSubnet).toHaveBeenCalledTimes(1);
    });
});
