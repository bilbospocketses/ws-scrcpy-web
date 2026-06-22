export const LEGACY_KEYS = {
    theme: 'ws-scrcpy-web-theme',
    iconSize: 'file-browser-icon-size',
    scanSubnets: 'ws-scrcpy-web:scan-subnets',
    audioPrefix: 'ws-scrcpy-web:audio:', // ws-scrcpy-web:audio:<udid>
    videoPrefix: 'WebCodecsPlayer:', // WebCodecsPlayer:<udid>:<WxH>[:<displayId>:<WxH>][:fit]
    migratedFlag: 'ws-scrcpy-web:migrated-to-sqlite',
} as const;

export interface SettingsSink {
    patchGlobal(patch: Record<string, unknown>): Promise<void>;
    patchDevice(udid: string, patch: Record<string, unknown>): Promise<void>;
}

const isWxH = (t: string): boolean => /^\d+x\d+$/.test(t);
const isNum = (t: string): boolean => /^\d+$/.test(t);

/**
 * Recover the udid from a WebCodecsPlayer video key remainder (prefix + any
 * trailing ':fit' already stripped). The remainder is `<udid>:<WxH>` or
 * `<udid>:<WxH>:<displayId>:<WxH>`, and <udid> itself may contain ':'.
 * Returns null if the shape is unrecognized.
 */
function udidFromVideoRemainder(rest: string): string | null {
    const t = rest.split(':');
    if (t.length >= 3 && isWxH(t.at(-1)!) && isNum(t.at(-2)!) && isWxH(t.at(-3)!)) {
        return t.slice(0, -3).join(':') || null; // full form
    }
    if (t.length >= 2 && isWxH(t.at(-1)!)) {
        return t.slice(0, -1).join(':') || null; // short form
    }
    return null;
}

/**
 * One-time import of legacy localStorage prefs into the per-user SQLite store
 * (via the injected sink). Idempotent + retry-safe: legacy keys are cleared and
 * the migrated flag is set ONLY after all patches resolve, so a mid-sequence
 * throw leaves everything intact for a clean re-run next load (the API writes
 * are idempotent KV upserts). Pure: no DOM, no fetch — inject `ls` and `sink`.
 */
export async function migrateLocalStorage(ls: Storage, sink: SettingsSink): Promise<void> {
    if (ls.getItem(LEGACY_KEYS.migratedFlag)) return;

    // ---- global prefs ----
    const globalPatch: Record<string, unknown> = {};
    const theme = ls.getItem(LEGACY_KEYS.theme);
    if (theme !== null) globalPatch['theme'] = theme;
    const icon = ls.getItem(LEGACY_KEYS.iconSize);
    if (icon !== null) {
        const n = parseInt(icon, 10);
        if (!Number.isNaN(n)) globalPatch['iconSize'] = n;
    }
    const subnets = ls.getItem(LEGACY_KEYS.scanSubnets);
    if (subnets !== null) {
        try {
            globalPatch['scanSubnets'] = JSON.parse(subnets);
        } catch {
            /* skip malformed */
        }
    }

    // ---- per-device prefs (audio + video) ----
    const perDevice = new Map<string, { audio?: unknown; video?: { settings?: unknown; fit?: boolean } }>();
    const bucket = (udid: string) => {
        let b = perDevice.get(udid);
        if (!b) {
            b = {};
            perDevice.set(udid, b);
        }
        return b;
    };
    for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (!k) continue;
        if (k.startsWith(LEGACY_KEYS.audioPrefix)) {
            const udid = k.slice(LEGACY_KEYS.audioPrefix.length);
            if (!udid) continue;
            try {
                bucket(udid).audio = JSON.parse(ls.getItem(k)!);
            } catch {
                /* skip malformed */
            }
        } else if (k.startsWith(LEGACY_KEYS.videoPrefix)) {
            let rest = k.slice(LEGACY_KEYS.videoPrefix.length);
            const isFit = rest.endsWith(':fit');
            if (isFit) rest = rest.slice(0, -':fit'.length);
            const udid = udidFromVideoRemainder(rest);
            if (!udid) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(ls.getItem(k)!);
            } catch {
                continue;
            }
            const b = bucket(udid);
            const v = (b.video ??= {});
            if (isFit) v.fit = Boolean(parsed);
            else v.settings = parsed; // last-wins across viewports (collapse)
        }
    }

    // ---- send patches (await all BEFORE clearing) ----
    if (Object.keys(globalPatch).length) await sink.patchGlobal(globalPatch);
    for (const [udid, b] of perDevice) {
        const patch: Record<string, unknown> = {};
        if (b.audio !== undefined) patch['audio'] = b.audio;
        if (b.video !== undefined) patch['video'] = b.video;
        if (Object.keys(patch).length) await sink.patchDevice(udid, patch);
    }

    // ---- clear legacy keys + set marker (only reached on full success) ----
    [LEGACY_KEYS.theme, LEGACY_KEYS.iconSize, LEGACY_KEYS.scanSubnets].forEach((k) => ls.removeItem(k));
    for (let i = ls.length - 1; i >= 0; i--) {
        const k = ls.key(i);
        if (k && (k.startsWith(LEGACY_KEYS.audioPrefix) || k.startsWith(LEGACY_KEYS.videoPrefix))) ls.removeItem(k);
    }
    ls.setItem(LEGACY_KEYS.migratedFlag, '1');
}
