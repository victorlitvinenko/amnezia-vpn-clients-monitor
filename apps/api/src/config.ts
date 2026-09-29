export interface AppConfig {
  port: number;
  containerName: string;
  interfaceName: string;
  onlineThresholdSeconds: number;
  cacheTtlMs: number;
  nodeEnv: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: positiveInteger(env.PORT, 8080),
    containerName: env.AMNEZIA_CONTAINER || 'amnezia-awg2',
    interfaceName: env.AMNEZIA_INTERFACE || 'awg0',
    onlineThresholdSeconds: positiveInteger(env.ONLINE_THRESHOLD_SECONDS, 180),
    cacheTtlMs: positiveInteger(env.CACHE_TTL_MS, 3000),
    nodeEnv: env.NODE_ENV || 'development'
  };
}
