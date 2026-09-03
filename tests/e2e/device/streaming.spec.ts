import {
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    expect,
    type Locator,
    type Page,
    request,
    test,
} from '@playwright/test';
import { e2eBaseUrl, mintToken } from '../support/auth';
import { gotoHome } from '../support/consent';
import {
    canvasSignature,
    captureConsole,
    connectDevice,
    decodedFrames,
    deviceAddress,
    expectFramesArriving,
    installFrameCounter,
    lockedNotice,
    qaAdb,
    screenState,
    unlockDevice,
    waitForDeviceRow,
} from '../support/device';

/**
 * Smoke module 8 — the stream itself. Rows 8.1, 8.2, 8.3, 8.4, 8.5, 8.6 and 8.8.
 *
 * Three facts shape every assertion in this file:
 *
 *  - **A connection is never the subject; a picture is.** The beta.75 regression
 *    (#508) produced a healthy-looking session, plausible console lines and no
 *    picture at all, because the decoder was handed an Annex B `description`
 *    where WebCodecs needs an ISOBMFF box. So every streaming row ends in
 *    `expectFramesArriving`, which requires the decoded-frame count to rise, the
 *    canvas pixels to change, and the canvas to be something other than black.
 *
 *  - **Frames only exist when the screen changes.** scrcpy encodes on surface
 *    updates, so a still device delivers almost nothing. `expectFramesArriving`
 *    swipes the device between samples for exactly that reason, and no row here
 *    ever samples the canvas without provoking the device first.
 *
 *  - **H.265 is out of reach on this tier, and that is the platform's doing, not
 *    the emulator's.** The Linux runner's Chromium *and* Chrome both refuse
 *    `hev1.1.6.L93.B0` (qa-harness `docs/adr/2026-09-01-browser-codec-matrix.md`,
 *    Linux rows, measured 2026-09-03) because the `noble` base ships no platform
 *    HEVC decoder. The app takes that refusal at face value and drops h265 from
 *    the dropdown, so row 8.5 verifies its H.264 half here and its H.265 half
 *    stays on the residual register. Row 8.6 iterates whatever the dropdown
 *    actually offers rather than a hardcoded list, for the same reason: the
 *    offered set is (device encoders) ∩ (browser decoders), and both sides of
 *    that intersection are environment facts.
 *
 * The emulator is a google_apis x86_64 Android 36 image with software encoders
 * (`c2.android.*` / `OMX.google.*`). Which codecs it offers is READ AT RUNTIME
 * from the dropdown and logged; an absent av1 or h265 encoder is an emulator
 * fact, not a spec failure, and the loop simply has fewer codecs to walk.
 *
 * ⚠️ **These rows need a secure context and cannot say so themselves.**
 * WebCodecs is `[SecureContext]`, so on a plain-HTTP non-loopback origin
 * `VideoDecoder` is undefined, `WebCodecsPlayer.isSupported()` is false, and no
 * player is registered — at which point the device row renders no `connect`
 * link and ConfigureScrcpy's connect button returns early without opening a
 * ConnectModal. Every symptom points at the app and none of them is the app's
 * fault. qa-harness therefore runs the runner inside the subject's network
 * namespace and hands it `PLAYWRIGHT_BASE_URL=http://127.0.0.1:8000`, which is
 * a secure context by the localhost exception. If these rows ever fail with a
 * missing connect link, check the origin before the app.
 */

const CONNECTED_RE = /\[StreamClientScrcpy\] Connected: (.+) (\d+)x(\d+) video=(\S+) audio=(\S+)/;
const REFRESHING_RE = /\[StreamClientScrcpy\] Refreshing stream/;
/** `[WebCodecsPlayer] <codec>: decoder configured but produced no frames after 5000ms…` */
const WATCHDOG_RE = /decoder configured but produced no frames after/;
/** `[WebCodecsPlayer] <codec>: requesting a fresh keyframe (attempt 1/3)` — the beta.81 recovery. */
const KEYFRAME_REQUEST_RE = /requesting a fresh keyframe \(attempt/;
const LOCKED_NOTICE_TEXT = 'device is locked — unlock it to see the screen';
/**
 * How long a row waits for a picture. Generous because the emulator's encoders
 * are software (`c2.android.*`) and the runner shares a host with other suites;
 * a first frame is not slow because the app is wrong.
 */
const FRAMES_TIMEOUT_MS = 90_000;

/** Shared API context: connect/lock/unlock and the screen-state witness all go through it. */
let api: APIRequestContext;
/** Browser contexts opened by a test, closed in afterEach so no stream outlives its row. */
const openContexts: BrowserContext[] = [];

interface AppPage {
    context: BrowserContext;
    page: Page;
    logs: { all: string[]; errors: string[] };
}

interface CanvasBox {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
}

// ---------------------------------------------------------------------------
// Page + stream helpers
// ---------------------------------------------------------------------------

/**
 * Count what the stream socket actually delivers, per URL.
 *
 * Without this, "no picture" has two indistinguishable causes: the device sent
 * no video, or the browser failed to decode what it was sent. The frame counter
 * only sees the second half. Installed as an init script for the same reason
 * the frame counter is — the constructor has to be replaced before any page
 * script grabs a reference to it.
 */
async function installSocketProbe(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as {
            __wsStats: Record<string, { messages: number; bytes: number; closed: string | null }>;
            WebSocket: typeof WebSocket;
        };
        w.__wsStats = {};
        const Orig = w.WebSocket;
        if (!Orig) return;
        w.WebSocket = new Proxy(Orig, {
            construct(target, args: [string | URL, (string | string[])?]) {
                const url = String(args[0]);
                const stat = { messages: 0, bytes: 0, closed: null as string | null };
                w.__wsStats[url] = stat;
                const socket = new target(...args);
                socket.addEventListener('message', (event: MessageEvent) => {
                    stat.messages += 1;
                    const data = event.data as ArrayBuffer | Blob | string;
                    if (data instanceof ArrayBuffer) stat.bytes += data.byteLength;
                    else if (typeof data === 'string') stat.bytes += data.length;
                    else if (data && typeof (data as Blob).size === 'number') stat.bytes += (data as Blob).size;
                });
                socket.addEventListener('close', (event: CloseEvent) => {
                    stat.closed = `${event.code} ${event.reason}`;
                });
                return socket;
            },
        }) as typeof WebSocket;
    });
}

async function socketStats(page: Page): Promise<unknown> {
    return page.evaluate(() => (window as unknown as { __wsStats?: unknown }).__wsStats ?? {});
}

/**
 * `expectFramesArriving`, with the socket's own numbers printed when it fails.
 *
 * A "no picture" failure is worth nothing on its own: it cannot say whether the
 * device sent no video or the browser could not decode what arrived. The socket
 * counters separate those two, and printing them costs nothing on the happy path.
 */
async function expectPicture(page: Page, timeoutMs = FRAMES_TIMEOUT_MS): Promise<void> {
    try {
        await expectFramesArriving(page, timeoutMs);
    } catch (err) {
        const stats = (await socketStats(page)) as Record<string, { messages: number; bytes: number }>;
        console.log(`[stream-socket] ${JSON.stringify(stats)}`);
        const streams = Object.entries(stats).filter(([url]) => url.includes('action=stream'));
        const last = streams[streams.length - 1];
        // The distinction that matters, in the failure text rather than only in
        // the log: bytes on the socket with no decoded frames is the browser
        // failing to decode video it was sent, which is a different fault from
        // the device sending nothing.
        throw new Error(
            `${(err as Error).message}
The stream socket carried ${
                last ? `${last[1].messages} messages / ${last[1].bytes} bytes` : 'no data (no stream socket)'
            }.${
                last && last[1].bytes > 0
                    ? ' Bytes arrived and nothing decoded — register finding 8.14: VideoDecoder.configure never ' +
                      'ran, so the canvas stays at its 300x150 default and the decode watchdog (armed only after ' +
                      'configure) never reports it.'
                    : ' No bytes arrived, so the device sent no video at all — a different fault from finding 8.14.'
            }`,
        );
    }
}

