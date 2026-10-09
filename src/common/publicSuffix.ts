import { IANA_TLDS } from './ianaTlds';

/**
 * Names a Local HTTPS certificate may not be issued for: every real internet
 * top-level domain, and the common second-level public suffixes below.
 *
 * Why. The CA a hostname certificate is minted with is name-constrained to
 * `{name, *.name}` (see `isAcceptableHostnameSubject` in
 * `src/server/tls/CertService.ts`): an RFC 5280 dNSName constraint always
 * covers the whole subtree under the name, and mkcert adds the `.name` form as
 * well. So a CA made for `de` may sign `bank.de`. Measured: mkcert with the
 * subject `de` produced `Permitted: DNS:de, DNS:.de`, and a leaf for `bank.de`
 * signed by that CA passed `openssl verify`. Every device that installed the CA
 * then accepts such a certificate from anyone who can present it, an
 * interceptor on the network path included. DNS plays no part: whoever holds
 * the CA key does not need to own `bank.de` to answer for it. A real TLD, or a
 * suffix like `co.uk` under which strangers register names, therefore cannot
 * be a subject (user decision 2026-10-09: refuse any real internet TLD).
 *
 * What stays allowed is a name that is not delegated on the internet: `htpc`,
 * `nas`, `localhost`, and also `lan`, `local` and `home`. A CA for one of those
 * still covers every name under it, and for `lan`, `local` and `home` that can
 * mean every device on the LAN named that way; the user accepted that reach
 * for a LAN-only name. It cannot reach a site on the internet.
 *
 * The TLDs are IANA's delegated list, shipped in `src/common/ianaTlds.ts` and
 * refreshed with `scripts/refresh-iana-tlds.mjs`, not fetched at run time. The
 * second-level suffixes are a short explicit list, not the Public Suffix List.
 * Until 0.5.5 the server held a hand-picked list of 25 names and refused every
 * one-word name besides `localhost`, so `htpc` was refused while `media.lan`
 * was not; names like `dev`, `app` or `media` are delegated TLDs, and refused.
 *
 * Shared by the server (`CertService.generate` refuses a listed name) and the
 * client (the Local HTTPS tab says so while the name is typed, and holds
 * generate back), so the two cannot disagree about which names those are.
 */
export const MULTI_LABEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
    'co.uk',
    'org.uk',
    'ac.uk',
    'com.au',
    'net.au',
    'org.au',
    'com.br',
    'co.jp',
    'co.nz',
    'co.za',
    'com.cn',
    'co.in',
]);

/**
 * Is `name` (surrounding whitespace and case ignored) a real internet TLD or
 * one of the listed second-level public suffixes, and so refused as a
 * certificate subject?
 */
export function isPublicSuffix(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    if (normalized === '') return false;
    return normalized.includes('.') ? MULTI_LABEL_PUBLIC_SUFFIXES.has(normalized) : IANA_TLDS.has(normalized);
}
