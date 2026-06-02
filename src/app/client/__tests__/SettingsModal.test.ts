import { describe, it, expect } from 'vitest';
import { uninstallFollowupMessage, classifyInstallPoll } from '../SettingsModal';

describe('uninstallFollowupMessage', () => {
    it('user scope -> reconnect/relaunch message', () => {
        expect(uninstallFollowupMessage('user')).toMatch(/relaunch|reconnect|local/i);
    });
    it('system scope -> service removed message', () => {
        expect(uninstallFollowupMessage('system')).toMatch(/removed|stopped/i);
    });
});

describe('classifyInstallPoll', () => {
    const base = { reachable: true, configMtime: 100, baselineMtime: 100, diskWebPort: null, iterations: 1, maxIterations: 30 };
    it('navigates when config mtime changed + port known (the existing Windows path)', () => {
        expect(classifyInstallPoll({ ...base, configMtime: 200, diskWebPort: 8002 })).toEqual({ kind: 'navigate', port: 8002 });
    });
    it('reconnects (not errors) when the local server becomes unreachable - same-port handoff', () => {
        expect(classifyInstallPoll({ ...base, reachable: false })).toEqual({ kind: 'reconnect' });
    });
    it('keeps polling while reachable + no config change', () => {
        expect(classifyInstallPoll(base)).toEqual({ kind: 'keep-polling' });
    });
    it('times out after maxIterations', () => {
        expect(classifyInstallPoll({ ...base, iterations: 31 })).toEqual({ kind: 'timeout' });
    });
});
