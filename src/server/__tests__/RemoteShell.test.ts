import { describe, it, expect } from 'vitest';
import { buildShellEnv } from '../goog-device/mw/RemoteShell';

// #29 — the device-shell PTY must NOT inherit the server's full process.env
// (which may carry app/user secrets). buildShellEnv allowlists only the OS +
// adb + terminal essentials.
describe('buildShellEnv (#29)', () => {
    it('keeps OS/terminal essentials but drops arbitrary (potentially secret) env vars', () => {
        const env = buildShellEnv({
            PATH: '/usr/bin:/bin',
            SECRET_TOKEN: 'super-secret',
            AWS_SECRET_ACCESS_KEY: 'leak-me',
            WS_SCRCPY_INTERNAL: 'x',
        });
        expect(env['PATH']).toBe('/usr/bin:/bin');
        expect(env['TERM']).toBe('xterm-256color');
        expect(env['COLORTERM']).toBe('truecolor');
        // The whole point of #29: arbitrary env (secrets) must not pass through.
        expect(env['SECRET_TOKEN']).toBeUndefined();
        expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
        expect(env['WS_SCRCPY_INTERNAL']).toBeUndefined();
    });
});
