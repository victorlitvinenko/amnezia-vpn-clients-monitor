import { describe, expect, it } from 'vitest';

import { formatBitRate, formatTrafficBytes, formatUptime } from './format';

describe('traffic formatting', () => {
  it('formats traffic with decimal units', () => {
    expect(formatTrafficBytes(18_700_000_000)).toBe('18.7 GB');
  });

  it('formats network speed in bits per second', () => {
    expect(formatBitRate(24_200_000)).toBe('24.2 Mbit/s');
    expect(formatBitRate(null)).toBe('—');
  });

  it('formats container uptime compactly', () => {
    expect(formatUptime(12 * 86_400 + 7 * 3_600)).toBe('12d 7h');
    expect(formatUptime(7 * 3_600 + 14 * 60)).toBe('7h 14m');
    expect(formatUptime(45)).toBe('0m');
    expect(formatUptime(null)).toBe('—');
  });
});
