/**
 * Helpers for safely building shell command strings that run with elevated
 * privileges (e.g. `pkexec sh -c ...`). Any string-typed or untrusted value
 * interpolated into such a script runs as root, so it must be quoted or
 * validated. POSIX single-quoting makes a value an inert literal; a single
 * quote is the only character that has to be escaped (close, escaped-quote,
 * reopen: `'\''`).
 */

/** POSIX single-quote a value so it is an inert literal inside `sh -c`. */
export function shQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SERVICE_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Validate a systemd service/unit base name. Service names are server-derived
 * constants today, but they are interpolated into privileged commands, so we
 * pin them to a safe charset rather than trust the caller. Returns the name on
 * success, otherwise throws.
 */
export function assertServiceName(name: string): string {
    if (typeof name !== 'string' || !SERVICE_NAME_RE.test(name)) {
        const shown = typeof name === 'string' ? JSON.stringify(name) : typeof name;
        throw new Error(`invalid service name: ${shown}`);
    }
    return name;
}
