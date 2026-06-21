import * as path from 'path';

/**
 * Absolute path to the legacy `device-labels.json` — bundle-relative, the exact
 * path the (now-removed, Phase 2) per-file JSON label store wrote to. The one-time
 * SQLite import (`importLegacy`) reads it so an existing install's labels migrate
 * into the per-user `device_labels` table. Resolution is unchanged from the old
 * store (this module sits in the same directory, so `__dirname` matches), so old
 * files are still found.
 */
export const DEFAULT_DEVICE_LABELS_PATH = path.resolve(__dirname, '..', 'device-labels.json');
