/**
 * The home page's container decisions (row 20.19). Pure (no DOM) so they are
 * unit-testable and importable by the entry point, like `bookmarkGate`.
 *
 * In a container the image IS the install: there is no first run to walk
 * through, no system-wide copy to update, and no in-app updater (the server
 * never starts one there and refuses its routes). Each gate answers false for
 * `docker: true` explicitly, rather than relying on the server's replies
 * happening to keep the control quiet.
 *
 * `docker` is optional on both wire shapes (an old server omits it), and an
 * absent flag means "not a container", so a host is unaffected.
 */

/** The first-run wizard: only on a host whose first run is not complete. */
export function showsWelcomeWizard(args: { docker?: boolean | undefined; firstRunComplete: boolean }): boolean {
    if (args.docker === true) return false;
    return !args.firstRunComplete;
}

/** The "update the system-wide install?" banner (Linux, newer home AppImage over /opt). */
export function offersSystemWideUpdate(status: {
    docker?: boolean | undefined;
    optUpdateAvailable?: boolean | undefined;
}): boolean {
    if (status.docker === true) return false;
    return status.optUpdateAvailable === true;
}

/**
 * The top-bar update pill. `null` is a failed /api/config read, which mounts the
 * pill as before: failing open to the desktop answer, matching SettingsModal.
 */
export function mountsUpdateButton(runtime: { docker?: boolean | undefined } | null): boolean {
    return runtime?.docker !== true;
}
