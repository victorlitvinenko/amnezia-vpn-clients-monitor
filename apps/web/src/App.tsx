import type { ClientStatus } from '@awg-monitor/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { formatBytes, formatHandshakeAge, sortClients } from './format';

const REFRESH_INTERVAL_MS = 10_000;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isClientStatus(value: unknown): value is ClientStatus {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'ip' in value &&
    isNullableString(value.ip) &&
    'online' in value &&
    typeof value.online === 'boolean' &&
    'latestHandshake' in value &&
    isNullableNumber(value.latestHandshake) &&
    'handshakeAgeSeconds' in value &&
    isNullableNumber(value.handshakeAgeSeconds) &&
    'endpoint' in value &&
    isNullableString(value.endpoint) &&
    'downloadBytes' in value &&
    typeof value.downloadBytes === 'number' &&
    'uploadBytes' in value &&
    typeof value.uploadBytes === 'number' &&
    'createdAt' in value &&
    isNullableString(value.createdAt)
  );
}

function apiErrorMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('error' in value)) return null;
  return typeof value.error === 'string' ? value.error : null;
}

async function fetchClients(signal?: AbortSignal): Promise<ClientStatus[]> {
  const response = await fetch('/api/clients', {
    ...(signal ? { signal } : {}),
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new Error(apiErrorMessage(body) ?? 'Unable to load AmneziaWG status');
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body) || !body.every(isClientStatus)) {
    throw new Error('Invalid AmneziaWG status response');
  }
  return body;
}

interface ClientRowProps {
  client: ClientStatus;
}

function ClientRow({ client }: ClientRowProps) {
  return (
    <article className="client-row">
      <div className="identity">
        <span
          className={`status-dot ${client.online ? 'online' : ''}`}
          aria-label={client.online ? 'Online' : 'Offline'}
        />
        <div className="identity-text">
          <strong>{client.name}</strong>
          <span className="mono secondary">{client.ip ?? 'No address'}</span>
        </div>
      </div>
      <div className="traffic" aria-label="Traffic">
        <span className="download">
          <b>↓</b> {formatBytes(client.downloadBytes)}
        </span>
        <span className="upload">
          <b>↑</b> {formatBytes(client.uploadBytes)}
        </span>
      </div>
      <div className="connection">
        <span>{formatHandshakeAge(client.handshakeAgeSeconds)}</span>
        <span className="mono secondary endpoint">{client.endpoint ?? 'No endpoint'}</span>
      </div>
    </article>
  );
}

function LoadingState() {
  return (
    <div className="skeleton-list" aria-label="Loading clients">
      {[0, 1, 2, 3].map((item) => (
        <div className="skeleton" key={item} />
      ))}
    </div>
  );
}

export function App() {
  const [clients, setClients] = useState<ClientStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const nextClients = await fetchClients(signal);
      setClients(nextClients);
      setError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError('Unable to load AmneziaWG status');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const interval = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [load]);

  const sortedClients = useMemo(() => sortClients(clients), [clients]);
  const onlineClients = clients.filter((client) => client.online).length;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">VPN STATUS</p>
          <h1>AmneziaWG</h1>
          <p className="summary">
            <strong>{onlineClients}</strong> online <span>/</span> {clients.length} clients
          </p>
        </div>
        <div className={`refresh ${refreshing ? 'active' : ''}`} aria-live="polite">
          <span className="refresh-dot" />
          {refreshing ? 'Refreshing' : 'Live'}
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      <section className="clients" aria-label="AmneziaWG clients">
        <div className="table-header" aria-hidden="true">
          <span>Client</span>
          <span>Traffic</span>
          <span>Connection</span>
        </div>
        {loading ? (
          <LoadingState />
        ) : sortedClients.length > 0 ? (
          <div className="client-list">
            {sortedClients.map((client) => (
              <ClientRow client={client} key={client.id} />
            ))}
          </div>
        ) : !error ? (
          <p className="empty">No clients found</p>
        ) : null}
      </section>
    </main>
  );
}
