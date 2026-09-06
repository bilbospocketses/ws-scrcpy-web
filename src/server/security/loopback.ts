/**
 * Is this socket peer on the local machine?
 *
 * The check behind every "this machine only" surface: the embed-consent
 * endpoints (EmbedRequestApi) and the sibling identity probe (WhoamiApi). Those
 * are ungated by the instance token and, for whoami, by AuthGate, so the
 * remote address is the only thing standing between them and the LAN --
 * `server.listen(port)` binds all interfaces, `isHostAllowed` accepts any IP
 * literal, and a non-browser client controls its own Origin header.
 *
 * Takes the raw `req.socket.remoteAddress`. Node reports IPv4-mapped IPv6 for a
 * dual-stack listener (`::ffff:127.0.0.1`), so that form is unwrapped first.
 * The whole 127/8 block is loopback, not only 127.0.0.1.
 */
export function isLoopback(remoteAddress: string): boolean {
    const addr = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress;
    return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.');
}
