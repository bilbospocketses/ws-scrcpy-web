import { describe, expect, it, vi } from 'vitest';
import { AdbClient, AdbExecError, PairingError, parsePairGuid } from '../AdbClient';

const SECRET = 'hunter2hunter2';

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
    it('does not leak the pairing code when adb fails', async () => {
        const client = new AdbClient('C:/fake/adb.exe');
        // The real hazard: AdbExecError interpolates args.join(' ') into its
        // message, so the raw error text contains the code.
        const raw = new AdbExecError('exit', 'C:/fake/adb.exe', ['pair', '1.2.3.4:5555', SECRET]);
        expect(raw.message).toContain(SECRET); // proves the hazard is real
        vi.spyOn(execOf(client), 'exec').mockRejectedValue(raw);

        const err = await client.pair('1.2.3.4:5555', SECRET).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PairingError);
        const pairingError = err as PairingError;
        expect(JSON.stringify({ m: pairingError.message, s: pairingError.stack })).not.toContain(SECRET);
        expect(pairingError.cause).toBeUndefined();
    });

    it('returns adb stdout on success', async () => {
        const client = new AdbClient('C:/fake/adb.exe');
        vi.spyOn(execOf(client), 'exec').mockResolvedValue('Successfully paired to 1.2.3.4:5555 [guid=adb-X]');
        await expect(client.pair('1.2.3.4:5555', SECRET)).resolves.toContain('Successfully paired');
    });

    it('treats an adb success exit whose text is a failure as a failure', async () => {
        const client = new AdbClient('C:/fake/adb.exe');
        vi.spyOn(execOf(client), 'exec').mockResolvedValue('Failed: wrong code');
        await expect(client.pair('1.2.3.4:5555', SECRET)).rejects.toBeInstanceOf(PairingError);
    });
});
