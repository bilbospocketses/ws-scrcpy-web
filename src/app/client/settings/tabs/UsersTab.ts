import type { AppConfigEnvelope } from '../../../../common/ConfigEvents';
import { REMOTE_ADMIN_FORCED_MESSAGE, REMOTE_ADMIN_ID } from '../../../../common/remoteAdmin';
import { authClient } from '../../AuthClient';
import { adminApiReachable } from '../../adminGate';
import { RemoteAdminWarningModal } from '../../RemoteAdminWarningModal';
import { UsersModal } from '../../UsersModal';
import type { StagedSettingsStore } from '../StagedSettingsStore';
import {
    buildAdminUnreachableNote,
    buildItem,
    buildRow,
    buildSection,
    buildTabAlert,
    setRowShown,
} from '../settingsLayout';
import type { TabContext } from './EmbeddingTab';

/** The staged field's summary label: `Remote admin without sign-in: off → on`. */
export const REMOTE_ADMIN_LABEL = 'Remote admin without sign-in';

/** Under the checkbox while it is checked (warning tone): the notice that used to be the home page's banner. */
export const REMOTE_ADMIN_ON_NOTE =
    'any device that can reach this server can administer it. set up sign-in, or uncheck this, to close it.';

/**
 * The bold title over the note while the exposure is live (saved on, or forced
 * by the environment): the home page banner's own title, which this item replaced.
 */
export const REMOTE_ADMIN_ON_TITLE = 'remote admin is enabled without sign-in.';

/** The same title while the box is checked but not yet saved. */
export const REMOTE_ADMIN_STAGED_TITLE = 'remote admin will be enabled without sign-in when you save.';

/** Under the checkbox while it is unchecked. */
export const REMOTE_ADMIN_OFF_NOTE = 'admin actions are limited to this machine unless sign-in is set up.';

/** Under the checkbox while sign-in is on, which makes the setting moot until it is turned off again. */
export const REMOTE_ADMIN_SIGN_IN_NOTE = 'ignored while sign-in is on; it applies again if sign-in is turned off.';

/**
 * Under the checkbox, and on the review screen, when the device turning it off
 * is an admin only BECAUSE of it: once saved, this device is refused.
 */
export const REMOTE_ADMIN_OFF_BOX_WARNING = 'you are on another device: saving this ends your admin access from here.';

/** Ids for the remote-admin row's label, unique across every dialog opened on the page. */
let remoteAdminDomSeq = 0;

/**
 * Per-instance appliers, keyed by the section `buildUsersTab` returned (the
 * same WeakMap shape as the other tabs' appliers): the remote-admin item needs
 * the /api/config envelope, which the dialog reads after every tab is built.
 */
const configAppliers = new WeakMap<HTMLElement, (env: AppConfigEnvelope) => void>();

/**
 * Hand a Users tab the /api/config envelope the dialog read, so its
 * remote-admin item can show the stored value, whether the environment forces
 * it, and whether sign-in is on, and so the tab can hold back every admin
 * control when the admin API will not answer this page (`adminApiReachable`).
 * A no-op if `section` was never built through `buildUsersTab`.
 */
export function applyUsersConfig(section: HTMLElement, env: AppConfigEnvelope): void {
    configAppliers.get(section)?.(env);
}

/**
 * The Users tab (admin-only) — manage-users entry point, the auth on/off
 * toggle, and (0.5.5) remote admin without sign-in.
 *
 * Opening the manage-users modal and flipping auth are actions (a modal launch
 * and an immediate POST) and register nothing with `store`. Remote admin is a
 * STAGED setting (`allowRemoteAdmin`): the checkbox only stages it, the review
 * screen lists it, and the dialog's Save applies it (SettingsBatchApi). It
 * moved here from the home page's banner, which could only turn it on and
 * then showed a warning nobody could dismiss.
 *
 * Where the admin API will not answer this page (another machine, sign-in off,
 * remote admin off), every control here is disabled, with one note saying why
 * at the top of the card: each of them would only be refused (0.5.5).
 */
