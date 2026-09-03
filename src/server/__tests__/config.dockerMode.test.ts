import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../Config';
import { EnvName } from '../EnvName';

// Same CONFIG_PATH + DEPS_PATH temp harness as config.storeBacked.test.ts: the
// DB co-locates with config.json, so each test is isolated in its own temp dir.
const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DOCKER: process.env['WS_SCRCPY_DOCKER'],
};

function setup(initial: unknown, docker?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-docker-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(initial));
    process.env[EnvName.CONFIG_PATH] = configPath;
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    if (docker === undefined) delete process.env['WS_SCRCPY_DOCKER'];
    else process.env['WS_SCRCPY_DOCKER'] = docker;
    Config._resetForTest();
    return configPath;
}

afterEach(() => {
    Config._resetForTest();
    for (const [k, v] of [
        [EnvName.CONFIG_PATH, saved.CONFIG],
        ['DEPS_PATH', saved.DEPS],
        ['WS_SCRCPY_DOCKER', saved.DOCKER],
    ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('WS_SCRCPY_DOCKER runtime implication (SP4 E4)', () => {
    it('presents a container as already-configured: firstRunComplete + installMode user', () => {
        // A container has no Velopack hooks.rs::on_install to seed the trio, so
        // without this the WelcomeModal and the Linux SystemWideInstallModal
        // would open on every boot of a perfectly good image.
        setup({}, '1');
        const c = Config.getInstance();
        expect(c.getFirstRunStatus().firstRunComplete).toBe(true);
        expect(c.getAppConfig().installMode).toBe('user');
        expect(c.getFirstRunStatus().docker).toBe(true);
    });

    it('changes nothing when the flag is unset', () => {
        setup({});
        const c = Config.getInstance();
        expect(c.getFirstRunStatus().firstRunComplete).toBe(false);
        expect(c.getAppConfig().installMode).toBeNull();
        expect(c.getFirstRunStatus().docker ?? false).toBe(false);
    });

    it('NEVER persists the implication to config.json, even when a port shift forces a save', () => {
        // The trap. Config composes the effective config and then PERSISTS:
        // setActualWebPort() calls saveToDisk() on a shift, and saveToDisk writes
        // installMode + firstRunComplete straight out of _appConfig. If the Docker
        // implication were baked into that object, the container would write
        // firstRunComplete:true into /data/config.json on first boot and the flag
        // would stop being an env implication and become persisted state -- which
        // outlives WS_SCRCPY_DOCKER and would suppress the welcome modal on any
        // host that later mounted the same volume.
        const configPath = setup({ webPort: 8000 }, '1');
        const c = Config.getInstance();
        c.setActualWebPort(8123); // differs from webPort -> saveToDisk()

        const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        expect(onDisk['webPort']).toBe(8123); // the shift itself SHOULD persist
        expect(onDisk['firstRunComplete']).toBe(false); // the implication must NOT
        expect(onDisk['installMode']).toBeNull();

        // And the live view still reports the container as configured.
        expect(c.getFirstRunStatus().firstRunComplete).toBe(true);
        expect(c.getAppConfig().installMode).toBe('user');
    });

    it.each(['0', '', 'false', 'no'])('does not treat %o as enabling docker mode', (value) => {
        // Boolean(process.env.X) makes the STRING '0' true, so a compose file that
        // disables the flag by setting it to 0 would silently leave it enabled.
        // The comparison is against the literal '1'.
        setup({}, value);
        const c = Config.getInstance();
        expect(c.getFirstRunStatus().docker ?? false).toBe(false);
        expect(c.getFirstRunStatus().firstRunComplete).toBe(false);
        expect(c.getAppConfig().installMode).toBeNull();
    });

    it('lets an explicit installMode in config.json win over the implication', () => {
        // The implication is a DEFAULT, not an override: a user who wrote a value
        // meant it, and a container started against an existing volume must not
        // have its recorded install mode silently rewritten.
        setup({ installMode: 'system-service', firstRunComplete: false }, '1');
        const c = Config.getInstance();
        expect(c.getAppConfig().installMode).toBe('system-service');
        // Same rule for firstRunComplete: an EXPLICIT false in the file wins, so a
        // container started against a volume mid-first-run still finishes it.
        expect(c.getFirstRunStatus().firstRunComplete).toBe(false);
        // ...but it is still a container, and the UI gating keys off this.
        expect(c.getFirstRunStatus().docker).toBe(true);
    });
});
