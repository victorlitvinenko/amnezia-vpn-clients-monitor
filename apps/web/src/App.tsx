import type { AuthStatus, ClientStatus, ContainerStats, LoginRequest } from '@awg-monitor/shared';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { formatBitRate, formatHandshakeAge, formatTrafficBytes, sortClients } from './format';

const REFRESH_INTERVAL_MS = 5_000;

class AuthenticationRequiredError extends Error {}

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
    'downloadTodayBytes' in value &&
    typeof value.downloadTodayBytes === 'number' &&
    'downloadMonthBytes' in value &&
    typeof value.downloadMonthBytes === 'number' &&
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
  if (response.status === 401) throw new AuthenticationRequiredError();
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

async function fetchContainerStats(signal?: AbortSignal): Promise<ContainerStats> {
  const response = await fetch('/api/stats', {
    ...(signal ? { signal } : {}),
    headers: { Accept: 'application/json' }
  });
  if (response.status === 401) throw new AuthenticationRequiredError();
  if (!response.ok) throw new Error('Unable to load container stats');

  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('cpuPercent' in body) ||
    typeof body.cpuPercent !== 'number' ||
    !Number.isFinite(body.cpuPercent) ||
    !('downloadBitsPerSecond' in body) ||
    !isNullableNumber(body.downloadBitsPerSecond) ||
    !('uploadBitsPerSecond' in body) ||
    !isNullableNumber(body.uploadBitsPerSecond) ||
    !('totalTodayBytes' in body) ||
    typeof body.totalTodayBytes !== 'number' ||
    !Number.isFinite(body.totalTodayBytes)
  ) {
    throw new Error('Invalid container stats response');
  }
  return {
    cpuPercent: body.cpuPercent,
    downloadBitsPerSecond: body.downloadBitsPerSecond,
    uploadBitsPerSecond: body.uploadBitsPerSecond,
    totalTodayBytes: body.totalTodayBytes
  };
}

async function fetchAuthStatus(signal?: AbortSignal): Promise<AuthStatus> {
  const response = await fetch('/api/auth/session', {
    ...(signal ? { signal } : {}),
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error('Unable to check authentication');
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('authenticated' in body) ||
    typeof body.authenticated !== 'boolean'
  ) {
    throw new Error('Invalid authentication response');
  }
  return { authenticated: body.authenticated };
}

async function login(password: string): Promise<void> {
  const body: LoginRequest = { password };
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Invalid password');
    if (response.status === 429) throw new Error('Too many attempts. Try again later.');
    throw new Error('Unable to sign in');
  }
}

