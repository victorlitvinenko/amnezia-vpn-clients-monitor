import { fileURLToPath } from 'node:url';

import type {
  ApiError,
  AuthStatus,
  ClientStatus,
  ContainerStats,
  HealthResponse,
  LoginRequest
} from '@awg-monitor/shared';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  createAuthenticationCookie,
  createAuthenticationHook,
  isAuthenticated,
  verifyPassword
} from './auth.js';
import type { AppConfig } from './config.js';
import { getContainerRuntimeStats, type ContainerRuntimeStats } from './docker.js';
import { createMonitoringService, type TrafficStats } from './service.js';

interface BuildAppOptions {
  config: AppConfig;
  getClients?: () => Promise<ClientStatus[]>;
  getContainerStats?: () => Promise<ContainerRuntimeStats>;
  getTrafficStats?: () => TrafficStats;
}

const loginSchema = z.object({
  password: z.string().min(1).max(1024)
});

const PRODUCTION_COOKIE_NAME = '__Host-awg-session';
const DEVELOPMENT_COOKIE_NAME = 'awg-session';

export async function buildApp({
  config,
  getClients,
  getContainerStats,
  getTrafficStats
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: true });
  const monitor = getClients ? undefined : createMonitoringService(config);
  const loadClients = getClients ?? (() => monitor!.getClients());
  const loadContainerStats =
    getContainerStats ?? (() => getContainerRuntimeStats(config.containerName));
  const loadTrafficStats =
    getTrafficStats ??
    (() =>
      monitor?.getTrafficStats() ?? {
        downloadBitsPerSecond: null,
        uploadBitsPerSecond: null,
        totalTodayBytes: 0
      });

  if (monitor) {
    monitor.start(app.log);
    app.addHook('onClose', async () => monitor.close());
  }

  const production = config.nodeEnv === 'production';
  const sessionCookieName = production ? PRODUCTION_COOKIE_NAME : DEVELOPMENT_COOKIE_NAME;
  const sessionCookieOptions = {
    path: '/',
    httpOnly: true,
    secure: production,
    sameSite: 'strict' as const
  };
  await app.register(cookie, {
    secret: Buffer.from(config.sessionSecret, 'hex'),
    algorithm: 'sha256'
  });
  await app.register(rateLimit, { global: false });
  app.addHook('onRequest', createAuthenticationHook(sessionCookieName));

  app.get<{ Reply: HealthResponse }>('/api/health', () => ({ status: 'ok' }));
  app.get<{ Reply: AuthStatus }>('/api/auth/session', (request) => ({
    authenticated: isAuthenticated(request, sessionCookieName)
  }));
  app.post<{ Body: LoginRequest; Reply: AuthStatus | ApiError }>(
    '/api/auth/login',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute'
        }
      }
    },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (
        !parsed.success ||
        !(await verifyPassword(config.authPasswordHash, parsed.data.password))
      ) {
        return reply.code(401).send({ error: 'Invalid password' });
      }

      reply.setCookie(sessionCookieName, createAuthenticationCookie(config.sessionTtlSeconds), {
        ...sessionCookieOptions,
        signed: true,
        maxAge: config.sessionTtlSeconds
      });
      return { authenticated: true };
    }
  );
  app.post('/api/auth/logout', (_request, reply) => {
    reply.clearCookie(sessionCookieName, sessionCookieOptions);
    return reply.code(204).send();
  });
  app.get('/api/clients', async (_request, reply) => {
    try {
      return await loadClients();
    } catch (error) {
      app.log.error({ err: error }, 'Unable to read AmneziaWG state');
      return reply.code(503).send({ error: 'Unable to read AmneziaWG state' });
    }
  });
  app.get<{ Reply: ContainerStats | ApiError }>('/api/stats', async (_request, reply) => {
    try {
      const traffic = loadTrafficStats();
      const container = await loadContainerStats();
      return { ...container, ...traffic };
    } catch (error) {
      app.log.error({ err: error }, 'Unable to read AmneziaWG container stats');
      return reply.code(503).send({ error: 'Unable to read AmneziaWG container stats' });
    }
  });

  if (config.nodeEnv === 'production') {
    const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
