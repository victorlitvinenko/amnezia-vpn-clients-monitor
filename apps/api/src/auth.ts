import { argon2id, hash, verify } from 'argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';

const PUBLIC_API_ROUTES = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/session',
  '/api/auth/setup'
]);

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    type: argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
    hashLength: 32
  });
}

export async function verifyPassword(encodedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(encodedHash, password);
  } catch {
    return false;
  }
}

interface AuthenticationCookie {
  authenticated: true;
  expiresAt: number;
}

export function createAuthenticationCookie(ttlSeconds: number): string {
  const payload: AuthenticationCookie = {
    authenticated: true,
    expiresAt: Date.now() + ttlSeconds * 1000
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function isAuthenticated(request: FastifyRequest, cookieName: string): boolean {
  const signedCookie = request.cookies[cookieName];
  if (!signedCookie) return false;

  const unsigned = request.unsignCookie(signedCookie);
  if (!unsigned.valid || !unsigned.value) return false;

  try {
    const payload: unknown = JSON.parse(Buffer.from(unsigned.value, 'base64url').toString('utf8'));
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'authenticated' in payload &&
      payload.authenticated === true &&
      'expiresAt' in payload &&
      typeof payload.expiresAt === 'number' &&
      Number.isFinite(payload.expiresAt) &&
      payload.expiresAt > Date.now()
    );
  } catch {
    return false;
  }
}

export function createAuthenticationHook(cookieName: string, isConfigured: () => boolean) {
  return async function requireAuthentication(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const path = request.url.split('?', 1)[0] ?? request.url;
    if (!path.startsWith('/api/') || PUBLIC_API_ROUTES.has(path)) return;

    if (!isConfigured()) {
      await reply.code(401).send({ error: 'Setup required' });
      return;
    }

    if (!isAuthenticated(request, cookieName)) {
      await reply.code(401).send({ error: 'Authentication required' });
    }
  };
}
