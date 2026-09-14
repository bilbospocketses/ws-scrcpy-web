import type { UpdateChannel } from '../../../../common/ConfigEvents';
import type { UpdatesStatusResponse } from '../../../../common/UpdateEvents';
import { runUpgradingHandoff } from '../../UpgradingOverlay';
import type { StagedSettingsStore } from '../StagedSettingsStore';
import type { TabContext } from './EmbeddingTab';

/** Local copy — see EmbeddingTab.ts's `buildSection` for why it isn't shared. */
function buildSection(title: string): { section: HTMLElement; body: HTMLElement } {
    const section = document.createElement('section');
    section.className = 'settings-section';
    const heading = document.createElement('h3');
    heading.className = 'settings-section-heading';
    heading.textContent = title;
    section.appendChild(heading);
    const body = document.createElement('div');
    body.className = 'settings-section-body';
    section.appendChild(body);
    return { section, body };
}

/** Local copy — see EmbeddingTab.ts's `buildRow` for why it isn't shared. */
function buildRow(labelText: string, control: HTMLElement | DocumentFragment): HTMLElement {
    const row = document.createElement('div');
    row.className = 'settings-row';

    const label = document.createElement('span');
    label.className = 'settings-label';
    label.textContent = labelText;
    row.appendChild(label);

    const controlWrap = document.createElement('div');
    controlWrap.className = 'settings-control';
    controlWrap.appendChild(control);
    row.appendChild(controlWrap);

    return row;
}

/**
 * A row whose LABEL is returned alongside it, so the caller can keep mutating
 * the text on the left while the control on the right stays put. This section
 * uses it twice: for the error + retry row, and for the action row whose label
 * IS the live update-status line.
 */
function buildDynamicLabelRow(
    labelText: string,
    control: HTMLElement | DocumentFragment,
): { row: HTMLElement; labelEl: HTMLSpanElement } {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'settings-label';
    labelEl.textContent = labelText;
    row.appendChild(labelEl);
    const controlWrap = document.createElement('div');
    controlWrap.className = 'settings-control';
    controlWrap.appendChild(control);
    row.appendChild(controlWrap);
    return { row, labelEl };
}

/** The staged-field ids, as `SettingsBatchApi.STAGEABLE_IDS` spells them. */
const CHANNEL_ID = 'channel';
const AUTO_UPDATE_ID = 'autoUpdate';
const INTERVAL_ID = 'updateCheckIntervalMinutes';

/** The interval bounds `Config.validateField('updateCheckIntervalMinutes')` enforces. */
const INTERVAL_MIN = 5;
const INTERVAL_MAX = 1440;

/** The three values this tab stages, as /api/updates/status reports them. */
interface UpdatesBaseline {
    channel: UpdateChannel | null;
    autoUpdate: boolean | null;
    updateCheckIntervalMinutes: number | null;
}

/**
 * Register — or RE-baseline — the three staged Updates fields.
 *
 * Called twice, deliberately: once at build time with `null` initials, and again
 * from the refresh with the values /api/updates/status reports. `register`
 * overwrites both the field record and the current value, which is what makes
 * the second call establish a new BASELINE rather than a change.
 *
 * It has to be a re-`register` and not a `set`. A `set` would leave `initial` at
 * the build-time `null`, so an untouched dialog would sit permanently dirty at
 * `null → …` on all three fields and every batch Save would carry three
 * update-config writes nobody asked for.
 *
 * Both call sites go through this one function so the ids, labels and the
 * on/off formatter cannot drift apart between them — the drift would be
 * invisible until the summary screen showed the wrong label, or the batch was
 * refused for an id the server does not allow.
 */
function registerUpdatesFields(store: StagedSettingsStore, initial: UpdatesBaseline): void {
    store.register({ id: CHANNEL_ID, label: 'Update channel', initial: initial.channel });
    store.register({
        id: AUTO_UPDATE_ID,
        label: 'Automatic updates',
        initial: initial.autoUpdate,
        format: (v) => (v ? 'on' : 'off'),
    });
    store.register({
        id: INTERVAL_ID,
        label: 'Check interval (minutes)',
        initial: initial.updateCheckIntervalMinutes,
    });
}