/**
 * Wait for the session's `Connected:` line, dumping the socket counters if it
 * never arrives.
 *
 * A missing `Connected:` line has two very different causes — the browser never
 * opened the stream socket, or it opened one and the server never sent the
 * session header — and the console alone cannot tell them apart. The counters
 * can, so they are printed before the failure rather than left for a rerun.
 */
async function expectConnected(
    page: Page,
    logs: { all: string[] },
    from: number,
    message: string,
): Promise<SessionInfo> {
    try {
        return parseConnected(await waitForConsoleLine(logs, from, CONNECTED_RE, message));
    } catch {
        const stats = (await socketStats(page)) as Record<string, { messages: number; bytes: number; closed: string }>;
        console.log(`[stream-socket] ${JSON.stringify(stats)}`);
        const streams = Object.entries(stats).filter(([url]) => url.includes('action=stream'));
        const last = streams[streams.length - 1];
        throw new Error(
            `${message}. The stream socket is the witness: ${
                last ? `${JSON.stringify(last[1])} on ${last[0]}` : 'the page never opened a stream socket at all'
            }`,
        );
    }
}

/**
 * A fresh context whose page counts decoded frames and stream-socket bytes.
 *
 * Both probes wrap a constructor through an init script, so both have to be
 * installed BEFORE the first navigation — a page that has already loaded holds
 * the untouched constructors and the counters would never move, which reads as
 * "no frames" against a perfectly healthy stream.
 */
async function openApp(browser: Browser): Promise<AppPage> {
    const context = await browser.newContext({ baseURL: e2eBaseUrl() });
    openContexts.push(context);
    const page = await context.newPage();
    await installFrameCounter(page);
    await installSocketProbe(page);
    const logs = captureConsole(page);
    await gotoHome(page);
    return { context, page, logs };
}

/**
 * Wait for a console line matching `re` among the lines logged after `from`.
 *
 * The index matters: several rows connect more than once, and a scan from the
 * top of the buffer would match the PREVIOUS session's `Connected:` line and
 * assert the old codec against the new selection.
 */
async function waitForConsoleLine(
    logs: { all: string[] },
    from: number,
    re: RegExp,
    message: string,
    timeoutMs = 90_000,
): Promise<RegExpExecArray> {
    let found: RegExpExecArray | undefined;
    await expect
        .poll(
            () => {
                for (const line of logs.all.slice(from)) {
                    const m = re.exec(line);
                    if (m) {
                        found = m;
                        return true;
                    }
                }
                return false;
            },
            { timeout: timeoutMs, message },
        )
        .toBe(true);
    return found as RegExpExecArray;
}

interface SessionInfo {
    deviceName: string;
    videoWidth: number;
    videoHeight: number;
    videoCodec: string;
    audioCodec: string;
}

function parseConnected(match: RegExpExecArray): SessionInfo {
    return {
        deviceName: match[1] as string,
        videoWidth: Number(match[2]),
        videoHeight: Number(match[3]),
        videoCodec: match[4] as string,
        audioCodec: match[5] as string,
    };
}

/**
 * ConfigureScrcpy's dialog. It carries no class of its own, so it is identified
 * by the one control only it has — the video-codec select, whose id is suffixed
 * with an escaped udid (hence the `id^=` prefix form rather than importing
 * `Util.escapeUdid` from src/).
 */
function configModal(page: Page): Locator {
    return page.locator('dialog.modal').filter({ has: page.locator('select[id^="videoCodec_"]') });
}

async function openConfigModal(page: Page, udid: string): Promise<Locator> {
    const row = await waitForDeviceRow(page, udid, 60_000);
    await row.locator(`button.action-button[data-command="configure_stream"][data-udid="${udid}"]`).click();
    const modal = configModal(page);
    await expect(modal, 'the config-stream button should open ConfigureScrcpy').toBeVisible();
    // The device probe fills the codec and encoder dropdowns and is what enables
    // the connect button. Asserting on "ready" rather than on the button alone
    // means a probe that fails names itself (status-error, "probe failed: …").
    await expect(modal.locator('span.status-text'), 'the device probe must reach "ready"').toHaveText('ready', {
        timeout: 90_000,
    });
    await expect(modal.locator('button.connect-btn'), 'connect is enabled only once the probe lands').toBeEnabled();
    return modal;
}

/** Click connect in ConfigureScrcpy and wait for the stream modal it opens. */
async function connectFromConfig(page: Page, modal: Locator): Promise<void> {
    await modal.locator('button.connect-btn').click();
    await expect(page.locator('dialog.connect-modal'), 'connect should open the stream modal').toBeVisible();
    await expect(
        page.locator('dialog.connect-modal .connect-modal-error'),
        'the stream must not fail on open (the modal shows "stream failed: …" when it does)',
    ).toHaveCount(0);
}

/**
 * Close the stream modal.
 *
 * Escape and backdrop clicks are deliberately blocked by ConnectModal (UHID
 * keyboard capture needs Escape, and a stray backdrop click must not kill a
 * session), so the × is the only way out. The theme toggle shares the
 * `modal-close` class and sits before the × in the header controls, so it has
 * to be excluded or the click toggles the theme and leaves the stream running.
 */
async function closeStream(page: Page): Promise<void> {
    const modal = page.locator('dialog.connect-modal');
    await modal.locator('button.modal-close:not(.theme-toggle)').click();
    await expect(modal, 'the stream modal should be gone after the ×').toHaveCount(0, { timeout: 15_000 });
}

async function canvasBox(page: Page): Promise<CanvasBox> {
    return page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('canvas.video-layer');
        if (!c) throw new Error('no canvas.video-layer in the document');
        return { clientWidth: c.clientWidth, clientHeight: c.clientHeight, width: c.width, height: c.height };
    });
}

/**
 * Resize the viewport and return the canvas box once it has stopped moving.
 *
 * `.video-layer` is capped by `max-width: calc(95vw - 3.715rem)` /
 * `max-height: calc(90vh - 2.5rem)` inside the stream modal, so its box tracks
 * the viewport — but only after the resize has been applied and laid out. Two
 * identical readings is the settle condition.
 */
async function measureAfterResize(page: Page, size: { width: number; height: number }): Promise<CanvasBox> {
    await page.setViewportSize(size);
    let previous = -1;
    await expect
        .poll(
            async () => {
                const { clientHeight } = await canvasBox(page);
                const settled = clientHeight === previous && clientHeight > 0;
                previous = clientHeight;
                return settled;
            },
            { timeout: 15_000, message: `canvas box should settle after resizing to ${size.width}x${size.height}` },
        )
        .toBe(true);
    return canvasBox(page);
}

function expectAspect(box: CanvasBox, deviceRatio: number, label: string): void {
    const ratio = box.clientWidth / box.clientHeight;
    const drift = Math.abs(ratio - deviceRatio) / deviceRatio;
    expect(
        drift,
        `${label}: the video cell is ${box.clientWidth}x${box.clientHeight} (ratio ${ratio.toFixed(4)}), which must ` +
            `stay within 2% of the device aspect ${deviceRatio.toFixed(4)} — a wider drift is the stretch/squish ` +
            'the #106 grid-auto-sizing fix removed',
    ).toBeLessThan(0.02);
}

async function optionValues(select: Locator): Promise<string[]> {
    return select.evaluate((el) => Array.from((el as HTMLSelectElement).options).map((o) => o.value));
}

/**
 * Move a range input with the keyboard rather than by filling it.
 *
 * Playwright refuses `fill()` on `input[type=range]`, and setting `.value` from
 * a script would skip the `input`/`change` events the modal listens to — so the
 * saved value would not be the value the user is shown.
 */
async function nudgeRange(page: Page, input: Locator, key: 'ArrowLeft' | 'ArrowRight', times: number): Promise<number> {
    await input.focus();
    for (let i = 0; i < times; i++) {
        await page.keyboard.press(key);
    }
    return Number(await input.inputValue());
}

