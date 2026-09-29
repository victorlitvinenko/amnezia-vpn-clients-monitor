import type { ClientStatus } from '@awg-monitor/shared';
import { z } from 'zod';

export interface AwgPeer {
  publicKey: string;
  endpoint: string | null;
  allowedIps: string;
  latestHandshake: number;
  rxBytes: number;
  txBytes: number;
}

const clientSchema = z.object({
  clientId: z.string().min(1),
  userData: z
    .object({
      allowed_ips: z.string().optional(),
      clientName: z.string().optional(),
      creationDate: z.string().optional()
    })
    .optional()
});

export type ClientMetadata = z.infer<typeof clientSchema>;

export interface ClientTrafficUsage {
  downloadTodayBytes: number;
  downloadMonthBytes: number;
}

export interface ClientTrafficRate {
  downloadBitsPerSecond: number | null;
  uploadBitsPerSecond: number | null;
}

function numberField(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function nullableField(value: string | undefined): string | null {
  if (value === undefined || value === '' || value === '(none)') return null;
  return value;
}

export function parseAwgDump(dump: string): AwgPeer[] {
  const lines = dump.split(/\r?\n/);
  return lines.slice(1).flatMap((line) => {
    if (!line.trim()) return [];
    const fields = line.split('\t');
    if (fields.length < 8) return [];
    const publicKey = fields[0];
    const latestHandshake = numberField(fields[4]);
    const rxBytes = numberField(fields[5]);
    const txBytes = numberField(fields[6]);
    if (!publicKey || latestHandshake === null || rxBytes === null || txBytes === null) return [];

    return [
      {
        publicKey,
        endpoint: nullableField(fields[2]),
        allowedIps: nullableField(fields[3]) ?? '',
        latestHandshake,
        rxBytes,
        txBytes
      }
    ];
  });
}

export function parseClientsTable(json: string): ClientMetadata[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('clientsTable contains invalid JSON');
  }
  const result = z.array(clientSchema).safeParse(value);
  if (!result.success) throw new Error('clientsTable has an invalid structure');
  return result.data;
}

export function isOnline(latestHandshake: number, nowUnix: number, threshold: number): boolean {
  return latestHandshake > 0 && nowUnix - latestHandshake <= threshold;
}

function stripCidr(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first ? first.split('/')[0] || null : null;
}

function statusFor(
  id: string,
  client: ClientMetadata | undefined,
  peer: AwgPeer | undefined,
  traffic: ClientTrafficUsage | undefined,
  rate: ClientTrafficRate | undefined,
  storedHandshake: number | undefined,
  nowUnix: number,
  threshold: number
): ClientStatus {
  const runtimeHandshake = peer?.latestHandshake ?? 0;
  const displayHandshake = runtimeHandshake > 0 ? runtimeHandshake : (storedHandshake ?? 0);
  const hasHandshake = displayHandshake > 0;
  const fallbackName = stripCidr(peer?.allowedIps ?? null) ?? id;

  return {
    id,
    name: client?.userData?.clientName?.trim() || fallbackName,
    ip: stripCidr(peer?.allowedIps || client?.userData?.allowed_ips || null),
    online: isOnline(runtimeHandshake, nowUnix, threshold),
    latestHandshake: hasHandshake ? displayHandshake : null,
    handshakeAgeSeconds: hasHandshake ? Math.max(0, nowUnix - displayHandshake) : null,
    endpoint: peer?.endpoint ?? null,
    downloadTodayBytes: traffic?.downloadTodayBytes ?? 0,
    downloadMonthBytes: traffic?.downloadMonthBytes ?? 0,
    downloadBitsPerSecond: rate?.downloadBitsPerSecond ?? null,
    uploadBitsPerSecond: rate?.uploadBitsPerSecond ?? null,
    createdAt: client?.userData?.creationDate ?? null
  };
}

export function mergeClients(
  peers: readonly AwgPeer[],
  clients: readonly ClientMetadata[],
  nowUnix: number,
  threshold: number,
  trafficByClient: ReadonlyMap<string, ClientTrafficUsage> = new Map(),
  lastHandshakeByClient: ReadonlyMap<string, number> = new Map(),
  ratesByClient: ReadonlyMap<string, ClientTrafficRate> = new Map()
): ClientStatus[] {
  const peersByKey = new Map(peers.map((peer) => [peer.publicKey, peer]));
  const clientsByKey = new Map(clients.map((client) => [client.clientId, client]));
  const ids = new Set([...clientsByKey.keys(), ...peersByKey.keys()]);
  return [...ids].map((id) =>
    statusFor(
      id,
      clientsByKey.get(id),
      peersByKey.get(id),
      trafficByClient.get(id),
      ratesByClient.get(id),
      lastHandshakeByClient.get(id),
      nowUnix,
      threshold
    )
  );
}
