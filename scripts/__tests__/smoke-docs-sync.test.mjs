// The smoke rows are enumerated in three places and counted in several more, all
// by hand: the rows themselves in smoke-test.md, that file's module index, the
// `## Every row` table in automation-coverage.md, and the totals that register
// restates in its bucket table and its prose. Before this test the only check
// that had ever run was a person counting two of them (2026-09-23, both 155).
//
// Sets, not counts: equal counts with a swapped id is exactly what a count check
// passes. And the register's percentages are the numbers quoted to qa-harness, so
// a denominator that drifts makes every one of them wrong in a direction nobody
// can see. Writing this test found one already: 20.4 and 20.5 had no spec but
// were counted as automated container rows (13 instead of 11).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'smoke-tests');
const smoke = readFileSync(join(DIR, 'smoke-test.md'), 'utf8');
const register = readFileSync(join(DIR, 'automation-coverage.md'), 'utf8');

const cells = (line) =>
    line
        .split('|')
        .slice(1, -1)
        .map((c) => c.replace(/\*\*/g, '').trim());

// `| ☐ <a id="t-4-2-user"></a> **4.2-user** ...`
const rows = smoke
    .split('\n')
    .filter((l) => /^\|\s*☐/.test(l))
    .map((l) => {
        const m = /^\|\s*☐\s*<a id="t-([^"]+)"><\/a>\s*\*\*([^*]+)\*\*/.exec(l);
        if (!m) throw new Error(`smoke-test.md: a row does not open with an anchor and a bold id: ${l.slice(0, 100)}`);
        return { anchor: m[1], id: m[2] };
    });
const rowIds = rows.map((r) => r.id);

// `- **Module 4 — Service mode:** [4.1](#t-4-1) · ...`
const indexIds = [...smoke.matchAll(/\[([^\]]+)\]\(#t-[^)]+\)/g)].map((m) => m[1]);

const everyRow = (() => {
    const parts = register.split(/^## Every row\s*$/m);
    if (parts.length !== 2) throw new Error('automation-coverage.md: expected exactly one "## Every row" section');
    return parts[1]
        .split(/^## /m)[0]
        .split('\n')
        .filter((l) => /^\|/.test(l))
        .slice(2) // header + separator
        .map(cells)
        .map((c) => ({ id: c[0], bucket: c[3] }));
})();

// The bucket table's labels, and which `## Every row` Bucket values each one counts.
// A new bucket value fails the tally test until it is placed here, on purpose.
const BUCKETS = {
    'Automated, fast tier': ['fast'],
    'Automated, container tier': ['container'],
    'Automated, device tier': ['device'],
    'Automated, Windows guest tier': ['windows guest'],
    'Automatable, no spec written yet': ['automatable: no spec yet', 'automatable — container'],
    'Automated, manual/conditional': ['manual/conditional'],
    'Residual — Linux installer and desktop': ['residual: linux-desktop'],
    'Residual — un-automatable': ['residual: un-automatable'],
};
const AUTOMATED = [
    'Automated, fast tier',
    'Automated, container tier',
    'Automated, device tier',
    'Automated, Windows guest tier',
];

const bucketTable = (() => {
    const lines = register.split('\n');
    const start = lines.findIndex((l) => /^\|\s*\|\s*Rows\s*\|/.test(l));
    if (start < 0) throw new Error('automation-coverage.md: bucket table (header "| | Rows | Where |") not found');
    const out = {};
    for (const l of lines.slice(start + 2)) {
        if (!/^\|/.test(l)) break;
        const [label, n] = cells(l);
        out[label] = Number(n);
    }
    return out;
})();

const dupes = (xs) => xs.filter((x, i) => xs.indexOf(x) !== i);
const diff = (a, b) => ({ missing: b.filter((x) => !a.includes(x)), extra: a.filter((x) => !b.includes(x)) });

describe('smoke-test.md rows', () => {
    it('has rows to check', () => {
        expect(rows.length).toBeGreaterThan(100);
    });

    it('has no duplicate row ids', () => {
        expect(dupes(rowIds)).toEqual([]);
    });

    it("anchors every row as t-<id with dots as dashes>, which the module index's links rely on", () => {
        expect(rows.filter((r) => r.anchor !== r.id.replace(/\./g, '-'))).toEqual([]);
    });

    it('lists exactly the same ids in its module index', () => {
        expect(dupes(indexIds)).toEqual([]);
        expect(diff(indexIds, rowIds)).toEqual({ missing: [], extra: [] });
    });
});

describe('automation-coverage.md against smoke-test.md', () => {
    it('## Every row holds exactly the same row ids', () => {
        const ids = everyRow.map((r) => r.id);
        expect(dupes(ids)).toEqual([]);
        expect(diff(ids, rowIds)).toEqual({ missing: [], extra: [] });
    });

    it('every Bucket value in ## Every row belongs to a bucket-table line', () => {
        const known = Object.values(BUCKETS).flat();
        expect([...new Set(everyRow.map((r) => r.bucket))].filter((b) => !known.includes(b))).toEqual([]);
    });

    it('the bucket table has exactly the known lines, plus Total', () => {
        expect(Object.keys(bucketTable).sort()).toEqual([...Object.keys(BUCKETS), 'Total'].sort());
    });

    it.each(Object.entries(BUCKETS))('bucket table "%s" matches its ## Every row tally', (label, values) => {
        const tally = everyRow.filter((r) => values.includes(r.bucket)).length;
        expect(bucketTable[label]).toBe(tally);
    });

    it('bucket table Total is the row count', () => {
        expect(bucketTable.Total).toBe(rowIds.length);
    });

    it('the provenance paragraph ends on the row count', () => {
        const m = /so the doc holds\s+\*\*(\d+)\*\*/.exec(register);
        expect(m, 'provenance sentence "so the doc holds **N**" not found').not.toBeNull();
        expect(Number(m[1])).toBe(rowIds.length);
    });

    it('"Automated today: A of N" is the automated tiers over the row count', () => {
        const m = /\*\*Automated today: (\d+) of (\d+) = (\d+) %\.\*\*/.exec(register);
        expect(m, 'headline "**Automated today: A of N = P %.**" not found').not.toBeNull();
        const automated = AUTOMATED.reduce((sum, label) => sum + bucketTable[label], 0);
        expect(Number(m[1])).toBe(automated);
        expect(Number(m[2])).toBe(rowIds.length);
        expect(Number(m[3])).toBe(Math.round((100 * automated) / rowIds.length));
    });
});
