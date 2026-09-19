import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../Config';
import { EnvName } from '../EnvName';

// Same temp harness as config.frameAncestorsMutation.test.ts: CONFIG_PATH +
// DEPS_PATH, with the DB co-located beside config.json so each test is
// isolated.
const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(initial: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-httpsport-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(initial));
    process.env[EnvName.CONFIG_PATH] = configPath;
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
    return configPath;
}

function readConfig(configPath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

afterEach(() => {
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const BOOT = { webPort: 8200, installMode: 'user', firstRunComplete: true };

describe('Config.setHttpsPort (task 11)', () => {
    it('persists the port without disturbing the other keys', () => {
        const configPath = setup({ ...BOOT, allowedHosts: ['devices.example.com'] });

        Config.getInstance().setHttpsPort(9443);

        const written = readConfig(configPath);
        expect(written['httpsPort']).toBe(9443);
        // The whole file is rewritten, so every unrelated key has to survive --
        // a user who loses webPort here finds the server on a different port
        // after the next restart (mirrors the frame-ancestor/allowedHost tests).
        expect(written['webPort']).toBe(8200);
        expect(written['installMode']).toBe('user');
        expect(written['firstRunComplete']).toBe(true);
        expect(written['allowedHosts']).toEqual(['devices.example.com']);
    });

    it('overwrites a previously-set httpsPort rather than appending or ignoring it', () => {
        const configPath = setup({ ...BOOT, httpsPort: 8443 });

        Config.getInstance().setHttpsPort(9000);

        expect(readConfig(configPath)['httpsPort']).toBe(9000);
    });

    it("does NOT move webPort -- the two ports stay independent (mirrors buildServerList's doc comment)", () => {
        const configPath = setup(BOOT);

        Config.getInstance().setHttpsPort(80);

        expect(readConfig(configPath)['webPort']).toBe(8200);
        expect(readConfig(configPath)['httpsPort']).toBe(80);
    });

    it('does not apply live -- there is no in-process rebind, unlike allowedHosts/frameAncestors', () => {
        const configPath = setup({ ...BOOT, httpsPort: 8443 });
        const cfg = Config.getInstance();
        const serversBefore = cfg.servers;

        cfg.setHttpsPort(9999);

        // The listener set is built once at boot (Config.buildServers). If a
        // live rebind were added here without also updating the caller to
        // schedule a restart, this reference-identity check would still pass
        // -- so pair it with the ON-DISK assertion, which DOES need to change.
        expect(cfg.servers).toBe(serversBefore);
        expect(readConfig(configPath)['httpsPort']).toBe(9999);
    });
});

// C1 (Critical, whole-branch review): /api/tls/state needs enough to tell
// "restart required" apart from "your config.json overrides this" apart from
// "httpsPort collides with the http port" -- these two getters are the Config
// half of that. Both are resolved once at boot, exactly like `servers`
// itself, and deliberately do NOT re-read config.json on every call.
describe('Config.httpsPort / usesAdvancedServerConfig getters (C1)', () => {
    it('reports the resolved target httpsPort on the ordinary (flat) config path', () => {
        setup({ ...BOOT, httpsPort: 9443 });
        expect(Config.getInstance().httpsPort).toBe(9443);
        expect(Config.getInstance().usesAdvancedServerConfig).toBe(false);
    });

    it('reports the default target port when httpsPort is unset', () => {
        setup(BOOT);
        expect(Config.getInstance().httpsPort).toBe(8443);
    });

    // Paired: an advanced `server` array in use must report BOTH the
    // boolean AND that `httpsPort` is STILL the real resolved value -- team-
    // lead's exact contract wants `httpsPort` unconditionally present (post-
    // sanitizeHttpsPort) for the panel's prefill, regardless of mode, even
    // though `Config.buildServers` never consults it in this mode. A version
    // that zeroed/undefined'd it here would silently break that prefill for
    // anyone on an advanced config.
    it('reports usesAdvancedServerConfig true, with httpsPort still resolved even though buildServers ignores it in this mode', () => {
        setup({
            ...BOOT,
            server: [{ secure: false, port: 8200 }],
            httpsPort: 9443,
        });
        const cfg = Config.getInstance();
        expect(cfg.usesAdvancedServerConfig).toBe(true);
        expect(cfg.httpsPort).toBe(9443);
    });

    it("is false for an EMPTY server array -- only a non-empty advanced array counts (mirrors Config.buildServers' own condition)", () => {
        setup({ ...BOOT, server: [], httpsPort: 9443 });
        const cfg = Config.getInstance();
        expect(cfg.usesAdvancedServerConfig).toBe(false);
        expect(cfg.httpsPort).toBe(9443);
    });
});
