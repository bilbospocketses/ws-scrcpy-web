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
    return (
        typeof serial === 'string' &&
        serial.length > 0 &&
        !serial.startsWith('-') &&
        SERIAL_RE.test(serial)
    );
}

/** Return the serial when valid, otherwise throw. */
export function assertSerial(serial: unknown): string {
    if (!isValidSerial(serial)) {
        const shown = typeof serial === 'string' ? JSON.stringify(serial) : typeof serial;
        throw new Error(`invalid adb serial: ${shown}`);
    }
    return serial;
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
