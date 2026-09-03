import { execFileSync } from 'node:child_process';
import { type APIRequestContext, expect, type Locator, type Page } from '@playwright/test';

/**
 * Shared ground for the `@device` specs (smoke modules 7, 8, 9 and 19). These run
 * ONLY inside qa-harness's Linux runner, against the subject container and P2's
 * Android emulator on the run network. Two facts every helper here leans on:
 *
 *  - The harness hands the runner the emulator's adb address in
 *    QA_DEVICE_ADDRESS (`qa-android:5555`), and the runner image bakes the
 *    absolute path of its own vendored adb in QA_ADB. A spec never resolves
 *    adb from PATH, and never uses the app's adb for anything: the app's adb
 *    is the thing under test; the runner's is the out-of-band witness (locking
 *    the screen, reading device state, counting shells).
 *  - A spec whose emulator is absent FAILS with a named reason. It never
 *    skips. A silently skipping device suite reports green forever while
 *    covering seventeen fewer rows than anyone believes.
 */

/** The emulator's adb address, or a loud failure naming why the suite cannot run here. */
export function deviceAddress(): string {
    const addr = process.env['QA_DEVICE_ADDRESS'];
    expect(
        addr,
        'QA_DEVICE_ADDRESS is unset: the device suite runs only under qa-harness, which starts the emulator and hands the runner its address. This is the named reason, not a skip.',
    ).toBeTruthy();
    return addr as string;
}

/**
 * The runner's vendored adb, addressed to the emulator. Out-of-band only.
 * run-suite.sh has already `adb connect`ed the endpoint before Playwright
 * started (its exit-45 gate), so `-s <address>` resolves here.
 */
export function qaAdb(...args: string[]): string {
    const adb = process.env['QA_ADB'];
    expect(
        adb,
        'QA_ADB is unset: the runner image bakes the absolute path of its vendored adb; this suite never resolves adb from PATH.',
    ).toBeTruthy();
    return execFileSync(adb as string, ['-s', deviceAddress(), ...args], { encoding: 'utf8', timeout: 30_000 });
}

export async function connectDevice(
    ctx: APIRequestContext,
    address = deviceAddress(),
    label?: string,
): Promise<{ success: boolean; message: string }> {
    const res = await ctx.post('/api/devices/connect', { data: label ? { address, label } : { address } });
    expect(res.status(), `POST /api/devices/connect ${address}`).toBe(200);
    const body = (await res.json()) as { success: boolean; message: string };
    expect(body, `connect ${address}`).toMatchObject({ success: true });
    return body;
}

export async function disconnectDevice(
    ctx: APIRequestContext,
    address = deviceAddress(),
): Promise<{ success: boolean; message: string }> {
    const res = await ctx.post('/api/devices/disconnect', { data: { address } });
    expect(res.status(), `POST /api/devices/disconnect ${address}`).toBe(200);
    return (await res.json()) as { success: boolean; message: string };
}

/**
 * `adb disconnect` answers "no such device" for an address that is not
 * connected, and the route reports that as 500 (register finding 7.8) — so
 * `disconnectDevice`'s 200 assertion cannot be used from an arrange or cleanup
 * step that may run against either state. This accepts both and leaves the
 * caller to assert the OUTCOME (the row is gone). `connectDevice` needs no
 * twin: `adb connect` on an already-connected address answers "already
 * connected to …", which the route reads as success.
 */
export async function disconnectIfConnected(ctx: APIRequestContext, address = deviceAddress()): Promise<void> {
    const res = await ctx.post('/api/devices/disconnect', { data: { address } });
    const body = await res.text();
    expect([200, 500], `POST /api/devices/disconnect ${address} → ${res.status()} ${body}`).toContain(res.status());
}

/** The device's own `ro.serialno` — the key the row's label cell uses (DeviceTracker.buildDeviceRow), read out of band. */
export function deviceSerial(): string {
    const serial = qaAdb('shell', 'getprop', 'ro.serialno').trim();
    expect(serial, 'the emulator must report a ro.serialno — the row label cell keys on it').not.toBe('');
    return serial;
}

/** What the app believes about the device's screen: `{ awake?, locked? }`. */
export async function screenState(
    ctx: APIRequestContext,
    udid = deviceAddress(),
): Promise<{ awake?: boolean; locked?: boolean }> {
    const res = await ctx.get(`/api/devices/screen-state?udid=${encodeURIComponent(udid)}`);
    expect(res.status(), 'GET /api/devices/screen-state').toBe(200);
    return (await res.json()) as { awake?: boolean; locked?: boolean };
}

/**
 * The device's row in the connected-devices list. `.device[data-udid]`, not a
 * bare `[data-udid]`: the same value also sits on the row's "config stream"
 * button, so the bare attribute selector matches two elements per device.
 */
export function deviceRow(page: Page, udid = deviceAddress()): Locator {
    return page.locator(`#devices .device-list .device[data-udid="${udid}"]`);
}

