import type { UpdatesStatusResponse } from '../../common/UpdateEvents';
import { onAdminAccessLost } from './adminAccess';
import { reasonToUserMessage } from './serviceFailureMessage';
import { runUpgradingHandoff } from './UpgradingOverlay';
import { classifyFailedApply, LostApplyWatch } from './updateApplyOutcome';

/**
 * UpdateButton — small top-right indicator that polls /api/updates/status and
 * renders one of 5 states (per SP3 P5 contracts):
 *   - idle (or isInstalled=false): hidden
 *   - checking: muted spinner, tooltip "checking…"
 *   - downloading: blue button "downloading update… {progress}%" (no-op click)
 *   - ready: green button "apply update v{availableVersion}" (POST /apply),
 *     with the reason beside it when the last install of it failed
 *   - error: red caption + retry button (POST /check); the caption is the
 *     failed install's reason when there is one
 *
 * While the chip's own install runs it shows the download's progress, else
 * "installing update…", never a clickable "apply update"; once the server
 * goes down for the update it shows "restarting…" and ignores every later
 * status read.
 *
 * Polling cadence: 30s default; 2s while in 'downloading' state for fresher
 * progress, and while the chip's own install runs. A read the server refuses
 * (403: the admin API does not answer this page, or no longer does) hides the
 * pill and stops the poll for good, never an error pill, and so does Settings
 * announcing this page lost its admin access (`adminAccess.ts`, 0.5.5); the
 * next page load decides afresh. Frontend never derives
 * state itself — backend is the source of truth (contracts decision 5). All
 * dynamic text uses textContent only; no innerHTML interpolation. The spinner
 * is CSS-only (.update-button-spinner has its own keyframes in home.css).
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
    /** From the click until the apply's outcome is known (or the server goes down). */
    let applyInFlight = false;
    /** Set once "restarting…" (or the upgrading overlay) is up; every later status read is dropped. */
    let restarting = false;
    /**
     * Bumped when an apply starts and when its outcome is known, so a status
     * read started before either is dropped rather than painted over it.
     */
    let epoch = 0;
    /**
     * Set while an apply whose answer was lost (a proxy's 502/503/504, or no
     * answer at all) is followed through the status; `reason` is what to say if
     * it turns out not to have happened.
     */
    let lost: { watch: LostApplyWatch; reason: string } | null = null;
    /** Set once the admin API refused this page: no more reads, nothing shown. */
    let stopped = false;

    function installFailedNote(reason: string): string {
        return `install failed: ${reason} — click to retry`;
    }

    function clearTimer(): void {
        if (pollTimer !== undefined) {
            window.clearInterval(pollTimer);
            pollTimer = undefined;
        }
    }

    function scheduleTimer(ms: number): void {
        clearTimer();
        if (stopped) return;
        currentPollMs = ms;
        pollTimer = window.setInterval(() => {
            void poll();
        }, ms);
    }

    function setState(stateClass: string): void {
        container.classList.remove('state-checking', 'state-downloading', 'state-ready', 'state-error');
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

    /** The chip's own install, between or after its download: nothing to click. */
    function renderInstalling(): void {
        container.replaceChildren();
        setState('state-downloading');
        container.style.display = 'flex';
        container.title = 'installing update';

        const label = document.createElement('span');
        label.className = 'update-button-label';
        label.textContent = 'installing update…';
        container.appendChild(label);
    }

    function renderReady(availableVersion: string | undefined, note?: string): void {
        container.replaceChildren();
        setState('state-ready');
        container.style.display = 'flex';
        // Not "downloaded": with automatic download off, the click downloads it first.
        container.title = note ?? 'click to install update';

        if (note) {
            const label = document.createElement('span');
            label.className = 'update-button-label';
            label.textContent = note;
            container.appendChild(label);
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'update-button-action';
        // textContent is the safe path for the dynamic version string.
        btn.textContent = availableVersion ? `apply update v${availableVersion}` : 'apply update';
        btn.addEventListener('click', () => {
            void onApplyClick(btn);
        });
        container.appendChild(btn);
    }

    /**
     * A failed check, with a retry that checks again. `applyError` is a failed
     * install of the update on offer (the check after it failed too): its reason
     * is the one shown, as Settings → Updates does. The retry still checks, since
     * the server only installs from `ready`; a check that succeeds brings back the
     * apply button with the same reason beside it.
     */
    function renderError(message: string | undefined, applyError?: string): void {
        container.replaceChildren();
        setState('state-error');
        container.style.display = 'flex';
        if (applyError !== undefined) {
            container.title = `install failed: ${applyError} — retry checks for the update again`;
        } else {
            container.title = message ? `update check failed: ${message}` : 'update check failed';
        }

        const caption = document.createElement('span');
        caption.className = 'update-button-label';
        caption.textContent = applyError !== undefined ? `install failed: ${applyError}` : 'update check failed';
        container.appendChild(caption);

        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'update-button-retry';
        retryBtn.title = 'check for updates again';
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
        if (restarting) return;
        lastStatus = s;

        // Dev mode (or no updates available + idle) → hidden.
        if (!s.isInstalled) {
            renderHidden();
            // Slow polling is fine in dev mode; nothing will change.
            if (currentPollMs !== SLOW_POLL_MS) scheduleTimer(SLOW_POLL_MS);
            return;
        }

        if (applyInFlight) {
            // The chip's own install: its download, else a label. A `ready` read
            // now (before the server has the request, or after the download) must
            // not offer the update for a second click.
            if (s.status === 'downloading') renderDownloading(s.progress);
            else renderInstalling();
            if (currentPollMs !== FAST_POLL_MS) scheduleTimer(FAST_POLL_MS);
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
                renderReady(
                    s.availableVersion,
                    s.lastApplyError !== undefined ? installFailedNote(s.lastApplyError) : undefined,
                );
                if (currentPollMs !== SLOW_POLL_MS) scheduleTimer(SLOW_POLL_MS);
                break;
            case 'error':
                renderError(s.errorMessage, s.lastApplyError);
                if (currentPollMs !== SLOW_POLL_MS) scheduleTimer(SLOW_POLL_MS);
                break;
            default:
                renderHidden();
        }
    }

    /** The admin API does not answer this page: hide, and never read again. */
    function stopForGood(): void {
        stopped = true;
        clearTimer();
        renderHidden();
    }

    async function poll(): Promise<void> {
        if (stopped) return;
        const started = epoch;
        let s: UpdatesStatusResponse;
        try {
            const r = await fetch('/api/updates/status');
            // Refused, not failed: nothing to retry, nothing to show. An apply
            // in flight, or one being followed, is still decided below.
            if (r.status === 403 && !applyInFlight && !lost) {
                stopForGood();
                return;
            }
            if (!r.ok) throw new Error(`status ${r.status}`);
            s = (await r.json()) as UpdatesStatusResponse;
        } catch (err) {
            if (restarting || started !== epoch) return;
            // An apply whose answer was lost, and now the server does not answer
            // either: it has gone down for the update.
            if (lost) {
                void startRestart();
                return;
            }
            // The apply's own answer decides; "update check failed" would be wrong.
            if (applyInFlight) return;
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
            return;
        }
        // A read that was in flight when "restarting…" went up, or when the apply
        // it was started for ended, describes a moment that has passed.
        if (restarting || started !== epoch) return;
        if (lost) {
            followLostApply(s);
            return;
        }
        renderFromStatus(s);
    }

    /** The apply's outcome is known: back to reading the status as usual. */
    function endApply(): void {
        applyInFlight = false;
        lost = null;
        epoch++;
    }

    /**
     * The server is going down for the update: say so and reload, or on Linux
     * (`mode: 'reconnect'`) hand over to the upgrading overlay. Used by an apply
     * that answered 200, and by one whose answer was lost once the server
     * stops answering.
     */
    async function startRestart(mode?: string): Promise<void> {
        if (restarting) return;
        restarting = true;
        lost = null;
        // A status read failing against the stopped server would paint
        // "update check failed" over "restarting…".
        clearTimer();
        if (mode === 'reconnect') {
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
    }

    /**
     * The apply's answer was lost: a proxy gave up on the long Windows request
     * (502/503/504) or the browser dropped it, while the install may well be
     * carrying on. Keep reading the status instead of reporting a failure.
     */
    function startFollowingLostApply(reason: string): void {
        epoch++;
        lost = { watch: new LostApplyWatch(), reason };
        renderInstalling();
        if (currentPollMs !== FAST_POLL_MS) scheduleTimer(FAST_POLL_MS);
        void poll();
    }

    function followLostApply(s: UpdatesStatusResponse): void {
        const { watch, reason } = lost!;
        lastStatus = s;
        const view = watch.read(s);
        switch (view.kind) {
            case 'downloading':
                renderDownloading(view.progress);
                return;
            case 'installing':
                renderInstalling();
                return;
            case 'gave-up':
                endApply();
                renderReady(s.availableVersion, installFailedNote(reason));
                if (currentPollMs !== SLOW_POLL_MS) scheduleTimer(SLOW_POLL_MS);
                return;
            default:
                // 'failed' (the status carries the reason, and renders it) or 'ended'.
                endApply();
                renderFromStatus(s);
        }
    }

    async function onApplyClick(btn: HTMLButtonElement): Promise<void> {
        if (applyInFlight || restarting) return;
        applyInFlight = true;
        epoch++;
        btn.disabled = true;
        btn.textContent = 'applying…';
        // On Windows the request stays open while the server downloads the
        // update: read the status now and every 2 s, so the progress shows.
        scheduleTimer(FAST_POLL_MS);
        void poll();
        let r: Response;
        try {
            r = await fetch('/api/updates/apply', { method: 'POST' });
        } catch {
            startFollowingLostApply("couldn't reach server");
            return;
        }
        if (r.ok) {
            const body = (await r.json().catch(() => ({}))) as { mode?: string };
            await startRestart(body.mode);
            return;
        }
        const failure = await classifyFailedApply(r);
        if (failure.kind === 'lost') {
            startFollowingLostApply(`no answer from the server (${r.status})`);
            return;
        }
        endApply();
        if (currentPollMs !== SLOW_POLL_MS) scheduleTimer(SLOW_POLL_MS);
        if (failure.kind === 'declined') {
            // A cancelled polkit prompt on a machine-wide update (smoke
            // 14.10): nothing changed, the update is still ready. Say so
            // beside the same button; the next poll repaints the chip.
            renderReady(lastStatus?.availableVersion, reasonToUserMessage('uac-declined', ''));
            return;
        }
        if (failure.reason !== undefined) {
            renderReady(lastStatus?.availableVersion, installFailedNote(failure.reason));
        }
        // A 500 leaves the update on offer with its reason in the status
        // (lastApplyError), and reading it now could catch the check a failed
        // download starts, putting a spinner where the reason was. Anything else
        // (a 409: the state moved on; 503 dev mode) is read again at once.
        if (r.status !== 500 || failure.reason === undefined) void poll();
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

    // This page lost its admin access (Settings saved remote admin off from this
    // device): stop before the next tick lands on the refusal.
    onAdminAccessLost(() => {
        if (!applyInFlight && !restarting) stopForGood();
    });

    // Initial poll + start the slow timer. Hidden until first poll resolves.
    scheduleTimer(SLOW_POLL_MS);
    void poll();

    return container;
}
