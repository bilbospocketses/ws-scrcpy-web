#!/usr/bin/env node
/**
 * Rotate raw RGBA pixels into ARGB32, network byte order — the pixmap format
 * a StatusNotifierItem host expects (`ksni::Icon`). ImageMagick can emit raw
 * `RGBA:` but has no `ARGB:` coder, hence this shim. stdin → stdout.
 *
 *   magick assets/tray-icon.png -resize 22x22 -depth 8 RGBA:- \
 *     | node scripts/rgba-to-argb.mjs > assets/tray-icon-22.argb
 *
 * Developer-side, run once when the icon changes; the result is committed and
 * embedded with include_bytes! (common/src/tray_policy.rs). Nothing at build
 * or run time invokes ImageMagick.
 */
import { readFileSync, writeSync } from 'node:fs';

const rgba = readFileSync(0);
if (rgba.length === 0 || rgba.length % 4 !== 0) {
    console.error(`rgba-to-argb: ${rgba.length} bytes is not a whole number of RGBA pixels`);
    process.exit(1);
}
const argb = Buffer.alloc(rgba.length);
for (let i = 0; i < rgba.length; i += 4) {
    argb[i] = rgba[i + 3];
    argb[i + 1] = rgba[i];
    argb[i + 2] = rgba[i + 1];
    argb[i + 3] = rgba[i + 2];
}
writeSync(1, argb);
