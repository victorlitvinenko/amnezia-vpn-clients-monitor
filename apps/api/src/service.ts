import type { ClientStatus } from '@awg-monitor/shared';

import type { AppConfig } from './config.js';
import { getAwgDump, getClientsTable } from './docker.js';
import {
  mergeClients,
  parseAwgDump,
  parseClientsTable,
  type AwgPeer,
  type ClientMetadata,
  type ClientTrafficRate
} from './domain.js';
import { TrafficStore } from './traffic-store.js';

export interface TrafficStats {
  downloadBitsPerSecond: number | null;
  uploadBitsPerSecond: number | null;
  totalTodayBytes: number;
}

export interface MonitoringSnapshot {
  sampledAt: number;
  clients: ClientStatus[];
  traffic: TrafficStats;
}

interface RuntimeSnapshot {
  peers: AwgPeer[];
  sampledAtMs: number;
}

interface MonitoringDependencies {
  loadSources?: () => Promise<{ peers: AwgPeer[]; clients: ClientMetadata[] }>;
  now?: () => number;
  store?: TrafficStore;
}

interface MonitorLogger {
  error: (error: unknown, message: string) => void;
}

export class MonitoringService {
  private readonly loadSources: () => Promise<{ peers: AwgPeer[]; clients: ClientMetadata[] }>;
  private readonly now: () => number;
  private readonly store: TrafficStore;
  private clients: ClientStatus[] | undefined;
  private runtimeSnapshot: RuntimeSnapshot | undefined;
  private pending: Promise<void> | undefined;
  private interval: NodeJS.Timeout | undefined;
  private stats: TrafficStats;

  constructor(
    private readonly config: AppConfig,
    dependencies: MonitoringDependencies = {}
  ) {
    this.loadSources =
      dependencies.loadSources ??
      (async () => {
        const [dump, table] = await Promise.all([
          getAwgDump(config.containerName, config.interfaceName),
          getClientsTable(config.containerName)
        ]);
        return { peers: parseAwgDump(dump), clients: parseClientsTable(table) };
      });
    this.now = dependencies.now ?? Date.now;
    this.store = dependencies.store ?? new TrafficStore(config.trafficDbPath, config.timeZone);
    this.stats = {
      downloadBitsPerSecond: null,
      uploadBitsPerSecond: null,
      totalTodayBytes: this.store.readTotalToday(this.now())
    };
  }

  start(logger: MonitorLogger): void {
    void this.refresh().catch((error: unknown) => {
      logger.error(error, 'Unable to collect AmneziaWG traffic sample');
    });
    this.interval = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        logger.error(error, 'Unable to collect AmneziaWG traffic sample');
      });
    }, this.config.trafficSampleIntervalMs);
  }

  async getClients(): Promise<ClientStatus[]> {
    return (await this.getSnapshot()).clients;
  }

  async getSnapshot(): Promise<MonitoringSnapshot> {
    const sampledAtMs = this.runtimeSnapshot?.sampledAtMs ?? 0;
    if (!this.clients || this.now() - sampledAtMs >= this.config.cacheTtlMs) {
      await this.refresh();
    }
    if (!this.clients || !this.runtimeSnapshot) {
      throw new Error('No AmneziaWG snapshot is available');
    }
    return {
      sampledAt: this.runtimeSnapshot.sampledAtMs,
      clients: this.clients,
      traffic: { ...this.stats }
    };
  }

  getTrafficStats(): TrafficStats {
    const sampledAtMs = this.runtimeSnapshot?.sampledAtMs ?? 0;
    const ratesAreFresh = this.now() - sampledAtMs <= this.config.trafficSampleIntervalMs * 2;
    return {
      downloadBitsPerSecond: ratesAreFresh ? this.stats.downloadBitsPerSecond : null,
      uploadBitsPerSecond: ratesAreFresh ? this.stats.uploadBitsPerSecond : null,
      totalTodayBytes: this.store.readTotalToday(this.now())
    };
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async close(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    try {
      await this.pending;
    } finally {
      this.store.close();
    }
  }

  private async collect(): Promise<void> {
    const { peers, clients } = await this.loadSources();
    const sampledAtMs = this.now();
    const stored = this.store.applySnapshot(peers, sampledAtMs);
    const previous = this.runtimeSnapshot;
    const elapsedSeconds = previous ? (sampledAtMs - previous.sampledAtMs) / 1000 : 0;
    let downloadDelta = 0;
    let uploadDelta = 0;
    const ratesByClient = new Map<string, ClientTrafficRate>();

    if (previous && elapsedSeconds > 0) {
      const previousByKey = new Map(previous.peers.map((peer) => [peer.publicKey, peer]));
      for (const peer of peers) {
        const oldPeer = previousByKey.get(peer.publicKey);
        if (!oldPeer) continue;
        const peerDownloadDelta =
          peer.txBytes >= oldPeer.txBytes ? peer.txBytes - oldPeer.txBytes : 0;
        const peerUploadDelta =
          peer.rxBytes >= oldPeer.rxBytes ? peer.rxBytes - oldPeer.rxBytes : 0;
        downloadDelta += peerDownloadDelta;
        uploadDelta += peerUploadDelta;
        ratesByClient.set(peer.publicKey, {
          downloadBitsPerSecond: (peerDownloadDelta * 8) / elapsedSeconds,
          uploadBitsPerSecond: (peerUploadDelta * 8) / elapsedSeconds
        });
      }
    }

    this.clients = mergeClients(
      peers,
      clients,
      Math.floor(sampledAtMs / 1000),
      this.config.onlineThresholdSeconds,
      stored.trafficByClient,
      stored.lastHandshakeByClient,
      ratesByClient
    );
    this.runtimeSnapshot = { peers, sampledAtMs };
    this.stats = {
      downloadBitsPerSecond:
        previous && elapsedSeconds > 0 ? (downloadDelta * 8) / elapsedSeconds : null,
      uploadBitsPerSecond:
        previous && elapsedSeconds > 0 ? (uploadDelta * 8) / elapsedSeconds : null,
      totalTodayBytes: stored.totalTodayBytes
    };
  }
}

export function createMonitoringService(config: AppConfig): MonitoringService {
  return new MonitoringService(config);
}
