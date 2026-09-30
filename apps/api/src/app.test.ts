import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  nodeEnv: 'test',
  initialAuthPasswordHash:
    '$argon2id$v=19$m=65536,p=4,t=3$DMq1d2uUTT+Yq+c/+iz67g$FiF/rQcgJPb/orLNaxC0/C69j/qGannXd4cpVyAp5o8',
  initialSessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  sessionTtlSeconds: 86_400
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function authenticatedCookie(instance: FastifyInstance): Promise<string> {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'test-password' }
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  if (typeof setCookie !== 'string') throw new Error('Login did not return a session cookie');
  const cookie = setCookie.split(';', 1)[0];
  if (!cookie) throw new Error('Login returned an empty session cookie');
  return cookie;
}

describe('API', () => {
  it('returns health status', async () => {
    app = await buildApp({ config, getClients: async () => [] });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('rejects protected API requests without a session', async () => {
    app = await buildApp({ config, getClients: async () => [] });
    const response = await app.inject({ method: 'GET', url: '/api/clients' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Authentication required' });
  });

  it('rejects an invalid password without creating a session', async () => {
    app = await buildApp({ config, getClients: async () => [] });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong-password' }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid password' });
    expect(response.cookies).toHaveLength(0);
  });

  it('rejects a tampered session cookie', async () => {
    app = await buildApp({ config, getClients: async () => [] });
    const cookie = await authenticatedCookie(app);
    const tamperedCookie = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`;
    const response = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { cookie: tamperedCookie }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Authentication required' });
  });

  it('creates and clears an authenticated session', async () => {
    app = await buildApp({ config, getClients: async () => [] });
    const cookie = await authenticatedCookie(app);

    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie }
    });
    expect(session.json()).toEqual({ authenticated: true, setupRequired: false });

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie }
    });
    expect(logout.statusCode).toBe(204);
  });

  it('allows the session cookie over plain HTTP', async () => {
    app = await buildApp({
      config: { ...config, nodeEnv: 'production' },
      getClients: async () => []
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'test-password' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toMatch(/^amnezia-vpn-monitor-session=/);
    expect(response.headers['set-cookie']).not.toContain('; Secure');
  });

  it('returns the AmneziaWG container CPU load and uptime', async () => {
    app = await buildApp({
      config,
      getClients: async () => [],
      getContainerStats: async () => ({ cpuPercent: 12.5, uptimeSeconds: 1_062_000 }),
      getTrafficStats: () => ({
        downloadBitsPerSecond: 24_200_000,
        uploadBitsPerSecond: 3_800_000,
        totalTodayBytes: 18_700_000_000
      })
    });
    const cookie = await authenticatedCookie(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/stats',
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      cpuPercent: 12.5,
      uptimeSeconds: 1_062_000,
      downloadBitsPerSecond: 24_200_000,
      uploadBitsPerSecond: 3_800_000,
      totalTodayBytes: 18_700_000_000
    });
  });

  it('returns clients and stats from one dashboard snapshot', async () => {
    app = await buildApp({
      config,
      getClients: async () => [],
      getContainerStats: async () => ({ cpuPercent: 12.5, uptimeSeconds: 1_062_000 }),
      getDashboardSnapshot: async () => ({
        sampledAt: 1_790_697_000_000,
        clients: [],
        traffic: {
          downloadBitsPerSecond: 24_200_000,
          uploadBitsPerSecond: 3_800_000,
          totalTodayBytes: 18_700_000_000
        }
      })
    });
    const cookie = await authenticatedCookie(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sampledAt: 1_790_697_000_000,
      clients: [],
      stats: {
        cpuPercent: 12.5,
        uptimeSeconds: 1_062_000,
        downloadBitsPerSecond: 24_200_000,
        uploadBitsPerSecond: 3_800_000,
        totalTodayBytes: 18_700_000_000
      }
    });
  });

  it('returns a safe JSON error when container stats are unavailable', async () => {
    app = await buildApp({
      config,
      getClients: async () => [],
      getContainerStats: async () => {
        throw new Error('socket detail');
      }
    });
    const cookie = await authenticatedCookie(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/stats',
      headers: { cookie }
    });
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
    const cookie = await authenticatedCookie(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { cookie }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Unable to read AmneziaWG state' });
  });

  it('creates credentials during first-run setup and authenticates the new session', async () => {
    const freshConfig: AppConfig = {
      ...config,
      initialAuthPasswordHash: undefined,
      initialSessionSecret: undefined
    };
    app = await buildApp({ config: freshConfig, getClients: async () => [] });

    const initialStatus = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(initialStatus.json()).toEqual({ authenticated: false, setupRequired: true });

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'new-password', passwordConfirmation: 'new-password' }
    });
    expect(setup.statusCode).toBe(200);
    expect(setup.json()).toEqual({ authenticated: true, setupRequired: false });
    const setCookie = setup.headers['set-cookie'];
    if (typeof setCookie !== 'string') throw new Error('Setup did not return a session cookie');
    const cookie = setCookie.split(';', 1)[0];

    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie }
    });
    expect(session.json()).toEqual({ authenticated: true, setupRequired: false });

    const repeatSetup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'other-password', passwordConfirmation: 'other-password' }
    });
    expect(repeatSetup.statusCode).toBe(409);
    expect(repeatSetup.json()).toEqual({ error: 'Setup has already been completed' });
  });

  it('rejects first-run setup when passwords differ', async () => {
    const freshConfig: AppConfig = {
      ...config,
      initialAuthPasswordHash: undefined,
      initialSessionSecret: undefined
    };
    app = await buildApp({ config: freshConfig, getClients: async () => [] });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'new-password', passwordConfirmation: 'different-password' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Passwords do not match' });
  });

  it('keeps first-run credentials after an application restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'awg-monitor-auth-'));
    const freshConfig: AppConfig = {
      ...config,
      trafficDbPath: join(directory, 'traffic.sqlite'),
      initialAuthPasswordHash: undefined,
      initialSessionSecret: undefined
    };
    try {
      app = await buildApp({ config: freshConfig, getClients: async () => [] });
      const setup = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { password: 'persisted-password', passwordConfirmation: 'persisted-password' }
      });
      expect(setup.statusCode).toBe(200);
      await app.close();
      app = undefined;

      app = await buildApp({ config: freshConfig, getClients: async () => [] });
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'persisted-password' }
      });
      expect(login.statusCode).toBe(200);
    } finally {
      await app?.close();
      app = undefined;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
