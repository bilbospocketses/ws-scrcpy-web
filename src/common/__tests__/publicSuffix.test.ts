import { describe, expect, it } from 'vitest';
import { isPublicSuffix, PUBLIC_SUFFIX_DENYLIST } from '../publicSuffix';

// src/common/publicSuffix.ts (0.5.5): the one list the server refuses a
// hostname certificate for (CertService.generate) and the Local HTTPS tab
// warns about while it is typed.

describe('PUBLIC_SUFFIX_DENYLIST', () => {
    it('is exactly the agreed list', () => {
        expect([...PUBLIC_SUFFIX_DENYLIST].sort()).toEqual(
            [
                'com',
                'net',
                'org',
                'info',
                'biz',
                'gov',
                'edu',
                'mil',
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

    it.each(['dev', 'app', 'me', 'io', 'co'])('no longer lists "%s", a believable machine name', (name) => {
        expect(PUBLIC_SUFFIX_DENYLIST.has(name)).toBe(false);
    });
});

describe('isPublicSuffix', () => {
    it.each(['com', 'COM', ' com ', 'Co.Uk', 'org.au'])('refuses %j', (name) => {
        expect(isPublicSuffix(name)).toBe(true);
    });

    it.each(['nas', 'localhost', 'lan', 'local', 'devices.lan', 'example.com', 'com.example', ''])(
        'allows %j',
        (name) => {
            expect(isPublicSuffix(name)).toBe(false);
        },
    );
});
