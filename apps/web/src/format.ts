import type { ClientStatus } from '@awg-monitor/shared';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  const digits = power === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${units[power]}`;
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
