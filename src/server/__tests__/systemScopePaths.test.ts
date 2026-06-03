import { describe, it, expect } from 'vitest';
import { buildServiceUnitEnv, buildSystemSeedConfig } from '../service/SystemdClient';

/**
 * Bug #36: the system-scope service ran node/adb from the installing user's
 * home (DEPS_PATH=cfg.dependenciesPath, unconditionally) and landed its config
 * in /tmp (no DATA_ROOT -> Rust /tmp fallback). The unit env must instead point
 * at the app's OWN /opt tree (Local-Dependencies-Only) and set DATA_ROOT so the
 * root service (no HOME) doesn't fall back to ephemeral /tmp.
 */
describe('buildServiceUnitEnv (#36 system-scope /opt paths)', () => {
    const userDeps = '/home/jamie/.local/share/WsScrcpyWeb/dependencies';

    it('linux + system: DATA_ROOT + DEPS_PATH under /opt, NOT the user home', () => {
        expect(buildServiceUnitEnv('linux', 'system', userDeps)).toEqual({
            DATA_ROOT: '/opt/ws-scrcpy-web/data',
            DEPS_PATH: '/opt/ws-scrcpy-web/dependencies',
        });
    });

    it('linux + user: the caller deps path, no DATA_ROOT override', () => {
        expect(buildServiceUnitEnv('linux', 'user', userDeps)).toEqual({ DEPS_PATH: userDeps });
    });

    it('win32 + system: user deps, no /opt (Windows path is unaffected)', () => {
        const winDeps = 'C:\\ProgramData\\WsScrcpyWeb\\dependencies';
        expect(buildServiceUnitEnv('win32', 'system', winDeps)).toEqual({ DEPS_PATH: winDeps });
    });
});

describe('buildSystemSeedConfig (#36 seed)', () => {
    it('seeds system-service mode, first-run-complete, and the caller web port', () => {
        // installMode + firstRunComplete => the service reads a correct config
        // (ServiceFirstRunModal, not WelcomeModal); webPort = the user's current
        // port => the post-install browser hand-off lands on the same URL.
        expect(buildSystemSeedConfig(8002)).toEqual({
            installMode: 'system-service',
            firstRunComplete: true,
            webPort: 8002,
        });
    });
});
