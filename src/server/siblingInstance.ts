/**
 * Is the process listening on loopback `port` ANOTHER INSTANCE OF THIS APP?
 *
 * Asked by the port resolver (index.ts reconcileWebPort) before it persists an
 * auto-shift. The configured port being busy has two very different causes:
 *
 *   - some other program owns it → persist the shift; the user's config should
 *     follow the port that actually works, as it always has;
 *   - a SIBLING instance of ws-scrcpy-web owns it — an elevated second instance
 *     started via "Run as administrator" (smoke row 3.7, case b), a second copy
 *     launched during an update → do NOT persist. The configured port is right
 *     and the sibling is serving it; writing the shift would rewrite the shared
 *     config.json to a port the surviving instance does not serve, and the next
 *     launch reads that file. Measured by qa-harness Arc 1a (2026-09-06): the
 *     elevated instance wrote webPort=8001 into config.json while the
 *     user-level server kept serving 8000.
 *
 * The probe is the launcher's own upgrade probe: GET /api/config, which is
 * exempt from the instance token and needs no Origin (security/instanceToken.ts,
 * security/originGuard.ts — Host is an IP literal). A sibling answers 200 with
 * the AppConfigEnvelope shape: `config.webPort` a number and a `runtime` object.
 * Anything else — refused, timeout, non-JSON, another program's 200 — is "not a
 * sibling", and the caller falls back to the pre-existing behaviour: persist.
 *
 * KNOWN LIMIT: with users configured (locked mode), AuthGate answers this probe
 * with 401, so the guard reads "not a sibling" and an elevated second instance
 * persists its shift exactly as before. The safe default, but an inert one
 * there.
 *
 * NOT FOR THE SERVICE INSTANCE (see isServiceInstance): on the Windows
 * service-install handoff the process holding the configured port is the
 * outgoing local node, and the documented handoff depends on the service
 * PERSISTING the port it will actually serve — the tray and the install poll
 * read it from config.json.
 *
 * Pure apart from the network call; `fetchImpl` exists for tests.
 */
export async function isSiblingInstance(
    port: number,
    opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
    const doFetch = opts.fetchImpl ?? fetch;
    try {
        const res = await doFetch(`http://127.0.0.1:${port}/api/config`, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(opts.timeoutMs ?? 1000),
        });
        if (!res.ok) {
            return false;
        }
        const body = (await res.json()) as { config?: { webPort?: unknown }; runtime?: unknown } | null;
        return typeof body?.config?.webPort === 'number' && body.runtime !== undefined && body.runtime !== null;
    } catch {
        return false;
    }
}

/**
 * Is THIS process the service instance? The service units (Windows via Servy,
 * Linux via systemd — src/server/service/) start Node with WS_SCRCPY_SERVICE=1.
 * The sibling guard above is skipped for it: a service that finds its configured
 * port busy is almost always looking at the local node it is replacing, and
 * must persist the port it ends up on.
 */
export function isServiceInstance(env: NodeJS.ProcessEnv = process.env): boolean {
    return env['WS_SCRCPY_SERVICE'] === '1';
}
