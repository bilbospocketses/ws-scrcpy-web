/**
 * Validation and escaping for untrusted values that flow into adb invocations
 * or device shell command strings. Browser/WebSocket input (paths, serials,
 * encoder names, push destinations) is untrusted; `adb shell <cmd>` runs the
 * command string through the device's /bin/sh, and a serial beginning with "-"
 * is parsed by adb as an option rather than a positional.
 */

/**
 * Wrap an arbitrary string as a single POSIX-sh single-quoted token. Everything
 * inside single quotes is literal except a single quote itself, which is closed,
 * escaped, and reopened (`'\''`). Safe to interpolate into an `adb shell` string.
 */
export function shArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

// adb serials: USB serials, `emulator-NNNN`, and `host:port` for network devices.
// They never contain whitespace (adb prints them whitespace-delimited) and never
// start with "-".
const SERIAL_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidSerial(serial: unknown): serial is string {
    return typeof serial === 'string' && serial.length > 0 && !serial.startsWith('-') && SERIAL_RE.test(serial);
}

/** Return the serial when valid, otherwise throw. */
export function assertSerial(serial: unknown): string {
    if (!isValidSerial(serial)) {
        const shown = typeof serial === 'string' ? JSON.stringify(serial) : typeof serial;
        throw new Error(`invalid adb serial: ${shown}`);
    }
    return serial;
}

// scrcpy codec options are a comma-separated list of `key[:type]=value`, e.g.
// `i-frame-interval:int=2,profile:int=8`. Values are MediaFormat keys, type
// names and numbers — never paths, quotes or shell metacharacters. Like the
// encoder name, this is browser input that ends up inside the `app_process ...`
// string run via `adb shell`, so it is allowlisted rather than escaped.
const CODEC_OPTIONS_RE = /^[A-Za-z0-9_.:,=-]{1,256}$/;

export function isSafeCodecOptions(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && CODEC_OPTIONS_RE.test(value);
}

// Encoder names look like `OMX.qcom.video.encoder.avc` / `c2.android.avc.encoder`.
const ENCODER_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export function isSafeEncoderName(name: unknown): name is string {
    return typeof name === 'string' && ENCODER_RE.test(name);
}

/**
 * Validate an on-device push destination. The value is passed to `adb push` as
 * an argv element (no shell), so the only real hazards are option injection (a
 * leading "-") and an empty/NUL value; we keep the caller's chosen path
 * otherwise so the feature still works for arbitrary device locations.
 */
export function assertSafeRemotePath(name: unknown): string {
    if (typeof name !== 'string' || name.length === 0) {
        throw new Error('invalid remote path: empty');
    }
    if (name.startsWith('-')) {
        throw new Error('invalid remote path: may not start with "-"');
    }
    if (name.includes('\0')) {
        throw new Error('invalid remote path: contains NUL');
    }
    return name;
}

// Device storage/system roots whose recursive deletion would wipe user data or
// brick the device. The file browser only ever deletes user-selected entries
// *beneath* these, never the roots themselves, so we refuse them outright
// (after normalising trailing slashes).
const PROTECTED_ROOTS = new Set([
    '/',
    '/sdcard',
    '/storage',
    '/storage/emulated',
    '/storage/emulated/0',
    '/data',
    '/system',
    '/vendor',
    '/mnt',
    '/proc',
    '/dev',
]);

// A multi-select delete of more than this many entries is treated as abuse
// rather than a legitimate UI action.
const MAX_DELETE_PATHS = 1000;

/**
 * Validate a list of device paths targeted for a privileged recursive delete
 * (`rm -rf`). The op is auth-gated, but a bug or a same-origin script could
 * still drive it, so we defend in depth: the list must be a bounded array of
 * absolute, well-formed paths with no `.`/`..` traversal segments, and must not
 * name a catastrophic storage/system root. Returns the validated paths, else
 * throws.
 */
export function assertDeletablePaths(paths: unknown): string[] {
    if (!Array.isArray(paths) || paths.length === 0) {
        throw new Error('paths must be a non-empty array');
    }
    if (paths.length > MAX_DELETE_PATHS) {
        throw new Error(`too many paths: ${paths.length} (max ${MAX_DELETE_PATHS})`);
    }
    for (const p of paths) {
        if (typeof p !== 'string' || p.length === 0) {
            throw new Error('each path must be a non-empty string');
        }
        if (p.includes('\0')) {
            throw new Error('path contains NUL');
        }
        if (!p.startsWith('/')) {
            throw new Error(`path must be absolute: ${JSON.stringify(p)}`);
        }
        if (p.split('/').some((seg) => seg === '.' || seg === '..')) {
            throw new Error(`path may not contain "." or ".." segments: ${JSON.stringify(p)}`);
        }
        const normalized = p.replace(/\/+$/, '') || '/';
        if (PROTECTED_ROOTS.has(normalized)) {
            throw new Error(`refusing to delete a protected root: ${normalized}`);
        }
    }
    return paths as string[];
}

