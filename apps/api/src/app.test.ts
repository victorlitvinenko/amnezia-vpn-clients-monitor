import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { AppConfig } from './config.js';

const config: AppConfig = {
  port: 8080,
  containerName: 'amnezia-awg2',
  interfaceName: 'awg0',
  onlineThresholdSeconds: 180,
  cacheTtlMs: 3000,
  trafficSampleIntervalMs: 5000,
  trafficDbPath: ':memory:',
  timeZone: 'Europe/Moscow',
  nodeEnv: 'test'
};

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

describe('API', () => {
  it('returns health status', async () => {
    app = await buildApp({ config, getClients: async () => [] });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns the AmneziaWG container CPU load', async () => {
    app = await buildApp({
      config,
      getClients: async () => [],
      getCpuPercent: async () => 12.5,
      getTrafficStats: () => ({
        downloadBitsPerSecond: 24_200_000,
        uploadBitsPerSecond: 3_800_000,
        totalTodayBytes: 18_700_000_000
      })
    });
    const response = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      cpuPercent: 12.5,
      downloadBitsPerSecond: 24_200_000,
      uploadBitsPerSecond: 3_800_000,
      totalTodayBytes: 18_700_000_000
    });
  });

  it('returns a safe JSON error when container stats are unavailable', async () => {
    app = await buildApp({
      config,
      getClients: async () => [],
      getCpuPercent: async () => {
        throw new Error('socket detail');
      }
    });
    const response = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Unable to read AmneziaWG container stats' });
  });

  it('returns a safe JSON error when the data source fails', async () => {
    app = await buildApp({
      config,
      getClients: async () => {
        throw new Error('socket detail');
      }
    });
    const response = await app.inject({ method: 'GET', url: '/api/clients' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Unable to read AmneziaWG state' });
  });
});
