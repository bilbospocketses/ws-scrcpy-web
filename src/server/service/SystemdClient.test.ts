import { describe, expect, it } from 'vitest';
import {
    buildMachineWideInstallScript,
    buildMachineWideUpdateScript,
    buildServiceUnitEnv,
    buildSystemUninstallScript,
    pkexecDeclined,
    renderUnitFile,
    STAGED_SYSTEM_DIR,
    SystemdClient,
    systemctlArgv,
} from './SystemdClient';
import { shQuote } from './shellEscape';

// item 160: measured by qa-harness on stock Fedora 44 KDE (polkit-kde 6.6.4), run wssw-20260929T172816Z-811b.
const KDE_CANCEL_STDERR =
    'Error executing command as another user: Not authorized\n\nThis incident has been reported.\n';
const NO_AGENT_STDERR =
    "Error creating textual authentication agent: Error opening current controlling terminal for the process (`/dev/tty'): No such device or address\n";

describe('pkexecDeclined (item 160)', () => {
    it('GNOME: exit 126 is a dismissed prompt', () => {
        expect(pkexecDeclined(126, '')).toBe(true);
    });
    it('KDE: a cancel exits 127 "Not authorized", which is declined too', () => {
        expect(pkexecDeclined(127, KDE_CANCEL_STDERR)).toBe(true);
    });
    it('127 with an unrecognised or localised text still reads as declined', () => {
        expect(pkexecDeclined(127, 'Fehler beim Ausführen des Befehls als anderer Benutzer: Nicht autorisiert')).toBe(
            true,
        );
    });
    it.each([
        ['no authentication agent (pkexec from a shell with no desktop)', NO_AGENT_STDERR],
        ["the app's own refusal", 'refusing to run elevated: argv[0] is not an absolute, existing path: "pkexec"'],
        ['a command missing inside the elevated sh -c script', 'sh: 1: /usr/bin/update-desktop-database: not found'],
        ['a program pkexec cannot run', 'pkexec: cannot run program /opt/x: No such file or directory'],
    ])('127 from %s stays an error', (_label, stderr) => {
        expect(pkexecDeclined(127, stderr)).toBe(false);
    });
    it('any other exit code is an error', () => {
        for (const code of [0, 1, 2, 125, 128, undefined]) expect(pkexecDeclined(code, KDE_CANCEL_STDERR)).toBe(false);
    });
});

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
        envVars: {
            DATA_ROOT: '/var/lib/ws-scrcpy-web',
            DEPS_PATH: '/opt/ws-scrcpy-web/dependencies',
            WS_SCRCPY_SERVICE: '1',
        },
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
            (t) => `/usr/bin/${t}`,
            (t) => `/usr/sbin/${t}`,
        );
        expect(s).toContain('mkdir -p -m 0755 /opt/ws-scrcpy-web');
        // D14b: a fresh root-owned inode renamed in, never a cp onto the /opt binary
        // (cp onto an existing file keeps that file's owner).
        expect(s).toContain(
            `install -o root -g root -m 0755 '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage' "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage.new"`,
        );
        expect(s).toContain(
            'mv -f "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage.new" "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"',
        );
        expect(s).not.toMatch(/\bcp '[^']*' "\/opt\/ws-scrcpy-web\/WsScrcpyWeb\.AppImage"/);
        expect(s).toContain('rm -f /opt/ws-scrcpy-web/VERSION');
        expect(s).toContain('chmod 0644 /opt/ws-scrcpy-web/VERSION');
        expect(s).toContain("semanage fcontext -a -t bin_t '/opt/ws-scrcpy-web(/.*)?'");
        expect(s).toContain('restorecon -Rv "/opt/ws-scrcpy-web"');
        expect(s).toContain('/opt/ws-scrcpy-web/VERSION');
        expect(s).toContain('/usr/share/applications/ws-scrcpy-web.desktop'); // SYSTEM-WIDE menu (all users)
        expect(s).toContain('Exec=/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage'); // every user launches the shared /opt binary
        expect(s).not.toContain('dependencies'); // binary only — deps stay per-user ~/.local
        expect(s).not.toContain('systemctl'); // no service install here
        expect(s).toContain(`rm -f '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage'`); // final step: delete the original (true relocate)
    });

    it('sets umask 022 first and leaves /opt 0755 even if it already existed 775 (D8)', () => {
        // pkexec keeps the desktop user's umask (0002 on Ubuntu); /opt came out
        // 775 and the later system install refused it.
        const s = buildMachineWideInstallScript(
            { sourceAppImage: '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage', version: '0.1.31-beta.1' },
            (t) => `/usr/bin/${t}`,
            (t) => `/usr/sbin/${t}`,
        );
        const steps = s.split(' && ');
        expect(steps[0]).toBe('umask 022');
        expect(steps[1]).toBe('/usr/bin/mkdir -p -m 0755 /opt/ws-scrcpy-web');
        expect(steps[2]).toBe('/usr/bin/chmod 0755 /opt/ws-scrcpy-web');
    });

    it('installs the menu icon into the hicolor theme + refreshes the icon cache when iconSource is given', () => {
        const s = buildMachineWideInstallScript(
            {
                sourceAppImage: '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage',
                version: '0.1.31-beta.1',
                iconSource: '/tmp/.mount_x/.DirIcon',
            },
            (t) => `/usr/bin/${t}`,
            (t) => `/usr/sbin/${t}`,
        );
        // icon staged into the hicolor 256x256 apps dir under the name the
        // .desktop's `Icon=ws-scrcpy-web` resolves to (also the path the launcher
        // uninstaller's SYS_ICON teardown removes).
        expect(s).toContain('mkdir -p /usr/share/icons/hicolor/256x256/apps');
        expect(s).toContain(`cp '/tmp/.mount_x/.DirIcon' /usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png`);
        expect(s).toContain('/usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png');
        // best-effort cache refresh, mirroring the update-desktop-database subshell.
        expect(s).toContain('gtk-update-icon-cache');
        expect(s).toMatch(/\(\s*\/usr\/bin\/gtk-update-icon-cache -f \/usr\/share\/icons\/hicolor \|\| true\s*\)/);
        // ordering: icon install lands AFTER the .desktop write and BEFORE the home-AppImage delete.
        const desktopIdx = s.indexOf('/usr/share/applications/ws-scrcpy-web.desktop');
        const iconIdx = s.indexOf('/usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png');
        const rmIdx = s.indexOf(`rm -f '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage'`);
        expect(desktopIdx).toBeGreaterThanOrEqual(0);
        expect(desktopIdx).toBeLessThan(iconIdx);
        expect(iconIdx).toBeLessThan(rmIdx);
    });

    it('skips the icon steps entirely when no iconSource is given (graceful skip)', () => {
        const s = buildMachineWideInstallScript(
            { sourceAppImage: '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage', version: '0.1.31-beta.1' },
            (t) => `/usr/bin/${t}`,
            (t) => `/usr/sbin/${t}`,
        );
        expect(s).not.toContain('/usr/share/icons/hicolor');
        expect(s).not.toContain('gtk-update-icon-cache');
    });

    it('makes the /opt bin_t fcontext add idempotent (-a || -m) so a re-install over an existing rule still restorecons (no &&-cascade)', () => {
        const s = buildMachineWideInstallScript(
            { sourceAppImage: '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage', version: '0.1.31-beta.1' },
            (t) => `/usr/bin/${t}`,
            (t) => `/usr/sbin/${t}`,
        );
        // a re-install (or any path hitting a pre-existing /opt rule) makes a bare
        // `semanage -a` error "already defined" and the `&&` skips restorecon. The
        // `-a || -m` form keeps it idempotent. (Sibling of the #9 2.2/2.3 bug.)
        expect(s).toContain("semanage fcontext -m -t bin_t '/opt/ws-scrcpy-web(/.*)?'");
    });

    it('restorecon runs independently of the bin_t add (;-separated), no chcon fallback (beta.61)', () => {
        const s = buildMachineWideInstallScript({
            sourceAppImage: '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage',
            version: '0.1.31-beta.1',
        });
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
        stagedAppImage: '/home/u/.local/share/WsScrcpyWeb/control/update-staging/WsScrcpyWeb-linux-beta.AppImage.new',
        version: '0.1.31-beta.2',
    };

    it('installs a fresh root-owned copy, rename-swaps it in (old→.bak), relabels best-effort, writes VERSION 0644', () => {
        const steps = buildMachineWideUpdateScript(
            args,
            (t) => `/usr/bin/${t}`,
            (t) => `/usr/sbin/${t}`,
        ).split(' && ');
        const bin = '/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage';
        expect(steps).toEqual([
            'umask 022',
            // D14b: a FRESH root-owned inode from the user's staged download. The old
            // `mv` of the staged file kept the user as the owner of the /opt binary.
            `/usr/bin/install -o root -g root -m 0755 '${args.stagedAppImage}' "${bin}.new"`,
            // Back up the RUNNING binary by rename (cp would ETXTBSY it), then swap.
            `/usr/bin/mv -f "${bin}" "${bin}.bak"`,
            `/usr/bin/mv -f "${bin}.new" "${bin}"`,
            // The rollback copy is never left user-owned either.
            `/usr/bin/chown root:root "${bin}.bak"`,
            `/usr/bin/chmod 0755 "${bin}.bak"`,
            `( /usr/sbin/restorecon -v "${bin}" || /usr/bin/chcon -t bin_t "${bin}" || true )`,
            '/usr/bin/rm -f /opt/ws-scrcpy-web/VERSION',
            `/usr/bin/printf '%s' '0.1.31-beta.2' > /opt/ws-scrcpy-web/VERSION`,
            '/usr/bin/chmod 0644 /opt/ws-scrcpy-web/VERSION',
        ]);
    });

    it('never moves the staged download itself into /opt (D14b)', () => {
        const s = buildMachineWideUpdateScript(args);
        expect(s).not.toContain(`mv -f '${args.stagedAppImage}'`);
        // The staged download is only ever the SOURCE of `install -o root`.
        expect(s.split(`'${args.stagedAppImage}'`).length - 1).toBe(1);
    });

    it('NEVER cp the AppImage (cp overwrites in place → ETXTBSY on the running file)', () => {
        const s = buildMachineWideUpdateScript(
            args,
            (t) => `/usr/bin/${t}`,
            (t) => `/usr/sbin/${t}`,
        );
        expect(s).not.toMatch(/\bcp\b/);
    });

    it('orders the steps: fresh install → backup-rename → swap-rename → relabel → VERSION', () => {
        const s = buildMachineWideUpdateScript(args);
        const fresh = s.indexOf(args.stagedAppImage);
        const backup = s.indexOf('.bak"');
        const swap = s.indexOf('.new" "');
        const relabel = s.indexOf('restorecon -v');
        const version = s.indexOf('VERSION');
        expect(fresh).toBeGreaterThanOrEqual(0);
        expect(fresh).toBeLessThan(backup);
        expect(backup).toBeLessThan(swap);
        expect(swap).toBeLessThan(relabel);
        expect(relabel).toBeLessThan(version);
    });

    it('relabel is best-effort — restorecon → chcon → || true in one subshell (never aborts the && chain)', () => {
        const s = buildMachineWideUpdateScript(
            args,
            (t) => `/usr/bin/${t}`,
            (t) => `/usr/sbin/${t}`,
        );
        expect(s).toMatch(
            /\(\s*\/usr\/sbin\/restorecon -v "[^"]+" \|\| \/usr\/bin\/chcon -t bin_t "[^"]+" \|\| true\s*\)/,
        );
    });

    it('uses absolute tool paths (no bare names) when resolvers are injected', () => {
        const s = buildMachineWideUpdateScript(
            args,
            (t) => `/usr/bin/${t}`,
            (t) => `/usr/sbin/${t}`,
        );
        expect(s).toContain('/usr/bin/mv -f');
        expect(s).toContain('/usr/bin/printf');
        expect(s).toContain('/usr/sbin/restorecon');
    });
});

