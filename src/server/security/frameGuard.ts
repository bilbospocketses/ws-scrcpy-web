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
 * Characters refused anywhere in the raw value, before it is parsed. `*` is a
 * CSP wildcard (`http://*`, `https://*.example`); `;` ends a CSP directive, so
 * `http://a;sandbox` would inject one; `,` separates header values, splitting
 * the header in two for anything that folds it; whitespace separates CSP source
 * expressions; quotes delimit CSP keywords (`'self'`, `'none'`). Checked on the
 * RAW text because the URL parser hides some of them: it silently strips a tab
 * or newline (`http://a\tb` parses as `http://ab`), and drops userinfo
 * (`http://x;y@host` parses as `http://host`).
 */
const FORBIDDEN_RAW_CHARS = /[*;,\s"'`]/;

/**
 * The hostname the parser hands back, after normalization (lowercased, IDNA
 * to punycode, IPv4 forms canonicalized): letters, digits, dots and hyphens
 * only. Punycode (`xn--…`) matches. Anything else -- `_`, `!`, `$`, `&`, `(`,
 * `+`, `=`, `~`, `{`, a percent-decoded `,` or `;` -- is not a host a browser
 * would ever send as an origin, and some of it means something to CSP.
 */
const HOSTNAME_RE = /^[a-z0-9.-]+$/;

/**
 * Normalize one frame-ancestor entry, or return null if it is not usable.
 *
 * Shared by every path that writes `frameAncestors` -- the config.json loader,
 * the embed-request (consent) API and the settings batch's pre-approval -- so a
 * value an operator types into config.json, a value another app asks for and a
 * value staged in Settings are held to exactly the same standard. Accepted: an
 * `http:` or `https:` URL with no path, query, fragment or wildcard, whose host
 * is a DNS name or IPv4 address (letters, digits, dots and hyphens).
 * `frame-ancestors` matches origins, so a path is an authoring mistake the
 * browser would ignore; `*` in any position is refused, since allowing every
 * embedder (or every subdomain) is the thing the header exists to prevent; and
 * the result is interpolated into a `Content-Security-Policy` header, so
 * nothing that CSP or HTTP header syntax gives meaning to may pass (see
 * FORBIDDEN_RAW_CHARS).
 *
 * A bracketed IPv6 literal is refused (HOSTNAME_RE has no `[` or `:`): the CSP
 * host-source grammar has no IPv6 literals, so a browser discards a source such
 * as `http://[::1]:47812` and the embedder stays blocked while the list says it
 * is allowed (proved in Chromium in the 0.5.3 review). `isIpv6FrameAncestor`
 * tells that refusal apart, so callers can say why.
 */
export function parseFrameAncestorOrigin(value: string): string | null {
    const parsed = parseHttpOrigin(value);
    if (parsed === null || !HOSTNAME_RE.test(parsed.hostname)) return null;
    return parsed.origin;
}

/**
 * True when `value` would be an acceptable frame ancestor but for its host
 * being an IPv6 literal (`http://[::1]:5159`), which `parseFrameAncestorOrigin`
 * refuses. Lets the config loader, the consent route and the settings batch
 * give that refusal its own reason: it is the one an older build accepted and
 * a caller is most likely to try in good faith.
 */
export function isIpv6FrameAncestor(value: string): boolean {
    const parsed = parseHttpOrigin(value);
    if (parsed === null) return false;
    return parsed.hostname.startsWith('[');
}

/** The shape checks shared by the two functions above: everything but the host. */
function parseHttpOrigin(value: string): URL | null {
    const trimmed = value.trim();
    if (trimmed.length === 0 || FORBIDDEN_RAW_CHARS.test(trimmed)) return null;

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // `new URL('http://host')` yields pathname '/', so anything longer is a path.
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed;
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
 * Has an operator opted any embedder in? Read by `cookiePolicy` — the framing
 * opt-in is also the consent that relaxes the cookies' SameSite policy, since
 * an embedder that may frame the app is useless if the app cannot authenticate
 * inside that frame (#641).
 */
export function hasFrameAncestors(): boolean {
    return configuredFrameAncestors.length > 0;
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
