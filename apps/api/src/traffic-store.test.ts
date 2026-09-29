import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { AwgPeer } from './domain.js';
import { TrafficStore } from './traffic-store.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function peer(txBytes: number, rxBytes: number, latestHandshake = 0): AwgPeer {
  return {
    publicKey: 'pub-a',
    endpoint: null,
    allowedIps: '10.8.1.2/32',
    latestHandshake,
    rxBytes,
    txBytes
  };
}

describe('TrafficStore', () => {
  it('seeds the current month but starts the current day at zero', () => {
    const store = new TrafficStore(':memory:', 'Europe/Moscow');
    const first = store.applySnapshot([peer(1_000, 200)], Date.UTC(2026, 8, 29, 9));

    expect(first.trafficByClient.get('pub-a')).toEqual({
      downloadTodayBytes: 0,
      downloadMonthBytes: 1_000
    });
    expect(first.totalTodayBytes).toBe(0);
    store.close();
  });

  it('accumulates counter deltas and handles a counter reset', () => {
    const store = new TrafficStore(':memory:', 'Europe/Moscow');
    const start = Date.UTC(2026, 8, 29, 9);
    store.applySnapshot([peer(1_000, 200)], start);

    const second = store.applySnapshot([peer(1_300, 260)], start + 5_000);
    expect(second.trafficByClient.get('pub-a')).toEqual({
      downloadTodayBytes: 300,
      downloadMonthBytes: 1_300
    });
    expect(second.totalTodayBytes).toBe(360);

    const afterReset = store.applySnapshot([peer(40, 10)], start + 10_000);
    expect(afterReset.trafficByClient.get('pub-a')).toEqual({
      downloadTodayBytes: 340,
      downloadMonthBytes: 1_340
    });
    expect(afterReset.totalTodayBytes).toBe(410);
    store.close();
  });

  it('starts new daily and monthly totals at period boundaries', () => {
    const store = new TrafficStore(':memory:', 'Europe/Moscow');
    const september = Date.UTC(2026, 8, 30, 20, 59, 55);
    store.applySnapshot([peer(1_000, 200)], september);
    store.applySnapshot([peer(1_100, 250)], september + 4_000);

    const october = store.applySnapshot([peer(1_300, 350)], september + 10_000);
    expect(october.trafficByClient.get('pub-a')).toEqual({
      downloadTodayBytes: 200,
      downloadMonthBytes: 200
    });
    expect(october.totalTodayBytes).toBe(300);
    store.close();
  });

  it('keeps removed clients in the aggregate daily total', () => {
    const store = new TrafficStore(':memory:', 'Europe/Moscow');
    const start = Date.UTC(2026, 8, 29, 9);
    store.applySnapshot([peer(1_000, 200)], start);
    store.applySnapshot([peer(1_100, 250)], start + 5_000);

    const withoutPeer = store.applySnapshot([], start + 10_000);
    expect(withoutPeer.totalTodayBytes).toBe(150);
    store.close();
  });

  it('continues from persisted counters after a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'awg-monitor-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'traffic.sqlite');
    const start = Date.UTC(2026, 8, 29, 9);

    const firstStore = new TrafficStore(path, 'Europe/Moscow');
    firstStore.applySnapshot([peer(1_000, 200)], start);
    firstStore.close();

    const secondStore = new TrafficStore(path, 'Europe/Moscow');
    const afterRestart = secondStore.applySnapshot([peer(1_300, 260)], start + 5_000);
    expect(afterRestart.trafficByClient.get('pub-a')).toEqual({
      downloadTodayBytes: 300,
      downloadMonthBytes: 1_300
    });
    expect(afterRestart.totalTodayBytes).toBe(360);
    secondStore.close();
  });

  it('keeps the last nonzero handshake after a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'awg-monitor-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'traffic.sqlite');
    const start = Date.UTC(2026, 8, 29, 9);

    const firstStore = new TrafficStore(path, 'Europe/Moscow');
    firstStore.applySnapshot([peer(1_000, 200, 1_780_000_000)], start);
    firstStore.close();

    const secondStore = new TrafficStore(path, 'Europe/Moscow');
    const afterRestart = secondStore.applySnapshot([peer(1_100, 250, 0)], start + 5_000);
    expect(afterRestart.lastHandshakeByClient.get('pub-a')).toBe(1_780_000_000);
    secondStore.close();
  });

  it('migrates an existing traffic database without handshake history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'awg-monitor-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'traffic.sqlite');
    const legacyDatabase = new DatabaseSync(path);
    legacyDatabase.exec(`
      CREATE TABLE peer_counters (
        peer_id TEXT PRIMARY KEY,
        download_bytes INTEGER NOT NULL,
        upload_bytes INTEGER NOT NULL,
        sampled_at_ms INTEGER NOT NULL
      );
      INSERT INTO peer_counters VALUES ('pub-a', 1000, 200, 0);
    `);
    legacyDatabase.close();

    const store = new TrafficStore(path, 'Europe/Moscow');
    const snapshot = store.applySnapshot([peer(1_100, 250, 1_780_000_000)], Date.now());
    expect(snapshot.lastHandshakeByClient.get('pub-a')).toBe(1_780_000_000);
    store.close();
  });
});
