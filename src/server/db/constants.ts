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
