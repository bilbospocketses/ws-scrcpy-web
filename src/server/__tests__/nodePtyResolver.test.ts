import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveNodePty, getNodePty, _resetForTest } from '../NodePtyResolver';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as os from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';

describe('NodePtyResolver', () => {
    beforeEach(() => {
        _resetForTest();
        vi.restoreAllMocks();
    });

    it('getNodePty returns undefined before resolveNodePty is called', () => {
        expect(getNodePty()).toBeUndefined();
    });

    it('resolveNodePty returns { available: true } when homebridge require succeeds', async () => {
        // Default happy path — the test host should have homebridge installed
        // with a working prebuilt for its own ABI.
        const depsPath = path.join(os.tmpdir(), 'ws-scrcpy-web-test-deps-' + Date.now());
        const handle = await resolveNodePty(depsPath);
        expect(handle.available).toBe(true);
        expect(handle.pty).toBeDefined();
        expect(typeof (handle.pty as any).spawn).toBe('function');
    });

    it('getNodePty returns the resolved handle after resolveNodePty completes', async () => {
        const depsPath = path.join(os.tmpdir(), 'ws-scrcpy-web-test-deps-' + Date.now());
        await resolveNodePty(depsPath);
        const handle = getNodePty();
        expect(handle?.available).toBe(true);
    });

    it('resolveNodePty caches and returns the same handle on subsequent calls', async () => {
        const depsPath = path.join(os.tmpdir(), 'ws-scrcpy-web-test-deps-' + Date.now());
        const first = await resolveNodePty(depsPath);
        const second = await resolveNodePty(depsPath);
        expect(second).toBe(first);
    });
});
