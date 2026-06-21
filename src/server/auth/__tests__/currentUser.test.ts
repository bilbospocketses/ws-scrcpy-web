import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'http';
import { resolveUserId } from '../currentUser';
import { IMPLICIT_ADMIN_ID } from '../../db/constants';

describe('resolveUserId (open mode)', () => {
    it('returns the implicit admin when no auth context is present', () => {
        expect(resolveUserId(undefined)).toBe(IMPLICIT_ADMIN_ID);
        expect(resolveUserId({} as IncomingMessage)).toBe(IMPLICIT_ADMIN_ID);
    });
});
