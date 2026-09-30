import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export interface StoredCredentials {
  passwordHash: string;
  sessionSecret: string;
}

interface CredentialRow {
  password_hash: string;
  session_secret: string;
}

function asCredentialRow(value: unknown): CredentialRow | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('password_hash' in value) ||
    typeof value.password_hash !== 'string' ||
    !('session_secret' in value) ||
    typeof value.session_secret !== 'string'
  ) {
    return undefined;
  }
  return { password_hash: value.password_hash, session_secret: value.session_secret };
}

export function authDatabasePath(trafficDatabasePath: string): string {
  return trafficDatabasePath === ':memory:'
    ? ':memory:'
    : join(dirname(trafficDatabasePath), 'auth.sqlite');
}

export class AuthStore {
  private readonly database: DatabaseSync;
  private readonly getCredentials: StatementSync;
  private readonly insertCredentials: StatementSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        session_secret TEXT NOT NULL
      );
    `);
    this.getCredentials = this.database.prepare(
      'SELECT password_hash, session_secret FROM credentials WHERE id = 1'
    );
    this.insertCredentials = this.database.prepare(
      'INSERT INTO credentials (id, password_hash, session_secret) VALUES (1, ?, ?)'
    );
  }

  readCredentials(): StoredCredentials | undefined {
    const row = asCredentialRow(this.getCredentials.get());
    return row && { passwordHash: row.password_hash, sessionSecret: row.session_secret };
  }

  initialize(initialCredentials: StoredCredentials | undefined): StoredCredentials | undefined {
    const stored = this.readCredentials();
    if (stored || !initialCredentials) return stored;
    return this.createCredentials(initialCredentials) ? initialCredentials : this.readCredentials();
  }

  createCredentials(credentials: StoredCredentials): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.readCredentials()) {
        this.database.exec('COMMIT');
        return false;
      }
      this.insertCredentials.run(credentials.passwordHash, credentials.sessionSecret);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}

export function createSessionSecret(): string {
  return randomBytes(32).toString('hex');
}
