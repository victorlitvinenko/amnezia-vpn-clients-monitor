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

export async function demultiplexDockerStream(
  multiplexed: NodeJS.ReadableStream
): Promise<{ stdout: string; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutResult = collect(stdout);
  const stderrResult = collect(stderr);

  const sourceFinished = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    multiplexed.once('end', finish);
    multiplexed.once('close', finish);
    multiplexed.once('error', fail);
  });

  docker.modem.demuxStream(multiplexed, stdout, stderr);

  try {
    await sourceFinished;
  } finally {
    // dockerode demuxes chunks but does not end the destination streams.
    stdout.end();
    stderr.end();
  }

  const [stdoutText, stderrText] = await Promise.all([stdoutResult, stderrResult]);
  return { stdout: stdoutText, stderr: stderrText };
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
  const { stdout: output, stderr: errorOutput } = await demultiplexDockerStream(multiplexed);
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
