import { describe, it, expect } from 'vitest';
import { resolveActiveSessionId } from '../active-session';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('resolveActiveSessionId', () => {
    it('returns the integer parsed from the helper exe stdout', async () => {
        // Create a stub script that prints a number and exits 0.
        const dir = mkdtempSync(join(tmpdir(), 'active-session-test-'));
        const stub = join(dir, 'stub.cmd');
        writeFileSync(stub, '@echo off\necho 1\nexit /b 0\n');
        const result = await resolveActiveSessionId(stub);
        expect(result).toEqual({ ok: true, sessionId: 1 });
    });

    it('returns ok:false when the helper exe is missing', async () => {
        const result = await resolveActiveSessionId('Z:\\does\\not\\exist.exe');
        expect(result.ok).toBe(false);
    });

    it('returns ok:false when stdout is not a number', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'active-session-test-'));
        const stub = join(dir, 'stub.cmd');
        writeFileSync(stub, '@echo off\necho hello\nexit /b 0\n');
        const result = await resolveActiveSessionId(stub);
        expect(result.ok).toBe(false);
    });
});