// ---------------------------------------------------------------------------
// Out-of-band device witnesses (the runner's own adb, never the app's)
// ---------------------------------------------------------------------------

/**
 * What the device has in the foreground. The witness for every control assertion.
 *
 * Two sources, and the `=null` lines dropped from both. On Android 16 the first
 * `mCurrentFocus` / `mFocusedApp` that `dumpsys window` prints are the global
 * ones, and they are `null` while a per-display section further down holds the
 * real answer — so a `grep -m2` reads "nothing is focused" off a device that is
 * plainly showing an app. Measured: the run that failed this way had Settings
 * visible in its own stream screenshot. `topResumedActivity` from
 * `dumpsys activity activities` is the unambiguous line; the window-focus lines
 * are kept because they are the only ones that name the notification shade.
 */
function currentFocus(): string {
    try {
        const raw = qaAdb(
            'shell',
            'dumpsys activity activities 2>/dev/null | grep -m2 -E "topResumedActivity|mResumedActivity"; ' +
                'dumpsys window 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp"',
        );
        return raw
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !/=null$/.test(line))
            .join('\n');
    } catch {
        // A transient adb hiccup is not an answer; let the poll ask again.
        return '';
    }
}

/**
 * Wait until the foreground names `re`.
 *
 * `absent` is not optional decoration: the blob can carry several lines, so a
 * stale one naming the launcher would let "Home went back to the launcher" pass
 * while Settings is still in front. Naming what must NOT be there closes that.
 */
async function expectFocus(re: RegExp, message: string, absent?: RegExp, timeoutMs = 30_000): Promise<void> {
    await expect.poll(() => currentFocus(), { timeout: timeoutMs, message }).toMatch(re);
    if (absent) {
        // Polled rather than read once: the two dumpsys sources settle at
        // slightly different moments, so the window-focus half can still carry
        // the outgoing activity for a beat after the resumed activity changed.
        await expect
            .poll(() => currentFocus(), {
                timeout: 10_000,
                message: `${message} — and ${absent} must no longer be in the foreground`,
            })
            .not.toMatch(absent);
    }
}

/** One raw read of the device state the app's own screen-state route summarises. Logged, never asserted. */
function logDeviceDiagnostics(): void {
    const probes: Array<[string, string]> = [
        ['wakefulness', 'dumpsys power 2>/dev/null | grep -m3 -iE "mWakefulness|Display Power|mHoldingDisplay"'],
        // The exact field `parseScreenState` looks for, counted rather than
        // sampled: a `grep -m5 keyguard` that happens not to show it proves
        // nothing about whether it is there further down.
        ['isKeyguardShowing occurrences', 'dumpsys window 2>/dev/null | grep -c -i isKeyguardShowing'],
        ['keyguard (dumpsys window)', 'dumpsys window 2>/dev/null | grep -i -m5 keyguard'],
        ['keyguard (window policy)', 'dumpsys window policy 2>/dev/null | grep -i -m8 "keyguard\\|showing"'],
        // Candidate replacements for a product fix, so the finding carries a recipe.
        ['keyguard (activity)', 'dumpsys activity activities 2>/dev/null | grep -i -m3 keyguard'],
        ['keyguard (statusbar)', 'dumpsys statusbar 2>/dev/null | grep -i -m3 keyguard'],
        ['lockscreen disabled', 'settings get secure lockscreen.disabled; locksettings get-disabled 2>/dev/null'],
        [
            'resumed activity',
            'dumpsys activity activities 2>/dev/null | grep -m2 -E "topResumedActivity|mResumedActivity"',
        ],
        ['window focus', 'dumpsys window 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp"'],
        ['screen_off_timeout', 'settings get system screen_off_timeout'],
        ['display', 'wm size; wm density'],
    ];
    for (const [label, command] of probes) {
        let out: string;
        try {
            out = qaAdb('shell', command).trim();
        } catch (err) {
            out = `<failed: ${(err as Error).message.split('\n')[0]}>`;
        }
        console.log(`[device-state] ${label}: ${out.replace(/\s*\n\s*/g, ' | ') || '<empty>'}`);
    }
}

/** Key codes for the two characters row 8.2 types: KEYCODE_Q (45) and KEYCODE_A (29). */
const TYPED_KEYCODES_RE = /keyCode=(?:45|29)(?![0-9])|KEYCODE_(?:Q|A)(?![A-Z_])/i;

/**
 * Key events the device's input dispatcher recently handled.
 *
 * The out-of-band witness for "typing reaches the device". Deliberately not the
 * text of the focused field: reading that back depends on an IME binding, and
 * on this image the Settings search box does not reliably expose typed
 * characters to `uiautomator dump`. The dispatcher records the key codes it
 * received whether or not anything renders them.
 */
function recentKeyEvents(): string {
    try {
        return qaAdb('shell', 'dumpsys input 2>/dev/null | grep -i -m40 -E "keyCode|RecentQueue|KeyEvent"');
    } catch {
        return '';
    }
}

interface UiNode {
    left: number;
    top: number;
    right: number;
    bottom: number;
    text: string;
    cls: string;
    desc: string;
    id: string;
    focused: boolean;
}

/**
 * The device's view hierarchy, out of band.
 *
 * `uiautomator dump` writes a file, so the read is chained into the same shell
 * round trip. This is how a spec can find a control's real coordinates and read
 * a text field's contents without the app being the one to report it — the app
 * is the thing under test, so it cannot also be the witness.
 */
function uiDump(): UiNode[] {
    let xml: string;
    try {
        // `uiautomator dump` refuses while the window is animating ("could not
        // get idle state") and then writes nothing, so `cat` exits non-zero and
        // adb propagates that. An empty answer means "ask again", never "the
        // screen is empty" — every caller polls.
        xml = qaAdb('shell', 'uiautomator dump /sdcard/qa-ui.xml >/dev/null 2>&1; cat /sdcard/qa-ui.xml');
    } catch {
        return [];
    }
    const nodes: UiNode[] = [];
    const nodeRe = /<node\b([^>]*?)\/?>/g;
    const attr = (raw: string, name: string): string => {
        const m = new RegExp(`\\b${name}="([^"]*)"`).exec(raw);
        return m ? (m[1] as string) : '';
    };
    let m: RegExpExecArray | null = nodeRe.exec(xml);
    while (m !== null) {
        const raw = m[1] as string;
        const bounds = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attr(raw, 'bounds'));
        if (bounds) {
            nodes.push({
                left: Number(bounds[1]),
                top: Number(bounds[2]),
                right: Number(bounds[3]),
                bottom: Number(bounds[4]),
                text: attr(raw, 'text'),
                cls: attr(raw, 'class'),
                desc: attr(raw, 'content-desc'),
                id: attr(raw, 'resource-id'),
                focused: attr(raw, 'focused') === 'true',
            });
        }
        m = nodeRe.exec(xml);
    }
    return nodes;
}

/** The display rectangle the dump's coordinates are expressed in (the root node's bounds). */
function displaySize(nodes: UiNode[]): { width: number; height: number } {
    const width = Math.max(...nodes.map((n) => n.right), 0);
    const height = Math.max(...nodes.map((n) => n.bottom), 0);
    return { width, height };
}

/**
 * Tap a point given in DEVICE pixels through the app's touch canvas.
 *
 * The canvas covers the whole device screen, so device coordinates map onto it
 * as fractions. Clicking the locator (rather than `page.mouse`) makes Playwright
 * check the hit target, so an overlay swallowing the click fails loudly instead
 * of silently sending the touch nowhere.
 */
async function tapDevicePoint(
    page: Page,
    deviceX: number,
    deviceY: number,
    display: { width: number; height: number },
) {
    const touch = page.locator('dialog.connect-modal canvas.touch-layer');
    const box = await touch.boundingBox();
    expect(box, 'the touch canvas must have a box to map device coordinates onto').not.toBeNull();
    const b = box as { x: number; y: number; width: number; height: number };
    await touch.click({
        position: {
            x: (deviceX / display.width) * b.width,
            y: (deviceY / display.height) * b.height,
        },
    });
}

