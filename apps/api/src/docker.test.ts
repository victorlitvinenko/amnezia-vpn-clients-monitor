import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { demultiplexDockerStream } from './docker.js';

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
