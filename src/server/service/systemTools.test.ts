import { describe, expect, it } from 'vitest';
import { buildDetachedSpawn, resolveSystemTool } from './systemTools';

describe('resolveSystemTool — POSIX', () => {
    it('returns the first candidate that exists', () => {
        const exists = (p: string) => p === '/usr/bin/systemctl';
        expect(resolveSystemTool('systemctl', exists, 'linux')).toBe('/usr/bin/systemctl');
    });

    it('prefers /usr/bin over /bin when both exist', () => {
        const exists = (p: string) => p === '/usr/bin/pkexec' || p === '/bin/pkexec';
        expect(resolveSystemTool('pkexec', exists, 'linux')).toBe('/usr/bin/pkexec');
    });

    it('checks sbin locations for admin tools (semanage/restorecon)', () => {
        const exists = (p: string) => p === '/usr/sbin/semanage';
        expect(resolveSystemTool('semanage', exists, 'linux')).toBe('/usr/sbin/semanage');
    });

    it('falls back to the bare name when no absolute path exists', () => {
        const exists = (_p: string) => false;
        expect(resolveSystemTool('systemctl', exists, 'linux')).toBe('systemctl');
    });
});

describe('resolveSystemTool — Windows', () => {
    it('resolves OS tools under System32 (PATH-hijack defense, #20)', () => {
        const exists = (p: string) => p.toLowerCase().endsWith('system32\\taskkill.exe');
        const resolved = resolveSystemTool('taskkill', exists, 'win32');
        expect(resolved.toLowerCase()).toContain('system32');
        expect(resolved.toLowerCase().endsWith('taskkill.exe')).toBe(true);
    });

    it('appends .exe when probing a bare Windows tool name', () => {
        const seen: string[] = [];
        resolveSystemTool(
            'icacls',
            (p) => {
                seen.push(p);
                return false;
            },
            'win32',
        );
        expect(seen.some((p) => p.toLowerCase().endsWith('system32\\icacls.exe'))).toBe(true);
    });

    it('falls back to the bare tool name when absent', () => {
        expect(resolveSystemTool('arp', () => false, 'win32')).toBe('arp');
    });

    // Item 123. This used to read `%SystemRoot%` / `%windir%`, which is a
    // forbidden resolution path under the very Local-Dependencies-Only rule the
    // function exists to serve — an env var is caller-controlled in the same way
    // $PATH is. The repo pins the literal elsewhere for the same reason
    // (elevated_runner.rs, and openBrowser.ts since #653).
    it('probes the literal C:\\Windows, never an environment variable', () => {
        const saved = { SystemRoot: process.env['SystemRoot'], windir: process.env['windir'] };
        try {
            process.env['SystemRoot'] = 'D:\\Hijacked';
            process.env['windir'] = 'D:\\AlsoHijacked';
            const seen: string[] = [];
            resolveSystemTool(
                'taskkill',
                (p) => {
                    seen.push(p);
                    return false;
                },
                'win32',
            );
            expect(seen.every((p) => !p.includes('Hijacked'))).toBe(true);
            expect(seen.some((p) => p.startsWith('C:\\Windows\\System32\\'))).toBe(true);
        } finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    });
});

describe('buildDetachedSpawn', () => {
    const prog = '/data/control/operation-server/ws-scrcpy-web-launcher.exe';
    const pArgs = ['--linux-apply', '--staged', '/s.new', '--target', '/t.AppImage', '--wait-pid', '123'];

    it('prefers systemd-run --user --collect in its own transient unit (escapes the app cgroup)', () => {
        // systemd-run resolves to an absolute path; everything else is bare.
        const resolve = (t: string) => (t === 'systemd-run' ? '/usr/bin/systemd-run' : t);
        const plan = buildDetachedSpawn(prog, pArgs, { unit: 'wsscrcpy-apply-1' }, resolve);
        expect(plan.cmd).toBe('/usr/bin/systemd-run');
        expect(plan.args).toEqual(['--user', '--collect', '--unit=wsscrcpy-apply-1', prog, ...pArgs]);
        expect(plan.viaSystemd).toBe(true);
    });

    it('falls back to setsid (new session) when systemd-run is absent', () => {
        // only setsid resolves absolute; systemd-run stays bare (not found).
        const resolve = (t: string) => (t === 'setsid' ? '/usr/bin/setsid' : t);
        const plan = buildDetachedSpawn(prog, pArgs, { unit: 'wsscrcpy-apply-1' }, resolve);
        expect(plan.cmd).toBe('/usr/bin/setsid');
        expect(plan.args).toEqual([prog, ...pArgs]);
        expect(plan.viaSystemd).toBe(false);
    });

    it('falls back to a bare exec when neither systemd-run nor setsid exist', () => {
        const resolve = (t: string) => t; // nothing resolves to an absolute path
        const plan = buildDetachedSpawn(prog, pArgs, { unit: 'wsscrcpy-apply-1' }, resolve);
        expect(plan.cmd).toBe(prog);
        expect(plan.args).toEqual(pArgs);
        expect(plan.viaSystemd).toBe(false);
    });

    it('omits the --unit token when no unit is given', () => {
        const resolve = (t: string) => (t === 'systemd-run' ? '/usr/bin/systemd-run' : t);
        const plan = buildDetachedSpawn(prog, pArgs, {}, resolve);
        expect(plan.args).toEqual(['--user', '--collect', prog, ...pArgs]);
    });

    it('omits --user for the system manager when system:true (root system-scope apply)', () => {
        const resolve = (t: string) => (t === 'systemd-run' ? '/usr/bin/systemd-run' : t);
        const plan = buildDetachedSpawn(prog, pArgs, { unit: 'wsscrcpy-apply-1', system: true }, resolve);
        expect(plan.cmd).toBe('/usr/bin/systemd-run');
        expect(plan.args).toEqual(['--collect', '--unit=wsscrcpy-apply-1', prog, ...pArgs]);
        expect(plan.viaSystemd).toBe(true);
    });
});
