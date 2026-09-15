# Wireless Pairing (QR + Pairing Code) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pair an Android 11+ device with ws-scrcpy-web by scanning a QR code or typing a pairing code, then auto-connect it — closing the hole where discovery works but connection is structurally impossible.

**Architecture:** A `PairingSession` holds one session's state and secret with no I/O, so its lifecycle is unit-testable with a fake clock. A `PairingService` singleton owns the single active session, polls `adb mdns services` for the exact service name the QR advertised, drives `adb pair`, then auto-connects. A vendored zero-dependency QR encoder renders to SVG server-side so the pairing password never crosses the wire as readable JSON.

**Tech Stack:** TypeScript, Node 24, vitest, the app's bundled adb 37.0.1 (`dependencies/adb/adb.exe`), existing `AdbClient`.

**Spec:** `docs/superpowers/specs/2026-09-15-qr-pairing-design.md`

## Global Constraints

- **Runtime dependency count stays at 2** (`velopack`, `ws`). No new entry in `package.json` `dependencies`. The QR encoder is vendored source, not a package.
- **The pairing password must never appear in:** an error message, a log line, an HTTP response body, or the DB. `AdbExecError` interpolates `args.join(' ')` into its message, so this is an active hazard, not a precaution.
- **Match the pairing service by exact name**, never "any `_adb-tls-pairing._tcp` on the network".
- **Session TTL is 180 s.** One active session at a time; replacement, cancel or expiry makes prior work inert.
- **Local-Dependencies-Only:** adb is always `Config.getInstance().adbPath`. Never a bare `adb`.
- **Branch:** `feat/wssw-qr-pairing`, stacked on `feat/wssw-live-rotation` (user's call, so one build carries both this and item 24 for a single combined device test).
- **Commit style:** conventional commits. No AI attribution lines.
- **Tests:** vitest. Server tests live in `src/server/__tests__/`, named `<subject>.test.ts`.

---

### Task 1: Vendored QR encoder

**Files:**
- Create: `src/server/pairing/qr.ts`
- Test: `src/server/__tests__/pairingQr.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `encodeQrSvg(text: string, opts?: { moduleSize?: number; margin?: number }): string` — returns a complete `<svg>…</svg>` string. Throws `Error` if `text` is empty or too long for version 10.

**Implementation note — this is the one task with real algorithmic risk.** Do not invent a QR encoder. Port Nayuki's public-domain "QR Code generator" reference implementation (MIT), keeping **byte mode only** and dropping kanji/alphanumeric/ECI. Preserve its MIT header comment at the top of the file verbatim — it is a licence condition and the reason this is legal to vendor. Use ECC level **M** and let the version float between 1 and 10; the payload is ~60 chars so it will land around version 3.

- [ ] **Step 1: Write the failing known-answer test**

A hand-checked matrix is the only thing that proves a QR encoder is correct; "it produced some SVG" proves nothing.

```ts
import { describe, expect, it } from 'vitest';
import { encodeQrSvg } from '../pairing/qr';

describe('encodeQrSvg', () => {
    it('emits an svg sized for the module count', () => {
        const svg = encodeQrSvg('WIFI:T:ADB;S:wsscrcpy-abc;P:secret123;;');
        expect(svg.startsWith('<svg')).toBe(true);
        expect(svg.endsWith('</svg>')).toBe(true);
        // viewBox is "0 0 N N" where N = modules + 2*margin. Square, and odd
        // module counts are impossible for QR (always 4*v+17, always odd).
        const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
        expect(m).not.toBeNull();
        expect(m![1]).toBe(m![2]);
    });

    it('is deterministic for the same input', () => {
        const a = encodeQrSvg('WIFI:T:ADB;S:x;P:y;;');
        const b = encodeQrSvg('WIFI:T:ADB;S:x;P:y;;');
        expect(a).toBe(b);
    });

    it('changes when the payload changes', () => {
        expect(encodeQrSvg('WIFI:T:ADB;S:x;P:y;;')).not.toBe(encodeQrSvg('WIFI:T:ADB;S:x;P:z;;'));
    });

    it('refuses empty input rather than emitting a blank code', () => {
        expect(() => encodeQrSvg('')).toThrow(/empty/i);
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- pairingQr`
Expected: FAIL — `Cannot find module '../pairing/qr'`.

- [ ] **Step 3: Port the encoder**

Create `src/server/pairing/qr.ts` with the MIT header preserved, byte mode only, ECC level M, versions 1–10. Export `encodeQrSvg`, which builds the module matrix and serialises it as one `<path>` of black squares on a white `<rect>`:

```ts
export function encodeQrSvg(text: string, opts: { moduleSize?: number; margin?: number } = {}): string {
    if (!text) throw new Error('encodeQrSvg: refusing to encode an empty payload');
    const margin = opts.margin ?? 4;
    const modules = buildMatrix(text); // boolean[][] from the ported encoder
    const n = modules.length + margin * 2;
    let path = '';
    for (let y = 0; y < modules.length; y++) {
        for (let x = 0; x < modules.length; x++) {
            if (modules[y]![x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
        }
    }
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
        `<rect width="${n}" height="${n}" fill="#fff"/>` +
        `<path d="${path}" fill="#000"/>` +
        `</svg>`
    );
}
```

- [ ] **Step 4: Verify against a real scanner before trusting the tests**

Write the SVG of `WIFI:T:ADB;S:test;P:test;;` to a scratch file, open it, and scan it with a phone camera. It must decode to that exact string. **A unit test cannot tell you the matrix is scannable** — only a scanner can, and a subtly wrong mask or format-info block still produces a plausible-looking square.

- [ ] **Step 5: Run the tests**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- pairingQr`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/pairing/qr.ts src/server/__tests__/pairingQr.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(pairing): vendor a zero-dependency QR encoder"
```

---

### Task 2: PairingSession — state machine, no I/O

**Files:**
- Create: `src/server/pairing/PairingSession.ts`
- Test: `src/server/__tests__/pairingSession.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PairingState = 'awaiting-scan' | 'pairing' | 'connecting' | 'paired' | 'paired-not-connected' | 'failed' | 'expired'`
  - `type PairingMode = 'qr' | 'code'`
  - `class PairingSession` with `readonly id: string`, `readonly mode: PairingMode`, `readonly serviceName: string` (empty for `'code'`), `readonly password: string`, `readonly expiresAt: number`, `get state(): PairingState`, `get message(): string | undefined`, `get serial(): string | undefined`, `get address(): string | undefined`, and methods `isExpired(now: number): boolean`, `toStatus(now: number): { state: PairingState; message?: string; serial?: string; address?: string }`, `markPairing()`, `markConnecting(serial: string | undefined, address: string)`, `markPaired()`, `markPairedNotConnected(message: string)`, `markFailed(message: string)`, `cancel()`.
  - `function newSession(mode: PairingMode, now: number, random?: () => Buffer): PairingSession`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { newSession, PairingSession } from '../pairing/PairingSession';

const T0 = 1_700_000_000_000;

describe('PairingSession', () => {
    it('starts awaiting-scan in qr mode and carries a service name and password', () => {
        const s = newSession('qr', T0);
        expect(s.state).toBe('awaiting-scan');
        expect(s.serviceName).toMatch(/^wsscrcpy-[a-z2-7]{10}$/);
        expect(s.password).toHaveLength(12);
        expect(s.expiresAt).toBe(T0 + 180_000);
    });

    it('skips awaiting-scan in code mode', () => {
        expect(newSession('code', T0).state).toBe('pairing');
    });

    it('expires exactly at the TTL boundary', () => {
        const s = newSession('qr', T0);
        expect(s.isExpired(T0 + 179_999)).toBe(false);
        expect(s.isExpired(T0 + 180_000)).toBe(true);
    });

    it('reports expired through toStatus without needing a timer', () => {
        const s = newSession('qr', T0);
        expect(s.toStatus(T0 + 200_000).state).toBe('expired');
    });

    it('never reports expired once it has reached a terminal state', () => {
        // A session that PAIRED before the clock ran out is paired, full stop.
        // Reporting it as expired would tell the user to pair a device that is
        // already paired.
        const s = newSession('qr', T0);
        s.markPairing();
        s.markConnecting('SERIAL1', '192.168.1.5:5555');
        s.markPaired();
        expect(s.toStatus(T0 + 200_000).state).toBe('paired');
    });

    it('distinguishes paired-not-connected from failed', () => {
        const s = newSession('qr', T0);
        s.markPairing();
        s.markPairedNotConnected('no connect service found');
        const st = s.toStatus(T0);
        expect(st.state).toBe('paired-not-connected');
        expect(st.message).toContain('no connect service');
    });

    it('never exposes the password through toStatus, in any state', () => {
        for (const drive of [
            (s: PairingSession) => s.markFailed('boom'),
            (s: PairingSession) => s.markPaired(),
            (s: PairingSession) => s.cancel(),
        ]) {
            const s = newSession('qr', T0);
            drive(s);
            expect(JSON.stringify(s.toStatus(T0))).not.toContain(s.password);
        }
    });

    it('gives two sessions different secrets', () => {
        expect(newSession('qr', T0).password).not.toBe(newSession('qr', T0).password);
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- pairingSession`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { randomBytes } from 'crypto';

export type PairingState =
    | 'awaiting-scan' | 'pairing' | 'connecting'
    | 'paired' | 'paired-not-connected' | 'failed' | 'expired';
export type PairingMode = 'qr' | 'code';

export const PAIRING_TTL_MS = 180_000;
const TERMINAL: ReadonlySet<PairingState> = new Set(['paired', 'paired-not-connected', 'failed', 'expired']);
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const PW = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function pick(alphabet: string, len: number, random: () => Buffer): string {
    const bytes = random();
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
    return out;
}

export class PairingSession {
    private _state: PairingState;
    private _message?: string;
    private _serial?: string;
    private _address?: string;

    constructor(
        readonly id: string,
        readonly mode: PairingMode,
        readonly serviceName: string,
        readonly password: string,
        readonly expiresAt: number,
    ) {
        this._state = mode === 'qr' ? 'awaiting-scan' : 'pairing';
    }

    get state(): PairingState { return this._state; }
    get message(): string | undefined { return this._message; }
    get serial(): string | undefined { return this._serial; }
    get address(): string | undefined { return this._address; }

    isExpired(now: number): boolean {
        return !TERMINAL.has(this._state) && now >= this.expiresAt;
    }

    /** Never returns the password or the QR payload, in any state. */
    toStatus(now: number): { state: PairingState; message?: string; serial?: string; address?: string } {
        const state = this.isExpired(now) ? 'expired' : this._state;
        return { state, message: this._message, serial: this._serial, address: this._address };
    }

    markPairing(): void { this._state = 'pairing'; }
    markConnecting(serial: string | undefined, address: string): void {
        this._state = 'connecting';
        this._serial = serial;
        this._address = address;
    }
    markPaired(): void { this._state = 'paired'; }
    markPairedNotConnected(message: string): void { this._state = 'paired-not-connected'; this._message = message; }
    markFailed(message: string): void { this._state = 'failed'; this._message = message; }
    cancel(): void { if (!TERMINAL.has(this._state)) { this._state = 'failed'; this._message = 'cancelled'; } }
}

export function newSession(mode: PairingMode, now: number, random: () => Buffer = () => randomBytes(64)): PairingSession {
    return new PairingSession(
        pick(B32, 16, random),
        mode,
        mode === 'qr' ? `wsscrcpy-${pick(B32, 10, random)}` : '',
        pick(PW, 12, random),
        now + PAIRING_TTL_MS,
    );
}
```

- [ ] **Step 4: Run the tests**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- pairingSession`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/pairing/PairingSession.ts src/server/__tests__/pairingSession.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(pairing): add the pairing session state machine"
```

---

### Task 3: AdbClient.pair() with redaction

**Files:**
- Modify: `src/server/AdbClient.ts` (add `pair` to `DEFAULT_TIMEOUT_MS`, add the `pair()` method, export `PairingError`)
- Test: `src/server/__tests__/adbClientPair.test.ts`

**Interfaces:**
- Consumes: the existing private `exec(args, opts)`.
- Produces:
  - `class PairingError extends Error { constructor(readonly kind: 'timeout' | 'refused' | 'unknown', message: string) }`
  - `AdbClient.pair(address: string, code: string): Promise<string>` — resolves with adb's stdout on success; throws `PairingError` on any failure, **carrying no args and no cause chain**.
  - `export function parsePairGuid(output: string): string | undefined`

- [ ] **Step 1: Write the failing test**

The redaction test is the point of this task.

```ts
import { describe, expect, it, vi } from 'vitest';
import { AdbClient, AdbExecError, parsePairGuid, PairingError } from '../AdbClient';

const SECRET = 'hunter2hunter2';

describe('parsePairGuid', () => {
    it('extracts the guid adb prints on success', () => {
        expect(parsePairGuid('Successfully paired to 192.168.86.190:41415 [guid=adb-5C061JEA327610-bo0E0q]'))
            .toBe('adb-5C061JEA327610-bo0E0q');
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
        vi.spyOn(client as never, 'exec').mockRejectedValue(raw);

        const err = await client.pair('1.2.3.4:5555', SECRET).catch((e) => e);
        expect(err).toBeInstanceOf(PairingError);
        expect(JSON.stringify({ m: err.message, s: err.stack })).not.toContain(SECRET);
        expect((err as PairingError).cause).toBeUndefined();
    });

    it('returns adb stdout on success', async () => {
        const client = new AdbClient('C:/fake/adb.exe');
        vi.spyOn(client as never, 'exec').mockResolvedValue('Successfully paired to 1.2.3.4:5555 [guid=adb-X]');
        await expect(client.pair('1.2.3.4:5555', SECRET)).resolves.toContain('Successfully paired');
    });

    it('treats an adb success exit whose text is a failure as a failure', async () => {
        const client = new AdbClient('C:/fake/adb.exe');
        vi.spyOn(client as never, 'exec').mockResolvedValue('Failed: wrong code');
        await expect(client.pair('1.2.3.4:5555', SECRET)).rejects.toBeInstanceOf(PairingError);
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- adbClientPair`
Expected: FAIL — `PairingError` / `parsePairGuid` are not exported.

- [ ] **Step 3: Implement**

Add `pair: 20_000` to `DEFAULT_TIMEOUT_MS` (pairing involves a TLS handshake and user-paced input, so it gets longer than `connect`'s 8 s), then:

```ts
export class PairingError extends Error {
    constructor(readonly kind: 'timeout' | 'refused' | 'unknown', message: string) {
        super(message);
        this.name = 'PairingError';
    }
}

export function parsePairGuid(output: string): string | undefined {
    return /\[guid=([^\]]+)\]/.exec(output)?.[1];
}
```

and on `AdbClient`:

```ts
/**
 * Pair with a device. NEVER lets the pairing code escape.
 *
 * AdbExecError builds its message from `args.join(' ')`, so letting one
 * propagate from here would put the pairing password into every log that
 * catches it. This method is the redaction boundary: it swallows the original
 * error entirely — no args, no cause chain — and throws a PairingError whose
 * message names only the failure kind.
 */
async pair(address: string, code: string): Promise<string> {
    let out: string;
    try {
        out = await this.exec(['pair', address, code], { timeoutMs: DEFAULT_TIMEOUT_MS.pair });
    } catch (e) {
        const kind = e instanceof AdbExecError && e.kind === 'timeout' ? 'timeout' : 'unknown';
        throw new PairingError(kind, `adb pair failed (${kind})`);
    }
    // adb exits 0 while printing a failure for a wrong code, so the exit code
    // is not the signal — the text is.
    if (!/successfully paired/i.test(out)) {
        throw new PairingError('refused', 'pairing refused — check the code and that the phone is still on the pairing screen');
    }
    return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- adbClientPair`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/AdbClient.ts src/server/__tests__/adbClientPair.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(pairing): add AdbClient.pair with a redacting error boundary"
```

---

### Task 4: PairingService — discovery, pairing, auto-connect

**Files:**
- Create: `src/server/pairing/PairingService.ts`
- Test: `src/server/__tests__/pairingService.test.ts`

**Interfaces:**
- Consumes: `newSession`, `PairingSession`, `PairingState` (Task 2); `AdbClient.pair`, `parsePairGuid`, `PairingError` (Task 3); existing `AdbClient.mdnsServices()`, `AdbClient.connect()`, `MdnsDevice`.
- Produces: `class PairingService` with:
  - `static getInstance(): PairingService` — production singleton, built with the real `AdbClient` and `Date.now`.
  - `constructor(deps: PairingDeps)` — **public**, so tests build one directly instead of mutating a singleton.
  - `startQr(): { sessionId: string; payload: string; expiresAt: number }`
  - `startCode(address: string, code: string): { sessionId: string }`
  - `status(sessionId: string): PairingStatus | undefined` — `undefined` for any id that is not the current session.
  - `cancel(sessionId: string): void`
  - `pollOnce(): Promise<void>` — **public on purpose.** One discovery tick. Production drives it on a timer; tests call it directly so no test needs fake timers.
  - `stop(): void` — clears the timer and drops the session.
- Types this task defines:

```ts
export type PairingStatus = ReturnType<PairingSession['toStatus']>;

export interface PairingDeps {
    adb: Pick<AdbClient, 'pair' | 'mdnsServices' | 'connect'>;
    now: () => number;
    setTimeoutFn?: typeof setTimeout;
}
```

**Note:** `startQr` returns the **payload** to its in-process caller (the API layer turns it into SVG and discards the string). The payload never leaves the server as text.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { PairingService } from '../pairing/PairingService';

const PAIR_SVC = '_adb-tls-pairing._tcp';
const CONNECT_SVC = '_adb-tls-connect._tcp';

function makeService(over: Partial<Parameters<typeof PairingService.prototype.constructor>[0]> = {}) {
    const adb = {
        pair: vi.fn().mockResolvedValue('Successfully paired to 10.0.0.5:41415 [guid=adb-SER1-xx]'),
        mdnsServices: vi.fn().mockResolvedValue([]),
        connect: vi.fn().mockResolvedValue('connected to 10.0.0.5:43777'),
    };
    let t = 1_000;
    const svc = new PairingService({ adb, now: () => t, ...over } as never);
    return { svc, adb, advance: (ms: number) => { t += ms; } };
}

describe('PairingService', () => {
    it('builds the Android WIFI:T:ADB payload from the session', () => {
        const { svc } = makeService();
        const { payload } = svc.startQr();
        expect(payload).toMatch(/^WIFI:T:ADB;S:wsscrcpy-[a-z2-7]{10};P:[A-Za-z0-9]{12};;$/);
    });

    it('ignores a pairing service advertised under a DIFFERENT name', async () => {
        const { svc, adb } = makeService();
        svc.startQr();
        adb.mdnsServices.mockResolvedValue([
            { name: 'wsscrcpy-someoneelse', service: PAIR_SVC, address: '10.0.0.9', port: 41415 },
        ]);
        await svc.pollOnce();
        expect(adb.pair).not.toHaveBeenCalled();
    });

    it('pairs against the exact advertised name, then auto-connects by guid', async () => {
        const { svc, adb } = makeService();
        const { sessionId, payload } = svc.startQr();
        const name = /S:([^;]+)/.exec(payload)![1]!;
        adb.mdnsServices.mockResolvedValue([
            { name, service: PAIR_SVC, address: '10.0.0.5', port: 41415 },
            { name: 'adb-SER1-xx', service: CONNECT_SVC, address: '10.0.0.5', port: 43777 },
        ]);
        await svc.pollOnce();
        expect(adb.pair).toHaveBeenCalledWith('10.0.0.5:41415', expect.any(String));
        expect(adb.connect).toHaveBeenCalledWith('10.0.0.5:43777');
        expect(svc.status(sessionId)!.state).toBe('paired');
    });

    it('falls back to the same IP when the guid matches no connect service', async () => {
        const { svc, adb } = makeService();
        const { payload } = svc.startQr();
        const name = /S:([^;]+)/.exec(payload)![1]!;
        adb.pair.mockResolvedValue('Successfully paired to 10.0.0.5:41415');
        adb.mdnsServices.mockResolvedValue([
            { name, service: PAIR_SVC, address: '10.0.0.5', port: 41415 },
            { name: 'adb-OTHER-yy', service: CONNECT_SVC, address: '10.0.0.5', port: 43777 },
            { name: 'adb-THIRD-zz', service: CONNECT_SVC, address: '10.9.9.9', port: 40000 },
        ]);
        await svc.pollOnce();
        expect(adb.connect).toHaveBeenCalledWith('10.0.0.5:43777');
    });

    it('reports paired-not-connected when pairing works but no connect service exists', async () => {
        const { svc, adb } = makeService();
        const { sessionId, payload } = svc.startQr();
        const name = /S:([^;]+)/.exec(payload)![1]!;
        adb.mdnsServices.mockResolvedValue([{ name, service: PAIR_SVC, address: '10.0.0.5', port: 41415 }]);
        await svc.pollOnce();
        expect(svc.status(sessionId)!.state).toBe('paired-not-connected');
    });

    it('discards a result belonging to a superseded session', async () => {
        const { svc, adb } = makeService();
        const first = svc.startQr();
        const second = svc.startQr(); // replaces the first
        expect(svc.status(first.sessionId)).toBeUndefined();
        expect(svc.status(second.sessionId)).toBeDefined();
        expect(adb.pair).not.toHaveBeenCalled();
    });

    it('stops polling and reports expired past the TTL', async () => {
        const { svc, advance } = makeService();
        const { sessionId } = svc.startQr();
        advance(180_001);
        await svc.pollOnce();
        expect(svc.status(sessionId)!.state).toBe('expired');
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- pairingService`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Key points the tests pin: `pollOnce()` is public so tests drive discovery without timers; every async continuation re-checks `this.session` identity before mutating; the connect lookup is guid → same-IP → `markPairedNotConnected`.

```ts
const PAIR_SVC = '_adb-tls-pairing._tcp';
const CONNECT_SVC = '_adb-tls-connect._tcp';
export const POLL_INTERVAL_MS = 1_000;

export class PairingService {
    private session?: PairingSession;
    private timer?: ReturnType<typeof setTimeout>;

    constructor(private readonly deps: PairingDeps) {}

    private replace(s: PairingSession): void {
        // Replacement makes prior work inert: the old session object is dropped,
        // and every continuation below re-checks identity, so a late mDNS hit or
        // a late adb result belonging to it can no longer mutate anything.
        this.stop();
        this.session = s;
        this.schedule();
    }

    private schedule(): void {
        if (this.session?.state !== 'awaiting-scan') return;
        const setT = this.deps.setTimeoutFn ?? setTimeout;
        this.timer = setT(() => void this.pollOnce().finally(() => this.schedule()), POLL_INTERVAL_MS);
    }

    stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.session = undefined;
    }

    startQr(): { sessionId: string; payload: string; expiresAt: number } {
        const s = newSession('qr', this.deps.now());
        this.replace(s);
        return { sessionId: s.id, payload: `WIFI:T:ADB;S:${s.serviceName};P:${s.password};;`, expiresAt: s.expiresAt };
    }

    startCode(address: string, code: string): { sessionId: string } {
        const s = newSession('code', this.deps.now());
        this.replace(s);
        void this.pairAndConnect(s, address, code, address.split(':')[0]!);
        return { sessionId: s.id };
    }

    status(sessionId: string): PairingStatus | undefined {
        const s = this.session;
        if (!s || s.id !== sessionId) return undefined;
        return s.toStatus(this.deps.now());
    }

    cancel(sessionId: string): void {
        if (this.session?.id === sessionId) { this.session.cancel(); this.stop(); }
    }

    async pollOnce(): Promise<void> {
        const s = this.session;
        if (!s || s.state !== 'awaiting-scan') return;
        if (s.isExpired(this.deps.now())) { if (this.timer) clearTimeout(this.timer); this.timer = undefined; return; }
        const services = await this.deps.adb.mdnsServices().catch(() => []);
        if (this.session !== s) return; // superseded while awaiting mDNS
        const hit = services.find((x) => x.service === PAIR_SVC && x.name === s.serviceName);
        if (!hit) return;
        s.markPairing();
        await this.pairAndConnect(s, `${hit.address}:${hit.port}`, s.password, hit.address);
    }

    private async pairAndConnect(s: PairingSession, pairAddress: string, code: string, ip: string): Promise<void> {
        let out: string;
        try {
            out = await this.deps.adb.pair(pairAddress, code);
        } catch (e) {
            if (this.session === s) s.markFailed(e instanceof Error ? e.message : 'pairing failed');
            return;
        }
        if (this.session !== s) return;

        const guid = parsePairGuid(out);
        const services = await this.deps.adb.mdnsServices().catch(() => []);
        if (this.session !== s) return;

        const connects = services.filter((x) => x.service === CONNECT_SVC);
        // guid first, then same IP. NEVER "the only connect service on the
        // network" -- with several devices advertising that is a coin toss.
        const target = (guid && connects.find((x) => x.name === guid)) ?? connects.find((x) => x.address === ip);
        if (!target) {
            s.markPairedNotConnected('paired, but no connect service was advertised for this device');
            return;
        }
        const address = `${target.address}:${target.port}`;
        s.markConnecting(guid, address);
        try {
            const res = await this.deps.adb.connect(address);
            if (this.session !== s) return;
            if (/connected/i.test(res)) s.markPaired();
            else s.markPairedNotConnected(`paired, but connect said: ${res.trim()}`);
        } catch {
            if (this.session === s) s.markPairedNotConnected('paired, but the connect attempt failed');
        }
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- pairingService`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/pairing/PairingService.ts src/server/__tests__/pairingService.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(pairing): add the pairing service with discovery and auto-connect"
```

---

### Task 5: PairingApi

**Files:**
- Create: `src/server/api/PairingApi.ts`
- Modify: `src/server/index.ts` (register alongside `DeviceDiscoveryApi`)
- Test: `src/server/__tests__/pairingApi.test.ts`

**Interfaces:**
- Consumes: `PairingService` (Task 4), `encodeQrSvg` (Task 1), existing `readJsonBodyStrict`, `sendInternalError` from `./utils`.
- Produces: `class PairingApi { async handle(req, res): Promise<boolean> }`, matching `DeviceDiscoveryApi`'s shape — returns `false` for a URL it does not own.

Routes, all admin-scoped, mirroring how `DeviceDiscoveryApi` gates:

| Method | Route | Returns |
|---|---|---|
| POST | `/api/devices/pair/qr` | `{ sessionId, svg, expiresAt }` |
| POST | `/api/devices/pair/code` | `{ sessionId }` |
| GET | `/api/devices/pair/status?sessionId=` | `{ state, message?, serial?, address? }` |
| POST | `/api/devices/pair/cancel` | `{ ok: true }` |

- [ ] **Step 1: Write the failing test**

```ts
it('returns rendered svg and never the payload or password', async () => {
    const { res, body } = await post('/api/devices/pair/qr');
    expect(res.statusCode).toBe(200);
    expect(body.svg.startsWith('<svg')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('WIFI:T:ADB');
    expect(body.payload).toBeUndefined();
});

it('status never carries the password, including on failure', async () => {
    // drive the service to 'failed', then read status
    const { body } = await get(`/api/devices/pair/status?sessionId=${id}`);
    expect(Object.keys(body).sort()).toEqual(['message', 'state']);
});

it('404s an unknown sessionId rather than leaking the active one', async () => {
    const { res } = await get('/api/devices/pair/status?sessionId=nope');
    expect(res.statusCode).toBe(404);
});

it('rejects a code-mode body missing address or code', async () => {
    expect((await post('/api/devices/pair/code', { code: '123456' })).res.statusCode).toBe(400);
    expect((await post('/api/devices/pair/code', { address: '1.2.3.4:5' })).res.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- pairingApi`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export class PairingApi {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/devices/pair')) return false;
        res.setHeader('Content-Type', 'application/json');
        const svc = PairingService.getInstance();
        try {
            if (req.method === 'POST' && url === '/api/devices/pair/qr') {
                const { sessionId, payload, expiresAt } = svc.startQr();
                // The payload is converted here and never returned, logged, or
                // stored. Only the rendered SVG leaves the process.
                const svg = encodeQrSvg(payload);
                res.writeHead(200);
                res.end(JSON.stringify({ sessionId, svg, expiresAt }));
                return true;
            }
            if (req.method === 'POST' && url === '/api/devices/pair/code') {
                const { address, code } = await readJsonBodyStrict<{ address?: string; code?: string }>(req);
                if (!address || !code) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'address and code are required' }));
                    return true;
                }
                res.writeHead(200);
                res.end(JSON.stringify(svc.startCode(address, code)));
                return true;
            }
            if (req.method === 'GET' && url.startsWith('/api/devices/pair/status')) {
                const id = new URL(url, 'http://localhost').searchParams.get('sessionId') ?? '';
                const status = svc.status(id);
                if (!status) {
                    // 404 rather than returning the active session: an unknown id
                    // must not be a way to read somebody else's pairing.
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'no such pairing session' }));
                    return true;
                }
                res.writeHead(200);
                res.end(JSON.stringify(status));
                return true;
            }
            if (req.method === 'POST' && url === '/api/devices/pair/cancel') {
                const { sessionId } = await readJsonBodyStrict<{ sessionId?: string }>(req);
                if (sessionId) svc.cancel(sessionId);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true }));
                return true;
            }
            return false;
        } catch (e) {
            sendInternalError(res, e);
            return true;
        }
    }
}
```

Register in `src/server/index.ts` **before** `DeviceDiscoveryApi` in the dispatch chain — both match `/api/devices`, and `DeviceDiscoveryApi` must not claim `/api/devices/pair/*` first.

- [ ] **Step 4: Run the tests**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- pairingApi`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/PairingApi.ts src/server/index.ts src/server/__tests__/pairingApi.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(pairing): expose the pairing API"
```

---

### Task 6: AdbHandshakeProbe learns STLS

**Files:**
- Modify: `src/server/network/AdbHandshakeProbe.ts`
- Test: `src/server/__tests__/adbHandshakeProbe.test.ts` (extend)

**Interfaces:**
- Produces: the existing probe result gains an optional flag — `{ isAdb: boolean; model?: string; requiresPairing?: boolean }`.
- **Export `parseReply(buf: Buffer): { isAdb: boolean; model?: string; requiresPairing?: boolean }`** if it is not exported already. The test below calls it directly; asserting through a real socket would make this a network test for a pure byte-parsing change. Check the existing `adbHandshakeProbe.test.ts` first — if it already reaches the parser some other way, follow that instead of adding a second seam.

Harvest item 6 from #506: Android wireless debugging answers `CNXN` with `STLS` on the secure connect port. The probe does not recognise it today, so such an endpoint reads as "not adb" instead of "adb, but you must pair first".

- [ ] **Step 1: Write the failing test**

```ts
it('recognises an STLS reply as adb that requires pairing', () => {
    const header = Buffer.alloc(24);
    header.writeUInt32LE(0x534c5453, 0);           // "STLS"
    header.writeUInt32LE(0x01000000, 4);           // version
    header.writeUInt32LE(0, 8);                    // data length
    header.writeUInt32LE((0x534c5453 ^ 0xffffffff) >>> 0, 20); // magic
    expect(parseReply(header)).toEqual({ isAdb: true, requiresPairing: true });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- adbHandshakeProbe`
Expected: FAIL — returns `{ isAdb: false }`.

- [ ] **Step 3: Implement**

```ts
const A_STLS = 0x534c5453; // "STLS"
const A_STLS_MAGIC = (A_STLS ^ 0xffffffff) >>> 0;
// ...alongside the existing A_CNXN / A_AUTH branches:
if (command === A_STLS) {
    if (magic !== A_STLS_MAGIC) return { isAdb: false };
    return { isAdb: true, requiresPairing: true };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- adbHandshakeProbe`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/network/AdbHandshakeProbe.ts src/server/__tests__/adbHandshakeProbe.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(pairing): recognise the STLS handshake reply"
```

---

### Task 7: UI inside the scan/connect modal

**Files:**
- Modify: `src/app/client/NetworkDiscoveryPanel.ts`
- Test: `src/app/client/__tests__/networkDiscoveryPairing.test.ts`

**Interfaces:**
- Consumes: the Task 5 routes.

Add a **Pair a device** section to the existing panel with two modes: *Scan QR* (renders the returned SVG, polls `status` every 1 s) and *Pairing code* (address + 6-digit code inputs). On `paired`, refresh the device list and close. On `paired-not-connected`, say the device is paired but not connected and offer Connect — **do not** present it as a failure.

**Exported for testability:** `export function renderPairingSection(deps: { fetchFn: typeof fetch }): HTMLElement` plus `export function pairingStatusText(status: PairingStatus): { text: string; action?: 'connect' | 'restart' }`. Keeping the status→copy mapping a pure function means the interesting assertions need no DOM timing.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pairingStatusText, renderPairingSection } from '../NetworkDiscoveryPanel';

describe('pairingStatusText', () => {
    it('presents paired-not-connected as a partial success with a Connect action', () => {
        // NOT an error. The pairing is durable; calling it a failure makes the
        // user re-pair a device that is already paired.
        const r = pairingStatusText({ state: 'paired-not-connected', message: 'no connect service' });
        expect(r.action).toBe('connect');
        expect(r.text).toMatch(/paired/i);
        expect(r.text).not.toMatch(/failed|error/i);
    });

    it('offers a restart on expiry', () => {
        expect(pairingStatusText({ state: 'expired' }).action).toBe('restart');
    });

    it('reports a real failure as a failure', () => {
        const r = pairingStatusText({ state: 'failed', message: 'pairing refused' });
        expect(r.text).toMatch(/refused/);
        expect(r.action).toBe('restart');
    });
});

describe('renderPairingSection', () => {
    let fetchFn: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchFn = vi.fn();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('renders the returned svg and never receives the payload', async () => {
        fetchFn.mockResolvedValue({
            ok: true,
            json: async () => ({ sessionId: 's1', svg: '<svg viewBox="0 0 29 29"></svg>', expiresAt: Date.now() + 180000 }),
        });
        const el = renderPairingSection({ fetchFn: fetchFn as never });
        el.querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        expect(el.querySelector('svg')).not.toBeNull();
        const sent = JSON.stringify(fetchFn.mock.results);
        expect(sent).not.toContain('WIFI:T:ADB');
    });

    it('stops polling once the session reaches a terminal state', async () => {
        fetchFn
            .mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: 's1', svg: '<svg></svg>', expiresAt: Date.now() + 180000 }) })
            .mockResolvedValue({ ok: true, json: async () => ({ state: 'paired' }) });
        const el = renderPairingSection({ fetchFn: fetchFn as never });
        el.querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(1000); // first status poll -> paired
        const afterTerminal = fetchFn.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5000); // must issue nothing further
        expect(fetchFn.mock.calls.length).toBe(afterTerminal);
    });

    it('requires both address and code before enabling the code-mode submit', async () => {
        const el = renderPairingSection({ fetchFn: fetchFn as never });
        el.querySelector<HTMLButtonElement>('[data-pair-mode="code"]')!.click();
        const submit = el.querySelector<HTMLButtonElement>('[data-pair-submit]')!;
        expect(submit.disabled).toBe(true);
        el.querySelector<HTMLInputElement>('[data-pair-address]')!.value = '192.168.86.190:41415';
        el.querySelector<HTMLInputElement>('[data-pair-code]')!.value = '987530';
        el.querySelector<HTMLInputElement>('[data-pair-code]')!.dispatchEvent(new Event('input'));
        expect(submit.disabled).toBe(false);
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- networkDiscoveryPairing`
Expected: FAIL — `pairingStatusText` / `renderPairingSection` are not exported.

- [ ] **Step 3: Implement**

```ts
export function pairingStatusText(status: PairingStatus): { text: string; action?: 'connect' | 'restart' } {
    switch (status.state) {
        case 'awaiting-scan': return { text: 'Scan this code on the phone: Wireless debugging -> Pair device with QR code.' };
        case 'pairing': return { text: 'Pairing…' };
        case 'connecting': return { text: 'Paired. Connecting…' };
        case 'paired': return { text: 'Paired and connected.' };
        case 'paired-not-connected':
            return { text: `Paired, but not connected yet — ${status.message ?? 'no connect service found'}.`, action: 'connect' };
        case 'expired': return { text: 'The pairing window closed. Start again to get a fresh code.', action: 'restart' };
        case 'failed': return { text: status.message ?? 'Pairing failed.', action: 'restart' };
    }
}
```

`renderPairingSection` builds a section with two mode buttons (`data-pair-mode="qr"` / `"code"`), a QR container that gets `innerHTML` set to the returned SVG, address/code inputs (`data-pair-address`, `data-pair-code`, `data-pair-submit`), and a status line. It polls `GET /api/devices/pair/status?sessionId=` every 1 s and **stops on any terminal state** — `paired`, `paired-not-connected`, `failed`, `expired`. Mount it in the existing scan/connect modal alongside the scan and manual-add controls.

Setting `innerHTML` from the SVG is safe here and nowhere else: the string is produced by our own `encodeQrSvg`, which emits only `<rect>` and `<path>` from a numeric matrix, and never interpolates the payload into the markup.

- [ ] **Step 4: Run the tests**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test -- networkDiscoveryPairing`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(pairing): add the pairing UI to the scan/connect modal"
```

---

### Task 8: Docs, CHANGELOG and smoke rows

**Files:**
- Modify: `CHANGELOG.md`, `docs/TECHNICAL_GUIDE.md`, `docs/smoke-tests/smoke-test.md`, `docs/smoke-tests/automation-coverage.md`

- [ ] **Step 1: CHANGELOG** — an `### Added` bullet under `[Unreleased]` explaining that Android 11+ devices could not be connected at all without pairing, and that the missing prompt was never coming because Android 11+ does not show one.
- [ ] **Step 2: TECHNICAL_GUIDE** — a pairing section: the two-service dance, why the ports are unrelated ephemerals, and the redaction boundary in `AdbClient.pair()`.
- [ ] **Step 3: Smoke rows** — add **7.6** (pair by QR, Pixel) and **7.7** (pair by code, GTV Streamer — the only flow that can pair a cameraless device). Update the Module 7 index line.
- [ ] **Step 4: Coverage register** — add both rows, bucket `residual: un-automatable` (pairing needs a real phone showing a real pairing screen; the emulator does not advertise `_adb-tls-pairing._tcp`). **Row count goes 145 → 147**; update the derivation note, the table Total, and both percentages (`58/147 = 39 %`, `84/147 = 57 %`). Verify by counting the doc's own anchors, not by trusting the arithmetic.
- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(pairing): document wireless pairing and add smoke rows 7.6 and 7.7"
```

---

## Device verification (with the user present)

Not a task — the gate before the PR merges.

1. **Pixel 10a by QR** → auto-connects → streams.
2. **GTV Streamer by pairing code** — it has no camera, so this is the only thing that exercises the second path end to end. Skipping it ships half the feature unverified.
3. **Then rotate**, which is item 24's outstanding device test (PR #698). Both features are in this build by design.
