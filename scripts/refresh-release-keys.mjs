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
// Every armored key is stored VERBATIM, as published: no minimising, no
// cleaning, every self-signature and subkey binding kept. verifyOpenPgp refuses
// a signature made while the key, or the self-signature it then carried, had
// expired -- and it can only see that lapse while the pinned copy still holds
// the old self-signature. So a refresh refuses to drop one: if a fetched key
// lacks any self-signature or subkey binding the currently pinned copy has (in
// particular, if it has fewer), the script fails, unless run with
//
//   node scripts/refresh-release-keys.mjs --allow-dropped-self-signatures
//
// which pins the fetched copy anyway and lists what it drops. The counts of
// each pinned key's self-signatures and bindings are recorded beside it, and
// verifyOpenPgp.test.ts checks the armored blocks still carry them.
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

/** How many self-signatures (all user IDs) and subkey binding signatures (all subkeys) a key carries. */
export function signatureCounts(key) {
    return {
        selfSignatures: key.users.reduce((n, u) => n + u.selfCertifications.length, 0),
        subkeyBindings: key.subkeys.reduce((n, s) => n + s.bindingSignatures.length, 0),
    };
}

const packetHex = (signature) => Buffer.from(signature.write()).toString('hex');

/** Every self-signature and subkey binding of `key`: identity (what it signs + exact bytes) -> description. */
function selfSignaturesOf(key) {
    const out = new Map();
    for (const u of key.users) {
        const what = u.userID ? `self-signature on user ID "${u.userID.userID}"` : 'self-signature on a user attribute';
        for (const s of u.selfCertifications) {
            out.set(`${what}:${packetHex(s)}`, `${what} made ${s.created?.toISOString()}`);
        }
    }
    for (const sub of key.subkeys) {
        const what = `binding of subkey ${sub.getFingerprint().toUpperCase()}`;
        for (const s of sub.bindingSignatures) {
            out.set(`${what}:${packetHex(s)}`, `${what} made ${s.created?.toISOString()}`);
        }
    }
    return out;
}

/** The self-signatures and subkey bindings `pinned` carries that `fetched` does not, described. */
export function droppedSelfSignatures(pinned, fetched) {
    const kept = selfSignaturesOf(fetched);
    return [...selfSignaturesOf(pinned)].filter(([id]) => !kept.has(id)).map(([, described]) => described);
}

/**
 * Fails on (or, with `allowDropped`, warns about) a fetched key that lacks a
 * self-signature or binding the pinned copy of the same key has.
 */
async function checkNothingDropped(label, fingerprint, fetched, options) {
    const pinnedArmored = options.previous.get(fingerprint);
    if (!pinnedArmored) return;
    const dropped = droppedSelfSignatures(await openpgp.readKey({ armoredKey: pinnedArmored }), fetched);
    if (!dropped.length) return;
    const message = `${label} as fetched lacks ${dropped.length} self-signature(s) or binding(s) the pinned copy has: ${dropped.join('; ')}`;
    if (!options.allowDropped) {
        fail(
            `${message}. The old ones are what lets a signature made while the key had lapsed be refused; ` +
                'rerun with --allow-dropped-self-signatures only after reviewing why the publisher dropped them',
        );
    }
    console.warn('warning: --allow-dropped-self-signatures: %s', message);
}

async function nodeKeys(options) {
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
        const key = await readPublicKey(armored, k.fingerprint, `Node.js key ${k.fingerprint}`);
        assertTemplateSafe(armored, k.fingerprint);
        await checkNothingDropped(`Node.js key ${k.fingerprint}`, k.fingerprint, key, options);
        out.push({
            ...k,
            source,
            fetched: today,
            ...signatureCounts(key),
            armored: armored.endsWith('\n') ? armored : `${armored}\n`,
        });
    }
    return out.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

async function scrcpyKeys(options) {
    const armored = await fetchText(ROM1V_KEY_URL);
    const key = await readPublicKey(armored, null, 'rom1v.asc');
    const fingerprint = key.getFingerprint().toUpperCase();
    const doc = (await fetchText(SCRCPY_VERIFY_DOC_RAW)).replace(/[ \t]/g, '');
    if (!doc.includes(fingerprint)) {
        fail(`rom1v.asc's fingerprint ${fingerprint} is not in scrcpy's doc/verify-release.md`);
    }
    assertTemplateSafe(armored, 'rom1v.asc');
    await checkNothingDropped('rom1v.asc', fingerprint, key, options);
    const uid = key.users.map((u) => u.userID?.userID).find(Boolean) ?? 'Romain Vimont';
    return [
        {
            fingerprint,
            owner: uid,
            status: 'active',
            source: ROM1V_KEY_URL,
            fetched: today,
            ...signatureCounts(key),
            armored: armored.endsWith('\n') ? armored : `${armored}\n`,
        },
    ];
}

/**
 * The armored keys the module at `out` pins now, by fingerprint. Fails closed:
 * this feeds the "no self-signature dropped" check, so a module whose keys
 * cannot all be read back (its format changed) must stop the refresh rather
 * than yield an empty map that skips that check without a word.
 */
export function previousArmored(out) {
    const pinned = new Map();
    if (!fs.existsSync(out)) return pinned;
    const src = fs.readFileSync(out, 'utf8');
    for (const m of src.matchAll(/fingerprint: '([0-9A-F]{40})',[^`]*?armored: `([^`]*)`/g)) pinned.set(m[1], m[2]);
    const listed = new Set([...src.matchAll(/fingerprint: '([0-9A-F]{40})'/g)].map((m) => m[1]));
    if (listed.size === 0 || pinned.size !== listed.size) {
        fail(
            `could read ${pinned.size} armored key(s) from ${out} but it lists ${listed.size} fingerprint(s); ` +
                'its format no longer matches this script, so the dropped-self-signature check cannot run. ' +
                'Fix previousArmored before refreshing.',
        );
    }
    return pinned;
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
        `        selfSignatures: ${k.selfSignatures},`,
        `        subkeyBindings: ${k.subkeyBindings},`,
        `        armored: \`${k.armored}\`,`,
        '    },',
    ].join('\n');
}

/**
 * Fetches and checks every key, then returns the module text and the
 * fingerprints it pins. `previous` holds the armored keys pinned now, by
 * fingerprint, so a key that drops a self-signature fails (see the top).
 */
export async function buildPinnedKeysModule({ previous = new Map(), allowDropped = false } = {}) {
    const options = { previous, allowDropped };
    const node = await nodeKeys(options);
    const scrcpy = await scrcpyKeys(options);
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
    /**
     * How many self-signatures (all user IDs) and subkey binding signatures
     * (all subkeys) the armored key, stored verbatim, carried when fetched. A
     * refresh refuses to drop any: the old ones are what lets a signature made
     * while the key had lapsed be refused.
     */
    readonly selfSignatures: number;
    readonly subkeyBindings: number;
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
export async function refresh(out = OUT, { allowDropped = false } = {}) {
    const before = previousFingerprints(out);
    const built = await buildPinnedKeysModule({ previous: previousArmored(out), allowDropped });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, built.module);
    console.log('wrote %s', path.relative(REPO_ROOT, out));
    printDiff('Node.js', before.node, built.node);
    printDiff('scrcpy', before.scrcpy, built.scrcpy);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const unknown = args.filter((a) => a !== '--allow-dropped-self-signatures');
    if (unknown.length) fail(`unknown argument(s): ${unknown.join(' ')}`);
    await refresh(OUT, { allowDropped: args.includes('--allow-dropped-self-signatures') });
}
