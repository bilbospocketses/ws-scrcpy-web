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

/**
 * Normalise one frame-ancestor entry, or return null if it is not usable.
 *
 * Shared by the config loader and the embed-request API so a value an operator
 * types into config.json and a value another app asks for are held to exactly
 * the same standard. `frame-ancestors` matches origins, so anything carrying a
 * path, query or fragment is an authoring mistake the browser would ignore,
 * and `*` is refused outright — allowing every embedder is the thing the header
 * exists to prevent.
 */
export function parseFrameAncestorOrigin(value: string): string | null {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === '*') return null;

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // `new URL('http://host')` yields pathname '/', so anything longer is a path.
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;

    return parsed.origin;
}

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
