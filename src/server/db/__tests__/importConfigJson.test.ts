import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../migrations';
import { AppSettingsStore } from '../AppSettingsStore';
import { UserSettingsStore } from '../UserSettingsStore';
import { importConfigJson } from '../import/importConfigJson';
import { IMPLICIT_ADMIN_ID } from '../constants';

let db: DatabaseSync;
beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
});

describe('importConfigJson', () => {
    it('routes globals to app_settings, prompt flags to user-1 settings, returns the boot trio', () => {
        const legacy = {
            installMode: 'user',
            webPort: 8123,
            firstRunComplete: true,
            autoUpdate: false,
            updateCheckIntervalMinutes: 30,
            channel: 'beta',
            githubOwner: 'x',
            adbPath: '/opt/adb',
            dependenciesPath: '/opt/deps',
            scanConcurrency: 32,
            scanTcpTimeoutMs: 200,
            scanAdbConnectTimeoutMs: 4000,
            scanProgressInterval: 5,
            bookmarkDismissedForPort: 8123,
            bookmarkDismissedGlobally: true,
            serviceFirstRunSeen: true,
        };
        const trio = importConfigJson(db, legacy);
        expect(trio).toEqual({ installMode: 'user', webPort: 8123, firstRunComplete: true });

        const app = new AppSettingsStore(db).getAll();
        expect(app).toMatchObject({
            autoUpdate: false,
            channel: 'beta',
            githubOwner: 'x',
            adbPath: '/opt/adb',
            dependenciesPath: '/opt/deps',
            scanConcurrency: 32,
        });
        // Boot trio must NOT be duplicated into app_settings.
        expect(app).not.toHaveProperty('webPort');
        expect(app).not.toHaveProperty('installMode');

        const prompts = new UserSettingsStore(db).getAll(IMPLICIT_ADMIN_ID);
        expect(prompts).toMatchObject({
            bookmarkDismissedForPort: 8123,
            bookmarkDismissedGlobally: true,
            serviceFirstRunSeen: true,
        });
    });

    it('omits absent fields (no undefined rows written)', () => {
        const trio = importConfigJson(db, { webPort: 9000 });
        expect(trio).toEqual({ installMode: null, webPort: 9000, firstRunComplete: false });
        expect(new AppSettingsStore(db).getAll()).toEqual({ authEnabled: false });
    });
});
