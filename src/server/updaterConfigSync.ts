import type { AppConfig } from '../common/ConfigEvents';
import type { UpdateService } from './UpdateService';

/**
 * The two calls that move a RUNNING update service onto new settings. A `Pick`
 * rather than the class, so a test can hand in two spies, and so importing this
 * module never pulls in the velopack addon behind `UpdateService`.
 */
export type UpdaterControls = Pick<UpdateService, 'reconfigure' | 'restartTimer'>;

/**
 * Tell the running update service about an updater-config write, by comparing
 * the config BEFORE the write with the config AFTER it.
 *
 * Writing config.json is not enough on its own: the service holds its channel,
 * owner and timer in memory from `init()`, so without this call a changed
 * interval or channel only takes effect when the app restarts. Shared by both
 * writers of those settings -- PATCH /api/updates/config (`UpdatesApi`) and the
 * Settings dialog's Save, POST /api/settings/batch (`SettingsBatchApi`) -- so
 * the two cannot drift apart again. Until smoke row 6.11 (qa-harness) only the
 * PATCH did this, and every Save left the service on the old values.
 *
 *   - channel or GitHub owner moved -> `reconfigure`, which switches the feed
 *     and checks at once.
 *   - otherwise, interval moved      -> `restartTimer` at the new interval.
 *   - `autoUpdate` needs no call: the service reads it from config at every
 *     check (`UpdateService.runCheck`), never caches it.
 *
 * When the channel/owner AND the interval move together, only `reconfigure`
 * runs, which is the precedence the PATCH has always had (UpdatesApi.test.ts
 * pins it). Comparing configs rather than a patch means a field re-stated at
 * its current value is not a change.
 */
export async function applyUpdaterConfigChange(
    svc: UpdaterControls,
    before: AppConfig,
    after: AppConfig,
): Promise<void> {
    const channelChanged = after.channel !== before.channel;
    const ownerChanged = after.githubOwner !== before.githubOwner;
    const intervalChanged = after.updateCheckIntervalMinutes !== before.updateCheckIntervalMinutes;

    if (channelChanged || ownerChanged) {
        await svc.reconfigure(after.channel, after.githubOwner);
    } else if (intervalChanged) {
        svc.restartTimer(after.updateCheckIntervalMinutes, after.autoUpdate);
    }
}
