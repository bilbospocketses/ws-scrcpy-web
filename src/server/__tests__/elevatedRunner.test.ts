import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isElevationTimeout, parseResult, pollForResultFile, toSnakeCase } from '../service/elevatedRunner';

describe('toSnakeCase', () => {
    it('converts camelCase keys to snake_case at the top level', () => {
        const out = toSnakeCase({
            servyPath: 'a',
            displayName: 'b',
            maxRestartAttempts: 3,
        });
        expect(out).toEqual({
            servy_path: 'a',
            display_name: 'b',
            max_restart_attempts: 3,
        });
    });

    it('preserves all-lowercase keys unchanged', () => {
        const out = toSnakeCase({ name: 'X', envvars: 'a=b' });
        expect(out).toEqual({ name: 'X', envvars: 'a=b' });
    });

    it('handles empty object', () => {
        expect(toSnakeCase({})).toEqual({});
    });
});

describe('parseResult', () => {
    it('parses snake_case JSON (Rust default serde format)', () => {
        const json = JSON.stringify({
            ok: true,
            exit_code: 0,
            stdout: 'install ok',
            stderr: '',
        });
        const r = parseResult(json);
        expect(r).toEqual({
            ok: true,
            exitCode: 0,
            stdout: 'install ok',
            stderr: '',
            errorMessage: undefined,
        });
    });

    it('falls back to camelCase keys when present', () => {
        const json = JSON.stringify({
            ok: false,
            exitCode: 4,
            stdout: '',
            stderr: 'failed',
            errorMessage: 'servy-cli install exited with code 1',
        });
        const r = parseResult(json);
        expect(r.ok).toBe(false);
        expect(r.exitCode).toBe(4);
        expect(r.errorMessage).toBe('servy-cli install exited with code 1');
    });

    it('coerces missing fields to safe defaults', () => {
        const r = parseResult('{}');
        expect(r.ok).toBe(false);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe('');
        expect(r.stderr).toBe('');
        expect(r.errorMessage).toBeUndefined();
    });

    it('returns a structured failure for malformed JSON', () => {
        const r = parseResult('not json at all');
        expect(r.ok).toBe(false);
        expect(r.exitCode).toBe(-1);
        expect(r.errorMessage).toMatch(/could not parse/i);
        // Original raw string is preserved in stderr for debugging.
        expect(r.stderr).toBe('not json at all');
    });
});

// §30: removed the `describe('buildPsRunAsCommand', ...)` block — the
// builder + its 4 tests were dropped along with the PowerShell elevation
// path. The replacement (launcher `--request-uac` invoked via
// execFileAsync's array-form argv) doesn't need shell-escape tests because
// argv is passed as a JS string array, not joined into a shell command line.
// Exit-code mapping (0 vs 1223 vs other) is exercised end-to-end on Windows
// via the existing service install/uninstall flows; pure-unit coverage
// would require mocking the launcher subprocess, which would test the mock
// rather than the integration.

// #646. `--request-uac` blocks until the consent dialog is answered, and the
// await had no timeout — so an unanswered prompt (including Windows' own ~2
// minute auto-dismiss) never returned, leaving installMode at 'system-service'
// with no service until the app restarted. The wait is now bounded; these
// tests pin the part that decides what the user is told when it expires,
// because the wrong answer here is "you declined", which they did not.
describe('isElevationTimeout', () => {
    it('treats a child killed by our own timeout as a timeout', () => {
        // The shape Node rejects with when the `timeout` option fires.
        const err = Object.assign(new Error('Command failed: ...'), { killed: true, signal: 'SIGTERM' });
        expect(isElevationTimeout(err)).toBe(true);
    });

    it('does NOT treat a UAC decline as a timeout', () => {
        // ERROR_CANCELLED — the user clicked No. The helper exited on its own,
        // so `killed` is false and they get the decline message, not this one.
        const err = Object.assign(new Error('Command failed: ...'), { killed: false, code: 1223 });
        expect(isElevationTimeout(err)).toBe(false);
    });

    it('does NOT treat an unexpected non-zero exit as a timeout', () => {
        const err = Object.assign(new Error('Command failed: ...'), { code: 1 });
        expect(isElevationTimeout(err)).toBe(false);
    });

    it('is safe on a thrown value that carries nothing', () => {
        expect(isElevationTimeout(new Error('boom'))).toBe(false);
        expect(isElevationTimeout(undefined)).toBe(false);
        expect(isElevationTimeout(null)).toBe(false);
        expect(isElevationTimeout('a string')).toBe(false);
    });
});

describe('pollForResultFile', () => {
    let tmpDir: string;
    let resultPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elev-poll-'));
        resultPath = path.join(tmpDir, 'result.json');
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    });

    it('returns null after timeout when the result file never appears', async () => {
        // Use a tiny timeout for tests; sleep is real so the poll
        // exhausts in real time. 50ms total timeout, 10ms interval.
        const result = await pollForResultFile(resultPath, 50, 10);
        expect(result).toBeNull();
    });

    it('returns the parsed result once the file is written', async () => {
        // Write the result file 30ms after the poll starts. The poll
        // should pick it up on its next tick and return.
        setTimeout(() => {
            fs.writeFileSync(resultPath, JSON.stringify({ ok: true, exit_code: 0, stdout: 'done', stderr: '' }));
        }, 30);
        const result = await pollForResultFile(resultPath, 1000, 10);
        expect(result).not.toBeNull();
        expect(result!.ok).toBe(true);
        expect(result!.stdout).toBe('done');
    });

    it('tolerates a partially-written result file by waiting for the next tick', async () => {
        // Write partial JSON first, then complete it. Polling should
        // skip the partial version and return the complete one.
        fs.writeFileSync(resultPath, '{"ok":');
        setTimeout(() => {
            fs.writeFileSync(resultPath, JSON.stringify({ ok: true, exit_code: 0, stdout: '', stderr: '' }));
        }, 30);
        const result = await pollForResultFile(resultPath, 1000, 10);
        expect(result).not.toBeNull();
        expect(result!.ok).toBe(true);
    });

    it('returns immediately if the file already exists at start of poll', async () => {
        fs.writeFileSync(
            resultPath,
            JSON.stringify({ ok: false, exit_code: 4, stdout: '', stderr: 'err', error_message: 'boom' }),
        );
        const start = Date.now();
        const result = await pollForResultFile(resultPath, 5000, 10);
        const elapsed = Date.now() - start;
        expect(result).not.toBeNull();
        expect(result!.ok).toBe(false);
        expect(result!.errorMessage).toBe('boom');
        // Should resolve well under the timeout.
        expect(elapsed).toBeLessThan(500);
    });

    it('returns the result when its nonce matches the expected per-call nonce (#28)', async () => {
        fs.writeFileSync(
            resultPath,
            JSON.stringify({ ok: true, exit_code: 0, stdout: 'ok', stderr: '', nonce: 'good-nonce' }),
        );
        const result = await pollForResultFile(resultPath, 1000, 10, undefined, 'good-nonce');
        expect(result).not.toBeNull();
        expect(result!.ok).toBe(true);
    });

    it('rejects (times out on) a result whose nonce does not match — a spoofed/stale file (#28)', async () => {
        fs.writeFileSync(
            resultPath,
            JSON.stringify({ ok: true, exit_code: 0, stdout: 'spoofed', stderr: '', nonce: 'attacker-nonce' }),
        );
        const result = await pollForResultFile(resultPath, 80, 10, undefined, 'expected-nonce');
        expect(result).toBeNull();
    });
});
