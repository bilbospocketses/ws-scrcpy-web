import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import { AppSettingsStore } from '../AppSettingsStore';
import { type BootTrio, importConfigJson } from './importConfigJson';
import { importDeviceLabels } from './importDeviceLabels';

const MARKER = 'legacyImported';

// Server-only boot fields that are NOT part of AppConfig and are read straight
// from config.json at boot (Config.buildServers + sanitizeAllowedHosts). They
// must survive the trim verbatim — dropping `server` breaks SSL setups and
// dropping `allowedHosts` (PR #421) breaks reverse-proxy / domain deploys.
const PRESERVED_BOOT_KEYS = ['server', 'allowedHosts'] as const;

function readJson(p: string): Record<string, unknown> | null {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function writeTrimmedConfig(p: string, trio: BootTrio, legacy: Record<string, unknown>): void {
    const out: Record<string, unknown> = { installMode: trio.installMode, firstRunComplete: trio.firstRunComplete };
    if (trio.webPort !== undefined) out['webPort'] = trio.webPort;
    for (const k of PRESERVED_BOOT_KEYS) {
        if (legacy[k] !== undefined) out[k] = legacy[k];
    }
    fs.writeFileSync(p, `${JSON.stringify(out, null, 2)}\n`, 'utf-8');
}

export function importLegacyIfNeeded(db: DatabaseSync, paths: { configPath: string; deviceLabelsPath: string }): void {
    const app = new AppSettingsStore(db);
    if (app.get(MARKER) === true) return;

    db.exec('BEGIN');
    try {
        const legacyConfig = readJson(paths.configPath);
        if (legacyConfig) {
            const trio = importConfigJson(db, legacyConfig);
            writeTrimmedConfig(paths.configPath, trio, legacyConfig);
        }
        const labels = readJson(paths.deviceLabelsPath);
        if (labels) importDeviceLabels(db, labels as Record<string, string>);
        app.set(MARKER, true);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
