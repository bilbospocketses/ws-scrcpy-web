/**
 * Pre-approving an embedder from Settings → Embedding (0.5.3): what the admin
 * types into the add row, checked, and turned into the exact origin string(s) a
 * browser will send for that embedder.
 *
 * Shared by the client (the add row's inline validation and the origins it
 * stages) and the server (the batch id below), so the two cannot disagree.
 *
 * The origins are built with `new URL(...).origin`, which is the same
 * normalization the server applies to every frame ancestor
 * (`parseFrameAncestorOrigin`, `src/server/security/frameGuard.ts`) and the
 * same serialization a browser uses for `Origin` and for matching
 * `frame-ancestors`: the scheme and host are lowercased and a scheme's default
 * port (80 for http, 443 for https) is dropped. A staged origin therefore
 * matches, character for character, the one the server stores and the list it
 * returns, which is what makes the tab's duplicate check exact.
 *
 * An IPv6 address is refused, here and on the server: the CSP host-source
 * grammar has no IPv6 literals, so a browser discards a `frame-ancestors`
 * source such as `http://[::1]:47812` and the embedder stays blocked however
 * the list reads (proved in Chromium in the 0.5.3 review).
 */

/**
 * The staged-setting id for "origins to add to `frameAncestors`".
 *
 * One of `SettingsBatchApi.STAGEABLE_IDS`. Its `to` is the array of origins to
 * add; its `from` is always the empty array, because the change only ever
 * adds. Revoking is not staged: it stays an immediate, confirmed action.
 */
export const FRAME_ANCESTORS_ADD_ID = 'frameAncestorsAdd';

/** The scheme dropdown's three choices; `both` adds an http and an https origin. */
export type EmbedderScheme = 'http' | 'https' | 'both';

export const EMBEDDER_SCHEMES: readonly EmbedderScheme[] = ['http', 'https', 'both'];

export function isEmbedderScheme(value: unknown): value is EmbedderScheme {
    return value === 'http' || value === 'https' || value === 'both';
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** One DNS label: letters, digits and inner hyphens, 1-63 characters. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
/** A decimal IPv4 octet with no leading zero (a URL parser reads `010` as octal 8). */
const IPV4_OCTET_RE = /^(?:0|[1-9]\d{0,2})$/;
/**
 * An IPv6 address once any brackets and anything after them are taken off: two
 * or more colons (no hostname or IPv4 address has any, and one is `host:port`),
 * hex digits and dots (the tail of `::ffff:1.2.3.4`), and an optional zone id
 * (`%eth0`). Only good enough to give an IPv6 address its own refusal instead
 * of the generic hostname one; nothing is accepted by it.
 */
const IPV6_LIKE_RE = /^(?=(?:[^:]*:){2})[0-9a-f:.]+(?:%.*)?$/i;
const MAX_HOSTNAME_LENGTH = 253;

/** The second sentence of the add row's "not a valid ip address or hostname" error. */
export const HOSTNAME_RULES_HINT =
    'a hostname uses only letters, digits, hyphens and dots (no underscores); type an internationalized name in its punycode form (xn--…).';

/**
 * The refusal for an IPv6 address, shared with the server (the consent route
 * and the settings batch) so every place an embedder can be added says the
 * same thing. A browser discards an IPv6 `frame-ancestors` source, so allowing
 * one would show as allowed while the embedder stayed blocked.
 */
export const IPV6_EMBEDDER_ERROR =
    "browsers don't accept ipv6 addresses for embedding; use a hostname (such as localhost) or an ipv4 address.";

function fail<T>(error: string): Parsed<T> {
    return { ok: false, error };
}

/** True for an IPv6 address, bare or bracketed, with or without a port after the brackets. */
function looksLikeIpv6(value: string): boolean {
    const inner = value.replace(/^\[/, '').replace(/\].*$/, '');
    return IPV6_LIKE_RE.test(inner);
}

/**
 * Validate the address box: an IPv4 address, a hostname or a fully qualified
 * domain name. Answers the host as it goes into an origin: a name lowercased.
 *
 * Anything else is refused with a message for the inline error, including the
 * near misses a user is likely to paste: a whole URL, `host:port`, and an IPv6
 * address, which a browser will not match in `frame-ancestors`
 * (`IPV6_EMBEDDER_ERROR`). The IPv6 check runs before the port one, so
 * `[::1]:5159` is told about IPv6 rather than sent to the port box first.
 */
export function parseEmbedderAddress(input: string): Parsed<string> {
    const value = input.trim();
    if (value.length === 0) return fail('enter an ip address or hostname.');
    if (value.includes('/')) {
        return fail('enter only the address: choose the scheme from the list, and leave out any path.');
    }
    if (looksLikeIpv6(value)) return fail(IPV6_EMBEDDER_ERROR);

    const colons = (value.match(/:/g) ?? []).length;
    if (colons === 1) {
        return fail('enter the port in the port box, not after the address.');
    }

    // A URL parser reads a host whose LAST label is a number as an IPv4
    // address (WHATWG's "ends in a number"), so `1.2.3` becomes `1.2.0.3` and
    // `999.1.1.1` is refused. Such a value is checked as IPv4, strictly, rather
    // than passed off as a hostname that the URL would then rewrite.
    const labels = value.split('.');
    const last = labels[labels.length - 1] ?? '';
    if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/i.test(last)) return parseIpv4(value);

    if (value.length > MAX_HOSTNAME_LENGTH || !labels.every((label) => LABEL_RE.test(label))) {
        // Names the two refusals a user cannot guess (0.5.3 review, M7): an
        // underscore, legal in some DNS records but never in a hostname a
        // browser sends as an origin, and a non-ASCII name, which a browser
        // sends in its punycode form and so must be typed that way here.
        return fail(`"${value}" is not a valid ip address or hostname. ${HOSTNAME_RULES_HINT}`);
    }
    return { ok: true, value: value.toLowerCase() };
}

