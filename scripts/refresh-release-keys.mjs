#!/usr/bin/env node
// scripts/refresh-release-keys.mjs
//
// M5: regenerates src/server/release-keys/pinnedReleaseKeys.ts, the OpenPGP
// keys the dependency updater accepts on Node.js's SHASUMS256.txt and on
// scrcpy's SHA256SUMS.txt (see DependencyManager.fetchSignedChecksumList).
//
// Run it when the network-gated test fails with "is not a pinned Node.js
// release key" (a new Node releaser), or when scrcpy announces a new key:
//
//   node scripts/refresh-release-keys.mjs
//   WS_SCRCPY_NETWORK_TESTS=1 npx vitest run src/server/__tests__/releaseSignatures.network.test.ts
//
// then review the printed fingerprint diff and commit the regenerated module.
// It is a maintainer tool: the app never fetches keys at run time, and a key
// this script has not pinned refuses the install (user decision 2026-10-07).
//
// Sources, each cross-checked against a second one:
//   Node.js  every key in https://github.com/nodejs/release-keys -- active AND
//            retired, because a retired key still vouches for the releases it
//            signed. The README's two lists must equal keys.list exactly, and
//            every key's fingerprint must equal its file name. Fingerprints
//            missing from nodejs/node's README "Release keys" section are
//            printed as a warning.
//   scrcpy   https://blog.rom1v.com/keys/rom1v.asc, whose primary fingerprint
//            must appear in Genymobile/scrcpy doc/verify-release.md.
//
// Writes only the generated module. Exit 1 on any check that fails, with
// nothing written.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as openpgp from 'openpgp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const OUT = path.join(REPO_ROOT, 'src', 'server', 'release-keys', 'pinnedReleaseKeys.ts');

const NODE_RAW = 'https://raw.githubusercontent.com/nodejs/release-keys/main';
const NODE_README_RAW = 'https://raw.githubusercontent.com/nodejs/node/main/README.md';
const ROM1V_KEY_URL = 'https://blog.rom1v.com/keys/rom1v.asc';
const SCRCPY_VERIFY_DOC_RAW = 'https://raw.githubusercontent.com/Genymobile/scrcpy/master/doc/verify-release.md';

const today = new Date().toISOString().slice(0, 10);

async function fetchText(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'ws-scrcpy-web refresh-release-keys' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.text()).replace(/\r\n/g, '\n');
}

function fail(message) {
    console.error('refresh-release-keys:', message);
    process.exit(1);
}

/** `* **Name** <<email>>` followed by one or more `[`FPR`](./keys/FPR.asc)` lines, inside one marker pair. */
function parseReadmeSection(readme, open, close) {
    const start = readme.indexOf(open);
    const end = readme.indexOf(close);
    if (start < 0 || end < start) fail(`release-keys README has no "${open}" ... "${close}" section`);
    const out = [];
    let owner = null;
    for (const line of readme.slice(start + open.length, end).split('\n')) {
        const who = line.match(/^\*\s+\*\*(.+?)\*\*\s+<<?([^>]+)>>?/);
        if (who) owner = `${who[1]} <${who[2]}>`;
        for (const m of line.matchAll(/\[`([0-9A-F]{40})`\]\(\.\/keys\/([0-9A-F]{40})\.asc\)/g)) {
            if (m[1] !== m[2]) fail(`README links ${m[1]} to keys/${m[2]}.asc`);
            if (!owner) fail(`README lists ${m[1]} with no owner above it`);
            out.push({ fingerprint: m[1], owner });
        }
    }
    return out;
}

