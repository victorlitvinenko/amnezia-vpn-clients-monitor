import { describe, expect, it } from 'vitest';

import { isOnline, mergeClients, parseAwgDump, type AwgPeer } from './domain.js';

const header = 'private\tpublic\t51820\toff\t1\t2\t3\t4';

function peerLine(overrides: Partial<Record<number, string>> = {}): string {
  const fields = [
    'pub-a',
    'psk-secret',
    '203.0.113.7:51820',
    '10.8.1.2/32',
    '1000',
    '128',
    '256',
    'off'
  ];
  for (const [index, value] of Object.entries(overrides)) {
    if (value !== undefined) fields[Number(index)] = value;
  }
  return fields.join('\t');
}

describe('parseAwgDump', () => {
  it('ignores the interface line and parses a normal peer without exposing PSK', () => {
    expect(parseAwgDump(`${header}\n${peerLine()}\n`)).toEqual([
      {
        publicKey: 'pub-a',
        endpoint: '203.0.113.7:51820',
        allowedIps: '10.8.1.2/32',
        latestHandshake: 1000,
        rxBytes: 128,
        txBytes: 256
      }
    ]);
  });

  it('converts a (none) endpoint to null', () => {
    expect(parseAwgDump(`${header}\n${peerLine({ 2: '(none)' })}`)[0]?.endpoint).toBeNull();
  });

  it('accepts zero handshake and zero traffic', () => {
    const parsed = parseAwgDump(`${header}\n${peerLine({ 4: '0', 5: '0', 6: '0' })}`)[0];
    expect(parsed).toMatchObject({ latestHandshake: 0, rxBytes: 0, txBytes: 0 });
  });

  it('parses multiple peers and ignores malformed or empty lines', () => {
    const second = peerLine({ 0: 'pub-b', 3: '10.8.1.3/32' });
    expect(
      parseAwgDump(`${header}\n${peerLine()}\ninvalid\n\n${second}`).map((peer) => peer.publicKey)
    ).toEqual(['pub-a', 'pub-b']);
  });
});

describe('online status', () => {
  it.each([
    [20, true],
    [179, true],
    [181, false]
  ])('treats a handshake %i seconds ago as online=%s', (age, expected) => {
    expect(isOnline(1000 - age, 1000, 180)).toBe(expected);
  });

  it('treats handshake 0 as offline', () => {
    expect(isOnline(0, 1000, 180)).toBe(false);
  });
});

describe('mergeClients', () => {
  const runtimePeer: AwgPeer = {
    publicKey: 'pub-a',
    endpoint: '203.0.113.7:51820',
    allowedIps: '10.8.1.2/32',
    latestHandshake: 980,
    rxBytes: 128,
    txBytes: 256
  };

  it('matches by public key and prefers the runtime IP', () => {
    const [status] = mergeClients(
      [runtimePeer],
      [
        {
          clientId: 'pub-a',
          userData: { clientName: 'Sega', allowed_ips: '10.8.9.9/32' }
        }
      ],
      1000,
      180
    );
    expect(status).toMatchObject({ id: 'pub-a', name: 'Sega', ip: '10.8.1.2' });
  });

  it('falls back to the metadata IP when runtime has none', () => {
    const [status] = mergeClients(
      [{ ...runtimePeer, allowedIps: '' }],
      [
        {
          clientId: 'pub-a',
          userData: { allowed_ips: '10.8.1.9/32' }
        }
      ],
      1000,
      180
    );
    expect(status?.ip).toBe('10.8.1.9');
  });

  it('marks a client that never connected as offline', () => {
    const [status] = mergeClients([{ ...runtimePeer, latestHandshake: 0 }], [], 1000, 180);
    expect(status).toMatchObject({
      online: false,
      latestHandshake: null,
      handshakeAgeSeconds: null
    });
  });

  it('displays a stored handshake after restart without marking the client online', () => {
    const [status] = mergeClients(
      [{ ...runtimePeer, latestHandshake: 0 }],
      [],
      1000,
      180,
      new Map(),
      new Map([['pub-a', 900]])
    );
    expect(status).toMatchObject({
      online: false,
      latestHandshake: 900,
      handshakeAgeSeconds: 100
    });
  });

  it('keeps a runtime peer with missing metadata', () => {
    const [status] = mergeClients([runtimePeer], [], 1000, 180);
    expect(status).toMatchObject({ id: 'pub-a', ip: '10.8.1.2', createdAt: null });
  });

  it('adds stored daily and monthly download totals', () => {
    const [status] = mergeClients(
      [runtimePeer],
      [],
      1000,
      180,
      new Map([['pub-a', { downloadTodayBytes: 128, downloadMonthBytes: 256 }]])
    );
    expect(status).toMatchObject({ downloadTodayBytes: 128, downloadMonthBytes: 256 });
  });

  it('adds current traffic rates', () => {
    const [status] = mergeClients(
      [runtimePeer],
      [],
      1000,
      180,
      new Map(),
      new Map(),
      new Map([['pub-a', { downloadBitsPerSecond: 160, uploadBitsPerSecond: 80 }]])
    );
    expect(status).toMatchObject({ downloadBitsPerSecond: 160, uploadBitsPerSecond: 80 });
  });
});
