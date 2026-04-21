import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getArch, getDependencyDefinitions, getPlatform, NODE_LTS_ABI, parseNodeMajor } from '../DependencyDefinitions';
import * as NodePtyResolver from '../NodePtyResolver';

describe('getPlatform', () => {
    it('returns win32 or linux based on os.platform()', () => {
        const platform = getPlatform();
        expect(['win32', 'linux']).toContain(platform);
    });
});

describe('getArch', () => {
    it('returns x64 or arm64', () => {
        const arch = getArch();
        expect(['x64', 'arm64']).toContain(arch);
    });
});

describe('getDependencyDefinitions', () => {
    it('returns definitions for all managed dependencies', () => {
        const defs = getDependencyDefinitions('/tmp/test-deps');
        const names = defs.map((d) => d.name);
        expect(names).toContain('nodejs');
        expect(names).toContain('adb');
        expect(names).toContain('scrcpy-server');
    });

    it('each definition has required fields', () => {
        const defs = getDependencyDefinitions('/tmp/test-deps');
        for (const def of defs) {
            expect(def.name).toBeTruthy();
            expect(def.displayName).toBeTruthy();
            expect(def.description).toBeTruthy();
            expect(typeof def.checkInstalled).toBe('function');
            expect(typeof def.checkLatest).toBe('function');
        }
    });

    it('nodejs definition includes node-pty pairing', () => {
        const defs = getDependencyDefinitions('/tmp/test-deps');
        const node = defs.find((d) => d.name === 'nodejs');
        expect(node?.pairedWith).toBe('node-pty');
        expect(node?.requiresRestart).toBe(true);
    });

    it('scrcpy-server does not require restart', () => {
        const defs = getDependencyDefinitions('/tmp/test-deps');
        const scrcpy = defs.find((d) => d.name === 'scrcpy-server');
        expect(scrcpy?.requiresRestart).toBe(false);
    });
});

describe('parseNodeMajor', () => {
    it('parses leading-v version strings', () => {
        expect(parseNodeMajor('v24.14.1')).toBe(24);
    });

    it('parses bare version strings', () => {
        expect(parseNodeMajor('22.11.0')).toBe(22);
    });

    it('returns NaN for garbage input', () => {
        expect(parseNodeMajor('not-a-version')).toBeNaN();
    });
});

describe('NODE_LTS_ABI', () => {
    it('covers known LTS majors with string ABI values', () => {
        // These ABIs are documented in process.versions.modules across Node releases.
        expect(NODE_LTS_ABI[20]).toBe('115');
        expect(NODE_LTS_ABI[22]).toBe('127');
        expect(NODE_LTS_ABI[24]).toBe('137');
    });

    it('does not include non-LTS majors', () => {
        expect(NODE_LTS_ABI[21]).toBeUndefined();
        expect(NODE_LTS_ABI[23]).toBeUndefined();
    });
});

describe('nodejs.checkLatest (Option D gating)', () => {
    const ltsReleases = [
        { version: 'v26.0.0', lts: 'Theta' },
        { version: 'v24.14.1', lts: 'Krypton' },
        { version: 'v22.11.0', lts: 'Jod' },
        { version: 'v20.15.0', lts: 'Iron' },
    ];

    let fetchSpy: ReturnType<typeof vi.spyOn>;
    let manifestSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(JSON.stringify(ltsReleases), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        manifestSpy?.mockRestore();
    });

    function getNodejsDef() {
        const defs = getDependencyDefinitions('/tmp/test-deps');
        const d = defs.find((x) => x.name === 'nodejs');
        if (!d) throw new Error('nodejs definition missing');
        return d;
    }

    it('returns newest LTS covered by manifest', async () => {
        manifestSpy = vi.spyOn(NodePtyResolver, 'loadManifest').mockResolvedValue({
            upstreamVersion: '1.1.0',
            coveredAbis: ['115', '127', '137'],
        });
        const def = getNodejsDef();
        expect(await def.checkLatest()).toBe('24.14.1');
    });

    it('returns the next-newest LTS when latest has no prebuilt', async () => {
        manifestSpy = vi.spyOn(NodePtyResolver, 'loadManifest').mockResolvedValue({
            upstreamVersion: '1.1.0',
            coveredAbis: ['115', '127'],
        });
        const def = getNodejsDef();
        expect(await def.checkLatest()).toBe('22.11.0');
    });

    it('returns null when no LTS in manifest coverage', async () => {
        manifestSpy = vi.spyOn(NodePtyResolver, 'loadManifest').mockResolvedValue({
            upstreamVersion: '1.1.0',
            coveredAbis: ['100'],
        });
        const def = getNodejsDef();
        expect(await def.checkLatest()).toBeNull();
    });

    it('falls back to unfiltered latest when manifest is null', async () => {
        manifestSpy = vi.spyOn(NodePtyResolver, 'loadManifest').mockResolvedValue(null);
        const def = getNodejsDef();
        expect(await def.checkLatest()).toBe('26.0.0');
    });

    it('ignores Node majors not in NODE_LTS_ABI (skips unknown)', async () => {
        const original = { ...NODE_LTS_ABI };
        delete (NODE_LTS_ABI as Record<number, string>)[26];
        try {
            manifestSpy = vi.spyOn(NodePtyResolver, 'loadManifest').mockResolvedValue({
                upstreamVersion: '1.1.0',
                coveredAbis: ['115', '127', '137'],
            });
            const def = getNodejsDef();
            expect(await def.checkLatest()).toBe('24.14.1');
        } finally {
            Object.assign(NODE_LTS_ABI, original);
        }
    });
});
