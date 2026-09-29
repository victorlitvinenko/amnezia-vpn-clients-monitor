import { PassThrough } from 'node:stream';

import Docker from 'dockerode';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

function collect(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return new Promise((resolve, reject) => {
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.once('error', reject);
  });
}

export async function execInAmneziaContainer(
  containerName: string,
  cmd: readonly string[]
): Promise<string> {
  const container = docker.getContainer(containerName);
  const execution = await container.exec({
    Cmd: [...cmd],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false
  });
  const multiplexed = await execution.start({ hijack: true, stdin: false });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutResult = collect(stdout);
  const stderrResult = collect(stderr);

  docker.modem.demuxStream(multiplexed, stdout, stderr);
  const [output, errorOutput] = await Promise.all([stdoutResult, stderrResult]);
  const details = await execution.inspect();

  if (details.ExitCode !== 0) {
    const reason = errorOutput.trim() || `exit code ${details.ExitCode ?? 'unknown'}`;
    throw new Error(`AmneziaWG command failed: ${reason}`);
  }

  return output;
}

export function getAwgDump(containerName: string, interfaceName: string): Promise<string> {
  return execInAmneziaContainer(containerName, ['awg', 'show', interfaceName, 'dump']);
}

export function getClientsTable(containerName: string): Promise<string> {
  return execInAmneziaContainer(containerName, ['cat', '/opt/amnezia/awg/clientsTable']);
}
