import { authClient } from '../../AuthClient';
import { UsersModal } from '../../UsersModal';
import type { StagedSettingsStore } from '../StagedSettingsStore';
import { buildItem, buildRow, buildSection, buildTabAlert } from '../settingsLayout';
import type { TabContext } from './EmbeddingTab';

/**
 * The Users tab (admin-only) — manage-users entry point plus the auth on/off
 * toggle.
 *
 * Registers nothing with `store`: opening the manage-users modal and
 * flipping auth are both actions (a modal launch and an immediate POST,
 * respectively), not values to stage and save later.
 */
export function buildUsersTab(ctx: TabContext, _store: StagedSettingsStore): HTMLElement {
    const { section, card } = buildSection('Users');
    // The tab's one status line. Built now, but it lands below the card all
    // the same: the card is already in the section and stays its last card.
    const tabAlert = buildTabAlert(section);

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
    }

    return section;
}
