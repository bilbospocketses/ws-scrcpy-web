import { describe, it, expect } from 'vitest';
import { SystemdClient, renderUnitFile, STAGED_SYSTEM_DIR, buildSystemInstallScript, systemctlArgv, buildServiceUnitEnv, buildMachineWideInstallScript, buildMachineWideUpdateScript, buildSystemMigrationScript, buildSystemSeedConfig } from './SystemdClient';

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

    it('every service unit env carries WS_SCRCPY_SERVICE=1 so the service can identify itself to the post-install poll', () => {
        const userEnv = buildServiceUnitEnv('linux', 'user', '/home/u/.local/share/WsScrcpyWeb/dependencies');
        const sysEnv = buildServiceUnitEnv('linux', 'system', '/home/u/.local/share/WsScrcpyWeb/dependencies');
        const winEnv = buildServiceUnitEnv('win32', undefined, 'C:\\deps');
        expect(userEnv['WS_SCRCPY_SERVICE']).toBe('1');
        expect(sysEnv['WS_SCRCPY_SERVICE']).toBe('1');
        expect(winEnv['WS_SCRCPY_SERVICE']).toBe('1');
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

describe('buildMachineWideInstallScript', () => {
    it('machine-wide install stages the binary + label + desktop + VERSION, then deletes the source', () => {
        const s = buildMachineWideInstallScript(
            { sourceAppImage: '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage', version: '0.1.31-beta.1' },
            (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`,
        );
        expect(s).toContain('mkdir -p /opt/ws-scrcpy-web');
        expect(s).toContain('cp "/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage" "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
        expect(s).toContain('chmod 0755 "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
        expect(s).toContain("semanage fcontext -a -t bin_t '/opt/ws-scrcpy-web(/.*)?'");
        expect(s).toContain('restorecon -Rv "/opt/ws-scrcpy-web"');
        expect(s).toContain('/opt/ws-scrcpy-web/VERSION');
        expect(s).toContain('/usr/share/applications/ws-scrcpy-web.desktop');   // SYSTEM-WIDE menu (all users)
        expect(s).toContain('Exec=/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage');     // every user launches the shared /opt binary
        expect(s).not.toContain('dependencies');   // binary only — deps stay per-user ~/.local
        expect(s).not.toContain('systemctl');      // no service install here
        expect(s).toContain('rm -f "/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage"');  // final step: delete the original (true relocate)
    });

    it('installs the menu icon into the hicolor theme + refreshes the icon cache when iconSource is given', () => {
        const s = buildMachineWideInstallScript(
            {
                sourceAppImage: '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage',
                version: '0.1.31-beta.1',
                iconSource: '/tmp/.mount_x/.DirIcon',
            },
            (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`,
        );
        // icon staged into the hicolor 256x256 apps dir under the name the
        // .desktop's `Icon=ws-scrcpy-web` resolves to (also the path the launcher
        // uninstaller's SYS_ICON teardown removes).
        expect(s).toContain('mkdir -p /usr/share/icons/hicolor/256x256/apps');
        expect(s).toContain('cp "/tmp/.mount_x/.DirIcon" /usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png');
        expect(s).toContain('/usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png');
        // best-effort cache refresh, mirroring the update-desktop-database subshell.
        expect(s).toContain('gtk-update-icon-cache');
        expect(s).toMatch(/\(\s*\/usr\/bin\/gtk-update-icon-cache -f \/usr\/share\/icons\/hicolor \|\| true\s*\)/);
        // ordering: icon install lands AFTER the .desktop write and BEFORE the home-AppImage delete.
        const desktopIdx = s.indexOf('/usr/share/applications/ws-scrcpy-web.desktop');
        const iconIdx = s.indexOf('/usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png');
        const rmIdx = s.indexOf('rm -f "/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage"');
        expect(desktopIdx).toBeGreaterThanOrEqual(0);
        expect(desktopIdx).toBeLessThan(iconIdx);
        expect(iconIdx).toBeLessThan(rmIdx);
    });

    it('skips the icon steps entirely when no iconSource is given (graceful skip)', () => {
        const s = buildMachineWideInstallScript(
            { sourceAppImage: '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage', version: '0.1.31-beta.1' },
            (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`,
        );
        expect(s).not.toContain('/usr/share/icons/hicolor');
        expect(s).not.toContain('gtk-update-icon-cache');
    });
});

describe('buildMachineWideUpdateScript', () => {
    // Phase 3 — machine-wide-no-service in-app update. The user runs the
    // root-owned /opt AppImage directly (NOT a service), so the swap needs ONE
    // pkexec. A `cp` over /opt would ETXTBSY the running file, so the swap is a
    // RENAME (the old inode stays alive for the running process; renames work
    // while the AppImage is mounted). The new file gets re-labelled bin_t + a
    // fresh VERSION.
    const args = {
        stagedAppImage:
            '/home/u/.local/share/WsScrcpyWeb/control/update-staging/WsScrcpyWeb-linux-beta.AppImage.new',
        version: '0.1.31-beta.2',
    };

    it('rename-swaps the /opt AppImage (old→.bak, staged→/opt), chmods, relabels best-effort, writes VERSION', () => {
        const s = buildMachineWideUpdateScript(args, (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`);
        // 1. back up the RUNNING /opt binary by RENAME (cp would ETXTBSY it).
        expect(s).toContain(
            '/usr/bin/mv -f "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage" "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage.bak"',
        );
        // 2. move the staged download into place (rename, not cp).
        expect(s).toContain(
            `/usr/bin/mv -f "${args.stagedAppImage}" "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"`,
        );
        // 3. chmod the new binary executable.
        expect(s).toContain('/usr/bin/chmod 0755 "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
        // 4. re-apply the bin_t label best-effort: restorecon (persistent rule),
        //    chcon fallback, trailing `|| true` so a non-SELinux host still writes VERSION.
        expect(s).toContain('/usr/sbin/restorecon -v "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
        expect(s).toContain('/usr/bin/chcon -t bin_t "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
        // 5. write the new VERSION marker.
        expect(s).toContain(`/usr/bin/printf '%s' '0.1.31-beta.2' > /opt/ws-scrcpy-web/VERSION`);
    });

    it('NEVER cp the AppImage (cp overwrites in place → ETXTBSY on the running file)', () => {
        const s = buildMachineWideUpdateScript(args, (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`);
        expect(s).not.toMatch(/\bcp\b/);
    });

    it('orders the steps: backup-rename → staged-rename → chmod → relabel → VERSION', () => {
        const s = buildMachineWideUpdateScript(args);
        const backup = s.indexOf('.bak');
        const stagedMove = s.indexOf(args.stagedAppImage);
        const chmod = s.indexOf('chmod 0755');
        const relabel = s.indexOf('restorecon -v');
        const version = s.indexOf('VERSION');
        expect(backup).toBeGreaterThanOrEqual(0);
        expect(backup).toBeLessThan(stagedMove);
        expect(stagedMove).toBeLessThan(chmod);
        expect(chmod).toBeLessThan(relabel);
        expect(relabel).toBeLessThan(version);
    });

    it('relabel is best-effort — restorecon → chcon → || true in one subshell (never aborts the && chain)', () => {
        const s = buildMachineWideUpdateScript(args, (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`);
        expect(s).toMatch(/\(\s*\/usr\/sbin\/restorecon -v "[^"]+" \|\| \/usr\/bin\/chcon -t bin_t "[^"]+" \|\| true\s*\)/);
    });

    it('uses absolute tool paths (no bare names) when resolvers are injected', () => {
        const s = buildMachineWideUpdateScript(args, (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`);
        expect(s).toContain('/usr/bin/mv -f');
        expect(s).toContain('/usr/bin/printf');
        expect(s).toContain('/usr/sbin/restorecon');
    });
});

describe('buildSystemMigrationScript', () => {
    const args = {
        seedConfigJson: JSON.stringify(buildSystemSeedConfig(8000)),
        unitTmpPath: '/tmp/WsScrcpyWeb.service.tmp',
        unitPath: '/etc/systemd/system/WsScrcpyWeb.service',
        name: 'WsScrcpyWeb',
    };

    it('old-cleanup: stops + disables + reset-failed the unit, rm -rf the legacy /opt/.../data, deletes the legacy fcontext rule', () => {
        const script = buildSystemMigrationScript(args);
        expect(script).toContain('systemctl stop WsScrcpyWeb.service');
        expect(script).toContain('systemctl disable WsScrcpyWeb.service');
        expect(script).toContain('systemctl reset-failed WsScrcpyWeb.service');
        expect(script).toContain('rm -rf /opt/ws-scrcpy-web/data');
        expect(script).toContain("semanage fcontext -d '/opt/ws-scrcpy-web/data(/.*)?'");
    });

    it('new-setup: mkdir /var/opt, seeds config.json there, adds var_lib_t + restorecon, installs the unit, daemon-reload, enable --now', () => {
        const script = buildSystemMigrationScript(args);
        expect(script).toContain('mkdir -p /var/opt/ws-scrcpy-web');
        expect(script).toContain('/var/opt/ws-scrcpy-web/config.json');
        expect(script).toContain("semanage fcontext -a -t var_lib_t '/var/opt/ws-scrcpy-web(/.*)?'");
        expect(script).toContain('restorecon -Rv "/var/opt/ws-scrcpy-web"');
        expect(script).toContain('cp "/tmp/WsScrcpyWeb.service.tmp" "/etc/systemd/system/WsScrcpyWeb.service"');
        expect(script).toContain('systemctl daemon-reload');
        expect(script).toContain('systemctl enable --now WsScrcpyWeb.service');
    });

    it('carries the seeded webPort into /var/opt/.../config.json', () => {
        const script = buildSystemMigrationScript(args);
        expect(script).toContain('"webPort":8000');
        // the config.json write lands BEFORE the relabel so restorecon labels it var_lib_t
        expect(script.indexOf('config.json')).toBeLessThan(script.indexOf('restorecon -Rv'));
    });

    it('does NOT re-copy the AppImage or deps — the binary stays in /opt', () => {
        const script = buildSystemMigrationScript(args);
        // no cp of the binary / deps — migration only relocates state + unit
        expect(script).not.toContain('WsScrcpyWeb.AppImage');
        expect(script).not.toContain('cp -a');
    });

    it('old cleanup runs before the new-layout setup', () => {
        const script = buildSystemMigrationScript(args);
        expect(script.indexOf('rm -rf /opt/ws-scrcpy-web/data'))
            .toBeLessThan(script.indexOf('mkdir -p /var/opt/ws-scrcpy-web'));
        expect(script.indexOf('mkdir -p /var/opt/ws-scrcpy-web'))
            .toBeLessThan(script.indexOf('enable --now'));
    });

    it('cleanup steps are best-effort (|| true) so a stopped/non-SELinux host still migrates', () => {
        const script = buildSystemMigrationScript(args);
        // stop/disable/reset-failed + the legacy fcontext delete must not abort the && chain
        expect(script).toContain('|| true');
        // the unit install still happens after the best-effort SELinux relabel
        expect(script.indexOf('cp "/tmp/WsScrcpyWeb.service.tmp"'))
            .toBeGreaterThan(script.indexOf('restorecon -Rv'));
    });

    it('uses absolute tool paths (no bare names)', () => {
        const script = buildSystemMigrationScript(args, (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`);
        expect(script).toContain('/usr/bin/systemctl daemon-reload');
        expect(script).toContain('/usr/sbin/restorecon -Rv');
        expect(script).toContain('/usr/sbin/semanage fcontext -d');
    });
});