function parseIpv4(value: string): Parsed<string> {
    const parts = value.split('.');
    const valid = parts.length === 4 && parts.every((p) => IPV4_OCTET_RE.test(p) && Number(p) <= 255);
    return valid ? { ok: true, value } : fail(`"${value}" is not a valid ipv4 address.`);
}

/**
 * Validate the port box. Blank means the scheme's default port, answered as
 * `null`; otherwise a whole number from 1 to 65535.
 *
 * Read from a TEXT input on purpose: a `type="number"` input reports an
 * unparseable entry (`8e3`, `80.5` mid-typing) as `''`, which this would then
 * accept as "blank", silently dropping what the user typed.
 */
export function parseEmbedderPort(input: string): Parsed<number | null> {
    const value = input.trim();
    if (value.length === 0) return { ok: true, value: null };
    if (!/^\d{1,5}$/.test(value)) return fail('port must be a whole number from 1 to 65535.');
    const port = Number(value);
    if (port < 1 || port > 65535) return fail('port must be a whole number from 1 to 65535.');
    return { ok: true, value: port };
}

/**
 * The refusal for `both` with a port. One port cannot be both schemes' default:
 * port 80 with `both` used to stage `http://host` and `https://host:80`, an
 * https origin on the http port that no real embedder serves from. The add row
 * disables its port box for `both`, so only a value typed before switching, or
 * a hand-built call, meets this.
 */
export const BOTH_SCHEMES_PORT_ERROR =
    'http & https uses 80 for http and 443 for https; for another port, add each scheme separately.';

/**
 * The origin(s) one add stages: one for `http` or `https`, two for `both`
 * (http first). A scheme's default port is dropped (80 for http, 443 for
 * https), which is what a browser sends. `both` takes no port -- it means each
 * scheme on its own default, `http://host` and `https://host` -- and
 * `embedderOriginsFromInput` refuses one (BOTH_SCHEMES_PORT_ERROR); this
 * builder applies whatever port it is given, so callers pass `null` with `both`.
 */
export function buildEmbedderOrigins(host: string, port: number | null, scheme: EmbedderScheme): string[] {
    const schemes: ('http' | 'https')[] = scheme === 'both' ? ['http', 'https'] : [scheme];
    const suffix = port === null ? '' : `:${port}`;
    return schemes.map((s) => new URL(`${s}://${host}${suffix}`).origin);
}

/** Which box an add-row error belongs to. */
export type EmbedderField = 'address' | 'port';

/**
 * The whole add row at once: the origins to stage, or the first problem and
 * the box it is in. The address is checked before the port. `both` with any
 * port at all is refused (BOTH_SCHEMES_PORT_ERROR): it always means each
 * scheme's default.
 */
export function embedderOriginsFromInput(input: {
    address: string;
    port: string;
    scheme: EmbedderScheme;
}): { ok: true; origins: string[] } | { ok: false; field: EmbedderField; error: string } {
    const address = parseEmbedderAddress(input.address);
    if (!address.ok) return { ok: false, field: 'address', error: address.error };
    if (input.scheme === 'both' && input.port.trim().length > 0) {
        return { ok: false, field: 'port', error: BOTH_SCHEMES_PORT_ERROR };
    }
    const port = parseEmbedderPort(input.port);
    if (!port.ok) return { ok: false, field: 'port', error: port.error };
    return { ok: true, origins: buildEmbedderOrigins(address.value, port.value, input.scheme) };
}
