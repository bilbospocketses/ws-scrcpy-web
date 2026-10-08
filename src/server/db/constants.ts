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
 * The `app_settings` row recording that the stored `channel` was PICKED, not
 * inherited: `true` once the channel has been written through
 * `Config.updateAppConfig` (the Updates tab's Save, PATCH /api/config, PATCH
 * /api/updates/config) or by `UpdateService.keepChannelAcrossApply`.
 *
 * It lets Config tell a deliberate `stable` apart from one left behind by an
 * earlier install (see `defaultChannelForVersion`): an unmarked `stable` row is
 * ignored and the channel follows the build.
 *
 * Deliberately NOT in GLOBAL_KEYS and not an AppConfig field: nothing a client
 * sends can name it. `updateAppConfig` refuses it as an unknown key, and
 * `SettingsBatchApi` as a non-stageable id; the server writes it only as a side
 * effect of a channel write.
 */
export const CHANNEL_PICKED_KEY = 'channelPickedByUser';
