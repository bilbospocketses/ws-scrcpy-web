import { describe, it, expect } from 'vitest';
import { resolveSystemTool } from './systemTools';

describe('resolveSystemTool', () => {
    it('returns the first candidate that exists', () => {
        const exists = (p: string) => p === '/usr/bin/systemctl';
        expect(resolveSystemTool('systemctl', exists)).toBe('/usr/bin/systemctl');
    });

    it('prefers /usr/bin over /bin when both exist', () => {
        const exists = (p: string) => p === '/usr/bin/pkexec' || p === '/bin/pkexec';
        expect(resolveSystemTool('pkexec', exists)).toBe('/usr/bin/pkexec');
    });

    it('checks sbin locations for admin tools (semanage/restorecon)', () => {
        const exists = (p: string) => p === '/usr/sbin/semanage';
        expect(resolveSystemTool('semanage', exists)).toBe('/usr/sbin/semanage');
    });

    it('falls back to the bare name when no absolute path exists', () => {
        const exists = (_p: string) => false;
        expect(resolveSystemTool('systemctl', exists)).toBe('systemctl');
    });
});
