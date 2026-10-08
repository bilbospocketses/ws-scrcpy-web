export const IMPLICIT_ADMIN_ID = 1;
export const DB_FILENAME = 'wsscrcpy.db';
export const AUTH_ENABLED_KEY = 'authEnabled';

/**
 * Global (non-per-user) app-setting keys persisted in `app_settings`. Config
 * reads these into the effective AppConfig and routes matching `/api/config`
 * PATCH keys to `appSettings` (vs. the boot trio, which stays in config.json).
 */
export const GLOBAL_KEYS = [
    'autoUpdate',
    'updateCheckIntervalMinutes',
    'channel',
    'githubOwner',
    'adbPath',
    'dependenciesPath',
    'scanConcurrency',
    'scanTcpTimeoutMs',
    'scanAdbConnectTimeoutMs',
    'scanProgressInterval',
] as const;

/**
 * The `app_settings` row recording that the stored `channel` row was written
 * by THIS code's channel write, so it pins the channel against the build's
 * default. Set to `true` by every channel write, all of which go through
 * `Config.updateAppConfig`, in the same savepoint as the `channel` row:
 *
 * - the Updates tab's Save (POST /api/settings/batch);
 * - PATCH /api/config;
 * - PATCH /api/updates/config;
 * - `UpdateService.keepChannelAcrossApply`, which writes it without anyone
 *   touching the radio, to carry the running channel across an update.
 *
 * It does not say a person chose the channel, only that it was written on
 * purpose rather than left behind. Without it a stored `stable` cannot be told
 * apart from one an earlier install left in a kept data folder, so an unpinned
 * `stable` is ignored and the channel follows the build (Config.ts
 * `resolveChannel`).
 *
 * Deliberately NOT in GLOBAL_KEYS and not an AppConfig field: nothing a client
 * sends can name it. `updateAppConfig` refuses it as an unknown key,
 * `SettingsBatchApi` as a non-stageable id, and PATCH /api/updates/config drops
 * it; the server writes it only as a side effect of a channel write.
 */
export const CHANNEL_PINNED_KEY = 'channelPinned';
