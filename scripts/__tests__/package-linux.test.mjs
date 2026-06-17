import { describe, expect, it } from 'vitest';
import { parseCargoWorkspaceVersion } from '../package-linux.mjs';

describe('parseCargoWorkspaceVersion', () => {
    it('reads version from the [workspace.package] section', () => {
        const toml = '[workspace]\nmembers = ["a"]\n\n[workspace.package]\nversion = "1.2.3"\nedition = "2021"\n';
        expect(parseCargoWorkspaceVersion(toml)).toBe('1.2.3');
    });

    it('does not grab a version= from an earlier section by position (#102)', () => {
        const toml = '[package]\nversion = "9.9.9"\n\n[workspace.package]\nversion = "1.2.3"\n';
        expect(parseCargoWorkspaceVersion(toml)).toBe('1.2.3');
    });

    it('finds version when it is not the first key in the section', () => {
        const toml = '[workspace.package]\nedition = "2021"\nversion = "4.5.6"\n';
        expect(parseCargoWorkspaceVersion(toml)).toBe('4.5.6');
    });

    it('returns null when there is no [workspace.package] version', () => {
        expect(parseCargoWorkspaceVersion('[workspace]\nmembers = []\n')).toBeNull();
    });
});
