import type { ServerResponse } from 'http';
import { Config } from '../Config';

/**
 * Container mode's server-side refusals, in one place.
 *
 * A container's lifecycle, updates, dependencies, HTTPS and port belong to the
 * image and to docker, not to the app. Hiding the matching UI is the cosmetic
 * half; these refusals are the half that holds when a route is called directly,
 * which is what keeps the UI gating from having to be a security boundary.
 *
 * 409 rather than 403: the caller is permitted, the action simply does not
 * apply to this deployment. The copy always names the container and the real
 * remedy, so the caller is never left with a refusal and nowhere to go.
 */

/** Where the thing a container refuses actually lives. */
export type ContainerRemedy = 'docker-rm' | 'reverse-proxy' | 'pull-image' | 'docker-settings';

const REMEDY: Record<ContainerRemedy, string> = {
    'docker-rm': "this image's lifecycle belongs to docker. Use `docker rm` to remove it.",
    'reverse-proxy':
        'serve HTTPS from a reverse proxy in front of the container; that is the only supported way to add HTTPS to the image.',
    'pull-image': 'the image owns the app and its dependencies. Pull a newer image to update.',
    'docker-settings':
        'docker owns this setting. The http port is always 8000 inside the container; publish a different one with `docker run -p` or compose `ports:`.',
};

/**
 * Whether this process runs in a container. Fails open to "not a container"
 * when the config cannot be read: that is the desktop answer, the same one the
 * Settings modal falls back to, and a route that already tolerates a config
 * failure (TlsApi's N1) must not start throwing here. A real container always
 * has a loaded config, since `Config` is read at boot before any route runs.
 */
export function inContainer(): boolean {
    try {
        return Config.getInstance()?.dockerMode === true;
    } catch {
        return false;
    }
}

/** The copy a container refusal carries. Pure. */
export function containerRefusalMessage(action: string, remedy: ContainerRemedy): string {
    return `"${action}" does not apply in a container — ${REMEDY[remedy]}`;
}

/**
 * In container mode, answer 409 `{ ok: false, error, reason: 'unsupported' }`
 * and return true (the caller returns at once). Outside a container, touch
 * nothing and return false.
 */
export function refuseInContainer(res: ServerResponse, action: string, remedy: ContainerRemedy): boolean {
    if (!inContainer()) return false;
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(409);
    res.end(JSON.stringify({ ok: false, error: containerRefusalMessage(action, remedy), reason: 'unsupported' }));
    return true;
}

/**
 * App config keys that mean nothing in a container, so a write to any of them
 * is refused there. `installMode` and `firstRunComplete` describe a host install
 * the image does not have (the container reads them from its Docker overlay);
 * `webPort` is fixed by `WS_SCRCPY_WEB_PORT=8000` and restored on every restart;
 * the four updater keys configure an updater a container never runs.
 */
export const CONTAINER_HOST_ONLY_CONFIG_KEYS: ReadonlySet<string> = new Set([
    'installMode',
    'firstRunComplete',
    'webPort',
    'autoUpdate',
    'updateCheckIntervalMinutes',
    'channel',
    'githubOwner',
]);

/** The host-only keys among `keys`, in their original order. Pure. */
export function hostOnlyConfigKeys(keys: readonly string[]): string[] {
    return keys.filter((k) => CONTAINER_HOST_ONLY_CONFIG_KEYS.has(k));
}
