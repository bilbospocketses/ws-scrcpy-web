import type { IncomingMessage } from 'http';
import { describe, expect, it } from 'vitest';
import { IMPLICIT_ADMIN_ID } from '../../db/constants';
import { resolveUserId } from '../currentUser';

describe('resolveUserId (open mode)', () => {
    it('returns the implicit admin when no auth context is present', () => {
        expect(resolveUserId(undefined)).toBe(IMPLICIT_ADMIN_ID);
        expect(resolveUserId({} as IncomingMessage)).toBe(IMPLICIT_ADMIN_ID);
    });
    it('returns the attached session user id when present', () => {
        expect(resolveUserId({ user: { id: 7 } } as never)).toBe(7);
    });
});
