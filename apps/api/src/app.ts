import { fileURLToPath } from 'node:url';

import type { ApiError, ClientStatus, ContainerStats, HealthResponse } from '@awg-monitor/shared';
import fastifyStatic from '@fastify/static';
import fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { getContainerCpuPercent } from './docker.js';
import { createMonitoringService, type TrafficStats } from './service.js';

interface BuildAppOptions {
  config: AppConfig;
  getClients?: () => Promise<ClientStatus[]>;
  getCpuPercent?: () => Promise<number>;
  getTrafficStats?: () => TrafficStats;
}

export async function buildApp({
  config,
  getClients,
  getCpuPercent,
  getTrafficStats
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: true });
  const monitor = getClients ? undefined : createMonitoringService(config);
  const loadClients = getClients ?? (() => monitor!.getClients());
  const loadCpuPercent = getCpuPercent ?? (() => getContainerCpuPercent(config.containerName));
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

  app.get<{ Reply: HealthResponse }>('/api/health', async () => ({ status: 'ok' }));
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
      const cpuPercent = await loadCpuPercent();
      return { cpuPercent, ...traffic };
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
