import { fileURLToPath } from 'node:url';

import type { ClientStatus, HealthResponse } from '@awg-monitor/shared';
import fastifyStatic from '@fastify/static';
import fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { createClientStatusService } from './service.js';

interface BuildAppOptions {
  config: AppConfig;
  getClients?: () => Promise<ClientStatus[]>;
}

export async function buildApp({ config, getClients }: BuildAppOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: true });
  const loadClients = getClients ?? createClientStatusService(config);

  app.get<{ Reply: HealthResponse }>('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/clients', async (_request, reply) => {
    try {
      return await loadClients();
    } catch (error) {
      app.log.error({ err: error }, 'Unable to read AmneziaWG state');
      return reply.code(503).send({ error: 'Unable to read AmneziaWG state' });
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
