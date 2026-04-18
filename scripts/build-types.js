#!/usr/bin/env node
/**
 * Builds dist/public/ws-scrcpy.d.ts via dts-bundle-generator's programmatic API.
 *
 * Previously this file monkey-patched checkProgramDiagnosticsErrors because
 * dts-bundle-generator ignores tsconfig's `include` and only loads the entry
 * file + its transitive imports — so our ambient declarations in
 * src/types/assets.d.ts and the @types/node globals were unreachable, and
 * the tool aborted before writing.  The entry now pulls both in via
 * /// <reference> directives (see src/app/public/index.ts), so the program
 * compiles clean and no patch is needed.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { generateDtsBundle } = require('dts-bundle-generator');

const repoRoot = path.resolve(__dirname, '..');
const entryFile = path.join(repoRoot, 'src', 'app', 'public', 'index.ts');
const outFile = path.join(repoRoot, 'dist', 'public', 'ws-scrcpy.d.ts');
const tsconfig = path.join(repoRoot, 'tsconfig.json');

const [generated] = generateDtsBundle(
    [
        {
            filePath: entryFile,
            output: { noBanner: false },
        },
    ],
    { preferredConfigPath: tsconfig },
);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, generated);
console.log(`[build-types] wrote ${path.relative(repoRoot, outFile)} (${generated.length} bytes)`);
