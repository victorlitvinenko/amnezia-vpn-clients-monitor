export interface AppConfig {
  port: number;
  containerName: string;
  interfaceName: string;
  onlineThresholdSeconds: number;
  cacheTtlMs: number;
  trafficSampleIntervalMs: number;
  trafficDbPath: string;
  timeZone: string;
  nodeEnv: string;
  initialAuthPasswordHash: string | undefined;
  initialSessionSecret: string | undefined;
  sessionTtlSeconds: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validTimeZone(value: string | undefined): string {
  const timeZone = value || 'Europe/Moscow';
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return timeZone;
  } catch {
    return 'Europe/Moscow';
  }
}

function optionalArgon2idHash(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const encodedHashPattern =
    /^\$argon2id\$v=\d+\$m=\d+,(?:t=\d+,p=\d+|p=\d+,t=\d+)\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/;
  if (!value || !encodedHashPattern.test(value)) {
    throw new Error('AUTH_PASSWORD_HASH must be a valid Argon2id encoded hash');
  }
  return value;
}

function optionalSessionSecret(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      'SESSION_SECRET must contain exactly 32 bytes encoded as 64 hexadecimal characters'
    );
  }
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: positiveInteger(env.PORT, 8080),
    containerName: env.AMNEZIA_CONTAINER || 'amnezia-awg2',
    interfaceName: env.AMNEZIA_INTERFACE || 'awg0',
    onlineThresholdSeconds: positiveInteger(env.ONLINE_THRESHOLD_SECONDS, 180),
    cacheTtlMs: positiveInteger(env.CACHE_TTL_MS, 3000),
    trafficSampleIntervalMs: positiveInteger(env.TRAFFIC_SAMPLE_INTERVAL_MS, 5000),
    trafficDbPath: env.TRAFFIC_DB_PATH || './data/traffic.sqlite',
    timeZone: validTimeZone(env.TZ),
    nodeEnv: env.NODE_ENV || 'development',
    initialAuthPasswordHash: optionalArgon2idHash(env.AUTH_PASSWORD_HASH),
    initialSessionSecret: optionalSessionSecret(env.SESSION_SECRET),
    sessionTtlSeconds: positiveInteger(env.SESSION_TTL_SECONDS, 86_400)
  };
}
