import { describe, it, expect } from 'vitest';
import { SystemdClient, renderUnitFile, STAGED_SYSTEM_DIR, buildSystemInstallScript, systemctlArgv, buildServiceUnitEnv } from './SystemdClient';

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

    it('stages the launcher helper into /opt alongside the AppImage (bin_t via the fcontext rule)', () => {
        const script = buildSystemInstallScript({
            sourceAppImage: '/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage',
            sourceHelper: '/home/u/.local/share/WsScrcpyWeb/control/operation-server/ws-scrcpy-web-launcher.exe',
            unitTmpPath: '/tmp/WsScrcpyWeb.service.tmp',
            unitPath: '/etc/systemd/system/WsScrcpyWeb.service',
            name: 'WsScrcpyWeb',
        });
        expect(script).toContain('cp "/home/u/.local/share/WsScrcpyWeb/control/operation-server/ws-scrcpy-web-launcher.exe" "/opt/ws-scrcpy-web/ws-scrcpy-web-launcher.exe"');
        expect(script).toContain('chmod 0755 "/opt/ws-scrcpy-web/ws-scrcpy-web-launcher.exe"');
        const helperCp = script.indexOf('/opt/ws-scrcpy-web/ws-scrcpy-web-launcher.exe');
        const relabel = script.indexOf('restorecon -Rv');
        expect(helperCp).toBeLessThan(relabel);
    });

    it('omits the helper cp when no sourceHelper is provided (from-source / unavailable)', () => {
        const script = buildSystemInstallScript({
            sourceAppImage: '/a.AppImage', unitTmpPath: '/t', unitPath: '/u', name: 'WsScrcpyWeb',
        });
        expect(script).not.toContain('ws-scrcpy-web-launcher.exe');
    });

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

    it('copies the user deps into /opt and seeds the data config (#36)', () => {
        const script = buildSystemInstallScript({
            sourceAppImage: '/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage',
            sourceDeps: '/home/u/.local/share/WsScrcpyWeb/dependencies',
            seedConfigTmpPath: '/tmp/WsScrcpyWeb.seed.json',
            unitTmpPath: '/tmp/WsScrcpyWeb.service.tmp',
            unitPath: '/etc/systemd/system/WsScrcpyWeb.service',
            name: 'WsScrcpyWeb',
        });
        // writable state dir + deps dir created
        expect(script).toContain('mkdir -p /var/opt/ws-scrcpy-web');
        expect(script).toContain('mkdir -p /opt/ws-scrcpy-web/dependencies');
        // deps copied from the user's dir into the app's OWN /opt tree (Local-Deps)
        expect(script).toContain('cp -a "/home/u/.local/share/WsScrcpyWeb/dependencies/." "/opt/ws-scrcpy-web/dependencies/"');
        // seed config written into the state dir (FHS /var/opt)
        expect(script).toContain('cp "/tmp/WsScrcpyWeb.seed.json" "/var/opt/ws-scrcpy-web/config.json"');
        // state dir gets the writable var_lib_t label (more-specific beats the tree's bin_t)
        expect(script).toContain("semanage fcontext -a -t var_lib_t '/var/opt/ws-scrcpy-web(/.*)?'");
        // deps + seed land before the relabel so restorecon labels them correctly
        expect(script.indexOf('config.json')).toBeLessThan(script.indexOf('restorecon -Rv'));
    });

    it('always prepares the writable state dir, but omits deps-copy + seed when not provided', () => {
        const script = buildSystemInstallScript(args);
        expect(script).toContain('mkdir -p /var/opt/ws-scrcpy-web');
        expect(script).toContain("semanage fcontext -a -t var_lib_t '/var/opt/ws-scrcpy-web(/.*)?'");
        expect(script).not.toContain('cp -a');
        expect(script).not.toContain('config.json');
    });
});

describe('SYSTEM_STATE_DIR — FHS /var/opt retargeting', () => {
    it('system-scope unit env points DATA_ROOT at /var/opt (not /opt/.../data)', () => {
        const env = buildServiceUnitEnv('linux', 'system', '/home/u/.local/share/WsScrcpyWeb/dependencies');
        expect(env['DATA_ROOT']).toBe('/var/opt/ws-scrcpy-web');
        expect(env['DEPS_PATH']).toBe('/opt/ws-scrcpy-web/dependencies');
    });

    it('system install seeds config + labels state under /var/opt (var_lib_t)', () => {
        const script = buildSystemInstallScript(
            { sourceAppImage: '/home/u/App.AppImage', seedConfigTmpPath: '/tmp/seed.json',
              unitTmpPath: '/tmp/u.service', unitPath: '/etc/systemd/system/WsScrcpyWeb.service', name: 'WsScrcpyWeb' },
            (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`,
        );
        expect(script).toContain('mkdir -p /var/opt/ws-scrcpy-web');
        expect(script).toContain('cp "/tmp/seed.json" "/var/opt/ws-scrcpy-web/config.json"');
        expect(script).toContain("semanage fcontext -a -t var_lib_t '/var/opt/ws-scrcpy-web(/.*)?'");
        expect(script).toContain('restorecon -Rv "/var/opt/ws-scrcpy-web"');
        expect(script).not.toContain('/opt/ws-scrcpy-web/data');
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
