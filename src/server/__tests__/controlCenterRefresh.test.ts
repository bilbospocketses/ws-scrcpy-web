import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { ControlCenter } from '../goog-device/services/ControlCenter';

// ──────────────────────────────────────────────────────────────────────────
// `refreshNow` is the out-of-band device poll a successful pairing triggers, so
// the new row does not wait out the 5 s cadence. It is the first test to reach
// ControlCenter directly: the class had no test file, which is why a mutation
// removing its `initialized` guard survived unnoticed.
//
// ControlCenter reads `Config.getInstance().adbPath` while its fields
// initialise, so a temp config has to exist before one is constructed. No adb
// is ever run -- `pollDevices` is replaced on the instance.

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wscc-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
}

/** White-box: `initialized` and `pollDevices` are both private, and both are the subject. */
interface Innards {
    initialized: boolean;
    pollDevices: () => Promise<void>;
}

function innards(cc: ControlCenter): Innards {
    return cc as unknown as Innards;
}

afterEach(() => {
    // The temp dirs are deliberately NOT removed, matching the pairing-API
    // harness: Config opens a SQLite DB inside each one and still holds the
    // handle here, so Windows refuses the delete with EPERM and the cleanup
    // fails a test whose assertions had already passed. They are small, they
    // live under the OS temp dir, and the OS reclaims them.
    tmpDirs.length = 0;
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    Config._resetForTest();
});

describe('ControlCenter.refreshNow', () => {
    it('polls once when the tracker is running', async () => {
        setup();
        const cc = ControlCenter.getInstance();
        const poll = vi.fn().mockResolvedValue(undefined);
        innards(cc).pollDevices = poll;
        innards(cc).initialized = true;

        await cc.refreshNow();
        expect(poll).toHaveBeenCalledTimes(1);
    });

    it('does nothing before init, rather than polling a tracker that never started', async () => {
        // `init` is what enumerates devices and arms the interval. Polling ahead
        // of it would run adb on behalf of a tracker that does not exist yet,
        // and in a process that deliberately never started one it would be the
        // only adb call anybody made.
        setup();
        const cc = ControlCenter.getInstance();
        const poll = vi.fn().mockResolvedValue(undefined);
        innards(cc).pollDevices = poll;
        innards(cc).initialized = false;

        await cc.refreshNow();
        expect(poll).not.toHaveBeenCalled();
    });
});
