import { describe, expect, it } from 'vitest';
import { ControlCenterCommand } from '../ControlCenterCommand';

describe('ControlCenterCommand.fromJSON', () => {
    it('parses a valid KILL_SERVER command', () => {
        const cmd = ControlCenterCommand.fromJSON(
            JSON.stringify({
                id: 1,
                type: ControlCenterCommand.KILL_SERVER,
                data: { udid: 'dev1', pid: 1234 },
            }),
        );
        expect(cmd.getType()).toBe(ControlCenterCommand.KILL_SERVER);
        expect(cmd.getId()).toBe(1);
        expect(cmd.getUdid()).toBe('dev1');
        expect(cmd.getPid()).toBe(1234);
    });

    it('parses START_SERVER (no pid required)', () => {
        const cmd = ControlCenterCommand.fromJSON(
            JSON.stringify({ id: 2, type: ControlCenterCommand.START_SERVER, data: { udid: 'dev2' } }),
        );
        expect(cmd.getType()).toBe(ControlCenterCommand.START_SERVER);
        expect(cmd.getUdid()).toBe('dev2');
    });

    it('rejects KILL_SERVER with a non-positive pid (|| not &&)', () => {
        // The bug: `typeof pid !== 'number' && pid <= 0` only throws when pid is
        // BOTH non-numeric AND <= 0, so a valid-typed but non-positive pid slips through.
        expect(() =>
            ControlCenterCommand.fromJSON(
                JSON.stringify({ id: 1, type: ControlCenterCommand.KILL_SERVER, data: { udid: 'd', pid: 0 } }),
            ),
        ).toThrow(/Invalid "pid"/);
        expect(() =>
            ControlCenterCommand.fromJSON(
                JSON.stringify({ id: 1, type: ControlCenterCommand.KILL_SERVER, data: { udid: 'd', pid: -5 } }),
            ),
        ).toThrow(/Invalid "pid"/);
    });

    it('rejects KILL_SERVER with a non-numeric or missing pid', () => {
        expect(() =>
            ControlCenterCommand.fromJSON(
                JSON.stringify({ id: 1, type: ControlCenterCommand.KILL_SERVER, data: { udid: 'd', pid: '1234' } }),
            ),
        ).toThrow(/Invalid "pid"/);
        expect(() =>
            ControlCenterCommand.fromJSON(
                JSON.stringify({ id: 1, type: ControlCenterCommand.KILL_SERVER, data: { udid: 'd' } }),
            ),
        ).toThrow(/Invalid "pid"/);
    });

    it('throws a clean error (not an undefined deref) when data is missing', () => {
        let msg = '';
        try {
            ControlCenterCommand.fromJSON(
                JSON.stringify({ id: 1, type: ControlCenterCommand.START_SERVER }),
            );
            throw new Error('expected fromJSON to throw');
        } catch (e) {
            msg = (e as Error).message;
        }
        expect(msg).toMatch(/Invalid input/);
        // The original bug surfaced as a TypeError reading `data.udid` of undefined.
        expect(msg).not.toMatch(/Cannot read propert/i);
    });

    it('throws on an unknown command type', () => {
        expect(() =>
            ControlCenterCommand.fromJSON(JSON.stringify({ id: 1, type: 'bogus', data: { udid: 'd' } })),
        ).toThrow(/Unknown command/);
    });

    it('throws on a falsy JSON body', () => {
        expect(() => ControlCenterCommand.fromJSON('null')).toThrow(/Invalid input/);
    });
});
