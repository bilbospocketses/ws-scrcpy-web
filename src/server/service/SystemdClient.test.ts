import { describe, it, expect } from 'vitest';
import { SystemdClient, renderUnitFile, STAGED_SYSTEM_DIR } from './SystemdClient';

describe('system-scope staging', () => {
    const baseOpts = {
        name: 'WsScrcpyWeb',
        displayName: 'ws-scrcpy-web',
        description: 'desc',
        binPath: '/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage', // source = home AppImage
        startupDir: '/home/u/Apps',
        startType: 'Automatic' as const,
        maxRestartAttempts: 3,
        envVars: { DEPS_PATH: '/home/u/.local/share/WsScrcpyWeb/dependencies' },
        logPath: '/home/u/.local/share/WsScrcpyWeb/logs/service.log',
    };

    it('stagedSystemBinPath is the fixed /opt path', () => {
        const c = new SystemdClient();
        expect(c.stagedSystemBinPath()).toBe(`${STAGED_SYSTEM_DIR}/WsScrcpyWeb.AppImage`);
    });

    it('system unit ExecStart points at the staged /opt path, not the home AppImage', () => {
        const unit = renderUnitFile(baseOpts, 'system');
        expect(unit).toContain(`ExecStart=${STAGED_SYSTEM_DIR}/WsScrcpyWeb.AppImage`);
        expect(unit).not.toContain('/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage');
    });

    it('user unit ExecStart still points at the home AppImage (unchanged)', () => {
        const unit = renderUnitFile(baseOpts, 'user');
        expect(unit).toContain('ExecStart=/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage');
    });
});
