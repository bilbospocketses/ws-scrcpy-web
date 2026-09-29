/**
 * True when a request was refused because this page's instance token belongs
 * to a process that has gone. The token is minted per PROCESS and only handed
 * out with a document response (instanceToken.ts), so once a new process
 * answers on this origin -- a service hand-off, or an in-app update's relaunch --
 * every API call the old page makes is
 * `403 {"error":"forbidden","reason":"missing or invalid token"}`. That refusal is
 * itself the proof that a DIFFERENT process now answers here, so a poll waiting
 * for that process reloads to pick up the new token.
 *
 * The hand-off polls read it as "not ready yet" until D4 (qa-harness arc L2,
 * beta.141); the update poll did the same until D15 (arc L4, beta.145). Any
 * other 403 (a non-admin's `{"error":"forbidden"}`, the operator gate) is not
 * this and returns false.
 */
export function isStaleTokenRefusal(status: number, body: unknown): boolean {
    return (
        status === 403 &&
        typeof body === 'object' &&
        body !== null &&
        (body as { reason?: unknown }).reason === 'missing or invalid token'
    );
}
