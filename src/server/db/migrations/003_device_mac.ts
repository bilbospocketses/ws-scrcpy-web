import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../migrations';

// The MAC a device was last seen with (row 19.5 follow-up).
//
// On a host, a connect files the device's name under its MAC as well as its
// serial, so a rescan that only has the MAC (from ARP) can still find it. The
// card renames and clears by serial, and nothing linked the serial to that MAC
// copy, so a cleared name came back on the next rescan. This column is the
// link: `PUT /api/devices/labels` reads it to keep the MAC copy in step.
const DDL = `
ALTER TABLE devices ADD COLUMN mac TEXT;
`;

export const migration003: Migration = {
    version: 3,
    up(db: DatabaseSync): void {
        db.exec(DDL);
    },
};
