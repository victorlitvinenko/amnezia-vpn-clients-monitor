import { describe, expect, it } from 'vitest';

import { formatBitRate, formatTrafficBytes } from './format';

describe('traffic formatting', () => {
  it('formats traffic with decimal units', () => {
    expect(formatTrafficBytes(18_700_000_000)).toBe('18.7 GB');
  });

  it('formats network speed in bits per second', () => {
    expect(formatBitRate(24_200_000)).toBe('24.2 Mbit/s');
    expect(formatBitRate(null)).toBe('—');
  });
});
