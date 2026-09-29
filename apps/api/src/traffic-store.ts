import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { AwgPeer, ClientTrafficUsage } from './domain.js';

interface CounterRow {
  download_bytes: number;
  upload_bytes: number;
}

interface UsageRow {
  download_bytes: number;
}

interface TotalRow {
  total_bytes: number;
}

interface HandshakeRow {
  peer_id: string;
  latest_handshake: number;
}

interface TableColumnRow {
  name: string;
}

function asCounterRow(value: unknown): CounterRow | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('download_bytes' in value) ||
    typeof value.download_bytes !== 'number' ||
    !('upload_bytes' in value) ||
    typeof value.upload_bytes !== 'number'
  ) {
    return undefined;
  }
  return { download_bytes: value.download_bytes, upload_bytes: value.upload_bytes };
}

function asUsageRow(value: unknown): UsageRow | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('download_bytes' in value) ||
    typeof value.download_bytes !== 'number'
  ) {
    return undefined;
  }
  return { download_bytes: value.download_bytes };
}

function asTotalRow(value: unknown): TotalRow | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('total_bytes' in value) ||
    typeof value.total_bytes !== 'number'
  ) {
    return undefined;
  }
  return { total_bytes: value.total_bytes };
}

function asHandshakeRow(value: unknown): HandshakeRow | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('peer_id' in value) ||
    typeof value.peer_id !== 'string' ||
    !('latest_handshake' in value) ||
    typeof value.latest_handshake !== 'number'
  ) {
    return undefined;
  }
  return { peer_id: value.peer_id, latest_handshake: value.latest_handshake };
}

function isTableColumnRow(value: unknown): value is TableColumnRow {
  return (
    typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
  );
}

export interface StoredTrafficSnapshot {
  trafficByClient: Map<string, ClientTrafficUsage>;
  lastHandshakeByClient: Map<string, number>;
  totalTodayBytes: number;
}

function periodKeys(nowMs: number, timeZone: string): { day: string; month: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
    .formatToParts(nowMs)
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});
  const year = parts.year ?? '0000';
  const month = parts.month ?? '00';
  const day = parts.day ?? '00';
  return { day: `${year}-${month}-${day}`, month: `${year}-${month}` };
}

