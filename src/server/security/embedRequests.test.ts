import { afterEach, describe, expect, it } from 'vitest';
import {
    _resetForTest,
    _setClockForTest,
    createRequest,
    getPendingRequest,
    getStatus,
    REQUEST_TTL_MS,
    resolveRequest,
} from './embedRequests';

describe('embedRequests', () => {
    afterEach(() => {
        _resetForTest();
    });

    it('records a request and exposes it to the approval UI', () => {
        const created = createRequest('http://localhost:5159', 'Control Menu');

        expect(created).not.toBeNull();
        expect(getPendingRequest()).toMatchObject({
            id: created?.id,
            origin: 'http://localhost:5159',
            appName: 'Control Menu',
        });
        expect(getStatus(created?.id ?? '')).toBe('pending');
    });

    it('refuses an origin that is not a usable frame ancestor', () => {
        // A caller must not be able to park junk, a path, or a wildcard in a
        // prompt a human is about to approve.
        expect(createRequest('*', 'Evil')).toBeNull();
        expect(createRequest('http://localhost:5159/embed', 'Evil')).toBeNull();
        expect(createRequest('not a url', 'Evil')).toBeNull();
        expect(createRequest('ftp://localhost', 'Evil')).toBeNull();
        expect(getPendingRequest()).toBeNull();
    });

    it('falls back to a generic name when none is supplied', () => {
        createRequest('http://localhost:5159', '   ');

        expect(getPendingRequest()?.appName).toBe('An application');
    });

    it('caps an over-long app name so it cannot flood the prompt', () => {
        createRequest('http://localhost:5159', 'x'.repeat(500));

        expect(getPendingRequest()?.appName).toHaveLength(64);
    });

    it('keeps only one request pending — a second replaces the first', () => {
        const first = createRequest('http://localhost:5159', 'One');
        const second = createRequest('http://localhost:6000', 'Two');

        expect(getPendingRequest()?.id).toBe(second?.id);
        expect(getStatus(first?.id ?? '')).toBe('unknown');
    });

    it('approves only the request the decision names', () => {
        const created = createRequest('http://localhost:5159', 'Control Menu');

        expect(resolveRequest('some-other-id', true)).toBeNull();
        expect(getStatus(created?.id ?? '')).toBe('pending');

        expect(resolveRequest(created?.id ?? '', true)).not.toBeNull();
        expect(getStatus(created?.id ?? '')).toBe('approved');
    });

    it('records a denial', () => {
        const created = createRequest('http://localhost:5159', 'Control Menu');
        resolveRequest(created?.id ?? '', false);

        expect(getStatus(created?.id ?? '')).toBe('denied');
        expect(getPendingRequest()).toBeNull();
    });

    it('never resolves the same request twice', () => {
        const created = createRequest('http://localhost:5159', 'Control Menu');
        resolveRequest(created?.id ?? '', false);

        // A stale prompt left open in a second tab must not be able to flip a
        // denial into an approval.
        expect(resolveRequest(created?.id ?? '', true)).toBeNull();
        expect(getStatus(created?.id ?? '')).toBe('denied');
    });

    it('expires a request that is never answered', () => {
        let clock = 1_000_000;
        _setClockForTest(() => clock);
        const created = createRequest('http://localhost:5159', 'Control Menu');

        clock += REQUEST_TTL_MS;

        expect(getStatus(created?.id ?? '')).toBe('expired');
        expect(getPendingRequest()).toBeNull();
        expect(resolveRequest(created?.id ?? '', true)).toBeNull();
    });

    it('reports an unknown id rather than guessing', () => {
        expect(getStatus('never-existed')).toBe('unknown');
    });
});
