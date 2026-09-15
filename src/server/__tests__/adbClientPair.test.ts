import { inspect } from 'util';
import { describe, expect, it, vi } from 'vitest';
import { AdbClient, AdbExecError, DEFAULT_TIMEOUT_MS, PairingError, parsePairGuid } from '../AdbClient';

const SECRET = 'hunter2hunter2';

/**
 * Whole-object leak guard. Asserting only on `message` and `stack` would let a
 * future `err.args = …` / `err.stdout = …` carry the password past this test,
 * so check every own property, enumerable or not, at any depth.
 */
function expectNoSecretAnywhere(err: PairingError): void {
    expect(inspect(err, { depth: null })).not.toContain(SECRET);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(SECRET);
}

/**
 * `exec` is private, so it is not in `keyof AdbClient` and `vi.spyOn` cannot
 * see it. Casting through `unknown` to its real shape keeps the same object
 * reference — the spy still patches the live instance — while giving the
 * returned MockInstance a usable type. (`client as never` compiles under
 * esbuild but fails `tsc --noEmit`: `mockRejectedValue` does not exist on
 * `never`.)
 */
interface ExecTarget {
    exec(args: string[], opts?: { timeoutMs?: number }): Promise<string>;
}

function execOf(client: AdbClient): ExecTarget {
    return client as unknown as ExecTarget;
}

describe('parsePairGuid', () => {
    it('extracts the guid adb prints on success', () => {
        expect(parsePairGuid('Successfully paired to 192.168.86.190:41415 [guid=adb-5C061JEA327610-bo0E0q]')).toBe(
            'adb-5C061JEA327610-bo0E0q',
        );
    });

    it('returns undefined when adb printed no guid', () => {
        expect(parsePairGuid('Successfully paired to 192.168.86.190:41415')).toBeUndefined();
    });
});

describe('AdbClient.pair', () => {
    // The spy assertion below compares against DEFAULT_TIMEOUT_MS.pair on both
    // sides, so it proves pair() passes the *pair* budget (not connect's, not
    // undefined) but moves with the constant and cannot pin its value. This
    // does — a literal on one side is what makes the 20 s deliberate.
    it('budgets pairing at 20s, longer than connect', () => {
        expect(DEFAULT_TIMEOUT_MS.pair).toBe(20_000);
        expect(DEFAULT_TIMEOUT_MS.pair).toBeGreaterThan(DEFAULT_TIMEOUT_MS.connect);
    });

    it('does not leak the pairing code when adb fails', async () => {
        const client = new AdbClient('C:/fake/adb.exe');
        // The real hazard: AdbExecError interpolates args.join(' ') into its
        // message, so the raw error text contains the code.
        const raw = new AdbExecError('exit', 'C:/fake/adb.exe', ['pair', '1.2.3.4:5555', SECRET]);
        expect(raw.message).toContain(SECRET); // proves the hazard is real
        const spy = vi.spyOn(execOf(client), 'exec').mockRejectedValue(raw);

        const err = await client.pair('1.2.3.4:5555', SECRET).catch((e: unknown) => e);
        // Without this the test is vacuous: had the spy failed to patch, the
        // real exec would ENOENT, still produce 'unknown', and still pass. It
        // also pins the pair timeout budget, which nothing else asserts.
        expect(spy).toHaveBeenCalledWith(['pair', '1.2.3.4:5555', SECRET], { timeoutMs: DEFAULT_TIMEOUT_MS.pair });
        expect(err).toBeInstanceOf(PairingError);
        const pairingError = err as PairingError;
        expectNoSecretAnywhere(pairingError);
        expect(pairingError.kind).toBe('unknown');
        expect(pairingError.cause).toBeUndefined();
    });

    it('reports an adb pair timeout as kind timeout, still without the code', async () => {
        const client = new AdbClient('C:/fake/adb.exe');
        const raw = new AdbExecError('timeout', 'C:/fake/adb.exe', ['pair', '1.2.3.4:5555', SECRET]);
        expect(raw.message).toContain(SECRET); // the timeout branch leaks too
        vi.spyOn(execOf(client), 'exec').mockRejectedValue(raw);

        const err = await client.pair('1.2.3.4:5555', SECRET).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PairingError);
        const pairingError = err as PairingError;
        expect(pairingError.kind).toBe('timeout');
        // Covers the OTHER arm of the catch's ternary — redaction must hold on
        // both, not just the one the leak test above exercises.
        expectNoSecretAnywhere(pairingError);
        expect(pairingError.cause).toBeUndefined();
    });

    it('does not report a daemon start-server timeout as a pairing timeout', async () => {
        const client = new AdbClient('C:/fake/adb.exe');
        // exec() awaits daemon.ensureReady() before running our argv, and that
        // throws its own timeout when adb never came up. Calling that a pairing
        // timeout would send the user back to the phone for a fresh code
        // against a daemon that is not running.
        const raw = new AdbExecError('timeout', 'C:/fake/adb.exe', ['start-server']);
        vi.spyOn(execOf(client), 'exec').mockRejectedValue(raw);

        const err = await client.pair('1.2.3.4:5555', SECRET).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PairingError);
        expect((err as PairingError).kind).toBe('unknown');
    });

    it('returns adb stdout on success', async () => {
        const client = new AdbClient('C:/fake/adb.exe');
        vi.spyOn(execOf(client), 'exec').mockResolvedValue('Successfully paired to 1.2.3.4:5555 [guid=adb-X]');
        await expect(client.pair('1.2.3.4:5555', SECRET)).resolves.toContain('Successfully paired');
    });

    it('treats an adb success exit whose text is a failure as a failure', async () => {
        const client = new AdbClient('C:/fake/adb.exe');
        vi.spyOn(execOf(client), 'exec').mockResolvedValue('Failed: wrong code');
        await expect(client.pair('1.2.3.4:5555', SECRET)).rejects.toMatchObject({
            name: 'PairingError',
            kind: 'refused',
        });
    });
});
