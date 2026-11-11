import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const token = process.env.AXIOM_GATEWAY_TOKEN?.trim();
if (token && token.length >= 64) {
  process.stdout.write(token + '\n');
  process.exit(0);
}

const tokenFile = join(homedir(), '.config', 'axiom', 'gateway-token');
try {
  const stored = (await readFile(tokenFile, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/i.test(stored)) throw new Error('Stored gateway token is invalid.');
  process.stdout.write(stored + '\n');
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('No gateway pairing token exists yet. Start the Axiom gateway once, then run this command again.');
    process.exitCode = 1;
  } else {
    console.error(error.message || 'Could not read the gateway pairing token.');
    process.exitCode = 1;
  }
}