describe('root-script shell-escaping (review #11)', () => {
    it('single-quote-escapes a hostile sourceAppImage in the install script', () => {
        const evil = '/tmp/x$(id).AppImage';
        const s = buildMachineWideInstallScript(
            { sourceAppImage: evil, version: '1.0.0' },
            (t) => `/usr/bin/${t}`,
            (t) => `/usr/sbin/${t}`,
        );
        // the payload appears ONLY inside a single-quoted (inert) literal,
        expect(s).toContain(shQuote(evil));
        // never in a double-quoted slot the root shell would expand.
        expect(s).not.toContain(`"${evil}"`);
    });

    it('single-quote-escapes a hostile version (single-quote breakout)', () => {
        const evil = "1.0'; id; '";
        const s = buildMachineWideInstallScript(
            { sourceAppImage: '/tmp/a.AppImage', version: evil },
            (t) => `/usr/bin/${t}`,
            (t) => `/usr/sbin/${t}`,
        );
        expect(s).toContain(shQuote(evil));
    });

    it('single-quote-escapes a hostile stagedAppImage in the update script', () => {
        const evil = '/tmp/s$(id).AppImage.new';
        const s = buildMachineWideUpdateScript(
            { stagedAppImage: evil, version: '1.0.0' },
            (t) => `/usr/bin/${t}`,
            (t) => `/usr/sbin/${t}`,
        );
        expect(s).toContain(shQuote(evil));
        expect(s).not.toContain(`"${evil}"`);
    });
});

