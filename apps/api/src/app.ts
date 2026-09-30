import { fileURLToPath } from 'node:url';

import type {
  ApiError,
  AuthStatus,
  ClientStatus,
  ContainerStats,
  DashboardSnapshot,
  HealthResponse,
  LoginRequest,
  SetupRequest
} from '@amnezia-vpn-monitor/shared';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  AuthStore,
  authDatabasePath,
  createSessionSecret,
  type StoredCredentials
} from './auth-store.js';
import {
  createAuthenticationCookie,
  createAuthenticationHook,
  hashPassword,
  isAuthenticated,
  verifyPassword
} from './auth.js';
import type { AppConfig } from './config.js';
import { getContainerRuntimeStats, type ContainerRuntimeStats } from './docker.js';
import { createMonitoringService, type MonitoringSnapshot, type TrafficStats } from './service.js';

interface BuildAppOptions {
  config: AppConfig;
  getClients?: () => Promise<ClientStatus[]>;
  getContainerStats?: () => Promise<ContainerRuntimeStats>;
  getTrafficStats?: () => TrafficStats;
  getDashboardSnapshot?: () => Promise<MonitoringSnapshot>;
  authStore?: AuthStore;
}

const loginSchema = z.object({
  password: z.string().min(1).max(1024)
});

const setupSchema = z.object({
  password: z.string().min(1).max(1024),
  passwordConfirmation: z.string().min(1).max(1024)
});

const PRODUCTION_COOKIE_NAME = 'amnezia-vpn-monitor-session';
const DEVELOPMENT_COOKIE_NAME = 'awg-session';

export async function buildApp({
  config,
  getClients,
  getContainerStats,
  getTrafficStats,
  getDashboardSnapshot,
  authStore: suppliedAuthStore
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: true });
  const authStore = suppliedAuthStore ?? new AuthStore(authDatabasePath(config.trafficDbPath));
  const initialCredentials = initialStoredCredentials(config);
  let credentials = authStore.initialize(initialCredentials);
  const sessionSecret = credentials?.sessionSecret ?? createSessionSecret();
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
  const loadDashboardSnapshot =
    getDashboardSnapshot ??
    (monitor
      ? () => monitor.getSnapshot()
      : async () => ({
          sampledAt: Date.now(),
          clients: await loadClients(),
          traffic: loadTrafficStats()
        }));

  if (monitor) {
    monitor.start(app.log);
    app.addHook('onClose', async () => monitor.close());
  }
  if (!suppliedAuthStore) app.addHook('onClose', async () => authStore.close());

  const production = config.nodeEnv === 'production';
  const sessionCookieName = production ? PRODUCTION_COOKIE_NAME : DEVELOPMENT_COOKIE_NAME;
  const sessionCookieOptions = {
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'strict' as const
  };
  await app.register(cookie, {
    secret: Buffer.from(sessionSecret, 'hex'),
    algorithm: 'sha256'
  });
  await app.register(rateLimit, { global: false });
  app.addHook(
    'onRequest',
    createAuthenticationHook(sessionCookieName, () => credentials !== undefined)
  );

  app.get<{ Reply: HealthResponse }>('/api/health', () => ({ status: 'ok' }));
  app.get<{ Reply: AuthStatus }>('/api/auth/session', (request) => ({
    authenticated: credentials !== undefined && isAuthenticated(request, sessionCookieName),
    setupRequired: credentials === undefined
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
      if (!credentials) return reply.code(409).send({ error: 'Setup required' });
      if (
        !parsed.success ||
        !(await verifyPassword(credentials.passwordHash, parsed.data.password))
      ) {
        return reply.code(401).send({ error: 'Invalid password' });
      }
      setAuthenticationCookie(
        reply,
        sessionCookieName,
        sessionCookieOptions,
        config.sessionTtlSeconds
      );
      return { authenticated: true, setupRequired: false };
    }
  );
  app.post<{ Body: SetupRequest; Reply: AuthStatus | ApiError }>(
    '/api/auth/setup',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute'
        }
      }
    },
    async (request, reply) => {
      const parsed = setupSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid setup request' });
      if (parsed.data.password !== parsed.data.passwordConfirmation) {
        return reply.code(400).send({ error: 'Passwords do not match' });
      }
      if (credentials) return reply.code(409).send({ error: 'Setup has already been completed' });

      const newCredentials: StoredCredentials = {
        passwordHash: await hashPassword(parsed.data.password),
        sessionSecret
      };
      if (!authStore.createCredentials(newCredentials)) {
        credentials = authStore.readCredentials();
        return reply.code(409).send({ error: 'Setup has already been completed' });
      }
      credentials = newCredentials;
      setAuthenticationCookie(
        reply,
        sessionCookieName,
        sessionCookieOptions,
        config.sessionTtlSeconds
      );
      return { authenticated: true, setupRequired: false };
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
  app.get<{ Reply: DashboardSnapshot | ApiError }>('/api/dashboard', async (_request, reply) => {
    try {
      const [snapshot, container] = await Promise.all([
        loadDashboardSnapshot(),
        loadContainerStats()
      ]);
      return {
        sampledAt: snapshot.sampledAt,
        clients: snapshot.clients,
        stats: { ...container, ...snapshot.traffic }
      };
    } catch (error) {
      app.log.error({ err: error }, 'Unable to read AmneziaWG dashboard');
      return reply.code(503).send({ error: 'Unable to read AmneziaWG dashboard' });
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

function initialStoredCredentials(config: AppConfig): StoredCredentials | undefined {
  const hasPasswordHash = config.initialAuthPasswordHash !== undefined;
  const hasSessionSecret = config.initialSessionSecret !== undefined;
  if (hasPasswordHash !== hasSessionSecret) {
    throw new Error('AUTH_PASSWORD_HASH and SESSION_SECRET must be set together');
  }
  if (!hasPasswordHash || !hasSessionSecret) return undefined;
  return {
    passwordHash: config.initialAuthPasswordHash!,
    sessionSecret: config.initialSessionSecret!
  };
}

function setAuthenticationCookie(
  reply: import('fastify').FastifyReply,
  cookieName: string,
  options: { path: string; httpOnly: boolean; secure: boolean; sameSite: 'strict' },
  ttlSeconds: number
): void {
  reply.setCookie(cookieName, createAuthenticationCookie(ttlSeconds), {
    ...options,
    signed: true,
    maxAge: ttlSeconds
  });
}
