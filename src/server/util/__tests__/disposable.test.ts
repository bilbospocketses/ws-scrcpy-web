import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { tempDir } from '../disposable';

describe('tempDir', () => {
    it('creates a writable temp directory and removes it on dispose', () => {
        let capturedPath: string;
        {
            using td = tempDir('disposable-test-');
            capturedPath = td.path;

            expect(fs.existsSync(td.path)).toBe(true);
            expect(fs.statSync(td.path).isDirectory()).toBe(true);

            // Write a file to confirm directory is writable and that cleanup
            // recurses (default rmSync is non-recursive and would throw here).
            fs.writeFileSync(path.join(td.path, 'probe.txt'), 'hello');
            expect(fs.existsSync(path.join(td.path, 'probe.txt'))).toBe(true);
        }
        expect(fs.existsSync(capturedPath)).toBe(false);
    });

    it('uses the supplied prefix in the directory name', () => {
        using td = tempDir('custom-prefix-§25-');
        expect(path.basename(td.path).startsWith('custom-prefix-§25-')).toBe(true);
    });

    it('defaults the prefix to ws-scrcpy- when none is supplied', () => {
        using td = tempDir();
        expect(path.basename(td.path).startsWith('ws-scrcpy-')).toBe(true);
    });

    it('does not throw when the directory has already been removed', () => {
        const td = tempDir('disposable-already-removed-');
        fs.rmSync(td.path, { recursive: true, force: true });
        // Manually invoke dispose — must not throw even though the
        // backing directory is gone (force: true on the internal rmSync).
        expect(() => td[Symbol.dispose]()).not.toThrow();
    });
});
