import { describe, expect, it } from 'vitest';

import { readConfig } from './config.js';

const requiredEnvironment = {
  AUTH_PASSWORD_HASH: '$argon2id$v=19$m=65536,p=4,t=3$salt$hash',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
};

describe('configuration', () => {
  it('reads authentication settings', () => {
    const config = readConfig({
      ...requiredEnvironment,
      SESSION_TTL_SECONDS: '3600'
    });
    expect(config.authPasswordHash).toBe(requiredEnvironment.AUTH_PASSWORD_HASH);
    expect(config.sessionSecret).toBe(requiredEnvironment.SESSION_SECRET);
    expect(config.sessionTtlSeconds).toBe(3600);
  });

  it('requires an Argon2id password hash', () => {
    expect(() =>
      readConfig({
        ...requiredEnvironment,
        AUTH_PASSWORD_HASH: '$argon2i$v=19$m=65536,p=4,t=3$salt$hash'
      })
    ).toThrow('AUTH_PASSWORD_HASH');
  });

  it('requires a 32-byte hexadecimal session secret', () => {
    expect(() => readConfig({ ...requiredEnvironment, SESSION_SECRET: 'too-short' })).toThrow(
      'SESSION_SECRET'
    );
  });
});
