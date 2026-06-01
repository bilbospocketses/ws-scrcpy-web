import type { UpdatesStatusResponse } from '../../common/UpdateEvents';
import { runUpgradingHandoff } from './UpgradingOverlay';

/**
 * UpdateButton — small top-right indicator that polls /api/updates/status and
 * renders one of 5 states (per SP3 P5 contracts):
 *   - idle (or isInstalled=false): hidden
 *   - checking: muted spinner, tooltip "checking…"
 *   - downloading: blue button "downloading update… {progress}%" (no-op click)
 *   - ready: green button "apply update v{availableVersion}" (POST /apply)
 *   - error: red caption + retry button (POST /check)
 *
 * Polling cadence: 30s default; 2s while in 'downloading' state for fresher
 * progress. Frontend never derives state itself — backend is the source of
 * truth (contracts decision 5). All dynamic text uses textContent only; no
 * innerHTML interpolation. The spinner is CSS-only (.update-button-spinner
 * has its own keyframes in home.css).
 */

const SLOW_POLL_MS = 30 * 1000;
const FAST_POLL_MS = 2 * 1000;
const APPLY_RELOAD_DELAY_MS = 5 * 1000;

export function createUpdateButton(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'update-button-container';
    container.style.display = 'none';

    let pollTimer: number | undefined;
    let currentPollMs = SLOW_POLL_MS;
    let lastStatus: UpdatesStatusResponse | null = null;
    let applyInFlight = false;

    function clearTimer(): void {
        if (pollTimer !== undefined) {
            window.clearInterval(pollTimer);
            pollTimer = undefined;
        }
    }

    function scheduleTimer(ms: number): void {
        clearTimer();
        currentPollMs = ms;
        pollTimer = window.setInterval(() => {
            void poll();
        }, ms);
    }

    function setState(stateClass: string): void {
        container.classList.remove(
            'state-checking',
            'state-downloading',
            'state-ready',
            'state-error',
        );
        if (stateClass) container.classList.add(stateClass);
    }

    function renderHidden(): void {
        container.replaceChildren();
        setState('');
        container.style.display = 'none';
    }

    function renderChecking(): void {
        container.replaceChildren();
        setState('state-checking');
        container.style.display = 'flex';
        container.title = 'checking for updates…';

        const spinner = document.createElement('span');
        spinner.className = 'update-button-spinner';
        // CSS-only spinner; no inner content needed.
        container.appendChild(spinner);

        const label = document.createElement('span');
        label.className = 'update-button-label';
        label.textContent = 'checking…';
        container.appendChild(label);
    }

    function renderDownloading(progress: number | undefined): void {
        container.replaceChildren();
        setState('state-downloading');
        container.style.display = 'flex';
        container.title = 'downloading update';

        const label = document.createElement('span');
        label.className = 'update-button-label';
        const pct = typeof progress === 'number' ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
        label.textContent = `downloading update… ${pct}%`;
        container.appendChild(label);
    }

    function renderReady(availableVersion: string | undefined): void {
        container.replaceChildren();
        setState('state-ready');
        container.style.display = 'flex';
        container.title = 'click to apply downloaded update';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'update-button-action';
        // textContent is the safe path for the dynamic version string.
        btn.textContent = availableVersion
            ? `apply update v${availableVersion}`
            : 'apply update';
        btn.addEventListener('click', () => {
            void onApplyClick(btn);
        });
        container.appendChild(btn);
    }

    function renderError(message: string | undefined): void {
        container.replaceChildren();
        setState('state-error');
        container.style.display = 'flex';
        container.title = message ? `update check failed: ${message}` : 'update check failed';

        const caption = document.createElement('span');
        caption.className = 'update-button-label';
        caption.textContent = 'update check failed';
        container.appendChild(caption);

        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'update-button-retry';
        retryBtn.textContent = 'retry';
        retryBtn.addEventListener('click', () => {
            void onRetryClick(retryBtn);
        });
        container.appendChild(retryBtn);
    }

    function renderRestarting(): void {
        container.replaceChildren();
        setState('state-ready');
        container.style.display = 'flex';
        container.title = 'server is restarting to apply the update';

        const label = document.createElement('span');
        label.className = 'update-button-label';
        label.textContent = 'restarting…';
        container.appendChild(label);
    }

    function renderFromStatus(s: UpdatesStatusResponse): void {
        lastStatus = s;

        // Dev mode (or no updates available + idle) → hidden.
        if (!s.isInstalled) {
            renderHidden();
            // Slow polling is fine in dev mode; nothing will change.
            if (currentPollMs !== SLOW_POLL_MS) scheduleTimer(SLOW_POLL_MS);
            return;
        }

        switch (s.status) {
            case 'idle':
                renderHidden();
                if (currentPollMs !== SLOW_POLL_MS) scheduleTimer(SLOW_POLL_MS);
                break;
            case 'checking':
                renderChecking();
                if (currentPollMs !== SLOW_POLL_MS) scheduleTimer(SLOW_POLL_MS);
                break;
            case 'downloading':
                renderDownloading(s.progress);
                if (currentPollMs !== FAST_POLL_MS) scheduleTimer(FAST_POLL_MS);
                break;
            case 'ready':
                renderReady(s.availableVersion);
                if (currentPollMs !== SLOW_POLL_MS) scheduleTimer(SLOW_POLL_MS);
                break;
            case 'error':
                renderError(s.errorMessage);
                if (currentPollMs !== SLOW_POLL_MS) scheduleTimer(SLOW_POLL_MS);
                break;
            default:
                renderHidden();
        }
    }

    async function poll(): Promise<void> {
        try {
            const r = await fetch('/api/updates/status');
            if (!r.ok) throw new Error(`status ${r.status}`);
            const s = (await r.json()) as UpdatesStatusResponse;
            renderFromStatus(s);
        } catch (err) {
            // Server unreachable — show error state (don't stay hidden) so the
            // user has a retry affordance. Don't blow up unhandled.
            const msg = err instanceof Error ? err.message : 'network error';
            // Keep isInstalled-derived hidden behavior if we previously knew
            // it was dev mode; otherwise show the error.
            if (lastStatus && !lastStatus.isInstalled) {
                renderHidden();
                return;
            }
            renderError(msg);
        }
    }

    async function onApplyClick(btn: HTMLButtonElement): Promise<void> {
        if (applyInFlight) return;
        applyInFlight = true;
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'applying…';
        try {
            const r = await fetch('/api/updates/apply', { method: 'POST' });
            if (!r.ok) {
                btn.disabled = false;
                btn.textContent = prevText;
                applyInFlight = false;
                // Re-poll to learn current state (probably 409 because state
                // wasn't 'ready' anymore, or 503 dev mode).
                void poll();
                return;
            }
            const body = (await r.json().catch(() => ({}))) as { mode?: string };
            if (body.mode === 'reconnect') {
                // Linux: the server is relaunching the AppImage. Show the
                // upgrading overlay and poll the same origin until the new
                // version answers, then reload (timeout → bookmark fallback).
                await runUpgradingHandoff(lastStatus?.currentVersion ?? '');
                return;
            }
            // Windows / fallback: server is exiting within ~100ms. Show
            // "restarting…" and attempt a page reload after a short grace
            // period. The reload fails until Velopack finishes the swap and
            // relaunches the server; that's expected — leave the message visible.
            renderRestarting();
            window.setTimeout(() => {
                try {
                    window.location.reload();
                } catch {
                    // Ignore — server still down.
                }
            }, APPLY_RELOAD_DELAY_MS);
        } catch {
            btn.disabled = false;
            btn.textContent = prevText;
            applyInFlight = false;
            void poll();
        }
    }

    async function onRetryClick(btn: HTMLButtonElement): Promise<void> {
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = '…';
        try {
            const r = await fetch('/api/updates/check', { method: 'POST' });
            if (r.ok) {
                const s = (await r.json()) as UpdatesStatusResponse;
                renderFromStatus(s);
                return;
            }
            // 503 in dev mode or other failure — re-poll status for canonical state.
            await poll();
        } catch {
            // Leave the error state as-is; user can click retry again.
            btn.disabled = false;
            btn.textContent = prevText;
        }
    }

    // Initial poll + start the slow timer. Hidden until first poll resolves.
    scheduleTimer(SLOW_POLL_MS);
    void poll();

    return container;
}
