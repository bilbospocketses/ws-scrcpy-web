import { type BrowserContext, expect, type Page, test, type WebSocketRoute } from '@playwright/test';
import { deviceRow } from './support/device';

/**
 * Smoke row 8.33's app-logic half (#995): a stream link,
 * `/#!action=stream&udid=<id>&player=webcodecs` (the href the connect button
 * itself carries), opens that device's stream with no click, and a ctrl+click
 * on connect opens it in a new tab instead of in place. The device-tier half,
 * a real picture from a real stream, is `device/streaming.spec.ts` @device 8.33.
 *
 * "A device" is a stub, the way insecure-origin.spec.ts builds one: the page's
 * multiplexed socket (`?action=multiplex`) is routed here and answers HSTS with
 * one local android tracker and GTRC with one device. This page is on
 * localhost, a secure context, so the WebCodecs player registers and the card
 * carries a real connect link. The stream socket itself is routed and left
 * silent: what is asserted is that the stream modal opens for the right device,
 * not that frames arrive, and nothing reaches the shared server's adb for a
 * device that does not exist. The routes are on the CONTEXT so a tab opened by a
 * ctrl+click sees the same stub.
 */

/** src/packages/multiplexer/MessageType.ts. */
const CREATE_CHANNEL = 4;
const RAW_STRING_DATA = 32;

const UDID = 'e2e-8-33-fake';
const TRACKER = { id: 'e2e-8-33-tracker', name: 'e2e 8.33 tracker' };
const LINK = `/#!action=stream&udid=${UDID}&player=webcodecs`;

/** A whole GoogDeviceDescriptor once the server has read its properties. */
const READ = {
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

/**
 * The first `device`-state record the server sends for a transport, before
 * getprop answers (server `Device.setState` emits, then fetches): every
 * property empty.
 */
const UNREAD = {
    ...READ,
    'ro.build.version.release': '',
    'ro.build.version.sdk': '',
    'ro.product.cpu.abi': '',
    'ro.product.manufacturer': '',
    'ro.product.model': '',
    'ro.serialno': '',
};

/** `[u8 type][u32 LE channelId][payload]` — src/packages/multiplexer/Message.ts. */
function stringFrame(channelId: number, message: unknown): Buffer {
    const head = Buffer.alloc(5);
    head.writeUInt8(RAW_STRING_DATA, 0);
    head.writeUInt32LE(channelId, 1);
    return Buffer.concat([head, Buffer.from(JSON.stringify(message), 'utf8')]);
}

interface Stub {
    /** Send a device update on the most recent page's tracker channel. */
    update(device: typeof READ): void;
}

/** Arm BEFORE navigation: the sockets open during page load. */
async function stubDevice(context: BrowserContext, first: typeof READ): Promise<Stub> {
    let tracker: { ws: WebSocketRoute; channelId: number } | undefined;
    await context.routeWebSocket(/\?action=multiplex$/, (ws: WebSocketRoute) => {
        ws.onMessage((message) => {
            if (typeof message === 'string') return;
            if (message.length < 5 || message.readUInt8(0) !== CREATE_CHANNEL) return;
            const channelId = message.readUInt32LE(1);
            const code = message.subarray(5).toString('utf8');
            if (code === 'HSTS') {
                ws.send(stringFrame(channelId, { id: -1, type: 'hosts', data: { local: [{ type: 'android' }] } }));
            } else if (code === 'GTRC') {
                tracker = { ws, channelId };
                ws.send(stringFrame(channelId, { id: -1, type: 'devicelist', data: { list: [first], ...TRACKER } }));
            }
        });
    });
    // The stream itself: accepted and left silent, never forwarded to the server.
    await context.routeWebSocket(/[?&]action=stream&/, () => {});
    return {
        update(device) {
            if (!tracker) throw new Error('the page never opened its device tracker channel');
            tracker.ws.send(stringFrame(tracker.channelId, { id: -1, type: 'device', data: { device, ...TRACKER } }));
        },
    };
}

function streamModals(page: Page) {
    return page.locator('dialog.connect-modal[open]');
}

test.describe('8.33 a stream link opens that device stream (#995)', () => {
    test('8.33 a stream link opens the stream with no click once the device has been read, and leaves the address bar', async ({
        context,
        page,
    }) => {
        const stub = await stubDevice(context, UNREAD);
        await page.goto(LINK);

        // The first record has no properties yet: its card exists, but the link
        // waits, because a stream opened from it would have no name, no saved
        // settings and no Android version.
        await expect(deviceRow(page, UDID).locator('a.link-stream')).toBeVisible();
        await expect(streamModals(page)).toHaveCount(0);
        expect(new URL(page.url()).hash, 'the link waits for the device').toBe(LINK.slice(1));

        stub.update(READ);
        await expect(streamModals(page)).toHaveCount(1);
        await expect(streamModals(page)).toHaveAttribute('data-udid', UDID);
        await expect
            .poll(() => new URL(page.url()).hash, { message: 'the followed link leaves the address bar' })
            .toBe('');
    });

    test('8.33 ctrl+click on connect opens the stream in a new tab, and a plain click opens it in place', async ({
        context,
        page,
    }) => {
        await stubDevice(context, READ);
        await page.goto('/');
        const connect = deviceRow(page, UDID).locator('a.link-stream');
        await expect(connect).toBeVisible();

        const [tab] = await Promise.all([
            context.waitForEvent('page'),
            connect.click({ modifiers: ['ControlOrMeta'] }),
        ]);
        await expect(streamModals(tab)).toHaveCount(1);
        await expect(streamModals(tab)).toHaveAttribute('data-udid', UDID);
        await expect(streamModals(page), 'the ctrl+click must not also open it in the first tab').toHaveCount(0);
        await tab.close();

        await connect.click();
        await expect(streamModals(page)).toHaveCount(1);
        expect(context.pages(), 'a plain click opens no tab').toHaveLength(1);
    });

    test('8.33 the same link entered again while that stream is open opens no second stream', async ({
        context,
        page,
    }) => {
        await stubDevice(context, READ);
        await page.goto(LINK);
        await expect(streamModals(page)).toHaveCount(1);
        await expect.poll(() => new URL(page.url()).hash).toBe('');

        await page.evaluate((hash) => {
            window.location.hash = hash;
        }, LINK.slice(1));
        await expect.poll(() => new URL(page.url()).hash, { message: 'the link is consumed again' }).toBe('');
        await expect(streamModals(page)).toHaveCount(1);
    });
});
