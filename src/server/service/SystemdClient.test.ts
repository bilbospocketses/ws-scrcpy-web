import { describe, it, expect } from 'vitest';
import { SystemdClient, renderUnitFile, STAGED_SYSTEM_DIR, systemctlArgv, buildServiceUnitEnv, buildMachineWideInstallScript, buildMachineWideUpdateScript } from './SystemdClient';

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


describe('SYSTEM_STATE_DIR — /var/lib retargeting', () => {
    it('system-scope unit env points DATA_ROOT at /var/lib (not /opt/.../data)', () => {
        const env = buildServiceUnitEnv('linux', 'system', '/home/u/.local/share/WsScrcpyWeb/dependencies');
        expect(env['DATA_ROOT']).toBe('/var/lib/ws-scrcpy-web');
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
        expect(unitSection).toContain('StartLimitIntervalSec=60');
        expect(unitSection).toContain('StartLimitBurst=3');
        expect(serviceSection).not.toContain('StartLimitIntervalSec');
        expect(serviceSection).not.toContain('StartLimitBurst');
    });
});

describe('renderUnitFile — system scope unit', () => {
    const sysOpts = {
        name: 'WsScrcpyWeb',
        description: 'ws-scrcpy-web',
        binPath: '/home/u/.local/share/WsScrcpyWeb/bin/WsScrcpyWeb.AppImage',
        startupDir: '/home/u',
        maxRestartAttempts: 10,
        envVars: { DATA_ROOT: '/var/lib/ws-scrcpy-web', DEPS_PATH: '/opt/ws-scrcpy-web/dependencies', WS_SCRCPY_SERVICE: '1', WS_SCRCPY_WEB_PORT: '8000' },
        logPath: '/var/lib/ws-scrcpy-web/logs/service.log',
    } as unknown as Parameters<typeof renderUnitFile>[0];

    it('puts StartLimit* in [Unit], Restart=on-failure/RestartSec=2 in [Service], and execs the /opt binary', () => {
        const unit = renderUnitFile(sysOpts, 'system');
        const unitSection = unit.split('[Service]')[0];
        expect(unitSection).toContain('StartLimitIntervalSec=60');
        expect(unitSection).toContain('StartLimitBurst=10');
        const serviceSection = (unit.split('[Service]')[1] ?? '').split('[Install]')[0] ?? '';
        expect(serviceSection).not.toContain('StartLimit');
        expect(serviceSection).toContain('Restart=on-failure');
        expect(serviceSection).toContain('RestartSec=2');
        expect(serviceSection).toContain('ExecStart=/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage');
        expect(unit).toContain('WantedBy=multi-user.target');
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

    it('makes the /opt bin_t fcontext add idempotent (-a || -m) so a re-install over an existing rule still restorecons (no &&-cascade)', () => {
        const s = buildMachineWideInstallScript(
            { sourceAppImage: '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage', version: '0.1.31-beta.1' },
            (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`,
        );
        // a re-install (or any path hitting a pre-existing /opt rule) makes a bare
        // `semanage -a` error "already defined" and the `&&` skips restorecon. The
        // `-a || -m` form keeps it idempotent. (Sibling of the #9 2.2/2.3 bug.)
        expect(s).toContain("semanage fcontext -m -t bin_t '/opt/ws-scrcpy-web(/.*)?'");
    });

    it('restorecon runs independently of the bin_t add (;-separated), no chcon fallback (beta.61)', () => {
        const s = buildMachineWideInstallScript(
            { sourceAppImage: '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage', version: '0.1.31-beta.1' },
        );
        expect(s).toContain('restorecon -Rv "/opt/ws-scrcpy-web"');
        expect(s).not.toContain('chcon -t bin_t');
        // bin_t add + restorecon are `;`-separated, not `&&`-chained (can't short-circuit)
        expect(s).not.toMatch(/-a -t bin_t[^;]*&&[^;]*restorecon/);
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
