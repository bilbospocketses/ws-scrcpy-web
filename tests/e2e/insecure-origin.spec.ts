import { expect, type Page, test, type WebSocketRoute } from '@playwright/test';
import { e2eBaseUrl } from './support/auth';
import { deviceRow } from './support/device';
import { lanAddress } from './support/rawHttp';

/**
 * Smoke row 8.19: from another machine, over plain http, with a device
 * connected — the device card and the config modal's status line both carry
 * the secure-context notice (finding 8.10), and nothing silently does nothing.
 *
 * "Another machine" is this machine's own LAN address. Chromium treats
 * `http://<that ip>:<port>` as an insecure context for real — `isSecureContext`
 * false, no `VideoDecoder` — so no player registers. Nothing about that is
 * faked: the real insecure origin is the subject of the row.
 *
 * "A device" is a stub. The page's one multiplexed socket
 * (`?action=multiplex`) is routed here and answers the two channels the home
 * page opens: HSTS with one local android tracker, GTRC with one device. The
 * config modal's probe socket (`?action=probe`) is stubbed the same way. The
 * HTTP the page makes (settings, labels, capabilities) goes to the shared
 * server, read-only; nothing here changes server state.
 */

/** src/packages/multiplexer/MessageType.ts. */
const CREATE_CHANNEL = 4;
const RAW_STRING_DATA = 32;

const UDID = 'e2e-8-19-fake';

/** A whole GoogDeviceDescriptor (src/types/GoogDeviceDescriptor.d.ts): buildDeviceRow reads several fields. */
const DESCRIPTOR = {
    udid: UDID,
    state: 'device',
    'ro.build.version.release': '14',
    'ro.build.version.sdk': '34',
    'ro.product.cpu.abi': 'arm64-v8a',
    'ro.product.manufacturer': 'E2E',
    'ro.product.model': 'E2E Fake Phone',
    'ro.serialno': UDID,
    'wifi.interface': '',
    interfaces: [],
    pid: 0,
    'last.update.timestamp': 0,
    'screen.state': 'awake',
};

/** One ProbeResult (src/common/ProbeResult.ts); DeviceProbeClient parses a single text frame. */
const PROBE_RESULT = {
    width: 1080,
    height: 2400,
    density: 420,
    sdkInt: 34,
    videoEncoders: ['c2.android.avc.encoder'],
    audioEncoders: [],
};

/** Copied from src/app/secureContext.ts (insecureOriginNotice), with loopbackEquivalent inlined. */
function expectedNotice(port: string): string {
    return (
        'this address is not a secure origin, so the browser will not expose the video decoder ' +
        'and no stream can start. turn on local https in settings → local https for the ' +
        'quickest fix on your own network, open ' +
        `http://localhost:${port}` +
        ' on the machine running ws-scrcpy-web, or serve this app over https from a trusted origin ' +
        'for anything beyond a home lan.'
    );
}

/** `[u8 type][u32 LE channelId][payload]` — src/packages/multiplexer/Message.ts. */
function frame(type: number, channelId: number, payload: Buffer): Buffer {
    const head = Buffer.alloc(5);
    head.writeUInt8(type, 0);
    head.writeUInt32LE(channelId, 1);
    return Buffer.concat([head, payload]);
}

function stringFrame(channelId: number, message: unknown): Buffer {
    return frame(RAW_STRING_DATA, channelId, Buffer.from(JSON.stringify(message), 'utf8'));
}

interface Stubs {
    /** Channel codes the page asked for, in order. */
    channels: string[];
    /** Probe sockets answered. */
    probes: string[];
}

/** Arm BEFORE navigation: both sockets open during page load or on a click. */
async function stubDeviceSockets(page: Page): Promise<Stubs> {
    const stubs: Stubs = { channels: [], probes: [] };
    await page.routeWebSocket(/\?action=multiplex$/, (ws: WebSocketRoute) => {
        ws.onMessage((message) => {
            if (typeof message === 'string') return;
            if (message.length < 5 || message.readUInt8(0) !== CREATE_CHANNEL) return;
            const channelId = message.readUInt32LE(1);
            const code = message.subarray(5).toString('utf8');
            stubs.channels.push(code);
            if (code === 'HSTS') {
                ws.send(stringFrame(channelId, { id: -1, type: 'hosts', data: { local: [{ type: 'android' }] } }));
            } else if (code === 'GTRC') {
                ws.send(
                    stringFrame(channelId, {
                        id: -1,
                        type: 'devicelist',
                        data: { list: [DESCRIPTOR], id: 'e2e-8-19-tracker', name: 'e2e 8.19 tracker' },
                    }),
                );
            }
        });
    });
    await page.routeWebSocket(/\?action=probe&/, (ws: WebSocketRoute) => {
        stubs.probes.push(ws.url());
        ws.send(JSON.stringify(PROBE_RESULT));
    });
    return stubs;
}

/** The app loaded from this machine's own LAN address: an insecure origin, for real. */
async function gotoFromLan(page: Page): Promise<string> {
    const ip = lanAddress();
    expect(
        ip,
        'this host needs a non-loopback IPv4 address to stand in for another machine (none found in os.networkInterfaces())',
    ).toBeTruthy();
    const port = new URL(e2eBaseUrl()).port;
    await page.goto(`http://${ip}:${port}/`);
    expect(await page.evaluate(() => window.isSecureContext), 'the LAN origin must be an insecure context').toBe(false);
    expect(await page.evaluate(() => typeof (window as { VideoDecoder?: unknown }).VideoDecoder)).toBe('undefined');
    return port;
}

test.describe('8.19 an insecure origin explains itself on the device card and in the config modal', () => {
    test('8.19 the device card shows the secure-context notice in place of a connect link', async ({ page }) => {
        const stubs = await stubDeviceSockets(page);
        const port = await gotoFromLan(page);

        const row = deviceRow(page, UDID);
        await expect(row).toBeVisible();
        expect(stubs.channels).toEqual(['HSTS', 'GTRC']);
        await expect(row.locator('.insecure-origin-notice')).toHaveText(expectedNotice(port));
        await expect(row.locator('a.link-stream')).toHaveCount(0);
        // The control: the card is otherwise whole — its config stream button is there.
        await expect(row.locator('button[id^="configure_"]')).toHaveText('config stream');
    });

    test("8.19 after the probe, the config modal's status line says the same, not 'ready'", async ({ page }) => {
        const stubs = await stubDeviceSockets(page);
        const port = await gotoFromLan(page);

        const row = deviceRow(page, UDID);
        await row.locator('button[id^="configure_"]').click();
        // ConfigureScrcpy's dialog carries no class of its own; it is the open
        // modal holding a video codec select.
        const modal = page.locator('dialog.modal[open]').filter({ has: page.locator('select[id^="videoCodec_"]') });
        await expect(modal).toBeVisible();

        // The probe answered and was applied: the display option is written from
        // it in the same synchronous run that settles the status line.
        await expect.poll(() => stubs.probes.length).toBe(1);
        await expect(modal.locator('select[id^="displayId_"] option')).toHaveText('ID: 0; 1080x2400');

        const status = modal.locator('.modal-footer .status-text');
        await expect(status).toHaveText(expectedNotice(port));
        await expect(status).toHaveClass(/\bstatus-error\b/);
    });
});
