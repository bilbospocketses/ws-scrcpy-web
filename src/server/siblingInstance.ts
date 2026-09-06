import { APP_IDENTITY } from './api/WhoamiApi';

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
 * Two probes, sent together, and either one is enough:
 *
 *   1. GET /api/whoami — the identity probe (api/WhoamiApi.ts). Exempt from the
 *      instance token AND from AuthGate, loopback-only, and it answers 200 with
 *      `app: "ws-scrcpy-web"`. This is the one that works with users configured:
 *      the sibling has no session to offer and needs none.
 *   2. GET /api/config — the launcher's upgrade probe, token-exempt but NOT
 *      AuthGate-exempt. A sibling answers 200 with the AppConfigEnvelope shape
 *      (`config.webPort` a number, a `runtime` object) in open mode and 401 in
 *      locked mode. Kept because a sibling may be an OLDER BUILD — during an
 *      update the process holding the port is exactly that — whose whoami is
 *      still token-gated and carries no `app` field.
 *
 * Anything else — refused, timeout, non-JSON, another program's 200, a whoami
 * body without `app` — is "not a sibling", and the caller falls back to the
 * pre-existing behaviour: persist. Only a POSITIVE identification suppresses
 * the write.
 *
 * NOT FOR THE SERVICE INSTANCE (see isServiceInstance): on the Windows
 * service-install handoff the process holding the configured port is the
 * outgoing local node, and the documented handoff depends on the service
 * PERSISTING the port it will actually serve — the tray and the install poll
 * read it from config.json.
 *
 * Pure apart from the network calls; `fetchImpl` exists for tests.
 */
export async function isSiblingInstance(
    port: number,
    opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
    const doFetch = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 1000;

    async function getJson(path: string): Promise<unknown> {
        const res = await doFetch(`http://127.0.0.1:${port}${path}`, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
            return null;
        }
        return res.json();
    }

    // In parallel: one timeout bounds the whole decision, and the cost of the
    // second request is one loopback GET at startup.
    const [identity, envelope] = await Promise.all([
        getJson('/api/whoami').catch(() => null),
        getJson('/api/config').catch(() => null),
    ]);
    return isIdentity(identity) || isEnvelope(envelope);
}

function isIdentity(body: unknown): boolean {
    return typeof body === 'object' && body !== null && (body as { app?: unknown }).app === APP_IDENTITY;
}

function isEnvelope(body: unknown): boolean {
    const b = body as { config?: { webPort?: unknown }; runtime?: unknown } | null;
    return typeof b?.config?.webPort === 'number' && b.runtime !== undefined && b.runtime !== null;
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
