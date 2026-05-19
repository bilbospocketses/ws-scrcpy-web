import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('fs');
vi.mock('child_process');

import { detectLibc } from '../libcDetect';
import * as fs from 'fs';
import * as childProcess from 'child_process';

const fsModule = vi.mocked(fs);
const childProcessModule = vi.mocked(childProcess);

describe('detectLibc', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        vi.clearAllMocks();
    });

    function setPlatform(p: string): void {
        Object.defineProperty(process, 'platform', { value: p, configurable: true });
    }

    it('returns glibc on win32 regardless of other signals', () => {
        setPlatform('win32');
        expect(detectLibc()).toBe('glibc');
    });

    it('returns glibc on linux when process.report has glibcVersionRuntime', () => {
        setPlatform('linux');
        vi.spyOn(process.report as any, 'getReport').mockReturnValue({
            header: { glibcVersionRuntime: '2.35' },
        });
        expect(detectLibc()).toBe('glibc');
    });

    it('returns musl on linux when /etc/alpine-release exists and glibc marker is absent', () => {
        setPlatform('linux');
        vi.spyOn(process.report as any, 'getReport').mockReturnValue({ header: {} });
        fsModule.accessSync.mockImplementation((path: fs.PathLike) => {
            if (path !== '/etc/alpine-release') throw new Error('ENOENT');
        });
        expect(detectLibc()).toBe('musl');
    });

    it('falls back to glibc on linux when no signals are present', () => {
        setPlatform('linux');
        vi.spyOn(process.report as any, 'getReport').mockReturnValue({ header: {} });
        fsModule.accessSync.mockImplementation(() => { throw new Error('ENOENT'); });
        childProcessModule.execFileSync.mockImplementation(() => { throw new Error('ldd not found'); });
        expect(detectLibc()).toBe('glibc');
    });
});
