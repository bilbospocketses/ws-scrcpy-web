import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMdnsOutput } from '../AdbClient';
import type { PairingDeps } from '../pairing/PairingService';
import { CONNECT_SVC, PAIR_SVC, PairingService } from '../pairing/PairingService';
import type { PairingSession } from '../pairing/PairingSession';

// Every service built by makeService is stopped after the test. A QR session
// arms a real 1s discovery timer, and with the clock frozen at t=1000 it never
// expires, so an unstopped service would keep re-arming past the end of the run.
const built: PairingService[] = [];

afterEach(() => {
    for (const svc of built) {
        svc.stop();
    }
    built.length = 0;
});

function makeService(over: Partial<PairingDeps> = {}) {
    const adb = {
        pair: vi.fn().mockResolvedValue('Successfully paired to 10.0.0.5:41415 [guid=adb-SER1-xx]'),
        mdnsServices: vi.fn().mockResolvedValue([]),
        connect: vi.fn().mockResolvedValue('connected to 10.0.0.5:43777'),
    };
    let t = 1_000;
    const svc = new PairingService({ adb, now: () => t, ...over });
    built.push(svc);
    return {
        svc,
        adb,
        advance: (ms: number) => {
            t += ms;
        },
    };
}

/**
 * White-box on purpose. The password is unreachable through the public surface
 * -- that is the whole point of the redaction -- so reading the field the
 * service holds is the only way to prove it was actually blanked in memory
 * rather than merely kept out of the status shape.
 */
function currentSession(svc: PairingService): PairingSession | undefined {
    return (svc as unknown as { session: PairingSession | undefined }).session;
}

/**
 * A setTimeout stub that collects the callbacks instead of running them, so a
 * test can fire a discovery tick by hand and then count how many the service
 * armed. The handle it hands back is 0 -- deliberately falsy, since a dedupe
 * written as `if (this.timer) return` would pass against a Node handle and fail
 * here.
 */
function stubTimer() {
    const ticks: (() => void)[] = [];
    const setTimeoutFn = ((fn: () => void) => {
        ticks.push(fn);
        return 0;
    }) as unknown as typeof setTimeout;
    return { ticks, setTimeoutFn };
}

