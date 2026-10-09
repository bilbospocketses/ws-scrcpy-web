/**
 * Names a Local HTTPS certificate may not be issued for: common public
 * suffixes (a bare TLD, or a widely used second-level suffix such as `co.uk`),
 * under which unrelated third parties register names the requester does not
 * own.
 *
 * A small, explicit denylist -- NOT a Public Suffix List implementation, and
 * not claimed to be complete. It exists to catch the obvious, high-impact
 * mistake: the CA a hostname certificate is minted with is constrained to
 * `{name, *.name}` (see `isAcceptableHostnameSubject` in
 * `src/server/tls/CertService.ts`), so a certificate for a real public suffix
 * would leave a CA that, if its key leaked, could impersonate every site under
 * that suffix on each device that trusts it.
 *
 * `dev`, `app`, `me`, `io` and `co` were on the list until 0.5.5 and are not any
 * more: one-word names are allowed now (user decision, 2026-10-09; hobbyists
 * name their machines that way and reach them through a hosts file), and those
 * five are believable machine names. They are also real TLDs, but a CA for one
 * word reaches only what the devices that trust it resolve under that word.
 *
 * Shared by the server (`CertService.generate` refuses a listed name) and the
 * client (the Local HTTPS tab says so while the name is typed, and holds
 * generate back), so the two cannot disagree about which names those are.
 */
export const PUBLIC_SUFFIX_DENYLIST: ReadonlySet<string> = new Set([
    'com',
    'net',
    'org',
    'info',
    'biz',
    'gov',
    'edu',
    'mil',
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

/** Is `name` (surrounding whitespace and case ignored) one of the listed public suffixes? */
export function isPublicSuffix(name: string): boolean {
    return PUBLIC_SUFFIX_DENYLIST.has(name.trim().toLowerCase());
}
