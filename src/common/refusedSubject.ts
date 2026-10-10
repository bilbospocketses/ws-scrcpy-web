/**
 * What the user reads when `POST /api/tls/generate` refuses the certificate
 * subject: sent as the 400 body's `error` (src/server/api/TlsApi.ts), and shown
 * by the Local HTTPS tab when a refusal comes back without one. One function,
 * so the server's copy and the tab's own cannot drift apart (they once differed
 * by a trailing period).
 *
 * It names what the user typed in their own terms: in hostname mode they typed
 * a NAME, and "that address could not be used" (the only wording until 0.5.5)
 * read as though the panel had taken it for an ip address. Fixed copy either
 * way, never the subject itself: echoed back, it would land in the caller's DOM.
 */
export function refusedSubjectMessage(kind: 'ip' | 'hostname'): string {
    return kind === 'hostname'
        ? 'that name could not be used for a certificate.'
        : 'that address could not be used for a certificate.';
}
