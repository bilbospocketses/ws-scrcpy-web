import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeUninstallHandoffMarker } from '../control-marker';

describe('writeUninstallHandoffMarker', () => {
    it('writes a parseable JSON marker at <dataRoot>/control/uninstall-handoff.json', async () => {
        const dataRoot = mkdtempSync(join(tmpdir(), 'marker-test-'));
        const result = await writeUninstallHandoffMarker(dataRoot, {
            targetSessionId: 1,
            launcherPath: 'C:\\Program Files\\WsScrcpyWeb\\current\\ws-scrcpy-web-launcher.exe',
            launcherArgs: ['--local-takeover'],
        });
        expect(result.ok).toBe(true);
        const path = join(dataRoot, 'control', 'uninstall-handoff.json');
        expect(existsSync(path)).toBe(true);
        const body = JSON.parse(readFileSync(path, 'utf8'));
        expect(body.verb).toBe('uninstall-service');
        expect(body.targetSessionId).toBe(1);
        expect(body.launcherPath).toBe('C:\\Program Files\\WsScrcpyWeb\\current\\ws-scrcpy-web-launcher.exe');
        expect(body.launcherArgs).toEqual(['--local-takeover']);
        expect(body.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('overwrites an existing marker', async () => {
        const dataRoot = mkdtempSync(join(tmpdir(), 'marker-test-'));
        await writeUninstallHandoffMarker(dataRoot, {
            targetSessionId: 1,
            launcherPath: 'a.exe',
            launcherArgs: [],
        });
        await writeUninstallHandoffMarker(dataRoot, {
            targetSessionId: 2,
            launcherPath: 'a.exe',
            launcherArgs: [],
        });
        const path = join(dataRoot, 'control', 'uninstall-handoff.json');
        const body = JSON.parse(readFileSync(path, 'utf8'));
        expect(body.targetSessionId).toBe(2);
    });

    it('accepts null targetSessionId for "any session"', async () => {
        const dataRoot = mkdtempSync(join(tmpdir(), 'marker-test-'));
        const result = await writeUninstallHandoffMarker(dataRoot, {
            targetSessionId: null,
            launcherPath: 'a.exe',
            launcherArgs: [],
        });
        expect(result.ok).toBe(true);
        const path = join(dataRoot, 'control', 'uninstall-handoff.json');
        const body = JSON.parse(readFileSync(path, 'utf8'));
        expect(body.targetSessionId).toBeNull();
    });
});
