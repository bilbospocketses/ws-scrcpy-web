import type { UpdateChannel } from '../../../../common/ConfigEvents';
import type { UpdatesStatusResponse } from '../../../../common/UpdateEvents';
import { type AdminRefusal, adminRefusal } from '../../adminGate';
import { reasonToUserMessage } from '../../serviceFailureMessage';
import { runUpgradingHandoff } from '../../UpgradingOverlay';
import { classifyFailedApply, LostApplyWatch } from '../../updateApplyOutcome';
import type { StagedSettingsStore } from '../StagedSettingsStore';
import {
    buildDynamicLabelRow,
    buildItem,
    buildRefusedNote,
    buildRow,
    buildSection,
    buildTabAlert,
} from '../settingsLayout';
import type { TabContext } from './EmbeddingTab';

/** The staged-field ids, as `SettingsBatchApi.STAGEABLE_IDS` spells them. */
const CHANNEL_ID = 'channel';
const AUTO_UPDATE_ID = 'autoUpdate';
const INTERVAL_ID = 'updateCheckIntervalMinutes';
const OWNER_ID = 'githubOwner';

/** The interval bounds `Config.validateField('updateCheckIntervalMinutes')` enforces. */
const INTERVAL_MIN = 5;
const INTERVAL_MAX = 1440;

/**
 * How often the status is read while an apply started here runs (its Windows
 * download can take minutes), and after a failed one until the check the
 * server starts has finished.
 */
const APPLY_POLL_MS = 2 * 1000;
/** How long "restarting…" shows before the page is reloaded. */
const APPLY_RELOAD_DELAY_MS = 5 * 1000;

/** An apply started from this tab, from the click until its outcome is known. */
interface ApplyRun {
    btn: HTMLButtonElement;
    prevText: string | null;
    timer: number | undefined;
    /** Set once the apply's answer was lost (see LostApplyWatch); `reason` is what to say if it never happened. */
    lost: { watch: LostApplyWatch; reason: string } | null;
}

/** The four values this tab stages, as /api/updates/status reports them. */
interface UpdatesBaseline {
    channel: UpdateChannel | null;
    autoUpdate: boolean | null;
    updateCheckIntervalMinutes: number | null;
    githubOwner: string | null;
}

/**
 * Register — or RE-baseline — the four staged Updates fields.
 *
 * Called twice, deliberately: once at build time with `null` initials, and again
 * from the refresh with the values /api/updates/status reports. `register`
 * overwrites both the field record and the current value, which is what makes
 * the second call establish a new BASELINE rather than a change.
 *
 * It has to be a re-`register` and not a `set`. A `set` would leave `initial` at
 * the build-time `null`, so an untouched dialog would sit permanently dirty at
 * `null → …` on all four fields and every batch Save would carry four
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
    store.register({ id: OWNER_ID, label: 'GitHub owner', initial: initial.githubOwner });
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
 * `channel`, `autoUpdate`, `updateCheckIntervalMinutes` and `githubOwner` are
 * STAGED: editing one calls `store.set(...)` and nothing else, and the dialog's
 * Save sends the whole batch to POST /api/settings/batch. This is a behaviour
 * change users can see — before the tabs work, every toggle fired its own PATCH
 * /api/updates/config, so flipping auto-update and closing the dialog saved it.
 * Now closing without Save changes nothing.
 *
 * "check for updates now" / "apply update" stay ACTIONS: they fire immediately
 * on click and register nothing, so they cannot reach the change summary.
 * Their results (a check or an apply that failed) go to the tab's status line
 * below the card (0.5.5), while the action row's label keeps showing the
 * update STATE ("up to date: v…", "downloading v… — n%"). A value the interval
 * or owner field refuses is said under that field.
 *
 * Builds synchronously and fires no network request of its own. Everything
 * below the "loading…" placeholder is rendered by the externally-triggered
 * `refreshUpdates()`, because WHAT to render (the dev-mode note, an error and a
 * retry, or the full control set) is a function of the /api/updates/status
 * response.
 */
