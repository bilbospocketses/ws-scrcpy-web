/**
 * Show a sticky banner notice with a single action button. Used for the
 * system-wide update offer and for a declined "install for all users" prompt
 * when the welcome screen does not open — a status-driven banner that lives
 * above the main content (same as FirstRunBanner), not a full-screen modal.
 *
 * Returns the container element so the caller can append it to the page.
 */
export function showStatusBanner(text: string, actionLabel: string, onAction: () => void): HTMLElement {
    const banner = document.createElement('div');
    // Pinned to the BOTTOM edge. At the top it sat over the fixed header controls
    // (settings gear, theme toggle, indicators -- all `top:12px`, z-index 100) and
    // swallowed the click on Settings: 32 of the gear's 36px were under it
    // (qa-harness L3 on beta.145). The page reserves room below its content so
    // the banner never hides the last row either.
    banner.style.cssText =
        'position:fixed;bottom:0;left:0;right:0;z-index:9000;background:var(--bg-color,#1e1e2e);' +
        'color:var(--text-color,#cdd6f4);border-top:1px solid var(--border-color,#45475a);' +
        'padding:0.6rem 1rem;display:flex;align-items:center;gap:1rem;font-size:0.9rem;';
    const msg = document.createElement('span');
    msg.textContent = text;
    banner.appendChild(msg);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = actionLabel;
    btn.style.cssText =
        'padding:0.3rem 0.8rem;border-radius:4px;border:1px solid currentColor;' +
        'background:transparent;color:inherit;cursor:pointer;white-space:nowrap;';
    btn.addEventListener('click', onAction);
    banner.appendChild(btn);
    document.body.appendChild(banner);
    document.body.style.paddingBottom = `${banner.offsetHeight}px`;
    return banner;
}