/**
 * Per-instance re-entry point, keyed by the section `buildUpdatesTab` returned.
 * Same shape — and the same reason — as ServerTab.ts's `refreshers`:
 * `SettingsModal` builds every tab eagerly, then decides LATER whether to fire
 * the /api/updates/status read at all (it is held until container mode is
 * known). This map is what lets it drive a specific tab's internals from
 * outside without `buildUpdatesTab` returning anything other than the
 * `HTMLElement` its signature promises.
 */
const refreshers = new WeakMap<HTMLElement, () => Promise<void>>();

/**
 * The Updates tab.
 *
 * `channel`, `autoUpdate` and `updateCheckIntervalMinutes` are STAGED: editing
 * one calls `store.set(...)` and nothing else, and the dialog's Save sends the
 * whole batch to POST /api/settings/batch. This is a behaviour change users can
 * see — before the tabs work, every toggle fired its own PATCH
 * /api/updates/config, so flipping auto-update and closing the dialog saved it.
 * Now closing without Save changes nothing.
 *
 * "check for updates now" / "apply update" stay ACTIONS: they fire immediately
 * on click and register nothing, so they cannot reach the change summary. So
 * does the github owner field — the batch endpoint's allowlist does not carry
 * `githubOwner`, so it is written the way it always was.
 *
 * Builds synchronously and fires no network request of its own. Everything
 * below the "loading…" placeholder is rendered by the externally-triggered
 * `refreshUpdates()`, because WHAT to render (the dev-mode note, an error and a
 * retry, or the full control set) is a function of the /api/updates/status
 * response.
 */
