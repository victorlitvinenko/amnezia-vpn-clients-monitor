import type { ClientStatus } from '@awg-monitor/shared';

import { TimedCache } from './cache.js';
import type { AppConfig } from './config.js';
import { getAwgDump, getClientsTable } from './docker.js';
import { mergeClients, parseAwgDump, parseClientsTable } from './domain.js';

export function createClientStatusService(config: AppConfig): () => Promise<ClientStatus[]> {
  const cache = new TimedCache<ClientStatus[]>(config.cacheTtlMs);

  return () =>
    cache.get(async () => {
      const [dump, table] = await Promise.all([
        getAwgDump(config.containerName, config.interfaceName),
        getClientsTable(config.containerName)
      ]);
      return mergeClients(
        parseAwgDump(dump),
        parseClientsTable(table),
        Math.floor(Date.now() / 1000),
        config.onlineThresholdSeconds
      );
    });
}
