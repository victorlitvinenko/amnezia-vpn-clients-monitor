import { describe, expect, it } from 'vitest';

import type { AppConfig } from './config.js';
import type { AwgPeer } from './domain.js';
import { MonitoringService } from './service.js';
import { TrafficStore } from './traffic-store.js';

const config: AppConfig = {
  port: 8080,
  containerName: 'amnezia-awg2',
  interfaceName: 'awg0',
  onlineThresholdSeconds: 180,
  cacheTtlMs: 3000,
  trafficSampleIntervalMs: 5000,
  trafficDbPath: ':memory:',
  timeZone: 'Europe/Moscow',
  nodeEnv: 'test',
  authPasswordHash: '$argon2id$v=19$m=65536,p=4,t=3$salt$hash',
  sessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  sessionTtlSeconds: 86_400
};

function peer(txBytes: number, rxBytes: number): AwgPeer {
  return {
    publicKey: 'pub-a',
    endpoint: null,
    allowedIps: '10.8.1.2/32',
    latestHandshake: 0,
    rxBytes,
    txBytes
  };
}

describe('MonitoringService', () => {
  it('calculates rates after the second sample and exposes accumulated traffic', async () => {
    let now = Date.UTC(2026, 8, 29, 9);
    let currentPeer = peer(1_000, 200);
    const service = new MonitoringService(config, {
      now: () => now,
      store: new TrafficStore(':memory:', config.timeZone),
      loadSources: async () => ({ peers: [currentPeer], clients: [] })
    });

    await service.refresh();
    expect(service.getTrafficStats()).toEqual({
      downloadBitsPerSecond: null,
      uploadBitsPerSecond: null,
      totalTodayBytes: 0
    });

    now += 5_000;
    currentPeer = peer(1_100, 250);
    await service.refresh();
    expect(service.getTrafficStats()).toEqual({
      downloadBitsPerSecond: 160,
      uploadBitsPerSecond: 80,
      totalTodayBytes: 150
    });
    await expect(service.getClients()).resolves.toEqual([
      expect.objectContaining({
        downloadTodayBytes: 100,
        downloadMonthBytes: 1_100,
        downloadBitsPerSecond: 160,
        uploadBitsPerSecond: 80
      })
    ]);
    await expect(service.getSnapshot()).resolves.toMatchObject({
      sampledAt: now,
      traffic: {
        downloadBitsPerSecond: 160,
        uploadBitsPerSecond: 80,
        totalTodayBytes: 150
      }
    });
    await service.close();
  });

  it('returns null before rates can be calculated and zero after counters reset', async () => {
    let now = Date.UTC(2026, 8, 29, 9);
    let currentPeer = peer(1_000, 200);
    const service = new MonitoringService(config, {
      now: () => now,
      store: new TrafficStore(':memory:', config.timeZone),
      loadSources: async () => ({ peers: [currentPeer], clients: [] })
    });

    await service.refresh();
    await expect(service.getClients()).resolves.toEqual([
      expect.objectContaining({ downloadBitsPerSecond: null, uploadBitsPerSecond: null })
    ]);

    now += 5_000;
    currentPeer = peer(10, 5);
    await service.refresh();
    await expect(service.getClients()).resolves.toEqual([
      expect.objectContaining({ downloadBitsPerSecond: 0, uploadBitsPerSecond: 0 })
    ]);
    await service.close();
  });

  it('coalesces concurrent refreshes', async () => {
    let finishLoad: (() => void) | undefined;
    let loadCount = 0;
    const service = new MonitoringService(config, {
      store: new TrafficStore(':memory:', config.timeZone),
      loadSources: async () => {
        loadCount += 1;
        await new Promise<void>((resolve) => {
          finishLoad = resolve;
        });
        return { peers: [], clients: [] };
      }
    });

    const first = service.refresh();
    const second = service.refresh();
    expect(first).toBe(second);
    finishLoad?.();
    await Promise.all([first, second]);
    expect(loadCount).toBe(1);
    await service.close();
  });
});
