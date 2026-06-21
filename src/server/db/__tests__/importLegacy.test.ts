import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMigrations } from '../migrations';
import { AppSettingsStore } from '../AppSettingsStore';
import { importLegacyIfNeeded } from '../import/importLegacy';

const dirs: string[] = [];
function tmpdir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsimp-'));
    dirs.push(d);
    return d;
}
afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('importLegacyIfNeeded', () => {
    it('imports once, trims config.json to the boot trio (+ server-only fields), and is idempotent', () => {
        const dir = tmpdir();
        const configPath = path.join(dir, 'config.json');
        const labelsPath = path.join(dir, 'device-labels.json');
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                webPort: 8123,
                installMode: 'user',
                firstRunComplete: true,
                channel: 'beta',
                bookmarkDismissedGlobally: true,
                // Server-only boot fields (NOT AppConfig) that MUST survive the trim.
                allowedHosts: ['proxy.example.com'],
                server: [{ secure: true, port: 443 }],
            }),
        );
        fs.writeFileSync(labelsPath, JSON.stringify({ S1: 'TV' }));

        const db = new DatabaseSync(':memory:');
        runMigrations(db);
        importLegacyIfNeeded(db, { configPath, deviceLabelsPath: labelsPath });

        // config.json trimmed to the trio PLUS the preserved server-only fields —
        // channel/bookmark (moved to stores) are gone; allowedHosts/server stay.
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({
            installMode: 'user',
            webPort: 8123,
            firstRunComplete: true,
            allowedHosts: ['proxy.example.com'],
            server: [{ secure: true, port: 443 }],
        });
        expect(new AppSettingsStore(db).get('channel')).toBe('beta');
        expect(new AppSettingsStore(db).get('legacyImported')).toBe(true);

        // Second call: marker present → no-op (mutate config.json to prove it is not re-trimmed/re-read).
        fs.writeFileSync(configPath, JSON.stringify({ webPort: 9999, installMode: 'user', firstRunComplete: true }));
        importLegacyIfNeeded(db, { configPath, deviceLabelsPath: labelsPath });
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).webPort).toBe(9999);
    });

    it('handles missing legacy files (fresh install) by marking imported', () => {
        const dir = tmpdir();
        const db = new DatabaseSync(':memory:');
        runMigrations(db);
        importLegacyIfNeeded(db, {
            configPath: path.join(dir, 'config.json'),
            deviceLabelsPath: path.join(dir, 'device-labels.json'),
        });
        expect(new AppSettingsStore(db).get('legacyImported')).toBe(true);
    });
});
