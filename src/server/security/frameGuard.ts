/**
 * Framing policy for static responses.
 *
 * By default the app refuses to be embedded anywhere but its own origin
 * (`X-Frame-Options: SAMEORIGIN`), which is the clickjacking defense added in
 * #377. That also blocks a legitimate case: another local tool embedding the
 * app in an iframe from a different port, which is a different origin.
 *
 * An operator opts that in per-origin via config.json `frameAncestors`, which
 * adds `Content-Security-Policy: frame-ancestors 'self' <origins>`. Both
 * headers are then sent: CSP Level 2 requires a browser that supports
 * `frame-ancestors` to IGNORE `X-Frame-Options` when both are present, so the
 * allowlist wins in modern browsers while older ones keep the stricter
 * behaviour. Configure nothing and the headers are byte-identical to before.
 */

const BASE_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
} as const;

// Origins permitted to frame the app, beyond its own. Populated once at boot
// from `Config.frameAncestors`; empty by default, so the default policy is
// unchanged unless an operator opts in.
let configuredFrameAncestors: readonly string[] = [];

/**
 * Register the origins allowed to embed the app in a frame. Called once during
 * startup from `Config.frameAncestors`. An empty array restores the default
 * same-origin-only policy.
 *
 * Entries are expected to be pre-validated by `sanitizeFrameAncestors`; this
 * only trims and drops blanks, mirroring setAllowedHosts.
 */
export function setFrameAncestors(origins: readonly string[]): void {
    configuredFrameAncestors = origins.map((o) => o.trim()).filter((o) => o.length > 0);
}

/**
 * Security headers for every static response. Returns a fresh object each call
 * so callers can spread it alongside their own headers.
 */
export function securityHeaders(): Record<string, string> {
    if (configuredFrameAncestors.length === 0) {
        return { ...BASE_HEADERS };
    }

    return {
        ...BASE_HEADERS,
        'Content-Security-Policy': `frame-ancestors 'self' ${configuredFrameAncestors.join(' ')}`,
    };
}
