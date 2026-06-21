import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrations';

export function openDatabase(dbPath: string): DatabaseSync {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
    return db;
}
