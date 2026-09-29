import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { calculateCpuPercent, demultiplexDockerStream } from './docker.js';

function dockerFrame(streamType: 1 | 2, text: string): Buffer {
  const content = Buffer.from(text);
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(content.length, 4);
  return Buffer.concat([header, content]);
}

describe('demultiplexDockerStream', () => {
  it('resolves stdout and stderr when the Docker source stream ends', async () => {
    const source = new PassThrough();
    const output = demultiplexDockerStream(source);

    source.end(
      Buffer.concat([
        dockerFrame(1, 'first stdout\n'),
        dockerFrame(2, 'command warning\n'),
        dockerFrame(1, 'second stdout\n')
      ])
    );

    await expect(output).resolves.toEqual({
      stdout: 'first stdout\nsecond stdout\n',
      stderr: 'command warning\n'
    });
  });
});

describe('calculateCpuPercent', () => {
  it('calculates Docker CPU usage across the available CPUs', () => {
    expect(
      calculateCpuPercent({
        cpu_stats: {
          cpu_usage: { total_usage: 1_300, percpu_usage: [650, 650] },
          system_cpu_usage: 5_000,
          online_cpus: 2
        },
        precpu_stats: {
          cpu_usage: { total_usage: 1_000 },
          system_cpu_usage: 4_000
        }
      })
    ).toBe(60);
  });

  it('returns zero when Docker has no usable previous sample', () => {
    expect(
      calculateCpuPercent({
        cpu_stats: {
          cpu_usage: { total_usage: 1_000 },
          system_cpu_usage: 4_000,
          online_cpus: 2
        },
        precpu_stats: {
          cpu_usage: { total_usage: 1_000 },
          system_cpu_usage: 4_000
        }
      })
    ).toBe(0);
  });
});