export function buildUpdatesTab(ctx: TabContext, store: StagedSettingsStore): HTMLElement {
    // `body` is the tab's card: everything below renders into it, one item per setting.
    const { section, card: body } = buildSection('Updates');
    // The tab's one status line. Built now, but below the card all the same:
    // `body` is the section's only card, and only its contents are redrawn.
    const tabAlert = buildTabAlert(section);
    const placeholder = document.createElement('p');
    placeholder.className = 'settings-status';
    placeholder.style.gridColumn = '1 / -1';
    placeholder.textContent = 'loading…';
    body.appendChild(buildItem(placeholder));

    // Registered with null baselines because the real values are not knowable
    // synchronously — every tab is built before the read that learns them.
    // `runRefresh` re-registers with the true values; see registerUpdatesFields.
    registerUpdatesFields(store, {
        channel: null,
        autoUpdate: null,
        updateCheckIntervalMinutes: null,
        githubOwner: null,
    });

    // Replaces the instance fields `SettingsModal` held for this section
    // (`this.updatesStatusEl`, `this.updatesLastStatus`, …). Each stays null
    // until `renderSection` builds the controls, and every consumer guards on
    // that exactly as the old `if (this.x)` checks did. Only the refs something
    // still READS survive the move: the four control refs the old
    // `syncControlsToStatus` wrote through are gone with it.
    let statusEl: HTMLElement | null = null;
    let actionBtn: HTMLButtonElement | null = null;
    let intervalDebounce: number | undefined;
    let lastStatus: UpdatesStatusResponse | null = null;
    /** The apply in flight, if any; null once its outcome is known. */
    let run: ApplyRun | null = null;
    /** Set once "restarting…" (or the upgrading overlay) is up; every later status read is dropped. */
    let restarting = false;
    /** The status read that follows a failed apply until its check has finished. */
    let settleTimer: number | undefined;

    async function runRefresh(): Promise<void> {
        let resp: UpdatesStatusResponse;
        try {
            const r = await fetch('/api/updates/status');
            if (!r.ok) {
                const refusal = await adminRefusal(r);
                if (refusal) renderRefused(refusal);
                else renderError("couldn't reach server");
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
        // dev-mode response still carries all four, and a baseline that is only
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
            githubOwner: resp.githubOwner,
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
        body.appendChild(buildItem(row));
    }

    /**
     * The server refused the read: say why, with no retry, which could only be
     * refused again (0.5.6). An operator refusal tells the dialog, which holds
     * back every admin control the same way and replaces this tab's body.
     */
    function renderRefused(refusal: AdminRefusal): void {
        body.replaceChildren();
        statusEl = null;
        actionBtn = null;
        body.appendChild(buildItem(buildRefusedNote(refusal)));
        if (refusal === 'operator') ctx.onAdminRefused?.();
    }

    function renderSection(s: UpdatesStatusResponse): void {
        body.replaceChildren();
        statusEl = null;
        actionBtn = null;

        if (!s.isInstalled) {
            const devNote = document.createElement('p');
            devNote.className = 'settings-stub-note';
            devNote.style.gridColumn = '1 / -1';
            const versionStr = s.currentVersion ? `current: v${s.currentVersion} — ` : '';
            devNote.textContent = `${versionStr}dev mode — packaging features disabled`;
            body.appendChild(buildItem(devNote));
            return;
        }

        // Row 1: auto-download checkbox. STAGED.
        const auto = document.createElement('input');
        auto.type = 'checkbox';
        auto.checked = s.autoUpdate;
        auto.addEventListener('change', () => {
            store.set(AUTO_UPDATE_ID, auto.checked);
        });
        body.appendChild(buildItem(buildRow('automatically download updates', auto)));

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
                commitIntervalChange(interval, intervalNote);
            }, 500);
        });
        interval.addEventListener('blur', () => {
            if (intervalDebounce !== undefined) {
                window.clearTimeout(intervalDebounce);
                intervalDebounce = undefined;
            }
            commitIntervalChange(interval, intervalNote);
        });
        const intervalNote = buildFieldNote();
        intervalNote.setAttribute('data-updates-interval-note', '');
        body.appendChild(buildItem(buildRow('check interval (minutes)', interval), intervalNote));

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

        body.appendChild(buildItem(buildRow('update channel', channelFrag)));

        // Row 4: github owner. STAGED, behind the non-empty guard below.
        const owner = document.createElement('input');
        owner.type = 'text';
        owner.className = 'settings-input';
        owner.value = s.githubOwner;
        owner.addEventListener('blur', () => {
            commitOwnerChange(owner, ownerNote);
        });
        const ownerNote = buildFieldNote();
        ownerNote.setAttribute('data-updates-owner-note', '');
        body.appendChild(buildItem(buildRow('github owner', owner), ownerNote));

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
        body.appendChild(buildItem(actionRow));
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
                if (s.lastApplyError !== undefined) {
                    // The last install of this update failed; the button retries it.
                    text = `apply failed: ${s.lastApplyError}`;
                    isError = true;
                } else {
                    text = `update: v${s.availableVersion ?? '?'}`;
                    isReady = true;
                }
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
        btn.disabled = busy || run !== null || restarting;
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

    /** The line under a staged field, empty and hidden until the field refuses a value. */
    function buildFieldNote(): HTMLElement {
        const note = document.createElement('p');
        note.className = 'settings-status settings-status-error';
        note.style.gridColumn = '1 / -1';
        note.hidden = true;
        return note;
    }

    function setFieldNote(note: HTMLElement, msg: string): void {
        note.textContent = msg;
        note.hidden = msg.length === 0;
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
     * A refused value is LEFT ON SCREEN with the message under it, and nothing
     * is staged — the same refusal shape `ServerTab`'s web-port guard has always
     * had. This used to snap the field back to the staged value instead, so the
     * dialog had two staged number fields disagreeing about what an invalid
     * entry does: one kept the typing, the other silently erased it. Leaving it
     * is also the kinder half of the pair, because the user can see and correct
     * the digit they got wrong rather than having to retype the whole value.
     */
    function commitIntervalChange(input: HTMLInputElement, note: HTMLElement): void {
        const n = Number(input.value.trim());
        if (!Number.isInteger(n) || n < INTERVAL_MIN || n > INTERVAL_MAX) {
            // Refuse the stage: whatever was last staged stands, and the message
            // stays up until a valid interval replaces it.
            setFieldNote(note, `interval must be between ${INTERVAL_MIN} and ${INTERVAL_MAX} minutes`);
            return;
        }
        // Clear the refusal before staging, the way ServerTab's guard clears its
        // message on the success path. Without this the message is STICKY: type
        // 3 (red "interval must be between…"), then type 90 — the 90 stages fine
        // but the field still says it is out of range.
        setFieldNote(note, '');
        // No "same as the server's value, nothing to do" early return. That was
        // right for a PATCH and wrong for a stage: typing 90 then 60 back would
        // leave 90 staged while the field read 60, and Save would write a value
        // the user had already undone. Re-staging the baseline is how the change
        // CLEARS — `changes()` compares, it does not latch.
        store.set(INTERVAL_ID, n);
    }

    /**
     * Stage the github owner, behind the non-empty guard the old per-field PATCH
     * used to apply before sending.
     *
     * This field wrote immediately on blur until `githubOwner` joined
     * `SettingsBatchApi.STAGEABLE_IDS`; now it stages like its three siblings and
     * the dialog's Save is what writes it. The guard travels with it, because
     * `Config.validateField('githubOwner')` wants a NON-EMPTY string and
     * `updateAppConfig` rejects anything else by THROWING — so an unguarded stage
     * becomes a 400 at Save time, about a field the user blanked minutes earlier
     * in a dialog that said nothing at the time.
     *
     * `trim()` before the emptiness test AND before staging, so a field holding
     * only spaces is refused rather than saved as whitespace the server would
     * happily accept (its check is `length === 0`, not "blank").
     *
     * A refused value is left on screen with the message beside it and nothing is
     * staged — the same refusal shape as the interval guard above and
     * `ServerTab`'s web-port guard. All three staged text/number fields in this
     * dialog now answer bad input identically.
     */
    function commitOwnerChange(input: HTMLInputElement, note: HTMLElement): void {
        const next = input.value.trim();
        if (next.length === 0) {
            setFieldNote(note, 'github owner cannot be empty');
            return;
        }
        // Clear the refusal message before staging, for the reason spelled out
        // in `commitIntervalChange`: without it the red warning outlives the
        // value it was about.
        setFieldNote(note, '');
        // No "same as the server's value, nothing to do" early return, for the
        // same reason as the interval: re-staging the baseline is how a change
        // CLEARS, since `changes()` compares rather than latches.
        store.set(OWNER_ID, next);
    }

    /**
     * Apply an update from inside the Settings modal — mirrors the home-page
     * UpdateButton chip's apply path. POST /api/updates/apply returns 200 then
     * the server exits ~100ms later; we show a "restarting…" message and reload
     * the page after a grace window so the user lands on the new version once
     * Velopack's swap + relaunch completes.
     *
     * On Windows the request stays open while the server downloads the update
     * first, so the status is read every 2 s meanwhile and the line shows the
     * download. An answer lost on the way (a proxy's 502/503/504, or none at
     * all) is not a failure: the install may be carrying on, so the status is
     * followed until it says how it ended, or stops answering because the
     * server has gone down for the update (see LostApplyWatch).
     */
    async function onApplyClick(btn: HTMLButtonElement): Promise<void> {
        if (run !== null || restarting) return;
        stopSettling();
        const me: ApplyRun = { btn, prevText: btn.textContent, timer: undefined, lost: null };
        run = me;
        btn.disabled = true;
        btn.textContent = 'applying…';
        showApplyLine('installing update…');
        void readApplyStatus(me);
        me.timer = window.setInterval(() => {
            void readApplyStatus(me);
        }, APPLY_POLL_MS);

        let r: Response;
        try {
            r = await fetch('/api/updates/apply', { method: 'POST' });
        } catch {
            followLostApply(me, "couldn't reach server");
            return;
        }
        if (r.ok) {
            const applyBody = (await r.json().catch(() => ({}))) as { mode?: string };
            await startRestart(applyBody.mode);
            return;
        }
        const failure = await classifyFailedApply(r);
        if (failure.kind === 'lost') {
            followLostApply(me, `apply failed (${r.status})`);
            return;
        }
        if (failure.kind === 'declined') {
            endApply(me);
            // A cancelled polkit prompt on a machine-wide update (smoke
            // 14.10). Nothing changed and the update is still ready, so
            // there is no state to re-read: the label goes back to the
            // state it showed, and the decline is said on the tab's line.
            if (lastStatus) applyStatusText(lastStatus);
            tabAlert.show('error', reasonToUserMessage('uac-declined', ''));
            return;
        }
        failApply(me, failure.reason !== undefined ? `apply failed: ${failure.reason}` : `apply failed (${r.status})`);
    }

    function showApplyLine(text: string): void {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.remove('settings-status-error', 'settings-status-ready');
    }

    function downloadingLine(progress: number | undefined): string {
        const pct = typeof progress === 'number' ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
        return `downloading update… ${pct}%`;
    }

    /** One status read for the apply in flight. */
    async function readApplyStatus(me: ApplyRun): Promise<void> {
        let s: UpdatesStatusResponse;
        try {
            const r = await fetch('/api/updates/status');
            if (!r.ok) throw new Error(`status ${r.status}`);
            s = (await r.json()) as UpdatesStatusResponse;
        } catch {
            if (run !== me || restarting) return;
            // The apply's answer was lost and now the server does not answer
            // either: it has gone down for the update. While the request is
            // still open, its own answer decides.
            if (me.lost) void startRestart();
            return;
        }
        if (run !== me || restarting) return;
        lastStatus = s;
        if (!me.lost) {
            showApplyLine(s.status === 'downloading' ? downloadingLine(s.progress) : 'installing update…');
            return;
        }
        const view = me.lost.watch.read(s);
        switch (view.kind) {
            case 'downloading':
                showApplyLine(downloadingLine(view.progress));
                return;
            case 'installing':
                showApplyLine('installing update…');
                return;
            case 'failed':
                failApply(me, `apply failed: ${view.reason}`);
                return;
            default:
                // 'gave-up' or 'ended': it did not happen.
                failApply(me, lostApplyEndLine(s, me.lost.reason));
        }
    }

    /**
     * Why a lost apply ended, from the status it ended on: the failed install
     * the server recorded, else the error the status ended in (the check a
     * failed download starts can itself fail). Only a status that says neither
     * leaves the apply's own answer ("apply failed (504)").
     */
    function lostApplyEndLine(s: UpdatesStatusResponse, fallback: string): string {
        if (s.lastApplyError) return `apply failed: ${s.lastApplyError}`;
        if (s.status === 'error' && s.errorMessage) return `apply failed: ${s.errorMessage}`;
        return fallback;
    }

    function followLostApply(me: ApplyRun, reason: string): void {
        if (run !== me) return;
        me.lost = { watch: new LostApplyWatch(), reason };
        void readApplyStatus(me);
    }

    function endApply(me: ApplyRun): void {
        if (me.timer !== undefined) window.clearInterval(me.timer);
        me.timer = undefined;
        if (run === me) run = null;
        me.btn.disabled = false;
        me.btn.textContent = me.prevText;
    }

    /**
     * The apply failed: say why on the tab's line, and re-read the state. The
     * refresh rebuilds the body and re-baselines, so any staged edit is
     * dropped — the same rebuild the pre-tabs code did, and the alternative (a
     * stale body describing a state that has moved on) is worse. The line is
     * outside the card, so the rebuild leaves it up; and while the check a
     * failed download starts is running, the status is followed until it
     * ends, or the button would stay disabled.
     */
    function failApply(me: ApplyRun, line: string): void {
        endApply(me);
        tabAlert.show('error', line);
        void runRefresh().then(() => settleAfterFailure());
    }

    function stopSettling(): void {
        if (settleTimer !== undefined) window.clearTimeout(settleTimer);
        settleTimer = undefined;
    }

    function settleAfterFailure(): void {
        stopSettling();
        if (!lastStatus || (lastStatus.status !== 'checking' && lastStatus.status !== 'downloading')) return;
        settleTimer = window.setTimeout(() => {
            settleTimer = undefined;
            void (async () => {
                let s: UpdatesStatusResponse;
                try {
                    const r = await fetch('/api/updates/status');
                    if (!r.ok) return;
                    s = (await r.json()) as UpdatesStatusResponse;
                } catch {
                    return;
                }
                if (run !== null || restarting) return;
                lastStatus = s;
                applyActionButtonState(s);
                applyStatusText(s);
                settleAfterFailure();
            })();
        }, APPLY_POLL_MS);
    }

    /**
     * The server is going down for the update: say so and reload, or on Linux
     * (`mode: 'reconnect'`) hand over to the upgrading overlay. Used by an apply
     * that answered 200, and by one whose answer was lost once the server stops
     * answering.
     */
    async function startRestart(mode?: string): Promise<void> {
        if (restarting) return;
        restarting = true;
        const me = run;
        if (me?.timer !== undefined) window.clearInterval(me.timer);
        if (me) me.timer = undefined;
        if (mode === 'reconnect') {
            // Linux: server relaunching the AppImage. Show the upgrading
            // overlay and poll the same origin until the new version answers.
            await runUpgradingHandoff(lastStatus?.currentVersion ?? '');
            return;
        }
        // The server is exiting within ~100ms. Show "restarting…" and attempt
        // a page reload after a 5s grace period. The reload will fail until
        // Velopack finishes the swap and relaunches the server; that's
        // expected — leave the message visible.
        showApplyLine('server restarting to apply update — page will reload…');
        if (me) me.btn.textContent = 'restarting…';
        window.setTimeout(() => {
            try {
                ctx.reload();
            } catch {
                /* server still down — user will reload manually */
            }
        }, APPLY_RELOAD_DELAY_MS);
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
        tabAlert.clear();
        try {
            const r = await fetch('/api/updates/check', { method: 'POST' });
            if (!r.ok) {
                // The label goes back to the state it showed; the failure is
                // the click's result, so it goes on the tab's line.
                if (lastStatus) applyStatusText(lastStatus);
                tabAlert.show('error', `check failed (${r.status})`);
                btn.textContent = 'check for updates now';
                return;
            }
            const s = (await r.json()) as UpdatesStatusResponse;
            lastStatus = s;
            // Status text and button state only. The response also carries the
            // server's copy of all four staged values, and pushing ANY of them
            // back into its control would silently revert an edit the user had
            // just made while it stayed in the store — the dialog would show one
            // value and Save would write another. This used to re-sync the github
            // owner, which was correct while that field wrote immediately and
            // became this bug the moment it started staging. Staged controls
            // belong to the user until Save; only `runRefresh` re-baselines them.
            applyStatusText(s);
            applyActionButtonState(s);
        } catch {
            if (lastStatus) applyStatusText(lastStatus);
            tabAlert.show('error', "couldn't reach server");
            btn.textContent = 'check for updates now';
        }
    }

    refreshers.set(section, runRefresh);
    return section;
}

/**
 * Externally trigger the /api/updates/status read for an Updates tab
 * `buildUpdatesTab` already built — it renders the section's body and baselines
 * the four staged fields. A no-op if `section` was never built through
 * `buildUpdatesTab`.
 */
export async function refreshUpdates(section: HTMLElement): Promise<void> {
    const run = refreshers.get(section);
    if (!run) return;
    await run();
}
