import { describe, expect, it } from 'vitest';
import { IANA_TLDS, IANA_TLDS_VERSION } from '../ianaTlds';
import { isPublicSuffix, MULTI_LABEL_PUBLIC_SUFFIXES } from '../publicSuffix';

// src/common/publicSuffix.ts (0.5.5): what the server refuses a hostname
// certificate for (CertService.generate) and the Local HTTPS tab warns about
// while it is typed -- every delegated TLD (src/common/ianaTlds.ts, generated
// from IANA's list) and a short list of second-level public suffixes.

describe('IANA_TLDS', () => {
    it("keeps IANA's version header, and is the whole list, lower case", () => {
        expect(IANA_TLDS_VERSION).toMatch(/^# Version \d{10}, Last Updated .+ UTC$/);
        expect(IANA_TLDS.size).toBeGreaterThan(1000);
        for (const tld of IANA_TLDS) expect(tld, tld).toMatch(/^[a-z0-9-]+$/);
    });

    it('holds the TLDs a CA must never be made for, and none of the LAN names', () => {
        for (const tld of ['com', 'net', 'org', 'de', 'uk', 'dev', 'app', 'me', 'io', 'co', 'media', 'xn--p1ai']) {
            expect(IANA_TLDS.has(tld), tld).toBe(true);
        }
        for (const name of ['htpc', 'nas', 'lan', 'local', 'home', 'localhost', 'internal']) {
            expect(IANA_TLDS.has(name), name).toBe(false);
        }
    });
});

describe('MULTI_LABEL_PUBLIC_SUFFIXES', () => {
    it('is exactly the agreed list', () => {
        expect([...MULTI_LABEL_PUBLIC_SUFFIXES].sort()).toEqual(
            [
                'co.uk',
                'org.uk',
                'ac.uk',
                'com.au',
                'net.au',
                'org.au',
                'com.br',
                'co.jp',
                'co.nz',
                'co.za',
                'com.cn',
                'co.in',
            ].sort(),
        );
    });
});

describe('isPublicSuffix', () => {
    it.each(['com', 'COM', ' com ', 'de', 'De', 'media', 'dev', 'app', 'io', 'co', 'xn--p1ai', 'XN--P1AI', 'Co.Uk'])(
        'refuses %j',
        (name) => {
            expect(isPublicSuffix(name)).toBe(true);
        },
    );

    it.each([
        'htpc',
        'nas',
        'lan',
        'local',
        'home',
        'localhost',
        'media.lan',
        'example.com',
        'com.example',
        'de.lan',
        '',
    ])('allows %j', (name) => {
        expect(isPublicSuffix(name)).toBe(false);
    });
});