export function buildUsersTab(ctx: TabContext, store: StagedSettingsStore): HTMLElement {
    const { section, card } = buildSection('Users');
    // The tab's one status line. Built now, but it lands below the card all
    // the same: the card is already in the section and stays its last card.
    const tabAlert = buildTabAlert(section);

    // Shown, first in the card, only when the admin API will not answer this
    // page (applyUsersConfig).
    const unreachableNote = buildAdminUnreachableNote();
    card.appendChild(buildItem(unreachableNote));

    // 1. Manage users button — opens UsersModal (admin-only action).
    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'modal-button';
    manageBtn.textContent = 'manage users';
    manageBtn.addEventListener('click', () => {
        // A child of Settings: it closes if Settings does.
        ctx.openChild(() => new UsersModal());
    });
    card.appendChild(buildItem(buildRow('user accounts', manageBtn)));

    // 2. Auth toggle — disable login (authEnabled=true) or enable login
    //    (authEnabled=false). ctx.reload() on success (SettingsModal wires this
    //    to window.location.reload(), matching every other action control in
    //    Settings that needs a reload — buildResetControl, buildInstallAllUsersControl).
    //    A failure is reported on the tab's line, below the card (`tabAlert`).
    let loginBtn: HTMLButtonElement;
    if (ctx.authEnabled) {
        const disableBtn = document.createElement('button');
        disableBtn.type = 'button';
        disableBtn.className = 'modal-button';
        disableBtn.textContent = 'disable login (return to open mode)';
        disableBtn.addEventListener('click', () => {
            disableBtn.disabled = true;
            void (async () => {
                try {
                    await authClient.disableAuth();
                    ctx.reload();
                } catch {
                    tabAlert.show('error', 'failed to disable login — see server logs.');
                    disableBtn.disabled = false;
                }
            })();
        });
        card.appendChild(buildItem(buildRow('login', disableBtn)));
        loginBtn = disableBtn;
    } else {
        const enableBtn = document.createElement('button');
        enableBtn.type = 'button';
        enableBtn.className = 'modal-button';
        enableBtn.textContent = 'enable login';
        enableBtn.addEventListener('click', () => {
            enableBtn.disabled = true;
            void (async () => {
                try {
                    const res = await authClient.enableAuth();
                    if (res.ok) {
                        ctx.reload();
                        return;
                    }
                    tabAlert.show(
                        'error',
                        res.status === 409
                            ? 'Add a user with an admin password first (Users → manage users)'
                            : `failed to enable login (${res.status})`,
                    );
                    enableBtn.disabled = false;
                } catch {
                    tabAlert.show('error', 'failed to enable login — could not reach server.');
                    enableBtn.disabled = false;
                }
            })();
        });
        card.appendChild(buildItem(buildRow('login', enableBtn)));
        loginBtn = enableBtn;
    }

    // 3. Remote admin without sign-in — STAGED. Hidden until the dialog hands
    //    over the /api/config envelope (applyUsersConfig): until then nothing
    //    says what is stored, whether the environment forces it, or who is
    //    asking.
    const remote = buildRemoteAdminItem(ctx, store);
    card.appendChild(remote.item);

    configAppliers.set(section, (env) => {
        remote.apply(env);
        // The remote-admin box is held back by `remote.apply` on the same rule.
        if (adminApiReachable(env.runtime)) return;
        manageBtn.disabled = true;
        loginBtn.disabled = true;
        unreachableNote.hidden = false;
    });
    return section;
}

/**
 * The remote-admin item: a checkbox named by its row's label, and one note
 * under it that says what the current state means.
 *
 * The note, in order of precedence:
 * - forced on by the environment: the checkbox is checked and disabled, since
 *   no save can turn it off (the server refuses the attempt);
 * - sign-in is on: the setting is ignored, but a stored `on` comes back into
 *   force if sign-in is turned off, so the row stays editable to clear it;
 * - this device is an admin only because of the setting and has staged it
 *   off: saving ends its admin access (the review screen says so too);
 * - checked: the warning the home page used to show; unchecked: what holds.
 *
 * Checking it when it is stored off raises `RemoteAdminWarningModal` first,
 * and stages only on its explicit accept. "Set up sign-in instead" opens the
 * manage-users dialog over Settings, where the first admin with a password is
 * created; any other way out of the warning just leaves the box unchecked.
 * Unchecking needs no confirmation.
 */
