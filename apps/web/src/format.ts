import type { ClientStatus } from '@awg-monitor/shared';

export function formatTrafficBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  const value = bytes / 1000 ** power;
  const digits = power === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${units[power]}`;
}

export function formatBitRate(bitsPerSecond: number | null): string {
  if (bitsPerSecond === null || !Number.isFinite(bitsPerSecond) || bitsPerSecond < 0) return '—';
  if (bitsPerSecond < 1000) return `${Math.round(bitsPerSecond)} bit/s`;
  const units = ['kbit/s', 'Mbit/s', 'Gbit/s', 'Tbit/s'];
  const power = Math.min(
    Math.floor(Math.log(bitsPerSecond) / Math.log(1000)) - 1,
    units.length - 1
  );
  const value = bitsPerSecond / 1000 ** (power + 1);
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${units[power]}`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const wholeSeconds = Math.floor(seconds);
  const days = Math.floor(wholeSeconds / 86_400);
  const hours = Math.floor((wholeSeconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatHandshakeAge(seconds: number | null): string {
  if (seconds === null) return 'Never connected';
  if (seconds < 60) return `${seconds} sec ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return hours ? `${days}d ${hours}h ago` : `${days}d ago`;
}

export function sortClients(clients: readonly ClientStatus[]): ClientStatus[] {
  return [...clients].sort((left, right) => {
    if (left.online !== right.online) return left.online ? -1 : 1;
    const leftHandshake = left.latestHandshake ?? -1;
    const rightHandshake = right.latestHandshake ?? -1;
    if (leftHandshake !== rightHandshake) return rightHandshake - leftHandshake;
    return left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
  });
}
