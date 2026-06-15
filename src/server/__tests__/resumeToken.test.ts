import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    consumeToken,
    issueToken,
    purgeExpiredTokens,
} from '../service/resumeToken';

// Wrap a few node:fs writers in spies that still call through to the real
// implementation, so #30 can assert the *intent* (mode 0700/0600 + atomic
// tmp→rename) OS-independently — Windows mode bits are synthetic, and ESM
// namespaces can't be vi.spyOn'd directly.
const fsSpies = vi.hoisted(() => ({
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
            fsSpies.mkdirSync(...args);
            return actual.mkdirSync(...args);
        },
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
            fsSpies.writeFileSync(...args);
            return actual.writeFileSync(...args);
        },
        renameSync: (...args: Parameters<typeof actual.renameSync>) => {
            fsSpies.renameSync(...args);
            return actual.renameSync(...args);
        },
    };
});

describe('resumeToken', () => {
    let installRoot: string;

    beforeEach(() => {
        installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-resume-'));
    });

    afterEach(() => {
        try {
            fs.rmSync(installRoot, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    });

    it('issued token validates and consumes successfully', () => {
        const token = issueToken(installRoot, 'uninstall-service');
        expect(token).toMatch(/^[a-f0-9]{32}$/);
        const record = consumeToken(installRoot, token, 'uninstall-service');
        expect(record).not.toBeNull();
        expect(record!.action).toBe('uninstall-service');
    });

    it('token is single-use — second consume returns null', () => {
        const token = issueToken(installRoot, 'uninstall-service');
        const first = consumeToken(installRoot, token, 'uninstall-service');
        expect(first).not.toBeNull();
        const second = consumeToken(installRoot, token, 'uninstall-service');
        expect(second).toBeNull();
    });

    it('rejects expired tokens (older than 10 minutes)', () => {
        const past = Date.now() - 11 * 60 * 1000;
        const token = issueToken(installRoot, 'uninstall-service', past);
        const record = consumeToken(installRoot, token, 'uninstall-service');
        expect(record).toBeNull();
    });

    it('accepts tokens at the 9:59 mark', () => {
        const past = Date.now() - 9 * 60 * 1000 - 59 * 1000;
        const token = issueToken(installRoot, 'uninstall-service', past);
        const record = consumeToken(installRoot, token, 'uninstall-service');
        expect(record).not.toBeNull();
    });

    it('rejects nonexistent tokens', () => {
        const fake = '0123456789abcdef0123456789abcdef';
        expect(consumeToken(installRoot, fake, 'uninstall-service')).toBeNull();
    });

    it('rejects malformed tokens (path traversal attempt)', () => {
        // The token is used to construct a filesystem path. A malicious
        // value like "../etc/passwd" must be rejected before it reaches
        // the filesystem.
        expect(consumeToken(installRoot, '../etc/passwd', 'uninstall-service')).toBeNull();
        expect(consumeToken(installRoot, '../../something', 'uninstall-service')).toBeNull();
    });

    it('rejects tokens of incorrect length', () => {
        expect(consumeToken(installRoot, 'short', 'uninstall-service')).toBeNull();
        expect(
            consumeToken(installRoot, '0'.repeat(64), 'uninstall-service'),
        ).toBeNull();
    });

    it('purgeExpiredTokens removes expired entries and keeps fresh ones', () => {
        const past = Date.now() - 11 * 60 * 1000;
        const fresh = Date.now() - 1 * 60 * 1000;
        issueToken(installRoot, 'uninstall-service', past);
        issueToken(installRoot, 'uninstall-service', fresh);

        const tokenFiles = () =>
            fs.readdirSync(path.join(installRoot, '.resume-tokens'));
        expect(tokenFiles()).toHaveLength(2);

        purgeExpiredTokens(installRoot);
        expect(tokenFiles()).toHaveLength(1);
    });

    it('purgeExpiredTokens is a no-op when the token directory does not exist', () => {
        // Fresh installRoot has no .resume-tokens dir yet.
        expect(() => purgeExpiredTokens(installRoot)).not.toThrow();
    });

    it('writes the token atomically (tmp + rename) into an owner-restricted dir (#30)', () => {
        fsSpies.mkdirSync.mockClear();
        fsSpies.renameSync.mockClear();
        fsSpies.writeFileSync.mockClear();
        const token = issueToken(installRoot, 'uninstall-service');
        // Directory created owner-only (0700).
        expect(fsSpies.mkdirSync).toHaveBeenCalledWith(
            path.join(installRoot, '.resume-tokens'),
            expect.objectContaining({ recursive: true, mode: 0o700 }),
        );
        // Atomic write: a temp file renamed into place (never a partial token).
        expect(fsSpies.renameSync).toHaveBeenCalledTimes(1);
        // Token file written owner-only (0600).
        expect(fsSpies.writeFileSync).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            expect.objectContaining({ mode: 0o600 }),
        );
        // Round-trip still works through the atomic write.
        expect(consumeToken(installRoot, token, 'uninstall-service')).not.toBeNull();
    });
});