/** Armored keys go into template literals; refuse anything that could escape one. */
function assertTemplateSafe(armored, label) {
    if (/[`\\]|\$\{/.test(armored)) fail(`${label}'s armored block contains a character a template literal cannot hold`);
}

async function readPublicKey(armored, expected, label) {
    const key = await openpgp.readKey({ armoredKey: armored });
    if (key.isPrivate()) fail(`${label} is a PRIVATE key`);
    const actual = key.getFingerprint().toUpperCase();
    if (expected && actual !== expected) fail(`${label} parses as ${actual}, not ${expected}`);
    return key;
}

async function nodeKeys() {
    const readme = await fetchText(`${NODE_RAW}/README.md`);
    const active = parseReadmeSection(readme, '<!-- Active releasers keys -->', '<!-- /Active releasers keys -->');
    const retired = parseReadmeSection(readme, '<!-- Retired keys -->', '<!-- /Retired keys -->');
    const listed = [
        ...active.map((k) => ({ ...k, status: 'active' })),
        ...retired.map((k) => ({ ...k, status: 'retired' })),
    ];
    const keysList = (await fetchText(`${NODE_RAW}/keys.list`))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    const fromReadme = new Set(listed.map((k) => k.fingerprint));
    const fromList = new Set(keysList);
    const onlyReadme = [...fromReadme].filter((f) => !fromList.has(f));
    const onlyList = [...fromList].filter((f) => !fromReadme.has(f));
    if (onlyReadme.length || onlyList.length || fromReadme.size !== listed.length) {
        fail(
            `release-keys README and keys.list disagree (README only: ${onlyReadme.join(', ') || 'none'}; ` +
                `keys.list only: ${onlyList.join(', ') || 'none'}; duplicates: ${listed.length - fromReadme.size})`,
        );
    }

    const nodeReadme = await fetchText(NODE_README_RAW);
    const absent = listed.filter((k) => !nodeReadme.includes(k.fingerprint)).map((k) => k.fingerprint);
    if (absent.length) {
        console.warn('warning: not in nodejs/node README "Release keys":', absent.join(', '));
    }

    const out = [];
    for (const k of listed) {
        const source = `${NODE_RAW}/keys/${k.fingerprint}.asc`;
        const armored = await fetchText(source);
        await readPublicKey(armored, k.fingerprint, `Node.js key ${k.fingerprint}`);
        assertTemplateSafe(armored, k.fingerprint);
        out.push({ ...k, source, fetched: today, armored: armored.endsWith('\n') ? armored : `${armored}\n` });
    }
    return out.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

async function scrcpyKeys() {
    const armored = await fetchText(ROM1V_KEY_URL);
    const key = await readPublicKey(armored, null, 'rom1v.asc');
    const fingerprint = key.getFingerprint().toUpperCase();
    const doc = (await fetchText(SCRCPY_VERIFY_DOC_RAW)).replace(/[ \t]/g, '');
    if (!doc.includes(fingerprint)) {
        fail(`rom1v.asc's fingerprint ${fingerprint} is not in scrcpy's doc/verify-release.md`);
    }
    assertTemplateSafe(armored, 'rom1v.asc');
    const uid = key.users.map((u) => u.userID?.userID).find(Boolean) ?? 'Romain Vimont';
    return [
        {
            fingerprint,
            owner: uid,
            status: 'active',
            source: ROM1V_KEY_URL,
            fetched: today,
            armored: armored.endsWith('\n') ? armored : `${armored}\n`,
        },
    ];
}

function previousFingerprints(out) {
    if (!fs.existsSync(out)) return { node: [], scrcpy: [] };
    const src = fs.readFileSync(out, 'utf8');
    const section = (name) => {
        const start = src.indexOf(`export const ${name}`);
        if (start < 0) return [];
        const end = src.indexOf('];', start);
        return [...src.slice(start, end).matchAll(/fingerprint: '([0-9A-F]{40})'/g)].map((m) => m[1]);
    };
    return { node: section('NODE_RELEASE_KEYS'), scrcpy: section('SCRCPY_RELEASE_KEYS') };
}

function printDiff(label, before, after) {
    const added = after.filter((f) => !before.includes(f));
    const removed = before.filter((f) => !after.includes(f));
    if (!added.length && !removed.length) {
        console.log('%s: %d keys, unchanged', label, after.length);
        return;
    }
    console.log('%s: %d keys', label, after.length);
    for (const f of added) console.log('  + %s', f);
    for (const f of removed) console.log('  - %s', f);
}

const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function entry(k) {
    return [
        '    {',
        `        fingerprint: ${q(k.fingerprint)},`,
        `        owner: ${q(k.owner)},`,
        `        status: ${q(k.status)},`,
        `        source: ${q(k.source)},`,
        `        fetched: ${q(k.fetched)},`,
        `        armored: \`${k.armored}\`,`,
        '    },',
    ].join('\n');
}

/** Fetches and checks every key, then returns the module text and the fingerprints it pins. */
export async function buildPinnedKeysModule() {
    const node = await nodeKeys();
    const scrcpy = await scrcpyKeys();
    const module = `// GENERATED by scripts/refresh-release-keys.mjs -- do not edit by hand; run the script.
//
// The OpenPGP keys the dependency updater accepts (M5). A hash list signed by any
// other key refuses the install, and nothing here is fetched at run time. The
// keys are embedded in a module, not shipped as files, so they travel inside the
// server bundle into every package (Velopack, AppImage/.deb, the Docker image)
// with no packaging step that could leave them behind.
//
// Node.js: every key in https://github.com/nodejs/release-keys, active and
// retired. A retired key stays because it still vouches for the releases it
// signed; verifyOpenPgp checks a key's validity at the signature's creation time.
// scrcpy: Romain Vimont's key, whose signing subkey signs every release since v2.0.

import type { PinnedKey } from '../verifyOpenPgp';

export interface PinnedReleaseKey extends PinnedKey {
    /** Which list in nodejs/release-keys' README names it; scrcpy's is \`active\`. */
    readonly status: 'active' | 'retired';
    /** Where scripts/refresh-release-keys.mjs fetched it from. */
    readonly source: string;
    /** When (UTC date). */
    readonly fetched: string;
}

export const NODE_RELEASE_KEYS: readonly PinnedReleaseKey[] = [
${node.map(entry).join('\n')}
];

export const SCRCPY_RELEASE_KEYS: readonly PinnedReleaseKey[] = [
${scrcpy.map(entry).join('\n')}
];
`;
    return { module, node: node.map((k) => k.fingerprint), scrcpy: scrcpy.map((k) => k.fingerprint) };
}

/** Writes `out` (the pinned module by default) and prints what changed against what it held. */
export async function refresh(out = OUT) {
    const before = previousFingerprints(out);
    const built = await buildPinnedKeysModule();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, built.module);
    console.log('wrote %s', path.relative(REPO_ROOT, out));
    printDiff('Node.js', before.node, built.node);
    printDiff('scrcpy', before.scrcpy, built.scrcpy);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await refresh();
}