// ---------------------------------------------------------------------------
// Fixture: the device is connected, awake and unlocked before and after each row
// ---------------------------------------------------------------------------

/**
 * Turn the device's lock screen on or off, and read whether it is off.
 *
 * The AVD ships with the lock screen DISABLED — `locksettings get-disabled`
 * answers `true`, measured in run lin-wssw-20260903T204513Z-abca. On such a
 * device KEYCODE_POWER only dozes the display: `mWakefulness` goes to `Dozing`,
 * no keyguard is raised, and `isKeyguardShowing=false` is the CORRECT answer.
 * The app reporting `locked:false` there is right, not broken — which is why
 * row 8.8 has to create a keyguard before it can test the banner at all, and
 * why it puts the setting back afterwards.
 */
function setLockScreenEnabled(enabled: boolean): void {
    qaAdb('shell', 'locksettings', 'set-disabled', enabled ? 'false' : 'true');
}

function lockScreenIsDisabled(): boolean {
    try {
        return /true/i.test(qaAdb('shell', 'locksettings get-disabled'));
    } catch {
        return false;
    }
}

/**
 * Raise the keyguard and require the APP to see it.
 *
 * Deliberately not the support library's `lockDevice`: its message ("the device
 * did not report locked") cannot separate a device that never raised a keyguard
 * from an app that cannot see the one it has, and those are the two candidate
 * explanations. This one quotes the route's answer, the device's own
 * `isKeyguardShowing` lines and the lock-screen setting, so the failure says
 * which of the two it is instead of leaving a reader to guess.
 */
async function lockAndRequireTheAppToSeeIt(udid: string): Promise<void> {
    qaAdb('shell', 'input', 'keyevent', '26');
    const deadline = Date.now() + 20_000;
    let state = await screenState(api, udid);
    while (state.locked !== true && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        state = await screenState(api, udid);
    }
    let raw: string;
    try {
        raw = qaAdb('shell', 'dumpsys window 2>/dev/null | grep -m3 -i isKeyguardShowing')
            .trim()
            .split(/\s*[\r\n]+\s*/)
            .join(' | ');
    } catch {
        raw = '<no isKeyguardShowing line at all>';
    }
    expect(
        state.locked,
        `with the screen off, GET /api/devices/screen-state answered ${JSON.stringify(state)} while the device ` +
            `itself reported "${raw}" and lock-screen-disabled=${lockScreenIsDisabled()}. If the device says the ` +
            'keyguard IS showing and the route still answers locked:false, the fault is the product: ' +
            'src/server/deviceScreenState.ts SCREEN_STATE_COMMAND keeps only `grep -m1 -i isKeyguardShowing` from ' +
            '`dumpsys window`, which prints that field more than once on Android 16.',
    ).toBe(true);
}

async function ensureDeviceReady(): Promise<string> {
    const udid = deviceAddress();
    await connectDevice(api, udid);
    // Wake and dismiss the keyguard with the RUNNER's adb, unconditionally,
    // before consulting the app at all. Two reasons, both learned the hard way:
    //
    //  - The app's screen-state route is what row 8.8 puts on trial, so a
    //    fixture that only wakes the device when that route says to would be
    //    deciding its own preconditions with the behaviour under test.
    //  - A sleeping display produces NO surface updates, so scrcpy sends
    //    session metadata and then nothing — not even the config packet the
    //    decoder needs. The stream reports itself connected, the decoder is
    //    never configured, the watchdog never arms because it arms on
    //    configure, and the canvas sits at its untouched 300x150 default. That
    //    is indistinguishable from the #508 black screen this suite exists to
    //    catch, and it is what a dozing emulator produced in run c662.
    //
    // Both keyevents are idempotent: 224 (WAKEUP) on an awake device is a
    // no-op, and 82 (MENU) dismisses a swipe keyguard and does nothing without one.
    // `stayon true` stops the display timing out again mid-row: injected touches
    // are dropped by the dispatcher while the display is off, so once it sleeps
    // `stimulateScreen` cannot wake it and the stream has nothing to encode.
    // Row 8.8 still turns the screen off with KEYCODE_POWER, which stay-on does
    // not block — it only suppresses the idle timeout.
    qaAdb('shell', 'svc', 'power', 'stayon', 'true');
    qaAdb('shell', 'input', 'keyevent', '224');
    qaAdb('shell', 'input', 'keyevent', '82');
    const state = await screenState(api, udid);
    if (state.awake === false || state.locked !== false) {
        await unlockDevice(api);
    }
    return udid;
}

