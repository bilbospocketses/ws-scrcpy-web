import * as fs from 'fs';
import * as path from 'path';

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
// After webpack build, __dirname = dist/. One level up = project root.
const LOG_FILE = path.resolve(__dirname, '..', 'ws-scrcpy-web.log');
const BACKUP_FILE = `${LOG_FILE}.1`;

let rotationChecked = false;

function rotateIfNeeded(): void {
    if (rotationChecked) return;
    rotationChecked = true;
    try {
        const stats = fs.statSync(LOG_FILE);
        if (stats.size >= MAX_LOG_SIZE) {
            fs.renameSync(LOG_FILE, BACKUP_FILE);
        }
    } catch {
        // File doesn't exist yet — nothing to rotate
    }
}

function timestamp(): string {
    return new Date().toISOString();
}

function writeToFile(line: string): void {
    rotateIfNeeded();
    try {
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch {
        // If we can't write to the log file, don't crash the server
    }
}

export class Logger {
    private readonly tag: string;

    private constructor(tag: string) {
        this.tag = `[${tag}]`;
    }

    static for(tag: string): Logger {
        return new Logger(tag);
    }

    info(...args: unknown[]): void {
        const ts = timestamp();
        const message = args.map(String).join(' ');
        const line = `${ts} ${this.tag} ${message}`;
        console.log(this.tag, ...args);
        writeToFile(line);
    }

    warn(...args: unknown[]): void {
        const ts = timestamp();
        const message = args.map(String).join(' ');
        const line = `${ts} ${this.tag} WARN ${message}`;
        console.warn(this.tag, ...args);
        writeToFile(line);
    }

    error(...args: unknown[]): void {
        const ts = timestamp();
        const message = args.map(String).join(' ');
        const line = `${ts} ${this.tag} ERROR ${message}`;
        console.error(this.tag, ...args);
        writeToFile(line);
    }
}