export function buildUpdatesTab(ctx: TabContext, store: StagedSettingsStore): HTMLElement {
    const { section, body } = buildSection('Updates');
    const placeholder = document.createElement('p');
    placeholder.className = 'settings-status';
    placeholder.style.gridColumn = '1 / -1';
    placeholder.textContent = 'loading…';
    body.appendChild(placeholder);

    // Registered with null baselines because the real values are not knowable
    // synchronously — every tab is built before the read that learns them.
    // `runRefresh` re-registers with the true values; see registerUpdatesFields.
    registerUpdatesFields(store, { channel: null, autoUpdate: null, updateCheckIntervalMinutes: null });

    // Replaces the instance fields `SettingsModal` held for this section
    // (`this.updatesStatusEl`, `this.updatesLastStatus`, …). Each stays null
    // until `renderSection` builds the controls, and every consumer guards on
    // that exactly as the old `if (this.x)` checks did. Only the refs something
    // still READS survive the move: the four control refs the old
    // `syncControlsToStatus` wrote through are gone with it.
    let statusEl: HTMLElement | null = null;
    let ownerInput: HTMLInputElement | null = null;
    let actionBtn: HTMLButtonElement | null = null;
    let intervalDebounce: number | undefined;
    let lastStatus: UpdatesStatusResponse | null = null;
    let applyInFlight = false;

    async function runRefresh(): Promise<void> {
        let resp: UpdatesStatusResponse;
        try {
            const r = await fetch('/api/updates/status');
            if (!r.ok) {
                renderError("couldn't reach server");
                return;
            }
            resp = (await r.json()) as UpdatesStatusResponse;
        } catch {
            renderError("couldn't reach server");
            return;
        }
        lastStatus = resp;
        // The first moment the true values are known, so this is where they
        // become the baseline. Ahead of the isInstalled branch below because the
        // dev-mode response still carries all three, and a baseline that is only
        // set on some paths is a baseline nobody can reason about.
        //
        // This also RESETS any staged edit, since `register` overwrites the
        // current value too. That is correct for every caller there is: the
        // modal's one-shot read runs before the user can touch anything, and the
        // retry button only exists on the error body, which has no controls to
        // have staged from.
        registerUpdatesFields(store, {
            channel: resp.channel,
            autoUpdate: resp.autoUpdate,
            updateCheckIntervalMinutes: resp.updateCheckIntervalMinutes,
        });
        renderSection(resp);
    }

    function renderError(msg: string): void {
        body.replaceChildren();
        statusEl = null;
        actionBtn = null;
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'settings-btn';
        retryBtn.textContent = 'retry';
        retryBtn.addEventListener('click', () => {
            void runRefresh();
        });
        const { row, labelEl } = buildDynamicLabelRow(msg, retryBtn);
        labelEl.classList.add('settings-status-error');
        body.appendChild(row);
    }

    function renderSection(s: UpdatesStatusResponse): void {
        body.replaceChildren();
        statusEl = null;
        ownerInput = null;
        actionBtn = null;

        if (!s.isInstalled) {
            const devNote = document.createElement('p');
            devNote.className = 'settings-stub-note';
            devNote.style.gridColumn = '1 / -1';
            const versionStr = s.currentVersion ? `current: v${s.currentVersion} — ` : '';
            devNote.textContent = `${versionStr}dev mode — packaging features disabled`;
            body.appendChild(devNote);
            return;
        }

        // Row 1: auto-download checkbox. STAGED.
        const auto = document.createElement('input');
        auto.type = 'checkbox';
        auto.checked = s.autoUpdate;
        auto.addEventListener('change', () => {
            store.set(AUTO_UPDATE_ID, auto.checked);
        });
        body.appendChild(buildRow('automatically download updates', auto));

        // Row 2: check interval. STAGED, behind the range guard below.
        const interval = document.createElement('input');
        interval.type = 'number';
        interval.min = String(INTERVAL_MIN);
        interval.max = String(INTERVAL_MAX);
        interval.step = '1';
        interval.className = 'settings-input';
        interval.style.maxWidth = '110px';
        interval.value = String(s.updateCheckIntervalMinutes);
        interval.addEventListener('input', () => {
            if (intervalDebounce !== undefined) {
                window.clearTimeout(intervalDebounce);
            }
            intervalDebounce = window.setTimeout(() => {
                commitIntervalChange(interval);
            }, 500);
        });
        interval.addEventListener('blur', () => {
            if (intervalDebounce !== undefined) {
                window.clearTimeout(intervalDebounce);
                intervalDebounce = undefined;
            }
            commitIntervalChange(interval);
        });
        body.appendChild(buildRow('check interval (minutes)', interval));

        // Row 3: channel radios. STAGED.
        const channelFrag = document.createDocumentFragment();
        const stableLabel = document.createElement('label');
        stableLabel.className = 'settings-radio-label';
        const stableRadio = document.createElement('input');
        stableRadio.type = 'radio';
        stableRadio.name = 'updates-channel';
        stableRadio.value = 'stable';
        stableRadio.checked = s.channel === 'stable';
        stableRadio.addEventListener('change', () => {
            if (stableRadio.checked) {
                store.set(CHANNEL_ID, 'stable');
            }
        });
        stableLabel.appendChild(stableRadio);
        stableLabel.appendChild(document.createTextNode('stable'));
        channelFrag.appendChild(stableLabel);

        const betaLabel = document.createElement('label');
        betaLabel.className = 'settings-radio-label';
        const betaRadio = document.createElement('input');
        betaRadio.type = 'radio';
        betaRadio.name = 'updates-channel';
        betaRadio.value = 'beta';
        betaRadio.checked = s.channel === 'beta';
        betaRadio.addEventListener('change', () => {
            if (betaRadio.checked) {
                store.set(CHANNEL_ID, 'beta');
            }
        });
        betaLabel.appendChild(betaRadio);
        betaLabel.appendChild(document.createTextNode('beta'));
        channelFrag.appendChild(betaLabel);

        body.appendChild(buildRow('update channel', channelFrag));

        // Row 4: github owner. NOT staged — see patchGithubOwner.
        const owner = document.createElement('input');
        owner.type = 'text';
        owner.className = 'settings-input';
        owner.value = s.githubOwner;
        owner.addEventListener('blur', () => {
            const next = owner.value.trim();
            if (next.length === 0) {
                owner.value = lastStatus?.githubOwner ?? '';
                return;
            }
            if (next === lastStatus?.githubOwner) return;
            void patchGithubOwner(next);
        });
        body.appendChild(buildRow('github owner', owner));
        ownerInput = owner;

        // Action row: label = live status text (idle: "up to date (vX)", ready:
        // "vX ready to apply", checking/downloading: progress, error: failure
        // reason — wraps in the left column as needed), control = dual-purpose
        // action button (left-aligned in the right column like every other
        // control). Same row pattern as the inputs above. The button is "check
        // for updates now" when there's nothing to apply and flips to "apply
        // update v{X}" when status === 'ready' (mirroring the home-page
        // UpdateButton chip). A single click handler branches on the current
        // status — we just retitle the button as state changes.
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'settings-btn settings-btn-primary';
        action.textContent = 'check for updates now';
        action.addEventListener('click', () => {
            if (lastStatus && lastStatus.status === 'ready') {
                void onApplyClick(action);
            } else {
                void onCheckNowClick();
            }
        });
        const { row: actionRow, labelEl: actionLabelEl } = buildDynamicLabelRow('', action);
        body.appendChild(actionRow);
        actionBtn = action;
        // The action row's label doubles as this section's status line, so
        // applyStatusText can mutate it.
        statusEl = actionLabelEl;

        applyStatusText(s);
        applyActionButtonState(s);
    }

    function applyStatusText(s: UpdatesStatusResponse): void {
        if (!statusEl) return;
        let text = '';
        let isError = false;
        let isReady = false;
        switch (s.status) {
            case 'idle':
                text = `up to date: v${s.currentVersion}`;
                break;
            case 'checking':
                text = 'checking for updates…';
                break;
            case 'downloading': {
                const pct = typeof s.progress === 'number' ? Math.round(s.progress) : 0;
                text = `downloading v${s.availableVersion ?? '?'} — ${pct}%`;
                break;
            }
            case 'ready':
                text = `update: v${s.availableVersion ?? '?'}`;
                isReady = true;
                break;
            case 'error':
                text = `check failed: ${s.errorMessage ?? 'unknown error'}`;
                isError = true;
                break;
            default:
                text = '';
        }
        statusEl.textContent = text;
        statusEl.classList.toggle('settings-status-error', isError);
        // Pair the description text color with the action button: green when an
        // update is ready (mirrors .settings-btn-ready), default muted
        // otherwise. Idle/up-to-date stays muted alongside the blue "check for
        // updates now" button.
        statusEl.classList.toggle('settings-status-ready', isReady);
    }

    /**
     * Drive the dual-purpose action button's label + visual state from the
     * latest status. The button physically stays mounted across polls; we just
     * retitle and reskin it. Click branches on current status, so swapping the
     * label here is enough to swap behavior.
     *
     *   - status='ready' → "apply update v{availableVersion}", green
     *     outline+text (.settings-btn-ready, mirrors home-page chip), enabled
     *   - status='checking' / 'downloading' → "check for updates now", blue
     *     (.settings-btn-primary), disabled
     *   - everything else → "check for updates now", blue, enabled
     */
    function applyActionButtonState(s: UpdatesStatusResponse): void {
        if (!actionBtn) return;
        const btn = actionBtn;
        const busy = s.status === 'checking' || s.status === 'downloading';
        btn.disabled = busy || applyInFlight;
        if (s.status === 'ready') {
            btn.textContent = s.availableVersion ? `apply v${s.availableVersion}` : 'apply update';
            btn.classList.remove('settings-btn-primary');
            btn.classList.add('settings-btn-ready');
        } else {
            btn.textContent = 'check for updates now';
            btn.classList.remove('settings-btn-ready');
            btn.classList.add('settings-btn-primary');
        }
    }

    function setStatusError(msg: string): void {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.classList.add('settings-status-error');
    }

    /**
     * Stage the interval, behind the range guard the old per-field PATCH used to
     * apply before sending. `Config.validateField('updateCheckIntervalMinutes')`
     * wants an integer in [5, 1440] and `updateAppConfig` rejects anything else
     * by THROWING, so an unguarded stage becomes a 400 at Save time — an error
     * about a value the user typed minutes earlier, in a dialog that gave no
     * hint at the time.
     *
     * `Number` + `isInteger`, NOT `parseInt`, so the test here is the same one
     * `validateField` applies. `parseInt` TRUNCATES: '90.5' would stage 90 while
     * the field still read 90.5, saving an interval the user never typed.
     * `Number` gives NaN for junk and 0 for an emptied field, and both fail below.
     *
     * A refused value snaps back to what is currently STAGED rather than to what
     * the server last reported: the field and the store have to agree, or the
     * dialog shows one interval and Save writes another.
     */
    function commitIntervalChange(input: HTMLInputElement): void {
        const n = Number(input.value.trim());
        if (!Number.isInteger(n) || n < INTERVAL_MIN || n > INTERVAL_MAX) {
            const staged = store.get(INTERVAL_ID);
            input.value = String(staged ?? lastStatus?.updateCheckIntervalMinutes ?? 60);
            setStatusError(`interval must be between ${INTERVAL_MIN} and ${INTERVAL_MAX} minutes`);
            return;
        }
        // No "same as the server's value, nothing to do" early return. That was
        // right for a PATCH and wrong for a stage: typing 90 then 60 back would
        // leave 90 staged while the field read 60, and Save would write a value
        // the user had already undone. Re-staging the baseline is how the change
        // CLEARS — `changes()` compares, it does not latch.
        store.set(INTERVAL_ID, n);
    }

    /**
     * The one Updates value still written immediately, because the staging path
     * cannot carry it: `SettingsBatchApi.STAGEABLE_IDS` is an allowlist of
     * `webPort`, `channel`, `autoUpdate` and `updateCheckIntervalMinutes`, and a
     * batch naming anything else is refused outright with a 400. Staging
     * `githubOwner` would therefore not be "staged" — it would be a Save that
     * fails for the whole batch.
     *
     * So this keeps the pre-tabs behaviour for this field exactly: blur writes,
     * the response re-syncs, an error shows on the status line.
     */
    async function patchGithubOwner(githubOwner: string): Promise<void> {
        if (statusEl) {
            statusEl.textContent = 'saving…';
            statusEl.classList.remove('settings-status-error');
        }
        try {
            const r = await fetch('/api/updates/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ githubOwner }),
            });
            if (!r.ok) {
                setStatusError(`save failed (${r.status})`);
                return;
            }
            // PATCH /api/updates/config returns a flat UpdatesStatusResponse
            // (see UpdatesApi.handleConfig).
            const s = (await r.json()) as UpdatesStatusResponse;
            lastStatus = s;
            syncOwnerToStatus(s);
            applyStatusText(s);
            applyActionButtonState(s);
        } catch {
            setStatusError("couldn't reach server");
        }
    }

    /**
     * Push the server's github owner back into its input without rebuilding.
     *
     * Only that field. The pre-tabs version of this also re-synced the auto-update
     * checkbox, the interval and the channel radios, which is exactly wrong once
     * those are staged: a "check now" response would silently revert a control
     * the user had just edited while the edit stayed in the store, leaving the
     * dialog showing one value and Save writing another. Staged controls belong
     * to the user until Save; only `runRefresh` re-baselines them.
     */
    function syncOwnerToStatus(s: UpdatesStatusResponse): void {
        if (ownerInput && document.activeElement !== ownerInput && ownerInput.value !== s.githubOwner) {
            ownerInput.value = s.githubOwner;
        }
    }

    /**
     * Apply a downloaded update from inside the Settings modal — mirrors the
     * home-page UpdateButton chip's apply path. POST /api/updates/apply returns
     * 200 then the server exits ~100ms later (after Velopack's pre-apply hygiene
     * + waitExitThenApplyUpdate); we show a "restarting…" message and reload the
     * page after a grace window so the user lands on the new version once
     * Velopack's swap + relaunch completes.
     */
    async function onApplyClick(btn: HTMLButtonElement): Promise<void> {
        if (applyInFlight) return;
        applyInFlight = true;
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'applying…';
        if (statusEl) {
            statusEl.textContent = 'applying update…';
            statusEl.classList.remove('settings-status-error');
        }
        try {
            const r = await fetch('/api/updates/apply', { method: 'POST' });
            if (!r.ok) {
                setStatusError(`apply failed (${r.status})`);
                btn.disabled = false;
                btn.textContent = prevText;
                applyInFlight = false;
                // Re-poll to learn the current state (probably 409 because state
                // wasn't 'ready' anymore by the time we got here). This rebuilds
                // the body and re-baselines, so any staged edit is dropped — the
                // same rebuild the pre-tabs code did, and the alternative (a
                // stale body describing a state that has moved on) is worse.
                void runRefresh();
                return;
            }
            const applyBody = (await r.json().catch(() => ({}))) as { mode?: string };
            if (applyBody.mode === 'reconnect') {
                // Linux: server relaunching the AppImage. Show the upgrading
                // overlay and poll the same origin until the new version answers.
                await runUpgradingHandoff(lastStatus?.currentVersion ?? '');
                return;
            }
            // Success: server is exiting within ~100ms. Show "restarting…" and
            // attempt a page reload after a 5s grace period. The reload will
            // fail until Velopack finishes the swap and relaunches the server;
            // that's expected — leave the message visible.
            if (statusEl) {
                statusEl.textContent = 'server restarting to apply update — page will reload…';
            }
            btn.textContent = 'restarting…';
            window.setTimeout(() => {
                try {
                    ctx.reload();
                } catch {
                    /* server still down — user will reload manually */
                }
            }, 5_000);
        } catch {
            setStatusError("couldn't reach server");
            btn.disabled = false;
            btn.textContent = prevText;
            applyInFlight = false;
            void runRefresh();
        }
    }

    async function onCheckNowClick(): Promise<void> {
        if (!actionBtn) return;
        const btn = actionBtn;
        btn.disabled = true;
        btn.textContent = 'checking…';
        if (statusEl) {
            statusEl.textContent = 'checking for updates…';
            statusEl.classList.remove('settings-status-error');
        }
        // §25b using-declaration replaces the prior try/finally. The dispose
        // ONLY re-enables the button (when appropriate) — it deliberately does
        // NOT restore textContent. The success path runs applyActionButtonState
        // which sets the correct final label ("apply v{X}" when ready, "check
        // for updates now" otherwise), and the failure paths set their own
        // labels below. Prior code captured `prev` before the fetch and restored
        // it in dispose, which clobbered the correct "apply v{X}" label that
        // applyActionButtonState had just set — visible as a button with
        // green-ready styling but stale "check for updates now" text (caught by
        // v0.1.25-beta.15 smoke 2026-05-20).
        using _restoreBtn = {
            [Symbol.dispose]: (): void => {
                if (lastStatus && lastStatus.status !== 'checking' && lastStatus.status !== 'downloading') {
                    btn.disabled = false;
                }
            },
        };
        try {
            const r = await fetch('/api/updates/check', { method: 'POST' });
            if (!r.ok) {
                setStatusError(`check failed (${r.status})`);
                btn.textContent = 'check for updates now';
                return;
            }
            const s = (await r.json()) as UpdatesStatusResponse;
            lastStatus = s;
            syncOwnerToStatus(s);
            applyStatusText(s);
            applyActionButtonState(s);
        } catch {
            setStatusError("couldn't reach server");
            btn.textContent = 'check for updates now';
        }
    }

    refreshers.set(section, runRefresh);
    return section;
}

/**
 * Externally trigger the /api/updates/status read for an Updates tab
 * `buildUpdatesTab` already built — it renders the section's body and baselines
 * the three staged fields. A no-op if `section` was never built through
 * `buildUpdatesTab`.
 */
export async function refreshUpdates(section: HTMLElement): Promise<void> {
    const run = refreshers.get(section);
    if (!run) return;
    await run();
}
