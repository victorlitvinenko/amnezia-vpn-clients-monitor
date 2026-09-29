export interface ClientStatus {
  id: string;
  name: string;
  ip: string | null;
  online: boolean;
  latestHandshake: number | null;
  handshakeAgeSeconds: number | null;
  endpoint: string | null;
  downloadBytes: number;
  uploadBytes: number;
  createdAt: string | null;
}

export interface ApiError {
  error: string;
}

export interface HealthResponse {
  status: 'ok';
}