describe('buildSystemUninstallScript (review #12)', () => {
    it('builds disable/rm/daemon-reload with the unit and path single-quoted', () => {
        const s = buildSystemUninstallScript(
            'ws-scrcpy-web',
            '/etc/systemd/system/ws-scrcpy-web.service',
            '/usr/bin/systemctl',
        );
        expect(s).toContain(`/usr/bin/systemctl disable --now 'ws-scrcpy-web.service' || true`);
        expect(s).toContain(`rm -f '/etc/systemd/system/ws-scrcpy-web.service'`);
        expect(s).toContain('/usr/bin/systemctl daemon-reload');
    });

    it('single-quote-escapes a hostile unitPath', () => {
        const evil = '/etc/systemd/system/x$(id).service';
        const s = buildSystemUninstallScript('ws-scrcpy-web', evil, '/usr/bin/systemctl');
        expect(s).toContain(shQuote(evil));
        expect(s).not.toContain(`"${evil}"`);
    });

    it('rejects a service name carrying shell metacharacters', () => {
        expect(() => buildSystemUninstallScript('a;id', '/x', '/usr/bin/systemctl')).toThrow(/service name/);
        expect(() => buildSystemUninstallScript('a b', '/x', '/usr/bin/systemctl')).toThrow();
    });
});
