import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Item 122. `biome.json` declared schema 2.5.11 while the pinned CLI was 2.5.12.
 * Biome notices — "The configuration schema version does not match the CLI
 * version" — but it says so at INFO level and still exits 0, so `npm run lint`
 * stayed green and the drift sat there unread. The gap opens on its own every
 * time Dependabot bumps the devDependency, because nothing in that bump touches
 * the `$schema` string.
 *
 * This test closes it: the declared schema must equal the installed CLI, so the
 * bump that forgets `npx biome migrate` fails `npm test` instead of whispering.
 */
export function schemaVersionFromUrl(url) {
    const match = /^https:\/\/biomejs\.dev\/schemas\/([^/]+)\/schema\.json$/.exec(url ?? '');
    if (!match) {
        throw new Error(`biome.json $schema is not a recognised Biome schema URL: ${url}`);
    }
    return match[1];
}

describe('schemaVersionFromUrl', () => {
    it('extracts the version segment', () => {
        expect(schemaVersionFromUrl('https://biomejs.dev/schemas/2.5.12/schema.json')).toBe('2.5.12');
    });

    it('rejects anything that is not a Biome schema URL', () => {
        expect(() => schemaVersionFromUrl('https://example.test/schema.json')).toThrow(/not a recognised/);
        expect(() => schemaVersionFromUrl(undefined)).toThrow(/not a recognised/);
    });
});

describe('biome.json', () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, 'biome.json'), 'utf8'));

    it('declares the schema version of the installed Biome CLI', () => {
        const installed = JSON.parse(
            readFileSync(join(REPO_ROOT, 'node_modules', '@biomejs', 'biome', 'package.json'), 'utf8'),
        ).version;
        expect(
            schemaVersionFromUrl(config.$schema),
            'run `npx biome migrate --write` after bumping @biomejs/biome',
        ).toBe(installed);
    });

    /**
     * `recommended: true` was deprecated in favour of `preset: "recommended"`
     * and is slated for removal in Biome's next major. Catching it here means
     * the removal lands as a clear test failure rather than as a config that
     * silently stops enabling the recommended rules.
     */
    it('uses the preset field, not the deprecated recommended field', () => {
        expect(config.linter?.rules?.recommended).toBeUndefined();
        expect(config.linter?.rules?.preset).toBe('recommended');
    });
});