test.describe('device streaming (smoke §8)', () => {
    test.beforeAll(async () => {
        api = await request.newContext({ baseURL: e2eBaseUrl() });
        // A document GET is the only thing that mints the instance token that gates /api.
        await mintToken(api);
        // Printed once so a failure downstream can be read against what the
        // device actually reports, rather than against what the app says it
        // reports. Row 8.8 depends on `isKeyguardShowing` still being in
        // `dumpsys window` on this Android version, and that is exactly the
        // kind of field that moves between releases.
        logDeviceDiagnostics();
    });

    test.afterAll(async () => {
        // `ensureDeviceReady` turns the stay-awake-while-charging flag on so a
        // dozing display cannot starve the encoder mid-row. Put it back, the
        // way 8.8 restores the lock screen: a suite must not leave the fixture
        // changed for whatever runs next on this emulator.
        if (process.env['QA_DEVICE_ADDRESS'] && process.env['QA_ADB']) {
            try {
                qaAdb('shell', 'svc', 'power', 'stayon', 'false');
            } catch {
                // Teardown only: a device already gone is not this suite's failure.
            }
        }
        await api.dispose();
    });

    test.afterEach(async () => {
        // Close first: a page left open keeps its scrcpy session on the device,
        // and the next row's connect would land on a device already streaming.
        for (const context of openContexts.splice(0)) {
            await context.close();
        }
        // Leave the device awake and unlocked even when the row failed — 8.8
        // deliberately locks it, and a failure mid-row would otherwise hand
        // every later row a black screen and no explanation.
        if (!process.env['QA_DEVICE_ADDRESS'] || !process.env['QA_ADB']) return;
        const state = await screenState(api);
        if (state.awake === false || state.locked !== false) {
            await unlockDevice(api);
        }
    });

    test('@device 8.1 the stream renders live video with no decode errors and rescales with the window at the device aspect ratio', async ({
        browser,
    }) => {
        test.setTimeout(180_000);
        const udid = await ensureDeviceReady();
        const { page, logs } = await openApp(browser);
        const from = logs.all.length;

        await test.step('open the stream from the row', async () => {
            const row = await waitForDeviceRow(page, udid, 60_000);
            // The connect link is intercepted by DeviceTracker: it opens
            // ConnectModal in place rather than navigating to a second tab.
            await row.locator('a.link-stream').click();
            await expect(page.locator('dialog.connect-modal')).toBeVisible();
        });

        const session = parseConnected(
            await waitForConsoleLine(
                logs,
                from,
                CONNECTED_RE,
                'the session should announce itself (…Connected: <name> WxH video=<codec> audio=<codec>)',
            ),
        );
        expect(session.videoWidth, 'the session must report a real width').toBeGreaterThan(0);
        expect(session.videoHeight, 'the session must report a real height').toBeGreaterThan(0);

        await expect(page.locator('dialog.connect-modal .device-view .video canvas.video-layer')).toBeVisible();
        await expectPicture(page);

        const decodeErrors = logs.errors.filter((line) => /decod/i.test(line));
        expect(
            decodeErrors,
            'no decode errors: WebCodecsPlayer logs decoder faults through console.error, and a decoder that ' +
                'configures then emits nothing logs "decoder configured but produced no frames"',
        ).toEqual([]);

        await test.step('the video cell rescales on resize and keeps the device aspect', async () => {
            const deviceRatio = session.videoWidth / session.videoHeight;
            const wide = await measureAfterResize(page, { width: 1280, height: 900 });
            expectAspect(wide, deviceRatio, 'at 1280x900');

            const narrow = await measureAfterResize(page, { width: 760, height: 520 });
            expectAspect(narrow, deviceRatio, 'at 760x520');
            expect(
                narrow.clientHeight,
                `shrinking the window must shrink the video cell (was ${wide.clientHeight}px tall at 1280x900, ` +
                    `${narrow.clientHeight}px at 760x520) — a cell that ignores the viewport is the overflow #106 fixed`,
            ).toBeLessThan(wide.clientHeight);

            const grown = await measureAfterResize(page, { width: 1400, height: 1040 });
            expectAspect(grown, deviceRatio, 'at 1400x1040');
            expect(
                grown.clientHeight,
                `growing the window must grow the video cell back (was ${narrow.clientHeight}px tall at 760x520, ` +
                    `${grown.clientHeight}px at 1400x1040)`,
            ).toBeGreaterThan(narrow.clientHeight);
        });

        await closeStream(page);
    });

    test('@device 8.2 the on-screen buttons, canvas touches and keyboard all reach the device', async ({ browser }) => {
        test.setTimeout(240_000);
        const udid = await ensureDeviceReady();
        const { page, logs } = await openApp(browser);
        const from = logs.all.length;

        const row = await waitForDeviceRow(page, udid, 60_000);
        await row.locator('a.link-stream').click();
        await expect(page.locator('dialog.connect-modal')).toBeVisible();
        await expectConnected(page, logs, from, 'the session should announce itself before any control');
        await expectPicture(page);

        const toolbox = page.locator('dialog.connect-modal .device-view .control-buttons-list');
        // The emulator classifies as a phone (smallestDp < 600), and GoogToolBox
        // seeds phones/tablets into Touch mode. Asserted rather than assumed:
        // in D-pad mode a left-click sends DPAD_CENTER instead of a touch, and
        // the canvas-touch step below would fail for a reason that has nothing
        // to do with touch reaching the device.
        await expect(
            toolbox.locator('label.control-button[title^="Touch mode"]'),
            'a phone-kind device starts the toolbox in Touch mode',
        ).toBeVisible();

        await test.step('Home returns the device to its launcher', async () => {
            qaAdb('shell', 'am', 'start', '-a', 'android.settings.SETTINGS');
            await expectFocus(/com\.android\.settings/, 'Settings should take focus when started out of band');
            await toolbox.locator('button.control-button[title="Home"]').click();
            await expectFocus(
                /launcher/i,
                'the toolbox Home button must return the device to its launcher',
                /com\.android\.settings/,
            );
        });

        await test.step('Back leaves the foreground activity', async () => {
            qaAdb('shell', 'am', 'start', '-a', 'android.settings.SETTINGS');
            await expectFocus(/com\.android\.settings/, 'Settings should take focus when started out of band');
            await toolbox.locator('button.control-button[title="Back"]').click();
            await expectFocus(/launcher/i, 'the toolbox Back button must leave Settings', /com\.android\.settings/);
        });

        await test.step('a swipe on the canvas is delivered as a touch', async () => {
            // Pulling the notification shade down is the one gesture whose result
            // is visible out of band: the shade takes window focus. A tap has no
            // such witness on a launcher whose icon layout is not fixed.
            const touch = page.locator('dialog.connect-modal canvas.touch-layer');
            const box = await touch.boundingBox();
            expect(box, 'the touch canvas must have a box').not.toBeNull();
            const b = box as { x: number; y: number; width: number; height: number };
            const x = b.x + b.width / 2;
            await page.mouse.move(x, b.y + 2);
            await page.mouse.down();
            for (let step = 1; step <= 20; step++) {
                await page.mouse.move(x, b.y + 2 + (b.height * 0.6 * step) / 20);
                await page.waitForTimeout(15);
            }
            await page.mouse.up();
            await expectFocus(
                /NotificationShade/i,
                'a swipe from the top of the video canvas must reach the device as a touch and open the shade',
            );
            await toolbox.locator('button.control-button[title="Back"]').click();
            await expectFocus(/launcher/i, 'Back should close the shade again');
        });

        await test.step('a tap focuses a text field and typing fills it', async () => {
            qaAdb('shell', 'am', 'start', '-a', 'android.settings.SETTINGS');
            await expectFocus(/com\.android\.settings/, 'Settings should take focus when started out of band');
            // Settled state first: a dump taken mid-transition finds a half-built
            // hierarchy and the search affordance is simply absent from it.
            let nodes: UiNode[] = [];
            await expect
                .poll(
                    () => {
                        nodes = uiDump();
                        return nodes.some((n) => /search/i.test(n.id) || /search/i.test(n.desc));
                    },
                    { timeout: 45_000, message: 'the Settings home screen should show its search affordance' },
                )
                .toBe(true);
            const display = displaySize(nodes);
            const search = nodes.find((n) => /search/i.test(n.id) || /search/i.test(n.desc)) as UiNode;
            await tapDevicePoint(
                page,
                Math.round((search.left + search.right) / 2),
                Math.round((search.top + search.bottom) / 2),
                display,
            );

            await expect
                .poll(() => uiDump().some((n) => n.cls === 'android.widget.EditText' && n.focused), {
                    timeout: 45_000,
                    message:
                        'the tap must reach the device and focus the search field — a focused EditText is the ' +
                        'out-of-band proof that the canvas touch was delivered, not just drawn',
                })
                .toBe(true);

            // The stream keeps document-level key capture on, so keystrokes go to
            // the device as KeyCodeControlMessages rather than into the page.
            //
            // Typed once per poll rather than once up front: the search field
            // takes focus a beat before its IME connection is live.
            //
            // The witness is the device's INPUT DISPATCHER, not the field's
            // text. Reading the text back needs an IME binding and the Settings
            // search box on this image does not reliably expose typed
            // characters through `uiautomator dump` — measured as an empty
            // string after a full 60 s of re-typing in run
            // lin-wssw-20260903T214058Z-3c57, on a run where the tap had
            // already focused the EditText. `dumpsys input` names the key codes
            // the dispatcher actually received, which is the thing this row is
            // about: key input reaching the device. KEYCODE_Q is 45 and
            // KEYCODE_A is 29.
            let dispatcher = '';
            try {
                await expect
                    .poll(
                        async () => {
                            await page.keyboard.type('qa');
                            await page.waitForTimeout(800);
                            dispatcher = recentKeyEvents();
                            return TYPED_KEYCODES_RE.test(dispatcher);
                        },
                        {
                            timeout: 45_000,
                            message:
                                'the typed characters must reach the device: its input dispatcher should name ' +
                                'keyCode 45 (Q) or 29 (A) among the events it recently handled',
                        },
                    )
                    .toBe(true);
            } finally {
                // Printed on both paths so a failure carries the exact output
                // the assertion judged, rather than sending the next run to
                // find out what `dumpsys input` prints on this image.
                const flat = dispatcher
                    .trim()
                    .split(/[\r\n]+/)
                    .map((line) => line.trim())
                    .join(' | ');
                console.log(`[8.2] dumpsys input witness: ${flat.slice(0, 1000) || '<empty>'}`);
            }

            await toolbox.locator('button.control-button[title="Home"]').click();
            await expectFocus(/launcher/i, 'Home should return to the launcher after typing');
        });

        await closeStream(page);
    });

    test('@device 8.3 audio streams with the selected codec, the codec toggle changes it, and disabling it is honoured', async ({
        browser,
    }) => {
        test.setTimeout(300_000);
        const udid = await ensureDeviceReady();
        const { page, logs } = await openApp(browser);

        let modal = await openConfigModal(page, udid);
        const audioEnabled = modal.locator('input[type=checkbox][id^="audioEnabled_"]');
        const audioCodecSelect = modal.locator('select[id^="audioCodec_"]');

        // Android 11+ is what scrcpy needs to capture audio at all; this emulator
        // is Android 36, so an unavailable checkbox means the SDK gate misread
        // the descriptor rather than that the device cannot do it.
        await expect(audioEnabled, 'audio capture needs Android 11+ and this device is Android 36').toBeEnabled();
        await audioEnabled.setChecked(true);

        const audioCodecs = await optionValues(audioCodecSelect);
        console.log(`[8.3] audio codecs offered by $udid: $audioCodecs.join(', ')`);
        expect(
            audioCodecs.length,
            `the audio codec dropdown offered $JSON.stringify(audioCodecs): ConfigureScrcpy always appends "raw" ` +
                "and adds opus/aac/flac for the device's own audio encoders, so fewer than two means the probe " +
                'returned no audio encoders at all',
        ).toBeGreaterThanOrEqual(2);
        const firstCodec = audioCodecs[0] as string;
        const secondCodec = audioCodecs[1] as string;

        let from = logs.all.length;
        await audioCodecSelect.selectOption(firstCodec);
        await connectFromConfig(page, modal);
        let session = await expectConnected(page, logs, from, `the session should report audio=${firstCodec}`);
        expect(
            session.audioCodec,
            'the stream metadata reports "disabled" when audio was never asked for and "error" when scrcpy could ' +
                'not open the capture, so either value means the enabled checkbox did not reach the device',
        ).toBe(firstCodec);
        await expectPicture(page);
        await closeStream(page);

        await test.step('changing the audio codec changes what the session reports', async () => {
            modal = await openConfigModal(page, udid);
            await modal.locator('input[type=checkbox][id^="audioEnabled_"]').setChecked(true);
            await modal.locator('select[id^="audioCodec_"]').selectOption(secondCodec);
            from = logs.all.length;
            await connectFromConfig(page, modal);
            session = await expectConnected(page, logs, from, `the session should report audio=${secondCodec}`);
            expect(session.audioCodec, `selecting ${secondCodec} must change the codec the session negotiates`).toBe(
                secondCodec,
            );
            expect(session.audioCodec, 'the second connect must differ from the first').not.toBe(firstCodec);
            await closeStream(page);
        });

        await test.step('the audio source reaches scrcpy', async () => {
            // The source is not echoed in the session metadata, so it cannot be
            // read back directly. What IS observable is that scrcpy accepted it:
            // a source the device cannot open makes the capture fail and the
            // metadata reports audio=error instead of the codec.
            modal = await openConfigModal(page, udid);
            const sources = await optionValues(modal.locator('select[id^="audioSource_"]'));
            console.log(`[8.3] audio sources offered by ${udid}: ${sources.join(', ')}`);
            expect(sources, 'scrcpy\'s own default source, "output", is always offered').toContain('output');
            await modal.locator('input[type=checkbox][id^="audioEnabled_"]').setChecked(true);
            await modal.locator('select[id^="audioSource_"]').selectOption('output');
            await modal.locator('select[id^="audioCodec_"]').selectOption(firstCodec);
            from = logs.all.length;
            await connectFromConfig(page, modal);
            session = await expectConnected(page, logs, from, 'the session should come up with the chosen source');
            expect(session.audioCodec, 'a source scrcpy cannot open surfaces as audio=error').toBe(firstCodec);
            await closeStream(page);
        });

        await test.step('unchecking audio turns it off at the device', async () => {
            modal = await openConfigModal(page, udid);
            await modal.locator('input[type=checkbox][id^="audioEnabled_"]').setChecked(false);
            // The codec and source dropdowns follow the checkbox, which is the
            // visible half of the same state the stream URL carries.
            await expect(modal.locator('select[id^="audioCodec_"]')).toBeDisabled();
            await expect(modal.locator('select[id^="audioSource_"]')).toBeDisabled();
            from = logs.all.length;
            await connectFromConfig(page, modal);
            session = await expectConnected(
                page,
                logs,
                from,
                'the session should report audio=disabled (register finding 8.13: with audio off the server ' +
                    'still waits for three TCP sockets and the stream never starts)',
            );
            expect(session.audioCodec, 'audio off must reach the device as no audio stream at all').toBe('disabled');
            await closeStream(page);
        });

        // Headless Chromium has no sound to prove, so what is asserted is the
        // absence of the failures the audio path reports for itself: AudioPlayer
        // logs "[AudioPlayer] Decoder error" and StreamClientScrcpy logs
        // "Failed to start audio".
        const audioErrors = logs.errors.filter((line) => /audio/i.test(line));
        expect(audioErrors, 'the audio path must not report a decoder or start failure').toEqual([]);
    });

    test('@device 8.4 codec, encoder, fps and bitrate apply to the stream and persist per device across a reload and a resize', async ({
        browser,
    }) => {
        test.setTimeout(300_000);
        const udid = await ensureDeviceReady();
        const { page, logs } = await openApp(browser);

        let modal = await openConfigModal(page, udid);
        const videoCodecs = await optionValues(modal.locator('select[id^="videoCodec_"]'));
        console.log(`[8.4] video codecs offered by ${udid}: ${videoCodecs.join(', ')}`);
        expect(
            videoCodecs.length,
            'the video codec dropdown must offer something: it is the device encoder list intersected with the ' +
                "browser's decode support, and ConfigureScrcpy falls back to h264 rather than an empty list",
        ).toBeGreaterThan(0);

        const baseCodec = (await modal.locator('select[id^="videoCodec_"]').inputValue()) as string;
        const encoderSelect = modal.locator('select[id^="encoderName_"]');
        const encoders = await optionValues(encoderSelect);
        console.log(`[8.4] encoders offered for ${baseCodec}: ${JSON.stringify(encoders)}`);
        expect(
            encoders.length,
            `the encoder dropdown for ${baseCodec} should list at least one encoder`,
        ).toBeGreaterThan(1);
        const chosenEncoder = encoders[encoders.length - 1] as string;
        await encoderSelect.selectOption(chosenEncoder);

        const fpsInput = modal.locator('input[type=range][id^="maxFps_"]');
        const bitrateInput = modal.locator('input[type=range][id^="bitrate_"]');
        const fpsBefore = Number(await fpsInput.inputValue());
        const bitrateBefore = Number(await bitrateInput.inputValue());
        const fpsAfter = await nudgeRange(page, fpsInput, 'ArrowRight', 5);
        const bitrateAfter = await nudgeRange(page, bitrateInput, 'ArrowLeft', 2);
        expect(fpsAfter, `the fps slider should move (was ${fpsBefore})`).not.toBe(fpsBefore);
        expect(bitrateAfter, `the bitrate slider should move (was ${bitrateBefore})`).not.toBe(bitrateBefore);

        await test.step('save flashes "saved"', async () => {
            // Located by position in the settings row (reset, load, save) rather
            // than by name: the button RENAMES itself to "saved" for 1.5s, so a
            // name-based locator stops resolving at the moment it is asserted on.
            const save = modal.locator('.modal-settings button.button').last();
            await expect(save, 'the last settings button is save').toHaveText('save');
            await save.click();
            await expect(save, 'the save button confirms by flashing "saved" for 1.5s').toHaveText('saved');
        });

        await test.step('the values come back after a reload', async () => {
            await gotoHome(page);
            modal = await openConfigModal(page, udid);
            await expect(
                modal.locator('input[type=range][id^="maxFps_"]'),
                'max fps is stored per device (server-side, keyed by udid alone since the viewport-key collapse)',
            ).toHaveValue(String(fpsAfter));
            await expect(modal.locator('input[type=range][id^="bitrate_"]')).toHaveValue(String(bitrateAfter));
            await expect(
                modal.locator('select[id^="encoderName_"]'),
                'the chosen encoder is part of the saved VideoSettings',
            ).toHaveValue(chosenEncoder);
        });

        await test.step('and survive a window resize (they are keyed per device, not per window)', async () => {
            // The beta.67 fix: settings used to be stored under a key that
            // included the viewport, so a resized window read a different slot
            // and the device came back with defaults.
            await page.keyboard.press('Escape');
            await expect(configModal(page)).toHaveCount(0);
            await page.setViewportSize({ width: 900, height: 640 });
            await gotoHome(page);
            modal = await openConfigModal(page, udid);
            await expect(modal.locator('input[type=range][id^="maxFps_"]')).toHaveValue(String(fpsAfter));
            await expect(modal.locator('input[type=range][id^="bitrate_"]')).toHaveValue(String(bitrateAfter));
            await expect(modal.locator('select[id^="encoderName_"]')).toHaveValue(chosenEncoder);
        });

        await test.step('a codec change reaches the stream', async () => {
            // Named rather than defaulted back to baseCodec: re-selecting the
            // codec that was already selected would assert nothing at all, and
            // would do it silently.
            const target = videoCodecs.find((c) => c !== baseCodec);
            expect(
                target,
                `only ${baseCodec} was offered (full list: ${JSON.stringify(videoCodecs)}), so there is no second ` +
                    'codec to change to and this half of the row cannot be exercised',
            ).toBeDefined();
            await modal.locator('select[id^="videoCodec_"]').selectOption(target as string);
            const from = logs.all.length;
            await connectFromConfig(page, modal);
            const session = await expectConnected(page, logs, from, `the session should negotiate video=${target}`);
            expect(
                session.videoCodec,
                `the codec picked in the modal must be the codec the device encodes with (asked for ${target})`,
            ).toBe(target);
            await expectPicture(page);
            await closeStream(page);
        });
    });

    test('@device 8.5 H.264 decodes and paints a picture (the beta.75 black-screen regression check)', async ({
        browser,
    }) => {
        test.setTimeout(180_000);
        const udid = await ensureDeviceReady();
        const { page, logs } = await openApp(browser);

        const modal = await openConfigModal(page, udid);
        const codecs = await optionValues(modal.locator('select[id^="videoCodec_"]'));
        expect(
            codecs,
            "h264 is the baseline: every Android device can encode it and the Linux runner's Chromium decodes it " +
                '(ADR 2026-09-01, Linux rows). Its absence from the dropdown is a real failure, not an environment fact',
        ).toContain('h264');
        // H.265 is the other half of this row and is unreachable on this tier —
        // neither Chromium nor Chrome in the Linux runner has an HEVC decoder, so
        // the app correctly never offers it. That half stays on the residual
        // register against the platform, not against the emulator.
        await modal.locator('select[id^="videoCodec_"]').selectOption('h264');

        const from = logs.all.length;
        await connectFromConfig(page, modal);
        const session = await expectConnected(page, logs, from, 'the h264 session should announce itself');
        expect(session.videoCodec, 'the session must actually be h264').toBe('h264');

        // THE assertion of this row. Before #508 the connection looked exactly
        // this healthy — metadata, canvas, console lines — and no frame was ever
        // painted, because the decoder got Annex B where WebCodecs wanted avcC.
        await expectPicture(page);

        const decodeErrors = logs.errors.filter((line) => /decod/i.test(line));
        expect(decodeErrors, 'h264 must decode without faults').toEqual([]);
        await closeStream(page);
    });

    test('@device 8.6 every other codec the device and browser both support decodes and paints', async ({
        browser,
    }) => {
        test.setTimeout(420_000);
        const udid = await ensureDeviceReady();
        const { page, logs } = await openApp(browser);

        let modal = await openConfigModal(page, udid);
        const offered = await optionValues(modal.locator('select[id^="videoCodec_"]'));
        console.log(`[8.6] video codecs offered by ${udid}: ${offered.join(', ')}`);
        expect(
            offered.length,
            'the offered codec list must not be empty — it is the device encoder list intersected with the ' +
                "browser's decode support, and an empty intersection would mean nothing can stream at all",
        ).toBeGreaterThan(0);

        // Whatever is missing here (h265 certainly, av1 probably) is missing for
        // a named reason: h265 because the Linux runner has no HEVC decoder, av1
        // because a google_apis emulator's software encoder list may not include
        // one. Neither is a spec failure; the loop simply has fewer codecs.
        const others = offered.filter((codec) => codec !== 'h264');
        expect(
            others.length,
            `only h264 was offered (full list: ${JSON.stringify(offered)}). VP8 and VP9 are software encoders every ` +
                'recent AOSP build carries and Linux Chromium decodes both, so their absence points at the device ' +
                'probe rather than at the emulator',
        ).toBeGreaterThan(0);

        let first = true;
        for (const codec of others) {
            await test.step(`${codec} decodes and paints`, async () => {
                if (!first) {
                    modal = await openConfigModal(page, udid);
                }
                first = false;
                await modal.locator('select[id^="videoCodec_"]').selectOption(codec);
                const from = logs.all.length;
                const errorsFrom = logs.errors.length;
                await connectFromConfig(page, modal);
                const session = await expectConnected(page, logs, from, `the session should negotiate video=${codec}`);
                expect(session.videoCodec, 'the device must encode with the codec that was picked').toBe(codec);
                // VP8/VP9 take a different startup path: their config packet
                // carries no usable parameter sets, so the decoder is configured
                // from session metadata instead. A codec that connects and paints
                // nothing is exactly that path breaking.
                await expectPicture(page);
                // The watchdog line is expected here, not a fault. VP8/VP9
                // configure from session metadata and then wait for a keyframe,
                // and keyframes are scarce — measured at 2 in ~24s — so the
                // 5s grace routinely expires before the first one lands. Since
                // beta.81 the watchdog answers by ASKING the device for a
                // keyframe, and the stream recovers. What must not happen is
                // the watchdog firing with no recovery behind it, so that is
                // what is asserted; every other decode error is still a fault.
                const decodeErrors = logs.errors
                    .slice(errorsFrom)
                    .filter((line) => /decod/i.test(line) && !WATCHDOG_RE.test(line));
                expect(decodeErrors, `${codec} must decode without faults`).toEqual([]);
                if (logs.all.slice(from).some((line) => WATCHDOG_RE.test(line))) {
                    expect(
                        logs.all.slice(from).some((line) => KEYFRAME_REQUEST_RE.test(line)),
                        `${codec} tripped the decode watchdog, so it must also have asked the device for a fresh ` +
                            'keyframe — a watchdog that only reports is the beta.81 recovery having regressed',
                    ).toBe(true);
                }
                await closeStream(page);
            });
        }
    });

    test('@device 8.8 (partial) a locked device is reported rather than shown as a black screen, in both orderings', async ({
        browser,
    }) => {
        test.setTimeout(420_000);
        const udid = await ensureDeviceReady();
        const { page, logs } = await openApp(browser);
        const banner = lockedNotice(page);

        // PARTIAL. Three halves of this row are exercised here: the app's own
        // lock detection on SDK 36, the absence of a self-reconnect while
        // locked (issue #498's regression guard), and frames returning after
        // unlock. The banner half is RESIDUAL on this fixture — Android
        // refusing to capture the keyguard is what makes a real device stream
        // black, and this emulator composes its keyguard instead (measured:
        // 50 decoded frames while locked, every canvas sample `:picture`).
        // The banner assertion is therefore live only when a sample actually
        // comes back black; otherwise the row records an annotation.
        //
        // This AVD boots with its lock screen turned off, so KEYCODE_POWER only
        // dozes the display and no keyguard is ever raised — there would be
        // nothing for the banner to report and `locked:false` would be the
        // right answer. Turn the swipe keyguard on for the row and put the
        // setting back afterwards, pass or fail, so the fixture is unchanged
        // for every later row and every later run.
        const lockScreenWasDisabled = lockScreenIsDisabled();
        setLockScreenEnabled(true);
        try {
            /**
             * Wait for the banner, and report how long it took.
             *
             * The detector needs a 30-frame baseline plus five consecutive
             * "no picture" frames before it asks the device anything, and the ask
             * itself is rate-limited to one every 5s. A locked device keeps
             * delivering frames on its own — scrcpy's encoder repeats the previous
             * frame, which is why a black screen measured a steady 13 bytes per
             * frame rather than silence — so no stimulus should be needed. If the
             * banner has not appeared by 25s, KEYCODE_WAKEUP is sent once: it turns
             * the display on WITHOUT dismissing the keyguard, so frames resume while
             * the device stays locked. Whether that was needed is printed, because
             * it is the measurement this row was asked for.
             */
            async function waitForBanner(label: string): Promise<void> {
                const started = Date.now();
                const framesAtStart = await decodedFrames(page);
                const signatures = new Set<string>();
                let nudges = 0;
                let lastNudge = 0;
                let firstBlackAt = 0;
                let bannerAt = 0;
                let visible = false;
                while (Date.now() - started < 90_000) {
                    // A locked device only feeds the detector while its display
                    // is composing. KEYCODE_WAKEUP turns the screen on WITHOUT
                    // dismissing the keyguard, so frames keep coming and the
                    // device stays locked. Repeated because it can doze again.
                    if (Date.now() - lastNudge > 8_000) {
                        qaAdb('shell', 'input', 'keyevent', '224');
                        lastNudge = Date.now();
                        nudges += 1;
                    }
                    const signature = await canvasSignature(page);
                    if (!signature.startsWith('no-')) signatures.add(signature);
                    if (signature.endsWith(':black') && firstBlackAt === 0) firstBlackAt = Date.now();
                    if (await banner.isVisible()) {
                        visible = true;
                        bannerAt = Date.now();
                        break;
                    }
                    await page.waitForTimeout(500);
                }
                const elapsed = Date.now() - started;
                const framesDelta = (await decodedFrames(page)) - framesAtStart;
                const state = await screenState(api, udid);
                console.log(
                    `[8.8] ${label}: banner ${visible ? 'appeared' : 'did NOT appear'} after ${elapsed} ms; ` +
                        `${nudges} wake nudges; frames while locked: ${framesDelta}; ` +
                        `canvas: ${[...signatures].join(' ') || 'none'}; screen-state: ${JSON.stringify(state)}`,
                );
                expect(state.locked, `${label}: the device must still be locked or this proves nothing`).toBe(true);

                if (firstBlackAt !== 0) {
                    // The row's real subject. Android refusing to capture the
                    // keyguard is what makes the stream black, and a black
                    // rectangle with no explanation is issue #498.
                    expect(
                        visible,
                        `${label}: the canvas went black while the device was locked, so the banner must say why. ` +
                            `Samples: ${[...signatures].join(' ')}.`,
                    ).toBe(true);
                    expect(
                        bannerAt - firstBlackAt,
                        `${label}: the banner took ${bannerAt - firstBlackAt} ms after the picture went black. The ` +
                            'detector needs a 30-frame baseline, five degraded frames and one rate-limited ask, ' +
                            'which is seconds, not a minute.',
                    ).toBeLessThanOrEqual(60_000);
                    await expect(banner, 'the banner says what is wrong in words').toHaveText(LOCKED_NOTICE_TEXT);
                    return;
                }
                // RESIDUAL. This emulator composes its keyguard, so the stream
                // keeps a readable picture and there is nothing for the banner
                // to explain. That is real-device behaviour the fixture cannot
                // reproduce, not a defect — so it is recorded as an annotation
                // rather than a failure the nightly would show red forever. The
                // black branch above turns live on its own the day an image
                // starts blanking the keyguard.
                // Reachable with NO samples at all (a canvas that never sized,
                // so every reading was `no-canvas`), and "all pictured" would
                // then be a claim about an empty set. Require real evidence
                // before recording the residual.
                expect(
                    signatures.size,
                    `${label}: the residual verdict claims every canvas sample carried a picture, so there must ` +
                        'have been samples to judge. None means the canvas never sized, which is its own failure.',
                ).toBeGreaterThan(0);
                const note =
                    `${label}: emulator composes the keyguard: ${framesDelta} frames, all pictured — banner ` +
                    'premise not reproducible here.';
                console.log(`[8.8] RESIDUAL — ${note}`);
                test.info().annotations.push({ type: 'residual', description: note });
                // The falsifiable half of the partial: the banner half of the
                // row cannot be exercised here, but the app must still not put
                // a "device is locked" banner over a screen that is plainly
                // readable. A false alarm is a defect in the other direction,
                // and this catches it.
                expect(
                    visible,
                    `${label}: every canvas sample carried a picture, so the banner must stay hidden — a "device ` +
                        'is locked" notice over a readable screen is a false alarm. ' +
                        `Samples: ${[...signatures].join(' ')}.`,
                ).toBe(false);
                await expect(
                    banner,
                    'the DOM form of the same claim: no locked notice over a screen that still has a picture',
                ).toBeHidden();
            }

            await test.step('(a) lock a live stream', async () => {
                const from = logs.all.length;
                const row = await waitForDeviceRow(page, udid, 60_000);
                await row.locator('a.link-stream').click();
                await expect(page.locator('dialog.connect-modal')).toBeVisible();
                await expectConnected(page, logs, from, 'the session should announce itself before locking');
                await expectPicture(page);
                await expect(banner, 'nothing is wrong yet, so no banner').toBeHidden();

                const afterConnect = logs.all.length;
                // Ground truth before the app is asked anything. `lockDevice` polls
                // the app's own screen-state route for `locked`, so when it times
                // out the message cannot say whether this AVD has no keyguard at
                // all or whether the app has lost sight of the one it has —
                // `isKeyguardShowing` is a dumpsys field, and dumpsys fields move
                // between Android releases. These two lines make the run answer that.
                qaAdb('shell', 'input', 'keyevent', '26');
                // The same probes as the start-of-run dump, but taken WHILE the
                // keyguard is up: a field the device only prints when the keyguard
                // is showing would be invisible in an awake-state dump.
                logDeviceDiagnostics();
                console.log(`[8.8] app screen-state after power-off: ${JSON.stringify(await screenState(api, udid))}`);
                await lockAndRequireTheAppToSeeIt(udid);
                await waitForBanner('locked while streaming');

                // The degradation-driven reconnect was removed in beta.82: it could
                // never have fixed a locked phone and only interrupted the video to
                // land on the same black screen (issue #498).
                const refreshes = logs.all.slice(afterConnect).filter((line) => REFRESHING_RE.test(line));
                expect(
                    refreshes,
                    'the stream must NOT reconnect on its own while the device is locked — a "Refreshing stream" line ' +
                        'here means the removed degradation-reconnect came back',
                ).toEqual([]);

                await unlockDevice(api);
                await expect(banner, 'the banner clears on the first frame with a picture in it').toBeHidden({
                    timeout: 30_000,
                });
                await expectPicture(page);
                await closeStream(page);
            });

            await test.step('(b) connect to a device that is already locked', async () => {
                // The case that regressed easily: the frame-size baseline is built
                // out of black frames, so nothing can ever look small relative to it
                // and a purely relative check sees nothing. The absolute floor
                // (NO_PICTURE_FRAME_BYTES) is what catches this one.
                await lockAndRequireTheAppToSeeIt(udid);
                const from = logs.all.length;
                const row = await waitForDeviceRow(page, udid, 60_000);
                await row.locator('a.link-stream').click();
                await expect(page.locator('dialog.connect-modal')).toBeVisible();
                await expectConnected(page, logs, from, 'the session should come up even while locked');

                await waitForBanner('connected while already locked');

                const refreshes = logs.all.slice(from).filter((line) => REFRESHING_RE.test(line));
                expect(refreshes, 'connecting onto a locked device must not start a reconnect loop either').toEqual([]);

                await unlockDevice(api);
                await expect(banner, 'unlocking clears the banner').toBeHidden({ timeout: 30_000 });
                await expectPicture(page);
                await closeStream(page);
            });
        } finally {
            if (lockScreenWasDisabled) setLockScreenEnabled(false);
            qaAdb('shell', 'input', 'keyevent', '224');
            qaAdb('shell', 'input', 'keyevent', '82');
        }
    });
});