// ---------------------------------------------------------------------------
// Wireless pairing (`adb pair <address> <code>`)
//
// Moved here from `api/PairingApi.ts`: these are adb-argv validators for
// untrusted request-body input, which is what this module is, and keeping them
// beside `isValidSerial` and `assertSafeRemotePath` is how the next person
// finds them.
//
// SCOPE, because the names invite reuse: these are the PAIRING shapes, not
// general adb-endpoint shapes. `isPairingAddress` requires a port and refuses a
// bracketed IPv6 literal, neither of which is true of `adb connect`, which
// documents `HOST[:PORT]` and accepts IPv6. Applying this to
// `/api/devices/connect` would narrow what that route accepts today; a
// `isConnectAddress` for that path would be a different function.
// ---------------------------------------------------------------------------

/**
 * `address` reaches adb as an argv element of `adb pair <address> <code>`.
 * `PairingService.startCode` does NOT validate it and `AdbClient.pair` only
 * validates a `-s` serial, so this is the only place it is checked — and it is
 * request-body input.
 *
 * execFile means there is no shell to inject into, so the real hazards are
 * option injection (adb parses a leading `-` as a flag, e.g. `-H` to redirect
 * to another adb server) and a value that is not an endpoint at all. The
 * phone's wireless-debugging screen shows `IP:port`, so that is the only shape
 * accepted: an IPv4 literal or a hostname, plus a port. The port range is
 * checked numerically because the pattern alone would accept `:0` and `:99999`.
 *
 * A bracketed IPv6 literal is deliberately REFUSED, though adb itself accepts
 * one. `PairingService.startCode` derives its connect-service fallback IP with
 * `address.split(':')[0]`, which on `[fe80::1]:5555` yields `"["` — so an IPv6
 * pairing could only ever finish `paired-not-connected`. Accepting a form we
 * cannot complete is worse for the user than refusing it at the door with a
 * clear 400. (Fixing that split belongs to `PairingService`, not here.)
 */
const HOST_PORT_RE =
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*:(\d{1,5})$/;

export function isPairingAddress(value: string): boolean {
    if (value.length > 300) {
        return false;
    }
    const match = HOST_PORT_RE.exec(value);
    if (!match) {
        return false;
    }
    const port = Number(match[1] ?? '');
    return port >= 1 && port <= 65535;
}

// ---------------------------------------------------------------------------
// Network connect (`adb connect <address>`)
// ---------------------------------------------------------------------------

/**
 * `address` reaches adb as an argv element of `adb connect <address>`, and then
 * again as the device selector for `adb shell <address> getprop ro.serialno`
 * on the label-persisting path. Until this existed the route checked only that
 * the value was non-empty, so a leading `-` went straight to adb — `-H` points
 * it at another adb server entirely.
 *
 * DELIBERATELY WIDER THAN `isPairingAddress`, which is why it is a separate
 * function rather than a reuse: `adb connect` documents `HOST[:PORT]`, so the
 * port is optional, and it accepts a bracketed IPv6 literal. Pairing refuses
 * both — the first because the phone always shows a port, the second because
 * `PairingService.startCode` cannot derive a fallback IP from one. Neither
 * reason applies here, and narrowing this route to the pairing shape would
 * reject addresses that work today.
 *
 * execFile means there is no shell to inject into, so what is being excluded is
 * option injection and values that are not endpoints at all. Control characters
 * fall out for free: the pattern is an ALLOWLIST, so a NUL or a newline is not
 * a character it can match.
 *
 * It ends `(?![\s\S])` rather than `$`, which is load-bearing and not style: a
 * JS `$` without the `m` flag still matches BEFORE a single trailing newline, so
 * `$` here would have accepted `10.0.0.5\n` — the allowlist would have been
 * right and the anchor would have let it through anyway. `(?![\s\S])` is a true
 * end-of-input assertion; `isConnectAddress('10.0.0.5\n')` pins it.
 */
const CONNECT_ADDRESS_RE =
    /^(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)(?::(\d{1,5}))?(?![\s\S])/;

export function isConnectAddress(value: string): boolean {
    if (value.length === 0 || value.length > 300) {
        return false;
    }
    const match = CONNECT_ADDRESS_RE.exec(value);
    if (!match) {
        return false;
    }
    // The port is optional here, unlike pairing — absent is valid, present must
    // be a real port. `\d{1,5}` alone would accept `:0` and `:70000`.
    const port = match[1];
    if (port === undefined) {
        return true;
    }
    const parsed = Number(port);
    return parsed >= 1 && parsed <= 65535;
}

/**
 * Android's wireless-debugging pairing code is six digits. Accepting digits
 * only — with a little slack on the length rather than a hard six, in case a
 * vendor build differs — keeps anything that could be read as an adb option or
 * a control character out of the argv.
 */
const PAIRING_CODE_RE = /^[0-9]{4,10}$/;

export function isPairingCode(value: string): boolean {
    return PAIRING_CODE_RE.test(value);
}