/** Let an awaited continuation and its `finally` run. */
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('PairingService', () => {
    // The QR flow matches the service type with `===`, so it is not enough that
    // these constants look right — they have to equal what `parseMdnsOutput`
    // actually hands the service. DNS-SD names are fully qualified and may
    // carry a trailing root dot; an adb that prints one would make discovery
    // fail SILENTLY (no error, the device simply never found) while the scan
    // path, which uses `includes`, went on working. Driven from parser output
    // in BOTH spellings rather than from a hand-written constant.
    it.each([
        ['undotted', '_adb-tls-pairing._tcp', '_adb-tls-connect._tcp'],
        ['dotted', '_adb-tls-pairing._tcp.', '_adb-tls-connect._tcp.'],
    ])('matches the service types adb prints in its %s form', (_form, pairSvc, connectSvc) => {
        const parsed = parseMdnsOutput(
            [
                'List of discovered mdns services',
                `wsscrcpy-abc\t${pairSvc}\t10.0.0.5:41415`,
                `adb-SER1-xx\t${connectSvc}\t10.0.0.5:43777`,
            ].join('\n'),
        );
        expect(parsed[0]!.service).toBe(PAIR_SVC);
        expect(parsed[1]!.service).toBe(CONNECT_SVC);
    });

    it('builds the Android WIFI:T:ADB payload from the session', () => {
        const { svc } = makeService();
        const { payload } = svc.startQr();
        expect(payload).toMatch(/^WIFI:T:ADB;S:wsscrcpy-[a-z2-7]{10};P:[A-Za-z0-9]{12};;$/);
    });

    it('draws the password from the alphabet with the lookalike glyphs removed', () => {
        // One sample proves nothing here: a 12-character draw misses any single
        // banned glyph most of the time by chance. Two hundred sessions is 2,400
        // characters, so an alphabet that had let `l` back in would show it with
        // overwhelming probability rather than slipping through.
        const { svc } = makeService();
        let chars = '';
        for (let i = 0; i < 200; i++) {
            chars += /P:([^;]+)/.exec(svc.startQr().payload)![1]!;
        }
        expect(chars).toHaveLength(2_400);
        expect(chars).not.toMatch(/[Il1O0]/);
        // ...and it is still drawing from the rest, rather than having collapsed
        // to a narrow subset that would trivially satisfy the line above.
        expect(new Set(chars).size).toBeGreaterThan(50);
    });

    it('gives a code-mode session no service name, because it advertises nothing', () => {
        // The QR flow finds its device by matching an advertised mDNS name
        // against this field. A typed-code session was handed its address, so it
        // never advertises and never polls -- an empty name is the honest value,
        // and a non-empty one could only ever match something belonging to
        // somebody else.
        const { svc } = makeService();
        svc.startCode('10.0.0.5:41415', '123456');
        expect(currentSession(svc)!.serviceName).toBe('');
        expect(currentSession(svc)!.state).toBe('pairing');
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

    it('reports the STRIPPED device serial, not the raw mDNS guid', async () => {
        // `PairingStatus.serial` is documented as "Device serial", and the rest
        // of the app keys devices by the stripped form. The guid carries both
        // the `adb-` prefix and a per-advertisement instance suffix, so storing
        // it raw would put a value in that field that matches nothing.
        const { svc, adb } = makeService();
        const guid = 'adb-5C061JEA327610-bo0E0q';
        adb.pair.mockResolvedValue(`Successfully paired to 10.0.0.5:41415 [guid=${guid}]`);
        const { sessionId, payload } = svc.startQr();
        const name = /S:([^;]+)/.exec(payload)![1]!;
        adb.mdnsServices.mockResolvedValue([
            { name, service: PAIR_SVC, address: '10.0.0.5', port: 41415 },
            { name: guid, service: CONNECT_SVC, address: '10.0.0.5', port: 43777 },
        ]);
        await svc.pollOnce();
        expect(svc.status(sessionId)!.serial).toBe('5C061JEA327610');
        expect(svc.status(sessionId)!.serial).not.toBe(guid);
    });

    it('auto-connects a typed-code session by the guid adb pair reported', async () => {
        // Code mode skips discovery entirely -- there is no `awaiting-scan` and
        // no `pollOnce`; `startCode` pairs immediately off the address the user
        // typed. The decoy below SHARES the paired device's IP and is listed
        // first, so this goes green only if the guid is consulted before the IP
        // fallback -- against a decoy on some other IP, an IP-first
        // implementation would pick the right service anyway and the test would
        // pass having proved nothing about the guid.
        const { svc, adb } = makeService();
        adb.pair.mockResolvedValue('Successfully paired to 10.0.0.5:41415 [guid=adb-SER1-bo0E0q]');
        adb.mdnsServices.mockResolvedValue([
            { name: 'adb-DECOY-aa', service: CONNECT_SVC, address: '10.0.0.5', port: 40001 },
            { name: 'adb-SER1-bo0E0q', service: CONNECT_SVC, address: '10.0.0.5', port: 43777 },
        ]);
        const { sessionId } = svc.startCode('10.0.0.5:41415', '123456');
        await flush();
        expect(adb.pair).toHaveBeenCalledWith('10.0.0.5:41415', '123456');
        expect(adb.connect).toHaveBeenCalledWith('10.0.0.5:43777');
        expect(svc.status(sessionId)!.state).toBe('paired');
        expect(svc.status(sessionId)!.serial).toBe('SER1');
    });

    it('falls back to the same IP for a typed-code session whose guid names no connect service', async () => {
        // This is why `startCode` splits the IP off the address it was given
        // rather than passing it through whole: the typed address carries the
        // PAIRING port (41415), and the fallback has to match on the IP alone
        // or it would compare '10.0.0.5:41415' against a connect endpoint that
        // is on a different, unrelated ephemeral port.
        const { svc, adb } = makeService();
        adb.pair.mockResolvedValue('Successfully paired to 10.0.0.5:41415 [guid=adb-SER1-bo0E0q]');
        adb.mdnsServices.mockResolvedValue([
            { name: 'adb-NOTUS-zz', service: CONNECT_SVC, address: '10.0.0.5', port: 43777 },
            { name: 'adb-OTHER-yy', service: CONNECT_SVC, address: '10.9.9.9', port: 40000 },
        ]);
        const { sessionId } = svc.startCode('10.0.0.5:41415', '123456');
        await flush();
        expect(adb.connect).toHaveBeenCalledWith('10.0.0.5:43777');
        expect(svc.status(sessionId)!.state).toBe('paired');
    });

    it('reports paired-not-connected when pairing works but no connect service exists', async () => {
        const { svc, adb } = makeService();
        const { sessionId, payload } = svc.startQr();
        const name = /S:([^;]+)/.exec(payload)![1]!;
        adb.mdnsServices.mockResolvedValue([{ name, service: PAIR_SVC, address: '10.0.0.5', port: 41415 }]);
        await svc.pollOnce();
        expect(svc.status(sessionId)!.state).toBe('paired-not-connected');
        expect(svc.status(sessionId)!.message).toBe('no connect service was advertised for this device');
    });

    // Every paired-not-connected message is a DETAIL CLAUSE, not a sentence:
    // the client renders "Paired, but not connected yet -- <message>.", so one
    // that opened with "paired, but" would reach the user doubled. Three
    // separate paths produce one, and each is pinned below.
    it.each([
        ['no connect service exists', undefined, 'no connect service was advertised for this device'],
        [
            'connect answers without connecting',
            'failed to connect to 10.0.0.5:43777',
            'connect said: failed to connect to 10.0.0.5:43777',
        ],
        ['connect throws', new Error('boom'), 'the connect attempt failed'],
    ])(
        'phrases the paired-not-connected message as a detail clause when %s',
        async (_case, connectResult, expected) => {
            const { svc, adb } = makeService();
            const { sessionId, payload } = svc.startQr();
            const name = /S:([^;]+)/.exec(payload)![1]!;
            const mdns = [{ name, service: PAIR_SVC, address: '10.0.0.5', port: 41415 }];
            if (connectResult !== undefined) {
                mdns.push({ name: 'adb-SER1-xx', service: CONNECT_SVC, address: '10.0.0.5', port: 43777 });
                if (connectResult instanceof Error) {
                    adb.connect.mockRejectedValue(connectResult);
                } else {
                    adb.connect.mockResolvedValue(connectResult);
                }
            }
            adb.mdnsServices.mockResolvedValue(mdns);
            await svc.pollOnce();

            const message = svc.status(sessionId)!.message;
            expect(message).toBe(expected);
            expect(message?.toLowerCase().startsWith('paired, but')).toBe(false);
        },
    );

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

    it('stops re-arming the discovery timer once the session has expired', async () => {
        // An expired session's STORED state is still 'awaiting-scan' -- expiry is
        // derived from the clock at read time, never written down -- so a
        // re-arm guard that only looked at the state would poll a QR nobody ever
        // scanned every second for the life of the process.
        const { ticks, setTimeoutFn } = stubTimer();
        const { svc, advance } = makeService({ setTimeoutFn });
        svc.startQr();
        expect(ticks).toHaveLength(1);

        advance(180_001);
        ticks[0]!();
        await flush();
        expect(ticks).toHaveLength(1);
    });

    it('does not let a stale tick re-arm the timer on behalf of the session that replaced it', async () => {
        // The tick belonging to session A resumes after A has been replaced by B.
        // Its identity check correctly stops it doing any work -- but the re-arm
        // in its `finally` runs against `this.session`, which is now B. Without
        // an identity check there too, B ends up with two live poll loops (the
        // one `replace` armed is orphaned, because `stop()` can only clear the
        // single handle in `this.timer`), and one more with every further
        // replacement mid-tick. It shows up in production as N spawns of
        // `adb mdns services` a second.
        const { ticks, setTimeoutFn } = stubTimer();
        const { svc, adb } = makeService({ setTimeoutFn });
        let release: () => void = () => {};
        adb.mdnsServices.mockReturnValue(
            new Promise((resolve) => {
                release = () => resolve([]);
            }),
        );

        svc.startQr();
        expect(ticks).toHaveLength(1);
        ticks[0]!(); // A's tick is now parked on mdnsServices
        svc.startQr(); // replaces A with B, which arms its own tick
        expect(ticks).toHaveLength(2);

        release();
        await flush();
        expect(ticks).toHaveLength(2);
    });

    it('discards a hit that arrives after the deadline passed mid-tick', async () => {
        // mdnsServices gets 8 s, so the deadline can pass while it is in flight.
        // A status poll in that gap has already told the user 'expired'; walking
        // the session expired -> pairing -> paired afterwards would be the one
        // path on which 'expired' is not final. The late hit loses.
        const { ticks, setTimeoutFn } = stubTimer();
        const { svc, adb, advance } = makeService({ setTimeoutFn });
        const { sessionId, payload } = svc.startQr();
        const name = /S:([^;]+)/.exec(payload)![1]!;
        let release: () => void = () => {};
        adb.mdnsServices.mockReturnValue(
            new Promise((resolve) => {
                release = () => resolve([{ name, service: PAIR_SVC, address: '10.0.0.5', port: 41415 }]);
            }),
        );

        ticks[0]!();
        advance(180_001);
        release();
        await flush();

        expect(adb.pair).not.toHaveBeenCalled();
        expect(svc.status(sessionId)!.state).toBe('expired');
        expect(currentSession(svc)?.password).toBe('');
    });

    it('blanks the pairing secret once the session is terminal, and stays pollable', async () => {
        const { svc, adb } = makeService();
        const { sessionId, payload } = svc.startQr();
        const name = /S:([^;]+)/.exec(payload)![1]!;
        const password = /P:([^;]+)/.exec(payload)![1]!;
        adb.mdnsServices.mockResolvedValue([
            { name, service: PAIR_SVC, address: '10.0.0.5', port: 41415 },
            { name: 'adb-SER1-xx', service: CONNECT_SVC, address: '10.0.0.5', port: 43777 },
        ]);
        await svc.pollOnce();

        // It really did pair with the generated secret...
        expect(adb.pair).toHaveBeenCalledWith('10.0.0.5:41415', password);
        // ...and the secret is gone the moment it can no longer be used.
        expect(currentSession(svc)?.password).toBe('');
        // Nothing else about the session went with it: the UI still polls this.
        expect(svc.status(sessionId)!.state).toBe('paired');
        expect(JSON.stringify(svc.status(sessionId))).not.toContain(password);
    });

    it('blanks the pairing secret when the session expires unscanned', async () => {
        const { svc, advance } = makeService();
        const { sessionId } = svc.startQr();
        advance(180_001);
        await svc.pollOnce();
        expect(currentSession(svc)?.password).toBe('');
        expect(svc.status(sessionId)!.state).toBe('expired');
    });

    it('blanks the pairing secret when the session is cancelled or replaced', () => {
        const { svc } = makeService();
        const cancelled = svc.startQr();
        const session = currentSession(svc);
        svc.cancel(cancelled.sessionId);
        expect(session?.password).toBe('');

        const replaced = svc.startQr();
        const stale = currentSession(svc);
        svc.startQr();
        expect(stale?.password).toBe('');
        expect(svc.status(replaced.sessionId)).toBeUndefined();
    });

    it('never surfaces adb detail past the PairingError redaction boundary', async () => {
        const { svc, adb } = makeService();
        const { sessionId, payload } = svc.startQr();
        const name = /S:([^;]+)/.exec(payload)![1]!;
        const password = /P:([^;]+)/.exec(payload)![1]!;
        adb.mdnsServices.mockResolvedValue([{ name, service: PAIR_SVC, address: '10.0.0.5', port: 41415 }]);
        // An unaudited error -- not a PairingError -- carrying the secret in its
        // message, which is exactly what AdbExecError would have done.
        adb.pair.mockRejectedValue(new Error(`adb exit (args="pair 10.0.0.5:41415 ${password}")`));
        await svc.pollOnce();

        const status = svc.status(sessionId)!;
        expect(status.state).toBe('failed');
        expect(status.message).toBe('pairing failed');
        expect(JSON.stringify(status)).not.toContain(password);
    });
});
