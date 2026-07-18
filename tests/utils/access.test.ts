import { isUserAllowed } from '../../src/utils/access';

describe('isUserAllowed', () => {
    it('allows an explicitly listed user', () => {
        expect(isUserAllowed(['u1', 'u2'], 'u1')).toBe(true);
    });

    it('rejects a user not on the list', () => {
        expect(isUserAllowed(['u1', 'u2'], 'u3')).toBe(false);
    });

    it('rejects everyone when the list is empty', () => {
        expect(isUserAllowed([], 'u1')).toBe(false);
    });

    it('allows anyone when the wildcard "*" is present', () => {
        expect(isUserAllowed(['*'], 'anyone')).toBe(true);
        expect(isUserAllowed(['u1', '*'], 'someone-else')).toBe(true);
    });
});