function buildRemoteAdminItem(
    ctx: TabContext,
    store: StagedSettingsStore,
): { item: HTMLElement; apply: (env: AppConfigEnvelope) => void } {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('data-remote-admin', '');

    const row = buildRow('remote admin without sign-in', checkbox);
    const label = row.querySelector<HTMLElement>('.settings-label');
    if (label) {
        remoteAdminDomSeq += 1;
        label.id = `settings-remote-admin-${remoteAdminDomSeq}`;
        checkbox.setAttribute('aria-labelledby', label.id);
    }

    const note = document.createElement('p');
    note.className = 'settings-status';
    note.style.gridColumn = '1 / -1';
    note.setAttribute('data-remote-admin-note', '');
    remoteAdminDomSeq += 1;
    note.id = `settings-remote-admin-${remoteAdminDomSeq}`;
    checkbox.setAttribute('aria-describedby', note.id);

    // While the exposure is (or is about to be) live, the item takes the look of
    // the home page banner it replaced (`.settings-item--alert`, modal.css): a
    // bold warning-colored title over the note, in a bordered box.
    const title = document.createElement('strong');
    title.className = 'settings-alert-title';
    title.style.gridColumn = '1 / -1';
    title.setAttribute('data-remote-admin-title', '');
    title.hidden = true;

    const item = buildItem(row, title, note);
    item.hidden = true;
    setRowShown(row, false);
    note.hidden = true;

    let forced = false;
    let signInOn = false;
    // An admin only because of this setting: off this machine, sign-in off,
    // and the setting in force.
    let adminBecauseOfIt = false;
    let known = false;

    const stored = (): boolean => {
        const change = store.changes().find((c) => c.id === REMOTE_ADMIN_ID);
        const current = store.get(REMOTE_ADMIN_ID);
        return change ? change.from === true : current === true;
    };

    function render(): void {
        if (!known) return;
        const value = forced || store.get(REMOTE_ADMIN_ID) === true;
        checkbox.checked = value;
        let text: string;
        let warn: boolean;
        if (forced) {
            text = REMOTE_ADMIN_FORCED_MESSAGE;
            warn = true;
        } else if (signInOn) {
            text = REMOTE_ADMIN_SIGN_IN_NOTE;
            warn = false;
        } else if (!value && stored() && adminBecauseOfIt) {
            text = REMOTE_ADMIN_OFF_BOX_WARNING;
            warn = true;
        } else if (value) {
            text = REMOTE_ADMIN_ON_NOTE;
            warn = true;
        } else {
            text = REMOTE_ADMIN_OFF_NOTE;
            warn = false;
        }
        // The banner look: forced on, or checked with sign-in off. The title says
        // whether it is already in force or only staged.
        const alert = forced || (!signInOn && value);
        title.textContent = alert ? (forced || stored() ? REMOTE_ADMIN_ON_TITLE : REMOTE_ADMIN_STAGED_TITLE) : '';
        title.hidden = !alert;
        item.classList.toggle('settings-item--alert', alert);
        note.textContent = text;
        // In the box the title carries the warning tone and the note reads as its body.
        note.classList.toggle('settings-status-warning', warn && !alert);
    }

    function register(initial: boolean): void {
        store.register({
            id: REMOTE_ADMIN_ID,
            label: REMOTE_ADMIN_LABEL,
            initial,
            format: (v) => (v === true ? 'on' : 'off'),
            warning: (to) => (to === false && adminBecauseOfIt ? REMOTE_ADMIN_OFF_BOX_WARNING : null),
        });
    }

    checkbox.addEventListener('change', () => {
        if (!checkbox.checked) {
            store.set(REMOTE_ADMIN_ID, false);
            return;
        }
        // Back to a stored `on`: an undo, not a decision to open the server up.
        if (stored()) {
            store.set(REMOTE_ADMIN_ID, true);
            return;
        }
        // Unchecked until the warning is accepted, so a dismissal leaves it as it was.
        checkbox.checked = false;
        void (async () => {
            const choice = await ctx.askChild(() => RemoteAdminWarningModal.choose(), 'dismiss');
            if (choice === 'accept') {
                store.set(REMOTE_ADMIN_ID, true);
            } else if (choice === 'sign-in') {
                ctx.openChild(() => new UsersModal());
            }
        })();
    });

    store.subscribe(render);

    function apply(env: AppConfigEnvelope): void {
        const runtime = env.runtime;
        forced = runtime.remoteAdminForced === true;
        signInOn = runtime.adminScope === 'authenticated';
        adminBecauseOfIt = runtime.adminScope === 'remote' && runtime.callerIsLocal === false;
        known = true;
        // Re-registered from the stored value, like the other tabs' baselines:
        // nothing staged yet, since the item has been hidden until now.
        register(env.config.allowRemoteAdmin === true);
        // Disabled when forced (nothing can turn it off), and when the admin
        // API will not answer this caller at all (off this machine with the
        // setting off): Save would only be refused.
        checkbox.disabled = forced || !adminApiReachable(runtime);
        item.hidden = false;
        setRowShown(row, true);
        note.hidden = false;
        render();
    }

    return { item, apply };
}
