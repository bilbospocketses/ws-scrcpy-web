import * as fs from 'fs';
import * as path from 'path';

// Exported so the SQLite migration (Db / importLegacy) reads the SAME legacy
// file this store wrote — it is bundle-relative (next to dist/), NOT under
// <dataRoot>, so the importer must use this exact path, not a dataRoot guess.
export const DEFAULT_DEVICE_LABELS_PATH = path.resolve(__dirname, '..', 'device-labels.json');

export class DeviceLabelStore {
    private static instance?: DeviceLabelStore | undefined;
    private labels: Record<string, string> = {};

    private constructor(private readonly filePath: string) {
        this.load();
    }

    static getInstance(filePath = DEFAULT_DEVICE_LABELS_PATH): DeviceLabelStore {
        if (!this.instance) {
            this.instance = new DeviceLabelStore(filePath);
        }
        return this.instance;
    }

    static resetInstance(): void {
        this.instance = undefined;
    }

    get(serial: string): string | undefined {
        return this.labels[serial];
    }

    set(serial: string, label: string): void {
        this.labels[serial] = label;
        this.save();
    }

    delete(serial: string): void {
        delete this.labels[serial];
        this.save();
    }

    getAll(): Record<string, string> {
        return { ...this.labels };
    }

    private load(): void {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            this.labels = JSON.parse(raw);
        } catch {
            this.labels = {};
        }
    }

    private save(): void {
        try {
            fs.writeFileSync(this.filePath, `${JSON.stringify(this.labels, null, 2)}\n`);
        } catch {
            // If we can't write, don't crash the server
        }
    }
}