export async function waitForDeviceRow(page: Page, udid = deviceAddress(), timeout = 10_000): Promise<Locator> {
    const row = deviceRow(page, udid);
    await expect(row, `device row for ${udid}`).toBeVisible({ timeout });
    return row;
}

/**
 * Install BEFORE the first navigation. Wraps the page's VideoDecoder so every
 * decoded frame is counted in `window.__decodedFrames`. The app registers a
 * single WebCodecs player, so this is the one place frames can be counted from
 * outside the player without touching app code.
 */
export async function installFrameCounter(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as { __decodedFrames: number; VideoDecoder: typeof VideoDecoder };
        w.__decodedFrames = 0;
        const Orig = w.VideoDecoder;
        if (!Orig) return;
        w.VideoDecoder = class extends Orig {
            constructor(init: VideoDecoderInit) {
                const output = init.output;
                super({
                    ...init,
                    output: (frame: VideoFrame) => {
                        w.__decodedFrames += 1;
                        output(frame);
                    },
                });
            }
        } as typeof VideoDecoder;
    });
}

export async function decodedFrames(page: Page): Promise<number> {
    return page.evaluate(() => (window as unknown as { __decodedFrames?: number }).__decodedFrames ?? 0);
}

/** A cheap signature of the stream canvas's pixels: size plus a sampled hash. */
export async function canvasSignature(page: Page): Promise<string> {
    return page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('canvas.video-layer');
        if (!c || c.width === 0 || c.height === 0) return 'no-canvas';
        const ctx = c.getContext('2d');
        if (!ctx) return 'no-2d';
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let h = 0;
        let nonBlack = 0;
        for (let i = 0; i < d.length; i += 97) {
            h = (h * 31 + (d[i] ?? 0)) >>> 0;
            if ((d[i] ?? 0) > 16) nonBlack += 1;
        }
        return `${c.width}x${c.height}:${h}:${nonBlack > 0 ? 'picture' : 'black'}`;
    });
}

/** Provoke motion on the device, so a healthy stream has something to deliver. Out of band. */
export function stimulateScreen(): void {
    qaAdb('shell', 'input', 'swipe', '300', '900', '300', '400', '250');
}

/**
 * Frames are ARRIVING and carry a picture: the decoded-frame count rises and
 * the canvas signature changes across a stimulus, and the canvas is not all
 * black. The beta.75 regression this guards produced a healthy-looking
 * connection with no picture; "connected" is never the assertion here.
 */
export async function expectFramesArriving(page: Page, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const before = await decodedFrames(page);
    const signatures = new Set<string>();
    while (Date.now() < deadline) {
        stimulateScreen();
        await page.waitForTimeout(600);
        const sig = await canvasSignature(page);
        if (!sig.startsWith('no-')) signatures.add(sig);
        const after = await decodedFrames(page);
        const pictured = [...signatures].some((s) => s.endsWith(':picture'));
        if (after > before && signatures.size >= 2 && pictured) return;
    }
    const after = await decodedFrames(page);
    expect(
        false,
        `no picture arrived within ${timeoutMs} ms: decoded frames ${before} -> ${after}, canvas signatures [${[...signatures].join(', ') || 'none'}]. The frame count must rise, the canvas must change, and it must show something other than black.`,
    ).toBe(true);
}

/** The "device is locked" banner over the video. Hidden until the app's degradation check has asked the device. */
export function lockedNotice(page: Page): Locator {
    return page.locator('.video .stream-locked-notice');
}

/**
 * Lock (screen off) or unlock the emulator out of band. Power (26) toggles
 * the screen; 82 (menu) dismisses the swipe keyguard the emulator boots with.
 * Both are verified through the app's own screen-state route, so a spec is
 * never asserting on a keyevent it merely sent.
 */
export async function lockDevice(ctx: APIRequestContext): Promise<void> {
    const state = await screenState(ctx);
    if (state.awake !== false) qaAdb('shell', 'input', 'keyevent', '26');
    await expect
        .poll(async () => (await screenState(ctx)).locked, {
            timeout: 10_000,
            message: 'the device did not report locked',
        })
        .toBe(true);
}

export async function unlockDevice(ctx: APIRequestContext): Promise<void> {
    const state = await screenState(ctx);
    if (state.awake === false) qaAdb('shell', 'input', 'keyevent', '26');
    qaAdb('shell', 'input', 'keyevent', '82');
    await expect
        .poll(async () => (await screenState(ctx)).locked, {
            timeout: 10_000,
            message: 'the device did not report unlocked',
        })
        .toBe(false);
}

/** Collect console output for the life of a page: `errors` are console.error and pageerror. */
export function captureConsole(page: Page): { all: string[]; errors: string[] } {
    const all: string[] = [];
    const errors: string[] = [];
    page.on('console', (msg) => {
        const line = `[${msg.type()}] ${msg.text()}`;
        all.push(line);
        if (msg.type() === 'error') errors.push(line);
    });
    page.on('pageerror', (err) => {
        all.push(`[pageerror] ${err.message}`);
        errors.push(`[pageerror] ${err.message}`);
    });
    return { all, errors };
}
