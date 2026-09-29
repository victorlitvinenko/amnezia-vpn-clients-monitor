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
  authPasswordHash:
    '$argon2id$v=19$m=65536,p=4,t=3$DMq1d2uUTT+Yq+c/+iz67g$FiF/rQcgJPb/orLNaxC0/C69j/qGannXd4cpVyAp5o8',
  sessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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
    expect(session.json()).toEqual({ authenticated: true });

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie }
    });
    expect(logout.statusCode).toBe(204);
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
    const cookie = await authenticatedCookie(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/stats',
      headers: { cookie }
    });
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
});
