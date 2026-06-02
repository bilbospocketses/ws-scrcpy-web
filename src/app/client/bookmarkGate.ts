/**
 * Decide whether to show the "bookmark this URL" reminder. Pure (no DOM) so it
 * is unit-testable and importable by the entry point without pulling the
 * PortChangeModal bundle into the entry chunk.
 *
 * Precedence: a global dismissal ("don't show again, ever") wins outright;
 * otherwise a per-port dismissal suppresses only the matching port, so a port
 * change re-shows the reminder. (v0.1.30-beta.31 #5b.)
 */
export function shouldShowBookmark(args: {
    globallyDismissed: boolean;
    dismissedForPort: number | null;
    currentPort: number;
}): boolean {
    if (args.globallyDismissed) return false;
    if (args.dismissedForPort === args.currentPort) return false;
    return true;
}