async function logout(): Promise<void> {
  const response = await fetch('/api/auth/logout', { method: 'POST' });
  if (!response.ok && response.status !== 401) throw new Error('Unable to sign out');
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
        <strong>{client.name}</strong>
      </div>
      <div className="period-traffic" aria-label="Download today">
        <span className="mobile-label">↓ Today</span>
        <strong>{formatTrafficBytes(client.downloadTodayBytes)}</strong>
      </div>
      <div className="period-traffic" aria-label="Download this month">
        <span className="mobile-label">↓ Month</span>
        <strong>{formatTrafficBytes(client.downloadMonthBytes)}</strong>
      </div>
      <div className="connection">
        <span>{formatHandshakeAge(client.handshakeAgeSeconds)}</span>
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

interface DashboardProps {
  onAuthenticationRequired: () => void;
  onLogout: () => void;
}

function Dashboard({ onAuthenticationRequired, onLogout }: DashboardProps) {
  const [clients, setClients] = useState<ClientStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cpuPercent, setCpuPercent] = useState<number | null>(null);
  const [downloadBitsPerSecond, setDownloadBitsPerSecond] = useState<number | null>(null);
  const [uploadBitsPerSecond, setUploadBitsPerSecond] = useState<number | null>(null);
  const [totalTodayBytes, setTotalTodayBytes] = useState<number | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setRefreshing(true);
      try {
        const nextClients = await fetchClients(signal);
        setClients(nextClients);
        setError(null);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        if (cause instanceof AuthenticationRequiredError) {
          onAuthenticationRequired();
          return;
        }
        setError('Unable to load AmneziaWG status');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [onAuthenticationRequired]
  );

  const loadStats = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const stats = await fetchContainerStats(signal);
        setCpuPercent(stats.cpuPercent);
        setDownloadBitsPerSecond(stats.downloadBitsPerSecond);
        setUploadBitsPerSecond(stats.uploadBitsPerSecond);
        setTotalTodayBytes(stats.totalTodayBytes);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        if (cause instanceof AuthenticationRequiredError) {
          onAuthenticationRequired();
          return;
        }
        setCpuPercent(null);
        setDownloadBitsPerSecond(null);
        setUploadBitsPerSecond(null);
      }
    },
    [onAuthenticationRequired]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    void loadStats(controller.signal);
    const interval = window.setInterval(() => {
      void load();
      void loadStats();
    }, REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [load, loadStats]);

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
        <div className="header-stats">
          <div className="status-line">
            <div className="cpu-load" aria-label="AmneziaWG container CPU load">
              <span>CPU</span>
              <strong>{cpuPercent === null ? '—' : `${cpuPercent.toFixed(1)}%`}</strong>
            </div>
            <div
              className={`refresh ${refreshing ? 'active' : ''}`}
              aria-label={refreshing ? 'Refreshing' : 'Live'}
            >
              <span className="refresh-dot" aria-hidden="true" />
              <span aria-hidden="true">Live</span>
            </div>
          </div>
          <div className="throughput" aria-label="Current VPN traffic speed">
            <span className="download">
              <b>↓</b> {formatBitRate(downloadBitsPerSecond)}
            </span>
            <span className="upload">
              <b>↑</b> {formatBitRate(uploadBitsPerSecond)}
            </span>
          </div>
          <div className="total-today">
            Total today:{' '}
            <strong>{totalTodayBytes === null ? '—' : formatTrafficBytes(totalTodayBytes)}</strong>
          </div>
          <button className="logout-button" type="button" onClick={onLogout}>
            Sign out
          </button>
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
          <span>↓ Today</span>
          <span>↓ Month</span>
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

interface LoginProps {
  initialError: string | null;
  onAuthenticated: () => void;
}

function Login({ initialError, onAuthenticated }: LoginProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(password);
      setPassword('');
      onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to sign in');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <p className="eyebrow">VPN STATUS</p>
        <h1 id="login-title">AmneziaWG</h1>
        <p className="login-description">Enter the dashboard password to continue.</p>
        <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            value={password}
            autoComplete="current-password"
            required
            maxLength={1024}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}

type AuthenticationState = 'checking' | 'authenticated' | 'anonymous';

export function App() {
  const [authentication, setAuthentication] = useState<AuthenticationState>('checking');
  const [authenticationError, setAuthenticationError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAuthStatus(controller.signal)
      .then((status) => setAuthentication(status.authenticated ? 'authenticated' : 'anonymous'))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setAuthenticationError('Unable to reach the server');
        setAuthentication('anonymous');
      });
    return () => controller.abort();
  }, []);

  const handleAuthenticationRequired = useCallback(() => setAuthentication('anonymous'), []);
  const handleLogout = useCallback(() => {
    void logout().finally(() => setAuthentication('anonymous'));
  }, []);

  if (authentication === 'checking') {
    return (
      <main className="auth-loading" aria-label="Checking authentication">
        <span className="refresh-dot" />
      </main>
    );
  }

  if (authentication === 'anonymous') {
    return (
      <Login
        initialError={authenticationError}
        onAuthenticated={() => {
          setAuthenticationError(null);
          setAuthentication('authenticated');
        }}
      />
    );
  }

  return (
    <Dashboard onAuthenticationRequired={handleAuthenticationRequired} onLogout={handleLogout} />
  );
}
