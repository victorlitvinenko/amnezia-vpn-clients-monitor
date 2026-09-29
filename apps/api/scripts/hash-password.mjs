import { argon2id, hash } from 'argon2';

async function readAllInput() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input.replace(/[\r\n]+$/, '');
}

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish();
          reject(new Error('Password entry cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (character >= ' ') value += character;
      }
    };

    process.stdin.on('data', onData);
  });
}

async function readPassword() {
  if (!process.stdin.isTTY) return readAllInput();
  const password = await readHidden('Password: ');
  const confirmation = await readHidden('Repeat password: ');
  if (password !== confirmation) throw new Error('Passwords do not match');
  return password;
}

try {
  const password = await readPassword();
  if (!password) throw new Error('Password must not be empty');
  const encodedHash = await hash(password, {
    type: argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
    hashLength: 32
  });
  process.stdout.write(`${encodedHash}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Unable to hash password'}\n`);
  process.exitCode = 1;
}
