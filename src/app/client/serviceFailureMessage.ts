/**
 * The user-facing line for a `ServiceFailureReason` (src/common/ServiceEvents.ts).
 * One copy, so every caller of an endpoint that can raise an elevation prompt
 * says the same thing when it is declined: Settings → Service, Settings → Server
 * ("install for all users"), Settings → Updates and the update chip (a
 * machine-wide update), and the first-run welcome modal (smoke 14.10). Lived in
 * ServiceTab.ts until then, its only caller.
 */
export function reasonToUserMessage(reason: string | undefined, fallbackError: string): string {
    switch (reason) {
        case 'unsupported':
            return 'Service mode is not supported on this platform.';
        case 'uac-declined':
            return 'Administrative privileges were declined. Try again and approve the prompt.';
        case 'handoff-no-target':
            return "Couldn't identify a user session to relay the action to.";
        case 'servy-failure':
            return `Service install/uninstall failed: ${fallbackError}`;
        case 'service-start-failed':
            return 'The service was installed but did not start, so it was removed. The app is still running locally — check the service logs and try again.';
        case 'unknown':
        case undefined:
            return `An unexpected error occurred: ${fallbackError}`;
        default:
            return fallbackError;
    }
}

/**
 * True when a refused response is a declined elevation prompt: 403 with
 * `reason: 'uac-declined'` (a Windows UAC No, or a cancelled polkit prompt).
 * Reads the body, so pass a response nothing else will read. Never throws: a
 * body that is not JSON is simply not a decline.
 */
export async function isElevationDeclined(res: Response): Promise<boolean> {
    if (res.status !== 403) return false;
    try {
        const body = (await res.json()) as { reason?: unknown } | null;
        return body?.reason === 'uac-declined';
    } catch {
        return false;
    }
}
