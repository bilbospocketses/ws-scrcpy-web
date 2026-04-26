import { describe, expect, it } from 'vitest';
import { SYSTEMD_NOT_IMPLEMENTED_MESSAGE, SystemdClient } from '../service/SystemdClient';

describe('SystemdClient (P3 stub)', () => {
    const client = new SystemdClient();
    const installOpts = {
        name: 'WsScrcpyWeb',
        displayName: 'ws-scrcpy-web',
        description: 'd',
        binPath: 'b',
        account: 'currentUser' as const,
        startType: 'Automatic' as const,
        maxRestartAttempts: 3,
        envVars: {},
        logPath: 'l',
    };

    it('install throws the not-implemented sentinel', async () => {
        await expect(client.install(installOpts)).rejects.toThrow(SYSTEMD_NOT_IMPLEMENTED_MESSAGE);
    });

    it('uninstall throws the not-implemented sentinel', async () => {
        await expect(client.uninstall('WsScrcpyWeb')).rejects.toThrow(SYSTEMD_NOT_IMPLEMENTED_MESSAGE);
    });

    it('status throws the not-implemented sentinel', async () => {
        await expect(client.status('WsScrcpyWeb')).rejects.toThrow(SYSTEMD_NOT_IMPLEMENTED_MESSAGE);
    });

    it('restart throws the not-implemented sentinel', async () => {
        await expect(client.restart('WsScrcpyWeb')).rejects.toThrow(SYSTEMD_NOT_IMPLEMENTED_MESSAGE);
    });

    it('stop throws the not-implemented sentinel', async () => {
        await expect(client.stop('WsScrcpyWeb')).rejects.toThrow(SYSTEMD_NOT_IMPLEMENTED_MESSAGE);
    });

    it('exposes the sentinel message verbatim', () => {
        expect(SYSTEMD_NOT_IMPLEMENTED_MESSAGE).toBe('Linux service mode lands later in SP3');
    });
});
