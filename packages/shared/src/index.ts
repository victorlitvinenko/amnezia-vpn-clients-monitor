export interface ClientStatus {
  id: string;
  name: string;
  ip: string | null;
  online: boolean;
  latestHandshake: number | null;
  handshakeAgeSeconds: number | null;
  endpoint: string | null;
  downloadTodayBytes: number;
  downloadMonthBytes: number;
  createdAt: string | null;
}

export interface ApiError {
  error: string;
}

export interface HealthResponse {
  status: 'ok';
}

export interface ContainerStats {
  cpuPercent: number;
  downloadBitsPerSecond: number | null;
  uploadBitsPerSecond: number | null;
  totalTodayBytes: number;
}