function counter(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export class TrafficStore {
  private readonly database: DatabaseSync;
  private readonly getCounter: StatementSync;
  private readonly upsertCounter: StatementSync;
  private readonly getLastHandshakes: StatementSync;
  private readonly addDailyUsage: StatementSync;
  private readonly addMonthlyUsage: StatementSync;
  private readonly getDailyUsage: StatementSync;
  private readonly getMonthlyUsage: StatementSync;
  private readonly getTotalDailyUsage: StatementSync;
  private readonly getMeta: StatementSync;
  private readonly setMeta: StatementSync;

  constructor(
    path: string,
    private readonly timeZone: string
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS peer_counters (
        peer_id TEXT PRIMARY KEY,
        download_bytes INTEGER NOT NULL,
        upload_bytes INTEGER NOT NULL,
        sampled_at_ms INTEGER NOT NULL,
        latest_handshake INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS daily_usage (
        day TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        download_bytes INTEGER NOT NULL,
        upload_bytes INTEGER NOT NULL,
        PRIMARY KEY (day, peer_id)
      );
      CREATE TABLE IF NOT EXISTS monthly_usage (
        month TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        download_bytes INTEGER NOT NULL,
        upload_bytes INTEGER NOT NULL,
        PRIMARY KEY (month, peer_id)
      );
    `);
    const counterColumns = this.database
      .prepare('PRAGMA table_info(peer_counters)')
      .all()
      .filter(isTableColumnRow);
    if (!counterColumns.some((column) => column.name === 'latest_handshake')) {
      this.database.exec(
        'ALTER TABLE peer_counters ADD COLUMN latest_handshake INTEGER NOT NULL DEFAULT 0'
      );
    }
    this.getCounter = this.database.prepare(
      'SELECT download_bytes, upload_bytes FROM peer_counters WHERE peer_id = ?'
    );
    this.upsertCounter = this.database.prepare(`
      INSERT INTO peer_counters (
        peer_id, download_bytes, upload_bytes, sampled_at_ms, latest_handshake
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET
        download_bytes = excluded.download_bytes,
        upload_bytes = excluded.upload_bytes,
        sampled_at_ms = excluded.sampled_at_ms,
        latest_handshake = MAX(peer_counters.latest_handshake, excluded.latest_handshake)
    `);
    this.getLastHandshakes = this.database.prepare(`
      SELECT peer_id, latest_handshake
      FROM peer_counters
      WHERE latest_handshake > 0
    `);
    this.addDailyUsage = this.database.prepare(`
      INSERT INTO daily_usage (day, peer_id, download_bytes, upload_bytes)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(day, peer_id) DO UPDATE SET
        download_bytes = daily_usage.download_bytes + excluded.download_bytes,
        upload_bytes = daily_usage.upload_bytes + excluded.upload_bytes
    `);
    this.addMonthlyUsage = this.database.prepare(`
      INSERT INTO monthly_usage (month, peer_id, download_bytes, upload_bytes)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(month, peer_id) DO UPDATE SET
        download_bytes = monthly_usage.download_bytes + excluded.download_bytes,
        upload_bytes = monthly_usage.upload_bytes + excluded.upload_bytes
    `);
    this.getDailyUsage = this.database.prepare(
      'SELECT download_bytes FROM daily_usage WHERE day = ? AND peer_id = ?'
    );
    this.getMonthlyUsage = this.database.prepare(
      'SELECT download_bytes FROM monthly_usage WHERE month = ? AND peer_id = ?'
    );
    this.getTotalDailyUsage = this.database.prepare(`
      SELECT COALESCE(SUM(download_bytes + upload_bytes), 0) AS total_bytes
      FROM daily_usage WHERE day = ?
    `);
    this.getMeta = this.database.prepare('SELECT value FROM meta WHERE key = ?');
    this.setMeta = this.database.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
  }

  applySnapshot(peers: readonly AwgPeer[], nowMs: number): StoredTrafficSnapshot {
    const periods = periodKeys(nowMs, this.timeZone);
    const initialized = this.getMeta.get('initialized') !== undefined;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM daily_usage WHERE day <> ?').run(periods.day);
      this.database.prepare('DELETE FROM monthly_usage WHERE month <> ?').run(periods.month);

      for (const peer of peers) {
        const downloadBytes = counter(peer.txBytes);
        const uploadBytes = counter(peer.rxBytes);
        const previous = asCounterRow(this.getCounter.get(peer.publicKey));

        if (!initialized) {
          this.addMonthlyUsage.run(periods.month, peer.publicKey, downloadBytes, uploadBytes);
        } else {
          const downloadDelta = previous
            ? downloadBytes >= previous.download_bytes
              ? downloadBytes - previous.download_bytes
              : downloadBytes
            : downloadBytes;
          const uploadDelta = previous
            ? uploadBytes >= previous.upload_bytes
              ? uploadBytes - previous.upload_bytes
              : uploadBytes
            : uploadBytes;
          this.addDailyUsage.run(periods.day, peer.publicKey, downloadDelta, uploadDelta);
          this.addMonthlyUsage.run(periods.month, peer.publicKey, downloadDelta, uploadDelta);
        }

        this.upsertCounter.run(
          peer.publicKey,
          downloadBytes,
          uploadBytes,
          nowMs,
          counter(peer.latestHandshake)
        );
      }
      if (!initialized) this.setMeta.run('initialized', '1');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return this.readSnapshot(peers, nowMs);
  }

  readTotalToday(nowMs: number): number {
    const { day } = periodKeys(nowMs, this.timeZone);
    const row = asTotalRow(this.getTotalDailyUsage.get(day));
    return row?.total_bytes ?? 0;
  }

  close(): void {
    this.database.close();
  }

  private readSnapshot(peers: readonly AwgPeer[], nowMs: number): StoredTrafficSnapshot {
    const periods = periodKeys(nowMs, this.timeZone);
    const trafficByClient = new Map<string, ClientTrafficUsage>();
    const lastHandshakeByClient = new Map<string, number>();
    for (const value of this.getLastHandshakes.all()) {
      const row = asHandshakeRow(value);
      if (row) lastHandshakeByClient.set(row.peer_id, row.latest_handshake);
    }
    for (const peer of peers) {
      const daily = asUsageRow(this.getDailyUsage.get(periods.day, peer.publicKey));
      const monthly = asUsageRow(this.getMonthlyUsage.get(periods.month, peer.publicKey));
      trafficByClient.set(peer.publicKey, {
        downloadTodayBytes: daily?.download_bytes ?? 0,
        downloadMonthBytes: monthly?.download_bytes ?? 0
      });
    }
    return {
      trafficByClient,
      lastHandshakeByClient,
      totalTodayBytes: this.readTotalToday(nowMs)
    };
  }
}
