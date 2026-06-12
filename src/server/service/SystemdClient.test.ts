import { describe, it, expect } from 'vitest';
import { SystemdClient, renderUnitFile, STAGED_SYSTEM_DIR, buildSystemInstallScript, systemctlArgv, buildServiceUnitEnv, buildMachineWideInstallScript, buildMachineWideUpdateScript } from './SystemdClient';

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
        unitTmpPath: '/tmp/WsScrcpyWeb.service.tmp',
        unitPath: '/etc/systemd/system/WsScrcpyWeb.service',
        name: 'WsScrcpyWeb',
    };

    it('stages the launcher helper into /opt alongside the AppImage (bin_t via the fcontext rule)', () => {
        const script = buildSystemInstallScript({
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
            unitTmpPath: '/t', unitPath: '/u', name: 'WsScrcpyWeb',
        });
        expect(script).not.toContain('ws-scrcpy-web-launcher.exe');
    });

    it('prepares /opt, chmods the (already-staged) binary, then installs the unit', () => {
        const script = buildSystemInstallScript(args);
        expect(script).toContain('mkdir -p /opt/ws-scrcpy-web');
        // the AppImage is NOT re-copied (machine-wide precondition) — only chmod'd
        expect(script).toContain('chmod 0755 "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
        expect(script).toContain('restorecon -Rv "/opt/ws-scrcpy-web"');
        expect(script).toContain('cp "/tmp/WsScrcpyWeb.service.tmp" "/etc/systemd/system/WsScrcpyWeb.service"');
        expect(script).toContain('systemctl daemon-reload');
        expect(script).toContain('systemctl enable --now WsScrcpyWeb.service');
    });

    it('emits NO var_lib_t rule and NO /var/opt — labels state via the /var/lib default, restorecons both trees', () => {
        // The system install was IMPOSSIBLE on Fedora: `/var/opt` is policy-aliased to
        // `/opt` (file_contexts.subs_dist), so `semanage -a -t var_lib_t /var/opt/...` is
        // REJECTED and the path inherits /opt's bin_t. State now lives under /var/lib,
        // which the policy's built-in /var/lib(/.*)? rule labels var_lib_t for free — so
        // the install emits NO custom semanage rule at all. This guard is exactly what the
        // old string-only tests lacked: they asserted the un-addable command WAS present,
        // which is how the bug shipped green-but-broken 4×.
        const script = buildSystemInstallScript(args);
        expect(script).not.toContain('var_lib_t');     // no custom state-dir rule
        expect(script).not.toContain('/var/opt');       // the aliased path is gone
        expect(script).toContain('restorecon -Rv "/opt/ws-scrcpy-web"');       // relabel copied deps -> bin_t
        expect(script).toContain('restorecon -Rv "/var/lib/ws-scrcpy-web"');   // assert the var_lib_t default
        expect(script).not.toContain('chcon');           // no transient fallback
        expect(script).not.toContain("semanage fcontext -a -t bin_t '/opt/ws-scrcpy-web(/.*)?'"); // no /opt re-add
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

    it('copies the user deps into /opt and seeds the state config (#36)', () => {
        const script = buildSystemInstallScript({
            sourceDeps: '/home/u/.local/share/WsScrcpyWeb/dependencies',
            seedConfigTmpPath: '/tmp/WsScrcpyWeb.seed.json',
            unitTmpPath: '/tmp/WsScrcpyWeb.service.tmp',
            unitPath: '/etc/systemd/system/WsScrcpyWeb.service',
            name: 'WsScrcpyWeb',
        });
        // writable state dir + deps dir created
        expect(script).toContain('mkdir -p /var/lib/ws-scrcpy-web');
        expect(script).toContain('mkdir -p /opt/ws-scrcpy-web/dependencies');
        // deps copied from the user's dir into the app's OWN /opt tree (Local-Deps)
        expect(script).toContain('cp -a "/home/u/.local/share/WsScrcpyWeb/dependencies/." "/opt/ws-scrcpy-web/dependencies/"');
        // seed config written into the state dir (/var/lib)
        expect(script).toContain('cp "/tmp/WsScrcpyWeb.seed.json" "/var/lib/ws-scrcpy-web/config.json"');
        // NO custom var_lib_t rule — /var/lib is var_lib_t by the policy default
        expect(script).not.toContain('var_lib_t');
        // seed lands before the /var/lib restorecon (which asserts the default label)
        expect(script.indexOf('config.json')).toBeLessThan(script.indexOf('restorecon -Rv "/var/lib/ws-scrcpy-web"'));
    });

    it('always prepares the writable state dir, but omits deps-copy + seed when not provided', () => {
        const script = buildSystemInstallScript(args);
        expect(script).toContain('mkdir -p /var/lib/ws-scrcpy-web');
        expect(script).toContain('restorecon -Rv "/var/lib/ws-scrcpy-web"');
        expect(script).not.toContain('cp -a');
        expect(script).not.toContain('config.json');
    });

    it('does NOT stage/copy the AppImage into /opt (machine-wide is a precondition — the binary is already there, so copying self-copies)', () => {
        // The system-service install is gated behind a machine-wide install, so
        // /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage already exists AND is the
        // running binary ($APPIMAGE). Re-staging it is a `cp X X` self-copy that
        // GNU cp refuses ("are the same file"), aborting the pkexec script. The
        // install must not copy the AppImage — the unit's ExecStart already
        // points at the existing /opt binary.
        const script = buildSystemInstallScript(args);
        expect(script).not.toMatch(/cp\s+"[^"]*"\s+"\/opt\/ws-scrcpy-web\/WsScrcpyWeb\.AppImage"/);
    });

    it('with a staged helper: enables (not --now) and spawns a rootful system handoff (beta.57)', () => {
        const script = buildSystemInstallScript(
            { sourceHelper: '/home/u/.local/share/WsScrcpyWeb/control/operation-server/ws-scrcpy-web-launcher.exe',
              unitTmpPath: '/tmp/u', unitPath: '/etc/systemd/system/WsScrcpyWeb.service',
              name: 'WsScrcpyWeb', handoffUnit: 'wsscrcpy-install-123' },
            (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`,
        );
        // never start under the local instance's still-live port (the beta.56 self-defer):
        expect(script).not.toContain('enable --now');
        expect(script).toContain('/usr/bin/systemctl enable WsScrcpyWeb.service');
        // rootful, out-of-cgroup handoff that waits for the port to free, then starts + verifies:
        expect(script).toContain(
            '/usr/bin/systemd-run --collect --unit=wsscrcpy-install-123 --setenv=DATA_ROOT=/var/lib/ws-scrcpy-web ' +
            '"/opt/ws-scrcpy-web/ws-scrcpy-web-launcher.exe" --linux-service-install-handoff --scope system --unit WsScrcpyWeb'
        );
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

    it('system install seeds config + labels state under /var/lib (var_lib_t by default)', () => {
        const script = buildSystemInstallScript(
            { seedConfigTmpPath: '/tmp/seed.json',
              unitTmpPath: '/tmp/u.service', unitPath: '/etc/systemd/system/WsScrcpyWeb.service', name: 'WsScrcpyWeb' },
            (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`,
        );
        expect(script).toContain('mkdir -p /var/lib/ws-scrcpy-web');
        expect(script).toContain('cp "/tmp/seed.json" "/var/lib/ws-scrcpy-web/config.json"');
        expect(script).not.toContain('var_lib_t');
        expect(script).toContain('restorecon -Rv "/var/lib/ws-scrcpy-web"');
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
