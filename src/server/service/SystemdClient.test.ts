import { describe, it, expect } from 'vitest';
import { SystemdClient, renderUnitFile, STAGED_SYSTEM_DIR, buildSystemInstallScript, systemctlArgv } from './SystemdClient';

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

describe('buildSystemInstallScript', () => {
    const args = {
        sourceAppImage: '/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage',
        unitTmpPath: '/tmp/WsScrcpyWeb.service.tmp',
        unitPath: '/etc/systemd/system/WsScrcpyWeb.service',
        name: 'WsScrcpyWeb',
    };

    it('stages the AppImage to /opt, chmods, labels bin_t, then installs the unit', () => {
        const script = buildSystemInstallScript(args);
        expect(script).toContain('mkdir -p /opt/ws-scrcpy-web');
        expect(script).toContain('cp "/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage" "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
        expect(script).toContain('chmod 0755 "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
        expect(script).toContain("semanage fcontext -a -t bin_t '/opt/ws-scrcpy-web(/.*)?'");
        expect(script).toContain('restorecon -Rv "/opt/ws-scrcpy-web"');
        expect(script).toContain('chcon -t bin_t "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
        expect(script).toContain('cp "/tmp/WsScrcpyWeb.service.tmp" "/etc/systemd/system/WsScrcpyWeb.service"');
        expect(script).toContain('systemctl daemon-reload');
        expect(script).toContain('systemctl enable --now WsScrcpyWeb.service');
    });

    it('staging precedes the unit copy (so ExecStart target exists before enable)', () => {
        const script = buildSystemInstallScript(args);
        expect(script.indexOf('/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage'))
            .toBeLessThan(script.indexOf('enable --now'));
    });

    it('uses absolute tool paths (no bare names)', () => {
        const script = buildSystemInstallScript(args, (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`);
        expect(script).toContain('/usr/bin/systemctl daemon-reload');
        expect(script).toContain('/usr/sbin/restorecon -Rv');
    });

    it('label step is best-effort — a failed SELinux label does not abort the unit install', () => {
        const script = buildSystemInstallScript(args);
        // wrapped in a subshell + `|| true` so a non-SELinux host (semanage absent, chcon errors)
        // still proceeds to cp unit + enable.
        expect(script).toContain('|| true');
        expect(script.indexOf('cp "/tmp/WsScrcpyWeb.service.tmp"')).toBeGreaterThan(script.indexOf('chcon'));
    });
});

describe('absolute-path OS tools', () => {
    it('systemctlArgv resolves systemctl to an absolute path', () => {
        const argv = systemctlArgv(['--user', 'daemon-reload'], (t) => `/usr/bin/${t}`);
        expect(argv.bin).toBe('/usr/bin/systemctl');
        expect(argv.args).toEqual(['--user', 'daemon-reload']);
    });
});

describe('renderUnitFile', () => {
    const baseOpts = {
        name: 'WsScrcpyWeb',
        displayName: 'ws-scrcpy-web',
        description: 'desc',
        binPath: '/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage',
        startupDir: '/home/u/Apps',
        startType: 'Automatic' as const,
        maxRestartAttempts: 3,
        envVars: { DEPS_PATH: '/home/u/.local/share/WsScrcpyWeb/dependencies' },
        logPath: '/home/u/.local/share/WsScrcpyWeb/logs/service.log',
    };

    it('places StartLimit keys in [Unit], not [Service] (systemd ignores them in [Service])', () => {
        const unit = renderUnitFile(baseOpts, 'system');
        const unitSection = unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'));
        const serviceSection = unit.slice(unit.indexOf('[Service]'), unit.indexOf('[Install]'));
        expect(unitSection).toContain('StartLimitIntervalSec=300');
        expect(unitSection).toContain('StartLimitBurst=3');
        expect(serviceSection).not.toContain('StartLimitIntervalSec');
        expect(serviceSection).not.toContain('StartLimitBurst');
    });
});
